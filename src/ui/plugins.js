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
import { defineCommand } from '../core/commands.js';
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
} from '../core/plugins/notice.js';
import { loadCompat, mapScanned, summarizeNpp } from '../core/npp-compat.js';

/** 当前打开的对话框（同时只允许一个）。 */
let currentDialog = null;

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
    `<button class="qp-plugin__close" data-role="close" aria-label="关闭">${icon('close', 14)}</button>` +
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
      return `<span class="qp-market__perm" title="${escapeHtml(perm)}">` +
        `${escapeHtml(meta ? meta.name.slice(0, 1) : '·')}</span>`;
    }).join('') + (perms.length > 3 ? `<span class="qp-market__perm">+${perms.length - 3}</span>` : '');
    // 市场里只放「点下去真能装上」的条目：装不上的包不该出现在 catalog 里
    // （scripts/plugin-pack-check.mjs 会拦住），所以这里不再有「未上架」灰卡片分支。
    const action = st.state === 'not-installed' ? 'install'
      : st.state === 'updatable' ? 'update'
        : st.state === 'disabled' ? 'enable' : 'disable';
    const label = actionLabel(st, p);
    const disabled = st.state === 'installed' || st.state === 'disabled' && st.label.startsWith('已阻止');
    return (
      `<div class="qp-market__card" data-plugin-row data-plugin-id="${escapeHtml(p.id)}" ` +
      `data-plugin-state="${escapeHtml(st.state)}">` +
      `<span class="qp-market__badge ${allowed ? '' : 'is-danger'}" data-license-badge>` +
      `${escapeHtml(p.license || 'UNLICENSED')}</span>` +
      `<div class="qp-market__name">${escapeHtml(p.name || p.id)}</div>` +
      `<div class="qp-market__meta">${escapeHtml(p.id)} · v${escapeHtml(p.version || '')}` +
      `${p.official ? ' · 官方' : ''}</div>` +
      `<div class="qp-market__desc">${escapeHtml(p.description || '')}</div>` +
      `<div class="qp-market__foot"><span class="qp-market__perms">${permHtml}</span>` +
      `<button class="btn ${action === 'install' ? 'is-primary' : 'is-ghost'}" ` +
      `data-plugin-action="${action}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></div>` +
      `<div class="qp-market__state">${escapeHtml(st.label)}</div>` +
      `</div>`
    );
  }).join('');

  return (
    `<div class="qp-market" data-side-panel="plugins">` +
    `<div class="qp-market__notice" data-role="boundary">${noticeHtml(escapeHtml)}</div>` +
    (catalog.warning
      ? `<div class="qp-market__warning" data-role="catalog-warning">${escapeHtml(catalog.warning)}</div>`
      : '') +
    `<div class="qp-market__tools">` +
    `<input class="qp-market__search" type="search" data-market-search ` +
    `placeholder="搜索插件…" value="${escapeHtml(q)}" aria-label="搜索插件" />` +
    `<select class="qp-market__select" data-market-category aria-label="分类">` +
    categoriesOf(catalog.items).map((c) => `<option value="${escapeHtml(c)}"${c === filters.category ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('') +
    `</select>` +
    `<select class="qp-market__select" data-market-sort aria-label="排序">` +
    SORTS.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === filters.sort ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('') +
    `</select>` +
    `<button class="btn is-ghost" data-market-url title="从 URL 安装 zip">＋ 从 URL 安装</button>` +
    `</div>` +
    `<div class="qp-market__list" data-role="plugin-list">` +
    (cards || `<div class="qp-market__empty" data-market-empty="true">没有找到匹配的插件<br/>` +
      `<span>试试「＋ 从 URL 安装」，或换个关键词</span></div>`) +
    `</div>` +
    `<div class="qp-market__status" data-market-count>共 ${items.length} 个插件 · ` +
    `${items.length} 个可安装 · ${installedCount} 个已安装</div>` +
    `<div class="qp-market__npp"><button class="btn is-ghost" data-npp-open>从 Notepad++ 导入</button></div>` +
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
      category: cat ? cat.value : '全部',
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
    const t = e.target;
    if (t.closest('[data-market-url]')) { openInstallFromUrl(app); return; }
    if (t.closest('[data-npp-open]')) { await openNppImport(app); return; }
    const btn = t.closest('[data-plugin-action]');
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
        toast(`「${plugin.name}」的 ${plugin.license} 不在许可白名单，已拒绝安装`, 'error', 3600);
        return;
      }
      openPermConfirm(app, plugin, action);
      return;
    } else if (action === 'disable') {
      const res = await host.disable(app, id);
      toast(res && res.ok === false ? `禁用失败：${res.error || res.code}` : `已禁用「${plugin.name}」`, res && res.ok === false ? 'error' : 'info');
    } else if (action === 'enable') {
      const res = await host.enable(app, id);
      toast(res && res.ok === false ? `启用失败：${res.error || res.code}` : `已启用「${plugin.name}」`, res && res.ok === false ? 'error' : 'info');
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
    toast(`安装失败：${res.error || res.code || '未知错误'}`, 'error', 4200);
  } else {
    toast(`已安装「${plugin.name}」`, 'success', 2600);
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
    const meta = PERMISSION_LABELS[p] || { name: p, effect: '插件将获得该能力' };
    const risky = ['network', 'files:write'].includes(p);
    return (
      `<div class="qp-perm__row" data-perm="${escapeHtml(p)}"${risky ? ' data-perm-risk="high"' : ''}>` +
      `<span class="qp-perm__icon">${escapeHtml(meta.name.slice(0, 1))}</span>` +
      `<span class="qp-perm__name">${escapeHtml(meta.name)}</span>` +
      `<span class="qp-perm__desc">${escapeHtml(meta.effect || '')}</span>` +
      `</div>`
    );
  }).join('');
  const riskHtml = high
    ? `<div class="qp-perm__risk" data-perm-risk="high">` +
      (perms.includes('network') ? `<p>该插件可访问网络，可能把文件内容发送到外部服务器。</p>` : '') +
      (perms.includes('files:write') ? `<p>该插件可覆盖磁盘上的文件。</p>` : '') +
      `<label class="qp-perm__ack"><input type="checkbox" data-risk-ack /> ` +
      `我已了解该插件的网络与写盘能力</label></div>`
    : '';
  const body =
    `<div class="qp-perm__meta">安装「${escapeHtml(plugin.name)}」· v${escapeHtml(plugin.version || '')}？</div>` +
    `<div class="qp-perm__sub ${allowed ? '' : 'is-danger'}">作者 ${escapeHtml(plugin.author || '未知')} · ` +
    `${escapeHtml(plugin.license || 'UNLICENSED')} 许可${allowed ? '' : '（不在白名单，禁止安装）'}</div>` +
    riskHtml + `<div class="qp-perm__list">${permRows}</div>` +
    `<div class="qp-perm__boundary">${noticeHtml(escapeHtml)}</div>` +
    `<div class="qp-plugin__foot">` +
    `<button class="btn is-ghost" data-role="close">取消</button>` +
    (allowed ? `<button class="btn is-primary" data-btn="install"${high ? ' disabled' : ''}>` +
      `${action === 'update' ? '更新' : '安装'}</button>` : '') +
    `</div>`;
  const dlg = makeDialog('perm-confirm', '权限确认', body, '480px');
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
    `<p class="qp-dll__fact" data-dll-name>「${escapeHtml(dllName)}」是 Notepad++ 专用的原生 DLL，` +
    `不能直接在 QuillPad 中运行。</p>` +
    `<p class="qp-dll__reason" data-reject-reason>${escapeHtml(DLL_REJECT_REASON)}</p>` +
    `<p class="qp-dll__lead">你可以改用等价的官方插件或内置功能：</p>` +
    `<div class="qp-dll__actions">` +
    `<button class="btn is-ghost" data-action="show-equivalent">查看等价功能</button>` +
    `<button class="btn is-ghost" data-action="search-market">在市场搜索替代方案</button>` +
    `<button class="btn is-primary" data-action="request-port">提交移植需求</button>` +
    `</div>`;
  const dlg = makeDialog('dll-reject', '无法安装 Notepad++ 原生插件', body, '460px');
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
      const text = `插件移植需求：${base}\n来源：Notepad++ 原生 DLL ${dllName}\n` +
        `期望：提供等价的 QuillPad 官方插件（MIT）`;
      try {
        await navigator.clipboard.writeText(text);
        toast('反馈内容已复制', 'success', 2600);
      } catch {
        toast('网络不可用，无法打开反馈页面', 'info', 2600);
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
  const dlg = makeDialog('npp-import', '从 Notepad++ 导入', stepHtml(1, ''), '560px');
  let scan = null;
  try {
    scan = await desktop.nppScan();
  } catch {
    scan = { ok: true, paths: [], dirs: [], count: 0 };
  }
  const dirs = scan && Array.isArray(scan.dirs) ? scan.dirs : [];
  const mapped = mapScanned(dirs, compat);
  const summary = summarizeNpp(dirs, compat);
  const countText = summary.text;

  /** @param {number} step @param {string} content */
  const setStep = (step, content) => {
    dlg.el.querySelector('.qp-plugin__body').innerHTML = stepHtml(step, content);
  };

  if (!mapped.length) {
    setStep(1,
      `<div class="qp-npp__empty" data-empty-state="no-npp">未检测到本机 Notepad++ 安装。` +
      `<span>你仍可从插件市场安装官方兼容包。</span></div>` +
      `<div class="qp-plugin__foot">` +
      `<button class="btn is-primary" data-npp-goto-market>打开插件市场</button>` +
      `<button class="btn is-ghost" data-npp-rescan>重新扫描</button></div>`);
  } else {
    setStep(2,
      `<div class="qp-npp__count" data-npp-count>${escapeHtml(countText)}</div>` +
      groupHtml('已内置', 'builtin', mapped) +
      groupHtml('可一键安装', 'port', mapped) +
      groupHtml('不支持', 'unsupported', mapped) +
      `<div class="qp-npp__boundary">${noticeHtml(escapeHtml)}</div>` +
      `<div class="qp-plugin__foot"><button class="btn is-primary" data-npp-install>安装可移植项</button>` +
      `<button class="btn is-ghost" data-npp-rescan>重新扫描</button></div>`);
  }

  dlg.el.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-npp-goto-market]')) {
      dlg.close();
      const mod = await import('./plugin-manager.js');
      mod.openPluginManager(app, { view: 'market' });
      return;
    }
    if (t.closest('[data-npp-rescan]')) { dlg.close(); await openNppImport(app, opts); return; }
    if (t.closest('[data-npp-install]')) {
      const targets = mapped.filter((x) => x.status === 'port' && x.entry && x.entry.installable);
      let done = 0;
      const failures = [];
      setStep(3, `<div class="qp-npp__progress">正在安装 0/${targets.length}…</div>` +
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
        if (stage) stage.textContent = `正在安装 ${done}/${targets.length}…`;
        if (bar) bar.style.width = `${Math.max(4, Math.round((done / Math.max(1, targets.length)) * 100))}%`;
      }
      setStep(3,
        `<div class="qp-npp__done">已安装 ${done} 个，跳过 ${failures.length} 个</div>` +
        (failures.length ? `<ul class="qp-npp__fails">${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : '') +
        `<div class="qp-npp__boundary">${noticeHtml(escapeHtml)}</div>` +
        `<div class="qp-plugin__foot"><button class="btn is-primary" data-role="close">完成</button></div>`);
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
  const labels = ['① 扫描', '② 报告', '③ 安装'];
  return `<div class="qp-npp__stepper">` +
    labels.map((l, i) => `<span class="qp-npp__step${i + 1 === step ? ' is-active' : ''}"` +
      `${i + 1 === step ? ' aria-current="step"' : ''}>${l}</span>`).join('') +
    `</div>` + (content || `<div class="qp-npp__loading">正在扫描本机 Notepad++ 插件…</div>`);
}

/**
 * 分组 HTML。
 * @param {string} label
 * @param {string} status
 * @param {Array<object>} mapped
 * @return {string}
 */
function groupHtml(label, status, mapped) {
  const rows = mapped.filter((x) => status === 'unsupported'
    ? x.status !== 'builtin' && x.status !== 'port'
    : x.status === status);
  return `<details class="qp-npp__group" data-npp-group="${escapeHtml(status)}" open>` +
    `<summary>${escapeHtml(label)}（${rows.length}）</summary>` +
    (rows.map((x) => {
      const e = x.entry || {};
      return `<div class="qp-npp__row" data-npp-row data-npp-plugin="${escapeHtml(x.name)}" ` +
        `data-npp-status="${escapeHtml(status)}">` +
        `<span class="qp-npp__check" data-npp-check>${status === 'unsupported' ? '✕' : '✓'}</span>` +
        `<span class="qp-npp__name">${escapeHtml(x.name)}</span>` +
        `<span class="qp-npp__license">${escapeHtml(e.nppLicense || 'GPL')}</span>` +
        `<span class="qp-npp__equiv">等价项：${escapeHtml(e.quillpadEquivalent || '—')}</span>` +
        (status === 'port' && e.installable ? `<button class="btn is-ghost" data-npp-install-one>安装</button>` : '') +
        (status === 'unsupported' ? `<span class="qp-npp__reason" title="${escapeHtml(e.reason || '暂无兼容实现')}">` +
          `${escapeHtml(String(e.reason || '暂无兼容实现').slice(0, 18))}…</span>` : '') +
        `</div>`;
    }).join('') || `<div class="qp-npp__none">无</div>`) +
    `</details>`;
}

/* ================================================== 从 URL / 本地 zip 安装 */

/**
 * 「＋ 从 URL 安装」：本地 zip 走 FileReader，URL 走 fetch，再交给主进程。
 * @param {object} app
 */
export function openInstallFromUrl(app) {
  const body =
    `<p class="qp-install__lead">安装第三方插件前，请确认其许可证在白名单内（MIT / Apache-2.0 / ` +
    `BSD / ISC / 0BSD）。GPL / AGPL / SSPL 一律拒绝。</p>` +
    `<label class="qp-install__row"><span>本地 zip</span>` +
    `<input type="file" accept=".zip" data-install-file /></label>` +
    `<label class="qp-install__row"><span>或 URL</span>` +
    `<input type="text" data-install-url placeholder="https://…/plugin.zip" /></label>` +
    `<div class="qp-plugin__foot"><button class="btn is-ghost" data-role="close">取消</button>` +
    `<button class="btn is-primary" data-install-go>安装</button></div>`;
  const dlg = makeDialog('plugin-install', '从 URL / 本地安装插件', body, '480px');
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
      toast('请选择本地 zip 或填写 URL', 'info', 2200);
      return;
    }
    const res = await host.installFromZip(app, payload);
    if (res && res.ok === false) toast(`安装失败：${res.error || res.code}`, 'error', 4200);
    else toast('插件已安装', 'success', 2400);
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
    `<div class="qp-plugin-view__title">${escapeHtml(v.title || v.id)}</div>` +
    `<div class="qp-plugin-view__hint">由插件 ${escapeHtml(v.pluginId || '')} 提供</div></div>`,
  ).join('') + `</div>`;
}

/* ============================================================ 初始化入口 */

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

  // 插件菜单化：注册「插件」顶级菜单所需的命令入口
  // （懒加载 openPluginManager，避免与 plugin-manager.js 形成启动期环依赖）
  defineCommand({
    id: 'plugins.manager',
    title: '插件管理器…',
    category: '插件',
    run: async () => {
      const mod = await import('./plugin-manager.js');
      mod.openPluginManager(app);
    },
  });
  defineCommand({
    id: 'plugins.installUrl',
    title: '从 URL / 本地安装…',
    category: '插件',
    run: () => openInstallFromUrl(app),
  });
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
