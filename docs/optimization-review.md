# 优化建议清单（代码评审）

对照当前代码（v1.5.0，6854 行 JS）逐条看下来，挑出**确实存在问题**的地方，按「影响 × 修复成本」排序。
每条都标了文件/位置、为什么是问题、怎么改。

> **后续进展**：1.5.2 在排查「整页翻译偶发失败」时，又通过测试跑环额外抓到并修掉了 3 个真 bug
> （都不在这份清单里）：① 替换模式的统计回调没有返回值 → 每段成功都被计成失败；
> ② 初始化设置是异步取的，用户动作可能跑在它前面 → 偶发「尚未加载设置」；
> ③ 迟到的初始设置会整体覆盖内存里的设置 → 用户刚改的目标语言被改回去。
> 清单里的 A1–A7 / B1–B5 / C1–C6 / D1–D6 **仍然未修**。

---

## A. 是真 bug 或隐患，建议优先修

### A1. 双语对照会把译文插进 `<button>` / `<label>` 里面 ★
`content/main.js:251` 的 `INSERT_INSIDE` 里有 `BUTTON` / `LABEL` / `SUMMARY` / `OUTPUT`。

`<button>` 按 HTML 内容模型只允许**短语内容**，塞一个块级 `<div>` 进去会：
- 按钮被撑成两行、左侧多出一条竖线（我们的样式有 `border-left`），视觉直接崩；
- 按钮里的文字变成两块，某些站点按 `textContent` 做判断的逻辑会失配。

**改**：这几个标签从 `INSERT_INSIDE` 里去掉，并把 `BUTTON / LABEL / SUMMARY / OPTION / SELECT / NAV` 加入
双语模式的**跳过名单**（它们是 UI 铬件，不是正文）。顺带在「替换模式」里也建议对 `BUTTON` 谨慎——按钮文案被换掉会让用户找不到「提交」「下一步」。

### A2. 极端情况下译文会被追加到 `<body>` 最末尾
`content/main.js:222` 的 `blockOf()`：

```js
while (el && el !== document.body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
return el || node.parentElement || document.body;
```

如果一段文字只被内联元素包着、直接挂在 `<body>` 下（`<span>…</span>` 之类），循环会在
`el === document.body` 时退出并**返回 BODY**；而 `BODY` 又在 `INSERT_INSIDE` 里 → `applyDual` 会
`appendChild`，译文被插到整个页面最底部，跟原文离了十万八千里。

**改**：`blockOf` 遇到 BODY/HTML 时退回 `node.parentElement`，并在 `applyDual` 里对 BODY/HTML
走「插到最后一个非译文子节点之后」的逻辑，而不是 `appendChild`。

### A3. 弹窗（`<dialog>`）正文不会被整页翻译
`content/main.js:31` 的 `SKIP_TAGS` 里有 `DIALOG`。也就是说：**模态弹窗里的文字，整页翻译一律跳过**，
用户会觉得「页面没翻全」。动态跟进（MutationObserver）也救不了，因为它是 `acceptTextNode` 层被排除。

**改**：从 `SKIP_TAGS` 去掉 `DIALOG`（或只在双语模式下保留），让动态跟进负责弹窗内容；
如果是有意为之，README 的「已知限制」里必须写明，否则会被当成 bug 反复报。

### A4. 离屏文档重复实现了批量翻译（两份逻辑会漂移）
`offscreen/offscreen.js:54` 自己写了一套 `translateBatch`（并发 2、逐条 try/catch、错误映射），
而 `lib/engine.js:869` 早就有 `translateMany()`（带缓存、并发控制、`onItem` 回调、同样的错误映射）。
现在等于同一件事有两份实现，改一处忘一处就会不一致——这类漂移是维护成本的主要来源。

**改**：`offscreen.js` 直接 `import { translateMany }`，`case 'translateBatch'` 改成一行调用。
（这也是我上一轮遗留的「待核实项」，现在核实了：它确实没用上 `translateMany`。）

### A5. 主世界助手的 `postMessage` 通道没有令牌校验
`content/agent.js:204` 只判断 `event.source === window`，不校验消息来源。任何页面脚本都能构造
`{__lt_agent_req:true, action:'write', hostId:…, text:…}` 驱动我们的助手去写它自己创建的影子根。

严格说**不构成新的权限提升**（页面脚本本来就能直接操作自己的 shadow root），但这是一条不必要的
可信边界：它把「谁在写这个输入框」这件事变得不可区分，将来如果有人给助手加能力（比如跨影子根遍历），
就会立刻变成真漏洞。

**改**：注入时生成一次性 nonce，通过 `document.documentElement.dataset` 或第一条消息传递；
助手只应答带正确 nonce 的请求，并且严格校验字段类型。约 20 行。

### A6. 混合语言页面：已经是目标语言的段落也照翻
现在只在整页开始时检测一次语言（`content/main.js` 的 `samplePageText`）。
中文页面里夹的英文引用、代码注释、外语站名等会被一并「翻译」成中文，既费算力又出噪音
（比如已经把中文原文再翻一遍）。

**改**：逐段用 `U.roughScript()`（已有）或 `LanguageDetector` 做一次廉价判定，与目标语言同脚本的段落直接跳过；
在面板里加个开关「跳过已是目标语言的段落」（默认开）。

### A7. 版本号曾经漂移，但没人拦
上一轮就出现过 `manifest.json` 是 1.4.0、`package.json` 还是 1.3.1 的情况。
`tools/validate-manifest.mjs` 现在**没有**这条检查（`grep package.json` = 0 处）。

**改**：validate 里加 5 行——读 `package.json`，断言 `version` 相等，不等就 `fail()`。
同类检查还可以加：`lib/engine.js` 里 `MIN_CHROME` 与 manifest 的 `minimum_chrome_version` 一致。

---

## B. 性能与体验

### B1. 整页翻译是「一口气全页」，长文档又慢又费电 ★
3000 个节点、每批 20 条、并发 2 —— 一篇长文要跑几分钟，期间 CPU 持续占用，且**不能取消**。
用户能看到的只有一个进度条（其实 `state.token` 已经支持中断，只是没接 UI）。

**改（性价比最高的一项）**：
1. **按视口优先**：先用 `IntersectionObserver` / `getBoundingClientRect` 只翻「当前可见 + 前后一屏」，
   滚动时继续翻下一批。用户 1 秒内就能看到正文译文，而不是等全页跑完。
2. 面板/进度条上加**「取消」**按钮（调用已有的 token 机制）。
3. 双语模式下这个体验差距尤其明显——现在要等全页跑完才「一次性」看到效果。

### B2. 可见性判定可能触发强制同步布局
`content/main.js` 的 `acceptTextNode` 对**每个文本节点**都调 `isVisible()` →
`getClientRects()` + `getComputedStyle()`。在样式脏了的时刻，这会强制整棵树重排；3000 次的量级
值得实测（我建议在面板诊断里加一个 `performance.now()` 计时暴露出来，用真实网页量，别猜）。

**改**：按**块**判定一次（同块内共享），或用 `IntersectionObserver` 的可见集合代替即时计算；
再叠加 B1 的视口优先，这一项的收益会自然被吸收。

### B3. 批内重复文本各翻一次
导航里反复出现的「Home」「Read more」、模板文案，在同一个批次里会**各发一次**翻译请求。

**改**：`buildItems` / `buildBlockItems` 出来后按 `text` 去重，只对唯一文本发请求，回填时按映射展开。
天然和缓存互补（缓存命中是「下一次」，去重是「这一次」）。

### B4. 双语对照缺少「针对性」交互
现在只能「全页插译文」。用户想「这一段不用翻」或「只翻这一段」时没有入口。

**改**：译文块 hover 时显示两个小按钮（🗑 删除这一条 / ⟳ 重新翻译）；再给一个「点段落才翻译」的模式
（配合 B1 的视口优先会更好用）。删除只需从 `state.dualItems` 里摘掉对应项，代价很小。

### B5. 自动翻译的默认值一直悬着
1.3.0 的问法你没回：**整页自动翻译**默认关、**输入框转写**默认 `button`（弹浮标）。
如果你的常用场景就是「外语页面直接看中文」，把 `autoTranslate` 默认打开（白名单为空 = 所有站点）
会让扩展「装上就有用」；代价是某些站点的初次加载会跑翻译。

---

## C. 工程质量（决定以后还能不能愉快地改）

### C1. 缺真实浏览器的端到端测试 ★★
这是目前**最高杠杆**的一项。jsdom 覆盖不到：真实布局、`isContentEditable`、iframe（跨文档）、
真实 `postMessage` 语义、真实 `execCommand`。1.4.0 那个「面板把自己的译文框当成目标」的 bug，
用 Playwright 打开一个真实页面点一下就现形，根本不用你手动复现。

**改**：加 `tests/e2e/`：Puppeteer/Playwright 用 `--load-extension` 启动 Chrome，加载本地
`tests/fixtures/page.html`（含导航、正文、iframe、open/closed shadow root、contenteditable 编辑器），
断言：浮标出现、`Alt+Shift+Enter` 后输入框内容变了、双语模式插入了 N 个 `.lt-dual-translation`、
还原后 `innerHTML` 与初始一致。CI 里跑（需要真 Chrome，本地 `npm run e2e` 手动跑也行）。

### C2. `test:dom` 在没装 jsdom 时静默跳过 → CI 里的「假绿」
`tests/test-ui-dom.mjs` 开头 catch 到缺 jsdom 就 `process.exit(0)`。今天我就踩了一次：
套件显示「跳过」，而我看的是另一条命令的输出。

**改**：加 `--require` / `LT_STRICT=1`（CI 下缺失即失败），并把 jsdom 写进 `devDependencies`
由 CI 统一安装；本地缺了才允许跳过。

### C3. 三个大文件 + 没有类型检查
`content/inline.js` 1552 行、`sidepanel/panel.js` 956、`content/main.js` 805。
内容脚本不能用 ESM（manifest 限制），所以现在是「一个文件一个世界」的结构。

**改（两条路，按意愿选）**：
- 保守：加 `jsconfig.json` + JSDoc 类型标注，`tsc --checkJs --noEmit` 进 `npm test`。
  零运行时改动，就能挡住「函数名写错/参数顺序错/少传参数」——这一轮我就写过一次
  `onMessage is not defined`，正是这类错误。
- 激进：引入 esbuild（~50 行配置）打包 `content/*` 为经典脚本，源码拆成真正的 ES 模块，
  `lib/` 与内容脚本共享代码，顺带得到 tree-shaking 与构建期校验。

### C4. 我们自己的界面只有中文
一个「本地翻译」扩展的 UI 硬编码中文（`sidepanel/panel.html`、`content/inline.js` 的面板文案、
`content/ui.js` 的气泡文案），没用 `chrome.i18n` / `_locales`。

**改**：抽 `_locales/zh_CN` + `en`，`msg()` 包装。对非中文用户（这个扩展的目标人群其实不小）是硬门槛。

### C5. 无障碍与键盘
Shadow DOM 里的 UI 没有 `aria-label` / `role`；转写浮标不能 Tab 聚焦（只有鼠标点）；
面板按钮没有可见的 `:focus-visible` 样式；译文块用颜色区分，深色模式下对比度偏低。

**改**：给按钮补 `aria-label`、浮标用 `<button>` 语义 + `tabindex`、加 `:focus-visible` 样式、
在 `prefers-reduced-motion` 下关掉过渡。

### C6. 消息协议没有单一清单
`lt:*` 现在有 20 多种消息，散落在 background / content / panel / popup / offscreen 里，
靠字符串约定。加一个 `lib/protocol.js` 集中定义类型常量 + 文档注释，能避免拼写错误与「谁该应答」的混乱
（这一轮的 frame 抢答问题，本质就是协议语义不清）。

---

## D. 功能缺口（按性价比排）

1. **只翻正文区域**：用启发式（`<main>`/`<article>`/文本密度的粗略评分）或手动「选择区域」模式，
   跳过导航、页脚、侧栏、Cookie 横幅。双语模式下这是**最影响观感**的一项。
2. **术语表升级**：现在只有纯文本域；支持 CSV/TBX 导入导出、从页面对照里自动收集专有名词
   （`lib/engine.js` 已有 `parseGlossary`）。
3. **站点级细粒度规则**：现在只有「自动翻译/永不翻译」黑白名单；应支持每站点独立的目标语言、
   引擎、是否双语、是否悬停。
4. **设置导入导出**：删扩展/换机器后配置就没了；顺带能当「配置模板」分享。
5. **PDF / 图片文字**：Chrome 内置 PDF 阅读器不可脚本化（`chrome://` 限制），截图 OCR 是另一个量级——
   建议直接写进「已知限制」，不要留悬念。
6. **学习向功能**：逐词对照、生词本、双语朗读（朗读已有 TTS 基础）。

---

## 建议的推进顺序

| 档位 | 内容 | 预估 |
| --- | --- | --- |
| **快修** | A1 A2 A3 A4 A6 A7 + C2 | 半天 |
| **体验** | B1（视口优先 + 取消）、B3、B4 | 1–2 天 |
| **健康** | C1（真浏览器 e2e）→ C6 → C3 | 2–3 天 |
| **产品** | D1（只翻正文）→ D3 → C4 | 视优先级 |

我的建议是先做「快修 + B1 + C1」：快修保证现在不出洋相，B1 让长页面终于能用，
C1 则把「需要你手动验证」这件事变成机器自动验证 —— 前面几轮来回，代价最高的其实一直是这一点。
