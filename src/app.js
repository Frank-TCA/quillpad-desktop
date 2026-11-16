/**
 * QuillPad · 应用装配
 *
 * 这里是唯一的「协调层」：把状态、编辑器、各个 UI 模块和命令注册表接在一起。
 * 所有具体能力（新建 / 保存 / 搜索 / 主题…）都通过命令注册表暴露，
 * 保证菜单、工具栏、快捷键、命令面板四条入口行为完全一致。
 */

import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/wysiwyg.css';
import './styles/plugins.css';

import {
  state,
  bus,
  addTab,
  removeTab,
  activateTab as setActiveId,
  getTab,
  activeTab,
  isDirty,
  setTabs,
  nextTabId,
  BIG_FILE_THRESHOLD,
} from './core/state.js';
import { registerCommands } from './core/actions.js';
import {
  runCommand,
  resetCommands,
  allCommands,
  getCommand,
  defineCommand,
} from './core/commands.js';
import {
  t,
  setLocale,
  getLocale,
  normalizeLocale,
  LOCALE_LABELS,
} from './core/i18n.js';
import { loadSettings, saveSettings, pickSettings, clamp, FONT_SIZE_MIN, FONT_SIZE_MAX, fontStepFor, SIDEBAR_MIN, SIDEBAR_MAX } from './core/settings.js';
import {
  loadSession,
  saveSession,
  getFileHandle,
  getDirHandle,
  putFileHandle,
  putDirHandle,
  deleteDirHandle,
  newHandleKey,
  ensurePermission,
} from './core/persist.js';
import {
  supportsFsa,
  pickOpenFiles,
  pickSaveFile,
  pickDirectory,
  pickFilesLegacy,
  readFileHandle,
  readFileObject,
  writeFileHandle,
  downloadText,
  toEol,
  detectEol,
  decodeBytes,
  filesFromDataTransfer,
} from './core/fs.js';
import { installKeyHandler, buildCmKeymap } from './core/keys.js';
import { guessLanguage, isMarkdown, languageLabel, codeTagLabel, resolveLangId } from './editor/languages.js';
import { highlightCode } from './core/code-highlight.js';
import {
  effectiveViewMode,
  nextViewMode,
  isHardLimited,
  shouldDegrade,
  countLines,
} from './editor/viewmode.js';
import { createWysiwygExtension } from './editor/wysiwyg/index.js';
import { createAidsExtension } from './editor/focus.js';
import { createFrameMeter } from './editor/wysiwyg/perf.js';
import { createMinimap } from './ui/minimap.js';
import { insertMarkdownImage } from './editor/wysiwyg/image.js';
import { closeCellEditor as closeTableCellEditor } from './editor/wysiwyg/table.js';
import { THEMES, getThemeSyntaxPalette } from './editor/cm-themes.js';
import { EditorManager } from './editor/editor.js';
import { initMenubar } from './ui/menubar.js';
import { initEditorContextMenu } from './ui/editor-contextmenu.js';
import { initTabs } from './ui/tabs.js';
import { initSidebar } from './ui/sidebar.js';
import { initStatusbar } from './ui/statusbar.js';
import { initToolbar } from './ui/toolbar.js';
import { initViewSwitch } from './ui/viewswitch.js';
import { initPluginUI } from './ui/plugin-panel.js';
import { initPalette } from './ui/palette.js';
import { initWelcome } from './ui/welcome.js';
import { initTooltips } from './ui/tooltip.js';
import { FindInFilesPanel } from './ui/findbar.js';
import { dismissTopModal, hasModal, confirmClose, newFileDialog } from './ui/dialogs.js';
import { toast } from './ui/toast.js';
import { renderMarkdown } from './core/markdown.js';
import { resolveImageUrl } from './editor/wysiwyg/image.js';
import { isLocalImageUrl, loadImageSrc } from './editor/wysiwyg/image-src.js';
import * as printPipeline from './core/print.js';
import * as desktopBridge from './core/desktop.js';
import * as pluginHost from './core/plugins/host.js';
import { debounce } from './core/utils.js';
import { welcomeMarkdown, isWelcomeTemplate, WELCOME_NAMES } from './samples.js';
import { icon } from './ui/icons.js';

/** 单个文件读取上限（字节）。 */
const MAX_FILE_SIZE = 24 * 1024 * 1024;

/** 判断是否是可识别为代码的语言。 */
const TEXT_LANGS = new Set(['plaintext', 'markdown']);

/**
 * 写入剪贴板（`navigator.clipboard` 不可用时回退 `execCommand`）。
 * @param {string} text
 * @return {Promise<boolean>}
 */
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 创建并初始化应用。
 * @return {Promise<object>}
 */
export async function createApp() {
  const el = {
    app: document.getElementById('app'),
    titlebar: document.getElementById('titlebar'),
    title: document.getElementById('titlebar-title'),
    titleActions: document.getElementById('titlebar-actions'),
    menubar: document.getElementById('menubar'),
    toolbar: document.getElementById('toolbar'),
    workspace: document.getElementById('workspace'),
    sidebar: document.getElementById('sidebar'),
    sidebarResizer: document.getElementById('sidebar-resizer'),
    editorHost: document.getElementById('editor-host'),
    editorPane: document.getElementById('editor-pane'),
    editorSplit: document.getElementById('editor-split'),
    tabbar: document.getElementById('tabbar'),
    preview: document.getElementById('preview-pane'),
    findFiles: document.getElementById('find-files'),
    statusbar: document.getElementById('statusbar'),
    welcome: document.getElementById('welcome'),
    brandLogo: document.getElementById('brand-logo'),
  };

  const app = {
    el,
    state,
    savingTabs: new Set(),
    lastCursor: { line: 1, column: 1, selectionLength: 0, lines: 0, chars: 0 },
  };

  /* 语言必须在「任何 UI 渲染 / 命令注册」之前定下来：菜单项、命令标题、
   * 工具栏 tooltip 都是注册时就把 t() 的结果写死的。
   * main.js 的 boot() 里也做了一次（给致命错误页用），这里再按磁盘设置
   * 校准一次，保证 createApp() 被测试脚本直接调用时语言同样正确。 */
  const initialSettings = loadSettings();
  setLocale(initialSettings.locale);

  /* index.html 里的静态文案没法用 t()，启动时与切换语言时由 JS 覆写一遍。
   * <html lang> 由 i18n.js 的 setLocale() 负责，这里只管 title / aria-label。 */
  const applyStaticLabels = () => {
    // 有活动标签时 document.title 由 updateTitle() 写成「文件名 — QuillPad」，
    // 不能用产品标语盖掉；产品标语只在没有标签时作为页面标题出现。
    if (!activeTab()) {
      document.title = t(
        'QuillPad · 现代文本与代码编辑器',
        'QuillPad — A modern text and code editor',
      );
    }
    const labels = [
      ['menubar', t('主菜单', 'Main menu')],
      ['toolbar', t('工具栏', 'Toolbar')],
      ['sidebar', t('侧边栏', 'Sidebar')],
      ['tabbar', t('已打开文件', 'Open files')],
    ];
    for (const [id, label] of labels) {
      const node = document.getElementById(id);
      if (node) node.setAttribute('aria-label', label);
    }
  };
  applyStaticLabels();

  app.toast = toast;
  app.supportsFsa = supportsFsa();

  /* ------------------------------------------------------------ 编辑器实例 */

  app.editor = new EditorManager(el.editorHost, {
    onChange: (tabId, content) => handleContentChange(tabId, content),
    onCursor: (info) => {
      app.lastCursor = info;
      app.statusbar.setCursor(info);
      // T09：大纲跟随光标（300ms 防抖）+ 迷你地图视口刷新
      if (app.sidebar && typeof app.sidebar.syncActiveHeading === 'function') {
        app.sidebar.syncActiveHeading(info.line);
      }
      if (app.minimap) app.minimap.update();
    },
  });

  /* -------------------------------------------------------------- 子模块 */

  // 注意：命令必须先于任何「会读取命令标题」的 UI 初始化。
  // 工具栏 / 标题栏按钮在渲染时会把命令标题写进 data-tip 与 aria-label，
  // 若此时注册表为空，tooltip 会退化成原始命令 id（形如 file.new）。
  registerCommands(app);

  app.sidebar = initSidebar(el.sidebar, el.sidebarResizer, app);
  app.statusbar = initStatusbar(el.statusbar, app);
  app.tabsView = initTabs(el.tabbar, app);
  app.palette = initPalette(app);
  app.welcome = initWelcome(el.welcome, app);
  app.findInFiles = new FindInFilesPanel(el.findFiles, app);
  app.toolbar = initToolbar(el.toolbar, el.titleActions, app);
  const viewSwitchHost = el.toolbar.querySelector('#toolbar-viewswitch');
  app.viewSwitch = viewSwitchHost ? initViewSwitch(viewSwitchHost, app) : null;

  el.brandLogo.innerHTML = icon('feather', 13);

  /* -------------------------------------------------------------- 设置应用 */

  const settings = initialSettings;
  /** v2：完整设置对象（含 decorations / pdf / macro / plugins 四组嵌套） */
  app.settings = settings;

  // 主进程读不到 localStorage，语言另存一份到 <userData>/locale.json。
  // 启动时同步一次，否则重启后系统原生对话框会退回中文。
  try {
    const desktopLocaleReady = window.quillpadDesktop?.setLocale?.(settings.locale);
    if (desktopLocaleReady && typeof desktopLocaleReady.catch === 'function') {
      desktopLocaleReady.catch((err) => {
        console.warn('[QuillPad] 启动时同步界面语言失败：', err);
      });
    }
    // 多窗口：别的窗口切换语言时跟随（发起方不会收到自己的广播，
    // 且 applyLocale 对同语言直接 return，不会形成来回广播）。
    window.quillpadDesktop?.onLocaleChange?.((locale) => {
      const next = normalizeLocale(locale);
      if (next === getLocale()) return;
      if (typeof app.applyLocale === 'function') void app.applyLocale(next);
    });
  } catch (err) {
    console.warn('[QuillPad] 桌面语言桥不可用：', err);
  }

  // 浅色成为默认主题：从没主动选过主题的老用户（存的是旧默认 aurora）
  // 迁移到新的默认值，避免「装了新版本还是黑底」。显式选过的保持不动。
  state.themePinned = !!settings.themePinned;
  state.theme = !state.themePinned && settings.theme === 'aurora' ? 'ivory' : settings.theme;
  state.fontSize = settings.fontSize;
  state.wordWrap = settings.wordWrap;
  state.sidebarVisible = settings.sidebarVisible;
  state.sidebarWidth = settings.sidebarWidth;
  state.sidebarTab = settings.sidebarTab;
  state.autoSave = settings.autoSave;
  state.indentSize = settings.indentSize;
  state.useTabs = settings.useTabs;

  /* v2 视图模式与交互偏好 */
  state.viewModePreference = settings.viewMode;
  state.viewModeLocked = settings.viewModeLocked;
  state.reduceMotion = settings.reduceMotion;
  state.focusMode = !!settings.decorations.focusMode;
  state.typewriter = !!settings.decorations.typewriter;
  state.minimapVisible = !!settings.decorations.minimap;

  document.documentElement.dataset.theme = state.theme;
  applySyntaxPalette(state.theme);
  document.documentElement.dataset.reduceMotion = state.reduceMotion ? 'true' : 'false';
  el.sidebar.style.width = `${clamp(state.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX)}px`;
  el.sidebar.hidden = !state.sidebarVisible;
  el.sidebarResizer.hidden = !state.sidebarVisible;
  app.sidebar.render();

  app.editor.setTheme(state.theme);
  app.editor.setAppearance({
    fontSize: state.fontSize,
    wordWrap: state.wordWrap,
    indentSize: state.indentSize,
    useTabs: state.useTabs,
  });

  /* ------------------------------------------- v2 T09：专注 / 打字机 / 迷你地图 */

  /** 应用专注模式与打字机模式（Compartment 整体替换，保留撤销栈）。 */
  function applyAids() {
    app.editor.setAids(
      createAidsExtension({
        focus: () => !!state.focusMode,
        typewriter: () => !!state.typewriter,
      }),
    );
    if (app.minimap) app.minimap.setVisible(!!state.minimapVisible);
  }
  app.applyAids = applyAids;

  app.minimap = createMinimap(el.editorPane, app);
  applyAids();
  // 供验收脚本采样帧率（T08 ④）
  app.frameMeter = createFrameMeter();

  /* ---------------------------------------------------------- 会话持久化 */

  const persistSessionLazy = debounce(() => persistSession(), 700);
  app.persistSession = persistSessionLazy;
  /**
   * 把 state + 设置分组收敛成可持久化的配置对象。
   * 注意：`viewMode` 持久化的是**偏好**（auto/source/wysiwyg/split），
   * 不是当前标签的有效模式（否则大文件降级会把用户的偏好写坏）。
   * @return {object}
   */
  function collectSettings() {
    const base = app.settings || {};
    return pickSettings({
      ...base,
      theme: state.theme,
      themePinned: !!state.themePinned,
      fontSize: state.fontSize,
      wordWrap: state.wordWrap,
      sidebarVisible: state.sidebarVisible,
      sidebarWidth: state.sidebarWidth,
      sidebarTab: state.sidebarTab,
      autoSave: state.autoSave,
      indentSize: state.indentSize,
      useTabs: state.useTabs,
      viewMode: state.viewModePreference,
      viewModeLocked: state.viewModeLocked,
      reduceMotion: state.reduceMotion,
      decorations: {
        ...(base.decorations || {}),
        focusMode: state.focusMode,
        typewriter: state.typewriter,
        minimap: state.minimapVisible,
      },
    });
  }
  app.collectSettings = collectSettings;
  app.persistSettings = () => saveSettings(collectSettings());

  /* ------------------------------------------------------------- 命令注册 */

  app.editor.setAppKeymap(buildCmKeymap((id) => runCommand(id, app)));

  /* --------------------------------------------------------------- 菜单栏 */

  // 菜单栏返回 { render }；切语言时由 refreshChrome 重绘顶层菜单。
  app.menubar = initMenubar(el.menubar, app);
  initEditorContextMenu(app, el.editorHost);
  app.tooltips = initTooltips();

  /* --------------------------------------------------------------- 全局键 */

  installKeyHandler({
    isSuppressed: () => false,
    run: (id, evt) => {
      if (hasModal() && id !== 'view.zen') return false;
      runCommand(id, app, evt);
      return true;
    },
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (dismissTopModal()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (app.palette.isOpen()) {
        e.preventDefault();
        app.palette.close();
        return;
      }
      if (state.zen) {
        e.preventDefault();
        app.setZen(false);
        return;
      }
      if (!el.findFiles.hidden) {
        e.preventDefault();
        app.findInFiles.close();
      }
    },
    true,
  );

  /* ------------------------------------------------------------- 事件订阅 */

  bus.on('tabs', () => {
    app.tabsView.render();
    updateTitle();
    updateWelcome();
    app.toolbar.update();
    persistSessionLazy();
  });

  bus.on('active', () => {
    syncActive();
  });

  window.addEventListener('beforeunload', () => {
    flushSession();
  });

  /* --------------------------------------------------------- 拖拽打开文件 */

  setupDragAndDrop();

  /* ------------------------------------------------------------- 应用方法 */

  /**
   * 内容变化统一入口。
   * @param {string} tabId
   * @param {string} content
   */
  function handleContentChange(tabId, content) {
    const tab = getTab(tabId);
    if (!tab) return;
    tab.content = content;
    const dirty = isDirty(tab);
    if (tab._dirtyShown !== dirty) {
      tab._dirtyShown = dirty;
      app.tabsView.render();
      persistSessionLazy();
    }
    updateTitle();
    app.statusbar.update();
    updatePreview();
    // T09 ②：大纲重绘必须 300ms 防抖（连续输入 5 次 → 重绘 ≤2 次）
    if (state.sidebarTab === 'outline') app.sidebar.scheduleOutlineSync();
    if (app.minimap) app.minimap.update();
    scheduleAutoSave(tab);
    persistSessionLazy();
  }

  /**
   * 活动标签切换后的同步。
   */
  function syncActive() {
    const tab = activeTab();
    // 切标签时关掉可能残留的表格单元格浮层（它记录的是上一个文档的位置）
    closeTableCellEditor();
    app.editor.switchTo(tab);
    app.tabsView.render();
    updateTitle();
    app.statusbar.update();
    // 有效模式随标签的语言 / 大小变化（A1 默认规则）
    refreshViewMode();
    if (state.sidebarTab === 'outline') app.sidebar.renderBody();
    if (tab) app.sidebar.setActivePath(tab.path);
    app.toolbar.update();
    persistSessionLazy();
  }

  /** 标题栏文本。 */
  function updateTitle() {
    const tab = activeTab();
    if (!tab) {
      el.title.innerHTML = `<span class="doc-name">${t('未打开文件', 'No file open')}</span>`;
      document.title = t(
        'QuillPad · 现代文本与代码编辑器',
        'QuillPad — A modern text and code editor',
      );
      return;
    }
    const dirty = isDirty(tab);
    el.title.innerHTML =
      `<span class="doc-name">${escapeTitle(tab.name)}</span>` +
      (dirty ? '<span class="doc-dirty">•</span>' : '') +
      (tab.path && tab.path !== tab.name ? `<span class="doc-path">${escapeTitle(tab.path)}</span>` : '');
    document.title = `${dirty ? '• ' : ''}${tab.name} — QuillPad`;
  }

  /**
   * HTML 转义（仅用于标题栏拼接）。
   * @param {string} s
   * @return {string}
   */
  function escapeTitle(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 欢迎页显隐。 */
  function updateWelcome() {
    if (state.tabs.length === 0) app.welcome.show();
    else app.welcome.hide();
  }

  /** Markdown 预览刷新（只在 `split` 模式渲染；A1）。 */
  function updatePreview() {
    const tab = activeTab();
    const shouldShow = state.viewMode === 'split' && !!tab && isMarkdown(tab.language);
    el.preview.hidden = !shouldShow;
    if (!shouldShow) return;
    el.preview.innerHTML = `<div class="markdown-body">${renderMarkdown(tab.content)}</div>`;
    hydratePreviewImages(el.preview, docDirOf(tab));
    hydratePreviewCode(el.preview);
  }

  /**
   * 预览里的围栏代码块按 info string 真正着色。
   *
   * marked 只产出 `<code class="language-js">`，本身不做语法着色；这里沿用
   * WYSIWYG / PDF 同一套 lezer 解析器（`core/code-highlight.js`），把代码文本
   * 换成 `tok-*` 类的 span，颜色由当前主题的 `--tok-*` 变量决定。
   * 没有语言标记（或 `text` / `plaintext`）的块保持原样 —— 与 WYSIWYG 一致。
   *
   * @param {HTMLElement} root
   */
  function hydratePreviewCode(root) {
    root.querySelectorAll('pre > code').forEach((code) => {
      const match = /(?:^|\s)language-([\w#+.-]+)/.exec(code.className || '');
      const tag = match ? match[1] : '';
      const langId = resolveLangId(tag);
      if (!langId || langId === 'plaintext' || langId === 'markdown') return;
      const pre = code.parentElement;
      if (pre) {
        pre.setAttribute('data-lang', codeTagLabel(tag));
        pre.setAttribute('data-qp-code', '1');
      }
      const raw = code.textContent || '';
      highlightCode(raw, langId).then((html) => {
        // 预览可能在异步返回前已经重渲染过，旧节点不要再写
        if (!code.isConnected) return;
        code.innerHTML = html;
      });
    });
  }

  /**
   * 分屏预览里的本地图片也要交给主进程代读。
   *
   * marked 输出 `<img src="images/x.png">`，相对的是本地 HTTP server 的根，
   * 而不是文档所在目录；先按文档目录解析成 `file:///`，再走与 WYSIWYG
   * 相同的 data URL 通道。网络 / data / blob 地址保持原样。
   *
   * @param {HTMLElement} root
   * @param {string|null} docDir
   */
  function hydratePreviewImages(root, docDir) {
    root.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src || /^(https?:|data:|blob:)/i.test(src)) return;
      // marked 会把非 ASCII 的 src 百分号编码（`01_%E5%B0%81…png`），
      // 而 resolveImageUrl→toFileUrl 还会再编码一次；先解回来，避免双重编码。
      let raw = src;
      try {
        raw = decodeURIComponent(src);
      } catch {
        // 含非法 % 序列时保持原样，交由后面的加载失败占位处理
      }
      const info = resolveImageUrl(raw, docDir);
      if (!info.resolved || !isLocalImageUrl(info.url)) return;
      img.removeAttribute('src');
      img.setAttribute('data-qp-src', raw);
      loadImageSrc(info.url).then((dataUrl) => {
        // 预览可能在异步返回前已经重渲染过，旧节点不要再写
        if (!img.isConnected) return;
        if (!dataUrl) {
          previewImageFallback(img, raw);
          return;
        }
        img.src = dataUrl;
      });
    });
  }

  /**
   * 预览里图片加载失败时的占位（内联样式，避免依赖 WYSIWYG 专属样式表）。
   * @param {HTMLImageElement} img
   * @param {string} src
   */
  function previewImageFallback(img, src) {
    const box = document.createElement('span');
    box.className = 'qp-img-missing';
    box.setAttribute('data-qp-node', 'image-missing');
    box.textContent = t(`图片未能加载：${src}`, `Image failed to load: ${src}`);
    box.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;' +
      'border:1px dashed var(--border);border-radius:6px;' +
      'color:var(--text-dim);font-size:12px;';
    img.replaceWith(box);
  }

  app.updatePreview = updatePreview;

  /* ---------------------------------------------------------- 三态视图模式 */

  /** 每个标签的行数缓存（大文件判定用，避免每次重算全文）。 */
  const lineCountCache = new Map();

  /**
   * 取标签行数（带缓存，doc 变化时由 handleContentChange 失效）。
   * @param {object} tab
   * @return {number}
   */
  function tabLines(tab) {
    if (!tab) return 0;
    const cached = lineCountCache.get(tab.id);
    if (cached && cached.length === tab.content.length) return cached.lines;
    const lines = countLines(tab.content || '');
    lineCountCache.set(tab.id, { length: tab.content.length, lines });
    return lines;
  }

  /**
   * 文档所在目录（图片路径解析基准，A6）。
   * @param {object|null} tab
   * @return {string|null} 形如 `D:/docs`；虚拟文件名返回 null
   */
  function docDirOf(tab) {
    if (!tab) return null;
    const raw = String(tab.nativePath || tab.path || '');
    if (!raw) return null;
    const norm = raw.replace(/\\/g, '/');
    if (!norm.includes('/')) return null;
    return norm.slice(0, norm.lastIndexOf('/'));
  }
  app.docDirOf = docDirOf;

  /**
   * 当前视图模式上下文。
   * @return {{preference: string, locked: boolean, forced: boolean}}
   */
  function modeContext() {
    const tab = activeTab();
    return {
      preference: state.viewModePreference,
      locked: state.viewModeLocked,
      forced: !!tab && state.wysiwygForced.has(tab.id),
    };
  }

  /** 懒建 WYSIWYG 装饰层（首屏不在 wysiwyg 模式就不构造）。 */
  function ensureWysiwyg() {
    if (app.wysiwyg) return app.wysiwyg;
    app.wysiwyg = createWysiwygExtension({
      enabled: () => state.viewMode === 'wysiwyg',
      features: () => (app.settings && app.settings.decorations) || {},
      getDocDir: () => docDirOf(activeTab()),
      runCommand: (id, args) => runCommand(id, app, args),
      toast: (msg, kind) => toast(msg, kind || 'info'),
      getTab: () => activeTab(),
      rerender: () => requestAnimationFrame(() => app.editor.view.requestMeasure()),
      /** 目录 / 脚注 / 标题跳转 */
      onJumpLine: (pos) => app.editor.gotoPos(pos),
      dispatchSelection: (pos) => app.editor.gotoPos(pos),
      onOpenLink: (url) => app.openExternal(url),
      /** 代码块复制：不含围栏 */
      copyText: async (text) => {
        const ok = await copyToClipboard(text);
        toast(
          ok ? t(`已复制 ${text.length} 个字符`, `Copied ${text.length} characters`) : t('剪贴板不可用', 'Clipboard unavailable'),
          ok ? 'success' : 'error',
          1800,
        );
        return ok;
      },
      /** 脚注上标 → 跳到定义行 */
      jumpToFootnote: (id, info) => {
        const def = info && info.defs ? info.defs.find((d) => d.id === id) : null;
        if (!def) {
          toast(t('未找到该脚注的定义', 'No definition found for this footnote'), 'info', 2000);
          return;
        }
        app.editor.gotoPos(def.from);
      },
    });
    return app.wysiwyg;
  }

  /** 把有效模式写到 DOM（`data-view-mode` + `#preview-pane` 显隐 + `previewVisible` 镜像）。 */
  function applyViewModeToDOM() {
    if (el.editorSplit) el.editorSplit.dataset.viewMode = state.viewMode;
    // 单一写入点（ARCH R7）：previewVisible 恒等于 (viewMode === 'split')
    state.previewVisible = state.viewMode === 'split';
    updatePreview();
  }

  /** 把 WYSIWYG 装饰层装载 / 卸载到编辑器。 */
  function applyWysiwygLayer() {
    const shouldEnable = state.viewMode === 'wysiwyg';
    if (!shouldEnable) {
      app.editor.setWysiwyg([]);
      return;
    }
    app.editor.setWysiwyg(ensureWysiwyg());
  }

  /**
   * 按「偏好 + 语言 + 大文件策略」重新推导有效模式并落到 DOM / 编辑器。
   *
   * 只在「切标签 / 切语言 / 文档被整体替换 / 打开降级开关」时调用，
   * **不**在每次输入时调用（避免热路径上做全文行数统计）。
   */
  function refreshViewMode() {
    const tab = activeTab();
    const ctx = modeContext();
    const next = effectiveViewMode(
      tab ? { ...tab, lines: tabLines(tab) } : null,
      ctx,
    );
    const degraded =
      !!tab &&
      tab.language === 'markdown' &&
      shouldDegrade({ content: tab.content, lines: tabLines(tab) }) &&
      !ctx.forced;
    state.viewMode = next;
    state.wysiwygDegraded = degraded;
    applyViewModeToDOM();
    applyWysiwygLayer();
    updateDegradeBanner();
    bus.emit('viewmode', { mode: next, tabId: tab ? tab.id : null });
    app.statusbar.update();
    if (app.toolbar) app.toolbar.update();
  }
  app.refreshViewMode = refreshViewMode;

  /**
   * 设置有效模式（分段控件 / 命令 / 状态栏胶囊统一入口）。
   *
   * @param {'source'|'wysiwyg'|'split'} mode
   * @param {{user?: boolean}} [opts] user=true 表示用户显式选择 → 写偏好并锁定
   * @return {boolean} 是否真的切换了
   */
  app.setViewMode = function setViewMode(mode, opts = {}) {
    const tab = activeTab();
    let target = mode;
    if (!tab) {
      toast(t('请先打开一个文件', 'Open a file first'), 'info', 1600);
      return false;
    }
    if (target !== 'source' && tab.language !== 'markdown') {
      toast(t('仅 Markdown 支持所见即所得与分屏', 'WYSIWYG and split view are only available for Markdown'), 'info', 2200);
      target = 'source';
    }
    if (target !== 'source' && isHardLimited({ ...tab, lines: tabLines(tab) })) {
      toast(t('文件过大（超过 20MB / 500k 行），已禁用所见即所得与分屏', 'File too large (over 20MB / 500k lines). WYSIWYG and split view are disabled.'), 'error', 3600);
      target = 'source';
    }
    if (target !== 'source' && shouldDegrade({ content: tab.content, lines: tabLines(tab) })
      && !state.wysiwygForced.has(tab.id)) {
      // 大文件降级：进入 source，同时给出「仍要启用」入口
      state.wysiwygDegraded = true;
      target = 'source';
      toast(
        t(`文件较大（${(tab.content.length / 1024 / 1024).toFixed(1)} MB / ${tabLines(tab)} 行），已切至源码视图以保持流畅`, `Large file (${(tab.content.length / 1024 / 1024).toFixed(1)} MB / ${tabLines(tab)} lines). Switched to source view to keep things smooth.`),
        'info',
        4200,
      );
    }

    if (opts.user) {
      state.viewModePreference = target;
      state.viewModeLocked = true;
      app.persistSettings();
    }
    const changed = state.viewMode !== target;
    state.viewMode = target;
    applyViewModeToDOM();
    applyWysiwygLayer();
    updateDegradeBanner();
    bus.emit('viewmode', { mode: target, tabId: tab.id });
    app.statusbar.update();
    if (app.toolbar) app.toolbar.update();
    if (changed) app.persistSession();
    return true;
  };

  /** `Mod-E`：固定顺序 source → split → wysiwyg → source。 */
  app.cycleViewMode = function cycleViewMode() {
    const tab = activeTab();
    if (!tab) {
      toast(t('请先打开一个文件', 'Open a file first'), 'info', 1600);
      return false;
    }
    if (tab.language !== 'markdown') {
      toast(t('仅 Markdown 支持切换视图模式', 'View modes can only be switched for Markdown'), 'info', 2000);
      return false;
    }
    return app.setViewMode(nextViewMode(state.viewMode), { user: true });
  };

  /**
   * 「仍要启用」：把当前标签加入会话级白名单，并进入 wysiwyg（A9）。
   */
  app.forceWysiwyg = function forceWysiwyg() {
    const tab = activeTab();
    if (!tab) return;
    state.wysiwygForced.add(tab.id);
    state.wysiwygDegraded = false;
    updateDegradeBanner();
    app.setViewMode('wysiwyg');
    toast(t('已为该文件启用所见即所得（本次会话内有效）', 'WYSIWYG enabled for this file (this session only)'), 'success', 2600);
  };

  /** 大文件降级提示条（不依赖 toast，因为需要常驻 + 可点击）。 */
  function updateDegradeBanner() {
    let banner = el.editorPane.querySelector('.qp-degrade-banner');
    if (!state.wysiwygDegraded) {
      if (banner) banner.remove();
      return;
    }
    const tab = activeTab();
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'qp-degrade-banner';
      banner.innerHTML =
        '<span class="qp-degrade-banner__text"></span>' +
        `<button type="button" class="qp-degrade-banner__btn" data-role="force-wysiwyg">${t('仍要启用', 'Enable Anyway')}</button>` +
        `<button type="button" class="qp-degrade-banner__close" data-role="dismiss-degrade" aria-label="${t('关闭提示', 'Dismiss')}">×</button>`;
      banner.addEventListener('click', (e) => {
        const force = e.target.closest('[data-role="force-wysiwyg"]');
        if (force) {
          app.forceWysiwyg();
          return;
        }
        if (e.target.closest('[data-role="dismiss-degrade"]')) {
          state.wysiwygDegraded = false;
          updateDegradeBanner();
        }
      });
      el.editorPane.appendChild(banner);
    }
    const size = tab ? (tab.content.length / 1024 / 1024).toFixed(1) : '0';
    const lines = tab ? tabLines(tab) : 0;
    const text = banner.querySelector('.qp-degrade-banner__text');
    if (text) {
      text.textContent = t(`文件较大（${size} MB / ${lines} 行），已切至源码视图以保持流畅`, `Large file (${size} MB / ${lines} lines). Switched to source view to keep things smooth.`);
    }
    // 提示条可能是切语言之前就常驻的：每次刷新都重写按钮文案与无障碍标签。
    const forceBtn = banner.querySelector('[data-role="force-wysiwyg"]');
    if (forceBtn) forceBtn.textContent = t('仍要启用', 'Enable Anyway');
    const closeBtn = banner.querySelector('[data-role="dismiss-degrade"]');
    if (closeBtn) closeBtn.setAttribute('aria-label', t('关闭提示', 'Dismiss'));
  }
  app.updateDegradeBanner = updateDegradeBanner;

  /**
   * 自动保存调度。
   * @param {object} tab
   */
  function scheduleAutoSave(tab) {
    if (!state.autoSave || !tab || !tab.handleKey) return;
    if (tab._autoSaveTimer) window.clearTimeout(tab._autoSaveTimer);
    tab._autoSaveTimer = window.setTimeout(async () => {
      if (!isDirty(tab)) return;
      await app.saveTab(tab, { silent: true });
    }, 1500);
  }

  /* ---------------------------------------------------------- 会话存取 */

  /** 组装会话对象。 */
  function buildSession() {
    return {
      version: 1,
      tabs: state.tabs.map((tab) => ({
        name: tab.name,
        path: tab.path,
        content: tab.content,
        savedContent: tab.savedContent,
        savedEol: tab.savedEol,
        language: tab.language,
        eol: tab.eol,
        encoding: tab.encoding,
        handleKey: tab.handleKey,
        nativePath: tab.nativePath || null,
        nativeBom: !!tab.nativeBom,
        bigFile: tab.bigFile,
        scrollTop: app.editor.scrollTops.get(tab.id) || 0,
      })),
      activeIndex: Math.max(0, state.tabs.findIndex((t) => t.id === state.activeTabId)),
      recent: state.recent.slice(0, 12),
      folder: state.folder,
    };
  }

  /** 立即写会话。 */
  function persistSession() {
    app.editor.saveScroll();
    saveSession(buildSession());
  }

  /** 卸载前冲刷。 */
  function flushSession() {
    persistSessionLazy.cancel();
    persistSession();
  }

  app.flushSession = flushSession;

  /** 读取并恢复会话。 */
  async function restoreSession() {
    const session = loadSession();
    app._restoredSession = !!session;
    if (!session) return;

    state.recent = Array.isArray(session.recent) ? session.recent.slice(0, 12) : [];
    state.folder = session.folder || null;

    const tabs = (session.tabs || [])
      .filter((tab) => tab && typeof tab.content === 'string')
      .map((tab) => ({
        id: nextTabId(),
        name: tab.name || t('未命名.txt', 'Untitled.txt'),
        path: tab.path || tab.name || t('未命名.txt', 'Untitled.txt'),
        content: tab.content,
        savedContent: typeof tab.savedContent === 'string' ? tab.savedContent : tab.content,
        savedEol: tab.savedEol || tab.eol || 'LF',
        language: tab.language || guessLanguage(tab.name),
        eol: tab.eol || 'LF',
        encoding: tab.encoding || 'UTF-8',
        handleKey: tab.handleKey || null,
        nativePath: tab.nativePath || null,
        nativeBom: !!tab.nativeBom,
        bigFile: !!tab.bigFile,
        _dirtyShown: false,
      }));

    if (tabs.length) {
      tabs.forEach((tab, i) => {
        const raw = session.tabs[i] || {};
        if (raw.scrollTop) app.editor.scrollTops.set(tab.id, raw.scrollTop);
      });
      const activeIdx = Math.min(Math.max(0, session.activeIndex || 0), tabs.length - 1);
      setTabs(tabs, tabs[activeIdx].id);
      tabs.forEach((tab) => {
        tab._dirtyShown = isDirty(tab);
      });
      app.tabsView.render();
    }

    // 恢复文件夹（权限需要用户手势，这里只做静默检查）
    if (state.folder && state.folder.handleKey) {
      try {
        const handle = await getDirHandle(state.folder.handleKey);
        if (handle && handle.queryPermission) {
          const perm = await handle.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted') {
            await app.sidebar.setFolder(handle);
          }
        }
      } catch (err) {
        console.warn('[QuillPad] 恢复文件夹失败：', err);
      }
    }
  }

  /* ------------------------------------------------------------ 标签操作 */

  /**
   * 「未命名」文件名的识别规则。
   *
   * 中英文两种前缀都算：用户切过语言之后，同一个会话里可能同时存在
   * 「未命名.txt」与「Untitled.txt」，序号必须接着往下排而不是从 1 重来。
   */
  const UNTITLED_PATTERN = /^(?:未命名|Untitled)/;

  /**
   * 生成下一个「未命名」文件名。
   *
   * 只统计「从未落盘」的未命名标签，序号接着往下排：未命名.txt → 未命名2.md。
   * 扩展名跟着用户选的文件类型走，这样 .md 新建出来就是 Markdown 标签。
   *
   * 文件名本身属于数据而不是界面文案，但前缀跟随界面语言更符合预期，
   * 因此这里用 t() 取前缀，同时用 UNTITLED_PATTERN 兼容两种写法。
   *
   * @param {string} [ext] 扩展名（不含点）
   * @return {string}
   */
  app.nextUntitledName = function nextUntitledName(ext = 'txt') {
    const count =
      state.tabs.filter((tab) => !tab.handleKey && UNTITLED_PATTERN.test(tab.name)).length + 1;
    const base = t('未命名', 'Untitled');
    return count <= 1 ? `${base}.${ext}` : `${base}${count}.${ext}`;
  };

  /**
   * 新建一个空标签。
   * @param {{name?: string, content?: string, language?: string, path?: string}} [opts]
   * @return {object}
   */
  app.createTab = function createTab(opts = {}) {
    const name = opts.name || app.nextUntitledName('txt');
    const tab = {
      id: nextTabId(),
      name,
      path: opts.path || name,
      content: opts.content || '',
      savedContent: opts.content || '',
      savedEol: 'LF',
      language: opts.language || guessLanguage(name),
      eol: 'LF',
      encoding: 'UTF-8',
      handleKey: null,
      bigFile: (opts.content || '').length > BIG_FILE_THRESHOLD,
      _dirtyShown: false,
    };
    addTab(tab, true);
    return tab;
  };

  /** 新建文件（不询问，直接给一个「未命名.txt」）。脚本 / 快捷路径用。 */
  app.newFile = function newFile() {
    const tab = app.createTab({});
    app.tabsView.render();
    requestAnimationFrame(() => app.editor.focus());
    return tab;
  };

  /**
   * 新建文件（弹对话框选文件名与类型）。
   *
   * 这是 Ctrl+N / 工具栏 / 标签栏「+」的默认入口；`app.newFile()` 保留给
   * 需要「立刻拿到一个空标签、不要弹窗」的内部调用与自动化脚本。
   *
   * @return {Promise<object|null>} 取消时返回 null
   */
  app.newFileWithType = async function newFileWithType() {
    const picked = await newFileDialog({
      suggestName: (ext) => app.nextUntitledName(ext),
    });
    if (!picked) return null;
    const tab = app.createTab({ name: picked.name });
    app.tabsView.render();
    requestAnimationFrame(() => app.editor.focus());
    return tab;
  };

  /**
   * 用句柄打开文件。
   * @param {FileSystemFileHandle} handle
   * @param {string} [displayPath]
   * @return {Promise<object|null>}
   */
  app.openFromHandle = async function openFromHandle(handle, displayPath) {
    const path = displayPath || handle.name;
    const existing = state.tabs.find((t) => t.path === path);
    if (existing) {
      setActiveId(existing.id);
      return existing;
    }
    try {
      const file = await handle.getFile();
      if (file.size > MAX_FILE_SIZE) {
        toast(t(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），已跳过`, `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Skipped.`), 'error', 3600);
        return null;
      }
      // 桌面壳里能拿到 File 的真实磁盘路径：记住它，右键「复制完整路径 /
      // 打开所在位置」才有绝对路径可用（`displayPath` 可能只是文件夹内的相对路径）。
      let nativePath = '';
      try {
        const viaBridge = window.quillpadDesktop && window.quillpadDesktop.getFilePath;
        if (typeof viaBridge === 'function') nativePath = viaBridge(file) || '';
      } catch {
        nativePath = '';
      }
      const data = await readFileHandle(handle);
      const key = newHandleKey();
      await putFileHandle(key, handle);
      const tab = {
        id: nextTabId(),
        name: data.name,
        path,
        nativePath: nativePath || null,
        content: data.content,
        savedContent: data.content,
        savedEol: data.eol,
        language: guessLanguage(data.name),
        eol: data.eol,
        encoding: data.encoding,
        handleKey: key,
        bigFile: data.content.length > BIG_FILE_THRESHOLD,
        _dirtyShown: false,
      };
      addTab(tab, true);
      if (tab.bigFile) {
        toast(t(`「${tab.name}」超过 2MB，已关闭语法高亮以保证编辑流畅`, `"${tab.name}" is over 2MB, so syntax highlighting is off to keep editing smooth`), 'info', 4000);
        app.editor.loadedLang.set(tab.id, 'plaintext');
      }
      addRecent(tab.name, path, key);
      app.sidebar.setActivePath(path);
      return tab;
    } catch (err) {
      console.error(err);
      toast(t(`打开文件失败：${err.message || err}`, `Failed to open file: ${err.message || err}`), 'error', 3600);
      return null;
    }
  };

  /**
   * 用 File 对象打开（降级方案 / 拖拽）。
   * @param {File} file
   * @return {Promise<object|null>}
   */
  app.openFileObject = async function openFileObject(file) {
    const existing = state.tabs.find((t) => t.path === file.name);
    if (existing) {
      setActiveId(existing.id);
      return existing;
    }
    if (file.size > MAX_FILE_SIZE) {
      toast(t(`文件过大（${(file.size / 1024 / 1024).toFixed(1)} MB），已跳过`, `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Skipped.`), 'error', 3600);
      return null;
    }
    try {
      const data = await readFileObject(file);
      const tab = {
        id: nextTabId(),
        name: data.name,
        path: data.name,
        content: data.content,
        savedContent: data.content,
        savedEol: data.eol,
        language: guessLanguage(data.name),
        eol: data.eol,
        encoding: data.encoding,
        handleKey: null,
        bigFile: data.content.length > BIG_FILE_THRESHOLD,
        _dirtyShown: false,
      };
      addTab(tab, true);
      if (tab.bigFile) toast(t(`「${tab.name}」超过 2MB，已关闭语法高亮`, `"${tab.name}" is over 2MB, so syntax highlighting is off`), 'info', 3600);
      addRecent(tab.name, data.name, null);
      return tab;
    } catch (err) {
      toast(t(`读取文件失败：${err.message || err}`, `Failed to read file: ${err.message || err}`), 'error', 3600);
      return null;
    }
  };

  /** 打开文件。 */
  app.openFiles = async function openFiles() {
    if (supportsFsa()) {
      const handles = await pickOpenFiles();
      if (!handles.length) return;
      for (const handle of handles) {
        await app.openFromHandle(handle);
      }
      if (handles.length > 1) toast(t(`已打开 ${handles.length} 个文件`, `Opened ${handles.length} files`), 'success');
    } else {
      const files = await pickFilesLegacy(true);
      if (!files.length) return;
      for (const file of files) await app.openFileObject(file);
      toast(t('当前浏览器不支持直接写回磁盘，保存时会下载文件', 'This browser cannot write to disk directly; saving will download the file'), 'info', 3600);
    }
  };

  /**
   * 打开文件夹。
   */
  app.openFolder = async function openFolder() {
    if (!supportsFsa() || typeof window.showDirectoryPicker !== 'function') {
      toast(t('当前浏览器不支持「打开文件夹」，请使用 Chrome / Edge', 'This browser does not support "Open Folder". Please use Chrome or Edge.'), 'error', 3600);
      return;
    }
    const handle = await pickDirectory();
    if (!handle) return;
    const key = newHandleKey();
    await putDirHandle(key, handle);
    state.folder = { name: handle.name, handleKey: key };
    await app.sidebar.setFolder(handle);
    state.sidebarVisible = true;
    el.sidebar.hidden = false;
    el.sidebarResizer.hidden = false;
    app.persistSettings();
    app.toolbar.update();
    app.persistSession();
    toast(t(`已打开文件夹：${handle.name}`, `Folder opened: ${handle.name}`), 'success');
  };

  /** 恢复上次的文件夹（需要用户手势内申请权限）。 */
  app.restoreFolder = async function restoreFolder() {
    if (!state.folder || !state.folder.handleKey) return;
    const handle = await getDirHandle(state.folder.handleKey);
    if (!handle) {
      toast(t('无法恢复上次的文件夹，请重新打开', 'Could not restore the last folder. Please open it again.'), 'error');
      state.folder = null;
      app.sidebar.render();
      return;
    }
    const ok = await ensurePermission(handle, 'readwrite');
    if (!ok) {
      toast(t('未获得文件夹访问权限', 'Folder access was not granted'), 'error');
      return;
    }
    await app.sidebar.setFolder(handle);
    toast(t(`已恢复文件夹：${handle.name}`, `Folder restored: ${handle.name}`), 'success');
  };

  /** 关闭文件夹。 */
  app.closeFolder = async function closeFolder() {
    if (state.folder && state.folder.handleKey) {
      await deleteDirHandle(state.folder.handleKey);
    }
    state.folder = null;
    app.sidebar.clearFolder();
    app.persistSession();
  };

  /** 刷新文件夹树。 */
  app.refreshFolder = async function refreshFolder() {
    if (!app.sidebar.handle) {
      toast(t('还没有打开文件夹', 'No folder is open'), 'info');
      return;
    }
    await app.sidebar.refresh();
    toast(t('已刷新文件夹', 'Folder refreshed'), 'success');
  };

  /**
   * 按路径打开文件夹中的文件。
   * @param {string} path
   * @return {Promise<boolean>}
   */
  app.openFileByPath = async function openFileByPath(path) {
    const existing = state.tabs.find((t) => t.path === path);
    if (existing) {
      setActiveId(existing.id);
      return true;
    }
    if (!app.sidebar.handle) return false;
    const handle = await app.sidebar.resolveFileHandle(path);
    if (!handle) return false;
    const tab = await app.openFromHandle(handle, path);
    return !!tab;
  };

  /**
   * 打开桌面壳从系统传入的磁盘文件（右键菜单 / 文件关联 / 命令行 / 单实例转发）。
   *
   * 与 File System Access 的 FileSystemFileHandle 不同，这条通路记住的是绝对路径，
   * 保存时交给主进程直接写回 —— 因此同样具备「Ctrl+S 覆盖原文件」的能力，
   * 且不依赖 IndexedDB 里的句柄是否还有效。浏览器里没有这个桥，函数直接返回 false。
   *
   * @param {string} filePath 绝对路径
   * @return {Promise<boolean>} 是否成功打开
   */
  app.openNativePath = async function openNativePath(filePath) {
    const bridge = window.quillpadDesktop;
    if (!bridge || typeof bridge.readFile !== 'function') return false;
    const target = String(filePath || '');
    if (!target) return false;

    const existing = state.tabs.find((t) => t.nativePath === target);
    if (existing) {
      setActiveId(existing.id);
      return true;
    }

    try {
      const res = await bridge.readFile(target);
      if (!res || !res.ok) {
        toast(t(`打开文件失败：${(res && res.error) || '无法读取文件'}`, `Failed to open file: ${(res && res.error) || 'cannot read file'}`), 'error', 3600);
        return false;
      }
      if (res.size > MAX_FILE_SIZE) {
        toast(t(`文件过大（${(res.size / 1024 / 1024).toFixed(1)} MB），已跳过`, `File too large (${(res.size / 1024 / 1024).toFixed(1)} MB). Skipped.`), 'error', 3600);
        return false;
      }
      const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes || []);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const decoded = decodeBytes(buffer);
      const eol = detectEol(decoded.text);
      const name = res.name || target.split(/[\\/]/).pop() || t('未命名.txt', 'Untitled.txt');

      const tab = {
        id: nextTabId(),
        name,
        path: target,
        content: decoded.text,
        savedContent: decoded.text,
        savedEol: eol,
        language: guessLanguage(name),
        eol,
        encoding: decoded.encoding,
        handleKey: null,
        nativePath: target,
        nativeBom: decoded.hadBom,
        bigFile: decoded.text.length > BIG_FILE_THRESHOLD,
        _dirtyShown: false,
      };
      addTab(tab, true);
      if (tab.bigFile) {
        toast(t(`「${tab.name}」超过 2MB，已关闭语法高亮以保证编辑流畅`, `"${tab.name}" is over 2MB, so syntax highlighting is off to keep editing smooth`), 'info', 4000);
        app.editor.loadedLang.set(tab.id, 'plaintext');
      }
      addRecent(tab.name, target, null, target);
      app.sidebar.setActivePath(target);
      return true;
    } catch (err) {
      console.error(err);
      toast(t(`打开文件失败：${err.message || err}`, `Failed to open file: ${err.message || err}`), 'error', 3600);
      return false;
    }
  };

  /* -------------------------------------------------------------- 保存流程 */

  /**
   * 保存单个标签。
   * @param {object} tab
   * @param {{saveAs?: boolean, silent?: boolean}} [opts]
   * @return {Promise<boolean>}
   */
  app.saveTab = async function saveTab(tab, opts = {}) {
    if (!tab) return false;
    app.savingTabs.add(tab.id);
    app.statusbar.update();
    try {
      let handle = null;
      if (!opts.saveAs && tab.handleKey) {
        handle = await getFileHandle(tab.handleKey);
        if (handle) {
          const ok = await ensurePermission(handle, 'readwrite');
          if (!ok) handle = null;
        }
      }

      const payload = toEol(tab.content, tab.eol);

      // 桌面壳从系统打开的文件：按绝对路径直接写回，不再弹文件选择器。
      // 这条分支排在句柄逻辑之前，因为这类标签本来就没有 FileSystemFileHandle。
      const bridge = window.quillpadDesktop;
      if (!opts.saveAs && tab.nativePath && bridge && typeof bridge.writeFile === 'function') {
        const res = await bridge.writeFile(tab.nativePath, payload, { bom: !!tab.nativeBom });
        if (!res || !res.ok) throw new Error((res && res.error) || t('写入失败', 'write failed'));
        tab.savedContent = tab.content;
        tab.savedEol = tab.eol;
        tab.encoding = 'UTF-8';
        tab._dirtyShown = false;
        addRecent(tab.name, tab.path, tab.handleKey, tab.nativePath);
        app.tabsView.render();
        updateTitle();
        app.statusbar.update();
        persistSession();
        if (!opts.silent) toast(t(`已保存 ${tab.name}`, `Saved ${tab.name}`), 'success');
        return true;
      }

      if (!handle) {
        // 桌面壳优先：系统「另存为」对话框是唯一能拿到**完整绝对路径**的入口。
        // FSA 的 FileSystemFileHandle 只有 name，用它保存出来的标签会没有目录，
        // 「复制完整路径」误报「尚未保存到磁盘」、「打开所在位置」被置灰。
        if (desktopBridge.canSaveDialog()) {
          const picked = await desktopBridge.saveDialog({ defaultName: tab.name });
          if (!picked || !picked.ok) {
            if (picked && picked.canceled) return false;
            throw new Error((picked && picked.error) || t('无法打开保存对话框', 'Cannot open the save dialog'));
          }
          const target = String(picked.path || '');
          if (!target) throw new Error(t('保存对话框没有返回路径', 'The save dialog returned no path'));
          const written = await bridge.writeFile(target, payload, { bom: !!tab.nativeBom });
          if (!written || !written.ok) throw new Error((written && written.error) || t('写入失败', 'write failed'));

          const base = target.split(/[\\/]/).pop() || tab.name;
          tab.name = base;
          // `path` 与 `nativePath` 都记绝对路径：一个给文件树/最近文件用，
          // 一个给「复制完整路径 / 打开所在位置 / 按路径回写」用。
          tab.path = target;
          tab.nativePath = target;
          tab.handleKey = null;
          tab.nativeBom = false;
          tab.savedContent = tab.content;
          tab.savedEol = tab.eol;
          tab.encoding = 'UTF-8';
          tab._dirtyShown = false;
          if (tab.language === 'plaintext' || !tab.language) {
            tab.language = guessLanguage(base);
          }
          addRecent(base, target, null, target);
          app.tabsView.render();
          updateTitle();
          app.statusbar.update();
          persistSession();
          if (!opts.silent) toast(t(`已保存 ${base}`, `Saved ${base}`), 'success');
          return true;
        }

        if (supportsFsa()) {
          const picked = await pickSaveFile(tab.name);
          if (!picked) return false;
          handle = picked;
          const key = newHandleKey();
          await putFileHandle(key, handle);
          tab.handleKey = key;
          tab.name = handle.name;
          tab.path = handle.name;
          // 另存到新位置后，原先的绝对路径失效
          tab.nativePath = null;
          tab.nativeBom = false;
          if (tab.language === 'plaintext' || !tab.language) {
            tab.language = guessLanguage(handle.name);
          }
        } else {
          downloadText(tab.name, payload);
          tab.savedContent = tab.content;
          tab.savedEol = tab.eol;
          tab._dirtyShown = false;
          addRecent(tab.name, tab.path, null);
          app.tabsView.render();
          updateTitle();
          app.statusbar.update();
          if (!opts.silent) toast(t('已下载文件（当前浏览器不支持直接写盘）', 'File downloaded (this browser cannot write to disk directly)'), 'success');
          return true;
        }
      }

      await writeFileHandle(handle, payload);
      tab.savedContent = tab.content;
      tab.savedEol = tab.eol;
      tab.encoding = 'UTF-8';
      tab._dirtyShown = false;
      addRecent(tab.name, tab.path, tab.handleKey);
      app.tabsView.render();
      updateTitle();
      app.statusbar.update();
      persistSession();
      if (!opts.silent) toast(t(`已保存 ${tab.name}`, `Saved ${tab.name}`), 'success');
      return true;
    } catch (err) {
      console.error(err);
      toast(t(`保存失败：${err.message || err}`, `Save failed: ${err.message || err}`), 'error', 3600);
      return false;
    } finally {
      app.savingTabs.delete(tab.id);
      app.statusbar.update();
    }
  };

  /** 保存当前标签。 */
  app.saveActive = async function saveActive() {
    const tab = activeTab();
    if (!tab) {
      toast(t('没有需要保存的文件', 'No file to save'), 'info');
      return false;
    }
    return app.saveTab(tab);
  };

  /** 另存为。 */
  app.saveActiveAs = async function saveActiveAs() {
    const tab = activeTab();
    if (!tab) {
      toast(t('没有需要保存的文件', 'No file to save'), 'info');
      return false;
    }
    return app.saveTab(tab, { saveAs: true });
  };

  /** 全部保存。 */
  app.saveAll = async function saveAll() {
    const dirtyTabs = state.tabs.filter((t) => isDirty(t));
    if (!dirtyTabs.length) {
      toast(t('所有文件都已保存', 'All files are saved'), 'info');
      return;
    }
    let ok = 0;
    for (const tab of dirtyTabs) {
      // 逐个 await，保证 File Picker 处于用户手势内
      const done = await app.saveTab(tab);
      if (done) ok += 1;
    }
    toast(t(`已保存 ${ok} / ${dirtyTabs.length} 个文件`, `Saved ${ok} of ${dirtyTabs.length} files`), ok ? 'success' : 'info');
  };

  /** 重新加载当前文件（从磁盘）。 */
  app.reloadActive = async function reloadActive() {
    const tab = activeTab();
    if (!tab) return;

    // 桌面壳打开的绝对路径文件：重新读一遍磁盘
    const bridge = window.quillpadDesktop;
    if (tab.nativePath && bridge && typeof bridge.readFile === 'function') {
      try {
        const res = await bridge.readFile(tab.nativePath);
        if (!res || !res.ok) throw new Error((res && res.error) || t('无法读取原文件', 'Cannot read the original file'));
        const bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes || []);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const decoded = decodeBytes(buffer);
        tab.content = decoded.text;
        tab.savedContent = decoded.text;
        tab.savedEol = detectEol(decoded.text);
        tab.eol = tab.savedEol;
        tab.encoding = decoded.encoding;
        tab.nativeBom = decoded.hadBom;
        tab._dirtyShown = false;
        app.editor.resetContent(tab);
        app.tabsView.render();
        updateTitle();
        app.statusbar.update();
        updatePreview();
        toast(t('已从磁盘重新加载', 'Reloaded from disk'), 'success');
      } catch (err) {
        toast(t(`重新加载失败：${err.message || err}`, `Reload failed: ${err.message || err}`), 'error');
      }
      return;
    }

    if (!tab.handleKey) {
      toast(t('该文件没有关联磁盘句柄，无法重新加载', 'This file has no disk handle, so it cannot be reloaded'), 'info');
      return;
    }
    const handle = await getFileHandle(tab.handleKey);
    if (!handle || !(await ensurePermission(handle, 'read'))) {
      toast(t('无法读取原文件', 'Cannot read the original file'), 'error');
      return;
    }
    try {
      const data = await readFileHandle(handle);
      tab.content = data.content;
      tab.savedContent = data.content;
      tab.savedEol = data.eol;
      tab.eol = data.eol;
      tab.encoding = data.encoding;
      tab._dirtyShown = false;
      app.editor.resetContent(tab);
      app.tabsView.render();
      updateTitle();
      app.statusbar.update();
      updatePreview();
      toast(t('已从磁盘重新加载', 'Reloaded from disk'), 'success');
    } catch (err) {
      toast(t(`重新加载失败：${err.message || err}`, `Reload failed: ${err.message || err}`), 'error');
    }
  };

  /* -------------------------------------------------------------- 关闭流程 */

  /**
   * 关闭标签。
   * @param {string} id
   * @param {boolean} [force]
   * @return {Promise<void>}
   */
  app.closeTab = async function closeTab(id, force = false) {
    const tab = getTab(id);
    if (!tab) return;
    if (!force && isDirty(tab)) {
      setActiveId(id);
      const choice = await confirmClose(tab.name);
      if (choice === 'cancel') return;
      if (choice === 'save') {
        const ok = await app.saveTab(tab);
        if (!ok) return;
      }
    }
    app.editor.destroyState(id);
    removeTab(id);
    if (!state.tabs.length) updateWelcome();
  };

  /**
   * 关闭其它标签。
   * @param {string} keepId
   */
  app.closeOtherTabs = async function closeOtherTabs(keepId) {
    const others = state.tabs.filter((t) => t.id !== keepId);
    for (const tab of others) {
      // eslint-disable-next-line no-await-in-loop
      await app.closeTab(tab.id);
      if (getTab(tab.id)) return; // 用户取消了
    }
  };

  /** 关闭全部标签。 */
  app.closeAllTabs = async function closeAllTabs() {
    const all = state.tabs.slice();
    for (const tab of all) {
      // eslint-disable-next-line no-await-in-loop
      await app.closeTab(tab.id);
      if (getTab(tab.id)) return;
    }
    updateWelcome();
  };

  /**
   * 标签对应的磁盘绝对路径。
   *
   * 三条来源，优先级从高到低：
   *  1. `nativePath`：桌面壳读文件时记住的绝对路径（最可靠）；
   *  2. `path` 本身就是绝对路径（`D:/x/y.md`、`\\\\server\\share\\y.md`）；
   *  3. 从文件夹树打开时 `path` 只是相对路径，用已记住的文件夹根拼出来。
   *
   * 拿不到绝对路径（未命名 / 纯浏览器目录句柄）时返回空串，由调用方给出提示。
   *
   * @param {object|null} tab
   * @return {string}
   */
  function tabFsPath(tab) {
    if (!tab) return '';
    const native = String(tab.nativePath || '');
    if (native) return native;
    const raw = String(tab.path || '');
    if (!raw) return '';
    if (/^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || raw.startsWith('/')) return raw;
    const root = String((state.folder && state.folder.root) || '');
    if (!root) return '';
    return `${root.replace(/[\\/]+$/, '')}/${raw.replace(/^[\\/]+/, '')}`;
  }
  app.tabFsPath = tabFsPath;

  /**
   * 复制标签路径。
   *
   * 复制的是**磁盘绝对路径**：从文件夹树打开的文件 `tab.path` 只是相对路径，
   * 直接复制会得到「文件名」一样的片段（用户报的 bug）。
   *
   * @param {string} id
   */
  app.copyTabPath = async function copyTabPath(id) {
    const tab = getTab(id);
    if (!tab) return;
    const abs = tabFsPath(tab);
    const text = abs || tab.name;
    try {
      await navigator.clipboard.writeText(text);
      if (abs) {
        toast(t('完整路径已复制到剪贴板', 'Full path copied to the clipboard'), 'success');
      } else if (tab.handleKey) {
        // 旧版本用 File System Access API 保存的标签：文件在磁盘上，但句柄只有
        // 文件名、拿不到目录，所以这里**不能**说「尚未保存到磁盘」（那是假话）。
        toast(t('该文件已保存，但系统没记录它的完整路径；用「另存为」重新存一次即可恢复', 'This file is saved, but the system did not record its full path. Use "Save As" once to restore it.'), 'info', 4000);
      } else {
        toast(t('该文件尚未保存到磁盘，已复制文件名', 'This file is not on disk yet; the file name was copied instead'), 'info');
      }
    } catch {
      toast(t('复制失败，请检查剪贴板权限', 'Copy failed. Please check the clipboard permission.'), 'error');
    }
  };

  /**
   * 在系统文件管理器中定位该文件（桌面壳）。
   * @param {object} tab
   */
  app.revealTabInFolder = async function revealTabInFolder(tab) {
    if (!tab) return;
    const abs = tabFsPath(tab);
    if (!abs) {
      toast(
        tab.handleKey
          ? t('该文件已保存，但系统没记录它的完整路径；用「另存为」重新存一次即可定位', 'This file is saved, but the system did not record its full path. Use "Save As" once to reveal it.')
          : t('该文件还没有磁盘路径，无法在文件夹中定位', 'This file has no disk path yet, so it cannot be revealed in the folder'),
        'info',
        4000,
      );
      return;
    }
    if (!desktopBridge.canRevealInFolder()) {
      toast(t('当前环境不支持打开文件所在位置', 'Revealing files in the folder is not supported in this environment'), 'info');
      return;
    }
    const res = await desktopBridge.revealInFolder(abs);
    if (!res || !res.ok) toast(t(`定位失败：${(res && res.error) || '未知错误'}`, `Could not reveal the file: ${(res && res.error) || 'unknown error'}`), 'error', 3000);
  };

  /**
   * 在文件树中定位。
   * @param {object} tab
   */
  app.revealInTree = async function revealInTree(tab) {
    if (!tab) return;
    if (!app.sidebar.handle) {
      toast(t('还没有打开文件夹', 'No folder is open'), 'info');
      return;
    }
    const ok = await app.sidebar.revealPath(tab.path);
    if (!ok) toast(t('文件树中找不到该文件', 'The file was not found in the folder tree'), 'info');
    state.sidebarVisible = true;
    el.sidebar.hidden = false;
    el.sidebarResizer.hidden = false;
    app.persistSettings();
    app.toolbar.update();
  };

  /**
   * 拖拽排序标签。
   * @param {string} dragId
   * @param {string} targetId
   * @param {boolean} after
   */
  app.moveTab = function moveTab(dragId, targetId, after) {
    const from = state.tabs.findIndex((t) => t.id === dragId);
    let to = state.tabs.findIndex((t) => t.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = state.tabs.splice(from, 1);
    to = state.tabs.findIndex((t) => t.id === targetId);
    state.tabs.splice(after ? to + 1 : to, 0, moved);
    app.tabsView.render();
    persistSession();
  };

  /* -------------------------------------------------------------- 其它操作 */

  /**
   * 激活标签（包装）。
   * @param {string} id
   */
  app.activateTab = function activateTabById(id) {
    setActiveId(id);
  };

  /**
   * 循环切换标签页。
   * @param {number} delta 1 = 下一个，-1 = 上一个
   */
  app.cycleTab = function cycleTab(delta) {
    const tabs = state.tabs;
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === state.activeTabId);
    const next = tabs[(((idx < 0 ? 0 : idx) + delta) % tabs.length + tabs.length) % tabs.length];
    if (!next) return;
    setActiveId(next.id);
  };

  /** 当前活动标签。 */
  app.activeTab = activeTab;

  /** 当前语言。 */
  app.currentLanguageId = function currentLanguageId() {
    const tab = activeTab();
    return tab ? tab.language : 'plaintext';
  };

  /**
   * 标签图标名。
   * @param {object} tab
   * @return {string}
   */
  app.tabIcon = function tabIcon(tab) {
    if (!tab) return 'file';
    if (TEXT_LANGS.has(tab.language)) return 'fileText';
    if (isMarkdown(tab.language)) return 'fileText';
    return 'code';
  };

  /**
   * 直接设置某标签的正文（用于全局替换）。
   * @param {string} id
   * @param {string} text
   * @param {{markEdited?: boolean}} [opts]
   */
  app.setTabContent = function setTabContent(id, text, opts = {}) {
    const tab = getTab(id);
    if (!tab) return;
    // 正文被整体替换后，表格单元格浮层里记录的旧位置全部失效 → 先关掉
    closeTableCellEditor();
    tab.content = text;
    if (!opts.markEdited) tab.savedContent = text;
    if (id === state.activeTabId) {
      app.editor.replaceAll(text);
    } else {
      app.editor.states.delete(id);
    }
    app.tabsView.render();
    updateTitle();
    app.statusbar.update();
    persistSession();
  };

  /**
   * 把当前主题的语法色下发成 CSS 变量。
   *
   * 分屏预览与打印稿的代码着色走 `tok-*` 类名 + `--tok-*` 变量（与编辑器主题
   * 同一份调色板），这样切主题时预览里的关键字颜色跟着换，不用在 CSS 里
   * 再抄一份配色。
   *
   * @param {string} themeId
   */
  function applySyntaxPalette(themeId) {
    const pal = getThemeSyntaxPalette(themeId);
    if (!pal) return;
    const style = document.documentElement.style;
    style.setProperty('--tok-keyword', pal.keyword);
    style.setProperty('--tok-string', pal.string);
    style.setProperty('--tok-number', pal.number);
    style.setProperty('--tok-comment', pal.comment);
    style.setProperty('--tok-function', pal.function);
    style.setProperty('--tok-type', pal.type);
    style.setProperty('--tok-punct', pal.punct);
  }

  /**
   * 主题设置。
   * @param {string} id
   */
  app.setTheme = function setTheme(id) {
    const theme = THEMES.find((t) => t.id === id) || THEMES[0];
    state.theme = theme.id;
    state.themePinned = true;
    document.documentElement.dataset.theme = theme.id;
    applySyntaxPalette(theme.id);
    app.editor.setTheme(theme.id);
    app.persistSettings();
    toast(t(`主题已切换为 ${theme.label}`, `Theme switched to ${theme.label}`), 'info', 1500);
  };

  /** 循环切换主题。 */
  app.cycleTheme = function cycleTheme() {
    const idx = THEMES.findIndex((t) => t.id === state.theme);
    app.setTheme(THEMES[(idx + 1) % THEMES.length].id);
  };

  /**
   * 字号设置。
   * @param {number} size
   */
  app.setFontSize = function setFontSize(size) {
    state.fontSize = clamp(size, FONT_SIZE_MIN, FONT_SIZE_MAX);
    app.editor.setAppearance({ fontSize: state.fontSize });
    app.persistSettings();
  };

  // Ctrl + 滚轮缩放字号：挂在编辑区（编辑器 + 预览面板的公共父容器）上，
  // 上滚放大、下滚缩小，边界由 setFontSize 内部 clamp 到 FONT_SIZE_MIN/MAX。
  // 必须 passive: false 才能 preventDefault，阻止浏览器整页缩放。
  // 步进自适应（与键盘 / 菜单共用 fontStepFor）：<28 走 1px、28–99 走 4px、
  // ≥100 走 10px，否则从 14 调到 300 要滚几百次；
  // 再按 deltaY 量级分档：触控板小 delta 走一档，鼠标滚轮（常见 ±100）走两档。
  el.editorSplit.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      const base = fontStepFor(state.fontSize);
      const step = Math.abs(e.deltaY) >= 200 ? base * 2 : base;
      app.setFontSize(state.fontSize + (e.deltaY < 0 ? step : -step));
    },
    { passive: false },
  );

  /**
   * 自动换行。
   * @param {boolean} [value]
   */
  app.setWordWrap = function setWordWrap(value) {
    state.wordWrap = typeof value === 'boolean' ? value : !state.wordWrap;
    app.editor.setAppearance({ wordWrap: state.wordWrap });
    app.persistSettings();
    app.toolbar.update();
  };

  /**
   * 专注模式（T09 ③）：非当前段落行降低不透明度。
   * @param {boolean} [value]
   */
  app.setFocusMode = function setFocusMode(value) {
    state.focusMode = typeof value === 'boolean' ? value : !state.focusMode;
    applyAids();
    app.persistSettings();
    app.toolbar.update();
    app.statusbar.update();
    toast(state.focusMode ? t('专注模式已开启', 'Focus mode on') : t('专注模式已关闭', 'Focus mode off'), 'info', 1600);
  };

  /**
   * 打字机模式（T09 ④）：光标行保持在视口中央。
   * @param {boolean} [value]
   */
  app.setTypewriter = function setTypewriter(value) {
    state.typewriter = typeof value === 'boolean' ? value : !state.typewriter;
    applyAids();
    app.persistSettings();
    app.toolbar.update();
    app.statusbar.update();
    toast(state.typewriter ? t('打字机模式已开启', 'Typewriter mode on') : t('打字机模式已关闭', 'Typewriter mode off'), 'info', 1600);
  };

  /**
   * 迷你地图显隐（T09 ⑤）。
   * @param {boolean} [value]
   */
  /**
   * 切换「减少动效」（T16 ③）。
   *
   * 除了写 `html[data-reduce-motion]`（样式侧的总开关），还顺带同步
   * 系统级 `prefers-reduced-motion` —— 两者是**双通道**：
   * 用户没开设置项时也要尊重系统偏好，这是无障碍的基本要求。
   * @param {boolean} [value]
   */
  app.setReduceMotion = function setReduceMotion(value) {
    state.reduceMotion = typeof value === 'boolean' ? value : !state.reduceMotion;
    document.documentElement.dataset.reduceMotion = state.reduceMotion ? 'true' : 'false';
    app.persistSettings();
    app.statusbar.update();
    app.toolbar.update();
    toast(state.reduceMotion ? t('已开启减少动效', 'Reduce motion on') : t('已关闭减少动效', 'Reduce motion off'), 'info', 1800);
    return state.reduceMotion;
  };

  /**
   * 切换「减少动效」（T16 ③）。
   *
   * 除了写 `html[data-reduce-motion]`（样式侧的总开关），还顺带同步
   * 系统级 `prefers-reduced-motion` —— 两者是**双通道**：
   * 用户没开设置项时也要尊重系统偏好，这是无障碍的基本要求。
   * @param {boolean} [value]
   */
  app.setReduceMotion = function setReduceMotion(value) {
    state.reduceMotion = typeof value === 'boolean' ? value : !state.reduceMotion;
    document.documentElement.dataset.reduceMotion = state.reduceMotion ? 'true' : 'false';
    app.persistSettings();
    app.statusbar.update();
    app.toolbar.update();
    toast(state.reduceMotion ? t('已开启减少动效', 'Reduce motion on') : t('已关闭减少动效', 'Reduce motion off'), 'info', 1800);
    return state.reduceMotion;
  };

  app.setMinimap = function setMinimap(value) {
    state.minimapVisible = typeof value === 'boolean' ? value : !state.minimapVisible;
    applyAids();
    if (app.minimap) app.minimap.update();
    app.persistSettings();
    app.toolbar.update();
    toast(state.minimapVisible ? t('迷你地图已显示', 'Minimap shown') : t('迷你地图已隐藏', 'Minimap hidden'), 'info', 1600);
  };

  /**
   * 侧栏显隐。
   * @param {boolean} [value]
   */
  app.setSidebarVisible = function setSidebarVisible(value) {
    state.sidebarVisible = typeof value === 'boolean' ? value : !state.sidebarVisible;
    el.sidebar.hidden = !state.sidebarVisible;
    el.sidebarResizer.hidden = !state.sidebarVisible;
    app.persistSettings();
    app.toolbar.update();
  };

  /**
   * 禅模式。
   * @param {boolean} [value]
   */
  app.setZen = function setZen(value) {
    state.zen = typeof value === 'boolean' ? value : !state.zen;
    el.app.classList.toggle('is-zen', state.zen);
    app.toolbar.update();
    if (state.zen) toast(t('已进入禅模式，按 Esc 退出', 'Zen mode on. Press Esc to exit.'), 'info', 2000);
    requestAnimationFrame(() => app.editor.focus());
  };

  /**
   * Markdown 预览开关（`view.preview`，v1 兼容入口）。
   *
   * v2 语义：`view.preview` = 「分屏」的兼容别名。
   * 打开 → split；再点一次 → 回 wysiwyg（与 v1 的 on/off 语义等价，零回归）。
   */
  app.togglePreview = function togglePreview() {
    const tab = activeTab();
    if (!tab) return;
    if (!isMarkdown(tab.language)) {
      toast(t('只有 Markdown 文件支持预览', 'Only Markdown files support preview'), 'info');
      return;
    }
    if (state.viewMode === 'split') {
      app.setViewMode('wysiwyg', { user: true });
    } else {
      app.setViewMode('split', { user: true });
    }
  };

  /**
   * 打开外部链接（A2 链接行 / `Mod+Click`）。
   *
   * 桌面壳提供 `quillpadDesktop.openExternal` 时走 `qp:open-external` IPC；
   * 浏览器内降级为 `window.open`（noopener）。
   *
   * @param {string} url
   * @return {boolean}
   */
  app.openExternal = function openExternal(url) {
    const target = String(url || '').trim();
    if (!target) return false;
    if (!/^(https?:|mailto:)/i.test(target)) {
      toast(t(`不是可打开的链接：${target.slice(0, 40)}`, `Not an openable link: ${target.slice(0, 40)}`), 'info', 2400);
      return false;
    }
    // 统一的「打开外部链接」出口：先派发 DOM 事件（桌面壳 / 测试桩 / 插件都能监听）
    try {
      window.dispatchEvent(
        new CustomEvent('qp:open-external', { detail: { url: target } }),
      );
    } catch (err) {
      console.warn('[QuillPad] 派发 qp:open-external 失败：', err && err.message);
    }
    const bridge = typeof window !== 'undefined' ? window.quillpadDesktop : null;
    try {
      if (bridge && typeof bridge.openExternal === 'function') {
        bridge.openExternal(target);
        return true;
      }
      if (typeof window.__qpNoAutoOpen !== 'undefined' && window.__qpNoAutoOpen) return true;
      window.open(target, '_blank', 'noopener,noreferrer');
      return true;
    } catch (err) {
      console.warn('[QuillPad] 打开链接失败：', err && err.message);
      return false;
    }
  };

  /**
   * 切换语言。
   * @param {string} id
   */
  app.setLanguage = async function setLanguage(id) {
    const tab = activeTab();
    if (!tab) return;
    tab.language = id;
    await app.editor.setLanguage(tab, id);
    app.statusbar.update();
    if (state.sidebarTab === 'outline') app.sidebar.renderBody();
    refreshViewMode();
    persistSession();
    toast(t(`语言已切换为 ${languageLabel(id)}`, `Language switched to ${languageLabel(id)}`), 'info', 1500);
  };

  /** 循环缩进设置。 */
  app.cycleIndent = function cycleIndent() {
    const options = [
      { size: 2, tabs: false },
      { size: 4, tabs: false },
      { size: 8, tabs: false },
      { size: 4, tabs: true },
    ];
    const idx = options.findIndex(
      (o) => o.size === state.indentSize && o.tabs === state.useTabs,
    );
    const next = options[(idx + 1) % options.length];
    state.indentSize = next.size;
    state.useTabs = next.tabs;
    app.editor.setAppearance({ indentSize: state.indentSize, useTabs: state.useTabs });
    app.persistSettings();
    app.statusbar.update();
    // 先算出缩进量词再拼句子：避免在一个 t() 里嵌套模板字符串导致两次求值。
    const indentLabel = next.tabs ? 'Tab' : t(`空格 ${next.size}`, `${next.size} spaces`);
    toast(
      t(`缩进方式已切换为 ${indentLabel}`, `Indentation set to ${indentLabel}`),
      'info',
      1800,
    );
  };

  /** 切换换行符。 */
  app.toggleEol = function toggleEol() {
    const tab = activeTab();
    if (!tab) return;
    tab.eol = tab.eol === 'LF' ? 'CRLF' : 'LF';
    tab._dirtyShown = false;
    app.tabsView.render();
    updateTitle();
    app.statusbar.update();
    toast(t(`换行符已切换为 ${tab.eol}，保存后生效`, `Line endings switched to ${tab.eol}; it takes effect after saving`), 'info', 2200);
    persistSession();
  };

  /**
   * 写入最近文件。
   * @param {string} name
   * @param {string} path
   * @param {string|null} handleKey
   */
  function addRecent(name, path, handleKey, nativePath) {
    state.recent = [
      { name, path, handleKey, nativePath: nativePath || null },
      ...state.recent.filter((r) => r.path !== path),
    ].slice(0, 12);
    persistSessionLazy();
    if (!state.tabs.length) app.welcome.render();
  }
  app.addRecent = addRecent;

  /**
   * 打开最近文件。
   * @param {string} path
   */
  app.openRecent = async function openRecent(path) {
    const existing = state.tabs.find((t) => t.path === path);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const entry = state.recent.find((r) => r.path === path);
    if (!entry) {
      toast(t('找不到该文件的记录，请重新打开', 'No record of this file. Please open it again.'), 'info', 3000);
      return;
    }
    // 桌面壳里由系统打开的条目记的是绝对路径，直接走原生读取
    if (entry.nativePath && window.quillpadDesktop) {
      await app.openNativePath(entry.nativePath);
      return;
    }
    if (!entry.handleKey) {
      toast(t('该文件没有可用的磁盘句柄，请重新打开', 'This file has no usable disk handle. Please open it again.'), 'info', 3000);
      return;
    }
    const handle = await getFileHandle(entry.handleKey);
    if (!handle) {
      toast(t('无法恢复该文件，请重新打开', 'Cannot restore this file. Please open it again.'), 'error');
      return;
    }
    const ok = await ensurePermission(handle, 'readwrite');
    if (!ok) {
      toast(t('未获得文件访问权限', 'File access was not granted'), 'error');
      return;
    }
    await app.openFromHandle(handle, path);
  };

  /** 首次运行的欢迎文档。 */
  function openWelcomeDocument() {
    // 欢迎文档的标签名也是界面文案，跟随当前语言；内容由 samples.js 的
    // welcomeMarkdown() 在「读取点」按 getLocale() 取，不能用顶层常量
    // WELCOME_MD（import 期会把语言冻结成默认中文）。
    const welcomeName = t('欢迎.md', 'Welcome.md');
    const md = welcomeMarkdown();
    const tab = {
      id: nextTabId(),
      name: welcomeName,
      path: welcomeName,
      content: md,
      savedContent: md,
      savedEol: 'LF',
      language: 'markdown',
      eol: 'LF',
      encoding: 'UTF-8',
      handleKey: null,
      bigFile: false,
      _dirtyShown: false,
    };
    addTab(tab, true);
    requestAnimationFrame(() => app.editor.focus());
  }
  app.openWelcomeDocument = openWelcomeDocument;

  /**
   * 欢迎文档跟随界面语言（applyLocale 时调用）。
   *
   * 标签名 / 路径始终换为当前语言（欢迎.md ↔ Welcome.md）；正文仅在仍是
   * 模板原文（或会话瘦身恢复出的空正文）时替换为当前语言模板——用户改过
   * 的一律不覆盖，只改名。会话恢复出的欢迎标签走同一条路径，无特殊分支。
   */
  function syncWelcomeDocs() {
    const welcomeName = t('欢迎.md', 'Welcome.md');
    for (const tab of app.state.tabs) {
      if (!WELCOME_NAMES.includes(tab.path)) continue;
      tab.name = welcomeName;
      tab.path = welcomeName;
      if (!tab.content || isWelcomeTemplate(tab.content)) {
        const md = welcomeMarkdown();
        tab.content = md;
        tab.savedContent = md;
        tab._dirtyShown = false;
        if (app.state.activeTabId === tab.id) app.editor.resetContent(tab);
      }
    }
  }

  /** 搜索相关入口。 */
  app.openFind = () => runCommand('search.find', app);
  app.openReplace = () => runCommand('search.replace', app);
  app.openFindInFiles = () => runCommand('search.findInFiles', app);

  /* --------------------------------------------------------- 拖拽 / 窗口 */

  /** 配置拖拽打开文件。 */
  function setupDragAndDrop() {
    const zone = document.createElement('div');
    zone.className = 'dropzone';
    zone.hidden = true;
    zone.innerHTML = t(`<div class="dropzone__inner">${icon('openFile', 30)}松开即可打开文件</div>`, `<div class="dropzone__inner">${icon('openFile', 30)}Drop files here to open</div>`);
    document.body.appendChild(zone);

    let depth = 0;
    const hasFiles = (e) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth += 1;
      zone.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
      depth = 0;
      zone.hidden = true;
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;

      // T05 ②：拖进编辑区的图片 → 落到「文档目录/assets/」并插入 Markdown
      const inEditor = !!e.target && !!e.target.closest && !!e.target.closest('.cm-editor');
      if (inEditor) {
        const images = files.filter((f) => /^image\//.test(f.type || ''));
        if (images.length) {
          e.stopPropagation();
          for (const file of images) {
            // eslint-disable-next-line no-await-in-loop
            const res = await insertMarkdownImage(app, file);
            if (!res.ok) toast(res.error || t('插入图片失败', 'Failed to insert image'), 'error', 3400);
            else if (res.degraded) toast(t('已以内联 data URL 插入（建议先另存为）', 'Inserted as an inline data URL. Save the file first.'), 'info', 3200);
          }
          const rest = files.filter((f) => !/^image\//.test(f.type || ''));
          if (!rest.length) return;
        }
      }

      for (const file of files) {
        // 桌面壳能拿到 File 对应的真实路径，优先走原生通路，
        // 这样拖进来的文件保存时同样能直接写回原位置。
        const nativePath = window.quillpadDesktop?.getFilePath?.(file);
        if (nativePath) {
          // eslint-disable-next-line no-await-in-loop
          const opened = await app.openNativePath(nativePath);
          if (opened) continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await app.openFileObject(file);
      }
      toast(t(`已打开 ${files.length} 个文件`, `Opened ${files.length} files`), 'success');
    });
  }

  /**
   * 让编辑器内部的静态文案跟随语言。
   *
   * editor.js 已把 cmPlaceholder 放进 appearanceCompartment，并在构造里
   * 监听 bus('locale') 自行 refreshLocale()；这里再显式调一次 setPlaceholder()
   * （幂等的 Compartment 重配，撤销栈 / 选区 / 滚动都保留），保证即使编辑器层
   * 没有监听到事件也能切到当前语言。文案与编辑器层的 t() 原文逐字一致。
   * 若将来该方法被移除，退化为改写已渲染的 `.cm-placeholder` 节点。
   */
  function refreshEditorLocale() {
    const text = t(
      '以「Ctrl + N」新建文件，或把文件拖到这里打开',
      'Press Ctrl + N to create a file, or drop one here',
    );
    if (typeof app.editor?.setPlaceholder === 'function') {
      app.editor.setPlaceholder(text);
      return;
    }
    document.querySelectorAll('.cm-placeholder').forEach((node) => {
      node.textContent = text;
    });
  }

  /** 拖拽浮层只在 setupDragAndDrop() 里创建一次，切语言时单独刷新文案。 */
  function refreshDropzoneLabel() {
    const inner = document.querySelector('.dropzone__inner');
    if (!inner) return;
    inner.innerHTML = `${icon('openFile', 30)}${t('松开即可打开文件', 'Drop files here to open')}`;
  }

  /**
   * 全局刷新外壳（主题 / 界面语言等外部变更后调用）。
   *
   * 各 UI 模块的 render()/update() 都在渲染点求值 t()，因此只需重跑一遍；
   * 命令面板的条目是打开时算出来的，先关掉避免显示旧语言标题。
   */
  app.refreshChrome = function refreshChrome() {
    if (app.palette && typeof app.palette.isOpen === 'function' && app.palette.isOpen()) {
      app.palette.close();
    }
    if (app.menubar && typeof app.menubar.render === 'function') app.menubar.render();
    else if (typeof app.refreshMenubar === 'function') app.refreshMenubar();
    app.toolbar?.update?.();
    app.statusbar?.update?.();
    app.viewSwitch?.update?.();
    app.tabsView?.render?.();
    app.sidebar?.render?.();
    app.welcome?.render?.();
    // 面板若提供了 relabel()，只重算静态文案，不重建 DOM（避免重复绑定事件）。
    if (typeof app.findInFiles?.relabel === 'function') app.findInFiles.relabel();
    updateWelcome();
    updateDegradeBanner();
    refreshDropzoneLabel();
    refreshEditorLocale();
    updateTitle();
    applyStaticLabels();
  };

  /** 当前界面语言：供命令 / 插件 / 验收脚本读取。 */
  app.getLocale = getLocale;
  app.localeLabel = () => LOCALE_LABELS[getLocale()];

  /**
   * 切换界面语言。
   *
   * 刻意不用 location.reload()：persist.js 存会话时把 tab.content 清空，刷新会
   * 丢掉用户没保存的内容。这里改为原地重算命令标题 + 重绘外壳，标签页内容与
   * 光标位置都不动。
   *
   * @param {string} next 'zh-CN' | 'en'
   * @return {Promise<string>} 生效后的语言码
   */
  app.applyLocale = async function applyLocale(next) {
    const target = normalizeLocale(next);
    if (target === getLocale()) return target;

    setLocale(target);
    if (app.settings) app.settings.locale = target;
    // 必须走 persistSettings()（内部 collectSettings 把 state 里改过的主题 / 字号
    // 一起收敛）；直接 saveSettings(app.settings) 会把启动时的旧快照写回磁盘。
    if (typeof app.persistSettings === 'function') app.persistSettings();
    else saveSettings(app.settings || {});

    // 主进程原生对话框 / 插件错误不读 DOM，必须单独同步（失败不阻塞界面切换）。
    try {
      await window.quillpadDesktop?.setLocale?.(target);
    } catch (err) {
      console.warn('[QuillPad] 同步界面语言到主进程失败：', err);
    }

    // 命令标题是注册时求值的：清空后按新语言重注册。
    // resetCommands() 只保留 plugin.*（插件贡献的动态命令）；其它命令一律
    // 重新注册，包括 actions.js 里的 plugins.* 内置命令。
    // 先快照一份：有些 UI 模块（如 ui/plugins.js 的 initPluginUI）会在
    // registerCommands() 之外自己 defineCommand，它们必须自己监听 locale
    // 事件用新语言重注册；下面对「没补回来的」做一次原样恢复，保证切语言
    // 永远不会让菜单 / 快捷键丢入口（退化时标题可能仍是旧语言）。
    const commandsBefore = allCommands();
    resetCommands();
    registerCommands(app);
    // 给插件宿主 / UI 模块一个「语言变了」的信号：它们应按新语言重算自己的
    // 命令标题（同步重注册即可，此时这些 id 已被清空，不会触发重复注册告警）。
    bus.emit('locale', target);
    for (const stale of commandsBefore) {
      // plugin.* 由 resetCommands 原样保留，getCommand 一定命中；其余内置命令
      // 由 registerCommands 重建，只有「外部注册却没监听 locale」的会走到这里。
      if (!getCommand(stale.id)) defineCommand(stale);
    }

    // CodeMirror keymap 在启动时按命令对象生成，重注册后旧闭包还指向旧对象；
    // 重建一次即可。全局 keydown 处理器每次事件都读 allCommands()，无需重绑。
    app.editor?.setAppKeymap?.(buildCmKeymap((id) => runCommand(id, app)));

    // 欢迎文档正文 / 标签名跟随界面语言（用户改过的内容不覆盖）
    syncWelcomeDocs();

    app.refreshChrome();
    toast(t('界面语言已切换', 'Interface language changed'), 'info', 1800);
    return target;
  };

  /**
   * 以命令 id 触发一次动作（供快捷键 / 调试 / 扩展使用）。
   * @param {string} id
   * @param {Event} [evt]
   * @return {*}
   */
  app.run = function run(id, evt) {
    return runCommand(id, app, evt);
  };

  /* ------------------------------------------------------- v2 · 打印 / PDF
   * 把整条管线挂到 app 上：命令层、验收脚本、以及将来的插件都复用同一份实现，
   * 不各自 import 一遍（也避免测试脚本去 dynamic import 源码 —— 打包后没有源码路径）。 */
  app.print = {
    buildPrintHtml: printPipeline.buildPrintHtml,
    defaultPdfOptions: printPipeline.defaultPdfOptions,
    pdfFileNameFor: printPipeline.pdfFileNameFor,
    buildElectronPrintOptions: printPipeline.buildElectronPrintOptions,
    buildPageCss: printPipeline.buildPageCss,
    collectThemeTokens: printPipeline.collectThemeTokens,
    exportPdf: printPipeline.exportPdf,
    printDocument: printPipeline.printDocument,
    measureTocPages: printPipeline.measureTocPages,
    paperSizeMm: printPipeline.paperSizeMm,
  };
  app.desktop = desktopBridge;
  app.plugins = pluginHost;

  /** 插件贡献的侧栏视图（由 plugin-view.js 渲染，宿主只登记）。 */
  app.pluginViews = [];
  app.registerPluginView = function registerPluginView(view) {
    if (!view || !view.id) return;
    const at = app.pluginViews.findIndex((v) => v.id === view.id);
    if (at >= 0) app.pluginViews[at] = view;
    else app.pluginViews.push(view);
  };
  app.unregisterPluginViews = function unregisterPluginViews(pluginId) {
    app.pluginViews = app.pluginViews.filter((v) => v.pluginId !== pluginId);
  };
  app.emitPluginsChanged = function emitPluginsChanged() {
    // 插件管理器对话框打开时刷新其列表与市场卡片状态（侧栏插件页已移除）
    if (typeof app._refreshPluginManager === 'function') app._refreshPluginManager();
    if (app.statusbar && typeof app.statusbar.update === 'function') app.statusbar.update();
  };

  // T22–T24：插件市场 / 权限确认 / .dll 拒绝 / Npp 导入向导的 UI 入口。
  // 纯附加式初始化，失败只警告，绝不阻塞首屏（与插件平台启动同一策略）。
  try {
    initPluginUI(app);
  } catch (err) {
    console.warn('[QuillPad] 插件 UI 初始化失败：', err && err.message);
  }

  /* ------------------------------------------------------------- 启动流程 */

  await restoreSession();

  // 插件平台：失败只警告，绝不阻塞首屏；崩溃停用的插件不会被自动复活
  pluginHost
    .primeBaseUrl()
    .then(() => pluginHost.refresh(app))
    .then(() => app.emitPluginsChanged())
    .catch((err) => console.warn('[QuillPad] 插件平台初始化失败：', err && err.message));

  if (!state.tabs.length && !app._restoredSession) {
    openWelcomeDocument();
  }

  updateTitle();
  updateWelcome();
  app.toolbar.update();
  app.statusbar.update();
  refreshViewMode();
  app.sidebar.render();

  return app;
}
