/**
 * background.js —— MV3 Service Worker（module）
 *
 * 职责：
 *   - 唯一的「模型调用入口」：所有翻译 / 语言检测 / 解释都在本机完成
 *   - 推理宿主选择：优先在 Service Worker 里直接调用内置 AI；
 *     若该 Chrome 版本不允许（内置 AI 需要「负责文档」做策略检查、
 *     或语言包下载需要用户手势），自动切换到离屏文档（offscreen document）
 *   - 消息路由：侧边栏 / 弹窗 / 内容脚本之间的桥
 *   - 右键菜单、快捷键、每个标签页的翻译状态
 */

import {
  AIError,
  ENGINES,
  apiSupport,
  clearCache,
  detectLanguage,
  ensureNanoModel,
  explain,
  getCacheSize,
  humanizeError,
  probe,
  resetTranslators,
  resetNanoSessions,
  selftest,
  translate,
  translateStream,
  warmup,
} from './lib/engine.js';
import { getSettings, setSettings, onSettingsChanged } from './lib/settings.js';
import { isClaimUsable, pickBestResponse, summarizeFrames } from './lib/frames.js';

/* ------------------------------------------------------------------ */
/* 「哪个 frame 在打字」——认领表 + 逐个 frame 问答                      */
/* ------------------------------------------------------------------ */

/**
 * tabId → { frameId, at, url }
 *
 * 内容脚本一边打字一边认领自己所在的 frame。这样快捷键一来就能**点对点**发给
 * 那个 frame，而不是广播——广播时 `tabs.sendMessage` 只兑现第一个应答，
 * 而顶层 frame 会因为「祖先也算有焦点」抢答「没有输入框」，把真正能干的子 frame 挤掉。
 */
const editorClaims = new Map();

function claimEditor(tabId, frameId, info) {
  if (typeof tabId !== 'number' || typeof frameId !== 'number') return;
  editorClaims.set(tabId, { frameId, at: Date.now(), url: (info && info.url) || '' });
}

/** 列出标签页里的所有 frameId（用 scripting 的返回值枚举，不需要 webNavigation 权限） */
async function enumerateFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true,
    });
    const ids = results.map((r) => r.frameId).filter((id) => typeof id === 'number');
    if (!ids.includes(0)) ids.unshift(0);
    return [...new Set(ids)];
  } catch (err) {
    return [0];
  }
}

/** 问所有 frame 同一个问题，收齐**全部**回答（不是听第一个） */
async function askAllFrames(tabId, message, { timeoutMs = 1200 } = {}) {
  const frameIds = await enumerateFrames(tabId);
  const asks = frameIds.map((frameId) =>
    Promise.race([
      sendToTab(tabId, message, { frameId }).then((res) => ({ frameId, res })),
      new Promise((resolve) => setTimeout(() => resolve({ frameId, res: null }), timeoutMs)),
    ]).catch(() => ({ frameId, res: null })),
  );
  return Promise.all(asks);
}

/**
 * 输入框转写：先问认领的 frame（点对点），不行再问所有 frame 并挑最好的回答。
 * 返回内容脚本的应答，附带 frameId 与判定过程，方便排障。
 */
async function rewriteInInputFrame(tabId, instruction, payload = {}) {
  const claim = editorClaims.get(tabId);
  const direct = { ...instruction, payload: { ...payload, directive: 'claim' } };

  // 1) 有人认领（用户刚在那个 frame 里打过字）→ 点对点直接干，最准也最快
  if (isClaimUsable(claim)) {
    const res = await sendToTab(tabId, direct, { frameId: claim.frameId }).catch(() => null);
    if (res && res.ok) return { ...res, frameId: claim.frameId, via: 'claim' };
  }

  // 2) 没人认领 / 认领失效 → 先「探路」（probeOnly 不会动任何输入框），
  //    收齐所有 frame 的回答后挑唯一的赢家；这样绝不会有两个 frame 同时写。
  const probes = await askAllFrames(tabId, { ...instruction, payload: { ...payload, probeOnly: true } });
  const best = pickBestResponse(probes);
  if (best && best.res && best.res.canWrite) {
    const res = await sendToTab(tabId, direct, { frameId: best.frameId }).catch(() => null);
    if (res && res.ok) return { ...res, frameId: best.frameId, via: 'elected' };
    return { ...(res || {}), ok: false, frameId: best.frameId, error: (res && res.error) || '写入失败' };
  }

  const fallback = best && best.res ? best.res.error : null;
  return {
    ok: false,
    frameId: null,
    error: fallback || (claim ? '当前没有聚焦的输入框' : '请先把光标放进要转写的输入框'),
  };
}

/* ------------------------------------------------------------------ */
/* 推理宿主：Service Worker 或 离屏文档                                 */
/* ------------------------------------------------------------------ */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let engineHost = null; // 'sw' | 'offscreen'

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return true;
  } catch (err) {
    /* 没有 offscreen 权限时继续往下试 */
  }
  for (const reason of ['WORKERS', 'BLOBS']) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [reason],
        justification: 'Chrome 内置 AI（Translator / Prompt API）需要在文档上下文中运行，扩展 Service Worker 里可能不可用。',
      });
      return true;
    } catch (err) {
      const message = String((err && err.message) || '');
      if (message.includes('Only a single offscreen')) return true;
    }
  }
  return false;
}

/** 当前该用哪个宿主跑模型 */
async function pickHost() {
  if (engineHost === 'offscreen') return 'offscreen';
  const support = apiSupport();
  if (support.translator || support.nano) return 'sw';
  engineHost = 'offscreen';
  return 'offscreen';
}

/** 在 Service Worker 里直接执行（正常路径） */
async function runLocal(kind, payload) {
  switch (kind) {
    case 'probe':
      return { ok: true, ...(await probe(payload)) };
    case 'detect':
      return { ok: true, ...(await detectLanguage(payload.text || '')) };
    case 'warmup':
      await warmup(payload.source === 'auto' ? 'en' : payload.source, payload.target, {
        onDownload: (progress) =>
          broadcast({ type: 'lt:model-progress', payload: { source: payload.source, target: payload.target, progress } }),
      });
      return { ok: true };
    case 'nanoEnsure':
      // 兜底：个别 Chrome 版本允许在后台上下文里触发 Nano 下载（通常需要手势，不行会抛错）
      return { ok: true, ...(await ensureNanoModel({})) };
    case 'translate': {
      const res = await translate(payload);
      return {
        ok: true,
        text: res.text,
        engine: res.engine,
        sourceLang: res.source,
        targetLang: res.target,
        skipped: res.skipped,
        cached: res.cached,
        fallbackFrom: res.fallbackFrom,
      };
    }
    case 'translateBatch': {
      const { items = [], options = {} } = payload;
      const concurrency = Math.max(1, Math.min(4, options.concurrency || 2));
      const results = new Array(items.length).fill(null);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
          while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            const item = items[index];
            try {
              const res = await translate({
                ...options,
                text: typeof item === 'string' ? item : item.text,
                context: (item && item.context) || options.context || '',
              });
              results[index] = { text: res.text, skipped: res.skipped, engine: res.engine };
            } catch (err) {
              results[index] = { text: null, error: humanizeError(err), code: err && err.code };
            }
          }
        }),
      );
      return { ok: true, results };
    }
    default:
      throw new AIError('unknown', `未知任务：${kind}`);
  }
}

/** 交给离屏文档执行 */
async function callOffscreen(kind, payload) {
  if (!(await ensureOffscreen())) {
    throw new AIError('no-api', '无法创建离屏推理文档，请确认扩展已获得 offscreen 权限');
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', kind, payload });
  if (!res) throw new AIError('unknown', '离屏文档没有响应');
  if (res.ok === false) throw new AIError(res.code || 'unknown', res.error);
  return res;
}

/** 统一入口：自动选择宿主 + 失败后切换宿主重试一次 */
async function callEngine(kind, payload) {
  const host = await pickHost();
  if (host === 'offscreen') return callOffscreen(kind, payload);
  try {
    return await runLocal(kind, payload);
  } catch (err) {
    const code = (err && err.code) || '';
    // 这些失败都说明「Service Worker 里做不到」，换到离屏文档（真实文档上下文）再试一次
    const swBlind =
      code === 'no-api' ||
      code === 'no-nano' ||
      code === 'need-gesture' ||
      code === 'pair-create-failed' ||
      (err && err.name === 'NotAllowedError');
    if (!swBlind) throw err;
    engineHost = 'offscreen';
    return callOffscreen(kind, payload);
  }
}

/* ------------------------------------------------------------------ */
/* 标签页状态                                                          */
/* ------------------------------------------------------------------ */

const tabState = new Map(); // tabId -> status object

function setTabState(tabId, patch) {
  if (typeof tabId !== 'number') return null;
  const next = { ...(tabState.get(tabId) || {}), ...patch, updatedAt: Date.now() };
  tabState.set(tabId, next);
  broadcast({ type: 'lt:page-status', payload: { tabId, status: next } });
  return next;
}

const broadcast = (message) => {
  chrome.runtime.sendMessage(message).catch(() => {});
};

/**
 * 给标签页发消息。
 *   - 默认（options 省略）→ 广播到该标签页的所有 frame（Chrome 的默认行为），
 *     每个内容脚本自己决定要不要应答；这样「整页翻译 / 还原」能覆盖 iframe 里的内容，
 *     「翻译选中内容」也能命中选区所在的 frame。
 *   - { frameId: 0 } → 只发给顶层 frame（页面级状态、心跳走这条）。
 */
async function sendToTab(tabId, message, options) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, options ? { frameId: options.frameId } : undefined);
  } catch (err) {
    // 内容脚本可能还没注入（扩展刚安装 / 页面在扩展加载前就打开了）→ 注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/util.js', 'content/ui.js', 'content/inline.js', 'content/main.js'],
      });
      // 主世界的影子根助手（用于封闭 Shadow DOM）
      await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, files: ['content/agent.js'], world: 'MAIN' })
        .catch(() => {});
      return await chrome.tabs.sendMessage(tabId, message, options ? { frameId: options.frameId } : undefined);
    } catch (err2) {
      return { ok: false, error: '当前页面无法注入翻译脚本（chrome:// 与 Chrome 应用商店等页面不支持）' };
    }
  }
}

/** 只发给顶层 frame（拿页面级状态用） */
const sendToTopFrame = (tabId, message) => sendToTab(tabId, message, { frameId: 0 });

async function broadcastSettingsToTabs(settings) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    return;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    chrome.tabs.sendMessage(tab.id, { type: 'lt:settings-changed', payload: settings }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

async function handle(message, sender) {
  const { type, payload = {} } = message || {};
  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : payload.tabId;
  const settings = () => getSettings();

  switch (type) {
    /* ---------- 内容脚本注册 / 汇报 ---------- */
    case 'lt:register': {
      const s = await settings();
      const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
      // 只有顶层 frame 负责 tab 级状态，子 frame 注册时不要覆盖
      if (typeof tabId === 'number' && (frameId === 0 || !tabState.has(tabId))) {
        setTabState(tabId, {
          url: payload.url,
          title: payload.title,
          docLang: payload.docLang || '',
          isTop: payload.isTop !== false,
          phase: 'idle',
          translated: 0,
        });
        if (frameId === 0) await chrome.storage.session.set({ lastTabId: tabId }).catch(() => {});
      }
      return { ok: true, settings: s, support: apiSupport() };
    }
    case 'lt:editor-claim': {
      // 内容脚本说：用户正在我这儿打字（payload.url 用于排障）
      const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
      claimEditor(tabId, frameId, payload);
      return { ok: true, frameId };
    }
    case 'lt:inline-status-all': {
      // 侧边栏「自检当前输入框」：把每个 frame 的状态收齐（谁有目标、读到了几个字）
      const entries = await askAllFrames(tabId, { type: 'lt:inline-status', payload: {} });
      const claim = editorClaims.get(tabId) || null;
      return {
        ok: true,
        claimFrame: claim && isClaimUsable(claim) ? claim.frameId : null,
        frames: summarizeFrames(entries),
      };
    }
    case 'lt:progress':
      return { ok: true, status: setTabState(tabId, payload) };
    case 'lt:done':
      return { ok: true, status: setTabState(tabId, { ...payload, phase: 'done' }) };
    case 'lt:reset':
      return { ok: true, status: setTabState(tabId, { phase: 'idle', translated: 0 }) };

    /* ---------- 基础能力 ---------- */
    case 'lt:probe': {
      const s = await settings();
      const res = await callEngine('probe', {
        engine: payload.engine || s.engine,
        source: payload.source || s.sourceLang,
        target: payload.target || s.targetLang,
      });
      // 个别 Chrome 版本在 Service Worker 里看不见 Prompt API（nanoCtor() 为空），
      // 但离屏文档（真实 document）里看得见 —— 别把 Nano 误报成「不可用」，问一遍离屏宿主再合并。
      if (res.support && !res.support.nano) {
        try {
          const alt = await callOffscreen('probe', {
            engine: res.engine || 'auto',
            source: payload.source || s.sourceLang,
            target: payload.target || s.targetLang,
          });
          if (alt && alt.support && alt.support.nano) {
            res.support = { ...res.support, nano: true };
            if (!res.nano || res.nano === 'unsupported' || res.nano === 'unavailable') res.nano = alt.nano;
          }
        } catch (err) {
          /* 离屏宿主不可用：维持原结果 */
        }
      }
      return { ...res, settings: s, host: engineHost || 'sw' };
    }
    case 'lt:nano:ensure': {
      // 触发 Gemini Nano 模型本体下载的兜底链路：侧边栏/弹窗（有手势的文档）里触发失败后，
      // 先试 Service Worker（个别版本模型已就绪时不需要手势），再试离屏文档。
      try {
        return await runLocal('nanoEnsure', {});
      } catch (err) {
        try {
          return await callOffscreen('nanoEnsure', {});
        } catch (err2) {
          return { ok: false, error: humanizeError(err2), code: err2 && err2.code };
        }
      }
    }
    case 'lt:detect':
      return callEngine('detect', { text: payload.text || '' });

    case 'lt:warmup': {
      const s = await settings();
      const source = payload.source || s.sourceLang;
      const target = payload.target || s.targetLang;
      try {
        await callEngine('warmup', { source, target });
        broadcast({ type: 'lt:model-progress', payload: { source, target, progress: 1, done: true } });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: humanizeError(err), code: err && err.code };
      }
    }

    /* ---------- 翻译 ---------- */
    case 'lt:translate': {
      const s = await settings();
      return callEngine('translate', {
        text: payload.text,
        source: payload.source || s.sourceLang,
        target: payload.target || s.targetLang,
        engine: payload.engine || s.engine,
        tone: payload.tone || s.tone,
        glossary: payload.glossary !== undefined ? payload.glossary : s.glossary,
        context: payload.context || s.context,
        useCache: s.cacheEnabled !== false,
      });
    }

    case 'lt:translateBatch': {
      const s = await settings();
      const options = {
        source: (payload.options && payload.options.source) || s.sourceLang,
        target: (payload.options && payload.options.target) || s.targetLang,
        engine: (payload.options && payload.options.engine) || s.engine,
        tone: (payload.options && payload.options.tone) || s.tone,
        glossary: payload.options && payload.options.glossary !== undefined ? payload.options.glossary : s.glossary,
        context: (payload.options && payload.options.context) || s.context,
        concurrency: Math.max(1, Math.min(4, (payload.options && payload.options.concurrency) || s.concurrency || 2)),
        useCache: s.cacheEnabled !== false,
      };
      return callEngine('translateBatch', { items: payload.items || [], options });
    }

    case 'lt:explain': {
      const host = await pickHost();
      try {
        if (host === 'offscreen') {
          const res = await callOffscreen('explain', { text: payload.text, lang: payload.lang || 'zh' });
          return { ok: true, text: res.text };
        }
        const text = await explain(payload.text, { lang: payload.lang || 'zh' });
        return { ok: true, text };
      } catch (err) {
        if (host === 'sw' && (err.code === 'no-nano' || err.name === 'NotAllowedError')) {
          engineHost = 'offscreen';
          try {
            const res = await callOffscreen('explain', { text: payload.text, lang: payload.lang || 'zh' });
            return { ok: true, text: res.text };
          } catch (err2) {
            return { ok: false, error: humanizeError(err2), code: err2 && err2.code };
          }
        }
        return { ok: false, error: humanizeError(err), code: err && err.code };
      }
    }

    /* ---------- 整页 / 划词（面向标签页） ---------- */
    case 'lt:page:translate': {
      const target = typeof payload.tabId === 'number' ? payload.tabId : tabId;
      if (typeof target !== 'number') return { ok: false, error: '找不到目标标签页' };
      broadcast({ type: 'lt:page-status', payload: { tabId: target, status: { phase: 'working' } } });
      return sendToTab(target, { type: 'lt:translate-page', payload: { mode: payload.mode } });
    }
    case 'lt:page:restore': {
      const target = typeof payload.tabId === 'number' ? payload.tabId : tabId;
      if (typeof target !== 'number') return { ok: false, error: '找不到目标标签页' };
      const res = await sendToTab(target, { type: 'lt:restore-page' });
      setTabState(target, { phase: 'idle', translated: 0 });
      return res;
    }
    case 'lt:page:status': {
      const target = typeof payload.tabId === 'number' ? payload.tabId : tabId;
      if (typeof target !== 'number') return { ok: false, error: '找不到目标标签页' };
      const live = await sendToTopFrame(target, { type: 'lt:status' });
      if (live && live.ok) setTabState(target, { ...live, phase: live.phase });
      return { ok: true, status: live && live.ok ? live : tabState.get(target) || null };
    }
    case 'lt:selection:translate':
    case 'lt:selection:explain': {
      const target = typeof payload.tabId === 'number' ? payload.tabId : tabId;
      if (typeof target !== 'number') return { ok: false, error: '找不到目标标签页' };
      const msgType = type === 'lt:selection:translate' ? 'lt:translate-selection' : 'lt:explain-selection';
      const res = await sendToTab(target, { type: msgType, payload: { text: payload.text } });
      return res && res.ok === false ? res : { ok: true };
    }

    /* ---------- 设置 / 缓存 / 诊断 ---------- */
    case 'lt:settings:get':
      return { ok: true, settings: await getSettings(), support: apiSupport(), host: engineHost || 'sw' };
    case 'lt:settings:set': {
      const next = await setSettings(payload.patch || {});
      await broadcastSettingsToTabs(next);
      broadcast({ type: 'lt:settings', payload: next });
      // Nano 会话池以（语气/术语表/上下文/温度）为键，且系统提示词在创建时就固化进会话。
      // 改了这些设置后旧会话不会自动更新 —— 主动清掉，下一次翻译用新设置重建。
      const touched = Object.keys(payload.patch || {});
      if (touched.some((k) => ['engine', 'tone', 'glossary', 'context', 'temperature', 'uiLang'].includes(k))) {
        resetNanoSessions();
        try {
          await callOffscreen('engineReset', {});
        } catch (err) {
          /* 离屏宿主可能没起来，忽略 */
        }
      }
      return { ok: true, settings: next };
    }
    case 'lt:cache:size':
      return { ok: true, size: await getCacheSize() };
    case 'lt:cache:clear':
      await clearCache();
      return { ok: true, size: 0 };
    case 'lt:engine:reset': {
      // 释放并重建两条链路的原生会话：Nano 会话 + 内置翻译会话。
      // 万一哪个实例被外部弄坏了（比如被 abort 成 destroy），点一下就能恢复，
      // 不用重启浏览器。
      resetNanoSessions();
      resetTranslators();
      try {
        await callOffscreen('engineReset', {});
      } catch (err) {
        /* 离屏宿主可能没起来，忽略 */
      }
      return { ok: true };
    }
    case 'lt:host:info':
      return { ok: true, host: engineHost || 'sw', support: apiSupport() };

    /* ---------- 自检：分别报告 availability 与 create 的真实结果 ---------- */
    case 'lt:selftest': {
      const source = !payload.source || payload.source === 'auto' ? 'en' : payload.source;
      const result = await selftest({ source, target: payload.target || 'zh' });
      return { ok: true, ...result, host: engineHost || 'sw' };
    }

    default:
      return { ok: false, error: `未知消息类型：${type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  // 发给离屏文档的消息不要在这里处理（否则会抢答）
  if (message.target === 'offscreen') return false;
  // 离屏文档回传的下载进度
  if (message.target === 'background' && message.type === 'lt:offscreen-progress') {
    broadcast({ type: 'lt:model-progress', payload: message.payload });
    return false;
  }
  handle(message, sender).then(
    (res) => sendResponse(res),
    (err) => sendResponse({ ok: false, error: humanizeError(err), code: err && err.code }),
  );
  return true; // 异步响应
});

/* ------------------------------------------------------------------ */
/* 流式翻译通道（侧边栏「输入即译」用）                                  */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lt-stream') return;
  /**
   * 每次请求一个 controller + 一个递增的序号。
   * 序号用来判断「这次请求是不是已经被后来的请求取代了」——被取代的请求
   * 就算是因为 abort 失败报错，也不该弹给用户看（否则「边输边译」时全是假报错）。
   */
  let controller = null;
  let runId = 0;
  let finished = true;

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start') {
      if (msg && msg.type === 'abort' && controller) controller.abort();
      return;
    }
    // 只中止「还在跑」的上一个请求；已经跑完的不要动它
    if (controller && !finished) controller.abort();
    controller = new AbortController();
    const myRun = ++runId;
    finished = false;
    const stale = () => myRun !== runId;
    try {
      const s = await getSettings();
      const options = {
        text: msg.text,
        source: msg.source || s.sourceLang,
        target: msg.target || s.targetLang,
        engine: msg.engine || s.engine,
        tone: msg.tone || s.tone,
        glossary: msg.glossary !== undefined ? msg.glossary : s.glossary,
        context: msg.context !== undefined ? msg.context : s.context,
        signal: controller.signal,
        onDownload: (progress) => {
          try {
            port.postMessage({ type: 'download', progress });
          } catch (err) {
            /* 端口已关闭 */
          }
        },
      };
      const host = await pickHost();
      if (host === 'offscreen') {
        // 离屏文档不支持跨进程流式，一次性回传（前端会自动退化为一次显示）
        const res = await callOffscreen('stream', { ...options, signal: undefined, onDownload: undefined });
        if (stale()) return;
        port.postMessage({ type: 'chunk', text: res.text });
        port.postMessage({ type: 'done', text: res.text });
        finished = true;
        return;
      }
      try {
        let last = '';
        for await (const acc of translateStream(options)) {
          last = acc;
          if (stale()) return; // 已经被新请求取代：别再往回推流
          port.postMessage({ type: 'chunk', text: acc });
        }
        if (stale()) return;
        port.postMessage({ type: 'done', text: last });
        finished = true;
      } catch (err) {
        if (err && (err.code === 'no-api' || err.name === 'NotAllowedError')) {
          engineHost = 'offscreen';
          const res = await callOffscreen('stream', { ...options, signal: undefined, onDownload: undefined });
          if (stale()) return;
          port.postMessage({ type: 'chunk', text: res.text });
          port.postMessage({ type: 'done', text: res.text });
          finished = true;
          return;
        }
        throw err;
      }
    } catch (err) {
      finished = true;
      // 被后来的请求取代了（比如边打字边重复触发）→ 静默，用户不需要看到这个错误
      if (stale()) return;
      try {
        port.postMessage({ type: 'error', error: humanizeError(err), code: err && err.code });
      } catch (err2) {
        /* 端口已关闭 */
      }
    }
  });

  port.onDisconnect.addListener(() => {
    runId += 1; // 让在跑的请求失效
    if (controller && !finished) controller.abort();
    controller = null;
    finished = true;
  });
});

/* ------------------------------------------------------------------ */
/* 右键菜单 & 快捷键                                                    */
/* ------------------------------------------------------------------ */

const MENUS = [
  { id: 'lt-selection-translate', title: '本地翻译：翻译所选内容', contexts: ['selection'] },
  { id: 'lt-selection-explain', title: '本地翻译：用 Gemini Nano 解释所选内容', contexts: ['selection'] },
  { id: 'lt-sep-1', type: 'separator', contexts: ['selection', 'page'] },
  { id: 'lt-page-translate', title: '本地翻译：翻译整个页面（替换原文）', contexts: ['page', 'frame'] },
  { id: 'lt-page-dual', title: '本地翻译：双语对照翻译（原文下方插入译文）', contexts: ['page', 'frame'] },
  { id: 'lt-page-hover', title: '本地翻译：悬停对照翻译', contexts: ['page', 'frame'] },
  { id: 'lt-page-restore', title: '本地翻译：还原页面原文', contexts: ['page', 'frame'] },
  { id: 'lt-sep-2', type: 'separator', contexts: ['page'] },
  { id: 'lt-open-panel', title: '本地翻译：打开侧边栏', contexts: ['page', 'action'] },
];

async function setupMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (err) {
    /* 忽略 */
  }
  for (const item of MENUS) {
    try {
      chrome.contextMenus.create(item);
    } catch (err) {
      /* 忽略重复创建 */
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupMenus();
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (err) {
    /* 旧版本没有 sidePanel */
  }
  // 预创建离屏宿主，避免第一次翻译时多等一拍
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab && tab.id;
  // 右键有可能发生在 iframe 里：info.frameId 就是那个 frame，定向投递最稳
  const frameOptions = typeof info.frameId === 'number' ? { frameId: info.frameId } : undefined;
  switch (info.menuItemId) {
    case 'lt-selection-translate':
      await sendToTab(tabId, { type: 'lt:translate-selection', payload: { text: info.selectionText } }, frameOptions);
      break;
    case 'lt-selection-explain':
      await sendToTab(tabId, { type: 'lt:explain-selection', payload: { text: info.selectionText } }, frameOptions);
      break;
    case 'lt-page-translate':
      await sendToTab(tabId, { type: 'lt:translate-page', payload: { mode: 'replace' } });
      break;
    case 'lt-page-dual':
      await sendToTab(tabId, { type: 'lt:translate-page', payload: { mode: 'dual' } });
      break;
    case 'lt-page-hover':
      await sendToTab(tabId, { type: 'lt:translate-page', payload: { mode: 'hover' } });
      break;
    case 'lt-page-restore':
      await sendToTab(tabId, { type: 'lt:restore-page' });
      setTabState(tabId, { phase: 'idle', translated: 0 });
      break;
    case 'lt-open-panel':
      try {
        await chrome.sidePanel.open({ tabId });
      } catch (err) {
        /* 需要用户手势，失败就忽略 */
      }
      break;
    default:
      break;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') return;
  if (command === 'translate-page') {
    await sendToTab(tab.id, { type: 'lt:translate-page', payload: {} });
  } else if (command === 'translate-selection') {
    await sendToTab(tab.id, { type: 'lt:translate-selection', payload: {} });
  } else if (command === 'restore-page') {
    await sendToTab(tab.id, { type: 'lt:restore-page' });
  } else if (command === 'open-panel') {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
      /* 忽略 */
    }
  } else if (command === 'rewrite-input') {
    // 输入框转写：认领优先（点对点），否则问一圈所有 frame 再挑最好的回答
    const res = await rewriteInInputFrame(tab.id, { type: 'lt:rewrite-input' }, {});
    if (res && res.ok === false && res.error) {
      // 别让用户面对「按了没反应」：把原因送进侧边栏的「输入框转写」卡片
      broadcast({ type: 'lt:inline-hint', payload: { text: res.error } });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 标签页生命周期                                                       */
/* ------------------------------------------------------------------ */

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  editorClaims.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabState.delete(tabId);
    editorClaims.delete(tabId); // 导航后旧的 frame 认领作废
    broadcast({ type: 'lt:page-status', payload: { tabId, status: { phase: 'idle', url: changeInfo.url } } });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await chrome.storage.session.set({ lastTabId: tabId }).catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 设置变化 → 通知所有页面                                              */
/* ------------------------------------------------------------------ */

onSettingsChanged(async (settings) => {
  await broadcastSettingsToTabs(settings);
  broadcast({ type: 'lt:settings', payload: settings });
});

// 便于在 service worker 控制台里调试：__LT_ENGINE__
globalThis.__LT_ENGINE__ = { ENGINES, apiSupport, probe, callEngine, pickHost };
