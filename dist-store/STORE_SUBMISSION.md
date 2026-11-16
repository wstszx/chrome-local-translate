# Chrome Web Store 上架资料（1.5.7）

> 已打包：`dist-store/chrome-local-translate-1.5.7.zip`（manifest.json 在包根；含 MV3 i18n `_locales/en`、`_locales/zh_CN`，`default_locale: "en"`，面向多国市场）
> 已通过：`npm run validate` + `npm test`（73/73 + 16/16）
> 商品：`本地翻译 · Chrome 内置模型` / Listing 默认显示名 `Local Translate – On-Device AI`（ID `ncenacdchlmblbdlljdkjjhhnjimmeje`，发布者 `mywstszx`）
> 控制台：https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit

## 当前控制台状态（2026-11-16 更新）
- **Status**：`Pending review`（Draft: “This draft is pending review.”；Published 仍为 1.5.5，公开）。
- **Package**：已上传 Draft **1.5.7**（Languages: English, Chinese (China)）。首次上传因 `en` 的 manifest 描述超 132 字符被拒，已修复 `_locales/en/messages.json` 的 `extDescription` 后重新打包上传。
- **Store listing（English – en, default）**：已更新并保存草稿。
  - Title（from package）：`Local Translate – On-Device AI`
  - Summary（from package）：`Private offline translation with Chrome's on-device AI. Translate selections, pages, and input text. No API key; data stays local.`
  - Description：已替换为英文（见下方“英文详细描述（实际已填）”），覆盖站点偏好/记忆、翻译历史、本地状态与引导、39 种语言对齐等新功能。
  - Screenshots：已移除旧图并为 **Localized screenshots** 与 **Global screenshots** 各上传 3 张：
    1. `dist-store/store-promo-1-inpage-selection.png`（网页内划词气泡）
    2. `dist-store/store-promo-2-inpage-dual.png`（整页双语对照）
    3. `dist-store/store-promo-3-inpage-inline.png`（输入框实时转写）
- **提交**：已点击 “Submit for review”（勾选通过审核后自动发布），提交成功。
- **备注**：`<all_urls>` 为核心功能所需，控制台可能继续提示 Broad Host Permissions / 审核时间较长；zh_CN 可在后台单独补充本地化 Listing 文案（包内已含 `_locales/zh_CN`）。

## 1. 商店信息（照填）

| 字段 | 填法 |
| --- | --- |
| 名称（英文/默认） | Local Translate – On-Device AI |
| 名称（简体中文） | 本地翻译 · 设备端离线翻译 |
| 简短描述（英文，132 字符内） | Private offline translation with Chrome's on-device AI. Translate selections, pages, and input text. No API key; data stays local. |
| 简短描述（中文，132 字符内） | 使用 Chrome 内置设备端本地模型离线翻译：划词即译、整页翻译、输入框转写、术语表与语气控制。无需 API Key，文本不出本机。 |
| 详细描述 | 见下方「详细描述」（建议在商店后台配置英文与中文本地化 Listing） |
| 分类 | Productivity / 效率 |
| 语言 | English（主）+ 简体中文（本地化）等（按目标市场添加） |
| 图标 | `icons/icon-128.png`（128×128 PNG） |
| 推广图片（可选，强烈建议） | 440×280 / 920×680 / 1400×560（至少 1 张） |
| 截图（必填，至少 1 张） | 1280×800 或 640×400，建议 3-4 张并突出**网页内翻译**：划词气泡、整页双语对照、输入框转写、侧边栏协同（已生成美化版见 `dist-store/store-promo-1-inpage-selection.png`、`store-promo-2-inpage-dual.png`、`store-promo-3-inpage-inline.png`） |
| 隐私权政策网址（必填） | `https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`（Cloudflare，项目 `chrome-local-translate-privacy`） |

### 详细描述（可直接粘贴）

> **把 Chrome 里已经下载好的本地模型用起来做翻译 —— 不需要 API Key，不联网推理，文本不出本机。**
>
> 本扩展同时用 Chrome 的两个本地 AI：
> • **Translator API（翻译专用模型）**：默认引擎，按语言对下载，速度快、质量好。
> • **Gemini Nano（Prompt API）**：进阶引擎，支持术语表、语气风格、上下文翻译与解释；语言对不受支持时自动回退到 Nano。
>
> 核心功能：
> • 划词翻译：选中文字气泡即译，可拖动、朗读、复制、用 Nano 解释。
> • 整页翻译：保留 DOM 结构，只替换文本节点，支持替换 / 双语对照 / 悬停对照三种显示方式，一键还原，视口优先、动态内容跟进。
> • 输入框转写：在网页 input / textarea / contenteditable（含 iframe、Shadow DOM）里打字实时翻译，流式输出，可替换 / 追加 / 还原，兼容 React/Vue 受控组件。
> • 术语表与语气控制：每行 `原文=译文`，支持忠实 / 自然 / 正式 / 口语 / 技术 / 学术等风格（Nano 链路）。
> • 快捷键：Alt+Shift+T 翻译整页、Alt+Shift+S 翻译选中、Alt+Shift+R 还原、Alt+Shift+Y 打开侧边栏。
> • 缓存与设置：同一句只翻一次（本地缓存），设置可跨设备同步。
>
> 要求：**Chrome 138+ 桌面版**（Windows / macOS / Linux / ChromeOS）。首次使用请在侧边栏点一次「下载当前语言对的语言包」。
>
> 隐私：**没有任何网络请求**。文本只在「页面 → 扩展后台 → 本地模型」本机链路上处理，不经过任何服务器。译文缓存只存 `chrome.storage.local`（可随时清空）。

### 英文详细描述（实际已填，English – en Listing）

> Translate privately on your device with Chrome’s built-in on-device AI — no API key, no cloud inference, and your text never leaves your machine.
>
> This extension uses Chrome’s local AI capabilities:
> • Translator API (built-in translation model): fast, high-quality translation for supported language pairs.
> • Gemini Nano (Prompt API): advanced mode for glossary, tone/style control, contextual translation, and explanations, with automatic fallback when needed.
>
> Key features:
> • Selection translation: translate highlighted text in-page with a draggable bubble (copy, read aloud, explain).
> • Full-page translation: translate while preserving page structure, with replace / bilingual / hover modes and one-click restore. Viewport-first with dynamic content updates.
> • Input rewrite: translate text as you type in inputs, textareas, and contenteditable fields (including iframes and Shadow DOM), with streaming output and replace/append/restore.
> • Site preferences & memory: remember per-site translation preferences and behavior.
> • Translation history: keep a local history of translations for quick reference.
> • Local status & guidance: clearer on-device model status and setup guidance.
> • Glossary & tone control: custom terms and styles (faithful, natural, formal, casual, technical, academic) via Nano.
> • Shortcuts: Alt+Shift+T translate page, Alt+Shift+S translate selection, Alt+Shift+R restore, Alt+Shift+Y open side panel.
> • Local cache & syncable settings.
>
> Language support: aligned with the Chrome Translator API language list (39 languages, including recent additions such as Kannada and Marathi), with actual availability depending on your device and installed language packs.
>
> Requirements: Chrome 138+ on desktop (Windows / macOS / Linux / ChromeOS). On first use, open the side panel and download the language pair/model as prompted.
>
> Privacy: no network requests. Text is processed only on-device (page → extension → local model). Translation cache is stored locally in chrome.storage.local and can be cleared at any time.

## 2. 数据安全与隐私申报（关键，照此填）

- **收集数据：否（Does not collect）** —— 选 *This extension does not collect any user data*。
- 受益人 / 第三方：否。
- 数据处理：本地处理，不传输。
- 远程代码：否（无远程加载的 JS/CSS，全部随包）。
- **单用途说明（Single Purpose）**：本扩展的唯一用途是本地离线翻译网页文本。`<all_urls>` + `activeTab` 仅用于向正在阅读的页面注入翻译 UI（气泡 / 整页翻译 / 输入框转写），不读取或外传与翻译无关的页面内容。

> ✅ `privacy.html` 联系邮箱：`mywstszx@gmail.com`。隐私政策已托管：`https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`（商店表单已填写）。

## 3. 提交 checklist（1.5.7 当前状态）

- [x] `manifest.json` MV3，版本 1.5.7，`npm run validate` + `npm test` 通过；已加入 `default_locale` 与 `_locales/en`、`_locales/zh_CN`（名称/描述/命令本地化）
- [x] ZIP 内只有生产文件（无 node_modules / tests / demo / docs）
- [x] `privacy.html` 已换真实邮箱 `mywstszx@gmail.com`
- [x] `privacy.html` 已托管到公开 URL，并填入商店表单：`https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`
- [x] 3 张 1280×800 美化宣传截图（含网页内翻译功能）已生成并上传至 Listing（Localized + Global）：`dist-store/store-promo-1-inpage-selection.png`、`dist-store/store-promo-2-inpage-dual.png`、`dist-store/store-promo-3-inpage-inline.png`（源：`dist-store/promo-1-selection.html`、`promo-2-dual.html`、`promo-3-inline.html`）
- [ ] （可选）制作 440×280 或 1400×560 推广图
- [x] 开发者控制台上传 1.5.7 Draft 包（`dist-store/chrome-local-translate-1.5.7.zip`）
- [x] 更新 Listing 文案（英文默认）并保存 Draft
- [x] 已提交审核（2026-11-16，Status: Pending review，选择通过审核后自动发布）

## 4. 本地仓库记录
- 分支/提交：`main` @ `34c685c`（已推送 `origin/main`）
  - `d5dd328` chore: 国际化应用名称并升级至 1.5.7
  - `34c685c` fix: shorten en extension description to 132 chars for store
- 工作区：`privacy.html` 有未提交修改；`dist-store/` 下存在未跟踪素材/截图/脚本，`dist-privacy/` 未跟踪（打包 zip 已生成但被忽略）。
