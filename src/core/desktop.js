/**
 * QuillPad · 桌面壳桥
 *
 * 全部「只有 Electron 才能做」的能力都收敛到这一个文件里，渲染层其余代码
 * 只调用这里的函数，不直接摸 `window.quillpadDesktop`。这样：
 *
 *  - 浏览器里跑（`npm run dev`）时所有能力探测统一返回 `false`，
 *    降级路径只有一处需要维护；
 *  - 测试可以整体替换 `window.quillpadDesktop` 来做桩；
 *  - 每个 IPC 的失败都被归一成 `{ok:false, code, error}`，调用方不需要
 *    各自写 try/catch。
 */

import { t } from './i18n.js';

/**
 * 取桌面桥（浏览器里为 null）。
 * @return {object|null}
 */
export function bridge() {
  if (typeof window === 'undefined') return null;
  const b = window.quillpadDesktop;
  return b && typeof b === 'object' ? b : null;
}

/** 是否运行在桌面壳里。 */
export function isDesktop() {
  const b = bridge();
  return !!(b && b.isDesktop);
}

/**
 * 某个桥方法是否可用。
 * @param {string} method
 * @return {boolean}
 */
function has(method) {
  const b = bridge();
  return !!(b && typeof b[method] === 'function');
}

/** 能否在产品链路上直接导出 PDF（决定 PDF 对话框是否置灰分页控件）。 */
export function canExportPdf() {
  return has('exportPdf');
}

/** 能否走主进程打印。 */
export function canPrint() {
  return has('printDocument');
}

/** 能否把字节落到文档同目录的 `assets/`。 */
export function canWriteAsset() {
  return has('writeAsset');
}

/** 能否把外链交给系统浏览器。 */
export function canOpenExternal() {
  return has('openExternal');
}

/** 能否读写宏文件（`%APPDATA%\QuillPad\macros.json`）。 */
export function canPersistMacros() {
  return has('readMacros') && has('writeMacros');
}

/** 能否读本机绝对路径的字节（打印时内联图片用）。 */
export function canReadLocalFile() {
  return has('readFile');
}

/**
 * 能否把文档引用的本地图片读成 data URL。
 *
 * 主窗口由本地 HTTP server 提供，Chromium 禁止从 http 页面加载 `file:///`
 * 资源；只有桌面壳能代读字节，浏览器模式下图片只能走原样 URL（会加载失败）。
 */
export function canReadImage() {
  return has('readImage');
}

/** 能否弹系统目录选择框（导出 PDF 的「浏览…」）。 */
export function canPickDirectory() {
  return has('pickDirectory');
}

/** 能否在系统文件管理器中定位文件（标签右键「打开所在位置」）。 */
export function canRevealInFolder() {
  return has('revealInFolder');
}

/** 能否弹系统「另存为」对话框（桌面壳专有，返回完整绝对路径）。 */
export function canSaveDialog() {
  return has('saveDialog');
}

/**
 * 弹系统「另存为」对话框。
 *
 * 桌面壳里「保存到新位置」必须走这里：File System Access API 的
 * `FileSystemFileHandle` 只有 `name`，拿不到目录，用它的标签会没有绝对路径，
 * 「复制完整路径」「打开所在位置」都会失效。
 *
 * @param {{defaultName?: string, directory?: string}} [payload]
 * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string, error?: string}>}
 */
export function saveDialog(payload) {
  return call('saveDialog', payload || {});
}

/**
 * 统一信封：把桥调用包成 `{ok, ...}`，绝不抛错。
 * @param {string} method
 * @param {...any} args
 * @return {Promise<{ok: boolean, error?: string, code?: string}>}
 */
async function call(method, ...args) {
  const b = bridge();
  const fn = b && b[method];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'ENOBRIDGE', error: t('当前环境不支持该操作（浏览器模式）', 'This operation is unavailable in browser mode') };
  }
  try {
    const result = await fn.apply(b, args);
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, code: 'EIPC', error: (err && err.message) || String(err) };
  }
}

/**
 * 交给主进程导出 PDF（隐藏窗口 + `printToPDF` + 保存对话框）。
 *
 * @param {{html: string, options: object, suggestedName?: string,
 *          filePath?: string|null}} payload
 * @return {Promise<{ok: boolean, path?: string, bytes?: number,
 *                  code?: string, error?: string}>}
 */
export function exportPdf(payload) {
  return call('exportPdf', payload || {});
}

/**
 * 弹系统目录选择框。
 * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string, error?: string}>}
 */
export function pickDirectory() {
  return call('pickDirectory');
}

/**
 * 交给主进程打印（与 PDF 共用同一份打印 HTML）。
 * @param {{html: string, options: object}} payload
 * @return {Promise<{ok: boolean, code?: string, error?: string}>}
 */
export function printDocument(payload) {
  return call('printDocument', payload || {});
}

/**
 * 把字节写入文档同目录的 `assets/`（主进程做路径防护）。
 *
 * @param {{docDir: string, fileName: string, bytes: Uint8Array}} payload
 * @return {Promise<{ok: boolean, path?: string, name?: string,
 *                  code?: string, error?: string}>}
 */
export function writeAsset(payload) {
  return call('writeAsset', payload || {});
}

/**
 * 用系统浏览器打开外链（主进程做协议白名单）。
 * @param {string} url
 * @return {Promise<{ok: boolean, code?: string, error?: string}>}
 */
export function openExternal(url) {
  return call('openExternal', { url: String(url || '') });
}

/**
 * 读本机绝对路径的原始字节（打印时把图片内联成 data URL）。
 * @param {string} filePath
 * @return {Promise<{ok: boolean, bytes?: Uint8Array, name?: string,
 *                  size?: number, code?: string, error?: string}>}
 */
export function readLocalFile(filePath) {
  return call('readFile', String(filePath || ''));
}

/**
 * 把 `file:///…` 或本机绝对图片路径读成可内联的 base64 + mime。
 *
 * WYSIWYG 与分屏预览都用它：主窗口是 http 页面，直接把 `file:///` 交给
 * `<img src>` 会被 Chromium 以 "Not allowed to load local resource" 拒绝。
 * 主进程只放行图片扩展名白名单 + 20MB 上限，不提供任意文件读取能力。
 *
 * @param {string} urlOrPath
 * @return {Promise<{ok: boolean, mime?: string, base64?: string,
 *                   bytes?: number, code?: string, error?: string}>}
 */
export function readImage(urlOrPath) {
  // 注意：IPC handler 收的是 {path|url} 信封，不能直接传裸字符串
  return call('readImage', { url: String(urlOrPath || '') });
}

/**
 * 在系统文件管理器里选中该文件（Explorer / Finder 的「显示简介」等价操作）。
 *
 * @param {string} filePath 本机绝对路径
 * @return {Promise<{ok: boolean, path?: string, code?: string, error?: string}>}
 */
export function revealInFolder(filePath) {
  return call('revealInFolder', { path: String(filePath || '') });
}

/**
 * 读取宏文件。
 * @return {Promise<{ok: boolean, macros?: Array<object>, path?: string,
 *                  code?: string, error?: string}>}
 */
export function readMacros() {
  return call('readMacros');
}

/**
 * 写入宏文件。
 * @param {Array<object>} macros
 * @return {Promise<{ok: boolean, path?: string, code?: string, error?: string}>}
 */
export function writeMacros(macros) {
  return call('writeMacros', Array.isArray(macros) ? macros : []);
}

/**
 * 询问主进程「宏文件在哪」（用于错误提示与调试）。
 * @return {Promise<{ok: boolean, path?: string}>}
 */
export function macrosPath() {
  return call('macrosPath');
}

/**
 * 能力清单（对话框提示条、命令可用性判断共用）。
 * @return {{desktop: boolean, pdf: boolean, print: boolean,
 *           asset: boolean, external: boolean, macros: boolean}}
 */
export function capabilities() {
  return {
    desktop: isDesktop(),
    pdf: canExportPdf(),
    print: canPrint(),
    asset: canWriteAsset(),
    external: canOpenExternal(),
    macros: canPersistMacros(),
    plugins: has('pluginList') && has('pluginInstall'),
  };
}

/* ------------------------------------------------------- v2 三期 · 插件平台 */

/** 是否具备插件安装能力（浏览器模式下市场只读）。 */
export function canManagePlugins() {
  return has('pluginList') && has('pluginInstall');
}

/**
 * 插件相关路径与本地服务地址（沙箱 Worker 的 baseUrl 从这里取）。
 * @return {Promise<object>}
 */
export function pluginRoots() {
  return call('pluginRoots');
}

/**
 * 本地静态服务地址。
 * @return {Promise<{ok: boolean, baseUrl?: string}>}
 */
export function pluginBaseUrl() {
  return call('pluginBaseUrl');
}

/**
 * 已安装插件列表。
 * @return {Promise<{ok: boolean, plugins?: Array<object>}>}
 */
export function pluginList() {
  return call('pluginList');
}

/**
 * 安装 / 更新插件（主进程负责校验与落盘）。
 * @param {object} payload
 * @return {Promise<object>}
 */
export function pluginInstall(payload) {
  return call('pluginInstall', payload || {});
}

/**
 * 卸载插件。
 * @param {string} id
 * @return {Promise<object>}
 */
export function pluginUninstall(id) {
  return call('pluginUninstall', String(id || ''));
}

/**
 * 启用 / 禁用插件。
 * @param {string} id
 * @param {boolean} enabled
 * @param {string} [reason]
 * @return {Promise<object>}
 */
export function pluginEnable(id, enabled, reason = '') {
  return call('pluginEnable', String(id || ''), !!enabled, String(reason || ''));
}

/**
 * 读插件目录内的文件（只用于诊断）。
 * @param {string} id
 * @param {string} rel
 * @return {Promise<object>}
 */
export function pluginRead(id, rel) {
  return call('pluginRead', String(id || ''), String(rel || ''));
}

/**
 * 插件私有 storage 读写。
 * @param {{action?: 'get'|'set', id: string, key?: string, value?: *}} payload
 * @return {Promise<object>}
 */
export function pluginStorage(payload) {
  return call('pluginStorage', payload || {});
}

/**
 * 扫描本机 Notepad++ 插件目录。
 * @param {{paths?: string[]}} [payload]
 * @return {Promise<{ok: boolean, paths?: Array<object>, dirs?: string[], count?: number}>}
 */
export function nppScan(payload) {
  return call('nppScan', payload || {});
}
