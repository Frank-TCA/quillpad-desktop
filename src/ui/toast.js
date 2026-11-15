/**
 * QuillPad · Toast 通知
 * 右下角堆叠，2.5 秒后自动淡出；成功 / 错误 / 信息三种语气。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';

const ROOT_ID = 'toast-root';
let root = null;

/**
 * 取（或懒创建）toast 容器。
 * @return {HTMLElement}
 */
function getRoot() {
  if (root && root.isConnected) return root;
  root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'toast-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * 弹出一条通知。
 * @param {string} message 文案
 * @param {'success'|'error'|'info'} [kind] 语气
 * @param {number} [duration] 毫秒，默认 2500
 */
export function toast(message, kind = 'info', duration = 2500) {
  const host = getRoot();
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  const glyph = kind === 'success' ? 'success' : kind === 'error' ? 'alert' : 'info';
  el.innerHTML =
    `<span class="toast__icon">${icon(glyph, 15)}</span>` +
    `<span class="toast__msg">${escapeHtml(message)}</span>`;
  host.appendChild(el);

  const remove = () => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 180);
  };
  const timer = window.setTimeout(remove, duration);
  el.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });

  // 最多同时显示 5 条，超出移除最旧的
  while (host.children.length > 5) host.firstElementChild?.remove();
}

export const toastSuccess = (msg, d) => toast(msg, 'success', d);
export const toastError = (msg, d) => toast(msg, 'error', d);
export const toastInfo = (msg, d) => toast(msg, 'info', d);
