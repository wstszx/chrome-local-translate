/**
 * sidepanel/panel.js —— 侧边栏主界面
 * 所有模型推理都通过消息交给 background（lib/engine.js）完成。
 */
import { LANGUAGES, langLabel, normalizeCode, isRtl } from '../lib/languages.js';
import { SPONSOR_LINKS } from '../lib/links.js';
import {
  TONES,
  ENGINES,
  apiSupport as apiSupportLocal,
  checkNanoHardware,
  ensureNanoModel as ensureNanoModelLocal,
  probe as probeLocal,
  selftest as selftestLocal,
  warmup as warmupLocal,
} from '../lib/engine.js';

const $ = (id) => document.getElementById(id);

function msg(key, fallback = '') {
  try { return chrome.i18n.getMessage(key) || fallback; } catch (err) { return fallback; }
}

function applyI18n(root = document) {
  const get = (el, attr) => el.getAttribute(attr);
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = get(el, 'data-i18n');
    const text = msg(key);
    if (text) el.textContent = text;
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = get(el, 'data-i18n-html');
    const text = msg(key);
    if (text) el.innerHTML = text;
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = get(el, 'data-i18n-title');
    const text = msg(key);
    if (text) el.title = text;
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = get(el, 'data-i18n-placeholder');
    const text = msg(key);
    if (text) el.placeholder = text;
  });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = get(el, 'data-i18n-aria');
    const text = msg(key);
    if (text) el.setAttribute('aria-label', text);
  });
}

/* ------------------------------ 通用 ------------------------------ */

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(friendlyError(err.message)));
      else if (res && res.ok === false) reject(new Error(friendlyError(res.error || msg('operationFailed','Operation failed'))));
      else resolve(res);
    });
  });
}

/**
 * 扩展重载/更新后，旧面板窗口里的 chrome.* 调用会拿到英文报错
 * （「Extension context invalidated.」等）。统一转成人话，避免吓到用户。
 */
function friendlyError(msg) {
  const text = String(msg || '');
  if (/extension context invalidated/i.test(text)) {
    return msg('errExtensionContextInvalidated', 'Connection to the extension background was lost (the extension was reloaded or updated). Please close and reopen the side panel.');
  }
  if (/receiving end does not exist|message port closed/i.test(text)) {
    return msg('errNoReceivingEnd', 'Cannot reach the extension background right now (it may be starting). Please try again in a moment.');
  }
  return text;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 轻量 Markdown 渲染（代码 / 粗体 / 列表 / 换行） */
function renderText(text) {
  const lines = escapeHtml(String(text)).split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (li) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(inline(line));
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function showError(el, message) {
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

/* ------------------------------ 状态 ------------------------------ */

let settings = null;
let activeTab = null;
let pageStatus = { phase: 'idle' };

/* ------------------------------ 初始化 ------------------------------ */

function fillLanguageSelects() {
  for (const [id, withAuto] of [['src-lang', true], ['tgt-lang', false]]) {
    const sel = $(id);
    sel.innerHTML = '';
    if (withAuto) sel.appendChild(new Option(msg('autoDetectOption','Auto-detect'), 'auto'));
    for (const l of LANGUAGES) sel.appendChild(new Option(l.zh, l.code));
  }
  // 转写目标语言：第一项 = 跟随主目标语言
  const inlineSel = $('inline-target');
  inlineSel.innerHTML = '';
  inlineSel.appendChild(new Option(msg('followTargetLang','Follow target language above'), ''));
  for (const l of LANGUAGES) inlineSel.appendChild(new Option(l.zh, l.code));

  const toneSel = $('tone');
  toneSel.innerHTML = '';
  for (const t of TONES) {
    const cap = t.value.charAt(0).toUpperCase() + t.value.slice(1);
    const label = msg(`tone${cap}Label`, t.zh || t.en || t.value);
    const hint = msg(`tone${cap}Hint`, t.hint || '');
    toneSel.appendChild(new Option(hint ? `${label} — ${hint}` : label, t.value));
  }
}

function updateRuleCounts() {
  if (!settings) return;
  const inlineCount = (settings.inlineNeverSites || []).filter(Boolean).length;
  const autoCount = (settings.autoTranslateSites || []).filter(Boolean).length;
  const neverCount = (settings.neverSites || []).filter(Boolean).length;
  const inlineEl = $('inline-rules-count');
  const pageEl = $('page-rules-count');
  if (inlineEl) inlineEl.textContent = inlineCount ? msg('siteInlineExceptions','· {n} site exceptions').replace('{n}', String(inlineCount)) : '';
  if (pageEl) pageEl.textContent = (autoCount || neverCount) ? msg('siteAutoNeverSummary','· Auto {a} / Never {n}').replace('{a}', String(autoCount)).replace('{n}', String(neverCount)) : '';
}

function showSaveStatus(text = msg('settingsAutoSave', 'Settings are saved automatically'), ms = 1400) {
  const el = $('save-status');
  if (!el) return;
  el.textContent = text;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    if ($('save-status')) $('save-status').textContent = msg('settingsAutoSave', 'Settings are saved automatically');
  }, ms);
}

function syncForm() {
  if (!settings) return;
  $('src-lang').value = settings.sourceLang;
  $('tgt-lang').value = settings.targetLang;
  $('engine').value = settings.engine;
  $('tone').value = settings.tone;
  $('glossary').value = settings.glossary || '';
  $('context').value = settings.context || '';
  $('show-bubble').checked = !!settings.showBubble;
  $('dblclick').checked = !!settings.selectionDblclick;
  $('inline-enabled').checked = settings.inlineEnabled !== false;
  $('inline-mode').value = settings.inlineMode || 'button';
  $('inline-target').value = settings.inlineTargetLang || '';
  $('inline-insert').value = settings.inlineInsert || 'replace';
  $('inline-live').checked = settings.inlineLive !== false;
  $('inline-min').value = settings.inlineMinChars == null ? 2 : settings.inlineMinChars;
  $('inline-never').value = (settings.inlineNeverSites || []).join('\n');
  const inlineMirror = $('inline-never-mirror');
  if (inlineMirror) inlineMirror.value = (settings.inlineNeverSites || []).join('\n');
  syncInlineAvailability();

  $('display-mode').value = settings.displayMode;
  $('auto-translate').checked = !!settings.autoTranslate;
  $('auto-sites').value = (settings.autoTranslateSites || []).join('\n');
  $('never-sites').value = (settings.neverSites || []).join('\n');
  $('min-chars').value = settings.minAutoChars;
  $('max-nodes').value = settings.maxNodes;
  $('skip-same-lang').checked = settings.skipSameLang !== false;
  $('concurrency').value = String(settings.concurrency);
  $('cache-enabled').checked = settings.cacheEnabled !== false;
  if ($('history-enabled')) $('history-enabled').checked = settings.historyEnabled !== false;
  $('theme').value = settings.theme;
  document.documentElement.dataset.theme = settings.theme || 'auto';
  document.documentElement.lang = settings.uiLang === 'en' ? 'en' : 'zh-CN';
  updateRuleCounts();
  if (typeof renderSiteRuleManager === 'function') renderSiteRuleManager();
}

async function patchSettings(patch) {
  const res = await send({ type: 'lt:settings:set', payload: { patch } });
  settings = res.settings;
  updateRuleCounts();
  renderSitePrefUI();
  showSaveStatus();
  return settings;
}

/** 转写开关联动：关掉总开关时把下面几项置灰 */
function syncInlineAvailability() {
  const enabled = $('inline-enabled').checked && $('inline-mode').value !== 'off';
  for (const id of ['inline-mode', 'inline-target', 'inline-insert', 'inline-live', 'inline-min', 'inline-never']) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }
}

const saveDebounced = (() => {
  let timer = null;
  let pending = {};
  return (patch) => {
    pending = { ...pending, ...patch };
    showSaveStatus(msg('saving', 'Saving…'), 1200);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const p = pending;
      pending = {};
      try {
        settings = (await send({ type: 'lt:settings:set', payload: { patch: p } })).settings;
        updateRuleCounts();
        renderSitePrefUI();
        showSaveStatus();
      } catch (err) {
        showSaveStatus(msg('saveFailed', 'Save failed'), 2200);
        showError($('text-error'), err.message);
      }
    }, 400);
  };
})();

/* ------------------------------ 引擎状态 ------------------------------ */

async function refreshEnginePill() {
  const pill = $('engine-pill');
  try {
    const res = await send({ type: 'lt:probe', payload: {} });
    const support = res.support || {};
    // 侧边栏自己也是扩展页面（有 document）：个别 Chrome 版本在 Service Worker 里
    // 看不见 Prompt API / Translator，但在这种扩展页面里看得见。后台报缺失时用
    // 本页的 apiSupport() 补齐，避免把本机可用的能力误报成「不可用」。
    let local = null;
    if (!support.translator || !support.nano) {
      local = apiSupportLocal();
      if (local.translator) support.translator = true;
      if (local.nano) support.nano = true;
    }
    // 后台问不到 Translator 的语言对状态时，用本页文档再问一次
    if (support.translator && res.translator == null) {
      try {
        const src = $('src-lang').value === 'auto' ? 'en' : $('src-lang').value;
        const localRes = await probeLocal({ source: src, target: $('tgt-lang').value });
        res.translator = localRes.translator;
      } catch (err) {
        /* 忽略 */
      }
    }
    const parts = [];
    if (support.translator) parts.push(`${msg('builtinTranslatorModel','Built-in translation model')}：${statusLabel(res.translator)}`);
    if (support.nano) parts.push(`Nano：${statusLabel(res.nano)}`);
    if (!support.translator && !support.nano) {
      pill.textContent = msg('statusUnavailableLocal', 'Unavailable locally');
      pill.className = 'pill err';
      return { support, res };
    }
    pill.textContent = support.translator && res.translator === 'available' ? msg('statusReady', 'Model ready') : parts[0];
    pill.className = `pill ${res.translator === 'available' || res.nano === 'available' ? 'ok' : res.translator === 'unavailable' && !support.nano ? 'err' : 'warn'}`;
    return { support, res };
  } catch (err) {
    pill.textContent = msg('statusUnknown', 'Unknown');
    pill.className = 'pill err';
    return null;
  }
}

function statusLabel(status) {
  switch (status) {
    case 'available':
      return msg('labelAvailable', 'Ready');
    case 'downloadable':
      return msg('labelDownloadable', 'Downloadable');
    case 'downloading':
      return msg('labelDownloading', 'Downloading');
    case 'unsupported':
      return msg('labelUnsupported', 'Unsupported');
    case 'unavailable':
      return msg('labelUnavailable', 'Unavailable');
    default:
      return status || msg('statusUnknown', 'Unknown');
  }
}

/**
 * Gemini Nano「不可用 / 不支持」时给一句可操作的指引，而不是只说「不可用」。
 * downloadable → 其实是好消息：点一下「让 Chrome 下载 Gemini Nano」就能启用。
 */
function nanoHint(status) {
  if (status === 'downloadable' || status === 'downloading') {
    return msg('nanoHintDownloadable', '{status}: click “Download Gemini Nano” below to enable it').replace('{status}', statusLabel(status));
  }
  return msg('nanoHintUnavailable', '{status}: usually the model is not downloaded or hardware is insufficient — try “Download Gemini Nano” first. If it still fails, open chrome://components and find “Optimization Guide Manifest Component: nano_v3_gpu_component” (the one with nano in the name), click “Check for update” until status becomes Up-to-date. If it stays unchanged, hardware may be insufficient (>4GB VRAM, or 16GB RAM + 4 cores) or less than 22GB disk space is available.').replace('{status}', statusLabel(status));
}

async function refreshModelList() {
  const box = $('model-list');
  const target = $('tgt-lang').value;
  const source = $('src-lang').value === 'auto' ? 'en' : $('src-lang').value;
  box.innerHTML = `<div class="model-row"><span class="spinner"></span>${msg('detecting','Detecting…')}</div>`;
  try {
    const { support, res } = (await refreshEnginePill()) || {};
    const rows = [];
    const dot = (s) => (s === 'available' ? 'ok' : s === 'downloadable' || s === 'downloading' ? 'warn' : 'err');
    if (support && support.translator) {
      rows.push(
        `<div class="model-row"><span class="dot ${dot(res.translator)}"></span><b>${msg('builtinTranslatorModel','Built-in translation model')}</b><span class="muted small">${langLabel(source)} → ${langLabel(target)}：${statusLabel(res.translator)}</span></div>`,
      );
    } else {
      rows.push(`<div class="model-row"><span class="dot err"></span><b>${msg('builtinTranslatorModel','Built-in translation model')}</b><span class="muted small">${msg('envUnavailable','Unavailable in this environment')}</span></div>`);
    }
    if (support && support.nano) {
      rows.push(
        `<div class="model-row"><span class="dot ${dot(res.nano)}"></span><b>Gemini Nano</b><span class="muted small">${nanoHint(res.nano)}</span></div>`,
      );
    } else {
      rows.push(`<div class="model-row"><span class="dot err"></span><b>Gemini Nano</b><span class="muted small">${msg('nanoEnvUnavailable','Unavailable in this environment (no Prompt API; hardware unsupported or Chrome version too old)')}</span></div>`);
    }
    const host = res && res.host;
    rows.push(
      `<div class="model-row"><span class="dot"></span><span class="muted small">${msg('backendHost','Inference host')}：${escapeHtml(
        host === 'offscreen'
          ? msg('hostOffscreen','Offscreen document (fallback when unavailable in Service Worker)')
          : host === 'sw'
            ? msg('hostSw','Service Worker')
            : msg('hostAuto','Auto'),
      )}</span></div>`,
    );
    box.innerHTML = rows.join('');
    // Nano 没就绪时顺手把「本机能验证的那部分」硬件信息摆出来，不用等用户点下载按钮踩坑才看到
    const nanoStatus = support && support.nano ? res.nano : null;
    if (nanoStatus && nanoStatus !== 'available') {
      renderHwCheck(await checkNanoHardware().catch(() => null));
    } else {
      $('hw-check').hidden = true;
    }
  } catch (err) {
    box.innerHTML = `<div class="muted small">${msg('detectFailed','Detection failed')}：${escapeHtml(err.message)}</div>`;
  }
}

async function refreshDiag() {
  const box = $('diag');
  box.innerHTML = `<span class="spinner"></span>${msg('diagDetecting', ' Detecting…')}`;
  try {
    const res = await send({ type: 'lt:probe', payload: {} });
    const support = res.support || {};
    const ua = navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/);
    const targets = ['zh', 'en', 'ja', 'fr', 'de', 'es', 'ru', 'ar'];
    const src = $('src-lang').value === 'auto' ? 'en' : $('src-lang').value;
    const pairLines = [];
    for (const t of targets) {
      if (normalizeCode(t) === normalizeCode(src)) continue;
      try {
        const one = await send({ type: 'lt:probe', payload: { source: src, target: t } });
        pairLines.push(`${langLabel(src)} → ${langLabel(t)}：${statusLabel(one.translator)}`);
      } catch (err) {
        pairLines.push(`${langLabel(src)} → ${langLabel(t)}：${msg('detectFailedShort','Detection failed')}`);
      }
    }
    const cache = await send({ type: 'lt:cache:size' });
    box.innerHTML = [
      `${msg('diagChrome','Chrome')}：${ua ? ua[1] : msg('unknown','Unknown')}`,
      `${msg('diagTranslatorApi','Translator API')}：${support.translator ? msg('supported','Supported') : msg('notSupported','Not supported')}`,
      `${msg('diagDetectorApi','LanguageDetector API')}：${support.detector ? msg('supported','Supported') : msg('notSupported','Not supported')}`,
      `${msg('diagPromptApi','Prompt API (Gemini Nano)')}：${support.nano ? msg('supported','Supported') : msg('notSupported','Not supported')}`,
      `${msg('diagCpuCores','CPU logical cores')}：${navigator.hardwareConcurrency || msg('unknown','Unknown')}`,
      `${msg('diagMemoryApprox','Memory (approx.)')}：${navigator.deviceMemory ? `${navigator.deviceMemory} GB` : msg('unknown','Unknown')}`,
      `${msg('diagCacheEntries','Cache entries')}：${cache.size}`,
      `${msg('diagCurrentEngine','Current engine')}：${settings ? settings.engine : '-'}`,
      `${msg('backendHost','Inference host')}：${res.host || msg('hostAuto','Auto')}`,
      msg('diagHintAvailability','Tip: availability only reflects language pair support. create also depends on permissions, model download / user gesture.'),
      msg('diagHintSelftest','Click "Step-by-step environment self-test" to compare real creation results in side panel, background, and offscreen contexts.'),
      msg('diagPairAvailability','▼ Language pair availability (top 20 common targets)'),
      ...pairLines,
    ]
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join('');
  } catch (err) {
    box.textContent = `${msg('detectFailed','Detection failed')}：${err.message}`;
  }
}

/* ------------------------------ 文本翻译 ------------------------------ */

let currentTranslation = '';
let streamPort = null;
let streamTimer = null;

/**
 * 流式通道的看门狗时长（毫秒）：后台这么久既没给完结果也没断开就当它卡住了，
 * 放弃流式、退回普通消息拿一次完整译文。测试里可以用全局变量压到很短。
 */
const STREAM_STALL_MS = Number(globalThis.__LT_STREAM_STALL_MS) > 0 ? Number(globalThis.__LT_STREAM_STALL_MS) : 25000;

function setOutMeta(text) {
  $('out-meta').textContent = text;
}

function setOutput(html, isPlaceholder = false) {
  const out = $('output');
  out.innerHTML = html ? html : `<span class="placeholder">${msg('outputWillShowHere','Translation will appear here')}</span>`;
  out.dataset.placeholder = isPlaceholder ? '1' : '';
}

function stopStream() {
  // 顺手把上一轮的看门狗也收掉：它属于那一轮，留着只会在下一轮跑到一半时
  // 对一个已经结算的 promise 空 reject（无害但是噪音）
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  if (streamPort) {
    try {
      streamPort.disconnect();
    } catch (err) {
      /* 忽略 */
    }
    streamPort = null;
  }
}

async function translateCurrent() {
  const text = $('input').value.trim();
  if (!text) return;
  showError($('text-error'), '');
  const btn = $('do-translate');
  btn.disabled = true;
  setOutMeta(msg('translating', 'Translating locally…'));
  setOutput('<span class="spinner"></span>', true);
  currentTranslation = '';
  const started = performance.now();
  const payload = {
    text,
    source: $('src-lang').value,
    target: $('tgt-lang').value,
    engine: settings ? settings.engine : 'auto',
    tone: settings ? settings.tone : 'default',
  };

  // 先用流式通道拿“逐字输出”，失败再退回普通消息
  try {
    await new Promise((resolve, reject) => {
      stopStream();
      let got = false;
      let finished = false; // 后台有没有给出「完整结果」（done / error）
      let port;
      try {
        port = chrome.runtime.connect({ name: 'lt-stream' });
      } catch (err) {
        reject(err);
        return;
      }
      streamPort = port;
      port.onMessage.addListener((msg) => {
        if (msg.type === 'chunk') {
          got = true;
          currentTranslation = msg.text;
          setOutput(renderText(msg.text));
        } else if (msg.type === 'download') {
          setOutMeta(msg('downloadingLangPack','Downloading language pack {n}%').replace('{n}', (msg.progress * 100).toFixed(0)));
        } else if (msg.type === 'done') {
          if (!got && !currentTranslation) {
            reject(new Error('empty'));
            return;
          }
          finished = true;
          resolve();
        } else if (msg.type === 'error') {
          finished = true;
          reject(new Error(msg.error));
        }
      });
      port.onDisconnect.addListener(() => {
        // 同步读一下 lastError：端口被 Chrome 强制关闭（典型场景是本页进了
        // 往返缓存）时它带着报错信息，不读的话控制台会刷
        // 「Unchecked runtime.lastError: The page keeping the extension port is
        //  moved into back/forward cache, so the message channel is closed.」
        void chrome.runtime.lastError;
        // 自己 stopStream() 主动关掉的端口（新一轮已经接管）：不用管
        if (streamPort !== port) return;
        streamPort = null;
        // 后台在给完完整结果之前就断了（Service Worker 被回收等）→ 别把半截
        // 文本当成结果：reject 掉，让外层退回普通消息拿一次完整译文。
        if (!finished) reject(new Error('port-disconnected'));
        else resolve();
      });
      port.postMessage({ type: 'start', ...payload });
      streamTimer = setTimeout(() => {
        // 看门狗必须**无条件**收尾：以前只在「一个分片都没收到」时才 reject，
        // 于是后台卡在半路（有分片、没 done、没断开）时这个 await 会永远等下去，
        // 按钮停在禁用态 —— 表现就是「第一次能用，后面点不动」。
        reject(new Error(got ? 'stream-stalled' : 'timeout'));
      }, STREAM_STALL_MS);
    });
  } catch (err) {
    // 流式失败 → 普通翻译（同时能拿到更准确的错误信息）
    // 先把半路的端口收掉，否则它还在推分片，会把下面这条完整译文覆盖成半截的
    stopStream();
    try {
      const res = await send({ type: 'lt:translate', payload });
      currentTranslation = res.text || '';
      setOutput(renderText(currentTranslation));
      setOutMeta(
        `${langLabel(res.sourceLang)} → ${langLabel(res.targetLang)} · ${res.engine === 'nano' ? 'Gemini Nano' : msg('panelEngineBuiltinModel', 'Built-in translation model')} · ${Math.round(
          performance.now() - started,
        )} ms${res.fallbackFrom ? msg('panelFallbackToNano', ' · Built-in translation model unavailable, automatically switched to Gemini Nano') : ''}`,
      );
      btn.disabled = false;
      if (streamTimer) clearTimeout(streamTimer);
      return;
    } catch (err2) {
      showError($('text-error'), err2.message);
      setOutput('');
      setOutMeta(msg('translateFailed', 'Translation failed'));
      btn.disabled = false;
      return;
    }
  }
  if (streamTimer) clearTimeout(streamTimer);
  const engineName = settings && settings.engine === 'nano' ? 'Gemini Nano' : msg('panelEngineBuiltinModel', 'Built-in translation model');
  setOutMeta(`${langLabel($('src-lang').value)} → ${langLabel($('tgt-lang').value)} · ${engineName} · ${Math.round(performance.now() - started)} ms`);
  btn.disabled = false;
}

async function explainCurrent() {
  const text = $('input').value.trim() || currentTranslation;
  if (!text) return;
  showError($('text-error'), '');
  $('do-explain').disabled = true;
  setOutMeta(msg('explaining', 'Explaining with Gemini Nano…'));
  setOutput('<span class="spinner"></span>', true);
  try {
    const res = await send({ type: 'lt:explain', payload: { text, lang: (settings && settings.uiLang) || 'zh' } });
    setOutput(renderText(res.text));
    setOutMeta(msg('nanoExplanationLabel','Gemini Nano explanation'));
  } catch (err) {
    showError($('text-error'), err.message);
    setOutput('');
    setOutMeta(msg('explainFailed', 'Explanation failed'));
  } finally {
    $('do-explain').disabled = false;
  }
}

/* ------------------------------ 页面翻译 ------------------------------ */

function activeHost() {
  if (!activeTab || !activeTab.url) return '';
  try {
    return new URL(activeTab.url).hostname.toLowerCase();
  } catch (err) {
    return '';
  }
}

function getSitePref(host) {
  if (!host || !settings || !settings.sitePrefs) return null;
  return settings.sitePrefs[host] || null;
}

function renderSitePrefUI() {
  const host = activeHost();
  const hostEl = $('site-host');
  const summary = $('site-pref-summary');
  const globalHint = $('site-global-hint');
  const btnAuto = $('site-toggle-auto');
  const btnNever = $('site-toggle-never');
  if (hostEl) hostEl.textContent = host || '—';
  const pref = getSitePref(host);
  if (!host) {
    if (summary) summary.textContent = msg('sitePrefsUnsupported', 'Site preferences are not available for this tab.');
    if (globalHint) globalHint.textContent = '';
    if (btnAuto) { btnAuto.disabled = true; btnAuto.textContent = `${msg('sitePrefAuto','Auto-translate')}：—`; }
    if (btnNever) { btnNever.disabled = true; btnNever.textContent = msg('siteNeverAddBtn','Add to never translate'); }
    return;
  }
  if (btnAuto) btnAuto.disabled = false;
  if (btnNever) btnNever.disabled = false;
  const parts = [];
  const modeName = (m) => m === 'dual' ? msg('modeDual','Bilingual') : m === 'hover' ? msg('modeHover','Hover') : msg('modeReplace','Replace');
  if (pref) {
    if (pref.targetLang) parts.push(`${msg('sitePrefTarget','Target')}：${langLabel(pref.targetLang)}`);
    if (pref.sourceLang) parts.push(`${msg('sitePrefSource','Source')}：${pref.sourceLang === 'auto' ? msg('autoDetect','Auto') : langLabel(pref.sourceLang)}`);
    if (pref.displayMode) parts.push(`${msg('sitePrefMode','Mode')}：${modeName(pref.displayMode)}`);
    if (pref.autoTranslate === true) parts.push(`${msg('sitePrefAuto','Auto-translate')}：${msg('on','On')}`);
    if (pref.autoTranslate === false) parts.push(`${msg('sitePrefAuto','Auto-translate')}：${msg('off','Off')}`);
    if (pref.neverTranslate) parts.push(`${msg('sitePrefNever','Never translate')}：${msg('on','On')}`);
  }
  if (summary) summary.textContent = parts.length ? parts.join(' · ') : msg('sitePrefsNone','No preferences saved for this site yet.');
  const globalNotes = [];
  const autoSites = (settings && settings.autoTranslateSites) || [];
  const neverSites = (settings && settings.neverSites) || [];
  const inAuto = autoSites.some((s) => String(s || '').toLowerCase() === host);
  const inNever = neverSites.some((s) => String(s || '').toLowerCase() === host);
  if (inNever) globalNotes.push(msg('globalNeverList','In global “Never translate” list'));
  if (inAuto) globalNotes.push(msg('globalAutoList','In global “Auto-translate” list'));
  if (!inAuto && !inNever && autoSites.length === 0 && settings && settings.autoTranslate) globalNotes.push(msg('globalAutoAll','Global auto-translate is enabled (all sites)'));
  if (globalHint) globalHint.textContent = globalNotes.length ? `${msg('globalRulesLabel','Global rules')}：${globalNotes.join('；')}` : '';
  const autoOn = !!(pref && pref.autoTranslate);
  const neverOn = !!(pref && pref.neverTranslate);
  if (btnAuto) btnAuto.textContent = autoOn ? msg('siteAutoOn','Auto-translate for this site: On') : msg('siteAutoOffBtn','Auto-translate for this site: Off');
  if (btnNever) btnNever.textContent = neverOn ? msg('siteNeverRemove','Remove from never translate') : msg('siteNeverAddBtn','Add to never translate');
}

async function updateSitePrefForActive(mutator) {
  const host = activeHost();
  if (!host) return;
  const current = { ...(settings && settings.sitePrefs ? settings.sitePrefs : {}) };
  const prev = { ...(current[host] || {}) };
  const next = mutator(prev) || {};
  const cleaned = {};
  if (next.targetLang) cleaned.targetLang = next.targetLang;
  if (next.sourceLang) cleaned.sourceLang = next.sourceLang;
  if (next.displayMode) cleaned.displayMode = next.displayMode;
  if (next.autoTranslate === true || next.autoTranslate === false) cleaned.autoTranslate = next.autoTranslate;
  if (next.neverTranslate === true || next.neverTranslate === false) cleaned.neverTranslate = next.neverTranslate;
  if (Object.keys(cleaned).length) current[host] = cleaned;
  else delete current[host];
  settings = (await send({ type: 'lt:settings:set', payload: { patch: { sitePrefs: current } } })).settings;
  renderSitePrefUI();
}

function formatHistoryTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch (err) { return ''; }
}

async function loadHistory() {
  const listEl = $('history-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="muted small"><span class="spinner"></span>${msg('historyLoading','Loading…')}</div>`;
  try {
    const res = await send({ type: 'lt:history:get' });
    const items = (res && res.items) || [];
    if (!items.length) {
      listEl.innerHTML = `<div class="muted small">${msg('historyEmpty','No history yet. Translations and explanations will appear here (stored locally only).')}</div>`;
      return;
    }
    listEl.innerHTML = items.map((it) => {
      const meta = [formatHistoryTime(it.at), it.kind === 'explain' ? msg('historyExplain','Explain') : msg('historyTranslate','Translate'), it.engine || '', it.sourceLang && it.targetLang ? `${langLabel(it.sourceLang)} → ${langLabel(it.targetLang)}` : ''].filter(Boolean).join(' · ');
      return `<div class="history-item" data-id="${escapeHtml(it.id)}">
        <div class="history-meta">${escapeHtml(meta)}</div>
        <div class="history-text">${escapeHtml(String(it.text || '').slice(0, 400))}</div>
        <div class="history-trans">${escapeHtml(String(it.translation || '').slice(0, 600))}</div>
        <div class="history-actions">
          <button type="button" class="mini" data-action="load" data-id="${escapeHtml(it.id)}">${msg('load','Load')}</button>
          <button type="button" class="mini" data-action="copy" data-id="${escapeHtml(it.id)}">${msg('copyTranslation','Copy translation')}</button>
          <button type="button" class="mini" data-action="remove" data-id="${escapeHtml(it.id)}">${msg('delete','Delete')}</button>
        </div>
      </div>`;
    }).join('');
    listEl._items = items;
  } catch (err) {
    listEl.innerHTML = `<div class="muted small">${msg('historyLoadFailed','Failed to load')}：${escapeHtml(err.message)}</div>`;
  }
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTab = tab || null;
  } catch (err) {
    activeTab = null;
  }
  const titleEl = $('page-title');
  const urlEl = $('page-url');
  if (!activeTab) {
    titleEl.textContent = msg('panelNoActiveTab', 'No active tab');
    urlEl.textContent = '';
    renderSitePrefUI();
    return;
  }
  titleEl.textContent = activeTab.title || msg('panelNoTitle', '(No title)');
  urlEl.textContent = activeTab.url || '';
  renderSitePrefUI();
  await refreshPageStatus();
}

async function refreshPageStatus() {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  try {
    const res = await send({ type: 'lt:page:status', payload: { tabId: activeTab.id } });
    if (res.status) {
      pageStatus = res.status;
      renderPageStatus();
    }
  } catch (err) {
    $('page-status').textContent = `${msg('pageStatusReadFailed','Failed to read page status')}：${err.message}`;
  }
}

function renderPageStatus() {
  const st = pageStatus || {};
  const bar = $('page-bar');
  const phase = st.phase || 'idle';
  bar.parentElement.classList.toggle('indeterminate', phase === 'working' && !st.total);
  if (st.total) {
    bar.style.width = `${Math.round(((st.done || 0) / st.total) * 100)}%`;
  } else if (phase === 'done') {
    bar.style.width = '100%';
  } else {
    bar.style.width = '0%';
  }
  const target = st.target || (settings && settings.targetLang) || '';
  const modeLabel = st.mode === 'dual' ? msg('pageDual','Bilingual view') : st.mode === 'hover' ? msg('pageHover','Hover view') : st.mode === 'replace' ? msg('pageTranslate','Translate page') : '';
  const seg = msg('segments','segments');
  const label =
    phase === 'working'
      ? `${msg('pageStatusWorking','Translating')}：${st.done || 0}/${st.total || '?'} ${seg}${modeLabel ? ` · ${modeLabel}` : ''}`
      : phase === 'done'
        ? `${msg('pageStatusDone','Translated')} ${st.translated || st.nodes || 0} ${seg}${modeLabel ? ` · ${modeLabel}` : ''}${st.sourceLang ? ` · ${langLabel(st.sourceLang)} → ${langLabel(target)}` : ''}${st.failed ? ` · ${msg('failed','failed')} ${st.failed} ${seg}` : ''}`
        : st.error
          ? `${msg('pageStatusFailed','Failed')}：${st.error}`
          : msg('pageStatusIdleText','Not translated');
  $('page-status').textContent = label;

  const guide = $('page-guide');
  if (guide) {
    let tip = '';
    if (phase === 'working') {
      tip = msg('guideWorking','Translating this page locally. You can monitor progress; if it stalls, try resetting the local session in Settings > Performance & display.');
    } else if (phase === 'done') {
      tip = st.mode === 'hover'
        ? msg('guideDoneHover','Hover translation is enabled: move the cursor over a paragraph to see its translation. Use “Translate page” or “Bilingual view” for fixed translations.')
        : msg('guideDone','Translation complete. You can restore the original page or save site preferences below for next time.');
    } else if (st.error) {
      tip = msg('guideError','Translation failed: check whether this page allows script injection (chrome:// pages are not supported), whether language packs/models are ready, or try Refresh/Re-check.');
    } else {
      tip = msg('guideIdle','Not translated yet. Use “Translate page”, “Bilingual view”, or “Hover view”. Save site preferences below to apply automatically next time.');
    }
    guide.textContent = tip;
    guide.hidden = false;
  }
}
async function translatePage(mode) {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  $('page-translate').disabled = true;
  $('page-dual').disabled = true;
  $('page-hover').disabled = true;
  pageStatus = { phase: 'working', mode };
  renderPageStatus();
  try {
    const res = await send({ type: 'lt:page:translate', payload: { tabId: activeTab.id, mode } });
    if (res && res.ok === false) throw new Error(res.error);
    if (res && res.skipped === 'same-language') $('page-status').textContent = msg('skippedSameLanguage','Page is already in the target language');
    if (res && res.skipped === 'no-text') $('page-status').textContent = msg('skippedNoText','No translatable text found');
  } catch (err) {
    $('page-status').textContent = `${msg('pageStatusFailed','Failed')}：${err.message}`;
  } finally {
    $('page-translate').disabled = false;
    $('page-dual').disabled = false;
    $('page-hover').disabled = false;
  }
}

async function restorePage() {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  try {
    await send({ type: 'lt:page:restore', payload: { tabId: activeTab.id } });
    pageStatus = { phase: 'idle', translated: 0 };
    renderPageStatus();
  } catch (err) {
    $('page-status').textContent = `${msg('restoreFailed','Restore failed')}：${err.message}`;
  }
}

async function translateSelection(explain = false) {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  const box = $('sel-result');
  box.hidden = false;
  box.innerHTML = `<span class="spinner"></span>${msg('readingSelection','Reading selected text…')}`;
  try {
    const sel = await chrome.tabs.sendMessage(activeTab.id, { type: 'lt:get-selection' });
    const text = sel && sel.text;
    if (!text) {
      box.innerHTML = `<span class="muted">${msg('noSelection','No text is selected on this page')}</span>`;
      return;
    }
    if (explain) {
      const res = await send({ type: 'lt:explain', payload: { text, lang: (settings && settings.uiLang) || 'zh' } });
      box.innerHTML = `<div class="muted small">${msg('nanoExplanation','Gemini Nano explanation:')}</div>${renderText(res.text)}`;
    } else {
      const res = await send({ type: 'lt:translate', payload: { text, source: 'auto', target: $('tgt-lang').value } });
      box.innerHTML = `<div class="muted small">${langLabel(res.sourceLang)} → ${langLabel(res.targetLang)}：</div>${renderText(res.text)}`;
    }
  } catch (err) {
    box.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}

/* ------------------------------ 语言包下载 ------------------------------ */

/** 从界面取当前语言对（source 为自动检测时，用 en 作为可下载的默认源语言） */
function pairFromUI() {
  const raw = $('src-lang').value;
  return { source: raw === 'auto' ? 'en' : raw, raw };
}

function showDlHint(html) {
  $('dl-hint-text').innerHTML = html || '';
  $('dl-hint').hidden = !html;
}

async function downloadPair() {
  const { source } = pairFromUI();
  const target = $('tgt-lang').value;
  const btn = $('download-models');
  const bar = $('dl-bar');
  btn.disabled = true;
  showDlHint('');
  bar.parentElement.classList.add('indeterminate');
  bar.style.width = '0%';
  $('dl-status').textContent = msg('downloadPreparing','Preparing download (first time may be slow, keep network available)…');

  // 关键点：在这里（侧边栏文档 + 真实点击手势）直接调用 Translator.create()。
  // 规范要求创建 Translator 需要「最近有用户交互的文档」，Service Worker 里没有文档也没有手势，
  // 因此后台调用 create() 可能被 Chrome 拒绝（NotSupportedError）。
  try {
    await warmupLocal(source, target, {
      onDownload: (p) => {
        const percent = Math.round((p || 0) * 100);
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${percent}%`;
        $('dl-status').textContent = msg('downloadingPair','Downloading language pack… {n}%').replace('{n}', String(percent));
      },
    });
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '100%';
    $('dl-status').textContent = msg('pairReady','Language pack ready: {pair}, available offline.').replace('{pair}', `${langLabel(source)} → ${langLabel(target)}`);
    await refreshModelList();
    return { ok: true };
  } catch (err) {
    // 侧边栏里也失败 → 再问一次后台，把两个环境的结果都摆出来，方便定位
    const bg = await send({ type: 'lt:warmup', payload: { source, target } }).catch((e) => ({ ok: false, error: e.message }));
    const code = err && err.code;
    $('dl-status').textContent = `${msg('downloadFailed','Download failed')}：${err && err.message ? err.message : String(err)}`;
    showDlHint(
      [
        code === 'pair-create-failed' || code === 'unsupported-pair'
          ? msg('dlPairRejected','<b>Chrome refused to create a translator instance for this language pair.</b>')
          : msg('dlCreateFailed','<b>Language pack creation failed.</b>'),
        msg('dlHint1','① Use now: switch to Gemini Nano (ready on this device), translation is unaffected.'),
        msg('dlHint2','② Check language pack: open <code>chrome://components</code> in a new tab → find <b>Chrome TranslateKit</b> → click “Check for update”.'),
        msg('dlHint3','③ Remove pair limit: <code>chrome://flags/#translation-api</code> → choose <b>Enabled without language pack limit</b> → restart Chrome (ignore if flag is unavailable).'),
        msg('dlHint4','④ Try another pair (e.g. English → Japanese): if only this pair fails, it’s a language pack issue, not an extension issue.'),
        `${msg('dlHint5','⑤ Background context result: ')}${bg && bg.ok ? msg('dlBgOk','created successfully') : (bg && bg.error) || msg('failed','failed')}`,
      ].join('<br>'),
    );
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    btn.disabled = false;
    bar.parentElement.classList.remove('indeterminate');
  }
}

/**
 * 让 Chrome 下载 Gemini Nano 模型本体（语言包之外那个 2~4GB 的基础模型）。
 * 必须在有用户手势的文档上下文里调用 —— 侧边栏的按钮点击正是这种环境；
 * 本页创建失败时再走后台（SW → 离屏文档）兑底。
 */
async function downloadNano() {
  const btn = $('nano-download');
  const bar = $('dl-bar');
  btn.disabled = true;
  showDlHint('');
  bar.parentElement.classList.add('indeterminate');
  bar.style.width = '0%';
  $('dl-status').textContent = msg('nanoDownloadPreparing','Triggering Gemini Nano download (~2–4GB, keep network available and non-metered)…');
  try {
    const local = await ensureNanoModelLocal({
      onDownload: (p) => {
        const percent = Math.round((p || 0) * 100);
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${percent}%`;
        $('dl-status').textContent = msg('downloadingNano','Downloading Gemini Nano… {n}%').replace('{n}', String(percent));
      },
    });
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '100%';
    $('dl-status').textContent = `${msg('nanoReady','Gemini Nano is ready.')} (${statusLabel(local.status)})`;
    await refreshModelList();
    return { ok: true };
  } catch (err) {
    // 本页失败（可能这个 Chrome 版本要求模型「本来就绪」才能 create）→ 问后台再试一次
    const bg = await send({ type: 'lt:nano:ensure', payload: {} }).catch((e) => ({ ok: false, error: e.message }));
    if (bg && bg.ok) {
      bar.style.width = '100%';
      $('dl-status').textContent = msg('nanoReadyBg','Gemini Nano is ready (confirmed in background context).');
      await refreshModelList();
      return { ok: true };
    }
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '0%';
    $('dl-status').textContent = `${msg('downloadFailed','Download failed')}：${(err && err.message) || String(err)}`;
    const hw = await checkNanoHardware().catch(() => null);
    showDlHint(
      [
        msg('nanoNotReadyTitle','<b>Gemini Nano is not ready.</b> Check in order:'),
        msg('nanoHintStep1','① Click “Open chrome://components” below → find <b>Optimization Guide Manifest Component: nano_v3_gpu_component</b> (name contains nano) → click “Check for update” until status changes from <b>New</b> to <b>Up-to-date</b> (~2GB).'),
        msg('nanoHintStep2','② Ensure <code>chrome://flags/#prompt-api-for-gemini-nano</code> (if present) is <b>Enabled</b> and restart browser.'),
        msg('nanoHintStep3','③ Hardware requirements: &gt;4GB VRAM, or 16GB RAM + 4+ cores; at least 22GB free disk space.'),
        msg('nanoHintStep4','④ Click “Open on-device-internals” below → check Model Status for specific errors.'),
        `${msg('nanoHintStep5','⑤ Background context result: ')}${bg && bg.error ? escapeHtml(bg.error) : msg('failed','failed')}`,
      ].join('<br>'),
    );
    renderHwCheck(hw);
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    btn.disabled = false;
  }
}

/**
 * 打开 chrome:// 内部诊断页。普通网页 / <a href="chrome://..."> 会被 Chrome 直接
 * 重定向到 about:blank（这是刻意的安全限制），但从扩展的特权上下文（侧边栏文档）
 * 调用 chrome.tabs.create() 不受此限制，也不需要额外声明 "tabs" 权限
 * （创建标签页本身是免权限操作，"tabs" 权限只影响能否读取 url/title 等敏感字段）。
 * 万一某个 Chrome 版本收紧了这条路（Chrome 117+ 曾扩大过 chrome:// 导航保护范围），
 * 这里兜底把地址复制到剪贴板，让用户自己粘到地址栏。
 */
async function openChromeInternalPage(url) {
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    try {
      await navigator.clipboard.writeText(url);
      $('dl-status').textContent = msg('openInternalFail','Cannot open directly ({err}). Please copy the URL to the address bar and open manually: {url}').replace('{err}', err.message).replace('{url}', url);
    } catch {
      $('dl-status').textContent = msg('openInternalFailShort','Cannot open directly ({err}). Please enter manually in the address bar: {url}').replace('{err}', err.message).replace('{url}', url);
    }
  }
}

/**
 * 把 checkNanoHardware() 的结果渲染成一句人话：能在浏览器里验证的部分（CPU/内存/存储配额）
 * 直接给结论；显存拿不到，只能提示「还要看这一条」。
 */
function renderHwCheck(hw) {
  const box = $('hw-check');
  if (!hw) {
    box.hidden = true;
    return;
  }
  const parts = [];
  const mem = hw.memoryGB ? `${hw.memoryGB}GB` : msg('hwCpuMemUnknown','unknown (not exposed by Chrome)');
  parts.push(msg('hwCpuMem','CPU {cores} cores · Memory ~{mem}').replace('{cores}', String(hw.cores || msg('unknown','Unknown'))).replace('{mem}', mem));
  if (hw.quotaGB != null) {
    parts.push(msg('hwQuota','Storage quota ~{gb}GB (not total free disk space, for reference only)').replace('{gb}', hw.quotaGB.toFixed(1)));
  }
  if (hw.reasons.length) {
    parts.push(msg('hwWarn','⚠️ {reasons}').replace('{reasons}', hw.reasons.join('；')));
  } else if (hw.cpuMemOk === true) {
    parts.push(msg('hwOkGpuUnknown','CPU/memory meet requirements; VRAM cannot be detected in browser — confirm in chrome://components whether model is fully downloaded.'));
  }
  box.innerHTML = parts.map((p) => escapeHtml(p)).join('<br>');
  box.hidden = false;
}

/** 分环境自检：侧边栏文档 vs 扩展后台，把 availability 与 create 的真实结果都打出来 */
async function runSelftest() {
  const { source } = pairFromUI();
  const target = $('tgt-lang').value;
  const box = $('diag');
  box.innerHTML = `<span class="spinner"></span> ${msg('selftestRunning','Running self-test (creating models in both contexts, may take a few seconds)…')}`;
  const lines = [
    `${msg('selftestLangPair','Language pair')}：${langLabel(source)} → ${langLabel(target)}`,
    `${msg('diagChrome','Chrome')}：${(navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/) || [])[1] || msg('unknown','Unknown')}`,
  ];
  let local = null;
  let bg = null;

  lines.push('', msg('selftestSidepanel','[Side panel (document + user gesture)]'));
  try {
    local = await selftestLocal({ source, target });
    lines.push(`${msg('selftestAvailability','availability')}：${local.availability}`);
    lines.push(`${msg('selftestCreate','create')}：${local.create}${local.createError ? ` — ${local.createError}` : ''}`);
    if (local.sample) lines.push(`${msg('selftestSample','Sample translation')}：${String(local.sample).slice(0, 60)}`);
    lines.push(
      `${msg('selftestNano','Gemini Nano')}：availability=${local.nanoAvailability} / create=${local.nanoCreate}${local.nanoCreateError ? ` — ${local.nanoCreateError}` : ''}`,
    );
  } catch (err) {
    lines.push(`${msg('selftestFailed','Self-test failed')}：${err.message}`);
  }

  lines.push('', msg('selftestBackground','[Extension background (Service Worker)]'));
  try {
    bg = await send({ type: 'lt:selftest', payload: { source, target } });
    lines.push(`${msg('selftestAvailability','availability')}：${bg.availability}`);
    lines.push(`${msg('selftestCreate','create')}：${bg.create}${bg.createError ? ` — ${bg.createError}` : ''}`);
    lines.push(
      `${msg('selftestNano','Gemini Nano')}：availability=${bg.nanoAvailability} / create=${bg.nanoCreate}${bg.nanoCreateError ? ` — ${bg.nanoCreateError}` : ''}`,
    );
    lines.push(`${msg('selftestHost','Background host')}：${bg.host || '-'}`);
  } catch (err) {
    lines.push(`${msg('selftestFailed','Self-test failed')}：${err.message}`);
  }

  box.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  box.dataset.raw = lines.join('\n');

  // 给一句结论，省得用户自己比对
  const nanoOk = (local && local.nanoCreate === 'ok') || (bg && bg.nanoCreate === 'ok');
  if (local && local.create === 'ok') {
    showDlHint(
      `${msg('selftestOkLocal','✅ This language pair can be created in the side panel.')}${
        bg && bg.create === 'failed' ? msg('selftestOkBgFailed',' but creation failed in background (Chrome only allows creation in a document with user gesture) — the extension will automatically use offscreen document / Gemini Nano and should work normally.') : '。'
      }`,
    );
  } else if (local && local.create === 'failed') {
    showDlHint(
      [
        `${msg('selftestLocalFailed','⚠️ Creation also failed in the side panel: ')}<code>${escapeHtml(local.createError || '')}</code>`,
        msg('selftestLocalFailedExplain','This means the language pack for this pair is unavailable on the Chrome side (availability is only a capability query and Chrome intentionally obscures language pack status).'),
        nanoOk ? msg('selftestNanoOkSuggest','Gemini Nano works on this device → consider switching to the Gemini Nano engine above; translation/explanation will still work.') : msg('selftestNanoBadSuggest','Gemini Nano is also unavailable. Check chrome://on-device-internals and hardware requirements.'),
        msg('selftestExtraSuggest','Also try: chrome://components → Chrome TranslateKit “Check for update”, and chrome://flags/#translation-api set to “Enabled without language pack limit”.'),
      ].join('<br>'),
    );
  } else {
    showDlHint(msg('selftestNoResult','No self-test result. See raw output below.'));
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  // 标签切换
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const name = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
      if (name === 'page') {
        refreshActiveTab();
        refreshModelList();
      }
      if (name === 'history') loadHistory();
      if (name === 'settings') refreshDiag();
    });
  });

  // 语言 / 引擎
  $('src-lang').addEventListener('change', () => {
    saveDebounced({ sourceLang: $('src-lang').value });
    refreshModelList();
  });
  $('tgt-lang').addEventListener('change', () => {
    saveDebounced({ targetLang: $('tgt-lang').value });
    refreshModelList();
  });
  $('swap').addEventListener('click', () => {
    const s = $('src-lang').value;
    const t = $('tgt-lang').value;
    const nextSource = t;
    $('tgt-lang').value = s === 'auto' ? 'en' : s;
    $('src-lang').value = nextSource;
    saveDebounced({ sourceLang: nextSource, targetLang: s === 'auto' ? 'en' : s });
    refreshModelList();
  });
  $('engine').addEventListener('change', () => {
    patchSettings({ engine: $('engine').value });
    refreshModelList();
  });
  $('tone').addEventListener('change', () => {
    saveDebounced({ tone: $('tone').value });
    send({ type: 'lt:engine:reset' }).catch(() => {});
  });
  $('glossary').addEventListener('input', () => saveDebounced({ glossary: $('glossary').value }));
  $('glossary').addEventListener('change', () => send({ type: 'lt:engine:reset' }).catch(() => {}));
  $('context').addEventListener('input', () => saveDebounced({ context: $('context').value }));

  // 划词 / 输入框转写 / 整页
  $('show-bubble').addEventListener('change', () => patchSettings({ showBubble: $('show-bubble').checked }));
  $('dblclick').addEventListener('change', () => patchSettings({ selectionDblclick: $('dblclick').checked }));

  $('inline-enabled').addEventListener('change', async () => {
    await patchSettings({ inlineEnabled: $('inline-enabled').checked });
    syncInlineAvailability();
  });
  $('inline-mode').addEventListener('change', async () => {
    await patchSettings({ inlineMode: $('inline-mode').value });
    syncInlineAvailability();
  });
  $('inline-target').addEventListener('change', () => patchSettings({ inlineTargetLang: $('inline-target').value }));
  $('inline-insert').addEventListener('change', () => patchSettings({ inlineInsert: $('inline-insert').value }));
  $('inline-live').addEventListener('change', () => patchSettings({ inlineLive: $('inline-live').checked }));
  $('inline-min').addEventListener('change', () =>
    patchSettings({ inlineMinChars: Math.max(1, Number($('inline-min').value) || 2) }),
  );
  const normalizeHostLines = (text) => {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/\n|,/)) {
      let v = raw.trim().toLowerCase();
      if (!v) continue;
      v = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  };
  const bindHostListEditor = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => saveDebounced({ [key]: normalizeHostLines(el.value) }));
    el.addEventListener('blur', () => {
      const list = normalizeHostLines(el.value);
      el.value = list.join('\n');
      saveDebounced({ [key]: list });
      updateRuleCounts();
    });
  };
  const siteListFromUI = () => ({
    autoTranslateSites: normalizeHostLines($('auto-sites') ? $('auto-sites').value : ((settings && settings.autoTranslateSites) || []).join('\n')),
    neverSites: normalizeHostLines($('never-sites') ? $('never-sites').value : ((settings && settings.neverSites) || []).join('\n')),
    inlineNeverSites: normalizeHostLines($('inline-never') ? $('inline-never').value : ((settings && settings.inlineNeverSites) || []).join('\n')),
  });
  const syncSiteRuleTextareas = () => {
    const lists = siteListFromUI();
    if ($('auto-sites')) $('auto-sites').value = lists.autoTranslateSites.join('\n');
    if ($('never-sites')) $('never-sites').value = lists.neverSites.join('\n');
    if ($('inline-never')) $('inline-never').value = lists.inlineNeverSites.join('\n');
    const mirror = $('inline-never-mirror');
    if (mirror) mirror.value = lists.inlineNeverSites.join('\n');
    updateRuleCounts();
  };
  const setSiteRuleLists = async (patchLists, opts = {}) => {
    const lists = {
      autoTranslateSites: normalizeHostLines((patchLists.autoTranslateSites || []).join('\n')),
      neverSites: normalizeHostLines((patchLists.neverSites || []).join('\n')),
      inlineNeverSites: normalizeHostLines((patchLists.inlineNeverSites || []).join('\n')),
    };
    settings = { ...(settings || {}), ...lists };
    if ($('auto-sites')) $('auto-sites').value = lists.autoTranslateSites.join('\n');
    if ($('never-sites')) $('never-sites').value = lists.neverSites.join('\n');
    if ($('inline-never')) $('inline-never').value = lists.inlineNeverSites.join('\n');
    const mirror = $('inline-never-mirror');
    if (mirror) mirror.value = lists.inlineNeverSites.join('\n');
    updateRuleCounts();
    renderSitePrefUI();
    renderSiteRuleManager();
    if (opts.save !== false) await patchSettings(lists);
  };
  const renderSiteRuleManager = () => {
    const box = $('site-rule-list');
    if (!box) return;
    const lists = settings ? {
      auto: new Set(settings.autoTranslateSites || []),
      never: new Set(settings.neverSites || []),
      inline: new Set(settings.inlineNeverSites || []),
    } : { auto: new Set(), never: new Set(), inline: new Set() };
    const q = String(($('site-rule-search') && $('site-rule-search').value) || '').trim().toLowerCase();
    const hosts = Array.from(new Set([...lists.auto, ...lists.never, ...lists.inline])).sort();
    const filtered = q ? hosts.filter((h) => h.includes(q)) : hosts;
    if (!filtered.length) {
      box.innerHTML = `<div class="site-rule-empty">${hosts.length ? msg('siteRulesNoMatch','No matching site rules.') : msg('siteRulesEmpty','No global site rules yet. Add a domain above or paste in bulk text edit below.')}</div>`;
      return;
    }
    box.innerHTML = filtered.map((host) => `
      <div class="site-rule-item" data-host="${escapeHtml(host)}">
        <div class="site-rule-host">${escapeHtml(host)}</div>
        <button type="button" class="mini" data-site-rule-action="remove" data-host="${escapeHtml(host)}">${msg('remove','Remove')}</button>
        <div class="site-rule-toggles">
          <label class="chk small"><input type="checkbox" data-site-rule-toggle="auto" data-host="${escapeHtml(host)}" ${lists.auto.has(host) ? 'checked' : ''}/> ${msg('siteRuleAuto','Auto-translate')}</label>
          <label class="chk small"><input type="checkbox" data-site-rule-toggle="never" data-host="${escapeHtml(host)}" ${lists.never.has(host) ? 'checked' : ''}/> ${msg('siteRuleNever','Never translate')}</label>
          <label class="chk small"><input type="checkbox" data-site-rule-toggle="inline" data-host="${escapeHtml(host)}" ${lists.inline.has(host) ? 'checked' : ''}/> ${msg('siteRuleInline','No input popup')}</label>
        </div>
      </div>`).join('');
  };
  const addSiteRuleFromManager = async () => {
    const input = $('site-rule-input');
    if (!input) return;
    const host = normalizeHostLines(input.value)[0];
    if (!host) return;
    const lists = siteListFromUI();
    const flags = {
      auto: !!($('site-rule-flag-auto') && $('site-rule-flag-auto').checked),
      never: !!($('site-rule-flag-never') && $('site-rule-flag-never').checked),
      inline: !!($('site-rule-flag-inline') && $('site-rule-flag-inline').checked),
    };
    if (!flags.auto && !flags.never && !flags.inline) flags.auto = true; // 默认添加为自动翻译规则（可再调整）
    if (flags.auto && !lists.autoTranslateSites.includes(host)) lists.autoTranslateSites.push(host);
    if (flags.never && !lists.neverSites.includes(host)) lists.neverSites.push(host);
    if (flags.inline && !lists.inlineNeverSites.includes(host)) lists.inlineNeverSites.push(host);
    input.value = '';
    await setSiteRuleLists(lists);
  };

  bindHostListEditor('inline-never', 'inlineNeverSites');
  const bindMirror = (id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => saveDebounced({ inlineNeverSites: normalizeHostLines(el.value) }));
    el.addEventListener('blur', () => {
      const list = normalizeHostLines(el.value);
      el.value = list.join('\n');
      if ($('inline-never')) $('inline-never').value = list.join('\n');
      saveDebounced({ inlineNeverSites: list });
      updateRuleCounts();
      renderSiteRuleManager();
    });
  };
  bindMirror('inline-never-mirror');
  $('display-mode').addEventListener('change', () => patchSettings({ displayMode: $('display-mode').value }));
  $('auto-translate').addEventListener('change', () => patchSettings({ autoTranslate: $('auto-translate').checked }));
  bindHostListEditor('auto-sites', 'autoTranslateSites');
  bindHostListEditor('never-sites', 'neverSites');
  // 文本编辑变化时同步管理器视图
  ['inline-never','inline-never-mirror','auto-sites','never-sites'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { updateRuleCounts(); renderSitePrefUI(); });
    if (el) el.addEventListener('blur', () => { syncSiteRuleTextareas(); renderSiteRuleManager(); });
  });
  const bindClear = (btnId, inputId, key) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const lists = siteListFromUI();
      lists[key] = [];
      await setSiteRuleLists(lists);
    });
  };
  bindClear('inline-never-clear', 'inline-never', 'inlineNeverSites');
  bindClear('inline-never-clear-inline', 'inline-never-mirror', 'inlineNeverSites');
  bindClear('auto-sites-clear', 'auto-sites', 'autoTranslateSites');
  bindClear('never-sites-clear', 'never-sites', 'neverSites');

  if ($('site-rule-add')) $('site-rule-add').addEventListener('click', addSiteRuleFromManager);
  if ($('site-rule-input')) $('site-rule-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSiteRuleFromManager(); }
  });
  if ($('site-rule-search')) $('site-rule-search').addEventListener('input', renderSiteRuleManager);
  if ($('site-rule-list')) $('site-rule-list').addEventListener('change', async (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.siteRuleToggle) return;
    const host = t.dataset.host;
    const kind = t.dataset.siteRuleToggle; // auto|never|inline
    const lists = siteListFromUI();
    const key = kind === 'auto' ? 'autoTranslateSites' : kind === 'never' ? 'neverSites' : 'inlineNeverSites';
    const has = lists[key].includes(host);
    if (t.checked && !has) lists[key].push(host);
    if (!t.checked && has) lists[key] = lists[key].filter((h) => h !== host);
    await setSiteRuleLists(lists);
  });
  if ($('site-rule-list')) $('site-rule-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-site-rule-action="remove"]');
    if (!btn) return;
    const host = btn.dataset.host;
    const lists = siteListFromUI();
    lists.autoTranslateSites = lists.autoTranslateSites.filter((h) => h !== host);
    lists.neverSites = lists.neverSites.filter((h) => h !== host);
    lists.inlineNeverSites = lists.inlineNeverSites.filter((h) => h !== host);
    await setSiteRuleLists(lists);
  });
  if ($('site-rules-clear-all')) $('site-rules-clear-all').addEventListener('click', async () => {
    await setSiteRuleLists({ autoTranslateSites: [], neverSites: [], inlineNeverSites: [] });
  });
  if ($('site-rules-export')) $('site-rules-export').addEventListener('click', async () => {
    const lists = siteListFromUI();
    const payload = { version: 1, ...lists, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chrome-local-translate-site-rules.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showSaveStatus(msg('exportedSiteRules', 'Site rules exported'), 1600);
  });
  if ($('site-rules-import')) $('site-rules-import').addEventListener('click', () => $('site-rules-import-file') && $('site-rules-import-file').click());
  if ($('site-rules-import-file')) $('site-rules-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const lists = siteListFromUI();
      if (Array.isArray(data.autoTranslateSites)) lists.autoTranslateSites = normalizeHostLines(data.autoTranslateSites.join('\n'));
      if (Array.isArray(data.neverSites)) lists.neverSites = normalizeHostLines(data.neverSites.join('\n'));
      if (Array.isArray(data.inlineNeverSites)) lists.inlineNeverSites = normalizeHostLines(data.inlineNeverSites.join('\n'));
      await setSiteRuleLists(lists);
      showSaveStatus(msg('importedSiteRules', 'Site rules imported'), 1600);
    } catch (err) {
      showSaveStatus(msg('importInvalid', 'Import failed: invalid file format'), 2200);
    }
  });
  $('min-chars').addEventListener('change', () => patchSettings({ minAutoChars: Number($('min-chars').value) || 0 }));
  $('max-nodes').addEventListener('change', () => patchSettings({ maxNodes: Number($('max-nodes').value) || 3000 }));
  $('skip-same-lang').addEventListener('change', () => patchSettings({ skipSameLang: $('skip-same-lang').checked }));

  // 性能与显示
  $('concurrency').addEventListener('change', () => patchSettings({ concurrency: Number($('concurrency').value) || 2 }));
  $('cache-enabled').addEventListener('change', () => patchSettings({ cacheEnabled: $('cache-enabled').checked }));
  // (history-enabled listener added in history section if present)
  $('cache-clear').addEventListener('click', async () => {
    await send({ type: 'lt:cache:clear' });
    const size = await send({ type: 'lt:cache:size' });
    $('cache-size').textContent = `${size.size}`;
  });
  $('engine-reset').addEventListener('click', async () => {
    const btn = $('engine-reset');
    // 释放并重建两个链路的原生会话（Nano 会话 + 内置翻译会话）
    await send({ type: 'lt:engine:reset' });
    btn.textContent = msg('resetDone', 'Reset ✓');
    setTimeout(() => {
      btn.textContent = msg('resetSessionLabel', btn.dataset.label || msg('panelResetSessionLabelFallback', 'Reset local session'));
    }, 1600);
  });
  $('theme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('theme').value;
    patchSettings({ theme: $('theme').value });
  });

  // 文本面板
  const input = $('input');
  const setCount = (n) => { $('count').textContent = `${n} ${msg('charsUnit', 'chars')}`; };
  input.addEventListener('input', () => {
    setCount(input.value.length);
    if ($('auto-input').checked) {
      clearTimeout(input._timer);
      input._timer = setTimeout(() => translateCurrent(), 900);
    }
  });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translateCurrent();
    }
  });
  $('do-translate').addEventListener('click', translateCurrent);
  $('do-explain').addEventListener('click', explainCurrent);
  $('do-clear').addEventListener('click', () => {
    stopStream();
    input.value = '';
    setCount(0);
    currentTranslation = '';
    setOutput('');
    setOutMeta(msg('translationLabel','Translation'));
    showError($('text-error'), '');
  });
  $('do-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      input.value = text;
      setCount(text.length);
      translateCurrent();
    } catch (err) {
      showError($('text-error'), msg('clipboardReadFailed','Cannot read clipboard. Please paste manually (Ctrl/Cmd + V).'));
    }
  });
  $('out-copy').addEventListener('click', async () => {
    if (!currentTranslation) return;
    await navigator.clipboard.writeText(currentTranslation);
    $('out-copy').textContent = msg('copied', 'Copied ✓');
    setTimeout(() => ($('out-copy').textContent = msg('copy', 'Copy')), 1200);
  });
  $('out-speak').addEventListener('click', () => {
    if (!currentTranslation || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(currentTranslation.slice(0, 800));
    const code = normalizeCode($('tgt-lang').value);
    u.lang = code === 'zh' ? 'zh-CN' : code === 'zh-Hant' ? 'zh-TW' : code;
    window.speechSynthesis.speak(u);
  });
  $('out-back').addEventListener('click', () => {
    if (!currentTranslation) return;
    input.value = currentTranslation;
    setCount(currentTranslation.length);
    const s = $('src-lang').value;
    const t = $('tgt-lang').value;
    $('src-lang').value = t;
    $('tgt-lang').value = s === 'auto' ? 'en' : s;
    saveDebounced({ sourceLang: t, targetLang: s === 'auto' ? 'en' : s });
    translateCurrent();
  });

  // 页面面板
  // 「翻译整页」跟随设置里的显示方式（替换 / 双语对照 / 悬停）；旁边的按钮是临时指定
  $('page-translate').addEventListener('click', () => translatePage($('display-mode').value || 'replace'));
  $('page-dual').addEventListener('click', () => translatePage('dual'));
  $('page-hover').addEventListener('click', () => translatePage('hover'));
  $('page-restore').addEventListener('click', restorePage);
  $('page-refresh').addEventListener('click', () => {
    refreshActiveTab();
    refreshModelList();
  });
  $('sel-translate').addEventListener('click', () => translateSelection(false));
  $('sel-explain').addEventListener('click', () => translateSelection(true));

  $('site-save-pref').addEventListener('click', () => updateSitePrefForActive((prev) => ({
    ...prev,
    targetLang: $('tgt-lang').value,
    sourceLang: $('src-lang').value,
    displayMode: $('display-mode').value,
  })));
  $('site-clear-pref').addEventListener('click', () => updateSitePrefForActive(() => ({})));
  $('site-toggle-auto').addEventListener('click', () => updateSitePrefForActive((prev) => ({
    ...prev,
    autoTranslate: !(prev && prev.autoTranslate),
    neverTranslate: !(prev && prev.autoTranslate) ? false : !!(prev && prev.neverTranslate),
  })));
  $('site-toggle-never').addEventListener('click', () => updateSitePrefForActive((prev) => ({
    ...prev,
    neverTranslate: !(prev && prev.neverTranslate),
    autoTranslate: !(prev && prev.neverTranslate) ? false : !!(prev && prev.autoTranslate),
  })));

  // 历史
  if ($('history-enabled')) {
    $('history-enabled').addEventListener('change', () => patchSettings({ historyEnabled: $('history-enabled').checked }));
  }
  if ($('history-refresh')) $('history-refresh').addEventListener('click', loadHistory);
  // render after all bindings are ready
  renderSiteRuleManager();

  if ($('history-clear')) $('history-clear').addEventListener('click', async () => {
    await send({ type: 'lt:history:clear' });
    loadHistory();
  });
  if ($('history-list')) {
    $('history-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const items = $('history-list')._items || [];
      const item = items.find((x) => x.id === id);
      if (action === 'remove') {
        await send({ type: 'lt:history:remove', payload: { id } });
        loadHistory();
        return;
      }
      if (!item) return;
      if (action === 'copy') {
        await navigator.clipboard.writeText(item.translation || '');
        btn.textContent = msg('copiedShort', 'Copied');
        setTimeout(() => (btn.textContent = msg('copyTranslation', 'Copy translation')), 1200);
        return;
      }
      if (action === 'load') {
        // 切到文本页并载入
        const tabBtn = document.querySelector('.tab-btn[data-tab="text"]');
        if (tabBtn) tabBtn.click();
        $('input').value = item.text || '';
        setCount(($('input').value || '').length);
        currentTranslation = item.translation || '';
        setOutput(renderText(currentTranslation));
        setOutMeta(item.kind === 'explain' ? msg('historyRecordExplain','History (explanation)') : msg('historyRecord','History'));
        showError($('text-error'), '');
      }
    });
  }
  $('download-models').addEventListener('click', downloadPair);
  $('nano-download').addEventListener('click', downloadNano);
  $('diag-refresh').addEventListener('click', refreshDiag);
  $('selftest').addEventListener('click', runSelftest);
  $('diag-selftest').addEventListener('click', runSelftest);
  $('use-nano').addEventListener('click', async () => {
    try {
      settings = (await send({ type: 'lt:settings:set', payload: { patch: { engine: 'nano' } } })).settings;
      syncForm();
      $('dl-status').textContent = msg('switchedToNano','Switched to Gemini Nano: translation and explanation will use the on-device Gemini Nano model.');
      showDlHint('');
      await refreshModelList();
    } catch (err) {
      $('dl-status').textContent = `${msg('switchFailed','Switch failed')}：${err.message}`;
    }
  });
  // chrome:// 页面扩展没法用脚本直接读状态，只能帮用户开好页面、告诉 ta 该看哪一行
  $('open-components').addEventListener('click', () => openChromeInternalPage('chrome://components'));
  $('open-on-device').addEventListener('click', () => openChromeInternalPage('chrome://on-device-internals'));
  /* ---------------- 输入框转写：自检当前输入框（逐层 frame） ---------------- */
  $('inline-probe').addEventListener('click', async () => {
    const out = $('inline-probe-out');
    const btn = $('inline-probe');
    out.hidden = false;
    btn.disabled = true;
    out.textContent = msg('probeRunning','Querying each frame…');
    try {
      await refreshActiveTab();
      if (!activeTab) throw new Error(msg('probeNoActiveTab','No active tab'));
      const res = await send({ type: 'lt:inline-status-all', payload: { tabId: activeTab.id } });
      const frames = (res && res.frames) || [];
      const lines = [];
      lines.push(`${msg('probeActiveTab','Active tab:')}${activeTab.url || ''}`);
      lines.push(`${msg('probeClaimedFrame','Claimed frame:')}${res && res.claimFrame != null ? `#${res.claimFrame}` : msg('probeNoClaimYet','(none yet: type a few characters in an input field first)')}`);
      lines.push('');
      if (!frames.length) {
        lines.push(msg('probeNoFrames','No frames responded — content script not injected (chrome:// and other special pages are not supported).'));
      }
      for (const f of frames) {
        const where = f.top ? msg('probeTopFrame','Top page') : `${msg('probeIframe','iframe')} #${f.frameId}`;
        lines.push(`【${where}】 ${f.url}`);
        lines.push(
          `  ${msg('probeTranscription','Transcription')}：${f.enabled ? msg('probeEnabled','enabled') : msg('probeDisabled','disabled')}（${msg('probeMode','mode')} ${f.mode || '-'}）  ${msg('probeFocus','focus')}：${
            f.hasFocus ? msg('probeHas','yes') : msg('probeNone','no')
          }  ${msg('probeTarget','target')}：${f.hasTarget ? `${msg('probeHas','yes')}（${f.kind === 'agent' ? msg('probeTargetAgent','closed Shadow DOM, via main-world helper') : msg('probeTargetNormal','normal element')} ${f.tag}）` : msg('probeNone','no')}`,
        );
        lines.push(`  ${msg('probeCharsRead','characters read')}：${f.chars == null ? '—' : f.chars}`);
        lines.push('');
      }
      lines.push(msg('probeHowToRead','How to read this report:'));
      lines.push(msg('probeHint1','· An iframe row shows “target: yes” and “characters read > 0” → extension can see that input; transcription should work.'));
      lines.push(msg('probeHint2','· All frames show “target: no” → extension did not detect that input (please copy/screenshot this for support).'));
      lines.push(msg('probeHint3','· “characters read = 0” but has target → element detected but text unreadable (often a special rich-text editor).'));
      out.dataset.raw = lines.join('\n');
      out.textContent = lines.join('\n');
    } catch (err) {
      out.textContent = `${msg('probeFailed','Probe failed')}：${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $('diag-copy').addEventListener('click', async () => {
    const text = $('diag').dataset.raw || $('diag').innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      $('diag-copy').textContent = msg('copied', 'Copied ✓');
    } catch (err) {
      $('diag-copy').textContent = msg('copyFailed', 'Copy failed');
    }
    setTimeout(() => ($('diag-copy').textContent = msg('copyDiagnostics', 'Copy diagnostics')), 1400);
  });

  // 来自 background 的广播
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'lt:page-status' && activeTab && msg.payload && msg.payload.tabId === activeTab.id) {
      pageStatus = msg.payload.status || {};
      renderPageStatus();
    } else if (msg.type === 'lt:history-updated') {
      const active = document.querySelector('.tab-panel.active');
      if (active && active.id === 'tab-history') loadHistory();
    } else if (msg.type === 'lt:inline-hint' && msg.payload) {
      // 快捷键没找到输入框之类的状况，直接说给用户听（否则只有「按了没反应」）
      const box = $('inline-hint');
      if (box) {
        box.textContent = msg.payload.text || '';
        box.hidden = !msg.payload.text;
        clearTimeout(box.dataset.timer);
        const t = setTimeout(() => {
          box.hidden = true;
        }, 9000);
        box.dataset.timer = t;
      }
    } else if (msg.type === 'lt:model-progress' && msg.payload) {
      const p = Math.round((msg.payload.progress || 0) * 100);
      $('dl-status').textContent = msg('downloadingLangPackShort','Downloading language pack… {n}%').replace('{n}', String(p));
      $('dl-bar').style.width = `${p}%`;
    } else if (msg.type === 'lt:settings' && msg.payload) {
      settings = msg.payload;
      syncForm();
      renderSitePrefUI();
    }
  });

  // 标签页变化
  chrome.tabs.onActivated.addListener(() => {
    refreshActiveTab();
    refreshModelList();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (activeTab && tabId === activeTab.id && (changeInfo.status === 'complete' || changeInfo.url)) {
      pageStatus = { phase: 'idle' };
      renderPageStatus();
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */

(async function main() {
  applyI18n();
  fillLanguageSelects();
  bindEvents();
  try {
    const res = await send({ type: 'lt:settings:get' });
    settings = res.settings;
  } catch (err) {
    showError($('text-error'), msg('errReadSettings', 'Failed to read settings. Please reload the extension.'));
  }
  syncForm();
  const countEl = $('count');
  if (countEl) countEl.textContent = `0 ${msg('charsUnit','chars')}`;
  const engineReset = $('engine-reset');
  if (engineReset) engineReset.dataset.label = msg('resetSessionLabel','Reset local session');
  const footerTagline = $('footer-tagline');
  if (footerTagline) footerTagline.textContent = msg('footerTagline') || footerTagline.textContent;
  const footerProject = $('footer-project');
  if (footerProject) footerProject.textContent = msg('projectHome') || footerProject.textContent;
  const sponsorBox = $('footer-sponsors');
  if (sponsorBox && Array.isArray(SPONSOR_LINKS)) {
    for (const item of SPONSOR_LINKS) {
      if (!item || !item.url) continue;
      const a = document.createElement('a');
      a.className = 'footer-link';
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = item.label || (msg('sponsorLabel') || 'Support');
      sponsorBox.appendChild(a);
    }
  }
  // 从「扩展详情 → 选项」进来时（panel.html#settings）直接落到设置页
  const wanted = (location.hash || '').replace('#', '');
  if (wanted) {
    const btn = document.querySelector(`.tab-btn[data-tab="${wanted}"]`);
    if (btn) btn.click();
  }
  await refreshEnginePill();
  await refreshActiveTab();
  const size = await send({ type: 'lt:cache:size' }).catch(() => ({ size: 0 }));
  $('cache-size').textContent = String(size.size);
  $('input').focus();
})();
