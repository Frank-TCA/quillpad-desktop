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
import { t } from '../../core/i18n.js';
import {
  parseTable,
  serializeTable,
  applyCellEdit,
  unescapeCell,
  isDelimiterRow,
  rowHasPipe,
} from './table-model.js';
import { applyTableOp } from './table-ops.js';

/**
 * 7 个操作的展示元数据（顺序即浮层顺序）。
 *
 * `label` 用 getter：本数组在模块顶层，若把 t() 结果写死成字符串，
 * 切语言后浮层按钮的 tooltip 不会更新。
 */
export const TABLE_OP_SPEC = [
  {
    op: 'rowAbove',
    get label() {
      return t('上方插入行', 'Insert Row Above');
    },
    glyph: 'arrowUp',
  },
  {
    op: 'rowBelow',
    get label() {
      return t('下方插入行', 'Insert Row Below');
    },
    glyph: 'arrowDown',
  },
  {
    op: 'rowDelete',
    get label() {
      return t('删除行', 'Delete Row');
    },
    glyph: 'rowDelete',
  },
  {
    op: 'colLeft',
    get label() {
      return t('左侧插入列', 'Insert Column Left');
    },
    glyph: 'arrowLeft',
  },
  {
    op: 'colRight',
    get label() {
      return t('右侧插入列', 'Insert Column Right');
    },
    glyph: 'arrowRight',
  },
  {
    op: 'colDelete',
    get label() {
      return t('删除列', 'Delete Column');
    },
    glyph: 'colDelete',
  },
  {
    op: 'alignCycle',
    get label() {
      return t('切换对齐', 'Cycle Alignment');
    },
    glyph: 'table',
  },
];

/** 浮层输入框（全局单例，挂在 body）。 */
let cellInput = null;

/**
 * 表格块的「当前单元格」记忆。
 *
 * 为什么不能只放在 `TableWidget` 实例上：操作浮层的每个按钮都会 dispatch 一次
 * 改动，`TableWidget.eq()` 因为 `aligns` / `rows` 变了返回 false，CodeMirror
 * 随即**销毁旧实例、新建一个 widget**（DOM 也是新的）。实例字段 `activeCell`
 * 于是被重置成默认的 `{r:0,c:0}` —— 这正是「切换对齐第二次点击开始总是改首列」
 * 的成因：第一次点对了列，之后每次都被当成表头首格。
 *
 * 记忆按「表格块起始偏移」索引（同一张表做对齐 / 增删行列时 `from` 不变，
 * 表前正文改动导致 `from` 变化时自然失配、回落到本实例的 activeCell）。
 *
 * @type {Map<number, {r: number, c: number}>}
 */
const cellMemory = new Map();

/**
 * 记下某张表最后操作的单元格。
 * @param {number} from 表格块起始偏移
 * @param {number} r DOM 行下标（0 = 表头）
 * @param {number} c 列下标
 */
function rememberCell(from, r, c) {
  cellMemory.set(from, { r, c });
}

/**
 * 取某张表最后操作的单元格，并夹紧到当前表格尺寸内
 * （中间可能删过行 / 列，下标会越界）。
 * @param {number} from 表格块起始偏移
 * @param {number} rowCount 数据行数
 * @param {number} colCount 列数
 * @return {{r: number, c: number}}
 */
function recallCell(from, rowCount, colCount) {
  const got = cellMemory.get(from);
  const r = got ? got.r : 0;
  const c = got ? got.c : 0;
  return {
    r: Math.min(Math.max(0, rowCount), Math.max(0, r)),
    c: Math.min(Math.max(0, colCount - 1), Math.max(0, c)),
  };
}

/**
 * 按块起始偏移，从**当前文档**重新解析那张表。
 *
 * 为什么不能直接用 widget 上的 `this.model`：它的 `from` / `to` 是渲染那一刻的
 * 快照。只要表格文本长度变过（切换对齐会把 `---` 变成 `:---:`、单元格编辑会改
 * 字数），旧 `to` 就短了一截 —— 拿它去 `sliceString()` 会切在半行中间，随后
 * 序列化再写回，末尾那一格就会多出一个 `|`，或者把后面的正文并进表格。
 *
 * 探针实测过的两个具体故障都出自这里：
 *  1. 浮层开着时点「切换对齐」→ 提交时用旧区间 → 最后一行变成 `| 3 | 4 ||`；
 *  2. 表下紧跟正文（GFM 会把它算成表格行）→ 点一次对齐就把正文写成 `| 正文 |  |  |`。
 *
 * 第 2 条的另一半在 `scan.js`（收窄表格块区间）与 `table-model.js`（解析时在
 * 无竖线行处截断）；这里负责「按当前文本重新取一遍」，三者合起来保证操作只碰
 * 真正的表格行。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} from 表格块起始偏移（必须是行首）
 * @return {import('./table-model.js').TableModel|null} 该位置已不是一张完整的表时返回 null
 */
function liveTableModel(view, from) {
  const doc = view.state.doc;
  if (!Number.isFinite(from) || from < 0 || from > doc.length) return null;
  const head = doc.lineAt(from);
  // 起始偏移必须仍落在行首，否则说明表已被移动 / 前面的文字改过长度
  if (head.from !== from) return null;
  if (head.number >= doc.lines) return null;
  const delim = doc.line(head.number + 1);
  if (!isDelimiterRow(delim.text)) return null;
  let lastNo = delim.number;
  for (let n = lastNo + 1; n <= doc.lines; n += 1) {
    if (!rowHasPipe(doc.line(n).text)) break;
    lastNo = n;
  }
  const last = doc.line(lastNo);
  return parseTable(doc.sliceString(head.from, last.to), head.from, last.to);
}

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
  el.setAttribute('aria-label', t('编辑单元格', 'Edit Cell'));
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
      /* 末尾单元格（最后一行 × 最右一列）敲回车 = 「表格写完了」，把光标送到
         表格之外的下一行；其余单元格回车只是提交（保持原来的手感）。 */
      const r = Number(el.dataset.r);
      const c = Number(el.dataset.c);
      const last = typeof h.isLastCell === 'function' ? h.isLastCell(r, c) : false;
      commitCellEditor(false);
      if (last && typeof h.onExitBelow === 'function') h.onExitBelow();
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
 * @param {(r: number, c: number) => boolean} [params.isLastCell] 是否末尾单元格
 * @param {Function} [params.onExitBelow] 末尾单元格回车 → 光标出表
 * @param {DOMRect} [params.rect] 单元格矩形（调用方已按旧布局量好时传入）
 */
export function openCellEditor(params) {
  const el = ensureCellInput({
    onInsertRowBelow: params.onInsertRowBelow,
    onEscape: params.onEscape,
    onEscapeVertical: params.onEscapeVertical,
    isLastCell: params.isLastCell,
    onExitBelow: params.onExitBelow,
  });
  const rect = params.rect || params.td.getBoundingClientRect();
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
 * 即可让表格左右边缘与 `.qp-code-line` / `.qp-quote` 的外边缘对齐
 * （表格在预览里是 `width:100%` 的块级元素，与 pre / blockquote 同宽）。
 * 不能用 `width:100%`（spike S1 哨兵坑），也不能按
 * `scrollDOM.clientWidth - offsetLeft` 估算：`.cm-content.qp-doc` 带
 * `max-width:46em; margin:0 auto`，估算会把表格撑出正文列（右侧溢出）。
 *
 * 这里**只**减 `.cm-content` 自己的左右内边距，**不再**减 `.cm-line` 的
 * 左右内边距：行盒的 `0 14px 0 6px` 是行**内部**的呼吸区，行的外边缘（带背景
 * 与边框的那条边）本身就是内容列的左右边界。减掉它会让表格比代码块 / 引用块
 * 各窄 20px（用户可见的「表格缩进了一截」）。
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
  const width = rect.width - padH;
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
    /* 记下自己的块起始偏移：点击表格外侧的空白时，靠它把 DOM 反查回块区间。
       不要按「第几个 .qp-table-wrap」下标去对 `blocks` —— 解析失败的表格不会
       生成 widget，下标就会整体错位，点第二张表删掉的却是第一张。 */
    wrap.setAttribute('data-qp-from', String(model.from));
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
      cell.title = t('单击编辑单元格', 'Click to edit cell');
      cell.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button !== 0) return;
        this.activeCell = { r: domRow, c };
        rememberCell(this.model.from, domRow, c);
        /* 双击的第二下：浮层已经开在同一格，别重开 —— 重开等于先按「提交」
           再打开，会把没改动的文本再写一遍文档（多一条无意义的撤销记录）。 */
        if (e.detail >= 2 && isCellEditorOpen() && cellInput) {
          const sameCell =
            cellInput.dataset.from === String(this.model.from) &&
            Number(cellInput.dataset.r) === domRow &&
            Number(cellInput.dataset.c) === c;
          if (sameCell) {
            cellInput.focus();
            cellInput.select();
            return;
          }
        }
        // 几何先量：打开浮层的过程中可能 dispatch（widget 重建会换掉单元格节点，
        // 之后 getBoundingClientRect() 只能拿到 0×0）
        const rect = cell.getBoundingClientRect();
        this._openEditor(view, cell, domRow, c, rect);
      });
      tr.appendChild(cell);
    });
    return tr;
  }

  /**
   * 打开单元格浮层。
   * @param {import('@codemirror/view').EditorView} view
   * @param {HTMLTableCellElement} cell
   * @param {number} domRow
   * @param {number} col
   * @param {DOMRect} [rect] 打开前量好的单元格矩形
   */
  _openEditor(view, cell, domRow, col, rect) {
    const model = liveTableModel(view, this.model.from);
    if (!model) return;
    // DOM 行下标：0 = 表头，1..rows.length = 数据行
    const lastRow = model.rows.length;
    const lastCol = Math.max(0, model.headers.length - 1);
    openCellEditor({
      view,
      td: cell,
      rect,
      r: domRow,
      c: col,
      value: unescapeCell(domRow === 0 ? model.headers[col] : (model.rows[domRow - 1] || [])[col]),
      model,
      isLastCell: (r, c) => r === lastRow && c === lastCol,
      onExitBelow: () => this._exitBelow(view, model),
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
   * 末尾单元格回车 → 把光标送到表格之外的下一行。
   *
   * 表格块覆盖的行没有行盒，光标无法「落在表格内部」再按 → 出来，所以这里
   * 直接把选区放到表格末行之后：
   *  - 表格后面还有内容（常见是那条空行）→ 落到下一行行首；
   *  - 表格就在文末 → 先补一个换行，再落到这个新空行上（否则没有「下一行」）。
   *
   * 行数用模型算（表头 + 分隔行 + 数据行），不依赖 `this.model.to`：提交编辑
   * 时那次 dispatch 已经改过文本，旧的偏移可能短一截。
   *
   * @param {import('@codemirror/view').EditorView} view
   * @param {import('./table-model.js').TableModel} model
   */
  _exitBelow(view, model) {
    const doc = view.state.doc;
    const blockLines = model.rows.length + 2;
    const startNo = doc.lineAt(Math.min(model.from, doc.length)).number;
    const endNo = Math.min(doc.lines, startNo + blockLines - 1);
    const endLine = doc.line(endNo);
    if (endNo < doc.lines) {
      view.dispatch({ selection: { anchor: endLine.to + 1 } });
    } else {
      view.dispatch({
        changes: { from: endLine.to, insert: '\n' },
        selection: { anchor: endLine.to + 1 },
      });
    }
    view.focus();
  }

  /**
   * 应用一次单元格编辑：模型 → 序列化 → 一次 dispatch。
   * @param {import('@codemirror/view').EditorView} view
   * @param {import('./table-model.js').TableModel} model
   * @param {{r: number, c: number, value: string, dir: number}} change
   * @param {{focusNext: number}} options
   */
  _applyCell(view, model, change, options) {
    // 浮层可能比文档活得久（换文件 / 整体替换 / 撤销跨过表格边界，或浮层开着时
    // 点了工具栏按钮）：一律按当前文本重新定位这张表，旧区间一个字符都不要用。
    const live = liveTableModel(view, model ? model.from : -1);
    if (!live) {
      closeCellEditor();
      return;
    }
    const base = live;
    const next = applyCellEdit(base, change.r - 1, change.c, change.value);
    this._dispatchModel(view, next, base);
    rememberCell(base.from, change.r, change.c);
    const dir = options && options.focusNext ? options.focusNext : 0;
    if (dir) {
      /* Tab / Shift-Tab：换到相邻单元格（行末跳到下一行首格）。
         必须限定在**这一张表**的 widget 里：`view.dom` 下所有表格的单元格都混在
         一起，按全局下标挪动会在多表文档里跳到别张表的格子上。 */
      const scope =
        view.dom.querySelector(`.qp-table-wrap[data-qp-from="${base.from}"]`) || view.dom;
      const cells = Array.from(scope.querySelectorAll('.qp-table__cell')).map((el) => ({
        r: Number(el.getAttribute('data-r')),
        c: Number(el.getAttribute('data-c')),
        el,
      }));
      const idx = cells.findIndex((x) => x.r === change.r && x.c === change.c);
      const target = cells[idx + dir];
      if (target) {
        this.activeCell = { r: target.r, c: target.c };
        rememberCell(base.from, target.r, target.c);
        // 下一帧重新取节点：这一帧里可能又有 dispatch 把 widget 换掉了
        requestAnimationFrame(() => {
          const host =
            view.dom.querySelector(`.qp-table-wrap[data-qp-from="${base.from}"]`) || view.dom;
          const el = host.querySelector(
            `.qp-table__cell[data-r="${target.r}"][data-c="${target.c}"]`,
          );
          if (!el) return;
          this._openEditor(view, el, target.r, target.c, el.getBoundingClientRect());
        });
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
    const model = liveTableModel(view, this.model.from);
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
    /* 替换区间取 prev.to：调用方给的都是 `liveTableModel()` 按当前文本重算的结果，
       它与 `prev.rawLines.join('\n').length` 严格相等；用 `to` 更直观，也不会在
       `rawLines` 被截断（表下正文）时把区间算短、留下半行。 */
    const to = Math.max(from, Math.min(prev.to, docLen));
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
    bar.setAttribute('aria-label', t('表格操作', 'Table Actions'));
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
        /* 浮层还开着（点了单元格在输入、还没提交）就先提交一次：不提交的话，
           操作会先把表格改写一遍，而浮层仍挂着旧区间，稍后提交必然写错位置
           （实测会出现 `| 3 | 4 ||` 这种半行拼接）。提交走的是当前文本，
           所以这里两件事的顺序必须是「先提交、再操作」。 */
        if (isCellEditorOpen()) commitCellEditor(false);
        /* 用「记忆里的那一格」而不是实例字段：每次操作都会让 widget 重建、
           新实例的 `activeCell` 回到 {0,0}，直接用它会从第二次点击起一律改首列
           （用户报的「切换对齐」Bug）。 */
        const at = recallCell(this.model.from, this.model.rows.length, this.model.headers.length);
        this.activeCell = at;
        this._applyOp(view, spec.op, { row: Math.max(0, at.r - 1), col: at.c });
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
