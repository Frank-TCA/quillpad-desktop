/**
 * QuillPad · Markdown 结构扫描
 *
 * 一个 pass 同时产出三层信息：
 *  1. `lines`  —— 每行的结构类型（标题 / 列表 / 任务 / 引用 / 代码 / 分隔线 / 表格 /
 *                 front matter / 公式块 / TOC / 脚注定义 / 普通），供块级行装饰使用；
 *  2. `blocks` —— 需要「整块替换成 widget」的区域（表格 / front matter / 公式块）；
 *  3. `inline` —— 行内元素（粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 / 任务框 /
 *                 行内公式 / 脚注引用）以及「行级 widget 锚点」（分隔线 / TOC / 围栏头）。
 *
 * 为什么必须自己扫：`@lezer/markdown@1.8.1` **不解析** front matter、`[TOC]`、
 * 脚注、`$公式$`（ARCH §5「PRD 事实校正 ②」），这 4 类只能走行级正则。
 *
 * 结果按 `EditorState` 对象做了 WeakMap 缓存：块级 StateField 与行内 ViewPlugin
 * 在同一次 update 中会各取一次，缓存保证「一次计算、两处复用」。
 */

import { syntaxTree } from '@codemirror/language';

/** 行级类型枚举。 */
export const LINE_KINDS = /** @type {const} */ ({
  plain: 'plain',
  heading: 'heading',
  list: 'list',
  task: 'task',
  quote: 'quote',
  code: 'code',
  fence: 'fence',
  hr: 'hr',
  table: 'table',
  frontmatter: 'frontmatter',
  mathBlock: 'math-block',
  toc: 'toc',
  footnoteDef: 'footnote-def',
});

/** 行内类型枚举（也用于 `data-qp-node`）。 */
export const INLINE_KINDS = /** @type {const} */ ({
  strong: 'strong',
  em: 'em',
  del: 'del',
  code: 'code-inline',
  link: 'link',
  image: 'image',
  task: 'task',
  mathInline: 'math-inline',
  footnoteRef: 'footnote-ref',
  hr: 'hr',
  toc: 'toc',
  codeHead: 'code-block',
});

/** lezer 节点 → 行内类型。 */
const INLINE_NODE_MAP = {
  StrongEmphasis: INLINE_KINDS.strong,
  Emphasis: INLINE_KINDS.em,
  Strikethrough: INLINE_KINDS.del,
  InlineCode: INLINE_KINDS.code,
  Link: INLINE_KINDS.link,
  Image: INLINE_KINDS.image,
};

/** 需要被隐藏的标记节点名（按行内类型分组）。 */
const MARK_NAMES = {
  [INLINE_KINDS.strong]: ['EmphasisMark'],
  [INLINE_KINDS.em]: ['EmphasisMark'],
  [INLINE_KINDS.del]: ['StrikethroughMark'],
  [INLINE_KINDS.code]: ['CodeMark'],
  [INLINE_KINDS.link]: ['LinkMark', 'URL', 'LinkTitle'],
  [INLINE_KINDS.image]: ['LinkMark', 'URL', 'LinkTitle'],
};

/** `data-qp-mark` 的取值（与 ARCH §8.4 一致）。 */
export const MARK_KIND_BY_INLINE = {
  [INLINE_KINDS.strong]: 'bold',
  [INLINE_KINDS.em]: 'italic',
  [INLINE_KINDS.del]: 'strike',
  [INLINE_KINDS.code]: 'code',
  [INLINE_KINDS.link]: 'link',
  [INLINE_KINDS.task]: 'task',
  [INLINE_KINDS.mathInline]: 'code',
  [INLINE_KINDS.footnoteRef]: 'footnote',
  [INLINE_KINDS.hr]: 'list',
  [INLINE_KINDS.toc]: 'link',
  [INLINE_KINDS.codeHead]: 'code',
};

/** ATX 标题节点名的前缀。 */
const ATX_PREFIX = 'ATXHeading';
const SETEXT_PREFIX = 'SetextHeading';

const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})[ \t]*([^\s`~]*)[^\n]*$/;
const RE_TOC = /^\s*\[toc\]\s*$/i;
const RE_FOOTNOTE_DEF = /^\s{0,3}\[\^([^\]\s]+)\]:[ \t]?/;
const RE_MATH_BLOCK_FENCE = /^\s*\$\$\s*$/;
const RE_HR = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const RE_MATH_INLINE = /(?<![\\$])\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g;
const RE_FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;

/** @type {WeakMap<import('@codemirror/state').EditorState, object>} */
const scanCache = new WeakMap();

/**
 * 扫描整篇文档（结果按 state 缓存）。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {{from?: number, to?: number}} [range] 只保留与该区间相交的行内元素
 * @return {{lines: object[], blocks: object[], inline: object[], kinds: object}}
 */
export function scanMarkdown(state, range) {
  let full = scanCache.get(state);
  if (!full) {
    full = buildScan(state);
    scanCache.set(state, full);
  }
  if (!range) return full;
  const { from = 0, to = state.doc.length } = range;
  return {
    ...full,
    inline: full.inline.filter((e) => e.to > from && e.from < to),
  };
}

/**
 * 真正的扫描实现。
 * @param {import('@codemirror/state').EditorState} state
 * @return {{lines: object[], blocks: object[], inline: object[]}}
 */
function buildScan(state) {
  const doc = state.doc;
  const total = doc.lines;
  /** @type {object[]} */
  const lines = new Array(total);
  /** @type {object[]} */
  const blocks = [];
  /** @type {object[]} */
  const inline = [];

  /* ------------------------------------------------ 1. 行级正则兜底扫描 */

  let inCode = false;
  let codeFence = null;
  let frontmatterEnd = -1;
  let mathBlockEnd = -1;
  /** 围栏栈（只支持单层围栏，符合 GFM 实际语义） */
  let activeFence = null;

  // front matter：第 1 行 `---` 且在其后找到 `---` / `...`
  const firstText = lineText(doc, 1);
  if (firstText.trim() === '---' && total >= 2) {
    for (let n = 2; n <= total; n += 1) {
      const t = lineText(doc, n).trim();
      if (t === '---' || t === '...') {
        frontmatterEnd = n;
        break;
      }
    }
    if (frontmatterEnd < 0) frontmatterEnd = -1;
  }

  for (let n = 1; n <= total; n += 1) {
    const line = doc.line(n);
    const text = line.text;
    /** @type {any} */
    const info = {
      number: n,
      from: line.from,
      to: line.to,
      kind: LINE_KINDS.plain,
    };
    lines[n - 1] = info;

    // front matter 区间：整块只做一件事（块级 widget 由 blocks 表达）
    if (frontmatterEnd > 0 && n <= frontmatterEnd) {
      info.kind = LINE_KINDS.frontmatter;
      if (n === 1) {
        blocks.push({
          kind: LINE_KINDS.frontmatter,
          from: line.from,
          to: doc.line(frontmatterEnd).to,
          startLine: 1,
          endLine: frontmatterEnd,
        });
      }
      continue;
    }

    // 公式块 $$ ... $$
    if (mathBlockEnd >= 0) {
      info.kind = LINE_KINDS.mathBlock;
      if (n === mathBlockEnd) {
        mathBlockEnd = -1;
        blocks.push({
          kind: LINE_KINDS.mathBlock,
          from: doc.line(startOfMathBlock(lines, n)).from,
          to: line.to,
        });
      }
      continue;
    }

    // 围栏代码块
    if (activeFence) {
      const closeMatch = RE_FENCE.exec(text);
      if (closeMatch && closeMatch[2][0] === activeFence.char && closeMatch[2].length >= activeFence.len) {
        info.kind = LINE_KINDS.fence;
        activeFence.endLine = n;
        activeFence.endFrom = line.from;
        activeFence.endTo = line.to;
        activeFence.bodyTo = doc.line(Math.max(1, n - 1)).to;
        activeFence = null;
      } else {
        info.kind = LINE_KINDS.code;
        info.lang = undefined;
      }
      continue;
    }

    const fenceMatch = RE_FENCE.exec(text);
    if (fenceMatch) {
      info.kind = LINE_KINDS.fence;
      info.lang = fenceMatch[3] || '';
      info.fenceChar = fenceMatch[2][0];
      info.fenceLen = fenceMatch[2].length;
      info.fenceFrom = line.from + fenceMatch[1].length;
      info.fenceTo = info.fenceFrom + fenceMatch[2].length + (fenceMatch[3] ? fenceMatch[3].length : 0);
      activeFence = {
        char: info.fenceChar,
        len: info.fenceLen,
        startLine: n,
        startFrom: line.from,
        headFrom: info.fenceFrom,
        headTo: line.to,
        lang: info.lang,
        bodyFrom: doc.line(Math.min(total, n + 1)).from,
      };
      // 围栏头：行内层负责隐藏 ```lang 并在行首插入语言标签 + 复制按钮
      inline.push({
        kind: INLINE_KINDS.codeHead,
        from: info.fenceFrom,
        to: info.fenceTo,
        lineNumber: n,
        lang: info.lang,
        marks: [{ from: info.fenceFrom, to: info.fenceTo }],
        fence: activeFence,
      });
      continue;
    }

    if (RE_TOC.test(text)) {
      info.kind = LINE_KINDS.toc;
      inline.push({
        kind: INLINE_KINDS.toc,
        from: line.from,
        to: line.to,
        lineNumber: n,
        marks: [{ from: line.from, to: line.to }],
      });
      continue;
    }

    if (RE_MATH_BLOCK_FENCE.test(text)) {
      const closeIdx = findMathBlockEnd(doc, n, total);
      if (closeIdx > 0) {
        info.kind = LINE_KINDS.mathBlock;
        mathBlockEnd = closeIdx;
        blocks.push({ kind: LINE_KINDS.mathBlock, from: line.from, to: doc.line(closeIdx).to, startLine: n });
        continue;
      }
    }

    const fnDef = RE_FOOTNOTE_DEF.exec(text);
    if (fnDef) {
      info.kind = LINE_KINDS.footnoteDef;
      info.footnoteId = fnDef[1];
      continue;
    }

    if (RE_HR.test(text) && text.trim().length > 0) {
      info.kind = LINE_KINDS.hr;
      // 分隔线：隐藏整行源码 + 插入 <hr> widget（保留 DOM 文本 → textContent 不变）
      inline.push({
        kind: INLINE_KINDS.hr,
        from: line.from,
        to: line.to,
        lineNumber: n,
        marks: [{ from: line.from, to: line.to }],
      });
      continue;
    }
  }

  /* ------------------------------------------- 2. 未闭合围栏：把尾巴当代码 */
  if (activeFence) {
    for (let n = activeFence.startLine + 1; n <= total; n += 1) {
      if (lines[n - 1] && lines[n - 1].kind === LINE_KINDS.plain) {
        lines[n - 1].kind = LINE_KINDS.code;
      }
    }
  }

  /* ---------------------------------------------- 3. lezer 结构（块 + 行内） */
  const tree = syntaxTree(state);
  const fmTo = frontmatterEnd > 0 ? doc.line(frontmatterEnd).to : -1;

  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (ref) => {
      const name = ref.name;
      const nodeFrom = ref.from;
      const nodeTo = ref.to;
      if (fmTo >= 0 && nodeFrom <= fmTo && nodeTo <= fmTo) return false;

      /* ---- 标题 ---- */
      if (name.startsWith(ATX_PREFIX)) {
        const level = Number(name.slice(ATX_PREFIX.length)) || 1;
        const lineNo = doc.lineAt(nodeFrom).number;
        const info = lines[lineNo - 1];
        if (info && info.kind === LINE_KINDS.plain) {
          info.kind = LINE_KINDS.heading;
          info.level = level;
        }
        // 标记：`#`×n（含尾随 `#` 及其前空格）
        const marks = [];
        for (const m of childRanges(ref.node, ['HeaderMark'])) {
          marks.push({ from: m.from, to: m.to });
        }
        inline.push({
          kind: 'heading',
          markKind: 'heading',
          from: nodeFrom,
          to: nodeTo,
          lineNumber: lineNo,
          level,
          marks: expandHeadingMarks(state, marks, nodeFrom, nodeTo),
        });
        return false;
      }
      if (name.startsWith(SETEXT_PREFIX)) {
        const level = Number(name.slice(SETEXT_PREFIX.length)) || 1;
        const lineNo = doc.lineAt(nodeFrom).number;
        const info = lines[lineNo - 1];
        if (info && info.kind === LINE_KINDS.plain) {
          info.kind = LINE_KINDS.heading;
          info.level = level;
        }
        return false;
      }

      /* ---- 列表 ---- */
      if (name === 'ListItem') {
        const depth = countAncestors(ref.node, 'ListItem') + 1;
        const parent = ref.node.parent;
        const ordered = !!parent && parent.name === 'OrderedList';
        const lineNo = doc.lineAt(nodeFrom).number;
        const info = lines[lineNo - 1];
        if (info && (info.kind === LINE_KINDS.plain || info.kind === LINE_KINDS.list)) {
          info.kind = LINE_KINDS.list;
          info.depth = depth;
          info.list = ordered ? 'ol' : 'ul';
          // 有序列表序号：预览走 HTML <ol>，由浏览器生成 1. 2. 3.；
          // WYSIWYG 每行是独立 .cm-line，拿不到父 <ol>，必须在扫描阶段算出序号，
          // 供 blocks.js 写到 data-qp-num 上，再由 CSS ::before 渲染。
          if (ordered) info.ordinal = orderedOrdinal(state, ref.node, parent);
        }
        for (const m of childRanges(ref.node, ['ListMark'])) {
          inline.push({
            kind: 'list-mark',
            markKind: 'list',
            from: m.from,
            to: m.to,
            lineNumber: doc.lineAt(m.from).number,
            depth,
            list: ordered ? 'ol' : 'ul',
            marks: [{ from: m.from, to: expandSpace(state, m.to) }],
          });
        }
        return true;
      }

      /* ---- 引用 ---- */
      if (name === 'Blockquote') {
        const depth = countAncestors(ref.node, 'Blockquote') + 1;
        for (const m of descendantRanges(ref.node, 'QuoteMark')) {
          const lineNo = doc.lineAt(m.from).number;
          const info = lines[lineNo - 1];
          if (info && info.kind === LINE_KINDS.plain) {
            info.kind = LINE_KINDS.quote;
            info.depth = depth;
          } else if (info) {
            info.depth = Math.max(info.depth || 1, depth);
            info.quote = true;
          }
          inline.push({
            kind: 'quote-mark',
            markKind: 'quote',
            from: m.from,
            to: m.to,
            lineNumber: lineNo,
            depth,
            marks: [{ from: m.from, to: expandSpace(state, m.to) }],
          });
        }
        return true;
      }

      /* ---- 任务列表 ---- */
      if (name === 'TaskMarker') {
        const lineNo = doc.lineAt(nodeFrom).number;
        const info = lines[lineNo - 1];
        const checked = /\[[xX]\]/.test(doc.sliceString(nodeFrom, nodeTo));
        if (info) {
          info.kind = LINE_KINDS.task;
          info.checked = checked;
        }
        inline.push({
          kind: INLINE_KINDS.task,
          markKind: 'task',
          from: nodeFrom,
          to: nodeTo,
          lineNumber: lineNo,
          checked,
          marks: [{ from: nodeFrom, to: expandSpace(state, nodeTo) }],
        });
        return false;
      }

      /* ---- 表格 ---- */
      if (name === 'Table') {
        const first = doc.lineAt(nodeFrom);
        const last = doc.lineAt(Math.max(nodeFrom, nodeTo - 1));
        blocks.push({
          kind: 'table',
          from: first.from,
          to: last.to,
          startLine: first.number,
          endLine: last.number,
          source: doc.sliceString(first.from, last.to),
        });
        for (let n = first.number; n <= last.number; n += 1) {
          const info = lines[n - 1];
          if (info && (info.kind === LINE_KINDS.plain || info.kind === LINE_KINDS.list)) {
            info.kind = LINE_KINDS.table;
          }
        }
        return false;
      }

      /* ---- 行内元素 ---- */
      const inlineKind = INLINE_NODE_MAP[name];
      if (inlineKind) {
        inline.push(buildInlineEntry(state, ref.node, inlineKind));
        // Link 里可能还有 Emphasis，继续下钻；其余叶子节点无需下钻
        return name === 'Link';
      }

      return undefined;
    },
  });

  /* ------------------------------------- 4. 正则行内补充：公式 / 脚注引用 */
  collectRegexInline(state, lines, inline);

  // 行内元素按位置排序，方便调试与断言
  inline.sort((a, b) => a.from - b.from || a.to - b.to);

  return { lines, blocks, inline };
}

/* ------------------------------------------------------------------ 工具 */

/**
 * 取某行文本（越界返回空串）。
 * @param {import('@codemirror/state').Text} doc
 * @param {number} n
 * @return {string}
 */
function lineText(doc, n) {
  if (n < 1 || n > doc.lines) return '';
  return doc.line(n).text;
}

/**
 * 由「公式块结束行」回溯起始行。
 * @param {object[]} lines
 * @param {number} endLine
 * @return {number}
 */
function startOfMathBlock(lines, endLine) {
  for (let n = endLine; n >= 1; n -= 1) {
    if (lines[n - 1] && lines[n - 1].kind === LINE_KINDS.mathBlock) return n;
  }
  return endLine;
}

/**
 * 找到公式块结束行（`$$` 独占一行）。
 * @param {import('@codemirror/state').Text} doc
 * @param {number} startLine
 * @param {number} total
 * @return {number} -1 表示未闭合
 */
function findMathBlockEnd(doc, startLine, total) {
  for (let n = startLine + 1; n <= total; n += 1) {
    if (RE_MATH_BLOCK_FENCE.test(doc.line(n).text)) return n;
  }
  return -1;
}

/**
 * 取某节点的直接子节点中名字命中的范围。
 * @param {import('@lezer/common').SyntaxNode} node
 * @param {string[]} names
 * @return {Array<{from: number, to: number}>}
 */
function childRanges(node, names) {
  const out = [];
  let child = node.firstChild;
  while (child) {
    if (names.includes(child.name)) out.push({ from: child.from, to: child.to });
    child = child.nextSibling;
  }
  return out;
}

/**
 * 收集子树里所有指定名称节点的区间（深度优先，含非直接子节点）。
 *
 * 为什么需要它：多行引用的第二个 `>` 不是 Blockquote 的直接子节点（Lezer 把它
 * 挂在内部 Paragraph 下），只用 `childRanges` 会漏掉第 2 行以后的引用标记，
 * 表现为「首个引用行有底色、后续行仍是裸的 `>` 源码」。
 *
 * @param {import('@lezer/common').SyntaxNode} node
 * @param {string} name
 * @return {Array<{from: number, to: number}>}
 */
function descendantRanges(node, name) {
  const out = [];
  const cur = node.cursor();
  if (!cur.firstChild()) return out;
  do {
    if (cur.name === name) out.push({ from: cur.from, to: cur.to });
  } while (cur.next());
  return out;
}

/**
 * 同名祖先数量（用于列表 / 引用嵌套层级）。
 * @param {import('@lezer/common').SyntaxNode} node
 * @param {string} name
 * @return {number}
 */
function countAncestors(node, name) {
  let n = 0;
  let parent = node.parent;
  while (parent) {
    if (parent.name === name) n += 1;
    parent = parent.parent;
  }
  return n;
}

/**
 * 计算有序列表项应显示的序号（与预览 `<ol>` 的编号规则一致）。
 *
 * 规则：从同一 `<ol>` 的首项 ListMark 读出起始号（`3.` 开头即从 3 起），
 * 再数当前项之前的兄弟 ListItem 个数。Lezer 的 Markdown 语法树里 ListItem
 * 是 OrderedList 的直接子节点，因此兄弟计数即可还原浏览器编号。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {any} item 当前 ListItem 节点
 * @param {any} list OrderedList 节点
 * @return {number}
 */
function orderedOrdinal(state, item, list) {
  let start = 1;
  let index = 0;
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'ListItem') continue;
    if (child.from === item.from) break;
    index += 1;
  }
  // 首项的 ListMark 文本即列表起始号（Lezer 未把 `start` 单独暴露成属性）。
  // 注意要读「列表第一项」而不是「当前项」——当前项自己就是首项时也得读。
  let firstItem = null;
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name === 'ListItem') {
      firstItem = child;
      break;
    }
  }
  if (firstItem) {
    const mark = firstItem.getChild('ListMark');
    if (mark) {
      const v = Number.parseInt(state.doc.sliceString(mark.from, mark.to), 10);
      if (Number.isFinite(v)) start = v;
    }
  }
  return start + index;
}

/**
 * 把位置向右扩过连续空格（隐藏 `#` 后面的空格 / `>` 后面的空格）。
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @return {number}
 */
function expandSpace(state, pos) {
  const line = state.doc.lineAt(pos);
  let p = pos;
  while (p < line.to && state.doc.sliceString(p, p + 1) === ' ') p += 1;
  return p;
}

/**
 * 标题标记范围：行首 `#` 连同其后空格、行尾 `#` 连同其前空格。
 * @param {import('@codemirror/state').EditorState} state
 * @param {Array<{from: number, to: number}>} marks
 * @param {number} nodeFrom
 * @param {number} nodeTo
 * @return {Array<{from: number, to: number}>}
 */
function expandHeadingMarks(state, marks, nodeFrom, nodeTo) {
  return marks.map((m) => {
    if (m.from === nodeFrom) return { from: m.from, to: expandSpace(state, m.to) };
    // 尾随 `#`：向前吞掉空格
    const line = state.doc.lineAt(m.from);
    let p = m.from;
    while (p > line.from && state.doc.sliceString(p - 1, p) === ' ') p -= 1;
    return { from: p, to: m.to };
  });
}

/**
 * 由 lezer 节点构造行内条目。
 * @param {import('@codemirror/state').EditorState} state
 * @param {import('@lezer/common').SyntaxNode} node
 * @param {string} inlineKind
 * @return {object}
 */
function buildInlineEntry(state, node, inlineKind) {
  const doc = state.doc;
  const lineNo = doc.lineAt(node.from).number;
  const markNames = MARK_NAMES[inlineKind] || [];
  const marks = childRanges(node, markNames).map((m) => ({ from: m.from, to: m.to }));

  /** @type {any} */
  const entry = {
    kind: inlineKind,
    markKind: MARK_KIND_BY_INLINE[inlineKind] || 'code',
    from: node.from,
    to: node.to,
    lineNumber: lineNo,
    marks,
    contentFrom: node.from,
    contentTo: node.to,
  };

  if (inlineKind === INLINE_KINDS.code) {
    // 行内代码：内容 = 去掉首尾反引号
    if (marks.length >= 2) {
      entry.contentFrom = marks[0].to;
      entry.contentTo = marks[marks.length - 1].from;
    }
  } else if (inlineKind === INLINE_KINDS.link || inlineKind === INLINE_KINDS.image) {
    // 链接 / 图片：`[` 与 `](` 之间是文本，`(` 之后是 URL
    const linkMarks = marks;
    const urlNode = childRanges(node, ['URL'])[0];
    entry.href = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : '';
    if (linkMarks.length >= 2) {
      entry.contentFrom = linkMarks[0].to;
      entry.contentTo = linkMarks[1].from;
      entry.text = doc.sliceString(entry.contentFrom, entry.contentTo);
    }
    if (inlineKind === INLINE_KINDS.image) {
      entry.src = entry.href;
      entry.alt = entry.text || '';
    }
  }

  return entry;
}

/**
 * 正则补充：行内公式 `$…$`、脚注引用 `[^id]`。
 *
 * 这些语法 lezer 完全不解析，只能按行扫；同时要跳过代码行（围栏内）与
 * 已由 lezer 处理过的行内代码范围，避免把代码里的 `$` 当公式。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {object[]} lines
 * @param {object[]} inline
 */
function collectRegexInline(state, lines, inline) {
  const doc = state.doc;
  for (const info of lines) {
    if (!info) continue;
    if (
      info.kind === LINE_KINDS.code ||
      info.kind === LINE_KINDS.fence ||
      info.kind === LINE_KINDS.frontmatter ||
      info.kind === LINE_KINDS.mathBlock
    ) {
      continue;
    }
    const text = doc.sliceString(info.from, info.to);
    if (!text.includes('$') && !text.includes('[^')) continue;

    // 行内代码范围（不被公式 / 脚注正则误伤）
    const codeRanges = inline
      .filter((e) => e.kind === INLINE_KINDS.code && e.lineNumber === info.number)
      .map((e) => [e.from - info.from, e.to - info.from]);

    /** 是否落在行内代码里 */
    const inCode = (idx) => codeRanges.some(([a, b]) => idx >= a && idx < b);

    if (text.includes('$')) {
      RE_MATH_INLINE.lastIndex = 0;
      let m;
      while ((m = RE_MATH_INLINE.exec(text))) {
        const start = m.index;
        if (inCode(start)) continue;
        const from = info.from + start;
        const to = from + m[0].length;
        inline.push({
          kind: INLINE_KINDS.mathInline,
          markKind: 'code',
          from,
          to,
          lineNumber: info.number,
          tex: m[1],
          marks: [{ from, to }],
        });
      }
    }

    if (text.includes('[^')) {
      RE_FOOTNOTE_REF.lastIndex = 0;
      let m;
      while ((m = RE_FOOTNOTE_REF.exec(text))) {
        const start = m.index;
        if (inCode(start)) continue;
        const from = info.from + start;
        const to = from + m[0].length;
        inline.push({
          kind: INLINE_KINDS.footnoteRef,
          markKind: 'footnote',
          from,
          to,
          lineNumber: info.number,
          id: m[1],
          marks: [{ from, to }],
        });
      }
    }
  }
}

/**
 * 取某位置所在行的信息。
 * @param {object[]} lines
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @return {object|null}
 */
export function lineInfoAt(lines, state, pos) {
  const n = state.doc.lineAt(pos).number;
  return lines[n - 1] || null;
}

/**
 * 收集选区覆盖的所有行号（A3 核心：不是只有 head 行）。
 *
 * 大选区（跨 > 400 行）时退化为「全部视为活跃」，避免集合膨胀。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @return {Set<number>}
 */
export function activeLineNumbers(state) {
  const set = new Set();
  for (const range of state.selection.ranges) {
    const a = state.doc.lineAt(range.from).number;
    const b = state.doc.lineAt(range.to).number;
    if (b - a > 400) return { has: () => true, size: Infinity, large: true };
    // 空光标恰在文档位置 0（默认光标位）不算「进入首行」。
    // 否则文档以 hr / [TOC] / 表格开头时，首行恒被判活跃 → 首块只露源码不渲染（D-7）。
    // 语义：光标停在文档开头边界 ≠ 用户主动进入该行。
    if (range.empty && range.from === 0 && a === 1) {
      for (let n = 2; n <= b; n += 1) set.add(n);
      continue;
    }
    for (let n = a; n <= b; n += 1) set.add(n);
  }
  return set;
}
