/**
 * QuillPad · 全局状态与事件总线
 *
 * 应用只有一份可变状态树，所有 UI 模块订阅自己关心的事件后重绘。
 * 这里不做虚拟 DOM，重绘都是「局部 innerHTML 替换 + 事件委托」，
 * 对几十个标签 / 几百个树节点完全够用，且零框架开销。
 */

/** 极简事件总线。 */
class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.map = new Map();
  }

  /**
   * 订阅事件。
   * @param {string} type 事件名
   * @param {Function} fn 回调
   * @return {Function} 取消订阅函数
   */
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.off(type, fn);
  }

  /**
   * 取消订阅。
   * @param {string} type 事件名
   * @param {Function} fn 回调
   */
  off(type, fn) {
    const set = this.map.get(type);
    if (set) set.delete(fn);
  }

  /**
   * 派发事件。监听器异常不会影响其它监听器。
   * @param {string} type 事件名
   * @param {*} [payload] 载荷
   */
  emit(type, payload) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[QuillPad] 事件 "${type}" 监听器异常：`, err);
      }
    }
  }
}

/** 全局事件总线实例。 */
export const bus = new Emitter();

/** 单个标签可承载的最大字符数保护（超过则提示并降级）。 */
export const BIG_FILE_THRESHOLD = 2 * 1024 * 1024;

/** 应用状态。 */
export const state = {
  /** @type {Array<object>} 打开的标签 */
  tabs: [],
  /** @type {string|null} 当前活动标签 id */
  activeTabId: null,

  /* 外观 */
  theme: 'ivory',
  /** 是否由用户显式选过主题（决定是否按新默认值迁移到浅色）。 */
  themePinned: false,
  fontSize: 14,
  wordWrap: false,

  /* 侧栏 */
  sidebarVisible: true,
  sidebarWidth: 248,
  sidebarTab: 'files',

  /* 编辑偏好 */
  autoSave: false,
  indentSize: 2,
  useTabs: false,

  /* Markdown 预览 */
  previewVisible: false,

  /* --------------------------------------------------- v2 视图模式（A1） */
  /** @type {'source'|'wysiwyg'|'split'} 当前标签的**有效**模式（QA 直接断言） */
  viewMode: 'source',
  /** @type {'auto'|'source'|'wysiwyg'|'split'} 用户偏好 */
  viewModePreference: 'auto',
  /** 用户是否在分段控件里显式选过模式 */
  viewModeLocked: false,

  /* ------------------------------------------------- v2 WYSIWYG 运行态（A9） */
  /** @type {Set<string>} 会话内「仍要启用」的 tabId */
  wysiwygForced: new Set(),
  /** 当前是否因大文件降级 */
  wysiwygDegraded: false,
  /** 装饰层统计（块级 / 行内条数 / 耗时 ms） */
  wysiwygStats: { blocks: 0, inline: 0, ms: 0 },

  /* --------------------------------------------------- v2 专注 / 打字机 / 迷你地图 */
  focusMode: false,
  typewriter: false,
  minimapVisible: false,

  /* ------------------------------------------------------------- v2 PDF */
  pdfExporting: false,

  /* ------------------------------------------------------------- v2 宏 */
  macro: { recording: false, steps: [], name: '' },

  /* ------------------------------------------------------------ v2 插件 */
  plugins: {
    ready: false,
    /** @type {Array<object>} */
    installed: [],
    /** @type {Array<object>} */
    catalog: [],
    catalogError: null,
    /** @type {Map<string, object>} id -> sandbox handle（不持久化） */
    sandboxes: new Map(),
    /** @type {Map<string, object>} `${pluginId}:${viewId}` -> {title, nodes, handlers} */
    views: new Map(),
  },

  /* 禅模式 */
  zen: false,

  /* 最近打开 */
  /** @type {Array<{name: string, path: string}>} */
  recent: [],

  /* 已打开的文件夹 */
  /** @type {{name: string, handleKey: string}|null} */
  folder: null,
};

let tabSeq = 0;

/**
 * 生成一个标签 id。
 * @return {string}
 */
export function nextTabId() {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}

/**
 * 判断标签是否有未保存改动（正文或换行符变化）。
 * @param {object|null} tab
 * @return {boolean}
 */
export function isDirty(tab) {
  if (!tab) return false;
  if (tab.content !== tab.savedContent) return true;
  if (tab.savedEol != null && tab.eol !== tab.savedEol) return true;
  return false;
}

/**
 * 按 id 取标签。
 * @param {string|null} id
 * @return {object|null}
 */
export function getTab(id) {
  if (!id) return null;
  return state.tabs.find((t) => t.id === id) || null;
}

/**
 * 取当前活动标签。
 * @return {object|null}
 */
export function activeTab() {
  return getTab(state.activeTabId);
}

/**
 * 标签索引。
 * @param {string} id
 * @return {number}
 */
export function tabIndex(id) {
  return state.tabs.findIndex((t) => t.id === id);
}

/**
 * 添加标签并激活。
 * @param {object} tab
 * @param {boolean} [activate] 是否激活，默认 true
 * @return {object} 加入后的标签
 */
export function addTab(tab, activate = true) {
  state.tabs.push(tab);
  if (activate) state.activeTabId = tab.id;
  bus.emit('tabs');
  if (activate) bus.emit('active', tab.id);
  return tab;
}

/**
 * 移除标签，并自动把活动标签迁移到相邻标签。
 * @param {string} id
 * @return {boolean} 是否真的移除了
 */
export function removeTab(id) {
  const idx = tabIndex(id);
  if (idx < 0) return false;
  const wasActive = state.activeTabId === id;
  state.tabs.splice(idx, 1);
  if (wasActive) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    state.activeTabId = next ? next.id : null;
  }
  bus.emit('tabs');
  if (wasActive) bus.emit('active', state.activeTabId);
  return true;
}

/**
 * 激活标签。
 * @param {string|null} id
 */
export function activateTab(id) {
  if (state.activeTabId === id) return;
  if (id && !getTab(id)) return;
  state.activeTabId = id;
  bus.emit('active', id);
}

/**
 * 重置标签集合（用于会话恢复）。
 * @param {Array<object>} tabs
 * @param {string|null} activeId
 */
export function setTabs(tabs, activeId) {
  state.tabs = tabs;
  state.activeTabId = activeId && tabs.some((t) => t.id === activeId) ? activeId : (tabs[0] ? tabs[0].id : null);
  bus.emit('tabs');
  bus.emit('active', state.activeTabId);
}
