/**
 * QuillPad · Notepad++ 插件导入向导（T24）公开入口。
 *
 * `openNppImport()` 实现 ① 扫描 → ② 报告 → ③ 安装 三步，使用
 * `core/npp-compat.js` 的 `loadCompat()` / `mapScanned()` / `summarizeNpp()`
 * 保证 `data-npp-count` 与 G5-8 断言同源；末页复用 `EXPECTED_NOTICE` 原文。
 * 向导实现在 `ui/plugins.js`，本文件只做转出（架构文件清单的模块边界）。
 */

export {
  openNppImport,
  EXPECTED_NOTICE,
} from './plugins.js';

export {
  loadCompat,
  mapScanned,
  summarizeNpp,
  countsOf,
} from '../core/npp-compat.js';
