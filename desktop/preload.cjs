'use strict';

/**
 * QuillPad 桌面壳 · preload
 *
 * 只暴露窗口控制这一件事，其余能力（文件读写等）继续走浏览器的标准 API，
 * 这样同一份前端代码在浏览器和桌面壳里行为完全一致。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('quillpadDesktop', {
  /** 是否为桌面壳（前端可据此显示窗口按钮等桌面专属 UI）。 */
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('qp:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('qp:window', 'toggle-maximize'),
  close: () => ipcRenderer.send('qp:window', 'close'),
  /** @return {Promise<boolean>} 当前是否处于最大化状态 */
  isMaximized: () => ipcRenderer.invoke('qp:is-maximized'),
  /**
   * 订阅最大化状态变化。
   * @param {(maximized: boolean) => void} callback
   * @return {() => void} 取消订阅
   */
  onMaximizeChange: (callback) => {
    const handler = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on('qp:maximized', handler);
    return () => ipcRenderer.removeListener('qp:maximized', handler);
  },

  /* ---------------------------------------------------------- 原生文件通路 */
  /**
   * 读取磁盘文件，返回原始字节（解码交给页面里已有的 decodeBytes）。
   * @param {string} filePath 绝对路径
   * @return {Promise<{ok: boolean, error?: string, name?: string, path?: string,
   *   bytes?: Uint8Array, size?: number, modified?: number}>}
   */
  readFile: (filePath) => ipcRenderer.invoke('qp:read-file', filePath),
  /**
   * 写回磁盘（保留原文件是否带 BOM 的约定）。
   * @param {string} filePath
   * @param {string} text
   * @param {{bom?: boolean}} [opts]
   * @return {Promise<{ok: boolean, error?: string, size?: number}>}
   */
  writeFile: (filePath, text, opts) => ipcRenderer.invoke('qp:write-file', filePath, text, opts),
  /**
   * 系统「另存为」对话框。**唯一**能拿到完整绝对路径的保存入口
   * （FSA 的 FileSystemFileHandle 只有 name，没有目录）。
   * @param {{defaultName?: string, directory?: string}} [payload]
   * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string, error?: string}>}
   */
  saveDialog: (payload) => ipcRenderer.invoke('qp:save-dialog', payload || {}),
  /**
   * 读取文档引用的本地图片，返回 base64（渲染层拼成 data URL）。
   * @param {string} urlOrPath `file:///…` 或绝对路径
   * @return {Promise<{ok: boolean, mime?: string, base64?: string, code?: string, error?: string}>}
   */
  readImage: (urlOrPath) => ipcRenderer.invoke('qp:read-image', urlOrPath),
  revealInFolder: (payload) => ipcRenderer.invoke('qp:reveal-in-folder', payload),
  /**
   * 订阅由系统传来的待打开文件（命令行 / 右键菜单 / 文件关联 / 单实例转发）。
   * @param {(paths: string[]) => void} callback
   * @return {() => void} 取消订阅
   */
  onOpenPaths: (callback) => {
    const handler = (_event, paths) => callback(Array.isArray(paths) ? paths : []);
    ipcRenderer.on('qp:open-paths', handler);
    return () => ipcRenderer.removeListener('qp:open-paths', handler);
  },
  /** 告诉主进程「页面已就绪，可以推送待打开文件了」。 */
  notifyReady: () => ipcRenderer.send('qp:renderer-ready'),
  /**
   * 取拖进窗口的 File 对应的真实磁盘路径（Electron 扩展，浏览器没有）。
   * @param {File} file
   * @return {string} 无法取得时返回空字符串
   */
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  /* ------------------------------------------------- v2 · PDF / 打印 / 资源 */
  /**
   * 导出 PDF（主进程用隐藏 BrowserWindow + `printToPDF`）。
   *
   * @param {{html: string, options: object, suggestedName?: string,
   *          filePath?: string|null, directory?: string|null}} payload
   * @return {Promise<{ok: boolean, path?: string, bytes?: number,
   *                   canceled?: boolean, code?: string, error?: string}>}
   */
  exportPdf: (payload) => ipcRenderer.invoke('qp:export-pdf', payload || {}),
  /**
   * 弹出系统目录选择框（导出 PDF 的「浏览…」用）。
   * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string}>}
   */
  pickDirectory: () => ipcRenderer.invoke('qp:pick-directory'),
  /**
   * 打印（与 PDF 共用同一份打印 HTML）。
   * @param {{html: string, options: object}} payload
   * @return {Promise<{ok: boolean, code?: string, error?: string}>}
   */
  printDocument: (payload) => ipcRenderer.invoke('qp:print', payload || {}),
  /**
   * 把字节写进文档同目录的 `assets/`（主进程做路径防护与重名避让）。
   * @param {{docDir: string, fileName: string, bytes: Uint8Array}} payload
   * @return {Promise<{ok: boolean, path?: string, name?: string,
   *                   code?: string, error?: string}>}
   */
  writeAsset: (payload) => ipcRenderer.invoke('qp:write-asset', payload || {}),
  /**
   * 用系统浏览器打开链接（主进程做协议白名单）。
   * @param {{url: string}} payload
   * @return {Promise<{ok: boolean, code?: string, error?: string}>}
   */
  openExternal: (payload) => ipcRenderer.invoke('qp:open-external', payload || {}),
  /**
   * 读应用自带资源（打印时内联字体用；`file://` 下 fetch 不可用）。
   * @param {{url?: string, path?: string}} payload
   * @return {Promise<{ok: boolean, base64?: string, bytes?: number,
   *                   code?: string, error?: string}>}
   */
  readAsset: (payload) => ipcRenderer.invoke('qp:read-asset', payload || {}),

  /* ------------------------------------------------------------- 宏持久化 */
  /**
   * 读取宏文件。
   * @return {Promise<{ok: boolean, macros?: Array<object>, path?: string,
   *                   code?: string, error?: string}>}
   */
  readMacros: () => ipcRenderer.invoke('qp:read-macros'),
  /**
   * 写入宏文件。
   * @param {Array<object>} macros
   * @return {Promise<{ok: boolean, path?: string, code?: string, error?: string}>}
   */
  writeMacros: (macros) => ipcRenderer.invoke('qp:write-macros', macros),
  /**
   * 宏文件路径（诊断 / 错误提示用）。
   * @return {Promise<{ok: boolean, path?: string}>}
   */
  macrosPath: () => ipcRenderer.invoke('qp:macros-path'),

  /* ------------------------------------------------------------- 插件平台 */
  pluginRoots: () => ipcRenderer.invoke('qp:plugin-roots'),
  pluginBaseUrl: () => ipcRenderer.invoke('qp:plugin-base-url'),
  pluginList: () => ipcRenderer.invoke('qp:plugin-list'),
  pluginInstall: (payload) => ipcRenderer.invoke('qp:plugin-install', payload || {}),
  pluginUninstall: (id) => ipcRenderer.invoke('qp:plugin-uninstall', id),
  pluginEnable: (id, enabled, reason) => ipcRenderer.invoke('qp:plugin-enable', id, enabled, reason),
  pluginRead: (id, rel) => ipcRenderer.invoke('qp:plugin-read', id, rel),
  pluginStorage: (payload) => ipcRenderer.invoke('qp:plugin-storage', payload || {}),
  nppScan: (payload) => ipcRenderer.invoke('qp:npp-scan', payload || {}),
});
