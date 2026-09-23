/**
 * tools/validate-manifest.mjs —— 在加载进 Chrome 之前先做一遍清单体检
 *
 * 起因：Chrome 有若干「加载时才报错」的隐形限制，最容易踩的两个是
 *   1) 带默认快捷键的命令（commands[*].suggested_key）最多 4 个；
 *   2) 清单里引用的文件必须真实存在。
 * 这个脚本把这些检查前置，`npm test` 会先跑它，避免出现
 * 「Failed to load extension / Could not load manifest」才发现。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);
const note = (msg) => notes.push(msg);

const manifestPath = join(root, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('✗ 找不到 manifest.json');
  process.exit(1);
}

let m;
try {
  m = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`✗ manifest.json 不是合法 JSON：${err.message}`);
  process.exit(1);
}

const fileExists = (p) => {
  if (typeof p !== 'string' || !p) return false;
  const clean = p.split('#')[0].split('?')[0];
  return existsSync(join(root, clean));
};

/* ------------------------------ 基础字段 ------------------------------ */

if (m.manifest_version !== 3) fail(`manifest_version 应为 3，实际 ${m.manifest_version}`);
if (!/^\d+(\.\d+){0,3}$/.test(String(m.version || ''))) fail(`version 格式不合法：${m.version}`);
if (!m.name) fail('缺少 name');
if (!m.description) fail('缺少 description');
if (m.description && m.description.length > 132) fail(`description 超过 132 字符（${m.description.length}）`);

/* ------------------------------ 文件引用 ------------------------------ */

const referenced = [];
for (const [size, p] of Object.entries(m.icons || {})) referenced.push([`icons["${size}"]`, p]);
for (const [size, p] of Object.entries((m.action && m.action.default_icon) || {})) referenced.push([`action.default_icon["${size}"]`, p]);
if (m.action && m.action.default_popup) referenced.push(['action.default_popup', m.action.default_popup]);
if (m.background && m.background.service_worker) referenced.push(['background.service_worker', m.background.service_worker]);
if (m.side_panel && m.side_panel.default_path) referenced.push(['side_panel.default_path', m.side_panel.default_path]);
if (m.options_ui && m.options_ui.page) referenced.push(['options_ui.page', m.options_ui.page]);
for (const [i, cs] of (m.content_scripts || []).entries()) {
  for (const f of cs.js || []) referenced.push([`content_scripts[${i}].js`, f]);
  for (const f of cs.css || []) referenced.push([`content_scripts[${i}].css`, f]);
  for (const f of cs.matches || []) {
    if (!/^(\*|https?|file|ftp|<all_urls>)/.test(f)) fail(`content_scripts[${i}].matches 写法可疑：${f}`);
  }
}
for (const [where, p] of referenced) {
  if (!fileExists(p)) fail(`${where} 指向的文件不存在：${p}`);
}

/* ------------------------------ 快捷键限制（关键） ------------------------------ */

const commands = m.commands || {};
const withKey = Object.entries(commands).filter(([, c]) => c && c.suggested_key);
if (withKey.length > 4) {
  fail(
    `带默认快捷键的命令有 ${withKey.length} 个，Chrome 上限是 4 个：${withKey
      .map(([name]) => name)
      .join('、')} → 去掉其中若干个的 suggested_key（命令本身可以保留，用户可在 chrome://extensions/shortcuts 自行绑定）`,
  );
} else {
  note(`带默认快捷键的命令：${withKey.length}/4（${withKey.map(([n]) => n).join('、') || '无'}）`);
}
for (const [name, c] of Object.entries(commands)) {
  if (!c || typeof c !== 'object') {
    fail(`commands.${name} 应为对象`);
    continue;
  }
  if (!c.description) fail(`commands.${name} 缺少 description`);
  if (c.suggested_key) {
    const key = c.suggested_key.default || c.suggested_key.mac || c.suggested_key.windows || c.suggested_key.linux;
    if (!key) fail(`commands.${name}.suggested_key 里没有任何平台键值`);
    else if (!/^(Ctrl|Alt|Command|MacCtrl)(\+(Shift|Alt|Ctrl))?\+[A-Z0-9]$/i.test(key)) {
      fail(`commands.${name} 的快捷键写法可疑：${key}（形如 Alt+Shift+T）`);
    }
  }
}
note(`命令总数：${Object.keys(commands).length}，其中带默认键 ${withKey.length} 个（无默认键的命令不计数）`);

/* ------------------------------ 权限 / 内容脚本 ------------------------------ */

const KNOWN_PERMISSIONS = new Set([
  'activeTab', 'alarms', 'bookmarks', 'clipboardRead', 'clipboardWrite', 'contextMenus', 'cookies', 'debugger',
  'declarativeContent', 'declarativeNetRequest', 'downloads', 'fontSettings', 'gcm', 'history', 'identity',
  'idle', 'management', 'nativeMessaging', 'notifications', 'offscreen', 'pageCapture', 'power', 'printerProvider',
  'privacy', 'proxy', 'scripting', 'search', 'sessions', 'sidePanel', 'storage', 'tabCapture', 'tabGroups',
  'tabs', 'topSites', 'tts', 'ttsEngine', 'unlimitedStorage', 'userScripts', 'webNavigation', 'webRequest',
  'webRequestBlocking', 'geolocation', 'audio', 'videoCapture', 'clipboard', 'unlimitedStorage',
]);
for (const p of m.permissions || []) {
  if (!KNOWN_PERMISSIONS.has(p) && !/^chrome\./.test(p)) fail(`未知权限：${p}`);
}
if ((m.permissions || []).includes('tabs') && (m.host_permissions || []).length === 0) {
  note('提示：声明了 tabs 但没有 host_permissions，需要谨慎，检查是否真的需要');
}
if ((m.content_scripts || []).length && !(m.host_permissions || []).length && (m.content_scripts || []).some((cs) => /<all_urls>|https?:/.test((cs.matches || []).join(' ')))) {
  note('内容脚本匹配 http(s) 页面但没有 host_permissions —— 通常没问题（content_scripts.matches 自带授权），仅提示');
}
if (m.minimum_chrome_version) {
  const v = Number(m.minimum_chrome_version);
  if (!Number.isFinite(v) || v < 100) fail(`minimum_chrome_version 可疑：${m.minimum_chrome_version}`);
  else if (v > 140) note(`minimum_chrome_version=${v}，请确认目标用户都满足`);
}

/* ------------------------------ 模块化的 service worker 与 import ------------------------------ */

const sw = m.background && m.background.service_worker;
if (sw && m.background.type === 'module') {
  const src = readFileSync(join(root, sw), 'utf8');
  const imports = [...src.matchAll(/from\s+['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/g)].map((x) => x[1]);
  for (const rel of imports) {
    const target = join(root, dirname(sw), rel);
    if (!existsSync(target)) fail(`Service Worker 里 import 的文件不存在：${rel}`);
  }
  if (imports.length) note(`Service Worker 模块 import：${imports.length} 个，全部存在`);
}

/* ------------------------------ 内容脚本载入顺序 / 主世界脚本 ------------------------------ */

const csEntries = (m.content_scripts || []).filter((cs) => (cs.js || []).length);
for (const [i, cs] of csEntries.entries()) {
  const files = cs.js || [];
  for (const file of files) {
    if (!existsSync(join(root, file))) continue;
    const src = readFileSync(join(root, file), 'utf8');
    if (/^\s*import\s/m.test(src)) {
      fail(`${file} 使用了 ESM import —— 内容脚本不支持模块，请改成普通脚本（IIFE + 全局命名空间）`);
    }
    if (cs.world === 'MAIN' && /chrome\.(runtime|storage|i18n)/.test(src)) {
      note(`${file} 是主世界脚本，却用到了 chrome.* API —— 主世界里拿不到扩展 API`);
    }
    if (cs.world === 'MAIN' && i > 0) {
      note(`主世界脚本 ${file} 不在第一个 content_scripts 条目里 —— 应该放最前面，才能赶在页面脚本建影子根之前打补丁`);
    }
  }
}

// 隔离世界那条要按顺序加载：util 先于 ui/inline/main；命名空间最后要能被 inline/main 找到
const isolated = csEntries.find((cs) => (cs.world || 'ISOLATED') !== 'MAIN') || {};
const isoFiles = isolated.js || [];
const idx = (name) => isoFiles.findIndex((f) => f.endsWith(name));
if (isoFiles.length) {
  if (idx('util.js') === -1 || idx('util.js') > idx('ui.js')) note('加载顺序可疑：util.js 应排在 ui.js / inline.js / main.js 之前');
  if (!/content\.css$/.test((isolated.css || [])[0] || '')) note('isolated 内容脚本条目里没有 css（content.css）');
  for (const f of isoFiles) {
    if (/\.js$/.test(f) && !/^(content\/(util|ui|inline|main)|background|offscreen)/.test(f)) {
      note(`内容脚本 ${f} 不在预期名单里，确认它设计成经典脚本且不依赖加载顺序`);
    }
  }
}

/* ------------------------------ 输出 ------------------------------ */

for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error(`\n✗ manifest 有 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✓ manifest.json 通过校验');
