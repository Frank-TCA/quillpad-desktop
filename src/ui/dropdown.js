/**
 * QuillPad · 下拉菜单 / 上下文菜单（通用组件）
 *
 * 完全自绘，支持：分组分隔线、右侧快捷键、勾选态、键盘上下 / 回车 / Esc、
 * 点击外部关闭、超出视口时自动翻转、二级子菜单（hover 展开）、
 * 内容超高时自动限高滚动（菜单适配窗口）。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { IS_MAC } from '../core/commands.js';

/**
 * @typedef {object} DropdownItem
 * @property {string} [label]
 * @property {string[][]} [keys] 每段一个按键数组
 * @property {boolean|null} [checked] null 表示不显示勾选
 * @property {boolean} [disabled]
 * @property {boolean} [separator]
 * @property {string} [groupTitle]
 * @property {string} [swatch] 颜色图例（CSS 颜色字符串，渲染为 label 前的小色块）
 * @property {DropdownItem[]} [submenu] 二级子菜单项
 * @property {() => void} [run]
 */

/** 当前打开的根菜单控制器（同一时刻只允许一个根）。 */
let current = null;

/**
 * 关闭当前菜单（含全部子菜单）。
 */
export function closeDropdown() {
  if (current) current.close();
}

/**
 * 判断事件目标是否落在任意浮层菜单内部。
 *
 * 菜单面板统一挂在 document.body 下，并不属于触发它的容器（菜单栏 / 标签栏等），
 * 因此所有「点击外部即关闭」的逻辑都必须先排除 .dropdown / .context-menu：
 * 否则会在 mousedown 的捕获阶段把面板从 DOM 上摘掉，随后的 click 事件因为
 * 目标节点已脱离文档而根本不会派发，菜单项的命令将永远不会执行（QA P0）。
 *
 * @param {EventTarget|null} target 事件目标
 * @return {boolean} 是否位于浮层菜单内
 */
export function isInsideFloatingMenu(target) {
  return target instanceof Element && !!target.closest('.dropdown, .context-menu');
}

/**
 * 是否有菜单打开。
 * @return {boolean}
 */
export function isDropdownOpen() {
  return !!current;
}

/**
 * 打开一个下拉菜单。
 *
 * 支持二级子菜单：item.submenu 非空时渲染右箭头，hover / 点击在右侧展开嵌套面板。
 * 嵌套面板（子菜单）传 `nested: true`，不会抢占根菜单的 current 所有权，
 * 根菜单关闭时连带关闭全部子菜单。
 *
 * @param {object} opts
 * @param {number} opts.x 锚点左边缘（viewport 坐标）
 * @param {number} opts.y 锚点下边缘（viewport 坐标）
 * @param {DropdownItem[]} opts.items
 * @param {string} [opts.className]
 * @param {number} [opts.minWidth]
 * @param {(index: number) => void} [opts.onHighlight]
 * @param {() => void} [opts.onClose]
 * @param {boolean} [opts.nested] 作为子菜单打开（不抢占根 current）
 * @param {{close: () => void}} [opts.owner] 所属父菜单控制器（nested 用）
 * @return {{close: () => void, el: HTMLElement}}
 */
export function openDropdown(opts) {
  const nested = !!opts.nested;
  if (!nested) closeDropdown();

  const { items, x, y, className = 'dropdown', minWidth = 200, onClose } = opts;
  const el = document.createElement('div');
  el.className = className;
  el.style.minWidth = `${minWidth}px`;
  el.setAttribute('role', 'menu');

  const selectableIndexes = [];
  el.innerHTML = items
    .map((item, i) => {
      if (item.separator) return '<div class="dropdown__sep"></div>';
      if (item.groupTitle) return `<div class="dropdown__group-title">${escapeHtml(item.groupTitle)}</div>`;
      selectableIndexes.push(i);
      const hasSub = Array.isArray(item.submenu) && item.submenu.length > 0;
      const check = item.checked === null || item.checked === undefined
        ? '<span class="dropdown__item-check"></span>'
        : `<span class="dropdown__item-check">${item.checked ? icon('check', 12) : ''}</span>`;
      // 颜色图例小色块（swatch 提供 CSS 颜色时渲染在 label 前）
      const swatch = item.swatch
        ? `<span class="dropdown__item-swatch" style="background:${escapeHtml(item.swatch)}"></span>`
        : '';
      const keys = (item.keys || [])
        .map((chord) => chord.join(IS_MAC ? '' : '+'))
        .filter(Boolean)
        .join(' ');
      return (
        `<div class="dropdown__item${hasSub ? ' dropdown__item--has-sub' : ''}" role="menuitem" ` +
        `data-index="${i}" data-disabled="${item.disabled ? 'true' : 'false'}">` +
        check +
        swatch +
        `<span class="dropdown__item-label">${escapeHtml(item.label || '')}</span>` +
        (keys ? `<span class="dropdown__item-key">${escapeHtml(keys)}</span>` : '') +
        (hasSub ? `<span class="dropdown__item-arrow">${icon('chevronRight', 11)}</span>` : '') +
        `</div>`
      );
    })
    .join('');

  document.body.appendChild(el);

  // 菜单适配窗口：内容超出视口时限高并内部滚动
  const margin = 8;
  const availableH = window.innerHeight - y - margin;
  const maxH = Math.max(160, Math.min(availableH, window.innerHeight * 0.82));
  if (el.scrollHeight > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    el.style.overflowY = 'auto';
  }

  // 定位 + 翻转
  const rect = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, y - rect.height - 24);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;

  let activePos = 0;
  /** 按下（mousedown）时命中的菜单项下标；-1 表示当前没有待执行的按下动作。 */
  let pressedIndex = -1;
  /** 菜单项是否已经执行过（避免重复触发）。 */
  let activated = false;
  /** 当前展开的子菜单控制器。 */
  /** @type {{close: () => void}|null} */
  let childMenu = null;
  /** 子菜单对应的父项 index（用于判断是否需要切换）。 */
  let childForIndex = -2;

  /** 关闭子菜单。 */
  const closeChild = () => {
    if (childMenu) {
      const c = childMenu;
      childMenu = null;
      childForIndex = -2;
      c.close();
    }
  };

  /**
   * 展开某个带子菜单的项。
   * @param {number} index
   */
  const openSubmenu = (index) => {
    if (childForIndex === index && childMenu) return;
    closeChild();
    const item = items[index];
    if (!item || !Array.isArray(item.submenu) || !item.submenu.length) return;
    const node = el.querySelector(`[data-index="${index}"]`);
    if (!node) return;
    const r = node.getBoundingClientRect();
    childForIndex = index;
    childMenu = openDropdown({
      x: r.right - 4,
      y: r.top - 5,
      items: item.submenu,
      className,
      minWidth: 180,
      nested: true,
      owner: controller,
    });
  };

  /** 高亮第 pos 个可选项。 */
  const highlight = (pos) => {
    const nodes = el.querySelectorAll('.dropdown__item');
    nodes.forEach((n) => n.classList.remove('is-active'));
    if (!selectableIndexes.length) return;
    activePos = (pos + selectableIndexes.length) % selectableIndexes.length;
    const target = el.querySelector(`[data-index="${selectableIndexes[activePos]}"]`);
    if (target) {
      target.classList.add('is-active');
      target.scrollIntoView({ block: 'nearest' });
      // 高亮项带子菜单时自动展开
      const item = items[selectableIndexes[activePos]];
      if (item && Array.isArray(item.submenu) && item.submenu.length) {
        openSubmenu(selectableIndexes[activePos]);
      } else {
        closeChild();
      }
    }
  };

  /**
   * 执行某一项。
   * @param {number} index
   */
  const activate = (index) => {
    const item = items[index];
    if (!item || item.separator || item.disabled) return;
    // 带子菜单的项：展开而不是执行
    if (Array.isArray(item.submenu) && item.submenu.length) {
      openSubmenu(index);
      return;
    }
    activated = true;
    controller.close();
    if (item.run) item.run();
  };

  const onMouseOver = (e) => {
    const node = e.target.closest('.dropdown__item');
    if (!node) return;
    const idx = selectableIndexes.indexOf(Number(node.dataset.index));
    if (idx >= 0) highlight(idx);
  };

  const onClick = (e) => {
    const node = e.target.closest('.dropdown__item');
    if (!node) return;
    activate(Number(node.dataset.index));
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // 子菜单打开时 Esc 只关子菜单
      if (childMenu) {
        closeChild();
        return;
      }
      controller.close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      highlight(activePos + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      highlight(activePos - 1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      highlight(0);
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      highlight(selectableIndexes.length - 1);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (selectableIndexes.length) activate(selectableIndexes[activePos]);
      return;
    }
    if (e.key === 'ArrowRight') {
      // 进入子菜单
      e.preventDefault();
      e.stopPropagation();
      const item = items[selectableIndexes[activePos]];
      if (item && Array.isArray(item.submenu) && item.submenu.length) {
        openSubmenu(selectableIndexes[activePos]);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      // 子菜单内左键：关闭子菜单返回父级
      if (nested) {
        e.preventDefault();
        e.stopPropagation();
        controller.close();
      }
      return;
    }
  };

  const onDocPointerDown = (e) => {
    // 面板内部的按下不关闭（否则 click 目标会随面板一起消失）
    if (el.contains(e.target)) return;
    // 落在别的浮层菜单上时同样不抢先关闭，交给那个菜单自己处理
    if (isInsideFloatingMenu(e.target)) return;
    // 子菜单的点击外部：只关子菜单，保留根菜单（点击根菜单区域时）
    if (nested && opts.owner && opts.owner.el && opts.owner.el.contains(e.target)) {
      closeChild();
      return;
    }
    controller.close();
  };

  /**
   * 记录「按下」命中的菜单项。
   *
   * 监听器挂在 window 的捕获阶段，保证早于任何 document 上的捕获监听器执行；
   * 这样即便外部逻辑在本帧内把面板提前移除，这里也已经记住了要执行的菜单项。
   * @param {MouseEvent} e
   */
  const onWindowMouseDown = (e) => {
    if (!(e.target instanceof Node) || !el.contains(e.target)) return;
    const node = e.target.closest('.dropdown__item');
    if (!node) return;
    pressedIndex = Number(node.dataset.index);
  };

  /**
   * 松开时若已不在面板内（例如按下菜单项后拖走再松开），丢弃待执行项，避免误触发。
   * @param {MouseEvent} e
   */
  const onWindowMouseUp = (e) => {
    if (!(e.target instanceof Node) || !el.contains(e.target)) pressedIndex = -1;
  };

  const controller = {
    el,
    close() {
      if (controller._closed) return;
      controller._closed = true;
      closeChild();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onDocPointerDown, true);
      window.removeEventListener('mousedown', onWindowMouseDown, true);
      window.removeEventListener('mouseup', onWindowMouseUp, true);
      el.remove();
      if (onClose) onClose();
      // 兜底：按下时确实命中了某个菜单项，但面板在 click 派发前就被外部逻辑移除，
      // 此时补执行该菜单项的命令，杜绝「点了菜单项没反应」。
      if (!activated && pressedIndex >= 0) {
        const item = items[pressedIndex];
        activated = true;
        if (item && !item.separator && !item.disabled && item.run) item.run();
      }
    },
    _closed: false,
  };

  el.addEventListener('mouseover', onMouseOver);
  el.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onDocPointerDown, true);
  window.addEventListener('mousedown', onWindowMouseDown, true);
  window.addEventListener('mouseup', onWindowMouseUp, true);
  highlight(0);

  if (!nested) current = controller;
  return controller;
}

/**
 * 在鼠标位置打开上下文菜单。
 * @param {MouseEvent} evt
 * @param {DropdownItem[]} items
 * @return {{close: () => void}}
 */
export function openContextMenu(evt, items) {
  evt.preventDefault();
  return openDropdown({
    x: evt.clientX,
    y: evt.clientY,
    items,
    className: 'context-menu',
    minWidth: 180,
  });
}
