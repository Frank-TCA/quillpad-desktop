/**
 * QuillPad · 插件市场数据源（T22）
 *
 * 发布态 `plugins/catalog.json` 是唯一数据源；拉取失败时回落到
 * `src/data/catalog.json` 的编译期内联副本，并给出顶部提示条（PRD §4.G2）。
 * 搜索：id / name / description / keywords 大小写不敏感子串，中英文都能命中。
 *
 * 本文件里的中文串都是「状态机 / 筛选比较 / 断言」用的稳定 key，不是显示文案：
 * 按 ui/plugins.js 的既有约定写成单参数 t('中文原文')（英文参数缺失时恒返回中文），
 * 英文显示由 UI 渲染点的 localizedStateLabel() / localizedActionLabel() /
 * categoryLabel() 完成。t() 同时也让静态审计把这些 key 识别为已处理。
 */

import { LICENSE_WHITELIST, HIGH_RISK_PERMISSIONS, PERMISSION_LABELS } from './manifest.js';
import { t } from '../i18n.js';

/** 分类枚举（PRD §4.G2）。实际下拉框只列出目录里真实存在的分类，见 `categoriesOf`。 */
export const CATEGORIES = Object.freeze([t('全部'), t('文本处理'), 'Markdown', t('开发者'), t('主题'), t('语言')]);

/**
 * 由目录数据推出可用的分类列表（「全部」恒在首位）。
 *
 * 为什么不直接用 `CATEGORIES`：分类是跟着包走的，目录里没有该类插件时
 * 下拉框仍列出「主题 / 语言」会让用户选到空结果，看起来就像插件丢了。
 *
 * @param {Array<object>} items 目录条目
 * @return {string[]}
 */
export function categoriesOf(items = []) {
  const seen = [];
  for (const item of items) {
    const c = String((item && item.category) || '').trim();
    if (c && !seen.includes(c)) seen.push(c);
  }
  return [t('全部'), ...seen];
}

/** 排序枚举。 */
export const SORTS = Object.freeze([
  { id: 'recommended', label: '推荐', labelEn: 'Recommended' },
  { id: 'name', label: '名称', labelEn: 'Name' },
  { id: 'updated', label: '更新时间', labelEn: 'Last Updated' },
]);

/** 编译期内联兜底（Vite 会把 JSON 打进 bundle）。 */
import BUILTIN from '../../data/catalog.json';

/** 内存缓存。 */
let cache = null;

/**
 * 载入 catalog（可强制刷新）。
 * @param {boolean} [force]
 * @return {Promise<{items: Array<object>, source: string, warning: string}>}
 */
export async function loadCatalog(force = false) {
  if (cache && !force) return { ...cache, items: cache.items.slice() };
  let items = [];
  let source = 'builtin';
  let warning = '';
  try {
    const res = await fetch(new URL('./plugins/catalog.json', document.baseURI).href, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.plugins)) throw new Error(t('catalog 结构不合法', 'Invalid catalog structure'));
    items = data.plugins;
    source = 'dist';
  } catch {
    items = Array.isArray(BUILTIN.plugins) ? BUILTIN.plugins : [];
    source = 'builtin';
    warning = t('插件目录更新失败，正在显示内置列表', 'Failed to update the plugin catalog; showing the built-in list');
  }
  cache = { items, source, warning };
  return { items: items.slice(), source, warning };
}

/**
 * 关键字匹配（大小写不敏感子串）。
 * @param {object} plugin
 * @param {string} query
 * @return {boolean}
 */
export function matches(plugin, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    plugin.id,
    plugin.name,
    plugin.description,
    ...(Array.isArray(plugin.keywords) ? plugin.keywords : []),
    plugin.nameEn,
    plugin.titleEn,
    plugin.descriptionEn,
    ...(Array.isArray(plugin.featuresEn) ? plugin.featuresEn : []),
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

/**
 * 搜索 + 分类筛选 + 排序。
 * @param {Array<object>} items
 * @param {{query?: string, category?: string, sort?: string}} [opts]
 * @return {Array<object>}
 */
export function searchCatalog(items, opts = {}) {
  let out = (Array.isArray(items) ? items : []).filter((p) => matches(p, opts.query));
  const cat = String(opts.category || t('全部'));
  if (cat !== t('全部')) out = out.filter((p) => String(p.category || '') === cat);
  const sort = String(opts.sort || 'recommended');
  if (sort === 'name') {
    out = out.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  } else if (sort === 'updated') {
    out = out.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } else {
    out = out.slice().sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0));
  }
  return out;
}

/**
 * 计算卡片状态标签（四态）。
 *
 * 标签保持中文原文：UI 在渲染点用 localizedStateLabel() 翻译，且
 * `st.label.startsWith('已阻止')` 等分支依赖中文原文做状态判断。
 * @param {object} plugin catalog 条目
 * @param {object|null} installed 已安装状态
 * @return {{state: 'not-installed'|'installed'|'updatable'|'disabled'|'blocked', label: string, version: string}}
 */
export function pluginState(plugin, installed) {
  if (!installed) return { state: 'not-installed', label: t('未安装'), version: '' };
  const version = String(installed.version || '');
  if (installed.blocked) return { state: 'disabled', label: t('已阻止（License 不合规）'), version };
  if (!installed.enabled) {
    return {
      state: 'disabled',
      label: installed.disabledReason === 'crashed' ? t('已停用（无响应）') : t('已禁用'),
      version,
    };
  }
  const cmp = String(plugin.version || '').split('.').map(Number);
  const cur = version.split('.').map(Number);
  let newer = false;
  for (let i = 0; i < 3; i += 1) {
    if ((cmp[i] || 0) > (cur[i] || 0)) { newer = true; break; }
    if ((cmp[i] || 0) < (cur[i] || 0)) break;
  }
  if (newer) return { state: 'updatable', label: t(`可更新到 v${plugin.version}`), version };
  return { state: 'installed', label: t(`已安装 v${version}`), version };
}

/**
 * 主按钮文案（PRD §5.4 唯一来源）。
 * @param {{state: string}} st
 * @param {object} plugin
 * @return {string}
 */
export function actionLabel(st, plugin) {
  if (st.state === 'not-installed') return t('安装');
  if (st.state === 'updatable') return t(`更新到 v${plugin.version}`);
  if (st.state === 'disabled') return t('启用');
  return t('已安装');
}

/**
 * 权限摘要（最多 3 个 icon，超出 +N）。
 * @param {string[]} permissions
 * @return {string}
 */
export function permissionSummary(permissions) {
  const list = Array.isArray(permissions) ? permissions : [];
  const shown = list.slice(0, 3).map((p) => (PERMISSION_LABELS[p] ? PERMISSION_LABELS[p].name.slice(0, 1) : '·'));
  return shown.join(' ') + (list.length > 3 ? ` +${list.length - 3}` : '');
}

/**
 * License 是否在白名单内。
 * @param {string} license
 * @return {boolean}
 */
export function isAllowedLicense(license) {
  return LICENSE_WHITELIST.includes(String(license || ''));
}

/**
 * 是否含高风险权限。
 * @param {string[]} permissions
 * @return {boolean}
 */
export function hasHighRisk(permissions) {
  return (Array.isArray(permissions) ? permissions : []).some((p) => HIGH_RISK_PERMISSIONS.includes(p));
}

/** 测试用：清缓存。 */
export function __resetCatalog() {
  cache = null;
}

export { LICENSE_WHITELIST, PERMISSION_LABELS };
