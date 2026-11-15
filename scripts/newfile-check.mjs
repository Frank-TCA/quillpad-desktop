/**
 * QuillPad · 1.0.0 三项改动回归自检
 *
 * 覆盖：
 *   A) 行号槽字号不跟随正文缩放（正文 14–300px 全程 14px，槽宽不失控）
 *   B) 新建文件对话框：可选类型（.txt / .md …），名字与类型双向跟随
 *   C) 标签栏末尾的「+」按钮：位置、点击、溢出吸附、双击不重复建
 *
 * 前置：`npx vite --port 4173 --strictPort` 已启动。
 * 用法：node scripts/newfile-check.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

const results = [];
/**
 * 记录一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 附加信息
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.menubar__item', { timeout: 20000 });
await page.waitForTimeout(600);

/* ======================================================== A 行号字号 */

/** 读取当前编辑器的字号相关几何。 */
const metrics = () =>
  page.evaluate(() => {
    const scroller = document.querySelector('.cm-scroller');
    const gutters = document.querySelector('.cm-gutters');
    const num = document.querySelector('.cm-lineNumbers .cm-gutterElement');
    const pick = (el, prop) => (el ? getComputedStyle(el)[prop] : '');
    return {
      scroller: pick(scroller, 'fontSize'),
      gutter: pick(gutters, 'fontSize'),
      number: pick(num, 'fontSize'),
      gutterWidth: gutters ? Math.round(gutters.getBoundingClientRect().width) : 0,
      docWidth: scroller ? Math.round(scroller.getBoundingClientRect().width) : 0,
    };
  });

/** 建一个带多行的纯文本标签，保证行号槽有内容。 */
await page.evaluate(() => {
  const tab = window.quillpad.newFile();
  const view = window.quillpad.editor.view;
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行内容`).join('\n'),
    },
  });
  window.quillpad.state.tabs.find((t) => t.id === tab.id).savedContent = view.state.doc.toString();
});
await page.waitForTimeout(400);

const m0 = await metrics();
check(
  'A1 默认字号：正文 14px，行号 14px',
  m0.scroller === '14px' && m0.gutter === '14px',
  JSON.stringify(m0),
);

await page.evaluate(() => window.quillpad.setFontSize(60));
await page.waitForTimeout(400);
const m60 = await metrics();
check(
  'A2 正文放大到 60px：行号仍 14px',
  m60.scroller === '60px' && m60.gutter === '14px' && m60.number === '14px',
  JSON.stringify(m60),
);

await page.evaluate(() => window.quillpad.setFontSize(300));
await page.waitForTimeout(600);
const m300 = await metrics();
check(
  'A3 正文放大到 300px：行号仍 14px',
  m300.scroller === '300px' && m300.gutter === '14px' && m300.number === '14px',
  JSON.stringify(m300),
);
check(
  'A4 300px 时行号槽宽度 ≤ 140px（不再被撑到 560px）',
  m300.gutterWidth > 0 && m300.gutterWidth <= 140,
  `gutter=${m300.gutterWidth}px doc=${m300.docWidth}px`,
);
await page.screenshot({ path: `${OUT}/v100-fontsize-300.png` });

await page.evaluate(() => window.quillpad.setFontSize(1));
await page.waitForTimeout(400);
const mMin = await metrics();
check(
  'A5 正文缩到下限：setFontSize(1) 被夹到 14px，行号仍 14px',
  mMin.scroller === '14px' && mMin.gutter === '14px' && mMin.number === '14px',
  JSON.stringify(mMin),
);

// 缩小（仍在区间内）时行号也必须纹丝不动，而不是跟着变小
await page.evaluate(() => window.quillpad.setFontSize(16));
await page.waitForTimeout(300);
const m16 = await metrics();
check(
  'A6 正文 16px：行号仍 14px（缩小不跟）',
  m16.scroller === '16px' && m16.gutter === '14px',
  JSON.stringify(m16),
);

await page.evaluate(() => window.quillpad.setFontSize(14));
await page.waitForTimeout(300);

/* ================================================ B 新建文件对话框 */

const tabCount = () => page.evaluate(() => window.quillpad.state.tabs.length);
const activeTab = () =>
  page.evaluate(() => {
    const s = window.quillpad.state;
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t ? { name: t.name, language: t.language } : null;
  });

const beforeB = await tabCount();
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+n');
await page.waitForSelector('.modal', { timeout: 5000 });
await page.waitForTimeout(250);

const dlg = await page.evaluate(() => {
  const modal = document.querySelector('.modal');
  const select = document.querySelector('#newfile-type');
  const input = document.querySelector('#newfile-name');
  return {
    title: modal ? modal.querySelector('.modal__title').textContent.trim() : '',
    options: select ? select.options.length : 0,
    firstOption: select ? select.options[0].textContent.trim() : '',
    value: input ? input.value : '',
    ext: select ? select.value : '',
  };
});
check('B1 Ctrl+N 弹出「新建文件」对话框', dlg.title === '新建文件', JSON.stringify(dlg));
check('B2 类型下拉框选项 ≥ 20 且首项是纯文本', dlg.options >= 20 && /纯文本（\.txt）/.test(dlg.firstOption), `${dlg.options} 项，首项 ${dlg.firstOption}`);
check('B3 默认文件名与类型一致（未命名.txt / txt）', dlg.value.endsWith('.txt') && dlg.ext === 'txt', `${dlg.value} / ${dlg.ext}`);
await page.screenshot({ path: `${OUT}/v100-newfile-dialog.png` });

// 换类型 → 名字跟着换（用户没手改过名字）
await page.selectOption('#newfile-type', 'md');
await page.waitForTimeout(200);
const afterType = await page.inputValue('#newfile-name');
check('B4 选 .md 后文件名自动变成 未命名.md', afterType.endsWith('.md'), afterType);

// 回车创建
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const tabMd = await activeTab();
const afterB1 = await tabCount();
check(
  'B5 回车创建：标签名为 未命名N.md 且语言 = markdown',
  afterB1 === beforeB + 1 && !!tabMd && /^未命名\d*\.md$/.test(tabMd.name) && tabMd.language === 'markdown',
  `${JSON.stringify(tabMd)} tabs ${beforeB}→${afterB1}`,
);

// 输入带扩展名的文件名 → 类型跟随
await page.keyboard.press('Control+n');
await page.waitForSelector('.modal', { timeout: 5000 });
await page.fill('#newfile-name', 'README.md');
await page.waitForTimeout(200);
const syncedExt = await page.inputValue('#newfile-type');
check('B6 输入 README.md：类型下拉框自动跳到 md', syncedExt === 'md', syncedExt);
await page.click('.modal .btn.is-primary');
await page.waitForTimeout(500);
const tabReadme = await activeTab();
check(
  'B7 创建 README.md：语言 = markdown',
  tabReadme && tabReadme.name === 'README.md' && tabReadme.language === 'markdown',
  JSON.stringify(tabReadme),
);

// Esc 取消不建标签
const beforeEsc = await tabCount();
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+n');
await page.waitForSelector('.modal', { timeout: 5000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check('B8 Esc 取消：不新增标签', (await tabCount()) === beforeEsc, `${beforeEsc} → ${await tabCount()}`);

// 命令面板里的「新建空白文件」仍是即时建标签
const beforeQuick = await tabCount();
await page.evaluate(() => window.quillpad.run('file.newUntitled'));
await page.waitForTimeout(400);
check(
  'B9 file.newUntitled 仍是即时建标签（不弹窗）',
  (await tabCount()) === beforeQuick + 1 && !(await page.locator('.modal').count()),
  `${beforeQuick} → ${await tabCount()}`,
);

/* ==================================================== C 标签栏「+」 */

const plusGeom = await page.evaluate(() => {
  const plus = document.querySelector('.tabbar .tabadd');
  const tabs = Array.from(document.querySelectorAll('.tabbar .tab'));
  const last = tabs[tabs.length - 1];
  if (!plus || !last) return null;
  const p = plus.getBoundingClientRect();
  const l = last.getBoundingClientRect();
  return {
    visible: p.width > 0 && p.height > 0,
    afterLast: p.left >= l.right - 1,
    aria: plus.getAttribute('aria-label'),
    index: Array.from(plus.parentElement.children).indexOf(plus),
    childCount: plus.parentElement.children.length,
  };
});
check(
  'C1「+」按钮存在且排在最后一个标签之后',
  !!plusGeom && plusGeom.visible && plusGeom.afterLast && plusGeom.index === plusGeom.childCount - 1,
  JSON.stringify(plusGeom),
);
check('C2「+」有无障碍标签', plusGeom && plusGeom.aria === '新建文件', plusGeom ? plusGeom.aria : 'null');

// 点击「+」→ 弹对话框 → 取消
await page.locator('.tabbar .tabadd').click();
await page.waitForSelector('.modal', { timeout: 5000 });
const plusOpened = await page.locator('.modal .modal__title').first().innerText();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('C3 点击「+」弹出新建文件对话框', plusOpened.trim() === '新建文件', plusOpened.trim());

// 双击「+」只弹一个对话框（双击空白处的新建不能重复触发）
await page.locator('.tabbar .tabadd').dblclick();
await page.waitForTimeout(400);
const dlgs = await page.locator('.modal').count();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('C4 双击「+」只弹出一个对话框', dlgs === 1, `modal=${dlgs}`);

// 溢出场景：开一堆标签，「+」仍留在视口内
await page.evaluate(() => {
  for (let i = 0; i < 14; i += 1) {
    window.quillpad.createTab({ name: `长文件名测试-${i + 1}.txt` });
  }
  window.quillpad.tabsView.render();
});
await page.waitForTimeout(600);
const overflow = await page.evaluate(() => {
  const bar = document.getElementById('tabbar');
  const plus = document.querySelector('.tabbar .tabadd');
  const b = bar.getBoundingClientRect();
  const p = plus.getBoundingClientRect();
  return {
    overflowing: bar.scrollWidth > bar.clientWidth + 1,
    hasClass: bar.classList.contains('has-overflow'),
    inView: p.left >= b.left - 1 && p.right <= b.right + 1,
    tabs: document.querySelectorAll('.tabbar .tab').length,
  };
});
check(
  'C5 标签溢出时「+」吸附在可视区域内',
  overflow.overflowing && overflow.hasClass && overflow.inView,
  JSON.stringify(overflow),
);
await page.screenshot({ path: `${OUT}/v100-tab-add-overflow.png` });

// 「+」在溢出状态下点击仍然有效
const beforePlus = await tabCount();
await page.locator('.tabbar .tabadd').click();
await page.waitForSelector('.modal', { timeout: 5000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
check('C6 溢出状态下点「+」也能建文件', (await tabCount()) === beforePlus + 1, `${beforePlus} → ${await tabCount()}`);

/* ---------------------------------------------------------------- 收尾 */

await page.evaluate(() => window.quillpad.setFontSize(14));
check('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
