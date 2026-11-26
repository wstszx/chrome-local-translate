#!/usr/bin/env node
/**
 * 真实浏览器端到端冒烟测试（评审 C1）。
 *
 * jsdom 覆盖不到的东西由这里兜底：真实渲染、真实选区/鼠标事件、真实 Shadow DOM、
 * 真实的扩展加载链路（manifest → Service Worker → 内容脚本注入）。
 * 1.4.0 那个「面板把自己的译文框当成目标」的 bug 就属于这一类 —— 页面级交互在
 * jsdom 里全绿、真浏览器里才现形。
 *
 * 原则：**只断言 UI 链路，不断言译文质量**。E2E 机器可能没下载内置模型语言包，
 * 翻译请求可能失败（气泡里显示错误 + 重试按钮）——那也是正确行为。这里验证的是：
 *
 *   1. 扩展能被加载（Service Worker 起来）且内容脚本真的注入了页面
 *   2. 划词 → 气泡 Shadow DOM 弹出（含语言对行）
 *   3. 输入框打字 → 🌐 转写浮标出现
 *
 * 运行：`npm run test:e2e`（首次需要 `npx playwright install chromium` 下载测试浏览器；
 * 会弹出一个浏览器窗口，跑完自动关闭）
 */
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT = 20_000;

/** 极简静态服务器：只服务一个夹具页面（http://127.0.0.1 才保证内容脚本会注入；file:// 不保证） */
function serveFixture() {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>E2E fixture</title></head>
  <body>
    <p id="para1">This paragraph exists so that a selection can be made over real rendered text.</p>
    <p id="para2">Another short paragraph for good measure.</p>
    <form><textarea id="ta1" rows="3" placeholder="type here"></textarea></form>
  </body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** 等扩展的 MV3 Service Worker 起来，返回 chrome-extension://<id> */
async function waitExtensionReady(context) {
  const deadline = Date.now() + TIMEOUT;
  for (;;) {
    const sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (sw) return sw.url();
    if (Date.now() > deadline) throw new Error('扩展 Service Worker 未在时限内启动（--load-extension 是否生效？）');
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const { server, url } = await serveFixture();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-e2e-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false, // 扩展加载在带界面模式下最可靠；跑完即关，窗口一闪而过
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        // Chrome 137+ 默认禁用「命令行加载扩展」这个开关，必须显式解锁，否则扩展装不上
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const swUrl = await waitExtensionReady(context);
    const extId = new URL(swUrl).host;
    console.log(`✔ 扩展已加载（id: ${extId}）`);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });

    // —— 1. 内容脚本注入 ——
    // 注意：内容脚本跑在隔离世界，页面主世界看不到它的全局对象（window.__LOCAL_TRANSLATE__），
    // 所以改看它的「副作用」：init 时创建的 Shadow DOM 宿主（气泡 data-lt-ui="1" +
    // 转写浮标 data-lt-ui="inline"）。
    await page.waitForFunction(() => document.querySelectorAll('[data-lt-ui]').length >= 2, null, { timeout: TIMEOUT });
    console.log('✔ 内容脚本已注入页面（气泡/转写宿主已创建）');

    // —— 2. 划词 → 气泡弹出（真实鼠标拖选，jsdom 模拟不了 render 后的 hit-testing）——
    const para = page.locator('#para1');
    const box = await para.boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(box.x + 4 + (i * (box.width * 0.6)) / 8, box.y + box.height / 2, { steps: 2 });
    }
    await page.mouse.up();
    // 气泡宿主在 init 时就存在，要断言的是「选区后气泡从 hidden 变为显示」
    await page.waitForFunction(
      () => {
        const host = document.querySelector('[data-lt-ui="1"]');
        const bubble = host && host.shadowRoot && host.shadowRoot.querySelector('.lt-bubble');
        return !!(bubble && !bubble.hidden);
      },
      null,
      { timeout: TIMEOUT },
    );
    const bubblePair = await page.evaluate(() => {
      const host = document.querySelector('[data-lt-ui="1"]');
      const root = host && host.shadowRoot;
      const pair = root && root.querySelector('.lt-pair');
      return pair ? pair.textContent.trim() : '';
    });
    if (!bubblePair || !bubblePair.includes('→')) {
      throw new Error(`气泡里应有「源语言 → 目标语言」行，实际：${JSON.stringify(bubblePair)}`);
    }
    console.log(`✔ 划词后气泡弹出（语言对：${bubblePair}）`);

    // —— 3. 输入框打字 → 转写浮标出现 ——
    // 气泡还开着会挡住下面的元素（它就该挡住，真实用户也得先点空白处收起它）——先 Esc 收起
    await page.keyboard.press('Escape');
    await page.locator('#ta1').click();
    await page.keyboard.type('hello', { delay: 30 });
    await page.waitForFunction(
      () => {
        const hosts = document.querySelectorAll('[data-lt-ui]');
        for (const host of hosts) {
          const root = host.shadowRoot;
          const pill = root && root.querySelector('.lt-pill');
          if (pill && !pill.hidden) return true;
        }
        return false;
      },
      null,
      { timeout: TIMEOUT },
    );
    console.log('✔ 输入框打字后转写浮标出现');

    console.log('\nE2E 冒烟测试全部通过（3/3）。');
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('E2E 失败：', err && err.message ? err.message : err);
  process.exit(1);
});
