/**
 * QuillPad · 用户偏好设置
 *
 * 采用 localStorage 保存，跨刷新 / 跨会话生效。
 * v2 起新增「视图模式 / 装饰开关 / PDF / 宏 / 插件」五组字段：
 * 全部按「深合并 + 逐字段校验」读取，保证 v1 的旧数据（缺字段）也能安全升级，
 * 且任何脏值（类型错、越界、枚举外）都会回落到默认值而不是抛错。
 */

const SETTINGS_KEY = 'quillpad.settings.v1';

/**
 * 字号允许区间。
 *
 * 下限 14px 与默认字号一致：再小既难看清，也会让行号（固定 14px）比正文还大。
 */
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 300;

/**
 * 字号调节步进。小字号精细调，大字号跨步调，
 * 否则从 14 调到上限要按几百次。
 * @param {number} size 当前字号（px）
 * @return {number} 本次应增减的 px
 */
export function fontStepFor(size) {
  if (size < 28) return 1;
  if (size < 100) return 4;
  return 10;
}

/** 侧栏宽度允许区间。 */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;

/** 视图模式枚举：偏好（含 auto）与有效值。 */
export const VIEW_MODE_PREFERENCES = ['auto', 'source', 'wysiwyg', 'split'];
export const VIEW_MODES = ['source', 'wysiwyg', 'split'];

/** PDF 纸张与其它枚举。 */
export const PDF_PAPERS = ['A4', 'Letter', 'custom'];
export const PDF_ORIENTATIONS = ['portrait', 'landscape'];
export const PDF_THEMES = ['follow', 'light', 'dark'];
export const PDF_CODE_THEMES = ['follow', 'github-light', 'one-dark', 'solarized'];
export const PDF_IMAGE_WIDTHS = [25, 50, 75, 100];
export const PDF_PAGE_NUMBERS = ['off', 'footer-center', 'footer-right'];
export const PDF_HEADER_MODES = ['none', 'filename', 'custom'];
export const PDF_FOOTER_MODES = ['none', 'filename-date', 'custom'];

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  /* ---------------- v1 既有九项（键名与默认值保持不变） ---------------- */
  theme: 'ivory',
  /** 用户是否显式选过主题（false 时允许按新默认值迁移，见 app.js 启动段）。 */
  themePinned: false,
  fontSize: 14,
  wordWrap: false,
  sidebarVisible: true,
  sidebarWidth: 248,
  sidebarTab: 'files',
  autoSave: false,
  indentSize: 2,
  useTabs: false,

  /* ---------------------------- v2 视图模式 ---------------------------- */
  viewMode: 'auto',
  viewModeLocked: false,
  reduceMotion: false,

  /* ------------------------- v2 装饰层细粒度开关 ------------------------ */
  decorations: {
    math: true,
    toc: true,
    footnotes: true,
    frontmatter: true,
    images: true,
    tasks: true,
    focusMode: false,
    typewriter: false,
    minimap: false,
  },

  /* ------------------------------- v2 PDF ------------------------------ */
  pdf: {
    paper: 'A4',
    customWidth: 210,
    customHeight: 297,
    orientation: 'portrait',
    margin: { top: 20, bottom: 20, left: 18, right: 18 },
    theme: 'follow',
    codeTheme: 'follow',
    imageMaxWidth: 100,
    pageNumber: 'footer-center',
    toc: false,
    header: { mode: 'none', text: '' },
    footer: { mode: 'none', text: '' },
    lastDir: null,
    fileName: '',
  },

  /* ------------------------------- v2 宏 ------------------------------- */
  macro: { enabled: true, showStatusDot: true },

  /* ------------------------------ v2 插件 ------------------------------ */
  plugins: {
    remoteCatalogUrl: '',
    autoCheckUpdates: false,
    hideDuplicateCommands: false,
    lastMarketTab: 'market',
  },
};

/**
 * 数值夹紧。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @return {number}
 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 是否为普通对象（非 null / 非数组）。 */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深合并：以 base 为骨架，用 patch 中「同类型」的值覆盖。
 *
 * 规则（迁移友好）：
 * - patch 缺失的键 → 保留 base 的值（v1 旧数据天然升级）；
 * - 两边都是普通对象 → 递归；
 * - patch 的值类型与 base 不一致 → **丢弃 patch**，保留 base（脏值兜底）；
 * - 数组与其它标量 → 直接取 patch（但调用方需自行校验，见下面的逐字段校验）。
 *
 * @template T
 * @param {T} base
 * @param {any} patch
 * @return {T}
 */
export function deepMerge(base, patch) {
  if (!isPlainObject(base)) return base;
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    const b = base[key];
    const p = patch[key];
    if (isPlainObject(b)) {
      out[key] = deepMerge(b, p);
    } else if (typeof b === typeof p) {
      out[key] = p;
    }
  }
  return out;
}

/** 深拷贝默认值（避免调用方改到 DEFAULT_SETTINGS）。 */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

/** 取枚举内的值，否则回落。 */
function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** 取布尔值，否则回落。 */
function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 取字符串，否则回落。 */
function pickString(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 逐字段校验一份「已深合并」的设置对象，把越界/枚举外/类型错的值拉回默认。
 * @param {any} merged
 * @return {typeof DEFAULT_SETTINGS}
 */
function sanitize(merged) {
  const d = DEFAULT_SETTINGS;
  const out = cloneDefaults();

  /* v1 九项 */
  if (typeof merged.theme === 'string') out.theme = merged.theme;
  out.themePinned = pickBool(merged.themePinned, d.themePinned);
  out.fontSize = clamp(merged.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
  out.wordWrap = pickBool(merged.wordWrap, d.wordWrap);
  out.sidebarVisible = pickBool(merged.sidebarVisible, d.sidebarVisible);
  out.sidebarWidth = clamp(merged.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
  // 侧栏只保留「文件 / 大纲」两个 tab；历史值 'plugins'（v2 三期侧栏插件页）
  // 已随插件市场迁入插件管理器对话框而移除，迁移为 'files'。
  const sidebarTab = merged.sidebarTab === 'plugins' ? 'files' : merged.sidebarTab;
  out.sidebarTab = ['files', 'outline'].includes(sidebarTab) ? sidebarTab : 'files';
  out.autoSave = pickBool(merged.autoSave, d.autoSave);
  out.indentSize = clamp(merged.indentSize, 1, 8);
  out.useTabs = pickBool(merged.useTabs, d.useTabs);

  /* v2 视图模式 */
  out.viewMode = pickEnum(merged.viewMode, VIEW_MODE_PREFERENCES, d.viewMode);
  out.viewModeLocked = pickBool(merged.viewModeLocked, d.viewModeLocked);
  out.reduceMotion = pickBool(merged.reduceMotion, d.reduceMotion);

  /* v2 装饰开关 */
  for (const key of Object.keys(d.decorations)) {
    out.decorations[key] = pickBool(merged.decorations?.[key], d.decorations[key]);
  }

  /* v2 PDF */
  const pdf = merged.pdf || {};
  out.pdf.paper = pickEnum(pdf.paper, PDF_PAPERS, d.pdf.paper);
  out.pdf.customWidth = clamp(pdf.customWidth ?? d.pdf.customWidth, 50, 2000);
  out.pdf.customHeight = clamp(pdf.customHeight ?? d.pdf.customHeight, 50, 2000);
  out.pdf.orientation = pickEnum(pdf.orientation, PDF_ORIENTATIONS, d.pdf.orientation);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    out.pdf.margin[side] = clamp(pdf.margin?.[side] ?? d.pdf.margin[side], 0, 100);
  }
  out.pdf.theme = pickEnum(pdf.theme, PDF_THEMES, d.pdf.theme);
  out.pdf.codeTheme = pickEnum(pdf.codeTheme, PDF_CODE_THEMES, d.pdf.codeTheme);
  out.pdf.imageMaxWidth = PDF_IMAGE_WIDTHS.includes(Number(pdf.imageMaxWidth))
    ? Number(pdf.imageMaxWidth)
    : d.pdf.imageMaxWidth;
  out.pdf.pageNumber = pickEnum(pdf.pageNumber, PDF_PAGE_NUMBERS, d.pdf.pageNumber);
  out.pdf.toc = pickBool(pdf.toc, d.pdf.toc);
  out.pdf.header.mode = pickEnum(pdf.header?.mode, PDF_HEADER_MODES, d.pdf.header.mode);
  out.pdf.header.text = pickString(pdf.header?.text, '');
  out.pdf.footer.mode = pickEnum(pdf.footer?.mode, PDF_FOOTER_MODES, d.pdf.footer.mode);
  out.pdf.footer.text = pickString(pdf.footer?.text, '');
  out.pdf.lastDir = typeof pdf.lastDir === 'string' ? pdf.lastDir : null;
  out.pdf.fileName = pickString(pdf.fileName, '');

  /* v2 宏 */
  out.macro.enabled = pickBool(merged.macro?.enabled, d.macro.enabled);
  out.macro.showStatusDot = pickBool(merged.macro?.showStatusDot, d.macro.showStatusDot);

  /* v2 插件 */
  out.plugins.remoteCatalogUrl = pickString(merged.plugins?.remoteCatalogUrl, '');
  out.plugins.autoCheckUpdates = pickBool(
    merged.plugins?.autoCheckUpdates,
    d.plugins.autoCheckUpdates,
  );
  out.plugins.hideDuplicateCommands = pickBool(
    merged.plugins?.hideDuplicateCommands,
    d.plugins.hideDuplicateCommands,
  );
  out.plugins.lastMarketTab = pickEnum(
    merged.plugins?.lastMarketTab,
    ['installed', 'market', 'blocked'],
    d.plugins.lastMarketTab,
  );

  return out;
}

/**
 * 从 localStorage 读取设置，缺失字段用默认值补齐。
 *
 * 关键行为（T01 验收③）：v1 写下的旧 JSON（没有 viewMode / pdf 等字段）
 * 必须**不抛错**，且 `viewMode === 'auto'`、`pdf.margin.top === 20`。
 *
 * @return {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  const result = cloneDefaults();
  try {
    if (typeof localStorage === 'undefined') return result;
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return result;
    return sanitize(deepMerge(DEFAULT_SETTINGS, parsed));
  } catch (err) {
    console.warn('[QuillPad] 读取设置失败，使用默认值：', err);
  }
  return result;
}

/**
 * 保存设置。
 * @param {typeof DEFAULT_SETTINGS} settings
 */
export function saveSettings(settings) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('[QuillPad] 保存设置失败：', err);
  }
}

/**
 * 从一份完整的 settings 对象里挑选允许持久化的键（深拷贝，避免外部改到默认值）。
 * @param {object} src
 * @return {typeof DEFAULT_SETTINGS}
 */
export function pickSettings(src) {
  const merged = deepMerge(DEFAULT_SETTINGS, src || {});
  return sanitize(merged);
}
