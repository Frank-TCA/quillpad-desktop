/**
 * QuillPad · 视图模式纯函数
 *
 * 三种模式：`source`（纯源码）/ `wysiwyg`（就地渲染）/ `split`（左源码 + 右预览）。
 * 本模块**不含任何 DOM 访问**，便于在 node 里做单元测试（`scripts/v2-unit.mjs`）。
 */

/** @typedef {'source'|'wysiwyg'|'split'} ViewMode */
/** @typedef {'auto'|'source'|'wysiwyg'|'split'} ViewModePreference */

/** 三态循环顺序：`source → split → wysiwyg → source`（`nextViewMode` 用）。 */
export const VIEW_MODES = /** @type {ViewMode[]} */ (['source', 'split', 'wysiwyg']);

/** 分段控件的视觉顺序（源码 / 所见即所得 / 分屏）。 */
export const VIEW_MODE_UI_ORDER = /** @type {ViewMode[]} */ (['source', 'wysiwyg', 'split']);

/** 偏好枚举（多一个 auto）。 */
export const VIEW_MODE_PREFERENCES = /** @type {ViewModePreference[]} */ ([
  'auto',
  'source',
  'wysiwyg',
  'split',
]);

/**
 * 大文件降级阈值（A9）：超过则自动切 source。
 * 与 v1 的 `BIG_FILE_THRESHOLD`（2MB，仅关高亮）是两套指标，互不影响。
 */
export const DEGRADE_BYTES = 1024 * 1024;
export const DEGRADE_LINES = 20000;

/** 硬上限：超过则 WYSIWYG / split 入口整体置灰。 */
export const HARD_BYTES = 20 * 1024 * 1024;
export const HARD_LINES = 500000;

/**
 * 只有 markdown 支持 wysiwyg / split。
 * @param {string} language
 * @return {boolean}
 */
export function isMarkdownOnly(language) {
  return language === 'markdown';
}

/**
 * 某个模式在该语言下是否可用（`source` 恒可用）。
 * @param {ViewMode} mode
 * @param {string} language
 * @return {boolean}
 */
export function isModeSupported(mode, language) {
  if (mode === 'source') return true;
  return isMarkdownOnly(language);
}

/**
 * 三态循环：固定顺序 `source → split → wysiwyg → source`。
 *
 * 因此从默认的 `wysiwyg` 起连按 3 次 `Mod-E` 的序列是
 * `wysiwyg → source → split → wysiwyg`（与 T02 验收②一致）。
 *
 * @param {ViewMode|string} cur
 * @return {ViewMode}
 */
export function nextViewMode(cur) {
  const idx = VIEW_MODES.indexOf(/** @type {ViewMode} */ (cur));
  if (idx < 0) return 'source';
  return VIEW_MODES[(idx + 1) % VIEW_MODES.length];
}

/**
 * 是否已超过硬上限（> 20MB 或 > 500k 行）。
 * @param {{content?: string, lines?: number}} tab
 * @return {boolean}
 */
export function isHardLimited(tab) {
  if (!tab) return false;
  const bytes = tab.content ? tab.content.length : 0;
  const lines = typeof tab.lines === 'number' ? tab.lines : countLines(tab.content || '');
  return bytes > HARD_BYTES || lines > HARD_LINES;
}

/**
 * 是否应自动降级为 source（> 1MB 或 > 20k 行）。
 * @param {{content?: string, lines?: number}} tab
 * @return {boolean}
 */
export function shouldDegrade(tab) {
  if (!tab) return false;
  const content = tab.content || '';
  const bytes = content.length;
  const lines = typeof tab.lines === 'number' ? tab.lines : countLines(content);
  return bytes > DEGRADE_BYTES || lines > DEGRADE_LINES;
}

/**
 * 估行数（不建数组，避免大文件额外内存）。
 * @param {string} content
 * @return {number}
 */
export function countLines(content) {
  if (!content) return 1;
  let n = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

/**
 * 按「偏好 + 语言 + 大文件策略」推导有效模式。非 markdown 恒为 source。
 *
 * @param {{language: string, content?: string, lines?: number, forced?: boolean}} tab
 * @param {{preference?: ViewModePreference, locked?: boolean, forced?: boolean}} [ctx]
 * @return {ViewMode}
 */
export function effectiveViewMode(tab, ctx = {}) {
  if (!tab) return 'source';
  if (!isMarkdownOnly(tab.language)) return 'source';
  if (isHardLimited(tab)) return 'source';

  const forced = ctx.forced === true || tab.forced === true;
  if (shouldDegrade(tab) && !forced) return 'source';

  const preference = VIEW_MODE_PREFERENCES.includes(ctx.preference)
    ? ctx.preference
    : 'auto';
  const wanted = preference === 'auto' ? 'wysiwyg' : preference;
  return isModeSupported(wanted, tab.language) ? wanted : 'source';
}
