/**
 * QuillPad · 文本变换命令
 * 排序 / 去重 / 大小写 / 缩进转换 等「整块文本」操作。
 */

import { EditorSelection } from '@codemirror/state';

/**
 * 取「整块文本操作」的行范围。
 *
 * 有选区时取选区覆盖的完整行；只有光标（无选区）时取整个文档，
 * 与 VS Code / Sublime 的「无选区即全文」语义保持一致。
 * @param {import('@codemirror/state').EditorState} state
 * @return {{from: number, to: number, startLine: number, endLine: number, whole: boolean}}
 */
export function operationLineRange(state) {
  const sel = state.selection.main;
  if (sel.empty) {
    return { from: 0, to: state.doc.length, startLine: 1, endLine: state.doc.lines, whole: true };
  }
  const start = state.doc.lineAt(sel.from);
  const end = state.doc.lineAt(sel.to);
  return {
    from: start.from,
    to: end.to,
    startLine: start.number,
    endLine: end.number,
    whole: false,
  };
}

/**
 * 用一段新文本替换指定行范围。
 * @param {import('@codemirror/view').EditorView} view
 * @param {{from: number, to: number}} range
 * @param {string} text
 */
function replaceRange(view, range, text) {
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
  });
  view.focus();
}

/**
 * 排序选区内的行（无选区时排序全文）。
 * @param {import('@codemirror/view').EditorView} view
 * @param {'asc'|'desc'} dir
 * @return {boolean}
 */
export function sortLines(view, dir) {
  const range = operationLineRange(view.state);
  const raw = view.state.sliceDoc(range.from, range.to);
  const lines = raw.split('\n');
  if (lines.length < 2) return false;
  const sorted = lines.slice().sort((a, b) => {
    const r = a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    return dir === 'desc' ? -r : r;
  });
  replaceRange(view, range, sorted.join('\n'));
  return true;
}

/**
 * 移除范围内的重复行（保留首次出现；无选区时处理全文）。
 * @param {import('@codemirror/view').EditorView} view
 * @return {boolean}
 */
export function dedupeLines(view) {
  const range = operationLineRange(view.state);
  const raw = view.state.sliceDoc(range.from, range.to);
  const lines = raw.split('\n');
  if (lines.length < 2) return false;
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(line);
  }
  replaceRange(view, range, out.join('\n'));
  return true;
}

/**
 * 大小写转换。
 * @param {import('@codemirror/view').EditorView} view
 * @param {'upper'|'lower'|'title'} mode
 * @return {boolean}
 */
export function changeCase(view, mode) {
  const state = view.state;
  const sel = state.selection.main;
  const from = sel.empty ? state.doc.lineAt(sel.head).from : sel.from;
  const to = sel.empty ? state.doc.lineAt(sel.head).to : sel.to;
  const text = state.sliceDoc(from, to);
  if (!text) return false;
  let next = text;
  if (mode === 'upper') next = text.toUpperCase();
  else if (mode === 'lower') next = text.toLowerCase();
  else if (mode === 'title') {
    next = text.replace(/([A-Za-z\u4e00-\u9fa5]+)/g, (word) =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    );
  }
  if (next === text) return false;
  view.dispatch({
    changes: { from, to, insert: next },
    selection: EditorSelection.range(from, from + next.length),
  });
  view.focus();
  return true;
}

/**
 * 制表符缩进 → 空格缩进。
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} size 一个制表符等于多少空格
 * @return {number} 改动行数
 */
export function tabsToSpaces(view, size) {
  const state = view.state;
  const text = state.doc.toString();
  const next = text.replace(/^\t+/gm, (m) => ' '.repeat(m.length * size));
  if (next === text) return 0;
  const changed = text.split('\n').reduce((acc, line, i) => {
    return acc + (line !== next.split('\n')[i] ? 1 : 0);
  }, 0);
  view.dispatch({ changes: { from: 0, to: text.length, insert: next } });
  return changed;
}

/**
 * 空格缩进 → 制表符缩进。
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} size 多少空格算一个缩进
 * @return {number} 改动行数
 */
export function spacesToTabs(view, size) {
  const state = view.state;
  const text = state.doc.toString();
  const group = new RegExp(`^(?: {${size}})+`, 'gm');
  const next = text.replace(group, (m) => '\t'.repeat(Math.floor(m.length / size)));
  if (next === text) return 0;
  const before = text.split('\n');
  const after = next.split('\n');
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed += 1;
  view.dispatch({ changes: { from: 0, to: text.length, insert: next } });
  return changed;
}

/**
 * 删除整个文档的行尾空白。
 * @param {import('@codemirror/view').EditorView} view
 * @return {number} 改动行数
 */
export function trimTrailingWhitespace(view) {
  const state = view.state;
  const changes = [];
  for (let i = 1; i <= state.doc.lines; i += 1) {
    const line = state.doc.line(i);
    const m = /[ \t]+$/.exec(line.text);
    if (m) {
      changes.push({ from: line.from + m.index, to: line.to, insert: '' });
    }
  }
  if (!changes.length) return 0;
  view.dispatch({ changes });
  return changes.length;
}

/**
 * 复制当前行（插入到下方）。
 * @param {import('@codemirror/view').EditorView} view
 * @return {boolean}
 */
export function duplicateLine(view) {
  const state = view.state;
  const ranges = state.selection.ranges;
  const changes = [];
  for (const range of ranges) {
    const line = state.doc.lineAt(range.head);
    const text = state.sliceDoc(line.from, line.to);
    changes.push({ from: line.to, to: line.to, insert: `\n${text}` });
  }
  if (!changes.length) return false;
  view.dispatch({ changes });
  view.focus();
  return true;
}

/**
 * 选中范围内的行按升序排序（供命令层复用）。
 * @param {import('@codemirror/view').EditorView} view
 * @return {boolean}
 */
export function sortAsc(view) {
  return sortLines(view, 'asc');
}

/**
 * 选中范围内的行按降序排序。
 * @param {import('@codemirror/view').EditorView} view
 * @return {boolean}
 */
export function sortDesc(view) {
  return sortLines(view, 'desc');
}
