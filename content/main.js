/**
 * content/main.js —— 页面侧主控：
 *   1) 划词翻译气泡（选中即译，自动识别语言）
 *   2) 整页翻译（替换原文 / 双语对照：在每段下方插入译文 / 悬停对照）
 *   3) 悬停对照翻译（鼠标停在段落上显示译文）
 *   4) 自动翻译（按域名白名单）
 *
 * 真正的模型调用全部交给 background（Service Worker）里的 lib/engine.js，
 * 内容脚本只负责「取文本 / 放译文 / 画 UI」。
 */
(function () {
  const NS = globalThis.__LOCAL_TRANSLATE__;
  if (!NS || NS.started) return;
  NS.started = true;

  const U = NS.util;
  const ui = NS.ui;

  /** 是否顶层 frame：只有顶层显示进度条 / 上报状态 / 自动翻译，子 frame 静默干活 */
  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch (err) {
      return false;
    }
  })();

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TITLE',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
    'VIDEO', 'AUDIO', 'MAP', 'AREA', 'HEAD', 'META', 'LINK', 'BASE', 'NOSCRIPT', 'DIALOG',
  ]);
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'FIGURE', 'FIGCAPTION',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY',
    'TR', 'TD', 'TH', 'CAPTION', 'BLOCKQUOTE', 'PRE', 'ADDRESS', 'BUTTON', 'LABEL', 'SUMMARY', 'DETAILS',
    'FORM', 'FIELDSET', 'LEGEND', 'BODY', 'HTML', 'HGROUP', 'TIME', 'OUTPUT', 'OPTION', 'MENU', 'DIALOG',
  ]);
  const BATCH_SIZE = 20;

  /** 初始化之后被显式改过的设置项：迟到的「完整设置」不能把它们盖回去 */
  const settingsTouched = new Set();
  const settingsWaiters = [];

  const state = {
    settings: null,
    token: 0,
    phase: 'idle', // idle | working | done
    mode: 'replace', // replace | dual | hover
    nodes: new Map(), // TextNode -> {original, translated}（替换模式）
    dualItems: new Map(), // 块元素 -> { el, source }（双语对照模式插入的节点）
    lastSelection: null,
    sourceLang: 'auto',
    hoverBound: false,
    hoverNodes: null,
    observer: null,
    queue: new Set(),
    inflight: new Set(),
    lastError: '',
    dead: false, // 扩展被重载 / 更新后，这个脚本就哑了
  };

  /* ----------------------------- 与 background 通信 ----------------------------- */

  /** 扩展上下文是否已失效（重载/更新后，页面里的旧脚本会哑掉） */
  function isStale() {
    return state.dead || !U.extAlive();
  }

  function staleError() {
    const err = new Error(U.staleText());
    err.code = 'context-invalidated';
    return err;
  }

  function markDead() {
    if (state.dead) return;
    state.dead = true;
    state.phase = 'idle';
    state.token += 1;
    try {
      if (IS_TOP && ui.notice) ui.notice(U.staleText());
    } catch (err) {
      /* 忽略 */
    }
  }

  function normalizeErr(err) {
    if (isStale() || U.isContextInvalidated(err)) {
      markDead();
      return staleError();
    }
    return err instanceof Error ? err : new Error(String((err && err.message) || err));
  }

  function sendBG(message) {
    return new Promise((resolve, reject) => {
      if (isStale()) {
        markDead();
        reject(staleError());
        return;
      }
      let settled = false;
      // 旧版 Chrome 在上下文失效后，sendMessage 的回调可能**永远不回来**。
      // 超时后主动探测一次：那时 runtime.id 通常已经消失，就能给出人话报错。
      const timer = setTimeout(() => {
        if (settled) return;
        if (!U.extAlive()) {
          settled = true;
          markDead();
          reject(staleError());
        }
      }, 10000);
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      try {
        chrome.runtime.sendMessage(message, (res) => {
          try {
            const err = chrome.runtime.lastError;
            if (err) finish(reject, normalizeErr(new Error(err.message)));
            else finish(resolve, res);
          } catch (err) {
            finish(reject, normalizeErr(err));
          }
        });
      } catch (err) {
        finish(reject, normalizeErr(err));
      }
    });
  }

  const notifyBG = (type, payload) => sendBG({ type, payload }).catch(() => {});

  /* ----------------------------- 选中的文本 ----------------------------- */

  function selectedText() {
    const el = document.activeElement;
    const editable = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    if (editable && typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart) {
      return String(el.value || '').slice(el.selectionStart, el.selectionEnd).trim();
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return sel.toString().trim();
  }

  /* ----------------------------- 划词气泡 ----------------------------- */

  let selectionRequest = 0;

  async function translateSelection(text, rect, { showSource = true, context = '' } = {}) {
    if (!state.settings) return;
    const req = ++selectionRequest;
    const s = state.settings;
    const engineLabel = s.engine === 'nano' ? 'Gemini Nano' : s.engine === 'translator' ? '本地翻译模型' : '本地模型';
    state.lastSelection = { text, rect, showSource, context };
    ui.showBubble({
      rect,
      sourceText: text,
      translation: '',
      loading: true,
      showSource,
      sourceLang: 'auto',
      targetLang: s.targetLang,
      theme: s.theme,
      engineLabel,
    });
    try {
      const res = await sendBG({
        type: 'lt:translate',
        payload: {
          text,
          source: s.sourceLang || 'auto',
          target: s.targetLang,
          engine: s.engine,
          tone: s.tone,
          glossary: s.glossary,
          context,
        },
      });
      if (req !== selectionRequest) return;
      if (!res || res.ok === false) throw new Error((res && res.error) || '翻译失败');
      ui.showBubble({
        rect,
        translation: res.text,
        sourceText: text,
        showSource,
        sourceLang: res.sourceLang || 'auto',
        targetLang: res.targetLang || s.targetLang,
        engine: res.engine,
        engineLabel: res.engine === 'nano' ? 'Gemini Nano' : '本地翻译模型',
        hint: res.fallbackFrom ? '内置翻译模型不可用，已自动改用 Gemini Nano' : '',
        loading: false,
      });
    } catch (err) {
      if (req !== selectionRequest) return;
      ui.showBubble({ rect, error: String((err && err.message) || err), loading: false, showSource, sourceText: text });
    }
  }

  async function explainText(text, rect) {
    if (!state.settings) return;
    const s = state.settings;
    ui.showBubble({
      rect,
      sourceText: text,
      translation: '',
      loading: true,
      showSource: true,
      targetLang: s.targetLang,
      theme: s.theme,
      engineLabel: 'Gemini Nano',
    });
    try {
      const res = await sendBG({ type: 'lt:explain', payload: { text, lang: s.uiLang } });
      if (!res || res.ok === false) throw new Error((res && res.error) || '解释失败');
      ui.showBubble({ rect, translation: res.text, sourceText: text, loading: false, showSource: true, engineLabel: 'Gemini Nano' });
    } catch (err) {
      ui.showBubble({ rect, error: String((err && err.message) || err), loading: false, showSource: true, sourceText: text });
    }
  }

  function onMouseUp(e) {
    if (e && e.target && e.target.closest && e.target.closest('[data-lt-ui]')) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (anchorEl && (anchorEl.isContentEditable || anchorEl.closest('input, textarea'))) return;
    const text = selectedText();
    if (!text || text.length > 8000 || !U.looksTranslatable(text)) return;
    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (err) {
      rect = null;
    }

    // 若设置已就绪，直接检查开关；若尚未就绪（页面刚加载即划词），等待后再翻译
    if (state.settings) {
      if (!state.settings.showBubble) return;
      translateSelection(text, rect);
    } else {
      const snapRect = rect; // 提前捕获选区位置，等待期间选区可能消失
      whenSettingsReady(4000).then((s) => {
        if (!s || !s.showBubble) return;
        translateSelection(text, snapRect);
      });
    }
  }

  /* ----------------------------- 整页翻译 ----------------------------- */

  function isVisible(el) {
    try {
      if (!el.getClientRects || el.getClientRects().length === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (err) {
      return true;
    }
  }

  function acceptTextNode(node) {
    if (state.nodes.has(node)) return false;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return false;
    const text = raw.trim();
    const el = node.parentElement;
    if (!el) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.isContentEditable) return false;
    if (el.closest('[data-lt-skip], [data-lt-dual], [data-lt-ui], [translate="no"], .notranslate, code, pre, kbd, samp, [aria-hidden="true"]')) return false;
    if (text.length > 4000) return false;
    if (!U.looksTranslatable(text)) return false;
    if (!isVisible(el)) return false;
    return true;
  }

  function collectTextNodes(root = document.body, limit = 4000) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (acceptTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    while (walker.nextNode() && out.length < limit) out.push(walker.currentNode);
    return out;
  }

  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || node.parentElement || document.body;
  }

  function buildItems(nodes) {
    const byBlock = new Map();
    for (const node of nodes) {
      const b = blockOf(node);
      const arr = byBlock.get(b);
      if (arr) arr.push(node);
      else byBlock.set(b, [node]);
    }
    const items = [];
    for (const [block, list] of byBlock) {
      const multi = list.length > 1;
      let blockText = '';
      if (multi) {
        blockText = String(block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      }
      for (const node of list) items.push({ node, text: node.nodeValue, context: multi ? blockText : '' });
    }
    return items;
  }

  /* --------------------------- 双语对照（段落下插译文） --------------------------- */

/** 有些块不能在里面塞块级元素（表格单元格的兄弟、列表项的兄弟等），这些改成「插到块里面」 */
const INSERT_INSIDE = new Set([
  'TD', 'TH', 'LI', 'DT', 'DD', 'CAPTION', 'FIGCAPTION', 'LEGEND', 'BUTTON', 'LABEL', 'SUMMARY',
  'BLOCKQUOTE', 'BODY', 'HTML', 'OUTPUT', 'ADDRESS', 'TIME',
]);

/**
 * 把一个块里的若干文本节点拼成一段原文。
 * 直接拼 node.nodeValue 再折叠空白 = 原文本身（跳过的节点自然被排除），
 * 双语对照时整块一起翻译，段落上下文更完整、译文读起来也更连贯。
 */
function blockSourceText(list) {
  let out = '';
  for (const node of list) out += node.nodeValue || '';
  return out.replace(/\s+/g, ' ').trim();
}

/** 按块分组：一个块 → 一条待翻译项 */
function buildBlockItems(nodes) {
  const byBlock = new Map();
  for (const node of nodes) {
    if (node.nodeType !== 3) continue;
    const block = blockOf(node);
    if (!block || state.dualItems.has(block)) continue; // 已经有译文的块，别重复插
    const arr = byBlock.get(block);
    if (arr) arr.push(node);
    else byBlock.set(block, [node]);
  }
  const items = [];
  for (const [block, list] of byBlock) {
    const text = blockSourceText(list);
    if (!text || text.length > 4000) continue;
    items.push({ block, nodes: list, text, context: '' });
  }
  return items;
}

/** 建一个「译文块」元素 */
function makeDualElement(text) {
  const el = document.createElement('div');
  el.className = 'lt-dual-translation';
  el.setAttribute('data-lt-dual', '1');
  el.setAttribute('dir', 'auto');
  const s = state.settings;
  if (s && s.targetLang) {
    try {
      el.setAttribute('lang', U.normalizeCode(s.targetLang));
    } catch (err) {
      /* 忽略 */
    }
  }
  el.textContent = text;
  return el;
}

/**
 * 把译文插到原文段落下方（原文一个字符都不动）。
 * 返回 true 表示插上了/更新了。
 */
function applyDual(item, translated) {
  const block = item && item.block;
  if (!block || !block.isConnected) return false;
  if (typeof translated !== 'string') return false;
  const text = translated.trim();
  if (!text || text === String(item.text || '').trim()) return false;

  const exist = state.dualItems.get(block);
  if (exist && exist.el && exist.el.isConnected) {
    if (exist.el.textContent !== text) exist.el.textContent = text;
    exist.source = item.text || '';
    return true;
  }

  const el = makeDualElement(text);
  try {
    if (INSERT_INSIDE.has(block.tagName)) block.appendChild(el);
    else block.insertAdjacentElement('afterend', el);
  } catch (err) {
    try {
      block.appendChild(el);
    } catch (err2) {
      return false;
    }
  }
  state.dualItems.set(block, { el, source: item.text || '' });
  return true;
}

/** 移除所有插入的译文（还原原文） */
function clearDual() {
  for (const [, entry] of state.dualItems) {
    try {
      if (entry && entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    } catch (err) {
      /* 节点可能已经随页面一起没了 */
    }
  }
  state.dualItems.clear();
}

async function samplePageText() {
    try {
      const t = document.body ? document.body.innerText || '' : '';
      return t.replace(/\s+/g, ' ').trim().slice(0, 1200);
    } catch (err) {
      return '';
    }
  }

  async function startPageTranslation({ mode = '' } = {}) {
    if (!state.settings) await whenSettingsReady();
    const s = state.settings;
    if (!s) return { ok: false, error: '尚未加载设置' };
    if (isStale()) {
      markDead();
      return { ok: false, error: U.staleText(), code: 'context-invalidated' };
    }

    // 清理上一次的结果（restoreAll 会让旧的 token 失效，所以必须先清理再取 token）
    restoreAll({ silent: true });
    const token = ++state.token;
    const want = mode || s.displayMode || 'replace';
    const useHover = want === 'hover';
    const useDual = want === 'dual';
    state.mode = useHover ? 'hover' : useDual ? 'dual' : 'replace';
    state.phase = 'working';
    state.lastError = '';

    if (IS_TOP) {
      ui.showProgress({ title: '正在使用本地模型翻译…' });
      ui.setProgress({ done: 0, total: 1, message: '识别页面语言…' });
    }
    try {
      document.documentElement.setAttribute('data-lt-active', '1');
    } catch (err) {
      /* 忽略 */
    }

    try {
      const sample = await samplePageText();
      let source = s.sourceLang;
      if (source === 'auto' || !source) {
        const det = await sendBG({ type: 'lt:detect', payload: { text: sample || document.title } });
        source = (det && det.language) || U.roughScript(sample) || 'en';
      }
      state.sourceLang = source;

      if (U.normalizeCode(source) === U.normalizeCode(s.targetLang)) {
        if (IS_TOP) {
          ui.setProgress({ done: 1, total: 1, message: `页面已经是「${U.langLabel(s.targetLang)}」，无需翻译` });
          setTimeout(ui.hideProgress, 2600);
        }
        state.phase = 'idle';
        return { ok: true, skipped: 'same-language' };
      }

      const nodes = collectTextNodes(document.body, s.maxNodes || 3000);
      if (!nodes.length) {
        if (IS_TOP) {
          ui.setProgress({ done: 1, total: 1, message: '没有找到可翻译的文本' });
          setTimeout(ui.hideProgress, 2600);
        }
        state.phase = 'idle';
        return { ok: true, skipped: 'no-text' };
      }

      if (useHover) {
        state.hoverNodes = nodes;
        enableHoverMode();
        if (IS_TOP) {
          ui.setProgress({ done: 1, total: 1, message: '悬停对照模式：把鼠标移到段落上即可看到译文' });
          setTimeout(ui.hideProgress, 3200);
          notifyBG('lt:done', { url: location.href, sourceLang: source, target: s.targetLang, nodes: nodes.length, mode: 'hover' });
        }
        state.phase = 'done';
        return { ok: true, mode: 'hover', nodes: nodes.length };
      }

      // 组装待翻译项：
      //   替换模式 → 每个文本节点一条（保持原有 DOM 结构）
      //   双语对照 → 每个段落一条，译文整段插到段落下方
      const items = useDual ? buildBlockItems(nodes) : buildItems(nodes);
      const applyOne = useDual ? applyDual : (it, text) => applyTranslation(it.node, text);
      const total = items.length;
      if (!items.length) {
        if (IS_TOP) {
          ui.setProgress({ done: 1, total: 1, message: '没有找到可翻译的段落' });
          setTimeout(ui.hideProgress, 2600);
        }
        state.phase = 'done';
        return { ok: true, skipped: 'no-text' };
      }
      let done = 0;
      let failed = 0;
      if (IS_TOP) ui.setProgress({ done: 0, total, message: `共 ${total} 段，本地推理中…` });

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        if (token !== state.token) return { ok: false, error: 'aborted' };
        const slice = items.slice(i, i + BATCH_SIZE);
        let res = null;
        try {
          res = await sendBG({
            type: 'lt:translateBatch',
            payload: {
              items: slice.map((it) => ({ text: it.text, context: it.context })),
              options: {
                source,
                target: s.targetLang,
                engine: s.engine,
                tone: s.tone,
                glossary: s.glossary,
              },
            },
          });
        } catch (err) {
          res = null;
        }
        if (token !== state.token) return { ok: false, error: 'aborted' };
        const results = (res && res.results) || [];
        slice.forEach((it, idx) => {
          const r = results[idx];
          if (r && r.text) {
            if (!applyOne(it, r.text)) failed += 1;
          } else {
            failed += 1;
            if (r && r.error) state.lastError = r.error;
          }
        });
        done += slice.length;
        if (IS_TOP) ui.setProgress({ done, total, message: `已翻译 ${done}/${total} 段${failed ? `（${failed} 段失败）` : ''}` });
      }

      state.phase = 'done';
      const msg = failed
        ? `完成：成功 ${done - failed} 段，失败 ${failed} 段${state.lastError ? `（${state.lastError}）` : ''}`
        : `完成：共翻译 ${done} 段`;
      if (IS_TOP) {
        ui.setProgress({ done: total, total, message: msg });
        setTimeout(() => ui.hideProgress(), 3200);
        notifyBG('lt:done', {
          url: location.href,
          sourceLang: source,
          target: s.targetLang,
          nodes: done,
          failed,
          mode: state.mode,
        });
      }
      startWatcher();
      return { ok: true, mode: state.mode, nodes: done, failed };
    } catch (err) {
      state.phase = 'idle';
      const norm = normalizeErr(err);
      const msg = norm.message;
      state.lastError = msg;
      if (IS_TOP) {
        ui.setProgress({ done: 0, total: 1, message: `翻译失败：${msg}` });
        setTimeout(() => ui.hideProgress(), 6000);
      }
      return { ok: false, error: msg, code: norm.code };
    } finally {
      if (state.phase !== 'working') ui.hideProgress();
    }
  }

  /**
   * 替换模式：把译文写进文本节点。
   * 返回值必须明确 —— 调用方用 `if (!applyOne(...)) failed += 1` 统计失败数，
   * 返回 undefined 会让每一段都算成「失败」（曾经真的这样报：「成功 0 段，失败 3 段」）。
   */
  function applyTranslation(node, translated) {
    if (!node || typeof translated !== 'string') return false;
    const original = node.nodeValue;
    if (!original || translated.trim() === original.trim()) return false;
    state.nodes.set(node, { original, translated });
    node.nodeValue = translated;
    if (node.parentElement) node.parentElement.setAttribute('data-lt-translated', '');
    return true;
  }

  function restoreAll({ silent = false } = {}) {
    state.token += 1;
    for (const [node, saved] of state.nodes) {
      try {
        node.nodeValue = saved.original;
        if (node.parentElement) node.parentElement.removeAttribute('data-lt-translated');
      } catch (err) {
        /* 节点可能已被移除 */
      }
    }
    state.nodes.clear();
    clearDual(); // 双语对照模式插入的译文块
    state.queue.clear();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.hoverBound) {
      document.removeEventListener('mouseover', onHover, true);
      state.hoverBound = false;
      state.hoverNodes = null;
      hoverLast = null;
    }
    state.phase = 'idle';
    state.mode = 'replace';
    try {
      document.documentElement.removeAttribute('data-lt-active');
    } catch (err) {
      /* 忽略 */
    }
    if (!silent) {
      ui.hideProgress();
      ui.hideBubble();
    }
    return true;
  }

  /* ----------------------------- 悬停对照 ----------------------------- */

  let hoverLastRun = 0;
  let hoverLast = null;

  function onHover(e) {
    if (state.mode !== 'hover') return;
    const now = performance.now();
    if (now - hoverLastRun < 180) return; // 简单节流：快速划过时不反复请求
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-lt-ui], [data-lt-dual]') || target.isContentEditable) return;
    let el = target;
    while (el && el !== document.body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    if (!el || el === hoverLast) return;
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1200 || !U.looksTranslatable(text)) return;
    hoverLast = el;
    hoverLastRun = now;
    translateSelection(text, el.getBoundingClientRect(), { showSource: false });
  }

  function enableHoverMode() {
    if (state.hoverBound) return;
    state.hoverBound = true;
    document.addEventListener('mouseover', onHover, true);
  }

  /* ----------------------------- 动态内容跟进 ----------------------------- */

  const scheduleFollow = U.debounce(() => followQueue(), 900);

  function startWatcher() {
    if (state.observer || !document.body) return;
    state.observer = new MutationObserver((records) => {
      if (state.phase !== 'done') return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          // 我们自己插进去的译文块 / 气泡，不要当成新内容再翻一遍
          if (node.hasAttribute && node.hasAttribute('data-lt-dual')) continue;
          if (node.matches && node.matches('[data-lt-ui], [data-lt-dual]')) continue;
          state.queue.add(node);
        }
      }
      if (state.queue.size) scheduleFollow();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  async function followQueue() {
    const s = state.settings;
    if (!s || state.phase !== 'done' || !state.mode || state.mode === 'hover') return;
    const roots = [...state.queue];
    state.queue.clear();
    if (!roots.length) return;
    const token = state.token;
    const nodes = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      nodes.push(...collectTextNodes(root, 400));
    }
    if (!nodes.length) return;
    const useDual = state.mode === 'dual';
    const items = useDual ? buildBlockItems(nodes) : buildItems(nodes);
    const applyOne = useDual ? applyDual : (it, text) => applyTranslation(it.node, text);
    if (!items.length) return;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      if (token !== state.token) return;
      const slice = items.slice(i, i + BATCH_SIZE);
      let res = null;
      try {
        res = await sendBG({
          type: 'lt:translateBatch',
          payload: {
            items: slice.map((it) => ({ text: it.text, context: it.context })),
            options: { source: state.sourceLang, target: s.targetLang, engine: s.engine, tone: s.tone, glossary: s.glossary },
          },
        });
      } catch (err) {
        return;
      }
      if (token !== state.token) return;
      const results = (res && res.results) || [];
      slice.forEach((it, idx) => {
        const r = results[idx];
        if (r && r.text) applyOne(it, r.text);
      });
    }
  }

  /* ----------------------------- 设置 & 生命周期 ----------------------------- */

  /**
   * 设置合并。两个容易踩的点（都是真出现过的 bug）：
   *   1. 后台广播的可能只是**一小段补丁**（例如只改了显示方式），整体替换会把
   *      sourceLang / maxNodes / concurrency 一起变成 undefined → 必须合并。
   *   2. 页面刚打开时我们会异步向后台要一次「完整设置」，它可能**很晚才回来**，
   *      把用户此刻刚改过的显式设置又盖回旧值 → 迟到的基线不覆盖显式改动。
   */
  function applySettings(settings, opts = {}) {
    if (!settings) return;
    const baseline = !!opts.baseline;
    const merged = { ...(state.settings || {}) };
    for (const [key, value] of Object.entries(settings)) {
      if (baseline && settingsTouched.has(key) && key in merged) continue;
      merged[key] = value;
    }
    state.settings = merged;
    if (!baseline) for (const key of Object.keys(settings)) settingsTouched.add(key);
    markSettingsReady();
    if (merged.theme) ui.setTheme(merged.theme);
    if (merged.autoTranslate && state.phase === 'idle' && !state.autoDone) {
      state.autoDone = true;
      maybeAutoTranslate();
    }
  }

  /** 用户动作可能在设置送达之前就发生 → 等一小会儿，别把「尚未加载设置」丢给用户 */
  function whenSettingsReady(timeoutMs = 4000) {
    if (state.settings) return Promise.resolve(state.settings);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        markSettingsReady();
        resolve(state.settings);
      }, timeoutMs);
      settingsWaiters.push(() => {
        clearTimeout(timer);
        resolve(state.settings);
      });
    });
  }

  function markSettingsReady() {
    if (!settingsWaiters.length) return;
    const waiters = settingsWaiters.splice(0, settingsWaiters.length);
    for (const fn of waiters) {
      try {
        fn();
      } catch (err) {}
    }
  }

  function getStatus() {
    return {
      phase: state.phase,
      mode: state.mode,
      translated: state.mode === 'dual' ? state.dualItems.size : state.nodes.size,
      sourceLang: state.sourceLang,
      url: location.href,
      error: state.lastError,
    };
  }

  async function maybeAutoTranslate() {
    const s = state.settings;
    if (!s || !s.autoTranslate || !IS_TOP) return; // 子 frame 不自动翻译（避免广告/小挂件被翻）
    const host = U.hostOf(location.href);
    if (U.matchSite(host, s.neverSites)) return;
    if (s.autoTranslateSites && s.autoTranslateSites.length && !U.matchSite(host, s.autoTranslateSites)) return;
    const docLang = U.normalizeCode(document.documentElement.lang || '');
    if (docLang && docLang === U.normalizeCode(s.targetLang)) return;
    const sample = await samplePageText();
    if (sample.length < (s.minAutoChars || 300)) return;
    const rough = U.roughScript(sample);
    if (rough && U.normalizeCode(rough) === U.normalizeCode(s.targetLang)) return;
    await U.sleep(600);
    startPageTranslation({ mode: s.displayMode });
  }

  function onMessage(msg, sender, sendResponse) {
    if (state.dead) return false;
    if (!U.extAlive()) {
      markDead();
      return false;
    }
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'lt:ping':
        if (!IS_TOP) return false; // 顶层作答
        sendResponse({ ok: true, ...getStatus(), isTop: true });
        return false;
      case 'lt:status':
        if (!IS_TOP) return false;
        sendResponse({ ok: true, ...getStatus(), isTop: true });
        return false;
      case 'lt:translate-page':
        startPageTranslation(msg.payload || {}).then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      case 'lt:restore-page':
        restoreAll({});
        sendResponse({ ok: true });
        return false;
      case 'lt:get-selection': {
        const text = selectedText();
        // 广播到所有 frame：没选区的子 frame 不抢答，让真正有选区的那一帧回复
        if (!text && !IS_TOP) return false;
        sendResponse({ ok: true, text });
        return false;
      }
      case 'lt:translate-selection': {
        const text = (msg.payload && msg.payload.text) || selectedText();
        if (!text) {
          if (!IS_TOP) return false; // 交给有选区的 frame
          sendResponse({ ok: false, error: '没有选中文本' });
          return false;
        }
        let rect = null;
        try {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed) rect = sel.getRangeAt(0).getBoundingClientRect();
        } catch (err) {
          rect = null;
        }
        translateSelection(text, rect).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      case 'lt:explain-selection': {
        const text = (msg.payload && msg.payload.text) || selectedText();
        if (!text) {
          if (!IS_TOP) return false; // 交给有选区的 frame
          sendResponse({ ok: false, error: '没有选中文本' });
          return false;
        }
        explainText(text, null).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      case 'lt:settings-changed':
        applySettings(msg.payload);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  }

  function init() {
    ui.ensure();
    // 最后一道防线：拦截漏网的「上下文失效」未捕获异常，不再刷英文报错。
    U.installStaleGuard && U.installStaleGuard(markDead);
    ui.on('stop', () => {
      state.token += 1;
      state.phase = 'idle';
      ui.hideProgress();
    });
    ui.on('restore', () => {
      restoreAll({});
      setTimeout(() => ui.hideProgress(), 100);
    });
    ui.on('retry', () => {
      if (state.lastSelection) translateSelection(state.lastSelection.text, state.lastSelection.rect);
    });
    ui.on('explain', (text) => explainText(text || '', null));
    ui.on('copied', (ok) => {
      if (!ok) console.warn('[本地翻译] 复制失败');
    });

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('dblclick', (e) => {
      if (state.settings && state.settings.selectionDblclick) onMouseUp(e);
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Escape') ui.hideBubble();
      if (e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) onMouseUp(e);
    });
    ui.bindOutside(() => ui.hideBubble());

    chrome.runtime.onMessage.addListener(onMessage);

    // 注册到 background：拿到设置 + 让侧边栏知道当前页面
    sendBG({
      type: 'lt:register',
      payload: {
        url: location.href,
        title: document.title,
        docLang: document.documentElement.lang || '',
        isTop: IS_TOP,
        wordCount: (document.body ? document.body.innerText || '' : '').split(/\s+/).length,
      },
    })
      .then((res) => {
        applySettings((res && res.settings) || null, { baseline: true });
      })
      .catch(() => {});

    window.addEventListener('pagehide', () => {
      if (state.nodes.size) {
        // 只上报状态，不做清理（页面即将卸载）
        notifyBG('lt:reset', { url: location.href, translated: state.nodes.size });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // 暴露给演示页 / 调试用
  NS.main = {
    status: getStatus,
    settings: () => state.settings,
    translate: (mode) => startPageTranslation({ mode }),
    restore: () => restoreAll({}),
  };
})();
