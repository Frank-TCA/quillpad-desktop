/**
 * 行号与行内容垂直对齐（WYSIWYG 专用）。
 *
 * 问题：CM 的行号槽（gutter）每个元素与对应行盒**等高**，但行号文字画在元素
 * 顶部；而 WYSIWYG 用 `padding-top` 模拟预览的外边距折叠 —— 标题 0~25px、引用块
 * 首行 14px、代码块首行 14px。于是行号浮在内容上方的留白里，标题旁的行号甚至
 * 看起来属于上一行。另外还有一部分偏差来自**行间距由行内元素的 margin 撑出**
 * （分隔线的 `.qp-hr` 自带 32px 上下外边距），它把行盒往下顶，行号槽却没有。
 *
 * 做法：逐行把行号元素「视觉上」搬到该行第一行文字的位置：
 *   - `padding-top` = 行盒的 padding-top；
 *   - `line-height` = 行盒的 line-height（14px 的数字在这一行里垂直居中，不贴顶）；
 *   - `transform: translateY(delta)`，delta = 行盒与行号元素的布局顶差
 *     （量 rect 时扣掉上一轮已生效的 transform，避免把自身位移当成新偏差）。
 *
 * 为什么用 transform 而不是 margin：margin 会参与布局，把后面所有行号一起推移，
 * 于是每加一个偏移就制造一批新的偏差（写第二轮时实测整列多移了 10px）；transform
 * 只影响绘制，元素在流里的位置和高度都不变，每行的 delta 可以独立测量、独立修正，
 * 不会互相污染，也不会触发布局抖动。
 *
 * 为什么不用纯 CSS：偏移量来自 `calc(var(--qp-*) - 12px)` 这类随上下文变化的
 * 表达式（标题前有没有空行、前面是不是 hr 都会变），且标题字号会改变行高，
 * CSS 无法把 gutter 元素和它在文档里的前驱状态对上 —— 只能按实际几何同步。
 *
 * 定位方式：`.cm-lineNumbers` 的第一个 `.cm-gutterElement` 是测量最大行号宽度的
 * 占位元素（文本形如 99…9、高度 0），所以元素数可能比行数多 1。用两者的**数量差**
 * 求偏移量，比按类名或文本猜更稳。
 */

import { ViewPlugin } from '@codemirror/view';

/**
 * 写过的元素 → 卸载时只清自己写过的内联样式。
 * 必须是可迭代的 Set：WeakSet 不能 for...of，destroy() 里遍历会抛 TypeError。
 * 元素由 CM 复用，插件生命周期内数量有界，destroy 时 clear 掉即可，不会泄漏。
 */
const touched = new Set();

/**
 * 读取当前渲染出的行与行号元素的对应关系与几何。
 *
 * `getBoundingClientRect()` 含已生效的 transform，而本插件正是用 transform 做位移；
 * 因此重测时先扣掉 `dataset.qpTf` 记录的上一轮位移，还原成「未位移」的布局顶，
 * 否则每轮都会把自己上一轮的位移当成新的偏差，来回震荡。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {Array<{el: HTMLElement, delta: number, padT: number, lh: number}>}
 */
function collect(view) {
  const gutter = view.dom.querySelector('.cm-lineNumbers');
  if (!gutter) return [];
  const els = Array.from(gutter.querySelectorAll('.cm-gutterElement'));
  const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'));
  if (!els.length || !lines.length) return [];

  // 占位元素（测宽用）在序列最前面，数量差即偏移
  const offset = els.length - lines.length;
  /** @type {Array<{el: HTMLElement, delta: number, padT: number, lh: number}>} */
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const el = els[i + offset];
    if (!el || el.classList.contains('qp-gutter-hidden')) continue;
    const cs = getComputedStyle(lines[i]);
    // 注意不能按 font-size:0 跳过：`---` 那一行字号被归零（分隔线用 widget 画），
    // 但它的行号是可见的，一样要对齐；``` 围栏行才是真的要跳过（已被类标记藏掉）。
    const applied = parseFloat(el.dataset.qpTf || '0') || 0;
    const elTop = el.getBoundingClientRect().top - applied;
    const lineRect = lines[i].getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight) || 0;
    out.push({
      el,
      delta: Math.round(lineRect.top - elTop),
      padT: parseFloat(cs.paddingTop) || 0,
      // `---` 这类 font-size:0 的行没有行高，退回用行盒高度把数字居中
      lh: lh || Math.round(lineRect.height),
    });
  }
  return out;
}

/**
 * 把几何写到行号元素上。
 *
 * @param {Array<{el: HTMLElement, delta: number, padT: number, lh: number}>} rows
 */
function apply(rows) {
  let dirty = false;
  for (const { el, delta, padT, lh } of rows) {
    // 元素高度是 CM 内联写死的（等于行盒高度），加了 padding-top 必须改成
    // border-box，否则内容被撑出槽外
    if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
    const pad = `${padT}px`;
    if (el.style.paddingTop !== pad) el.style.paddingTop = pad;
    // line-height 与行盒一致 → 数字在这一行里垂直居中，而不是贴顶
    const lhv = lh ? `${lh}px` : '';
    if (el.style.lineHeight !== lhv) el.style.lineHeight = lhv;
    const tf = delta ? `translateY(${delta}px)` : '';
    if (el.style.transform !== tf) el.style.transform = tf;
    // 只有「本轮算出的 delta 与上一轮不同」才需要再测一轮。若只是稳定地保持
    // 某个非零位移，说明已经收敛，继续重测纯属浪费（还容易触发 measure 抖动）。
    if (el.dataset.qpTf !== String(delta)) dirty = true;
    el.dataset.qpTf = String(delta);
    touched.add(el);
  }
  return dirty;
}

/** 卸载时清掉本插件写过的内联样式（回到 CM 默认的贴顶布局）。 */
function reset() {
  for (const el of touched) {
    // CM 可能已经把元素移出 DOM，但内联样式仍挂在对象上，照清不误
    el.style.paddingTop = '';
    el.style.lineHeight = '';
    el.style.transform = '';
    el.style.boxSizing = '';
    delete el.dataset.qpTf;
  }
  touched.clear();
}

/** WYSIWYG 行号对齐扩展。 */
export const gutterAlignPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.pending = false;
      this.passes = 0;
      this.schedule(view);
    }

    update(u) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.geometryChanged ||
        u.focusChanged ||
        u.selectionSet
      ) {
        this.passes = 0;
        this.schedule(u.view);
      }
    }

    /**
     * 几何同步走 CM 的 measure 周期：read 阶段量、write 阶段写，避免读写交错
     * 反复触发重排。
     *
     * 为什么可能要连跑几轮：首次量到的几何可能是「装饰刚挂上、行高还没定型」的
     * 中间态（实测标题、引用、代码块的顶差第一轮会偏 5~50px），写完再量一次就
     * 能收敛。transform 不影响布局，所以多量几轮不会抖动，收敛即停（最多 3 轮）。
     *
     * @param {import('@codemirror/view').EditorView} view
     */
    schedule(view) {
      if (this.pending) return;
      this.pending = true;
      view.requestMeasure({
        key: this,
        read: () => collect(view),
        write: (rows) => {
          this.pending = false;
          if (!rows || !rows.length) return;
          const dirty = apply(rows);
          if (dirty && this.passes < 3) {
            this.passes += 1;
            this.schedule(view);
          }
        },
      });
    }

    destroy() {
      reset();
    }
  },
);
