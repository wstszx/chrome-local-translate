# 本地翻译 · Chrome 内置模型（Local Translate）

把 Chrome 里那套**已经在硬盘上、但一直闲置的本地模型**用起来做翻译：划词即译、整页翻译、术语表与语气控制，**不需要 API Key、不联网推理、文本不出本机**。

---

## 0. 先澄清一件事：Chrome 里的本地模型其实有两个

| 模型 | 谁在用 | 大小 | 本扩展里的角色 |
| --- | --- | --- | --- |
| **翻译专用模型**（Translator API / Language Detector API，Chrome 138+ 稳定版） | `window.Translator` | 按**语言对**下载，每个语言包通常几 MB ~ 上百 MB | **默认引擎**：快、质量好、专门做翻译 |
| **Gemini Nano**（Prompt API / 基础模型） | `window.LanguageModel` | 约 2~4 GB（你在 `chrome://on-device-internals` 看到的那个） | **进阶引擎**：术语表、语气风格、上下文、翻译 + 解释 |

很多人以为「4GB 的 Gemini Nano = Chrome 的翻译功能」，其实**翻译网页**用的内置翻译（右键「翻译成中文」）走的是第一套专家模型，Gemini Nano 是通用大模型，能力更泛但单句翻译不一定比专家模型好。本扩展**两条都用**，默认先用专家模型，需要「可控翻译」（术语表/语气/解释）时切到 Nano；语言对不被支持时也会自动回退到 Nano。

---

## 1. 安装（10 秒）

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的那一层）
4. 工具栏出现「本地翻译」图标；点图标 → **打开侧边栏**（或按 `Alt+Shift+Y`）

> 要求：**Chrome 138+ 桌面版**（Windows / macOS / Linux / ChromeOS）。内置 AI 在移动端不可用。

**不想装也能先看效果**：打开 `demo/ui-preview.html`（自包含单文件，内联了扩展真实的内容脚本 + 一个模拟后台）。选中文字、点「翻译整页」都能看到真实的交互；如果浏览器支持 `Translator` API，还可以点「启用真实内置模型」当场试真模型。

---

## 2. 首次使用最重要的一步：把语言包下下来

Chrome 规定：**在语言包还没下载好时，创建模型必须由「用户手势」触发**，否则会抛 `NotAllowedError`。所以第一次一定要主动点一下：

1. 打开侧边栏 → **页面** 标签 → 底部「本地模型」卡片
2. 确认语言对（比如 英语 → 中文），点 **「下载当前语言对的语言包」**
3. 看到进度条走完 → 之后这个语言对**永久离线可用**

同一张卡片还会显示：

- `内置翻译模型`：已就绪 / 待下载 / 不可用
- `Gemini Nano`：已就绪 / 待下载 / 不可用（不可用时通常是硬件不满足或模型没下完）

> 用了其他语言对（例如 日语 → 中文）时，Chrome 会为该语言对再下一份语言包，同样点一下就行。
> 想预先把多个语言对准备好：在侧边栏把目标语言切换一下，再点一次下载即可。

---

## 3. 怎么用

### 划词翻译
在任意网页选中文字 → 气泡自动弹出（如已就绪则几乎是瞬时的）。气泡里有：

- 源语言 → 目标语言、用的是哪个本地模型
- `🔊 朗读` · `⧉ 复制` · `💡 用 Gemini Nano 解释` · `✕ 关闭`
- 出错时会显示可读原因和「重试」

**气泡可以随便拖：**

| 操作 | 效果 |
| --- | --- |
| 按住标题栏拖动（`⠿` 把手 / 语言徽标那一行） | 气泡跟随指针移动，自动被视口钳制，不会拖出屏幕 |
| 松手 | 位置被记住（存 `chrome.storage.local`），之后的译文、悬停对照都会一直用这个位置 |
| 点 `⌖` 或双击标题栏 | 取消固定，气泡重新跟随选区 |
| 拖动后 | 标题栏会出现 `⌖` 按钮，表示当前处于「已固定」状态 |

拖动只在标题栏生效，气泡正文仍然可以正常选词复制。整页翻译的进度条不受影响。

### 整页翻译
侧边栏「页面」标签 → **翻译整页**（或 `Alt+Shift+T`，或右键菜单）。特点：

- **保留原 DOM 结构**：只翻译文本节点，标签/链接/列表/表格布局都不动
- 自动跳过 `code/pre/script/style/textarea`、`translate="no"`、`notranslate` 的内容
- 底部右下的进度条实时显示 `已翻译 n/N 段`
- **还原原文** 一键回滚（每个节点都保留了原始值）
- 翻译完成后会继续跟进**动态加载的内容**（MutationObserver，去抖 900ms）

### 输入框转写（在网页输入框里打字时）

在任意网页的**输入框 / 正文编辑区**（`input` / `textarea` / `contenteditable`）里输入文字后：

- 输入框右下角出现 **`🌐 转写` 小浮标**（目标语言就写在按钮上）→ 点开面板
- 面板里是**实时译文**（流式逐字输出，随输入自动更新），并且**译文可以直接编辑**
- 按钮：**替换输入框** / **追加到末尾** / **还原原文**（回滚刚刚的替换）/ 重新翻译
- 面板里的**语言下拉**可以随时换成任意目标语言（默认「跟随主语言」，也可固定成某个语言）
- 面板**可以拖动**（⌖ 复位到输入框下方），位置仅在本页会话内保持
- 快捷键：**`Alt+Shift+Enter`** 直接转写并按设置写入（默认替换）；**`Alt+Shift+E`** 同效，可在
  `chrome://extensions/shortcuts` 改键；**`Esc`** 关面板

写入是**兼容 React / Vue 受控组件**的：优先用 `execCommand('insertText')`（走浏览器编辑管线，
所以 `Ctrl/Cmd+Z` 也能撤销），失败时退回「原生 value setter + `input` 事件」——这是受控组件唯一认的方式。

**弹窗里的输入框也管**（v1.4.0 / v1.4.1）：整页弹窗、对话框、以及**嵌在 iframe 里的登录框 / 搜索框 / 评论框**都能用。
做法是这几件事：

0. **快捷键要发给「正在打字的那个 frame」**（v1.4.1）。`chrome.tabs.sendMessage` 不带 frameId 时是广播，
   但只兑现**第一个**应答的 frame；而 Chrome 里 `document.hasFocus()` 对焦点所在 frame 的**所有祖先**都是 true，
   于是顶层 frame 会抢答「当前没有聚焦的输入框」，把真正拿得到文本的子 frame 挤掉 —— 表现就是
   **「明明输入框里有字，转写却抓不到」**。现在改成：内容脚本一边打字一边**认领**自己所在的 frame，
   快捷键优先点对点发给它；拿不准时先广播一次**探路**（`probeOnly`，不动任何输入框），
   把每层 frame 的回答收齐、按「谁能写 + 有焦点 + 最近活动」打分挑出**唯一**赢家，再单独发真正的指令。
   顺带解决了「多个 frame 同时往各自页面里写」的隐患。
1. **我们自己的界面不许被当成输入框**（v1.4.1）。转写面板里的译文框本身是 `contenteditable`，
   而 `closest('[data-lt-ui]')` **跨不过影子边界** —— 于是打开面板、焦点落到译文框之后，
   扩展会把**自己的面板**当成要转写的输入框顶掉真正的那个，读到的永远是空面板。
   现在改成沿着影子树往上走（`getRootNode().host`）来判断「这是不是我们自己的 UI」。

1. 内容脚本 `all_frames: true`，**每一层 frame 都注入**（含 `about:blank` / `srcdoc` / `data:` 这种
   没有独立网址的弹窗 iframe，靠 `match_about_blank` + `match_origin_as_fallback` 兜住）；
2. 事件用 `event.composedPath()[0]` 解出**被 Shadow DOM 重定向前**的真实元素，焦点用
   `shadowRoot.activeElement` 一层层下钻；
3. **封闭（closed）Shadow DOM** —— 隔离世界完全看不见里面的节点 —— 由主世界小助手
   `content/agent.js`（`world: "MAIN"`，`document_start`）代读代写：它只做一件事，把页面自己创建的
   shadow root 记在一个 `WeakMap` 里（补丁**保持原语义**），然后按隔离世界的请求读/写那个输入框。
   这条通道里流动的文本本来就在页面的 DOM 里，不引入新的信息暴露面。

安全边界：**跳过** `password` / `email` / `tel` / `number` 等非文本输入、`autocomplete` 里的 `cc-*`
与一次性验证码、`readonly` / `disabled`、只读富文本，以及被标记 `data-lt-skip` 的区域（影子根里同样生效）。

**转写没反应怎么办**：按了快捷键但找不到输入框时，侧边栏「设置 → 输入框转写」卡片会直接说出原因
（不再是「按了没反应」）。想看细节就点同卡片里的 **「自检当前输入框」** 按钮。
它会问一遍这个标签页里**每一层 frame**（页面本身 + 里面的所有 iframe），逐行列出：谁有焦点、
谁「有目标」、目标是什么（普通元素 / 封闭 Shadow DOM）、**读到了几个字**。
如果报告里某层写着「目标：有、读到字符数 > 0」，说明扩展看得见那个输入框；
如果全是「目标：无」，把这份报告发给我就能直接定位。

三种模式（侧边栏「设置 → 输入框转写」）：

| 模式 | 行为 |
| --- | --- |
| `button`（默认） | 只显示小浮标，点它或按快捷键才转写 |
| `auto` | 输入够长就自动弹出面板，边输边译跟到底 |
| `off` | 完全不介入 |

「不自动弹出的网站」列表：面板里 **Shift + 点 ✕** 可一键把当前站点加进去（侧边栏可编辑/清空）。

### 双语对照（原文下方插入译文）

整页翻译有**三种显示方式**（侧边栏「设置 → 整页翻译 → 显示方式」，或面板/右键菜单里的专用按钮）：

| 显示方式 | 效果 | 适合 |
| --- | --- | --- |
| **替换原文** | 直接把页面文字换成译文，可一键还原 | 只想看译文、快速扫读 |
| **双语对照** | **原文一个字符都不动**，在**每一段下方插入译文** | 对照阅读、核对术语、学习语言 |
| **悬停对照** | 不改动页面，鼠标停在段落上才在气泡里显示 | 只想扫一眼、不想破坏原文 |

双语对照的实现要点（`content/main.js` 里的 `applyDual()`）：

- **按段落分组翻译**：一个块（`<p>` / `<h1>` / `<li>` / `<td>`…）里的文本节点拼成一段原文再送进模型，
  上下文完整，译文比逐节点翻译连贯得多；
- **原文零改动**：只往页面里**追加**一个 `<div class="lt-dual-translation">`，不移动、不修改任何原有节点，
  所以「还原原文」= 把追加的节点摘掉，DOM 与翻译前一模一样（测试里逐字节比对过 `body.innerHTML`）；
- **插入位置**：默认插在段落**后面**；对 `<li>` / `<td>` / `<th>` / `<blockquote>` / `<caption>` 这些
  「不能塞块级兄弟节点」的容器则插在**元素内部**，免得把列表项挤出列表、把单元格挤出表格行；
- **不会自我循环**：插进去的译文带 `data-lt-dual` 标记，收集文本时会被排除，动态内容跟进也不会二次翻译；
- **标题里不会串味**：样式强制 `font-size: .95em; font-weight: 400`，插在 `<h2>` 下方也是一行正常的正文，
  只用左侧一条 2px 细线做区分（深色模式单独调过色）；
- 翻译完依然**跟进动态内容**（评论、无限滚动），新出现的段落同样会加上译文。

### 悬停对照
侧边栏「悬停对照」按钮 或 右键菜单「悬停对照翻译」：不改动页面，鼠标停在段落上时用气泡显示译文 —— 适合「只想扫一眼、不想破坏原文」的场景（比如填表、写代码、对照阅读）。

### 快捷键（可在 `chrome://extensions/shortcuts` 修改）

| 快捷键 | 作用 |
| --- | --- |
| `Alt+Shift+T` | 翻译整个页面 |
| `Alt+Shift+S` | 翻译选中内容 |
| `Alt+Shift+R` | 还原页面原文 |
| `Alt+Shift+Y` | 打开侧边栏 |
| `Alt+Shift+Enter` | 输入框转写：直接转写当前输入框并按设置写入（**页内快捷键，不占扩展命令名额**） |

> 为什么转写只有一个快捷键、没有第二个？**Chrome 硬性限制：带默认快捷键的命令最多 4 个**
> （`Too many shortcuts specified for 'commands': The maximum is 4.`）。上面 4 个默认键已经用满，
> 所以「转写当前输入框里的内容」这个命令默认不占键 —— 页内 `Alt+Shift+Enter` 照常可用；
> 想换别的键，去 `chrome://extensions/shortcuts` 手动绑定即可。

### 自动翻译
侧边栏「设置 → 整页翻译」：

- 打开网页时自动翻译（默认关）
- **自动翻译的网站**白名单（每行一个域名，留空=所有网站）
- **永不翻译的网站**黑名单
- 最少正文字数阈值（默认 300 字，避免翻译落地页）

---

## 4. 设置项

| 设置 | 说明 |
| --- | --- |
| **引擎** | `自动`（推荐）→ 内置翻译模型优先，语言对不支持时自动用 Gemini Nano；也可强制指定其中一条链路 |
| **语气 / 风格** | 忠实原文 / 自然地道 / 正式书面 / 口语轻松 / 技术文档 / 学术严谨（**仅 Nano 链路**） |
| **术语表** | 每行 `原文=译文`（也支持 `原文 => 译文`、`原文→译文`、`原文 : 译文`）。例：`Gemini Nano=双子星纳米`。改完点一下「重置 Gemini Nano 会话」生效 |
| **翻译背景** | 一段语境说明（如「这是 React 更新日志」），帮模型选对词义；这段文字本身不会被翻译 |
| **划词翻译** | 是否弹气泡、双击单词也翻译 |
| **输入框转写** | 开关、模式（浮标 / 自动展开 / 关闭）、转写目标语言、快捷键动作（替换 / 追加 / 只复制）、最少字数、不自动弹出的站点 |
| **并发请求** | 1~4，整页翻译的并行度；默认 2（省电且不抢资源）|
| **缓存** | 同一句话只翻一次（内存 LRU + `chrome.storage.local` 持久化），可一键清空 |
| **主题** | 跟随系统 / 浅色 / 深色 |

---

## 5. 工作原理

```
┌──────────────── 页面（content script: util.js / ui.js / main.js）────────────────┐
│  选区监听 → 气泡 UI(Shadow DOM)        收集文本节点 → 批量翻译 → 写回 → 可还原     │
│  输入框聚焦 → 🌐 转写浮标/面板(Shadow DOM) → 流式译文 → 替换/追加/还原输入框        │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                │ chrome.runtime.sendMessage（只传文本）
┌───────────────────────────────▼────────────────────────────────────────────────┐
│                    background.js（Service Worker, MV3 module）                  │
│  消息路由 · 右键菜单 · 快捷键 · 每标签页状态 · 流式端口(connect)                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐ │
│  │ 宿主选择：优先 SW 直连内置 AI；拿不到就切到离屏文档（offscreen document）   │ │
│  └───────────────┬───────────────────────────────────────────┬───────────────┘ │
│                  ▼                                           ▼                 │
│        lib/engine.js（SW 内）                      offscreen/offscreen.js       │
│        ├── Translator API  链路                     └── 同一套 lib/engine.js     │
│        └── Gemini Nano 链路                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **推理只在扩展自己的上下文里做**，页面脚本拿不到模型权限，扩展也只把文本发给自己的后台（同进程内，不上网）。
- **分段策略**：`段落 → 句子 → 硬切` 三级切分，按 `inputQuota` 动态调上限（CJK 约 480 字 / 拉丁约 1100 字），段内用空格拼接，段间用空行 —— 这样长文不会撞配额，也不会把段落挤成一段。
- **合并细节**：中文之间不插空格，拉丁文之间插空格（`needsSpace`），避免出现 `你好 世界` 这种怪东西。
- **缓存键** = `引擎|源>目标|改写参数hash|文本hash`（FNV-1a），Nano 链路会把语气和术语表算进键里，改术语表不会命中旧译文。
- **降级链**：`内置翻译模型 → Gemini Nano → 明确报错`，每一步失败原因都会翻译成人话（比如「首次使用需要下载语言包，请点击按钮确认下载」）。
- **为什么还需要离屏文档**：内置 AI 需要一个「负责文档」做权限/策略检查，规范里 Web Worker 一律不可用，扩展 Service Worker 能不能用取决于 Chrome 版本。所以 `background.js` 会先试 SW，若报 `no-api` / `no-nano` / `NotAllowedError`，就自动把请求转给隐藏的 `offscreen.html`（它跑的是同一套 `lib/engine.js`），用户无感。
- **模型下载进度**：`monitor(m => m.addEventListener('downloadprogress', ...))` 的事件会一路冒泡到侧边栏的进度条。

---

### 5.0 扩展被重载之后（为什么会出现「Extension context invalidated」）

在 `chrome://extensions` 点「刷新」之后，**已经打开的页面**里那份内容脚本会立刻与扩展失联：
它的 JS 还在跑、DOM 还在，但任何 `chrome.runtime.*` / `chrome.storage.*` 调用都会抛
`Extension context invalidated.`，而且**它自己无法重新连上** —— 这是 Chrome 的设计，不是 bug。

本扩展的处理（v1.5.2）：

- 每次交互顺手读一次 `chrome.runtime.id`（极廉价的属性访问），发现失效就立刻「退场」：
  收起浮标、停止一切后台调用，不再反复抛错；
- 页面上弹出一张提示卡（左下角，红色）：**「扩展已被重新加载」+ 一键「刷新页面」按钮**；
- 报错文案一律转成中文说明，绝不把英文异常抛给用户；
- 如果此刻是你按了快捷键/点了侧边栏按钮：后台发现「页面里连一个活的接收端都没有」时会**自动往该标签页
  重新注入一份脚本**，于是很多时候连刷新都不用，功能自己就恢复了（重新注入发生在下一次你要用它的时候，
  它不会在扩展加载的那一刻平白往所有页面里塞脚本）；
- 页面里若有**一部分** frame 还活着，Chrome 就可能不报「接收端不存在」，这条自动恢复也就不会触发 ——
  此时按提示刷新页面即可，两条路都不会出现红字报错；
- 新脚本启动时会清掉上一次实例残留的 UI（`[data-lt-ui]` 宿主），所以不会出现两个浮标/两条进度条。

### 5.1 会话生命周期（一个容易踩的坑）

原生 `Translator` / `LanguageModel` 实例是**长命**资源，创建一次要复用；但它们的 `create()` 接受一个
`AbortSignal`，而规范里有一句很关键的话：

> 如果 `abort()` 在 `create()` 兑现**之后**被调用，效果等同于 `Translator.destroy()`：
> 实例被释放，任何进行中和后续的方法调用都会以 `AbortError` 失败。

所以「把每次请求的 signal 一路传进 create()」是个陷阱 —— 只要应用层会 abort 上一次请求
（我们为了「边输边译」必须这么做），第二次请求就会把第一次建好的会话弄死，而且是**永久的**
（死实例还在池子里）。本扩展现在的做法：

- **会话作用域**：池里的每个实例有自己独立的 `AbortController`，只有「重置本地会话」才会 abort 它；
- **请求作用域**：`translate()` / `translateStreaming()` / `prompt()` 都单独传当次的 signal，
  取消只影响这一次调用，不影响会话；
- **自愈**：任何 `AbortError` / `InvalidStateError` / 「destroyed」类错误，自动摘掉池里的实例并重建重试一次；
- **后台**：只中止「还在跑」的上一个请求；被后来请求取代的请求，其错误不再弹给用户看。

---

## 6. 已知限制（基本都是 Chrome 的限制，不是本扩展的）

- 需要 **Chrome 138+ 桌面版**；Firefox / Safari / 移动端不支持（Edge 148+ 可用 Translator API，但本扩展的 UI 依赖 Chrome 的 `sidePanel` 等 API，未做适配）。
- 内置 AI 是分语言对的：**Chrome 不支持的组合会返回 `unavailable`**，此时自动走 Gemini Nano；两条都不可用会明确报错（侧边栏「设置 → 诊断」里能看到逐语言对的状态表）。
- 首次下载语言包**必须有用户手势**（见第 2 节）。
- Gemini Nano 有硬件门槛（>4GB 显存，或 16GB 内存 + 4 核；磁盘至少 22GB 可用），达不到就没有 Nano 链路，但翻译专家模型通常仍可用。
- 页面翻译（划词/整页）只处理**可见文本节点**，不做图片 OCR、不处理 Canvas 内文字；整页翻译只作用于**顶层文档**，
  iframe 内部不翻（框架内那种「一整块第三方内容」通常也不希望被翻）。**输入框转写不受此限**：每个 frame 都注入，弹窗 iframe 里的输入框照样能用。
- **封闭（closed）Shadow DOM** 里的输入框依赖主世界小助手（`content/agent.js`）往返一次探测后才开始工作，
  第一次聚焦时比普通输入框**多几十毫秒**；如果站点把整个页面都塞进封闭影子根、或者 CSP 拦住了主世界脚本，会退化回「只支持开放影子根」。
- 极少数站点（CSP 严格 + 大量动态渲染）可能出现部分段落未翻译，可再点一次「翻译整页」补翻新增内容。

---

## 7. 排障

| 现象 | 处理 |
| --- | --- |
| 提示「点击按钮确认下载」 | 到侧边栏「页面 → 本地模型」点「下载当前语言对的语言包」 |
| 提示「不支持这个语言对」 | 换 Gemini Nano 引擎（侧边栏「设置 → 引擎」），或换目标语言 |
| **下载失败：Chrome 内置模型不支持这个语言对。（Unable to create translator for the given source and target language.）** | 见下面 §7.1：这是 `create()` 阶段的 `NotSupportedError`。先点侧边栏的「改用 Gemini Nano 引擎」（一键可用），再按需修复语言包 |
| **Failed to load extension / Too many shortcuts specified for 'commands': The maximum is 4.** | 清单里带 `suggested_key` 的命令超过 4 个。改完 `manifest.json` 后在 `chrome://extensions` 点刷新即可；本仓库的 `npm run validate` 会提前拦住这类错误 |
| **弹窗 / 对话框里的输入框不出浮标、快捷键没反应** | 先确认版本 ≥ **1.4.0**（`chrome://extensions` 应显示 1.4.0；改完代码要**先点刷新再重新加载页面**）。还不行请告诉我**具体网址**和输入框所在位置：是 `www.example.com` 页面本身、还是页面里嵌的 iframe（弹窗常见）、还是组件库的 Shadow DOM。临时自检：在页面里选中那个输入框后按 `Alt+Shift+Enter`，看侧边栏「输入框转写」卡片的状态行报了什么 |
| 刚打开页面就点「翻译整页」，偶尔回一句「尚未加载设置」（v1.5.2 已修） | 初始设置是异步向后台要的，用户动作可能跑在它前面。现在会先等一小会儿（最长 4 秒）再动手，不把内部状态丢给用户 |
| 页面刚打开时改过目标语言，结果又被「旧设置」改了回来（v1.5.2 已修） | 迟到的初始设置会整体覆盖内存里的设置。现在改成「合并 + 显式改动优先」：晚到的基线只补缺的键，不覆盖你刚改过的键 |
| 提示「完成：成功 0 段，失败 3 段」但页面明明翻译了（v1.5.2 已修） | 替换模式下统计失败数的回调没有返回值，`if (!结果) failed += 1` 就把每一段成功都算成了失败。现在替换模式明确返回布尔值，计数正确 |
| **转写第一次正常、第二次开始报错**（v1.5.1 已修） | 这是会话生命周期的 bug：请求的 `AbortSignal` 被传进了 `Translator.create()`，而按规范「创建兑现之后再 abort 这个 signal = `destroy()`」；后台每次新请求又会 abort 上一个请求的 controller，于是第二次就把缓存里的翻译器弄死了，而且死实例留在池子里 → 之后次次失败。现在会话有自己的作用域、请求 abort 只作用于单次调用，另外任何「会话已死」的错误都会自动重建重试一次。仍然卡住的话点设置里的 **「重置本地会话」** |
| **转写时报 `Extension context invalidated.`** | 这不是翻译出错，而是「页面上的脚本和你刚重载的扩展失联了」：在 `chrome://extensions` 点「刷新」或扩展自动更新后，**已经打开的页面**里那份内容脚本会立刻失效，而且它自己无法重连。v1.5.2 起扩展会识别这种情况：页面上弹出「扩展已被重新加载」的提示卡，里面有一个 **「刷新页面」** 按钮；再按快捷键时后台也会自动往该标签页**重新注入**一份新脚本，通常不用手动刷新就能继续用。彻底恢复：刷新页面（F5）。v1.5.3 又补了两类旆漏：个别 Chrome 版本在失效后「既不回话也不报错」（转写面板永远转圈）→ 现在 10 秒内探测到上下文已死就给出同样的提示；以及侧边栏/弹窗里英文报错 → 也统一换成人话 |
| 内置模型显示「不可用」 | `chrome://on-device-internals` → **Model Status** 看错误；必要时重启 Chrome、检查磁盘空间与网络（需非计费连接） |
| **Prompt API 报 `The sampling options are incompatible with speculative decoding (MTP)...`**（v1.5.6 已修） | 新版 Chrome 开启推测解码（MTP - Speculative Decoding）时，强制要求 Prompt API 显式指定兼容的采样选项（如 `samplingMode: 'most-predictable'`、`topK: 1` 或 `temperature: 0`）。当 Translator API 遇到不支持的语言对自动回退 Nano、或直接使用 Nano 时，扩展现在会自动采用 `most-predictable` 贪婪采样与分层兼容降级策略，在所有 Chrome 版本下都能顺利创建会话 |
| Nano 显示「不可用」或突然失效（v1.5.3 已修） | 两个原因：① 会话创建硬编码 `temperature=0.2` + `topK=3`，而规范要求扩展里这两个参数必须成对出现且不超过 `LanguageModel.params()` 的上限，各 Chrome 版本上限不同 —— 现在先查 `params()` 再传参，取不到就完全不带采样参数；② 无参的 `availability()` 探测与实际创建选项不一致时，部分版本会报 `unavailable` —— 现在探测时会用与创建一致的模态声明重问一次。仍不可用则检查硬件要求；`chrome://components` → `Optimization Guide On Device Model` 是否已下载；或 `chrome://flags/#prompt-api-for-gemini-nano` |
| Nano 显示「不可用」，但模型其实能下载（v1.5.4 修） | 还有两类漏报：① 个别 Chrome 版本对**无参** `availability()` 直接抛错或报 `unavailable`，现在探测时会依次用「无参 → 带模态声明 → 老版 `capabilities()`」三种方式重问，任何一步乐观就采用；② 个别版本在 Service Worker 里**看不见** Prompt API（但扩展页面看得见）—— 现在后台探测不到时会再问一次离屏文档、侧边栏也会用本页能力补齐，不再误报。若状态是「待下载」，点本地模型卡片新增的 **「让 Chrome 下载 Gemini Nano」** 按钮即可触发模型本体下载（约 2~4GB）；按钮失败时自动再试后台与离屏宿主，并给出 `chrome://components` / 硬件要求的逐步指引 |
| 「让 Chrome 下载 Gemini Nano」按钮点了没反应 / 失败（v1.5.5 增强） | 失败提示里新增了两个按钮 **「打开 chrome://components」** 和 **「打开 on-device-internals」**，一键跳转，不用手动敲地址栏；同时会自动读一遍本机能检测到的信号（CPU 核心数、近似内存、当前来源的存储配额）并给出结论——**注意显存大小 JS 拿不到，这条仍需你自己确认**；如果 CPU/内存/配额三项都达标却还是不可用，大概率是显存不足或该 Chrome 渠道/地区还没推送模型，去 `chrome://components` 看 `nano_v3_gpu_component` 的状态是决定性证据 |
| 翻不动某些页面 | `chrome://`、Chrome 应用商店、部分 PDF 内部页面不允许注入脚本 |
| 想确认到底走的是哪条链路 | 侧边栏「设置 → 诊断」，或看译文气泡上的引擎徽标；气泡旁的速度也会显示 |
| 看后台日志 | `chrome://extensions` → 本扩展 → **Service Worker** / **离屏文档** / **检查视图** 可打开 DevTools |
| 改了术语表没生效 | 点「重置 Gemini Nano 会话」（会话是带系统提示词的，需要重建） |

---

### 7.1 为什么 `availability()` 说「已就绪」，`create()` 却报「不支持这个语言对」？

这两个方法回答的**不是同一个问题**：

| 方法 | 回答的问题 | 特点 |
| --- | --- | --- |
| `Translator.availability({sourceLanguage, targetLanguage})` | 「Chrome **有能力**支持这个语言对吗？」 | 静态能力查询，不需要文档、不需要手势；而且官方文档明确写：**Chrome 会刻意模糊语言包的下载状态**（"all language pairs are reported as downloadable until individual sites create a translator for a given pair"），所以它偏乐观 |
| `Translator.create({...})` | 「我现在**真的能创建一个**该语言对的翻译实例吗？」 | 运行时操作：需要「最近有用户交互的文档」（transient user activation）、需要 Permissions-Policy 允许、需要语言包可获取 |

所以「已就绪 + 创建失败」的组合，通常来自这三类原因（按出现频率排序）：

1. **调用发生在没有文档 / 没有用户手势的上下文**（最典型：扩展的 Service Worker、Web Worker）。
   规范与 MDN 都写明创建 `Translator` 需要 transient user activation；SW 里两者都不存在。
   → 本扩展的处理：①「下载语言包」按钮现在**在侧边栏自己的文档里**执行（那里有真实点击手势）；
   ② 后台翻译失败时会自动切到离屏文档 / Gemini Nano；③ 侧边栏「设置 → 诊断 → 分环境自检」会把
   「侧边栏」与「后台」两个上下文的 `availability` / `create` 结果并列打出来，一眼就能看出是不是环境问题。
2. **该语言对的语言包在 Chrome 侧没启用**。语言包由 `chrome://components` 里的 **Chrome TranslateKit** 组件提供：
   - 打开 `chrome://components` → 找 **Chrome TranslateKit** → 点「检查更新」；
   - 若 `chrome://flags/#translation-api` 存在 **Enabled without language pack limit** 选项，选中后重启 Chrome 可解锁更多语言对；
   - 换个语言对（如 英语→日语）验证一下：只有某一个对失败 = 语言包问题，而不是扩展问题。
3. Chrome 组件状态异常（少见）：更新 Chrome、重启、`chrome://on-device-internals` 看模型状态。

**不管哪种原因，你都可以立刻继续用**：把引擎切成 **Gemini Nano**（侧边栏「设置 → 引擎」，或下载失败后点弹出的「改用 Gemini Nano 引擎」按钮）。
Nano 是通用模型，翻译质量略逊于专用翻译模型，但在你的机器上「已就绪」，不需要任何语言包。

## 8. 隐私

- 没有任何网络请求，扩展没有声明任何 `host_permissions` 之外的对外访问（只读页面文本）。
- 文本只在「页面 → 扩展后台 → 本地模型」这条进程内链路上流动，**不经过任何服务器**。
- 译文缓存保存在你本机的 `chrome.storage.local`（可随时清空）。
- 唯一的权限：`storage`（设置/缓存）、`contextMenus`（右键菜单）、`scripting`+`activeTab`+`<all_urls>`（注入翻译脚本）、`sidePanel`、`offscreen`（推理宿主）。

---

## 9. 项目结构

```
chrome-local-translate/
├── manifest.json              MV3 清单（Chrome 138+）
├── background.js              Service Worker：路由 / 宿主选择 / 菜单 / 快捷键
├── offscreen/                 备用推理宿主（真实 document 上下文）
│   ├── offscreen.html
│   └── offscreen.js
├── lib/
│   ├── engine.js              核心：两条本地链路 + 分段 + 缓存 + 降级 + 流式
│   ├── languages.js           语言表 / 代码归一化 / 离线启发式语言识别
│   ├── frames.js              多 frame 路由判定（认领有效期 / 应答打分 / 自检汇总）
│   └── settings.js            设置读写（sync + local）
├── content/
│   ├── util.js                页面侧工具（语言名、站点匹配、文本过滤）
│   ├── ui.js                  Shadow DOM 气泡（可拖动 / 记忆位置）+ 进度条
│   ├── inline.js              输入框转写：浮标 / 面板 / 流式 / 写入 / 还原（含影子根/iframe）
│   ├── agent.js               主世界小助手：只负责读写封闭 Shadow DOM 里的输入框
│   ├── main.js                划词/整页/悬停/自动翻译 + 还原 + 动态跟进（仅顶层 frame 管 UI）
│   └── content.css
├── options.html               选项入口（跳转到侧边栏的「设置」标签页）
├── sidepanel/                 侧边栏（文本 / 页面 / 设置 三个标签页）
├── popup/                     工具栏弹窗（快速翻译）
├── demo/ui-preview.html       免安装的界面预览（自包含）
├── icons/                     图标（由 tools/make_icons.py 生成）
├── tests/
│   ├── run-tests.mjs          单元测试（Node，零依赖）
│   └── test-ui-dom.mjs        DOM 交互测试（jsdom，可选依赖）
└── tools/
    ├── make_icons.py          生成图标
    ├── validate-manifest.mjs  清单体检（快捷键上限 / 文件引用 / 权限 / 描述长度…）
    └── build-preview.mjs      把内容脚本打包成预览页
```

## 10. 开发 / 测试

```bash
npm run validate             # 清单体检：快捷键数量上限、文件引用是否存在、权限名、内容脚本能否是 ESM…
npm test                     # 先跑 validate，再跑 42 个用例：分段、缓存、降级、错误映射、流式、术语表、自检、位置钳制…
npm run test:dom             # 59 个用例：在 jsdom 里跑真实的内容脚本（拖动 / 位置记忆 / 整页还原 / 输入框转写 / 影子根 / 上下文失效）
LT_ONLY="关键字" npm run test:dom   # 只跑名字里含该关键字的用例，排障时用
npm run test:all             # 上面两个都跑
npm run preview              # 重新生成 demo/ui-preview.html
npm run icons                # 重新生成图标
```

`test:dom` 需要 jsdom（可选依赖）：`npm i -D jsdom`；没装会自动跳过，不影响 `npm test`。
它把 `content/agent.js`、`content/util.js`、`content/ui.js`、`content/inline.js`、`content/main.js` 原样加载进 jsdom，
用一个假后台（含假流式端口）应答，所以测的是**真实交互代码**，而不是复制出来的简化版：

- 气泡：拖动跟手、视口钳制、松手落盘、⌖ 取消固定、双击标题栏、新页面恢复上次位置、越界位置被钳回
- 整页：翻译后原文可完整回滚、目标语言与页面一致时跳过
- 转写：输入后出现浮标、跳过密码/邮箱/只读框、点浮标后流式出译文、替换并派发 `input` 事件、
  还原原文、追加模式、`input` 里的换行被压成空格、`Alt+Shift+Enter` 直接替换、`copy` 模式不动输入框、
  `off` 模式不介入、站点黑名单、自动展开模式、切换目标语言后重新翻译、面板拖动钳制、Esc 关闭
- 影子根：**开放**影子根里的输入框照样浮标/替换/还原；**封闭**影子根靠 `agent.js` 代读代写
  （测试里手工派发带 `source` 的 `MessageEvent`，模拟真实浏览器里的同窗口 `postMessage`）；
  密码框在封闭影子根里同样被跳过；`agent.js` 没注入时优雅降级，不影响普通输入框
- 焦点保护：点浮标 / 面板按钮时阻止 `mousedown` 默认行为（不把输入框的焦点抢走，弹窗不会因此关掉），
  但语言下拉必须放行，否则点不开
- 1.4.1 的回归用例：**面板自己的译文框不许被当成输入框**、面板打开后仍能读到页面输入框的内容、
  打字时会向后台认领 frame、`hasFocus` 为 false 时点对点指令照样执行、探路模式绝不动输入框、
  富文本编辑器（`contenteditable`）的目标落在编辑器根上（整篇读、整篇替换）
- 双语对照：原文零改动、译文插在段落下、还原后 `body.innerHTML` 与翻译前逐字节一致、重复翻译不叠加、
  译文不会被二次翻译、`<li>`/`<td>` 的译文插在元素内部、从双语切回替换模式时旧译文被清掉
- 转写连续多轮都正常（第二轮不再报错）、上一轮还在流式输出时又触发一次不会互相污染
- **会话生命周期回归**（用严格按规范实现的假 Translator：兑现后 abort ≈ destroy）：
  「abort 上一次请求不会弄死已缓存的翻译器」「坏实例自动重建重试」「用户主动取消除外不重试」
  「Nano 会话不再绑定请求 signal」
- **扩展上下文失效回归**：「报的是人话并给出刷新出口」「脚本自我停摆不再反复报错」「翻译跑到一半扩展被重载
  也会返回可读的失败原因（带 `context-invalidated` 错误码）」「派发前就已失效则不假装能干活」
  「扩展重载后重新注入脚本会清掉旧实例残留的 UI（不会出现两个浮标）」

测试用「假 Translator / 假 LanguageModel」模拟浏览器行为，覆盖了：无 API 时的报错、语言包下载进度、`NotAllowedError` 映射、**`create()` 抛 `NotSupportedError` 时区分错误码并自动回退 Nano**、`selftest()` 的 availability/create 双结果、长文本分段与拼接、批量翻译的局部失败、AbortSignal 中断、流式两种语义兼容、气泡拖动时的视口钳制数学等。v1.5.4 起还覆盖：Nano 探测的三级兑底（无参抛错 / `unavailable` → 模态声明 → `capabilities()`）与 `ensureNanoModel()` 的就绪确认、下载进度、拒绝下载报 `need-gesture`、缺 API 报 `no-nano`。

顺带一提：`test:dom` 里有两类用例抓到过真实 bug —— 「拖动后立刻点 ⌖」这个竞态 —— 位置是异步从 storage 读回来的，
如果用户在读取返回前就拖动或取消固定，迟到的读取会把位置改回去；现在用 `posTouched` 标记丢弃过期结果。

## 11. 想继续改？几个自然的扩展点

- `lib/engine.js` 的 `buildSystemPrompt()`：换一版自己的翻译提示词（比如「保留 Markdown 结构」「输出 JSON」）。
- 想让 Nano 也更省电：`nanoChunkChars()` 调大分块、`concurrency` 调到 1。
- 加「词典模式」：在 `translate()` 里对单词输入走 `explain()`，输出词性 + 释义。
- 加「生词本」：把划词记录写进 `chrome.storage.local`，在侧边栏加一个标签页。
- 想要真流式的整页翻译：`engine.js` 已导出 `translateStream()`，可把 `content/main.js` 的批处理换成流式写回。

## 参考

- Chrome 文档：Translator API <https://developer.chrome.com/docs/ai/translator-api>
- Chrome 文档：Prompt API（Gemini Nano）<https://developer.chrome.com/docs/ai/prompt-api>
- Chrome 文档：Extensions and AI <https://developer.chrome.com/docs/extensions/ai>
- W3C 提案：Translator and Language Detector APIs <https://github.com/webmachinelearning/translation-api>
