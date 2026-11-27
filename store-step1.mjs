// 通过 CDP 连接调试端口的 Chrome,打开商店控制台并报告页面状态
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 15_000 });
const contexts = browser.contexts();
console.log('contexts:', contexts.length);
const ctx = contexts[0] || (await browser.newContext());
const page = ctx.pages()[0] || (await ctx.newPage());
console.log('当前页面:', page.url());

await page.goto('https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit/package', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(4000);
const url = page.url();
const title = await page.title();
const bodyText = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : '')).replace(/\s+/g, ' ');
console.log('URL:', url);
console.log('标题:', title);
console.log('正文摘要:', bodyText);
