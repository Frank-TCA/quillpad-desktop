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

import { EditorView, Decoration, ViewPlugin, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import {
  scanMarkdown,
  activeLineNumbers,
  INLINE_KINDS,
} from './scan.js';
import { markerDecoration, nodeDecoration, widgetDecoration, hiddenMark } from './marks.js';
import { createBlockField, resolveFeatures, rescanBlocks } from './blocks.js';
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
 * 删除光标紧邻的那张表。
 *
 * 见 `tableEdgeDelete` 的说明：CM 的原子区间只拦「跨界删除」，表前后各有一条
 * 换行挡着，单按一格退格只会把两行粘起来。这里直接把整块连同它一侧的换行删掉。
 *
 * 方向必须分开：Delete 是「向前删」、Backspace 是「向后删」。光标停在表格
 * **左端外侧**（`head === block.from`）时只认 Delete，停在**右端外侧**
 * （`head === block.to`）时只认 Backspace；反方向的按键交回 CM 按普通字符
 * 删除处理，否则「光标明明在表外」也会整表消失，退格删不到上一行。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {any} blockField 块层 StateField
 * @param {'start'|'end'} side `start` 对应 Delete，`end` 对应 Backspace
 * @return {boolean} 是否处理了这次按键
 */
function deleteTableAtCursor(view, blockField, side) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const value = view.state.field(blockField, false);
  if (!value || !value.blocks) return false;
  const block = value.blocks.find(
    (b) => b.kind === 'table' && (side === 'start' ? b.from === sel.head : b.to === sel.head),
  );
  if (!block) return false;

  const doc = view.state.doc;
  let from = block.from;
  let to = block.to;
  // 吃掉表格最后一行的换行：删完这一行才算真的没了
  if (to < doc.length && doc.sliceString(to, to + 1) === '\n') to += 1;
  // 表前后都是空行时，再吃掉表前那个换行 —— 否则删完会留下连续两条空行
  if (
    from >= 2 &&
    doc.sliceString(from - 1, from) === '\n' &&
    doc.sliceString(from - 2, from - 1) === '\n'
  ) {
    from -= 1;
  }
  view.dispatch({ changes: { from, to }, selection: { anchor: from } });
  return true;
}

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

  /**
   * 点在表格左右两侧的空白处 → 把光标放到表格之前 / 之后。
   *
   * 表格是被整块替换的 widget：它占满内容列，`row` 的行盒根本不存在，所以
   * 点它左边或右边的空白，CM 只能按 `posAtCoords` 就近吸附 —— 左空白吸到
   * 表格首字符、右空白吸到文末，光标停在「块内边界」上，`Delete` / `Backspace`
   * 都删不掉整张表（它们是原子区间，只有从**外侧**退格才会整块删除）。
   *
   * 这里按几何判断：竖直方向落在某张表的高度范围内、水平方向又在表格矩形
   * 之外，就把光标送到 `from - 1`（表前一行行尾）或 `to`（表格最后一格之后）。
   * 行号槽 / 折叠箭头不拦（`cm-gutters` 有自己的点击语义）。
   *
   * @param {import('@codemirror/view').EditorView} view
   * @param {MouseEvent} event
   * @return {{pos: number}|null}
   */
  function tableBlankTarget(view, event) {
    if (event.button !== 0) return null;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return null;
    // 单元格 / 操作条自己处理；行号槽与折叠槽保留原生行为
    if (target.closest('.qp-table-wrap')) return null;
    if (target.closest('.cm-gutters')) return null;

    const wraps = Array.from(view.contentDOM.querySelectorAll('.qp-table-wrap'));
    if (!wraps.length) return null;
    let side = 0;
    let from = null;
    for (const el of wraps) {
      const r = el.getBoundingClientRect();
      if (event.clientY < r.top || event.clientY > r.bottom) continue;
      if (event.clientX < r.left) side = -1;
      else if (event.clientX > r.right) side = 1;
      from = Number(el.getAttribute('data-qp-from'));
      break;
    }
    if (!side || !Number.isFinite(from)) return null;

    const value = view.state.field(blockField, false);
    const block =
      value && value.blocks
        ? value.blocks.find((b) => b.kind === 'table' && b.from === from)
        : null;
    if (!block) return null;
    /* 落在表格**边界**上（块首 / 块末），不是相邻文字里：光标贴在表格外侧，
       再按 Delete / Backspace 由下方那条按键规则整块删掉这张表。 */
    const pos = side < 0 ? block.from : block.to;
    return { pos };
  }

  /**
   * 光标贴在表格边界上时，按方向删掉整张表。
   *
   * 为什么不能靠 CM 的 `atomicRanges` 自己搞定：原子区间只在「删除范围**跨进**
   * 区间」时生效 —— 表前一个字符是换行，退格删的是那个换行（两行被粘起来），
   * 表格纹丝不动；表后同理。所以在这里显式接管，并连带吃掉它后面那行的换行
   * （表后没内容时吃前面的），保证删完不留一串空行。
   *
   * 分工与编辑器习惯一致：
   *  - 光标在表格**左端外侧**（`head === from`）→ 只有 Delete 删表，
   *    Backspace 照常删掉表格上方那一格；
   *  - 光标在表格**右端外侧**（`head === to`）→ 只有 Backspace 删表，
   *    Delete 照常删掉表格下方那一格。
   *
   * 只在 WYSIWYG 装的块层里注册，源码 / 分栏模式没有 `blockField`，按键照旧。
   *
   * @type {import('@codemirror/view').KeyBinding}
   */
  const tableEdgeDelete = {
    key: 'Delete',
    run: (view) => deleteTableAtCursor(view, blockField, 'start'),
  };
  const tableEdgeBackspace = {
    key: 'Backspace',
    run: (view) => deleteTableAtCursor(view, blockField, 'end'),
  };

  /**
   * 表格外侧空白的点击接管。
   *
   * 挂在 `.cm-scroller` 的**捕获阶段**：表格左右两侧的空白既不在 `.cm-content`
   * 里（内容列只有 46em 宽），也不在 widget 里，命中的元素是 `.cm-scroller`
   * 本身 —— `EditorView.domEventHandlers` 只监听内容节点，收不到这种事件。
   * 捕获期拦下还能抢在 CM 自己的 mousedown 之前，`stopPropagation()` 就不会
   * 再被它的 `posAtCoords` 就近吸附改写一次。
   */
  const tableBlankPlugin = ViewPlugin.fromClass(
    class {
      /** @param {import('@codemirror/view').EditorView} view */
      constructor(view) {
        this.view = view;
        this.onMouseDown = (event) => {
          const hit = tableBlankTarget(view, event);
          if (!hit) return;
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({ selection: { anchor: hit.pos } });
          view.focus();
        };
        view.scrollDOM.addEventListener('mousedown', this.onMouseDown, true);
      }

      destroy() {
        this.view.scrollDOM.removeEventListener('mousedown', this.onMouseDown, true);
      }
    },
  );

  /**
   * 解析进度兜底（大文档首次打开 / 粘贴大段内容）。
   *
   * `scan.js` 会用 `ensureSyntaxTree` 同步解析全文，但它有 80ms 上限：超大文档
   * 首次打开只解析到一部分，视口外的列表 / 引用 / 表格还没成形。等解析在后台
   * 推进完，这里主动让块层再算一次 —— 否则那些结构会一直缺到用户敲键盘为止
   * （用户报的「首次打开表格不渲染，切一下标签再回来才对」正是这条）。
   *
   * 判据用 `ensureSyntaxTree(..., 0)`：已覆盖全文时它立刻返回、零额外解析，
   * 所以常规击键路径上这个定时器几乎是空转。
   */
  const blockRescanPlugin = ViewPlugin.fromClass(
    class {
      /** @param {import('@codemirror/view').EditorView} view */
      constructor(view) {
        this.view = view;
        this.timer = null;
        this.rounds = 0;
        this.schedule(30);
      }

      update(u) {
        const reconfigured = u.transactions.some((t) => t.reconfigured);
        if (u.docChanged || reconfigured) {
          this.rounds = 0;
          this.schedule();
        }
      }

      schedule(delay = 160) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!this.view.dom.isConnected) return;
          const { state } = this.view;
          // 已覆盖全文：块层那次计算用的就是完整树，不必再算
          if (ensureSyntaxTree(state, state.doc.length, 0)) return;
          if (this.rounds >= 3) return;
          this.rounds += 1;
          this.view.dispatch({ effects: rescanBlocks.of(null) });
          this.schedule(500);
        }, delay);
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

  /** @type {any} */
  const extension = [
    blockField,
    // 光标贴在表格边界上时，Delete / Backspace 删整张表（见 tableEdgeDelete）
    Prec.high(keymap.of([tableEdgeDelete, tableEdgeBackspace])),
    // 点在表格左右两侧的空白处 → 光标停到表格外侧（见 tableBlankTarget）
    tableBlankPlugin,
    // 语法树晚到（大文档）时补一次块级重算
    blockRescanPlugin,
    inlinePlugin,
    // 行号 / 折叠箭头与行内容对齐（标题有几十像素的 padding-top、代码行字号又
    // 与正文不同，不处理就会出现「数字浮在文字上方」）
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
        // 块层请求重扫（大文档解析推进完）时，行内层也要跟上，否则视口内的
        // 加粗 / 斜体 / 列表标记会一直停在「纯文本」那一版
        const rescanned = u.transactions.some((t) => t.effects.some((e) => e.is(rescanBlocks)));
        if (
          u.docChanged ||
          u.selectionSet ||
          u.viewportChanged ||
          u.focusChanged ||
          reconfigured ||
          rescanned
        ) {
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
