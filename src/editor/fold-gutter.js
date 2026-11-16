/**
 * QuillPad · 折叠槽（gutter）—— 在 CM 原生实现上换掉「可折叠判定」。
 *
 * 为什么要抄一遍 `@codemirror/language` 的 `foldGutter()`：
 * `foldGutter(config)` 只接受 `openText / closedText / markerDOM / domEventHandlers /
 * foldingChanged`，**没有** `foldable` 选项 —— 传进去会被静默忽略（v1.0.1 踩过：
 * 以为传了就能过滤，结果箭头一个没少）。而我们要的正是「换判定函数」：
 *
 *   源码 / 分栏：完全等于原生行为（含内嵌语言的括号折叠，写代码时有用）；
 *   所见即所得：只保留 Markdown 结构性折叠（标题整节、围栏、引用、表格、列表），
 *               代码块**内部**不给箭头 —— 内嵌的 TS / Python 解析器会为
 *               `interface Document {` 这类行产出括号折叠，折起来只会把代码块
 *               中间的行藏掉、代码块样式随之断开，还挤在行号槽里误点。
 *
 * 除判定函数外，其余（标记 DOM、初值 spacer、点击折叠 / 展开、`codeFolding()`
 * 渲染折叠占位与原子性）与上游逐行一致，升级 CM 时对照 `foldGutter` 同步即可。
 */

import { GutterMarker, gutter } from '@codemirror/view';
import { RangeSet, RangeSetBuilder } from '@codemirror/state';
import {
  codeFolding,
  foldEffect,
  foldState,
  foldable as defaultFoldable,
  language,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language';
import { ViewPlugin } from '@codemirror/view';
import { wysiwygMode } from './wysiwyg/index.js';

/** 折叠槽文案（与 CM 默认一致）。 */
const OPEN_TEXT = '⌄';
const CLOSED_TEXT = '›';

/**
 * 本行落在**围栏代码块内部**（不含围栏那一行本身）。
 *
 * 围栏内容交给内嵌语言解析器，它们自带括号折叠；所见即所得下这种折叠没有意义
 * （见文件头注释）。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} from 行首位置
 * @return {boolean}
 */
function insideCodeBlock(state, from) {
  const tree = syntaxTree(state);
  for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return node.from < from;
    if (node.name === 'Document') return false;
  }
  return false;
}

/**
 * 可折叠判定：原生结果 + 所见即所得的额外限制。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} lineStart
 * @param {number} lineEnd
 * @return {{from: number, to: number}|null}
 */
function quillpadFoldable(state, lineStart, lineEnd) {
  const range = defaultFoldable(state, lineStart, lineEnd);
  if (!range) return null;
  if (!state.facet(wysiwygMode)) return range;
  return insideCodeBlock(state, lineStart) ? null : range;
}

/**
 * 该行上是否已有折叠范围（与 CM 内部的 `findFold` 等价）。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} from
 * @param {number} to
 * @return {{from: number, to: number}|null}
 */
function findFold(state, from, to) {
  let found = null;
  const set = state.field(foldState, false);
  if (set) {
    set.between(from, to, (f, t) => {
      if (!found || found.from > f) found = { from: f, to: t };
    });
  }
  return found;
}

/** 折叠标记（展开 / 收起两态，DOM 与 CM 默认一致）。 */
class FoldMarker extends GutterMarker {
  /**
   * @param {boolean} open
   */
  constructor(open) {
    super();
    this.open = open;
  }

  eq(other) {
    return this.open === other.open;
  }

  toDOM() {
    const span = document.createElement('span');
    span.textContent = this.open ? OPEN_TEXT : CLOSED_TEXT;
    return span;
  }
}

const markerOpen = new FoldMarker(true);
const markerClosed = new FoldMarker(false);

/**
 * 折叠槽扩展。
 *
 * @return {import('@codemirror/state').Extension}
 */
export function quillpadFoldGutter() {
  const markers = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.markers = this.buildMarkers(view);
      }

      update(update) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.startState.facet(language) !== update.state.facet(language) ||
          update.startState.field(foldState, false) !== update.state.field(foldState, false) ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          // 切视图模式会 reconfigure（wysiwygMode 变化），判定结果随之改变
          update.startState.facet(wysiwygMode) !== update.state.facet(wysiwygMode)
        ) {
          this.markers = this.buildMarkers(update.view);
        }
      }

      buildMarkers(view) {
        const builder = new RangeSetBuilder();
        for (const line of view.viewportLineBlocks) {
          const mark = findFold(view.state, line.from, line.to)
            ? markerClosed
            : quillpadFoldable(view.state, line.from, line.to)
              ? markerOpen
              : null;
          if (mark) builder.add(line.from, line.from, mark);
        }
        return builder.finish();
      }
    },
  );

  return [
    markers,
    gutter({
      class: 'cm-foldGutter',
      markers(view) {
        const plugin = view.plugin(markers);
        return (plugin && plugin.markers) || RangeSet.empty;
      },
      initialSpacer() {
        return markerClosed;
      },
      domEventHandlers: {
        click: (view, line) => {
          const folded = findFold(view.state, line.from, line.to);
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) });
            return true;
          }
          const range = quillpadFoldable(view.state, line.from, line.to);
          if (range) {
            view.dispatch({ effects: foldEffect.of(range) });
            return true;
          }
          return false;
        },
      },
    }),
    codeFolding(),
  ];
}
