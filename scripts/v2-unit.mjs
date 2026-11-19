/**
 * QuillPad v2 · 纯函数单元测试（node 环境，无浏览器）
 *
 * 运行：`node scripts/v2-unit.mjs`（或 `npm run test:v2:unit`）
 *
 * 覆盖：
 *  1. `src/editor/viewmode.js` —— 有效模式推导 / 三态循环 / 大文件策略
 *  2. `src/core/settings.js` —— v1 → v2 的 `localStorage` 迁移与脏值兜底
 *  3. `src/editor/wysiwyg/table-model.js` —— 表格解析 / 序列化 / 列宽（T06）
 *  4. `src/editor/wysiwyg/table-ops.js` —— 7 个行列操作（T06）
 *
 * 注意：脚本自带极简断言框架，不引入任何测试依赖（v1 无测试框架，保持一致）。
 */

import {
  effectiveViewMode,
  nextViewMode,
  isMarkdownOnly,
  isModeSupported,
  isHardLimited,
  shouldDegrade,
  countLines,
  DEGRADE_BYTES,
  DEGRADE_LINES,
  HARD_BYTES,
  HARD_LINES,
} from '../src/editor/viewmode.js';
import {
  DEFAULT_SETTINGS,
  deepMerge,
  loadSettings,
  pickSettings,
  clamp,
} from '../src/core/settings.js';
import {
  parseTable,
  serializeTable,
  computeWidths,
  escapeCell,
  unescapeCell,
  rowHasPipe,
} from '../src/editor/wysiwyg/table-model.js';
import { applyTableOp } from '../src/editor/wysiwyg/table-ops.js';
import { renderMarkdown, renderInlineMarkdown } from '../src/core/markdown.js';
import { EditorState } from '@codemirror/state';
import {
  rectInfo,
  columnInsert,
  columnDelete,
  columnAlign,
  columnNumber,
  selectRect,
  COLUMN_COMMANDS,
} from '../src/editor/columns.js';
import { allChars, charCount, codepointLabel, searchChars, RECENT_LIMIT } from '../src/core/chars.js';
import { isSafeAssetName, ASSETS_DIR } from '../src/core/assets.js';
import { NON_REPLAYABLE, MAX_STEPS, MAX_MACROS } from '../src/core/macro.js';
import { APP_VERSION, APP_VERSION_LABEL } from '../src/core/version.js';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------ 断言框架 */

const results = [];

/**
 * 注册并立即执行一条断言。
 * @param {string} name
 * @param {() => void} fn 抛错即失败
 */
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true, detail: '' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name} :: ${err.message}`);
  }
}

/**
 * 异步断言（RPC 并发 / 超时用例需要 await）。
 * @param {string} name
 * @param {() => Promise<void>} fn
 * @return {Promise<void>}
 */
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true, detail: '' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`FAIL  ${name} :: ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || '值不相等'}：实际=${a} 期望=${e}`);
}

/* -------------------------------------------------- localStorage 桩（迁移用） */

/**
 * 装一个可控的 localStorage 桩，返回 setRaw / clear 便于逐条用例改写数据。
 * @return {{setRaw: (v: string|null) => void, read: () => string|null}}
 */
function installStorageStub() {
  let raw = null;
  globalThis.localStorage = {
    getItem: () => raw,
    setItem: (_k, v) => {
      raw = String(v);
    },
    removeItem: () => {
      raw = null;
    },
    clear: () => {
      raw = null;
    },
    key: () => null,
    get length() {
      return raw == null ? 0 : 1;
    },
  };
  return {
    setRaw: (v) => {
      raw = v;
    },
    read: () => raw,
  };
}

const storage = installStorageStub();

/* ==================================================== 1. 视图模式（T01/T02） */

const MD = { language: 'markdown', content: '# 标题\n\n正文\n' };
const TXT = { language: 'plaintext', content: 'plain' };
const JS = { language: 'javascript', content: 'const a = 1;' };

test('effectiveViewMode：markdown + auto → wysiwyg', () => {
  assertEqual(effectiveViewMode(MD, { preference: 'auto' }), 'wysiwyg');
});

test('effectiveViewMode：非 markdown + auto → source', () => {
  assertEqual(effectiveViewMode(JS, { preference: 'auto' }), 'source');
  assertEqual(effectiveViewMode(TXT, { preference: 'wysiwyg' }), 'source');
});

test('effectiveViewMode：markdown + 偏好 split → split', () => {
  assertEqual(effectiveViewMode(MD, { preference: 'split' }), 'split');
  assertEqual(effectiveViewMode(MD, { preference: 'source' }), 'source');
});

test('effectiveViewMode：1.2MB markdown → 自动降级 source', () => {
  const big = { language: 'markdown', content: 'x'.repeat(Math.ceil(1.2 * 1024 * 1024)) };
  assertEqual(effectiveViewMode(big, { preference: 'auto' }), 'source');
  assertEqual(effectiveViewMode(big, { preference: 'wysiwyg' }), 'source');
  assert(isHardLimited(big) === false, '1.2MB 未到硬上限');
});

test('effectiveViewMode：1.2MB + forced → 仍可 wysiwyg（「仍要启用」）', () => {
  const big = { language: 'markdown', content: 'x'.repeat(Math.ceil(1.2 * 1024 * 1024)) };
  assertEqual(effectiveViewMode(big, { preference: 'auto', forced: true }), 'wysiwyg');
});

test('effectiveViewMode：25k 行（未过 1MB）→ 也降级 source', () => {
  const lines = new Array(DEGRADE_LINES + 5000).fill('a').join('\n');
  assert(lines.length < DEGRADE_BYTES, `fixture 应小于 1MB，实际 ${lines.length}`);
  assertEqual(effectiveViewMode({ language: 'markdown', content: lines }), 'source');
});

test('effectiveViewMode：> 20MB → 硬限制，恒 source', () => {
  const huge = { language: 'markdown', content: '', lines: HARD_LINES + 1 };
  assert(isHardLimited(huge), '应判定为超硬上限');
  assertEqual(effectiveViewMode(huge, { preference: 'wysiwyg', forced: true }), 'source');
  const hugeBytes = { language: 'markdown', content: 'x'.repeat(HARD_BYTES + 10) };
  assert(isHardLimited(hugeBytes), '按字节也应判定超限');
  assertEqual(effectiveViewMode(hugeBytes, { preference: 'split' }), 'source');
});

test('effectiveViewMode：无标签 → source', () => {
  assertEqual(effectiveViewMode(null), 'source');
  assertEqual(effectiveViewMode(undefined, { preference: 'split' }), 'source');
});

test('nextViewMode：固定顺序 source → split → wysiwyg → source', () => {
  assertEqual(nextViewMode('source'), 'split');
  assertEqual(nextViewMode('split'), 'wysiwyg');
  assertEqual(nextViewMode('wysiwyg'), 'source');
});

test('nextViewMode：从 weitwyg 连按 3 次回到 wysiwyg（T02 验收②序列）', () => {
  const seq = [];
  let cur = 'wysiwyg';
  for (let i = 0; i < 3; i += 1) {
    cur = nextViewMode(cur);
    seq.push(cur);
  }
  assertEqual(seq, ['source', 'split', 'wysiwyg']);
});

test('nextViewMode：未知输入回落 source', () => {
  assertEqual(nextViewMode('bogus'), 'source');
  assertEqual(nextViewMode(null), 'source');
});

test('isMarkdownOnly / isModeSupported / countLines', () => {
  assert(isMarkdownOnly('markdown') === true);
  assert(isMarkdownOnly('js') === false);
  assert(isModeSupported('source', 'plaintext') === true);
  assert(isModeSupported('wysiwyg', 'plaintext') === false);
  assertEqual(countLines(''), 1);
  assertEqual(countLines('a\nb\nc'), 3);
  assertEqual(countLines('a\n'), 2);
});

/* ==================================================== 2. 设置迁移（T01） */

test('loadSettings：无任何存储 → 全部默认值', () => {
  storage.setRaw(null);
  const s = loadSettings();
  assertEqual(s.viewMode, 'auto');
  assertEqual(s.viewModeLocked, false);
  assertEqual(s.pdf.margin.top, 20);
  assertEqual(s.pdf.paper, 'A4');
  assertEqual(s.decorations.math, true);
  assertEqual(s.plugins.lastMarketTab, 'market');
});

test('loadSettings：v1 旧数据（无新字段）不抛错且补齐新字段', () => {
  storage.setRaw(
    JSON.stringify({
      theme: 'nord',
      fontSize: 18,
      wordWrap: true,
      sidebarVisible: false,
      sidebarWidth: 300,
      sidebarTab: 'outline',
      autoSave: true,
      indentSize: 4,
      useTabs: true,
    }),
  );
  const s = loadSettings();
  assertEqual(s.theme, 'nord');
  assertEqual(s.fontSize, 18);
  assertEqual(s.wordWrap, true);
  assertEqual(s.sidebarWidth, 300);
  assertEqual(s.sidebarTab, 'outline');
  // 新增字段回落默认
  assertEqual(s.viewMode, 'auto');
  assertEqual(s.pdf.margin.top, 20);
  assertEqual(s.decorations.frontmatter, true);
  assertEqual(s.macro.enabled, true);
});

test('loadSettings：脏值一律回落默认（不抛错）', () => {
  storage.setRaw(
    JSON.stringify({
      viewMode: 'bogus',
      viewModeLocked: 'yes',
      fontSize: 999,
      sidebarWidth: 9999,
      pdf: { paper: 'A5', margin: { top: 999 }, orientation: 'diagonal', imageMaxWidth: 33 },
      decorations: 'math',
      plugins: { lastMarketTab: 'nope' },
    }),
  );
  const s = loadSettings();
  assertEqual(s.viewMode, 'auto');
  assertEqual(s.viewModeLocked, false);
  assertEqual(s.fontSize, 300); // clamp 上限
  assertEqual(s.sidebarWidth, 420); // clamp 上限
  assertEqual(s.pdf.paper, 'A4');
  assertEqual(s.pdf.margin.top, 100); // clamp 上限（0..100mm）
  assertEqual(s.pdf.margin.bottom, 20); // 缺失回落
  assertEqual(s.pdf.orientation, 'portrait');
  assertEqual(s.pdf.imageMaxWidth, 100);
  assertEqual(s.decorations.math, true); // 字符串丢弃 → 默认对象
  assertEqual(s.plugins.lastMarketTab, 'market');
});

test('loadSettings：用户自定义嵌套值被保留', () => {
  storage.setRaw(
    JSON.stringify({
      viewMode: 'split',
      viewModeLocked: true,
      pdf: {
        paper: 'custom',
        customWidth: 180,
        customHeight: 260,
        margin: { top: 12, bottom: 12, left: 30, right: 30 },
        toc: true,
        header: { mode: 'custom', text: 'QuillPad' },
      },
      decorations: { math: false, minimap: true },
    }),
  );
  const s = loadSettings();
  assertEqual(s.viewMode, 'split');
  assertEqual(s.viewModeLocked, true);
  assertEqual(s.pdf.paper, 'custom');
  assertEqual(s.pdf.customWidth, 180);
  assertEqual(s.pdf.margin.left, 30);
  assertEqual(s.pdf.toc, true);
  assertEqual(s.pdf.header.mode, 'custom');
  assertEqual(s.pdf.header.text, 'QuillPad');
  assertEqual(s.decorations.math, false);
  assertEqual(s.decorations.minimap, true);
  assertEqual(s.decorations.images, true); // 未提及的键保持默认
});

test('loadSettings：非法 JSON 不抛错', () => {
  storage.setRaw('{not json');
  const s = loadSettings();
  assertEqual(s.viewMode, 'auto');
});

test('pickSettings 深拷贝：改返回值不影响 DEFAULT_SETTINGS', () => {
  const picked = pickSettings({ ...DEFAULT_SETTINGS, viewMode: 'source' });
  picked.pdf.margin.top = 99;
  picked.decorations.math = false;
  assertEqual(DEFAULT_SETTINGS.pdf.margin.top, 20);
  assertEqual(DEFAULT_SETTINGS.decorations.math, true);
  assertEqual(DEFAULT_SETTINGS.viewMode, 'auto');
});

test('deepMerge / clamp 基础行为', () => {
  assertEqual(deepMerge({ a: 1, b: { c: 2 } }, { b: { c: 5 } }), { a: 1, b: { c: 5 } });
  assertEqual(deepMerge({ a: 1 }, { a: 'x' }), { a: 1 }); // 类型不一致 → 丢弃
  assertEqual(deepMerge({ a: 1 }, null), { a: 1 });
  assertEqual(clamp('abc', 2, 8), 2);
  assertEqual(clamp(99, 2, 8), 8);
});

/* ============================================ 3. 表格模型（T06，纯函数） */

const TABLE_FIXTURES = [
  // 普通对齐 + 表头
  ['| a | b |\n| --- | --- |\n| 1 | 2 |', '普通表格'],
  // 三种对齐写法
  ['| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |', '三种对齐'],
  // 转义竖线 + <br>
  ['| a\\|b | c |\n| --- | --- |\n| x<br>y | z |', '转义与换行'],
  // 非对齐分隔行（个数不足）
  ['| h1 | h2 |\n| -- | -- |\n| v1 | v2 |', '短分隔行'],
];

test('parseTable/serializeTable：4 组 fixture 严格 round-trip', () => {
  for (const [text, label] of TABLE_FIXTURES) {
    const model = parseTable(text, 0, text.length);
    assert(model, `${label}：解析失败`);
    const out = serializeTable(model);
    assertEqual(out.text, text, `${label} round-trip`);
  }
});

test('parseTable：表头 / 行 / 对齐 / 列宽结构正确', () => {
  const text = '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';
  const m = parseTable(text, 10, 10 + text.length);
  assert(m, '解析失败');
  assertEqual(m.headers, ['a', 'b', 'c']);
  assertEqual(m.aligns, ['left', 'center', 'right']);
  assertEqual(m.rows.length, 2);
  assertEqual(m.rows[1], ['4', '5', '6']);
  assertEqual(m.from, 10);
  assertEqual(m.to, 10 + text.length);
  assertEqual(m.widths.length, 3);
  assertEqual(Math.round(m.widths.reduce((a, b) => a + b, 0)), 100);
});

test('computeWidths：和恒为 100、每列 ≥ 8%、与内容长度正相关', () => {
  const model = {
    headers: ['短', '一个很长很长的表头'],
    aligns: [null, null],
    rows: [['x', 'y'.repeat(30)]],
    widths: [],
    rawLines: [],
    from: 0,
    to: 0,
  };
  const w = computeWidths(model);
  assertEqual(Math.round(w.reduce((a, b) => a + b, 0)), 100);
  assert(w.every((v) => v >= 8), '每列不低于 8%');
  assert(w[1] > w[0], '长内容列应更宽');
});

test('escapeCell / unescapeCell：竖线与换行互转', () => {
  assertEqual(escapeCell('a|b'), 'a\\|b');
  assertEqual(escapeCell('a<br>b'), 'a<br>b');
  assertEqual(escapeCell('  x  '), 'x');
  assertEqual(unescapeCell('a\\|b'), 'a|b');
  assertEqual(unescapeCell('a<br>b'), 'a\nb');
});

test('applyTableOp：7 个操作均返回新对象且不改原模型', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const m = parseTable(text, 0, text.length);
  const snapshot = JSON.stringify(m);
  const ops = [
    'rowAbove',
    'rowBelow',
    'rowDelete',
    'colLeft',
    'colRight',
    'colDelete',
    'alignCycle',
  ];
  for (const op of ops) {
    const next = applyTableOp(m, op, { row: 1, col: 0 });
    assert(next !== m, `${op} 必须返回新对象`);
    assertEqual(JSON.stringify(m), snapshot, `${op} 不得修改原模型`);
  }
});

test('applyTableOp：下方插入行 → 数据行 2 → 3（含表头共 4 行）', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
  const m = parseTable(text, 0, text.length);
  assertEqual(m.rows.length, 2);
  const next = applyTableOp(m, 'rowBelow', { row: 2 });
  assertEqual(next.rows.length, 3);
  assertEqual(next.headers.length, 2);
});

test('applyTableOp：右侧插入列 → 每行单元数 +1 且新列为空', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const m = parseTable(text, 0, text.length);
  const next = applyTableOp(m, 'colRight', { col: 1 });
  assertEqual(next.headers.length, 3);
  assertEqual(next.headers[2], '');
  assertEqual(next.rows[0].length, 3);
  assertEqual(next.rows[0][2], '');
  const out = serializeTable(next).text;
  assert(out.split('\n')[1].includes('---'), '分隔行列数应同步 +1');
});

test('applyTableOp：对齐循环 左→中→右→左，源码写回 :---: / ---:', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  let m = parseTable(text, 0, text.length);
  assertEqual(m.aligns[0], null);
  m = applyTableOp(m, 'alignCycle', { col: 0 });
  assertEqual(m.aligns[0], 'left');
  m = applyTableOp(m, 'alignCycle', { col: 0 });
  assertEqual(m.aligns[0], 'center');
  assertEqual(serializeTable(m).text.split('\n')[1], '| :---: | --- |');
  m = applyTableOp(m, 'alignCycle', { col: 0 });
  assertEqual(m.aligns[0], 'right');
  assertEqual(serializeTable(m).text.split('\n')[1], '| ---: | --- |');
  m = applyTableOp(m, 'alignCycle', { col: 0 });
  assertEqual(m.aligns[0], null);
});

test('applyTableOp：删除列到只剩 1 列时不再删除', () => {
  let text = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  let m = parseTable(text, 0, text.length);
  m = applyTableOp(m, 'colDelete', { col: 0 });
  assertEqual(m.headers.length, 1);
  const again = applyTableOp(m, 'colDelete', { col: 0 });
  assertEqual(again.headers.length, 1, '不得删成 0 列');
});

test('applyTableOp：applyCellEdit 等价路径（rowDelete 后撤销语义）', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
  const m = parseTable(text, 0, text.length);
  const next = applyTableOp(m, 'rowDelete', { row: 2 });
  assertEqual(next.rows, [['1', '2']]);
  assertEqual(serializeTable(next).text, '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

/* ==================================================================
 * 5. 列（矩形）编辑（T14）
 * ================================================================== */

/**
 * 造一个「够用」的 headless view：只提供 columns.js 真正用到的
 * `state` / `dispatch` / `focus`，不挂 DOM。
 *
 * @param {string} doc
 * @return {{state: EditorState, dispatch: Function, focus: Function}}
 */
function makeView(doc) {
  // 真实编辑器里 `allowMultipleSelections` 是开着的（editor.js 的矩形选区前提），
  // 这里必须同样打开，否则 EditorSelection.create 会把多段选区折叠成一段，
  // 于是「矩形」永远构造不出来。
  let state = EditorState.create({
    doc,
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  return {
    get state() {
      return state;
    },
    dispatch(spec) {
      state = state.update(spec).state;
    },
    focus() {},
  };
}

test('rectInfo：单光标与多光标都返回 null（只有矩形才算）', () => {
  const view = makeView('abc\ndef\nghi');
  assertEqual(rectInfo(view.state), null, '单光标不应被当成矩形');
  view.dispatch({ selection: { anchor: 0, head: 1 } });
  assertEqual(rectInfo(view.state), null);
});

test('rectInfo：selectRect 构造出的矩形给出正确的列 / 行数 / 宽度', () => {
  const view = makeView('abcdef\nabcdef\nabcdef');
  selectRect(view, { startLine: 1, endLine: 3, col: 2, width: 2 });
  const rect = rectInfo(view.state);
  assert(rect, '应当识别为矩形');
  assertEqual(rect.col, 2);
  assertEqual(rect.startLine, 1);
  assertEqual(rect.endLine, 3);
  assertEqual(rect.lineCount, 3);
  assertEqual(rect.width, 2);
});

test('columnInsert：每行同列插入同一段文本，一次事务', () => {
  const view = makeView('aaa\nbbb\nccc');
  selectRect(view, { startLine: 1, endLine: 3, col: 1, width: 1 });
  const res = columnInsert(view, '> ');
  assertEqual(res.ok, true);
  assertEqual(res.lines, 3);
  assertEqual(view.state.doc.toString(), 'a> aa\nb> bb\nc> cc');
});

test('columnInsert：没有矩形时返回 no-rect 而不是抛错', () => {
  const view = makeView('abc');
  const res = columnInsert(view, 'x');
  assertEqual(res.ok, false);
  assertEqual(res.reason, 'no-rect');
  assertEqual(view.state.doc.toString(), 'abc', '文档不能被改动');
});

test('columnDelete：按矩形宽度删掉每一行的同列字符', () => {
  const view = makeView('xxA\nxxB\nxxC');
  selectRect(view, { startLine: 1, endLine: 3, col: 0, width: 2 });
  const res = columnDelete(view);
  assertEqual(res.ok, true);
  assertEqual(view.state.doc.toString(), 'A\nB\nC');
});

test('columnAlign：按显示列对齐（中文占两列，不能用 length）', () => {
  // 三行在矩形左边的显示宽度分别是 3 / 2 / 2（「中a」= 2+1 列）。
  // 若按字符数算，最长是 2，三行都不会补空格；按显示列算，最长是 3，后两行各补 1 个空格。
  const view = makeView('中aX\nabX\nqqX');
  selectRect(view, { startLine: 1, endLine: 3, col: 2, width: 1 });
  const rect = rectInfo(view.state);
  assert(rect, '需要先形成矩形');
  const res = columnAlign(view);
  assertEqual(res.ok, true);
  assertEqual(res.column, 3, '目标显示列应为 3');
  assertEqual(view.state.doc.toString(), '中aX\nab X\nqq X');
});

test('columnNumber：插入 1..N 并按最长编号补空格', () => {
  const view = makeView('a\nb\nc');
  selectRect(view, { startLine: 1, endLine: 3, col: 0, width: 1 });
  const res = columnNumber(view, { start: 1 });
  assertEqual(res.ok, true);
  assertEqual(view.state.doc.toString(), '1a\n2b\n3c');
});

test('COLUMN_COMMANDS：四个命令 id 与 design 一致', () => {
  const ids = COLUMN_COMMANDS.map((c) => c.id).sort();
  assertEqual(
    ids.join(','),
    'edit.columnAlign,edit.columnDelete,edit.columnInsert,edit.columnNumber',
  );
});

/* ==================================================================
 * 6. 特殊字符数据（T15）
 * ================================================================== */

test('chars：字符总数 ≥ 500 且去重', () => {
  const list = allChars();
  assertEqual(list.length, charCount());
  assert(list.length >= 500, `字符太少：${list.length}`);
  assertEqual(new Set(list).size, list.length, '不得有重复字符');
});

test('chars：码位直查（4E2D / U+4E2D / 0x4E2D 都命中「中」）', () => {
  for (const q of ['4E2D', 'U+4E2D', '0x4E2D', 'u+4e2d']) {
    const hit = searchChars(q);
    assertEqual(hit.join(''), '中', `${q} 应命中「中」，实际=${hit.join('')}`);
  }
});

test('chars：按分组名过滤返回整组', () => {
  const arrows = searchChars('箭头');
  assert(arrows.length >= 8, `箭头组太小：${arrows.length}`);
  assert(arrows.includes('→'), '箭头组应含 →');
});

test('chars：码位标签格式为 U+XXXX', () => {
  assertEqual(codepointLabel('中'), 'U+4E2D');
  assertEqual(RECENT_LIMIT, 20);
});

/* ==================================================================
 * 7. 资源落盘 / 宏 / 版本（E 批次）
 * ================================================================== */

test('assets：isSafeAssetName 挡掉路径穿越与分隔符', () => {
  assertEqual(isSafeAssetName('shot.png'), true);
  assertEqual(isSafeAssetName('图 1.png'), true);
  for (const bad of ['..', '../x.png', 'a/b.png', 'a\\b.png', 'C:\\x.png', '', '.', '..png']) {
    assertEqual(isSafeAssetName(bad), false, `应拒绝：${JSON.stringify(bad)}`);
  }
  assertEqual(ASSETS_DIR, 'assets');
});

test('macro：不可录制的命令清单覆盖文件/导出一类危险操作', () => {
  for (const id of ['file.new', 'file.open', 'file.save', 'file.saveAs', 'pdf.export', 'pdf.print', 'macro.record', 'macro.play']) {
    assert(NON_REPLAYABLE.has(id), `${id} 必须不可录`);
  }
  assert(!NON_REPLAYABLE.has('edit.upperCase'), '普通编辑命令必须可录');
  assertEqual(MAX_STEPS, 2000);
  assertEqual(MAX_MACROS, 200);
});

test('version：src/core/version.js 与 package.json 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assertEqual(APP_VERSION, pkg.version);
  assert(/^\d+\.\d+\.\d+$/.test(APP_VERSION), `版本号格式不对：${APP_VERSION}`);
});

test('version：展示用版本号带 v 前缀', () => {
  assertEqual(APP_VERSION_LABEL, `v${APP_VERSION}`);
  assert(/^v\d+\.\d+\.\d+$/.test(APP_VERSION_LABEL), `展示版本号格式不对：${APP_VERSION_LABEL}`);
});

test('settings：字号下限 14px（旧配置里的 10–13 抬到 14）', () => {
  storage.setRaw(JSON.stringify({ fontSize: 10 }));
  assertEqual(loadSettings().fontSize, 14);
  storage.setRaw(JSON.stringify({ fontSize: 13 }));
  assertEqual(loadSettings().fontSize, 14);
  storage.setRaw(JSON.stringify({ fontSize: 15 }));
  assertEqual(loadSettings().fontSize, 15);
  storage.setRaw(JSON.stringify({ fontSize: 14 }));
  assertEqual(loadSettings().fontSize, 14);
});

/* ==================================================================
 * 8. 插件沙箱 / RPC / API（T20 纯函数侧）
 * ================================================================== */

import {
  createRpcHost,
  makeRequest,
  RPC_MAX_INFLIGHT,
  rpcOk,
} from '../src/core/plugins/rpc.js';
import { createPluginApi, dispatchApi, PERMISSION_ERROR } from '../src/core/plugins/api.js';
import { buildPrelude, BLOCKED_GLOBALS, API_METHODS } from '../src/core/plugins/sandbox.js';
import { readFileSync as readFileSync2 } from 'node:fs';

test('prelude 删除 fetch/XMLHttpRequest/importScripts/document/process', () => {
  const src = buildPrelude('quillpad.demo', API_METHODS, './main.js');
  for (const key of ['fetch', 'XMLHttpRequest', 'importScripts', 'document', 'process']) {
    assert(BLOCKED_GLOBALS.includes(key), `BLOCKED_GLOBALS 缺 ${key}`);
  }
  assert(/delete self\[key\]/.test(src), '必须有删除全局的兜底');
  assert(/import\(MAIN_FILE\)/.test(src), '必须动态导入插件 main');
  assert(!/eval\(/.test(src), 'prelude 自身不得使用 eval');
});

test('prelude 模板与 buildPrelude 不漂移', () => {
  const tpl = readFileSync2(new URL('../desktop/plugin-prelude.txt', import.meta.url), 'utf8');
  const rendered = tpl
    .replace('__QP_ID_JSON__', JSON.stringify('quillpad.demo'))
    .replace('__QP_MAIN_JSON__', JSON.stringify('./main.js'));
  assertEqual(rendered.trim(), buildPrelude('__QP_ID__', API_METHODS, '__QP_MAIN__')
    .replace('"__QP_ID__"', JSON.stringify('quillpad.demo'))
    .replace('"__QP_MAIN__"', JSON.stringify('./main.js'))
    .trim());
});

await testAsync('RPC 并发 17 个：第 17 个 EBUSY，其余全部 settle，inflight 归零', async () => {
  const host = createRpcHost({
    onCall: async (req) => {
      await new Promise((r) => setTimeout(r, 5));
      return rpcOk(req.id, { method: req.method });
    },
  });
  const reqs = Array.from({ length: RPC_MAX_INFLIGHT + 1 }, (_, i) => makeRequest('editor.getText', { i }));
  const out = await Promise.all(reqs.map((r) => host.handle(r)));
  const busy = out.filter((r) => r.ok === false && r.error.code === 'EBUSY');
  assertEqual(busy.length, 1, `应恰好 1 个 EBUSY，实际 ${busy.length}`);
  assertEqual(host.stats().inflight, 0, 'inflight 必须归零');
  assertEqual(host.stats().settled, RPC_MAX_INFLIGHT, '16 个正常 settle');
});

await testAsync('RPC 超时返回 ETIMEOUT 且不泄漏 inflight', async () => {
  const host = createRpcHost({
    timeoutMs: 20,
    onCall: () => new Promise(() => {}), // 永不 resolve
  });
  const out = await host.handle(makeRequest('net.fetch', {}));
  assertEqual(out.error.code, 'ETIMEOUT');
  assertEqual(host.stats().inflight, 0, '超时后 inflight 必须归零');
});

await testAsync('API 权限：未声明 network 时 net.fetch 返回 EPERM_NETWORK 且不发请求', async () => {
  let called = 0;
  const methods = createPluginApi({
    manifest: { id: 'quillpad.demo', permissions: ['editor:read'] },
    netFetch: async () => {
      called += 1;
      return 'should-not-happen';
    },
  });
  const res = await dispatchApi(methods, { method: 'net.fetch', params: { url: 'https://example.com' } });
  assertEqual(res.code, 'EPERM_NETWORK');
  assertEqual(called, 0, '绝不能真的发起网络请求');
  assertEqual(PERMISSION_ERROR['files:write'], 'EPERM_FILES_WRITE');
});

await testAsync('API 权限：声明 editor:read 后 getText 可用，写仍被拒', async () => {
  const methods = createPluginApi({
    manifest: { id: 'quillpad.demo', permissions: ['editor:read'] },
    app: { editor: { view: { state: { doc: { toString: () => 'abc' } } } } },
  });
  const read = await dispatchApi(methods, { method: 'editor.getText', params: {} });
  assertEqual(read.text, 'abc');
  const write = await dispatchApi(methods, { method: 'editor.replaceSelection', params: { text: 'x' } });
  assertEqual(write.code, 'EPERM_EDITOR_WRITE');
});

/* ------------------------------------------ 11. 表格下沿：尾行不被吞（v1.0.5） */

test('rowHasPipe：只有未转义的竖线才算表格行标记', () => {
  assertEqual(rowHasPipe('| a | b |'), true);
  assertEqual(rowHasPipe('a | b'), true);
  assertEqual(rowHasPipe('尾巴正文'), false);
  assertEqual(rowHasPipe(''), false);
  assertEqual(rowHasPipe('a \\| b'), false, '整行只有转义竖线 → 不是表格行');
  assertEqual(rowHasPipe('\\| a | b'), true);
});

test('parseTable：表下无竖线的正文不算数据行，to 同步收窄', () => {
  const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const text = `${table}\n尾巴\n第二行`;
  const m = parseTable(text, 0, text.length);
  assert(m, '解析失败');
  assertEqual(m.rows.length, 1, '只应有一条数据行');
  assertEqual(m.rows[0], ['1', '2']);
  assertEqual(m.to, table.length, 'to 必须落在最后一行表格行末');
  assertEqual(m.rawLines.length, 3, 'rawLines 只保留表格三行');
  assertEqual(serializeTable(m).text, table, '序列化不得写出尾行');
});

test('renderMarkdown：表下正文渲染为 <p>，不进入 <table>', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n尾巴\n第二行\n');
  const flat = html.replace(/\s+/g, ' ');
  assert(html.includes('<table>'), '表格应渲染');
  assert(flat.includes('<p>尾巴 第二行</p>'), `尾行应是段落：${flat}`);
  assert(flat.indexOf('尾巴') > flat.indexOf('</table>'), '尾行必须排在 </table> 之后');
});

test('renderMarkdown：代码围栏里的「表格 + 尾行」原样保留', () => {
  const html = renderMarkdown('```\n| a | b |\n| --- | --- |\n尾\n```\n');
  assert(!html.includes('<table>'), '围栏内不应渲染表格');
  assert(html.includes('尾'), '围栏内容必须完整');
});

test('renderMarkdown：表格后面接引用 / 列表时不额外插入空行', () => {
  const quoted = renderMarkdown('| a |\n| --- |\n| 1 |\n> 引用\n');
  assert(quoted.includes('<blockquote>'), '引用应渲染');
  const listed = renderMarkdown('| a |\n| --- |\n| 1 |\n- 列表\n');
  assert(listed.includes('<ul>'), '列表应渲染');
});

/* ------------------------------------------- 表格单元格的行内 Markdown */

test('renderInlineMarkdown：粗 / 斜 / 代码 / 删除 / 链接都转成真实标签', () => {
  assert(renderInlineMarkdown('**粗**').includes('<strong>粗</strong>'), '粗体');
  assert(renderInlineMarkdown('*斜*').includes('<em>斜</em>'), '斜体');
  assert(renderInlineMarkdown('`c()`').includes('<code>c()</code>'), '行内代码');
  assert(renderInlineMarkdown('~~删~~').includes('<del>删</del>'), '删除线');
  assert(renderInlineMarkdown('[名](https://a.b)').includes('href="https://a.b"'), '链接');
});

test('renderInlineMarkdown：纯文本原样、特殊字符转义、不产生块级标签', () => {
  assert(renderInlineMarkdown('普通文字') === '普通文字', '纯文本');
  const esc = renderInlineMarkdown('a < b & c');
  assert(esc.includes('&lt;') && esc.includes('&amp;'), `转义：${esc}`);
  assert(!renderInlineMarkdown('**x**').includes('<p>'), '不应有 <p> 包裹');
  assert(renderInlineMarkdown('') === '', '空串');
  assert(renderInlineMarkdown(null) === '', 'null');
});

test('renderInlineMarkdown：脚本标签被净化，不会注入', () => {
  const html = renderInlineMarkdown('**x**<script>alert(1)</script>');
  assert(!/<script/i.test(html), `脚本必须被移除：${html}`);
});

test('renderInlineMarkdown：表格里 `\\|` 还原后仍渲染加粗', () => {
  const cell = unescapeCell('**粗\\|分隔**');
  const html = renderInlineMarkdown(cell);
  assert(html.includes('<strong>'), `应加粗：${html}`);
  assert(html.includes('|'), '竖线保留在文字里');
});

/* --------------------------------------------------------------- 汇总 */
const passed = results.filter((r) => r.ok).length;
console.log(`\n===== v2-unit 结果 =====`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) {
  console.log('失败清单:');
  results.filter((r) => !r.ok).forEach((r) => console.log(` - ${r.name} :: ${r.detail}`));
  process.exit(1);
}
