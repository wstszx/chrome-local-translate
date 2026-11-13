# Chrome Web Store 上架资料（1.5.6）

> 已打包：`dist-store/chrome-local-translate-1.5.6.zip`（manifest.json 在包根，含 Translator API 官方语言列表对齐：新增 kn、mr）
> 已通过：`npm run validate` + `npm test`（72/72 + 16/16）
> 已修正：`privacy.html` 第二节「不收集」——与代码实际行为一致（零网络请求），否则数据安全申报对不上。

## 1. 商店信息（照填）

| 字段 | 填法 |
| --- | --- |
| 名称 | 本地翻译 · Chrome 内置模型 |
| 简短描述（132 字符内） | 用 Chrome 内置本地模型离线翻译：划词即译、整页翻译、输入框转写、术语表与语气控制。无需 API Key，文本不出本机。 |
| 详细描述 | 见下方「详细描述」 |
| 分类 | Productivity / 效率 |
| 语言 | 简体中文（主）、English（可加） |
| 图标 | `icons/icon-128.png`（128×128 PNG） |
| 推广图片（可选，强烈建议） | 440×280 / 920×680 / 1400×560（至少 1 张） |
| 截图（必填，至少 1 张） | 1280×800 或 640×400，建议 3-4 张：侧边栏文本翻译 / 整页翻译进度条 / 划词气泡 / 输入框转写 |
| 隐私权政策网址（必填） | 必须托管公开 URL —— 把 `privacy.html` 放到 GitHub Pages 或任意公开域名后填入。 |

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

### 英文详细描述（对应英文商店区）

> Translate with Chrome's built-in on-device models — no API key, fully offline.
> Uses Translator API (default) and Gemini Nano for glossary, tone and explanation.
> Features: selection bubble translation, full-page translation (replace / bilingual / hover), input-box rewrite in iframes & Shadow DOM, glossary & style control, local cache.
> Requires Chrome 138+ desktop. All text stays on your device.

## 2. 数据安全与隐私申报（关键，照此填）

- **收集数据：否（Does not collect）** —— 选 *This extension does not collect any user data*。
- 受益人 / 第三方：否。
- 数据处理：本地处理，不传输。
- 远程代码：否（无远程加载的 JS/CSS，全部随包）。
- **单用途说明（Single Purpose）**：本扩展的唯一用途是本地离线翻译网页文本。`<all_urls>` + `activeTab` 仅用于向正在阅读的页面注入翻译 UI（气泡 / 整页翻译 / 输入框转写），不读取或外传与翻译无关的页面内容。

> ✅ `privacy.html` 的联系邮箱已换成真实可收信地址 `mywstszx@gmail.com`。**仍需**把这个页面托管到公开 URL，并把 URL 填入商店表单的隐私政策栏。

## 3. 提交前 checklist

- [x] `manifest.json` MV3，版本 1.5.6，`npm run validate` 通过
- [x] ZIP 内只有生产文件（无 node_modules / tests / demo / docs）
- [x] `privacy.html` 已换真实邮箱 `mywstszx@gmail.com`
- [ ] `privacy.html` 已托管到公开 URL，并把该 URL 填入商店表单
- [ ] 截 3-4 张截图（建议用 `demo/ui-preview.html` 在真实 Chrome 里截图）
- [ ] 做 1 张 440×280 或 1400×560 推广图（可用 `icons/icon-128.png` 拼一个）
- [ ] 在 Chrome Web Store 开发者控制台新建商品 → 上传上面的 ZIP
- [ ] 最后点「提交审核」；审核通常 1-3 天，期间在 `chrome://extensions` 里保持开发者模式自测一遍
