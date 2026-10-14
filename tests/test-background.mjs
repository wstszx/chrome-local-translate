/**
 * tests/test-background.mjs —— Service Worker / 离屏宿主的消息路由测试（Node 20+，零依赖）
 * 运行：node tests/test-background.mjs   （npm test 会一起跑）
 *
 * 做法：造一层假 chrome.*，把 background.js 与 offscreen.js 真的 import 进来，
 * 然后直接驱动它们注册的 onMessage / onCommand 监听器。
 * 覆盖：设置读写消毒、标签页状态、frame 认领与「探路 → 选赢家 → 写入」、错误文案。
 */

import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${String(err && err.message).split('\n').slice(0, 8).join('\n    ')}`);
  }
}

/* ------------------------------ 假 chrome ------------------------------ */

function makeChrome() {
  const listeners = {
    onMessage: [], onConnect: [], onInstalled: [], onStartup: [], onCommand: [],
    menuClicked: [], tabRemoved: [], tabUpdated: [], tabActivated: [],
  };
  const calls = { tabsSendMessage: [], tabsQuery: [], broadcasts: [], menus: [], offscreen: [] };
  const storageData = { sync: {}, local: {}, session: {} };
  const area = (obj) => ({
    get: async (key) => {
      if (typeof key === 'string') return { [key]: obj[key] };
      if (key == null) return { ...obj };
      const out = {};
      for (const k of Object.keys(key)) out[k] = obj[k];
      return out;
    },
    set: async (o) => { Object.assign(obj, o); },
    remove: async (k) => { delete obj[k]; },
    clear: async () => { for (const k of Object.keys(obj)) delete obj[k]; },
  });
  let tabResponses = {};
  const chrome = {
    runtime: {
      id: 'probe-ext',
      lastError: undefined,
      getURL: (p) => `chrome-extension://probe-ext/${p}`,
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      onConnect: { addListener: (fn) => listeners.onConnect.push(fn) },
      onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
      onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
      // runtime.sendMessage：background 广播 + 发给离屏宿主都走这里
      sendMessage: (msg) => {
        if (msg && msg.target === 'offscreen') {
          const offListener = listeners.onMessage[0]; // 第一个注册的是 offscreen.js

          return new Promise((resolve) => {
            if (!offListener) return resolve(undefined);
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(undefined); } }, 5000);
            const ret = offListener(msg, {}, (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } });
            if (ret !== true) { /* 同步返回 */ }
          });
        }
        calls.broadcasts.push(msg);
        return Promise.resolve(undefined);
      },
    },
    tabs: {
      query: async (q) => {
        calls.tabsQuery.push(q);
        if (q && q.active) return [{ id: 1, url: 'https://example.com/a', title: 'A' }];
        return [{ id: 1, url: 'https://example.com/a' }, { id: 2, url: 'https://other.com/' }];
      },
      sendMessage: async (tabId, message, opts) => {
        calls.tabsSendMessage.push({ tabId, message, opts });
        const frameId = opts && typeof opts.frameId === 'number' ? opts.frameId : 'all';
        const fn = tabResponses[`${message.type}:${frameId}`] || tabResponses[message.type];
        if (typeof fn === 'function') return fn(message, frameId);
        if (fn !== undefined) return fn;
        return { ok: true };
      },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      onActivated: { addListener: (fn) => listeners.tabActivated.push(fn) },
    },
    storage: {
      sync: area(storageData.sync),
      local: area(storageData.local),
      session: area(storageData.session),
      onChanged: { addListener() {} },
    },
    offscreen: {
      hasDocument: async () => false,
      createDocument: async () => { calls.offscreen.push(1); },
    },
    contextMenus: {
      removeAll: async () => {},
      create: (item) => calls.menus.push(item),
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    scripting: {
      executeScript: async ({ target }) => (target && target.allFrames ? [{ frameId: 0 }, { frameId: 3 }] : [{ frameId: 0 }]),
    },
    commands: { onCommand: { addListener: (fn) => listeners.onCommand.push(fn) } },
  };
  return { chrome, listeners, calls, storageData, setTabResponses: (m) => { tabResponses = m; } };
}

/* ------------------------------ 假模型 ------------------------------ */

class FakeTranslator {
  static async availability() { return 'available'; }
  static async create({ sourceLanguage, targetLanguage }) {
    return new FakeTranslator(sourceLanguage, targetLanguage);
  }
  constructor(a, b) { this.a = a; this.b = b; }
  async translate(text) { return `«${text}»→${this.b}`; }
  async *translateStreaming(text) { yield `«${text}»→${this.b}`; }
  destroy() {}
}

/* ------------------------------ 启动 ------------------------------ */

const env = makeChrome();
globalThis.chrome = env.chrome;
globalThis.Translator = FakeTranslator;

await import('../offscreen/offscreen.js'); // 第一个注册：离屏宿主
await import('../background.js');          // 第二个注册：Service Worker

const onMessage = env.listeners.onMessage[env.listeners.onMessage.length - 1];
if (!onMessage) throw new Error('background.js 没有注册 onMessage 监听器');

function send(message, sender = { tab: { id: 1, url: 'https://example.com/a' }, frameId: 0 }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error(`等待 sendResponse 超时：${message.type}`)); }
    }, 5000);
    const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
    try {
      onMessage(message, sender, finish);
    } catch (err) {
      finish({ ok: false, error: `监听器抛错：${err && err.message}` });
    }
  });
}

const asTab = (id, frameId = 0) => ({ tab: { id, url: 'https://example.com/a' }, frameId });

/* ------------------------------ 用例 ------------------------------ */

await test('lt:register：返回设置；子 frame 注册不覆盖顶层 frame 的页面信息', async () => {
  const top = await send({ type: 'lt:register', payload: { url: 'https://example.com/a', title: 'A', docLang: 'en', isTop: true } }, asTab(7, 0));
  assert(top && top.ok === true, JSON.stringify(top));
  assert(top.settings && typeof top.settings.targetLang === 'string', '应带上设置');
  const sub = await send({ type: 'lt:register', payload: { url: 'https://example.com/iframe', isTop: false } }, asTab(7, 3));
  assert(sub.ok === true, JSON.stringify(sub));

  // 让「实时状态」问不到（内容脚本没应答），此时应回落到注册时记下的状态
  env.setTabResponses({ 'lt:status': null });
  const status = await send({ type: 'lt:page:status', payload: { tabId: 7 } });
  assert(status.ok === true, JSON.stringify(status));
  assert.equal(status.status.url, 'https://example.com/a', `子 frame 注册不该覆盖顶层状态：${JSON.stringify(status.status)}`);
  assert.equal(status.status.title, 'A', 'title 应保留');
  env.setTabResponses({});
});

await test('lt:page:status：实时状态回来后合并，不该把已知的 url/title 抹掉', async () => {
  env.setTabResponses({ 'lt:status': { ok: true, phase: 'done', translated: 5, mode: 'replace' } });
  const status = await send({ type: 'lt:page:status', payload: { tabId: 7 } });
  assert.equal(status.status.translated, 5, JSON.stringify(status.status));
  assert.equal(status.status.phase, 'done');
  assert.equal(status.status.url, 'https://example.com/a', `实时状态里没有 url 时不该把它抹成 undefined：${JSON.stringify(status.status)}`);
  assert.equal(status.status.title, 'A', '实时状态里没有 title 时不该抹掉');
  env.setTabResponses({});
});

await test('lt:settings:set：落盘 + 广播 + 改了术语表要清 Nano 会话', async () => {
  const res = await send({ type: 'lt:settings:set', payload: { patch: { targetLang: 'ja', glossary: 'AI=人工智能' } } });
  assert(res && res.ok === true, JSON.stringify(res));
  assert.equal(res.settings.targetLang, 'ja');
  assert.equal(env.storageData.sync.settings.targetLang, 'ja', '应写进 chrome.storage.sync');
  assert(env.calls.broadcasts.some((m) => m.type === 'lt:settings' && m.payload.targetLang === 'ja'), '应向扩展页面广播 lt:settings');
  assert(
    env.calls.tabsSendMessage.some((c) => c.message.type === 'lt:settings-changed' && c.message.payload.targetLang === 'ja'),
    '应向标签页广播 lt:settings-changed',
  );
  const again = await send({ type: 'lt:settings:get', payload: {} });
  assert.equal(again.settings.targetLang, 'ja');
  assert.equal(again.settings.glossary, 'AI=人工智能');
});

await test('lt:translate：走本地模型，应答协议带 ok:true', async () => {
  const res = await send({ type: 'lt:translate', payload: { text: 'Hello', source: 'en', target: 'ja' } });
  assert(res && res.ok === true, JSON.stringify(res));
  assert(String(res.text).includes('ja'), res.text);
});

await test('lt:translateBatch：应答协议与其它消息一致（带 ok:true），空项有结果', async () => {
  const res = await send({ type: 'lt:translateBatch', payload: { items: ['a', 'b', 'a', ''] } });
  assert(res, JSON.stringify(res));
  assert.equal(res.ok, true, `批量翻译的应答缺少 ok:true，调用方无法区分「失败」与「没这个字段」：${JSON.stringify(res).slice(0, 200)}`);
  assert.equal(res.results.length, 4, JSON.stringify(res).slice(0, 300));
  assert.equal(res.results[3].text, '', `空项应为空结果：${JSON.stringify(res.results[3])}`);
});

await test('lt:editor-claim：认领记录在正确的 tab 上', async () => {
  const claim = await send({ type: 'lt:editor-claim', payload: { url: 'https://example.com/a' } }, asTab(5, 3));
  assert(claim.ok === true && claim.frameId === 3, JSON.stringify(claim));
  env.setTabResponses({
    'lt:inline-status': (msg, frameId) => ({ ok: true, info: { hasTarget: frameId === 3, chars: 12, canWrite: frameId === 3 } }),
  });
  const statusAll = await send({ type: 'lt:inline-status-all', payload: { tabId: 5 } }, asTab(5, 0));
  assert(statusAll.ok === true, JSON.stringify(statusAll));
  assert.equal(statusAll.claimFrame, 3, '应认领 frame 3');
  assert.equal(statusAll.frames.length, 2, `两个 frame 的回答都该保留：${JSON.stringify(statusAll.frames)}`);
  const winner = statusAll.frames.find((f) => f.hasTarget);
  assert.equal(winner.frameId, 3, '真正有输入框的 frame 应被选中');
});

await test('lt:rewrite-input：没人认领时「探路 → 选赢家 → 写入」，且绝不广播写入', async () => {
  env.setTabResponses({
    'lt:rewrite-input': (msg, frameId) => {
      if (msg.payload && msg.payload.probeOnly) {
        // 真实内容脚本把 canWrite 放在顶层（content/inline.js sendResponse），info 里放读到的状态
        return { ok: true, canWrite: frameId === 3, info: { hasTarget: frameId === 3, chars: 5 } };
      }
      return { ok: true, canWrite: true, info: { value: `frame-${frameId}` } };
    },
  });
  env.calls.tabsSendMessage.length = 0;
  const res = await send({ type: 'lt:rewrite-input', payload: { tabId: 9, instruction: 'replace' } });
  assert(res, JSON.stringify(res));
  if (res.ok === false) {
    // 走到「没有输入框」也算合理路径，但错误必须是中文
    assert(/[一-龥]/.test(String(res.error)), `错误必须是中文：${res.error}`);
  } else {
    assert.equal(res.via, 'elected', JSON.stringify(res));
    assert.equal(res.frameId, 3);
    const probes = env.calls.tabsSendMessage.filter((c) => c.message.payload && c.message.payload.probeOnly);
    assert.equal(probes.length, 2, `探路要问遍所有 frame：${probes.length}`);
    const writes = env.calls.tabsSendMessage.filter((c) => !(c.message.payload && c.message.payload.probeOnly));
    assert(writes.every((c) => c.opts && c.opts.frameId === 3), `写入必须点对点发给赢家：${JSON.stringify(writes.map((c) => c.opts))}`);
  }
});

await test('快捷键 rewrite-input：有认领时点对点发给认领的 frame，不再广播', async () => {
  await send({ type: 'lt:editor-claim', payload: {} }, asTab(1, 3)); // 活动标签页是 1
  env.setTabResponses({
    'lt:rewrite-input': (msg, frameId) => ({ ok: true, via: frameId, info: { value: `frame-${frameId}` } }),
  });
  env.calls.tabsSendMessage.length = 0;
  const onCommand = env.listeners.onCommand[0];
  assert(onCommand, 'background.js 应注册 commands.onCommand 监听');
  await onCommand('rewrite-input');
  const sends = env.calls.tabsSendMessage.filter((c) => c.message.type === 'lt:rewrite-input');
  assert.equal(sends.length, 1, `应只发一次：${JSON.stringify(sends.map((c) => c.opts))}`);
  assert.equal(sends[0].opts && sends[0].opts.frameId, 3, `认领后必须点对点：${JSON.stringify(sends[0].opts)}`);
});

await test('快捷键 rewrite-input：没人认领时先探路再点对点写入', async () => {
  // 上一个用例在标签页 1 上留了认领记录：模拟标签页关闭，把认领表清干净
  env.listeners.tabRemoved[0](1);
  env.setTabResponses({
    'lt:rewrite-input': (msg, frameId) => {
      if (msg.payload && msg.payload.probeOnly) {
        // 真实内容脚本把 canWrite 放在顶层（content/inline.js sendResponse），info 里放读到的状态
        return { ok: true, canWrite: frameId === 3, info: { hasTarget: frameId === 3, chars: 5 } };
      }
      return { ok: true, canWrite: true, info: { value: `frame-${frameId}` } };
    },
  });
  env.calls.tabsSendMessage.length = 0;
  await env.listeners.onCommand[0]('rewrite-input');
  const sends = env.calls.tabsSendMessage.filter((c) => c.message.type === 'lt:rewrite-input');
  const probes = sends.filter((c) => c.message.payload && c.message.payload.probeOnly);
  const writes = sends.filter((c) => !(c.message.payload && c.message.payload.probeOnly));
  assert.equal(probes.length, 2, `探路要问遍所有 frame：${probes.length}`);
  assert.equal(writes.length, 1, `只该有一个赢家被写入：${writes.length}`);
  assert.equal(writes[0].opts && writes[0].opts.frameId, 3, `写入必须点对点发给赢家：${JSON.stringify(writes[0].opts)}`);
});

await test('快捷键 rewrite-input：所有 frame 都没有输入框 → 广播中文提示给侧边栏', async () => {
  env.setTabResponses({ 'lt:rewrite-input': { ok: false, error: '当前没有聚焦的输入框' } });
  env.calls.broadcasts.length = 0;
  await env.listeners.onCommand[0]('rewrite-input');
  const hint = env.calls.broadcasts.find((m) => m.type === 'lt:inline-hint');
  assert(hint, `应把原因送进侧边栏：${JSON.stringify(env.calls.broadcasts.map((m) => m.type))}`);
  assert(/[一-龥]/.test(String(hint.payload.text)), `提示必须是中文：${hint.payload.text}`);
});

await test('lt:page:*：状态流转自洽（翻译 → 还原 → idle）', async () => {
  env.setTabResponses({
    'lt:translate-page': { ok: true, nodes: 12, failed: 0 },
    'lt:restore-page': { ok: true },
    'lt:status': { ok: true, phase: 'done', translated: 12, mode: 'replace' },
  });
  const t = await send({ type: 'lt:page:translate', payload: { tabId: 3, mode: 'replace' } });
  assert(t && t.ok === true && t.nodes === 12, JSON.stringify(t));
  const s = await send({ type: 'lt:page:status', payload: { tabId: 3 } });
  assert.equal(s.status.translated, 12, JSON.stringify(s));
  const r = await send({ type: 'lt:page:restore', payload: { tabId: 3 } });
  assert(r && r.ok === true, JSON.stringify(r));
  env.setTabResponses({ 'lt:status': { ok: true, phase: 'idle', translated: 0 } });
  const s2 = await send({ type: 'lt:page:status', payload: { tabId: 3 } });
  assert.equal(s2.status.phase, 'idle', `还原后 phase 应回到 idle：${JSON.stringify(s2.status)}`);
  env.setTabResponses({});
});

await test('lt:page:*：没有标签页时给中文错误而不是抛异常', async () => {
  const res = await send({ type: 'lt:page:translate', payload: {} }, { frameId: 0 });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert(/[一-龥]/.test(String(res.error)), `错误必须是中文：${res.error}`);
});

await test('lt:cache:size / clear / lt:host:info / lt:selftest 都能应答', async () => {
  for (const type of ['lt:cache:size', 'lt:cache:clear', 'lt:host:info', 'lt:selftest']) {
    const res = await send({ type, payload: {} });
    assert(res && res.ok === true, `${type} → ${JSON.stringify(res).slice(0, 200)}`);
  }
});

await test('未知消息类型：不抛错、返回中文可读错误、不泄露栈', async () => {
  const res = await send({ type: 'lt:不存在的类型', payload: {} });
  assert(res && res.ok === false, JSON.stringify(res));
  assert(/[一-龥]/.test(String(res.error)), `错误必须是中文：${res.error}`);
  assert(!/at .*background\.js/.test(String(res.error)), '不该把栈透给调用方');
});

await test('lt:settings:set：非法 patch 不该把设置写坏', async () => {
  const before = (await send({ type: 'lt:settings:get', payload: {} })).settings;
  const res = await send({ type: 'lt:settings:set', payload: { patch: { targetLang: 12345, maxNodes: 'abc', inlineEnabled: 'yes' } } });
  assert(res && res.ok === true, JSON.stringify(res));
  const got = (await send({ type: 'lt:settings:get', payload: {} })).settings;
  assert.equal(typeof got.targetLang, 'string', `targetLang 应保持字符串：${JSON.stringify(got.targetLang)}`);
  assert.equal(typeof got.maxNodes, 'number', `maxNodes 应保持数字：${JSON.stringify(got.maxNodes)}`);
  assert.equal(typeof got.inlineEnabled, 'boolean', `inlineEnabled 应保持布尔：${JSON.stringify(got.inlineEnabled)}`);
  assert(before.targetLang !== 12345 && got.targetLang !== 12345, '非法目标语言不该落盘');
});

await test('lt:translate：没有可用引擎时报中文错误（放最后，会污染宿主选择）', async () => {
  const saved = globalThis.Translator;
  delete globalThis.Translator;
  try {
    const res = await send({ type: 'lt:translate', payload: { text: 'Hello', source: 'en', target: 'ja' } });
    assert(res && res.ok === false, JSON.stringify(res));
    assert(/[一-龥]/.test(String(res.error)), `错误必须是中文：${res.error}`);
    assert(!/at .*engine\.js/.test(String(res.error)), '不该把栈透给用户');
  } finally {
    globalThis.Translator = saved;
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
