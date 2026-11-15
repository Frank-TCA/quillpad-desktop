/**
 * QuillPad · 插件市场面板（T22）公开入口。
 *
 * 具体实现集中在 `ui/plugins.js`：`marketHtml` / `bindMarket` /
 * `pluginViewsHtml` / `initPluginUI` 共同维护 PRD §5.4 的 23 个 data-* 契约。
 * 市场 UI 现宿于插件管理器对话框（`ui/plugin-manager.js` 的 [data-pm-market]）。
 * 本文件只做稳定转出，让架构文件清单里的 `src/ui/plugin-panel.js` 成为可引用的
 * 模块边界，避免同一份 DOM 契约在多个文件里各写一遍而漂移。
 */

export {
  marketHtml,
  bindMarket,
  pluginViewsHtml,
  initPluginUI,
} from './plugins.js';
