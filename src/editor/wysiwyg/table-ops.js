/**
 * QuillPad · 表格行列操作（纯函数）
 *
 * 7 个操作与 `src/core/actions.js` 里注册的 `markdown.table.*` 命令一一对应。
 * 全部返回**新的** TableModel，绝不修改入参 —— 这样「撤销一次」只需回退文档，
 * 由纯函数重算出的列宽数组必然与撤销前逐项相同（T06 验收④）。
 */

import { cloneModel, computeWidths } from './table-model.js';

/**
 * @typedef {'rowAbove'|'rowBelow'|'rowDelete'|'colLeft'|'colRight'|'colDelete'|'alignCycle'} TableOp
 */

/** 全部操作（供命令层与测试共用）。 */
export const TABLE_OPS = /** @type {TableOp[]} */ ([
  'rowAbove',
  'rowBelow',
  'rowDelete',
  'colLeft',
  'colRight',
  'colDelete',
  'alignCycle',
]);

/** 对齐循环顺序：无 → 左 → 中 → 右 → 无。 */
const ALIGN_CYCLE = [null, 'left', 'center', 'right'];

/**
 * 新建一个空行。
 * @param {number} colCount
 * @return {string[]}
 */
function emptyRow(colCount) {
  return new Array(colCount).fill('');
}

/**
 * 应用一个表格操作。
 *
 * @param {import('./table-model.js').TableModel} model
 * @param {TableOp} op
 * @param {{row?: number, col?: number}} [at]  `row` 为数据行下标（0 基，不含表头）
 * @return {import('./table-model.js').TableModel}
 */
export function applyTableOp(model, op, at = {}) {
  const next = cloneModel(model);
  const colCount = next.headers.length;
  const rowCount = next.rows.length;
  const row = clampIndex(at.row, rowCount);
  const col = clampIndex(at.col, colCount);

  switch (op) {
    case 'rowAbove': {
      const at0 = rowCount === 0 ? 0 : row;
      next.rows.splice(at0, 0, emptyRow(colCount));
      break;
    }
    case 'rowBelow': {
      next.rows.splice(Math.min(rowCount, (rowCount === 0 ? -1 : row) + 1), 0, emptyRow(colCount));
      break;
    }
    case 'rowDelete': {
      if (rowCount > 1) next.rows.splice(row, 1);
      break;
    }
    case 'colLeft': {
      next.headers.splice(col, 0, '');
      next.aligns.splice(col, 0, null);
      next.dashes.splice(col, 0, 3);
      next.rows.forEach((r) => r.splice(col, 0, ''));
      break;
    }
    case 'colRight': {
      const at0 = Math.min(colCount, col + 1);
      next.headers.splice(at0, 0, '');
      next.aligns.splice(at0, 0, null);
      next.dashes.splice(at0, 0, 3);
      next.rows.forEach((r) => r.splice(at0, 0, ''));
      break;
    }
    case 'colDelete': {
      if (colCount > 1) {
        next.headers.splice(col, 1);
        next.aligns.splice(col, 1);
        next.dashes.splice(col, 1);
        next.rows.forEach((r) => r.splice(col, 1));
      }
      break;
    }
    case 'alignCycle': {
      const cur = next.aligns[col] ?? null;
      const idx = ALIGN_CYCLE.indexOf(cur);
      next.aligns[col] = ALIGN_CYCLE[(idx + 1) % ALIGN_CYCLE.length];
      break;
    }
    default:
      break;
  }

  // 行数 / 列数变化后列宽必然重算；纯函数保证确定性
  next.widths = computeWidths(next);
  return next;
}

/**
 * 下标夹紧。
 * @param {number|undefined} value
 * @param {number} length
 * @return {number}
 */
function clampIndex(value, length) {
  const n = Number.isFinite(value) ? Number(value) : 0;
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(n)));
}

/**
 * 对齐取值列表（供命令与 UI 共用）。
 * @return {Array<string|null>}
 */
export function alignCycleValues() {
  return ALIGN_CYCLE.slice();
}
