# Chrome Web Store 上架资料（当前：1.5.9 公开 / 1.5.10 已打包待上传）

> **2026-11-26 更新（晚）**：仓库递增到 **1.5.10** 并已打包 `dist-store/chrome-local-translate-1.5.10.zip`（29 条目、184 KB、validate + 全部测试通过）。内容：**B3 批内去重**（同批次重复文本只发一次请求）、**D1 只翻正文**（新设置 `skipChromeUI`，默认跳过导航/页脚/Cookie 横幅，`<main>`/`<article>` 是正文边界）、打赏区「赞助作者」本地化前缀（`32655f7`）、GitHub Sponsors 占位清理（`2153690`）、Playwright E2E 基建（`tests/e2e.mjs`，不进包）。**尚未上传商店**（上传时浏览器自动化连接已断开，待恢复或手动上传）。发版说明建议提一句：D1 默认开启会改变行为 —— 导航/页脚不再被翻译，这是改善但用户可能疑问。


> 包（本地构建产物）：`dist-store/chrome-local-translate-1.5.8.zip`（manifest.json 在包根；含 MV3 i18n `_locales/en`、`_locales/zh_CN`，`default_locale: "en"`）。**注意：本地在 1.5.8 提审后继续有提交并可能重建过 zip，勿将当前本地 zip 误当作已提交审核的 draft 包。**
> 校验/测试（本地仓库当前状态）：`npm run validate`、`npm test` 通过。
> 商品：Listing 默认显示名 `Local Translate – On-Device AI`（ID `ncenacdchlmblbdlljdkjjhhnjimmeje`，发布者 `mywstszx`）
> 控制台：https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit

## 当前控制台状态（2026-11-17 记录，后续请以控制台为准）
- **Status**：`Published - public`，公开版本 **1.5.9**（2026-11-26 确认；1.5.9 于 2026-11-23 提交审核、11-26 前后通过并自动发布）。Draft 无待审项。
- **Package**：Draft **1.5.8** 已上传（Languages: English, Chinese (China)）。**该 draft 不包含 `499c781` 之后的提交**（含站点规则管理/设置简化、后续 i18n 收敛、README/隐私页/选项页合规表述修补等）。
- **Store listing**：1.5.7/1.5.8 提审时已配置的中英文本地化与截图（见下文素材记录）；如需更新隐私/权限说明文案，请在下次版本提交时一并调整。
- **Privacy / Distribution**：提审时已填写（单一用途、权限理由、Remote code = No、数据使用声明、认证）。如后台字段/问题项有更新，建议按本文“商店后台权限与隐私说明（建议文案）”校对。
- **Submission checklist**：2026-11-17 已提交审核（自动发布）。

## 发布后待办（1.5.8 审核通过后）
- ✅ 1.5.8 已通过并公开（2026-11-23 确认公开页展示 1.5.8 与 en/zh-CN 本地化正常）。
- ✅ 将 `499c781` 之后的改动纳入 **>1.5.8** 的新版本：1.5.9 已递增版本号、打包上传、提交审核并通过（2026-11-23 提交，2026-11-26 确认公开）。
- 待办（下个版本）：把打赏区「赞助作者」本地化前缀与 GitHub Sponsors 占位清理（`32655f7`、`2153690`）随 1.5.10/1.6.0 上架；届时递增版本号、打包、上传并提交审核，更新本文件。
- 如要缓解 “Enhanced Safe Browsing: not trusted” 提示：在后台完善开发者账号信息与权限/隐私说明（见下文建议文案），保持合规与透明；该提示主要受信誉/分发等信号影响，无法仅靠代码立即消除。

## 1. 包与测试（下次版本提交流程）
- **Zip**：从仓库根目录打包生成 `dist-store/chrome-local-translate-<version>.zip`（根含 `manifest.json`；包含 `_locales/`、`lib/`、`content/`、`sidepanel/`、`popup/`、`offscreen/`、`icons/`、`background.js` 等运行时文件；不含 `node_modules/`、`tests/`、`demo/`、`docs/` 等开发/文档文件）。
- **校验**：`npm run validate`（版本一致、默认快捷键、Service Worker import）。
- **测试**：`npm test`。

## 2. Store listing（中英双语，控制台已配置/可复用）

### 中文（zh-CN）
- **名称（来自 package）**：本地翻译 · 设备端离线翻译
- **简介（来自 package）**：使用 Chrome 内置设备端本地模型进行离线翻译：划词即译、整页翻译、输入框转写，支持术语表与语气控制。无需 API Key，文本不出本机。
- **分类**：Productivity（生产力工具）/ Tools（工具）
- **隐私权政策**：`https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`

### English（en, default）
- **Title (from package)**：Local Translate – On-Device AI
- **Summary (from package)**：Private offline translation with Chrome's on-device AI. Translate selections, pages, and input text. No API key; data stays local.
- **Category**：Productivity / Tools
- **Detailed description (reference)**：Translate privately with AI that runs on your device.

  Local Translate helps you understand and rewrite text without sending page content to external translation servers. Use Chrome's on-device AI to translate selected text, full pages, and text you type — all inside your browser.

  Key features
  - Translate selected text instantly on the page
  - Translate full pages while browsing
  - Inline input translation and rewriting (select text in a text field, then press Alt+Shift+Enter)
  - Side panel and popup for quick translation workflows
  - Works with Chrome’s on-device AI (availability depends on your device, Chrome version, and supported languages)
  - No account required

  Privacy-first by design
  - Designed for on-device translation when Chrome’s built-in AI is available
  - No API key required
  - Page content is not sent to the developer’s servers for translation

  Notes
  - On-device AI availability and language support depend on your Chrome version, device capabilities, and Google’s model availability.
  - Some features may require a compatible Chrome version and supported hardware.

## 3. 素材与文档
- **图标**：`icons/icon-16/32/48/128.png`（包内）
- **截图（仓库中的上传素材）**：
  - `dist-store/store-promo-en-1-selection.png`（1280×800）
  - `dist-store/store-promo-en-2-dual.png`（1280×800）
  - `dist-store/store-promo-en-3-inline.png`（1280×800）
  - `dist-store/store-promo-en-4-popup.png`（1280×800）
  - `dist-store/store-promo-1-inpage-selection.png`（1280×800）
  - `dist-store/store-promo-2-inpage-dual.png`（1280×800）
  - `dist-store/store-promo-3-inpage-inline.png`（1280×800）
- **宣传图 / 宣传视频**：未提供（可选）
- **相关文档**：`privacy.html`（隐私政策页源码；线上托管 URL 见上）、`README.md`、`dist-store/STORE_SUBMISSION.md`、`.github/workflows/release.yml`、`.gitignore`

## 4. 商店后台权限与隐私说明（建议文案，粘贴时请按控制台字段与实际行为核对）

### 4.1 Single purpose / 单一用途
- **EN**: Provide on-device translation and rewriting for web content: translate selected text, full pages, and text in input fields using Chrome’s built-in AI (Translator / Language Detector / Prompt API). Optional controls such as glossary, tone, translation history, and per-site preferences run locally to support this purpose.
- **中文**：提供网页内容的设备端本地翻译与转写：使用 Chrome 内置 AI（Translator / Language Detector / Prompt API）翻译选中文本、整页内容和输入框文本；术语表、语气、翻译历史与站点偏好等可选功能均在本地运行，仅用于支持上述翻译用途。

### 4.2 Permission justification / 权限用途说明
- **`storage`**
  - **EN**: Stores user settings (engine, target language, display mode, glossary/tone options), per-site preferences/rules, translation cache, and translation history locally to provide core functionality.
  - **中文**：在本地保存用户设置（引擎、目标语言、显示模式、术语表/语气选项）、站点偏好/规则、译文缓存和翻译历史，用于提供扩展核心功能。
- **`contextMenus`**
  - **EN**: Adds context menu actions so users can trigger translation from the right-click menu.
  - **中文**：添加右键菜单操作，便于用户通过右键菜单触发翻译。
- **`sidePanel`**
  - **EN**: Opens the extension side panel UI for translation, settings, history, and diagnostics.
  - **中文**：打开扩展侧边栏界面，用于翻译、设置、历史与诊断。
- **`offscreen`**
  - **EN**: Creates an offscreen document as a local host for on-device AI/model operations required by the extension architecture (service worker/background coordination). No remote server processing is involved.
  - **中文**：创建离屏文档作为扩展架构所需的本地 AI/模型操作宿主（与后台 service worker 协同）。不涉及远程服务器处理。
- **`activeTab`**
  - **EN**: Grants temporary access to the active tab when the user explicitly invokes the extension (toolbar action, context menu, or shortcut) so it can read the selected/page/input content the user asked to translate and display results in that tab.
  - **中文**：当用户主动调用扩展时（工具栏按钮、右键菜单或快捷键），授予对当前活动标签页的临时访问，以读取用户请求翻译的选中内容/页面内容/输入内容并在该页显示结果。
- **`scripting`**
  - **EN**: Injects packaged extension scripts/UI into pages on user action to provide in-page translation bubbles, full-page translation overlays, and inline input rewriting. Scripts are bundled with the extension (no remote code).
  - **中文**：在用户触发时向页面注入随扩展打包的脚本与 UI，用于提供页内翻译气泡、整页翻译覆盖层和输入框内转写。脚本均随扩展打包（无远程代码）。
- **Host permissions: `<all_urls>`**
  - **EN**: Required because users may choose to translate content on any website they visit. The extension needs host access to inject its translation UI/content scripts on arbitrary pages (and, where applicable, embedded frames) to perform selection translation, full-page translation, and in-field rewriting. Access is limited to providing the extension’s translation features; page content is processed locally with Chrome’s built-in on-device AI and is not transmitted to the developer or third-party servers.
  - **中文**：由于用户可能在其访问的任意网站上请求翻译，扩展需要主机访问权限以在任意网页（以及适用时的嵌入式框架）注入翻译 UI/内容脚本，从而实现划词翻译、整页翻译和输入框转写。该访问仅用于提供翻译功能；页面内容通过 Chrome 内置设备端 AI 在本地处理，不会传输给开发者或第三方服务器。
- **Content script `content/agent.js` (`"world": "MAIN"`, `run_at: "document_start"`, `all_frames` / `match_about_blank` / `match_origin_as_fallback`, `<all_urls>`)**
  - **EN**: Declared to run early in the page’s main world so the extension can interact with page inputs/editors that may use closed Shadow DOM or other page-context behaviors required for reliable inline rewriting/translation in text fields across sites and frames. It is part of the packaged extension, used only to enable local translation/rewriting features, and does not upload page data.
  - **中文**：声明在页面主世界（MAIN world）于 `document_start` 尽早运行，以便在各网站及框架中可靠地支持输入框/编辑器的内联转写与翻译（包括使用 closed Shadow DOM 等页面上下文行为的场景）。该脚本随扩展打包，仅用于实现本地翻译/转写功能，不上传页面数据。

### 4.3 Privacy / data use / remote code（核对要点）
- **Remote code**：`No`（无 `eval`、不加载远程脚本/Wasm；推理使用 Chrome 内置 API 与打包代码）。
- **Data collection/transmission**：扩展不向开发者或第三方收集/出售/传输个人数据；翻译在本地完成；设置/站点偏好/缓存/历史等仅本地存储（并受用户浏览器同步设置影响时如实披露）。
- **Privacy policy URL**：`https://chrome-local-translate-privacy.wstszx.workers.dev/privacy.html`（确保托管内容与实际行为、后台披露一致）。

## 5. 提交前核对清单（下次版本复用）
- [ ] 确认 Developer account / 联系方式 / 隐私权实践无阻塞项。
- [ ] 递增版本号（`manifest.json` + `package.json` 同步）并更新本文件状态。
- [ ] 重新生成 zip，执行 `npm run validate` + `npm test`。
- [ ] 上传 zip → 保存草稿 → 核对 Package / Listing / Privacy / 权限说明 → 提交审核。
- [ ] 审核通过后补记：公开版本号、发布时间、Listing URL/截图与用户反馈摘要。

## 6. 本地仓库记录
- `origin/main` 已包含 1.5.8 打包/提审相关提交（如 `499c781`）及后续本地化/合规文档修补提交；请以 `git log` 与控制台实际已发布/审核版本为准区分“仓库代码”与“商店线上包”。
- `docs/plans/`、`docs/superpowers/` 等为本地计划/文档（可能未跟踪或未纳入发布包），不属于扩展运行时文件。
