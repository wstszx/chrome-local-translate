// 一气呵成的 1.5.10 上传送审:CDP 连接 → 打开控制台 → 上传 zip → 核对 Draft 版本 → 提交审核
// 运行前提:Chrome(ChromeDebugProfile 副本,--remote-debugging-port=9222)是唯一在跑的 Chrome 实例
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ZIP = path.join(ROOT, 'dist-store', 'chrome-local-translate-1.5.10.zip');
const CONSOLE = 'https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit/package';
const log = (s) => console.log(s);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 20_000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

// 1. 打开控制台 Package 页(新标签页,不影响其他标签)
await page.goto(CONSOLE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);

// 2. 登录检查:如果被重定向到 Google 登录页,明确报告并退出
if (page.url().includes('accounts.google.com')) {
  log('FAIL: 登录态没有带过来,跳到了 Google 登录页。需要在这个窗口手动登录一次 mywstszx@gmail.com。');
  await browser.close();
  process.exit(2);
}
log('✔ 已登录(未跳转登录页)');

// 3. 等待「Upload new package」按钮并点击
const uploadBtn = page.getByRole('button', { name: 'Upload new package' });
await uploadBtn.waitFor({ timeout: 30_000 });
await uploadBtn.click();
log('✔ 点击 Upload new package');

// 4. 直接对对话框里的 file input 设置 zip
//    (Google 的「Select file」按钮不会触发 Playwright 的 filechooser 事件,
//     但隐藏的 <input type="file"> 在 DOM 中,setInputFiles 可直接绕过按钮)
const dlg = page.getByRole('dialog', { name: /Upload new package/i });
await dlg.waitFor({ timeout: 15_000 });
const fileInput = page.locator('input[type="file"]');
await fileInput.waitFor({ state: 'attached', timeout: 15_000 });
await fileInput.setInputFiles(ZIP);
log('✔ 已提交 zip 文件');

// 5. 等待上传处理完成(页面会跳回 /edit)
await page.waitForURL(/\/edit$/, { timeout: 60_000 });
log('✔ 上传完成,页面已跳回编辑页');

// 6. 核对 Draft 版本 = 1.5.10
await page.goto(CONSOLE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);
const versions = await page.evaluate(() => {
  const text = document.body.innerText;
  const draftIdx = text.indexOf('Draft');
  const pubIdx = text.indexOf('Published');
  return {
    draft: draftIdx >= 0 ? text.slice(draftIdx, pubIdx > draftIdx ? pubIdx : draftIdx + 200) : '(找不到 Draft 区)',
    status: text.slice(0, 300),
  };
});
log('Draft 区摘要: ' + versions.draft.replace(/\s+/g, ' ').slice(0, 260));
if (!/1\.5\.10/.test(versions.draft)) {
  log('FAIL: Draft 不是 1.5.10,停止,不提交。请人工检查。');
  await browser.close();
  process.exit(3);
}
log('✔ Draft 版本确认 = 1.5.10');

// 7. 提交按钮只在 Store listing / Privacy / Distribution 页头部出现
//    (Package / Status 页没有,必须先跳到 listing 页)
await page.goto(CONSOLE.replace('/edit/package', '/edit/listing'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);
const submitBtn = page.getByRole('button', { name: 'Submit for review' });
await submitBtn.waitFor({ timeout: 15_000 });
await submitBtn.click();

// 8. 确认弹窗:保持「自动发布」勾选,点 Submit For Review
const confirmDlg = page.getByRole('dialog');
await confirmDlg.waitFor({ timeout: 15_000 });
const autoPublish = confirmDlg.getByRole('checkbox');
if (await autoPublish.count()) {
  const checked = await autoPublish.first().isChecked();
  log(`自动发布勾选状态: ${checked ? '已勾选(保持)' : '未勾选(勾上)'}`);
  if (!checked) await autoPublish.first().check();
}
await confirmDlg.getByRole('button', { name: 'Submit For Review' }).click();
log('✔ 已点击 Submit For Review');

// 9. 验证状态页出现 Pending review
await page.goto(CONSOLE.replace('/edit/package', '/edit/status'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);
const statusText = await page.evaluate(() => document.body.innerText.slice(0, 500));
if (/Pending review|pending review/i.test(statusText)) {
  log('\n🎉 成功:1.5.10 已提交审核(Pending review),审核通过后自动发布。');
} else {
  log('WARN: 状态页未见 Pending review 字样,请人工确认。页面摘要: ' + statusText.replace(/\s+/g, ' ').slice(0, 200));
}
await browser.close();
