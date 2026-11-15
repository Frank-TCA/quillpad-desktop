/**
 * QuillPad · 下拉菜单点击回归自检（QA P0 固化脚本）
 *
 * 覆盖范围：
 *   1) QA P0 —— 所有下拉菜单项点击后必须真正执行命令
 *      ① 主题 → Ivory Light   => document.documentElement.dataset.theme === 'ivory'
 *      ② 视图 → 禅模式        => #app 出现 is-zen，且菜单栏被隐藏
 *      ③ 视图 → Markdown 预览 => #preview-pane 分栏可见
 *      另外覆盖：编辑菜单、搜索菜单、视图菜单、帮助菜单、标签右键菜单
 *   2) P1 —— index.html 的内联 SVG favicon 生效，浏览器不再请求 /favicon.ico（无 404）
 *   3) P1 —— 四套主题切换时 CodeMirror 语法高亮配色同步改变（不只是换 CSS 变量）
 *
 * 依赖：playwright-core + 系统已安装的 Edge（channel: 'msedge'），无需下载浏览器。
 * 用法：
 *   npm run build && npm run preview        # 另开一个终端
 *   node scripts/menu-fix-check.mjs
 *   QUILLPAD_URL=http://127.0.0.1:4173/ node scripts/menu-fix-check.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ 断言器 */

const results = [];
/**
 * 记录一条断言结果。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 附加信息
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

/**
 * #rrggbb 转 rgb() 字符串，便于与 getComputedStyle 的结果比对。
 * @param {string} hex 十六进制颜色
 * @return {string}
 */
function rgb(hex) {
  const v = hex.replace('#', '');
  const n = parseInt(v, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/* ------------------------------------------------------------------ 启动 */

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
const badResponses = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.menubar__item', { timeout: 20000 });
await page.waitForTimeout(600);

/**
 * 打开一级菜单并点击其中的某一项（走真实的 mousedown → mouseup → click 链路）。
 *
 * 支持二级子菜单：传 `submenuLabel` 时先展开对应子菜单再点叶子项。
 * @param {string} menuLabel 一级菜单名，如「主题」
 * @param {string} itemText  菜单项文字（子串匹配）
 * @param {string|null} [submenuLabel] 二级子菜单名（如「大小写」），null 表示直接在一级下拉里找
 * @return {Promise<boolean>} 是否成功点到
 */
async function menuPick(menuLabel, itemText, submenuLabel = null) {
  await page.click(`.menubar__item:has-text("${menuLabel}")`);
  await page.waitForSelector('.dropdown', { state: 'visible', timeout: 5000 });
  let scope = page.locator('.dropdown').first();
  if (submenuLabel) {
    // 先展开二级子菜单：hover 带子菜单的父项
    const parent = scope.locator('.dropdown__item--has-sub', { hasText: submenuLabel });
    const pc = await parent.count();
    if (pc === 0) {
      check(`子菜单定位 ${menuLabel}/${submenuLabel}`, false, '未找到子菜单项');
      await page.keyboard.press('Escape');
      return false;
    }
    await parent.first().hover();
    await page.waitForTimeout(300);
    // 子菜单是新出现的 .dropdown 面板（嵌套）
    const dropdowns = page.locator('.dropdown');
    const dc = await dropdowns.count();
    scope = dropdowns.nth(dc - 1); // 最后一个是子菜单面板
  }
  const matched = scope.locator('.dropdown__item', { hasText: itemText });
  const count = await matched.count();
  if (count === 0) {
    check(`菜单项定位 ${menuLabel}/${itemText}`, false, '未找到菜单项');
    await page.keyboard.press('Escape');
    return false;
  }
  await matched.first().click();
  await page.waitForTimeout(450);
  return true;
}

/* ------------------------------------------------- P0 ①：主题 → Ivory Light */

await menuPick('主题', 'Ivory Light');
const themeId = await page.evaluate(() => document.documentElement.dataset.theme);
check('P0-① 主题→Ivory Light 后 dataset.theme === "ivory"', themeId === 'ivory', `实际=${themeId}`);
await page.screenshot({ path: `${OUT}/menu-ivory.png` });

/* ------------------------------------------------------ P0 ②：视图 → 禅模式 */

await menuPick('视图', '禅模式');
const zen = await page.evaluate(() => ({
  appClass: document.querySelector('#app')?.className || '',
  menubarHidden: !document.querySelector('#menubar')?.offsetParent,
}));
check(
  'P0-② 视图→禅模式后出现 is-zen 且菜单栏隐藏',
  zen.appClass.includes('is-zen') && zen.menubarHidden === true,
  JSON.stringify(zen),
);
await page.screenshot({ path: `${OUT}/menu-zen.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const zenOff = await page.evaluate(() => !document.querySelector('#app')?.classList.contains('is-zen'));
check('P0-② 附带：Esc 可退出禅模式', zenOff === true);

/* ------------------------------------------------- P0 ③：视图 → Markdown 预览 */

await menuPick('视图', 'Markdown 预览');
const preview = await page.evaluate(() => {
  const el = document.querySelector('#preview-pane');
  if (!el) return { hidden: true, w: 0, html: 0 };
  return { hidden: el.hidden, w: el.getBoundingClientRect().width, html: el.innerHTML.length };
});
check(
  'P0-③ 视图→Markdown 预览后预览分栏可见',
  preview.hidden === false && preview.w > 200 && preview.html > 100,
  JSON.stringify(preview),
);
await page.screenshot({ path: `${OUT}/menu-preview.png` });
await menuPick('视图', 'Markdown 预览'); // 复原

/* --------------------------------------------- 其它菜单项（逐条验证命令生效） */

// 编辑菜单 → 转换为大写
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+a');
await page.keyboard.type('hello world');
await page.waitForTimeout(200);
await menuPick('编辑', '大写', '大小写');
const upper = await page.locator('.cm-content').first().innerText();
check('菜单项：编辑→转换为大写', upper.includes('HELLO'), JSON.stringify(upper.slice(0, 40)));

// 搜索菜单 → 查找
await menuPick('搜索', '查找');
const findVisible = await page
  .locator('.cm-search, [class*=qp-search], [class*=search-panel]')
  .first()
  .isVisible()
  .catch(() => false);
check('菜单项：搜索→查找', findVisible === true);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// 视图菜单 → 显示 / 隐藏侧边栏
const sbBefore = await page.evaluate(() => !!document.querySelector('#sidebar')?.offsetParent);
await menuPick('视图', '侧边栏');
const sbAfter = await page.evaluate(() => !!document.querySelector('#sidebar')?.offsetParent);
check('菜单项：视图→显示/隐藏侧边栏', sbBefore !== sbAfter, `${sbBefore} -> ${sbAfter}`);
await menuPick('视图', '侧边栏');

// 帮助菜单 → 快捷键速查
await menuPick('帮助', '快捷键速查');
const dlgVisible = await page
  .locator('.modal-backdrop .modal')
  .first()
  .isVisible()
  .catch(() => false);
check('菜单项：帮助→快捷键速查', dlgVisible === true);
await page.screenshot({ path: `${OUT}/menu-shortcuts.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// 标签栏右键菜单（另一处自绘菜单）
// 先多开一个标签，保证「关闭其他」有可关闭的目标
await page.evaluate(() => window.quillpad.newFile());
await page.waitForTimeout(500);
const tabsBefore = await page.locator('.tab').count();
await page.locator('.tab').first().click({ button: 'right' });
await page.waitForSelector('.context-menu', { state: 'visible', timeout: 5000 });
await page.locator('.context-menu .dropdown__item', { hasText: '关闭其他' }).first().click();
await page.waitForTimeout(450);
const tabsAfter = await page.locator('.tab').count();
check('菜单项：标签右键菜单→关闭其他', tabsAfter < tabsBefore, `${tabsBefore} -> ${tabsAfter}`);

/* --------------------------------------------------------- P1：favicon 无 404 */

const faviconHref = await page.evaluate(() => {
  const link = document.querySelector('link[rel~="icon"]');
  return link ? link.getAttribute('href') : null;
});
check(
  'P1 index.html 内联 SVG favicon 存在',
  !!faviconHref && faviconHref.startsWith('data:image/svg+xml'),
  faviconHref ? faviconHref.slice(0, 48) + '…' : 'null',
);
const favicon404 = badResponses.filter((u) => /favicon\.ico/i.test(u));
check('P1 浏览器未请求 /favicon.ico（无 404）', favicon404.length === 0, favicon404.join(' | '));

/* ------------------------------------------- P1：四套主题的语法高亮同步切换 */

// 造一个 JavaScript 标签，保证有稳定的语法 token 可取色
await page.evaluate(async () => {
  const app = window.quillpad;
  app.newFile();
  await app.setLanguage('javascript');
  const view = app.editor.view;
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: 'const greet = "hello";\nfunction run() { return greet; }\n',
    },
  });
});
await page.waitForTimeout(600);

/** 四套主题的期望值（与 src/editor/cm-themes.js 的 PALETTES 保持一致）。 */
const THEME_EXPECT = [
  { label: 'Aurora Dark', id: 'aurora', bg: '#0d1015', keyword: '#8b9cff', string: '#8fd1a8' },
  { label: 'Ivory Light', id: 'ivory', bg: '#ffffff', keyword: '#4f46e5', string: '#0f7b4f' },
  { label: 'Nord', id: 'nord', bg: '#2b3038', keyword: '#8fbcbb', string: '#a3be8c' },
  // Solarized Light 的强调色已整体压暗到 WCAG AA（≥4.6:1 @ #fdf6e3）
  { label: 'Solarized Light', id: 'solarized', bg: '#fdf6e3', keyword: '#657400', string: '#207a73' },
];

/**
 * 读取当前编辑器的主题快照：背景色 + 每个语法 token 的颜色。
 * @return {Promise<{id: string, bg: string, tokens: Record<string, string>}>}
 */
async function readThemeSnapshot() {
  return page.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    const tokens = {};
    document.querySelectorAll('.cm-content span').forEach((s) => {
      const txt = (s.textContent || '').trim();
      if (!txt || txt in tokens) return;
      tokens[txt] = getComputedStyle(s).color;
    });
    return {
      id: document.documentElement.dataset.theme,
      bg: editor ? getComputedStyle(editor).backgroundColor : '',
      tokens,
    };
  });
}

const snapshots = [];
for (const t of THEME_EXPECT) {
  await menuPick('主题', t.label);
  await page.waitForTimeout(350);
  const snap = await readThemeSnapshot();
  snapshots.push({ ...t, snap });
  check(
    `P1 主题「${t.label}」编辑区背景同步为 ${t.bg}`,
    snap.id === t.id && snap.bg === rgb(t.bg),
    `id=${snap.id} bg=${snap.bg}`,
  );
  const stringToken = snap.tokens['"hello"'];
  check(
    `P1 主题「${t.label}」字符串语法色为 ${t.string}`,
    stringToken === rgb(t.string),
    `实际=${stringToken}`,
  );
}

// 两两比较：任意两套主题的语法 token 颜色都必须不同（证明高亮确实随主题切换）
let diffPairs = 0;
for (let i = 0; i < snapshots.length; i += 1) {
  for (let j = i + 1; j < snapshots.length; j += 1) {
    const a = snapshots[i].snap.tokens;
    const b = snapshots[j].snap.tokens;
    const keys = Object.keys(a).filter((k) => k in b);
    const diff = keys.filter((k) => a[k] !== b[k]);
    if (diff.length > 0) diffPairs += 1;
    else {
      check(
        `P1 主题「${snapshots[i].label}」与「${snapshots[j].label}」语法色不同`,
        false,
        `比较了 ${keys.length} 个 token，颜色完全相同`,
      );
    }
  }
}
check(
  'P1 四套主题两两之间语法高亮配色均不同（6/6 组）',
  diffPairs === 6,
  `不同组数=${diffPairs}`,
);

// 复原到默认主题
await menuPick('主题', 'Aurora Dark');

/* ------------------------------------------------------------------ 收尾 */

check('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const other404 = badResponses.filter((u) => !/favicon\.ico/i.test(u));
check('无其它 4xx / 5xx 资源请求', other404.length === 0, other404.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
