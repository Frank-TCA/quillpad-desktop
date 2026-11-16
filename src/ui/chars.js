/**
 * QuillPad · 特殊字符面板（PRD C11）
 *
 * 结构：搜索框 + 分组 chips + 最近使用 + 字符网格。
 * 网格用 `content-visibility: auto` 而不是虚拟滚动 —— 600 多个按钮的
 * DOM 规模对 Chromium 来说毫无压力，虚拟滚动反而会让「按码位搜索」的
 * 高亮与键盘遍历变复杂。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import {
  CHAR_GROUPS,
  charCount,
  allChars,
  searchChars,
  codepointLabel,
  loadRecentChars,
  pushRecentChar,
} from '../core/chars.js';
import { activeTab } from '../core/state.js';
import { toast } from './toast.js';
import { t, pickLocalized } from '../core/i18n.js';

/** 当前打开的对话框。 */
let current = null;

/**
 * 在光标处插入字符（替换选区）。
 * @param {object} app
 * @param {string} ch
 * @return {boolean}
 */
export function insertChar(app, ch) {
  if (!ch) return false;
  const tab = activeTab();
  if (!tab) {
    toast(t('没有打开的文档', 'No document is open.'), 'info', 1800);
    return false;
  }
  const view = app.editor.view;
  if (!view) return false;
  // `replaceSelection` 是 **EditorState** 的方法（不是 view 的）：它返回一个
  // TransactionSpec，交给 view.dispatch 才真正落到文档。
  view.dispatch({ ...view.state.replaceSelection(ch), scrollIntoView: true });
  view.focus();
  return true;
}

/**
 * 打开特殊字符面板。
 * @param {object} app
 * @return {{el: HTMLElement, close: () => void}}
 */
export function openCharsDialog(app) {
  if (current) {
    current.focusSearch();
    return current;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal qp-dialog qp-chars';
  modal.setAttribute('data-dialog', 'chars');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', t('插入特殊字符', 'Insert Special Character'));

  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__glyph is-info">${icon('symbol', 15)}</span>` +
    `<span class="modal__title">${t('插入特殊字符', 'Insert Special Character')}</span>` +
    `<span class="qp-chars__count" data-role="count">${t(`${charCount()} 个`, `${charCount()} characters`)}</span>` +
    `<button class="qp-pdf__close" data-role="close" aria-label="${t('关闭', 'Close')}">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-chars__body">` +
    `<div class="qp-chars__search">` +
    `<input type="text" class="text-input" data-role="search" placeholder="${t('搜索：分组名，或直接输入码位（如 4E2D / U+4E2D）', 'Search: group name, or enter a code point (e.g. 4E2D / U+4E2D)')}" />` +
    `</div>` +
    `<div class="qp-chars__groups" data-role="groups"></div>` +
    `<div class="qp-chars__recent" data-role="recent-wrap" hidden>` +
    `<div class="qp-chars__label">${t('最近使用', 'Recent')}</div>` +
    `<div class="qp-chars__grid qp-chars__grid--recent" data-role="recent"></div>` +
    `</div>` +
    `<div class="qp-chars__label" data-role="list-label">${t('全部', 'All')}</div>` +
    `<div class="qp-chars__grid" data-role="grid"></div>` +
    `</div>` +
    `<div class="modal__foot">` +
    `<span class="qp-chars__hint">${t('点击字符即插入到光标处 · Esc 关闭', 'Click a character to insert it at the cursor · Esc to close')}</span>` +
    `<button class="btn is-primary" data-role="close2">${t('完成', 'Done')}</button>` +
    `</div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const $ = (sel) => modal.querySelector(sel);
  const gridEl = $('[data-role="grid"]');
  const recentEl = $('[data-role="recent"]');
  const recentWrap = $('[data-role="recent-wrap"]');
  const groupsEl = $('[data-role="groups"]');
  const searchEl = $('[data-role="search"]');
  const listLabel = $('[data-role="list-label"]');

  let activeGroup = 'all';
  let query = '';

  /** 渲染分组 chips。 */
  function renderGroups() {
    const chips = [
      { id: 'all', name: t('全部', 'All'), nameEn: 'All' },
      ...CHAR_GROUPS.map((g) => ({ id: g.id, name: g.name, nameEn: g.nameEn || '' })),
    ];
    groupsEl.innerHTML = chips
      .map(
        (g) =>
          `<button class="qp-chars__chip${g.id === activeGroup ? ' is-active' : ''}" ` +
          `data-group="${escapeHtml(g.id)}" type="button">${escapeHtml(pickLocalized(g, 'name'))}</button>`,
      )
      .join('');
  }

  /**
   * 渲染字符网格。
   * @param {string[]} chars
   * @param {HTMLElement} host
   */
  function renderGrid(chars, host) {
    if (!chars.length) {
      host.innerHTML = `<div class="qp-chars__empty">${t('没有匹配的字符', 'No matching characters')}</div>`;
      return;
    }
    host.innerHTML = chars
      .map(
        (ch) =>
          `<button class="qp-chars__cell" type="button" data-char="${escapeHtml(ch)}" ` +
          `data-tip="${codepointLabel(ch)}" aria-label="${codepointLabel(ch)}">${escapeHtml(ch)}</button>`,
      )
      .join('');
  }

  /** 重新计算要显示的字符集。 */
  function refresh() {
    let chars;
    if (query) chars = searchChars(query);
    else if (activeGroup === 'all') chars = allChars();
    else {
      const group = CHAR_GROUPS.find((g) => g.id === activeGroup);
      chars = group ? [...group.chars] : allChars();
    }
    listLabel.textContent = query
      ? t(`搜索结果（${chars.length}）`, `Search results (${chars.length})`)
      : activeGroup === 'all' ? t('全部', 'All') : t('本组', 'This group');
    renderGrid(chars, gridEl);

    const recent = loadRecentChars();
    recentWrap.hidden = recent.length === 0;
    if (recent.length) renderGrid(recent, recentEl);
  }

  /** 关闭。 */
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown, true);
    current = null;
  }

  /** Esc 关闭；输入框里按 Esc 先清空搜索。 */
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (query) {
      searchEl.value = '';
      query = '';
      refresh();
      return;
    }
    close();
  }
  document.addEventListener('keydown', onKeydown, true);

  groupsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (!btn) return;
    activeGroup = btn.dataset.group;
    query = '';
    searchEl.value = '';
    renderGroups();
    refresh();
  });

  searchEl.addEventListener('input', () => {
    query = searchEl.value.trim();
    refresh();
  });

  modal.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-char]');
    if (cell) {
      const ch = cell.dataset.char;
      if (insertChar(app, ch)) {
        pushRecentChar(ch);
        refresh();
      }
      return;
    }
    if (e.target.closest('[data-role="close"]') || e.target.closest('[data-role="close2"]')) close();
  });

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  renderGroups();
  refresh();
  window.setTimeout(() => searchEl.focus(), 30);

  current = { el: modal, close, focusSearch: () => searchEl.focus() };
  return current;
}

/** 关闭面板（如果开着）。 */
export function closeCharsDialog() {
  if (current) current.close();
}

/** 是否有面板打开。 */
export function isCharsDialogOpen() {
  return !!current;
}
