/**
 * QuillPad · 5 色文本标记（highlight marks）
 *
 * CM6 StateField + RangeSet 存 `{from, to, color}` 区间，随 doc changes
 * 自动映射（RangeSet.map）。装饰由 EditorView.decorations 派生。
 *
 * 应用语义：对选区每个 range 先移除相交旧区间（切边保留）再插入新区间。
 */

import { StateField, StateEffect, RangeSet, RangeValue } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/** 可用标记颜色。 */
const MARK_COLORS = ['red', 'yellow', 'green', 'blue', 'purple'];

/** StateEffect：在 [from,to] 上添加指定颜色的标记。 */
const addMarkEffect = StateEffect.define();

/** StateEffect：清除文档内全部标记。 */
const clearAllEffect = StateEffect.define();

/** StateEffect：清除选区范围内的标记（切边保留）。 */
const clearInSelectionEffect = StateEffect.define();

/**
 * RangeValue 子类——携带颜色信息。
 */
class MarkValue extends RangeValue {
  /**
   * @param {string} color
   */
  constructor(color) {
    super();
    this.color = color;
  }

  /**
   * @param {RangeValue} other
   * @return {boolean}
   */
  eq(other) {
    return this.color === other.color;
  }
}

/**
 * 把 RangeSet&lt;MarkValue&gt; 转为 DecorationSet。
 * @param {RangeSet<MarkValue>} set
 * @return {DecorationSet}
 */
function marksToDecorations(set) {
  /** @type {import('@codemirror/view').Decoration[]} */
  const decos = [];
  const iter = set.iter();
  while (iter.value) {
    // 防御：区间经 tr.changes 映射后退化为零长度（from === to）时，
    // Decoration.mark().range() 会抛 "Mark decorations may not be empty"，跳过即可。
    if (iter.to > iter.from) {
      decos.push(
        Decoration.mark({ class: `qp-tmark qp-tmark--${iter.value.color}` }).range(
          iter.from,
          iter.to,
        ),
      );
    }
    iter.next();
  }
  return Decoration.set(decos, true);
}

/**
 * 对 RangeSet 施加一个标记：先切掉相交旧区间（保留不相交边缘），再插入新区间。
 * @param {RangeSet<MarkValue>} set
 * @param {number} from
 * @param {number} to
 * @param {string} color
 * @return {RangeSet<MarkValue>}
 */
function applyMarkToSet(set, from, to, color) {
  if (to <= from) return set;
  /** @type {import('@codemirror/state').Range<MarkValue>[]} */
  const pieces = [];
  const iter = set.iter();
  while (iter.value) {
    const mFrom = iter.from;
    const mTo = iter.to;
    const mColor = iter.value.color;
    if (mTo <= from || mFrom >= to) {
      // 无相交，原样保留
      pieces.push(new MarkValue(mColor).range(mFrom, mTo));
    } else {
      // 相交——切边保留
      if (mFrom < from) pieces.push(new MarkValue(mColor).range(mFrom, from));
      if (mTo > to) pieces.push(new MarkValue(mColor).range(to, mTo));
    }
    iter.next();
  }
  pieces.push(new MarkValue(color).range(from, to));
  pieces.sort((a, b) => a.from - b.from);
  return RangeSet.of(pieces, true);
}

/**
 * 清除若干区间内的标记（切边保留两侧残余）。
 * @param {RangeSet<MarkValue>} set
 * @param {{from: number, to: number}[]} ranges
 * @return {RangeSet<MarkValue>}
 */
function clearMarksInRanges(set, ranges) {
  /** @type {import('@codemirror/state').Range<MarkValue>[]} */
  const pieces = [];
  const iter = set.iter();
  while (iter.value) {
    const mFrom = iter.from;
    const mTo = iter.to;
    const mColor = iter.value.color;
    // 找出与当前标记相交的清除区间
    const overlapping = ranges
      .filter((r) => r.from < mTo && r.to > mFrom)
      .sort((a, b) => a.from - b.from);
    if (overlapping.length === 0) {
      pieces.push(new MarkValue(mColor).range(mFrom, mTo));
    } else {
      let cursor = mFrom;
      for (const r of overlapping) {
        const rFrom = Math.max(r.from, mFrom);
        const rTo = Math.min(r.to, mTo);
        if (rFrom > cursor) {
          pieces.push(new MarkValue(mColor).range(cursor, rFrom));
        }
        cursor = Math.max(cursor, rTo);
      }
      if (cursor < mTo) {
        pieces.push(new MarkValue(mColor).range(cursor, mTo));
      }
    }
    iter.next();
  }
  pieces.sort((a, b) => a.from - b.from);
  return RangeSet.of(pieces, true);
}

/** StateField：持有全部文本标记区间。 */
const marksField = StateField.define({
  create() {
    return RangeSet.empty;
  },
  update(set, tr) {
    // 文档变化时映射坐标
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addMarkEffect)) {
        const { from, to, color } = e.value;
        set = applyMarkToSet(set, from, to, color);
      } else if (e.is(clearAllEffect)) {
        set = RangeSet.empty;
      } else if (e.is(clearInSelectionEffect)) {
        set = clearMarksInRanges(set, e.value.ranges);
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f, marksToDecorations),
});

/**
 * 返回文本标记扩展（挂入 _baseExtensions）。
 * @return {import('@codemirror/state').Extension}
 */
export function textMarks() {
  return marksField;
}

/**
 * 对当前选区每个 range 施加指定颜色的标记。
 * 无选区（光标）时不做事。
 * @param {object} app
 * @param {string} color
 */
export function applyMark(app, color) {
  if (!MARK_COLORS.includes(color)) return;
  const view = app.editor.view;
  const { state } = view;
  const effects = [];
  for (const range of state.selection.ranges) {
    if (range.from === range.to) continue;
    effects.push(addMarkEffect.of({ from: range.from, to: range.to, color }));
  }
  if (effects.length) view.dispatch({ effects });
}

/**
 * 对**指定的**区间施加标记。
 *
 * 右键菜单必须在弹出时先捕获选区快照：CM6 的 DOMObserver 会在 contextmenu
 * 事件派发前把选区折叠到鼠标位置，若等到菜单项 run 时再读
 * `state.selection`，拿到的已是折叠后的空选区（标记颜色会静默失效）。
 *
 * @param {object} app
 * @param {{from: number, to: number}[]} ranges 选区快照
 * @param {string} color
 * @return {boolean} 是否实际应用了标记
 */
export function applyMarkToRanges(app, ranges, color) {
  if (!MARK_COLORS.includes(color)) return false;
  const view = app.editor.view;
  const effects = [];
  for (const r of ranges || []) {
    if (r.to > r.from) effects.push(addMarkEffect.of({ from: r.from, to: r.to, color }));
  }
  if (!effects.length) return false;
  view.dispatch({ effects });
  return true;
}

/**
 * 清除文档内全部标记。
 * @param {object} app
 */
export function clearMarks(app) {
  const view = app.editor.view;
  view.dispatch({ effects: clearAllEffect.of(null) });
}

/**
 * 清除选区范围内的标记（切边保留）；无选区时退化为清除全部。
 * @param {object} app
 */
export function clearMarksInSelection(app) {
  const view = app.editor.view;
  const { state } = view;
  const ranges = state.selection.ranges
    .filter((r) => r.from !== r.to)
    .map((r) => ({ from: r.from, to: r.to }));
  if (!ranges.length) {
    view.dispatch({ effects: clearAllEffect.of(null) });
    return;
  }
  view.dispatch({ effects: clearInSelectionEffect.of({ ranges }) });
}

/**
 * 清除**指定区间**内的标记（切边保留）；无有效区间时退化为清除全部。
 * 与 applyMarkToRanges 同理，服务于右键菜单的选区快照。
 * @param {object} app
 * @param {{from: number, to: number}[]} ranges 选区快照
 */
export function clearMarkRanges(app, ranges) {
  const view = app.editor.view;
  const valid = (ranges || [])
    .filter((r) => r.to > r.from)
    .map((r) => ({ from: r.from, to: r.to }));
  if (!valid.length) {
    view.dispatch({ effects: clearAllEffect.of(null) });
    return;
  }
  view.dispatch({ effects: clearInSelectionEffect.of({ ranges: valid }) });
}
