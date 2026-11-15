/**
 * QuillPad · 数学公式（KaTeX，MIT）
 *
 * 三条硬约束：
 *  1. **绝不静态 `import 'katex'`** —— 只在 `loadKatex()` 里动态 `import()`，
 *     让 65KB 的渲染器进分包、首屏不加载（ARCH R8）；
 *  2. 加载失败（离线 / 包被裁剪）时**降级为等宽源码**，且 `console.error` 计数为 0
 *     （只用 `console.warn`，A2 第 17 行验收）；
 *  3. 公式在「光标不在该行」时渲染为 `.katex`；光标进入即露出源码（A3）。
 */

import 'katex/dist/katex.min.css';

/** @type {Promise<any>|null} */
let katexPromise = null;
/** KaTeX 是否已确认不可用（避免反复重试刷日志）。 */
let katexUnavailable = false;

/**
 * 动态加载 KaTeX。
 * @return {Promise<any|null>}
 */
export function loadKatex() {
  if (katexUnavailable) return Promise.resolve(null);
  if (!katexPromise) {
    katexPromise = import('katex')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        katexUnavailable = true;
        katexPromise = null;
        console.warn('[QuillPad] KaTeX 加载失败，数学公式降级为源码显示：', err && err.message);
        return null;
      });
  }
  return katexPromise;
}

/**
 * 同构降级：把公式源码写进容器（等宽样式，靠 CSS 表达）。
 * @param {HTMLElement} el
 * @param {string} tex
 * @param {boolean} displayMode
 */
export function renderMathSource(el, tex, displayMode = false) {
  el.classList.add('qp-math-src');
  el.textContent = displayMode ? `$$\n${tex}\n$$` : `$${tex}$`;
}

/**
 * 渲染公式：先出源码，KaTeX 就绪后原地升级为 `.katex`。
 *
 * 幂等：同一容器重复调用只会升级一次（`dataset.qpMathTex` 去重）。
 *
 * @param {HTMLElement} el
 * @param {string} tex
 * @param {boolean} [displayMode]
 */
export function renderMath(el, tex, displayMode = false) {
  el.dataset.qpMathTex = tex;
  el.dataset.qpMathDisplay = displayMode ? 'block' : 'inline';
  renderMathSource(el, tex, displayMode);
  loadKatex().then((katex) => {
    if (!katex || !el.isConnected) return;
    if (el.dataset.qpMathTex !== tex) return;
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: false,
        output: 'html',
        trust: false,
      });
      el.classList.remove('qp-math-src');
      el.classList.add('qp-math-rendered');
      el.dataset.qpMathState = 'rendered';
    } catch (err) {
      // 语法错误 → 保持源码，不抛异常（console.error 计数必须为 0）
      console.warn('[QuillPad] 公式渲染失败，已保留源码：', err && err.message);
      el.dataset.qpMathState = 'failed';
    }
  });
}

/**
 * KaTeX 是否已就绪（测试用）。
 * @return {boolean}
 */
export function isKatexLoaded() {
  return !!katexPromise && !katexUnavailable;
}
