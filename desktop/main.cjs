'use strict';

/**
 * QuillPad 桌面壳 · 主进程
 *
 * 设计取舍：
 *  - 不在壳里重写任何编辑能力。前端仍是一份纯浏览器代码，壳只负责
 *    「起本地服务 → 开无边框窗口 → 注入窗口按钮 → 关窗前确认未保存」。
 *  - 用 http://127.0.0.1:<固定端口> 而不是 file://，因为 File System Access API
 *    需要安全上下文，且 IndexedDB 里保存的文件句柄按 origin 隔离 —— 端口固定，
 *    上次关联过的文件在下次启动时才能继续直接写回。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, screen, webContents } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStaticServer, listen } = require('./server.cjs');
const pluginFs = require('./plugin-fs.cjs');
const i18n = require('./i18n.cjs');

// 主进程侧的 t()：与渲染层 `src/core/i18n.js` 同语义（原文即键，英文缺失回落中文）。
// 注意：`t` 每次调用都读模块内当前语言，因此可以直接解构出来用；
// 但**不要**把 t() 的结果存进模块级常量 —— 那样切换语言后不会更新。
const { t } = i18n;

const APP_NAME = 'QuillPad';
const DIST_DIR = path.join(__dirname, '..', 'dist');
const INJECT_FILE = path.join(__dirname, 'inject.js');
const ICON_FILE = path.join(__dirname, '..', 'build', 'icon.png');
const PREFERRED_PORT = 41731;

/**
 * 从命令行参数里挑出「真实存在的文件」。
 *
 * Windows 通过文件关联 / 右键菜单 / 把文件拖到 exe 图标上启动时，
 * 路径会作为普通参数传进来（含空格的路径已被系统加好引号，argv 里是一整项）。
 * 开发模式下 `electron .` 的 "." 不是绝对路径，会被这里过滤掉。
 *
 * @param {string[]} argv
 * @return {string[]} 去重后的绝对路径
 */
function collectFileArgs(argv) {
  const found = [];
  for (const raw of argv || []) {
    if (typeof raw !== 'string' || !raw || raw.startsWith('-')) continue;
    let candidate = raw.trim().replace(/^"(.*)"$/, '$1');
    if (candidate.startsWith('file://')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname);
      } catch {
        continue;
      }
    }
    if (!path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    const absolute = path.resolve(candidate);
    if (!found.includes(absolute)) found.push(absolute);
  }
  return found;
}

/**
 * 读取文本文件，返回原始字节交给渲染层解码。
 * 复用前端同一套 decodeBytes（UTF-8 / BOM / UTF-16 / GBK 回退），
 * 避免壳与页面各写一份编码探测逻辑而产生行为差异。
 *
 * @param {string} filePath
 * @return {Promise<{ok: boolean, error?: string, name?: string, path?: string,
 *   bytes?: Uint8Array, size?: number, modified?: number}>}
 */
async function readTextFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: t('目标不是文件', 'Target is not a file') };
    const bytes = await fs.promises.readFile(filePath);
    return {
      ok: true,
      name: path.basename(filePath),
      path: path.resolve(filePath),
      bytes,
      size: stat.size,
      modified: stat.mtimeMs,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * 写回磁盘。写入前保留原文件的 BOM 约定（由渲染层通过 opts.bom 告知）。
 *
 * @param {string} filePath
 * @param {string} text
 * @param {{bom?: boolean}} [opts]
 * @return {Promise<{ok: boolean, error?: string, size?: number}>}
 */
async function writeTextFile(filePath, text, opts = {}) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: t('目标不是文件', 'Target is not a file') };
    const payload = (opts.bom ? '\uFEFF' : '') + String(text);
    await fs.promises.writeFile(filePath, payload, 'utf8');
    const after = await fs.promises.stat(filePath);
    return { ok: true, size: after.size };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/** 统计「有未保存修改」的标签数，逻辑与渲染层的 isDirty 保持一致。 */
const COUNT_DIRTY = `(() => {
  const tabs = window.quillpad && window.quillpad.state && window.quillpad.state.tabs;
  if (!Array.isArray(tabs)) return 0;
  return tabs.filter((t) => t && (t.content !== t.savedContent ||
    (t.savedEol != null && t.eol !== t.savedEol))).length;
})()`;

// ---------------------------------------------------------------- 便携版数据目录
// 便携版把用户数据放在 exe 旁边，删掉整个文件夹即彻底清除，不留痕。
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  try {
    const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'QuillPad-Data');
    fs.mkdirSync(portableData, { recursive: true });
    app.setPath('userData', portableData);
  } catch {
    // 目录只读（例如放在 Program Files）时回退到默认位置
  }
}

app.setName(APP_NAME);

let mainWindow = null;
let httpServer = null;
let baseUrl = '';
let allowClose = false;
let closePrompting = false;
let injectSource = '';

// 待打开的文件路径：主进程可能比页面早就绪（首次启动），
// 也可能在运行中到达（单实例转发），统一走这个队列，页面 ready 后再冲刷。
let rendererReady = false;
const pendingPaths = [];

/**
 * 把路径排进待打开队列；页面就绪时立即推送。
 * @param {string[]} paths
 */
function queueOpenPaths(paths) {
  if (!paths || !paths.length) return;
  for (const p of paths) {
    if (!pendingPaths.includes(p)) pendingPaths.push(p);
  }
  flushOpenPaths();
}

/** 页面就绪后把队列里的文件一次性推给渲染层。 */
function flushOpenPaths() {
  if (!rendererReady || !pendingPaths.length) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const batch = pendingPaths.splice(0, pendingPaths.length);
  mainWindow.webContents.send('qp:open-paths', batch);
}

// ------------------------------------------------------------------ 窗口几何记忆
/** @return {string} 窗口状态文件路径 */
function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * 读取上次的窗口位置；若落在已拔掉的显示器上则丢弃坐标只保留尺寸。
 * @return {{width?: number, height?: number, x?: number, y?: number, maximized?: boolean}}
 */
function loadWindowState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return {};
  }
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return {};

  if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
      return (
        raw.x + raw.width > a.x + 80 &&
        raw.x < a.x + a.width - 80 &&
        raw.y + raw.height > a.y + 40 &&
        raw.y < a.y + a.height - 40
      );
    });
    if (!onScreen) {
      delete raw.x;
      delete raw.y;
    }
  }
  return raw;
}

let saveTimer = null;

/**
 * 防抖写入窗口几何，避免拖拽过程中频繁落盘。
 * @param {BrowserWindow} win
 */
function scheduleSaveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const bounds = win.getNormalBounds();
      fs.writeFileSync(
        windowStatePath(),
        JSON.stringify({ ...bounds, maximized: win.isMaximized() }),
      );
    } catch {
      // 写盘失败不影响使用
    }
  }, 500);
}

// ------------------------------------------------------------------------ 窗口
/**
 * 创建主窗口。
 * @return {BrowserWindow}
 */
function createWindow() {
  const state = loadWindowState();

  const win = new BrowserWindow({
    width: state.width || 1440,
    height: state.height || 900,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#f4f5f7',
    title: APP_NAME,
    icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (state.maximized) win.maximize();

  // 先隐藏再显示，杜绝白屏闪烁
  win.once('ready-to-show', () => win.show());

  win.on('resize', () => scheduleSaveWindowState(win));
  win.on('move', () => scheduleSaveWindowState(win));
  win.on('maximize', () => {
    scheduleSaveWindowState(win);
    win.webContents.send('qp:maximized', true);
  });
  win.on('unmaximize', () => {
    scheduleSaveWindowState(win);
    win.webContents.send('qp:maximized', false);
  });

  // 任务栏标题固定为应用名，避免带上页面里那串副标题
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // 所有外链都交给系统浏览器，壳内不做导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(baseUrl)) return;
    event.preventDefault();
    // 拖放文件时 Chromium 会尝试导航到 file://，这里只放行 http(s)
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  // 新一轮页面加载开始时先标记未就绪：刷新后要等新页面重新报 ready，
  // 否则待打开文件会推给尚未注册监听的页面而丢失。
  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(injectSource, true).catch((err) => {
      console.warn('[QuillPad] 注入窗口按钮失败：', err && err.message);
    });
  });

  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closePrompting) return;
    void confirmClose(win);
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.loadURL(baseUrl);
  return win;
}

/**
 * 关闭前确认：有未保存内容时给一次挽回机会。
 * @param {BrowserWindow} win
 */
async function confirmClose(win) {
  closePrompting = true;
  let dirty = 0;
  try {
    dirty = await win.webContents.executeJavaScript(COUNT_DIRTY, true);
  } catch {
    dirty = 0;
  }
  closePrompting = false;

  if (!Number.isFinite(dirty) || dirty <= 0) {
    allowClose = true;
    win.close();
    return;
  }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('取消', 'Cancel'), t('不保存，直接退出', "Don't Save and Quit")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: APP_NAME,
    message: t(`有 ${dirty} 个文件还没保存`, `${dirty} unsaved ${dirty === 1 ? 'file' : 'files'}`),
    detail: t(
      '未保存的修改会随会话一起保留，下次启动 QuillPad 时会自动恢复；' +
        '已关联到磁盘的文件，需要在应用里保存才会真正写回磁盘。',
      'Unsaved changes are kept with this session and restored the next time QuillPad starts. ' +
        'Files linked to disk are only written back after you save them in the app.',
    ),
  });

  if (response === 1) {
    allowClose = true;
    win.close();
  }
}

// -------------------------------------------------------------------- 生命周期
async function boot() {
  // 语言必须最先加载：后面所有原生对话框、错误提示都要用它决定文案。
  // 此时 userData 已在模块顶层重定向完成（便携版指向 exe 同目录）。
  i18n.loadLocale(app.getPath('userData'));

  // 任务栏分组 / 通知归属需要稳定的 AppUserModelID（与 NSIS 安装器写入的一致）
  app.setAppUserModelId('com.quillpad.desktop');

  // 权限一律放行：这是本地可信应用，且文件读写依赖这些授权
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  try {
    injectSource = fs.readFileSync(INJECT_FILE, 'utf8');
  } catch {
    injectSource = '';
  }

  httpServer = createStaticServer(DIST_DIR, { pluginsRoot: pluginPaths().pluginsRoot });
  const port = await listen(httpServer, PREFERRED_PORT);
  baseUrl = `http://127.0.0.1:${port}/`;

  Menu.setApplicationMenu(null);
  mainWindow = createWindow();

  // 首次启动时命令行里带的文件（双击关联文件 / 右键菜单 / 把文件拖到图标上）
  queueOpenPaths(collectFileArgs(process.argv));

  // Ctrl+Shift+I / F12 打开开发者工具，方便排查问题
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const devTools = (key === 'i' && input.control && input.shift && !input.alt) || key === 'f12';
    if (devTools && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

/* ==========================================================================
 * v2 · PDF / 打印 / 资源落盘 / 外链 —— 五条 IPC
 *
 * 设计要点（与 ARCH-v2 §4.12 / §2.2 对应）：
 *
 *  - **导出走隐藏 BrowserWindow**，不在主窗口打印：主窗口的屏幕样式、
 *    滚动位置、正在编辑的选区都会被打印流程影响，用户会看到闪一下；
 *    隐藏窗口用完即 `destroy()`，`BrowserWindow.getAllWindows().length`
 *    必须回到 1。
 *  - **打印页是自包含 HTML**：由渲染层生成好整个文档（内联 CSS + base64 字体 +
 *    data URL 图片），主进程只负责「写临时文件 → 加载 → printToPDF」，
 *    不理解任何 Markdown。这样主进程不需要 preload 任何渲染逻辑，
 *    浏览器降级路径也能复用同一份 HTML。
 *  - **为什么用临时文件而不是 `loadURL('data:text/html;base64,…')`**：
 *    7 MB 级别的 data URL 在 Chromium 里会走 URL 长度上限与解析开销，
 *    且 `data:` 文档的 origin 是 null，`@font-face`/`localStorage` 行为与
 *    真实文档不一致；临时文件 + `loadFile` 与"用户打开一个本地 HTML"完全等价，
 *    出问题时还能把同一个文件留下来排查。
 *  - **所有失败都归一成 `{ok:false, code}`**，且把中间 HTML 落到
 *    `<userData>/pdf-debug.html` 供排查（PRD §4.B4）。
 * ========================================================================== */

/** 临时打印页文件名前缀（便于崩溃后人工清理）。 */
const PRINT_TMP_PREFIX = 'quillpad-print-';

/**
 * 生成本次导出用的临时 HTML 路径。
 * @return {string}
 */
function makePrintTempPath() {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `${PRINT_TMP_PREFIX}${Date.now()}-${rand}.html`);
}

/**
 * 把中间 HTML 落到 userData 下，供用户/支持人员排查。
 * @param {string} html
 * @return {string|null} 落盘路径
 */
function dumpPdfDebug(html) {
  try {
    const target = path.join(app.getPath('userData'), 'pdf-debug.html');
    fs.writeFileSync(target, String(html || ''), 'utf8');
    return target;
  } catch (err) {
    console.warn('[QuillPad] 写 pdf-debug.html 失败：', err && err.message);
    return null;
  }
}

/**
 * 在隐藏窗口里跑一段「加载 → 等字体 → printToPDF」的完整流程。
 *
 * @param {string} html 自包含打印 HTML
 * @param {object} options printToPDF 选项
 * @return {Promise<{ok: boolean, buffer?: Buffer, code?: string, error?: string}>}
 */
async function renderPdfInHiddenWindow(html, options) {
  if (typeof html !== 'string' || html.length < 32) {
    return { ok: false, code: 'EHTML', error: t('打印 HTML 为空', 'Print HTML is empty') };
  }

  const tempHtml = makePrintTempPath();
  let win = null;
  try {
    fs.writeFileSync(tempHtml, html, 'utf8');

    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        // 打印页里没有脚本、不需要 preload，沙箱开到最严
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    // 打印页里绝不允许导航或开新窗口
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    await win.loadFile(tempHtml);

    // 等字体真正就绪：不等的话 printToPDF 会用兜底字体排版，中文会走形
    try {
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.size)', true);
    } catch {
      // 字体 API 不可用不阻断导出，只是可能回退系统字体
    }

    const buffer = await win.webContents.printToPDF(options || {});
    return { ok: true, buffer };
  } catch (err) {
    dumpPdfDebug(html);
    return { ok: false, code: 'EPRINTTOPDF', error: (err && err.message) || String(err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.promises.unlink(tempHtml).catch(() => {});
  }
}

/**
 * 决定最终 PDF 落盘路径：显式路径 > 保存对话框。
 *
 * @param {{filePath?: string|null, suggestedName?: string, directory?: string|null}} payload
 * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string, error?: string}>}
 */
async function resolvePdfTarget(payload) {
  const explicit = payload && typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      return { ok: false, code: 'EPATH', error: t('目标路径必须是绝对路径', 'Target path must be absolute') };
    }
    const dir = path.dirname(explicit);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) {
        return { ok: false, code: 'EPATH', error: t('目标目录不存在', 'Target directory does not exist') };
      }
    } catch {
      return { ok: false, code: 'EPATH', error: t('目标目录不存在', 'Target directory does not exist') };
    }
    return { ok: true, path: explicit };
  }

  const fallbackName = t('未命名.pdf', 'Untitled.pdf');
  const suggested = String((payload && payload.suggestedName) || fallbackName);
  const safeName = path.basename(suggested).replace(/[\\/:*?"<>|]/g, '_') || fallbackName;
  const dir = payload && typeof payload.directory === 'string' && path.isAbsolute(payload.directory)
    ? payload.directory
    : app.getPath('documents');
  const defaultPath = path.join(dir, safeName);

  // skipDialog：导出对话框已在前端选定路径，不再弹保存框，直接落盘
  if (payload && payload.skipDialog) {
    return { ok: true, path: defaultPath };
  }

  const res = await dialog.showSaveDialog(mainWindow || undefined, {
    title: t('导出为 PDF', 'Export as PDF'),
    defaultPath,
    filters: [{ name: t('PDF 文档', 'PDF Document'), extensions: ['pdf'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true, code: 'ECANCELED' };
  return { ok: true, path: res.filePath };
}

ipcMain.handle('qp:export-pdf', async (_event, payload) => {
  const data = payload || {};
  const target = await resolvePdfTarget(data);
  if (!target.ok) {
    return { ok: false, canceled: !!target.canceled, code: target.code || 'ECANCELED', error: target.error };
  }
  // 保存对话框在前：用户点了取消就一个字节都不写
  const rendered = await renderPdfInHiddenWindow(data.html, data.options);
  if (!rendered.ok) return { ok: false, code: rendered.code, error: rendered.error };

  try {
    await fs.promises.mkdir(path.dirname(target.path), { recursive: true });
    await fs.promises.writeFile(target.path, rendered.buffer);
    const stat = await fs.promises.stat(target.path);
    return { ok: true, path: target.path, bytes: stat.size };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('qp:pick-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow || undefined, {
    title: t('选择保存目录', 'Choose Save Folder'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) {
    return { ok: false, canceled: true, code: 'ECANCELED' };
  }
  return { ok: true, path: res.filePaths[0] };
});

/** 依据当前文件名猜一组保存过滤器，让对话框默认就停在合适的类型上。 */
function saveDialogFilters(defaultName) {
  const ext = path.extname(String(defaultName || '')).replace(/^\./, '').toLowerCase();
  // 每项写 [中文名, 英文名]，取值时才求值（否则切换语言后过滤器名不会变）
  const known = {
    md: ['Markdown', 'Markdown'],
    markdown: ['Markdown', 'Markdown'],
    txt: ['纯文本', 'Plain Text'],
    log: ['纯文本', 'Plain Text'],
    json: ['JSON', 'JSON'],
    js: ['JavaScript', 'JavaScript'],
    mjs: ['JavaScript', 'JavaScript'],
    cjs: ['JavaScript', 'JavaScript'],
    ts: ['TypeScript', 'TypeScript'],
    css: ['CSS', 'CSS'],
    html: ['HTML', 'HTML'],
    htm: ['HTML', 'HTML'],
    py: ['Python', 'Python'],
    yml: ['YAML', 'YAML'],
    yaml: ['YAML', 'YAML'],
    csv: ['CSV', 'CSV'],
  };
  const list = [];
  if (ext && known[ext]) list.push({ name: t(known[ext][0], known[ext][1]), extensions: [ext] });
  list.push({ name: t('所有文件', 'All Files'), extensions: ['*'] });
  return list;
}

/**
 * 系统「另存为」对话框，返回**完整绝对路径**。
 *
 * 为什么桌面壳必须走这里而不是 File System Access API：
 * FSA 拿到的 `FileSystemFileHandle` 只暴露 `name`（纯文件名），拿不到所在目录。
 * 于是用 FSA 保存出来的标签，`path` 只有「未命名.txt」、`nativePath` 为空，
 * 后续「复制完整路径」会误报「尚未保存到磁盘」、「打开所在位置」被置灰
 * （用户报的两个 bug 是同一个根因）。
 *
 * @param {import('electron').IpcMainInvokeEvent} event
 * @param {{defaultName?: string, directory?: string}} [payload]
 * @return {Promise<{ok: boolean, path?: string, canceled?: boolean, code?: string, error?: string}>}
 */
ipcMain.handle('qp:save-dialog', async (event, payload) => {
  const data = payload || {};
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const fallbackName = t('未命名.txt', 'Untitled.txt');
  const defaultName = String(data.defaultName || fallbackName).trim() || fallbackName;

  let defaultPath = defaultName;
  const dir = String(data.directory || '').trim();
  if (dir && path.isAbsolute(dir)) {
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory()) defaultPath = path.join(dir, defaultName);
    } catch {
      // 目录不存在就用纯文件名，让系统决定起始位置
    }
  }

  try {
    const res = await dialog.showSaveDialog(owner, {
      title: t('另存为', 'Save As'),
      defaultPath,
      filters: saveDialogFilters(defaultName),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (res.canceled || !res.filePath) {
      return { ok: false, canceled: true, code: 'ECANCELED' };
    }
    return { ok: true, path: path.resolve(res.filePath) };
  } catch (err) {
    return { ok: false, code: 'EDIALOG', error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('qp:print', async (_event, payload) => {
  const data = payload || {};
  const tempHtml = makePrintTempPath();
  let win = null;
  try {
    fs.writeFileSync(tempHtml, String(data.html || ''), 'utf8');
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(tempHtml);
    try {
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => 1)', true);
    } catch {
      // 同导出：字体 API 不可用不阻断
    }
    const printed = await new Promise((resolve) => {
      let settled = false;
      win.webContents.print(
        {
          silent: false,
          printBackground: !!(data.options && data.options.printBackground),
          landscape: !!(data.options && data.options.landscape),
          pageSize: data.options && data.options.pageSize,
        },
        (success, reason) => {
          if (settled) return;
          settled = true;
          resolve({ success, reason });
        },
      );
      // print() 的回调在部分平台上不会触发；3 秒后兜底返回「已提交」
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ success: true, reason: 'submitted' });
      }, 3000);
    });
    return printed.success ? { ok: true } : { ok: false, code: 'EPRINT', error: printed.reason || t('打印失败', 'Print failed') };
  } catch (err) {
    dumpPdfDebug(data.html);
    return { ok: false, code: 'EPRINT', error: (err && err.message) || String(err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.promises.unlink(tempHtml).catch(() => {});
  }
});

/**
 * 把字节写到「文档同目录的 assets/」。
 *
 * 路径防护（三层，缺一不可）：
 *  1. `docDir` 必须是绝对路径且是目录；
 *  2. `fileName` 只取 basename，禁 `..`、禁路径分隔符、禁绝对路径；
 *  3. 拼出的目标 `path.resolve` 后必须仍在 `assets/` 之内（防符号链接/大小写绕过）；
 *  4. 同名已存在时追加随机后缀，绝不覆盖用户已有文件。
 *
 * @param {{docDir: string, fileName: string, bytes: Uint8Array|ArrayBuffer}} payload
 * @return {Promise<{ok: boolean, path?: string, name?: string, code?: string, error?: string}>}
 */
ipcMain.handle('qp:write-asset', async (_event, payload) => {
  const data = payload || {};
  const docDir = typeof data.docDir === 'string' ? data.docDir.trim() : '';
  if (!docDir || !path.isAbsolute(docDir)) {
    return { ok: false, code: 'EPATH', error: t('文档目录不合法', 'Document folder is invalid') };
  }

  const rawName = String(data.fileName || '').trim();
  if (!rawName || rawName.includes('..') || /[\\/]/.test(rawName) || path.isAbsolute(rawName)) {
    return { ok: false, code: 'EPATH', error: t('文件名不合法', 'File name is invalid') };
  }
  const baseName = path.basename(rawName);
  if (!baseName || baseName === '.' || baseName === '..') {
    return { ok: false, code: 'EPATH', error: t('文件名不合法', 'File name is invalid') };
  }

  const assetsDir = path.join(docDir, 'assets');
  const target = path.resolve(assetsDir, baseName);
  const guard = path.resolve(assetsDir) + path.sep;
  if (!target.startsWith(guard)) {
    return { ok: false, code: 'EPATH', error: t('目标路径越界', 'Target path escapes the assets folder') };
  }

  try {
    const stat = await fs.promises.stat(docDir);
    if (!stat.isDirectory()) {
      return { ok: false, code: 'EPATH', error: t('文档目录不存在', 'Document folder does not exist') };
    }
  } catch {
    return { ok: false, code: 'EPATH', error: t('文档目录不存在', 'Document folder does not exist') };
  }

  const bytes = data.bytes;
  if (!bytes || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
    return { ok: false, code: 'EBYTES', error: t('没有拿到图片字节', 'No image bytes received') };
  }
  const buf = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
  if (!buf.length) return { ok: false, code: 'EBYTES', error: t('图片内容为空', 'Image content is empty') };

  try {
    await fs.promises.mkdir(assetsDir, { recursive: true });

    // 同名文件存在 → 追加随机后缀，绝不覆盖
    let finalPath = target;
    let finalName = baseName;
    let exists = true;
    try {
      await fs.promises.access(finalPath, fs.constants.F_OK);
    } catch {
      exists = false;
    }
    if (exists) {
      const dot = baseName.lastIndexOf('.');
      const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
      const ext = dot > 0 ? baseName.slice(dot) : '';
      const rand = Math.random().toString(36).slice(2, 6);
      finalName = `${stem}-${rand}${ext}`;
      finalPath = path.resolve(assetsDir, finalName);
    }

    await fs.promises.writeFile(finalPath, buf);
    return { ok: true, path: finalPath, name: finalName };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
});

/**
 * 读应用自带资源（供打印内联字体使用）。
 *
 * 为什么需要它：打包后页面跑在 `file://` 上，Chromium 禁止 `fetch(file:…)`
 * （同源策略把 file 源当不透明源），于是 `@font-face` 里的字体 URL 读不到，
 * 打印稿会静默退回系统字体 —— 字体包白打进去。这里由主进程读盘解决。
 *
 * 路径防护：只允许读 `app.getAppPath()` 之内的文件。既能拿到 `dist/assets/**`，
 * 也挡住渲染层被注入后拿它当任意文件读取器（比如 %USERPROFILE%\.ssh\id_rsa）。
 *
 * @param {{url?: string, path?: string}} payload 资源 URL（`file:///…`）或绝对路径
 * @return {Promise<{ok: boolean, base64?: string, bytes?: number, code?: string, error?: string}>}
 */
ipcMain.handle('qp:read-asset', async (_event, payload) => {
  const raw = String((payload && (payload.path || payload.url)) || '').trim();
  if (!raw) return { ok: false, code: 'EPATH', error: t('资源路径为空', 'Resource path is empty') };

  let filePath = raw;
  if (/^file:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      filePath = decodeURIComponent(parsed.pathname);
      // Windows 上 pathname 形如 /D:/dir/f.ttf，去掉前导斜杠才是盘符路径
      if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
    } catch {
      return { ok: false, code: 'EPATH', error: t('资源路径解析失败', 'Failed to parse the resource path') };
    }
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, code: 'EPATH', error: t('资源路径必须是绝对路径', 'Resource path must be absolute') };
  }

  const root = path.resolve(app.getAppPath());
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { ok: false, code: 'EPATH', error: t('资源不在应用目录内', 'Resource is outside the application folder') };
  }

  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) return { ok: false, code: 'EPATH', error: t('目标不是文件', 'Target is not a file') };
    if (stat.size > 32 * 1024 * 1024) {
      return { ok: false, code: 'ETOOBIG', error: t('资源过大', 'Resource is too large') };
    }
    const buf = await fs.promises.readFile(target);
    return { ok: true, base64: buf.toString('base64'), bytes: buf.length };
  } catch (err) {
    return { ok: false, code: 'EREAD', error: (err && err.message) || String(err) };
  }
});

/** 允许读成 data URL 的图片扩展名。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/**
 * 把文档里的本地图片读成 data URL。
 *
 * 主窗口由本地 HTTP server 提供（`win.loadURL(baseUrl)`），Chromium 会拒绝
 * 从 http 页面加载 `file:///` 资源（"Not allowed to load local resource"），
 * 所以 WYSIWYG 与分屏预览里的相对路径图片都会掉进「图片未能加载」占位。
 * 与主进程读字体用的 `qp:read-asset` 不同：图片可能在用户文档所在目录，
 * 不能限制在 app.getAppPath() 内，因此改用「扩展名白名单 + 大小上限」防护，
 * 且只返回字节给渲染层做 `<img src>`，不暴露任意文件读取能力。
 *
 * @param {{url?: string, path?: string}} payload `file:///…` 或绝对路径
 * @return {Promise<{ok: boolean, mime?: string, base64?: string, bytes?: number,
 *   code?: string, error?: string}>}
 */
ipcMain.handle('qp:read-image', async (_event, payload) => {
  const raw = String((payload && (payload.path || payload.url)) || '').trim();
  if (!raw) return { ok: false, code: 'EPATH', error: t('图片路径为空', 'Image path is empty') };

  let filePath = raw;
  if (/^file:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      filePath = decodeURIComponent(parsed.pathname);
      if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
    } catch {
      return { ok: false, code: 'EPATH', error: t('图片路径解析失败', 'Failed to parse the image path') };
    }
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, code: 'EPATH', error: t('图片路径必须是绝对路径', 'Image path must be absolute') };
  }
  const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
  if (!mime) return { ok: false, code: 'EEXT', error: t('不是支持的图片格式', 'Unsupported image format') };

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, code: 'EPATH', error: t('目标不是文件', 'Target is not a file') };
    if (stat.size > 20 * 1024 * 1024) {
      return { ok: false, code: 'ETOOBIG', error: t('图片过大（上限 20MB）', 'Image is too large (20 MB limit)') };
    }
    const buf = await fs.promises.readFile(filePath);
    return { ok: true, mime, base64: buf.toString('base64'), bytes: buf.length };
  } catch (err) {
    return { ok: false, code: 'EREAD', error: (err && err.message) || String(err) };
  }
});

/**
 * 在系统文件管理器里定位文件（标签右键「打开所在位置」）。
 *
 * 三件套里只有桌面壳能做这件事：`shell.showItemInFolder` 会打开资源管理器并
 * 选中该文件。路径先做 `file:///` 归一与绝对路径校验，避免把任意字符串丢给系统。
 */
ipcMain.handle('qp:reveal-in-folder', async (_event, payload) => {
  const raw = String((payload && (payload.path || payload.url)) || '').trim();
  if (!raw) return { ok: false, code: 'EPATH', error: t('路径为空', 'Path is empty') };

  let filePath = raw;
  if (/^file:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      filePath = decodeURIComponent(parsed.pathname);
      if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
    } catch {
      return { ok: false, code: 'EPATH', error: t('路径解析失败', 'Failed to parse the path') };
    }
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, code: 'EPATH', error: t('路径必须是绝对路径', 'Path must be absolute') };
  }

  try {
    await fs.promises.access(filePath);
  } catch {
    return { ok: false, code: 'ENOENT', error: t('文件不存在或已被移动', 'The file no longer exists or has been moved') };
  }

  shell.showItemInFolder(filePath);
  return { ok: true, path: filePath };
});

/**
 * 交给系统打开外链。
 *
 * 协议白名单：只放行 `http:` / `https:` / `mailto:`；`file:` 需要二次确认
 * （点了"打开"才执行），其余协议一律 `EPROTO` 拒绝 —— 绝不能把渲染层传来的
 * 任意字符串丢给 `shell.openExternal`，那是本地代码执行的常见入口。
 */
ipcMain.handle('qp:open-external', async (event, payload) => {
  const raw = String((payload && payload.url) || '').trim();
  if (!raw) return { ok: false, code: 'EPROTO', error: t('链接为空', 'Link is empty') };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: 'EPROTO', error: t('链接格式不合法', 'Link format is invalid') };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
    try {
      await shell.openExternal(raw);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'EOPEN', error: (err && err.message) || String(err) };
    }
  }

  if (protocol === 'file:') {
    let filePath = '';
    try {
      filePath = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
      if (/^[a-zA-Z]:/.test(filePath) === false) filePath = decodeURIComponent(parsed.pathname);
    } catch {
      return { ok: false, code: 'EPROTO', error: t('文件路径解析失败', 'Failed to parse the file path') };
    }
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return { ok: false, code: 'EPATH', error: t('目标不是文件', 'Target is not a file') };
    } catch {
      return { ok: false, code: 'EPATH', error: t('文件不存在', 'File not found') };
    }
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const { response } = await dialog.showMessageBox(owner || undefined, {
      type: 'warning',
      buttons: [t('取消', 'Cancel'), t('用系统程序打开', 'Open with System App')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: APP_NAME,
      message: t('要打开本地文件吗？', 'Open this local file?'),
      detail: t(
        `${filePath}\n\n这会用系统关联的程序打开该文件。请确认来源可信。`,
        `${filePath}\n\nThis will open the file with the app associated on your system. Make sure you trust its source.`,
      ),
    });
    if (response !== 1) return { ok: false, code: 'ECANCELED', error: t('用户取消', 'Canceled by the user') };
    const errMsg = await shell.openPath(filePath);
    return errMsg ? { ok: false, code: 'EOPEN', error: errMsg } : { ok: true };
  }

  return { ok: false, code: 'EPROTO', error: t(`不允许的协议：${protocol}`, `Protocol not allowed: ${protocol}`) };
});

/* ------------------------------------------------------------------ 宏持久化 */

/** 宏文件路径（便携版已被上方重定向到 exe 同目录）。 */
function macrosFile() {
  return path.join(app.getPath('userData'), 'macros.json');
}

/**
 * 应用语言设置并把新语言广播给其它窗口。
 *
 * 渲染层切换语言时同步过来：原生对话框不读 DOM，语言必须单独持久化。
 * 只广播给**其它**窗口 —— 发起切换的那个窗口会自己重绘，再回送一次会造成
 * 「setLocale → 广播 → setLocale」的自我循环。
 *
 * @param {unknown} locale 目标语言（脏值由 i18n 归一化后回落中文）
 * @param {number} senderId 发起切换的 webContents id
 * @return {string} 当前生效的语言码
 */
function applyLocale(locale, senderId) {
  const next = i18n.setLocale(app.getPath('userData'), locale);
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.id === senderId) continue;
    try {
      wc.send('app:locale-changed', next);
    } catch {
      // 窗口正在关闭：忽略，它重启时会从 locale.json 读到正确语言
    }
  }
  return next;
}

/**
 * 渲染层切换界面语言时同步过来：原生对话框不读 DOM，语言必须单独持久化，
 * 同时把新语言广播给其它窗口（preload 的 onLocaleChange 负责接收）。
 *
 * 只保留 `app:set-locale` 这一个入口：渲染层唯一要调的 API 是
 * `window.quillpadDesktop.setLocale()`，多一个并存通道只会变成两套真相。
 */
ipcMain.handle('app:set-locale', (event, locale) => ({
  ok: true,
  locale: applyLocale(locale, event.sender.id),
}));
/** 启动时读取主进程当前语言（渲染层可据此对齐自己持久化下来的选择）。 */
ipcMain.handle('app:get-locale', () => ({ ok: true, locale: i18n.getLocale() }));

ipcMain.handle('qp:macros-path', () => ({ ok: true, path: macrosFile() }));

ipcMain.handle('qp:read-macros', async () => {
  const file = macrosFile();
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const macros = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.macros)
        ? parsed.macros
        : [];
    return { ok: true, macros, path: file };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, macros: [], path: file };
    // 文件坏了不能让应用起不来：返回空表，让上层覆盖写
    console.warn('[QuillPad] 读取宏失败：', err && err.message);
    return { ok: true, macros: [], path: file, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('qp:write-macros', async (_event, macros) => {
  const list = Array.isArray(macros) ? macros : [];
  // 只接受「命令 id + 参数 + 选区」这种纯数据，防止渲染层塞函数/原型污染
  const clean = list.slice(0, 200).map((m) => ({
    id: String((m && m.id) || ''),
    name: String((m && m.name) || t('未命名宏', 'Untitled Macro')).slice(0, 120),
    createdAt: Number((m && m.createdAt) || Date.now()),
    version: 1,
    steps: (Array.isArray(m && m.steps) ? m.steps : []).slice(0, 2000).map((s) => ({
      cmd: String((s && s.cmd) || ''),
      args: s && s.args && typeof s.args === 'object' ? s.args : undefined,
      sel: s && s.sel && typeof s.sel === 'object' ? { anchor: Number(s.sel.anchor) || 0, head: Number(s.sel.head) || 0 } : null,
      delay: Number(s && s.delay) || 0,
    })),
  }));
  const file = macrosFile();
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify({ version: 1, macros: clean }, null, 2), 'utf8');
    return { ok: true, path: file, count: clean.length };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
});

/* ------------------------------------------------------------------ 插件平台 IPC */

/**
 * 插件相关路径（便携版自动跟随上面的 userData 重定向）。
 * @return {{userData: string, pluginsRoot: string, stateFile: string, storageRoot: string}}
 */
function pluginPaths() {
  const userData = app.getPath('userData');
  return {
    userData,
    pluginsRoot: path.join(userData, 'plugins'),
    stateFile: path.join(userData, 'plugins-state.json'),
    storageRoot: path.join(userData, 'plugin-storage'),
  };
}

/**
 * 把渲染层传来的文件内容转成 Buffer 数组。
 * @param {Array<{name: string, base64?: string, text?: string}>} list
 * @return {Array<{name: string, bytes: Buffer}>}
 */
function decodeFiles(list) {
  return (Array.isArray(list) ? list : []).map((f) => ({
    name: String(f.name || ''),
    bytes: f.base64 ? Buffer.from(String(f.base64), 'base64') : Buffer.from(String(f.text || ''), 'utf8'),
  }));
}

/**
 * 从唯一真源模板生成插件引导脚本（安装时写进 `__qp_bootstrap.js`）。
 * @param {object} manifest
 * @return {string}
 */
function buildPluginBootstrap(manifest) {
  const template = fs.readFileSync(path.join(__dirname, 'plugin-prelude.txt'), 'utf8');
  const mainFile = `./${String(manifest.main || 'main.js').replace(/^\.\//, '')}`;
  return template
    .replace('__QP_ID_JSON__', JSON.stringify(String(manifest.id)))
    .replace('__QP_MAIN_JSON__', JSON.stringify(mainFile));
}

ipcMain.handle('qp:plugin-roots', () => ({ ok: true, ...pluginPaths(), baseUrl }));

ipcMain.handle('qp:plugin-base-url', () => ({ ok: true, baseUrl }));

ipcMain.handle('qp:plugin-list', () => {
  const p = pluginPaths();
  return { ok: true, plugins: pluginFs.listPlugins(p.pluginsRoot, p.stateFile), ...p };
});

/**
 * 安装插件：schema → License → engines → 静态扫描 → sha256 → 安全落盘。
 * 任何一步失败都不写盘（G5-3 / G5-12 / G5-13）。
 */
ipcMain.handle('qp:plugin-install', async (_event, payload) => {
  const p = pluginPaths();
  const data = payload || {};
  let zipBytes = null;
  let files = [];

  try {
    if (data.zipBase64) {
      zipBytes = Buffer.from(String(data.zipBase64), 'base64');
      const parsed = pluginFs.parseZip(zipBytes);
      if (!parsed.ok) return parsed;
      files = parsed.files;
    } else if (Array.isArray(data.files)) {
      files = decodeFiles(data.files);
    } else {
      return { ok: false, code: 'EINVALID', error: t('没有可安装的内容', 'Nothing to install') };
    }

    // 路径穿越：在写任何文件之前统一挡一次
    for (const f of files) {
      if (String(f.name).endsWith('/')) continue;
      if (!pluginFs.isSafeEntryName(f.name)) {
        return {
          ok: false,
          code: 'EPATH',
          error: t(`安装包包含非法路径：${f.name}`, `Package contains an illegal path: ${f.name}`),
        };
      }
    }

    const manifestFile = files.find((f) => String(f.name).replace(/^\.\//, '') === 'plugin.json');
    if (!manifestFile) {
      return { ok: false, code: 'ESCHEMA', error: t('安装包缺少 plugin.json', 'Package is missing plugin.json') };
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    } catch {
      return { ok: false, code: 'ESCHEMA', error: t('plugin.json 不是合法 JSON', 'plugin.json is not valid JSON') };
    }
    const checked = pluginFs.validateInstallManifest(manifest, app.getVersion());
    if (!checked.ok) return checked;

    // 静态扫描所有 js/mjs（含 main 与相对 import 的 lib）
    for (const f of files) {
      if (!/\.(js|mjs)$/i.test(String(f.name)) || String(f.name).startsWith('__qp_')) continue;
      const scanned = pluginFs.scanSource(f.bytes.toString('utf8'), String(f.name));
      if (!scanned.ok) return scanned;
    }

    const state = pluginFs.readState(p.stateFile);
    const old = state[manifest.id];
    const isUpdate = !!old;
    if (isUpdate && String(data.update) !== 'true' && String(data.force) !== 'true') {
      return { ok: false, code: 'EEXISTS', error: t('同 id 已安装，请使用更新流程', 'A plugin with this id is already installed. Use the update flow.') };
    }
    if (isUpdate && pluginFs.compareLess(String(manifest.version), String(old.version || ''))) {
      return { ok: false, code: 'EEXISTS', error: t('已安装更高版本', 'A newer version is already installed') };
    }

    const res = pluginFs.installPlugin({
      pluginsRoot: p.pluginsRoot,
      stateFile: p.stateFile,
      manifest,
      bootstrap: buildPluginBootstrap(manifest),
      zipBytes,
      files: zipBytes ? undefined : files,
      expectedSha256: String(data.expectedSha256 || ''),
      update: isUpdate,
    });
    if (!res.ok) return res;
    return { ok: true, id: res.id, dir: res.dir, version: res.version, sha256: res.sha256, manifest, baseUrl };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('qp:plugin-uninstall', (_event, id) => {
  const p = pluginPaths();
  return pluginFs.uninstallPlugin(p.pluginsRoot, p.stateFile, p.storageRoot, String(id || ''));
});

ipcMain.handle('qp:plugin-enable', (_event, id, enabled, reason) => {
  const p = pluginPaths();
  return pluginFs.setEnabled(p.stateFile, String(id || ''), !!enabled, String(reason || ''));
});

ipcMain.handle('qp:plugin-read', (_event, id, rel) => {
  const p = pluginPaths();
  return pluginFs.readPluginFile(p.pluginsRoot, String(id || ''), String(rel || ''));
});

ipcMain.handle('qp:plugin-storage', (_event, payload) => {
  const p = pluginPaths();
  const data = payload || {};
  const id = String(data.id || '');
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(id)) {
    return { ok: false, code: 'ESCHEMA', error: t('插件 id 不合法', 'Plugin id is invalid') };
  }
  if (data.action === 'set') {
    return pluginFs.storageSet(p.storageRoot, id, String(data.key || ''), data.value);
  }
  const all = pluginFs.storageGet(p.storageRoot, id);
  return { ok: true, value: data.key ? all[String(data.key)] : all };
});

/**
 * 扫描本机 Notepad++ 插件目录（G5-7 / G5-8）。
 * 路径可由 QA 传入覆盖；目录不存在返回空状态而不是报错。
 */
ipcMain.handle('qp:npp-scan', (_event, payload) => {
  const override = payload && Array.isArray(payload.paths) ? payload.paths : null;
  const candidates = override || [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Notepad++', 'plugins'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Notepad++', 'plugins'),
    path.join(app.getPath('appData'), 'Notepad++', 'plugins'),
  ];
  const paths = [];
  const dirs = [];
  for (const raw of candidates) {
    const dir = String(raw || '');
    let exists = false;
    const children = [];
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        exists = true;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const isDll = /\.dll$/i.test(entry.name);
          if (entry.isDirectory() || isDll) {
            const name = entry.name.replace(/\.dll$/i, '');
            children.push(name);
            if (!dirs.includes(name)) dirs.push(name);
          }
        }
      }
    } catch {
      exists = false;
    }
    paths.push({ path: dir, exists, children });
  }
  return { ok: true, paths, dirs, count: dirs.length };
});

ipcMain.on('qp:renderer-ready', () => {
  rendererReady = true;
  flushOpenPaths();
});
ipcMain.handle('qp:read-file', (_event, filePath) => readTextFile(String(filePath || '')));

ipcMain.handle('qp:write-file', (_event, filePath, text, opts) =>
  writeTextFile(String(filePath || ''), String(text ?? ''), opts || {}),
);

ipcMain.on('qp:window', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'toggle-maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
});

ipcMain.handle('qp:is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return Boolean(win && win.isMaximized());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // 已经开着时，用户在资源管理器里再右键 / 双击一个文件：
    // 新进程拿到路径后立刻退出，由这里转交给已有窗口打开。
    queueOpenPaths(collectFileArgs(argv));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox(t('QuillPad 启动失败', 'QuillPad failed to start'), String((err && err.stack) || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

app.on('will-quit', () => {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
});
