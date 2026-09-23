/**
 * content/inline.js —— 输入框转写（inline compose）
 *
 * 场景：在任意网页的输入框里用中文写内容，想直接变成英语/日语/任何目标语言。
 *   - 聚焦可写元素（input / textarea / contenteditable）后，出现一个「🌐 转写」小浮标；
 *     也可以设置成「自动展开」：一边打字一边在面板里看到译文（流式逐字输出）。
 *   - 面板里的译文可以自己改；然后一键「替换」「追加」，或者「还原原文」。
 *   - 快捷键：Alt+Shift+Enter（在页内直接转写并替换）/ Alt+Shift+E（扩展命令，可在
 *     chrome://extensions/shortcuts 改成别的键）/ Esc 关闭面板。
 *
 * 刻意避开的东西：password / email / tel / number 等敏感或非文本输入、
 * autocomplete 里 cc-* 与一次性验证码、readonly/disabled、以及被标记 data-lt-skip 的区域。
 *
 * 覆盖范围：
 *   - iframe / 弹窗 iframe：manifest 里 all_frames + match_about_blank + match_origin_as_fallback，
 *     每个 frame 各自跑一份，所以嵌在 iframe 里的编辑器、聊天框、登录弹窗都能用；
 *   - 开放 Shadow DOM：事件在 document 上被重定向到 shadow host，所以用 composedPath()[0]
 *     取真正的内层元素；焦点也用「逐层下钻 shadowRoot.activeElement」找最深的那个；
 *   - 封闭 Shadow DOM：隔离世界看不到里面，于是打给主世界的 agent（content/agent.js）代读代写，
 *     见下面「目标抽象」一节。
 */
(function () {
  const NS = globalThis.__LOCAL_TRANSLATE__;
  if (!NS || NS.inlineStarted) return;
  NS.inlineStarted = true;

  const U = NS.util;

  const SKIP_TYPES = new Set([
    'password', 'email', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week',
    'color', 'file', 'hidden', 'range', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image',
  ]);
  const SKIP_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;
  const WATCHED = new Set(['INPUT', 'TEXTAREA']);
  const PANEL_ID = 'lt-inline';

  /** 初始化之后被显式改过的设置项：迟到的「完整设置」不能把它们盖回去（1.5.2 修复） */
  const settingsTouched = new Set();
  const settingsWaiters = [];

  function mergedSettings(patch, baseline) {
    const merged = { ...(state.settings || {}) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (baseline && settingsTouched.has(key) && key in merged) continue;
      merged[key] = value;
    }
    if (!baseline) for (const key of Object.keys(patch || {})) settingsTouched.add(key);
    return merged;
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

  /**
   * 用户可能在设置送达之前就触发了转写（页面刚打开就按快捷键）。
   * 与其回一句「尚未加载设置」，不如等它一小会儿。
   */
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

  const state = {
    settings: null,
    target: null,         // { kind: 'dom', el } | { kind: 'agent', host }
    field: null,          // dom 目标的元素（兼容旧代码路径）
    anchorRect: null,     // 当前输入框的视口矩形（agent 目标靠它定位）
    snapshot: null,
    writing: false,
    lastActivity: 0,
    dead: false, // 扩展被重载 / 更新后，这个脚本就哑了       // agent probe 的最近结果
    open: false,
    loading: false,
    translation: '',
    original: '',
    lastReplace: null,    // { el, original, translated }
    requestId: 0,
    port: null,
    debounce: null,
    autoOpenedFor: null,
    pos: null,            // 用户拖动后的位置（仅本页有效）
    pillRaf: 0,
    shadow: null,
  };

  /* ------------------------------------------------------------------ */
  /* 元素判定                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 是不是富文本可编辑区域。
   * 优先用 isContentEditable（浏览器里最准），再退回看 contenteditable 属性 ——
   * 有些环境（旧内核、被 polyfill 过的编辑器、jsdom 等）拿不到前者。
   */
  function isRichText(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    try {
      const host = el.closest && el.closest('[contenteditable]');
      if (!host) return false;
      const v = String(host.getAttribute('contenteditable') || '').toLowerCase();
      return v !== 'false';
    } catch (err) {
      return false;
    }
  }

  /**
   * 是不是我们自己的界面（气泡 / 转写面板 / 被 data-lt-skip 标记的区域）。
   *
   * 必须跨影子根判断：我们自己的界面就在一个影子根里，而 `closest()` **不会穿过影子边界**，
   * 所以面板里那个可编辑的译文框看起来「很干净」—— 在真实浏览器里它 isContentEditable 为 true，
   * 会被当成用户要转写的输入框，把真正的输入框顶掉。
   * 结果就是：打开面板后读到的永远是面板自己的内容（空的）→「没有捕获到已经输入的内容」。
   */
  function insideOurUI(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.closest && el.closest('[data-lt-ui], [data-lt-skip]')) return true;
    } catch (err) {
      /* 继续往下走 */
    }
    let node = el;
    let guard = 0;
    while (node && guard < 20) {
      let root = null;
      try {
        root = node.getRootNode ? node.getRootNode() : null;
      } catch (err) {
        root = null;
      }
      node = root && root.host ? root.host : null;
      if (!node) return false;
      try {
        if (node.matches && node.matches('[data-lt-ui], [data-lt-skip]')) return true;
        if (node.closest && node.closest('[data-lt-ui], [data-lt-skip]')) return true;
      } catch (err) {
        /* 忽略 */
      }
      guard += 1;
    }
    return false;
  }

  function isWritable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (insideOurUI(el)) return false;
    if (isRichText(el)) {
      return !el.hasAttribute('aria-readonly');
    }
    const tag = el.tagName;
    if (!WATCHED.has(tag)) return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const ac = el.getAttribute('autocomplete') || '';
    if (SKIP_AUTOCOMPLETE.test(ac)) return false;
    return true;
  }

  /**
   * 富文本编辑器（聊天框、评论框、Slack/飞书式输入区）里，光标所在的是内层
   * `<p>` / `<div>`，而真正的「输入框」是带 contenteditable 的那个根元素。
   * 不收敛到根上会只读到一段、写回也只覆盖一段。closest 不跨影子根，正好够用。
   */
  function editableHost(el) {
    if (!el || el.nodeType !== 1) return el;
    if (!isRichText(el)) return el;
    try {
      return (
        el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') || el
      );
    } catch (err) {
      return el;
    }
  }

  function fieldText(el) {
    if (!el) return '';
    if (isRichText(el)) return String(el.innerText || el.textContent || '');
    return String(el.value || '');
  }

  function hostOf(url) {
    return U.hostOf(url || location.href);
  }

  function siteBlocked() {
    const s = state.settings;
    if (!s) return false;
    return U.matchSite(hostOf(), s.inlineNeverSites);
  }

  /* ------------------------------------------------------------------ */
  /* 写入输入框（兼容 React / Vue 受控组件）                              */
  /* ------------------------------------------------------------------ */

  function fireInput(el, value, inputType) {
    let event;
    try {
      event = new InputEvent('input', { bubbles: true, cancelable: false, data: value, inputType: inputType || 'insertText' });
    } catch (err) {
      event = new Event('input', { bubbles: true });
    }
    el.dispatchEvent(event);
  }

  /**
   * 把 text 写进元素。优先用 execCommand('insertText')：
   * 它走的是浏览器的编辑管线，能保留撤销栈（Ctrl+Z 可回退）。
   * 失败时退回「原生 value setter + input 事件」，这是 React/Vue 受控组件唯一认的方式。
   */
  function setFieldText(el, text) {
    if (!el) return false;
    const value = String(text == null ? '' : text);
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }

    if (isRichText(el)) {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (document.execCommand) {
        try {
          if (document.execCommand('insertText', false, value)) return true;
        } catch (err) {
          /* 继续走兜底 */
        }
      }
      el.textContent = value;
      fireInput(el, value);
      return true;
    }

    const tag = el.tagName;
    if (!WATCHED.has(tag)) return false;
    // input 不能有换行
    const normalized = tag === 'INPUT' ? value.replace(/\s*\n+\s*/g, ' ') : value;

    if (typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(0, String(el.value || '').length);
      } catch (err) {
        /* 某些 type 不支持，忽略 */
      }
    }
    if (document.execCommand) {
      try {
        if (document.execCommand('insertText', false, normalized)) return true;
      } catch (err) {
        /* 继续走兜底 */
      }
    }

    const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, normalized);
    else el.value = normalized;
    fireInput(el, normalized);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 目标抽象：普通元素 / Shadow DOM / 封闭 Shadow DOM                     */
  /* ------------------------------------------------------------------ */

  const HOST_ATTR = 'data-lt-host-id';
  const REQUEST = '__lt_agent_req';
  const RESPONSE = '__lt_agent_res';

  const hostIds = new WeakMap();   // host 元素 → 临时 id（供主世界 agent 回查）
  let hostSeq = 0;
  let agentSeq = 0;
  const agentPending = new Map();
  let agentListenerBound = false;

  function bindAgentListener() {
    if (agentListenerBound) return;
    agentListenerBound = true;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data[RESPONSE] !== true) return;
      const pending = agentPending.get(data.id);
      if (!pending) return;
      agentPending.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(data);
    });
  }

  /** 打给主世界 agent，超时/不可用时返回 { ok:false }，调用方自行降级 */
  function agentCall(action, payload, timeout = 900) {
    bindAgentListener();
    return new Promise((resolve) => {
      const id = `lt-${Date.now().toString(36)}-${++agentSeq}`;
      const timer = setTimeout(() => {
        agentPending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeout);
      agentPending.set(id, { resolve, timer });
      try {
        window.postMessage({ [REQUEST]: true, id, action, ...payload }, '*');
      } catch (err) {
        clearTimeout(timer);
        agentPending.delete(id);
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  function hostIdFor(host) {
    let id = hostIds.get(host);
    if (!id) {
      id = `lt${++hostSeq}`;
      hostIds.set(host, id);
      try {
        host.setAttribute(HOST_ATTR, id);
      } catch (err) {
        /* 忽略 */
      }
    }
    return id;
  }

  /** 事件在 document 上被 Shadow DOM 重定向过，composedPath()[0] 才是真正的内层元素 */
  function firstPathElement(event) {
    try {
      if (event.composedPath) {
        for (const node of event.composedPath()) {
          if (node && node.nodeType === 1) return node;
        }
      }
    } catch (err) {
      /* 落到 target */
    }
    return event.target && event.target.nodeType === 1 ? event.target : null;
  }

  /** 一路下钻 open shadow root，拿到真正持有焦点的元素 */
  function deepActiveElement() {
    let el = document.activeElement;
    let guard = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement && guard < 20) {
      el = el.shadowRoot.activeElement;
      guard += 1;
    }
    return el || null;
  }

  const probedHosts = new WeakSet(); // 探测过但不是 shadow host 的，别反复问

  /**
   * 从事件解析出「编辑目标」：
   *   - 普通元素 / open shadow root 里的元素 → { kind: 'dom', el }
   *   - closed shadow root → { kind: 'agent', host }（由主世界 agent 代读代写）
   */
  async function targetFromElement(candidate, hostElement) {
    if (isWritable(candidate)) return { kind: 'dom', el: candidate };

    const host = hostElement && hostElement.nodeType === 1 ? hostElement : null;
    if (!host || insideOurUI(host) || probedHosts.has(host)) return null;
    // 常见情况：自定义元素（含 -）或 shadow host；先问一次主世界 agent
    const snap = await agentCall('probe', { hostId: hostIdFor(host) });
    if (snap && snap.ok && snap.readOnly !== true) {
      state.snapshot = snap;
      state.anchorRect = snap.rect || null;
      return { kind: 'agent', host };
    }
    probedHosts.add(host);
    return null;
  }

  async function currentTarget({ probe = false } = {}) {
    const t = state.target;
    if (!t) return null;
    if (t.kind === 'dom') {
      if (!t.el.isConnected) return null;
      return t;
    }
    if (!t.host.isConnected) return null;
    if (probe) {
      const snap = await agentCall('probe', { hostId: hostIdFor(t.host) });
      if (!snap || !snap.ok || snap.readOnly === true) return null;
      state.snapshot = snap;
      state.anchorRect = snap.rect || state.anchorRect;
    }
    return t;
  }

  /** 读当前目标里的文本 */
  async function readTargetText() {
    const t = await currentTarget({ probe: true });
    if (!t) return '';
    if (t.kind === 'dom') {
    if (t.kind === 'dom') return fieldText(t.el);
    }
    const res = await agentCall('read', { hostId: hostIdFor(t.host) });
    if (res && res.ok) {
      state.anchorRect = res.rect || state.anchorRect;
      return String(res.text || '');
    }
    return state.snapshot ? String(state.snapshot.text || '') : '';
  }

  /** 把文本写回当前目标 */
  async function writeTargetText(text) {
    const t = await currentTarget({ probe: true });
    if (!t) return false;
    // 我们写进去的内容同样会派发 input 事件：打个标记，别自己的事件被当成用户输入
    // （否则会重新解析目标、丢掉撤销状态，边输边译模式下还会来回翻译）
    state.writing = true;
    try {
      if (t.kind === 'dom') return setFieldText(t.el, text);
      const res = await agentCall('write', { hostId: hostIdFor(t.host), text }, 1500);
      return !!(res && res.ok);
    } finally {
      setTimeout(() => {
        state.writing = false;
      }, 0);
    }
  }

  /** 当前目标是否还可用（用于 UI 显隐） */
  function targetAlive() {
    const t = state.target;
    if (!t) return false;
    return t.kind === 'dom' ? t.el.isConnected : t.host.isConnected;
  }

  /**
   * 两个编辑目标是不是同一个输入框。
   * 对象会被重新解析出来（身份不稳定），而且同一个输入框可能有两种表示：
   * 「宿主 + 主世界助手」（封闭影子根）或「直接拿到元素」（开放影子根 / 普通元素）。
   * 这两种情况都必须判为同一个，否则会误清撤销状态、重新触发翻译。
   */
  function sameTarget(a, b) {
    if (!a || !b || a.kind !== b.kind) {
      if (!a || !b) return false;
      const dom = a.kind === 'dom' ? a.el : b.kind === 'dom' ? b.el : null;
      const host = a.kind === 'agent' ? a.host : b.kind === 'agent' ? b.host : null;
      if (!dom || !host || typeof dom.getRootNode !== 'function') return false;
      try {
        const treeRoot = dom.getRootNode();
        return !!(treeRoot && treeRoot.host === host);
      } catch (err) {
        return false;
      }
    }
    return a.kind === 'dom' ? a.el === b.el : a.host === b.host;
  }

  /** 打字时认领自己所在的 frame：快捷键就能点对点找到这里（弹窗常在 iframe 里） */
  let lastClaimAt = 0;
  function claimFrame(force) {
    const now = Date.now();
    if (!force && now - lastClaimAt < 1000) return; // 最多每秒一次，别刷爆后台
    lastClaimAt = now;
    try {
      sendBG({ type: 'lt:editor-claim', payload: { url: location.href } }).catch(() => {});
    } catch (err) {
      /* 后台不可用（例如扩展刚被禁用）→ 忽略 */
    }
  }

  function setTarget(target) {
    const prev = state.target;
    if (!target) return target;
    state.lastActivity = Date.now();
    claimFrame(false);
    // 同一个输入框再次被解析出来（很多异步路径会走到这里）：沿用旧对象，
    // 否则会把「还原原文」的撤销状态、自动展开标记一起清掉。
    if (prev && sameTarget(prev, target)) {
      state.target = prev;
      state.field = prev.kind === 'dom' ? prev.el : null;
      return prev;
    }
    state.target = target;
    state.field = target && target.kind === 'dom' ? target.el : null; // 兼容旧引用：仅 dom 目标有元素
    if (prev && prev !== target) {
      state.lastReplace = null;
      if (root) root.querySelector('.lt-undo').hidden = true;
      state.autoOpenedFor = null;
    }
    return target;
  }

  /* ------------------------------------------------------------------ */
  /* 与后台通信                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 扩展上下文是否还活着 —— 在 chrome://extensions 里点「刷新」或扩展更新之后，
   * 页面里这份旧脚本会立刻失效：任何 chrome.runtime.* 调用都会抛
   * 「Extension context invalidated.」，而且它自己无法重新连上（只能刷新页面）。
   * 所以我们主动检测，把英文报错换成人话，并让脚本安静地退场。
   */
  function isStale() {
    return state.dead || !U.extAlive();
  }

  function staleError() {
    const err = new Error(U.staleText());
    err.code = 'context-invalidated';
    return err;
  }

  /** 标记「这个脚本已经哑了」：收起浮标、面板里写明原因、不再尝试任何 chrome API */
  function markDead() {
    if (state.dead) return;
    state.dead = true;
    state.loading = false;
    state.requestId += 1;
    try {
      if (pill) pill.hidden = true;
    } catch (err) {
      /* 忽略 */
    }
    try {
      if (state.open) setStateLine(U.staleText(), 'error');
    } catch (err) {
      /* 忽略 */
    }
    try {
      if (NS.ui && NS.ui.notice) NS.ui.notice(U.staleText());
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 把「上下文失效」类错误统一转成友好错误；其它错误原样返回 */
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
      // 旧版 Chrome 在上下文失效后，sendMessage 的回调可能**永远不回来**
      //（无 lastError、不同步抛错，只是静默丢消息）。超时后主动探测一次：
      // 那时 runtime.id 通常已经消失，就能给出人话报错而不是永远挂起。
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

  function ensurePort() {
    if (state.port) return state.port;
    if (isStale()) {
      markDead();
      return null;
    }
    try {
      const port = chrome.runtime.connect({ name: 'lt-stream' });
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => {
        state.port = null;
        // 端口断开往往就是扩展被重载了（也可能是后台被回收，那种情况下次调用会重连）
        if (!U.extAlive()) markDead();
      });
      state.port = port;
      return port;
    } catch (err) {
      // connect() 同步抛错（「Extension context invalidated.」等）→ 走统一的失效处理
      markDead();
      return null;
    }
  }

  function onPortMessage(msg) {
    if (!msg) return;
    if (msg.type === 'chunk') {
      state.loading = true;
      applyTranslation(msg.text);
    } else if (msg.type === 'done') {
      state.loading = false;
      if (state.translation) applyTranslation(state.translation);
      else if (!msg.text) setStateLine('没有拿到译文，请重试', 'error');
    } else if (msg.type === 'download') {
      setStateLine(`正在下载语言包 ${Math.round((msg.progress || 0) * 100)}%`, 'loading');
    } else if (msg.type === 'error') {
      state.loading = false;
      setStateLine(msg.error || '转写失败', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 界面                                                               */
  /* ------------------------------------------------------------------ */

  const STYLE = `
    :host { all: initial; }
    ${U.designTokens}
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", Roboto, sans-serif; }
    button, select { font: inherit; }

    .lt-pill {
      position: fixed; z-index: 2147483000; display: inline-flex; align-items: center; gap: 4px;
      height: 24px; padding: 0 8px; border-radius: 999px; cursor: pointer;
      background: var(--lt-grad); color: #ffffff; border: 0; font-size: 12px; font-weight: 600; line-height: 1;
      box-shadow: 0 4px 12px rgba(124, 58, 237, .4); backdrop-filter: blur(4px);
    }
    .lt-pill:hover { filter: brightness(1.08); }
    .lt-pill[hidden] { display: none !important; }

    .lt-panel {
      position: fixed; z-index: 2147483000; width: min(380px, calc(100vw - 20px));
      background: var(--lt-bg); color: var(--lt-fg); border: 1px solid var(--lt-border);
      border-top: 2px solid transparent; border-radius: var(--lt-radius);
      background-clip: padding-box;
      box-shadow: var(--lt-shadow); backdrop-filter: var(--lt-blur); -webkit-backdrop-filter: var(--lt-blur);
      font-size: 13px; line-height: 1.55; overflow: hidden; animation: lt-in .12s ease-out;
    }
    @keyframes lt-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    .lt-panel[hidden] { display: none !important; }
    .lt-panel.lt-dragging { opacity: .96; }

    .lt-head {
      display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 9px;
      background: var(--lt-bg-soft); color: var(--lt-fg); font-weight: 600;
      border-bottom: 1px solid var(--lt-border); cursor: move; user-select: none; touch-action: none;
    }
    .lt-grip { color: var(--lt-fg-muted); font-size: 12px; line-height: 1; letter-spacing: -1px; }
    .lt-head:hover .lt-grip { color: var(--lt-fg); }
    .lt-title { font-weight: 700; font-size: 12px; white-space: nowrap; }
    .lt-lang {
      font-size: 12px; border: 1px solid color-mix(in srgb, var(--lt-accent) 35%, var(--lt-border)); background: var(--lt-bg); color: var(--lt-accent); font-weight: 600;
      border-radius: var(--lt-radius-sm); padding: 2px 4px; max-width: 116px;
    }

    .lt-spacer { flex: 1; }
    .lt-mini {
      border: 0; background: transparent; color: var(--lt-accent); cursor: pointer; font-size: 12px;
      padding: 3px 5px; border-radius: 6px; line-height: 1;
    }
    .lt-mini:hover { background: var(--lt-accent-soft); color: var(--lt-accent); }
    .lt-mini.lt-on { background: var(--lt-accent); color: #ffffff; font-weight: 600; }

    .lt-body { padding: 9px 10px 4px; }
    .lt-out {
      min-height: 46px; max-height: 34vh; overflow: auto; outline: none; white-space: pre-wrap;
      word-break: break-word;
    }
    .lt-out:empty::before { content: attr(data-placeholder); color: var(--lt-fg-muted); }
    .lt-out:focus { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--lt-accent) 45%, transparent); border-radius: 6px; }
    .lt-out.lt-rtl { direction: rtl; text-align: right; }
    .lt-out.lt-loading { opacity: .75; }

    .lt-foot { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex-wrap: wrap; }
    .lt-btn {
      border: 1px solid color-mix(in srgb, var(--lt-accent) 30%, var(--lt-border)); background: transparent; color: var(--lt-accent); font-weight: 600; cursor: pointer;
      border-radius: var(--lt-radius-sm); padding: 5px 9px; font-size: 12px;
    }
    .lt-btn:hover:not(:disabled) { border-color: var(--lt-accent); background: var(--lt-accent-soft); }
    .lt-btn:disabled { opacity: .5; cursor: default; }
    .lt-btn.lt-primary { background: var(--lt-grad); border-color: transparent; color: #ffffff; font-weight: 700; }
    .lt-btn.lt-primary:hover:not(:disabled) { background: var(--lt-grad); filter: brightness(1.07); }
    .lt-state { flex-basis: 100%; font-size: 11px; font-weight: 600; color: var(--lt-accent); min-height: 14px; }
    .lt-state.lt-error { color: var(--lt-err); }
    .lt-state.lt-ok { color: var(--lt-ok); }
  `;

  const MARKUP = `
    <button class="lt-pill" hidden type="button" title="把输入内容转写成目标语言（Alt+Shift+Enter）">
      <span aria-hidden="true">🌐</span><span class="lt-pill-text">转写</span>
    </button>
    <div class="lt-panel" hidden role="dialog" aria-label="输入框转写">
      <div class="lt-head" title="按住拖动面板；双击回到输入框下方">
        <span class="lt-grip" aria-hidden="true">⠿</span>
        <span class="lt-title">转写</span>
        <select class="lt-lang" title="目标语言"></select>
        <span class="lt-spacer"></span>
        <button class="lt-mini lt-live" title="边输边译（自动跟随输入更新译文）">⟳</button>
        <button class="lt-mini lt-reset" title="回到输入框下方">⌖</button>
        <button class="lt-mini lt-speak" title="朗读译文">🔊</button>
        <button class="lt-mini lt-copy" title="复制译文">⧉</button>
        <button class="lt-mini lt-close" title="关闭（Shift+点击 = 本站不再自动弹出）">✕</button>
      </div>
      <div class="lt-body">
        <div class="lt-out" contenteditable="true" spellcheck="false" data-placeholder="译文会出现在这里，可以直接修改…"></div>
      </div>
      <div class="lt-foot">
        <button class="lt-btn lt-primary lt-replace">替换输入框</button>
        <button class="lt-btn lt-append">追加</button>
        <button class="lt-btn lt-undo" hidden>还原原文</button>
        <button class="lt-btn lt-retry">重新翻译</button>
        <div class="lt-state"></div>
      </div>
    </div>
  `;

  let root = null;
  let host = null;
  let pill = null;
  let panel = null;

  function ensureUI() {
    if (root) return root;
    // 扩展重载后页面里可能残留上一次实例的浮标宿主（那份脚本已经哑了）→ 先清掉，
    // 免得页面上出现两个「🌐 转写」浮标。
    try {
      for (const staleHost of document.querySelectorAll('[data-lt-ui="inline"]')) staleHost.remove();
    } catch (err) {
      /* 忽略 */
    }
    host = document.createElement('div');
    host.setAttribute('data-lt-ui', 'inline');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${STYLE}</style>${MARKUP}`;
    pill = root.querySelector('.lt-pill');
    panel = root.querySelector('.lt-panel');
    (document.documentElement || document.body).appendChild(host);
    fillLanguages();
    wire();
    return root;
  }

  function fillLanguages() {
    const sel = root.querySelector('.lt-lang');
    sel.innerHTML = '';
    for (const item of NS.inlineLanguages || []) {
      sel.appendChild(new Option(item.label, item.value));
    }
  }

  function wire() {
    const head = root.querySelector('.lt-head');
    pill.addEventListener('mousedown', (e) => {
      // 别让浮标抢走输入框焦点：弹窗常常在输入框失焦的瞬间被关掉（输入框跟着一起消失）
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
    });
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel({ focus: true, translate: true });
    });

    // 面板内的点击不要冒泡到页面（避免页面自己关输入框、丢焦点）
    panel.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      // 按钮不要抢走输入框的焦点（很多弹窗一旦输入框失焦就把弹窗关掉）；select 必须放行，否则下拉打不开
      if (e.target.closest('button')) e.preventDefault();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());

    head.addEventListener('pointerdown', onDragStart);
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, select')) return;
      e.stopPropagation();
      state.pos = null;
      place();
    });

    root.querySelector('.lt-close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey && state.settings && state.settings.inlineMode === 'auto') {
        blockSite();
      }
      closePanel();
    });
    root.querySelector('.lt-copy').addEventListener('click', async () => {
      const ok = await U.copyText(outputText());
      setStateLine(ok ? '已复制译文' : '复制失败', ok ? 'ok' : 'error');
    });
    root.querySelector('.lt-speak').addEventListener('click', () => {
      U.speak(outputText(), targetLang());
    });
    root.querySelector('.lt-reset').addEventListener('click', () => {
      state.pos = null;
      place();
    });
    root.querySelector('.lt-live').addEventListener('click', () => {
      const s = state.settings;
      if (!s) return;
      const next = !s.inlineLive;
      saveSettings({ inlineLive: next });
      setStateLine(next ? '已开启边输边译' : '已关闭边输边译', 'ok');
    });
    root.querySelector('.lt-replace').addEventListener('click', () => insert('replace'));
    root.querySelector('.lt-append').addEventListener('click', () => insert('append'));
    root.querySelector('.lt-undo').addEventListener('click', restoreOriginal);
    root.querySelector('.lt-retry').addEventListener('click', () => requestTranslation({ immediate: true }));
    root.querySelector('.lt-lang').addEventListener('change', (e) => {
      saveSettings({ inlineTargetLang: e.target.value });
      requestTranslation({ immediate: true });
    });
  }

  function outputEl() {
    return root.querySelector('.lt-out');
  }

  function outputText() {
    return String(outputEl().innerText || outputEl().textContent || '').trim();
  }

  function setStateLine(text, kind) {
    const el = root.querySelector('.lt-state');
    el.className = `lt-state${kind ? ` lt-${kind}` : ''}`;
    el.textContent = text || '';
  }

  function refreshLiveButton() {
    if (!root || !state.settings) return;
    root.querySelector('.lt-live').classList.toggle('lt-on', !!state.settings.inlineLive);
  }

  /** 弹窗固定深色，refreshTheme 保留接口兼容性，无需操作 DOM */
  function refreshTheme() {}

  function refreshLanguageSelect() {
    if (!root) return;
    const sel = root.querySelector('.lt-lang');
    const want = resolveTargetLang();
    if (sel.value !== want) sel.value = want;
  }

  /* ------------------------------------------------------------------ */
  /* 定位（浮标 / 面板）                                                  */
  /* ------------------------------------------------------------------ */

  /** 当前输入框的视口矩形：普通元素实时算；agent 目标用 probe 回来的矩形 */
  function anchorRectNow() {
    const t = state.target;
    if (t && t.kind === 'dom' && t.el.isConnected) {
      const r = t.el.getBoundingClientRect();
      state.anchorRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    return state.anchorRect;
  }

  function placeElement(node, kind) {
    const rect = anchorRectNow();
    if (!rect) return;
    const nodeRect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left;
    let top;

    if (kind === 'pill') {
      const narrow = rect.width < 96;
      left = narrow ? rect.right + 6 : rect.right - nodeRect.width - 6;
      top = rect.top + Math.max(3, (Math.min(rect.height, 26) - nodeRect.height) / 2);
    } else if (state.pos) {
      ({ left, top } = state.pos);
    } else {
      left = rect.left;
      top = rect.bottom + 6;
      if (top + nodeRect.height > vh - 8) {
        const above = rect.top - nodeRect.height - 6;
        top = above > 8 ? above : Math.max(8, vh - nodeRect.height - 8);
      }
    }

    const clamped = U.clampToViewport({
      left,
      top,
      width: nodeRect.width,
      height: nodeRect.height,
      viewportWidth: vw,
      viewportHeight: vh,
      margin: 6,
    });
    if (kind === 'panel' && state.pos) state.pos = clamped;
    node.style.left = `${clamped.left}px`;
    node.style.top = `${clamped.top}px`;
  }

  function place() {
    if (pill && !pill.hidden && targetAlive()) placeElement(pill, 'pill');
    if (panel && !panel.hidden && targetAlive()) placeElement(panel, 'panel');
  }

  const schedulePlace = () => {
    if (state.pillRaf) return;
    state.pillRaf = requestAnimationFrame(() => {
      state.pillRaf = 0;
      place();
    });
  };

  /* ------------------------------------------------------------------ */
  /* 拖动面板                                                            */
  /* ------------------------------------------------------------------ */

  let drag = null;

  function onDragStart(e) {
    if (!panel || e.button !== 0) return;
    if (e.target.closest('button, select, .lt-out')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, moved: false, id: e.pointerId };
    panel.classList.add('lt-dragging');
    const head = root.querySelector('.lt-head');
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
    const rect = panel.getBoundingClientRect();
    const next = U.clampToViewport({
      left: e.clientX - drag.dx,
      top: e.clientY - drag.dy,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      margin: 6,
    });
    if (Math.abs(e.clientX - drag.startX) > 3 || Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
    state.pos = next;
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
  }

  function onDragEnd(e) {
    const head = root.querySelector('.lt-head');
    head.removeEventListener('pointermove', onDragMove);
    head.removeEventListener('pointerup', onDragEnd);
    head.removeEventListener('pointercancel', onDragEnd);
    try {
      head.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
    if (drag && drag.moved) setStateLine('面板位置已固定（⌖ 可复位）', 'ok');
    drag = null;
    if (panel) panel.classList.remove('lt-dragging');
  }

  /* ------------------------------------------------------------------ */
  /* 开关面板                                                            */
  /* ------------------------------------------------------------------ */

  function openPanel({ focus = false, translate = false } = {}) {
    ensureUI();
    if (state.dead) {
      setStateLine(U.staleText(), 'error');
      return;
    }
    if (state.open) {
      if (translate) requestTranslation({ immediate: true });
      return;
    }
    state.open = true;
    panel.hidden = false;
    refreshTheme();
    refreshLiveButton();
    refreshLanguageSelect();
    place();
    pill.hidden = true;
    if (translate) requestTranslation({ immediate: true });
    if (focus) outputEl().focus({ preventScroll: true });
    setStateLine('Alt+Shift+Enter 直接替换 · Esc 关闭');
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    if (panel) panel.hidden = true;
    state.loading = false;
    state.requestId += 1;
    if (targetAlive()) updatePill();
  }

  function blockSite() {
    const s = state.settings;
    const hostName = hostOf();
    if (!s || U.matchSite(hostName, s.inlineNeverSites)) return;
    const list = [...(s.inlineNeverSites || []), hostName];
    saveSettings({ inlineNeverSites: list });
    setStateLine(`已把 ${hostName} 加入「不自动弹出」`, 'ok');
  }

  function updatePill() {
    const s = state.settings;
    if (!s || !s.inlineEnabled || s.inlineMode === 'off' || state.open) {
      if (pill) pill.hidden = true;
      return;
    }
    if (!targetAlive()) {
      if (pill) pill.hidden = true;
      return;
    }
    const preview = state.target && state.target.kind === 'dom' ? fieldText(state.target.el).trim() : String((state.snapshot && state.snapshot.text) || '').trim();
    if (preview.length < 2 || siteBlocked()) {
      if (pill) pill.hidden = true;
      return;
    }
    ensureUI();
    refreshTheme();
    pill.hidden = false;
    const textEl = root.querySelector('.lt-pill-text');
    if (textEl) textEl.textContent = `转写 ${U.langLabel(resolveTargetLang())}`;
    placeElement(pill, 'pill');
  }

  /* ------------------------------------------------------------------ */
  /* 翻译                                                                */
  /* ------------------------------------------------------------------ */

  function resolveTargetLang() {
    const s = state.settings;
    if (!s) return 'en';
    if (s.inlineTargetLang) return s.inlineTargetLang;
    return s.targetLang === 'zh' ? 'en' : s.targetLang;
  }

  function targetLang() {
    return U.normalizeCode(resolveTargetLang());
  }

  function applyTranslation(text) {
    const out = outputEl();
    const value = String(text == null ? '' : text);
    state.translation = value;
    out.classList.toggle('lt-rtl', U.isRtl(targetLang()));
    out.classList.toggle('lt-loading', state.loading);
    if (outputText() !== value.trim()) out.textContent = value;
    if (!value.trim()) return;
    // 译文和原文一模一样 → 多半本来就已经是目标语言
    if (state.original && value.trim().toLowerCase() === state.original.trim().toLowerCase()) {
      setStateLine('看起来已经是目标语言了', 'ok');
    } else if (state.loading) {
      setStateLine('');
    }
  }

  async function requestTranslation({ immediate = false } = {}) {
    if (!state.settings) await whenSettingsReady();
    const s = state.settings;
    if (!s) return;
    if (isStale()) {
      markDead();
      setStateLine(U.staleText(), 'error');
      return;
    }
    const target = await currentTarget({ probe: true });
    if (!target) {
      setStateLine('输入框已经不在页面上了', 'error');
      return;
    }
    const text = await readTargetText();
    const min = Math.max(1, Number(s.inlineMinChars) || 2);
    if (!text.trim() || text.trim().length < min) {
      setStateLine(`至少输入 ${min} 个字符`, '');
      return;
    }
    if (text.length > 8000) {
      setStateLine('内容太长（>8000 字），建议分成几段转写', 'error');
      return;
    }

    state.original = text;
    const token = ++state.requestId;
    state.loading = true;
    outputEl().classList.add('lt-loading');
    setStateLine('本地模型转写中…', 'loading');

    const payload = {
      text,
      source: 'auto',
      target: targetLang(),
      engine: s.engine,
      tone: s.tone,
      glossary: s.glossary,
      context: `用户在网页输入框里正在写的内容（${U.langLabel('auto')}→${U.langLabel(targetLang())}）`,
    };

    try {
      const port = ensurePort();
      if (!port) throw isStale() ? staleError() : new Error('no-port');
      port.postMessage({ type: 'start', ...payload, immediate });
    } catch (err) {
      // 端口不可用（扩展刚被重载 / 后台正忙）→ 退回普通消息
      try {
        const res = await sendBG({ type: 'lt:translate', payload });
        if (token !== state.requestId) return;
        state.loading = false;
        if (res && res.ok === false) {
          setStateLine(res.error || '转写失败', 'error');
          return;
        }
        applyTranslation((res && res.text) || '');
      } catch (err2) {
        if (token !== state.requestId) return;
        state.loading = false;
        setStateLine(normalizeErr(err2).message, 'error');
      }
    }
  }

  const scheduleTranslation = () => {
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      state.debounce = null;
      requestTranslation();
    }, 650);
  };

  /* ------------------------------------------------------------------ */
  /* 写入 / 还原                                                          */
  /* ------------------------------------------------------------------ */

  async function insert(mode) {
    if (isStale()) {
      markDead();
      setStateLine(U.staleText(), 'error');
      return;
    }
    const s = state.settings;
    const target = await currentTarget({ probe: true });
    if (!target) {
      setStateLine('输入框已经不在页面上了', 'error');
      return;
    }
    const translated = outputText();
    if (!translated) {
      setStateLine('还没有译文', 'error');
      return;
    }

    const before = await readTargetText();
    const mode2 = mode === 'append' ? 'append' : s && s.inlineInsert === 'copy' ? 'copy' : mode;
    if (mode2 === 'copy') {
      const ok = await U.copyText(translated);
      setStateLine(ok ? '已复制译文（未改动输入框）' : '复制失败', ok ? 'ok' : 'error');
      return;
    }

    let text;
    if (mode2 === 'append') {
      const sep = U.needsSpace(before, translated) ? ' ' : '\n';
      text = before ? `${before}${sep}${translated}` : translated;
    } else {
      text = translated;
    }

    const ok = await writeTargetText(text);
    if (!ok) {
      setStateLine('这个输入框不支持写入（可以用「复制」再手动粘贴）', 'error');
      return;
    }
    state.lastReplace = { target, original: before };
    root.querySelector('.lt-undo').hidden = false;
    setStateLine(mode2 === 'append' ? '已把译文追加到输入框末尾' : '已替换输入框内容（Ctrl/Cmd+Z 或「还原原文」可回退）', 'ok');
    updatePill();
  }

  async function restoreOriginal() {
    const last = state.lastReplace;
    if (!last || !targetAliveFor(last.target)) {
      setStateLine('没有可还原的内容', 'error');
      return;
    }
    const ok = await writeTargetTextFor(last.target, last.original);
    if (!ok) {
      setStateLine('还原失败', 'error');
      return;
    }
    state.lastReplace = null;
    root.querySelector('.lt-undo').hidden = true;
    setStateLine('已还原原文', 'ok');
  }

  /** 针对指定目标（而不是当前目标）读 / 写，供「还原原文」使用 */
  function targetAliveFor(target) {
    if (!target) return false;
    return target.kind === 'dom' ? target.el.isConnected : target.host.isConnected;
  }

  async function writeTargetTextFor(target, text) {
    if (!targetAliveFor(target)) return false;
    state.writing = true;
    try {
      if (target.kind === 'dom') return setFieldText(target.el, text);
      const res = await agentCall('write', { hostId: hostIdFor(target.host), text }, 1500);
      return !!(res && res.ok);
    } finally {
      setTimeout(() => {
        state.writing = false;
      }, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  /** 事件是不是发生在我们自己的界面里（气泡/面板）——是的话一律不管 */
  function eventInsideOurUI(event) {
    if (!event) return false;
    if (insideOurUI(firstPathElement(event))) return true;
    const host = event.target && event.target.nodeType === 1 ? event.target : null;
    return insideOurUI(host);
  }

  function settings() {
    return state.settings;
  }

  function saveSettings(patch) {
    state.settings = { ...(state.settings || {}), ...patch };
    sendBG({ type: 'lt:settings:set', payload: { patch } }).catch(() => {});
    refreshLiveButton();
    refreshLanguageSelect();
  }

  /** 事件 → 目标：同步路径（普通元素/开放影子根）优先，必要时异步问主世界 agent */
  function syncTargetFromEvent(event, { allowAgent = true } = {}) {
    const candidate = editableHost(firstPathElement(event));
    if (candidate && isWritable(candidate)) {
      setTarget({ kind: 'dom', el: candidate });
      state.snapshot = null;
      return { kind: 'dom', el: candidate };
    }
    const host = event && event.target && event.target.nodeType === 1 ? event.target : null;
    if (!allowAgent || !host) return null;
    // 可能是封闭 shadow root：交给 agent 探测（异步）
    return null;
  }

  async function resolveTargetAsync(event) {
    const sync = syncTargetFromEvent(event);
    if (sync) return sync;
    const host = event && event.target && event.target.nodeType === 1 ? event.target : null;
    if (!host) return null;
    const target = await targetFromElement(editableHost(firstPathElement(event)), host);
    if (target) {
      setTarget(target);
      return target;
    }
    return null;
  }

  /** 每次交互顺手确认一次上下文：失效了就立刻退场，别等下一次 chrome.* 调用才报错 */
  function guardAlive() {
    if (state.dead) return false;
    if (!U.extAlive()) {
      markDead();
      return false;
    }
    return true;
  }

  function onFocusIn(e) {
    if (!guardAlive()) return;
    // 面板里的译文框自己也会获得焦点（打开面板时我们会 focus 它）——
    // 那不是用户要转写的输入框，必须忽略，否则目标会被自己顶掉。
    if (eventInsideOurUI(e)) return;
    // 开放影子根 / 普通元素：同步就能确定
    const sync = syncTargetFromEvent(e);
    if (!sync) {
      // 可能是封闭影子根，异步兜一下
      resolveTargetAsync(e).then((target) => {
        if (!target) return;
        const s = settings();
        if (!s || !s.inlineEnabled || s.inlineMode === 'off' || siteBlocked()) return;
        ensureUI();
        updatePill();
      });
    }
    const target = state.target;

    const s = settings();
    if (!s || !s.inlineEnabled || s.inlineMode === 'off' || siteBlocked()) return;
    ensureUI();
    updatePill();
    // 自动展开模式：内容够长就把面板弹出来跟着打字走
    if (s.inlineMode === 'auto' && target && state.autoOpenedFor !== target) {
      const preview = target.kind === 'dom' ? fieldText(target.el).trim() : String((state.snapshot && state.snapshot.text) || '').trim();
      if (preview.length >= Math.max(2, Number(s.inlineMinChars) || 2)) {
        state.autoOpenedFor = target;
        openPanel({ translate: true });
      }
    }
  }

  function onFocusOut(e) {
    if (!state.target) return;
    const related = e.relatedTarget;
    if (related && related.closest && related.closest('[data-lt-ui]')) return;
    setTimeout(() => {
      const active = deepActiveElement();
      if (active && active.closest && active.closest('[data-lt-ui]')) return;
      if (state.open) return;
      updatePill();
    }, 120);
  }

  function onInput(e) {
    if (!guardAlive()) return;
    if (state.writing) return; // 我们自己写回文本框触发的 input
    if (eventInsideOurUI(e)) return;
    const sync = syncTargetFromEvent(e, { allowAgent: true });
    if (!sync) {
      resolveTargetAsync(e).then((target) => {
        if (!target) return;
        const s = settings();
        if (!s || !s.inlineEnabled || s.inlineMode === 'off') return;
        if (state.open && s.inlineLive) scheduleTranslation();
        else {
          updatePill();
          if (s.inlineMode === 'auto' && state.autoOpenedFor !== target) {
            state.autoOpenedFor = target;
            openPanel({ translate: true });
          }
        }
      });
    }
    const s = settings();
    if (!s || !s.inlineEnabled || s.inlineMode === 'off') return;
    if (state.open) {
      if (s.inlineLive) scheduleTranslation();
    } else {
      updatePill();
      if (s.inlineMode === 'auto' && state.target && state.autoOpenedFor !== state.target) {
        const preview =
          state.target.kind === 'dom'
            ? fieldText(state.target.el).trim()
            : String((state.snapshot && state.snapshot.text) || '').trim();
        if (preview.length >= Math.max(2, Number(s.inlineMinChars) || 2)) {
          state.autoOpenedFor = state.target;
          openPanel({ translate: true });
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 来自后台的消息                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 排障/自检信息（同步版）：哪个 frame、有没有焦点、目标是什么、当下能读到几个字。
   * 消息里必须传同步对象（Promise 没法结构化克隆到后台）。
   */
  function statusInfoSync() {
    let isTop = false;
    try {
      isTop = window.top === window;
    } catch (err) {
      isTop = false;
    }
    let hasFocus = false;
    try {
      hasFocus = document.hasFocus();
    } catch (err) {
      hasFocus = false;
    }
    const target = state.target;
    const live = !!(target && targetAlive());
    let chars = 0;
    if (live) {
      if (target.kind === 'dom') {
        chars = fieldText(target.el).trim().length;
      } else {
        chars = String((state.snapshot && state.snapshot.text) || '').trim().length;
      }
    }
    return {
      url: location.href,
      isTop,
      hasFocus,
      hasTarget: live,
      kind: target ? target.kind : null,
      tag:
        target && target.kind === 'dom'
          ? target.el.tagName.toLowerCase()
          : target
            ? `${target.host.tagName.toLowerCase()}(shadow)`
            : null,
      chars,
      enabled: !!(state.settings && state.settings.inlineEnabled),
      mode: (state.settings && state.settings.inlineMode) || null,
      lastActivity: state.lastActivity || 0,
      dead: !!state.dead,
    };
  }

  /** 完整自检信息（异步）：封闭影子根要绕主世界一圈才能读到字 */
  async function statusInfo() {
    const info = statusInfoSync();
    const target = state.target;
    if (info.hasTarget) {
      try {
        const text = await readTargetText();
        info.chars = text ? text.trim().length : 0;
      } catch (err) {
        /* 读不到就保留同步值 */
      }
      void target;
    }
    return info;
  }

  function onMessage(msg, sender, sendResponse) {
    if (state.dead) return false; // 脚本已失效，别再假装能干活
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'lt:rewrite-input') {
      // 同一个标签页里可能有很多 frame（弹窗、客服挂件…）。后台会优先点对点发给
      // 「刚刚在打字」的那个 frame（directive === 'claim'），只有拿不准时才广播。
      //
      // 注意：Chrome 里 document.hasFocus() 对焦点所在 frame 的**所有祖先**也是 true，
      // 所以顶层 frame 也会以为自己有焦点；绝对不能只听第一个应答的 frame。
      const directive = (msg.payload && msg.payload.directive) || 'broadcast';
      // 探路模式：只回答「我这儿能不能写」，绝对不动输入框。
      // 后台先用它问一圈所有 frame，挑出唯一一个该干活的，再单独发真正的指令
      // —— 否则广播会让多个 frame 同时往各自页面里写。
      const probeOnly = !!(msg.payload && msg.payload.probeOnly);
      let focused = true;
      try {
        focused = document.hasFocus();
      } catch (err) {
        focused = true;
      }
      const live = !!(state.target && targetAlive());
      const recent = !!(state.lastActivity && Date.now() - state.lastActivity < 30000);
      // 被后台点对点认领（用户刚在这个 frame 里打过字）时，就算 hasFocus 报 false 也得干活
      const byDirective = directive === 'claim' && live && recent;
      const canWrite = focused || byDirective;
      if (!probeOnly && !canWrite) {
        // 不是我的事：明确说自己没干活（带 hasFocus/canWrite，后台据此挑回答）
        sendResponse({
          ok: false,
          handled: false,
          canWrite: false,
          error: '当前没有聚焦的输入框',
          info: statusInfoSync(),
        });
        return false;
      }

      const finish = () => {
        if (!state.target || !targetAlive()) {
          sendResponse({
            ok: false,
            handled: true,
            canWrite: false,
            error: '当前没有聚焦的输入框',
            info: statusInfoSync(),
          });
          return;
        }
        const kind = state.target.kind;
        if (probeOnly) {
          sendResponse({ ok: true, handled: true, canWrite: true, kind, info: statusInfoSync() });
          return;
        }
        claimFrame(true); // 明确认领一次（后台下次就能点对点找到这里）
        rewriteNow();
        sendResponse({ ok: true, handled: true, canWrite: true, kind, info: statusInfoSync() });
      };

      const active = deepActiveElement();
      if (active && isWritable(active)) {
        setTarget({ kind: 'dom', el: active });
        finish();
        return false;
      }
      const hostEl = active && active.nodeType === 1 ? active : null;
      const already =
        state.target && state.target.kind === 'agent' && state.target.host === hostEl && targetAlive();
      if (!hostEl || already) {
        finish();
        return false;
      }
      // 焦点可能在封闭 shadow root 里：异步问主世界助手（异步回复 → return true）
      targetFromElement(null, hostEl).then((t) => {
        if (t) setTarget(t);
        finish();
      });
      return true;
    }

    if (msg.type === 'lt:settings-changed') {
      state.settings = mergedSettings(msg.payload || {}, false);
      markSettingsReady();
      refreshTheme();
      refreshLiveButton();
      refreshLanguageSelect();
      if (!state.settings.inlineEnabled || state.settings.inlineMode === 'off') closePanel();
      return false;
    }

    if (msg.type === 'lt:inline-status') {
      // 异步回答：自检时要真的去读一次输入框（可能是封闭影子根，得绕主世界一圈）
      statusInfo().then(
        (info) => sendResponse({ ok: true, open: state.open, target: targetLang(), info }),
        () => sendResponse({ ok: false, info: null, error: 'status-failed' }),
      );
      return true;
    }

    return false;
  }

  /**
   * 点到浮标/面板之外 ⇒ 收起面板。
   * shadow root 里的点击在 document 上 target 被重定向成宿主，所以必须看 composedPath。
   */
  function onOutsideMouseDown(e) {
    if (!state.open && !(pill && !pill.hidden)) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      if (node === host) return;
      // 我们自己是有影子根的宿主：路径上出现它就说明点在 UI 里
      if (root && node === host) return;
    }
    if (state.open) closePanel();
  }

  function onKeyDown(e) {
    if (!guardAlive()) return;
    const mod = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    // Alt+Shift+Enter：页内直接转写 + 按设置写入
    if (mod && (e.key === 'Enter' || e.keyCode === 13)) {
      if (!state.target || !targetAlive()) return;
      e.preventDefault();
      e.stopPropagation();
      rewriteNow();
      return;
    }
    if (e.key === 'Escape' && state.open) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }

  /** 快捷键动作：翻译当前输入框内容，并按设置替换 / 追加 / 复制 */
  async function rewriteNow() {
    ensureUI();
    if (!state.settings) await whenSettingsReady();
    const s = settings();
    if (!s) return;
    if (!state.open) {
      state.open = true;
      panel.hidden = false;
      refreshTheme();
      refreshLanguageSelect();
      place();
      pill.hidden = true;
    }
    setStateLine('转写中…（完成后自动写入）', 'loading');

    const target = await currentTarget({ probe: true });
    if (!target) {
      setStateLine('输入框已经不在页面上了', 'error');
      return;
    }
    const text = await readTargetText();
    state.original = text;
    const token = ++state.requestId;
    state.loading = true;
    try {
      const res = await sendBG({
        type: 'lt:translate',
        payload: {
          text,
          source: 'auto',
          target: targetLang(),
          engine: s.engine,
          tone: s.tone,
          glossary: s.glossary,
        },
      });
      if (token !== state.requestId) return;
      state.loading = false;
      if (!res || res.ok === false) {
        setStateLine((res && res.error) || '转写失败', 'error');
        return;
      }
      applyTranslation(res.text || '');
      outputEl().classList.remove('lt-loading');
      await insert(s.inlineInsert === 'copy' ? 'copy' : s.inlineInsert === 'append' ? 'append' : 'replace');
    } catch (err) {
      if (token !== state.requestId) return;
      state.loading = false;
      setStateLine(normalizeErr(err).message, 'error');
    }
  }

  function init() {
    ensureUI();
    // 最后一道防线：任何漏网的「上下文失效」异常（例如旧版 Chrome 静默失效场景）
    // 都在这里被拦下来标记失效，不在控制台刷英文报错。
    U.installStaleGuard && U.installStaleGuard(markDead);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onOutsideMouseDown, true);
    window.addEventListener('scroll', schedulePlace, { passive: true, capture: true });
    window.addEventListener('resize', schedulePlace, { passive: true });
    // 有些弹窗打开时就自动聚焦了输入框（我们还没收到 focusin），这里补一次
    setTimeout(() => {
      const el = deepActiveElement();
      if (el && isWritable(el)) {
        setTarget({ kind: 'dom', el });
        updatePill();
      }
    }, 400);
    chrome.runtime.onMessage.addListener(onMessage);

    sendBG({ type: 'lt:settings:get' })
      .then((res) => {
        if (res && res.settings) {
          state.settings = mergedSettings(res.settings, true);
          markSettingsReady();
          refreshTheme();
          refreshLiveButton();
          refreshLanguageSelect();
        }
      })
      .catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // 暴露给演示页 / 调试用
  NS.inline = {
    open: openPanel,
    close: closePanel,
    translate: () => requestTranslation({ immediate: true }),
    // 完整自检信息（会真的读一次输入框，可能是封闭影子根 → 绕主世界一圈）
    statusAsync: () => statusInfo(),
    status: () =>
      state.settings
        ? {
            open: state.open,
            dead: !!state.dead,
            target: targetLang(),
            kind: state.target ? state.target.kind : null,
            field: state.target
              ? state.target.kind === 'dom'
                ? state.target.el.tagName.toLowerCase()
                : `${state.target.host.tagName.toLowerCase()}(shadow)`
              : null,
          }
        : null,
    // 调试用：主动探测某个元素（含封闭影子根）
    probe: (el) => targetFromElement(el, el),
  };
})();
