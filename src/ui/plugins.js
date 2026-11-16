/**
 * QuillPad · 插件市场 / 权限确认 / `.dll` 拒绝 / Npp 导入向导（T22–T24）
 *
 * 全部 DOM 契约来自 PRD §5.4–5.7 与 §4.G5，data-* 属性是 QA 的断言依据，
 * 不得随意改名。能力边界声明统一取自 `core/plugins/notice.js`，保证
 * G5-15 的「不存在 HWND」「不加载任何 .dll」在三处可检索且不漂移。
 *
 * 设计取舍：这里**不复用 `openModal()`**。三个弹窗都需要多步状态
 * （权限勾选联动按钮、向导 3 步、`.dll` 三条出路各自跳转），
 * 自建 backdrop 才能把 `data-dialog` / `data-perm` / `data-npp-*`
 * 全部握在本文件里，也不影响 v1 既有对话框断言。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { toast } from './toast.js';
import { defineCommand, getCommand, unregisterCommand } from '../core/commands.js';
import { bus } from '../core/state.js';
import * as desktop from '../core/desktop.js';
import * as host from '../core/plugins/host.js';
import * as pluginState from '../core/plugins/state.js';
import {
  loadCatalog,
  searchCatalog,
  matches,
  pluginState as cardState,
  actionLabel,
  isAllowedLicense,
  hasHighRisk,
  PERMISSION_LABELS,
  categoriesOf,
  SORTS,
} from '../core/plugins/catalog.js';
import {
  EXPECTED_NOTICE,
  noticeHtml,
  DLL_REJECT_REASON,
  DLL_REJECT_REASON_EN,
} from '../core/plugins/notice.js';
import { loadCompat, mapScanned, summarizeNpp } from '../core/npp-compat.js';
import { t, pickLocalized } from '../core/i18n.js';

/** 当前打开的对话框（同时只允许一个）。 */
let currentDialog = null;

/**
 * 「全部分类」的筛选值。
 * 它是 `<option value>` 的内部值（筛选逻辑拿它与 catalog 的中文分类比对），不是展示文案，
 * 所以直接取 `categoriesOf([])` 的首项，避免在 UI 里再硬编码一份中文。
 */
export const ALL_CATEGORY = categoriesOf([])[0];

/* ------------------------------------------------------------------ 本地化助手
 * 目录 / 清单里的中文字段由数据层统一提供 `<字段>En`（nameEn / descriptionEn …）。
 * 下面这些映射只是兜底：数据层还没补 En 字段时，枚举值、状态标签之类也不会漏中文。
 *
 * 关于键的写法：用 `t('中文原文')`（只给中文参数）生成。按 i18n.js 的约定，英文参数
 * 缺失时恒返回中文原文，所以这些键不随界面语言变化，可以直接与 catalog / 清单里的
 * 中文字段比对；真正展示给用户的英文由映射的值提供。所有映射都是函数，在渲染点才求值。 */

/** 分类下拉的英文兜底（键为稳定的中文原文）。 */
function categoryEnMap() {
  return {
    [t('全部')]: 'All',
    [t('文本处理')]: 'Text Tools',
    [t('Markdown')]: 'Markdown',
    [t('开发者')]: 'Developer',
    [t('主题')]: 'Theme',
    [t('语言')]: 'Language',
  };
}

/** 排序下拉的英文兜底（键为排序 id，与界面语言无关）。 */
const SORT_EN = Object.freeze({
  recommended: 'Recommended',
  name: 'Name',
  updated: 'Last Updated',
});

/** 作者字段的英文兜底（键为稳定的中文原文）。 */
function authorEnMap() {
  return {
    [t('QuillPad 官方')]: 'QuillPad Official',
    [t('社区示例')]: 'Community Example',
    [t('未知')]: 'Unknown',
  };
}

/** 权限名称 / 效果说明的英文兜底（键为权限 id，与界面语言无关）。 */
const PERMISSION_EN = Object.freeze({
  'editor:read': { name: 'Read Editor Content', effect: 'Reads the text and selection you are editing' },
  'editor:write': { name: 'Modify Editor Content', effect: 'Replaces the selection or inserts text, changing the current document' },
  'files:read': { name: 'Read File Info', effect: 'Reads the current document path and content' },
  'files:write': { name: 'Write Files', effect: 'Triggers Save or Save As and can overwrite files on disk' },
  clipboard: { name: 'Clipboard', effect: 'Reads or writes the system clipboard' },
  network: { name: 'Network Access', effect: 'The plugin can access the network and may send file contents to external servers' },
  settings: { name: 'Plugin Storage', effect: 'Stores the plugin’s own settings (≤ 1 MB)' },
});

/** 卡片状态标签里固定短语的英文兜底（键为稳定的中文原文）。 */
function stateLabelEnMap() {
  return {
    [t('未安装')]: 'Not Installed',
    [t('已阻止（License 不合规）')]: 'Blocked (Non-compliant License)',
    [t('已停用（无响应）')]: 'Disabled (Not Responding)',
    [t('已禁用')]: 'Disabled',
    [t('已启用')]: 'Enabled',
  };
}

/** 市场按钮固定短语的英文兜底（键为稳定的中文原文）。 */
function actionLabelEnMap() {
  return {
    [t('安装')]: 'Install',
    [t('启用')]: 'Enable',
    [t('已安装')]: 'Installed',
  };
}

/**
 * 读取目录 / 清单对象里的本地化字段（优先 `<字段>En`，缺失时回退给定英文）。
 * @param {object|null|undefined} source
 * @param {string} key 中文字段名
 * @param {string} fallbackEn
 * @return {string}
 */
function localizedField(source, key, fallbackEn = '') {
  const zh = source && typeof source[key] === 'string' ? source[key] : '';
  const en = (source && typeof source[`${key}En`] === 'string' && source[`${key}En`]) || fallbackEn;
  return t(zh, en);
}

/**
 * 分类下拉的显示名（value 仍保持中文，筛选逻辑不依赖显示名）。
 * @param {string} category
 * @param {Array<object>} items
 * @return {string}
 */
function categoryLabel(category, items) {
  const c = String(category || '');
  const sample = (Array.isArray(items) ? items : []).find((p) => String(p.category || '') === c);
  const en = (sample && sample.categoryEn) || categoryEnMap()[c] || '';
  return t(c, en);
}

/**
 * 权限名称 / 效果说明的显示名。
 * @param {string} perm 权限 id
 * @param {object} meta PERMISSION_LABELS 中的条目
 * @param {'name'|'effect'} key
 * @return {string}
 */
function permissionText(perm, meta, key) {
  const zh = String((meta && meta[key]) || '');
  const fromPerm = PERMISSION_EN[perm] ? PERMISSION_EN[perm][key] : '';
  const en = (meta && meta[`${key}En`]) || fromPerm || '';
  return t(zh, en);
}

/**
 * 卡片状态标签（含「可更新到 vX」「已安装 vX」这类带版本号的字符串）。
 * @param {string} label
 * @return {string}
 */
function localizedStateLabel(label) {
  const text = String(label || '');
  const fixed = stateLabelEnMap()[text];
  if (fixed) return t(text, fixed);
  let m = /^可更新到 v(.+)$/.exec(text);
  if (m) return t(text, `Update to v${m[1]}`);
  m = /^已安装 v(.+)$/.exec(text);
  if (m) return t(text, `Installed v${m[1]}`);
  return text;
}

/**
 * 市场卡片主按钮文案（由 catalog.actionLabel() 产出）。
 * @param {string} label
 * @return {string}
 */
function localizedActionLabel(label) {
  const text = String(label || '');
  const fixed = actionLabelEnMap()[text];
  if (fixed) return t(text, fixed);
  const m = /^更新到 v(.+)$/.exec(text);
  if (m) return t(text, `Update to v${m[1]}`);
  return text;
}

/** 供 plugin-manager.js 复用，避免同一套「原文 → 英文」映射在两处漂移。 */
export { localizedField, localizedStateLabel, localizedActionLabel, categoryLabel, permissionText };

/**
 * 创建一个带 `data-dialog` 标识的自管弹窗。
 * @param {string} name data-dialog 值
 * @param {string} title 标题
 * @param {string} bodyHtml 内容
 * @param {string} [width] CSS 宽度
 * @return {{el: HTMLElement, root: HTMLElement, close: () => void}}
 */
function makeDialog(name, title, bodyHtml, width = '480px') {
  if (currentDialog) currentDialog.close();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qp-plugin-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal qp-dialog qp-plugin-dialog';
  modal.style.width = width;
  modal.setAttribute('data-dialog', name);
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', title);
  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__title">${escapeHtml(title)}</span>` +
    `<button class="qp-plugin__close" data-role="close" aria-label="${t('关闭', 'Close')}">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-plugin__body">${bodyHtml}</div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (currentDialog && currentDialog.root === backdrop) currentDialog = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="close"]')) close();
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  currentDialog = { root: backdrop, close };
  return { el: modal, root: backdrop, close };
}

/* ============================================================ 5.4 插件市场 */

/**
 * 市场区 HTML（插件管理器对话框 `data-pm-market` 容器的内容）。
 * @param {object} app
 * @param {{items: Array<object>, warning: string}} catalog
 * @param {{query: string, category: string, sort: string}} filters
 * @return {string}
 */
export function marketHtml(app, catalog, filters) {
  const q = String(filters.query || '');
  const items = searchCatalog(catalog.items, filters);
  const installed = pluginState.allState();
  const installedCount = Object.keys(installed).length;
  const cards = items.map((p) => {
    const st = cardState(p, installed[p.id] || null);
    const allowed = isAllowedLicense(p.license);
    const perms = Array.isArray(p.permissions) ? p.permissions : [];
    const permHtml = perms.slice(0, 3).map((perm) => {
      const meta = PERMISSION_LABELS[perm];
      const first = meta ? permissionText(perm, meta, 'name').slice(0, 1) : '·';
      return `<span class="qp-market__perm" title="${escapeHtml(perm)}">` +
        `${escapeHtml(first)}</span>`;
    }).join('') + (perms.length > 3 ? `<span class="qp-market__perm">+${perms.length - 3}</span>` : '');
    // 市场里只放「点下去真能装上」的条目：装不上的包不该出现在 catalog 里
    // （scripts/plugin-pack-check.mjs 会拦住），所以这里不再有「未上架」灰卡片分支。
    const action = st.state === 'not-installed' ? 'install'
      : st.state === 'updatable' ? 'update'
        : st.state === 'disabled' ? 'enable' : 'disable';
    const label = localizedActionLabel(actionLabel(st, p));
    // 阻止态的按钮要置灰。core 目前返回中文 label；若日后数据层直接给英文，
    // 中英两种前缀都认，避免漏置灰。
    const blocked = st.state === 'disabled' &&
      (st.label.startsWith(t('已阻止')) || /^Blocked/i.test(st.label));
    const disabled = st.state === 'installed' || blocked;
    return (
      `<div class="qp-market__card" data-plugin-row data-plugin-id="${escapeHtml(p.id)}" ` +
      `data-plugin-state="${escapeHtml(st.state)}">` +
      `<span class="qp-market__badge ${allowed ? '' : 'is-danger'}" data-license-badge>` +
      `${escapeHtml(p.license || 'UNLICENSED')}</span>` +
      `<div class="qp-market__name">${escapeHtml(pickLocalized(p, 'name') || pickLocalized(p, 'title') || p.id)}</div>` +
      `<div class="qp-market__meta">${escapeHtml(p.id)} · v${escapeHtml(p.version || '')}` +
      `${p.official ? ` · ${t('官方', 'Official')}` : ''}</div>` +
      `<div class="qp-market__desc">${escapeHtml(pickLocalized(p, 'description'))}</div>` +
      `<div class="qp-market__foot"><span class="qp-market__perms">${permHtml}</span>` +
      `<button class="btn ${action === 'install' ? 'is-primary' : 'is-ghost'}" ` +
      `data-plugin-action="${action}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></div>` +
      `<div class="qp-market__state">${escapeHtml(localizedStateLabel(st.label))}</div>` +
      `</div>`
    );
  }).join('');

  return (
    `<div class="qp-market" data-side-panel="plugins">` +
    `<div class="qp-market__notice" data-role="boundary">${noticeHtml(escapeHtml)}</div>` +
    // catalog.warning 由 core/plugins/catalog.js 在产出时已用 t() 本地化
    (catalog.warning
      ? `<div class="qp-market__warning" data-role="catalog-warning">${escapeHtml(catalog.warning)}</div>`
      : '') +
    `<div class="qp-market__tools">` +
    `<input class="qp-market__search" type="search" data-market-search ` +
    `placeholder="${t('搜索插件…', 'Search plugins…')}" value="${escapeHtml(q)}" aria-label="${t('搜索插件', 'Search Plugins')}" />` +
    `<select class="qp-market__select" data-market-category aria-label="${t('分类', 'Category')}">` +
    categoriesOf(catalog.items).map((c) => `<option value="${escapeHtml(c)}"${c === filters.category ? ' selected' : ''}>${escapeHtml(categoryLabel(c, catalog.items))}</option>`).join('') +
    `</select>` +
    `<select class="qp-market__select" data-market-sort aria-label="${t('排序', 'Sort')}">` +
    SORTS.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === filters.sort ? ' selected' : ''}>${escapeHtml(t(s.label, s.labelEn || SORT_EN[s.id] || ''))}</option>`).join('') +
    `</select>` +
    `<button class="btn is-ghost" data-market-url title="${t('从 URL 安装 zip', 'Install a zip from a URL')}">＋ ${t('从 URL 安装', 'Install from URL')}</button>` +
    `</div>` +
    `<div class="qp-market__list" data-role="plugin-list">` +
    (cards || `<div class="qp-market__empty" data-market-empty="true">${t('没有找到匹配的插件', 'No matching plugins found')}<br/>` +
      `<span>${t('试试「＋ 从 URL 安装」，或换个关键词', 'Try "＋ Install from URL", or use a different keyword')}</span></div>`) +
    `</div>` +
    `<div class="qp-market__status" data-market-count>${t(
      `共 ${items.length} 个插件 · ${items.length} 个可安装 · ${installedCount} 个已安装`,
      `${items.length} plugins · ${items.length} installable · ${installedCount} installed`,
    )}</div>` +
    `<div class="qp-market__npp"><button class="btn is-ghost" data-npp-open>${t('从 Notepad++ 导入', 'Import from Notepad++')}</button></div>` +
    `</div>`
  );
}

/**
 * 绑定市场区事件（事件委托，挂在容器上，内容重绘后依然有效）。
 * @param {object} app
 * @param {HTMLElement} body 市场区容器（如插件管理器里的 [data-pm-market]）
 */
export function bindMarket(app, body) {
  if (body.dataset.qpMarketBound === 'true') return;
  body.dataset.qpMarketBound = 'true';

  const rerender = async () => {
    const catalog = await loadCatalog();
    const search = body.querySelector('[data-market-search]');
    const cat = body.querySelector('[data-market-category]');
    const sort = body.querySelector('[data-market-sort]');
    const focus = document.activeElement === search;
    body.innerHTML = marketHtml(app, catalog, {
      query: search ? search.value : '',
      category: cat ? cat.value : ALL_CATEGORY,
      sort: sort ? sort.value : 'recommended',
    });
    // 事件委托挂在容器上，内容重绘后无需重绑（重绑会导致监听器翻倍）
    if (focus) body.querySelector('[data-market-search]')?.focus();
  };

  body.addEventListener('input', (e) => {
    if (e.target.matches('[data-market-search]')) void rerender();
  });
  body.addEventListener('change', (e) => {
    if (e.target.matches('[data-market-category], [data-market-sort]')) void rerender();
  });
  body.addEventListener('click', async (e) => {
    // 不要用 `t` 命名事件目标：会遮蔽 i18n 的 t()，toast 文案一调用就抛
    // `t is not a function`，被 async 监听器吞掉（见 plugin-manager.js 同款注释）。
    const target = e.target;
    if (target.closest('[data-market-url]')) { openInstallFromUrl(app); return; }
    if (target.closest('[data-npp-open]')) { await openNppImport(app); return; }
    const btn = target.closest('[data-plugin-action]');
    if (!btn) return;
    const row = btn.closest('[data-plugin-row]');
    if (!row) return;
    const id = row.dataset.pluginId;
    const action = btn.dataset.pluginAction;
    const catalog = await loadCatalog();
    const plugin = catalog.items.find((p) => p.id === id);
    if (!plugin) return;
    if (action === 'install' || action === 'update') {
      if (!isAllowedLicense(plugin.license)) {
        toast(t(`「${plugin.name}」的 ${plugin.license} 不在许可白名单，已拒绝安装`,
          `The ${plugin.license} license of "${plugin.name}" is not on the allowlist; installation was rejected`), 'error', 3600);
        return;
      }
      openPermConfirm(app, plugin, action);
      return;
    } else if (action === 'disable') {
      const res = await host.disable(app, id);
      toast(res && res.ok === false
        ? t(`禁用失败：${res.error || res.code}`, `Could not disable: ${res.error || res.code}`)
        : t(`已禁用「${plugin.name}」`, `Disabled "${plugin.name}"`), res && res.ok === false ? 'error' : 'info');
    } else if (action === 'enable') {
      const res = await host.enable(app, id);
      toast(res && res.ok === false
        ? t(`启用失败：${res.error || res.code}`, `Could not enable: ${res.error || res.code}`)
        : t(`已启用「${plugin.name}」`, `Enabled "${plugin.name}"`), res && res.ok === false ? 'error' : 'info');
    }
    app.emitPluginsChanged();
    await rerender();
  });
}

/**
 * 执行安装（官方内置包 / catalog 提供的 zip）。
 * @param {object} app
 * @param {object} plugin
 * @param {string} [action] 'install' | 'update'
 * @return {Promise<void>}
 */
async function doInstall(app, plugin, action = 'install') {
  const isOfficial = !!plugin.official || String(plugin.id).startsWith('quillpad.');
  const isUpdate = action === 'update';
  const res = isOfficial
    ? await host.installBuiltin(app, plugin.id, { update: isUpdate })
    : await host.installFromZip(app, {
      url: plugin.download,
      id: plugin.id,
      update: isUpdate,
      force: isUpdate,
      expectedSha256: plugin.sha256 || '',
    });
  if (res && res.ok === false) {
    toast(t(`安装失败：${res.error || res.code || '未知错误'}`,
      `Installation failed: ${res.error || res.code || 'Unknown error'}`), 'error', 4200);
  } else {
    toast(t(`已安装「${plugin.name}」`, `Installed "${plugin.name}"`), 'success', 2600);
  }
  app.emitPluginsChanged();
}

/* ======================================================= 5.5 权限确认弹窗 */

/**
 * 打开权限确认弹窗（G5-15 能力边界声明也在末页可检索）。
 * @param {object} app
 * @param {object} plugin
 * @param {string} action 'install' | 'update'
 */
export function openPermConfirm(app, plugin, action = 'install') {
  const allowed = isAllowedLicense(plugin.license);
  const perms = Array.isArray(plugin.permissions) ? plugin.permissions : [];
  const high = hasHighRisk(perms);
  const permRows = perms.map((p) => {
    const meta = PERMISSION_LABELS[p] || {
      name: p,
      effect: t('插件将获得该能力', 'The plugin will be granted this capability'),
    };
    const risky = ['network', 'files:write'].includes(p);
    const name = permissionText(p, meta, 'name');
    const effect = permissionText(p, meta, 'effect');
    return (
      `<div class="qp-perm__row" data-perm="${escapeHtml(p)}"${risky ? ' data-perm-risk="high"' : ''}>` +
      `<span class="qp-perm__icon">${escapeHtml(name.slice(0, 1))}</span>` +
      `<span class="qp-perm__name">${escapeHtml(name)}</span>` +
      `<span class="qp-perm__desc">${escapeHtml(effect)}</span>` +
      `</div>`
    );
  }).join('');
  const riskHtml = high
    ? `<div class="qp-perm__risk" data-perm-risk="high">` +
      (perms.includes('network') ? `<p>${t('该插件可访问网络，可能把文件内容发送到外部服务器。', 'This plugin can access the network and may send file contents to external servers.')}</p>` : '') +
      (perms.includes('files:write') ? `<p>${t('该插件可覆盖磁盘上的文件。', 'This plugin can overwrite files on disk.')}</p>` : '') +
      `<label class="qp-perm__ack"><input type="checkbox" data-risk-ack /> ` +
      `${t('我已了解该插件的网络与写盘能力', 'I understand this plugin’s network and disk-write capabilities')}</label></div>`
    : '';
  const body =
    `<div class="qp-perm__meta">${t(`安装「${escapeHtml(plugin.name)}」· v${escapeHtml(plugin.version || '')}？`, `Install "${escapeHtml(plugin.name)}" · v${escapeHtml(plugin.version || '')}?`)}</div>` +
    `<div class="qp-perm__sub ${allowed ? '' : 'is-danger'}">${t('作者', 'Author')} ${escapeHtml(localizedField(plugin, 'author', authorEnMap()[plugin.author] || '') || t('未知', 'Unknown'))} · ` +
    `${escapeHtml(plugin.license || 'UNLICENSED')} ${t('许可', 'license')}${allowed ? '' : t('（不在白名单，禁止安装）', ' (not on the allowlist — installation blocked)')}</div>` +
    riskHtml + `<div class="qp-perm__list">${permRows}</div>` +
    `<div class="qp-perm__boundary">${noticeHtml(escapeHtml)}</div>` +
    `<div class="qp-plugin__foot">` +
    `<button class="btn is-ghost" data-role="close">${t('取消', 'Cancel')}</button>` +
    (allowed ? `<button class="btn is-primary" data-btn="install"${high ? ' disabled' : ''}>` +
      `${action === 'update' ? t('更新', 'Update') : t('安装', 'Install')}</button>` : '') +
    `</div>`;
  const dlg = makeDialog('perm-confirm', t('权限确认', 'Permission Confirmation'), body, '480px');
  const ack = dlg.el.querySelector('[data-risk-ack]');
  const installBtn = dlg.el.querySelector('[data-btn="install"]');
  if (ack && installBtn) {
    ack.addEventListener('change', () => { installBtn.disabled = !ack.checked; });
  }
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      await doInstall(app, plugin, action);
      dlg.close();
    });
  }
}

/* ====================================================== 5.6 .dll 拒绝弹窗 */

/**
 * 打开 `.dll` 拒绝弹窗（G5-9 必须含 Scintilla / NPPM_ / GPL）。
 * @param {object} app
 * @param {string} dllName
 */
export function openDllReject(app, dllName = 'NppExec.dll') {
  const body =
    `<p class="qp-dll__fact" data-dll-name>${t(
      `「${escapeHtml(dllName)}」是 Notepad++ 专用的原生 DLL，不能直接在 QuillPad 中运行。`,
      `"${escapeHtml(dllName)}" is a native DLL designed for Notepad++ and cannot run directly in QuillPad.`,
    )}</p>` +
    `<p class="qp-dll__reason" data-reject-reason>${escapeHtml(t(DLL_REJECT_REASON, DLL_REJECT_REASON_EN))}</p>` +
    `<p class="qp-dll__lead">${t('你可以改用等价的官方插件或内置功能：', 'You can use an equivalent official plugin or built-in feature instead:')}</p>` +
    `<div class="qp-dll__actions">` +
    `<button class="btn is-ghost" data-action="show-equivalent">${t('查看等价功能', 'View Equivalent Features')}</button>` +
    `<button class="btn is-ghost" data-action="search-market">${t('在市场搜索替代方案', 'Search Marketplace for Alternatives')}</button>` +
    `<button class="btn is-primary" data-action="request-port">${t('提交移植需求', 'Request a Port')}</button>` +
    `</div>`;
  const dlg = makeDialog('dll-reject', t('无法安装 Notepad++ 原生插件', 'Cannot Install Notepad++ Native Plugin'), body, '460px');
  dlg.el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const base = String(dllName).replace(/\.dll$/i, '');
    const act = btn.dataset.action;
    if (act === 'search-market') {
      dlg.close();
      const mod = await import('./plugin-manager.js');
      mod.openPluginManager(app, { view: 'market', query: base });
    } else if (act === 'show-equivalent') {
      await openNppImport(app, { preselect: base });
      dlg.close();
    } else {
      const text = t(
        `插件移植需求：${base}\n来源：Notepad++ 原生 DLL ${dllName}\n期望：提供等价的 QuillPad 官方插件（MIT）`,
        `Plugin port request: ${base}\nSource: Notepad++ native DLL ${dllName}\n` +
          `Request: provide an equivalent official QuillPad plugin (MIT)`,
      );
      try {
        await navigator.clipboard.writeText(text);
        toast(t('反馈内容已复制', 'Feedback copied to clipboard'), 'success', 2600);
      } catch {
        toast(t('网络不可用，无法打开反馈页面', 'Network unavailable; the feedback page could not be opened'), 'info', 2600);
      }
      dlg.close();
    }
  });
}

/* ==================================================== 5.7 Npp 导入向导 */

/**
 * 打开 Npp 导入向导（3 步；G5-7 空态 / G5-8 报告文本）。
 * @param {object} app
 * @param {{preselect?: string}} [opts]
 */
export async function openNppImport(app, opts = {}) {
  const compat = await loadCompat();
  const dlg = makeDialog('npp-import', t('从 Notepad++ 导入', 'Import from Notepad++'), stepHtml(1, ''), '560px');
  let scan = null;
  try {
    scan = await desktop.nppScan();
  } catch {
    scan = { ok: true, paths: [], dirs: [], count: 0 };
  }
  const dirs = scan && Array.isArray(scan.dirs) ? scan.dirs : [];
  const mapped = mapScanned(dirs, compat);
  const summary = summarizeNpp(dirs, compat);
  // summary.text 由 core/plugins/npp-report.js 在产出时已用 t() 本地化，
  // 这里直接沿用（G5-8 的 data-npp-count 断言与核心口径同源）。
  const countText = summary.text;

  /** @param {number} step @param {string} content */
  const setStep = (step, content) => {
    dlg.el.querySelector('.qp-plugin__body').innerHTML = stepHtml(step, content);
  };

  if (!mapped.length) {
    setStep(1,
      `<div class="qp-npp__empty" data-empty-state="no-npp">${t('未检测到本机 Notepad++ 安装。', 'No local Notepad++ installation was detected.')}` +
      `<span>${t('你仍可从插件市场安装官方兼容包。', 'You can still install official compatibility packs from the Plugin Marketplace.')}</span></div>` +
      `<div class="qp-plugin__foot">` +
      `<button class="btn is-primary" data-npp-goto-market>${t('打开插件市场', 'Open Plugin Marketplace')}</button>` +
      `<button class="btn is-ghost" data-npp-rescan>${t('重新扫描', 'Rescan')}</button></div>`);
  } else {
    setStep(2,
      `<div class="qp-npp__count" data-npp-count>${escapeHtml(countText)}</div>` +
      groupHtml((n) => t(`已内置（${n}）`, `Built-in (${n})`), 'builtin', mapped) +
      groupHtml((n) => t(`可一键安装（${n}）`, `One-Click Installable (${n})`), 'port', mapped) +
      groupHtml((n) => t(`不支持（${n}）`, `Unsupported (${n})`), 'unsupported', mapped) +
      `<div class="qp-npp__boundary">${noticeHtml(escapeHtml)}</div>` +
      `<div class="qp-plugin__foot"><button class="btn is-primary" data-npp-install>${t('安装可移植项', 'Install Portable Items')}</button>` +
      `<button class="btn is-ghost" data-npp-rescan>${t('重新扫描', 'Rescan')}</button></div>`);
  }

  dlg.el.addEventListener('click', async (e) => {
    // 同上：`t` 留给 i18n，事件目标用 target。
    const target = e.target;
    if (target.closest('[data-npp-goto-market]')) {
      dlg.close();
      const mod = await import('./plugin-manager.js');
      mod.openPluginManager(app, { view: 'market' });
      return;
    }
    if (target.closest('[data-npp-rescan]')) { dlg.close(); await openNppImport(app, opts); return; }
    if (target.closest('[data-npp-install]')) {
      const targets = mapped.filter((x) => x.status === 'port' && x.entry && x.entry.installable);
      let done = 0;
      const failures = [];
      setStep(3, `<div class="qp-npp__progress">${t(`正在安装 0/${targets.length}…`, `Installing 0/${targets.length}…`)}</div>` +
        `<div class="qp-npp__bar"><span style="width:4%"></span></div>`);
      for (const target of targets) {
        const entry = target.entry;
        try {
          const cat = await loadCatalog();
          const plugin = cat.items.find((p) => p.id === entry.quillpadEquivalent) ||
            { id: entry.quillpadEquivalent, name: target.name, official: true, license: 'MIT', version: '1.0.0', permissions: [] };
          const res = await host.installBuiltin(app, plugin.id);
          if (res && res.ok === false) failures.push(`${target.name}：${res.code || res.error}`);
          else done += 1;
        } catch (err) {
          failures.push(`${target.name}：${String(err && err.message || err)}`);
        }
        const stage = dlg.el.querySelector('.qp-npp__progress');
        const bar = dlg.el.querySelector('.qp-npp__bar span');
        if (stage) stage.textContent = t(`正在安装 ${done}/${targets.length}…`, `Installing ${done}/${targets.length}…`);
        if (bar) bar.style.width = `${Math.max(4, Math.round((done / Math.max(1, targets.length)) * 100))}%`;
      }
      setStep(3,
        `<div class="qp-npp__done">${t(`已安装 ${done} 个，跳过 ${failures.length} 个`, `Installed ${done}, skipped ${failures.length}`)}</div>` +
        (failures.length ? `<ul class="qp-npp__fails">${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '') +
        `<div class="qp-npp__boundary">${noticeHtml(escapeHtml)}</div>` +
        `<div class="qp-plugin__foot"><button class="btn is-primary" data-role="close">${t('完成', 'Done')}</button></div>`);
      app.emitPluginsChanged();
    }
  });
}

/**
 * 向导步骤骨架。
 * @param {number} step
 * @param {string} content
 * @return {string}
 */
function stepHtml(step, content) {
  const labels = [
    t('① 扫描', '① Scan'),
    t('② 报告', '② Report'),
    t('③ 安装', '③ Install'),
  ];
  return `<div class="qp-npp__stepper">` +
    labels.map((l, i) => `<span class="qp-npp__step${i + 1 === step ? ' is-active' : ''}"` +
      `${i + 1 === step ? ' aria-current="step"' : ''}>${l}</span>`).join('') +
    `</div>` + (content || `<div class="qp-npp__loading">${t('正在扫描本机 Notepad++ 插件…', 'Scanning local Notepad++ plugins…')}</div>`);
}

/**
 * 分组 HTML。
 * @param {(count: number) => string} summary 已按当前语言算好的「分组名（条数）」
 * @param {string} status
 * @param {Array<object>} mapped
 * @return {string}
 */
function groupHtml(summary, status, mapped) {
  const rows = mapped.filter((x) => status === 'unsupported'
    ? x.status !== 'builtin' && x.status !== 'port'
    : x.status === status);
  return `<details class="qp-npp__group" data-npp-group="${escapeHtml(status)}" open>` +
    `<summary>${escapeHtml(summary(rows.length))}</summary>` +
    (rows.map((x) => {
      const e = x.entry || {};
      const reasonText = e.reason
        ? t(String(e.reason), String(e.reasonEn || ''))
        : t('暂无兼容实现', 'No compatible implementation');
      return `<div class="qp-npp__row" data-npp-row data-npp-plugin="${escapeHtml(x.name)}" ` +
        `data-npp-status="${escapeHtml(status)}">` +
        `<span class="qp-npp__check" data-npp-check>${status === 'unsupported' ? '✕' : '✓'}</span>` +
        `<span class="qp-npp__name">${escapeHtml(x.name)}</span>` +
        `<span class="qp-npp__license">${escapeHtml(e.nppLicense || 'GPL')}</span>` +
        `<span class="qp-npp__equiv">${t('等价项：', 'Equivalent: ')}${escapeHtml(e.quillpadEquivalent || '—')}</span>` +
        (status === 'port' && e.installable ? `<button class="btn is-ghost" data-npp-install-one>${t('安装', 'Install')}</button>` : '') +
        (status === 'unsupported' ? `<span class="qp-npp__reason" title="${escapeHtml(reasonText)}">` +
          `${escapeHtml(String(reasonText).slice(0, 18))}…</span>` : '') +
        `</div>`;
    }).join('') || `<div class="qp-npp__none">${t('无', 'None')}</div>`) +
    `</details>`;
}

/* ================================================== 从 URL / 本地 zip 安装 */

/**
 * 「＋ 从 URL 安装」：本地 zip 走 FileReader，URL 走 fetch，再交给主进程。
 * @param {object} app
 */
export function openInstallFromUrl(app) {
  const body =
    `<p class="qp-install__lead">${t('安装第三方插件前，请确认其许可证在白名单内（MIT / Apache-2.0 / BSD / ISC / 0BSD）。GPL / AGPL / SSPL 一律拒绝。',
      'Before installing a third-party plugin, make sure its license is on the allowlist (MIT / Apache-2.0 / BSD / ISC / 0BSD). GPL / AGPL / SSPL are always rejected.')}</p>` +
    // 原生 <input type="file"> 的「选择文件 / 未选择任何文件」是 Chromium 原生 UI，
    // 跟随系统 locale 而非页面语言。这里隐藏原生 input（JS 仍读 input.files），
    // 用自绘按钮 + 状态文本覆盖，文案随界面语言走。
    `<div class="qp-install__row"><span>${t('本地 zip', 'Local zip')}</span>` +
    `<input type="file" accept=".zip" data-install-file hidden />` +
    `<button type="button" class="btn is-ghost qp-install__file-btn" data-install-file-btn>` +
    `${t('选择文件', 'Choose File')}</button>` +
    `<span class="qp-install__file-name" data-install-file-name>` +
    `${t('未选择任何文件', 'No file chosen')}</span></div>` +
    `<label class="qp-install__row"><span>${t('或 URL', 'or URL')}</span>` +
    `<input type="text" data-install-url placeholder="https://…/plugin.zip" /></label>` +
    `<div class="qp-plugin__foot"><button class="btn is-ghost" data-role="close">${t('取消', 'Cancel')}</button>` +
    `<button class="btn is-primary" data-install-go>${t('安装', 'Install')}</button></div>`;
  const dlg = makeDialog('plugin-install', t('从 URL / 本地安装插件', 'Install Plugin from URL / Local File'), body, '480px');
  // 自绘文件控件：点按钮触发原生选择框；change 后把文件名写进状态文本。
  const fileInput = dlg.el.querySelector('[data-install-file]');
  const fileBtn = dlg.el.querySelector('[data-install-file-btn]');
  const fileName = dlg.el.querySelector('[data-install-file-name]');
  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
  }
  if (fileInput && fileName) {
    fileInput.addEventListener('change', () => {
      const picked = fileInput.files && fileInput.files[0];
      fileName.textContent = picked ? picked.name : t('未选择任何文件', 'No file chosen');
    });
  }
  dlg.el.querySelector('[data-install-go]').addEventListener('click', async () => {
    const fileEl = dlg.el.querySelector('[data-install-file]');
    const urlEl = dlg.el.querySelector('[data-install-url]');
    let payload = null;
    if (fileEl && fileEl.files && fileEl.files[0]) {
      const buf = await fileEl.files[0].arrayBuffer();
      payload = { bytes: new Uint8Array(buf) };
    } else if (urlEl && urlEl.value.trim()) {
      payload = { url: urlEl.value.trim() };
    } else {
      toast(t('请选择本地 zip 或填写 URL', 'Choose a local zip or enter a URL'), 'info', 2200);
      return;
    }
    const res = await host.installFromZip(app, payload);
    if (res && res.ok === false) toast(t(`安装失败：${res.error || res.code}`, `Installation failed: ${res.error || res.code}`), 'error', 4200);
    else toast(t('插件已安装', 'Plugin installed'), 'success', 2400);
    app.emitPluginsChanged();
    dlg.close();
  });
}

/* ==================================================== 插件贡献的侧栏视图 */

/**
 * 渲染插件声明式侧栏视图（PRD 事实校正 #14：Worker 无 DOM，只登记元数据）。
 * @param {object} app
 * @return {string}
 */
export function pluginViewsHtml(app) {
  const views = Array.isArray(app.pluginViews) ? app.pluginViews : [];
  if (!views.length) return '';
  return `<div class="qp-plugin-views">` + views.map((v) =>
    `<div class="qp-plugin-view" data-plugin-view="${escapeHtml(v.id)}">` +
    `<div class="qp-plugin-view__title">${escapeHtml(pickLocalized(v, 'title') || v.id)}</div>` +
    `<div class="qp-plugin-view__hint">${t(`由插件 ${escapeHtml(v.pluginId || '')} 提供`, `Provided by plugin ${escapeHtml(v.pluginId || '')}`)}</div></div>`,
  ).join('') + `</div>`;
}

/* ============================================================ 初始化入口 */

/**
 * 注册本文件负责的两条插件命令。
 *
 * 每次调用都重新用 `t()` 计算 title / category，因此界面语言切换后菜单与命令面板
 * 里的标题会立刻变成新语言。`run` 体里的 `await import()` 只是懒加载插件管理器，
 * 不影响注册动作的同步性。
 *
 * `defineCommand()` 遇到已存在的 id 会打印「被重复注册」告警，因此先查再注销：
 * 正常切语言时 applyLocale() 已 resetCommands() 删掉这两条，getCommand() 为空；
 * 若因其它路径重复派发 locale 事件，也不会产生告警。
 *
 * @param {object} app 应用实例，用于命令执行时打开对话框
 * @return {void}
 */
function registerPluginUiCommands(app) {
  const commands = [
    {
      id: 'plugins.manager',
      title: t('插件管理器…', 'Plugin Manager…'),
      category: t('插件', 'Plugins'),
      run: async () => {
        const mod = await import('./plugin-manager.js');
        mod.openPluginManager(app);
      },
    },
    {
      id: 'plugins.installUrl',
      title: t('从 URL / 本地安装…', 'Install from URL / Local File…'),
      category: t('插件', 'Plugins'),
      run: () => openInstallFromUrl(app),
    },
  ];
  for (const cmd of commands) {
    if (getCommand(cmd.id)) unregisterCommand(cmd.id);
    defineCommand(cmd);
  }
}

/**
 * 安装插件 UI：注册命令入口、`.dll` 拖放拒绝、市场 / 弹窗入口。
 * @param {object} app
 * @return {void}
 */
export function initPluginUI(app) {
  app.openPluginMarket = function openPluginMarket() {
    // 市场 UI 已迁入插件管理器对话框（懒加载，避免与 plugin-manager.js 静态环）
    void import('./plugin-manager.js').then((mod) => {
      mod.openPluginManager(app, { view: 'market' });
    });
  };
  app.openPermConfirm = (p, a) => openPermConfirm(app, p, a);
  app.openDllReject = (name) => openDllReject(app, name);
  app.openNppImport = (o) => openNppImport(app, o);
  app.openInstallFromUrl = () => openInstallFromUrl(app);
  app.marketHtml = (catalog, filters) => marketHtml(app, catalog, filters);
  app.bindMarket = (body) => bindMarket(app, body);
  app.pluginViewsHtml = () => pluginViewsHtml(app);

  // 插件菜单化：注册「插件」顶级菜单所需的命令入口。
  // 标题必须按当前语言求值，因此注册动作抽成函数，启动时与每次切语言时各跑一次。
  registerPluginUiCommands(app);
  // app.applyLocale() 的顺序是 resetCommands() → registerCommands() → bus.emit('locale')，
  // 前两步会删掉本文件注册的两条命令；这里同步重新注册（注册动作不能放进 await 之后，
  // 否则 E1 的「命令兜底」先放回旧语言对象，随后又被覆盖并触发重复注册告警）。
  bus.on('locale', () => registerPluginUiCommands(app));
  // plugins.importNpp / plugins.market 的注册在 core/actions.js（唯一注册点），
  // 这里不再重复 defineCommand，避免「被重复注册」告警与双实例。

  // G5-9：把 .dll 拖进应用一律拒绝，不写任何文件
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    const items = [...(e.dataTransfer.items || [])];
    if (items.some((it) => it.kind === 'file')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const dll = files.find((f) => /\.dll$/i.test(f.name));
    if (!dll) return;
    e.preventDefault();
    e.stopPropagation();
    openDllReject(app, dll.name);
  }, true);
}

/** 供 QA 直接读取的能力边界原文（G5-15）。 */
export { EXPECTED_NOTICE };
