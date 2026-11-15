/**
 * QuillPad · 装饰预算护栏（T08）
 *
 * 装饰层的成本 ≈ 装饰数 × 重建频率。这里给出三个可量化的闸门，
 * 供 `wysiwyg/index.js` 与 `app.js` 共用：
 *
 *  1. `decoBudget(docLength, viewportLines)` —— 本次允许产出的装饰上限；
 *  2. `shouldSkipHeavy(state)` —— 超大文档直接跳过「高成本装饰」
 *     （公式 / 图片解析 / 目录 / 脚注），只保留标题、粗斜删、列表等轻量项；
 *  3. `createFrameMeter()` —— rAF 采样器，用于验收「1MB 文档滚动 5s
 *     平均帧间隔 ≤20ms」，也在开发时可挂到 `window.__qpFrames`。
 */

/** 单次重建的装饰上限（行内层）。 */
export const INLINE_DECO_LIMIT = 8000;

/** 文档字符数超过该值 → 跳过重装饰。 */
export const HEAVY_DOC_CHARS = 400 * 1024;

/** 文档行数超过该值 → 跳过重装饰。 */
export const HEAVY_DOC_LINES = 8000;

/**
 * 计算本次允许的装饰数量上限。
 *
 * @param {number} docLength 文档字符数
 * @param {number} viewportLines 当前视口行数
 * @return {number}
 */
export function decoBudget(docLength, viewportLines) {
  const base = INLINE_DECO_LIMIT;
  const vp = Number.isFinite(viewportLines) ? Math.max(1, viewportLines) : 60;
  // 视口行数 × 20 是常态需求（一行内可能有多处行内元素）；
  // 大文档再打 0.6 折，避免单帧构造过多 Range 对象。
  const scale = docLength > HEAVY_DOC_CHARS ? 0.6 : 1;
  return Math.max(200, Math.min(base, Math.round(vp * 20 * scale)));
}

/**
 * 是否应当跳过「高成本装饰」。
 *
 * @param {{length: number, lines: number}} doc 形如 `state.doc`
 * @return {boolean}
 */
export function shouldSkipHeavy(doc) {
  if (!doc) return false;
  return doc.length > HEAVY_DOC_CHARS || doc.lines > HEAVY_DOC_LINES;
}

/**
 * rAF 帧间隔采样器（T08 ④）。
 *
 * @return {{start: () => void, stop: () => {frames: number, avg: number, max: number}}}
 */
export function createFrameMeter() {
  /** @type {number[]} */
  let stamps = [];
  let raf = 0;
  let running = false;

  const tick = (t) => {
    if (!running) return;
    stamps.push(t);
    raf = requestAnimationFrame(tick);
  };

  return {
    start() {
      stamps = [];
      running = true;
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const gaps = [];
      for (let i = 1; i < stamps.length; i += 1) gaps.push(stamps[i] - stamps[i - 1]);
      const total = gaps.reduce((a, b) => a + b, 0);
      return {
        frames: stamps.length,
        avg: gaps.length ? total / gaps.length : 0,
        max: gaps.length ? Math.max(...gaps) : 0,
      };
    },
  };
}
