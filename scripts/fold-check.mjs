/**
 * QuillPad · 行号栏 / 折叠箭头 / 光标定位回归检查
 *
 * v1.0.2 起**所见即所得不再显示行号栏与折叠箭头**（阅读面视图），源码与分栏保留。
 * 本脚本锁定这个边界，以及 v1.0.1 修好的光标定位：
 *
 *  1. 所见即所得下**没有**行号槽 / 折叠槽（`.cm-gutters` 整个不出现）；
 *  2. 有文字的行，行首光标坐标正常（不是 0 高度、不偏移）；
 *  3. 拖选两端与鼠标所在行一致；
 *  4. 源码模式**保留**行号与折叠箭头；
 *  5. 源码模式行号槽与内容行逐行对齐（原生行为，≤1px）；
 *  6. 源码模式的折叠箭头点得动（点一下出现折叠占位）；
 *  7. 源码里折叠过再切到所见即所得，不残留折叠（此时已无箭头可点，必须自动展开）；
 *  8. 全程无运行时错误。
 *
 * 用法: node scripts/fold-check.mjs [--url http://localhost:4173]
 */
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg || process.env.QUILLPAD_URL || 'http://localhost:4173';

const results = [];
const problems = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) problems.push(`${name} ${detail}`);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// 中文欢迎文档 + Ivory Light：与用户报障的文档 / 主题完全一致
await context.addInitScript(() => {
  try {
    window.localStorage.clear();
    window.localStorage.setItem(
      'quillpad.settings.v1',
      JSON.stringify({
        theme: 'ivory',
        themePinned: true,
        locale: 'zh-CN',
        sidebarVisible: true,
        sidebarTab: 'files',
        autoSave: false,
        fontSize: 14,
      }),
    );
  } catch {
    /* 隐私模式忽略 */
  }
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

/** 重新载入并进入指定视图模式。 */
async function enter(mode) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#tabbar .tab', { timeout: 20000 });
  await page.evaluate((m) => window.quillpad.setViewMode(m), mode);
  await page.waitForTimeout(900);
}

/* ------------------------------------------- 1. 所见即所得没有行号 / 折叠槽 */
await enter('wysiwyg');
const wy = await page.evaluate(() => {
  const gutters = document.querySelector('.cm-gutters');
  const content = document.querySelector('.cm-content');
  const scroller = document.querySelector('.cm-scroller');
  return {
    gutters: gutters ? Math.round(gutters.getBoundingClientRect().width) : null,
    lineNumbers: !!document.querySelector('.cm-lineNumbers'),
    foldGutter: !!document.querySelector('.cm-foldGutter'),
    // 内容列左缘与滚动容器左缘的差：没有行号槽时不应再留出槽宽
    offset: Math.round(content.getBoundingClientRect().left - scroller.getBoundingClientRect().left),
  };
});
check(
  '所见即所得下没有行号栏与折叠箭头',
  wy.gutters === null && !wy.lineNumbers && !wy.foldGutter,
  `gutters=${wy.gutters} lineNumbers=${wy.lineNumbers} foldGutter=${wy.foldGutter} 内容左移=${wy.offset}px`,
);

/* ------------------------------------------------- 2. 行首光标坐标（所见即所得） */
/**
 * 只在**真正可见的字符**上验光标几何。
 *
 * 分隔线（`---` 整行 font-size:0）、围栏行（``` 被 `.qp-md-hide` 零宽折叠）这几类
 * 位置上的文字矩形本来就是 0 高度，`coordsAtPos` 返回 0 高度是设计使然，不是缺陷；
 * v1.0.1 修的缺陷是**有文字的行**行首坐标偏低且高度为 0。所以这里跳过被
 * `.qp-md-hide` 包住的节点，只量第一个可见字符所在位置。
 */
const scanWysiwyg = await page.evaluate(async () => {
  const view = window.quillpad.editor.view;
  const doc = view.state.doc;
  const out = [];
  const seen = new Set();
  const collect = () => {
    for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
      let no;
      try {
        no = doc.lineAt(view.posAtDOM(el, 0)).number;
      } catch {
        continue;
      }
      if (seen.has(no)) continue;
      // 第一个可见字符（跳过 .qp-md-hide 里的隐藏标记、块级 widget 内部文字与纯空白）
      const WIDGET = '.qp-md-hide, .qp-code-head, .qp-table-wrap, .qp-toc, .qp-frontmatter, .qp-math--block, .qp-footnotes, .qp-img-wrap';
      let target = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        if (node.parentElement && node.parentElement.closest(WIDGET)) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(1, node.nodeValue.length));
        const rr = range.getBoundingClientRect();
        if (rr.height > 0) {
          target = { rect: rr, node };
          break;
        }
      }
      seen.add(no);
      if (!target) continue;
      let pos;
      try {
        pos = view.posAtDOM(target.node, 0);
      } catch {
        continue;
      }
      const c = view.coordsAtPos(pos);
      out.push({
        no,
        textTop: Math.round(target.rect.top),
        cmTop: c ? Math.round(c.top) : null,
        cmH: c ? Math.round(c.bottom - c.top) : null,
      });
    }
  };
  const scroller = view.scrollDOM;
  const step = Math.round(scroller.clientHeight * 0.6);
  for (let y = 0; y <= scroller.scrollHeight; y += step) {
    scroller.scrollTop = y;
    view.requestMeasure();
    await new Promise((res) => setTimeout(res, 120));
    collect();
  }
  scroller.scrollTop = 0;
  view.requestMeasure();
  await new Promise((res) => setTimeout(res, 200));
  return out;
});
const badCursor = scanWysiwyg.filter((l) => l.cmH === null || l.cmH < 2 || Math.abs(l.cmTop - l.textTop) > 2);
check(
  '可见字符处的光标坐标正常（无 0 高度 / 偏移）',
  scanWysiwyg.length >= 20 && badCursor.length === 0,
  badCursor.length
    ? badCursor.map((l) => `L${l.no} h=${l.cmH} 差${l.cmTop - l.textTop}`).join(', ')
    : `${scanWysiwyg.length} 行全部正常`,
);

/* ------------------------------------------------------------- 3. 拖选定位 */
const rows = await page.evaluate(() => {
  const view = window.quillpad.editor.view;
  const doc = view.state.doc;
  const out = [];
  for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
    const no = doc.lineAt(view.posAtDOM(el, 0)).number;
    if (![3, 9, 19, 24].includes(no)) continue;
    const r = el.getBoundingClientRect();
    const range = document.createRange();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    let rect = null;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue.trim()) continue;
      range.setStart(node, 0);
      range.setEnd(node, Math.min(1, node.nodeValue.length));
      const rr = range.getBoundingClientRect();
      if (rr.height > 0) {
        rect = rr;
        break;
      }
    }
    out.push({
      no,
      left: Math.round(rect ? rect.left : r.left),
      top: Math.round(rect ? rect.top : r.top),
    });
  }
  return out.sort((a, b) => a.no - b.no);
});
if (rows.length >= 2) {
  const a = rows[0];
  const b = rows[rows.length - 1];
  const x = a.left + 40;
  await page.mouse.move(x, a.top + 6);
  await page.mouse.down();
  await page.mouse.move(x, b.top + 6, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const sel = await page.evaluate(() => {
    const view = window.quillpad.editor.view;
    const r = view.state.selection.main;
    const doc = view.state.doc;
    return { fromLine: doc.lineAt(r.from).number, toLine: doc.lineAt(r.to).number };
  });
  check(
    '拖选落点与鼠标所在行一致',
    sel.fromLine === a.no && sel.toLine === b.no,
    `从 L${a.no} 拖到 L${b.no} → from=L${sel.fromLine} to=L${sel.toLine}`,
  );
} else {
  check('拖选落点与鼠标所在行一致', false, `未取到足够的目标行：${JSON.stringify(rows)}`);
}

/* ------------------------------------------------- 4/5. 源码模式保留且对齐 */
await enter('source');
const src = await page.evaluate(async () => {
  const view = window.quillpad.editor.view;
  const doc = view.state.doc;
  const gutters = document.querySelector('.cm-gutters');
  const nums = () =>
    Array.from(view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), text: el.textContent.trim(), vis: el.style.visibility !== 'hidden' };
    });
  const folds = () =>
    Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement')).filter(
      (el) => el.style.visibility !== 'hidden' && el.textContent.trim(),
    ).length;

  let worst = 0;
  const bad = [];
  let checked = 0;
  const seen = new Set();
  const collect = () => {
    const slots = nums().filter((n) => n.vis && /^\d+$/.test(n.text));
    for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
      let no;
      try {
        no = doc.lineAt(view.posAtDOM(el, 0)).number;
      } catch {
        continue;
      }
      if (seen.has(no)) continue;
      const slot = slots.find((n) => n.text === String(no));
      if (!slot) continue;
      seen.add(no);
      const box = el.getBoundingClientRect();
      const diff = Math.abs(slot.top - Math.round(box.top));
      checked += 1;
      if (diff > worst) worst = diff;
      if (diff > 1) bad.push(`L${no} 差${diff}`);
    }
  };
  const scroller = view.scrollDOM;
  const step = Math.round(scroller.clientHeight * 0.6);
  for (let y = 0; y <= scroller.scrollHeight; y += step) {
    scroller.scrollTop = y;
    view.requestMeasure();
    await new Promise((res) => setTimeout(res, 120));
    collect();
  }
  scroller.scrollTop = 0;
  view.requestMeasure();
  await new Promise((res) => setTimeout(res, 200));
  return {
    gutterWidth: gutters ? Math.round(gutters.getBoundingClientRect().width) : 0,
    numberCount: nums().filter((n) => n.vis && n.text).length,
    foldCount: folds(),
    aligned: checked,
    worst,
    bad: bad.slice(0, 6),
  };
});
check(
  '源码模式保留行号栏与折叠箭头',
  src.gutterWidth > 0 && src.numberCount >= 10 && src.foldCount >= 3,
  `槽宽=${src.gutterWidth}px 行号=${src.numberCount} 箭头=${src.foldCount}`,
);
check(
  '源码模式行号与内容行逐行对齐（≤1px）',
  src.aligned >= 10 && src.worst <= 1,
  `${src.aligned} 行 worst=${src.worst}px${src.bad.length ? ' ' + src.bad.join(',') : ''}`,
);

/* -------------------------------------------- 6. 源码模式箭头点得动 */
const arrow = await page.evaluate(() => {
  const view = window.quillpad.editor.view;
  const num = Array.from(view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')).find(
    (el) => el.style.visibility !== 'hidden' && el.textContent.trim() === '1',
  );
  if (!num) return null;
  const nr = num.getBoundingClientRect();
  for (const el of Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement'))) {
    if (el.style.visibility === 'hidden' || !el.textContent.trim()) continue;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.top - nr.top) < 3) {
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
  }
  return null;
});
let foldedInSource = 0;
if (arrow) {
  await page.mouse.click(arrow.x, arrow.y);
  await page.waitForTimeout(320);
  foldedInSource = await page.evaluate(
    () => window.quillpad.editor.view.contentDOM.querySelectorAll('.cm-foldPlaceholder').length,
  );
}
check(
  '源码模式折叠箭头点得动',
  !!arrow && foldedInSource > 0,
  arrow ? `折叠占位 ${foldedInSource} 个` : '未找到 L1 的箭头',
);

/* ------------------- 7. 折叠状态不残留到所见即所得（那边已无箭头可点） */
await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
await page.waitForTimeout(700);
const leftover = await page.evaluate(() => {
  const view = window.quillpad.editor.view;
  return {
    placeholders: view.contentDOM.querySelectorAll('.cm-foldPlaceholder').length,
    gutters: !!document.querySelector('.cm-gutters'),
  };
});
check(
  '切到所见即所得后折叠自动展开、槽位仍不出现',
  leftover.placeholders === 0 && !leftover.gutters,
  `折叠占位=${leftover.placeholders} gutters=${leftover.gutters}`,
);

check('无运行时错误', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
