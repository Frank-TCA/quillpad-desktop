/**
 * QuillPad · 块级装饰层（`StateField<DecorationSet>`）
 *
 * 为什么必须是 `StateField`：CodeMirror 源码硬限制
 * 「Block decorations may not be specified via plugins」（`@codemirror/view`）。
 *
 * 职责（ARCH §5.2）：
 *  - 行装饰：标题 / 列表项 / 引用 / 代码行 / 表格源行 / front matter 行；
 *  - 块级替换：表格、front matter、公式块（**光标进入该块即撤销替换、露出源码**）；
 *  - 文末脚注区（块级 widget，追加在文档末尾）；
 *  - `atomicRanges`：让被替换的块在光标移动时表现为一个整体。
 *
 * 重建时机：`docChanged` 全量重算；仅选区变化时，只有在「选区进出某个可替换块」
 * 时才重算（用 `touched` 签名比对），避免每次移动光标都重建整篇装饰。
 */

import { EditorView, Decoration, GutterMarker, gutterLineClass } from '@codemirror/view';
import { StateField, RangeSet } from '@codemirror/state';
import { lineDecoration } from './marks.js';
import { scanMarkdown, INLINE_KINDS } from './scan.js';
import {
  FrontmatterWidget,
  MathBlockWidget,
  FootnotesBlockWidget,
  ImageRowWidget,
} from './widgets.js';
import { TableWidget, tableModelAt } from './table.js';
import { collectFootnotes } from './footnotes.js';
import { resolveImageUrl } from './image.js';

/** 可整块替换的块类型。 */
const REPLACEABLE = new Set(['table', 'frontmatter', 'math-block', 'image-row']);

/**
 * 「渲染态看不见的行」的 gutter 标记：空行、代码围栏行。
 *
 * 这些行在 WYSIWYG 里没有自己的字形：围栏行的 ``` 已被零宽隐藏、高度压到 0
 * 只留上下间距；空行虽然与正文行同高（--qp-blank-h = 28px），但行内没有任何
 * 字符，行号本身没有意义。行号槽按真实槽高定位，一个行号塞进 0 高度的围栏行
 * 就会和下一行叠在一起，所以这两类行直接把行号藏掉；
 * 源码 / 分栏视图不受影响（那边有真实的 gutter 与字形）。
 *
 * 注意 `gutterLineClass` 收的是 `GutterMarker` 而不是 `Decoration`
 * （它读 `elementClass` 和 `compare`），给成 Decoration 会在 syncGutters 里抛
 * `a[i].compare is not a function`，整个插件崩掉。
 */
const collapsedGutterMarker = new (class extends GutterMarker {
  elementClass = 'qp-gutter-hidden';
})();

/**
 * 创建块级装饰 StateField。
 *
 * @param {object} opts `createWysiwygExtension` 的入参
 * @return {StateField<{deco: DecorationSet, atomic: any, blocks: object[], touched: string}>}
 */
export function createBlockField(opts) {
  return StateField.define({
    create(state) {
      return computeBlocks(state, opts, null);
    },
    update(value, tr) {
      if (tr.docChanged) return computeBlocks(tr.state, opts, value);
      // 语言包是异步加载的：加载完成后会 reconfigure，此时语法树才可用，
      // 必须重算一次，否则首屏的表格 / 标题等块级装饰会一直缺到用户敲键盘为止。
      if (tr.reconfigured) return computeBlocks(tr.state, opts, value);
      if (tr.selection) {
        if (!value.blocks.length) return value;
        const touched = touchedSignature(tr.state, value.blocks);
        if (touched === value.touched) return value;
        return computeBlocks(tr.state, opts, value);
      }
      return value;
    },
    provide: (field) => [
      EditorView.decorations.from(field, (v) => v.deco),
      // 空行与代码围栏行的行号要单独压掉：围栏行高度是 0（只有上下间距），
      // 空行没有任何字形，行号槽却按真实槽高定位，一个行号挤进去就会和下一行
      // 叠在一起（见 collapsedGutterMarker 的说明）。
      gutterLineClass.from(field, (v) => v.gutter),
    ],
  });
}

/**
 * 选区与「可替换块」的相交签名：只要没变就不必重算。
 * @param {import('@codemirror/state').EditorState} state
 * @param {object[]} blocks
 * @return {string}
 */
function touchedSignature(state, blocks) {
  const sel = state.selection;
  const parts = [];
  for (const b of blocks) {
    if (!REPLACEABLE.has(b.kind)) continue;
    let hit = false;
    for (const r of sel.ranges) {
      if (r.from <= b.to && r.to >= b.from) {
        hit = true;
        break;
      }
    }
    parts.push(`${b.kind}:${b.from}:${hit ? 1 : 0}`);
  }
  return parts.join('|');
}

/**
 * 计算块级装饰（也导出给 `index.js` 复用）。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {object} opts
 * @param {object|null} prev 旧字段值（保留 touched 以省一次重算）
 * @return {{deco: any, atomic: any, gutter: any, blocks: object[], touched: string}}
 */
export function computeBlocks(state, opts, prev) {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const scan = scanMarkdown(state);
  const features = resolveFeatures(opts);
  /** @type {import('@codemirror/view').Range<Decoration>[]} */
  const decos = [];
  /** @type {import('@codemirror/state').Range<Decoration>[]} */
  const atomic = [];
  /** @type {import('@codemirror/state').Range<Decoration>[]} 只给 gutter 用的行标记 */
  const gutterDecos = [];

  /* ------------------------------------------------------- 1. 行装饰 */
  const lineAttrs = new Map();
  const addLine = (n, attrs, cls) => {
    const cur = lineAttrs.get(n) || { attrs: {}, classes: new Set() };
    Object.assign(cur.attrs, attrs);
    for (const c of String(cls || '').split(/\s+/).filter(Boolean)) cur.classes.add(c);
    lineAttrs.set(n, cur);
  };

  /* 代码块内的行号（WYSIWYG 专属，每个代码块各自从 1 起）。
     计数器只认 `kind === 'code'` 的连续行：一旦遇到非代码行（开 / 闭围栏、
     空行、正文…）立刻归零，所以同一个文档里的多个代码块互不影响；
     围栏行本身不带 data-qp-ln，也就不显示行号。 */
  let codeLineNo = 0;

  for (const info of scan.lines) {
    if (!info) continue;
    const n = info.number;
    if (info.kind !== 'code') codeLineNo = 0;
    switch (info.kind) {
      case 'heading': {
        const level = info.level || 1;
        addLine(
          n,
          { 'data-qp-node': 'heading', 'data-qp-level': String(level) },
          `qp-h qp-h${level}`,
        );
        break;
      }
      case 'list': {
        const attrs = {
          'data-qp-node': 'li',
          'data-qp-list': info.list || 'ul',
          'data-qp-depth': String(info.depth || 1),
        };
        // 有序列表的序号由扫描层算好，CSS 用 attr() 渲染成 `1.`，
        // 与预览里浏览器给 <ol> 生成的编号一致。
        if (info.list === 'ol') attrs['data-qp-num'] = String(info.ordinal || 1);
        addLine(n, attrs, 'qp-li');
        break;
      }
      case 'task': {
        addLine(
          n,
          {
            'data-qp-node': 'li',
            'data-qp-list': 'ul',
            'data-qp-depth': String(info.depth || 1),
            'data-qp-task': 'true',
            'data-qp-checked': info.checked ? 'true' : 'false',
          },
          `qp-li qp-li--task${info.checked ? ' is-checked' : ''}`,
        );
        break;
      }
      case 'quote': {
        addLine(
          n,
          { 'data-qp-node': 'quote', 'data-qp-depth': String(info.depth || 1) },
          'qp-quote',
        );
        break;
      }
      case 'code': {
        // 代码行序号：CSS 用 `::before { content: attr(data-qp-ln) }` 渲染。
        // 空行（块内空行）也算一行，序号连续不跳号。
        codeLineNo += 1;
        addLine(
          n,
          { 'data-qp-node': 'code-line', 'data-qp-ln': String(codeLineNo) },
          'qp-code-line',
        );
        break;
      }
      case 'fence': {
        addLine(n, { 'data-qp-node': 'code-fence' }, 'qp-code-fence');
        // 围栏行高度被压到 0（只有上下间距），行号会和下一行叠在一起
        gutterDecos.push(collapsedGutterMarker.range(state.doc.line(n).from));
        break;
      }
      case 'table': {
        addLine(n, { 'data-qp-node': 'table-line' }, 'qp-table-line');
        break;
      }
      case 'frontmatter': {
        addLine(n, { 'data-qp-node': 'frontmatter-line' }, 'qp-fm-line');
        break;
      }
      case 'math-block': {
        addLine(n, { 'data-qp-node': 'math-line' }, 'qp-math-line');
        break;
      }
      case 'footnoteDef': {
        addLine(n, { 'data-qp-node': 'footnote-def' }, 'qp-fn-def');
        break;
      }
      default:
        break;
    }
  }

  for (const [n, entry] of lineAttrs) {
    const line = state.doc.line(n);
    decos.push(lineDecoration(entry.attrs, [...entry.classes].join(' ')).range(line.from));
  }

  /* 空行：类名 `qp-blank` 保留给 CSS 与其它模块判「这是无块级语义的空行」，
     但 v1.0.3 起 CSS 不再压缩它 —— 空行与正文行同高（整行 28px）。 */
  for (const info of scan.lines) {
    if (!info || info.kind !== 'plain') continue;
    const line = state.doc.line(info.number);
    if (line.text.trim() === '') {
      const deco = lineDecoration({}, 'qp-blank');
      decos.push(deco.range(line.from));
      // 同名行在 gutter 里再挂一个标记，CSS 用它把行号藏掉（见 qp-gutter-hidden）
      gutterDecos.push(collapsedGutterMarker.range(line.from));
    }
  }

  /* ------------------------------------- 2. 图片行组（软换行 → 单段渲染）
     Markdown 的软换行里，连续多行「每行只有图片」在预览中属于**同一个段落**：
     图片按 inline 流排成一行、超宽才折行。编辑器一行一个 `.cm-line`，会竖着
     堆成 N 行（徽章栏最典型）。这里识别出这种行组，整块替换成一个 inline 流
     widget，几何尺寸才和预览一致；单行图片不替换（行内 widget 已经够）。 */
  const imageGroups = features.images === false ? [] : collectImageRowGroups(state, scan);
  const imageBlocks = [];
  if (imageGroups.length) {
    const docDir = opts.getDocDir ? opts.getDocDir() : null;
    for (const g of imageGroups) {
      imageBlocks.push({
        kind: 'image-row',
        from: g.from,
        to: g.to,
        items: g.items.map((e) => {
          const info = resolveImageUrl(e.src || '', docDir);
          return { src: e.src || '', alt: e.alt || '', url: info.url, resolved: info.resolved };
        }),
      });
    }
  }

  /* --------------------------------------------------- 3. 块级替换 */
  const blocks = [];
  for (const block of [...scan.blocks, ...imageBlocks]) {
    if (!REPLACEABLE.has(block.kind)) continue;
    blocks.push(block);
    const active = selectionTouches(state, block.from, block.to);
    if (active) {
      // 光标进入 → 露出源码。front matter 额外保留一条细标题栏，
      // 保证 `[data-qp-node="frontmatter"]` 在两种状态下都存在（T04 ⑥）。
      if (block.kind === 'frontmatter' && resolveFeatures(opts).frontmatter !== false) {
        const line = state.doc.lineAt(block.from);
        const bar = new FrontmatterWidget({
          source: '',
          collapsed: false,
          onCollapse: () => {
            if (opts.dispatchSelection) {
              const target = Math.min(state.doc.length, line.to + 1);
              opts.dispatchSelection(target);
            }
          },
        });
        decos.push(
          Decoration.widget({ widget: bar, block: false, side: -1 }).range(line.from),
        );
      }
      continue;
    }
    const built = buildBlockDecoration(state, opts, features, scan, block);
    if (built) {
      decos.push(built.deco);
      // atomicRanges 只读取 from/to，用独立 mark 装饰承载范围
      atomic.push(Decoration.mark({}).range(built.from, built.to));
    }
  }

  /* --------------------------------------------- 4. 文末脚注区（A2 #14） */
  if (features.footnotes !== false) {
    const fn = collectFootnotes(scan.lines, scan.inline, state);
    if (fn.entries.length) {
      const widget = new FootnotesBlockWidget({
        entries: fn.entries,
        onJump: (id) => opts.jumpToFootnote && opts.jumpToFootnote(id, fn),
      });
      decos.push(
        Decoration.widget({ widget, block: true, side: 1 }).range(state.doc.length),
      );
    }
  }

  const deco = Decoration.set(decos, true);
  const atomicSet = Decoration.set(atomic, true);
  const gutterSet = RangeSet.of(gutterDecos, true);
  const touched = touchedSignature(state, blocks);

  if (opts.onStats) {
    const ms = typeof performance !== 'undefined' ? performance.now() - started : 0;
    opts.onStats({ blocks: decos.length, ms });
  }
  void prev;
  return { deco, atomic: atomicSet, gutter: gutterSet, blocks, touched };
}

/**
 * 找出「纯图片行」的连续行组（软换行合并渲染用）。
 *
 * 只认「行内除图片外没有任何可见文本」的行：这样整块替换绝不会藏掉可编辑的
 * 文字，用户要点进去才能改源码。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {object} scan
 * @return {Array<{from: number, to: number, items: object[]}>}
 */
function collectImageRowGroups(state, scan) {
  const doc = state.doc;
  /** @type {Map<number, object[]>} */
  const byLine = new Map();
  for (const e of scan.inline) {
    if (e.kind !== INLINE_KINDS.image && e.kind !== INLINE_KINDS.link) continue;
    const n = e.lineNumber || doc.lineAt(e.from).number;
    const list = byLine.get(n);
    if (list) list.push(e);
    else byLine.set(n, [e]);
  }

  /** @type {Map<number, {from: number, to: number, items: object[]}>} */
  const rows = new Map();
  for (const info of scan.lines) {
    if (!info || info.kind !== 'plain') continue;
    const list = byLine.get(info.number);
    if (!list) continue;
    const line = doc.line(info.number);
    if (!line.text.trim()) continue;
    const imgs = list.filter((e) => e.kind === INLINE_KINDS.image);
    if (!imgs.length) continue;
    if (!isMediaOnlyLine(line, list, imgs)) continue;
    rows.set(info.number, { from: line.from, to: line.to, items: imgs });
  }

  // 连续行号成组
  const nums = [...rows.keys()].sort((a, b) => a - b);
  /** @type {number[][]} */
  const groups = [];
  let run = [];
  for (const n of nums) {
    if (run.length && n === run[run.length - 1] + 1) {
      run.push(n);
    } else {
      if (run.length) groups.push(run);
      run = [n];
    }
  }
  if (run.length) groups.push(run);

  // 单行图片交给行内 widget 渲染即可（本来就独占一段，无需替换）
  return groups
    .filter((g) => g.length >= 2)
    .map((g) => ({
      from: doc.line(g[0]).from,
      to: doc.line(g[g.length - 1]).to,
      items: g.flatMap((n) => rows.get(n).items),
    }));
}

/**
 * 该行是否「除图片外没有可见文本」。
 *
 * 判据：行内每个非空白字符都落在某个图片区间，或落在「只包裹图片的链接」的
 * 区间里。徽章写法 `[![License: MIT](…)](LICENSE)` 的外层链接文本就是内层
 * 图片，因此链接的可见文本段必须整体被图片覆盖才放行。
 *
 * @param {import('@codemirror/state').Line} line
 * @param {object[]} list 该行的 image / link 条目
 * @param {object[]} imgs 该行的 image 条目
 * @return {boolean}
 */
function isMediaOnlyLine(line, list, imgs) {
  const text = line.text;
  const covered = (pos) => imgs.some((e) => pos >= e.from && pos < e.to);
  const nonWs = (pos) => !/\s/.test(text[pos - line.from] || ' ');
  const allowed = imgs.map((e) => [e.from, e.to]);

  for (const e of list) {
    if (e.kind !== INLINE_KINDS.link) continue;
    const from = Math.max(e.contentFrom == null ? e.from : e.contentFrom, line.from);
    const to = Math.min(e.contentTo == null ? e.to : e.contentTo, line.to);
    for (let p = from; p < to; p += 1) {
      if (!nonWs(p)) continue;
      if (!covered(p)) return false; // 链接里有真文字
    }
    allowed.push([e.from, e.to]);
  }

  for (let p = line.from; p < line.to; p += 1) {
    if (!nonWs(p)) continue;
    if (!allowed.some(([a, b]) => p >= a && p < b)) return false;
  }
  return true;
}

/**
 * 选区是否落在某个块内。
 *
 * 用**半开区间**语义（交集长度 > 0）：空光标恰落在 from/to 边界**不算**进入。
 * 原因（D-7）：块若为文档首块（`from === 0`），光标默认就停在位置 0，
 * 闭区间 `r.from <= to && r.to >= from` 会恒判「进入」→ 走 active 分支不建 widget，
 * 导致「文档以表格 / --- / [TOC] 开头」时块级渲染完全失效。
 * 块级替换区有 `atomicRanges` 保护，光标本就进不了区间内部，
 * 只有跨块选区才真正需要「进入 → 露源码」。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} from
 * @param {number} to
 * @return {boolean}
 */
function selectionTouches(state, from, to) {
  for (const r of state.selection.ranges) {
    if (r.from < to && r.to > from) return true;
  }
  return false;
}

/**
 * 为一个块构造替换装饰。
 * @param {import('@codemirror/state').EditorState} state
 * @param {object} opts
 * @param {object} features
 * @param {object} scan
 * @param {object} block
 * @return {{deco: any, from: number, to: number}|null}
 */
function buildBlockDecoration(state, opts, features, scan, block) {
  // 覆盖到下一行行首，避免替换后残留一个空行
  const lastLine = state.doc.lineAt(Math.max(block.from, block.to - 1));
  const end = lastLine.number < state.doc.lines ? lastLine.to + 1 : lastLine.to;
  const from = state.doc.lineAt(block.from).from;

  if (block.kind === 'table') {
    if (features.tables === false) return null;
    const model = tableModelAt(state, block);
    if (!model) return null;
    const widget = new TableWidget(model, {
      onAfterEdit: () => opts.rerender && opts.rerender(),
    });
    return { deco: Decoration.replace({ widget, block: true }).range(from, end), from, to: end };
  }

  if (block.kind === 'frontmatter') {
    if (features.frontmatter === false) return null;
    const source = state.doc.sliceString(from, lastLine.to);
    const widget = new FrontmatterWidget({
      source,
      collapsed: true,
      onExpand: () => {
        // 点「编辑」→ 选区落入块内 → 下一次重算即露出源码
        if (opts.dispatchSelection) opts.dispatchSelection(Math.min(state.doc.length, from + 3));
      },
    });
    return { deco: Decoration.replace({ widget, block: true }).range(from, end), from, to: end };
  }

  if (block.kind === 'image-row') {
    if (features.images === false) return null;
    const widget = new ImageRowWidget({
      items: block.items,
      from: block.from,
      onActivate: () => {
        // 点整组 → 光标进入块首 → 下一次重算即露出这 N 行的源码
        if (opts.dispatchSelection) opts.dispatchSelection(Math.min(state.doc.length, from + 1));
      },
    });
    return { deco: Decoration.replace({ widget, block: true }).range(from, end), from, to: end };
  }

  if (block.kind === 'math-block') {
    if (features.math === false) return null;
    const source = state.doc.sliceString(from, lastLine.to);
    const tex = source.replace(/^\s*\$\$\s*/, '').replace(/\s*\$\$\s*$/, '');
    const widget = new MathBlockWidget({
      tex,
      onActivate: () => {
        if (opts.dispatchSelection) opts.dispatchSelection(Math.min(state.doc.length, from + 3));
      },
    });
    return { deco: Decoration.replace({ widget, block: true }).range(from, end), from, to: end };
  }

  return null;
}

/**
 * 把设置里的开关转成 features（缺省全开）。
 * @param {object} opts
 * @return {object}
 */
export function resolveFeatures(opts) {
  const raw = typeof opts.features === 'function' ? opts.features() : opts.features;
  const f = raw || {};
  return {
    tables: f.tables !== false,
    math: f.math !== false,
    footnotes: f.footnotes !== false,
    toc: f.toc !== false,
    frontmatter: f.frontmatter !== false,
    images: f.images !== false,
    tasks: f.tasks !== false,
  };
}