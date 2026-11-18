/**
 * QuillPad · Markdown 源码格式化 helper
 *
 * 全部是「接收 CodeMirror EditorView、直接 dispatch 改源码」的纯函数。
 * 工具栏 / 命令面板 / 快捷键共用这一份实现，保证行为一致。
 * WYSIWYG / 分屏下源码文档依旧是可编辑文档，改 doc 即可即时反映。
 *
 * @module editor/markdown-format
 */

import { t } from '../core/i18n.js';

/**
 * 给选区两端加行内标记；已包裹则反向解包（toggle）。
 *
 * - 有选区且未包裹：替换为 left+选中文本+right，保持选中内部文本；
 * - 选区外侧紧贴同样标记，或选区本身含同样标记：去掉标记；
 * - 无选区：插入 left+placeholder+right，并选中 placeholder。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} left 左标记
 * @param {string} right 右标记
 * @param {string} [placeholder] 无选区时插入的占位文字
 */
export function wrapSelection(view, left, right, placeholder = '') {
  const { state } = view;
  const sel = state.selection.main;
  const from = sel.from;
  const to = sel.to;
  const doc = state.doc;
  const leftLen = left.length;
  const rightLen = right.length;

  // 1) 选区外侧紧贴标记 —— 常见于「加粗后再点一次」
  const outerLeft = from >= leftLen ? doc.sliceString(from - leftLen, from) : '';
  const outerRight = doc.sliceString(to, Math.min(doc.length, to + rightLen));
  if (outerLeft === left && outerRight === right) {
    view.dispatch({
      changes: [
        { from: from - leftLen, to: from },
        { from: to, to: to + rightLen },
      ],
      selection: { anchor: from - leftLen, head: to - leftLen },
    });
    view.focus();
    return;
  }

  // 2) 选区内部已含标记（选中了整段 **文本**）
  const selected = doc.sliceString(from, to);
  if (
    selected.length >= leftLen + rightLen &&
    selected.startsWith(left) &&
    selected.endsWith(right)
  ) {
    const inner = selected.slice(leftLen, selected.length - rightLen);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    view.focus();
    return;
  }

  // 3) 包裹 / 无选区插入
  if (from === to) {
    const insert = left + placeholder + right;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + leftLen, head: from + leftLen + placeholder.length },
    });
  } else {
    const insert = left + selected + right;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + leftLen, head: from + leftLen + selected.length },
    });
  }
  view.focus();
}

/**
 * 对选区覆盖到的每一行加 / 去行首前缀。
 *
 * - 所有参与行（默认忽略空行）已带该前缀时去掉（toggle）；
 * - 有序列表可传生成函数得到递增 `1. ` `2. `；
 * - 空行默认跳过，避免产生「只有前缀的空行」；
 * - **例外**：选区覆盖的行**全部为空**时（典型是「光标停在空行上点列表按钮」）
 *   照样插入前缀，并把光标放到前缀之后，用户可以直接敲字。否则点了按钮毫无反应。
 *   再点一次走上面那条 toggle 分支：此时行文本已是 `- `，`re` 命中 → 前缀被去掉。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string|((i: number) => string)} prefix 静态前缀，或按行序号生成前缀
 * @param {{strip?: RegExp, skipEmpty?: boolean}} [opts]
 *   strip 用于「已带前缀」判定与去除（有序列表等动态前缀必传）
 */
export function prefixLines(view, prefix, opts = {}) {
  const { strip = null, skipEmpty = true } = opts;
  const { state } = view;
  const sel = state.selection.main;
  const doc = state.doc;

  let first = doc.lineAt(sel.from).number;
  let last = doc.lineAt(sel.to).number;
  // 选区尾部恰好落在某行行首时，不把该行算作「被覆盖」
  if (sel.to > sel.from && doc.line(last).from === sel.to) last -= 1;
  if (last < first) last = first;

  const lines = [];
  for (let n = first; n <= last; n += 1) lines.push(doc.line(n));

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = strip || (typeof prefix === 'string' ? new RegExp('^' + escape(prefix)) : null);
  const active = skipEmpty ? lines.filter((l) => l.text.trim().length > 0) : lines;
  const allPrefixed = !!re && active.length > 0 && active.every((l) => re.test(l.text));

  /* 空行特例：选区覆盖的行**全部为空**（光标在空行上 / 选中若干空行），
     且还没有前缀 —— 这时跳过空行的规则会让整个命令变成空操作。改为插入前缀，
     光标落到本行前缀之后。已经带前缀的行（`- `）trim 后非空，走下面的常规分支。 */
  const allEmpty = lines.every((l) => l.text.trim().length === 0);
  if (skipEmpty && allEmpty && !allPrefixed) {
    let seqEmpty = 0;
    const texts = lines.map((l) => {
      const p = typeof prefix === 'function' ? prefix(seqEmpty) : prefix;
      seqEmpty += 1;
      return p + l.text;
    });
    const from = lines[0].from;
    const insert = texts.join('\n');
    // 光标落在第一行前缀之后（多行时选中整块，与常规分支一致）
    const caret = from + (typeof prefix === 'function' ? prefix(0) : prefix).length;
    view.dispatch({
      changes: { from, to: lines[lines.length - 1].to, insert },
      selection: sel.empty ? { anchor: caret } : { anchor: from, head: from + insert.length },
    });
    view.focus();
    return;
  }

  let seq = 0;
  const newTexts = lines.map((l) => {
    if (skipEmpty && l.text.trim().length === 0) return l.text;
    if (allPrefixed) return l.text.replace(re, '');
    const p = typeof prefix === 'function' ? prefix(seq) : prefix;
    seq += 1;
    return p + l.text;
  });

  const blockFrom = lines[0].from;
  const blockTo = lines[lines.length - 1].to;
  const insert = newTexts.join('\n');
  view.dispatch({
    changes: { from: blockFrom, to: blockTo, insert },
    selection: { anchor: blockFrom, head: blockFrom + insert.length },
  });
  view.focus();
}

/**
 * 插入块级片段（如 `---`）：自动补前后换行，且不产生多余空行。
 *
 * 会「吃掉」光标 / 选区前后已有的连续换行再重建，保证块前后至多各一个
 * 空行；文档开头不补前导换行，文档结尾只留一个换行收尾。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} text 块内容
 */
export function insertBlock(view, text) {
  const { state } = view;
  const sel = state.selection.main;
  const doc = state.doc;
  const from = sel.from;
  const to = sel.to;

  let leadNl = 0;
  let p = from;
  while (p > 0 && doc.sliceString(p - 1, p) === '\n') {
    leadNl += 1;
    p -= 1;
  }
  let tailNl = 0;
  let q = to;
  while (q < doc.length && doc.sliceString(q, q + 1) === '\n') {
    tailNl += 1;
    q += 1;
  }
  const hasBefore = from - leadNl > 0;
  const hasAfter = to + tailNl < doc.length;

  const wantLead = hasBefore ? Math.max(2, leadNl) : 0;
  const wantTail = hasAfter ? Math.max(2, tailNl) : 1;
  const changeFrom = from - leadNl;
  const changeTo = to + tailNl;
  const insert = '\n'.repeat(wantLead) + text + '\n'.repeat(wantTail);

  view.dispatch({
    changes: { from: changeFrom, to: changeTo, insert },
    selection: {
      anchor: changeFrom + wantLead,
      head: changeFrom + wantLead + text.length,
    },
  });
  view.focus();
}

/**
 * 插入链接 `[选中文本](url)`，并把 `url` 选中以便直接输入。
 * 无选区时使用占位文字 `[链接文字](url)`。
 *
 * @param {import('@codemirror/view').EditorView} view
 */
export function insertLink(view) {
  const { state } = view;
  const sel = state.selection.main;
  const label = state.sliceDoc(sel.from, sel.to) || t('链接文字', 'Link Text');
  const text = `[${label}](url)`;
  const urlFrom = sel.from + label.length + 3; // '[' + label + ']('
  const urlTo = urlFrom + 3; // 'url'
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: urlFrom, head: urlTo },
  });
  view.focus();
}

/**
 * 插入 3 列 2 行的骨架表格（表头 + 一行数据）。
 *
 * 走块级语义（`insertBlock`）：前后各留一个空行，表格不会紧贴在上一行内容后面。
 * 注意它和 `md.hr` 同源，**不是**「绝不切断段落」—— 光标落在段落中间时，段落会被
 * 在光标处切成两段，表格插在中间（行为与插入分隔线一致，这里只是记录实情）。
 * 插入后光标落在**第一个表头单元格的文字**上，可以直接敲字；
 * 表格块本身是原子单位，光标在块内时所见即所得按「块内即源码」显示源码，
 * 移开光标才渲染成表格。
 *
 * @param {import('@codemirror/view').EditorView} view
 */
export function insertTableSkeleton(view) {
  const cols = [t('列 1', 'Column 1'), t('列 2', 'Column 2'), t('列 3', 'Column 3')];
  const text = [
    `| ${cols[0]} | ${cols[1]} | ${cols[2]} |`,
    '| --- | --- | --- |',
    '|  |  |  |',
  ].join('\n');
  insertBlock(view, text);
  // insertBlock 把选区放在插入块的首尾之间；首格文字前面是 `| `（2 个字符）
  const start = view.state.selection.main.anchor;
  const caret = Math.max(0, Math.min(view.state.doc.length, start + 2));
  view.dispatch({ selection: { anchor: caret } });
  view.focus();
}
