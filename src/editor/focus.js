/**
 * QuillPad · 专注模式 / 打字机模式（T09）
 *
 * 两者都是「纯视图层」辅助，不修改文档：
 *  - 专注模式：当前「段落」之外的行加 `.qp-focus-dim`（降低不透明度）；
 *    段落 = 以空行为分隔的连续非空行块（与 Markdown 的段落语义一致）。
 *  - 打字机模式：光标移动后保持光标行位于滚动视口垂直中央。
 *
 * 性能约束（T08）：两者都只遍历 `view.visibleRanges`，且装饰数有上限，
 * 因此 1MB 文档也不会出现整篇装饰。
 */

import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';

/** 单次最多产出的行装饰数（护栏，防超大视口 / 极端折行）。 */
export const FOCUS_DIM_LIMIT = 4000;

/** 段落判定的空行正则。 */
const RE_BLANK = /^\s*$/;

/** 专注模式行装饰（单例复用）。 */
const DIM = Decoration.line({ class: 'qp-focus-dim' });

/**
 * 取光标所在段落（连续非空行）的行号区间。
 *
 * @param {import('@codemirror/state').EditorState} state
 * @return {Array<{a: number, b: number}>} 每个选区一个区间（1 基，闭区间）
 */
export function paragraphRanges(state) {
  const doc = state.doc;
  /** @type {Array<{a: number, b: number}>} */
  const out = [];
  for (const range of state.selection.ranges) {
    let a = doc.lineAt(range.from).number;
    let b = doc.lineAt(range.to).number;
    while (a > 1 && !RE_BLANK.test(doc.line(a - 1).text)) a -= 1;
    while (b < doc.lines && !RE_BLANK.test(doc.line(b + 1).text)) b += 1;
    out.push({ a, b });
  }
  return out;
}

/**
 * 为「非当前段落」的可见行生成 `.qp-focus-dim` 装饰。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {DecorationSet}
 */
export function computeFocusDim(view) {
  const state = view.state;
  const ranges = paragraphRanges(state);
  const inside = (n) => ranges.some((r) => n >= r.a && n <= r.b);
  /** @type {import('@codemirror/view').Range<Decoration>[]} */
  const decos = [];
  const seen = new Set();
  for (const visible of view.visibleRanges) {
    const first = state.doc.lineAt(visible.from).number;
    const last = state.doc.lineAt(visible.to).number;
    for (let n = first; n <= last; n += 1) {
      if (decos.length >= FOCUS_DIM_LIMIT) break;
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (RE_BLANK.test(line.text)) continue;
      if (inside(n)) continue;
      decos.push(DIM.range(line.from));
    }
  }
  return Decoration.set(decos, true);
}

/**
 * 专注模式扩展。
 *
 * @param {{enabled?: () => boolean}} [opts]
 * @return {import('@codemirror/state').Extension}
 */
export function createFocusExtension(opts = {}) {
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = enabled() ? computeFocusDim(view) : Decoration.none;
      }

      update(u) {
        if (!enabled()) {
          if (this.decorations !== Decoration.none) this.decorations = Decoration.none;
          return;
        }
        if (u.docChanged || u.selectionSet || u.viewportChanged) {
          this.decorations = computeFocusDim(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * 打字机模式：把光标行滚到视口中央。
 *
 * @param {import('@codemirror/view').EditorView} view
 */
function centerCursor(view) {
  const head = view.state.selection.main.head;
  const effects = EditorView.scrollIntoView(head, { y: 'center', yMargin: 0 });
  view.dispatch({ effects, scrollIntoView: false });
}

/**
 * 打字机模式扩展。
 *
 * @param {{enabled?: () => boolean}} [opts]
 * @return {import('@codemirror/state').Extension}
 */
export function createTypewriterExtension(opts = {}) {
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => true;
  return ViewPlugin.fromClass(
    class {
      /** @param {import('@codemirror/view').EditorView} view */
      constructor(view) {
        this.view = view;
        this.pending = 0;
        this.scheduled = false;
      }

      update(u) {
        if (!enabled()) return;
        if (!u.selectionSet && !u.docChanged) return;
        // 不能在 update 内 dispatch，推迟到下一帧
        if (this.scheduled) return;
        this.scheduled = true;
        this.pending = requestAnimationFrame(() => {
          this.scheduled = false;
          if (!enabled()) return;
          if (this.view.viewState) centerCursor(this.view);
        });
      }

      destroy() {
        if (this.pending) cancelAnimationFrame(this.pending);
      }
    },
  );
}

/**
 * 同时装载专注 + 打字机（关闭时返回 `[]`，便于 Compartment 整体替换）。
 *
 * @param {{focus?: () => boolean, typewriter?: () => boolean}} opts
 * @return {import('@codemirror/state').Extension}
 */
export function createAidsExtension(opts = {}) {
  const focusOn = typeof opts.focus === 'function' ? opts.focus : () => false;
  const twOn = typeof opts.typewriter === 'function' ? opts.typewriter : () => false;
  return [createFocusExtension({ enabled: focusOn }), createTypewriterExtension({ enabled: twOn })];
}
