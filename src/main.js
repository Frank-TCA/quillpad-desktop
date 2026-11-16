/**
 * QuillPad · 入口
 *
 * 样式表在 app.js 里统一引入，这里只负责引导启动。
 */

import { createApp } from './app.js';
import { loadSettings } from './core/settings.js';
import { setLocale, t } from './core/i18n.js';

/**
 * 引导启动。任何致命错误都会渲染一个可读的错误页，而不是白屏。
 */
async function boot() {
  // 界面语言必须在 createApp() 之前定下来：菜单、工具栏、状态栏渲染时就会读 t()。
  // createApp() 里会按同一份 settings 再校准一次（测试脚本可能直接调它），
  // 这里提前设一次是为了连「启动失败错误页」也能用正确的语言显示。
  try {
    setLocale(loadSettings().locale);
  } catch (err) {
    console.warn('[QuillPad] 读取界面语言失败，使用简体中文：', err);
  }
  const mount = document.getElementById('app');
  try {
    const app = await createApp();
    // 便于在控制台调试
    window.quillpad = app;

    // 桌面壳：接上「由系统传入的文件」通路（双击关联文件、右键菜单、单实例转发）。
    // 必须先注册监听再报 ready，否则主进程立刻推送的消息会丢。
    const desktop = window.quillpadDesktop;
    if (desktop && desktop.onOpenPaths) {
      desktop.onOpenPaths((paths) => {
        void (async () => {
          for (const filePath of paths) {
            // eslint-disable-next-line no-await-in-loop
            await app.openNativePath(filePath);
          }
        })();
      });
      if (desktop.notifyReady) desktop.notifyReady();
    }

    if (mount) mount.dataset.ready = 'true';
  } catch (err) {
    console.error('[QuillPad] 启动失败：', err);
    if (!mount) return;
    mount.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;padding:40px;text-align:center;font-family:system-ui">' +
      '<div>' +
      `<div style="font-size:20px;font-weight:700;margin-bottom:10px">${t('QuillPad 启动失败', 'QuillPad failed to start')}</div>` +
      '<div style="color:#8b97a6;font-size:13px;max-width:520px;line-height:1.7">' +
      `${String(err && err.message ? err.message : err)}<br/><br/>` +
      t('请打开浏览器控制台查看详细堆栈，或刷新页面重试。', 'Check the browser console for details, or refresh to retry.') +
      '</div>' +
      (err && err.stack
        ? `<pre style="text-align:left;font-size:11px;color:#5d6775;max-width:760px;overflow:auto;margin-top:16px">${String(
            err.stack,
          )
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')}</pre>`
        : '') +
      '</div></div>';
  }
}

boot();
