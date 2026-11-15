/**
 * QuillPad · Markdown 源码格式化 helper
 *
 * 全部是「接收 CodeMirror EditorView、直接 dispatch 改源码」的纯函数。
 * 工具栏 / 命令面板 / 快捷键共用这一份实现，保证行为一致。
 * WYSIWYG / 分屏下源码文档依旧是可编辑文档，改 doc 即可即时反映。
 *
 * @module editor/markdown-format
 */

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
 * - 空行默认跳过，避免产生「只有前缀的空行」。
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
  const label = state.sliceDoc(sel.from, sel.to) || '链接文字';
  const text = `[${label}](url)`;
  const urlFrom = sel.from + label.length + 3; // '[' + label + ']('
  const urlTo = urlFrom + 3; // 'url'
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: urlFrom, head: urlTo },
  });
  view.focus();
}
