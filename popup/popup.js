/**
 * popup/popup.js —— 工具栏弹窗（快速翻译）
 */
import { LANGUAGES, langLabel, normalizeCode } from '../lib/languages.js';
import { TONES } from '../lib/engine.js';

const $ = (id) => document.getElementById(id);

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

/** 扩展重载/更新后，旧弹窗里的 chrome.* 调用会拿到英文报错，统一转成人话 */
function friendlyError(msg) {
  const text = String(msg || '');
  if (/extension context invalidated/i.test(text)) {
    return '与扩展后台的连接已断开（扩展刚被重新加载或更新）。请关闭弹窗后重新打开。';
  }
  if (/receiving end does not exist|message port closed/i.test(text)) {
    return '暂时联系不上扩展后台（可能正在启动）。请稍等一两秒后重试。';
  }
  return text;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderText(text) {
  return escapeHtml(String(text))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

let settings = null;
let currentTranslation = '';
let busy = false;

function setOutput(html) {
  $('output').innerHTML = html || '<span class="placeholder">本地模型输出</span>';
}

function setError(message) {
  const el = $('error');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function fillLanguageSelects() {
  for (const [id, withAuto] of [['src-lang', true], ['tgt-lang', false]]) {
    const sel = $(id);
    sel.innerHTML = '';
    if (withAuto) sel.appendChild(new Option('自动检测', 'auto'));
    for (const l of LANGUAGES) sel.appendChild(new Option(l.zh, l.code));
  }
}

async function refreshPill() {
  const pill = $('engine-pill');
  try {
    const res = await send({ type: 'lt:probe', payload: {} });
    const label = (s) =>
      ({ available: '已就绪', downloadable: '待下载', downloading: '下载中', unavailable: '不可用', unsupported: '不支持' })[s] || s;
    if (res.support && res.support.translator) {
      pill.textContent = `内置模型：${label(res.translator)}`;
      pill.className = `pill ${res.translator === 'available' ? 'ok' : 'warn'}`;
    } else if (res.support && res.support.nano) {
      pill.textContent = `Nano：${label(res.nano)}`;
      pill.className = `pill ${res.nano === 'available' ? 'ok' : 'warn'}`;
    } else {
      pill.textContent = '本机不可用';
      pill.className = 'pill err';
    }
  } catch (err) {
    pill.textContent = '未知';
    pill.className = 'pill err';
  }
}

async function translate() {
  const text = $('input').value.trim();
  if (!text || busy) return;
  busy = true;
  setError('');
  $('do-translate').disabled = true;
  $('out-meta').textContent = '本地推理中…';
  setOutput('<span class="spinner"></span>');
  const started = performance.now();
  try {
    const res = await send({
      type: 'lt:translate',
      payload: { text, source: $('src-lang').value, target: $('tgt-lang').value },
    });
    currentTranslation = res.text || '';
    setOutput(renderText(currentTranslation));
    $('out-meta').textContent = `${langLabel(res.sourceLang)} → ${langLabel(res.targetLang)} · ${
      res.engine === 'nano' ? 'Gemini Nano' : '内置翻译模型'
    } · ${Math.round(performance.now() - started)} ms`;
  } catch (err) {
    setError(err.message);
    setOutput('');
    $('out-meta').textContent = '翻译失败';
  } finally {
    busy = false;
    $('do-translate').disabled = false;
  }
}

async function explain() {
  const text = $('input').value.trim() || currentTranslation;
  if (!text || busy) return;
  busy = true;
  setError('');
  $('out-meta').textContent = 'Gemini Nano 解释中…';
  setOutput('<span class="spinner"></span>');
  try {
    const res = await send({ type: 'lt:explain', payload: { text, lang: settings ? settings.uiLang : 'zh' } });
    setOutput(renderText(res.text));
    $('out-meta').textContent = 'Gemini Nano 解释';
  } catch (err) {
    setError(err.message);
    setOutput('');
  } finally {
    busy = false;
  }
}

(async function main() {
  fillLanguageSelects();
  try {
    const res = await send({ type: 'lt:settings:get' });
    settings = res.settings;
  } catch (err) {
    setError('无法读取设置，请重新加载扩展');
  }
  if (settings) {
    $('src-lang').value = settings.sourceLang;
    $('tgt-lang').value = settings.targetLang;
    document.documentElement.dataset.theme = settings.theme || 'auto';
  }
  refreshPill();

  $('do-translate').addEventListener('click', translate);
  $('do-explain').addEventListener('click', explain);
  $('do-clear').addEventListener('click', () => {
    $('input').value = '';
    currentTranslation = '';
    setOutput('');
    setError('');
    $('out-meta').textContent = '译文';
    $('input').focus();
  });
  $('swap').addEventListener('click', () => {
    const s = $('src-lang').value;
    const t = $('tgt-lang').value;
    $('src-lang').value = t;
    $('tgt-lang').value = s === 'auto' ? 'en' : s;
    send({ type: 'lt:settings:set', payload: { patch: { sourceLang: t, targetLang: s === 'auto' ? 'en' : s } } }).catch(() => {});
  });
  $('src-lang').addEventListener('change', () =>
    send({ type: 'lt:settings:set', payload: { patch: { sourceLang: $('src-lang').value } } }).catch(() => {}),
  );
  $('tgt-lang').addEventListener('change', () =>
    send({ type: 'lt:settings:set', payload: { patch: { targetLang: $('tgt-lang').value } } }).catch(() => {}),
  );
  $('input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      translate();
    }
  });
  $('out-copy').addEventListener('click', async () => {
    if (!currentTranslation) return;
    await navigator.clipboard.writeText(currentTranslation).catch(() => {});
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
  $('open-panel').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      await chrome.runtime.openOptionsPage().catch(() => {});
    }
    window.close();
  });
  // 整页翻译：按钮上写明用的是哪种显示方式（换设置后跟着变）
  function wirePageButton(id, label, mode) {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      btn.textContent = '翻译中…';
      try {
        await send({ type: 'lt:page:translate', payload: { tabId: tab.id, mode } });
        btn.textContent = '已开始 ✓';
      } catch (err) {
        setError(err.message);
        btn.textContent = label;
      }
    });
  }
  wirePageButton('translate-page', '翻译整页', 'replace');
  wirePageButton('translate-dual', '双语对照', 'dual');

  // 打开弹窗时若剪贴板里是长文本，自动填入并翻译（失败则忽略）
  try {
    const clip = await navigator.clipboard.readText();
    if (clip && clip.length > 8 && clip.length < 6000 && /[\p{L}]{3,}/u.test(clip)) {
      $('input').value = clip;
    }
  } catch (err) {
    /* 没有剪贴板权限就算了 */
  }
  $('input').focus();
})();
