/**
 * tools/build-preview.mjs —— 把扩展的内容脚本打包成一个自包含的 demo/ui-preview.html
 *
 * 用途：不安装扩展也能预览「划词气泡 / 整页翻译 / 进度条」的交互。
 *   - 内置一个模拟的 chrome.runtime（假后台）：返回演示译文
 *   - 如果浏览器支持 Chrome 内置翻译模型（Translator API），可点按钮切换为「真实本地推理」
 *
 * 运行：node tools/build-preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const contentCss = read('content/content.css');
const agentJs = read('content/agent.js');
const utilJs = read('content/util.js');
const uiJs = read('content/ui.js');
const inlineJs = read('content/inline.js');
const mainJs = read('content/main.js');

const ARTICLE = [
  ['h1', 'Local translation, entirely on your machine'],
  [
    'p',
    'Chrome ships with a compact translation model and a small language model (Gemini Nano). This page is a preview of the extension UI: it uses the exact same content scripts as the real extension, but with a simulated background worker so you can try the interactions before installing anything.',
  ],
  ['h2', 'How the bubble works'],
  [
    'p',
    'Select any sentence on this page and a bubble appears with the translation, the detected source language, and which local model produced it. The text never leaves this computer: inference happens inside the browser process.',
  ],
  ['h2', 'Whole-page translation'],
  [
    'p',
    'Press the "翻译整页" button above and every paragraph on the page is replaced with its translation, while keeping the original DOM structure intact. One click restores the original text, because every translated node keeps its original value in memory.',
  ],
  [
    'blockquote',
    'A translator that runs locally is not only cheaper, it is also dramatically more private: nothing is uploaded, nothing is queued, nothing is logged.',
  ],
  ['h2', 'Terms and tone'],
  [
    'p',
    'When the built-in translation model is not enough, the Gemini Nano path adds a glossary, a tone preset and page context, which is exactly what technical documentation and shipping copy need.',
  ],
  [
    'p',
    'Try hovering over this paragraph after enabling hover mode: the source text stays in place, and the translation shows up in the bubble instead.',
  ],
];

const SHADOW_SAMPLE = 'The dialog lives inside a closed shadow root.';

const COMPOSE_SAMPLE = 'Hi Sarah, thanks for the quick turnaround on the invoice. Could you also send me the updated delivery schedule for next week?';

const CANNED = new Map([
  [COMPOSE_SAMPLE, '你好 Sarah，谢谢你这么快处理了发票。方便的话，能否再把下周更新后的交付排期发我一份？'],
  ['Local translation, entirely on your machine', '完全在你本机完成的本地翻译'],
  [
    'Chrome ships with a compact translation model and a small language model (Gemini Nano). This page is a preview of the extension UI: it uses the exact same content scripts as the real extension, but with a simulated background worker so you can try the interactions before installing anything.',
    'Chrome 自带一个紧凑的翻译模型和一个小型语言模型（Gemini Nano）。本页只是扩展界面的预览：它使用与正式扩展完全相同的内容脚本，但把后台换成了模拟实现，方便你在安装前先体验交互。',
  ],
  ['How the bubble works', '气泡是怎么工作的'],
  [
    'Select any sentence on this page and a bubble appears with the translation, the detected source language, and which local model produced it. The text never leaves this computer: inference happens inside the browser process.',
    '在本页任意选中一句话，就会弹出气泡：包含译文、识别出的源语言，以及是哪个本地模型产出的。文本不会离开这台电脑——推理发生在浏览器进程内部。',
  ],
  ['Whole-page translation', '整页翻译'],
  [
    'Press the "翻译整页" button above and every paragraph on the page is replaced with its translation, while keeping the original DOM structure intact. One click restores the original text, because every translated node keeps its original value in memory.',
    '点击上方的「翻译整页」，页面上的每个段落都会被替换成译文，同时保持原有 DOM 结构不变。一键即可还原原文，因为每个被翻译的文本节点都在内存里保留了原始值。',
  ],
  [
    'A translator that runs locally is not only cheaper, it is also dramatically more private: nothing is uploaded, nothing is queued, nothing is logged.',
    '本地运行的翻译不仅更省钱，隐私性也好得多：不上传、不排队、不留日志。',
  ],
  ['Terms and tone', '术语与语气'],
  [
    'When the built-in translation model is not enough, the Gemini Nano path adds a glossary, a tone preset and page context, which is exactly what technical documentation and shipping copy need.',
    '当内置翻译模型不够用时，Gemini Nano 这条链路还能加上术语表、语气预设和页面上下文——这正是技术文档和产品文案所需要的。',
  ],
  [
    'Try hovering over this paragraph after enabling hover mode: the source text stays in place, and the translation shows up in the bubble instead.',
    '启用悬停模式后，把鼠标移到这段文字上试试：原文保持不动，译文显示在气泡里。',
  ],
]);

const demoJs = String.raw`
/* ============================ 演示层：假的 chrome.runtime ============================ */
(function () {
  const CANNED = new Map(__CANNED__);
  const listeners = [];
  const DEMO = { real: null, source: 'en', target: 'zh' };
  window.__LT_DEMO__ = DEMO;

  const setReal = (instance) => {
    DEMO.real = instance;
    document.getElementById('demo-real').textContent = '已启用真实内置模型 🟢';
    document.getElementById('demo-real').disabled = true;
  };
  const failReal = (message) => {
    document.getElementById('demo-real').textContent = '真实模型不可用（用演示数据）';
    document.getElementById('demo-real').disabled = true;
    document.getElementById('demo-note').textContent = message;
  };

  async function tryReal(buttonEl) {
    if (!('Translator' in window)) {
      failReal('这个浏览器/这个预览环境里没有 Translator API。装好扩展、在 Chrome 138+ 中打开普通网页即可用真实模型。');
      return;
    }
    try {
      const t = await Translator.create({
        sourceLanguage: DEMO.source,
        targetLanguage: DEMO.target,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            buttonEl.textContent = '下载语言包 ' + Math.round((e.loaded / (e.total || 1)) * 100) + '%';
          });
        },
      });
      setReal(t);
    } catch (err) {
      failReal('调用 Translator.create 失败：' + (err && err.message ? err.message : err));
    }
  }

  async function mockTranslate(text) {
    if (DEMO.real) {
      try {
        return await DEMO.real.translate(text);
      } catch (err) {
        /* 落回演示数据 */
      }
    }
    const hit = CANNED.get(String(text).trim());
    if (hit) return hit;
    return '【演示模式】' + String(text);
  }

  let settings = {
    uiLang: 'zh',
    sourceLang: 'en',
    targetLang: 'zh',
    engine: 'auto',
    tone: 'default',
    showBubble: true,
    selectionDblclick: false,
    displayMode: 'replace',
    autoTranslate: false,
    autoTranslateSites: [],
    neverSites: [],
    theme: 'auto',
    inlineEnabled: true,
    inlineMode: 'button',
    inlineTargetLang: '',
    inlineLive: true,
    inlineMinChars: 2,
    inlineInsert: 'replace',
    inlineNeverSites: [],
  };

  async function handleMessage(message) {
    const { type, payload = {} } = message || {};
    switch (type) {
      case 'lt:register':
        return { ok: true, settings, support: { translator: 'Translator' in window, detector: false, nano: false } };
      case 'lt:detect':
        return { ok: true, language: 'en', confidence: 0.9, via: 'demo' };
      case 'lt:translate': {
        const text = await mockTranslate(payload.text);
        return { ok: true, text, engine: DEMO.real ? 'translator' : 'demo', sourceLang: DEMO.source, targetLang: DEMO.target };
      }
      case 'lt:translateBatch': {
        const items = payload.items || [];
        const results = [];
        for (const item of items) {
          const text = await mockTranslate(typeof item === 'string' ? item : item.text);
          results.push({ text, engine: DEMO.real ? 'translator' : 'demo' });
        }
        return { ok: true, results };
      }
      case 'lt:settings:get':
        return { ok: true, settings, support: { translator: 'Translator' in window } };
      case 'lt:settings:set':
        Object.assign(settings, (payload && payload.patch) || {});
        return { ok: true, settings };
      case 'lt:explain':
        return {
          ok: true,
          text: '【演示】这里是 Gemini Nano 的解释输出：**关键表达** 与用法说明会以 Markdown 列表呈现，\n\n- 关键词一：含义\n- 关键词二：用法\n\n例句：An example sentence with its meaning.',
        };
      case 'lt:done':
      case 'lt:reset':
      case 'lt:progress':
      case 'lt:warmup':
      case 'lt:engine:reset':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  window.chrome = {
    runtime: {
      id: 'lt-demo-preview', // 内容脚本通过它判断「扩展上下文是否还在」
      lastError: undefined,
      sendMessage(message, callback) {
        Promise.resolve(handleMessage(message))
          .then((res) => callback && callback(res))
          .catch((err) => callback && callback({ ok: false, error: String(err && err.message) }));
      },
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
      },
      // 流式通道：优先用真实内置模型逐块输出，否则用演示数据
      connect({ name }) {
        const handlers = [];
        const disconnectHandlers = [];
        return {
          name,
          async postMessage(msg) {
            if (!msg || msg.type !== 'start') return;
            const text = String(msg.text || '');
            let full = '';
            if (DEMO.real) {
              try {
                full = await DEMO.real.translate(text);
              } catch (err) {
                full = '';
              }
            }
            if (!full) full = CANNED.get(text.trim()) || ('【演示译文】' + text);
            const pieces = full.match(/[\s\S]{1,6}/g) || [];
            let acc = '';
            pieces.forEach((piece, index) => {
              setTimeout(() => {
                acc += piece;
                handlers.forEach((fn) => fn({ type: 'chunk', text: acc }));
                if (index === pieces.length - 1) handlers.forEach((fn) => fn({ type: 'done', text: acc }));
              }, 16 * (index + 1));
            });
          },
          disconnect() {
            disconnectHandlers.forEach((fn) => fn());
          },
          onMessage: { addListener: (fn) => handlers.push(fn) },
          onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
        };
      },
      getURL: (p) => p,
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      // 同时支持 callback 与 Promise 两种调用风格（内容脚本用的是 callback 风格）
      local: {
        _data: {},
        get(key, cb) {
          const out = typeof key === 'string' ? { [key]: this._data[key] } : { ...this._data };
          if (typeof cb === 'function') {
            setTimeout(() => cb(out), 0);
            return undefined;
          }
          return Promise.resolve(out);
        },
        set(obj, cb) {
          Object.assign(this._data, obj);
          if (typeof cb === 'function') setTimeout(cb, 0);
          return Promise.resolve();
        },
        remove(key, cb) {
          delete this._data[key];
          if (typeof cb === 'function') setTimeout(cb, 0);
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  function dispatchToContent(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (res) => {
        if (!settled) {
          settled = true;
          resolve(res || { ok: true });
        }
      };
      let asyncResponder = false;
      for (const fn of listeners) {
        try {
          if (fn(message, { tab: { id: 'demo' } }, done) === true) asyncResponder = true;
        } catch (err) {
          done({ ok: false, error: String(err && err.message) });
          return;
        }
      }
      if (!asyncResponder) done();
      setTimeout(() => done(), 3000);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const real = document.getElementById('demo-real');
    real.addEventListener('click', () => tryReal(real));
    document.getElementById('demo-page').addEventListener('click', () => dispatchToContent({ type: 'lt:translate-page', payload: { mode: 'replace' } }));
    document.getElementById('demo-dual').addEventListener('click', () => dispatchToContent({ type: 'lt:translate-page', payload: { mode: 'dual' } }));
    document.getElementById('demo-hover').addEventListener('click', () => dispatchToContent({ type: 'lt:translate-page', payload: { mode: 'hover' } }));
    document.getElementById('demo-restore').addEventListener('click', () => dispatchToContent({ type: 'lt:restore-page' }));
    // 影子根演示：一个开放（隔离世界能直接看见）、一个封闭（只能靠主世界助手代读代写）
    const OPEN_TEXT = ${JSON.stringify(COMPOSE_SAMPLE)};
    const CLOSED_TEXT = ${JSON.stringify(SHADOW_SAMPLE)};
    const openHost = document.getElementById('demo-open-shadow');
    if (openHost) {
      const root = openHost.attachShadow({ mode: 'open' });
      root.innerHTML =
        '<input type="text" style="font:inherit;width:100%;padding:8px 10px;border-radius:8px;' +
        'border:1px solid rgba(17,24,39,.2);background:transparent;color:inherit" />';
      root.querySelector('input').value = OPEN_TEXT;
    }
    const closedHost = document.getElementById('demo-closed-shadow');
    if (closedHost) {
      const root = closedHost.attachShadow({ mode: 'closed' });
      root.innerHTML =
        '<textarea rows="2" style="font:inherit;width:100%;padding:8px 10px;border-radius:8px;' +
        'border:1px solid rgba(17,24,39,.2);background:transparent;color:inherit"></textarea>';
      root.querySelector('textarea').value = CLOSED_TEXT;
    }

    const composeRun = document.getElementById('demo-compose-run');
    if (composeRun) {
      composeRun.addEventListener('click', () => {
        const area = document.getElementById('demo-compose-area');
        const input = document.getElementById('demo-compose-input');
        const focused = document.activeElement;
        if (!(focused === area || focused === input)) {
          (input.value.trim() ? input : area).focus();
        }
        dispatchToContent({ type: 'lt:rewrite-input', payload: {} });
      });
    }
  });
})();
`;

const articleHtml = ARTICLE.map(([tag, text]) => {
  const cls = tag === 'h1' ? ' class="demo-h1"' : tag === 'h2' ? ' class="demo-h2"' : tag === 'blockquote' ? ' class="demo-quote"' : '';
  return `      <${tag}${cls}>${text}</${tag}>`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>本地翻译 · 界面预览（免安装）</title>
    <style>
      ${contentCss}
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh; padding-bottom: 140px;
        font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
              "Microsoft YaHei", "Noto Sans SC", Roboto, sans-serif;
        color: #111827; background: #f6f7f9;
      }
      @media (prefers-color-scheme: dark) { body { color: #e8eaed; background: #15171c; } }
      header.demo-bar {
        position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
        padding: 10px 14px; background: rgba(255,255,255,.86); backdrop-filter: blur(8px);
        border-bottom: 1px solid rgba(17,24,39,.1);
      }
      @media (prefers-color-scheme: dark) {
        header.demo-bar { background: rgba(21,23,28,.86); border-bottom-color: rgba(255,255,255,.12); }
      }
      header.demo-bar strong { font-size: 14px; }
      header.demo-bar button {
        font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(17,24,39,.16); background: transparent; color: inherit;
      }        header.demo-bar button.primary { background: linear-gradient(135deg, #7c3aed 0%, #a21caf 60%, #db2777 100%); border-color: transparent; color: #fff; font-weight: 600; }
      header.demo-bar button:disabled { opacity: .6; cursor: default; }
      #demo-note { flex-basis: 100%; font-size: 12px; opacity: .7; }
      main { max-width: 720px; margin: 0 auto; padding: 20px 18px 40px; }
      .demo-h1 { font-size: 28px; line-height: 1.25; margin: 18px 0 12px; letter-spacing: -.01em; }
      .demo-h2 { font-size: 19px; margin: 26px 0 8px; }
      .demo-quote {
        margin: 18px 0; padding: 10px 14px; border-left: 3px solid #6d28d9; border-radius: 0 8px 8px 0;
        background: rgba(109,40,217,.08); font-style: italic;
      }
      .demo-tip {
        margin-top: 28px; padding: 12px 14px; border-radius: 10px; font-size: 13px;
        border: 1px dashed rgba(17,24,39,.25); opacity: .85;
      }        .demo-compose { margin: 30px 0 10px; padding: 14px; border-radius: 12px; background: rgba(109,40,217,.07); }
      .demo-compose textarea, .demo-compose input[type="text"] {
        width: 100%; font: inherit; font-size: 14px; padding: 8px 10px; margin-bottom: 8px;
        border-radius: 8px; border: 1px solid rgba(17,24,39,.18); background: rgba(255,255,255,.9); color: #111827;
        resize: vertical;
      }
      @media (prefers-color-scheme: dark) {
        .demo-compose { background: rgba(109,40,217,.12); }
        .demo-compose textarea, .demo-compose input[type="text"] { background: rgba(21,23,28,.8); color: #e8eaed; border-color: rgba(255,255,255,.18); }
      }
      .demo-compose-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
      .demo-compose-actions button {
        font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(79,70,229,.5); background: rgba(79,70,229,.1); color: inherit;
      }
      .muted { opacity: .7; }
      @media (prefers-color-scheme: dark) { .demo-tip { border-color: rgba(255,255,255,.25); } }
    </style>
  </head>
  <body>
    <header class="demo-bar" data-lt-skip>
      <strong>本地翻译 · 界面预览</strong>
      <button type="button" class="primary" id="demo-page">翻译整页</button>
      <button type="button" id="demo-dual">双语对照</button>
      <button type="button" id="demo-hover">悬停对照</button>
      <button type="button" id="demo-restore">还原原文</button>
      <button type="button" id="demo-real">启用真实内置模型</button>
      <div id="demo-note">选中任意文字即可看到划词气泡；输出的译文默认是演示数据，点「启用真实内置模型」可直接调用 Chrome 内置翻译模型（需 Chrome 138+ 桌面版且模型已就绪）。</div>
    </header>

    <main id="page-content">
${articleHtml}
      <section class="demo-compose">
        <h2 class="demo-h2" data-lt-skip>输入框转写（inline compose）</h2>
        <p data-lt-skip>
          聚焦下面任意一个输入框就会看到 <b>🌐 转写</b> 浮标：点它打开面板，译文会随输入实时更新，
          可以直接在面板里改，然后「替换」/「追加」/「还原原文」。也可以按 <b>Alt+Shift+Enter</b>
          直接转写并替换（面板里的语言下拉可以随时换成别的目标语言）。
        </p>
        <textarea id="demo-compose-area" rows="3" spellcheck="false">${COMPOSE_SAMPLE}</textarea>
        <input id="demo-compose-input" type="text" placeholder="短一点的输入框也能用，比如这句： Please review the pull request before Friday." />
        <div class="demo-compose-actions" data-lt-skip>
          <button type="button" id="demo-compose-run">转写当前输入框（等价 Alt+Shift+Enter）</button>
          <span class="muted">演示数据同样是本地生成的；若启用了真实内置模型，这里的译文会由 Chrome 内置翻译模型产出。</span>
        </div>
      </section>

      <section class="demo-compose">
        <h2 class="demo-h2" data-lt-skip>弹窗 / Shadow DOM 里的输入框</h2>
        <p class="muted" data-lt-skip>
          很多网站（尤其是组件库弹窗）把输入框放在 Shadow DOM 里，组件库的模态框还常常整个塞在 iframe 里。
          下面两个输入框分别在<b>开放</b>和<b>封闭</b>影子根里：点进去应该都会出现 <code>🌐 转写</code> 浮标。
          封闭影子根在隔离世界里完全不可见，这里由随扩展一起注入的主世界小助手代读代写。
        </p>
        <p><b data-lt-skip>开放影子根：</b><span id="demo-open-shadow"></span></p>
        <p><b data-lt-skip>封闭影子根：</b><span id="demo-closed-shadow"></span></p>
        <div class="demo-compose-actions" data-lt-skip>
          <span class="muted">iframe 里的弹窗无法在这个免安装预览里演示（没有扩展把脚本注入子框架），装好扩展后同样生效。</span>
        </div>
      </section>

      <div class="demo-tip" data-lt-skip>
        这个页面把正式的 content script 原样跑了进来，只是把后台换成了模拟实现，所以气泡、进度条、还原逻辑都是真的。
        安装扩展后，同样的交互会出现在你浏览的任意网页上，并且由 Chrome 内置模型完成推理。
      </div>
    </main>

    <script>
      window.__LT_CANNED__ = true;
${demoJs.replace('__CANNED__', JSON.stringify([...CANNED.entries()]))}
    </script>
    <script>
/* ============================ 扩展的内容脚本（原样内联） ============================ */
/* agent.js：正式扩展里以 world:"MAIN" + document_start 注入，这里手工先跑，语义相同 */
${agentJs}
    </script>
    <script>
${utilJs}
    </script>
    <script>
${uiJs}
    </script>
    <script>
${inlineJs}
    </script>
    <script>
${mainJs}
    </script>
  </body>
</html>
`;

mkdirSync(join(root, 'demo'), { recursive: true });
writeFileSync(join(root, 'demo/ui-preview.html'), html, 'utf8');
console.log(`demo/ui-preview.html 已生成（${(html.length / 1024).toFixed(1)} KB）`);
