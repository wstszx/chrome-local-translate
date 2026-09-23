/**
 * offscreen/offscreen.js —— 备用推理宿主
 *
 * 与 background.js 使用完全相同的 lib/engine.js，只是运行在有 document 的上下文里。
 * 消息协议：{ target: 'offscreen', kind, payload } → { ok, ... }
 */
import {
  clearCache,
  detectLanguage,
  ensureNanoModel,
  explain,
  getCacheSize,
  humanizeError,
  probe,
  resetNanoSessions,
  resetTranslators,
  selftest,
  translate,
  translateStream,
  warmup,
} from '../lib/engine.js';

async function handle({ kind, payload = {} }) {
  switch (kind) {
    case 'probe': {
      const info = await probe(payload);
      return { ok: true, ...info };
    }
    case 'detect': {
      const res = await detectLanguage(payload.text || '', { allowDownload: false });
      return { ok: true, ...res };
    }
    case 'warmup': {
      await warmup(payload.source === 'auto' ? 'en' : payload.source, payload.target, {
        onDownload: (progress) => {
          chrome.runtime.sendMessage({ target: 'background', type: 'lt:offscreen-progress', payload: { ...payload, progress } }).catch(() => {});
        },
      });
      return { ok: true };
    }
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
    case 'selftest':
      return { ok: true, ...(await selftest({ source: payload.source || 'en', target: payload.target || 'zh' })) };
    case 'translateBatch': {
      const { items = [], options = {} } = payload;
      const results = new Array(items.length).fill(null);
      const tasks = items.map((item, index) => ({ item, index }));
      let cursor = 0;
      const concurrency = Math.max(1, Math.min(4, options.concurrency || 2));
      await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length || 1) }, async () => {
          while (cursor < tasks.length) {
            const { item, index } = tasks[cursor];
            cursor += 1;
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
    case 'stream': {
      // 离屏文档里不做真流式：把整段结果一次性回传，前端会自动退化为「一次显示」
      let last = '';
      for await (const acc of translateStream(payload)) last = acc;
      return { ok: true, text: last };
    }
    case 'nanoEnsure':
      return { ok: true, ...(await ensureNanoModel({})) };
    case 'explain':
      return { ok: true, text: await explain(payload.text, { lang: payload.lang || 'zh' }) };
    case 'cacheSize':
      return { ok: true, size: await getCacheSize() };
    case 'cacheClear':
      await clearCache();
      return { ok: true, size: 0 };
    case 'engineReset':
      resetNanoSessions();
      resetTranslators();
      return { ok: true };
    case 'ping':
      return { ok: true, ready: true };
    default:
      return { ok: false, error: `离屏宿主收到未知任务：${kind}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  handle(message).then(
    (res) => sendResponse(res),
    (err) => sendResponse({ ok: false, error: humanizeError(err), code: err && err.code }),
  );
  return true;
});
