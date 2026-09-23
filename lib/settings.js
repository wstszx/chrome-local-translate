/**
 * lib/settings.js —— 设置读写
 * 常规设置存 chrome.storage.sync（跨设备同步），术语表这类大文本存 local。
 */

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

export async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get('settings').catch(() => ({})),
    chrome.storage.local.get('glossary').catch(() => ({})),
  ]);
  const merged = { ...DEFAULT_SETTINGS, ...((sync && sync.settings) || {}) };
  if (local && typeof local.glossary === 'string') merged.glossary = local.glossary;
  else if (typeof merged.glossary !== 'string') merged.glossary = '';
  return merged;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
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
