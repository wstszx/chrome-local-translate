/**
 * lib/settings.js —— 设置读写
 * 常规设置存 chrome.storage.sync（跨设备同步），术语表这类大文本存 local。
 *
 * 所有读写都过一层「消毒」：storage.sync 是跨设备同步的，老版本 / 损坏的同步数据、
 * 甚至是内容脚本拼错的 patch，都可能把 targetLang 变成数字、把 maxNodes 变成字符串。
 * 这类脏值一旦落盘，翻译就会一路坏到用户手动清缓存为止。
 */

import { LANGUAGES, normalizeCode } from './languages.js';

export const DEFAULT_SETTINGS = {
  uiLang: 'zh',

  // 翻译方向
  sourceLang: 'auto',
  targetLang: 'zh',

  // 引擎：auto = 优先内置翻译模型，语言对不支持时自动改用 Gemini Nano
  engine: 'auto',
  tone: 'default',
  glossary: '',
  context: '',

  // 划词
  showBubble: true,
  selectionDblclick: false,

  // 整页
  displayMode: 'replace', // replace | dual | hover
  autoTranslate: false,
  autoTranslateSites: [], // 为空表示所有网站
  neverSites: [],
  minAutoChars: 300,
  maxNodes: 3000,
  skipSameLang: true, // 混合语言页面：已是目标语言的段落跳过不翻（评审 A6）

  // 输入框转写（inline compose）
  inlineEnabled: true,
  inlineMode: 'button', // button = 显示小浮标 | auto = 边输边译自动展开 | off = 关闭
  inlineTargetLang: '', // 空 = 跟随 targetLang
  inlineLive: true, // 打开面板后随输入自动更新译文
  inlineMinChars: 2,
  inlineInsert: 'replace', // replace | append | copy
  inlineNeverSites: [],

  // 性能 / 显示
  concurrency: 2,
  cacheEnabled: true,
  theme: 'auto', // auto | light | dark
  fontSize: 14,
};

const LOCAL_KEYS = ['glossary'];

/* ------------------------------ 消毒 ------------------------------ */

const ENUMS = {
  uiLang: ['zh', 'en'],
  engine: ['auto', 'translator', 'nano'],
  tone: ['default', 'natural', 'formal', 'casual', 'technical'],
  displayMode: ['replace', 'dual', 'hover'],
  inlineMode: ['button', 'auto', 'off'],
  inlineInsert: ['replace', 'append', 'copy'],
  theme: ['auto', 'light', 'dark'],
};

const NUMBERS = {
  maxNodes: [10, 20000],
  concurrency: [1, 8],
  inlineMinChars: [1, 500],
  minAutoChars: [0, 1000000],
  fontSize: [10, 30],
};

const BOOLEANS = ['showBubble', 'selectionDblclick', 'autoTranslate', 'skipSameLang', 'inlineEnabled', 'inlineLive', 'cacheEnabled'];
const LISTS = ['autoTranslateSites', 'neverSites', 'inlineNeverSites'];
const TEXTS = ['glossary', 'context'];
const LANG_KEYS = ['sourceLang', 'targetLang', 'inlineTargetLang'];

/** 语言值必须是「auto」或语言表里真实存在的代码（normalizeCode 兜底认得 zh-TW 这类写法） */
function isKnownLang(value) {
  if (value === 'auto') return true;
  const code = normalizeCode(value);
  return !!code && LANGUAGES.some((l) => l.code === code);
}

/**
 * 单个设置值的消毒：合法返回可用值，非法返回 fallback（保持原值或默认值）。
 * 只做「类型 + 取值范围」校验，不改变合法值本身（包括大小写、繁简代码写法）。
 */
export function sanitizeValue(key, value, fallback) {
  if (LANG_KEYS.includes(key)) {
    if (key === 'inlineTargetLang' && value === '') return ''; // 空 = 跟随 targetLang
    if (typeof value === 'string' && isKnownLang(value)) return value;
    return fallback;
  }
  if (Object.prototype.hasOwnProperty.call(ENUMS, key)) {
    return ENUMS[key].includes(value) ? value : fallback;
  }
  if (Object.prototype.hasOwnProperty.call(NUMBERS, key)) {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    const [min, max] = NUMBERS[key];
    return Math.min(max, Math.max(min, Math.round(num)));
  }
  if (BOOLEANS.includes(key)) return typeof value === 'boolean' ? value : fallback;
  if (LISTS.includes(key)) {
    if (!Array.isArray(value)) return fallback;
    return value.filter((x) => typeof x === 'string' && x.trim()).slice(0, 500);
  }
  if (TEXTS.includes(key)) return typeof value === 'string' ? value : fallback;
  return fallback; // 未知键：丢弃
}

/** 把一整份设置对象按默认值兜底清洗一遍（读 storage 时用） */
export function sanitizeSettings(raw) {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    out[key] = sanitizeValue(key, (raw || {})[key], DEFAULT_SETTINGS[key]);
  }
  return out;
}

/** 只保留 patch 里合法的键（写 storage 时用） */
export function sanitizePatch(current, patch) {
  const out = {};
  for (const key of Object.keys(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue;
    const sane = sanitizeValue(key, patch[key], current ? current[key] : DEFAULT_SETTINGS[key]);
    out[key] = sane;
  }
  return out;
}

export async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get('settings').catch(() => ({})),
    chrome.storage.local.get('glossary').catch(() => ({})),
  ]);
  const merged = { ...DEFAULT_SETTINGS, ...((sync && sync.settings) || {}) };
  if (local && typeof local.glossary === 'string') merged.glossary = local.glossary;
  // 读出来也要洗一遍：老版本 / 损坏的同步数据里可能躺着脏值
  return sanitizeSettings(merged);
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...sanitizePatch(current, patch) };
  const syncPart = { ...next };
  for (const key of LOCAL_KEYS) delete syncPart[key];
  const localPart = {};
  for (const key of LOCAL_KEYS) localPart[key] = next[key] == null ? '' : String(next[key]);
  await Promise.all([
    chrome.storage.sync.set({ settings: syncPart }).catch(() => {}),
    chrome.storage.local.set(localPart).catch(() => {}),
  ]);
  return next;
}

/** 监听设置变化，回调收到变化后的完整设置（需 await getSettings） */
export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' && area !== 'local') return;
    if (!changes.settings && !changes.glossary) return;
    getSettings().then(callback).catch(() => {});
  });
}
