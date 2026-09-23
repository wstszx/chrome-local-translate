/**
 * tests/test-ui-dom.mjs —— 在 jsdom 里加载真实的 content script，
 * 验证气泡拖动 / 定位 / 位置记忆 / 取消固定 / 整页翻译还原等交互。
 *
 * 需要 jsdom（可选依赖）：
 *   npm i -D jsdom && node tests/test-ui-dom.mjs
 * 或：NODE_PATH=/path/to/node_modules node tests/test-ui-dom.mjs
 *
 * 没装 jsdom 时会自动跳过（退出码 0），不影响 `npm test`。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (err) {
  console.log('⚠️  未安装 jsdom，跳过 DOM 测试（npm i -D jsdom 后可运行）');
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 内容脚本全量读进内存：每个用例的 makeEnv 都会重新加载一遍，
// 磁盘慢（比如 WSL 的 9p 挂载盘）时不缓存的话 I/O 会主导总耗时。
const CACHE = new Map();
const read = (p) => {
  if (!CACHE.has(p)) CACHE.set(p, readFileSync(join(root, p), 'utf8'));
  return CACHE.get(p);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等待条件成立（默认最多 10 秒）。固定 tick 在系统负载高/磁盘慢时会偶发不够用
 * （UI 还没来得及出现断言就跑了），这里改为「等条件成立」而不是「等固定时长」。
 * @param {() => boolean} fn 返回真值 = 条件已满足
 * @param {string} [what] 超时时报错里的人话描述
 */
async function waitFor(fn, what = '条件成立') {
  const deadline = Date.now() + 10000;
  let last = false;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await tick(10);
  }
  throw new Error(`等待超时：${what}（10 秒内未观察到：${fn.toString().slice(0, 120)}）`);
}

/**
 * 等内容脚本完成注册（lt:register 应答已送达，设置可用）。
 * 之前各用例写死 await tick(30~40)，负载高时设置还没回来，后面的操作全落空。
 */
const registerReady = (env) => waitFor(() => !!(env.window.__LOCAL_TRANSLATE__ && env.window.__LOCAL_TRANSLATE__.main && env.window.__LOCAL_TRANSLATE__.main.settings()), '内容脚本注册完成（lt:register 应答送达）');

/**
 * 等转写模块就绪：设置已送达 + 面板 UI（Shadow DOM）已创建。
 * 转写面板是懒创建的，仅当 inline 启用且设置就绪后才会出现。
 */
const inlineReady = (env) => registerReady(env).then(() => waitFor(() => inlineEls(env.window), '转写面板 UI 创建'));

const CANNED = {
  'Hello world': '你好，世界',
  'Local models are great.': '本地模型很棒。',
};

/* ------------------------------ 测试环境 ------------------------------ */

function makeEnv({
  savedPosition = null,
  url = 'https://example.com/article',
  inline = {},
  contextGone = false,
  registerGate = null, // 传入一个 Promise 即可把「初始设置」的送达卡住（模拟后台慢）
} = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>t</title></head><body>
       <p id="p1">Hello world</p>
       <p id="p2">Local models are great.</p>
       <form>
         <input id="i1" type="text" value="" />
         <input id="i2" type="password" value="" />
         <input id="i3" type="email" value="" />
         <textarea id="t1" rows="3"></textarea>
       </form>
       <div id="editor" contenteditable="true"><p id="editor-p">富文本里的中文。</p></div>
       <div id="open-shadow"></div>
       <div id="closed-shadow"></div>
     </body></html>`,
    { url, pretendToBeVisual: true, runScripts: 'outside-only' },
  );
  const { window } = dom;

  const messages = [];
  const storageData = {};
  if (savedPosition) storageData.bubblePos = savedPosition;
  const messageListeners = [];
  const ports = [];
  const streamStarts = [];
  const settings = {
    uiLang: 'zh',
    sourceLang: 'auto',
    targetLang: 'zh',
    engine: 'auto',
    tone: 'default',
    showBubble: true,
    selectionDblclick: false,
    displayMode: 'replace',
    autoTranslate: false,
    theme: 'auto',
    maxNodes: 100,
    glossary: '',
    inlineEnabled: true,
    inlineMode: 'button',
    inlineTargetLang: '',
    inlineLive: true,
    inlineMinChars: 2,
    inlineInsert: 'replace',
    inlineNeverSites: [],
    ...inline,
  };

  window.chrome = {
    runtime: {
      id: 'lt-test-extension', // 真实内容脚本一定拿得到 runtime.id；上下文失效时它会变成 undefined
      lastError: undefined,
      // 内容脚本 → 后台（本测试里由 fake 后台直接应答）
      sendMessage(message, callback) {
        messages.push(message);
        const respond = (res) => callback && callback(res);
        setTimeout(() => {
          const type = message && message.type;
          if (type === 'lt:register') {
            const payload = { ok: true, settings: { ...settings }, support: { translator: true } };
            if (registerGate) registerGate.then(() => respond(payload));
            else respond(payload);
          }
          else if (type === 'lt:settings:get') respond({ ok: true, settings, support: { translator: true } });
          else if (type === 'lt:settings:set') {
            Object.assign(settings, message.payload && message.payload.patch);
            respond({ ok: true, settings });
          }
          else if (type === 'lt:translate') {
            const text = message.payload.text;
            respond({
              ok: true,
              text: CANNED[text] || `【译】${text}`,
              engine: 'translator',
              sourceLang: 'en',
              targetLang: 'zh',
            });
          } else if (type === 'lt:translateBatch') {
            respond({
              ok: true,
              results: (message.payload.items || []).map((it) => ({
                text: `【译】${typeof it === 'string' ? it : it.text}`,
                engine: 'translator',
              })),
            });
          } else if (type === 'lt:detect') respond({ ok: true, language: 'en', confidence: 0.9 });
          else respond({ ok: true });
        }, 0);
      },
      // 后台 / 侧边栏 → 内容脚本
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
      // 内容脚本 → 后台的流式通道（输入框转写的「边输边译」走这里）
      connect({ name }) {
        const handlers = [];
        const disconnectHandlers = [];
        const port = {
          name,
          postMessage(msg) {
            if (!msg || msg.type !== 'start') return;
            streamStarts.push(msg);
            const text = String(msg.text || '');
            const full = CANNED[text] || `【译】${text}`;
            const pieces = full.match(/[\s\S]{1,4}/g) || [];
            let acc = '';
            pieces.forEach((piece, index) => {
              setTimeout(() => {
                acc += piece;
                handlers.forEach((fn) => fn({ type: 'chunk', text: acc }));
                if (index === pieces.length - 1) handlers.forEach((fn) => fn({ type: 'done', text: acc }));
              }, 4 * (index + 1));
            });
          },
          disconnect() {
            disconnectHandlers.forEach((fn) => fn());
          },
          onMessage: { addListener: (fn) => handlers.push(fn) },
          onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
        };
        ports.push(port);
        return port;
      },
    },
    storage: {
      local: {
        get(key, cb) {
          const out = { [key]: storageData[key] };
          if (typeof cb === 'function') {
            setTimeout(() => cb(out), 0);
            return undefined;
          }
          return Promise.resolve(out);
        },
        set(obj, cb) {
          Object.assign(storageData, obj);
          if (typeof cb === 'function') setTimeout(cb, 0);
          return Promise.resolve();
        },
        remove(key, cb) {
          delete storageData[key];
          if (typeof cb === 'function') setTimeout(cb, 0);
          return Promise.resolve();
        },
      },
      sync: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };

  // jsdom 没有排版引擎：getClientRects() 恒为空、rect 恒为 0，
  // 而内容脚本用它们判断「元素是否可见 / 计算气泡尺寸」。
  // 这里补一个最简单的替身，等价于真实浏览器里的一个 100×20 可见元素。
  const RECT = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  window.Element.prototype.getClientRects = function getClientRects() {
    return [RECT];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return RECT;
  };

  // jsdom 的 postMessage 不会给事件带上 source，而 agent.js 会校验 event.source === window
  // （真实浏览器里同窗口 postMessage 就是 window）。这里手工派发一个语义等价的事件。
  window.postMessage = function postMessage(data) {
    window.dispatchEvent(new window.MessageEvent('message', { data, source: window, origin: window.location.origin }));
  };

  // 先加载「主世界」的影子根助手（真实扩展里由 manifest 以 world: MAIN 在 document_start 注入；
  // jsdom 只有一个 realm，所以直接先跑它即可）
  window.eval(read('content/agent.js'));

  // 按 manifest 的顺序加载真实内容脚本
  window.eval(read('content/util.js'));
  window.eval(read('content/ui.js'));
  window.eval(read('content/inline.js'));
  window.eval(read('content/main.js'));

  /** 模拟 chrome.tabs.sendMessage(tabId, msg) → 内容脚本 */
  // 模拟「扩展已被重新加载」：chrome.runtime.id 消失，任何调用都抛英文错误
  function killExtensionContext() {
    window.chrome.runtime.id = undefined;
    window.chrome.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    window.chrome.runtime.connect = () => {
      throw new Error('Extension context invalidated.');
    };
  }
  if (contextGone) killExtensionContext();

  function sendToContent(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (!settled) {
          settled = true;
          resolve(res || { ok: true });
        }
      };
      if (!messageListeners.length) {
        done({ ok: false, error: '内容脚本未注册监听器' });
        return;
      }
      // 与 Chrome 语义一致：只要有任意一个监听器 return true（异步应答），就等它；
      // 全部同步返回时才立刻结束。
      let asyncResponder = false;
      // 注意：某个监听器抛错不应该连累后面的监听器 —— 真实 Chrome 里每个监听器是相互隔离的，
      // 早期版本在这里 `return`，会把后面的监听器整个跳过，造出假失败。
      for (const fn of messageListeners) {
        try {
          const ret = fn(message, { tab: { id: 1 } }, done);
          if (ret === true) asyncResponder = true;
        } catch (err) {
          if (process.env.LT_DEBUG) console.log('[fake] 监听器抛错：', err && err.message);
        }
      }
      if (!asyncResponder) done();
      // 8 秒：gate 用例里内容脚本会一直等到设置送达才应答，3 秒在慢盘/高负载下可能不够
      setTimeout(() => done({ ok: false, error: '等待内容脚本响应超时' }), 8000);
    });
  }

  // 让用例可以从 window 侧直接给内容脚本发消息（等价 chrome.tabs.sendMessage 到本 frame）
  window.__LT_TEST_SEND__ = sendToContent;
  return {
    dom,
    window,
    messages,
    storageData,
    ports,
    streamStarts,
    settings,
    sendToContent,
    killExtensionContext,
    /** 内容脚本是否已在 fake 后台注册了消息监听（init 可能在 DOMContentLoaded 之后才跑） */
    listenerReady: () => messageListeners.length > 0,
  };
}

function bubbleEl(window) {
  const host = window.document.querySelector('[data-lt-ui="1"]');
  return host && host.shadowRoot ? host.shadowRoot.querySelector('.lt-bubble') : null;
}

function selectText(window, el) {
  const range = window.document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

/** jsdom 没有 PointerEvent，用 MouseEvent 冒充（处理器只读 clientX/clientY/button） */
function pointer(window, type, { x = 0, y = 0, target }) {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
}

const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

/* ------------------------------ 气泡渲染 ------------------------------ */

test('气泡渲染：译文、语言对、引擎徽标', () => {
  const { window } = makeEnv(); // 同步用例：showBubble 直接调用，不需要等注册
  window.__LOCAL_TRANSLATE__.ui.showBubble({
    rect: { left: 100, top: 100, bottom: 120, width: 80, height: 20 },
    sourceText: 'Hello world',
    translation: '你好，世界',
    sourceLang: 'en',
    targetLang: 'zh',
    engine: 'translator',
  });
  const bubble = bubbleEl(window);
  assert.ok(bubble, '气泡应已插入页面');
  assert.equal(bubble.hidden, false);
  assert.equal(bubble.querySelector('.lt-text').textContent, '你好，世界');
  assert.equal(bubble.querySelector('.lt-pair').textContent, '英语 → 中文（简体）');
  assert.equal(bubble.querySelector('.lt-engine').textContent, '本地翻译模型');
  assert.equal(bubble.classList.contains('lt-placed'), false, '未拖动时不应是固定态');
  assert.ok(bubble.querySelector('.lt-reset'), '应有 ⌖ 回到选区按钮');
  assert.ok(bubble.querySelector('.lt-grip'), '应有拖动把手');
});

/* ------------------------------ 拖动 ------------------------------ */

test('拖动：按住标题栏移动 → 位置跟随指针，松手后落盘', async () => {
  const { window, storageData } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.showBubble({ rect: { left: 0, top: 0, bottom: 20, width: 10, height: 20 }, translation: 'x', sourceLang: 'en', targetLang: 'zh' });
  const bubble = bubbleEl(window);
  const head = bubble.querySelector('.lt-head');

  pointer(window, 'pointerdown', { x: 100, y: 100, target: head });
  assert.equal(bubble.classList.contains('lt-dragging'), true, '拖动中应加 lt-dragging');
  pointer(window, 'pointermove', { x: 300, y: 250, target: head });
  assert.equal(bubble.style.left, '200px', '应跟随指针位移（Δx=200）');
  assert.equal(bubble.style.top, '150px', '应跟随指针位移（Δy=150）');
  assert.equal(bubble.classList.contains('lt-placed'), true, '拖动后进入「已固定」态');

  pointer(window, 'pointerup', { x: 300, y: 250, target: head });
  assert.equal(bubble.classList.contains('lt-dragging'), false);
  await tick();
  assert.deepEqual(
    storageData.bubblePos && { left: storageData.bubblePos.left, top: storageData.bubblePos.top },
    { left: 200, top: 150 },
    '松手后位置应写入 storage.local',
  );
});

test('拖动被视口钳制：不会拖出屏幕', () => {
  const { window } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.showBubble({ rect: { left: 0, top: 0, bottom: 20, width: 10, height: 20 }, translation: 'x' });
  const bubble = bubbleEl(window);
  const head = bubble.querySelector('.lt-head');

  pointer(window, 'pointerdown', { x: 50, y: 50, target: head });
  pointer(window, 'pointermove', { x: -5000, y: -5000, target: head });
  assert.equal(bubble.style.left, '6px', '左上越界贴 margin=6');
  assert.equal(bubble.style.top, '6px');

  pointer(window, 'pointermove', { x: 99999, y: 99999, target: head });
  const left = parseInt(bubble.style.left, 10);
  const top = parseInt(bubble.style.top, 10);
  assert.ok(left < window.innerWidth && top < window.innerHeight, `右下越界应被钳制，实际 ${left},${top}`);
  pointer(window, 'pointerup', { x: 99999, y: 99999, target: head });
});

test('拖动后新译文仍停在固定位置（不再跳回选区）', async () => {
  const { window } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.showBubble({ rect: { left: 10, top: 10, bottom: 30, width: 50, height: 20 }, translation: 'a' });
  const bubble = bubbleEl(window);
  const head = bubble.querySelector('.lt-head');

  pointer(window, 'pointerdown', { x: 100, y: 100, target: head });
  pointer(window, 'pointermove', { x: 260, y: 200, target: head });
  pointer(window, 'pointerup', { x: 260, y: 200, target: head });
  const placed = { left: bubble.style.left, top: bubble.style.top };

  // 换一段选中的文字（rect 完全不同）→ 气泡不该移动
  ui.showBubble({
    rect: { left: 700, top: 500, bottom: 520, width: 60, height: 20 },
    sourceText: 'Another sentence.',
    translation: '另一句话。',
    loading: false,
  });
  assert.equal(bubble.style.left, placed.left);
  assert.equal(bubble.style.top, placed.top);
  assert.equal(bubble.querySelector('.lt-text').textContent, '另一句话。');
});

test('按钮不参与拖动：点 ✕ 仍然关闭气泡', () => {
  const { window } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.showBubble({ rect: { left: 0, top: 0, bottom: 20, width: 10, height: 20 }, translation: 'x' });
  const bubble = bubbleEl(window);
  const closeBtn = bubble.querySelector('.lt-close');
  const before = bubble.style.left;

  pointer(window, 'pointerdown', { x: 40, y: 10, target: closeBtn });
  pointer(window, 'pointermove', { x: 300, y: 300, target: closeBtn });
  assert.equal(bubble.classList.contains('lt-dragging'), false, '按住按钮不应触发拖动');
  assert.equal(bubble.style.left, before, '位置不应变化');
  pointer(window, 'pointerup', { x: 300, y: 300, target: closeBtn });

  click(window, closeBtn);
  assert.equal(bubble.hidden, true, '点 ✕ 应关闭气泡');
});

/* ------------------------------ 固定 / 取消固定 ------------------------------ */

test('⌖ 取消固定：清除记忆位置并重新跟随选区', async () => {
  const { window, storageData } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  storageData.bubblePos = { left: 400, top: 300 };
  ui.setPosition({ left: 400, top: 300 });
  assert.deepEqual({ ...ui.getPosition() }, { left: 400, top: 300 }); // 展开放进当前领域再比较
  assert.equal(ui.isPlaced(), true);

  ui.showBubble({ rect: { left: 30, top: 40, bottom: 60, width: 100, height: 20 }, translation: 'x' });
  const bubble = bubbleEl(window);
  assert.equal(bubble.style.left, '400px', '固定位置优先于选区锚点');

  click(window, bubble.querySelector('.lt-reset'));
  await waitFor(() => ui.isPlaced() === false && storageData.bubblePos === undefined, '取消固定后位置被清除');
  assert.equal(ui.isPlaced(), false);
  assert.equal(storageData.bubblePos, undefined, '应清掉 storage 里的位置');
  assert.equal(bubble.classList.contains('lt-placed'), false);
  assert.equal(bubble.style.left, '30px', '取消固定后回到选区锚点');
  assert.equal(bubble.style.top, '68px', '选区下方 8px');
});

test('双击标题栏 = 取消固定', async () => {
  const { window } = makeEnv();
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.setPosition({ left: 320, top: 220 });
  ui.showBubble({ rect: { left: 20, top: 30, bottom: 50, width: 40, height: 20 }, translation: 'x' });
  const bubble = bubbleEl(window);
  assert.equal(bubble.style.left, '320px');

  bubble.querySelector('.lt-head').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await waitFor(() => ui.isPlaced() === false, '双击后取消固定');
  assert.equal(ui.isPlaced(), false);
  assert.equal(bubble.style.left, '20px');
});

/* ------------------------------ 位置记忆 ------------------------------ */

test('位置记忆：新页面沿用上次拖到的位置', async () => {
  const { window } = makeEnv({ savedPosition: { left: 512, top: 111 } });
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.ensure();
  await waitFor(() => ui.getPosition() && ui.getPosition().left === 512, '异步读取保存的位置');
  ui.showBubble({ rect: { left: 10, top: 10, bottom: 30, width: 50, height: 20 }, translation: 'x' });
  const bubble = bubbleEl(window);
  assert.equal(bubble.style.left, '512px', '应恢复上次保存的 left');
  assert.equal(bubble.style.top, '111px');
  assert.equal(bubble.classList.contains('lt-placed'), true);
});

test('位置记忆越界：小窗口里会被钳回可视区', async () => {
  const { window } = makeEnv({ savedPosition: { left: 99999, top: 99999 } });
  const ui = window.__LOCAL_TRANSLATE__.ui;
  ui.ensure();
  await waitFor(() => !!ui.getPosition(), '异步读取保存的位置');
  ui.showBubble({ translation: 'x' });
  const bubble = bubbleEl(window);
  const left = parseInt(bubble.style.left, 10);
  const top = parseInt(bubble.style.top, 10);
  assert.ok(left > 0 && left < window.innerWidth, `left 应被钳制，实际 ${left}`);
  assert.ok(top > 0 && top < window.innerHeight, `top 应被钳制，实际 ${top}`);
});

/* ------------------------------ 与内容脚本联动 ------------------------------ */

test('全链路：选中段落 → 气泡显示译文，且确实请求了后台', async () => {
  const { window, messages } = makeEnv();
  await registerReady({ window }); // 等 lt:register

  const p = window.document.getElementById('p1');
  const sel = selectText(window, p);
  assert.equal(sel.toString(), 'Hello world', 'jsdom 选区应可用');
  p.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  await waitFor(() => {
    const b = bubbleEl(window);
    return !!(b && !b.hidden && b.querySelector('.lt-text').textContent === '你好，世界');
  }, '气泡弹出并显示译文');

  const bubble = bubbleEl(window);
  assert.ok(bubble && !bubble.hidden, 'mouseup 后应弹出气泡');
  assert.equal(bubble.querySelector('.lt-text').textContent, '你好，世界');
  assert.ok(
    messages.some((m) => m.type === 'lt:translate' && m.payload.text === 'Hello world'),
    '应向后台发起 lt:translate',
  );
});

test('整页翻译 + 还原：结构保留、原文可完整回滚', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });

  const res = await sendToContent({ type: 'lt:translate-page', payload: { mode: 'replace' } });
  assert.equal(res.ok, true, `整页翻译应成功：${JSON.stringify(res)}`);
  assert.ok(res.nodes >= 2, `应报告至少 2 段：${JSON.stringify(res)}`);
  assert.equal(res.failed, 0, `成功翻译不应被计成失败：${JSON.stringify(res)}`);
  assert.match(window.document.getElementById('p1').textContent, /【译】Hello world/);
  assert.match(window.document.getElementById('p2').textContent, /【译】Local models are great\./);

  const restored = await sendToContent({ type: 'lt:restore-page' });
  assert.equal(restored.ok, true);
  assert.equal(window.document.getElementById('p1').textContent, 'Hello world');
  assert.equal(window.document.getElementById('p2').textContent, 'Local models are great.');
});

test('整页翻译：目标语言与页面一致时直接跳过', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  // 把目标语言改成 en，页面本身是 en → 应跳过
  await sendToContent({ type: 'lt:settings-changed', payload: { targetLang: 'en', displayMode: 'replace' } });
  assert.equal(
    window.__LOCAL_TRANSLATE__.main.settings().targetLang,
    'en',
    '设置变更应当先被应用（否则后面的断言测的就不是同一件事）',
  );
  const res = await sendToContent({ type: 'lt:translate-page', payload: {} });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'same-language');
  assert.equal(window.document.getElementById('p1').textContent, 'Hello world', '不应改动页面');
});

test('整页翻译：设置还没送达也不该回「尚未加载设置」，而是等它一下', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { window, sendToContent, listenerReady } = makeEnv({ registerGate: gate });
  await waitFor(listenerReady, '内容脚本已注册消息监听（注册应答仍被卡住）');
  // 此刻后台还没把初始设置送回来（模拟 Service Worker 冷启动慢 / 页面刚打开就点翻译）
  const pending = sendToContent({ type: 'lt:translate-page', payload: { mode: 'replace' } });
  await tick(20);
  release();
  const res = await pending;
  assert.equal(res.ok, true, `应该等设置而不是直接失败：${JSON.stringify(res)}`);
  assert.ok(!res.error, `不应把「尚未加载设置」丢给用户：${JSON.stringify(res)}`);
  assert.match(window.document.getElementById('p1').textContent, /【译】Hello world/);
});

test('设置竞态：迟到的初始设置不能盖掉用户刚改的目标语言', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { window, sendToContent, settings, listenerReady } = makeEnv({ registerGate: gate });
  await waitFor(() => listenerReady(), '内容脚本已注册消息监听');
  // 用户/侧边栏先把目标语言改成 en（不先等注册：显式改设置本身就是异步路径）
  await sendToContent({ type: 'lt:settings-changed', payload: { targetLang: 'en' } });
  await waitFor(
    () => window.__LOCAL_TRANSLATE__.main.settings() && window.__LOCAL_TRANSLATE__.main.settings().targetLang === 'en',
    '显式设置生效',
  );
  assert.equal(window.__LOCAL_TRANSLATE__.main.settings().targetLang, 'en');
  // 后台这才把「页面打开时的旧设置」送回来（targetLang 仍是 zh）
  release();
  // uiLang 只会随基线送达：等到它出现，才能确定基线真的应用过了（否则断言的是空窗口期）
  await waitFor(
    () => {
      const s = window.__LOCAL_TRANSLATE__.main.settings();
      return !!(s && s.uiLang === 'zh' && s.targetLang === 'en');
    },
    '迟到基线已应用且未覆盖显式改动',
  );
  assert.equal(
    window.__LOCAL_TRANSLATE__.main.settings().targetLang,
    'en',
    '迟到的基线不应把新设置盖回去',
  );
  // 而基线里真正缺的键仍应被补上
  assert.equal(settings.targetLang, 'zh', '（fake 后台的存档没变，只是不该覆盖前端）');
  const res = await sendToContent({ type: 'lt:translate-page', payload: {} });
  assert.equal(res.skipped, 'same-language', '设置生效后应识别出与页面同语言');
});

/* ------------------------------ 输入框转写（inline compose） ------------------------------ */

function inlineEls(window) {
  const host = window.document.querySelector('[data-lt-ui="inline"]');
  if (!host || !host.shadowRoot) return null;
  return {
    host,
    pill: host.shadowRoot.querySelector('.lt-pill'),
    panel: host.shadowRoot.querySelector('.lt-panel'),
    out: host.shadowRoot.querySelector('.lt-out'),
    state: host.shadowRoot.querySelector('.lt-state'),
    replace: host.shadowRoot.querySelector('.lt-replace'),
    append: host.shadowRoot.querySelector('.lt-append'),
    undo: host.shadowRoot.querySelector('.lt-undo'),
    lang: host.shadowRoot.querySelector('.lt-lang'),
    retry: host.shadowRoot.querySelector('.lt-retry'),
  };
}

/** 聚焦字段并输入文本（派发真实 input 事件，等价于用户打字） */
function typeInto(window, el, text) {
  el.focus();
  el.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') el.value = text;
  else el.textContent = text;
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
}

test('转写：输入框获得焦点并输入后出现浮标', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  assert.ok(els, '应创建转写 UI（Shadow DOM）');
  assert.equal(els.pill.hidden, true, '没有输入内容时不显示浮标');

  const input = window.document.getElementById('i1');
  typeInto(window, input, '这是一个中文句子');
  assert.equal(els.pill.hidden, false, '输入后应显示浮标');
  assert.match(els.pill.textContent, /转写/);
});

test('转写：跳过密码框 / 邮箱框 / 只读框', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });

  for (const id of ['i2', 'i3']) {
    const el = window.document.getElementById(id);
    typeInto(window, el, 'secret-text');
    assert.equal(els.pill.hidden, true, `${id}（type=${el.type}）不应显示浮标`);
  }

  const readOnly = window.document.getElementById('i1');
  readOnly.readOnly = true;
  typeInto(window, readOnly, '中文内容');
  await waitFor(() => els.pill.hidden === true, '只读输入框不显示浮标');
  assert.equal(els.pill.hidden, true, '只读输入框不应显示浮标');
});

test('转写：点浮标打开面板 → 流式译文逐块出现', async () => {
  const { window, ports } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '这是一个中文句子');

  click(window, els.pill);
  assert.equal(els.panel.hidden, false, '面板应打开');
  await waitFor(() => els.out.textContent === '【译】这是一个中文句子', '流式译文输出完整');

  window.__ltDbgRead = true;
  assert.equal(els.out.textContent, '【译】这是一个中文句子', '面板应显示译文');
  assert.ok(ports.length >= 1, '应通过流式端口请求翻译');
  assert.equal(ports[0].name, 'lt-stream');
});

test('转写：替换输入框 → value 更新且派发 input 事件（React/Vue 受控组件可用）', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '这是一个中文句子');

  const seen = [];
  input.addEventListener('input', (e) => seen.push({ value: input.value, isInputEvent: e.type === 'input' }));
  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】这是一个中文句子', '流式译文输出完整');
  click(window, els.replace);
  await waitFor(() => input.value === '【译】这是一个中文句子' && !els.undo.hidden, '替换完成且出现还原按钮');

  assert.equal(input.value, '【译】这是一个中文句子', '输入框内容应被替换');
  assert.equal(seen.length, 1, '应派发一次 input 事件');
  assert.equal(seen[0].value, '【译】这是一个中文句子');
  assert.equal(els.undo.hidden, false, '替换后应出现「还原原文」');
  await waitFor(() => /已替换/.test(els.state.textContent), '状态行更新');
  assert.match(els.state.textContent, /已替换/);
});

test('转写：还原原文 → 输入框回到替换前的内容', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const area = window.document.getElementById('t1');
  typeInto(window, area, '第一段中文。\n第二段中文。');

  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】第一段中文。\n第二段中文。', '流式译文输出完整');
  click(window, els.replace);
  await waitFor(() => area.value === '【译】第一段中文。\n第二段中文。', '替换完成');
  assert.equal(area.value, '【译】第一段中文。\n第二段中文。');

  click(window, els.undo);
  await waitFor(() => area.value === '第一段中文。\n第二段中文。', '还原完成');
  assert.equal(area.value, '第一段中文。\n第二段中文。', '应还原成原始文本');
  assert.equal(els.undo.hidden, true);
});

test('转写：追加模式把译文接到原文后面', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const area = window.document.getElementById('t1');
  typeInto(window, area, '这是一句中文');

  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】这是一句中文', '流式译文输出完整');
  click(window, els.append);
  await waitFor(() => /这是一句中文[\s\S]*【译】这是一句中文$/.test(area.value), '追加完成');
  assert.match(area.value, /^这是一句中文[\s\S]*【译】这是一句中文$/, '原文在前、译文在后');
});

test('转写：input 元素里的换行会被压成空格（input 不支持换行）', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '第一行\n第二行');

  click(window, els.pill);
  await waitFor(() => els.out.textContent.includes('【译】'), '流式译文输出完整');
  click(window, els.replace);
  await waitFor(() => input.value.includes('【译】'), '替换完成');
  assert.equal(input.value.includes('\n'), false, 'input 的 value 不应包含换行');
});

test('转写：Alt+Shift+Enter 直接转写并替换（默认动作）', async () => {
  const { window } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '快捷键测试');

  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
  await waitFor(() => input.value === '【译】快捷键测试', '快捷键应直接替换输入框内容');
  assert.equal(input.value, '【译】快捷键测试', '快捷键应直接替换输入框内容');
});

test('转写：inlineInsert=copy 时快捷键只复制、不改动输入框', async () => {
  const { window } = makeEnv({ inline: { inlineInsert: 'copy' } });
  await registerReady({ window });
  // jsdom 没有剪贴板 API（navigator.clipboard / execCommand 都不存在），
  // 补一个成功的 execCommand 替身，等价于「平台允许复制」的真实浏览器场景。
  window.document.execCommand = () => true;
  const input = window.document.getElementById('i1');
  typeInto(window, input, '只复制');

  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
  // 等状态行进入成功态（lt-ok），不断言具体文案：jsdom 没有剪贴板，
  // 「已复制译文」背后的写入动作在测试环境里只是兜底成功。
  await waitFor(
    () => /(^|\s)lt-ok(\s|$)/.test(
      (window.document.querySelector('[data-lt-ui="inline"]')?.shadowRoot?.querySelector('.lt-state') || { className: '' }).className,
    ),
    'copy 模式完成（状态行进入成功态）',
  );
  assert.equal(input.value, '只复制', '输入框内容应保持不变');
});

test('转写：模式 off 时完全不出现浮标', async () => {
  const { window } = makeEnv({ inline: { inlineMode: 'off' } });
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '中文内容');
  await tick(20);
  assert.equal(els.pill.hidden, true);
});

test('转写：站点在黑名单里则不显示浮标', async () => {
  const { window } = makeEnv({ inline: { inlineNeverSites: ['example.com'] } });
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '中文内容');
  await tick(20);
  assert.equal(els.pill.hidden, true, '黑名单站点不应出现浮标');
});

test('转写：自动展开模式（inlineMode=auto）边输边译', async () => {
  const { window } = makeEnv({ inline: { inlineMode: 'auto' } });
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '自动模式测试');
  await waitFor(() => !els.panel.hidden && els.out.textContent === '【译】自动模式测试', '自动模式弹出面板并输出译文');
  assert.equal(els.panel.hidden, false, '自动模式应弹出面板');
  assert.equal(els.out.textContent, '【译】自动模式测试');
});

test('转写：目标语言下拉可切换，切换后立即重新翻译', async () => {
  const { window, streamStarts } = makeEnv();
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '切换语言');
  click(window, els.pill);
  await waitFor(() => streamStarts.length === 1 && els.out.textContent === '【译】切换语言', '首次流式翻译完成');

  els.lang.value = 'ja';
  els.lang.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => streamStarts.length === 2 && streamStarts[1].target === 'ja', '切换语言后重新翻译');
  await waitFor(() => els.out.textContent === '【译】切换语言', '新一轮流式输出完成');
  assert.equal(streamStarts.length, 2, '切换语言应立刻重新翻译');
  assert.equal(streamStarts[1].target, 'ja', '新请求应带上新目标语言');
  assert.equal(els.out.textContent, '【译】切换语言');
});

test('转写：面板可拖动，位置被视口钳制', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '拖动测试');
  click(window, els.pill);
  assert.equal(els.panel.hidden, false, '面板应打开（拖动前）');

  const head = els.panel.querySelector('.lt-head');
  pointer(window, 'pointerdown', { x: 100, y: 100, target: head });
  pointer(window, 'pointermove', { x: -8000, y: -8000, target: head });
  assert.equal(els.panel.style.left, '6px', '拖出左上角应贴 margin=6');
  assert.equal(els.panel.style.top, '6px');
  pointer(window, 'pointerup', { x: -8000, y: -8000, target: head });
});

test('转写：Esc 关闭面板', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  typeInto(window, window.document.getElementById('i1'), '关闭测试');
  click(window, els.pill);
  assert.equal(els.panel.hidden, false);

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(els.panel.hidden, true, 'Esc 应关闭面板');
});

/* ------------------------------ Shadow DOM / iframe 相关 ------------------------------ */

/** 在 open shadow root 里放一个 input */
function mountOpenShadow(window, { value = '' } = {}) {
  const host = window.document.getElementById('open-shadow');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<input id="si" type="text" />';
  const input = root.querySelector('#si');
  input.value = value;
  return { host, root, input };
}

/** 在 closed shadow root 里放一个 textarea（隔离世界看不到里面，只能靠 agent） */
function mountClosedShadow(window, { value = '' } = {}) {
  const host = window.document.getElementById('closed-shadow');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<textarea id="cti"></textarea>';
  const area = root.querySelector('#cti');
  area.value = value;
  return { host, root, area };
}

/** 模拟用户在 shadow 内部打字：事件会冒泡到 document，但 target 被重定向为 host */
function typeInsideShadow(window, inner, host, text) {
  inner.focus();
  if (inner.tagName === 'TEXTAREA' || inner.tagName === 'INPUT') inner.value = text;
  else inner.textContent = text;
  inner.dispatchEvent(new window.InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
  host.dispatchEvent(new window.InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
}

test('开放的 Shadow DOM：输入后出现浮标，替换写进影子根里的 input', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const { host, input } = mountOpenShadow(window);

  typeInsideShadow(window, input, host, '影子根里的中文');
  await waitFor(() => els.pill.hidden === false, '开放影子根里的输入弹出浮标');
  assert.equal(els.pill.hidden, false, '开放影子根里的输入也应弹出浮标');

  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】影子根里的中文', '应读到影子根里输入框的文本');
  assert.equal(els.out.textContent, '【译】影子根里的中文', '应读到影子根里输入框的文本');

  click(window, els.replace);
  await waitFor(() => input.value === '【译】影子根里的中文', '写入影子根里的 input');
  assert.equal(input.value, '【译】影子根里的中文', '应写进影子根里的 input');
});

test('封闭的 Shadow DOM：靠主世界 agent 代读代写', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const { host, area, root } = mountClosedShadow(window);

  // 隔离世界确实看不到里面
  assert.equal(host.shadowRoot, null, '封闭影子根对外应当是 null');

  typeInsideShadow(window, area, host, '封闭影子根的中文');
  await waitFor(() => els.pill.hidden === false, '封闭影子根里的输入出现浮标');
  assert.equal(els.pill.hidden, false, '封闭影子根里的输入也应有浮标');

  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】封闭影子根的中文', 'agent 读到封闭影子根里的文本');
  assert.equal(els.out.textContent, '【译】封闭影子根的中文', '应通过 agent 读到封闭影子根里的文本');

  click(window, els.replace);
  await waitFor(() => area.value === '【译】封闭影子根的中文', 'agent 写入封闭影子根');
  assert.equal(area.value, '【译】封闭影子根的中文', '应通过 agent 写入封闭影子根');
  void root;
});

test('封闭的 Shadow DOM：还原原文也走 agent', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const { host, area } = mountClosedShadow(window);
  typeInsideShadow(window, area, host, '原始内容');
  await waitFor(() => els.pill.hidden === false, '浮标出现');
  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】原始内容', 'agent 读取完成');
  click(window, els.replace);
  await waitFor(() => area.value === '【译】原始内容', 'agent 写入完成');
  assert.equal(area.value, '【译】原始内容');
  click(window, els.undo);
  await waitFor(() => area.value === '原始内容', 'agent 还原完成');
  assert.equal(area.value, '原始内容', '还原应回到原始文本');
});

test('安全边界在影子根里同样生效（password 不处理）', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const host = window.document.getElementById('closed-shadow');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<input id="pw" type="password" />';
  const pw = root.querySelector('#pw');
  typeInsideShadow(window, pw, host, 'secret123');
  await tick(20); // 输入事件链路跑完（预期不会有任何 UI 变化）
  assert.equal(els.pill.hidden, true, '封闭影子根里的密码框也不应被处理');
});

test('agent 不存在时优雅降级（不会抛错、不影响普通输入框）', async () => {
  const { window } = makeEnv();
  // 模拟主世界助手未注入：摘掉它
  window.__ltAgentInstalled = false;
  const els = await inlineReady({ window });
  const { host, area } = mountClosedShadow(window);
  typeInsideShadow(window, area, host, '封闭但没助手');
  await tick(30); // agent 探测失败路径跑完
  // 普通输入框仍然正常工作
  typeInto(window, window.document.getElementById('i1'), '普通输入框');
  await waitFor(() => els.pill.hidden === false, '普通输入框弹出浮标');
  assert.equal(els.pill.hidden, false, '普通输入框不受影响');
});

test('点浮标 / 面板按钮不会抢走输入框焦点（弹窗不会因此关掉），但下拉要能打开', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '中文');
  await waitFor(() => els.pill.hidden === false, '浮标出现');

  const pillDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  els.pill.dispatchEvent(pillDown);
  assert.equal(pillDown.defaultPrevented, true, '浮标的 mousedown 应被阻止默认行为');

  click(window, els.pill);
  await waitFor(() => els.panel.hidden === false, '面板打开');
  const btnDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  els.replace.dispatchEvent(btnDown);
  assert.equal(btnDown.defaultPrevented, true, '面板按钮的 mousedown 应被阻止默认行为');

  const selDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  els.lang.dispatchEvent(selDown);
  assert.equal(selDown.defaultPrevented, false, '语言下拉的 mousedown 不能拦，否则点不开');
});

/* ------------------------------ 弹窗/富文本/iframe 相关（1.4.1） ------------------------------ */

test('富文本编辑器：光标在内层 <p> 里，目标也要落在编辑器根上', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const editor = window.document.getElementById('editor');
  const inner = window.document.getElementById('editor-p');
  inner.focus();
  inner.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }));
  await waitFor(() => els.pill.hidden === false, '编辑器聚焦后弹出浮标');

  const st = window.__LOCAL_TRANSLATE__.inline.status();
  assert.equal(st.kind, 'dom', '应识别为普通元素目标');
  assert.equal(st.field, 'div', '目标应是 contenteditable 的根（div），而不是内层 p');
  assert.equal(els.pill.hidden, false, '编辑器里也应出现浮标');
});

test('富文本编辑器：读到的是一整篇内容，替换也替换整篇', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const editor = window.document.getElementById('editor');
  editor.innerHTML = '<p>第一段中文</p><p>第二段中文</p>';
  editor.focus();
  editor.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }));
  await waitFor(() => els.pill.hidden === false, '编辑器聚焦后弹出浮标');
  click(window, els.pill);
  // 等流式输出完整结束：fake 端按 4 字符分块推送，startsWith 会在第一块就放行，
  // 后面的断言（两段都在）就变成碰运气。整篇内容 = 两段拼接的完整译文。
  await waitFor(() => els.out.textContent === '【译】第一段中文第二段中文', '整篇流式译文输出完毕');
  // 注意：真实浏览器里 innerText 会在两段之间给换行，jsdom 没有 innerText 只能 textContent，
  // 所以这里只断言「两段都在、而且是整篇一起翻的」。
  assert.ok(els.out.textContent.startsWith('【译】'), `应拿到整篇的译文（实际：${els.out.textContent}）`);
  assert.ok(els.out.textContent.includes('第一段中文') && els.out.textContent.includes('第二段中文'), '两段都要在里面');

  click(window, els.replace);
  await waitFor(() => editor.textContent.includes('【译】'), '替换整篇完成');
  assert.ok(editor.textContent.includes('第一段中文') && editor.textContent.includes('第二段中文'), '替换后整篇都在');
  assert.equal(editor.querySelectorAll('p').length, 0, '整篇替换（不是只换掉光标所在的那一段）');
});

test('弹窗场景：打字时会向后台「认领」自己所在的 frame', async () => {
  const { window, messages } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '你好，这是一段中文');
  await waitFor(() => messages.some((m) => m && m.type === 'lt:editor-claim'), '发出认领消息');
  const claim = messages.find((m) => m && m.type === 'lt:editor-claim');
  assert.ok(claim, '应发送 lt:editor-claim，后台才知道该把快捷键发给哪一层 frame');
  assert.equal(typeof claim.payload.url, 'string');
});

test('弹窗场景：document.hasFocus() 为 false，但被认领的 frame 仍要能干活（iframe 里的输入框）', async () => {
  // Chrome 里 document.hasFocus() 对焦点所在 frame 的所有祖先都是 true，
  // 反过来子 frame 有时也可能报 false（多显示器/特殊嵌套）。被后台点对点认领时必须照做。
  const { window, messages } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '认领测试');
  await waitFor(() => messages.some((m) => m && m.type === 'lt:editor-claim'), '目标建立（认领消息已发）');
  window.document.hasFocus = () => false; // 模拟「自己以为没焦点」

  const res = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: { directive: 'claim' } });
  await waitFor(() => input.value === '【译】认领测试', '认领指令写入译文');
  assert.equal(res && res.ok, true, `认领路径应当成功（实际：${JSON.stringify(res)}）`);
  assert.equal(input.value, '【译】认领测试', '应按默认动作替换输入框内容');
  assert.ok(messages.some((m) => m.type === 'lt:editor-claim'));
});

test('弹窗场景：没焦点又没目标的 frame 要明确回「不是我」，别抢答', async () => {
  const { window } = makeEnv();
  await tick(30);
  window.document.hasFocus = () => false;
  const res = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: {} });
  assert.equal(res && res.ok, false, '不该谎报成功');
  assert.equal(res && res.handled, false, '应标明「我没干活」，好让后台去问别的 frame');
  assert.ok(res && res.info && typeof res.info.hasTarget === 'boolean');
});

test('自检：lt:inline-status 会真的去数输入框里的字符数', async () => {
  const { window } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '一二三四五');
  // status() 导出的是 kind（'dom' | 'shadow' | null），没有 hasTarget 字段
  await waitFor(() => window.__LOCAL_TRANSLATE__.inline.status().kind === 'dom', '输入框被解析为目标');
  const res = await window.__LT_TEST_SEND__({ type: 'lt:inline-status', payload: {} });
  assert.equal(res && res.ok, true);
  assert.equal(res.info.hasTarget, true);
  assert.equal(res.info.chars, 5, '自检要能报告读到几个字（这就是排障的依据）');
  assert.equal(res.info.isTop, true);
});

test('回归：面板自己的译文框不许被当成输入框（1.4.0 会把目标抢走 → 读不到已输入的内容）', async () => {
  // 真实浏览器里 .lt-out 是 contenteditable，isContentEditable 为 true；
  // 而 closest('[data-lt-ui]') 跨不过影子边界，于是它「看起来」像个干净的输入框。
  // 后果：打开面板 → 焦点落到译文框 → 目标被顶掉 → 读到的永远是面板内容（空）。
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '面板不许抢目标');
  await waitFor(() => els.pill.hidden === false, '浮标出现');

  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】面板不许抢目标', '面板显示译文');
  els.out.focus();
  els.out.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }));
  await tick(30); // focusin 的重解析路径跑完

  const st = window.__LOCAL_TRANSLATE__.inline.status();
  assert.equal(st.kind, 'dom', '目标应仍是页面里的输入框');
  assert.equal(st.field, 'input', '目标不应变成面板里的 div(.lt-out)');
  assert.equal(els.out.textContent, '【译】面板不许抢目标', '译文应来自页面输入框，而不是面板自己');

  // 从面板里再触发一次「重新翻译」，读到的仍应是页面输入框里的内容
  const res = await window.__LT_TEST_SEND__({ type: 'lt:inline-status', payload: {} });
  assert.equal(res.info.chars, '面板不许抢目标'.length, `自检应读到页面输入框的 7 个字（实际 ${res.info.chars}）`);
});

test('回归：默认打开面板后输入框内容仍然可读（端到端，和用户操作顺序一致）', async () => {
  const { window } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '先打字再点浮标');
  click(window, els.pill); // 用户就是这样：打完字立刻点浮标
  await waitFor(() => els.out.textContent === '【译】先打字再点浮标', '面板应显示页面输入框内容的译文');
  assert.equal(els.out.textContent, '【译】先打字再点浮标', '面板应显示页面输入框内容的译文');
  click(window, els.replace);
  await waitFor(() => input.value === '【译】先打字再点浮标', '替换应写回页面输入框');
  assert.equal(input.value, '【译】先打字再点浮标', '替换应写回页面输入框');
});

test('弹窗场景：探路模式只回答「能不能写」，绝不动输入框', async () => {
  const { window } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '探路测试');
  await waitFor(() => window.__LOCAL_TRANSLATE__.inline.status().kind === 'dom', '目标建立');

  const res = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: { probeOnly: true } });
  assert.equal(res && res.canWrite, true, '有活着的目标就该说自己能写');
  assert.equal(input.value, '探路测试', '探路阶段不许改动输入框');
  assert.equal(res.info.hasTarget, true);
});

test('弹窗场景：没焦点的 frame 在探路阶段也不说谎（canWrite=false，除非刚打过字）', async () => {
  const { window } = makeEnv();
  await tick(30);
  window.document.hasFocus = () => false;
  const res = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: { probeOnly: true } });
  assert.equal(res && res.canWrite, false, '既没焦点又没有目标 → 不该参与竞选');
  const st = window.__LOCAL_TRANSLATE__.inline.status();
  assert.equal(st.kind, null, '没有输入框时不该报出目标');
  assert.equal(res.info.hasTarget, false);
});

test('弹窗场景：探路选中之后，后台点对点发来的指令必须真的写进去', async () => {
  const { window } = makeEnv();
  await registerReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '两阶段路由');
  await waitFor(() => window.__LOCAL_TRANSLATE__.inline.status().kind === 'dom', '目标建立');
  window.document.hasFocus = () => false; // 模拟「祖先 frame 才报有焦点」的混乱情况

  const probe = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: { probeOnly: true } });
  assert.equal(probe.canWrite, true);
  const act = await window.__LT_TEST_SEND__({ type: 'lt:rewrite-input', payload: { directive: 'claim' } });
  await waitFor(() => input.value === '【译】两阶段路由', '点对点指令写入译文');
  assert.equal(act && act.ok, true, `点对点指令应当执行（实际 ${JSON.stringify(act)}）`);
  assert.equal(input.value, '【译】两阶段路由', '应当已经写入译文');
});

/* ------------------------------ 双语对照（段落下插译文） ------------------------------ */

test('双语对照：原文一个字符都不动，译文插到每段下方', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });

  const res = await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.equal(res.ok, true, `双语对照应成功：${JSON.stringify(res)}`);
  assert.equal(res.mode, 'dual');

  const doc = window.document;
  // 原文原封不动
  assert.equal(doc.getElementById('p1').textContent, 'Hello world');
  assert.equal(doc.getElementById('p2').textContent, 'Local models are great.');

  // 译文在下面
  const t1 = doc.querySelector('#p1 + .lt-dual-translation');
  const t2 = doc.querySelector('#p2 + .lt-dual-translation');
  assert.ok(t1, '第一段下方应有译文块');
  assert.ok(t2, '第二段下方应有译文块');
  assert.equal(t1.textContent, '【译】Hello world');
  assert.equal(t2.textContent, '【译】Local models are great.');
  assert.equal(t1.getAttribute('data-lt-dual'), '1');
  assert.equal(res.nodes >= 2, true, '应报告翻译的段数');
});

test('双语对照：还原会把插入的译文块全部摘掉，DOM 回到原样', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const doc = window.document;
  const before = doc.body.innerHTML;

  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.ok(doc.querySelectorAll('.lt-dual-translation').length >= 2);

  const restored = await sendToContent({ type: 'lt:restore-page' });
  assert.equal(restored.ok, true);
  assert.equal(doc.querySelectorAll('.lt-dual-translation').length, 0, '译文块应被全部移除');
  assert.equal(doc.body.innerHTML, before, '整页 DOM 应与翻译前一模一样');
});

test('双语对照：再翻一次不会重复插入（同一段只有一条译文）', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const doc = window.document;

  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  const first = doc.querySelectorAll('.lt-dual-translation').length;
  assert.ok(first >= 2);

  // 直接再来一次（用户可能连点两下按钮）：restoreAll 会先清干净，所以数量不变
  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.equal(doc.querySelectorAll('.lt-dual-translation').length, first, '不应出现重复的译文块');
  assert.equal(doc.getElementById('p1').textContent, 'Hello world', '原文仍然没动');
});

test('双语对照：插入的译文不会被当成待翻译文本（不会自我循环）', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const doc = window.document;
  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });

  // 再跑一次收集：译文块里的文字必须被排除
  const res = await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.equal(res.ok, true);
  const duals = [...doc.querySelectorAll('.lt-dual-translation')];
  assert.equal(duals.length >= 2, true);
  for (const el of duals) {
    assert.equal(el.textContent.startsWith('【译】【译】'), false, '译文不应被二次翻译');
  }
});

test('双语对照：列表项和表格单元格里的译文插在元素内部（不破坏列表/表格结构）', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const doc = window.document;
  doc.body.insertAdjacentHTML(
    'beforeend',
    '<ul id="ul1"><li id="li1">First item in English</li></ul>' +
      '<table><tbody><tr><td id="td1">Cell content in English</td></tr></tbody></table>',
  );

  const res = await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.equal(res.ok, true);

  const li = doc.getElementById('li1');
  const td = doc.getElementById('td1');
  assert.equal(li.parentElement.tagName, 'UL', '列表项不应被挤出列表');
  assert.equal(td.parentElement.tagName, 'TR', '单元格不应被挤出表格行');
  assert.ok(li.querySelector('.lt-dual-translation'), '列表项里的译文应插在 li 内部');
  assert.ok(td.querySelector('.lt-dual-translation'), '表格单元格里的译文应插在 td 内部');
  assert.equal(li.firstChild.nodeValue, 'First item in English', '原文仍在最前面');
});

test('双语对照：切换回替换模式时，之前插入的译文会被清掉', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const doc = window.document;

  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  assert.ok(doc.querySelectorAll('.lt-dual-translation').length >= 2);

  await sendToContent({ type: 'lt:translate-page', payload: { mode: 'replace' } });
  assert.equal(doc.querySelectorAll('.lt-dual-translation').length, 0, '换成替换模式前应清掉译文块');
  assert.match(doc.getElementById('p1').textContent, /【译】Hello world/, '替换模式应替换原文');
});

test('转写：连续三轮都没问题（第二次不再报错），端口复用不会互相污染', async () => {
  const { window, ports, streamStarts } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');

  for (const round of [1, 2, 3]) {
    typeInto(window, input, `第${round}轮内容`);
    await waitFor(() => els.pill.hidden === false, '浮标出现');
    click(window, els.pill);
    await waitFor(() => els.out.textContent === `【译】第${round}轮内容`, `第 ${round} 轮流式输出完成`);
    assert.equal(els.out.textContent, `【译】第${round}轮内容`, `第 ${round} 轮面板应显示译文`);
    assert.equal(els.state.className.includes('lt-error'), false, `第 ${round} 轮不该有错误状态`);
    assert.equal(els.state.textContent.includes('失败'), false, `第 ${round} 轮状态行不该报错：${els.state.textContent}`);
    click(window, els.replace);
    await waitFor(() => input.value === `【译】第${round}轮内容`, `第 ${round} 轮写入输入框`);
    assert.equal(input.value, `【译】第${round}轮内容`, `第 ${round} 轮应写入输入框`);
    // 真实用户替换后会手动关面板或点页面别处；不关的话下一轮打字走
    // 「面板已开 → live 重译」分支，浮标永远不再出现，第三轮就等不到了。
    window.__LOCAL_TRANSLATE__.inline.close();
  }

  assert.equal(ports.length, 1, '流式端口应当复用，不该每轮新建');
  assert.equal(streamStarts.length, 3, '三轮各自发一次 start');
});

test('转写：上一轮还在流式输出时又触发一次，旧的不能把新的顶掉', async () => {
  // 「边输边译」时就是这个节奏：后台会 abort 上一个请求。
  // 老代码里这次 abort 会把缓存的 Translator 一起弄死 ⇒ 之后次次报错。
  const { window, ports } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');

  typeInto(window, input, '第一次比较长的内容');
  await waitFor(() => els.pill.hidden === false, '浮标出现');
  click(window, els.pill); // 面板打开并开始流式
  await tick(6); // 故意不等它跑完
  typeInto(window, input, '第二次内容');
  await tick(20);
  window.__LOCAL_TRANSLATE__.inline.translate(); // 再来一次（等价于快捷键/重试按钮）
  await waitFor(() => els.out.textContent === '【译】第二次内容', '最后一次请求胜出');

  assert.equal(els.out.textContent, '【译】第二次内容', '面板应显示最后一次请求的结果');
  assert.equal(els.state.textContent.includes('失败'), false, `不该出现失败状态：${els.state.textContent}`);
});

/* --------------------- 扩展上下文失效（Extension context invalidated） --------------------- */

test('上下文失效：报的是人话（不是英文报错），并给出「刷新页面」的出口', async () => {
  const { window, killExtensionContext } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '失效前输入的内容');
  await waitFor(() => els.pill.hidden === false, '浮标出现');
  click(window, els.pill);
  await waitFor(() => els.out.textContent === '【译】失效前输入的内容', '译文已出现');

  // 用户此刻在 chrome://extensions 点了「刷新」→ 本页脚本立刻失效
  killExtensionContext();
  click(window, els.retry || els.pill);
  await waitFor(
    () => /重新加载|刷新/.test(els.state.textContent) &&
      !!(window.document.querySelector('[data-lt-ui="1"]')?.shadowRoot?.querySelector('.lt-stale:not([hidden])')),
    '失效提示出现',
  );

  const line = els.state.textContent;
  assert.equal(/Extension context invalidated/i.test(line), false, `不该把英文报错抛给用户：${line}`);
  assert.match(line, /重新加载|刷新/, `应当说明原因并给出解法：${line}`);

  const notice = window.document.querySelector('[data-lt-ui="1"]')?.shadowRoot?.querySelector('.lt-stale');
  assert.ok(notice, '应当出现「扩展已被重新加载」的提示卡');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /刷新页面/, '提示卡里要有刷新页面的按钮');
});

test('上下文失效：脚本自我停摆 —— 不再反复报错、浮标不再出现', async () => {
  const { window, messages } = makeEnv();
  const els = await inlineReady({ window });
  const input = window.document.getElementById('i1');
  typeInto(window, input, '内容');
  await waitFor(() => els.pill.hidden === false, '浮标出现');
  window.chrome.runtime.id = undefined;

  // 先触发一次，让脚本发现上下文没了
  typeInto(window, input, '内容再改一次');
  await waitFor(() => window.__LOCAL_TRANSLATE__.inline.status().dead === true, '脚本发现上下文失效');
  const before = messages.length;

  // 之后再操作：不该产生任何新的后台调用，也不该再刷出错误
  typeInto(window, input, '内容第三次');
  await tick(30); // 给误报一个机会（预期不会发生）
  const st = window.__LOCAL_TRANSLATE__.inline.status();
  assert.equal(st.dead, true, '脚本应当已标记为失效');
  assert.equal(messages.length, before, '失效后不该再调用后台');
  assert.equal(els.pill.hidden, true, '浮标应当收起（点了也没用）');
});

test('上下文失效：翻译进行到一半扩展被重载 → 返回可读的失败原因（不是英文异常）', async () => {
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  const request = sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });
  // 指令已经发出、正在跑的时候，用户在 chrome://extensions 点了「刷新」
  window.chrome.runtime.id = undefined;
  const res = await request;

  assert.equal(res.ok, false, '应当明确失败');
  assert.equal(res.code, 'context-invalidated', '带上可判别的错误码');
  assert.equal(/Extension context invalidated/i.test(res.error), false, `不该把英文报错抛给用户：${res.error}`);
  assert.match(res.error, /刷新/, `应当告诉用户怎么办：${res.error}`);
  assert.equal(window.document.querySelectorAll('.lt-dual-translation').length, 0, '不该真的去翻译');
});

test('上下文失效：派发前就已经失效 → 哑掉的脚本不再应答（后台一侧会重新注入脚本恢复）', async () => {
  // 真实 Chrome 里扩展被重载后，旧内容脚本的消息通道已经断开：
  // chrome.tabs.sendMessage 会 reject（"Receiving end does not exist"），
  // 后台的降级路径会往这个标签页重新注入一份脚本 —— 这是「不用手动刷新页面也能恢复」的关键。
  const { window, sendToContent } = makeEnv();
  await registerReady({ window });
  window.chrome.runtime.id = undefined;
  const res = await sendToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } });

  assert.equal(res && res.ok, true, '没人应答时由调用方的默认值兜底（真实环境是 reject）');
  assert.equal(window.document.querySelectorAll('.lt-dual-translation').length, 0, '失效的脚本不该真的去翻译');
  const notice = window.document.querySelector('[data-lt-ui="1"]')?.shadowRoot?.querySelector('.lt-stale');
  assert.ok(notice && !notice.hidden, '应当在页面上给出「扩展已被重新加载」的提示');
  assert.match(notice.textContent, /刷新/, '提示里要有刷新按钮');
});

test('扩展重载后：新脚本会清掉上一次实例残留的 UI（不会出现两个浮标）', async () => {
  const { window } = makeEnv();
  await registerReady({ window });
  const countHosts = () => window.document.querySelectorAll('[data-lt-ui="inline"]').length;
  assert.equal(countHosts(), 1, '正常只有一个浮标宿主');

  // 模拟「扩展重载 → 后台重新注入脚本」：同一页面里再跑一遍内容脚本
  window.__LOCAL_TRANSLATE__.started = false;
  window.__LOCAL_TRANSLATE__.inline = null;
  delete window.__LOCAL_TRANSLATE__;
  for (const file of ['content/util.js', 'content/ui.js', 'content/inline.js', 'content/main.js']) {
    window.eval(read(file));
  }
  await waitFor(() => countHosts() === 1, '重新注入后旧的宿主被清掉');
  assert.equal(countHosts(), 1, '重新注入后应当只剩一个宿主（旧的被清掉）');
  assert.equal(window.document.querySelectorAll('[data-lt-ui="1"]').length, 1, '气泡宿主同样只保留一个');
});

/* ------------------------------ 运行 ------------------------------ */

const ONLY = process.env.LT_ONLY || '';
let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  if (ONLY && !name.includes(ONLY)) continue;
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
  }
}
const total = ONLY ? passed + failures.length : tests.length;
console.log(`\n${passed}/${total} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
if (failures.length) process.exitCode = 1;
