/**
 * QuillPad 桌面壳冒烟测试
 *
 * 用 Playwright 直接拉起真实的 Electron 应用（而不是浏览器里的网页），验证：
 *   1. 窗口能起、页面能加载、无控制台报错；
 *   2. 注入的最小化/最大化/关闭按钮存在且真的能控制窗口；
 *   3. origin 是 127.0.0.1 且处于安全上下文（File System Access 可用的前提）；
 *   4. 应用核心交互（新建标签、输入、主题切换）在壳里照常工作。
 *
 * 用法：node scripts/desktop-check.mjs
 */

import { _electron as electron } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const results = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  timeout: 60000,
  // 宿主环境可能带着 ELECTRON_RUN_AS_NODE，会把 Electron 退化成纯 Node 进程，
  // 必须剔除，否则窗口永远起不来。
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'),
  ),
});

const page = await app.firstWindow();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(2500);

// 1. 应用是否真的启动完成
const boot = await page.evaluate(() => ({
  ready: document.querySelector('#app')?.dataset.ready === 'true',
  origin: location.origin,
  secure: window.isSecureContext,
  hasFsa: typeof window.showOpenFilePicker === 'function',
  desktopApi: typeof window.quillpadDesktop === 'object',
}));
check('应用启动完成', boot.ready === true, `ready=${boot.ready}`);
check('origin 为本地回环', /^http:\/\/127\.0\.0\.1:\d+$/.test(boot.origin), boot.origin);
check('处于安全上下文', boot.secure === true, `isSecureContext=${boot.secure}`);
check('File System Access 可用', boot.hasFsa === true, `showOpenFilePicker=${boot.hasFsa}`);
check('桌面 API 已注入', boot.desktopApi === true);

// 2. 窗口控制按钮
const winctl = await page.evaluate(() => {
  const el = document.getElementById('qp-winctl');
  if (!el) return null;
  const bar = document.getElementById('titlebar');
  return {
    buttons: [...el.querySelectorAll('button')].map((b) => b.dataset.kind),
    titlebarHeight: bar.getBoundingClientRect().height,
    winctlHeight: el.getBoundingClientRect().height,
    winctlRight: el.getBoundingClientRect().right,
    viewport: window.innerWidth,
  };
});
check(
  '窗口按钮已注入（最小化/最大化/关闭）',
  !!winctl && ['minimize', 'maximize', 'close'].every((k) => winctl.buttons.includes(k)),
  winctl ? winctl.buttons.join(',') : '未找到 #qp-winctl',
);
check(
  '窗口按钮与标题栏等高且贴右缘',
  !!winctl &&
    Math.abs(winctl.winctlHeight - winctl.titlebarHeight) < 1.5 &&
    Math.abs(winctl.winctlRight - winctl.viewport) < 1,
  winctl
    ? `h=${winctl.winctlHeight.toFixed(1)}/${winctl.titlebarHeight.toFixed(1)} right=${winctl.winctlRight.toFixed(1)}/${winctl.viewport}`
    : '',
);

// 3. 最大化按钮真的能改变窗口尺寸
const readBounds = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { width: w.getBounds().width, height: w.getBounds().height, maximized: w.isMaximized() };
  });

const before = await readBounds();
await page.click('#qp-winctl button[data-kind="maximize"]');
await page.waitForTimeout(900);
const afterMax = await readBounds();
check(
  '点击最大化按钮窗口进入最大化',
  afterMax.maximized === true && afterMax.width > before.width,
  `${before.width}x${before.height} → ${afterMax.width}x${afterMax.height} maximized=${afterMax.maximized}`,
);

// 图标应切换成「还原」
const iconAfterMax = await page.evaluate(
  () => document.querySelector('#qp-winctl button[data-kind="maximize"]')?.getAttribute('aria-label'),
);
check('最大化后按钮变为「向下还原」', iconAfterMax === '向下还原', String(iconAfterMax));

await page.click('#qp-winctl button[data-kind="maximize"]');
await page.waitForTimeout(900);
const afterRestore = await readBounds();
check('再次点击还原窗口', afterRestore.maximized === false, `maximized=${afterRestore.maximized}`);

// 4. 壳内核心交互
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+n');
await page.waitForTimeout(500);
await page.keyboard.type('desktop shell works');
await page.waitForTimeout(400);
const typed = await page.evaluate(() => {
  const tabs = window.quillpad?.state?.tabs || [];
  const active = tabs.find((t) => t.id === window.quillpad.state.activeId) || tabs[tabs.length - 1];
  return { text: active?.content || '', tabs: tabs.length, lang: active?.language };
});
check('壳内可新建标签并输入', typed.text.includes('desktop shell works'), `tabs=${typed.tabs}`);

await page.evaluate(() => window.quillpad.setTheme('ivory'));
await page.waitForTimeout(600);
const theme = await page.evaluate(() => document.documentElement.dataset.theme);
check('主题切换在壳内生效', theme === 'ivory', theme);
await page.evaluate(() => window.quillpad.setTheme('aurora'));
await page.waitForTimeout(400);

// 5. 截图
await page.screenshot({ path: 'shots/desktop-main.png' });
console.log('  已截图 shots/desktop-main.png');

check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '(无)');

// 清掉脏标记，避免关闭时弹确认框卡住测试
await page.evaluate(() => {
  const tabs = window.quillpad?.state?.tabs || [];
  for (const t of tabs) {
    t.savedContent = t.content;
    t.savedEol = t.eol;
  }
});

await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exitCode = 1;
}
