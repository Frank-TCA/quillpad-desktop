/**
 * QuillPad · 装饰规格工厂
 *
 * 全部使用 `Decoration.mark` / `Decoration.line` / `Decoration.widget`：
 * **绝不删除 DOM 文本**（ARCH §5.1 硬规则 1）。隐藏标记走 `.qp-md-hide`
 * （`font-size:0; opacity:0`），因此 `.cm-line` 的 `textContent` / `innerText`
 * 恒等于源码，v1 的 85+ 既有断言不受影响。
 */

import { Decoration } from '@codemirror/view';

/** 隐藏标记的类名（零宽，文本仍在 DOM 中）。 */
export const HIDE_CLASS = 'qp-md-hide';
/** 显示标记的类名（光标在本行时）。 */
export const MARK_CLASS = 'qp-md-mark';

/** 隐藏装饰（单例复用）。 */
const HIDDEN = Decoration.mark({ class: HIDE_CLASS });

/** @type {Map<string, Decoration>} 可见标记按 `data-qp-mark` 缓存 */
const VISIBLE_CACHE = new Map();

/**
 * 取「隐藏」标记装饰。
 * @return {Decoration}
 */
export function hiddenMark() {
  return HIDDEN;
}

/**
 * 取「可见」标记装饰（带 `data-qp-mark`，弱化色 + 无背景）。
 * @param {string} markKind `heading|bold|italic|strike|code|link|list|quote|task|footnote`
 * @return {Decoration}
 */
export function visibleMark(markKind) {
  let deco = VISIBLE_CACHE.get(markKind);
  if (!deco) {
    deco = Decoration.mark({
      class: MARK_CLASS,
      attributes: { 'data-qp-mark': markKind },
    });
    VISIBLE_CACHE.set(markKind, deco);
  }
  return deco;
}

/**
 * 按活跃态取标记装饰。
 * @param {string} markKind
 * @param {boolean} active
 * @return {Decoration}
 */
export function markerDecoration(markKind, active) {
  return active ? visibleMark(markKind) : hiddenMark();
}

/** @type {Map<string, Decoration>} 内容 span 缓存（key = kind + 额外属性） */
const NODE_CACHE = new Map();

/**
 * 内容装饰：挂 `data-qp-node` 与样式类，供 QA 断言与 CSS 取样式。
 *
 * @param {string} kind `data-qp-node` 取值（strong / em / del / code-inline / link …）
 * @param {Record<string, string>} [attrs] 额外属性（如 `data-qp-href`）
 * @return {Decoration}
 */
export function nodeDecoration(kind, attrs = {}) {
  const key = `${kind}|${JSON.stringify(attrs)}`;
  let deco = NODE_CACHE.get(key);
  if (!deco) {
    deco = Decoration.mark({
      class: `qp-node qp-node-${kind}`,
      attributes: { 'data-qp-node': kind, ...attrs },
    });
    NODE_CACHE.set(key, deco);
  }
  return deco;
}

/** @type {Map<string, Decoration>} 行装饰缓存 */
const LINE_CACHE = new Map();

/**
 * 行装饰：把结构属性写到 `.cm-line` 上。
 *
 * @param {Record<string, string>} attrs 例如 `{'data-qp-node': 'heading', 'data-qp-level': '2'}`
 * @param {string} [extraClass]
 * @return {Decoration}
 */
export function lineDecoration(attrs, extraClass = '') {
  const key = `${JSON.stringify(attrs)}|${extraClass}`;
  let deco = LINE_CACHE.get(key);
  if (!deco) {
    deco = Decoration.line({ class: extraClass, attributes: attrs });
    LINE_CACHE.set(key, deco);
  }
  return deco;
}

/**
 * 行内 widget 装饰（插入 DOM，不替换文本）。
 * @param {import('@codemirror/view').WidgetType} widget
 * @param {'before'|'after'} [side]
 * @return {Decoration}
 */
export function widgetDecoration(widget, side = 'before') {
  return Decoration.widget({
    widget,
    side: side === 'after' ? 1 : -1,
    block: false,
  });
}
