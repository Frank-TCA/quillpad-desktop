/**
 * QuillPad · 独立插件管理器（弹窗形态）
 *
 * 不依赖 sidebar 状态，可在任意时刻通过「插件 → 插件管理器…」或菜单栏
 * 右键菜单打开。对话框自上而下三段：
 *   1. 已安装插件列表（启用 / 禁用 / 卸载）
 *   2. 插件市场（从侧栏迁入，含搜索 / 分类 / 安装；事件委托在 marketHtml 容器上）
 *   3. 插件贡献的侧栏视图（pluginViewsHtml，对话框底部）
 *
 * DOM 契约（QA 断言用）：
 *   [data-dialog="plugin-manager"]          弹窗根
 *   [data-pm-row][data-plugin-id]           每个已安装插件一行
 *   [data-pm-action="enable|disable|uninstall"]  操作按钮
 *   [data-pm-open-url] / [data-pm-open-npp]  入口按钮（URL 安装 / Npp 导入）
 *   [data-pm-market]                        市场区容器（内含 marketHtml 的全部契约）
 *   [data-pm-views]                         插件视图区容器
 */

import { escapeHtml } from '../core/utils.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import * as host from '../core/plugins/host.js';
import * as pluginState from '../core/plugins/state.js';
import { loadCatalog } from '../core/plugins/catalog.js';
import { EXPECTED_NOTICE, noticeHtml } from '../core/plugins/notice.js';
// 市场区复用 plugins.js 的实现。反向依赖由 plugins.js 对本模块的「动态 import」
// 解开（见 initPluginUI / app.openPluginMarket），两者之间不存在启动期静态环。
import { marketHtml, bindMarket, pluginViewsHtml } from './plugins.js';

/** 当前打开的管理器弹窗（同时只允许一个）。 */
let currentManager = null;

/**
 * 渲染已安装插件列表 HTML。
 * @param {object} app
 * @param {Array<object>} catalogItems
 * @return {string}
 */
function installedRowsHtml(app, catalogItems) {
  const all = pluginState.allState();
  const ids = Object.keys(all);
  if (!ids.length) {
    return `<div class="qp-pm__empty" data-pm-empty="true">暂无已安装插件<br/>` +
      `<span>从下方插件市场安装，或从 URL / Notepad++ 导入。</span></div>`;
  }
  return ids.map((id) => {
    const entry = all[id] || {};
    const meta = catalogItems.find((p) => p.id === id) || {};
    const name = meta.name || id;
    const version = entry.version || meta.version || '';
    const disabled = entry.enabled === false;
    const blocked = !!entry.blocked;
    const crashed = entry.disabledReason === 'crashed';
    const stateLabel = blocked ? '已阻止（License 不合规）'
      : crashed ? '已停用（无响应）'
        : disabled ? '已禁用' : '已启用';
    const stateClass = blocked ? 'is-danger' : crashed ? 'is-danger' : disabled ? 'is-warn' : 'is-ok';
    return (
      `<div class="qp-pm__row" data-pm-row data-plugin-id="${escapeHtml(id)}" ` +
      `data-plugin-state="${escapeHtml(blocked ? 'blocked' : crashed ? 'crashed' : disabled ? 'disabled' : 'enabled')}">` +
      `<div class="qp-pm__info">` +
      `<div class="qp-pm__name">${escapeHtml(name)}</div>` +
      `<div class="qp-pm__meta">${escapeHtml(id)}${version ? ` · v${escapeHtml(version)}` : ''}` +
      `${meta.official ? ' · 官方' : ''}</div>` +
      `</div>` +
      `<div class="qp-pm__state ${stateClass}">${escapeHtml(stateLabel)}</div>` +
      `<div class="qp-pm__ops">` +
      (blocked ? '' :
        (disabled
          ? `<button class="btn is-ghost" data-pm-action="enable">启用</button>`
          : `<button class="btn is-ghost" data-pm-action="disable">禁用</button>`)) +
      // 与市场「安装」按钮同一套实心样式（同等高度、圆角、600 字重），
      // 只把强调色换成 danger 以标明破坏性操作。
      // 不要写成 is-ghost + is-danger：.btn.is-ghost 在样式表中排在 .btn.is-danger 之后，
      // 权重相同（都是 0,2,0）时背景被覆盖成透明，而 color:#fff 仍生效，
      // 结果就是「白字 + 透明底」，在浅色主题下等于看不见。
      `<button class="btn is-danger" data-pm-action="uninstall">卸载</button>` +
      `</div></div>`
    );
  }).join('');
}

/**
 * 「已安装」段 HTML（列表 + 快捷入口 + 能力边界声明）。
 * @param {object} app
 * @param {Array<object>} catalogItems
 * @return {string}
 */
function managerHtml(app, catalogItems) {
  return (
    `<div class="qp-pm">` +
    `<div class="qp-pm__list" data-role="pm-list">${installedRowsHtml(app, catalogItems)}</div>` +
    `<div class="qp-pm__entries">` +
    `<button class="btn is-ghost" data-pm-open-url>从 URL / 本地安装</button>` +
    `<button class="btn is-ghost" data-pm-open-npp>从 Notepad++ 导入</button>` +
    `</div>` +
    `<div class="qp-pm__boundary" data-role="boundary">${noticeHtml(escapeHtml)}</div>` +
    `</div>`
  );
}

/**
 * 打开独立插件管理器。
 * @param {object} app
 * @param {{view?: 'installed'|'market', query?: string}} [opts]
 *   view='market' 或提供 query 时，打开后滚动到市场区并聚焦搜索框。
 * @return {{close: () => void}}
 */
export function openPluginManager(app, opts = {}) {
  if (currentManager) {
    currentManager.close();
    currentManager = null;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qp-plugin-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal qp-dialog qp-plugin-dialog';
  modal.style.width = '560px';
  modal.setAttribute('data-dialog', 'plugin-manager');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', '插件管理器');
  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__title">插件管理器</span>` +
    `<button class="qp-plugin__close" data-role="close" aria-label="关闭">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-plugin__body">` +
    `<div class="qp-pm__installed" data-pm-installed><div class="qp-pm__loading">正在加载…</div></div>` +
    `<div class="qp-pm__market-wrap" data-pm-market-wrap>` +
    `<div class="qp-pm__market-title">插件市场</div>` +
    `<div class="qp-pm__market" data-pm-market></div>` +
    `</div>` +
    `<div class="qp-pm__views" data-pm-views></div>` +
    `</div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (currentManager && currentManager.root === backdrop) currentManager = null;
    if (app._refreshPluginManager === rerender) delete app._refreshPluginManager;
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // 上层还有别的插件弹窗（权限确认 / Npp 向导等）时，交给最上层处理。
    const backdrops = document.querySelectorAll('.qp-plugin-backdrop');
    if (backdrops.length && backdrops[backdrops.length - 1] !== backdrop) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-role="close"]')) close();
  });
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  currentManager = { root: backdrop, close };

  /**
   * 渲染市场区（保留搜索 / 分类 / 状态，不整段重建时委托不重绑）。
   * @param {{items: Array<object>, warning: string}} catalog
   */
  const renderMarket = (catalog) => {
    const wrap = modal.querySelector('[data-pm-market]');
    if (!wrap) return;
    const prevSearch = wrap.querySelector('[data-market-search]');
    const prevCat = wrap.querySelector('[data-market-category]');
    const prevSort = wrap.querySelector('[data-market-sort]');
    const isFirst = !wrap.dataset.qpMarketReady;
    wrap.innerHTML = marketHtml(app, catalog, {
      query: isFirst ? String(opts.query || '') : (prevSearch ? prevSearch.value : ''),
      category: prevCat ? prevCat.value : '全部',
      sort: prevSort ? prevSort.value : 'recommended',
    });
    wrap.dataset.qpMarketReady = 'true';
    // 事件委托挂在容器上，重绘内容后无需重绑（bindMarket 自带幂等守卫）
    bindMarket(app, wrap);
    if (isFirst && (opts.view === 'market' || opts.query)) {
      wrap.scrollIntoView({ block: 'start' });
      const search = wrap.querySelector('[data-market-search]');
      if (search) search.focus();
    }
  };

  /** 重绘「已安装」段 + 市场区 + 视图区。 */
  const rerender = async () => {
    const catalog = await loadCatalog();
    const installedEl = modal.querySelector('[data-pm-installed]');
    if (installedEl) installedEl.innerHTML = managerHtml(app, catalog.items || []);
    renderMarket(catalog);
    const viewsEl = modal.querySelector('[data-pm-views]');
    if (viewsEl) viewsEl.innerHTML = pluginViewsHtml(app);
  };

  // 事件委托只绑定一次（覆盖已安装段的按钮；市场区事件由 bindMarket 自理）
  modal.querySelector('.qp-plugin__body').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-pm-open-url]')) {
      close();
      if (typeof app.openInstallFromUrl === 'function') app.openInstallFromUrl();
      return;
    }
    if (t.closest('[data-pm-open-npp]')) {
      close();
      if (typeof app.openNppImport === 'function') app.openNppImport();
      return;
    }
    const btn = t.closest('[data-pm-action]');
    if (!btn) return;
    const row = btn.closest('[data-pm-row]');
    if (!row) return;
    const id = row.dataset.pluginId;
    const action = btn.dataset.pmAction;
    if (action === 'disable') {
      const res = await host.disable(app, id);
      toast(res && res.ok === false ? `禁用失败：${res.error || res.code}` : '已禁用插件',
        res && res.ok === false ? 'error' : 'info');
    } else if (action === 'enable') {
      const res = await host.enable(app, id);
      toast(res && res.ok === false ? `启用失败：${res.error || res.code}` : '已启用插件',
        res && res.ok === false ? 'error' : 'info');
    } else if (action === 'uninstall') {
      const res = await host.uninstall(app, id);
      toast(res && res.ok === false ? `卸载失败：${res.error || res.code}` : '已卸载插件',
        res && res.ok === false ? 'error' : 'info');
    }
    if (typeof app.emitPluginsChanged === 'function') app.emitPluginsChanged();
    await rerender();
  });

  // 供 app.emitPluginsChanged 在插件状态变化时刷新（含市场卡片状态）
  app._refreshPluginManager = rerender;

  void rerender();
  return { root: backdrop, close };
}

/** 供 QA 直接读取的能力边界原文。 */
export { EXPECTED_NOTICE };
