/**
 * engine.js —— 本地翻译内核（Chrome 内置 AI）
 *
 * 两条本地链路：
 *   1) Chromium/Translator  ：Chrome 138+ 内置翻译模型，按「语言对」下载，快、稳、质量好，
 *                            专门用于翻译（这也是那些 GB 级语言包的去处）。
 *   2) Gemini Nano          ：Prompt API（扩展里 Chrome 138+ 可用）驱动的基础模型，
 *                            适合带术语表 / 语气 / 上下文 / 解释的“可控翻译”。
 *
 * 本文件不依赖任何 DOM，可同时运行于：
 *   - MV3 Service Worker（module）
 *   - 扩展页面（popup / side panel / options）
 *   - Node（单元测试）
 */

import {
  isCJKHeavy,
  needsSpace,
  normalizeCode,
  detectByHeuristic,
  isReliableDetection,
} from './languages.js';

export const ENGINES = {
  AUTO: 'auto',
  TRANSLATOR: 'translator',
  NANO: 'nano',
};

export const TONES = [
  { value: 'default', zh: '忠实原文', en: 'Faithful', hint: '准确、中立，贴近原文结构' },
  { value: 'natural', zh: '自然地道', en: 'Natural', hint: '符合目标语言母语者表达习惯' },
  { value: 'formal', zh: '正式书面', en: 'Formal', hint: '商务 / 公文 / 邮件' },
  { value: 'casual', zh: '口语轻松', en: 'Casual', hint: '聊天、字幕、社媒' },
  { value: 'technical', zh: '技术文档', en: 'Technical', hint: '保留术语原词，首次出现可加括号' },
  { value: 'academic', zh: '学术严谨', en: 'Academic', hint: '论文、报告，术语规范' },
];

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export const HUMAN_ERRORS = {
  'no-api': '当前环境没有 Translator API（需要 Chrome 138+ 桌面版；移动端暂不支持）。',
  'no-nano':
    '当前环境没有 Gemini Nano（Prompt API 不可用）。常见原因：① 模型未下载 —— chrome://components 里的 "Optimization Guide On Device Model" 需要存在且已更新；② 硬件不满足（需 >4GB 显存，或 16GB 内存 + 4 核以上）；③ Chrome 版本过旧。若硬件/版本没问题，可在侧边栏点「让 Chrome 下载 Gemini Nano」触发下载。',
  'need-gesture': '首次使用需要下载语言包 / 模型，请点击按钮确认下载。',
  'unsupported-pair': 'Chrome 内置模型不支持这个语言对。',
  'pair-create-failed':
    'Chrome 拒绝为该语言对创建翻译实例：availability() 报告可用，但 create() 返回 NotSupportedError。常见原因是 create() 不在「有用户手势的文档」里执行（例如在扩展后台/Worker 中调用），或 Chrome TranslateKit 语言包未启用该语言对。',
  'same-language': '原文与目标语言相同，无需翻译。',
  quota: '文本超出模型输入配额，分段后仍然失败。',
  aborted: '已取消。',
  'download-failed': '模型下载失败，请检查网络（需要非计费连接），或稍后重试。',
  busy: '模型正忙，请稍后重试。',
  empty: '没有可翻译的内容。',
  unknown: '翻译失败。',
};

export class AIError extends Error {
  constructor(code, detail) {
    super(HUMAN_ERRORS[code] || code);
    this.name = 'AIError';
    this.code = code;
    this.detail = detail;
  }
}

const aiError = (code, detail) => new AIError(code, detail);

export function humanizeError(err) {
  if (!err) return HUMAN_ERRORS.unknown;
  const code = err.code || mapErrorName(err);
  const known = HUMAN_ERRORS[code];
  const base =
    !err.code && code === 'unknown' && err.message ? `翻译失败：${err.message}` : known || err.message || String(err);
  const detail = err.detail ? `（${String(err.detail).slice(0, 200)}）` : '';
  return base + detail;
}

function mapErrorName(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError') return 'need-gesture';
  if (n === 'AbortError') return 'aborted';
  if (n === 'NotSupportedError') return 'unsupported-pair';
  if (n === 'QuotaExceededError') return 'quota';
  return 'unknown';
}

function toAIError(err, fallbackCode) {
  if (err instanceof AIError) return err;
  const out = new AIError(mapErrorName(err) || fallbackCode, err && err.message);
  // 保留原始异常名：AIError 会把 name 变成 'AIError'，
  // 而调用方需要靠 'AbortError' 判断「这个会话是不是已经死了」（见 isDeadSessionError）
  try {
    out.originalName = err && err.name;
    out.cause = err;
  } catch (e) {
    /* 忽略 */
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 能力探测                                                            */
/* ------------------------------------------------------------------ */

const nanoCtor = () =>
  globalThis.LanguageModel ||
  (globalThis.ai && (globalThis.ai.languageModel || globalThis.ai.assistant)) ||
  null;

export function apiSupport() {
  return {
    translator: typeof globalThis.Translator !== 'undefined' && typeof globalThis.Translator.create === 'function',
    detector: typeof globalThis.LanguageDetector !== 'undefined',
    nano: !!nanoCtor(),
    offlineCapable: true,
  };
}

async function translatorAvailability(source, target) {
  const T = globalThis.Translator;
  if (!T || typeof T.availability !== 'function') return 'unsupported';
  try {
    return await T.availability({ sourceLanguage: source, targetLanguage: target });
  } catch (err) {
    return 'unavailable';
  }
}

async function nanoAvailability() {
  const LM = nanoCtor();
  if (!LM) return 'unsupported';
  // 规范要求：availability() 必须与 create()/prompt() 传同样的选项（有些模态/语言组合会改变结果）。
  // 我们的会话以纯文本为主（系统提示词英文、输出文本），所以先用无参查询；
  // 部分版本对无参查询会刻意报 unavailable，个别版本甚至直接抛错 —— 这都代表「模型还没就绪」，
  // 不代表硬件不支持。所以按顺序多问几次：
  //   ① 无参 availability() → ② 与 create() 一致的模态声明再问 → ③ 老版 capabilities() 兜底。
  // 任何一步给出乐观结果就采用（后续 create() 真不行还有分层重试与宿主切换兜着）。
  const expected = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };
  const readCapabilities = async () => {
    if (typeof LM.capabilities !== 'function') return null;
    try {
      const c = await LM.capabilities();
      if (c && c.available === 'readily') return 'available';
      if (c && c.available === 'after-download') return 'downloadable';
    } catch (err) {
      /* 忽略 */
    }
    return null;
  };
  try {
    if (typeof LM.availability === 'function') {
      let first = null;
      try {
        first = await LM.availability();
      } catch (err) {
        first = null; // 无参查询抛错 ≠ 不可用，继续往下问
      }
      if (first && first !== 'unavailable') return first;
      try {
        const second = await LM.availability(expected);
        if (second && second !== 'unavailable') return second;
      } catch (err) {
        /* 落到 capabilities 兜底 */
      }
      const caps = await readCapabilities();
      if (caps) return caps;
      return first || 'unavailable';
    }
    const caps = await readCapabilities();
    return caps || 'available'; // 老版本没有 availability()，直接试
  } catch (err) {
    return 'unavailable';
  }
}

/** LanguageDetector → 启发式兜底 */
export async function detectLanguage(text, { allowDownload = false } = {}) {
  const s = String(text || '').slice(0, 2000);
  const D = globalThis.LanguageDetector;
  if (D && typeof D.create === 'function') {
    try {
      const avail = typeof D.availability === 'function' ? await D.availability() : 'available';
      if (avail === 'available' || (avail !== 'unavailable' && allowDownload)) {
        const detector = await D.create();
        const results = await detector.detect(s);
        if (results && results[0] && isReliableDetection(s, { confidence: results[0].confidence })) {
          const language = normalizeCode(results[0].detectedLanguage);
          if (language) return { language, confidence: results[0].confidence, via: 'api' };
        }
      }
    } catch (err) {
      /* 落回启发式 */
    }
  }
  const guess = detectByHeuristic(s);
  return { language: normalizeCode(guess.language), confidence: guess.confidence, via: 'heuristic' };
}

async function resolveSource(text, source) {
  if (source && source !== 'auto') return normalizeCode(source);
  const { language } = await detectLanguage(text);
  return normalizeCode(language || 'en');
}

/**
 * 综合状态：给 UI 显示“能不能用 / 要不要下载”
 */
export async function probe({ engine = ENGINES.AUTO, source = 'auto', target = 'zh' } = {}) {
  const support = apiSupport();
  const out = { support, translator: null, nano: null };
  if (support.translator) {
    const src = source === 'auto' ? 'en' : normalizeCode(source);
    out.translator = await translatorAvailability(src, normalizeCode(target));
  }
  if (support.nano) out.nano = await nanoAvailability();
  return out;
}

/**
 * 自检：分别报告「能力查询」和「真正创建实例」的结果。
 *
 * 这两个结果经常会不一致：availability() 是静态能力查询（Chrome 还会刻意模糊语言包状态），
 * 而 create() 需要满足「有用户手势的文档上下文」等运行时条件。
 * 所以排障时必须分环境（扩展页面 / 后台 / 离屏文档）各跑一次这个自检。
 */
export async function selftest({ source = 'en', target = 'zh', destroy = true } = {}) {
  const src = normalizeCode(source);
  const tgt = normalizeCode(target);
  const out = { pair: `${src} → ${tgt}`, json: null };

  const support = apiSupport();
  out.support = support;

  if (support.translator) {
    out.availability = await translatorAvailability(src, tgt).catch(() => 'error');
    try {
      const T = globalThis.Translator;
      const translator = await T.create({ sourceLanguage: src, targetLanguage: tgt });
      out.create = 'ok';
      out.sample = await translator.translate('Hello, world.').catch((err) => `translate 失败：${err.name}`);
      out.inputQuota = translator.inputQuota;
      if (destroy && typeof translator.destroy === 'function') {
        try {
          translator.destroy();
        } catch (err) {
          /* 忽略 */
        }
      }
    } catch (err) {
      out.create = 'failed';
      out.createError = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
    }
  } else {
    out.availability = 'no-api';
    out.create = 'no-api';
  }

  if (support.nano) {
    out.nanoAvailability = await nanoAvailability();
    try {
      const LM = nanoCtor();
      const session = await LM.create();
      out.nanoCreate = 'ok';
      try {
        session.destroy();
      } catch (err) {
        /* 忽略 */
      }
    } catch (err) {
      out.nanoCreate = 'failed';
      out.nanoCreateError = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
    }
  } else {
    out.nanoCreate = 'no-api';
  }

  out.json = JSON.stringify(out, null, 2);
  return out;
}

/* ------------------------------------------------------------------ */
/* 文本分段                                                            */
/* ------------------------------------------------------------------ */

const SENT_RE = /[^.!?。！？；;\n]+[.!?。！？；;]*[”"’'）)\]]*\s*/g;

function splitSentences(text) {
  const m = text.match(SENT_RE);
  return m && m.length ? m : [text];
}

function hardSplit(s, max) {
  const parts = [];
  for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
  return parts;
}

/**
 * 按「段落 → 句子 → 硬切」三级切分，返回 [{ text, para }]
 * para=true 表示这是段落的最后一块（拼接译文时用换行而不是空格）
 */
export function chunkText(input, maxChars) {
  const text = String(input == null ? '' : input);
  const cjk = isCJKHeavy(text);
  const max = Math.max(60, maxChars || (cjk ? 480 : 1100));
  if (text.length <= max) return [{ text, para: true }];

  const chunks = [];
  const join = (a, b) => (a && needsSpace(a, b) ? `${a} ${b}` : a + b);

  // 逐段落处理：段内按「句子 → 硬切」分块，段落的最后一块标记 para=true（拼接时用换行）
  for (const para of text.split(/\n\s*\n+/)) {
    if (!para.trim()) continue;
    const units =
      para.length > max ? splitSentences(para).flatMap((s) => (s.length > max ? hardSplit(s, max) : [s])) : [para];
    let cur = '';
    let lastIndex = -1;
    const push = (piece) => {
      if (!piece.trim()) return;
      chunks.push({ text: piece.trim(), para: false });
      lastIndex = chunks.length - 1;
    };
    for (const unit of units) {
      const piece = unit.trim();
      if (!piece) continue;
      if (cur && cur.length + piece.length + 1 > max) {
        push(cur);
        cur = '';
      }
      cur = cur ? join(cur, piece) : piece;
      if (cur.length >= max) {
        push(cur);
        cur = '';
      }
    }
    if (cur) push(cur);
    if (lastIndex >= 0) chunks[lastIndex].para = true;
  }
  return chunks.length ? chunks : [{ text, para: true }];
}

function joinParts(chunks, parts) {
  let out = '';
  for (let i = 0; i < chunks.length; i += 1) {
    const piece = (parts[i] == null ? '' : String(parts[i])).trim();
    if (!piece) continue;
    if (!out) {
      out = piece;
    } else if (chunks[i - 1].para) {
      out += `\n\n${piece}`;
    } else {
      out = needsSpace(out, piece) ? `${out} ${piece}` : out + piece;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 链路 1：Chromium 内置翻译模型                                        */
/* ------------------------------------------------------------------ */

/**
 * "src>tgt" -> { promise, scope }
 *
 * scope 是这个会话自己的 AbortController：**只有**它才能中止/销毁这个 Translator。
 *
 * 为什么不能把「某一次请求的 signal」传进 create()：按规范（MDN 原文），
 * 「create() 兑现之后再 abort 它的 signal，效果等同于 Translator.destroy()，
 *   之后任何方法调用都会以 AbortError 失败」。
 * 而调用方（后台）在每次新的翻译请求到来时，都会 abort 上一个请求的 controller。
 * 于是：第二次请求一来就把第一次创建的 Translator 弄死了 —— 表现为
 * 「第一次转写正常，第二次开始报错」，而且死实例一直留在池子里，之后次次都错。
 */
const translatorPool = new Map();

export function getTranslatorPoolSize() {
  return translatorPool.size;
}

/**
 * 这个错误是不是「会话已经死了」（被销毁 / 被 abort / 状态非法）？
 * 死了就摘掉池里的实例、重建一个再试一次 —— 用户不该因为一个坏实例就要重启扩展。
 *
 * 注意：AIError 包装后 name 会变成 'AIError'，所以要看 originalName / code / 消息文本。
 * 「用户主动取消」也会是 aborted，那种情况不重试（调用方先检查 signal.aborted）。
 */
function isDeadSessionError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'InvalidStateError') return true;
  if (err.originalName === 'AbortError' || err.originalName === 'InvalidStateError') return true;
  if (err.code === 'aborted') return true; // 请求没被取消却拿到 aborted ⇒ 只能是会话没了
  const msg = String((err && err.message) || '');
  return /destroy|destroyed|abort|closed|no longer|not available/i.test(msg);
}

/** 池里的实例坏了：先摘掉，下次调用会重建 */
function evictTranslator(key) {
  const entry = translatorPool.get(key);
  translatorPool.delete(key);
  try {
    if (entry && entry.scope && !entry.scope.signal.aborted) entry.scope.abort();
  } catch (err) {
    /* 忽略 */
  }
}

/** 主动释放所有原生翻译会话（设置里的「重置引擎」/ 语言对切换时用） */
export function resetTranslators() {
  for (const key of [...translatorPool.keys()]) evictTranslator(key);
}

/** 拿到池里的实例，坏了就重建；run() 抛「会话已死」时自动换新实例重试一次 */
async function withTranslator(key, build, run, { signal } = {}) {
  const attempt = async () => {
    const entry = translatorPool.get(key);
    const translator = entry ? await entry.promise : await build();
    return run(translator);
  };
  try {
    return await attempt();
  } catch (err) {
    // 用户自己取消的：不要偷偷重试，照实上报
    if (signal && signal.aborted) throw err;
    if (!isDeadSessionError(err)) throw err;
    evictTranslator(key);
    return attempt();
  }
}

/**
 * 取得（必要时创建 + 触发语言包下载）一个 Translator 实例
 * onDownload(progress)  progress ∈ [0, 1]
 */
export async function getTranslator(source, target, { onDownload, signal, allowDownload = true } = {}) {
  const T = globalThis.Translator;
  if (!T || typeof T.create !== 'function') throw aiError('no-api');

  const src = normalizeCode(source);
  const tgt = normalizeCode(target);
  if (!src || !tgt) throw aiError('no-api', '缺少语言参数');
  const key = `${src}>${tgt}`;

  if (!allowDownload) {
    const avail = await translatorAvailability(src, tgt);
    if (avail !== 'available') throw aiError(avail === 'unavailable' ? 'unsupported-pair' : 'need-gesture', `状态：${avail}`);
  }

  if (translatorPool.has(key)) return translatorPool.get(key).promise;

  // 会话自己的作用域：与任何一次请求的生命周期无关（见 translatorPool 上方注释）
  let scope = null;
  try {
    scope = new AbortController();
  } catch (err) {
    scope = null; // 极老的环境没有 AbortController
  }

  const promise = (async () => {
    try {
      return await T.create({
        sourceLanguage: src,
        targetLanguage: tgt,
        monitor: onDownload
          ? (m) => {
              m.addEventListener('downloadprogress', (e) => {
                const total = e.total || 1;
                onDownload(Math.min(1, (e.loaded || 0) / total));
              });
            }
          : undefined,
        signal: scope ? scope.signal : undefined,
      });
    } catch (err) {
      // NotSupportedError 出现在 create() 阶段时，往往不是「语言对不存在」，
      // 而是当前上下文不允许创建（没有用户手势 / 没有负责文档 / 该语言对的语言包未启用）。
      // 单独给一个错误码，UI 才能给出针对性指引，而不是笼统说“语言对不支持”。
      if (err && err.name === 'NotSupportedError') {
        throw new AIError('pair-create-failed', err.message);
      }
      throw toAIError(err);
    }
  })();

  translatorPool.set(key, { promise, scope });
  try {
    return await promise;
  } catch (err) {
    translatorPool.delete(key);
    throw err;
  }
}

/** 预热：提前把某个语言包下载好（后台可调用） */
export async function warmup(source, target, { onDownload, signal } = {}) {
  await getTranslator(source, target, { onDownload, signal });
  return true;
}

/**
 * 触发 Gemini Nano 模型本体的下载（语言包之外那个 2~4GB 的基础模型）。
 *
 * 必须在「有用户手势的文档上下文」里调用（侧边栏 / 弹窗按钮的点击事件）。
 * 各版本行为差异很大，所以分层尝试：
 *   ① create() —— 若模型已就绪，直接返回可用；若待下载，会开始下载并监听进度；
 *   ② create() 失败时再试一次 LanguageModel.create({ ...expected })（个别版本对无参创建更严格）；
 *   ③ 全部失败 → 抛出可读错误（调用方把 chrome://components / 硬件要求的指引摆给用户）。
 * 成功创建的会话立即销毁 —— 这里只负责把模型装好，不占用推理会话。
 */
export async function ensureNanoModel({ onDownload, signal } = {}) {
  const LM = nanoCtor();
  if (!LM) throw aiError('no-nano');

  const monitor = onDownload
    ? (m) => {
        try {
          m.addEventListener('downloadprogress', (e) => {
            const total = e.total || 1;
            onDownload(Math.min(1, (e.loaded || 0) / total));
          });
        } catch (err) {
          /* 个别实现的 monitor 事件源不同，忽略 */
        }
      }
    : undefined;

  const expected = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };
  const attempts = [
    monitor ? { monitor, signal } : { signal },
    monitor ? { ...expected, monitor, signal } : { ...expected, signal },
  ];

  let lastErr = null;
  for (const raw of attempts) {
    const opts = {};
    for (const [k, v] of Object.entries(raw)) if (v !== undefined) opts[k] = v;
    let session = null;
    try {
      session = await LM.create(opts);
      // 模型就绪（或刚刚下载完）。会话只用来确认可用，马上释放。
      try {
        if (session && typeof session.destroy === 'function') session.destroy();
      } catch (err) {
        /* 忽略 */
      }
      const status = await nanoAvailability();
      return { ok: true, status: status === 'unsupported' ? 'available' : status };
    } catch (err) {
      lastErr = err;
      // 用户拒绝了下载（NotAllowedError）→ 没有必要再试下一组参数
      if (err && err.name === 'NotAllowedError') throw toAIError(err);
      try {
        if (session && typeof session.destroy === 'function') session.destroy();
      } catch (err2) {
        /* 忽略 */
      }
    }
  }
  throw toAIError(lastErr || aiError('no-nano'));
}

async function translateWithTranslator({ text, source, target, signal, onDownload, onProgress, maxChars }) {
  const src = source === 'auto' ? await resolveSource(text, source) : normalizeCode(source);
  const tgt = normalizeCode(target);
  if (src && tgt && src === tgt) return { text, skipped: true, engine: ENGINES.TRANSLATOR, source: src, target: tgt };

  const key = `${src}>${tgt}`;
  const runOnce = async () => {
    const translator = await getTranslator(src, tgt, { onDownload });

    // 依据输入配额动态决定分段长度（不同版本 inputQuota 单位不同，取保守值）
    let limit = maxChars || (isCJKHeavy(text) ? 480 : 1100);
    try {
      const quota = translator.inputQuota;
      if (typeof quota === 'number' && quota > 0) limit = Math.min(limit, Math.max(120, Math.floor(quota * 0.5)));
    } catch (err) {
      /* 忽略 */
    }

    const chunks = chunkText(text, limit);
    const parts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal && signal.aborted) throw aiError('aborted');
      try {
        parts.push(await translator.translate(chunks[i].text, signal ? { signal } : undefined));
      } catch (err) {
        throw toAIError(err);
      }
      if (onProgress) onProgress((i + 1) / chunks.length);
    }
    return { chunks, parts, limit };
  };

  const { chunks, parts } = await withTranslator(key, () => getTranslator(src, tgt, { onDownload }), runOnce, {
    signal,
  });
  return {
    text: joinParts(chunks, parts),
    skipped: false,
    engine: ENGINES.TRANSLATOR,
    source: src,
    target: tgt,
    chunks: chunks.length,
  };
}

/* ------------------------------------------------------------------ */
/* 链路 2：Gemini Nano（Prompt API）                                    */
/* ------------------------------------------------------------------ */

const nanoSessions = new Map(); // configKey -> Promise<session>

function glossaryLines(glossary) {
  if (!glossary) return [];
  const arr = Array.isArray(glossary) ? glossary : parseGlossary(glossary);
  return arr
    .filter((g) => g && g.from && g.to)
    .slice(0, 60)
    .map((g) => `- ${g.from} → ${g.to}`);
}

/** 解析术语表：支持 "from=to" / "from => to" / "from<TAB>to" / 逗号分隔的多列 */
export function parseGlossary(input) {
  const out = [];
  if (!input) return out;
  const lines = Array.isArray(input) ? input : String(input).split(/\n+/);
  for (const line of lines) {
    const s = String(line).trim();
    if (!s || s.startsWith('#')) continue;
    const m = s.split(/\s*(?:=>|=|→|\t|:|：)\s*/);
    if (m.length >= 2 && m[0] && m[1]) out.push({ from: m[0].trim(), to: m.slice(1).join(' ').trim() });
  }
  return out;
}

function tonePrompt(tone) {
  switch (tone) {
    case 'natural':
      return '译文要符合目标语言母语者的表达习惯，可以调整语序、拆分长句，不要翻译腔。';
    case 'formal':
      return '使用正式、得体的书面语，适合邮件、公文、商务场景。';
    case 'casual':
      return '使用轻松自然的口语表达，适合聊天、字幕、社交媒体。';
    case 'technical':
      return '这是技术内容：专业术语要准确，必要时首次出现时保留英文原词并加括号说明。';
    case 'academic':
      return '这是学术内容：用语严谨规范，术语统一，保持客观语气。';
    default:
      return '忠实、准确地传达原文含义，保持原文的段落结构。';
  }
}

export function buildSystemPrompt({ source, target, targetLabel, tone = 'default', glossary, context } = {}) {
  const lines = [];
  lines.push(`你是一个专业的翻译引擎，只负责把用户给出的文本翻译成${targetLabel || target}。`);
  lines.push('严格遵守以下规则：');
  lines.push('1. 只输出译文本身。不要输出解释、前言、引号、拼音、原文或任何标记。');
  lines.push('2. 完整保留原文的换行、段落、Markdown 标记、列表符号、数字、URL、代码片段与占位符（如 {name}、%s）。');
  lines.push('3. 保持原文的语气与意图；人名、品牌名、代码标识符按惯例处理，不要生造。');
  lines.push(`4. ${tonePrompt(tone)}`);
  lines.push('5. 如果用户给出的文本已经是目标语言，就原样返回；如果它不是一个完整的句子，也照常翻译。');
  const gl = glossaryLines(glossary);
  if (gl.length) {
    lines.push('');
    lines.push('必须严格遵守的术语对照表（左为原文，右为指定译法）：');
    lines.push(...gl);
  }
  if (context) {
    lines.push('');
    lines.push(`翻译背景（仅供理解，不要翻译这段背景本身）：${String(context).slice(0, 600)}`);
  }
  return lines.join('\n');
}

export function buildUserPrompt(text) {
  return text;
}

function nanoConfigKey(cfg) {
  return [
    cfg.source || 'auto',
    cfg.target,
    cfg.system ? fnv1a(cfg.system) : cfg.tone || 'default',
    cfg.temperature == null ? '' : cfg.temperature,
    cfg.system ? '' : (glossaryLines(cfg.glossary) || []).slice(0, 60).map((l) => fnv1a(l)).join(','),
    cfg.system ? '' : (cfg.context || '').slice(0, 120),
    cfg.purpose || 'translate',
  ].join('|');
}

/**
 * 读取当前模型的采样参数限制，并把期望 temperature 夹在合法区间。
 * 返回 null 表示「不要传采样参数」（params() 不可用 / 取值失败 / 取值非法）。
 * 规范：扩展会话必须同时传 temperature 与 topK，或都不传。
 */
async function nanoSamplingParams(wantedTemperature) {
  try {
    const LM = nanoCtor();
    if (!LM || typeof LM.params !== 'function') return null;
    const p = await LM.params();
    if (!p) return null;
    const defT = typeof p.defaultTemperature === 'number' ? p.defaultTemperature : 1;
    const maxT = typeof p.maxTemperature === 'number' ? p.maxTemperature : null;
    const maxK = typeof p.maxTopK === 'number' ? p.maxTopK : null;
    const defK = typeof p.defaultTopK === 'number' ? p.defaultTopK : null;
    if ((maxK != null && !(maxK >= 1)) || defK == null || !(defK >= 1)) return null;
    let t = wantedTemperature == null ? defT : Number(wantedTemperature);
    if (!Number.isFinite(t)) t = defT;
    if (maxT != null && maxT >= 0) t = Math.min(Math.max(t, 0), maxT);
    return { temperature: t, topK: defK };
  } catch (err) {
    return null;
  }
}

export async function getNanoSession(cfg, { onDownload, signal } = {}) {
  const LM = nanoCtor();
  if (!LM) throw aiError('no-nano');
  const key = nanoConfigKey(cfg);
  if (nanoSessions.has(key)) return nanoSessions.get(key);

  const promise = (async () => {
    const monitor = onDownload
      ? (m) => {
          m.addEventListener('downloadprogress', (e) => {
            const total = e.total || 1;
            onDownload(Math.min(1, (e.loaded || 0) / total));
          });
        }
      : undefined;
    const systemPrompt = cfg.system || buildSystemPrompt(cfg);
    // 与 Translator 同样的道理：**不要**把某一次请求的 signal 塞进会话创建。
    // 按规范，创建兑现后再 abort 那个 signal ≈ destroy()；而调用方每次新请求都会
    // abort 上一个 controller —— 于是第二次开始次次失败。会话的生死交给 nanoSessions 池统一管。
    //
    // 采样参数（官方文档 2026-08）：扩展里 temperature 与 topK **必须同时出现或都不出现**，
    // 且不得超过 params().maxTemperature / maxTopK —— 各版本默认值不同，硬编码
    // temperature=0.2 + topK=3 在部分 Chrome 版本上会让 create() 直接失败（NotSupportedError），
    // 表现就是「Gemini Nano 突然不可用」。所以：先查 params()，按它的上下限夹住取值；
    // params() 不存在或取值失败就完全不带采样参数（更保守，也符合规范）。
    const sampling = await nanoSamplingParams(cfg.temperature);
    const base = { initialPrompts: [{ role: 'system', content: systemPrompt }], monitor };
    const attempts = [
      sampling ? { ...base, ...sampling } : base,
      { initialPrompts: [{ role: 'system', content: systemPrompt }], monitor },
      { monitor },
    ];
    let lastErr;
    for (const raw of attempts) {
      const opts = {};
      for (const [k, v] of Object.entries(raw)) if (v !== undefined) opts[k] = v;
      try {
        return await LM.create(opts);
      } catch (err) {
        lastErr = err;
        if (err && err.name === 'NotAllowedError') throw toAIError(err);
      }
    }
    throw toAIError(lastErr);
  })();

  nanoSessions.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    nanoSessions.delete(key);
    throw err;
  }
}

/** 池里的 Nano 会话坏了：摘掉并释放，下次调用会重建 */
function evictNanoSession(key) {
  const promise = nanoSessions.get(key);
  nanoSessions.delete(key);
  if (promise) {
    promise
      .then((s) => {
        try {
          if (s && typeof s.destroy === 'function') s.destroy();
        } catch (err) {
          /* 忽略 */
        }
      })
      .catch(() => {});
  }
}

export function resetNanoSessions() {
  for (const key of [...nanoSessions.keys()]) evictNanoSession(key);
}

export function getNanoSessionCount() {
  return nanoSessions.size;
}

/** Gemini Nano 单次可处理的字符数（保守估计，留出系统提示词空间） */
function nanoChunkChars(text) {
  return isCJKHeavy(text) ? 700 : 1800;
}

function cleanModelOutput(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // 去掉整段被 ``` 包裹的情况
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  // 去掉常见的“译文：/ Translation:”前缀
  s = s.replace(/^(?:译文|翻译|translation|translated text)\s*[:：]\s*/i, '').trim();
  // 去掉整体包裹的引号
  if (/^["“'『「].*["”'』」]$/s.test(s) && s.length > 2) s = s.slice(1, -1).trim();
  return s;
}

async function translateWithNano({
  text,
  source,
  target,
  targetLabel,
  tone,
  glossary,
  context,
  temperature,
  signal,
  onDownload,
  onProgress,
  maxChars,
}) {
  const src = source === 'auto' ? await resolveSource(text, source) : normalizeCode(source);
  const tgt = normalizeCode(target);
  if (src && tgt && src === tgt) return { text, skipped: true, engine: ENGINES.NANO, source: src, target: tgt };

  const cfg = { source: src, target: tgt, targetLabel, tone, glossary, context, temperature };
  const key = nanoConfigKey(cfg);
  const chunks = chunkText(text, maxChars || nanoChunkChars(text));

  const runOnce = async (session) => {
    const parts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal && signal.aborted) throw aiError('aborted');
      const raw = await session.prompt(buildUserPrompt(chunks[i].text), signal ? { signal } : undefined);
      parts.push(cleanModelOutput(raw));
      if (onProgress) onProgress((i + 1) / chunks.length);
    }
    return parts;
  };

  let parts;
  try {
    parts = await runOnce(await getNanoSession(cfg, { onDownload }));
  } catch (err) {
    // 会话被销毁 / 关掉了：重建一次再试（用户主动取消除外）
    if ((signal && signal.aborted) || !isDeadSessionError(err)) throw toAIError(err);
    evictNanoSession(key);
    parts = await runOnce(await getNanoSession(cfg, { onDownload }));
  }
  return {
    text: joinParts(chunks, parts),
    skipped: false,
    engine: ENGINES.NANO,
    source: src,
    target: tgt,
    chunks: chunks.length,
  };
}

/* ------------------------------------------------------------------ */
/* 缓存（内存 + chrome.storage.local 持久化）                            */
/* ------------------------------------------------------------------ */

const CACHE_KEY = 'translationCache';
const CACHE_LIMIT = 1500;
const memCache = new Map();
let cacheLoaded = false;
let flushTimer = null;

const storageArea = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null);

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function cacheKey(text, engine, source, target, extra) {
  return `${engine}|${source}>${target}|${extra || ''}|${fnv1a(text)}`;
}

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const area = storageArea();
  if (!area) return;
  try {
    const got = await area.get(CACHE_KEY);
    const raw = got && got[CACHE_KEY];
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) memCache.set(k, v);
    }
  } catch (err) {
    /* 忽略 */
  }
}

function schedulePersist() {
  const area = storageArea();
  if (!area) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      const obj = {};
      let i = 0;
      // Map 保持插入顺序 → 删除最旧的部分
      const entries = [...memCache.entries()];
      const start = Math.max(0, entries.length - CACHE_LIMIT);
      for (let j = start; j < entries.length; j += 1) {
        const [k, v] = entries[j];
        obj[k] = v;
        i += 1;
      }
      if (i < memCache.size) {
        memCache.clear();
        for (const [k, v] of Object.entries(obj)) memCache.set(k, v);
      }
      await area.set({ [CACHE_KEY]: obj });
    } catch (err) {
      /* 忽略 */
    }
  }, 1500);
}

export async function getCached(text, { engine = ENGINES.AUTO, source = 'auto', target = 'zh', extra = '' } = {}) {
  await ensureCacheLoaded();
  const eng = engine === ENGINES.AUTO ? '*' : engine;
  const key = cacheKey(text, eng, source === 'auto' ? '*' : normalizeCode(source), normalizeCode(target), extra);
  const hit = memCache.get(key);
  if (!hit) return undefined;
  // 命中后移到 Map 末尾（LRU）
  memCache.delete(key);
  memCache.set(key, hit);
  return hit.v;
}

export async function putCache(text, value, { engine = ENGINES.AUTO, source = 'auto', target = 'zh', extra = '' } = {}) {
  await ensureCacheLoaded();
  const eng = engine === ENGINES.AUTO ? '*' : engine;
  const key = cacheKey(text, eng, source === 'auto' ? '*' : normalizeCode(source), normalizeCode(target), extra);
  memCache.set(key, { t: Date.now(), s: text.slice(0, 64), v: value });
  schedulePersist();
}

export async function getCacheSize() {
  await ensureCacheLoaded();
  return memCache.size;
}

export async function clearCache() {
  memCache.clear();
  cacheLoaded = true;
  const area = storageArea();
  if (area) {
    try {
      await area.remove(CACHE_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                          */
/* ------------------------------------------------------------------ */

function cacheExtra(engine, tone, glossary) {
  if (engine !== ENGINES.NANO) return '';
  return fnv1a(`${tone || 'default'}|${JSON.stringify(glossaryLines(glossary))}`);
}

/**
 * 翻译一段文本
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.source='auto']  'auto' 时先做语言检测
 * @param {string} opts.target
 * @param {'auto'|'translator'|'nano'} [opts.engine='auto']
 * @param {string} [opts.tone]
 * @param {string|Array} [opts.glossary]
 * @param {string} [opts.context]
 * @param {AbortSignal} [opts.signal]
 * @param {(p:number)=>void} [opts.onDownload]  0~1 模型下载进度
 * @param {(p:number)=>void} [opts.onProgress]  0~1 分段翻译进度
 * @param {boolean} [opts.useCache=true]
 * @returns {Promise<{text:string, skipped?:boolean, engine:string, source:string, target:string}>}
 */
export async function translate(opts) {
  const {
    text,
    source = 'auto',
    target,
    engine = ENGINES.AUTO,
    tone = 'default',
    glossary,
    context,
    temperature,
    signal,
    onDownload,
    onProgress,
    useCache = true,
    maxChars,
    targetLabel,
  } = opts || {};

  const clean = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!clean.trim()) throw aiError('empty');
  if (!target) throw aiError('unknown', '缺少目标语言');

  const support = apiSupport();
  const requested = engine === ENGINES.AUTO ? null : engine;

  if (requested === ENGINES.TRANSLATOR && !support.translator) throw aiError('no-api');
  if (requested === ENGINES.NANO && !support.nano) throw aiError('no-nano');

  const primary = requested || (support.translator ? ENGINES.TRANSLATOR : ENGINES.NANO);
  if (useCache) {
    const hit = await getCached(clean, { engine: primary, source, target, extra: cacheExtra(primary, tone, glossary) });
    if (hit !== undefined) {
      return { text: hit, engine: primary, source: normalizeCode(source) || 'auto', target: normalizeCode(target), cached: true };
    }
  }

  const runTranslator = () =>
    translateWithTranslator({ text: clean, source, target, signal, onDownload, onProgress, maxChars });

  const runNano = () =>
    translateWithNano({
      text: clean,
      source,
      target,
      targetLabel,
      tone,
      glossary,
      context,
      temperature,
      signal,
      onDownload,
      onProgress,
      maxChars,
    });

  let result;
  if (requested === ENGINES.TRANSLATOR) {
    result = await runTranslator();
  } else if (requested === ENGINES.NANO) {
    result = await runNano();
  } else if (support.translator) {
    try {
      result = await runTranslator();
    } catch (err) {
      const code = (err && err.code) || '';
      const recoverable =
        code === 'unsupported-pair' ||
        code === 'pair-create-failed' ||
        code === 'need-gesture' ||
        (err && err.name === 'NotSupportedError');
      if (!recoverable || !support.nano) throw err;
      const nanoResult = await runNano();
      nanoResult.fallbackFrom = code;
      result = nanoResult;
    }
  } else if (support.nano) {
    result = await runNano();
  } else {
    throw aiError('no-api');
  }

  if (useCache && !result.skipped && result.text) {
    await putCache(clean, result.text, {
      engine: result.engine,
      source: result.source || source,
      target,
      extra: cacheExtra(result.engine, tone, glossary),
    });
  }
  return result;
}

/**
 * 批量翻译（页面翻译用）：限量并发，命中缓存的条目瞬时返回
 * @returns {Promise<{map: Map<string,string|null>, errors: Array, stats: object}>}
 */
export async function translateMany(texts, opts = {}) {
  const { concurrency = 2, onItem } = opts;
  const unique = [];
  const seen = new Set();
  for (const t of texts || []) {
    const s = String(t == null ? '' : t);
    if (!s.trim() || seen.has(s)) continue;
    seen.add(s);
    unique.push(s);
  }
  const map = new Map();
  const errors = [];
  let done = 0;

  const tasks = unique.slice();
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, async () => {
    while (cursor < tasks.length) {
      const idx = cursor;
      cursor += 1;
      const t = tasks[idx];
      if (opts.signal && opts.signal.aborted) break;
      try {
        const res = await translate({ ...opts, text: t, useCache: opts.useCache !== false });
        map.set(t, res.text);
        done += 1;
        if (onItem) onItem(t, res.text, { cached: !!res.cached, done, total: unique.length });
      } catch (err) {
        map.set(t, null);
        errors.push({ text: t, error: err });
        done += 1;
        if (onItem) onItem(t, null, { error: err, done, total: unique.length });
      }
    }
  });
  await Promise.all(workers);

  return { map, errors, stats: { total: unique.length, failed: errors.length } };
}

/**
 * 流式翻译（长文本实时出字）：async generator，yield 累积译文
 */
export async function* translateStream(opts) {
  const { text, source = 'auto', target, engine = ENGINES.AUTO, tone, glossary, context, signal, onDownload } = opts || {};
  const clean = String(text == null ? '' : text);
  if (!clean.trim()) throw aiError('empty');
  const support = apiSupport();
  const useNano = engine === ENGINES.NANO || (engine === ENGINES.AUTO && !support.translator);
  let yieldedNano = false;

  const src = source === 'auto' ? await resolveSource(clean, source) : normalizeCode(source);
  if (src === normalizeCode(target)) {
    yield clean;
    return;
  }

  if (useNano) {
    const cfg = { source: src, target, tone, glossary, context };
    const key = nanoConfigKey(cfg);
    const runNanoStream = async function* runNanoStreamInner() {
      const session = await getNanoSession(cfg, { onDownload });
      const stream = session.promptStreaming(clean, signal ? { signal } : undefined);
      let acc = '';
      for await (const chunk of stream) {
        acc = accumulate(acc, chunk);
        yieldedNano = true;
        yield acc;
      }
    };
    try {
      yield* runNanoStream();
    } catch (err) {
      if (yieldedNano || (signal && signal.aborted) || !isDeadSessionError(err)) throw toAIError(err);
      evictNanoSession(key);
      yield* runNanoStream();
    }
    return;
  }

  const key = `${src}>${normalizeCode(target)}`;
  let yielded = false;
  // 注意：必须是「函数」而不是箭头函数，里面才能 yield
  const runOnce = async function* runOnceInner() {
    const translator = await getTranslator(src, normalizeCode(target), { onDownload });
    const stream = translator.translateStreaming(clean, signal ? { signal } : undefined);
    let acc = '';
    for await (const chunk of stream) {
      acc = accumulate(acc, chunk);
      yielded = true;
      yield acc;
    }
  };
  try {
    yield* runOnce();
  } catch (err) {
    // 已经吐过内容就别重来了（前端把累积文本当整段显示，重来会闪一下）
    if (yielded || (signal && signal.aborted) || !isDeadSessionError(err)) throw toAIError(err);
    evictTranslator(key);
    yield* runOnce();
  }
}

/** 兼容“累积式”和“增量式”两种流式语义 */
function accumulate(acc, chunk) {
  const c = String(chunk == null ? '' : chunk);
  if (!c) return acc;
  if (c.startsWith(acc) && acc) return c;
  return acc + c;
}

/**
 * 「解释一下」功能（仅 Gemini Nano）：释义 + 用法 + 例句
 */
export async function explain(text, { lang = 'zh', signal, onDownload } = {}) {
  const LM = nanoCtor();
  if (!LM) throw aiError('no-nano');
  const { language } = await detectLanguage(String(text).slice(0, 300));
  const system =
    lang === 'zh'
      ? '你是一位耐心、精准的语言学习助手。用户会给你一段其他语言的文本，你要帮用户彻底看懂它。只输出回答正文，不要重复用户给的原文。'
      : 'You are a precise language tutor. The user gives you a text in another language; help them fully understand it. Output only the answer body, do not repeat the source text.';
  const session = await getNanoSession(
    { purpose: 'explain', target: lang, tone: 'default', temperature: 0.4, system },
    { onDownload, signal },
  );
  try {
    const prompt =
      lang === 'zh'
        ? [
            `请用中文解释下面这段${language ? `（识别到的语言：${language}）` : ''}文本：`,
            '1) 一句话概括意思；2) 逐个解释关键词 / 固定搭配（列表）；3) 给出 1 个地道例句并附中文释义；4) 若有歧义、俚语或文化梗，特别说明。',
            '用 Markdown 输出，简洁，总长控制在 250 字以内。',
            '',
            String(text).slice(0, 2000),
          ].join('\n')
        : [
            `Explain the following text${language ? ` (detected language: ${language})` : ''} in English:`,
            '1) one-sentence gist; 2) key words / idioms explained as a list; 3) one natural example sentence with its meaning; 4) call out any ambiguity or slang.',
            'Markdown, concise, under 200 words.',
            '',
            String(text).slice(0, 2000),
          ].join('\n');
    const raw = await session.prompt(prompt, signal ? { signal } : undefined);
    return String(raw || '').trim();
  } catch (err) {
    throw toAIError(err);
  }
}

/** 供测试 / 诊断使用 */
export const __internals = { fnv1a, cleanModelOutput, accumulate, joinParts, mapErrorName, translatorPool, nanoSessions };
