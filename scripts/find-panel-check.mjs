/**
 * QuillPad · 查找面板 / 命令面板 缺陷回归（QA 第二轮 4 条）
 *
 * 覆盖：
 *   1) P1-1 查找面板「区分大小写 / 全词匹配」开关真正生效（编辑器面板 + 在文件中查找面板）
 *   2) P2-2 查找面板 Alt+C / Alt+W / Alt+R 快捷键生效（与按钮 title 承诺一致）
 *   3) P2-3 命令面板把 enabled() 为 false 的命令置灰，回车给出「当前不可用」提示
 *   4) P2-4 非法正则显示「正则无效」，与「无结果」区分开
 *
 * 用法：npm run build && npm run preview，然后 node scripts/find-panel-check.mjs
 */
import { chromium } from 'playwright-core';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';

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
await page.waitForTimeout(800);

/**
 * 把当前文档内容替换为指定文本，并把光标折叠到开头（避免查找框被选区预填）。
 * @param {string} text 文档内容
 */
async function setDoc(text) {
  await page.evaluate((t) => {
    const view = window.quillpad.editor.view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: t },
      selection: { anchor: 0 },
    });
  }, text);
  await page.waitForTimeout(300);
}

/**
 * 读取编辑器查找面板的计数文本与开关状态。
 * @return {Promise<{count: string, total: number, caseOn: boolean, wordOn: boolean, regexpOn: boolean}>}
 */
async function readPanel() {
  return page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const count = q('.qp-search [data-role="count"]')?.textContent?.trim() || '';
    const m = count.match(/(\d+)\s*\/\s*(\d+)/);
    return {
      count,
      // 命中总数（分母）；激活项序号会随光标变化，所以只断言总数
      total: m ? Number(m[2]) : 0,
      caseOn: !!q('.qp-search [data-toggle="case"]')?.classList.contains('is-on'),
      wordOn: !!q('.qp-search [data-toggle="word"]')?.classList.contains('is-on'),
      regexpOn: !!q('.qp-search [data-toggle="regexp"]')?.classList.contains('is-on'),
    };
  });
}

/**
 * 打开编辑器查找面板并输入关键词。
 * @param {string} keyword 关键词
 */
async function openFind(keyword) {
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.qp-search [data-role="search"]', { timeout: 8000 });
  await page.locator('.qp-search [data-role="search"]').fill(keyword);
  await page.waitForTimeout(500);
}

/** 关闭编辑器查找面板。 */
async function closeFind() {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/* ------------------------------------------- 1) P1-1 区分大小写 / 全词匹配开关 */

// 1-1 区分大小写
await setDoc('cat Cat CAT');
await openFind('cat');
let panel = await readPanel();
const beforeCase = panel.total;
await page.locator('.qp-search [data-toggle="case"]').click();
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P1-1 查找面板「区分大小写」开关真实生效',
  beforeCase === 3 && panel.total === 1 && panel.caseOn === true,
  `关闭=${beforeCase} 开启=${panel.total} 按钮高亮=${panel.caseOn}`,
);

// 1-2 关闭后应恢复
await page.locator('.qp-search [data-toggle="case"]').click();
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P1-1 「区分大小写」可再次关闭并恢复命中数',
  panel.total === 3 && panel.caseOn === false,
  `关闭后命中总数=${panel.total} 按钮高亮=${panel.caseOn}`,
);

// 1-3 全词匹配
await closeFind();
await setDoc('cat cats cat2');
await openFind('cat');
const beforeWord = (await readPanel()).total;
await page.locator('.qp-search [data-toggle="word"]').click();
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P1-1 查找面板「全词匹配」开关真实生效',
  beforeWord === 3 && panel.total === 1 && panel.wordOn === true,
  `关闭=${beforeWord} 开启=${panel.total} 按钮高亮=${panel.wordOn}`,
);
await closeFind();

/* ------------------------------------------------ 2) P2-2 Alt+C / Alt+W / Alt+R */

// 2-1 Alt+C
await setDoc('cat Cat CAT');
await openFind('cat');
await page.keyboard.press('Alt+c');
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P2-2 Alt+C 等于点击「区分大小写」',
  panel.total === 1 && panel.caseOn === true,
  `命中总数=${panel.total} 高亮=${panel.caseOn}`,
);

// 2-2 Alt+W（内容换成 cat cats cat2，全词匹配才会真正减少命中）
await closeFind();
await setDoc('cat cats cat2');
await openFind('cat');
await page.keyboard.press('Alt+w');
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P2-2 Alt+W 等于点击「全词匹配」',
  panel.total === 1 && panel.wordOn === true,
  `命中总数=${panel.total} 全词高亮=${panel.wordOn}`,
);

// 2-3 Alt+R
await closeFind();
await setDoc('cat Cat CAT');
await openFind('cat');
await page.keyboard.press('Alt+r');
await page.waitForTimeout(400);
panel = await readPanel();
check(
  'P2-2 Alt+R 等于点击「正则表达式」',
  panel.regexpOn === true,
  `正则高亮=${panel.regexpOn} count=${panel.count}`,
);
await closeFind();

/* ------------------------------------------------------ 3) P2-4 非法正则提示 */

await setDoc('value = a(b;');
await openFind('(b');
const literalCount = (await readPanel()).count;
await page.locator('.qp-search [data-toggle="regexp"]').click();
await page.waitForTimeout(400);
panel = await readPanel();
const errClass = await page.evaluate(
  () => !!document.querySelector('.qp-search [data-role="count"]')?.classList.contains('is-error'),
);
check(
  'P2-4 非法正则显示「正则无效」而不是「无结果」',
  literalCount === '1 / 1' && panel.count === '正则无效' && errClass === true,
  `字面量=${literalCount} 正则=${panel.count} 错误样式=${errClass}`,
);
await closeFind();

/* ------------------------------------ 4) P1-1 在文件中查找面板的开关同样生效 */

await setDoc('cat Cat CAT');
await page.keyboard.press('Control+Shift+F');
await page.waitForSelector('#find-files [data-role="search"]', { timeout: 8000 });
await page.locator('#find-files [data-role="search"]').fill('cat');
await page.waitForTimeout(900);
const summaryBefore = await page.locator('#find-files [data-role="summary"]').innerText();
await page.locator('#find-files [data-toggle="case"]').click();
await page.waitForTimeout(900);
const summaryAfter = await page.locator('#find-files [data-role="summary"]').innerText();
check(
  'P1-1 「在文件中查找」的大小写开关真实生效',
  /3 处匹配/.test(summaryBefore) && /1 处匹配/.test(summaryAfter),
  `关闭=${summaryBefore.trim()} 开启=${summaryAfter.trim()}`,
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* --------------------------------- 5) P2-3 命令面板对不可用命令置灰并提示 */

// 把当前文档切成纯文本，使「Markdown 预览」不可用
await page.evaluate(async () => {
  await window.quillpad.setLanguage('plaintext');
});
await page.waitForTimeout(500);
await page.keyboard.press('Control+Shift+P');
await page.waitForSelector('.palette__input', { timeout: 8000 });
await page.locator('.palette__input').fill('Markdown 预览');
await page.waitForTimeout(500);
const paletteState = await page.evaluate(() => {
  const item = Array.from(document.querySelectorAll('.palette__item')).find((n) =>
    n.textContent.includes('Markdown 预览'),
  );
  return {
    found: !!item,
    disabled: !!item?.classList.contains('is-disabled'),
    aria: item?.getAttribute('aria-disabled') || '',
  };
});
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const afterEnter = await page.evaluate(() => ({
  paletteOpen: !!document.querySelector('.palette'),
  toasts: Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent).join(' | '),
  previewVisible: !document.querySelector('#preview-pane')?.hidden,
}));
check(
  'P2-3 命令面板把不可用命令置灰（aria-disabled=true）',
  paletteState.found && paletteState.disabled && paletteState.aria === 'true',
  JSON.stringify(paletteState),
);
check(
  'P2-3 不可用命令回车给出「当前不可用」提示且不静默失败',
  /当前不可用/.test(afterEnter.toasts) && afterEnter.paletteOpen === true && afterEnter.previewVisible === false,
  JSON.stringify(afterEnter),
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

check('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
await browser.close();
process.exit(failed.length ? 1 : 0);
