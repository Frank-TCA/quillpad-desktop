/**
 * QuillPad · 表格 widget + 浮层单元格编辑 + 7 个操作浮层
 *
 * 方案由 spike S1 验证（`docs/spike-s1.md`，14/14 PASS）：
 *  1. 表格整体由块级 `Decoration.replace({block:true, widget})` 渲染；
 *  2. widget 内是**纯静态** `<table>`（`table-layout:fixed` + `<colgroup>` 百分比列宽）；
 *  3. 单元格编辑用挂在 `document.body` 的**浮层 `<input>`**（不在 widget DOM 内），
 *     因此 `dispatch` 导致 widget 重建时也不会失焦；
 *  4. widget 根节点必须给**像素宽度** —— `.cm-content` 是 flex item，
 *     widget 内 `width:100%` 会命中 Chromium 的固有尺寸哨兵值（1e6px）。
 *     宽度值 = `.cm-content` **内容列宽**（正文所在列），使表格右缘与正文
 *     右端对齐（预览里 `.markdown-body table{width:100%}` 的同构语义）；
 *     并由 ResizeObserver 跟随内容列变化（窗口缩放 / 分屏 / 侧栏 / 迷你地图 / 字号）。
 */

import { WidgetType } from '@codemirror/view';
import { icon } from '../../ui/icons.js';
import {
  parseTable,
  serializeTable,
  applyCellEdit,
  unescapeCell,
} from './table-model.js';
import { applyTableOp } from './table-ops.js';

/** 7 个操作的展示元数据（顺序即浮层顺序）。 */
export const TABLE_OP_SPEC = [
  { op: 'rowAbove', label: '上方插入行', glyph: 'arrowUp' },
  { op: 'rowBelow', label: '下方插入行', glyph: 'arrowDown' },
  { op: 'rowDelete', label: '删除行', glyph: 'trash' },
  { op: 'colLeft', label: '左侧插入列', glyph: 'arrowLeft' },
  { op: 'colRight', label: '右侧插入列', glyph: 'arrowRight' },
  { op: 'colDelete', label: '删除列', glyph: 'trash' },
  { op: 'alignCycle', label: '切换对齐', glyph: 'table' },
];

/** 浮层输入框（全局单例，挂在 body）。 */
let cellInput = null;

/**
 * 取（或懒创建）浮层输入框。
 * @param {object} handlers
 * @return {HTMLInputElement}
 */
function ensureCellInput(handlers) {
  if (cellInput && cellInput.isConnected) {
    cellInput._handlers = handlers;
    return cellInput;
  }
  const el = document.createElement('input');
  el.type = 'text';
  el.className = 'qp-cell-editor';
  el.setAttribute('data-role', 'cell-editor');
  el.setAttribute('aria-label', '编辑单元格');
  el.spellcheck = false;
  el.hidden = true;
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const h = el._handlers || {};
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeCellEditor();
      if (h.onEscape) h.onEscape();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (h.onInsertRowBelow) h.onInsertRowBelow();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitCellEditor(false);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitCellEditor(true, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      commitCellEditor(false);
      if (h.onEscapeVertical) h.onEscapeVertical(e.key === 'ArrowUp' ? -1 : 1);
    }
  });
  for (const type of ['input', 'beforeinput', 'paste', 'compositionstart', 'compositionend']) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
  el.addEventListener('blur', () => {
    // 点别处 / 滚动时提交并关闭，避免浮层与表格错位
    if (!el.hidden) commitCellEditor(false);
  });
  document.body.appendChild(el);
  cellInput = el;
  return el;
}

/**
 * 打开浮层输入框。
 *
 * @param {object} params
 * @param {import('@codemirror/view').EditorView} params.view
 * @param {HTMLTableCellElement} params.td
 * @param {number} params.r DOM 行下标（0 = 表头）
 * @param {number} params.c 列下标
 * @param {string} params.value 原始（未转义）文本
 * @param {object} params.model 表格模型
 * @param {(next: object, opts: {focusNext: number}) => void} params.apply 提交回调
 * @param {Function} [params.onInsertRowBelow]
 * @param {Function} [params.onEscape]
 * @param {Function} [params.onEscapeVertical]
 */
export function openCellEditor(params) {
  const el = ensureCellInput({
    onInsertRowBelow: params.onInsertRowBelow,
    onEscape: params.onEscape,
    onEscapeVertical: params.onEscapeVertical,
  });
  const rect = params.td.getBoundingClientRect();
  el.style.left = `${Math.round(rect.left)}px`;
  el.style.top = `${Math.round(rect.top)}px`;
  el.style.width = `${Math.max(72, Math.round(rect.width))}px`;
  el.style.height = `${Math.max(24, Math.round(rect.height))}px`;
  el.dataset.r = String(params.r);
  el.dataset.c = String(params.c);
  el.dataset.from = String(params.model.from);
  el.value = params.value;
  el.hidden = false;
  el._ctx = params;
  el.focus();
  el.select();
  // 某些时序下（widget 重建 / CM requestMeasure）焦点会被别人抢走，
  // 下一帧再确认一次，避免浮层「开着但键盘无效」。
  requestAnimationFrame(() => {
    if (el.hidden) return;
    if (document.activeElement !== el) {
      el.focus();
      el.select();
    }
  });
  return el;
}

/**
 * 提交浮层输入框内容。
 * @param {boolean} keepOpen 是否保持浮层（Tab 换格场景由调用方重新打开）
 * @param {number} [dir] Tab 方向：+1 下一格 / -1 上一格
 */
export function commitCellEditor(keepOpen = false, dir = 0) {
  const el = cellInput;
  if (!el || el.hidden) return;
  const ctx = el._ctx;
  if (!ctx) return;
  const r = Number(el.dataset.r);
  const c = Number(el.dataset.c);
  const value = el.value;
  el.hidden = true;
  if (ctx.apply) ctx.apply({ r, c, value, dir }, { focusNext: keepOpen ? dir : 0 });
}

/** 关闭浮层输入框（不提交）。 */
export function closeCellEditor() {
  if (!cellInput) return;
  const ctx = cellInput._ctx;
  cellInput.hidden = true;
  cellInput._ctx = null;
  if (ctx && ctx.view) ctx.view.focus();
}

/** 浮层是否打开（供滚动 / 点击其它处时统一关闭）。 */
export function isCellEditorOpen() {
  return !!cellInput && !cellInput.hidden;
}

/* ------------------------------------------------- 宽度：内容列 + 缩放响应 */

/** 测量失效时的兜底宽度下限（spike S1 的 320px 地板，仅走退化路径）。 */
const FALLBACK_MIN_WIDTH = 320;

/** 超过此值视为 Chromium 固有尺寸哨兵（1e6px）而非真实宽度。 */
const SENTINEL_WIDTH = 400000;

/**
 * 编辑面（`.cm-content`）→ 宽度监听上下文。
 * 同一编辑面的全部表格共用一个 ResizeObserver，最后一个表格销毁时自动断开。
 * @type {Map<Element, {view: any, wraps: Set<HTMLElement>, lastWidth: number, observer: ResizeObserver|null}>}
 */
const widthWatchers = new Map();

/**
 * 测量 `.cm-content` 的内容列宽（正文文本所在的列宽）。
 *
 * 表格 widget 是 `.cm-content` 的直接块级子节点，把根节点宽度设为内容列宽
 * 即可让表格右缘与正文右端精确对齐。不能用 `width:100%`（spike S1 哨兵坑），
 * 也不能按 `scrollDOM.clientWidth - offsetLeft` 估算：`.cm-content.qp-doc`
 * 带 `max-width:46em; margin:0 auto`，估算会把表格撑出正文列（右侧溢出）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {number} 像素宽度；测量无效（隐藏 / 哨兵值）时返回 0
 */
function measureContentColumn(view) {
  const content = view.contentDOM;
  if (!content) return 0;
  const rect = content.getBoundingClientRect();
  const cs = getComputedStyle(content);
  const padH = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  // 正文列真正减掉的是 `.cm-line` 的左右内边距：`.cm-content.qp-doc` 为补偿
  // 这 20px 特意把容器加宽（见 wysiwyg.css §0），表格若按容器宽算就会比
  // 预览宽 20px，右缘伸出正文列。
  const line = content.querySelector('.cm-line');
  const lcs = line ? getComputedStyle(line) : null;
  const linePadH = lcs
    ? (parseFloat(lcs.paddingLeft) || 0) + (parseFloat(lcs.paddingRight) || 0)
    : 0;
  const width = rect.width - padH - linePadH;
  if (!Number.isFinite(width) || width <= 0 || width > SENTINEL_WIDTH) return 0;
  return width;
}

/**
 * 退化兜底：拿不到内容列宽时按可视区估算（spike S1 旧公式）。
 * @param {import('@codemirror/view').EditorView} view
 * @return {number}
 */
function fallbackTableWidth(view) {
  const scrollW = (view.scrollDOM && view.scrollDOM.clientWidth) || 800;
  const offsetLeft = (view.contentDOM && view.contentDOM.offsetLeft) || 0;
  return Math.max(FALLBACK_MIN_WIDTH, scrollW - offsetLeft - 28);
}

/**
 * 把表格根节点宽度设成内容列宽（右缘与正文右端对齐）。
 * @param {import('@codemirror/view').EditorView} view
 * @param {HTMLElement} wrap
 */
function applyTableWidth(view, wrap) {
  const measured = measureContentColumn(view);
  const width = measured > 0 ? measured : fallbackTableWidth(view);
  // 保留 2 位小数即可覆盖分数像素布局，又避免样式串里出现浮点噪声
  const next = `${Math.round(width * 100) / 100}px`;
  if (wrap.style.width !== next) wrap.style.width = next;
}

/**
 * 绑定表格宽度：立即按内容列定宽，并注册 ResizeObserver 跟随缩放。
 *
 * 响应窗口缩放、分屏切换、侧栏拖宽、迷你地图显隐、字号 / --qp-measure 变化
 * 等一切内容列几何变化；缩放会挪动单元格位置，与滚动同策略（提交并关闭浮层）。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {HTMLElement} wrap
 * @return {() => void} 解绑函数（widget destroy 时调用）
 */
function bindTableWidth(view, wrap) {
  const content = view.contentDOM;
  applyTableWidth(view, wrap);
  if (!content || typeof ResizeObserver !== 'function') return () => {};
  let entry = widthWatchers.get(content);
  if (!entry) {
    entry = { view, wraps: new Set(), lastWidth: measureContentColumn(view), observer: null };
    entry.observer = new ResizeObserver(() => {
      if (!content.isConnected) {
        // 编辑面已销毁：断开并清掉注册，防止泄漏
        if (entry.observer) entry.observer.disconnect();
        widthWatchers.delete(content);
        return;
      }
      const width = measureContentColumn(view);
      // 高度变化（图片加载等）也会触发回调，只在列宽真的变了时动手
      if (width <= 0 || width === entry.lastWidth) return;
      entry.lastWidth = width;
      for (const el of entry.wraps) {
        if (el.isConnected) applyTableWidth(view, el);
      }
      if (isCellEditorOpen()) commitCellEditor(false);
    });
    entry.observer.observe(content);
    widthWatchers.set(content, entry);
  }
  entry.wraps.add(wrap);
  return () => {
    const current = widthWatchers.get(content);
    if (!current) return;
    current.wraps.delete(wrap);
    if (current.wraps.size === 0) {
      if (current.observer) current.observer.disconnect();
      widthWatchers.delete(content);
    }
  };
}

/* --------------------------------------------------------------- widget */

/** 表格 widget。 */
export class TableWidget extends WidgetType {
  /**
   * @param {import('./table-model.js').TableModel} model
   * @param {object} opts
   */
  constructor(model, opts) {
    super();
    this.model = model;
    this.opts = opts;
    this.activeCell = { r: 0, c: 0 };
    /** @type {(() => void)|null} 宽度绑定的解绑回调（toDOM 时注册）。 */
    this._unbindWidth = null;
  }

  eq(other) {
    return (
      other instanceof TableWidget &&
      other.model.from === this.model.from &&
      other.model.to === this.model.to &&
      JSON.stringify(other.model.headers) === JSON.stringify(this.model.headers) &&
      JSON.stringify(other.model.aligns) === JSON.stringify(this.model.aligns) &&
      JSON.stringify(other.model.rows) === JSON.stringify(this.model.rows)
    );
  }

  toDOM(view) {
    this._view = view;
    const model = this.model;
    const wrap = document.createElement('div');
    wrap.className = 'qp-table-wrap';
    wrap.setAttribute('contenteditable', 'false');
    // 关键：块级 widget 必须给像素宽度（spike S1 结论），禁止 width:100%。
    // 宽度按 .cm-content 内容列计算 → 右缘与正文右端对齐；
    // ResizeObserver 跟随窗口缩放 / 分屏 / 侧栏 / 迷你地图 / 字号变化。
    if (this._unbindWidth) this._unbindWidth();
    this._unbindWidth = bindTableWidth(view, wrap);

    const table = document.createElement('table');
    table.className = 'qp-table';
    table.setAttribute('data-qp-node', 'table');

    /* colgroup：列宽由纯函数推导 → 撤销后必然逐项相同（T06 验收④） */
    const colgroup = document.createElement('colgroup');
    model.widths.forEach((w) => {
      const col = document.createElement('col');
      col.style.width = `${w}%`;
      colgroup.appendChild(col);
    });
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    thead.appendChild(this._buildRow(view, model.headers, 0, 'th'));
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    model.rows.forEach((row, i) => {
      tbody.appendChild(this._buildRow(view, row, i + 1, 'td'));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    wrap.appendChild(this._buildOpsOverlay());

    // 交互护盾：不让任何事件冒泡到 CM
    for (const type of [
      'keydown',
      'beforeinput',
      'input',
      'paste',
      'compositionstart',
      'compositionend',
      'drop',
      'dragstart',
    ]) {
      wrap.addEventListener(type, (e) => e.stopPropagation());
    }
    return wrap;
  }

  /**
   * 构造一行。
   * @param {import('@codemirror/view').EditorView} view
   * @param {string[]} cells
   * @param {number} domRow 0 = 表头
   * @param {'th'|'td'} tag
   * @return {HTMLTableRowElement}
   */
  _buildRow(view, cells, domRow, tag) {
    const tr = document.createElement('tr');
    cells.forEach((raw, c) => {
      const cell = document.createElement(tag);
      cell.className = 'qp-table__cell';
      cell.setAttribute('data-r', String(domRow));
      cell.setAttribute('data-c', String(c));
      cell.textContent = unescapeCell(raw);
      const align = this.model.aligns[c];
      if (align) cell.style.textAlign = align;
      cell.title = '双击编辑单元格';
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.activeCell = { r: domRow, c };
        // 单击：只把文档光标落到表格块首（菜单里的 7 个表格操作据此定位），
        // 保证「点击编辑区 = 聚焦文档」这一基本契约不被 widget 打断；
        // 双击（e.detail >= 2）：才唤起浮层 input 做单元格所见即所得编辑。
        if (e.detail >= 2) {
          this._openEditor(view, cell, domRow, c);
          return;
        }
        this._focusBlock(view);
      });
      tr.appendChild(cell);
    });
    return tr;
  }

  /**
   * 单击单元格 → 把文档光标落到表格块**前一个字符**并聚焦编辑器。
   * 注意不能落在 `block.from`：光标与块区间相接会触发「光标进入 → 露出源码」
   * （A3 契约），widget 被移除，随后的双击就落不到单元格上了。
   * 落在 `from - 1` 既能让光标可见，又能让 `nearestTableBlock()` 命中本表。
   * @param {import('@codemirror/view').EditorView} view
   */
  _focusBlock(view) {
    const pos = this.model.from - 1;
    if (pos >= 0) {
      view.dispatch({ selection: { anchor: pos } });
    }
    view.focus();
  }

  /**
   * 打开单元格浮层。
   * @param {import('@codemirror/view').EditorView} view
   * @param {HTMLTableCellElement} cell
   * @param {number} domRow
   * @param {number} col
   */
  _openEditor(view, cell, domRow, col) {
    const model = parseTable(
      view.state.doc.sliceString(this.model.from, this.model.to),
      this.model.from,
      this.model.to,
    ) || this.model;
    openCellEditor({
      view,
      td: cell,
      r: domRow,
      c: col,
      value: unescapeCell(domRow === 0 ? model.headers[col] : (model.rows[domRow - 1] || [])[col]),
      model,
      apply: (change, options) => this._applyCell(view, model, change, options),
      onInsertRowBelow: () => {
        this._applyOp(view, 'rowBelow', { row: Math.max(0, domRow - 1), col });
      },
      onEscape: () => {
        // Esc：把光标落到表格块之后（A4 验收⑦）
        const pos = Math.min(view.state.doc.length, this.model.to + 1);
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      },
      onEscapeVertical: (dir) => {
        const pos =
          dir < 0
            ? Math.max(0, this.model.from - 1)
            : Math.min(view.state.doc.length, this.model.to + 1);
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
      },
    });
  }

  /**
   * 应用一次单元格编辑：模型 → 序列化 → 一次 dispatch。
   * @param {import('@codemirror/view').EditorView} view
   * @param {import('./table-model.js').TableModel} model
   * @param {{r: number, c: number, value: string, dir: number}} change
   * @param {{focusNext: number}} options
   */
  _applyCell(view, model, change, options) {
    // 浮层可能比文档活得久（换文件 / 整体替换 / 撤销跨过表格边界）：
    // 位置失效时直接丢弃这次提交，绝不能 dispatch 一个越界 range。
    if (!model || model.to > view.state.doc.length || model.from < 0) {
      closeCellEditor();
      return;
    }
    const live = parseTable(
      view.state.doc.sliceString(model.from, model.to),
      model.from,
      model.to,
    );
    const base = live || model;
    const next = applyCellEdit(base, change.r - 1, change.c, change.value);
    this._dispatchModel(view, next, base);
    const dir = options && options.focusNext ? options.focusNext : 0;
    if (dir) {
      // Tab / Shift-Tab：换到相邻单元格（行末跳到下一行首格）
      const cells = Array.from(view.dom.querySelectorAll('.qp-table__cell')).map((el) => ({
        r: Number(el.getAttribute('data-r')),
        c: Number(el.getAttribute('data-c')),
        el,
      }));
      const idx = cells.findIndex((x) => x.r === change.r && x.c === change.c);
      const target = cells[idx + dir];
      if (target) {
        this.activeCell = { r: target.r, c: target.c };
        requestAnimationFrame(() => this._openEditor(view, target.el, target.r, target.c));
        return;
      }
    }
    if (this.opts.onAfterEdit) this.opts.onAfterEdit();
  }

  /**
   * 应用一个行列操作。
   * @param {import('@codemirror/view').EditorView} view
   * @param {string} op
   * @param {{row?: number, col?: number}} at
   */
  _applyOp(view, op, at) {
    const model = parseTable(
      view.state.doc.sliceString(this.model.from, this.model.to),
      this.model.from,
      this.model.to,
    );
    if (!model) return;
    const next = applyTableOp(model, op, at || this.activeCell);
    this._dispatchModel(view, next, model);
  }

  /**
   * 把新模型写回文档。
   * @param {import('@codemirror/view').EditorView} view
   * @param {import('./table-model.js').TableModel} next
   * @param {import('./table-model.js').TableModel} prev
   */
  _dispatchModel(view, next, prev) {
    const out = serializeTable(next);
    const docLen = view.state.doc.length;
    const from = Math.max(0, Math.min(prev.from, docLen));
    // 同样的越界保护：宁可少改一次，也不能抛 "Invalid change range"
    const to = Math.max(from, Math.min(prev.from + prev.rawLines.join('\n').length, docLen));
    view.dispatch({
      changes: { from, to, insert: out.text },
    });
  }

  /**
   * 7 个操作的浮层。
   * @return {HTMLElement}
   */
  _buildOpsOverlay() {
    const bar = document.createElement('div');
    bar.className = 'qp-table-ops';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '表格操作');
    for (const spec of TABLE_OP_SPEC) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qp-table-ops__btn';
      btn.setAttribute('data-op', spec.op);
      btn.setAttribute('data-tip', spec.label);
      btn.setAttribute('aria-label', spec.label);
      btn.innerHTML = icon(spec.glyph, 13);
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = this._view || (this.opts.getView ? this.opts.getView() : null);
        if (!view) return;
        this._applyOp(view, spec.op, {
          row: Math.max(0, this.activeCell.r - 1),
          col: this.activeCell.c,
        });
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  ignoreEvent() {
    return true;
  }

  /**
   * widget 被移除（文档改动重建 / 切模式 / 视图销毁）时解除宽度监听。
   */
  destroy() {
    if (this._unbindWidth) {
      this._unbindWidth();
      this._unbindWidth = null;
    }
  }

  get estimatedHeight() {
    return Math.max(60, (this.model.rows.length + 1) * 34 + 12);
  }
}

/**
 * 从文档里解析表格模型（供块层刷新时使用）。
 * @param {import('@codemirror/state').EditorState} state
 * @param {{from: number, to: number}} block
 * @return {import('./table-model.js').TableModel|null}
 */
export function tableModelAt(state, block) {
  const source = state.doc.sliceString(block.from, block.to);
  return parseTable(source, block.from, block.to);
}
