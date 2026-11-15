/**
 * QuillPad · Notepad++ 插件兼容表数据契约（T24 / G5-8）
 *
 * 这是 `src/core/npp-compat.js` 的公开入口：负责读取发布态的
 * `public/npp-compat.json`（构建后位于 `dist/npp-compat.json`），并把纯函数
 * 计数口径从 `core/plugins/npp-report.js` 统一转出。
 *
 * 设计取舍：UI（`ui/plugins.js` / `ui/npp-wizard.js`）与 QA 脚本共用这一份
 * `loadCompat()` / `summarizeNpp()`，避免「页面写一套计数、测试写一套计数」
 * 造成 G5-8 的 `data-npp-count` 文本漂移。
 */

import { mapScanned, summarizeNpp } from './plugins/npp-report.js';

/** 兼容表相对 `document.baseURI` 的位置（Vite 会把 public/ 原样拷到 dist/）。 */
export const COMPAT_URL = './npp-compat.json';

export { mapScanned, summarizeNpp };

/**
 * 读取兼容表条目。
 *
 * 不做缓存：向导每次打开都拿最新发布态数据，也便于 QA 用不同 fixture 复跑。
 * 网络失败 / 结构不合法时返回空数组（空状态由 UI 渲染，不抛异常）。
 *
 * @param {boolean} [force=false] 保留参数以兼容未来缓存策略，当前不生效
 * @return {Promise<Array<object>>} npp-compat.json 的 items
 */
export async function loadCompat(force = false) {
  void force;
  try {
    const res = await fetch(new URL(COMPAT_URL, document.baseURI).href, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

/**
 * 统计兼容表三类分布（data-check / G5-10 的口径）。
 * @param {Array<object>} items
 * @return {{total: number, builtin: number, port: number, unsupported: number, installable: number}}
 */
export function countsOf(items) {
  const rows = Array.isArray(items) ? items : [];
  return {
    total: rows.length,
    builtin: rows.filter((x) => x.status === 'builtin').length,
    port: rows.filter((x) => x.status === 'port').length,
    unsupported: rows.filter((x) => x.status === 'unsupported').length,
    installable: rows.filter((x) => Boolean(x.installable)).length,
  };
}
