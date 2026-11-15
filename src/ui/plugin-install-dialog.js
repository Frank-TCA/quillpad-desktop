/**
 * QuillPad · 插件安装相关对话框（T22）公开入口。
 *
 * - `openPermConfirm`：`data-dialog="perm-confirm"`，7 种权限 + 高风险二次确认；
 * - `openDllReject`：`data-dialog="dll-reject"`，正文含 Scintilla / NPPM_ / GPL；
 * - `openInstallFromUrl`：`data-dialog="npp-import"` 之外的 URL 安装入口。
 *
 * 实现在 `ui/plugins.js`，本文件只做转出（架构文件清单的模块边界）。
 */

export {
  openPermConfirm,
  openDllReject,
  openInstallFromUrl,
} from './plugins.js';
