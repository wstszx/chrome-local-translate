// 仅提交审核:假定 1.5.10 zip 已上传,Draft 已是 1.5.10
// 提交按钮位于 /edit/listing 页头部(Package/Status 页没有)
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
const BASE = 'https://chrome.google.com/webstore/devconsole/6482309c-c541-4e2e-9f85-ba5b5fb25664/ncenacdchlmblbdlljdkjjhhnjimmeje/edit';
const log = (s) => console.log(s);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 20_000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

// 1. 核对 Draft 版本
await page.goto(`${BASE}/package`, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForTimeout(4000);
const draft = await page.evaluate(() => {
  const t = document.body.innerText;
  const i = t.indexOf('Draft');
  const j = t.indexOf('Published', i);
  return t.slice(i, j > i ? j : i + 200).replace(/\s+/g, ' ');
});
log('Draft 区: ' + draft);
if (!draft.includes(VERSION)) {
  log(`FAIL: Draft 不是 ${VERSION},不提交。`);
  process.exit(3);
}

// 2. 前往 listing 页,点 Submit for review
await page.goto(`${BASE}/listing`, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForTimeout(4000);
const submitBtn = page.getByRole('button', { name: 'Submit for review' });
await submitBtn.waitFor({ state: 'visible', timeout: 20_000 });
await submitBtn.click();
log('✔ 已点击 Submit for review');

// 3. 处理确认弹窗:打印内容以便核对,勾上自动发布,点确认
const dlg = page.getByRole('dialog');
await dlg.waitFor({ state: 'visible', timeout: 20_000 });
await page.waitForTimeout(1000);
const dlgInfo = await dlg.evaluate((el) => ({
  text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
  buttons: Array.from(el.querySelectorAll('button')).map((b) => (b.innerText || '').trim()).filter(Boolean),
  checkboxes: Array.from(el.querySelectorAll('input[type=checkbox]')).map((c) => ({ checked: c.checked, label: (c.closest('label')?.innerText || '').trim().slice(0, 120) })),
}));
log('弹窗文本: ' + dlgInfo.text);
log('弹窗按钮: ' + JSON.stringify(dlgInfo.buttons));
log('弹窗复选框: ' + JSON.stringify(dlgInfo.checkboxes));

const auto = dlg.getByRole('checkbox');
if (await auto.count()) {
  const first = auto.first();
  if (!(await first.isChecked())) {
    await first.check();
    log('✔ 已勾选自动发布');
  } else {
    log('✔ 自动发布原本已勾选');
  }
}
const confirm = dlg.getByRole('button', { name: /Submit For Review|Submit|Confirm/i }).last();
await confirm.waitFor({ state: 'visible', timeout: 15_000 });
await confirm.click();
log('✔ 已点击确认提交');

// 4. 验证状态页
await page.goto(`${BASE}/status`, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForTimeout(5000);
const status = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800));
log('状态页: ' + status);
if (/Pending review|In review/i.test(status)) {
  log(`\n🎉 成功:${VERSION} 已提交审核(Pending review)。`);
} else {
  log('\nWARN: 状态页未见 Pending review,请人工确认上面输出。');
}
process.exit(0);
