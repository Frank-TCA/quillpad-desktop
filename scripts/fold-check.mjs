/**
 * QuillPad · 行号栏 / 折叠箭头 / 光标定位回归检查
 *
 * v1.0.2 曾把所见即得当成纯阅读面，隐藏了行号栏与折叠箭头；**v1.0.4 需求反转**：
 * 所见即得重新装上行号槽与折叠槽，并要求行号与每行首个可见字符垂直对齐（≤1.5px）。
 * 本脚本锁定新边界，以及 v1.0.1 修好的光标定位：
 *
 *  1. 所见即所得**有**行号槽 / 折叠槽，且行号与该行首个可见字符 top 差 ≤1.5px；
 *  2. 有文字的行，行首光标坐标正常（不是 0 高度、不偏移）；
 *  3. 拖选两端与鼠标所在行一致；
 *  4. 源码模式**保留**行号与折叠箭头；
 *  5. 源码模式行号槽与内容行逐行对齐（原生行为，≤1px）；
 *  6. 源码模式的折叠箭头点得动（点一下出现折叠占位）；
 *  7. 切到所见即所得后行号槽仍在，折叠状态不被静默清空、且能在本视图展开；
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

/* -------------------------- 1. 所见即所得有行号 / 折叠槽，且逐行对齐（需求变更） */
/**
 * ⚠️ 本条与 v1.0.2~v1.0.3 的断言**方向相反**：当时的断言是「所见即得下没有行号栏
 * 与折叠箭头」，v1.0.4 的需求要求恢复这两列，因此旧断言被需求作废（不是回归），
 * 这里改成「有槽位 + 逐行对齐」。其余断言（源码模式对齐、箭头点得动、光标几何）
 * 一条都没有放宽。
 */
await enter('wysiwyg');
const wy = await page.evaluate(async () => {
  const view = window.quillpad.editor.view;
  const doc = view.state.doc;
  const gutters = document.querySelector('.cm-gutters');
  const scroller = document.querySelector('.cm-scroller');
  const content = document.querySelector('.cm-content');

  /** 行号数字的文本矩形 */
  const numRect = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const idx = (node.nodeValue || '').search(/\S/);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 1);
        const r = range.getBoundingClientRect();
        if (r.height > 0) return r;
      }
      node = walker.nextNode();
    }
    return null;
  };
  /** 行内首个可见字符的矩形（跳过隐藏标记与 widget 内部文字） */
  const charRect = (line) => {
    const SKIP =
      '.qp-md-hide, .qp-code-head, .qp-code-ops, .qp-table-wrap, .qp-toc, .qp-frontmatter, .qp-math--block, .qp-footnotes, .qp-img-wrap';
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const idx = (node.nodeValue || '').search(/\S/);
      if (idx >= 0 && !(node.parentElement && node.parentElement.closest(SKIP))) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 1);
        const r = range.getBoundingClientRect();
        if (r.height > 0) return r;
      }
      node = walker.nextNode();
    }
    return null;
  };

  let checked = 0;
  let worst = 0;
  const bad = [];
  const seen = new Set();
  const collect = () => {
    const nums = Array.from(
      view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    ).filter((el) => el.style.visibility !== 'hidden' && /^\d+$/.test(el.textContent.trim()));
    for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
      let no;
      try {
        no = doc.lineAt(view.posAtDOM(el, 0)).number;
      } catch {
        continue;
      }
      if (seen.has(no)) continue;
      const slot = nums.find((n) => n.textContent.trim() === String(no));
      if (!slot) continue;
      const cr = charRect(el);
      // 空行没有首字符，不在本条判定范围内（另有分组断言覆盖）
      if (!cr) continue;
      const nr = numRect(slot);
      if (!nr) continue;
      seen.add(no);
      const d = Math.abs(nr.top - cr.top);
      checked += 1;
      if (d > worst) worst = Math.round(d * 10) / 10;
      if (d > 1.5) bad.push(`L${no} 差${Math.round(d * 10) / 10}`);
    }
  };
  const step = Math.round(view.scrollDOM.clientHeight * 0.6);
  for (let y = 0; y <= view.scrollDOM.scrollHeight; y += step) {
    view.scrollDOM.scrollTop = y;
    view.requestMeasure();
    await new Promise((res) => setTimeout(res, 130));
    collect();
  }
  view.scrollDOM.scrollTop = 0;
  view.requestMeasure();
  await new Promise((res) => setTimeout(res, 220));
  collect();
  return {
    gutters: gutters ? Math.round(gutters.getBoundingClientRect().width) : null,
    lineNumbers: !!document.querySelector('.cm-lineNumbers'),
    foldGutter: !!document.querySelector('.cm-foldGutter'),
    /* 布局验算：行号槽贴滚动区左缘（与源码模式同一水平位置），正文列在槽位
       右侧的剩余空间居中 —— 左（槽右缘→正文左缘）与右（正文右缘→滚动区右缘）
       两段留白应当等宽。 */
    gutterLeft: Math.round(gutters.getBoundingClientRect().left - scroller.getBoundingClientRect().left),
    gapLeft: Math.round(content.getBoundingClientRect().left - gutters.getBoundingClientRect().right),
    /* 右留白要按**可视宽**算（`clientWidth` 已扣掉竖向滚动条）：
       用 rect.right 会把滚动条那 10px 也算成留白，装到本机后就会出现 199 / 209 的假失败。 */
    gapRight: Math.round(
      scroller.getBoundingClientRect().left +
        scroller.clientWidth -
        content.getBoundingClientRect().right,
    ),
    checked,
    worst,
    bad: bad.slice(0, 6),
  };
});
check(
  '所见即所得有行号栏与折叠槽（v1.0.4 需求变更，反向断言已作废）',
  wy.gutters !== null && wy.gutters > 0 && wy.lineNumbers && wy.foldGutter,
  `gutters=${wy.gutters} lineNumbers=${wy.lineNumbers} foldGutter=${wy.foldGutter}`,
);
check(
  '所见即所得行号槽贴左、正文列在剩余空间居中',
  wy.gutterLeft === 0 && Math.abs(wy.gapLeft - wy.gapRight) <= 1 && wy.gapLeft > 0,
  `槽左偏=${wy.gutterLeft}px 左留白=${wy.gapLeft}px 右留白=${wy.gapRight}px`,
);
check(
  '所见即所得行号与该行首个可见字符 top 差 ≤1.5px',
  wy.checked >= 10 && wy.worst <= 1.5,
  `${wy.checked} 行 worst=${wy.worst}px${wy.bad.length ? ' ' + wy.bad.join(',') : ''}`,
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

/**
 * 量出 3 / 9 / 19 / 24 行首个可见字符的坐标。
 *
 * **只能在视口内拖**：鼠标坐标落到视口外时，落点要靠 CodeMirror 的拖选自动
 * 滚动去逼近，实测同一个坐标连续 5 轮分别落到 L23 / L25（±1 抖动）。
 * 空行改成整行高度后欢迎文档整体高了约 100px，第 24 行掉到 900px 视口外
 * （y=977），这条断言就变成了 flaky —— 是量法不稳，不是落点算错：
 * 两端都在视口内时 5/5 精确命中。所以先滚到起点可见，再只在**完整可见**的
 * 候选行里挑最远的一行作为终点（断言本身不变）。
 *
 * @return {Promise<Array<{no:number,left:number,top:number}>>}
 */
const measureRows = () =>
  page.evaluate(() => {
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

let rows = await measureRows();
if (rows.length >= 2) {
  // 起点滚到视口上部，然后在完整可见的候选行里挑最远的一行当终点
  await page.evaluate((no) => {
    const view = window.quillpad.editor.view;
    const sc = view.scrollDOM;
    const block = view.lineBlockAt(view.state.doc.line(no).from);
    sc.scrollTop = Math.max(0, block.top - 80);
  }, rows[0].no);
  await page.waitForTimeout(320);
  const box = await page.evaluate(() => {
    const r = document.querySelector('.cm-scroller').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const all = await measureRows();
  const visible = all.filter((r) => r.top > box.top + 8 && r.top + 24 < box.bottom - 8);
  if (visible.length >= 2) rows = visible;
}
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

/* ------------- 7. 折叠状态跨模式保留，且能在所见即所得里就地展开（需求变更） */
/**
 * ⚠️ 同样是被需求作废的反向断言：v1.0.2 时所见即得没有箭头，源码里折叠过的行切过来
 * 会变成「看不见、也点不开」的死状态，所以进入本模式时强制 `unfoldAll`，断言是
 * 「切过来后折叠占位消失、槽位不出现」。v1.0.4 恢复了折叠槽，箭头点得动，折叠状态
 * 属于文档本身，切模式不该被静默清空 —— 断言改为「槽位在、折叠保留、并且能就地展开」。
 */
await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
await page.waitForTimeout(700);
const carried = await page.evaluate(() => {
  const view = window.quillpad.editor.view;
  const arrows = Array.from(view.dom.querySelectorAll('.cm-foldGutter .cm-gutterElement'))
    .filter((el) => el.style.visibility !== 'hidden' && el.textContent.trim())
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    });
  return {
    placeholders: view.contentDOM.querySelectorAll('.cm-foldPlaceholder').length,
    gutters: !!document.querySelector('.cm-gutters'),
    arrows,
  };
});
check(
  '切到所见即所得后行号槽仍在、折叠状态保留',
  carried.gutters && carried.placeholders > 0 && carried.arrows.length >= 1,
  `折叠占位=${carried.placeholders} gutters=${carried.gutters} 箭头=${JSON.stringify(carried.arrows)}`,
);
let unfolded = -1;
const closedArrow = carried.arrows.find((a) => a.text !== '⌄');
if (closedArrow) {
  await page.mouse.click(closedArrow.x, closedArrow.y);
  await page.waitForTimeout(500);
  unfolded = await page.evaluate(
    () => window.quillpad.editor.view.contentDOM.querySelectorAll('.cm-foldPlaceholder').length,
  );
}
check(
  '所见即所得下点收起箭头可展开（折叠状态可恢复）',
  unfolded === 0,
  `展开后折叠占位=${unfolded}`,
);

/* ------------------- 8. 分隔线画在行盒垂直中线上（v1.0.4 第二轮修正） */
/**
 * 分隔线所在行是 `font-size/line-height: 0` + 上下 padding 撑出来的，
 * 前一行是空行时**上**内边距会被压到 4px（与预览的外边距折叠等价），
 * 于是行内布局的 `<hr>` 会贴在行顶。改成绝对定位 `top: 50%` 后，
 * 横线上下留白必须等宽。
 */
await page.evaluate(async () => {
  const app = window.quillpad;
  const tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
  app.setTabContent(tab.id, '正文段落。\n\n---\n\n下一段。\n');
  app.refreshViewMode();
});
await page.waitForTimeout(900);
const hr = await page.evaluate(() => {
  const line = document.querySelector('.cm-line.qp-hr-line');
  const bar = line && line.querySelector('.qp-hr');
  const content = document.querySelector('.cm-content');
  if (!line || !bar) return { found: false };
  const lb = line.getBoundingClientRect();
  const hb = bar.getBoundingClientRect();
  const cb = content.getBoundingClientRect();
  return {
    found: true,
    lineH: Math.round(lb.height),
    above: Math.round(hb.top - lb.top),
    below: Math.round(lb.bottom - hb.bottom),
    width: Math.round(hb.width),
    contentW: Math.round(cb.width),
    left: Math.round(hb.left - cb.left),
  };
});
check(
  '所见即所得分隔线画在行盒垂直中线上',
  hr.found && Math.abs(hr.above - hr.below) <= 1 && hr.above >= 8,
  `行高=${hr.lineH}px 上=${hr.above} 下=${hr.below}`,
);
check(
  '所见即所得分隔线铺满内容列宽（与表格 / 正文同宽）',
  hr.found && hr.width === hr.contentW && hr.left === 0,
  `横线=${hr.width}px 内容列=${hr.contentW}px 左偏=${hr.left}px`,
);

/* ---------- 9. 行首 ← 不跳到上一行尾（v1.0.4 第五轮） ---------- */
/**
 * 三种视图 + 非 Markdown 文档都要一致：空选区、光标在**逻辑行首**时按 ←
 * 原地不动。行中照常左移，`Shift+←` 仍扩选（扩选走另一个按键名）。
 */
async function arrowLeftAt(doc, lineNo, col, mode) {
  await page.evaluate(
    async ([text, no, at, m]) => {
      const app = window.quillpad;
      const tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
      if (app.state.viewMode !== m) app.setViewMode(m, { user: true });
      app.setTabContent(tab.id, text);
      app.refreshViewMode();
      await new Promise((res) => setTimeout(res, 350));
      const v = app.editor.view;
      const line = v.state.doc.line(no);
      v.dispatch({ selection: { anchor: line.from + at } });
      v.focus();
    },
    [doc, lineNo, col, mode],
  );
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const v = window.quillpad.editor.view;
    const s = v.state.selection.main;
    const line = v.state.doc.lineAt(s.head);
    return { head: s.head, line: line.number, col: s.head - line.from };
  });
}

const ARROW_DOC = '第一行文字\n\n第三行文字\n';
for (const mode of ['wysiwyg', 'source', 'split']) {
  const r = await arrowLeftAt(ARROW_DOC, 3, 0, mode);
  check(`行首按 ← 留在本行（${mode}）`, r.line === 3 && r.col === 0, `落点 L${r.line}:${r.col}`);
}
const midLeft = await arrowLeftAt('第一行文字\n\n第三行文字\n', 3, 3, 'wysiwyg');
check('行中按 ← 正常左移一格（所见即所得）', midLeft.line === 3 && midLeft.col === 2, `落点 L${midLeft.line}:${midLeft.col}`);

await page.evaluate(() => {
  const v = window.quillpad.editor.view;
  const line = v.state.doc.line(3);
  v.dispatch({ selection: { anchor: line.from + 2 } });
  v.focus();
});
await page.waitForTimeout(200);
await page.keyboard.press('Shift+ArrowLeft');
await page.waitForTimeout(250);
const shiftLeft = await page.evaluate(() => {
  const s = window.quillpad.editor.view.state.selection.main;
  return { empty: s.empty, len: s.to - s.from };
});
check('Shift+← 仍可扩选（未被行首拦截误伤）', !shiftLeft.empty && shiftLeft.len === 1, `选区长=${shiftLeft.len}`);

const txtLeft = await arrowLeftAt('abc\ndef\n', 2, 0, 'wysiwyg');
check('纯文本文档行首按 ← 也留在本行', txtLeft.line === 2 && txtLeft.col === 0, `落点 L${txtLeft.line}:${txtLeft.col}`);

check('无运行时错误', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
