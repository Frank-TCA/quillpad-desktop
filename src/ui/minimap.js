/**
 * QuillPad · 迷你地图（T09）
 *
 * 一个 64px 宽的 `<canvas class="qp-minimap">`，叠在编辑区右侧：
 *  - 每条文档行画一根细横条（长度随该行字符数白化），密度即文档轮廓；
 *  - 半透明视口矩形表示当前可见范围；
 *  - 点击 / 拖动 → 按比例滚动，并把光标移到目标行。
 *
 * 为什么用 canvas 而不是 DOM：1MB 文档有 2.5 万行，DOM 方案必然卡死；
 * canvas 只在 `requestIdleCallback` 里按需重绘，且限制每帧绘制行数。
 */

import { state } from '../core/state.js';

/** 画布逻辑宽度（CSS 像素）。 */
const WIDTH = 64;
/** 每根行条的像素高度。 */
const ROW = 2;
/** 单次绘制的最大行数（护栏）。 */
const MAX_ROWS = 4000;
/** 超大文档的抽样行数（>2 万行时）。 */
const HUGE_ROWS = 800;

/** 行条缓存：文档没变就不重复遍历 `Text`（这是 1MB 文档滚动的性能关键）。 */
let barsCacheKey = '';
/** @type {Array<{x: number, y: number, w: number}>} */
let barsCache = [];

/**
 * 把文档行数映射成画布行数（超过上限时抽样）。
 * @param {number} lines
 * @return {number}
 */
function sampleCount(lines) {
  if (lines > 20000) return HUGE_ROWS;
  return Math.max(1, Math.min(MAX_ROWS, lines));
}

/**
 * 构建（或复用）行条几何数据。文档未变化时直接命中缓存 —— 这样滚动时
 * 每帧只做 canvas 绘制，不再遍历 2.5 万行 `Text`（T08 ④ 性能前提）。
 *
 * @param {object} doc `state.doc`
 * @param {number} height
 * @return {Array<{x: number, y: number, w: number}>}
 */
function buildBars(doc, height) {
  const key = `${doc.length}:${doc.lines}:${height}`;
  if (barsCacheKey === key) return barsCache;
  const rows = sampleCount(doc.lines);
  const step = height / rows;
  const bars = [];
  for (let i = 0; i < rows; i += 1) {
    const lineNo = doc.lines <= rows ? i + 1 : 1 + Math.floor((i * doc.lines) / rows);
    const text = doc.line(Math.min(doc.lines, Math.max(1, lineNo))).text;
    const indent = text.length - text.trimStart().length;
    const width = Math.min(WIDTH - 8, 6 + Math.min(text.trim().length, 120) * 0.42);
    bars.push({
      x: 3 + Math.min(indent, 12) * 1.6,
      y: i * step,
      w: Math.max(3, width),
    });
  }
  barsCacheKey = key;
  barsCache = bars;
  return bars;
}

/**
 * 创建迷你地图。
 *
 * @param {HTMLElement} host 挂载容器（`.editor-pane`）
 * @param {object} app
 * @return {{el: HTMLCanvasElement, update: () => void, render: () => void, destroy: () => void}}
 */
export function createMinimap(host, app) {
  const canvas = document.createElement('canvas');
  canvas.className = 'qp-minimap';
  canvas.setAttribute('data-qp-node', 'minimap');
  canvas.setAttribute('aria-label', '迷你地图（点击跳转）');
  canvas.setAttribute('role', 'presentation');
  canvas.width = WIDTH;
  host.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let raf = 0;
  let dragging = false;

  /** 画布 CSS 高度（跟随编辑区高度）。 */
  function cssHeight() {
    const editor = app.editor && app.editor.view ? app.editor.view.scrollDOM : null;
    const h = editor ? editor.clientHeight : host.clientHeight;
    return Math.max(60, Math.round(h));
  }

  /**
   * 当前主题色（从 CSS 变量取，避免硬编码）。
   * @param {string} name
   * @param {string} fallback
   * @return {string}
   */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** 重绘。 */
  function render() {
    if (!ctx) return;
    const height = cssHeight();
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${height}px`;

    ctx.clearRect(0, 0, WIDTH, height);
    const view = app.editor && app.editor.view;
    if (!view) return;
    const doc = view.state.doc;
    const bars = buildBars(doc, height);
    const rows = bars.length;

    const textColor = cssVar('--text-faint', '#8a8f98');
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = textColor;
    for (const bar of bars) {
      ctx.fillRect(bar.x, bar.y, bar.w, Math.max(1, Math.min(ROW, height / rows)));
    }

    // 视口矩形
    const scroller = view.scrollDOM;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const ratio = max > 0 ? scroller.scrollTop / max : 0;
    const visibleRatio = scroller.scrollHeight > 0 ? scroller.clientHeight / scroller.scrollHeight : 1;
    const boxH = Math.max(12, Math.min(height, visibleRatio * height));
    const boxY = Math.min(Math.max(0, height - boxH), ratio * Math.max(0, height - boxH));
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--accent', '#4f8cff');
    ctx.globalAlpha = 0.16;
    ctx.fillRect(0, boxY, WIDTH, boxH);
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = cssVar('--accent', '#4f8cff');
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, boxY + 0.5, WIDTH - 1, Math.max(2, boxH - 1));
    ctx.globalAlpha = 1;
  }

  /** 合并到下一帧。 */
  function update() {
    if (!state.minimapVisible) return;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }

  /**
   * 按画布纵坐标跳转。
   * @param {number} clientY
   */
  function jumpTo(clientY) {
    const view = app.editor && app.editor.view;
    if (!view) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height)));
    const doc = view.state.doc;
    const lineNo = Math.max(1, Math.min(doc.lines, 1 + Math.round(ratio * (doc.lines - 1))));
    app.editor.gotoLine(lineNo);
    app.editor.scrollToRatio(ratio);
    update();
  }

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    jumpTo(e.clientY);
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    jumpTo(e.clientY);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  // 编辑器滚动 / 内容变化 → 重绘
  const onScroll = () => update();
  const scroller = app.editor && app.editor.view ? app.editor.view.scrollDOM : null;
  if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => update()) : null;
  if (ro) ro.observe(host);

  /**
   * 显隐切换。
   * @param {boolean} visible
   */
  function setVisible(visible) {
    canvas.hidden = !visible;
    canvas.classList.toggle('is-visible', !!visible);
    if (visible) update();
  }

  setVisible(!!state.minimapVisible);

  return {
    el: canvas,
    update,
    render,
    setVisible,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (scroller) scroller.removeEventListener('scroll', onScroll);
      if (ro) ro.disconnect();
      canvas.remove();
    },
  };
}
