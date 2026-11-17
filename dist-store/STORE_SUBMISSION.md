# Chrome Web Store 上架资料（当前：1.5.8）

> 最新打包：`dist-store/chrome-local-translate-1.5.8.zip`（manifest.json 在包根；含 MV3 i18n `_locales/en`、`_locales/zh_CN`，`default_locale: "en"`）
> 已通过：`npm run validate` + `npm test`（73/73 + 16/16）
> 商品：Listing 默认显示名 `Local Translate – On-Device AI`（ID `ncenacdchlmblbdlljdkjjhhnjimmeje`，发布者 `mywstszx`）
> 控制台：https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit

## 当前控制台状态（2026-11-17 更新）
- **Status**：`Pending review`（Published: 1.5.7，公开；Draft: **1.5.8** pending review / 自动发布已选择）。
- **Package**：Draft **1.5.8** 已上传（Languages: English, Chinese (China)）。
- **Store listing**：沿用 1.5.7 已校正内容（未改动素材/文案结构）：
  - **English – en（default）**：Title/Summary 来自 package；Description 为英文新版；Localized screenshots 4 张（`dist-store/store-promo-en-1-selection.png`、`store-promo-en-2-dual.png`、`store-promo-en-3-inline.png`、`store-promo-en-4-popup.png`）。
  - **Chinese (China) – zh-CN**：Title/Summary 来自 package；Description 为中文新版；Localized screenshots 3 张（`dist-store/store-promo-1-inpage-selection.png`、`store-promo-2-inpage-dual.png`、`store-promo-3-inpage-inline.png`）。
  - **Global screenshots（4 张）**：与英文一致（`store-promo-en-1~4`）。
- **1.5.8 本次提交包含**：
  - 自愿支持入口（不影响功能、不引入追踪/网络请求）：侧边栏/弹窗支持链接（爱发电 + Ko-fi `https://ko-fi.com/fbread`，GitHub Sponsors 预留）、`lib/links.js`、`_locales` `sponsorLabel`、README 支持说明、`.github/FUNDING.yml`。
  - 设置页复杂度简化（渐进披露）：设置项分组折叠（引擎/Nano 高级、输入框转写高级与排错、整页全局站点规则与高级、性能高级、诊断故障排除）、文案收敛与交叉指引、页面 Tab「本地模型与状态」运维入口归并、站点优先级/全局命中提示、保存状态反馈、站点列表输入自动整理（去空白/去重/规范化 host）。
- **备注**：`<all_urls>` 为核心功能所需，可能继续提示 Broad Host Permissions / 审核时间较长。 eingel

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
| 截图（必填，至少 1 张） | 1280×800 或 640×400；**按 Listing 语言对应**。英文：`dist-store/store-promo-en-1-selection.png`、`store-promo-en-2-dual.png`、`store-promo-en-3-inline.png`、`store-promo-en-4-popup.png`（含扩展弹窗）；中文（zh-CN）：`dist-store/store-promo-1-inpage-selection.png`、`store-promo-2-inpage-dual.png`、`store-promo-3-inpage-inline.png`（源：`dist-store/promo-en-*.html`、`dist-store/promo-*-*.html`） |
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

## 3. 提交 checklist（1.5.8）

- [x] `manifest.json` MV3，版本 1.5.8，`npm run validate` + `npm test` 通过；`default_locale` 与 `_locales/en`、`_locales/zh_CN` 完整
- [x] ZIP 内为生产文件（无 node_modules / tests / demo / docs）
- [x] 隐私政策已托管并填写：`https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`
- [x] en/zh-CN Listing 与截图已按语言匹配并保持正确（本次未改动素材）
- [x] 打包并上传 Draft：`dist-store/chrome-local-translate-1.5.8.zip`（含支持链接与设置页简化）
- [x] 保存 Draft 并提交审核（2026-11-17，Status: **Pending review**，选择通过审核后自动发布；Published 当前为 1.5.7）
- [ ] （可选）制作 440×280 或 1400×560 推广图
- [ ] （可选）为 zh-CN 补充扩展弹窗/侧边栏截图
- [ ] 1.5.8 审核通过后补记：发布时间（本地时区）、线上版本号、自动发布结果与抽查记录（支持链接、设置页简化、Listing 展示）

## 4. 本地仓库记录
- 分支/提交：`main`（含 1.5.8 支持链接与设置页简化提交，待本次文档更新后推送 `origin/main`）
  - `f8cf965` feat: add voluntary support links and bump to 1.5.8
  - `6e363c8` feat: support multiple voluntary sponsor links (Afdian/Ko-fi/GitHub)
  - `8ced640` chore: add Ko-fi sponsor link
  - `0807915` refactor(sidepanel): simplify settings UI with progressive disclosure
- 历史：`34c685c`（1.5.7 描述修复）、`b0b20c0`/`43ef8c8`（1.5.7 提交与素材记录）等
- 工作区：`privacy.html` 有未提交修改；`dist-store/`、`dist-privacy/` 下存在未跟踪素材/脚本（打包 zip 已生成但被忽略）。

## 4. 本地仓库记录
- 分支/提交：`main` @ `34c685c`（已推送 `origin/main`）
  - `d5dd328` chore: 国际化应用名称并升级至 1.5.7
  - `34c685c` fix: shorten en extension description to 132 chars for store
- 工作区：`privacy.html` 有未提交修改；`dist-store/` 下存在未跟踪素材/截图/脚本，`dist-privacy/` 未跟踪（打包 zip 已生成但被忽略）。
