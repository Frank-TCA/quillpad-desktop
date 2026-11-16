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
 * 折叠槽（`.cm-foldGutter`）的箭头元素必须做**完全相同**的位移：行号被 transform
 * 搬走而箭头留在原地，两者反而互相错开（标题旁的箭头相对行号偏上 10~30px 就是
 * 这么来的）。两列共用同一套 delta/padT/lh 几何即可，箭头与数字落在同一个
 * line-height 带里，相对排布与源码模式一致。
 *
 * 配对方式（关键，两次踩坑后定的）：
 * 1. 行号槽 ↔ 行：按**行号文本**配对。`lineNumbers()` 的元素文本就是文档行号，
 *    用 `posAtDOM` 取每个 `.cm-line` 的文档行号做键。元素数与行数不齐（块级
 *    widget 行、深滚动的瞬态测量行）都不会再串位；测宽 spacer 的文本可能是纯
 *    数字（如 99），不能靠文本识别，用 CM 写在 spacer 上的内联
 *    `visibility: hidden` 跳过。
 * 2. 折叠槽 ↔ 行号槽：按（未变换布局顶, 槽高）双键反查同行行号槽的几何。折叠槽
 *    元素稀疏（只有可折叠行、带标记行、光标活跃行才有元素），不能按索引；两列
 *    同一行的槽位由 CM 写死的 height/marginTop 栈出同一套 block.top，布局顶与
 *    槽高都相等。**槽高是消歧键**：WYSIWYG 有 0 高度空行（连续空行
 *    `line-height: 0`），与下一行槽顶重合，只比顶会把空行的 padT/lh 套到下一行
 *    的箭头上（实测错 17~23px，即「高槽位错、矮槽位对」的来源）。
 *
 * 元素复用与布局防漂移（第三个坑）：CM 会**跨视口更新复用** gutter 的 DOM 元素
 * （滚动后同一节点换一行服务），本插件写在上面的 transform/padding/line-height
 * 与 `qpTf` 会变成「上一行的陈旧样式」。陈旧的 padding-top 落到更矮的新槽位上
 * 时（如 4px 围栏行），border-box 会把盒子撑高（height 4 + padding 19 → 盒高
 * 19），把**本列**下面所有槽位推下去，两列栈就此错开几像素，反查配对进一步
 * 失败、陈旧样式清不掉 —— 自我强化。因此：
 *   - `qpH`：apply 时记下 CM 写死的槽高，下一轮发现槽高变了（元素被复用给另
 *     一行）就先清掉该元素的全部插件样式再重配；
 *   - 配不上的元素（文本对不上行号、双键反查落空）若带旧样式也一律清掉，
 *     不让任何陈旧位移留在列里；
 *   - padding-top 一律钳制在槽高以内（正确配对时行盒高度必含其 padding，钳制
 *     只在错配的脏数据上生效），保证 padding 永远不改变盒子高度、不推动布局。
 *
 * 为什么用 transform 而不是 margin：margin 会参与布局，把后面所有行号一起推移，
 * 于是每加一个偏移就制造一批新的偏差（写第二轮时实测整列多移了 10px）；transform
 * 只影响绘制，元素在流里的位置和高度都不变，每行的 delta 可以独立测量、独立修正，
 * 不会互相污染，也不会触发布局抖动。
 *
 * 为什么不用纯 CSS：偏移量来自 `calc(var(--qp-*) - 12px)` 这类随上下文变化的
 * 表达式（标题前有没有空行、前面是不是 hr 都会变），且标题字号会改变行高，
 * CSS 无法把 gutter 元素和它在文档里的前驱状态对上 —— 只能按实际几何同步。
 */

import { ViewPlugin } from '@codemirror/view';

/**
 * 写过的元素 → 卸载时只清自己写过的内联样式。
 * 必须是可迭代的 Set：WeakSet 不能 for...of，destroy() 里遍历会抛 TypeError。
 * 元素由 CM 复用，插件生命周期内数量有界，destroy 时 clear 掉即可，不会泄漏。
 */
const touched = new Set();

/** 清掉单个元素上本插件写过的全部内联样式与 dataset（元素被复用/配不上时用）。 */
function clearEl(el) {
  el.style.paddingTop = '';
  el.style.lineHeight = '';
  el.style.transform = '';
  el.style.boxSizing = '';
  delete el.dataset.qpTf;
  delete el.dataset.qpH;
  touched.delete(el);
}

/**
 * 读取当前渲染出的行与两列 gutter 槽位的对应关系与几何。
 *
 * `getBoundingClientRect()` 含已生效的 transform，而本插件正是用 transform 做位移；
 * 因此重测时先扣掉 `dataset.qpTf` 记录的上一轮位移，还原成「未位移」的布局顶，
 * 否则每轮都会把自己上一轮的位移当成新的偏差，来回震荡。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {{rows: Array<{el: HTMLElement, delta: number, padT: number, lh: number, h: number}>,
 *           stale: Array<HTMLElement>}}
 */
function collect(view) {
  const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'));
  const numGutter = view.dom.querySelector('.cm-lineNumbers');
  if (!numGutter || !lines.length) return { rows: [], stale: [] };

  /**
   * 文档行号 → 行几何（行盒顶、padding-top、line-height）。
   * 行号取自文档本身（posAtDOM），与 DOM 元素个数无关，天然对不齐也串不了位。
   * @type {Map<number, {top: number, padT: number, lh: number}>}
   */
  const lineByNo = new Map();
  for (const el of lines) {
    let no = 0;
    try {
      no = view.state.doc.lineAt(view.posAtDOM(el, 0)).number;
    } catch (err) {
      no = 0;
    }
    if (!no || lineByNo.has(no)) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight) || 0;
    lineByNo.set(no, {
      top: rect.top,
      padT: parseFloat(cs.paddingTop) || 0,
      // `---` 这类 font-size:0 的行没有行高，退回用行盒高度把数字居中
      lh: lh || Math.round(rect.height),
    });
  }

  /** @type {Array<{el: HTMLElement, delta: number, padT: number, lh: number, h: number}>} */
  const rows = [];
  /** 跨视口复用后带着上一行陈旧样式的元素 → 写阶段清掉。 */
  const stale = [];
  /**
   * 行号槽的槽位几何（未变换布局顶 + 槽高），供折叠槽按（顶, 高）双键反查。
   * @type {Array<{top: number, height: number, geom: {delta: number, padT: number, lh: number}}>}
   */
  const slots = [];

  /** CM 写死的槽高（border-box 高度）。 */
  const slotHeight = (el, rect) => parseFloat(el.style.height) || rect.height;

  /**
   * 元素是否带着「另一行」的陈旧样式：CM 跨视口更新复用 gutter 元素，
   * 上一轮的 transform/padding 留在节点上，槽高一变即身份已换。
   * @param {HTMLElement} el
   * @return {boolean}
   */
  const isReused = (el) => {
    if (el.dataset.qpTf === undefined) return false;
    const cur = parseFloat(el.style.height);
    const old = parseFloat(el.dataset.qpH || '');
    return !Number.isNaN(cur) && !Number.isNaN(old) && Math.abs(cur - old) > 0.5;
  };

  for (const el of Array.from(numGutter.querySelectorAll('.cm-gutterElement'))) {
    // 测宽 spacer：CM SingleGutterView 在其上写了内联 visibility:hidden，
    // 文本可能是纯数字（如 99），必须先按内联样式跳过，不能数个数、也不能看文本
    if (el.style.visibility === 'hidden') continue;
    if (isReused(el)) {
      stale.push(el);
      continue;
    }
    const text = el.textContent.trim();
    // 行号文本即文档行号；非纯数字（spacer 形如 99…9）自然落空
    const li = /^\d+$/.test(text) ? lineByNo.get(parseInt(text, 10)) : null;
    if (!li) {
      // 配不上还带着旧样式（例如 widget 块行号被复用）→ 清掉，不让旧位移滞留
      if (el.dataset.qpTf !== undefined) stale.push(el);
      continue;
    }
    const applied = parseFloat(el.dataset.qpTf || '0') || 0;
    const rect = el.getBoundingClientRect();
    // 扣掉上一轮 transform，还原未变换布局顶
    const top = rect.top - applied;
    const geom = {
      delta: Math.round(li.top - top),
      padT: li.padT,
      lh: li.lh,
    };
    slots.push({ top, height: rect.height, geom });
    // 隐藏行号（qp-gutter-hidden 的空行/围栏行）也吃同一套几何：元素被 CSS
    // visibility:hidden 藏掉，位移无视觉影响；两列一致才能保证折叠箭头的反查
    // 与外部量测配对不分叉。
    rows.push({ el, ...geom, h: slotHeight(el, rect) });
  }

  // 折叠箭头槽：元素稀疏（只有可折叠行 / 标记行 / 活跃行有元素），不能按索引
  // 配对。与行号槽位同一行的槽位布局顶、槽高相等（两列 height/marginTop 栈出
  // 同一套 block.top），按（未变换布局顶, 槽高）双键反查所属行，复用该行几何。
  const foldGutter = view.dom.querySelector('.cm-foldGutter');
  if (foldGutter) {
    for (const el of Array.from(foldGutter.querySelectorAll('.cm-gutterElement'))) {
      // 测宽占位：CM spacer 内联 visibility:hidden，不是真箭头
      if (el.style.visibility === 'hidden') continue;
      if (isReused(el)) {
        stale.push(el);
        continue;
      }
      const applied = parseFloat(el.dataset.qpTf || '0') || 0;
      const rect = el.getBoundingClientRect();
      const top = rect.top - applied;
      let best = null;
      let bestDist = Infinity;
      for (const s of slots) {
        const dTop = Math.abs(s.top - top);
        const dH = Math.abs(s.height - rect.height);
        // 槽高必须同带（容差只吸收子像素舍入）；0 高度空行与 42px 内容行的槽高
        // 差远超容差，不会误配 —— 这正是「只比顶」配错 17~23px 的根因。
        if (dTop > 3 || dH > 6) continue;
        const d = dTop + dH;
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      if (!best) {
        if (el.dataset.qpTf !== undefined) stale.push(el);
        continue;
      }
      rows.push({ el, ...best.geom, h: slotHeight(el, rect) });
    }
  }
  return { rows, stale };
}

/**
 * 把几何写到行号 / 折叠箭头元素上。
 *
 * @param {Array<{el: HTMLElement, delta: number, padT: number, lh: number, h: number}>} rows
 * @return {boolean} 本轮是否有变化（需要再测一轮）
 */
function apply(rows) {
  let dirty = false;
  for (const { el, delta, padT, lh, h } of rows) {
    // 元素高度是 CM 内联写死的（等于行盒高度），加了 padding-top 必须改成
    // border-box，否则内容被撑出槽外。
    // padding-top 钳制在槽高以内：正确配对时行盒高度必含自身 padding，钳制不
    // 生效；只有错配的脏数据才会触发，宁可当轮字形偏一点也不能把盒子撑高、
    // 推动本列布局（两列栈一旦错开就自我强化，极难收敛）。
    if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
    const pad = `${Math.min(padT, h)}px`;
    if (el.style.paddingTop !== pad) el.style.paddingTop = pad;
    // line-height 与行盒一致 → 数字 / 箭头在这一行里垂直居中，而不是贴顶
    const lhv = lh ? `${lh}px` : '';
    if (el.style.lineHeight !== lhv) el.style.lineHeight = lhv;
    const tf = delta ? `translateY(${delta}px)` : '';
    if (el.style.transform !== tf) el.style.transform = tf;
    // 只有「本轮算出的 delta 与上一轮不同」才需要再测一轮。若只是稳定地保持
    // 某个非零位移，说明已经收敛，继续重测纯属浪费（还容易触发 measure 抖动）。
    if (el.dataset.qpTf !== String(delta)) dirty = true;
    el.dataset.qpTf = String(delta);
    // 记录 CM 写死的槽高：下一轮若槽高变了，说明元素被复用给另一行，先清再配
    el.dataset.qpH = String(h);
    touched.add(el);
  }
  return dirty;
}

/** 卸载时清掉本插件写过的内联样式（回到 CM 默认的贴顶布局）。 */
function reset() {
  for (const el of Array.from(touched)) {
    // CM 可能已经把元素移出 DOM，但内联样式仍挂在对象上，照清不误
    clearEl(el);
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
     * 能收敛；元素被复用后先清陈旧样式、再按干净布局重配，也各占一轮。transform
     * 不影响布局，所以多量几轮不会抖动，收敛即停（最多 3 轮）。
     *
     * @param {import('@codemirror/view').EditorView} view
     */
    schedule(view) {
      if (this.pending) return;
      this.pending = true;
      view.requestMeasure({
        key: this,
        read: () => collect(view),
        write: (res) => {
          this.pending = false;
          const rows = (res && res.rows) || [];
          const stale = (res && res.stale) || [];
          for (const el of stale) clearEl(el);
          const dirty = apply(rows) || stale.length > 0;
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
