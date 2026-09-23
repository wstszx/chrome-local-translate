/**
 * content/ui.js —— 页面内 UI：划词译文气泡 + 整页翻译进度条
 * 全部放在 Shadow DOM 中，避免被页面样式污染，也不污染页面。
 */
(function () {
  const NS = globalThis.__LOCAL_TRANSLATE__;
  const U = NS.util;

  const STYLE = `
    :host { all: initial; }
    ${U.designTokens}
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Roboto, sans-serif; }
    .lt-bubble {
      position: fixed; z-index: 2147483000; max-width: min(420px, calc(100vw - 24px)); min-width: 240px;
      background: var(--lt-bg); color: var(--lt-fg); border: 1px solid var(--lt-border); border-radius: var(--lt-radius);
      box-shadow: var(--lt-shadow); backdrop-filter: var(--lt-blur); -webkit-backdrop-filter: var(--lt-blur);
      padding: 0 12px 8px; font-size: 14px; line-height: 1.55; pointer-events: auto;
      animation: lt-in .12s ease-out; overflow: hidden;
    }
    @keyframes lt-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    .lt-bubble[hidden] { display: none !important; }
    .lt-head {
      display: flex; align-items: center; gap: 6px; margin: 0 -12px 8px; padding: 9px 12px 8px;
      background: var(--lt-grad); color: #ffffff;
      cursor: move; user-select: none; touch-action: none;
    }
    .lt-bubble.lt-dragging { opacity: .95; box-shadow: 0 18px 44px rgba(124,58,237,.45), 0 2px 8px rgba(124,58,237,.25); }
    .lt-grip { color: #ffffff; opacity: .6; font-size: 12px; line-height: 1; letter-spacing: -1px; cursor: move; }
    .lt-head:hover .lt-grip { opacity: 1; }
    .lt-reset { display: none; }
    .lt-bubble.lt-placed .lt-reset { display: inline-block; color: #ffffff; }
    .lt-badge {
      font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px;
      background: rgba(255, 255, 255, .22); color: #ffffff; font-weight: 600; white-space: nowrap;
    }
    .lt-badge.lt-engine { background: #ffffff; color: var(--lt-accent); }
    .lt-spacer { flex: 1; }
    .lt-btn {
      border: 0; background: transparent; cursor: pointer; font-size: 13px; line-height: 1;
      padding: 4px 5px; border-radius: 6px; color: #ffffff; opacity: .85;
    }
    .lt-btn:hover { background: rgba(255, 255, 255, .25); opacity: 1; }
    .lt-src {
      font-size: 12px; color: var(--lt-fg); border-left: 3px solid var(--lt-accent); padding: 1px 0 1px 8px;
      margin-bottom: 6px; max-height: 60px; overflow: hidden; white-space: pre-wrap; word-break: break-word;
    }
    .lt-src[hidden] { display: none !important; }
    .lt-body { white-space: pre-wrap; word-break: break-word; max-height: 45vh; overflow: auto; }
    .lt-body.lt-rtl { direction: rtl; text-align: right; }
    .lt-state { margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--lt-accent); display: flex; align-items: center; gap: 6px; }
    .lt-state[hidden] { display: none !important; }
    .lt-state.lt-error { color: var(--lt-err); }
    .lt-spin, .lt-spinner {
      width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--lt-border); border-top-color: var(--lt-accent);
      animation: lt-spin .7s linear infinite; display: inline-block;
    }
    @keyframes lt-spin { to { transform: rotate(360deg); } }
    .lt-link { color: var(--lt-accent); font-weight: 600; cursor: pointer; text-decoration: underline; background: none; border: 0; padding: 0; font-size: 12px; }
    .lt-md code { background: var(--lt-bg-soft); color: var(--lt-accent); padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .lt-md ul { margin: 4px 0 4px 18px; padding: 0; }
    .lt-md li { margin: 2px 0; }
    .lt-md strong { font-weight: 600; color: var(--lt-accent); }

    .lt-toast {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 268px;
      background: var(--lt-bg); color: var(--lt-fg); border: 1px solid var(--lt-border); border-radius: var(--lt-radius);
      box-shadow: var(--lt-shadow); padding: 12px; font-size: 13px; pointer-events: auto;
    }
    .lt-toast[hidden] { display: none !important; }
    .lt-toast-title { font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; color: var(--lt-accent); }
    .lt-toast-text { color: var(--lt-fg); font-size: 12px; margin-bottom: 8px; }
    .lt-bar { height: 5px; border-radius: 999px; background: var(--lt-bg-soft); overflow: hidden; margin-bottom: 10px; }
    .lt-bar > i { display: block; height: 100%; width: 0%; background: var(--lt-grad); transition: width .2s ease; }
    .lt-actions { display: flex; gap: 8px; }
    .lt-actions button {
      flex: 1; border: 1px solid var(--lt-border); background: transparent; color: var(--lt-accent); font-weight: 600;
      border-radius: var(--lt-radius-sm); padding: 6px 8px; font-size: 12px; cursor: pointer;
    }
    .lt-actions button:hover { border-color: var(--lt-accent); background: var(--lt-accent-soft); }

    /* 「扩展已被重新加载」这类需要用户动手的提示：左下角，错误配色但同套令牌 */
    .lt-stale {
      position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; width: 292px;
      background: var(--lt-bg); color: var(--lt-fg); border: 1px solid color-mix(in srgb, var(--lt-err) 35%, transparent);
      border-radius: var(--lt-radius); padding: 12px; box-shadow: var(--lt-shadow); font-size: 13px; pointer-events: auto;
    }
    .lt-stale[hidden] { display: none !important; }
    .lt-stale-title { font-weight: 700; margin-bottom: 6px; color: var(--lt-err); }
    .lt-stale-text { font-size: 12px; line-height: 1.6; margin-bottom: 10px; color: var(--lt-fg); }
    .lt-stale-refresh {
      display: block; width: 100%; border: 0; background: var(--lt-err); color: #ffffff; font-weight: 600;
      border-radius: var(--lt-radius-sm); padding: 7px 8px; font-size: 12px; cursor: pointer; font: inherit;
    }
    .lt-stale-refresh:hover { filter: brightness(1.1); }
  `;

  const MARKUP = `
    <div class="lt-bubble" hidden role="dialog" aria-live="polite">
      <div class="lt-head" title="按住拖动气泡；双击标题栏回到选区位置">
        <span class="lt-grip" aria-hidden="true">⠿</span>
        <span class="lt-badge lt-pair"></span>
        <span class="lt-badge lt-engine"></span>
        <span class="lt-spacer"></span>
        <button class="lt-btn lt-reset" title="回到选区位置（取消固定）">⌖</button>
        <button class="lt-btn lt-speak" title="朗读译文">🔊</button>
        <button class="lt-btn lt-copy" title="复制译文">⧉</button>
        <button class="lt-btn lt-explain" title="用 Gemini Nano 解释原文" hidden>💡</button>
        <button class="lt-btn lt-close" title="关闭">✕</button>
      </div>
      <div class="lt-src" hidden></div>
      <div class="lt-body"><span class="lt-text"></span></div>
      <div class="lt-state" hidden></div>
    </div>
    <div class="lt-stale" hidden role="alert">
      <div class="lt-stale-title">扩展已被重新加载</div>
      <div class="lt-stale-text"></div>
      <div class="lt-actions"><button class="lt-stale-refresh" type="button">刷新页面</button></div>
    </div>
    <div class="lt-toast" hidden role="status">
      <div class="lt-toast-title"><span class="lt-spinner"></span><span class="lt-toast-title-text">正在使用本地模型翻译…</span></div>
      <div class="lt-toast-text">全程离线，内容不会离开你的电脑</div>
      <div class="lt-bar"><i></i></div>
      <div class="lt-actions">
        <button class="lt-restore">还原原文</button>
        <button class="lt-stop">取消</button>
      </div>
    </div>
  `;

  let hostEl = null;
  let root = null;
  let noticeText = '';
  let bubble = null;
  let toast = null;
  let state = { rect: null, pinned: false, theme: 'auto', text: '', sourceLang: '', targetLang: '', engine: '' };
  const listeners = {};
  let outsideBound = false;

  /* -------------------- 位置：拖动 + 记忆 -------------------- */

  const POS_KEY = 'bubblePos';
  let userPos = null; // { left, top }：由用户拖动决定；存在时气泡不再跟随选区
  let drag = null;
  let posLoaded = false;
  let posTouched = false; // 用户已经主动改过位置（拖动 / 取消固定）→ 丢弃迟到的异步读取结果

  const storageLocal = () =>
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

  const ignoreLastError = (cb) =>
    typeof cb === 'function'
      ? (...args) => {
          void (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError);
          cb(...args);
        }
      : undefined;

  function loadPosition() {
    if (posLoaded) return;
    posLoaded = true;
    const area = storageLocal();
    if (!area) return;
    try {
      area.get(POS_KEY, ignoreLastError((res) => {
        // 读取是异步的：若用户在返回前已经拖动或取消固定，就以用户的最新操作为准
        if (posTouched) return;
        const saved = res && res[POS_KEY];
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
          userPos = { left: saved.left, top: saved.top };
          updatePlacedUi();
        }
      }));
    } catch (err) {
      /* 读不到就用默认锚点 */
    }
  }

  function persistPosition() {
    const area = storageLocal();
    if (!area || !userPos) return;
    try {
      area.set({ [POS_KEY]: { left: userPos.left, top: userPos.top, at: Date.now() } }, ignoreLastError());
    } catch (err) {
      /* 忽略 */
    }
  }

  function clearPosition() {
    userPos = null;
    drag = null;
    posTouched = true;
    const area = storageLocal();
    if (area) {
      try {
        area.remove(POS_KEY, ignoreLastError());
      } catch (err) {
        /* 忽略 */
      }
    }
    updatePlacedUi();
  }

  function updatePlacedUi() {
    if (bubble) bubble.classList.toggle('lt-placed', !!userPos);
  }

  function onDragStart(e) {
    if (!bubble || e.button !== 0) return;
    if (e.target.closest('button, a, input, select, textarea')) return; // 按钮照常点击
    e.preventDefault();
    const rect = bubble.getBoundingClientRect();
    posTouched = true;
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId, moved: false, startX: e.clientX, startY: e.clientY };
    bubble.classList.add('lt-dragging');
    const head = bubble.querySelector('.lt-head');
    try {
      head.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
    head.addEventListener('pointermove', onDragMove);
    head.addEventListener('pointerup', onDragEnd);
    head.addEventListener('pointercancel', onDragEnd);
  }

  function onDragMove(e) {
    if (!drag) return;
    const size = bubble.getBoundingClientRect();
    const next = U.clampToViewport({
      left: e.clientX - drag.dx,
      top: e.clientY - drag.dy,
      width: size.width,
      height: size.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 6,
    });
    if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
    userPos = next;
    bubble.style.left = `${next.left}px`;
    bubble.style.top = `${next.top}px`;
    updatePlacedUi();
  }

  function onDragEnd(e) {
    const head = bubble ? bubble.querySelector('.lt-head') : null;
    if (head) {
      head.removeEventListener('pointermove', onDragMove);
      head.removeEventListener('pointerup', onDragEnd);
      head.removeEventListener('pointercancel', onDragEnd);
      try {
        head.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    }
    const moved = !!(drag && drag.moved);
    drag = null;
    if (bubble) bubble.classList.remove('lt-dragging');
    if (moved) {
      persistPosition();
      flashBadge('已固定位置');
    }
  }

  /** 取消固定 → 气泡重新跟随选区 */
  function resetPosition() {
    clearPosition();
    if (bubble && !bubble.hidden) {
      place();
      flashBadge('已跟随选区');
    }
  }

  function on(name, fn) {
    listeners[name] = fn;
  }

  function emit(name, ...args) {
    const fn = listeners[name];
    if (fn) fn(...args);
  }

  function ensure() {
    if (root) return root;
    // 扩展重载后，页面里可能残留着「上一次实例」的 UI 宿主（那份脚本已经哑了）。
    // 直接清掉，免得页面上出现两个气泡 / 两条进度条。
    try {
      for (const staleHost of document.querySelectorAll('[data-lt-ui="1"]')) staleHost.remove();
    } catch (err) {
      /* 忽略 */
    }
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-lt-ui', '1');
    hostEl.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000;';
    root = hostEl.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>${MARKUP}`;
    bubble = root.querySelector('.lt-bubble');
    toast = root.querySelector('.lt-toast');
    (document.documentElement || document.body).appendChild(hostEl);
    wire();
    window.addEventListener(
      'resize',
      () => {
        if (userPos && bubble && !bubble.hidden) place();
      },
      { passive: true },
    );
    return root;
  }

  /** 弹窗固定深色，setTheme 仅记录偏好供将来使用 */
  function setTheme(theme) {
    state.theme = theme || 'auto';
  }

  function wire() {
    loadPosition();
    updatePlacedUi();
    const head = bubble.querySelector('.lt-head');
    head.addEventListener('pointerdown', onDragStart);
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      e.stopPropagation();
      resetPosition();
    });
    bubble.querySelector('.lt-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      resetPosition();
    });
    bubble.querySelector('.lt-close').addEventListener('click', (e) => {
      e.stopPropagation();
      hideBubble();
    });
    bubble.querySelector('.lt-copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      const textEl = bubble.querySelector('.lt-text');
      const ok = await U.copyText(textEl.textContent || '');
      emit('copied', ok);
      flashBadge(ok ? '已复制' : '复制失败');
    });
    bubble.querySelector('.lt-speak').addEventListener('click', (e) => {
      e.stopPropagation();
      U.speak(bubble.querySelector('.lt-text').textContent || '', state.targetLang);
    });
    bubble.querySelector('.lt-explain').addEventListener('click', (e) => {
      e.stopPropagation();
      emit('explain', state.text);
    });
    bubble.addEventListener('mousedown', (e) => e.stopPropagation());
    bubble.addEventListener('click', (e) => e.stopPropagation());
    toast.querySelector('.lt-stop').addEventListener('click', () => emit('stop'));
    toast.querySelector('.lt-restore').addEventListener('click', () => emit('restore'));
  }

  function flashBadge(text) {
    const el = bubble.querySelector('.lt-engine');
    const prev = el.textContent;
    el.textContent = text;
    setTimeout(() => {
      el.textContent = prev;
    }, 1200);
  }

  /**
   * 展示 / 更新气泡
   * data: { rect, sourceText, translation, sourceLang, targetLang, engine, tone, loading, error, showSource, pinned }
   */
  function showBubble(data = {}) {
    ensure();
    setTheme(data.theme || state.theme);
    if (data.rect) state.rect = data.rect;
    if (data.pinned !== undefined) state.pinned = data.pinned;
    if (data.sourceText !== undefined) state.text = data.sourceText;
    if (data.sourceLang !== undefined) state.sourceLang = data.sourceLang;
    if (data.targetLang !== undefined) state.targetLang = data.targetLang;
    if (data.engine !== undefined) state.engine = data.engine;

    const q = (sel) => bubble.querySelector(sel);
    const pair = q('.lt-pair');
    pair.textContent = `${U.langLabel(state.sourceLang)} → ${U.langLabel(state.targetLang)}`;

    const engine = q('.lt-engine');
    engine.textContent = data.engineLabel || (state.engine === 'nano' ? 'Gemini Nano' : state.engine === 'translator' ? '本地翻译模型' : '本地');

    const src = q('.lt-src');
    if (data.showSource === false || !state.text) {
      src.hidden = true;
    } else {
      src.hidden = false;
      src.textContent = state.text.length > 320 ? `${state.text.slice(0, 320)}…` : state.text;
    }

    const body = q('.lt-body');
    const textEl = q('.lt-text');
    body.classList.toggle('lt-rtl', U.isRtl(state.targetLang));
    textEl.innerHTML = data.error ? '' : renderMarkdown(data.translation == null ? '' : String(data.translation));
    textEl.hidden = !!data.error;

    const st = q('.lt-state');
    if (data.error) {
      st.hidden = false;
      st.classList.add('lt-error');
      st.innerHTML = `<span>${escapeHtml(data.error)}</span><button class="lt-link lt-retry">重试</button>`;
      const retry = st.querySelector('.lt-retry');
      if (retry) retry.addEventListener('click', (e) => {
        e.stopPropagation();
        emit('retry');
      });
    } else if (data.loading) {
      st.hidden = false;
      st.classList.remove('lt-error');
      st.innerHTML = '<span class="lt-spin"></span><span>本地模型翻译中…</span>';
    } else if (data.hint) {
      st.hidden = false;
      st.classList.remove('lt-error');
      st.textContent = data.hint;
    } else {
      st.hidden = true;
      st.innerHTML = '';
    }
    bubble.hidden = false;
    place();
  }

  function renderMarkdown(text) {
    // 极简 Markdown（只用于「解释」结果）：代码、粗体、列表
    const esc = escapeHtml(text);
    const lines = esc.split('\n');
    const out = [];
    let inList = false;
    for (const line of lines) {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
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
    return out.join('\n').replace(/\n{2,}/g, '<br><br>');
    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function place() {
    if (!bubble || bubble.hidden) return;
    const margin = 10;
    // 先归零量一下真实尺寸（内容长短不同，气泡高度会变），再决定落点
    bubble.style.visibility = 'hidden';
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const size = bubble.getBoundingClientRect();

    let left;
    let top;
    if (userPos) {
      // 用户拖动过 → 固定在用户选定的位置（窗口尺寸变化时自动钳制回可视区）
      const clamped = U.clampToViewport({
        left: userPos.left,
        top: userPos.top,
        width: size.width,
        height: size.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 6,
      });
      userPos = clamped;
      left = clamped.left;
      top = clamped.top;
    } else if (state.rect && state.rect.width >= 0) {
      const rect = state.rect;
      left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - size.width - margin));
      top = rect.bottom + 8;
      if (top + size.height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - size.height - 8);
      }
    } else {
      left = Math.max(margin, window.innerWidth - size.width - 16);
      top = Math.max(margin, window.innerHeight - size.height - 16);
    }

    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.visibility = 'visible';
  }

  function hideBubble() {
    if (bubble) bubble.hidden = true;
    state.pinned = false;
    state.rect = null;
  }

  /** 供内容脚本 / 演示页读写气泡位置 */
  function getPosition() {
    return userPos ? { ...userPos } : null;
  }

  function setPosition(pos) {
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;
    userPos = { left: pos.left, top: pos.top };
    updatePlacedUi();
    if (bubble && !bubble.hidden) place();
  }

  function isPlaced() {
    return !!userPos;
  }

  function isBubbleOpen() {
    return !!bubble && !bubble.hidden;
  }

  function bindOutside(handler) {
    if (outsideBound) return;
    outsideBound = true;
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!isBubbleOpen() || state.pinned) return;
        if (e.composedPath && e.composedPath().includes(hostEl)) return;
        handler();
      },
      true,
    );
  }

  /* -------------------- 整页翻译进度 -------------------- */

  /* -------------------- 「扩展已失效」提示 -------------------- */

  function notice(text, { title = '扩展已被重新加载', actionText = '刷新页面', onAction = null } = {}) {
    ensure();
    const box = root.querySelector('.lt-stale');
    box.hidden = false;
    if (title) box.querySelector('.lt-stale-title').textContent = title;
    box.querySelector('.lt-stale-text').textContent = text || '';
    const btn = box.querySelector('.lt-stale-refresh');
    btn.textContent = actionText;
    if (btn.dataset.bound !== '1') {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => (onAction ? onAction() : location.reload()));
    }
    return box;
  }

  function hideNotice() {
    if (!root) return;
    const box = root.querySelector('.lt-stale');
    if (box) box.hidden = true;
  }

  function showProgress({ title = '正在使用本地模型翻译…', text = '全程离线，内容不会离开你的电脑' } = {}) {
    ensure();
    toast.hidden = false;
    toast.querySelector('.lt-toast-title-text').textContent = title;
    toast.querySelector('.lt-toast-text').textContent = text;
    updateProgressBar(0);
  }

  function setProgress({ done = 0, total = 1, message, title } = {}) {
    ensure();
    if (toast.hidden) showProgress({ title });
    if (title) toast.querySelector('.lt-toast-title-text').textContent = title;
    if (message) toast.querySelector('.lt-toast-text').textContent = message;
    updateProgressBar(total ? done / total : 0);
  }

  function updateProgressBar(ratio) {
    const bar = toast.querySelector('.lt-bar > i');
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  }

  function hideProgress() {
    if (toast) toast.hidden = true;
  }

  NS.ui = {
    ensure,
    on,
    emit,
    notice,
    hideNotice,
    showBubble,
    hideBubble,
    isBubbleOpen,
    setTheme,
    bindOutside,
    place,
    getPosition,
    setPosition,
    isPlaced,
    resetPosition,
    showProgress,
    setProgress,
    hideProgress,
    escapeHtml,
  };
})();
