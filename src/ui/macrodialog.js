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
  modal.setAttribute('aria-label', '宏管理');

  const listHtml = () => {
    const list = getMacros();
    if (!list.length) {
      return (
        '<div class="qp-macro__empty">还没有录制任何宏。<br/>' +
        '点工具栏的 <strong>录制</strong> 按钮或按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> 开始，' +
        '再按一次停止并命名。</div>'
      );
    }
    return list
      .map(
        (m) =>
          `<div class="qp-macro__row" data-macro-id="${escapeHtml(m.id)}">` +
          `<span class="qp-macro__name">${escapeHtml(m.name)}</span>` +
          `<span class="qp-macro__meta">${m.steps.length} 步 · ${new Date(m.createdAt).toLocaleString('zh-CN')}</span>` +
          `<span class="qp-macro__ops">` +
          `<button class="btn btn--ghost" data-op="play" data-id="${escapeHtml(m.id)}" title="回放">${icon('chevronRight', 13)}</button>` +
          `<button class="btn btn--ghost" data-op="rename" data-id="${escapeHtml(m.id)}" title="重命名">${icon('theme', 13)}</button>` +
          `<button class="btn btn--ghost" data-op="delete" data-id="${escapeHtml(m.id)}" title="删除">${icon('trash', 13)}</button>` +
          `</span></div>`,
      )
      .join('');
  };

  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__glyph is-info">${icon('command', 15)}</span>` +
    `<span class="modal__title">宏管理</span>` +
    `<button class="qp-pdf__close" data-role="close" aria-label="关闭">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-macro__body" data-role="list">${listHtml()}</div>` +
    `<div class="modal__foot">` +
    `<span class="qp-macro__path">${desktop.canPersistMacros() ? '保存在应用数据目录的 macros.json' : '保存在浏览器本地存储'}</span>` +
    `<button class="btn btn--ghost" data-role="close2">关闭</button>` +
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
        toast(`已回放 ${res.played} 步，跳过 ${res.skipped.length} 步（不可重放的命令）`, 'info', 3000);
      } else {
        toast(`已回放「${macro.name}」${res.played} 步`, 'success', 2200);
      }
      return;
    }

    if (btn.dataset.op === 'rename') {
      const name = await promptInput({ title: '重命名宏', label: '名称', value: macro.name });
      if (name) {
        await renameMacro(id, name);
        rerender();
      }
      return;
    }

    if (btn.dataset.op === 'delete') {
      const ok = await confirmAction({
        title: '删除宏',
        message: `确定删除「${escapeHtml(macro.name)}」？此操作不能撤销。`,
        okLabel: '删除',
        danger: true,
      });
      if (ok) {
        await deleteMacro(id);
        rerender();
        toast('已删除', 'info', 1600);
      }
    }
  });

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  current = { el: modal, close };
}
