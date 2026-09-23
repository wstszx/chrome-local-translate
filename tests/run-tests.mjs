/**
 * tests/run-tests.mjs —— 引擎与工具函数的单元测试（Node 20+，零依赖）
 * 运行：node tests/run-tests.mjs   （或 npm test）
 *
 * 这里用「假 API」模拟 Chrome 的 Translator / LanguageModel 行为，
 * 用来验证分段、缓存、错误映射、回退链路等不依赖真实浏览器的逻辑。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINES,
  apiSupport,
  buildSystemPrompt,
  checkNanoHardware,
  chunkText,
  clearCache,
  detectLanguage,
  ensureNanoModel,
  humanizeError,
  parseGlossary,
  probe,
  selftest,
  translate,
  translateMany,
  translateStream,
  __internals,
} from '../lib/engine.js';
import { detectByHeuristic, langLabel, looksTranslatable, normalizeCode, needsSpace } from '../lib/languages.js';
import { CLAIM_TTL, isClaimUsable, pickBestResponse, scoreResponse, summarizeFrames } from '../lib/frames.js';

/* ------------------------------ 迷你测试框架 ------------------------------ */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------ 假 API ------------------------------ */

function installFakeTranslator({ availability = 'available', createError = null, downloadTicks = 2 } = {}) {
  const calls = [];
  const state = { created: 0 };
  globalThis.Translator = {
    async availability() {
      return availability;
    },
    async create({ sourceLanguage, targetLanguage, monitor }) {
      state.created += 1;
      if (monitor) {
        for (let i = 1; i <= downloadTicks; i += 1) {
          monitor({ addEventListener: (type, cb) => type === 'downloadprogress' && cb({ loaded: i, total: downloadTicks }) });
        }
      }
      if (createError) throw Object.assign(new Error('blocked'), { name: createError });
      return {
        sourceLanguage,
        targetLanguage,
        inputQuota: 5000,
        async translate(text) {
          calls.push({ sourceLanguage, targetLanguage, text });
          return `«${text.toUpperCase()}»`;
        },
        translateStreaming(text) {
          const full = `«${text.toUpperCase()}»`;
          const pieces = full.match(/.{1,6}/g) || [];
          let acc = '';
          return {
            async *[Symbol.asyncIterator]() {
              for (const p of pieces) {
                acc += p;
                yield acc; // 累积式语义
              }
            },
          };
        },
      };
    },
  };
  return { calls, state };
}

function installFakeNano({ availability = 'available', capture = [] } = {}) {
  globalThis.LanguageModel = {
    async availability() {
      return availability;
    },
    async create(options) {
      capture.push(options);
      return {
        async prompt(text) {
          return `NANO(${text})`;
        },
        promptStreaming(text) {
          return {
            async *[Symbol.asyncIterator]() {
              yield `NANO`;
              yield `NANO(${text.slice(0, 3)}`;
              yield `NANO(${text})`;
            },
          };
        },
        destroy() {},
      };
    },
  };
  return capture;
}

/**
 * 严格按规范实现的假 Translator（MDN 明确写过）：
 *   - abort() 在 create() 兑现**之前**调用 → 创建被取消；
 *   - abort() 在 create() 兑现**之后**调用 → 等价于 destroy()：
 *     实例被释放，之后任何 translate()/translateStreaming() 都以 AbortError 失败。
 * 真实 Chrome 就是这个行为，这正是「第一次转写正常、第二次开始报错」的根源。
 */
function installSpecFakeTranslator() {
  const state = { created: 0, destroyed: 0, abortedBeforeReady: 0 };
  globalThis.Translator = {
    async availability() {
      return 'available';
    },
    async create({ sourceLanguage, targetLanguage, signal }) {
      state.created += 1;
      let dead = false;
      const instance = {
        sourceLanguage,
        targetLanguage,
        inputQuota: 5000,
        destroyed: false,
        async translate(text) {
          if (dead) throw Object.assign(new Error('Translator has been destroyed'), { name: 'AbortError' });
          return `«${text.toUpperCase()}»`;
        },
        translateStreaming(text) {
          const full = `«${text.toUpperCase()}»`;
          const pieces = full.match(/.{1,6}/g) || [];
          let acc = '';
          return {
            async *[Symbol.asyncIterator]() {
              for (const p of pieces) {
                if (dead) throw Object.assign(new Error('The translator is destroyed'), { name: 'AbortError' });
                acc += p;
                yield acc;
              }
            },
          };
        },
        destroy() {
          if (!dead) state.destroyed += 1;
          dead = true;
        },
      };
      if (signal) {
        if (signal.aborted) {
          state.abortedBeforeReady += 1;
          throw Object.assign(new Error('create aborted'), { name: 'AbortError' });
        }
        signal.addEventListener(
          'abort',
          () => {
            // 规范的这一句是整件事的关键：兑现后再 abort ≈ destroy()
            instance.destroy();
          },
          { once: true },
        );
      }
      return instance;
    },
  };
  return state;
}

function resetGlobals() {
  delete globalThis.Translator;
  delete globalThis.LanguageModel;
  __internals.translatorPool.clear();
  __internals.nanoSessions.clear();
}

/** 临时改写 navigator 上那几个只读属性，测完自动还原（Node 的 navigator 不允许直接赋值）。 */
function withNavigatorStub(stub, fn) {
  const keys = ['hardwareConcurrency', 'deviceMemory', 'storage'];
  const original = {};
  for (const key of keys) {
    original[key] = Object.getOwnPropertyDescriptor(navigator, key);
    if (key in stub) {
      Object.defineProperty(navigator, key, { value: stub[key], configurable: true });
    } else {
      Object.defineProperty(navigator, key, { value: undefined, configurable: true });
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (original[key]) Object.defineProperty(navigator, key, original[key]);
      }
    });
}

/* ------------------------------ 语言工具 ------------------------------ */

test('normalizeCode 归一化常见标签', () => {
  assert.equal(normalizeCode('zh-CN'), 'zh');
  assert.equal(normalizeCode('zh_TW'), 'zh-Hant');
  assert.equal(normalizeCode('en-US'), 'en');
  assert.equal(normalizeCode('es-419'), 'es');
  assert.equal(normalizeCode('PT-br'), 'pt');
  assert.equal(normalizeCode(''), '');
});

test('langLabel 输出中文名', () => {
  assert.equal(langLabel('zh'), '中文（简体）');
  assert.equal(langLabel('ja'), '日语');
  assert.equal(langLabel('auto'), '自动检测');
  assert.equal(langLabel('xx'), 'xx');
});

test('detectByHeuristic 脚本粗判', () => {
  assert.equal(detectByHeuristic('这是一段中文测试文本，用来验证语言识别。').language, 'zh');
  assert.equal(detectByHeuristic('これは日本語のテストです。').language, 'ja');
  assert.equal(detectByHeuristic('Это тестовый текст на русском языке.').language, 'ru');
  assert.equal(detectByHeuristic('Це український текст із літерою ї.').language, 'uk');
  assert.equal(detectByHeuristic('The quick brown fox jumps over the lazy dog, and it is not bad.').language, 'en');
  assert.equal(detectByHeuristic('這段話是繁體中文，裡面的詞語與眾不同。').language, 'zh-Hant');
});

test('looksTranslatable 过滤掉噪音', () => {
  assert.equal(looksTranslatable('Hello world, this is a sentence.'), true);
  assert.equal(looksTranslatable('https://example.com/path'), false);
  assert.equal(looksTranslatable('me@example.com'), false);
  assert.equal(looksTranslatable('123 456 789'), false);
  assert.equal(looksTranslatable('index.js'), false);
  assert.equal(looksTranslatable('12%'), false);
});

test('needsSpace 在 CJK 之间不插空格', () => {
  assert.equal(needsSpace('你好', '世界'), false);
  assert.equal(needsSpace('hello', 'world'), true);
  assert.equal(needsSpace('你好', 'world'), false);
});

/* ------------------------------ 分段 ------------------------------ */

test('chunkText 严格不超过上限且不丢内容', () => {
  const para = 'Sentence number %N%. This is a longer piece of english text used to test chunking behaviour. ';
  const text = Array.from({ length: 40 }, (_, i) => para.replace('%N%', String(i))).join('\n\n');
  const chunks = chunkText(text, 300);
  assert.ok(chunks.length > 3, `应切成多段，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.text.length <= 300, `分段超长: ${c.text.length}`);
  const rejoined = chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();
  const source = text.replace(/\s+/g, ' ').trim();
  assert.equal(rejoined, source);
});

test('chunkText 处理超长单词（硬切）', () => {
  const long = 'x'.repeat(2500);
  const chunks = chunkText(long, 200);
  assert.ok(chunks.every((c) => c.text.length <= 200));
  assert.equal(chunks.map((c) => c.text).join(''), long);
});

test('chunkText 短文本原样返回', () => {
  const chunks = chunkText('Hello 世界', 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Hello 世界');
});

/* ------------------------------ 术语表 / 提示词 ------------------------------ */

test('parseGlossary 支持多种写法', () => {
  const list = parseGlossary('a=甲\nb => 乙\nc→丙\n# 注释\nd : 丁');
  assert.deepEqual(list, [
    { from: 'a', to: '甲' },
    { from: 'b', to: '乙' },
    { from: 'c', to: '丙' },
    { from: 'd', to: '丁' },
  ]);
});

test('buildSystemPrompt 包含目标语言、语气与术语表', () => {
  const prompt = buildSystemPrompt({ target: 'zh', targetLabel: '中文（简体）', tone: 'technical', glossary: 'Chrome=谷歌浏览器' });
  assert.match(prompt, /中文（简体）/);
  assert.match(prompt, /技术内容/);
  assert.match(prompt, /Chrome → 谷歌浏览器/);
  assert.match(prompt, /只输出译文本身/);
});

/* ------------------------------ 内置翻译模型链路 ------------------------------ */

test('无任何本地 API 时给出明确错误', async () => {
  resetGlobals();
  assert.equal(apiSupport().translator, false);
  await assert.rejects(() => translate({ text: 'hi', target: 'zh' }), (err) => err.code === 'no-api');
});

test('Translator 链路：翻译 + 二次命中缓存', async () => {
  resetGlobals();
  await clearCache();
  const { calls, state } = installFakeTranslator();
  const first = await translate({ text: 'Hello world.', source: 'en', target: 'fr' });
  assert.equal(first.text, '«HELLO WORLD.»');
  assert.equal(first.engine, ENGINES.TRANSLATOR);
  assert.equal(state.created, 1);
  const second = await translate({ text: 'Hello world.', source: 'en', target: 'fr' });
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, '第二次应命中缓存，不再调用模型');
  assert.equal(__internals.translatorPool.size, 1, '相同语言对复用同一个 Translator 实例');
});

test('源语言 = 目标语言时直接返回，不调用模型', async () => {
  resetGlobals();
  const { calls } = installFakeTranslator();
  const res = await translate({ text: '你好世界', source: 'zh', target: 'zh' });
  assert.equal(res.skipped, true);
  assert.equal(calls.length, 0);
});

test('长文本会自动分段后合并（CJK 用拼接不插空格）', async () => {
  resetGlobals();
  const { calls } = installFakeTranslator();
  const text = `${'这是第一句。'.repeat(60)}\n\n${'这是第二段。'.repeat(60)}`;
  const res = await translate({ text, source: 'zh', target: 'en', maxChars: 120 });
  assert.ok(calls.length > 2, `应多次调用，实际 ${calls.length}`);
  assert.ok(res.text.includes('«'), '每段译文都带标记');
  assert.ok(!/。\s*。/.test(res.text));
});

test('首次使用且没有用户手势 → need-gesture', async () => {
  resetGlobals();
  installFakeTranslator({ availability: 'downloadable', createError: 'NotAllowedError' });
  await assert.rejects(() => translate({ text: 'hello', source: 'en', target: 'ja' }), (err) => err.code === 'need-gesture');
});

test('语言对不支持时自动回退到 Gemini Nano', async () => {
  resetGlobals();
  const capture = installFakeNano();
  globalThis.Translator = {
    async availability() {
      return 'unavailable';
    },
    async create() {
      throw Object.assign(new Error('no pair'), { name: 'NotSupportedError' });
    },
  };
  const res = await translate({ text: 'Hello there', source: 'en', target: 'xx', glossary: 'Hello=你好' });
  assert.equal(res.engine, ENGINES.NANO);
  assert.equal(res.text, 'NANO(Hello there)');
  assert.ok(capture.length >= 1);
  const systemPrompt = capture[0].initialPrompts[0].content;
  assert.match(systemPrompt, /Hello → 你好/);
  // 采样参数合规（2026-08 官方文档）：temperature 与 topK 必须成对出现，且以 params() 为准；
  // params() 不可用时就一个采样参数都不传（否则硬编码值在新版 Chrome 上会让 create() 失败）。
  assert.equal(capture[0].temperature, undefined);
  assert.equal(capture[0].topK, undefined);
});

test('Nano 采样参数：params() 可用时成对传参，且 temperature 被夹在 maxTemperature 内', async () => {
  resetGlobals();
  const capture = installFakeNano();
  globalThis.LanguageModel.params = async () => ({
    defaultTemperature: 1,
    maxTemperature: 2,
    defaultTopK: 3,
    maxTopK: 128,
  });
  await translate({ text: 'Hello there', source: 'en', target: 'xx', temperature: 5 });
  assert.equal(capture[0].temperature, 2, '超出上限的 temperature 应被夹到 maxTemperature');
  assert.equal(capture[0].topK, 3, 'topK 必须与 temperature 同时出现');
});

test('Nano：create() 拒绝采样参数时自动降级为不带采样参数重试', async () => {
  resetGlobals();
  const attempts = [];
  globalThis.LanguageModel = {
    async availability() {
      return 'available';
    },
    async create(options) {
      attempts.push(options);
      if (options && options.temperature !== undefined) {
        throw Object.assign(new Error('Unsupported sampling parameters'), { name: 'TypeError' });
      }
      return {
        async prompt(text) {
          return `NANO(${text})`;
        },
        destroy() {},
      };
    },
  };
  // params() 存在 → 第一次会带采样参数；伪造「新版本拒绝旧参数」→ 自动降级重试
  globalThis.LanguageModel.params = async () => ({
    defaultTemperature: 1,
    maxTemperature: 2,
    defaultTopK: 3,
    maxTopK: 128,
  });
  const res = await translate({ text: 'Hello there', source: 'en', target: 'xx', useCache: false });
  assert.equal(res.engine, ENGINES.NANO);
  assert.equal(attempts.length, 2, '第一次带采样参数失败，第二次不带');
  assert.equal(attempts[1].temperature, undefined);
  assert.ok(attempts[1].initialPrompts, '降级重试仍保留系统提示词');
});

test('create() 抛 NotSupportedError → pair-create-failed（区分于 availability 说不支持）', async () => {
  resetGlobals();
  globalThis.Translator = {
    async availability() {
      return 'available'; // 关键：availability 说可用，create 却失败（用户实际遇到的情况）
    },
    async create() {
      throw Object.assign(new Error('Unable to create translator for the given source and target language.'), {
        name: 'NotSupportedError',
      });
    },
  };
  await assert.rejects(
    () => translate({ text: 'hello', source: 'en', target: 'zh', engine: 'translator' }),
    (err) => err.code === 'pair-create-failed' && /Unable to create translator/.test(err.detail || ''),
  );
});

test('自动模式下 create 失败会自动回退 Gemini Nano 并标记来源', async () => {
  resetGlobals();
  installFakeNano();
  globalThis.Translator = {
    async availability() {
      return 'available';
    },
    async create() {
      throw Object.assign(new Error('Unable to create translator for the given source and target language.'), {
        name: 'NotSupportedError',
      });
    },
  };
  const res = await translate({ text: 'Hello there', source: 'en', target: 'zh' });
  assert.equal(res.engine, ENGINES.NANO);
  assert.equal(res.fallbackFrom, 'pair-create-failed');
  assert.equal(res.text, 'NANO(Hello there)');
});

test('selftest 分别报告 availability 与 create 的结果', async () => {
  resetGlobals();
  installFakeNano();
  installFakeTranslator();
  const ok = await selftest({ source: 'en', target: 'ja' });
  assert.equal(ok.availability, 'available');
  assert.equal(ok.create, 'ok');
  assert.equal(ok.nanoCreate, 'ok');
  assert.match(ok.json, /"create": "ok"/);

  resetGlobals();
  installFakeNano();
  globalThis.Translator = {
    async availability() {
      return 'available';
    },
    async create() {
      throw Object.assign(new Error('nope'), { name: 'NotSupportedError' });
    },
  };
  const bad = await selftest({ source: 'en', target: 'zh' });
  assert.equal(bad.availability, 'available');
  assert.equal(bad.create, 'failed');
  assert.match(bad.createError, /NotSupportedError/);
});

test('语言包下载进度回调能收到 0~1 的进度', async () => {
  resetGlobals();
  installFakeTranslator({ downloadTicks: 4 });
  const seen = [];
  await translate({ text: 'hi there', source: 'en', target: 'de', onDownload: (p) => seen.push(p) });
  assert.deepEqual(seen, [0.25, 0.5, 0.75, 1]);
});

/* ------------------------------ Gemini Nano 链路 ------------------------------ */

test('Gemini Nano 链路：提示词、语气、解释输出清洗', async () => {
  resetGlobals();
  const capture = installFakeNano();
  const res = await translate({ text: 'Hello', source: 'en', target: 'zh', engine: ENGINES.NANO, tone: 'formal' });
  assert.equal(res.engine, ENGINES.NANO);
  assert.match(capture[0].initialPrompts[0].content, /正式/);
  assert.equal(__internals.cleanModelOutput('译文： 你好'), '你好');
  assert.equal(__internals.cleanModelOutput('“你好”'), '你好');
  assert.equal(__internals.cleanModelOutput('```\n你好\n```'), '你好');
});

test('Nano 会话按「语言对 + 语气 + 术语表」复用', async () => {
  resetGlobals();
  const capture = installFakeNano();
  await translate({ text: 'a', source: 'en', target: 'zh', engine: 'nano', tone: 'casual' });
  await translate({ text: 'b', source: 'en', target: 'zh', engine: 'nano', tone: 'casual' });
  assert.equal(capture.length, 1, '相同配置只创建一个会话');
  await translate({ text: 'c', source: 'en', target: 'zh', engine: 'nano', tone: 'formal' });
  assert.equal(capture.length, 2, '换语气要新建会话');
});

test('Nano 探测：无参 availability() 抛错时改用模态声明 / capabilities() 兑底，不误报 unavailable', async () => {
  resetGlobals();
  // 情况 ①：无参查询直接抛错，但带模态声明的查询说 downloadable
  globalThis.LanguageModel = {
    async availability(options) {
      if (options === undefined) throw new Error('expectedInputs required');
      return options.expectedInputs ? 'downloadable' : 'unavailable';
    },
  };
  assert.equal((await probe({})).nano, 'downloadable', '无参抛错 → 应用带模态声明的查询结果');

  // 情况 ②：availability 报 unavailable，但老版 capabilities() 说 readily
  globalThis.LanguageModel = {
    async availability() {
      return 'unavailable';
    },
    async capabilities() {
      return { available: 'readily' };
    },
  };
  assert.equal((await probe({})).nano, 'available', 'capabilities() 的乐观结果应胜出');

  // 情况 ③：全部都报 unavailable → 才是真的不可用
  globalThis.LanguageModel = {
    async availability() {
      return 'unavailable';
    },
  };
  assert.equal((await probe({})).nano, 'unavailable');
  resetGlobals();
});

test('ensureNanoModel：模型已就绪时创建一次即确认，并立即释放会话', async () => {
  resetGlobals();
  let created = 0;
  let destroyed = 0;
  const progress = [];
  globalThis.LanguageModel = {
    async availability() {
      return 'available';
    },
    async create(options) {
      created += 1;
      return {
        async prompt(text) {
          return `ok:${text}`;
        },
        destroy() {
          destroyed += 1;
        },
      };
    },
  };
  const res = await ensureNanoModel({ onDownload: (p) => progress.push(p) });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'available');
  assert.equal(created, 1, '已就绪时第一次 create 就应成功');
  assert.equal(destroyed, 1, '确认用的会话应立即释放');
  resetGlobals();
});

test('ensureNanoModel：待下载时监听进度；用户拒绝下载时照实报 need-gesture', async () => {
  resetGlobals();
  const progress = [];
  globalThis.LanguageModel = {
    async availability() {
      return 'downloadable';
    },
    async create({ monitor }) {
      if (monitor) {
        for (let i = 1; i <= 2; i += 1) {
          monitor({ addEventListener: (type, cb) => type === 'downloadprogress' && cb({ loaded: i, total: 2 }) });
        }
      }
      return {
        async prompt() {
          return 'ok';
        },
        destroy() {},
      };
    },
  };
  const res = await ensureNanoModel({ onDownload: (p) => progress.push(p) });
  assert.equal(res.ok, true);
  assert.deepEqual(progress, [0.5, 1], '应收到 0~1 的下载进度');

  // 用户拒绝下载（NotAllowedError）→ 不重试，直接报需要手势
  globalThis.LanguageModel = {
    async availability() {
      return 'downloadable';
    },
    async create() {
      throw Object.assign(new Error('user rejected'), { name: 'NotAllowedError' });
    },
  };
  await assert.rejects(() => ensureNanoModel({}), (err) => err.code === 'need-gesture');
  resetGlobals();
});

test('ensureNanoModel：没有 Prompt API 时给 no-nano 错误（文案含排障指引）', async () => {
  resetGlobals();
  await assert.rejects(() => ensureNanoModel({}), (err) => err.code === 'no-nano' && /components/.test(err.message));
  resetGlobals();
});

test('checkNanoHardware：CPU/内存/配额都达标时不给出否定结论', async () => {
  await withNavigatorStub(
    { hardwareConcurrency: 8, deviceMemory: 16, storage: { estimate: async () => ({ quota: 30 * 1024 ** 3, usage: 5 * 1024 ** 3 }) } },
    async () => {
      const hw = await checkNanoHardware();
      assert.equal(hw.cores, 8);
      assert.equal(hw.memoryGB, 16);
      assert.ok(Math.abs(hw.quotaGB - 30) < 0.01);
      assert.equal(hw.cpuMemOk, true);
      assert.equal(hw.quotaLikelyOk, true);
      assert.deepEqual(hw.reasons, []);
    },
  );
});

test('checkNanoHardware：CPU/内存不达标 → 给出具体原因', async () => {
  await withNavigatorStub({ hardwareConcurrency: 2, deviceMemory: 8, storage: undefined }, async () => {
    const hw = await checkNanoHardware();
    assert.equal(hw.cpuMemOk, false);
    assert.ok(hw.reasons.some((r) => /CPU\/内存偏低/.test(r)));
  });
});

test('checkNanoHardware：存储配额不足 22GB → 给出具体原因', async () => {
  await withNavigatorStub(
    { hardwareConcurrency: 8, deviceMemory: 16, storage: { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 1 * 1024 ** 3 }) } },
    async () => {
      const hw = await checkNanoHardware();
      assert.equal(hw.quotaLikelyOk, false);
      assert.ok(hw.reasons.some((r) => /存储配额/.test(r)));
    },
  );
});

test('checkNanoHardware：navigator.storage.estimate 缺失或报错时不抛出，只是拿不到读数', async () => {
  await withNavigatorStub(
    { hardwareConcurrency: 8, deviceMemory: 16, storage: { estimate: async () => { throw new Error('denied'); } } },
    async () => {
      const hw = await checkNanoHardware();
      assert.equal(hw.freeGB, null);
      assert.equal(hw.quotaGB, null);
      assert.equal(hw.quotaLikelyOk, null);
    },
  );
});

/* ------------------------------ 批量 / 流式 ------------------------------ */

test('translateMany 去重并返回结果映射', async () => {
  resetGlobals();
  await clearCache();
  const { calls } = installFakeTranslator();
  const res = await translateMany(['Hello', 'Hello', 'World', '', 'World!'], {
    source: 'en',
    target: 'fr',
    concurrency: 2,
  });
  assert.equal(res.stats.total, 3);
  assert.equal(res.map.get('Hello'), '«HELLO»');
  assert.equal(res.map.get('World!'), '«WORLD!»');
  assert.equal(calls.length, 3);
});

test('translateMany 单条失败不影响其他条目', async () => {
  resetGlobals();
  await clearCache();
  globalThis.Translator = {
    async availability() {
      return 'available';
    },
    async create() {
      return {
        async translate(text) {
          if (text.includes('boom')) throw new Error('inference failed');
          return `ok:${text}`;
        },
      };
    },
  };
  const res = await translateMany(['fine', 'boom here', 'also fine'], { source: 'en', target: 'de' });
  assert.equal(res.stats.failed, 1);
  assert.equal(res.map.get('also fine'), 'ok:also fine');
  assert.equal(res.map.get('boom here'), null);
});

test('translateStream 输出是累加的（两种流式语义都兼容）', async () => {
  resetGlobals();
  installFakeTranslator();
  const parts = [];
  for await (const acc of translateStream({ text: 'abcdefgh', source: 'en', target: 'fr' })) parts.push(acc);
  assert.ok(parts.length >= 2);
  assert.equal(parts[parts.length - 1], '«ABCDEFGH»');
  for (let i = 1; i < parts.length; i += 1) assert.ok(parts[i].startsWith(parts[i - 1]) || parts[i].length > parts[i - 1].length);

  // 增量式语义
  assert.equal(__internals.accumulate('ab', 'c'), 'abc');
  assert.equal(__internals.accumulate('ab', 'abc'), 'abc');
});

/* ------------------------------ 语言检测 / 错误 ------------------------------ */

test('detectLanguage 在无 API 时回退到启发式', async () => {
  resetGlobals();
  const res = await detectLanguage('これはテストです。日本語の文章。');
  assert.equal(res.language, 'ja');
  assert.equal(res.via, 'heuristic');
});

test('humanizeError 给出中文可读提示', () => {
  assert.match(humanizeError({ code: 'need-gesture' }), /点击/);
  assert.match(humanizeError({ code: 'unsupported-pair' }), /不支持/);
  assert.match(humanizeError(Object.assign(new Error('x'), { name: 'AbortError' })), /取消/);
  assert.match(humanizeError(new Error('weird')), /weird/);
});

test('AbortSignal 能中断长文本翻译', async () => {
  resetGlobals();
  installFakeTranslator();
  const controller = new AbortController();
  const text = 'This is a sentence. '.repeat(400);
  const p = translate({ text, source: 'en', target: 'de', maxChars: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (err) => err.code === 'aborted' || err.name === 'AbortError');
});

/* ------------------------------ 内容脚本工具（在 vm 里加载） ------------------------------ */

/** content/util.js 是 IIFE + 全局命名空间，这里用 vm 加载后取出暴露的工具 */
function loadContentUtil() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'util.js');
  const sandbox = { navigator: {}, window: {}, document: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: 'content/util.js' });
  return sandbox.__LOCAL_TRANSLATE__.util;
}

const CU = loadContentUtil();

test('内容脚本工具：语言代码归一化与名称', () => {
  assert.equal(CU.normalizeCode('zh-CN'), 'zh');
  assert.equal(CU.normalizeCode('zh-TW'), 'zh-Hant');
  assert.equal(CU.langLabel('ja'), '日语');
  assert.equal(CU.isRtl('ar'), true);
});

test('clampToViewport：拖动气泡时的视口钳制', () => {
  // 注意：跨 vm 领域返回的对象原型不同，这里展开放进当前领域再比较
  const box = (left, top, width = 300, height = 120) => ({
    ...CU.clampToViewport({ left, top, width, height, viewportWidth: 1000, viewportHeight: 800, margin: 8 }),
  });

  // 正常范围内不动
  assert.deepEqual(box(100, 100), { left: 100, top: 100 });
  // 拖出左上角 → 贴边
  assert.deepEqual(box(-50, -80), { left: 8, top: 8 });
  // 拖出右下角 → 保留 margin
  assert.deepEqual(box(5000, 5000), { left: 1000 - 300 - 8, top: 800 - 120 - 8 });
  // 小数会被取整
  assert.deepEqual(box(10.6, 20.4), { left: 11, top: 20 });
  // 气泡比视口还大（极端情况）→ 仍回到左上角 margin，不会变成负数
  const huge = {
    ...CU.clampToViewport({
    left: 500,
    top: 500,
    width: 1200,
    height: 900,
    viewportWidth: 1000,
    viewportHeight: 800,
      margin: 8,
    }),
  };
  assert.deepEqual(huge, { left: 8, top: 8 });
  // 非法输入（恢复上次保存的位置时可能遇到）
  assert.deepEqual(box(NaN, undefined), { left: 8, top: 8 });
});

test('内容脚本工具：文本过滤与站点匹配', () => {
  assert.equal(CU.looksTranslatable('A normal sentence.'), true);
  assert.equal(CU.looksTranslatable('https://x.com'), false);
  assert.equal(CU.matchSite('docs.example.com', ['example.com']), true);
  assert.equal(CU.matchSite('notexample.com', ['example.com']), false);
  assert.equal(CU.matchSite('a.b.example.com', ['https://example.com/foo']), true);
});

/* ------------------------------ 多 frame 路由（弹窗在 iframe 里的关键） ------------------------------ */

test('多 frame：顶层 frame「以为自己有焦点」时，也不能压过真正有输入框的子 frame', () => {
  // 这是「弹窗输入框捕获不到」的核心：tabs.sendMessage 只兑现第一个应答，
  // 而顶层 frame 会因为 hasFocus 为 true 抢答「没有输入框」。评分必须让子 frame 赢。
  const top = { frameId: 0, res: { ok: false, handled: false, info: { hasFocus: true, isTop: true, hasTarget: false, chars: 0 } } };
  const child = {
    frameId: 7,
    res: { ok: true, handled: true, kind: 'dom', info: { hasFocus: true, isTop: false, hasTarget: true, chars: 12, lastActivity: Date.now() } },
  };
  const best = pickBestResponse([top, child]);
  assert.equal(best.frameId, 7);
});

test('多 frame：封闭 Shadow DOM 的子 frame 同样胜出，且读到字符数计入评分', () => {
  const child = {
    frameId: 3,
    res: { ok: true, handled: true, kind: 'agent', info: { hasFocus: false, hasTarget: true, chars: 8 } },
  };
  const empty = { frameId: 5, res: { ok: false, handled: false, info: { hasFocus: true, hasTarget: false, chars: 0 } } };
  assert.equal(pickBestResponse([empty, child]).frameId, 3);
  assert.ok(scoreResponse(child) > scoreResponse(empty));
});

test('多 frame：都没干活时也能拿到最好的那个（用来给用户报错）', () => {
  const a = { frameId: 0, res: { ok: false, handled: false, info: { hasFocus: true, hasTarget: false } } };
  const b = { frameId: 4, res: { ok: false, handled: false, info: { hasFocus: false, hasTarget: false } } };
  const best = pickBestResponse([a, b]);
  assert.equal(best.frameId, 0); // 有焦点的那层更可能是用户所在的位置
  assert.equal(pickBestResponse([]), null);
  assert.equal(pickBestResponse([null, undefined, { frameId: 1, res: null }]), null);
});

test('多 frame：认领（claim）的有效期判定', () => {
  const now = 1_000_000;
  assert.equal(isClaimUsable({ frameId: 2, at: now - 1000 }, now), true);
  assert.equal(isClaimUsable({ frameId: 2, at: now - CLAIM_TTL - 1 }, now), false);
  assert.equal(isClaimUsable({ frameId: 2, at: now + 60_000 }, now), false); // 时钟跳变 → 别信
  assert.equal(isClaimUsable(null, now), false);
  assert.equal(isClaimUsable({ at: now }, now), false); // 没有 frameId
});

test('多 frame：自检汇总能区分「顶层/iframe」「普通元素/封闭影子根」「读到几个字」', () => {
  const rows = summarizeFrames([
    { frameId: 0, res: { ok: true, info: { isTop: true, hasFocus: true, hasTarget: true, kind: 'dom', tag: 'textarea', chars: 21, url: 'https://a.example/' } } },
    { frameId: 4, res: { ok: true, info: { isTop: false, hasFocus: false, hasTarget: true, kind: 'agent', tag: 'div(shadow)', chars: 7, url: 'https://widget.example/' } } },
    { frameId: 9, res: null },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].top, true);
  assert.equal(rows[1].kind, 'agent');
  assert.equal(rows[1].chars, 7);
  assert.equal(rows[1].tag, 'div(shadow)');
});

/* -------------------- 会话生命周期（转写第二次报错的根因） -------------------- */

test('回归：abort 上一次请求的 controller 不能弄死「已缓存的翻译器」（第二次转写必须正常）', async () => {
  resetGlobals();
  const state = installSpecFakeTranslator();
  const { translateStream } = await import('../lib/engine.js');

  // 第 1 次请求（后台会为它建一个 controller）
  const c1 = new AbortController();
  const first = [];
  for await (const acc of translateStream({ text: 'Hello', source: 'en', target: 'zh', signal: c1.signal })) {
    first.push(acc);
  }
  assert.ok(first.length, '第一次应该有流式输出');
  assert.equal(state.created, 1);

  // 后台在收到新请求时会 abort 上一个 controller —— 老代码会把缓存的实例一起弄死
  c1.abort();

  // 第 2 次请求：必须仍然可用，而且**不该**重建实例（缓存有效）
  const c2 = new AbortController();
  const second = [];
  for await (const acc of translateStream({ text: 'World', source: 'en', target: 'zh', signal: c2.signal })) {
    second.push(acc);
  }
  assert.ok(second.length, '第二次也必须有流式输出（这就是原来的 bug）');
  assert.ok(String(second[second.length - 1]).includes('WORLD'), '第二次拿到的应当是自己的译文');
  assert.equal(state.created, 1, '会话作用域与请求解耦后，不该每次都重建翻译器');
  assert.equal(state.destroyed, 0, '请求结束不应该销毁会话');
  resetGlobals();
});

test('自愈：池里的实例被销毁后，下一次调用会自动重建并重试（不用重启扩展）', async () => {
  resetGlobals();
  const state = installSpecFakeTranslator();
  const { translate, __internals } = await import('../lib/engine.js');

  const first = await translate({ text: 'Hello', source: 'en', target: 'zh' });
  assert.ok(first.text);

  // 模拟「实例被外部弄死了」（任何未知原因：模型被卸载、被别的代码 destroy…）
  const entry = __internals.translatorPool.get('en>zh');
  const instance = await entry.promise;
  instance.destroy();

  const second = await translate({ text: 'World', source: 'en', target: 'zh' });
  assert.ok(second.text, '坏实例应该被摘掉并重建，而不是一直报错');
  assert.equal(state.created, 2, '应当重建了一次');
  resetGlobals();
});

test('用户主动取消不等于「会话坏了」：不重试、照实报 aborted', async () => {
  resetGlobals();
  installFakeTranslator();
  const { translate } = await import('../lib/engine.js');
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    () => translate({ text: 'Hello', source: 'en', target: 'zh', signal: ctrl.signal, useCache: false }),
    (err) => err && err.code === 'aborted',
  );
  resetGlobals();
});

test('Nano：会话创建不再绑定请求 signal，请求结束不会把会话弄没', async () => {
  resetGlobals();
  const capture = installFakeNano();
  const { translate, __internals } = await import('../lib/engine.js');

  const c1 = new AbortController();
  const r1 = await translate({ text: 'Hello', source: 'en', target: 'zh', engine: 'nano', signal: c1.signal, useCache: false });
  assert.ok(r1.text);
  c1.abort(); // 后台会做的事

  const r2 = await translate({ text: 'World', source: 'en', target: 'zh', engine: 'nano', useCache: false });
  assert.ok(r2.text, '第二次也必须成功');
  assert.equal(__internals.nanoSessions.size, 1, '会话应当还在缓存里，不该被请求的 abort 清掉');
  assert.ok(
    capture.every((opts) => opts.signal === undefined),
    'create() 不该再收到请求的 signal（兑现后被 abort 就等于 destroy）',
  );
  resetGlobals();
});

/* ---------------- 扩展上下文失效（Extension context invalidated） ---------------- */

test('上下文检测：认识「Extension context invalidated.」及其同类错误', () => {
  assert.equal(CU.isContextInvalidated(new Error('Extension context invalidated.')), true);
  assert.equal(CU.isContextInvalidated({ message: 'Extension context invalidated.' }), true);
  assert.equal(
    CU.isContextInvalidated(new Error('Could not establish connection. Receiving end does not exist.')),
    true,
  );
  assert.equal(CU.isContextInvalidated(new Error('The message port closed before a response was received.')), true);

  // 别把普通错误误判成「扩展失效」
  assert.equal(CU.isContextInvalidated(new Error('NotAllowedError: user gesture required')), false);
  assert.equal(CU.isContextInvalidated(null), false);
  assert.equal(CU.isContextInvalidated(new Error('quota exceeded')), false);
});

test('上下文检测：给用户的说明必须是中文、且包含「刷新」这个动作', () => {
  const text = CU.staleText();
  assert.equal(typeof text, 'string');
  assert.match(text, /刷新/);
  assert.equal(/[A-Za-z]{6,}/.test(text.replace(/chrome:\/\/extensions/g, '')), false, '不要夹英文报错原文');
});

/* ------------------------------ 运行 ------------------------------ */

let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
  }
}
resetGlobals();
console.log(`\n${passed}/${tests.length} 通过${failures.length ? `，${failures.length} 失败` : ''}`);
if (failures.length) process.exitCode = 1;
