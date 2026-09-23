/**
 * sidepanel/panel.js —— 侧边栏主界面
 * 所有模型推理都通过消息交给 background（lib/engine.js）完成。
 */
import { LANGUAGES, langLabel, normalizeCode, isRtl } from '../lib/languages.js';
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

/* ------------------------------ 通用 ------------------------------ */

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(friendlyError(err.message)));
      else if (res && res.ok === false) reject(new Error(friendlyError(res.error || '操作失败')));
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
    return '与扩展后台的连接已断开（扩展刚被重新加载或更新）。请关闭并重新打开侧边栏。';
  }
  if (/receiving end does not exist|message port closed/i.test(text)) {
    return '暂时联系不上扩展后台（可能正在启动）。请稍等一两秒后重试。';
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
    if (withAuto) sel.appendChild(new Option('自动检测', 'auto'));
    for (const l of LANGUAGES) sel.appendChild(new Option(l.zh, l.code));
  }
  // 转写目标语言：第一项 = 跟随主目标语言
  const inlineSel = $('inline-target');
  inlineSel.innerHTML = '';
  inlineSel.appendChild(new Option('跟随上面的目标语言', ''));
  for (const l of LANGUAGES) inlineSel.appendChild(new Option(l.zh, l.code));

  const toneSel = $('tone');
  toneSel.innerHTML = '';
  for (const t of TONES) toneSel.appendChild(new Option(`${t.zh} — ${t.hint}`, t.value));
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
  syncInlineAvailability();

  $('display-mode').value = settings.displayMode;
  $('auto-translate').checked = !!settings.autoTranslate;
  $('auto-sites').value = (settings.autoTranslateSites || []).join('\n');
  $('never-sites').value = (settings.neverSites || []).join('\n');
  $('min-chars').value = settings.minAutoChars;
  $('max-nodes').value = settings.maxNodes;
  $('concurrency').value = String(settings.concurrency);
  $('cache-enabled').checked = settings.cacheEnabled !== false;
  $('theme').value = settings.theme;
  document.documentElement.dataset.theme = settings.theme || 'auto';
  document.documentElement.lang = settings.uiLang === 'en' ? 'en' : 'zh-CN';
}

async function patchSettings(patch) {
  const res = await send({ type: 'lt:settings:set', payload: { patch } });
  settings = res.settings;
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const p = pending;
      pending = {};
      try {
        settings = (await send({ type: 'lt:settings:set', payload: { patch: p } })).settings;
      } catch (err) {
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
    if (support.translator) parts.push(`内置翻译模型：${statusLabel(res.translator)}`);
    if (support.nano) parts.push(`Nano：${statusLabel(res.nano)}`);
    if (!support.translator && !support.nano) {
      pill.textContent = '本机不可用';
      pill.className = 'pill err';
      return { support, res };
    }
    pill.textContent = support.translator && res.translator === 'available' ? '本地模型就绪' : parts[0];
    pill.className = `pill ${res.translator === 'available' || res.nano === 'available' ? 'ok' : res.translator === 'unavailable' && !support.nano ? 'err' : 'warn'}`;
    return { support, res };
  } catch (err) {
    pill.textContent = '未知';
    pill.className = 'pill err';
    return null;
  }
}

function statusLabel(status) {
  switch (status) {
    case 'available':
      return '已就绪';
    case 'downloadable':
      return '待下载';
    case 'downloading':
      return '下载中';
    case 'unsupported':
      return '不支持';
    case 'unavailable':
      return '不可用';
    default:
      return status || '未知';
  }
}

/**
 * Gemini Nano「不可用 / 不支持」时给一句可操作的指引，而不是只说「不可用」。
 * downloadable → 其实是好消息：点一下「让 Chrome 下载 Gemini Nano」就能启用。
 */
function nanoHint(status) {
  if (status === 'downloadable' || status === 'downloading') {
    return `${statusLabel(status)}：点下方「让 Chrome 下载 Gemini Nano」即可启用`;
  }
  return `${statusLabel(status)}：多为模型未下载或硬件不满足 —— 先点「让 Chrome 下载 Gemini Nano」试一次；仍失败则点失败提示里的「打开 chrome://components」，找 "Optimization Guide Manifest Component: nano_v3_gpu_component"（名字含 nano 的那个）点「检查更新」，状态由 New 变 Up-to-date 即模型已装好；若状态不变，多为硬件不满足（>4GB 显存，或 16GB 内存 + 4 核）或磁盘剩余不足 22GB（下方会显示本机能检测到的部分）`;
}

async function refreshModelList() {
  const box = $('model-list');
  const target = $('tgt-lang').value;
  const source = $('src-lang').value === 'auto' ? 'en' : $('src-lang').value;
  box.innerHTML = '<div class="model-row"><span class="spinner"></span>检测中…</div>';
  try {
    const { support, res } = (await refreshEnginePill()) || {};
    const rows = [];
    const dot = (s) => (s === 'available' ? 'ok' : s === 'downloadable' || s === 'downloading' ? 'warn' : 'err');
    if (support && support.translator) {
      rows.push(
        `<div class="model-row"><span class="dot ${dot(res.translator)}"></span><b>内置翻译模型</b><span class="muted small">${langLabel(source)} → ${langLabel(target)}：${statusLabel(res.translator)}</span></div>`,
      );
    } else {
      rows.push('<div class="model-row"><span class="dot err"></span><b>内置翻译模型</b><span class="muted small">当前环境不可用</span></div>');
    }
    if (support && support.nano) {
      rows.push(
        `<div class="model-row"><span class="dot ${dot(res.nano)}"></span><b>Gemini Nano</b><span class="muted small">${nanoHint(res.nano)}</span></div>`,
      );
    } else {
      rows.push('<div class="model-row"><span class="dot err"></span><b>Gemini Nano</b><span class="muted small">当前环境不可用（浏览器没有 Prompt API；硬件不满足或 Chrome 版本过旧）</span></div>');
    }
    const host = res && res.host;
    rows.push(
      `<div class="model-row"><span class="dot"></span><span class="muted small">后台推理宿主：${escapeHtml(
        host === 'offscreen'
          ? '离屏文档（Service Worker 里不可用时自动切换）'
          : host === 'sw'
            ? 'Service Worker'
            : '自动选择',
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
    box.innerHTML = `<div class="muted small">检测失败：${escapeHtml(err.message)}</div>`;
  }
}

async function refreshDiag() {
  const box = $('diag');
  box.innerHTML = '<span class="spinner"></span> 检测中…';
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
        pairLines.push(`${langLabel(src)} → ${langLabel(t)}：检测失败`);
      }
    }
    const cache = await send({ type: 'lt:cache:size' });
    box.innerHTML = [
      `Chrome：${ua ? ua[1] : '未知'}`,
      `Translator API：${support.translator ? '支持' : '不支持'}`,
      `LanguageDetector API：${support.detector ? '支持' : '不支持'}`,
      `Prompt API (Gemini Nano)：${support.nano ? '支持' : '不支持'}`,
      `CPU 逻辑核心：${navigator.hardwareConcurrency || '未知'}`,
      `内存（近似）：${navigator.deviceMemory ? `${navigator.deviceMemory} GB` : '未知'}`,
      `缓存条目：${cache.size}`,
      `当前引擎：${settings ? settings.engine : '-'}`,
      `后台推理宿主：${res.host || '自动选择'}`,
      '提示：availability 只代表「能力支持」，create 还取决于上下文（文档 / 用户手势）',
      '点「分环境自检」可以对比侧边栏与后台两边的真实创建结果',
      '— 语言对可用性 —',
      ...pairLines,
    ]
      .map((line) => `<div>${escapeHtml(line)}</div>`)
      .join('');
  } catch (err) {
    box.textContent = `检测失败：${err.message}`;
  }
}

/* ------------------------------ 文本翻译 ------------------------------ */

let currentTranslation = '';
let streamPort = null;
let streamTimer = null;

function setOutMeta(text) {
  $('out-meta').textContent = text;
}

function setOutput(html, isPlaceholder = false) {
  const out = $('output');
  out.innerHTML = html ? html : '<span class="placeholder">译文会显示在这里</span>';
  out.dataset.placeholder = isPlaceholder ? '1' : '';
}

function stopStream() {
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
  setOutMeta('本地推理中…');
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
          setOutMeta(`正在下载语言包 ${(msg.progress * 100).toFixed(0)}%`);
        } else if (msg.type === 'done') {
          if (!got && !currentTranslation) {
            reject(new Error('empty'));
            return;
          }
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.error));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!got && !currentTranslation) reject(new Error('port-disconnected'));
        else resolve();
      });
      port.postMessage({ type: 'start', ...payload });
      streamTimer = setTimeout(() => {
        if (!got && !currentTranslation) reject(new Error('timeout'));
      }, 25000);
    });
  } catch (err) {
    // 流式失败 → 普通翻译（同时能拿到更准确的错误信息）
    try {
      const res = await send({ type: 'lt:translate', payload });
      currentTranslation = res.text || '';
      setOutput(renderText(currentTranslation));
      setOutMeta(
        `${langLabel(res.sourceLang)} → ${langLabel(res.targetLang)} · ${res.engine === 'nano' ? 'Gemini Nano' : '内置翻译模型'} · ${Math.round(
          performance.now() - started,
        )} ms${res.fallbackFrom ? ' · 内置翻译模型不可用，已自动改用 Gemini Nano' : ''}`,
      );
      btn.disabled = false;
      if (streamTimer) clearTimeout(streamTimer);
      return;
    } catch (err2) {
      showError($('text-error'), err2.message);
      setOutput('');
      setOutMeta('翻译失败');
      btn.disabled = false;
      return;
    }
  }
  if (streamTimer) clearTimeout(streamTimer);
  const engineName = settings && settings.engine === 'nano' ? 'Gemini Nano' : '本地翻译模型';
  setOutMeta(`${langLabel($('src-lang').value)} → ${langLabel($('tgt-lang').value)} · ${engineName} · ${Math.round(performance.now() - started)} ms`);
  btn.disabled = false;
}

async function explainCurrent() {
  const text = $('input').value.trim() || currentTranslation;
  if (!text) return;
  showError($('text-error'), '');
  $('do-explain').disabled = true;
  setOutMeta('Gemini Nano 解释中…');
  setOutput('<span class="spinner"></span>', true);
  try {
    const res = await send({ type: 'lt:explain', payload: { text, lang: settings.uiLang } });
    setOutput(renderText(res.text));
    setOutMeta('Gemini Nano 解释');
  } catch (err) {
    showError($('text-error'), err.message);
    setOutput('');
  } finally {
    $('do-explain').disabled = false;
  }
}

/* ------------------------------ 页面翻译 ------------------------------ */

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
    titleEl.textContent = '无活动标签页';
    urlEl.textContent = '';
    return;
  }
  titleEl.textContent = activeTab.title || '（无标题）';
  urlEl.textContent = activeTab.url || '';
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
    $('page-status').textContent = `无法读取页面状态：${err.message}`;
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
  const label =
    phase === 'working'
      ? `翻译中… ${st.done || 0}/${st.total || '?'} 段`
      : phase === 'done'
        ? `已翻译 ${st.translated || st.nodes || 0} 段${st.mode === 'hover' ? '（悬停对照模式）' : ''}${st.sourceLang ? ` · ${langLabel(st.sourceLang)} → ${langLabel(st.target || '')}` : ''}`
        : st.error
          ? `失败：${st.error}`
          : '未翻译';
  $('page-status').textContent = label;
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
    if (res && res.skipped === 'same-language') $('page-status').textContent = '页面已经是目标语言';
    if (res && res.skipped === 'no-text') $('page-status').textContent = '没有找到可翻译的文本';
  } catch (err) {
    $('page-status').textContent = `失败：${err.message}`;
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
    $('page-status').textContent = `还原失败：${err.message}`;
  }
}

async function translateSelection(explain = false) {
  if (!activeTab || typeof activeTab.id !== 'number') return;
  const box = $('sel-result');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span>读取选中文本…';
  try {
    const sel = await chrome.tabs.sendMessage(activeTab.id, { type: 'lt:get-selection' });
    const text = sel && sel.text;
    if (!text) {
      box.innerHTML = '<span class="muted">当前页面没有选中的文本</span>';
      return;
    }
    if (explain) {
      const res = await send({ type: 'lt:explain', payload: { text, lang: settings.uiLang } });
      box.innerHTML = `<div class="muted small">Gemini Nano 解释：</div>${renderText(res.text)}`;
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
  $('dl-status').textContent = '正在准备下载（首次可能较慢，请保持网络畅通）…';

  // 关键点：在这里（侧边栏文档 + 真实点击手势）直接调用 Translator.create()。
  // 规范要求创建 Translator 需要「最近有用户交互的文档」，Service Worker 里没有文档也没有手势，
  // 因此后台调用 create() 可能被 Chrome 拒绝（NotSupportedError）。
  try {
    await warmupLocal(source, target, {
      onDownload: (p) => {
        const percent = Math.round((p || 0) * 100);
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${percent}%`;
        $('dl-status').textContent = `正在下载语言包… ${percent}%`;
      },
    });
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '100%';
    $('dl-status').textContent = `✅ 语言包已就绪：${langLabel(source)} → ${langLabel(target)}，之后完全离线可用。`;
    await refreshModelList();
    return { ok: true };
  } catch (err) {
    // 侧边栏里也失败 → 再问一次后台，把两个环境的结果都摆出来，方便定位
    const bg = await send({ type: 'lt:warmup', payload: { source, target } }).catch((e) => ({ ok: false, error: e.message }));
    const code = err && err.code;
    $('dl-status').textContent = `下载失败：${err && err.message ? err.message : String(err)}`;
    showDlHint(
      [
        code === 'pair-create-failed' || code === 'unsupported-pair'
          ? '<b>Chrome 拒绝为这个语言对创建翻译实例。</b>'
          : '<b>语言包创建失败。</b>',
        '① 立刻能用：切到 Gemini Nano（这台机器上已就绪），翻译不受影响。',
        '② 检查语言包：新标签打开 <code>chrome://components</code> → 找 <b>Chrome TranslateKit</b> → 点「检查更新」。',
        '③ 解除语言对限制：<code>chrome://flags/#translation-api</code> → 选 <b>Enabled without language pack limit</b> → 重启 Chrome（若无此开关请忽略）。',
        '④ 换个语言对验证（例如 英语 → 日语）：若只有当前这个对失败，说明是语言包问题而不是扩展问题。',
        `⑤ 后台上下文结果：${bg && bg.ok ? '创建成功' : (bg && bg.error) || '失败'}`,
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
  $('dl-status').textContent = '正在触发 Gemini Nano 下载（约 2~4GB，请保持网络与非计费连接）…';
  try {
    const local = await ensureNanoModelLocal({
      onDownload: (p) => {
        const percent = Math.round((p || 0) * 100);
        bar.parentElement.classList.remove('indeterminate');
        bar.style.width = `${percent}%`;
        $('dl-status').textContent = `正在下载 Gemini Nano… ${percent}%`;
      },
    });
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '100%';
    $('dl-status').textContent = `✅ Gemini Nano 已就绪（${statusLabel(local.status)}），术语表 / 语气 / 解释现在都能用了。`;
    await refreshModelList();
    return { ok: true };
  } catch (err) {
    // 本页失败（可能这个 Chrome 版本要求模型「本来就绪」才能 create）→ 问后台再试一次
    const bg = await send({ type: 'lt:nano:ensure', payload: {} }).catch((e) => ({ ok: false, error: e.message }));
    if (bg && bg.ok) {
      bar.style.width = '100%';
      $('dl-status').textContent = '✅ Gemini Nano 已就绪（后台上下文确认可用）。';
      await refreshModelList();
      return { ok: true };
    }
    bar.parentElement.classList.remove('indeterminate');
    bar.style.width = '0%';
    $('dl-status').textContent = `下载失败：${(err && err.message) || String(err)}`;
    const hw = await checkNanoHardware().catch(() => null);
    showDlHint(
      [
        '<b>Gemini Nano 没能就绪。</b>按顺序检查：',
        '① 点下面的「打开 chrome://components」→ 找 <b>Optimization Guide Manifest Component: nano_v3_gpu_component</b>（名字里含 nano 的那个）→ 点「检查更新」，等状态从 <b>New</b> 变成 <b>Up-to-date</b>（约 2GB）；',
        '② 确认 <code>chrome://flags/#prompt-api-for-gemini-nano</code>（若存在）为 <b>Enabled</b> 并重启浏览器；',
        '③ 硬件要求：&gt;4GB 显存，或 16GB 内存 + 4 核以上；磁盘至少 22GB 可用；',
        '④ 点下面的「打开 on-device-internals」→ Model Status 看具体错误。',
        `⑤ 后台上下文结果：${bg && bg.error ? escapeHtml(bg.error) : '失败'}`,
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
      $('dl-status').textContent = `无法直接跳转（${err.message}），已把地址复制到剪贴板，请手动粘贴到地址栏：${url}`;
    } catch {
      $('dl-status').textContent = `无法直接跳转（${err.message}），请手动在地址栏输入：${url}`;
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
  parts.push(`本机检测：CPU ${hw.cores || '未知'} 核 · 内存约 ${hw.memoryGB ? `${hw.memoryGB}GB` : '未知（Chrome 未暴露）'}`);
  if (hw.quotaGB != null) {
    parts.push(`存储配额约 ${hw.quotaGB.toFixed(1)}GB（不等于磁盘总剩余空间，仅供参考）`);
  }
  if (hw.reasons.length) {
    parts.push(`⚠️ ${hw.reasons.join('；')}`);
  } else if (hw.cpuMemOk === true) {
    parts.push('CPU/内存达标；显存无法在浏览器里检测，仍需 chrome://components 确认模型是否真的下完');
  }
  box.innerHTML = parts.map((p) => escapeHtml(p)).join('<br>');
  box.hidden = false;
}

/** 分环境自检：侧边栏文档 vs 扩展后台，把 availability 与 create 的真实结果都打出来 */
async function runSelftest() {
  const { source } = pairFromUI();
  const target = $('tgt-lang').value;
  const box = $('diag');
  box.innerHTML = '<span class="spinner"></span> 正在自检（会在两个上下文里各创建一次模型，可能需要几秒）…';
  const lines = [
    `语言对：${langLabel(source)} → ${langLabel(target)}`,
    `Chrome：${(navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/) || [])[1] || '未知'}`,
  ];
  let local = null;
  let bg = null;

  lines.push('', '【侧边栏（文档 + 用户手势）】');
  try {
    local = await selftestLocal({ source, target });
    lines.push(`availability：${local.availability}`);
    lines.push(`create：${local.create}${local.createError ? ` — ${local.createError}` : ''}`);
    if (local.sample) lines.push(`试译：${String(local.sample).slice(0, 60)}`);
    lines.push(
      `Gemini Nano：availability=${local.nanoAvailability} / create=${local.nanoCreate}${local.nanoCreateError ? ` — ${local.nanoCreateError}` : ''}`,
    );
  } catch (err) {
    lines.push(`自检失败：${err.message}`);
  }

  lines.push('', '【扩展后台（Service Worker）】');
  try {
    bg = await send({ type: 'lt:selftest', payload: { source, target } });
    lines.push(`availability：${bg.availability}`);
    lines.push(`create：${bg.create}${bg.createError ? ` — ${bg.createError}` : ''}`);
    lines.push(
      `Gemini Nano：availability=${bg.nanoAvailability} / create=${bg.nanoCreate}${bg.nanoCreateError ? ` — ${bg.nanoCreateError}` : ''}`,
    );
    lines.push(`后台宿主：${bg.host || '-'}`);
  } catch (err) {
    lines.push(`自检失败：${err.message}`);
  }

  box.innerHTML = lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
  box.dataset.raw = lines.join('\n');

  // 给一句结论，省得用户自己比对
  const nanoOk = (local && local.nanoCreate === 'ok') || (bg && bg.nanoCreate === 'ok');
  if (local && local.create === 'ok') {
    showDlHint(
      `✅ 侧边栏里可以创建该语言对的翻译实例${
        bg && bg.create === 'failed' ? '，但后台不能（Chrome 只允许「有用户手势的文档」创建）——扩展会自动改用离屏文档 / Gemini Nano，正常可用。' : '。'
      }`,
    );
  } else if (local && local.create === 'failed') {
    showDlHint(
      [
        `⚠️ 侧边栏里也创建失败：<code>${escapeHtml(local.createError || '')}</code>`,
        `说明这个语言对的语言包在 Chrome 侧不可用（availability 只是能力查询，Chrome 会刻意模糊语言包状态）。`,
        nanoOk
          ? '这台机器的 Gemini Nano 正常 → 建议直接点上面的「改用 Gemini Nano 引擎」，翻译/解释都不受影响。'
          : 'Gemini Nano 也不可用，请检查 chrome://on-device-internals 与硬件要求。',
        '另外建议：chrome://components → Chrome TranslateKit 点「检查更新」，以及 chrome://flags/#translation-api 选 “Enabled without language pack limit」。',
      ].join('<br>'),
    );
  } else {
    showDlHint('自检未拿到结果，请查看下面的原始输出。');
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
  $('inline-never').addEventListener('input', () =>
    saveDebounced({ inlineNeverSites: $('inline-never').value.split('\n').map((s) => s.trim()).filter(Boolean) }),
  );
  $('display-mode').addEventListener('change', () => patchSettings({ displayMode: $('display-mode').value }));
  $('auto-translate').addEventListener('change', () => patchSettings({ autoTranslate: $('auto-translate').checked }));
  $('auto-sites').addEventListener('input', () =>
    saveDebounced({ autoTranslateSites: $('auto-sites').value.split('\n').map((s) => s.trim()).filter(Boolean) }),
  );
  $('never-sites').addEventListener('input', () =>
    saveDebounced({ neverSites: $('never-sites').value.split('\n').map((s) => s.trim()).filter(Boolean) }),
  );
  $('min-chars').addEventListener('change', () => patchSettings({ minAutoChars: Number($('min-chars').value) || 0 }));
  $('max-nodes').addEventListener('change', () => patchSettings({ maxNodes: Number($('max-nodes').value) || 3000 }));

  // 性能与显示
  $('concurrency').addEventListener('change', () => patchSettings({ concurrency: Number($('concurrency').value) || 2 }));
  $('cache-enabled').addEventListener('change', () => patchSettings({ cacheEnabled: $('cache-enabled').checked }));
  $('cache-clear').addEventListener('click', async () => {
    await send({ type: 'lt:cache:clear' });
    const size = await send({ type: 'lt:cache:size' });
    $('cache-size').textContent = `已清空（${size.size} 条）`;
  });
  $('engine-reset').addEventListener('click', async () => {
    const btn = $('engine-reset');
    // 释放并重建两个链路的原生会话（Nano 会话 + 内置翻译会话）
    await send({ type: 'lt:engine:reset' });
    btn.textContent = '已重置 ✓';
    setTimeout(() => {
      btn.textContent = btn.dataset.label || '重置本地会话';
    }, 1600);
  });
  $('theme').addEventListener('change', () => {
    document.documentElement.dataset.theme = $('theme').value;
    patchSettings({ theme: $('theme').value });
  });

  // 文本面板
  const input = $('input');
  input.addEventListener('input', () => {
    $('count').textContent = `${input.value.length} 字`;
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
    $('count').textContent = '0 字';
    currentTranslation = '';
    setOutput('');
    setOutMeta('译文');
    showError($('text-error'), '');
  });
  $('do-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      input.value = text;
      $('count').textContent = `${text.length} 字`;
      translateCurrent();
    } catch (err) {
      showError($('text-error'), '无法读取剪贴板，请手动粘贴（Ctrl/Cmd + V）');
    }
  });
  $('out-copy').addEventListener('click', async () => {
    if (!currentTranslation) return;
    await navigator.clipboard.writeText(currentTranslation);
    $('out-copy').textContent = '已复制 ✓';
    setTimeout(() => ($('out-copy').textContent = '复制'), 1200);
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
    $('count').textContent = `${currentTranslation.length} 字`;
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
  $('download-models').addEventListener('click', downloadPair);
  $('nano-download').addEventListener('click', downloadNano);
  $('diag-refresh').addEventListener('click', refreshDiag);
  $('selftest').addEventListener('click', runSelftest);
  $('diag-selftest').addEventListener('click', runSelftest);
  $('use-nano').addEventListener('click', async () => {
    try {
      settings = (await send({ type: 'lt:settings:set', payload: { patch: { engine: 'nano' } } })).settings;
      syncForm();
      $('dl-status').textContent = '已切换到 Gemini Nano：翻译、解释都会使用本机的 Gemini Nano 模型。';
      showDlHint('');
      await refreshModelList();
    } catch (err) {
      $('dl-status').textContent = `切换失败：${err.message}`;
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
    out.textContent = '正在问每一层框架…';
    try {
      await refreshActiveTab();
      if (!activeTab) throw new Error('没有活动标签页');
      const res = await send({ type: 'lt:inline-status-all', payload: { tabId: activeTab.id } });
      const frames = (res && res.frames) || [];
      const lines = [];
      lines.push(`活动标签页：${activeTab.url || ''}`);
      lines.push(`认领的框架：${res && res.claimFrame != null ? `#${res.claimFrame}` : '（还没有：先在输入框里打几个字）'}`);
      lines.push('');
      if (!frames.length) {
        lines.push('没有任何框架回答 —— 内容脚本没注入（chrome:// 等特殊页面不支持）。');
      }
      for (const f of frames) {
        const where = f.top ? '顶层页面' : `iframe #${f.frameId}`;
        lines.push(`【${where}】 ${f.url}`);
        lines.push(
          `  转写：${f.enabled ? '已启用' : '已关闭'}（模式 ${f.mode || '-'}）  焦点：${
            f.hasFocus ? '有' : '无'
          }  目标：${f.hasTarget ? `有（${f.kind === 'agent' ? '封闭 Shadow DOM，靠主世界助手' : '普通元素'} ${f.tag}）` : '无'}`,
        );
        lines.push(`  读到字符数：${f.chars == null ? '—' : f.chars}`);
        lines.push('');
      }
      lines.push('怎么读这份报告：');
      lines.push('· 某个 iframe 那行「目标：有」「读到字符数 > 0」→ 扩展看得见那个输入框，转写应该正常。');
      lines.push('· 所有框架都「目标：无」→ 扩展没抓到那个输入框（请把这行截图/复制给我）。');
      lines.push('· 「读到字符数 = 0」但有目标 → 抓到了元素却没读到文字（多半是特殊的富文本编辑器）。');
      out.dataset.raw = lines.join('\n');
      out.textContent = lines.join('\n');
    } catch (err) {
      out.textContent = `自检失败：${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  $('diag-copy').addEventListener('click', async () => {
    const text = $('diag').dataset.raw || $('diag').innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      $('diag-copy').textContent = '已复制 ✓';
    } catch (err) {
      $('diag-copy').textContent = '复制失败';
    }
    setTimeout(() => ($('diag-copy').textContent = '复制诊断信息'), 1400);
  });

  // 来自 background 的广播
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'lt:page-status' && activeTab && msg.payload && msg.payload.tabId === activeTab.id) {
      pageStatus = msg.payload.status || {};
      renderPageStatus();
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
      $('dl-status').textContent = `正在下载语言包… ${p}%`;
      $('dl-bar').style.width = `${p}%`;
    } else if (msg.type === 'lt:settings' && msg.payload) {
      settings = msg.payload;
      syncForm();
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
  fillLanguageSelects();
  bindEvents();
  try {
    const res = await send({ type: 'lt:settings:get' });
    settings = res.settings;
  } catch (err) {
    showError($('text-error'), '无法读取设置，请重新加载扩展');
  }
  syncForm();
  // 从「扩展详情 → 选项」进来时（panel.html#settings）直接落到设置页
  const wanted = (location.hash || '').replace('#', '');
  if (wanted) {
    const btn = document.querySelector(`.tab-btn[data-tab="${wanted}"]`);
    if (btn) btn.click();
  }
  await refreshEnginePill();
  await refreshActiveTab();
  const size = await send({ type: 'lt:cache:size' }).catch(() => ({ size: 0 }));
  $('cache-size').textContent = `${size.size} 条`;
  $('input').focus();
})();
