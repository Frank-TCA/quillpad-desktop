/**
 * QuillPad · 标签栏
 * 横向滚动、拖拽排序、中键关闭、右键菜单、脏标记。
 */

import { state, isDirty, getTab } from '../core/state.js';
import { icon } from './icons.js';
import { openContextMenu } from './dropdown.js';
import { escapeHtml } from '../core/utils.js';
import { runCommand } from '../core/commands.js';

/**
 * 初始化标签栏。
 * @param {HTMLElement} root
 * @param {object} app
 */
export function initTabs(root, app) {
  /** @type {string|null} 拖拽中的标签 id */
  let dragId = null;
  /** @type {string|null} 拖放目标标签 id */
  let dropId = null;
  let dropAfter = false;
  /** @type {number} 最近一次点击关闭按钮的时间，用于挡住「双击关闭」的误判 */
  let lastCloseClickAt = 0;

  // 空白处悬停时给出可发现性提示（标签自身有 title，会覆盖它）
  root.title = '双击空白处新建文件';

  /** 清理拖放指示。 */
  const clearIndicators = () => {
    root.querySelectorAll('.tab').forEach((n) => {
      n.classList.remove('is-drop-before', 'is-drop-after', 'is-dragging');
    });
  };

  /**
   * 更新标签栏的溢出状态。
   *
   * 横向溢出时标签栏两侧会出现渐隐遮罩（挂在 .editor-pane 上），
   * 提示「还有更多标签在视口外」；滚到头/尾时对应一侧的遮罩自动隐藏。
   */
  function updateOverflow() {
    const pane = root.parentElement;
    if (!pane) return;
    const overflowing = root.scrollWidth > root.clientWidth + 1;
    const atStart = root.scrollLeft <= 1;
    const atEnd = root.scrollLeft + root.clientWidth >= root.scrollWidth - 1;
    pane.classList.toggle('is-overflow-left', overflowing && !atStart);
    pane.classList.toggle('is-overflow-right', overflowing && !atEnd);
    // 「+」按钮据此吸附到右边缘，标签溢出时也不会被滚出视口
    root.classList.toggle('has-overflow', overflowing);

    // 左右滑动按钮：仅在溢出时显示，滚到头/尾时对应一侧禁用
    if (navPrev) {
      navPrev.hidden = !overflowing;
      navPrev.disabled = atStart;
    }
    if (navNext) {
      navNext.hidden = !overflowing;
      navNext.disabled = atEnd;
    }
  }

  /**
   * 按可视宽度 70% 平滑滚动标签栏。
   * @param {1|-1} dir 1 向右，-1 向左
   */
  function scrollTabsBy(dir) {
    const step = Math.max(120, Math.round(root.clientWidth * 0.7));
    root.scrollBy({ left: dir * step, behavior: 'smooth' });
  }

  /** @type {HTMLElement|null} 左滑动按钮 */
  let navPrev = null;
  /** @type {HTMLElement|null} 右滑动按钮 */
  let navNext = null;

  /** 建左右滑动按钮（挂在标签栏父容器上，不随滚动位移）。 */
  function ensureNavButtons() {
    const pane = root.parentElement;
    if (!pane || navPrev) return;
    navPrev = document.createElement('button');
    navPrev.className = 'tabnav tabnav--prev';
    navPrev.type = 'button';
    navPrev.setAttribute('aria-label', '向左滚动标签');
    navPrev.innerHTML = icon('chevronLeft', 13);
    navNext = document.createElement('button');
    navNext.className = 'tabnav tabnav--next';
    navNext.type = 'button';
    navNext.setAttribute('aria-label', '向右滚动标签');
    navNext.innerHTML = icon('chevronRight', 13);
    navPrev.hidden = true;
    navNext.hidden = true;
    navPrev.addEventListener('click', () => scrollTabsBy(-1));
    navNext.addEventListener('click', () => scrollTabsBy(1));
    pane.appendChild(navPrev);
    pane.appendChild(navNext);
  }
  ensureNavButtons();

  /** 渲染标签栏。 */
  function render() {
    const html =
      state.tabs
        .map((tab) => {
          const active = tab.id === state.activeTabId;
          const dirty = isDirty(tab);
          return (
            `<div class="tab ${active ? 'is-active' : ''}" data-tab-id="${tab.id}" role="tab" ` +
            `aria-selected="${active}" draggable="true" title="${escapeHtml(tab.path || tab.name)}">` +
            `<span class="tab__icon">${icon(app.tabIcon(tab), 13)}</span>` +
            `<span class="tab__name">${escapeHtml(tab.name)}</span>` +
            (dirty ? '<span class="tab__dirty" aria-label="未保存"></span>' : '') +
            `<span class="tab__close" data-close="${tab.id}" role="button" aria-label="关闭">${icon('close', 12)}</span>` +
            `</div>`
          );
        })
        .join('') +
      // 最后一个标签之后的「+」：新建文件。标签多到溢出时它吸附在右边缘，
      // 不会随内容滚出视口（见 layout.css 的 .tabbar.has-overflow .tabadd）。
      `<button class="tabadd" type="button" data-newfile="1" ` +
      `title="新建文件（Ctrl+N）" aria-label="新建文件">${icon('plus', 14)}</button>`;
    root.innerHTML = html;
    // 一个标签都没有时整条标签栏隐藏（欢迎页占满编辑区），保留 v1 的布局
    root.classList.toggle('is-empty', state.tabs.length === 0);

    // 让活动标签保持可见
    const activeEl = root.querySelector('.tab.is-active');
    if (activeEl) {
      const left = activeEl.offsetLeft;
      const right = left + activeEl.offsetWidth;
      if (left < root.scrollLeft) root.scrollLeft = left - 8;
      else if (right > root.scrollLeft + root.clientWidth) {
        root.scrollLeft = right - root.clientWidth + 8;
      }
    }
    updateOverflow();
  }

  root.addEventListener('scroll', updateOverflow, { passive: true });
  window.addEventListener('resize', updateOverflow);

  /* ------------------------------------------------------- 横向滚动（滚轮）
     标签溢出时：纵向滚轮转成横向滚动，Shift+滚轮亦横向；
     Ctrl/Meta+滚轮留给字号缩放（不要在这里吃掉）。 */
  root.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return;
      if (root.scrollWidth <= root.clientWidth + 1) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      e.preventDefault();
      root.scrollLeft += delta;
      updateOverflow();
    },
    { passive: false },
  );

  root.addEventListener('click', (e) => {
    // 「+」新建文件：放在标签之后，点了就走和 Ctrl+N 同一条命令
    if (e.target.closest('[data-newfile]')) {
      e.preventDefault();
      runCommand('file.new', app);
      return;
    }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      e.stopPropagation();
      lastCloseClickAt = Date.now();
      app.closeTab(closeBtn.dataset.close);
      return;
    }
    const tabEl = e.target.closest('[data-tab-id]');
    if (tabEl) app.activateTab(tabEl.dataset.tabId);
  });

  /* --------------------------------------------- 双击空白处新建文件
     标签栏是 flex 一行铺满的，标签之外的区域（含右侧 padding）事件的 target
     就是 root 本身。单击空白处本来没有任何行为，两次点击之间不会重建 DOM，
     因此可以直接用原生 dblclick。

     两个必须排除的情况：
       1) 落在标签 / 关闭按钮 / 左右滑动按钮 / 「+」按钮上 —— 那不是「空白处」；
       2) 双击关闭按钮 —— 第一次 click 会移除标签并重绘，第二次 click 可能
          落到刚露出的空白上，dblclick 的 target 会变成两者的共同祖先 root，
          不挡住就会在关掉一个标签之后凭空多开一个新文件。 */
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-tab-id], [data-close], .tabnav, [data-newfile]')) return;
    if (Date.now() - lastCloseClickAt < 500) return;
    e.preventDefault();
    runCommand('file.new', app);
  });

  root.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tabEl = e.target.closest('[data-tab-id]');
    if (!tabEl) return;
    e.preventDefault();
    app.closeTab(tabEl.dataset.tabId);
  });

  root.addEventListener('contextmenu', (e) => {
    const tabEl = e.target.closest('[data-tab-id]');
    if (!tabEl) {
      // 标签栏空白处：文件级操作菜单
      e.preventDefault();
      openContextMenu(e, [
        { label: '新建文件', keys: [['Ctrl', 'N']], run: () => runCommand('file.new', app) },
        { label: '打开文件…', keys: [['Ctrl', 'O']], run: () => runCommand('file.open', app) },
        { label: '打开文件夹…', run: () => runCommand('file.openFolder', app) },
        { separator: true },
        { label: '保存全部', run: () => app.saveAll() },
        { separator: true },
        { label: '关闭全部', disabled: state.tabs.length === 0, run: () => app.closeAllTabs() },
        { label: '重新加载', disabled: !state.activeTabId, run: () => runCommand('file.reload', app) },
        { separator: true },
        { label: '命令面板…', run: () => runCommand('view.commandPalette', app) },
      ]);
      return;
    }
    e.preventDefault();
    const id = tabEl.dataset.tabId;
    const tab = getTab(id);
    if (!tab) return;
    const fsPath = typeof app.tabFsPath === 'function' ? app.tabFsPath(tab) : '';
    openContextMenu(e, [
      { label: '保存', run: () => runCommand('file.save', app) },
      { label: '另存为…', run: () => runCommand('file.saveAs', app) },
      { separator: true },
      { label: '关闭', run: () => app.closeTab(id) },
      { label: '关闭其他', run: () => app.closeOtherTabs(id) },
      { label: '关闭全部', run: () => app.closeAllTabs() },
      { separator: true },
      {
        label: '复制完整路径',
        run: () => app.copyTabPath(id),
      },
      {
        label: '复制文件名',
        run: () => navigator.clipboard.writeText(tab.name),
      },
      {
        label: '打开所在位置',
        // 只有「从未落盘」的新文档才置灰。用旧版 FSA 保存出来的标签虽然拿不到
        // 目录（句柄只有 name），但文件确实在磁盘上，点进去给的是可操作的提示，
        // 而不是让用户面对一个灰掉的菜单项无从下手。
        disabled: !fsPath && !tab.handleKey,
        run: () => app.revealTabInFolder(tab),
      },
      { label: '在文件树中定位', run: () => app.revealInTree(tab) },
      { separator: true },
      { label: '重新加载', run: () => runCommand('file.reload', app) },
    ]);
  });

  /* ------------------------------------------------------------ 拖拽排序 */
  root.addEventListener('dragstart', (e) => {
    const tabEl = e.target.closest('[data-tab-id]');
    if (!tabEl) return;
    dragId = tabEl.dataset.tabId;
    tabEl.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    }
  });

  root.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const tabEl = e.target.closest('[data-tab-id]');
    if (!tabEl) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = tabEl.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    if (dropId !== tabEl.dataset.tabId || dropAfter !== after) {
      clearIndicators();
      const draggingEl = root.querySelector('.tab.is-dragging');
      if (draggingEl) draggingEl.classList.add('is-dragging');
      dropId = tabEl.dataset.tabId;
      dropAfter = after;
      tabEl.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    }
  });

  root.addEventListener('drop', (e) => {
    if (!dragId || !dropId) return;
    e.preventDefault();
    if (dragId !== dropId) app.moveTab(dragId, dropId, dropAfter);
    dragId = null;
    dropId = null;
    clearIndicators();
  });

  root.addEventListener('dragend', () => {
    dragId = null;
    dropId = null;
    clearIndicators();
  });

  return { render };
}
