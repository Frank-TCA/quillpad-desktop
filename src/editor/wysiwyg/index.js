/**
 * QuillPad · WYSIWYG 装饰层总装
 *
 * 两层结构（ARCH §5.2）：
 *  - 块级 `StateField`（`blocks.js`）：行装饰 + 表格/front matter/公式块的块级替换；
 *  - 行内 `ViewPlugin`（本文件）：**只遍历 `view.visibleRanges`**，负责行内标记的
 *    零宽折叠 / 浮现、行内 widget（图片、任务框、公式、脚注上标、分隔线、TOC、代码块头）。
 *
 * 三条不可动摇的规则：
 *  1. 隐藏标记一律 `Decoration.mark` + `.qp-md-hide`（零宽行内块，见 wysiwyg.css），
 *     **禁止 `Decoration.replace` 删掉行内文本字符** → `.cm-line.textContent === 源码`；
 *  2. `activeLines` = **所有选区区间覆盖的行**（不是只有 head 行）；
 *  3. `update()` 内同步重算（不放 rAF），否则滚动会闪烁。
 */

import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import { Facet } from '@codemirror/state';
import {
  scanMarkdown,
  activeLineNumbers,
  INLINE_KINDS,
} from './scan.js';
import { markerDecoration, nodeDecoration, widgetDecoration, hiddenMark } from './marks.js';
import { createBlockField, resolveFeatures } from './blocks.js';
import { gutterAlignPlugin } from './gutter-align.js';
import { decoBudget, shouldSkipHeavy } from './perf.js';
import {
  ImageWidget,
  TaskCheckboxWidget,
  HrWidget,
  TocWidget,
  MathInlineWidget,
  FootnoteRefWidget,
  CodeHeadWidget,
} from './widgets.js';
import { resolveImageUrl } from './image.js';
import { collectHeadingsFromScan } from './toc.js';
import { collectFootnotes } from './footnotes.js';

/**
 * 「所见即所得装饰正在生效」标记。
 *
 * 只在本模式的扩展里 provide；source / split 不 provide → 值恒为 false。
 * 折叠判定（`editor.js` 的 `quillpadFoldable`）据此决定走源码模式的原生规则
 * 还是所见即所得的结构化规则；`setWysiwyg()` 换掉 compartment 时值随之变化。
 *
 * @type {import('@codemirror/state').Facet<boolean, boolean>}
 */
export const wysiwygMode = Facet.define({
  combine: (values) => values.some(Boolean),
});

/**
 * 生成 WYSIWYG 扩展。
 *
 * @param {object} opts
 * @param {() => boolean} opts.enabled source 模式下返回 false
 * @param {object|(() => object)} opts.features
 * @param {() => string|null} opts.getDocDir 图片解析基准目录
 * @param {(id: string, args?: object) => any} opts.runCommand
 * @param {(msg: string, kind?: string) => void} opts.toast
 * @param {(url: string) => void} [opts.onOpenLink] `Mod+Click` 打开链接
 * @param {(pos: number) => void} [opts.onJumpLine] 目录 / 脚注跳转
 * @param {(id: string, fn: object) => void} [opts.jumpToFootnote]
 * @param {() => void} [opts.rerender]
 * @return {import('@codemirror/state').Extension}
 */
export function createWysiwygExtension(opts) {
  const blockField = createBlockField(opts);
  const inlinePlugin = createInlinePlugin(opts);

  /** @type {any} */
  const extension = [
    wysiwygMode.of(true),
    blockField,
    inlinePlugin,
    // 行号跟行内容对齐（标题 / 引用 / 代码块首行有 padding-top，行号会浮在上面）
    gutterAlignPlugin,
    // 被整块替换的区域在光标移动时是原子单位
    EditorView.atomicRanges.of((view) => {
      const value = view.state.field(blockField, false);
      return value ? value.atomic : Decoration.none;
    }),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return false;
        const link = target.closest('[data-qp-node="link"]');
        if (link && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          const href = link.getAttribute('data-qp-href') || '';
          if (href && opts.onOpenLink) opts.onOpenLink(href);
          return true;
        }

        /* 点击落点兜底校正（v1.0.1 起已是「保险」，不是主力）。

           历史成因：所见即所得曾经用 margin 表达块级间距，margin 会把 .cm-line
           整体下推却不进它的 rect，CM 的 lineBlock.top 只累加 rect 高度，偏差
           逐块累积（实测到 82px），于是 posAtCoords 把点击归到下面第 1~3 行。
           v1.0.1 已把间距全部改成行盒 / widget 自己的 padding（见 wysiwyg.css），
           行高映射与真实布局一致，`cm` 与 `dom` 现在应当恒等。

           仍保留这段：异步补上尺寸的图片、被外部样式改高的 widget 等边界情况
           仍可能让两者分叉一格。caretRangeFromPoint 读的是浏览器最终布局，
           posAtDOM 再映射回文档坐标，代价只有一次比较。 */
        if (event.button !== 0 || event.detail !== 1) return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        // 图片 / 表格 / 公式等整块 widget 有自己的 mousedown（点击进入源码），别抢
        if (target.closest('[contenteditable="false"]')) return false;

        const cm = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const dom = domPosAt(view, event.clientX, event.clientY);
        if (dom === null || cm === dom) return false;

        const docLen = view.state.doc.length;
        /** 幂等校正：拖选（from !== to）与已正确的选区都不动。 */
        const correct = () => {
          const sel = view.state.selection.main;
          if (sel.from !== sel.to || sel.head === dom) return;
          if (view.state.doc.length !== docLen) return;
          view.dispatch({ selection: { anchor: dom } });
        };
        // 自定义 handler 先于 CM 内置 handler 执行，所以必须等本轮事件跑完。
        // 微任务覆盖「点击后立即读选区」，下一帧兜住 CM 在 mouseup 里再改一次的情况。
        queueMicrotask(correct);
        requestAnimationFrame(correct);
        return false;
      },
    }),
  ];
  // 暴露块级 StateField，供诊断 / 验收脚本 `state.field(field)` 使用
  extension.blockField = blockField;
  return extension;
}

/**
 * 由屏幕坐标取浏览器的真实插入位置，再映射回文档位置。
 *
 * `caretRangeFromPoint` 读的是最终布局（含 margin 折叠造成的位移），
 * 因此不受 CM 的 lineBlock 估算偏差影响。Chromium（Electron）专有；
 * 不支持时返回 null，点击行为回落到 CM 默认处理。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} x
 * @param {number} y
 * @return {number|null}
 */
function domPosAt(view, x, y) {
  if (typeof document.caretRangeFromPoint !== 'function') return null;
  const range = document.caretRangeFromPoint(x, y);
  if (!range || !view.contentDOM.contains(range.startContainer)) return null;
  try {
    return view.posAtDOM(range.startContainer, range.startOffset);
  } catch {
    // 落在 widget 内部等无法映射的 DOM 上
    return null;
  }
}

/**
 * 行内层插件。
 * @param {object} opts
 * @return {import('@codemirror/state').Extension}
 */
function createInlinePlugin(opts) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = computeInline(view, opts);
      }

      update(u) {
        // 语言包异步加载完成会 reconfigure → 语法树可用，必须重算行内装饰
        const reconfigured = u.transactions.some((t) => t.reconfigured);
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || reconfigured) {
          this.decorations = computeInline(u.view, opts);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
  return plugin;
}

/**
 * 计算行内装饰（只覆盖可见区）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {object} opts
 * @return {DecorationSet}
 */
export function computeInline(view, opts) {
  const state = view.state;
  const features = resolveFeatures(opts);
  const active = activeLineNumbers(state);
  const docDir = opts.getDocDir ? opts.getDocDir() : null;
  /** 装饰预算（T08 护栏）。 */
  const skipHeavy = shouldSkipHeavy(state.doc);
  const viewportLines = Math.max(
    20,
    Math.round(
      (view.scrollDOM ? view.scrollDOM.clientHeight : 600) /
        Math.max(12, (view.defaultLineHeight || 22)),
    ),
  );
  const budget = decoBudget(state.doc.length, viewportLines);
  /** @type {import('@codemirror/view').Range<Decoration>[]} */
  const decos = [];

  // 目录 / 脚注需要整篇信息，但计算很便宜（只遍历行数组）
  let headings = null;
  let footnoteInfo = null;
  const getHeadings = () => {
    if (!headings) {
      const scan = scanMarkdown(state);
      headings = collectHeadingsFromScan(scan.lines, state);
    }
    return headings;
  };
  const getFootnotes = () => {
    if (!footnoteInfo) {
      const scan = scanMarkdown(state);
      footnoteInfo = collectFootnotes(scan.lines, scan.inline, state);
    }
    return footnoteInfo;
  };

  for (const range of view.visibleRanges) {
    const scan = scanMarkdown(state, range);
    for (const entry of scan.inline) {
      // 装饰预算护栏（T08）：超预算即停止，宁可少装饰也不能卡住输入
      if (decos.length >= budget) break;
      try {
        collectEntry(state, entry, active, features, docDir, opts, decos, {
          getHeadings,
          getFootnotes,
          view,
          heavy: skipHeavy,
        });
      } catch (err) {
        // 单个元素出错不得影响整篇渲染（smoke.mjs 要求 console error = 0）
        console.warn('[QuillPad] 行内装饰失败：', err && err.message);
      }
    }
    if (decos.length >= budget) break;
  }

  return Decoration.set(decos, true);
}

/**
 * 处理单个行内条目。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {object} entry
 * @param {Set<number>|{has: Function}} active
 * @param {object} features
 * @param {string|null} docDir
 * @param {object} opts
 * @param {Array} out 装饰收集器
 * @param {object} ctx
 */
function collectEntry(state, entry, active, features, docDir, opts, out, ctx) {
  const isActive = active.has(entry.lineNumber);

  /* ---- 功能开关：关闭时连标记也不折叠（完全等同源码态） ---- */
  if (entry.kind === INLINE_KINDS.mathInline && features.math === false) return;
  if (entry.kind === INLINE_KINDS.toc && features.toc === false) return;
  if (entry.kind === INLINE_KINDS.task && features.tasks === false) return;
  if (entry.kind === INLINE_KINDS.image && features.images === false) return;
  if (entry.kind === INLINE_KINDS.footnoteRef && features.footnotes === false) return;

  /* ---- 超大文档（T08）：跳过需要异步渲染 / 反查全文的重装饰 ---- */
  if (ctx.heavy) {
    if (
      entry.kind === INLINE_KINDS.mathInline ||
      entry.kind === INLINE_KINDS.image ||
      entry.kind === INLINE_KINDS.toc ||
      entry.kind === INLINE_KINDS.footnoteRef
    ) {
      return;
    }
  }

  /* ---------------------------- 1. 标记：隐藏（零宽）或显示（弱化） --------- */
  const markKind = entry.markKind || 'code';
  for (const mark of entry.marks || []) {
    if (mark.to <= mark.from) continue;
    out.push(markerDecoration(markKind, isActive).range(mark.from, mark.to));
  }

  /* ------------------------------------- 2. 内容 span（数据契约 + 样式） --- */
  const contentKinds = new Set([
    INLINE_KINDS.strong,
    INLINE_KINDS.em,
    INLINE_KINDS.del,
    INLINE_KINDS.code,
    INLINE_KINDS.link,
  ]);
  if (contentKinds.has(entry.kind) && entry.contentTo > entry.contentFrom) {
    const attrs =
      entry.kind === INLINE_KINDS.link ? { 'data-qp-href': entry.href || '' } : {};
    out.push(nodeDecoration(entry.kind, attrs).range(entry.contentFrom, entry.contentTo));
  }

  /* ------------------------------------------------- 3. widget（非活跃行） --- */
  if (isActive) return;

  if (entry.kind === INLINE_KINDS.image) {
    if (!features.images) return;
    // alt 文本（`![` 与 `]` 之间）在渲染态必须一并隐藏：预览只画图片，
    // 徽章这类 `[![License: MIT](…)](…))` 否则会多出一段可见的 alt 文字。
    // 光标进入本行时上面已 return，`![alt](src)` 仍完整可见，便于改图文。
    if (entry.contentTo > entry.contentFrom) {
      out.push(hiddenMark().range(entry.contentFrom, entry.contentTo));
    }
    const info = resolveImageUrl(entry.src || '', docDir);
    const widget = new ImageWidget({
      src: entry.src || '',
      alt: entry.alt || '',
      raw: state.doc.sliceString(entry.from, entry.to),
      url: info.url,
      resolved: info.resolved,
      reason: info.reason,
    });
    out.push(widgetDecoration(widget, 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.task && features.tasks) {
    const widget = new TaskCheckboxWidget(!!entry.checked, (next) => {
      // 只替换 `[ ]` 三个字符（等长 → selection.head 不变，A5 验收）
      const raw = state.doc.sliceString(entry.from, entry.to);
      const replacement = next ? raw.replace(/\[[ xX]\]/, '[x]') : raw.replace(/\[[xX]\]/, '[ ]');
      if (replacement === raw) return;
      ctx.view.dispatch({
        changes: { from: entry.from, to: entry.to, insert: replacement },
        // 不指定 selection → CM 自动映射，head 保持原位
      });
      if (opts.rerender) opts.rerender();
    });
    out.push(widgetDecoration(widget, 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.hr) {
    out.push(widgetDecoration(new HrWidget(), 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.toc && features.toc) {
    const toc = new TocWidget(() => ctx.getHeadings(), {
      onJump: (h) => {
        if (opts.onJumpLine) opts.onJumpLine(h.from);
      },
      onEdit: () => {
        if (opts.dispatchSelection) opts.dispatchSelection(Math.min(state.doc.length, entry.from + 1));
        else if (opts.onJumpLine) opts.onJumpLine(entry.from);
      },
    });
    out.push(widgetDecoration(toc, 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.codeHead) {
    const fence = entry.fence || {};
    const widget = new CodeHeadWidget({
      lang: entry.lang || '',
      getCode: () => {
        const from = fence.bodyFrom == null ? entry.to : fence.bodyFrom;
        const to = fence.bodyTo == null ? from : fence.bodyTo;
        return state.doc.sliceString(Math.min(from, to), Math.max(from, to)).replace(/\n$/, '');
      },
      onCopy: (code) => {
        if (opts.copyText) opts.copyText(code);
      },
      onPickLang: (anchor) => {
        if (opts.runCommand) {
          opts.runCommand('markdown.pickCodeLanguage', { anchor, headFrom: fence.headFrom });
        }
      },
    });
    out.push(widgetDecoration(widget, 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.mathInline && features.math) {
    out.push(widgetDecoration(new MathInlineWidget(entry.tex || ''), 'before').range(entry.from));
    return;
  }

  if (entry.kind === INLINE_KINDS.footnoteRef && features.footnotes) {
    const fn = ctx.getFootnotes();
    const hit = fn.refs.find((r) => r.from === entry.from);
    if (hit) {
      const widget = new FootnoteRefWidget({
        index: hit.index,
        id: hit.id,
        onJump: (id) => {
          if (opts.jumpToFootnote) opts.jumpToFootnote(id, fn);
        },
      });
      out.push(widgetDecoration(widget, 'before').range(entry.from));
    }
  }
}

export { computeBlocks } from './blocks.js';
