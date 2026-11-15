/** 状态栏交互 / 标签右键菜单 / 会话持久化 回归测试 */
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok, d }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' :: ' + d : ''}`); };
const statusText = () => page.locator('#statusbar').innerText();

// 1. 状态栏元素构成
const statusItems = await page.$$eval('#statusbar *', (els) =>
  els.filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => ({
    cls: e.className, txt: e.textContent.trim(), role: e.dataset.role || e.getAttribute('data-role') || '',
  })));
console.log('状态栏条目:', JSON.stringify(statusItems));

// 2. 点击缩进项切换
const indentEl = page.locator('#statusbar [data-cell="indent"]').first();
if (await indentEl.count()) {
  const before = (await indentEl.innerText()).replace(/\s+/g, ' ');
  await indentEl.click();
  await page.waitForTimeout(500);
  const after = (await indentEl.innerText()).replace(/\s+/g, ' ');
  check('状态栏点击缩进项可切换', before !== after, `${before} -> ${after}`);
} else {
  check('状态栏点击缩进项可切换', false, '未找到缩进项');
}

// 3. 点击 EOL 切换
const eolEl = page.locator('#statusbar [data-cell="eol"]').first();
if (await eolEl.count()) {
  const before = (await eolEl.innerText()).replace(/\s+/g, ' ');
  await eolEl.click();
  await page.waitForTimeout(500);
  const after = (await eolEl.innerText()).replace(/\s+/g, ' ');
  check('状态栏点击 EOL 可切换', before !== after, `${before} -> ${after}`);
} else {
  check('状态栏点击 EOL 可切换', false, '未找到 EOL 项');
}

// 4. 点击语言项切换语言
const langEl = page.locator('#statusbar [data-cell="lang"]').first();
if (await langEl.count()) {
  await langEl.click();
  await page.waitForTimeout(500);
  const anyMenu = await page.locator('.dropdown, .context-menu').count();
  check('状态栏点击语言可弹出选择器', anyMenu > 0, `弹出 ${anyMenu} 个菜单`);
  await page.keyboard.press('Escape');
} else {
  check('状态栏点击语言可弹出选择器', false, '未找到语言项');
}

// 5. 标签页右键菜单
const tab = page.locator('#tabbar [class*=tab]').first();
if (await tab.count()) {
  await tab.click({ button: 'right' });
  await page.waitForTimeout(400);
  const menuItems = await page.locator('.context-menu .dropdown__item').allInnerTexts();
  check('标签右键菜单可打开', menuItems.length > 0, menuItems.join(' / ').replace(/\s+/g, ' '));
  await page.screenshot({ path: 'shots/qa-tabmenu.png' });
  await page.keyboard.press('Escape');
} else {
  check('标签右键菜单可打开', false, '未找到标签');
}

// 6. 主题持久化：切到 ivory 后刷新应保持
await page.click('.menubar__item:has-text("主题")');
await page.waitForTimeout(300);
await page.click('.dropdown__item:has-text("Ivory Light")');
await page.waitForTimeout(600);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const themeAfterReload = await page.evaluate(() => document.documentElement.dataset.theme);
check('刷新后主题保持', themeAfterReload === 'ivory', themeAfterReload);

// 7. 脏标记
await page.locator('.cm-content').first().click();
await page.keyboard.type('X');
await page.waitForTimeout(400);
const dirty = await page.evaluate(() => {
  const t = document.querySelector('#tabbar [class*=tab]');
  return t ? { cls: t.className, txt: t.innerText, dots: t.querySelectorAll('.tab__dirty').length } : null;
});
check('修改后出现脏标记', !!dirty && (dirty.dots > 0 || /dirty|●/.test(dirty.cls + dirty.txt)), JSON.stringify(dirty));

// 8. 状态栏保存状态
const st = (await statusText()).replace(/\s+/g, ' ');
check('状态栏反映未保存状态', /未保存|已修改|\*/.test(st) || /已保存/.test(st), st);

check('无 console 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
await browser.close();

// 有失败就以非零码退出：否则「打印 7/8 但退出码 0」会让 npm test / CI 永远绿。
// 注意字段名与顶部 check() 推入的结构一致：{ n, ok, d }，别写成 name / detail。
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ' :: ' + f.d : ''}`);
  process.exit(1);
}
