/**
 * QuillPad · 本地图片 → 可直接给 `<img src>` 用的地址
 *
 * 背景：主窗口由本地 HTTP server 提供（`win.loadURL(baseUrl)`），Chromium 会
 * 拒绝从 http 页面加载 `file:///` 资源（"Not allowed to load local resource"）。
 * `resolveImageUrl()` 为了兼容打印管线仍返回 `file:///`，因此这里在**渲染层**
 * 做一次转换：桌面壳里走 `qp:read-image` 让主进程读字节，再拼成 data URL。
 *
 * 为什么放在渲染层而不是改 `resolveImageUrl()`：后者是同步函数，还被
 * `src/core/print.js` 用来解析打印时的本地图片；改成异步会牵动整条打印链。
 * 这里只服务 `<img>`，语义单一，且天然带缓存（WYSIWYG 每次重绘都会重建
 * widget，不缓存会对同一张图反复发起 IPC + base64 编解码）。
 */

import { canReadImage, readImage } from '../../core/desktop.js';

/** 缓存上限：单张图最大 20MB，留 60 张足够覆盖一篇长文。 */
const CACHE_LIMIT = 60;

/** @type {Map<string, Promise<string|null>>} file URL -> data URL（或 null） */
const cache = new Map();

/**
 * 是否是需要主进程代读的本地文件地址。
 * @param {string} url
 * @return {boolean}
 */
export function isLocalImageUrl(url) {
  return /^file:/i.test(String(url || ''));
}

/**
 * 取可直接写入 `<img src>` 的地址。
 *
 * - 网络 / data / blob / 相对路径：原样返回（调用方自行降级）；
 * - `file:`：桌面壳读成 `data:<mime>;base64,…`；浏览器模式或读取失败返回 null。
 *
 * 相同地址共享同一个 Promise，widget 反复重建也只会有一次 IPC。
 *
 * @param {string} url
 * @return {Promise<string|null>}
 */
export function loadImageSrc(url) {
  const raw = String(url || '');
  if (!raw) return Promise.resolve(null);
  if (!isLocalImageUrl(raw)) return Promise.resolve(raw);
  if (cache.has(raw)) return cache.get(raw);
  if (!canReadImage()) return Promise.resolve(null);

  if (cache.size >= CACHE_LIMIT) cache.clear();

  const task = readImage(raw)
    .then((res) => {
      if (!res || !res.ok || !res.base64 || !res.mime) return null;
      return `data:${res.mime};base64,${res.base64}`;
    })
    .catch(() => null);
  cache.set(raw, task);
  return task;
}

/**
 * 清空缓存（从磁盘重新加载文档 / 图片被外部覆盖时调用）。
 */
export function clearImageSrcCache() {
  cache.clear();
}
