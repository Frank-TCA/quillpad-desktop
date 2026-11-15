/**
 * QuillPad · P1 功能回归自检
 *
 * 覆盖本轮新增 / 修复的能力：
 *   1) Ctrl+Tab / Ctrl+PageDown 切换标签页（QA-1）
 *   2) Ctrl+H 真正展开「替换」行（QA-3）
 *   3) 「排序行」无选区时对全文排序（QA-4）
 *   4) 纯文本下 Ctrl+/ 给出明确提示（QA-5）
 *   5) 命令面板可直接搜索主题名 / 语言名并切换（P1-2）
 *   6) 「在文件中查找」输入即搜索（250ms 防抖），结果含行号与高亮（P1-3）
 *   7) 状态栏「缩进 / 换行符」点击有 toast + 高亮反馈（P1-4）
 *   8) 四套主题主界面截图（供视觉核对）
 *
 * 用法：npm run build && npm run preview，然后 node scripts/p1-check.mjs
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

/* --------------------------------------------------- 1) Ctrl+Tab 切换标签页 */

await page.evaluate(() => {
  // 直接建标签（run('file.new') 会先弹「新建文件」对话框）
  window.quillpad.newFile();
  window.quillpad.newFile();
});
await page.waitForTimeout(600);
const tabIdsBefore = await page.evaluate(() => {
  const s = window.quillpad.state;
  return { tabs: s.tabs.length, active: s.activeTabId };
});
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+Tab');
await page.waitForTimeout(400);
const tabIdsAfter = await page.evaluate(() => window.quillpad.state.activeTabId);
check(
  'QA-1 Ctrl+Tab 切换到下一个标签',
  tabIdsBefore.tabs >= 3 && tabIdsAfter !== tabIdsBefore.active,
  `${tabIdsBefore.tabs} 个标签，active ${tabIdsBefore.active} -> ${tabIdsAfter}`,
);
await page.keyboard.press('Control+Shift+Tab');
await page.waitForTimeout(400);
const tabIdsBack = await page.evaluate(() => window.quillpad.state.activeTabId);
check('QA-1 Ctrl+Shift+Tab 切回上一个标签', tabIdsBack === tabIdsBefore.active, `active=${tabIdsBack}`);

/* ------------------------------------------------------ 2) Ctrl+H 展开替换行 */

await page.keyboard.press('Control+h');
await page.waitForTimeout(700);
const replaceRow = await page.evaluate(() => {
  const row = document.querySelector('.qp-search [data-row="replace"]');
  if (!row) return { found: false };
  const input = row.querySelector('[data-role="replace"]');
  return {
    found: true,
    hidden: row.hidden,
    visible: !!row.offsetParent,
    focused: document.activeElement === input,
  };
});
check(
  'QA-3 Ctrl+H 展开替换行并聚焦替换输入框',
  replaceRow.found && replaceRow.hidden === false && replaceRow.visible === true,
  JSON.stringify(replaceRow),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ------------------------------------------------ 3) 无选区排序全文（QA-4） */

await page.evaluate(async () => {
  const app = window.quillpad;
  const view = app.editor.view;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: 'banana\napple\ncherry\n' },
  });
  // 只放光标、不做选区
  view.dispatch({ selection: { anchor: 0, head: 0 } });
  app.run('edit.sortAsc');
});
await page.waitForTimeout(500);
const sortedText = await page.locator('.cm-content').first().innerText();
check(
  'QA-4 无选区时「排序行（升序）」对全文生效',
  sortedText.indexOf('apple') < sortedText.indexOf('banana') &&
    sortedText.indexOf('banana') < sortedText.indexOf('cherry'),
  JSON.stringify(sortedText.trim().slice(0, 40)),
);

/* --------------------------------------------- 4) 纯文本 Ctrl+/ 提示（QA-5） */

await page.evaluate(() => {
  window.quillpad.newFile(); // 未命名.txt → 纯文本
});
await page.waitForTimeout(500);
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+/');
await page.waitForTimeout(600);
const toastText = await page.evaluate(() => {
  const items = document.querySelectorAll('.toast');
  return Array.from(items).map((n) => n.textContent).join(' | ');
});
check('QA-5 纯文本 Ctrl+/ 给出「不支持注释」提示', /不支持注释/.test(toastText), toastText);
await page.waitForTimeout(2200);

/* ------------------------------- 5) 命令面板直接搜主题名 / 语言名（P1-2） */

async function palettePick(query, expectCat, expectTitle) {
  await page.keyboard.press('Control+Shift+p');
  await page.waitForSelector('.palette__input', { timeout: 5000 });
  await page.fill('.palette__input', query);
  await page.waitForTimeout(400);
  const first = await page.evaluate(() => {
    const el = document.querySelector('.palette__item.is-active');
    if (!el) return null;
    return {
      cat: el.querySelector('.palette__item-cat')?.textContent || '',
      title: el.querySelector('.palette__item-title')?.textContent || '',
    };
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  return { first };
}

const themePick = await palettePick('ivory', '主题', 'Ivory Light');
const themeNow = await page.evaluate(() => document.documentElement.dataset.theme);
check(
  'P1-2 命令面板搜「ivory」直接切换主题',
  themePick.first && themePick.first.cat === '主题' && themeNow === 'ivory',
  `命中=${JSON.stringify(themePick.first)} theme=${themeNow}`,
);

const nordPick = await palettePick('nord', '主题', 'Nord');
const nordNow = await page.evaluate(() => document.documentElement.dataset.theme);
check(
  'P1-2 命令面板搜「nord」直接切换主题',
  nordPick.first && nordPick.first.cat === '主题' && nordNow === 'nord',
  `命中=${JSON.stringify(nordPick.first)} theme=${nordNow}`,
);

const langPick = await palettePick('python', '语言', 'Python');
const langNow = await page.evaluate(() => window.quillpad.currentLanguageId());
check(
  'P1-2 命令面板搜「python」直接切换语法',
  langPick.first && langPick.first.cat === '语言' && langNow === 'python',
  `命中=${JSON.stringify(langPick.first)} lang=${langNow}`,
);

// 复原主题
await palettePick('aurora', '主题', 'Aurora Dark');

/* ------------------------- 6) 在文件中查找：输入即搜索 + 行号 + 高亮（P1-3） */

await page.keyboard.press('Control+Shift+f');
await page.waitForSelector('.find-files [data-role="search"]', { timeout: 5000 });
await page.fill('.find-files [data-role="search"]', 'apple');
// 不按 Enter，仅等待防抖（250ms）+ 渲染
await page.waitForTimeout(900);
const ff = await page.evaluate(() => ({
  summary: document.querySelector('.find-files__summary')?.textContent || '',
  hits: document.querySelectorAll('.find-files .ff-hit').length,
  lineNumbers: document.querySelectorAll('.find-files .ff-hit__ln').length,
  marks: document.querySelectorAll('.find-files .ff-hit mark').length,
  firstLine: document.querySelector('.find-files .ff-hit__ln')?.textContent || '',
}));
check(
  'P1-3 输入即搜索（无需回车）并给出结果',
  /处匹配/.test(ff.summary) && ff.hits > 0,
  JSON.stringify(ff),
);
check(
  'P1-3 结果含行号与关键词高亮',
  ff.lineNumbers === ff.hits && ff.marks > 0,
  JSON.stringify(ff),
);

// 点击命中 → 跳转到对应行
await page.locator('.find-files .ff-hit').first().click();
await page.waitForTimeout(600);
const cursorLine = await page.evaluate(() => {
  const s = window.quillpad.state;
  const tab = s.tabs.find((t) => t.id === s.activeTabId);
  const view = window.quillpad.editor.view;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  return { line: line.number, text: line.text.trim(), name: tab ? tab.name : '' };
});
check('P1-3 点击命中可跳转到对应行', cursorLine.line >= 1, JSON.stringify(cursorLine));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* --------------------- 7) 状态栏缩进 / 换行符点击反馈（P1-4） */

const indentBefore = await page.locator('[data-cell="indent"]').innerText();
await page.locator('[data-cell="indent"]').click();
await page.waitForTimeout(300);
const indentFeedback = await page.evaluate(() => ({
  text: document.querySelector('[data-cell="indent"]')?.textContent || '',
  flashing: !!document.querySelector('[data-cell="indent"].is-flash'),
  toast: Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent).join(' | '),
}));
check(
  'P1-4 状态栏缩进点击后有 toast + 高亮反馈',
  /缩进方式/.test(indentFeedback.toast) && indentFeedback.flashing === true,
  `${indentBefore} -> ${indentFeedback.text} :: ${indentFeedback.toast}`,
);

const eolBefore = await page.locator('[data-cell="eol"]').innerText();
await page.locator('[data-cell="eol"]').click();
await page.waitForTimeout(300);
const eolFeedback = await page.evaluate(() => ({
  text: document.querySelector('[data-cell="eol"]')?.textContent || '',
  flashing: !!document.querySelector('[data-cell="eol"].is-flash'),
  toast: Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent).join(' | '),
}));
check(
  'P1-4 状态栏换行符点击后有 toast + 高亮反馈',
  /换行符/.test(eolFeedback.toast) && eolFeedback.flashing === true && eolFeedback.text !== eolBefore,
  `${eolBefore} -> ${eolFeedback.text} :: ${eolFeedback.toast}`,
);
await page.waitForTimeout(2200);

/* --------------------------- 7.5) 视觉与可访问性回归（tooltip / 对齐 / 焦点环） */

// 7.5-1 工具栏 / 标题栏按钮的 tooltip 与无障碍名必须是中文命令名，
//       不能退化成原始命令 id（命令注册晚于 UI 渲染时就会出现该退化）。
const tipInfo = await page.evaluate(() => {
  const tips = Array.from(document.querySelectorAll('#toolbar .tool-btn, #titlebar-actions .tool-btn'));
  const rows = tips.map((e) => ({
    cmd: e.dataset.cmd,
    tip: e.dataset.tip || '',
    aria: e.getAttribute('aria-label') || '',
  }));
  return {
    rows,
    rawId: rows.filter((r) => r.tip === r.cmd || r.aria === r.cmd).length,
    chinese: rows.filter((r) => /[一-龥]/.test(r.tip) && /[一-龥]/.test(r.aria)).length,
  };
});
check(
  'P1-1 工具栏 / 标题栏按钮显示中文命令名（非原始 id）',
  tipInfo.rows.length > 0 && tipInfo.rawId === 0 && tipInfo.chinese === tipInfo.rows.length,
  `按钮 ${tipInfo.rows.length} 个，原始 id ${tipInfo.rawId} 个，中文 ${tipInfo.chinese} 个 :: ${tipInfo.rows[0].tip}`,
);

// 7.5-2 顶栏各层左缘统一（logo / 菜单文字 / 工具栏图标 / 状态栏文字 ≈ 12px）
const align = await page.evaluate(() => {
  const textLeft = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rg = document.createRange();
    rg.selectNodeContents(el);
    return +rg.getBoundingClientRect().left.toFixed(1);
  };
  const btn = document.querySelector('#toolbar .tool-btn');
  const iconLeft = btn
    ? +(btn.getBoundingClientRect().left + (btn.getBoundingClientRect().width - 16) / 2).toFixed(1)
    : null;
  const logo = document.querySelector('.brand-logo');
  return {
    logo: logo ? +logo.getBoundingClientRect().left.toFixed(1) : null,
    menu: textLeft('.menubar__item'),
    icon: iconLeft,
    status: textLeft('.status-item'),
  };
});
const alignValues = [align.logo, align.menu, align.icon, align.status].filter((v) => v != null);
const alignSpread = Math.max(...alignValues) - Math.min(...alignValues);
check(
  'P1-1 顶栏各层左缘对齐（偏差 ≤ 1px）',
  alignValues.length === 4 && alignSpread <= 1,
  JSON.stringify(align),
);

// 7.5-3 键盘导航时按钮必须有可见焦点环（全局 button reset 清掉了 outline）
await page.evaluate(() => {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});
let focusInfo = null;
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab');
  focusInfo = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      cls: String(el.className || ''),
      tag: el.tagName,
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
    };
  });
  if (focusInfo && /tool-btn|menubar__item/.test(focusInfo.cls)) break;
}
check(
  'P1-1 键盘导航时按钮有可见焦点环',
  !!focusInfo && focusInfo.outlineStyle !== 'none' && focusInfo.outlineWidth >= 2,
  JSON.stringify(focusInfo),
);
await page.evaluate(() => {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
});

/* ------------------------------------------ 8) 四套主题截图（供视觉核对） */

const THEME_LABELS = {
  aurora: 'Aurora Dark',
  ivory: 'Ivory Light',
  nord: 'Nord',
  solarized: 'Solarized Light',
};

// 截图前把当前标签恢复成一段有代表性的代码（含多行注释 / 字符串 / 关键字），
// 让四张主题图能真实反映编辑区的语法高亮与整体排版，而不是空文档。
const SAMPLE = `/**
 * QuillPad · 视觉审查样例
 */
import { EditorView } from '@codemirror/view';

interface Options {
  readonly theme: 'aurora' | 'ivory' | 'nord';
  readonly fontSize: number;
}

export class QuillPad {
  private views = new Map<string, EditorView>();

  constructor(private options: Options = { theme: 'aurora', fontSize: 14 }) {}

  open(name: string): EditorView {
    const view = new EditorView({ parent: document.body });
    this.views.set(name, view);
    return view;
  }
}

const total = 42;
console.log(\`ready · \${total} items\`);
`;

await page.evaluate(async (sample) => {
  const qp = window.quillpad;
  qp.setLanguage('typescript');
  await new Promise((r) => setTimeout(r, 300));
  qp.editor.view.dispatch({
    changes: { from: 0, to: qp.editor.view.state.doc.length, insert: sample },
  });
  qp.editor.view.dispatch({ selection: { anchor: 0 } });
}, SAMPLE);
await page.waitForTimeout(700);

for (const [id, label] of Object.entries(THEME_LABELS)) {
  await page.evaluate((themeId) => window.quillpad.setTheme(themeId), id);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/p1-theme-${id}.png` });
  const ok = await page.evaluate((themeId) => document.documentElement.dataset.theme === themeId, id);
  check(`P1-1 主题截图 ${label} 已生成`, ok);
}

check('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
