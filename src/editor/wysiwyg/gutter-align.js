/**
 * QuillPad · 行号 / 折叠箭头与行内容垂直对齐（WYSIWYG 专用）
 *
 * ---------------------------------------------------------------------------
 * 要解决的问题
 *
 * CM 的每个 `.cm-gutterElement` 与该行行盒**等高**（`GutterElement.update()` 把
 * 行高写成内联 `height`），但槽里的内容默认贴在盒子顶部。所见即所得的行盒高度
 * 差异极大：
 *   · 正文 / 空行 28px，无上内边距；
 *   · h1 行上百像素，其中大半是 `padding-top`（模拟预览的外边距）；
 *   · 引用首行有 14px 上内边距；
 *   · 代码行 22.4px、围栏行 37.4px（字号 / 行高都与正文不同）。
 * 不处理时数字贴在这些行盒的顶部，标题旁的行号会浮在上方几十像素的留白里，看
 * 起来像属于上一行。
 *
 * ---------------------------------------------------------------------------
 * 只对齐 `padding-top` 不够 —— 还有「半行距」这一层
 *
 * 文字在行盒里的位置由两段构成：
 *
 *     textTop = 内容盒顶 + 半行距
 *     halfLeading = ( line-height - 内容高度 ) / 2
 *
 * 其中「内容高度」是字体自身的升降部高度（约 `font-size × 1.2`）。gutter 的字号
 * （12~14px）和行内字号（正文 16px、h1 30.4px）不同，两者即使 `padding-top` 与
 * `line-height` 都写成一样，`halfLeading` 也相差很大 —— 实测残差随标题字号线性
 * 放大：h1 差 12px、h2 8px、h3 5px、h4 3px、正文 3px。
 *
 * 因此这里**不猜字体度量**，而是解一次方程把「内容高度」反推出来，再解一次把
 * 文字顶边放到该行首字符的顶边：
 *
 *   1. 读当前已生效的 `line-height = L0`、`padding-top = P0`，以及数字文本矩形
 *      相对元素顶边的偏移 `D0`：
 *          D0 = P0 + ( L0 - C ) / 2      →      C = L0 + 2·P0 - 2·D0
 *      `C`（内容高度）与 `L0` 无关，一次测量即可解出，且对「元素刚被 CM 重建、
 *      内联样式被抹掉」的中间态同样成立（那时 P0 = CSS 的 padding，L0 = CSS 的
 *      行高，方程照样成立）。
 *   2. 目标：文字顶边落在 `T = 首字符矩形顶 - 元素矩形顶`。取 `padding-top = 0`，
 *      反解 `line-height = C + 2·T`（`T` 钳制在 `[0, 槽高 - C]`，绝不把内容推出
 *      槽位、也绝不让盒子变高推动本列布局）。
 *
 * 这样每一行只依赖**自己的实测几何**，标题、引用、代码、围栏、空行同一套公式，
 * 不需要为每种行类写边际值，也不会被 em 单位坑（见下）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 `transform: translateY(...)`、也不用「行类 → gutter 类」的 CSS 镜像
 *
 * · `transform` 只影响绘制、不影响布局：元素会被「搬」到自己槽位之外，与相邻槽位
 *   的元素**重叠**。命中测试按绘制顺序取最上层元素，于是点击看起来是「第 24 行的
 *   箭头」、实际落到的却是相邻行的空元素（v1.0.1 前的「箭头点不动」）。
 * · CSS 镜像（`.cm-lineNumbers .cm-gutterElement.qp-h1 { padding-top: … }`）会被
 *   em 单位坑死：`2.6em` 在 gutter 里按 gutter 自己的字号（14px）解析，而标题行的
 *   `2.6em` 是按标题字号（1.9em × 16px = 30.4px）解析的，两者相差一倍多。
 * 所以只能按**几何**逐槽写像素值。
 *
 * ---------------------------------------------------------------------------
 * 配对方式
 *
 * 1. 行号槽 ↔ 行：按**行号文本**配对。`lineNumbers()` 的元素文本就是文档行号，用
 *    `posAtDOM` 取每个 `.cm-line` 的文档行号做键。元素数与行数不齐（块级 widget
 *    行、深滚动的瞬态测量行）都不会串位；测宽 spacer 的文本可能是纯数字（如 99），
 *    不能靠文本识别，用 CM 写在 spacer 上的内联 `visibility: hidden` 跳过。
 * 2. 折叠槽 ↔ 行号槽：按（布局顶, 槽高）双键反查同行行号槽的几何。折叠槽元素稀疏
 *    （只有可折叠行 / 带标记行 / 光标活跃行才有元素），不能按索引；两列同一行的槽位
 *    由 CM 写死的 height / marginTop 栈出同一套 block.top。
 *
 * 元素复用：CM 会**跨视口更新复用** gutter 的 DOM 元素（滚动后同一节点换一行服务）。
 * 本插件每一轮都为**当前 DOM 里存在的每个元素**重算几何，配不上的清样式、配上的一
 * 律重写 —— 靠「无条件覆盖写」保证不留上一行的陈旧样式。
 */

import { ViewPlugin } from '@codemirror/view';

/**
 * 「本插件写过的元素」必须按**实例**记账，不能用模块级 Set：
 * 切视图模式 / 换语言都会 reconfigure，新实例先建、旧实例后销毁，模块级 Set 会被
 * 旧实例的 `reset()` 一起清空 —— 表现为「明明写进去了，样式却在下一帧被抹掉，
 * 行号永远贴顶」。
 */

/**
 * 找「首个可见字符」时要跳过的子树：
 * 隐藏的 Markdown 标记（`.qp-md-hide` 里的 `#`、`**`）、绝对定位的代码块标题栏与
 * 操作按钮、块级 widget（表格 / 目录 / 元信息 / 公式 / 脚注 / 图片）内部的文字。
 * 这些要么不可见、要么不参与行内文字流，拿它们的矩形当基准会把整列带偏。
 */
const SKIP_SELECTOR = [
  '.qp-md-hide',
  '.qp-code-head',
  '.qp-code-ops',
  '.qp-table-wrap',
  '.qp-toc',
  '.qp-frontmatter',
  '.qp-math--block',
  '.qp-footnotes',
  '.qp-img-wrap',
].join(', ');

/**
 * 元素内「首个可见字符」的文本矩形顶边（相对视口）。
 *
 * @param {HTMLElement} host 查找范围
 * @param {string} [skip] 额外跳过的选择器
 * @return {number|null} 顶边像素值；找不到可用文字时返回 null
 */
function firstTextTop(host, skip) {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    const idx = value.search(/\S/);
    if (idx >= 0) {
      const parent = node.parentElement;
      if (!parent || !(skip && parent.closest(skip))) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 1);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0) return rect.top;
      }
    }
    node = walker.nextNode();
  }
  return null;
}

/**
 * 清掉单个元素上本插件写过的全部内联样式（元素被复用 / 配不上时用）。
 * @param {HTMLElement} el
 * @return {void}
 */
function clearEl(el) {
  el.style.paddingTop = '';
  el.style.lineHeight = '';
  el.style.boxSizing = '';
}

/**
 * 为一行的 gutter 槽位算出 `{paddingTop, lineHeight}`。
 *
 * 见文件头「只对齐 padding-top 不够」：先用一次实测解出 gutter 字体的内容高度
 * `C`，再解出让文字顶边落在 `T` 处的 `line-height = C + 2T`。
 *
 * @param {HTMLElement} el 槽位元素（已被 CM 写了内联 height）
 * @param {{lh: number, padT: number, charTop: number|null}} line 该行几何
 * @return {{padT: number, lh: number, h: number}}
 */
function computeGeom(el, line) {
  const rect = el.getBoundingClientRect();
  // 槽高（border-box）由 CM 内联写死；拿不到就退回实测高度
  const h = parseFloat(el.style.height) || rect.height;
  const cs = getComputedStyle(el);
  const lhCur = parseFloat(cs.lineHeight) || 0;
  const padCur = parseFloat(cs.paddingTop) || 0;
  const numTop = firstTextTop(el);
  // 内容高度 = 行高 + 2·上内边距 - 2·文本顶偏移（半行距公式反解）
  const content =
    numTop === null || !lhCur ? 0 : lhCur + 2 * padCur - 2 * (numTop - rect.top);
  if (!(content > 0) || !Number.isFinite(content)) {
    // 量不到数字文本（极少数中间态）：退回「镜像行盒 padding + line-height」，
    // 至少不会把元素推出槽位
    return { padT: line.padT, lh: line.lh, h };
  }
  // 空行 / 纯 widget 行没有「首字符」，把数字摆到行盒（而非文字带）的中线
  const base =
    line.charTop === null ? (line.lh - content) / 2 : line.charTop - rect.top;
  const limit = Math.max(0, h - content);
  const target = Math.min(Math.max(base, 0), limit);
  return {
    padT: 0,
    lh: Math.round((content + 2 * target) * 100) / 100,
    h,
  };
}

/**
 * 读取当前渲染出的行与两列 gutter 槽位的对应关系与几何。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {Set<HTMLElement>} touched 本实例写过的元素
 * @return {{rows: Array<{el: HTMLElement, padT: number, lh: number, h: number}>,
 *           stale: HTMLElement[]}}
 */
function collect(view, touched) {
  const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'));
  const numGutter = view.dom.querySelector('.cm-lineNumbers');
  if (!numGutter || !lines.length) return { rows: [], stale: [] };

  /**
   * 文档行号 → 行几何（padding-top、line-height、首字符顶边）。
   * 行号取自文档本身（posAtDOM），与 DOM 元素个数无关，天然对不齐也串不了位。
   * @type {Map<number, {lh: number, padT: number, charTop: number|null}>}
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
    const lh = parseFloat(cs.lineHeight);
    lineByNo.set(no, {
      padT: parseFloat(cs.paddingTop) || 0,
      // `---` 所在行（font-size / line-height 都是 0）没有行高，退回用行盒高度
      lh: lh || el.getBoundingClientRect().height,
      charTop: firstTextTop(el, SKIP_SELECTOR),
    });
  }

  /** @type {Array<{el: HTMLElement, padT: number, lh: number, h: number}>} */
  const rows = [];
  /** 带样式但配不上的元素 → 写阶段清掉。 */
  const stale = [];
  /**
   * 行号槽的槽位几何（布局顶 + 槽高），供折叠槽按（顶, 高）双键反查。
   * @type {Array<{top: number, height: number, geom: {lh: number, padT: number, charTop: number|null}}>}
   */
  const slots = [];

  for (const el of Array.from(numGutter.querySelectorAll('.cm-gutterElement'))) {
    // 测宽 spacer：CM SingleGutterView 在其上写了内联 visibility:hidden，
    // 文本可能是纯数字（如 99），必须先按内联样式跳过。
    if (el.style.visibility === 'hidden') continue;
    const text = el.textContent.trim();
    // 行号文本即文档行号；非纯数字（spacer 形如 99…9）自然落空
    const line = /^\d+$/.test(text) ? lineByNo.get(parseInt(text, 10)) : null;
    if (!line) {
      if (touched.has(el)) stale.push(el);
      continue;
    }
    const rect = el.getBoundingClientRect();
    slots.push({ top: rect.top, height: rect.height, geom: line });
    rows.push({ el, ...computeGeom(el, line) });
  }

  // 折叠箭头槽：元素稀疏（只有可折叠行 / 标记行 / 活跃行有元素），不能按索引
  // 配对。与行号槽同一行的槽位布局顶、槽高相等（两列 height / marginTop 栈出
  // 同一套 block.top），按（布局顶, 槽高）双键反查所属行，复用该行几何。
  const foldGutter = view.dom.querySelector('.cm-foldGutter');
  if (foldGutter) {
    for (const el of Array.from(foldGutter.querySelectorAll('.cm-gutterElement'))) {
      if (el.style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      let best = null;
      let bestDist = Infinity;
      for (const s of slots) {
        const dTop = Math.abs(s.top - rect.top);
        const dH = Math.abs(s.height - rect.height);
        // 槽高必须同带（容差只吸收子像素舍入），避免把相邻行的几何套错
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
      rows.push({ el, ...computeGeom(el, best.geom) });
    }
  }
  return { rows, stale };
}

/**
 * 把几何写到行号 / 折叠箭头元素上。
 *
 * @param {Array<{el: HTMLElement, padT: number, lh: number, h: number}>} rows
 * @param {Set<HTMLElement>} touched 本实例写过的元素
 * @return {void}
 */
function apply(rows, touched) {
  for (const { el, padT, lh, h } of rows) {
    // 元素高度是 CM 内联写死的（等于行盒高度），加了 padding-top 必须改成
    // border-box，否则内容被撑出槽外。
    if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
    // padding-top 用作「兜底对齐」：正常路径解出的 padT 是 0（对齐靠 line-height），
    // 只有量不到数字文本的中间态才会带正值。两种都钳制在槽高以内 —— 宁可当轮字形
    // 偏一点，也不能把盒子撑高、推动本列布局。
    const pad = `${Math.min(Math.max(padT, 0), h)}px`;
    if (el.style.paddingTop !== pad) el.style.paddingTop = pad;
    // line-height 决定半行距，进而决定数字 / 箭头落在这一行的哪条水平线上
    const lhv = lh ? `${lh}px` : '';
    if (el.style.lineHeight !== lhv) el.style.lineHeight = lhv;
    touched.add(el);
  }
}

/** 卸载时清掉本插件写过的内联样式（回到 CM 默认的贴顶布局）。 */
function reset(touched) {
  for (const el of Array.from(touched)) clearEl(el);
  touched.clear();
}

/** WYSIWYG 行号 / 折叠箭头对齐扩展。 */
export const gutterAlignPlugin = ViewPlugin.fromClass(
  class {
    /**
     * @param {import('@codemirror/view').EditorView} view
     */
    constructor(view) {
      this.view = view;
      this.passes = 0;
      /** @type {Set<HTMLElement>} 本实例写过内联样式的元素（卸载时逐个还原） */
      this.touched = new Set();
      /** 下一帧是否已排好一次补写（MutationObserver 去抖用）。 */
      this.queued = false;
      /** @type {MutationObserver|null} */
      this.observer = null;
      this.schedule(view);
      this.watchGutterDom();
    }

    /**
     * 监听 gutter DOM 的**元素增删**。
     *
     * CM 的 `UpdateContext.addElement / finish` 会在滚动与视口变化时**移除并重新
     * 追加** `.cm-gutterElement` 节点（不是复用），内联样式随旧节点一起消失。这些
     * 增删可能发生在「写完样式之后的那一轮 measure」里 —— 那一轮不会再触发插件
     * 的 `update()`（`ViewUpdate` 是空的），于是样式丢了也没人补，实测表现就是
     * 「行号全部贴回行盒顶部」。
     *
     * 只观察 `childList`：我们自己写的是**属性**，不会自激死循环。
     *
     * @return {void}
     */
    watchGutterDom() {
      if (typeof MutationObserver !== 'function') return;
      this.observer = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type !== 'childList') continue;
          const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
          const hit = nodes.some(
            (n) =>
              n.nodeType === 1 &&
              (n.classList.contains('cm-gutterElement') ||
                n.classList.contains('cm-gutter') ||
                (n.querySelector && n.querySelector('.cm-gutterElement'))),
          );
          if (hit) {
            this.requeue();
            return;
          }
        }
      });
      this.observer.observe(this.view.dom, { childList: true, subtree: true });
    }

    /** 下一帧补一次量测（同一帧内多次触发只排一次）。 @return {void} */
    requeue() {
      if (this.queued) return;
      this.queued = true;
      const run = () => {
        this.queued = false;
        this.passes = 0;
        this.schedule(this.view);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 0);
    }

    /**
     * @param {import('@codemirror/view').ViewUpdate} u
     */
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
     * 不加「已经排过队就跳过」的布尔哨兵：视图初始化期间（插件刚构造、模式刚切换）
     * 请求的 measure 可能被 CM 丢弃，write 永不回调，哨兵就会永久卡住、整列再不
     * 对齐（实测就是这么坏的）。同一 key 的重复请求由 CM 自己合并，代价可忽略。
     *
     * 为什么要连跑几轮：首次量到的几何可能是「装饰刚挂上、行高还没定型」的中间态
     * （实测标题 / 引用 / 代码块的内边距第一轮会读到 0），写完再量一次才能收敛。
     * 公式是自洽的（第二轮解出的 `C`、`T` 与第一轮相同，写入值不变），所以多跑几
     * 轮不会抖动，收敛即停（最多 3 轮）。
     *
     * @param {import('@codemirror/view').EditorView} view
     * @return {void}
     */
    schedule(view) {
      view.requestMeasure({
        key: this,
        read: () => collect(view, this.touched),
        write: (res) => {
          const rows = (res && res.rows) || [];
          const stale = (res && res.stale) || [];
          for (const el of stale) {
            clearEl(el);
            this.touched.delete(el);
          }
          apply(rows, this.touched);
          /* 第二轮校验：CM 的 measure 循环可能在**写完槽位样式之后**再重建一次
             gutter DOM（视口 / 行高稳定前的最后一轮），新建的元素没有内联样式，
             而这一轮又不会再触发插件的 update —— 实测表现就是「样式写进去了，
             下一帧全没了，行号永远贴顶」。所以每轮写完都在下一帧补一次量测，
             用最多 2 轮收敛（`passes` 在每次 update 时归零）。 */
          if (this.passes < 2) {
            this.passes += 1;
            const next = () => this.schedule(view);
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(next);
            else setTimeout(next, 0);
          }
        },
      });
    }

    destroy() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      reset(this.touched);
    }
  },
);
