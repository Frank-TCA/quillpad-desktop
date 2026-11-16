/**
 * QuillPad · 宏管理对话框（T13）
 *
 * 一个列表 + 四个动作：回放 / 重命名 / 删除 / 关闭。
 * 录制本身不在这里启动 —— 录制是「高频轻量动作」，入口在工具栏与状态栏，
 * 对话框只负责**管理已录的宏**。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { getMacros, renameMacro, deleteMacro, playMacro, loadMacros } from '../core/macro.js';
import { promptInput, confirmAction } from './dialogs.js';
import { toast } from './toast.js';
import * as desktop from '../core/desktop.js';
import { t, isEnglish } from '../core/i18n.js';

/** 当前打开的对话框。 */
let current = null;

/**
 * 打开宏管理。
 * @param {object} app
 * @return {Promise<void>}
 */
export async function openMacroManager(app) {
  if (current) return;
  await loadMacros();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal qp-dialog qp-macro';
  modal.setAttribute('data-dialog', 'macros');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', t('宏管理', 'Macro Manager'));

  const listHtml = () => {
    const list = getMacros();
    if (!list.length) {
      return (
        `<div class="qp-macro__empty">${t('还没有录制任何宏。', 'No macros recorded yet.')}<br/>` +
        `${t('点工具栏的', 'Click the')} <strong>${t('录制', 'Record')}</strong> ` +
        `${t('按钮或按', 'button in the toolbar, or press')} ` +
        `<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> ` +
        `${t('开始，再按一次停止并命名。', 'to start; press again to stop and name the macro.')}</div>`
      );
    }
    return list
      .map((m) => {
        const dateText = new Date(m.createdAt).toLocaleString(isEnglish() ? 'en' : 'zh-CN');
        const meta = t(`${m.steps.length} 步 · ${dateText}`, `${m.steps.length} steps · ${dateText}`);
        return (
          `<div class="qp-macro__row" data-macro-id="${escapeHtml(m.id)}">` +
          `<span class="qp-macro__name">${escapeHtml(m.name)}</span>` +
          `<span class="qp-macro__meta">${meta}</span>` +
          `<span class="qp-macro__ops">` +
          `<button class="btn btn--ghost" data-op="play" data-id="${escapeHtml(m.id)}" title="${t('回放', 'Play')}">${icon('chevronRight', 13)}</button>` +
          `<button class="btn btn--ghost" data-op="rename" data-id="${escapeHtml(m.id)}" title="${t('重命名', 'Rename')}">${icon('theme', 13)}</button>` +
          `<button class="btn btn--ghost" data-op="delete" data-id="${escapeHtml(m.id)}" title="${t('删除', 'Delete')}">${icon('trash', 13)}</button>` +
          `</span></div>`
        );
      })
      .join('');
  };

  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__glyph is-info">${icon('command', 15)}</span>` +
    `<span class="modal__title">${t('宏管理', 'Macro Manager')}</span>` +
    `<button class="qp-pdf__close" data-role="close" aria-label="${t('关闭', 'Close')}">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-macro__body" data-role="list">${listHtml()}</div>` +
    `<div class="modal__foot">` +
    `<span class="qp-macro__path">${desktop.canPersistMacros()
      ? t('保存在应用数据目录的 macros.json', 'Stored in macros.json in the app data directory')
      : t('保存在浏览器本地存储', 'Stored in browser local storage')}</span>` +
    `<button class="btn btn--ghost" data-role="close2">${t('关闭', 'Close')}</button>` +
    `</div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const listEl = modal.querySelector('[data-role="list"]');
  const rerender = () => {
    listEl.innerHTML = listHtml();
  };

  /** 关闭。 */
  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown, true);
    current = null;
  }

  /** Esc 关闭。 */
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  }
  document.addEventListener('keydown', onKeydown, true);

  modal.addEventListener('click', async (e) => {
    if (e.target.closest('[data-role="close"]') || e.target.closest('[data-role="close2"]')) {
      close();
      return;
    }
    const btn = e.target.closest('[data-op]');
    if (!btn) return;
    const id = btn.dataset.id;
    const macro = getMacros().find((m) => m.id === id);
    if (!macro) return;

    if (btn.dataset.op === 'play') {
      const res = await playMacro(macro, app);
      if (res.skipped.length) {
        toast(t(`已回放 ${res.played} 步，跳过 ${res.skipped.length} 步（不可重放的命令）`,
          `Played ${res.played} steps, skipped ${res.skipped.length} steps (commands that cannot be replayed)`), 'info', 3000);
      } else {
        toast(t(`已回放「${macro.name}」${res.played} 步`, `Played "${macro.name}" — ${res.played} steps`), 'success', 2200);
      }
      return;
    }

    if (btn.dataset.op === 'rename') {
      const name = await promptInput({
        title: t('重命名宏', 'Rename Macro'),
        label: t('名称', 'Name'),
        value: macro.name,
      });
      if (name) {
        await renameMacro(id, name);
        rerender();
      }
      return;
    }

    if (btn.dataset.op === 'delete') {
      const ok = await confirmAction({
        title: t('删除宏', 'Delete Macro'),
        message: t(`确定删除「${escapeHtml(macro.name)}」？此操作不能撤销。`,
          `Delete "${escapeHtml(macro.name)}"? This cannot be undone.`),
        okLabel: t('删除', 'Delete'),
        danger: true,
      });
      if (ok) {
        await deleteMacro(id);
        rerender();
        toast(t('已删除', 'Deleted'), 'info', 1600);
      }
    }
  });

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  current = { el: modal, close };
}
