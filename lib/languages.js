/**
 * languages.js —— 语言表 + 代码归一化 + 离线启发式语言识别
 *
 * 说明：
 *  - Chrome 内置翻译模型（Translator API）当前支持的语种见下面列表，实际能力
 *    以 `Translator.availability()` 的返回值为准（不同 Chrome 版本会增减）。
 *  - 本文件同时被 Service Worker、扩展页面（ESM）和 Node 单元测试使用，
 *    因此不依赖任何 chrome.* API。
 */

export const LANGUAGES = [
  { code: 'zh', zh: '中文（简体）', en: 'Chinese (Simplified)', rtl: false },
  { code: 'zh-Hant', zh: '中文（繁體）', en: 'Chinese (Traditional)', rtl: false },
  { code: 'en', zh: '英语', en: 'English', rtl: false },
  { code: 'ja', zh: '日语', en: 'Japanese', rtl: false },
  { code: 'ko', zh: '韩语', en: 'Korean', rtl: false },
  { code: 'fr', zh: '法语', en: 'French', rtl: false },
  { code: 'de', zh: '德语', en: 'German', rtl: false },
  { code: 'es', zh: '西班牙语', en: 'Spanish', rtl: false },
  { code: 'pt', zh: '葡萄牙语', en: 'Portuguese', rtl: false },
  { code: 'it', zh: '意大利语', en: 'Italian', rtl: false },
  { code: 'ru', zh: '俄语', en: 'Russian', rtl: false },
  { code: 'uk', zh: '乌克兰语', en: 'Ukrainian', rtl: false },
  { code: 'nl', zh: '荷兰语', en: 'Dutch', rtl: false },
  { code: 'pl', zh: '波兰语', en: 'Polish', rtl: false },
  { code: 'cs', zh: '捷克语', en: 'Czech', rtl: false },
  { code: 'sk', zh: '斯洛伐克语', en: 'Slovak', rtl: false },
  { code: 'sl', zh: '斯洛文尼亚语', en: 'Slovenian', rtl: false },
  { code: 'hr', zh: '克罗地亚语', en: 'Croatian', rtl: false },
  { code: 'bg', zh: '保加利亚语', en: 'Bulgarian', rtl: false },
  { code: 'ro', zh: '罗马尼亚语', en: 'Romanian', rtl: false },
  { code: 'hu', zh: '匈牙利语', en: 'Hungarian', rtl: false },
  { code: 'el', zh: '希腊语', en: 'Greek', rtl: false },
  { code: 'da', zh: '丹麦语', en: 'Danish', rtl: false },
  { code: 'sv', zh: '瑞典语', en: 'Swedish', rtl: false },
  { code: 'no', zh: '挪威语', en: 'Norwegian', rtl: false },
  { code: 'fi', zh: '芬兰语', en: 'Finnish', rtl: false },
  { code: 'lt', zh: '立陶宛语', en: 'Lithuanian', rtl: false },
  { code: 'tr', zh: '土耳其语', en: 'Turkish', rtl: false },
  { code: 'ar', zh: '阿拉伯语', en: 'Arabic', rtl: true },
  { code: 'he', zh: '希伯来语', en: 'Hebrew', rtl: true },
  { code: 'hi', zh: '印地语', en: 'Hindi', rtl: false },
  { code: 'bn', zh: '孟加拉语', en: 'Bengali', rtl: false },
  { code: 'ta', zh: '泰米尔语', en: 'Tamil', rtl: false },
  { code: 'te', zh: '泰卢固语', en: 'Telugu', rtl: false },
  { code: 'th', zh: '泰语', en: 'Thai', rtl: false },
  { code: 'vi', zh: '越南语', en: 'Vietnamese', rtl: false },
  { code: 'id', zh: '印尼语', en: 'Indonesian', rtl: false },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));

/** 常见 BCP-47 标签 → Chrome 支持的短代码 */
const ALIASES = {
  'zh-cn': 'zh', 'zh-sg': 'zh', 'zh-my': 'zh', 'zh-hans': 'zh', 'zh-hans-cn': 'zh',
  'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-mo': 'zh-Hant', 'zh-hant-tw': 'zh-Hant',
  'iw': 'he', 'nb': 'no', 'nn': 'no', 'no-no': 'no',
  'pt-br': 'pt', 'pt-pt': 'pt', 'en-us': 'en', 'en-gb': 'en', 'en-ca': 'en', 'en-au': 'en',
  'fr-ca': 'fr', 'fr-fr': 'fr', 'es-419': 'es', 'es-mx': 'es', 'es-es': 'es',
  'in': 'id', 'ji': 'yi', 'tl': 'en', 'fil': 'en',
};

/**
 * 把任意语言标签归一化成 Chrome 能接受的代码，例如：
 * zh-CN → zh、zh_TW → zh-Hant、en-US → en、es-419 → es
 */
export function normalizeCode(tag) {
  if (!tag || typeof tag !== 'string') return '';
  const raw = tag.trim().replace(/_/g, '-');
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (BY_CODE.has(lower)) return BY_CODE.get(lower).code;
  if (ALIASES[lower]) return ALIASES[lower];
  // 只取主语言标签再试一次
  const primary = lower.split('-')[0];
  if (BY_CODE.has(primary)) return BY_CODE.get(primary).code;
  if (ALIASES[primary]) return ALIASES[primary];
  // 繁体判定兜底：zh-XX 里出现 tw/hk/mo/hant
  if (primary === 'zh') {
    return /hant|tw|hk|mo/.test(lower) ? 'zh-Hant' : 'zh';
  }
  return primary || raw;
}

/** 人类可读语言名，uiLang 为 'zh' 或 'en' */
export function langLabel(code, uiLang = 'zh') {
  if (!code || code === 'auto') return uiLang === 'zh' ? '自动检测' : 'Auto detect';
  const n = normalizeCode(code);
  const item = BY_CODE.get(String(n).toLowerCase());
  if (item) return uiLang === 'zh' ? item.zh : item.en;
  return n;
}

export function isRtl(code) {
  const item = BY_CODE.get(String(normalizeCode(code)).toLowerCase());
  return !!(item && item.rtl);
}

/** 生成 <select> 用的选项 HTML（不含 selected 逻辑） */
export function languageOptions(uiLang = 'zh') {
  return LANGUAGES.map((l) => ({ value: l.code, label: uiLang === 'zh' ? l.zh : l.en }));
}

/* ------------------------------------------------------------------ */
/* 离线启发式语言识别（LanguageDetector 不可用时的兜底，也可用于快速跳过） */
/* ------------------------------------------------------------------ */

const SCRIPTS = [
  ['ja', /[\u3040-\u30ff]/],                       // 有假名 → 日语
  ['ko', /[\uac00-\ud7af\u1100-\u11ff]/],          // 谚文
  ['zh', /[\u3400-\u4dbf\u4e00-\u9fff]/],          // 汉字
  ['ru', /[\u0400-\u04ff]/],                       // 西里尔
  ['ar', /[\u0600-\u06ff]/],
  ['he', /[\u0590-\u05ff]/],
  ['th', /[\u0e00-\u0e7f]/],
  ['hi', /[\u0900-\u097f]/],
  ['bn', /[\u0980-\u09ff]/],
  ['ta', /[\u0b80-\u0bff]/],
  ['te', /[\u0c00-\u0c7f]/],
  ['el', /[\u0370-\u03ff]/],
];

const UK_MARKERS = /[іїєґ]/i;
const ZH_HANT_MARKERS = /[們這說時體國學語為妳裡麼與後發東當經開關兩義權]|[\uf900-\ufaff]/;

// 拉丁字母语言的高频功能词（用于粗排）
const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'in', 'it', 'for', 'you', 'with', 'this', 'are', 'be', 'on'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'que', 'qui', 'pour', 'dans', 'pas', 'vous', 'nous', 'avec', 'sur'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'auf', 'für', 'sich', 'auch', 'wie', 'aber'],
  es: ['el', 'la', 'los', 'las', 'que', 'de', 'en', 'un', 'una', 'para', 'con', 'por', 'como', 'pero', 'más'],
  it: ['il', 'lo', 'la', 'che', 'di', 'un', 'una', 'per', 'con', 'non', 'come', 'più', 'sono', 'della', 'gli'],
  pt: ['o', 'a', 'os', 'as', 'que', 'de', 'um', 'uma', 'para', 'com', 'não', 'como', 'mais', 'por', 'dos'],
  nl: ['de', 'het', 'een', 'van', 'en', 'dat', 'niet', 'met', 'voor', 'zijn', 'aan', 'ook', 'maar', 'als', 'om'],
  pl: ['nie', 'jest', 'się', 'oraz', 'dla', 'jak', 'ale', 'przez', 'może', 'tylko', 'jestem', 'tego', 'które', 'albo'],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'olarak', 'daha', 'çok', 'değil', 'ama', 'gibi', 'kadar', 'olarak'],
  vi: ['của', 'và', 'là', 'có', 'được', 'không', 'người', 'những', 'trong', 'cho', 'một', 'này', 'với'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'untuk', 'dengan', 'tidak', 'dari', 'pada', 'adalah', 'akan', 'bisa'],
  da: ['ikke', 'og', 'det', 'en', 'til', 'med', 'kan', 'som', 'der', 'den', 'har', 'jeg'],
  sv: ['och', 'att', 'det', 'som', 'för', 'med', 'inte', 'har', 'den', 'är', 'jag', 'till'],
  no: ['og', 'ikke', 'det', 'som', 'til', 'med', 'har', 'jeg', 'den', 'for', 'på', 'er'],
  fi: ['ja', 'on', 'ei', 'että', 'se', 'kun', 'myös', 'voi', 'joka', 'kuin', 'hän'],
};

const NON_LATIN = /[\u0400-\u04ff\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u0900-\u097f\u0b80-\u0c7f\u0370-\u03ff\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/;
const HAS_LETTER = /[\p{L}]/u;

/**
 * 纯启发式识别，返回 { language, confidence }
 * 只做“够用”的粗判：脚本 → 语言；拉丁字母 → 功能词打分
 */
export function detectByHeuristic(text) {
  const s = String(text || '').slice(0, 1200);
  if (!s.trim()) return { language: 'en', confidence: 0.1 };

  let best = null;
  for (const [lang, re] of SCRIPTS) {
    const hits = (s.match(new RegExp(re.source, 'g')) || []).length;
    if (!hits) continue;
    if (!best || hits > best.hits) best = { lang, hits };
  }
  if (best) {
    const ratio = best.hits / s.length;
    let lang = best.lang;
    if (lang === 'zh') {
      if (ZH_HANT_MARKERS.test(s)) lang = 'zh-Hant';
    }
    if (lang === 'ru' && UK_MARKERS.test(s)) lang = 'uk';
    return { language: lang, confidence: Math.min(0.95, 0.5 + ratio) };
  }

  if (!HAS_LETTER.test(s)) return { language: 'en', confidence: 0.1 };

  // 拉丁字母：功能词打分
  const words = s.toLowerCase().match(/[a-zà-öø-ÿ']+/g) || [];
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  let top = { lang: 'en', score: 0 };
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const w of list) if (counts.has(w)) score += counts.get(w);
    score = score / Math.max(12, words.length) ;
    if (score > top.score) top = { lang, score };
  }
  const confidence = Math.min(0.85, 0.3 + top.score * 2);
  return { language: top.lang, confidence };
}

/** 只要一段文本的识别结果里含非拉丁字符，就基本可以确定语言 */
export function isReliableDetection(text, result) {
  if (!result) return false;
  if (result.confidence >= 0.5) return true;
  return NON_LATIN.test(String(text || '').slice(0, 200));
}

/** 判断是不是「值得翻译」的文本（过滤纯数字 / URL / 代码符号） */
export function looksTranslatable(text) {
  const s = String(text || '').trim();
  if (s.length < 2) return false;
  if (!HAS_LETTER.test(s)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(s)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return false;
  if (/^[\d\s.,:;%$€¥+\-/()]+$/.test(s)) return false;
  if (/^(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(s)) return false;
  return true;
}

/** 文本里是否以 CJK 为主（决定分段长度、拼接方式） */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
export function isCJKHeavy(text) {
  const s = String(text || '').slice(0, 400);
  if (!s) return false;
  const hits = (s.match(new RegExp(CJK_CHAR.source, 'g')) || []).length;
  return hits / s.length > 0.25;
}

/** 两段文字拼接时是否需要插空格 */
export function needsSpace(left, right) {
  if (!left || !right) return false;
  const a = left.slice(-1);
  const b = right.slice(0, 1);
  if (CJK_CHAR.test(a) || CJK_CHAR.test(b)) return false;
  return /[\p{L}\p{N}]/u.test(a) && /[\p{L}\p{N}]/u.test(b);
}
