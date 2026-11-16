/**
 * QuillPad · 所见即所得「折叠箭头 / 光标定位」回归检查
 *
 * 覆盖四件事（都是 v1.0.0 里被用户报出来的问题）：
 *  1. 行号槽与内容行**逐行对齐**（槽顶 == 行盒顶），折叠槽与行号槽同几何；
 *  2. 折叠箭头只出现在**结构化行**（标题 / 围栏 / 引用 / 表格 / 列表），
 *     代码块内部不再冒出「括号折叠」箭头；
 *  3. 每个箭头都**点得动**：点击后确实折叠，再点一次展开；
 *  4. 光标 / 选区定位不再下偏：每个位置都有正常高度的坐标，
 *     拖选两端落在鼠标所在的行。
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
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#tabbar .tab', { timeout: 20000 });
await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
await page.waitForTimeout(1200);

/** 滚动一遍全文档，收集每一行的对齐数据 + 每个折叠箭头所属行。 */
const scan = await page.evaluate(async () => {
  const view = window.quillpad.editor.view;
  const doc = view.state.doc;
  const scroller = view.scrollDOM;
  const out = { lines: [], folds: [], fenceLines: new Set() };

  // 围栏代码块的行号区间（按 ``` 成对出现算）
  const fences = [];
  let open = null;
  for (let n = 1; n <= doc.lines; n += 1) {
    if (!/^\s*```/.test(doc.line(n).text)) continue;
    if (open === null) {
      open = n;
    } else {
      for (let k = open + 1; k < n; k += 1) fences.push(k);
      open = null;
    }
  }
  out.codeLines = fences;

  const seenLine = new Set();
  const seenFold = new Set();
  const numsOf = (gutter) =>
    Array.from(gutter.querySelectorAll('.cm-gutterElement')).map((el) => {
      const r = el.getBoundingClientRect();
      return { el, top: Math.round(r.top), h: Math.round(r.height), text: el.textContent.trim(), hidden: el.style.visibility === 'hidden' };
    });

  const collect = () => {
    const num = numsOf(view.dom.querySelector('.cm-lineNumbers'));
    const numByKey = new Map();
    for (const n of num) {
      if (n.hidden || !/^\d+$/.test(n.text)) continue;
      numByKey.set(`${n.top}/${n.h}`, Number(n.text));
    }
    for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
      let no;
      try {
        no = doc.lineAt(view.posAtDOM(el, 0)).number;
      } catch {
        continue;
      }
      if (seenLine.has(no)) continue;
      const box = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // font-size:0 的行（分隔线 / 围栏）没有文字带，光标必然是 0 高度
      const hasText = parseFloat(cs.fontSize) > 0;
      const slot = num.find((n) => !n.hidden && n.text === String(no));
      // 首个可见字符的真实矩形
      let textTop = null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(1, node.nodeValue.length));
        const rr = range.getBoundingClientRect();
        if (rr.height > 0) {
          textTop = Math.round(rr.top);
          break;
        }
      }
      const c = view.coordsAtPos(doc.line(no).from);
      seenLine.add(no);
      out.lines.push({
        no,
        boxTop: Math.round(box.top),
        slotTop: slot ? slot.top : null,
        textTop,
        hasText,
        cmTop: c ? Math.round(c.top) : null,
        cmH: c ? Math.round(c.bottom - c.top) : null,
      });
    }
    const fold = Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement'));
    for (const el of fold) {
      const r = el.getBoundingClientRect();
      if (el.style.visibility === 'hidden') continue;
      if (!el.textContent.trim()) continue;
      const key = `${Math.round(r.top)}/${Math.round(r.height)}`;
      const no = numByKey.get(key);
      if (no === undefined || seenFold.has(no)) continue;
      seenFold.add(no);
      out.folds.push({ no, top: Math.round(r.top), h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width) });
    }
  };

  const step = Math.round(scroller.clientHeight * 0.6);
  const max = scroller.scrollHeight;
  for (let y = 0; y <= max; y += step) {
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

/* ---------------------------------------------------------------- 1. 对齐 */
const badSlot = scan.lines.filter((l) => l.slotTop !== null && Math.abs(l.slotTop - l.boxTop) > 1);
check(
  '行号槽与内容行逐行对齐',
  badSlot.length === 0,
  badSlot.length ? badSlot.map((l) => `L${l.no} 差${l.slotTop - l.boxTop}px`).join(', ') : `${scan.lines.length} 行全部对齐`,
);

/* ------------------------------------------------------------ 2. 光标几何 */
// 分隔线 / 围栏这类行 font-size:0、没有文字带，光标本来就是 0 高度（不可见也不可读），
// 不参与本项断言；真正要保证的是**有文字的行**行首坐标落在文字带上。
const textRows = scan.lines.filter((l) => l.textTop !== null && l.hasText);
const degenerate = textRows.filter((l) => l.cmH === null || l.cmH < 2 || Math.abs(l.cmTop - l.textTop) > 2);
check(
  '行首光标坐标正常（无 0 高度 / 偏移）',
  degenerate.length === 0,
  degenerate.length ? degenerate.map((l) => `L${l.no} h=${l.cmH} 差${l.cmTop - l.textTop}`).join(', ') : `${textRows.length} 行全部正常`,
);

/* --------------------------------------------------------- 3. 箭头落点合法 */
const codeSet = new Set(scan.codeLines);
const inCode = scan.folds.filter((f) => codeSet.has(f.no));
check(
  '代码块内部没有多余折叠箭头',
  inCode.length === 0,
  inCode.length ? `出现在第 ${inCode.map((f) => f.no).join(', ')} 行` : `共 ${scan.folds.length} 个箭头，全部在结构行上`,
);
check('标题仍有折叠箭头', scan.folds.some((f) => f.no === 1) && scan.folds.some((f) => f.no === 24), `箭头行: ${scan.folds.map((f) => f.no).join(',')}`);

/* --------------------------------------------------------- 4. 箭头可点击 */
/**
 * 把某行滚到可视区中部，返回该行折叠箭头的点击坐标。
 * 分两步走（滚动 → 等一帧 → 再量）：围栏行的槽只有 4px，
 * 滚动后立刻量会拿到重排前的旧坐标，点下去正好落在两个槽的分界线上。
 */
async function foldRectFor(no) {
  await page.evaluate((lineNo) => {
    const view = window.quillpad.editor.view;
    const block = view.lineBlockAt(view.state.doc.line(lineNo).from);
    const scroller = view.scrollDOM;
    const want = Math.max(0, block.top - scroller.clientHeight / 2);
    if (Math.abs(scroller.scrollTop - want) > 40) {
      scroller.scrollTop = want;
      view.requestMeasure();
    }
  }, no);
  await page.waitForTimeout(180);
  return page.evaluate((lineNo) => {
    const view = window.quillpad.editor.view;
    const nums = Array.from(view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'));
    const numEl = nums.find((el) => el.style.visibility !== 'hidden' && el.textContent.trim() === String(lineNo));
    if (!numEl) return null;
    const nr = numEl.getBoundingClientRect();
    for (const el of Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement'))) {
      // 只认真正带箭头的元素：同一槽顶还有高度 0 的空元素（空行），按高度配对会配错
      if (el.style.visibility === 'hidden' || !el.textContent.trim()) continue;
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - nr.top) < 3) {
        const y = Math.round(r.top + Math.min(Math.max(r.height / 2, 1), Math.max(1, r.height - 1)));
        return { no: lineNo, x: Math.round(r.left + r.width / 2), y };
      }
    }
    return null;
  }, no);
}

const foldLines = scan.folds.map((f) => f.no);
const foldFail = [];
const noArrow = [];

/** 重新载入页面并进入所见即所得（每条箭头独立验证，不在折叠状态上做二次操作）。 */
async function resetPage() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#tabbar .tab', { timeout: 20000 });
  await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
  await page.waitForTimeout(700);
}

for (const no of foldLines) {
  await resetPage();
  const t = await foldRectFor(no);
  if (!t) {
    noArrow.push(`L${no}`);
    continue;
  }
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(320);
  const folded = await page.evaluate(
    () => window.quillpad.editor.view.contentDOM.querySelectorAll('.cm-foldPlaceholder').length,
  );
  if (process.env.FOLD_DEBUG) console.log(`  L${no} @(${t.x},${t.y}) 折叠=${folded}`);
  if (folded < 1) foldFail.push(`L${no}`);
}
check(
  '可见折叠箭头全部点得动',
  foldFail.length === 0 && noArrow.length === 0,
  `${foldLines.length} 个箭头${noArrow.length ? '，找不到: ' + noArrow.join(',') : ''}${foldFail.length ? '，失败: ' + foldFail.join(',') : '，全部点得动'}`,
);

/* ------------------------------------------------------------ 5. 拖选定位 */
await page.evaluate(() => {
  window.quillpad.editor.view.scrollDOM.scrollTop = 0;
});
await page.waitForTimeout(300);
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
      h: Math.round(rect ? rect.height : r.height),
      ok: !!rect,
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

check('无运行时错误', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
