/**
 * 行号与行内容垂直对齐（WYSIWYG 专用）。
 *
 * 问题：CM 的行号槽（gutter）每个元素与对应行盒**等高**，但行号文字画在元素
 * 顶部；而 WYSIWYG 用 `padding-top` 模拟预览的外边距折叠 —— 标题 0~19px、引用块
 * 首行 14px、代码块首行 4px。于是行号浮在内容上方的留白里，标题旁的行号甚至
 * 看起来属于上一行。
 *
 * 做法：逐行把行号元素「视觉上」搬到该行第一行文字的位置：
 *   - `padding-top` = 行盒的 padding-top（钳制在槽高以内，盒子高度不变）；
 *   - `line-height` = 行盒的 line-height（数字在这一行里垂直居中，不贴顶）。
 * 折叠槽（`.cm-foldGutter`）的箭头元素做**完全相同**的处理：两列共用同一套
 * padT/lh，箭头与数字落在同一个 line-height 带里。
 *
 * ---------------------------------------------------------------------------
 * 为什么**不用** `transform: translateY(delta)`（v1.0.1 移除）
 *
 * 早期版本给两列元素加 transform 去补「行盒与槽位的布局顶差」。这套做法的
 * 前提是「两列布局顶会错开」，而错开的真正原因是**行高映射失真**：`.qp-hr`
 * 的外边距折叠出行盒、块级 widget 的 margin 不计入 rect，CM 每遇到一条 `---`
 * 就少算 20px、每遇到一个表格少算 32px（欢迎文档累积到 400px 以上）。
 *
 * transform 只影响绘制、不影响布局，结果是一列元素被「搬」到自己槽位之外，
 * 与相邻槽位的元素**重叠**。命中测试按绘制顺序取最上层元素，于是点击看起来
 * 是「第 24 行的箭头」，实际落到的却是相邻行的空元素 —— 点不动 / 折错行。
 * 偏差越大重叠越多，这就是「19 行之后箭头基本点不动」的直接原因。
 *
 * 正确做法是让 CM 的行高映射与真实布局一致：那块工作放在 `wysiwyg.css`
 * 里（间距一律用 padding 表达，margin 不进 layout 参与的盒子就一律改成
 * padding）。映射准了之后两列布局顶天然对齐，本插件只剩「把数字/箭头从槽位
 * 顶部移到首个文字基线」这一件事，纯 padding 即可完成，不会与任何元素重叠。
 *
 * ---------------------------------------------------------------------------
 * 配对方式：
 * 1. 行号槽 ↔ 行：按**行号文本**配对。`lineNumbers()` 的元素文本就是文档行号，
 *    用 `posAtDOM` 取每个 `.cm-line` 的文档行号做键。元素数与行数不齐（块级
 *    widget 行、深滚动的瞬态测量行）都不会再串位；测宽 spacer 的文本可能是纯
 *    数字（如 99），不能靠文本识别，用 CM 写在 spacer 上的内联
 *    `visibility: hidden` 跳过。
 * 2. 折叠槽 ↔ 行号槽：按（布局顶, 槽高）双键反查同行行号槽的几何。折叠槽
 *    元素稀疏（只有可折叠行、带标记行、光标活跃行才有元素），不能按索引；两列
 *    同一行的槽位由 CM 写死的 height/marginTop 栈出同一套 block.top，布局顶与
 *    槽高都相等。**槽高是消歧键**：WYSIWYG 有 0 高度空行（连续空行
 *    `line-height: 0`），与下一行槽顶重合，只比顶会把空行的 padT/lh 套到下一行
 *    的箭头上。
 *
 * 元素复用：CM 会**跨视口更新复用** gutter 的 DOM 元素（滚动后同一节点换一行
 * 服务）。本插件每一轮都为**当前 DOM 里存在的每个元素**重算几何：配不上的一律
 * 清样式，配上的一律重写，因此不存在「上一行的陈旧样式」——这一点靠「无条件
 * 重写」保证，不再需要记录 `qpH` 之类的身份比对。
 */

import { ViewPlugin } from '@codemirror/view';

/**
 * 写过的元素 → 卸载时只清自己写过的内联样式。
 * 必须是可迭代的 Set：WeakSet 不能 for...of，destroy() 里遍历会抛 TypeError。
 * 元素由 CM 复用，插件生命周期内数量有界，destroy 时 clear 掉即可，不会泄漏。
 */
const touched = new Set();

/** 清掉单个元素上本插件写过的全部内联样式（元素被复用 / 配不上时用）。 */
function clearEl(el) {
  el.style.paddingTop = '';
  el.style.lineHeight = '';
  el.style.boxSizing = '';
  touched.delete(el);
}

/**
 * 读取当前渲染出的行与两列 gutter 槽位的对应关系与几何。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {{rows: Array<{el: HTMLElement, padT: number, lh: number, h: number}>,
 *           stale: HTMLElement[]}}
 */
function collect(view) {
  const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'));
  const numGutter = view.dom.querySelector('.cm-lineNumbers');
  if (!numGutter || !lines.length) return { rows: [], stale: [] };

  /**
   * 文档行号 → 行几何（padding-top、line-height）。
   * 行号取自文档本身（posAtDOM），与 DOM 元素个数无关，天然对不齐也串不了位。
   * @type {Map<number, {padT: number, lh: number}>}
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
      padT: parseFloat(cs.paddingTop) || 0,
      // `---` 这类 font-size:0 的行没有行高，退回用行盒高度把数字居中
      lh: lh || Math.round(rect.height),
    });
  }

  /** @type {Array<{el: HTMLElement, padT: number, lh: number, h: number}>} */
  const rows = [];
  /** 带样式但配不上的元素 → 写阶段清掉。 */
  const stale = [];
  /**
   * 行号槽的槽位几何（布局顶 + 槽高），供折叠槽按（顶, 高）双键反查。
   * @type {Array<{top: number, height: number, geom: {padT: number, lh: number}}>}
   */
  const slots = [];

  /** CM 写死的槽高（border-box 高度）。 */
  const slotHeight = (el, rect) => parseFloat(el.style.height) || rect.height;

  for (const el of Array.from(numGutter.querySelectorAll('.cm-gutterElement'))) {
    // 测宽 spacer：CM SingleGutterView 在其上写了内联 visibility:hidden，
    // 文本可能是纯数字（如 99），必须先按内联样式跳过，不能数个数、也不能看文本
    if (el.style.visibility === 'hidden') continue;
    const text = el.textContent.trim();
    // 行号文本即文档行号；非纯数字（spacer 形如 99…9）自然落空
    const li = /^\d+$/.test(text) ? lineByNo.get(parseInt(text, 10)) : null;
    const rect = el.getBoundingClientRect();
    if (!li) {
      // 配不上却还带着样式（例如 widget 块行号被复用）→ 清掉，不留陈旧样式
      if (touched.has(el)) stale.push(el);
      continue;
    }
    slots.push({ top: rect.top, height: rect.height, geom: li });
    rows.push({ el, ...li, h: slotHeight(el, rect) });
  }

  // 折叠箭头槽：元素稀疏（只有可折叠行 / 标记行 / 活跃行有元素），不能按索引
  // 配对。与行号槽位同一行的槽位布局顶、槽高相等（两列 height/marginTop 栈出
  // 同一套 block.top），按（布局顶, 槽高）双键反查所属行，复用该行几何。
  const foldGutter = view.dom.querySelector('.cm-foldGutter');
  if (foldGutter) {
    for (const el of Array.from(foldGutter.querySelectorAll('.cm-gutterElement'))) {
      // 测宽占位：CM spacer 内联 visibility:hidden，不是真箭头
      if (el.style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      let best = null;
      let bestDist = Infinity;
      for (const s of slots) {
        const dTop = Math.abs(s.top - rect.top);
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
        if (touched.has(el)) stale.push(el);
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
 * @param {Array<{el: HTMLElement, padT: number, lh: number, h: number}>} rows
 * @return {void}
 */
function apply(rows) {
  for (const { el, padT, lh, h } of rows) {
    // 元素高度是 CM 内联写死的（等于行盒高度），加了 padding-top 必须改成
    // border-box，否则内容被撑出槽外。
    // padding-top 钳制在槽高以内：正确配对时行盒高度必含自身 padding，钳制不
    // 生效；只有错配的脏数据才会触发，宁可当轮字形偏一点也不能把盒子撑高、
    // 推动本列布局。
    if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
    const pad = `${Math.min(padT, h)}px`;
    if (el.style.paddingTop !== pad) el.style.paddingTop = pad;
    // line-height 与行盒一致 → 数字 / 箭头在这一行里垂直居中，而不是贴顶
    const lhv = lh ? `${lh}px` : '';
    if (el.style.lineHeight !== lhv) el.style.lineHeight = lhv;
    touched.add(el);
  }
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
     * 中间态（实测标题、引用、代码块的 padding 第一轮会读到 0），写完再量一次
     * 就能收敛。padding 不改变盒高，所以多量几轮不会抖动，收敛即停（最多 3 轮）。
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
          apply(rows);
          if (stale.length > 0 && this.passes < 3) {
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
