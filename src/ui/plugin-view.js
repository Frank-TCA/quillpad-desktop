/**
 * QuillPad · 插件侧栏视图（T22/T23）公开入口。
 *
 * 官方 `quillpad.dev-tools` 通过 `ui.registerSidebarView` 注册 1 个视图；
 * `pluginViewsHtml()` 负责把已注册视图渲染进插件管理器对话框底部，
 * `initPluginUI()` 负责把 `registerPluginView` / `unregisterPluginViews`
 * 挂到 app 上。实现在 `ui/plugins.js`，本文件只做转出。
 */

export {
  pluginViewsHtml,
  initPluginUI,
  EXPECTED_NOTICE,
} from './plugins.js';
