/**
 * QuillPad · Npp 导入报告（纯函数，T24 / G5-8）
 *
 * 抽成独立模块是为了让 UI 与 QA 共用同一份计数口径：
 * 向导里 `data-npp-count` 的文本与插件市场的端到端断言
 * 都来自 `summarizeNpp()`，不会出现「页面写一套、测试写一套」。
 */

import { t } from '../i18n.js';

/**
 * 把扫描到的目录名映射到兼容表条目。
 * @param {Array<string>} names 扫描到的插件目录名
 * @param {Array<object>} items npp-compat.json 的 items
 * @return {Array<{name: string, status: 'builtin'|'port'|'unsupported', entry: object|null}>}
 */
export function mapScanned(names, items) {
  return (Array.isArray(names) ? names : []).map((name) => {
    const hit = (Array.isArray(items) ? items : []).find(
      (it) => String(it.nppPlugin).toLowerCase() === String(name).toLowerCase(),
    );
    return { name: String(name), status: hit ? hit.status : 'unsupported', entry: hit || null };
  });
}

/**
 * 汇总（G5-8 文本口径：共 N 个：X 个已内置、Y 个可一键安装、Z 个不支持）。
 * @param {Array<string>} names
 * @param {Array<object>} items
 * @return {{total: number, builtin: number, port: number, unsupported: number, text: string, detail: string}}
 */
export function summarizeNpp(names, items) {
  const mapped = mapScanned(names, items);
  const builtin = mapped.filter((x) => x.status === 'builtin').length;
  const port = mapped.filter((x) => x.status === 'port').length;
  const unsupported = mapped.filter((x) => x.status !== 'builtin' && x.status !== 'port').length;
  return {
    total: mapped.length,
    builtin,
    port,
    unsupported,
    text: t(`共 ${mapped.length} 个：${builtin} 个已内置、${port} 个可一键安装、${unsupported} 个不支持`,
      `${mapped.length} total: ${builtin} built in, ${port} one-click installs, ${unsupported} unsupported`),
    detail: t(`共检测到 ${mapped.length} 个：${builtin} 个已内置 · ${port} 个可一键安装 · ${unsupported} 个不支持`,
      `Detected ${mapped.length} total: ${builtin} built in · ${port} one-click installs · ${unsupported} unsupported`),
  };
}
