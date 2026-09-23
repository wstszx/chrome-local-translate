/**
 * content/agent.js —— 页面主世界（MAIN world）小助手，只为一件事存在：
 * 让隔离世界能够读写**封闭（closed）Shadow DOM** 里的输入框。
 *
 * 为什么需要它：
 *   - 隔离世界（内容脚本）看不到封闭 shadow root 里面的节点，事件在 document 上
 *     被重定向（retarget）成 shadow host，因此无法读取/写入那个输入框；
 *   - 主世界能访问（页面自己创建的）shadow root，所以这里在 document_start 打一个
 *     极小的补丁把 shadow root 记下来，再按隔离世界的请求做「读取 / 写入」。
 *
 * 隐私说明：这条通道里流动的内容（输入框里的文本、要写回的译文）本来就属于页面
 * 自己的 DOM，页面脚本本来就能看到，所以不引入新的信息泄露面。除此之外这里不发
 * 任何网络请求、不读取任何其它 DOM。
 *
 * 运行时机：manifest 里以 world: "MAIN" + run_at: "document_start" 注入，
 * 必须早于页面脚本创建 shadow root。
 */
(function () {
  if (window.__ltAgentInstalled) return;
  window.__ltAgentInstalled = true;

  const REQUEST = '__lt_agent_req';
  const RESPONSE = '__lt_agent_res';
  const HOST_ATTR = 'data-lt-host-id';

  /** host → ShadowRoot（含 closed） */
  const REGISTRY = new WeakMap();

  const SKIP_TYPES = new Set([
    'password', 'email', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'week',
    'color', 'file', 'hidden', 'range', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image',
  ]);
  const SKIP_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;

  // ---- 1) 记录 shadow root（补丁保持原语义，只是多记一笔） ----
  try {
    const originalAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(init) {
      const root = originalAttach.call(this, init);
      try {
        REGISTRY.set(this, root);
      } catch (err) {
        /* 忽略 */
      }
      return root;
    };
  } catch (err) {
    /* 忽略：极端情况下打不上补丁，后续 probe 会返回 no-shadow-root */
  }

  /** 声明式 Shadow DOM（<template shadowrootmode>）在解析阶段就建好了，这里补记一遍 */
  function captureDeclarativeRoots() {
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot && !REGISTRY.has(el)) REGISTRY.set(el, el.shadowRoot);
      }
    } catch (err) {
      /* 忽略 */
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', captureDeclarativeRoots, { once: true });
  } else {
    captureDeclarativeRoots();
  }

  // ---- 2) 工具 ----

  /** 是不是富文本可编辑区域（主世界用 isContentEditable，退回看属性，见 inline.js 同款判定） */
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

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isRichText(el)) return !el.hasAttribute('aria-readonly');
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (SKIP_TYPES.has(type)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (SKIP_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return false;
    return true;
  }

  function deepActive(root) {
    let el = null;
    try {
      el = root.activeElement;
    } catch (err) {
      el = null;
    }
    let guard = 0;
    while (el && el.shadowRoot && el.shadowRoot.activeElement && guard < 20) {
      try {
        el = el.shadowRoot.activeElement;
      } catch (err) {
        break;
      }
      guard += 1;
    }
    return el;
  }

  /** 焦点元素找不到时，退而求其次：找一个可编辑元素 */
  function firstEditable(root) {
    try {
      for (const el of root.querySelectorAll('input, textarea, [contenteditable]')) {
        if (isEditable(el)) return el;
      }
    } catch (err) {
      /* 忽略 */
    }
    return null;
  }

  /** 富文本编辑器里，真正的「输入框」是带 contenteditable 的根，不是光标所在的内层 <p> */
  function editableRoot(el) {
    if (!el || el.nodeType !== 1 || !isRichText(el)) return el;
    try {
      return el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') || el;
    } catch (err) {
      return el;
    }
  }

  /**
   * 记住每个宿主上一次真正拿到的那个输入框。
   * 之前每次探测都重新找一遍：弹窗里若同时有搜索框和文本框（或 DOM 刚重建过），
   * 就可能读到另一个元素 —— 表现为「没有捕获到已经输入的内容」。
   */
  const LAST_EDITABLE = new WeakMap(); // host → Element

  function findEditable(root, host) {
    const active = editableRoot(deepActive(root));
    if (isEditable(active)) {
      if (host) LAST_EDITABLE.set(host, active);
      return active;
    }
    // 焦点不在这个影子根里时：优先用上次记下的那个（用户刚刚就在那儿打字）
    if (host) {
      const remembered = LAST_EDITABLE.get(host);
      if (remembered && remembered.isConnected && isEditable(remembered)) return remembered;
    }
    const first = editableRoot(firstEditable(root));
    if (first && host) LAST_EDITABLE.set(host, first);
    return first;
  }

  function readValue(el) {
    if (isRichText(el)) return String(el.innerText || el.textContent || '');
    return String(el.value || '');
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  function fireInput(el, value) {
    let event;
    try {
      event = new InputEvent('input', { bubbles: true, cancelable: false, data: value, inputType: 'insertText' });
    } catch (err) {
      event = new Event('input', { bubbles: true });
    }
    el.dispatchEvent(event);
  }

  /**
   * 写入：主世界就是页面自己的 realm，所以这里用「原生 value setter + input 事件」最稳，
   * React / Vue 受控组件都会认；能编辑的内容优先走 execCommand 以保留撤销栈。
   */
  function writeValue(el, text) {
    const value = String(text == null ? '' : text);
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      try {
        el.focus();
      } catch (err2) {
        /* 忽略 */
      }
    }

    if (isRichText(el)) {
      try {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        if (document.execCommand && document.execCommand('insertText', false, value)) return true;
      } catch (err) {
        /* 落到兜底 */
      }
      el.textContent = value;
      fireInput(el, value);
      return true;
    }

    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    const normalized = tag === 'INPUT' ? value.replace(/\s*\n+\s*/g, ' ') : value;

    try {
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, String(el.value || '').length);
      if (document.execCommand && document.execCommand('insertText', false, normalized)) return true;
    } catch (err) {
      /* 落到兜底 */
    }

    const proto = tag === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, normalized);
    else el.value = normalized;
    fireInput(el, normalized);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ---- 3) 应答隔离世界的请求 ----

  function respond(id, payload) {
    try {
      window.postMessage({ [RESPONSE]: true, id, ...payload }, '*');
    } catch (err) {
      /* 忽略 */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[REQUEST] !== true || typeof data.action !== 'string') return;

    const { id, action } = data;
    let host = null;
    let root = null;
    try {
      if (data.hostId) host = document.querySelector(`[${HOST_ATTR}="${String(data.hostId).replace(/"/g, '')}"]`);
      root = host ? REGISTRY.get(host) : null;
      if (!root) {
        respond(id, { ok: false, error: 'no-shadow-root' });
        return;
      }

      if (action === 'probe') {
        const el = findEditable(root, host);
        if (!el) {
          respond(id, { ok: false, error: 'no-editable' });
          return;
        }
        respond(id, {
          ok: true,
          tag: el.tagName.toLowerCase(),
          contentEditable: isRichText(el),
          type: (el.getAttribute && el.getAttribute('type')) || '',
          readOnly: !!(el.readOnly || el.disabled),
          text: readValue(el),
          rect: rectOf(el),
        });
        return;
      }

      if (action === 'read') {
        const el = findEditable(root, host);
        if (!el) {
          respond(id, { ok: false, error: 'no-editable' });
          return;
        }
        respond(id, { ok: true, text: readValue(el), rect: rectOf(el) });
        return;
      }

      if (action === 'write') {
        const el = findEditable(root, host);
        if (!el) {
          respond(id, { ok: false, error: 'no-editable' });
          return;
        }
        const ok = writeValue(el, data.text);
        // 注意：一定要把请求 id 带回，否则隔离世界匹配不到等待者（会白等超时）
        respond(id, ok ? { ok: true } : { ok: false, error: 'write-failed' });
        return;
      }

      respond(id, { ok: false, error: `unknown-action:${action}` });
    } catch (err) {
      respond(id, { ok: false, error: String((err && err.message) || err) });
    }
  });
})();
