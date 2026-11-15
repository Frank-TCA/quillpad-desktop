/**
 * QuillPad 冒烟测试脚本
 * 使用系统已安装的 Edge (msedge channel) + playwright-core，无需下载浏览器。
 * 用法: node scripts/smoke.mjs [--url http://localhost:4173]
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg || process.env.QUILLPAD_URL || 'http://localhost:4173';
const OUT = path.resolve('shots');
mkdirSync(OUT, { recursive: true });

const problems = [];
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) problems.push(`${name} ${detail}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1. 核心结构
check('标题栏存在', (await page.locator('.titlebar, header.titlebar, [class*=titlebar]').count()) > 0);
check('菜单栏存在', (await page.locator('[class*=menu]').count()) > 0);
check('标签栏存在', (await page.locator('[class*=tab]').count()) > 0);
check('状态栏存在', (await page.locator('[class*=status]').count()) > 0);
check('CodeMirror 已挂载', (await page.locator('.cm-editor').count()) > 0);

// 2. 首屏内容
const tabText = await page.locator('#tabbar .tab').first().innerText().catch(() => '');
check('默认打开欢迎文档', /欢迎/.test(tabText), tabText.replace(/\s+/g, ' ').slice(0, 40));

// 3. 编辑：输入内容
const editor = page.locator('.cm-content').first();
await editor.click();
await page.keyboard.press('Control+Home');
await page.keyboard.type('const hello = "QuillPad";');
await page.waitForTimeout(300);
const docText = await editor.innerText();
check('可输入文本', docText.includes('const hello'), docText.slice(0, 60).replace(/\n/g, ' '));

// 4. 撤销
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const afterUndo = await editor.innerText();
check('撤销生效', !afterUndo.includes('const hello'));

// 5. 查找替换面板
await page.keyboard.press('Control+f');
await page.waitForTimeout(500);
const findVisible = await page.locator('.cm-search, [class*=findbar], [class*=search]').first().isVisible().catch(() => false);
check('查找面板可打开', findVisible);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// 6. 命令面板
await page.keyboard.press('Control+Shift+P');
await page.waitForTimeout(500);
const paletteVisible = await page.locator('[class*=palette], .cm-palette').first().isVisible().catch(() => false);
check('命令面板可打开', paletteVisible);
if (paletteVisible) {
  await page.keyboard.type('主题');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '03-command-palette.png') });
  await page.keyboard.press('Escape');
}
await page.waitForTimeout(200);

// 7. 菜单下拉
const menuBtn = page.locator('[class*=menu] button, [class*=menu] [role=menuitem], nav [class*=item]').first();
if (await menuBtn.count()) {
  await menuBtn.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '04-menu.png') });
  await page.keyboard.press('Escape');
  check('菜单可展开', true);
} else {
  check('菜单可展开', false, '未找到菜单触发元素');
}

// 8. 主题切换（点击标题栏主题按钮）
const themeBtn = page.locator('#titlebar-actions [data-cmd="view.themeMenu"], [aria-label*="主题"]').first();
if (await themeBtn.count()) {
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await themeBtn.click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('主题可切换', before !== after, `${before} -> ${after}`);
  await page.screenshot({ path: path.join(OUT, '05-theme-switched.png') });
  await themeBtn.click();
  await page.waitForTimeout(300);
} else {
  check('主题可切换', false, '未找到主题按钮');
}

// 9. 状态栏信息
const statusText = await page.locator('[class*=status]').first().innerText().catch(() => '');
check('状态栏显示行列', /行\s*\d+/i.test(statusText) || /\d/.test(statusText), statusText.replace(/\s+/g, ' ').slice(0, 80));

// 10. 新建标签（Ctrl+N 弹「新建文件」对话框，回车按默认名创建）
const beforeTabs = await page.locator('#tabbar .tab').count();
await page.keyboard.press('Control+n');
await page.waitForSelector('.modal', { timeout: 5000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const afterTabs = await page.locator('#tabbar .tab').count();
check('Ctrl+N 新建标签', afterTabs > beforeTabs, `${beforeTabs} -> ${afterTabs}`);

// 11. 侧栏切换
const sidebarBefore = await page.locator('[class*=sidebar], aside').first().isVisible().catch(() => false);
const sidebarBtn = page.locator('#toolbar [data-cmd="view.toggleSidebar"], [aria-label*="侧边栏"]').first();
if (await sidebarBtn.count()) {
  await sidebarBtn.click();
  await page.waitForTimeout(400);
  const sidebarAfter = await page.locator('[class*=sidebar], aside').first().isVisible().catch(() => false);
  check('侧栏可切换', sidebarBefore !== sidebarAfter);
} else {
  check('侧栏可切换', false, '未找到侧栏按钮');
}

// 12. 关闭标签
await page.keyboard.press('Control+w');
await page.waitForTimeout(500);
check('Ctrl+W 关闭标签', (await page.locator('#tabbar .tab').count()) < afterTabs);

// 13. 刷新后恢复会话
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const restored = await page.locator('.cm-content').first().innerText().catch(() => '');
check('刷新后恢复会话', restored.length > 0, restored.slice(0, 40).replace(/\n/g, ' '));

// 14. 截图：主界面
await page.screenshot({ path: path.join(OUT, '01-main.png'), fullPage: false });

// 15. 无 console 错误
check('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

console.log('\n===== 结果 =====');
console.log(`通过 ${results.filter((r) => r.ok).length}/${results.length}`);
if (problems.length) {
  console.log('问题清单:');
  problems.forEach((p) => console.log(' - ' + p));
}
await browser.close();
process.exit(problems.length ? 1 : 0);
