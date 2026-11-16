/**
 * QuillPad · 列（矩形）编辑
 *
 * `rectangularSelection()` 已经在 `editor.js` 里挂载，Alt+拖拽可以选出一个矩形，
 * 但**没有任何命令面** —— 这才是 N++ 对齐项（C6/C7）真正的缺口。
 *
 * 所有命令都基于一个前提：`state.selection.ranges` 是多条「同列」选区。
 * CM 给矩形选区的方式是「每行一个 range，anchor/head 各在矩形的一角」，
 * 因此：
 *
 *  - `r.from` = 矩形左上角，`r.to` = 矩形右下角；
 *  - 列偏移（col）= `r.from - 该行起点`；
 *  - 矩形覆盖的行 = `lineAt(r.from).number` … `lineAt(r.to).number`。
 *
 * 四个命令都**只发一次事务**：一次撤销就能整体回退，这也是"列编辑"最容易被
 * 忽略的体验细节（N++ 里一次撤销撤回一整列）。
 */

import { EditorSelection } from '@codemirror/state';
import { t } from '../core/i18n.js';

/** 制表符宽度（与编辑器设置里的默认缩进一致）。 */
const TAB_SIZE = 2;

/**
 * 判断一个码位是否属于「东亚宽字符」（在等宽字体里占两格）。
 *
 * 覆盖：CJK 部首/汉字、假名、谚文、全角标点与全角字母、CJK 兼容区、
 * 以及常见 emoji。范围取自 Unicode 的 East Asian Width = W/F 主要区间。
 *
 * @param {number} cp 码位
 * @return {boolean}
 */
function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * 文本的「显示列宽」。
 *
 * 不能用 `String.length`（中文会少算一半），也不能用 CodeMirror 的
 * `countColumn`（它只展开制表符，汉字仍按 1 列算）。列对齐必须按
 * **等宽字体下的实际列数**来算，否则含中文的行会整体左移。
 *
 * @param {string} text
 * @param {number} [tabSize]
 * @return {number}
 */
export function displayWidth(text, tabSize = TAB_SIZE) {
  let width = 0;
  for (const ch of String(text == null ? '' : text)) {
    if (ch === '\t') {
      width += tabSize - (width % tabSize);
      continue;
    }
    const cp = ch.codePointAt(0) || 0;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/**
 * 矩形选区描述。
 * @typedef {object} RectInfo
 * @property {number} col 列偏移（字符数，非显示列）
 * @property {number} startLine 起始行号（1 基）
 * @property {number} endLine 结束行号（1 基）
 * @property {number} lineCount 行数
 * @property {number} width 矩形宽度（字符数）
 */

/**
 * 从当前选区推导矩形信息。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @return {RectInfo|null} 不是矩形选区时返回 null
 */
export function rectInfo(state) {
  const sel = state.selection;
  const ranges = sel.ranges;
  if (!ranges || ranges.length < 2) return null;
  // 必须每一段都不是空光标，否则只是多光标
  if (!ranges.every((r) => r.from !== r.to)) return null;

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const startLine = state.doc.lineAt(first.from).number;
  const endLine = state.doc.lineAt(last.to).number;
  if (endLine <= startLine) return null;

  const col = first.from - state.doc.lineAt(first.from).from;
  const width = Math.max(1, first.to - first.from);
  return {
    col,
    startLine,
    endLine,
    lineCount: endLine - startLine + 1,
    width,
  };
}

/**
 * 矩形覆盖的每一行上「列起点」的绝对位置。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {RectInfo} rect
 * @return {Array<{line: number, pos: number, prefix: string}>}
 */
function columnPositions(state, rect) {
  const out = [];
  for (let n = rect.startLine; n <= rect.endLine; n += 1) {
    const line = state.doc.line(n);
    const pos = Math.min(line.from + rect.col, line.to);
    out.push({ line: n, pos, prefix: line.text.slice(0, rect.col) });
  }
  return out;
}

/**
 * 在矩形左边缘插入文本。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} text
 * @return {{ok: boolean, reason?: string, lines?: number}}
 */
export function columnInsert(view, text) {
  const state = view.state;
  const rect = rectInfo(state);
  if (!rect) return { ok: false, reason: 'no-rect' };
  const value = String(text == null ? '' : text);
  if (!value) return { ok: false, reason: 'empty-text' };

  const changes = columnPositions(state, rect).map((p) => ({ from: p.pos, insert: value }));
  view.dispatch({ changes, userEvent: 'input.columnInsert' });
  view.focus();
  return { ok: true, lines: changes.length };
}

/**
 * 删除矩形选区覆盖的字符（默认删掉整个矩形的宽度）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} [count] 每行删除的字符数，默认 = 矩形宽度
 * @return {{ok: boolean, reason?: string, lines?: number}}
 */
export function columnDelete(view, count) {
  const state = view.state;
  const rect = rectInfo(state);
  if (!rect) return { ok: false, reason: 'no-rect' };
  const n = Math.max(1, Number(count) || rect.width);

  const changes = [];
  for (let lineNo = rect.startLine; lineNo <= rect.endLine; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const from = Math.min(line.from + rect.col, line.to);
    const to = Math.min(from + n, line.to);
    if (to > from) changes.push({ from, to });
  }
  if (!changes.length) return { ok: false, reason: 'empty-column' };
  view.dispatch({ changes, userEvent: 'delete.columnDelete' });
  view.focus();
  return { ok: true, lines: changes.length };
}

/**
 * 列对齐：把矩形左边缘之前的内容按最长者补空格，使目标列在同一显示列上。
 *
 * 用 `displayWidth` 而不是 `String.length`：中文/全角字符占两列，
 * 按字符数对齐会让含中文的行错位（`countColumn` 只展开制表符，同样不够用）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {{ok: boolean, reason?: string, lines?: number, column?: number}}
 */
export function columnAlign(view) {
  const state = view.state;
  const rect = rectInfo(state);
  if (!rect) return { ok: false, reason: 'no-rect' };

  const entries = columnPositions(state, rect);
  const widths = entries.map((e) => displayWidth(e.prefix));
  const target = Math.max(...widths);
  const changes = [];
  entries.forEach((entry, i) => {
    const pad = target - widths[i];
    if (pad > 0) changes.push({ from: entry.pos, insert: ' '.repeat(pad) });
  });
  if (!changes.length) return { ok: true, lines: entries.length, column: target };
  view.dispatch({ changes, userEvent: 'input.columnAlign' });
  view.focus();
  return { ok: true, lines: entries.length, column: target };
}

/**
 * 列编号：在矩形左边缘插入 `1..N`。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {{start?: number, pad?: boolean}} [opts]
 * @return {{ok: boolean, reason?: string, lines?: number}}
 */
export function columnNumber(view, opts = {}) {
  const state = view.state;
  const rect = rectInfo(state);
  if (!rect) return { ok: false, reason: 'no-rect' };

  const start = Number.isFinite(Number(opts.start)) ? Number(opts.start) : 1;
  const entries = columnPositions(state, rect);
  const numbers = entries.map((_, i) => String(start + i));
  const width = Math.max(...numbers.map((s) => s.length));
  const pad = opts.pad !== false;

  const changes = entries.map((entry, i) => ({
    from: entry.pos,
    insert: pad ? numbers[i].padStart(width, ' ') : numbers[i],
  }));
  view.dispatch({ changes, userEvent: 'input.columnNumber' });
  view.focus();
  return { ok: true, lines: entries.length };
}

/**
 * 选中一个矩形（供命令/测试构造前置状态）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {{startLine: number, endLine: number, col: number, width: number}} spec
 */
export function selectRect(view, spec) {
  const state = view.state;
  const ranges = [];
  for (let n = spec.startLine; n <= spec.endLine; n += 1) {
    const line = state.doc.line(Math.min(Math.max(1, n), state.doc.lines));
    const anchor = Math.min(line.from + spec.col, line.to);
    const head = Math.min(anchor + Math.max(0, spec.width), line.to);
    ranges.push(EditorSelection.range(anchor, head));
  }
  view.dispatch({ selection: EditorSelection.create(ranges) });
}

/**
 * 四个命令的注册描述（actions 层直接消费，避免两边写两份 id）。
 *
 * `title` 用 getter：本数组是模块级常量，若在 import 期把 t() 的结果写死，
 * 切换语言后动作名不会更新。读取 `.title` 时才按当前语言求值。
 */
export const COLUMN_COMMANDS = [
  {
    id: 'edit.columnInsert',
    op: 'insert',
    get title() {
      return t('列插入文本', 'Insert Column Text');
    },
    args: { text: '' },
  },
  {
    id: 'edit.columnDelete',
    op: 'delete',
    get title() {
      return t('删除列', 'Delete Column');
    },
    args: {},
  },
  {
    id: 'edit.columnAlign',
    op: 'align',
    get title() {
      return t('列对齐', 'Align Columns');
    },
    args: {},
  },
  {
    id: 'edit.columnNumber',
    op: 'number',
    get title() {
      return t('列编号', 'Number Columns');
    },
    args: {},
  },
];
