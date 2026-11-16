/**
 * QuillPad · 侧边栏
 * 「文件」目录树 + 「大纲」符号列表，宽度可拖动（180 - 420）。
 */

import { state, activeTab } from '../core/state.js';
import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { readDirectory } from '../core/fs.js';
import { extractSymbols } from '../core/outline.js';
import { SIDEBAR_MIN, SIDEBAR_MAX, clamp } from '../core/settings.js';
import { t } from '../core/i18n.js';

/**
 * 初始化侧边栏。
 * @param {HTMLElement} root
 * @param {HTMLElement} resizer
 * @param {object} app
 */
/** 侧边栏初始化。 */
export function initSidebar(root, resizer, app) {
  /** @type {FileSystemDirectoryHandle|null} */
  let dirHandle = null;
  /** 大纲 DOM 实际重建次数（T09 ② 验收） */
  let outlineRenderTotal = 0;
  /** @type {Map<string, Array<{name: string, kind: string, handle: FileSystemHandle}>>} */
  const cache = new Map();
  /** @type {Set<string>} 已展开的目录路径 */
  const expanded = new Set();
  /** @type {string|null} 当前高亮的文件路径 */
  let activePath = null;

  /* ---------------------------------------------------------------- 渲染 */

  /** 渲染侧栏骨架 + 内容。 */
  function render() {
    const tab = state.sidebarTab;
    root.innerHTML =
      `<div class="sidebar__tabs">` +
      `<button class="sidebar__tab ${tab === 'files' ? 'is-active' : ''}" data-side-tab="files">${t('文件', 'Files')}</button>` +
      `<button class="sidebar__tab ${tab === 'outline' ? 'is-active' : ''}" data-side-tab="outline">${t('大纲', 'Outline')}</button>` +
      // 顶部右侧关闭按钮：隐藏整个侧边栏（含拖拽条），与 view.toggleSidebar 状态互通
      `<button class="mini-btn sidebar__close" data-side-act="close-sidebar" ` +
      `data-tip="${t('关闭侧边栏', 'Close Sidebar')}" aria-label="${t('关闭侧边栏', 'Close Sidebar')}">${icon('close', 13)}</button>` +
      `</div>` +
      `<div class="sidebar__body" id="sidebar-body"></div>` +
      `<div class="sidebar__foot">` +
      `<span class="sidebar__foot-title">${escapeHtml(dirHandle ? dirHandle.name : t('未打开文件夹', 'No Folder Open'))}</span>` +
      `<button class="mini-btn" data-side-act="refresh" data-tip="${t('刷新', 'Refresh')}">${icon('refresh', 13)}</button>` +
      `<button class="mini-btn" data-side-act="close-folder" data-tip="${t('关闭文件夹', 'Close Folder')}">${icon('close', 13)}</button>` +
      `</div>`;

    renderBody();
  }

  /** 渲染侧栏内容区。 */
  function renderBody() {
    const body = root.querySelector('#sidebar-body');
    if (!body) return;
    body.innerHTML = state.sidebarTab === 'files' ? renderFiles() : renderOutline();
    if (state.sidebarTab === 'files' && dirHandle && !cache.has('')) {
      loadDir('', dirHandle).then(() => renderBody());
    }
  }

  /**
   * 文件树 HTML。
   * @return {string}
   */
  function renderFiles() {
    if (!dirHandle) {
      const pending = state.folder && state.folder.name;
      if (pending) {
        return (
          `<div class="tree-empty">${t('上次打开的文件夹', 'Last opened folder')}<br/><strong style="color:var(--text)">${escapeHtml(
            pending,
          )}</strong><br/>` +
          `<button class="btn is-primary" style="margin-top:10px" data-side-act="restore-folder">${t('恢复访问', 'Restore Access')}</button>` +
          `<button class="btn is-ghost" style="margin-top:6px" data-side-act="open-folder">${t('打开其它', 'Open Another')}</button>` +
          `</div>`
        );
      }
      return (
        `<div class="tree-empty">${t('还没有打开文件夹', 'No folder is open yet.')}<br/>` +
        `<button class="btn is-ghost" style="margin-top:10px" data-side-act="open-folder">${t('打开文件夹', 'Open Folder')}</button>` +
        `</div>`
      );
    }
    const entries = cache.get('') || [];
    if (!entries.length) return `<div class="tree-empty">${t('这个文件夹是空的', 'This folder is empty')}</div>`;
    return entries.map((entry) => renderNode(entry, '', 0)).join('');
  }

  /**
   * 递归渲染一个节点。
   * @param {{name: string, kind: string, handle: FileSystemHandle}} entry
   * @param {string} parentPath
   * @param {number} depth
   * @return {string}
   */
  function renderNode(entry, parentPath, depth) {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    const isDir = entry.kind === 'directory';
    const isOpen = expanded.has(path);
    const pad = 8 + depth * 12;
    if (isDir) {
      const children = cache.get(path);
      const childHtml =
        isOpen && children
          ? children.map((c) => renderNode(c, path, depth + 1)).join('')
          : '';
      const loadingHtml =
        isOpen && !children
          ? `<div class="tree-empty" style="padding:4px 0 4px ${pad + 16}px;text-align:left">${t('加载中…', 'Loading…')}</div>`
          : '';
      return (
        `<div class="tree-node" data-dir="${escapeHtml(path)}" style="padding-left:${pad}px">` +
        `<span class="tree-node__caret ${isOpen ? 'is-open' : ''}">${icon('chevronRight', 11)}</span>` +
        `<span class="tree-node__icon">${icon(isOpen ? 'folderOpen' : 'folder', 13)}</span>` +
        `<span class="tree-node__label">${escapeHtml(entry.name)}</span>` +
        `</div>` +
        loadingHtml +
        childHtml
      );
    }
    const cls = path === activePath ? 'is-active' : '';
    return (
      `<div class="tree-node ${cls}" data-file="${escapeHtml(path)}" style="padding-left:${pad}px" ` +
      `title="${escapeHtml(path)}">` +
      `<span class="tree-node__caret"></span>` +
      `<span class="tree-node__icon">${icon('file', 13)}</span>` +
      `<span class="tree-node__label">${escapeHtml(entry.name)}</span>` +
      `</div>`
    );
  }

  /**
   * 大纲 HTML。
   *
   * T09 ①：每一项带 `data-outline-line` 与 `aria-current`，由
   * `syncActiveHeading()` 在光标移动时切换，**不重建 DOM**（防抖 + 原地改属性）。
   *
   * @return {string}
   */
  function renderOutline() {
    outlineRenderTotal += 1;
    const tab = activeTab();
    if (!tab) return `<div class="tree-empty">${t('打开一个文件后，这里会显示它的结构', 'Open a file to see its structure here.')}</div>`;
    const symbols = extractSymbols(tab.content, tab.language);
    if (!symbols.length) return `<div class="tree-empty">${t('未能从当前文件中提取到符号', 'No symbols could be extracted from the current file.')}</div>`;
    return symbols
      .map(
        (s) =>
          `<div class="outline-item" data-line="${s.line}" data-outline-line="${s.line}" ` +
          `aria-current="false" title="${escapeHtml(s.name)}">` +
          `<span class="outline-item__kind">${escapeHtml(kindLabel(s.kind))}</span>` +
          `<span class="outline-item__label">${escapeHtml(s.name)}</span>` +
          `</div>`,
      )
      .join('');
  }

  /* --------------------------------------------------- 大纲联动（T09 ①②） */

  /** 上一次高亮的大纲行号（避免无谓的 DOM 写入）。 */
  let activeOutlineLine = -1;
  /** 300ms 防抖句柄。 */
  let outlineTimer = 0;

  /**
   * 按光标行高亮最近的一个大纲项（原地改属性，不重建 DOM）。
   *
   * @param {number} line 当前光标行（1 基）
   */
  function applyActiveHeading(line) {
    if (state.sidebarTab !== 'outline') return;
    const body = root.querySelector('#sidebar-body');
    if (!body) return;
    /** @type {HTMLElement|null} */
    let hit = null;
    for (const item of body.querySelectorAll('[data-outline-line]')) {
      const n = Number(item.dataset.outlineLine) || 0;
      if (n <= line) hit = item;
      else break;
    }
    if (!hit) {
      body.querySelectorAll('[data-outline-line][aria-current="true"]').forEach((el) => {
        el.setAttribute('aria-current', 'false');
      });
      activeOutlineLine = -1;
      return;
    }
    const n = Number(hit.dataset.outlineLine) || 0;
    if (n === activeOutlineLine) return;
    body.querySelectorAll('[data-outline-line][aria-current="true"]').forEach((el) => {
      el.setAttribute('aria-current', 'false');
    });
    hit.setAttribute('aria-current', 'true');
    activeOutlineLine = n;
  }

  /**
   * 光标移动 → 高亮大纲项（立即，代价极低）。
   * @param {number} line
   */
  function syncActiveHeading(line) {
    if (state.sidebarTab !== 'outline') return;
    if (!root.querySelector('#sidebar-body')) return;
    applyActiveHeading(Number(line) || 1);
  }

  /**
   * 内容变化 → 300ms 后重建大纲（T09 ②：连续输入 5 次只重绘 1 次）。
   */
  function scheduleOutlineSync() {
    if (outlineTimer) window.clearTimeout(outlineTimer);
    outlineTimer = window.setTimeout(() => {
      outlineTimer = 0;
      if (state.sidebarTab !== 'outline') return;
      activeOutlineLine = -1;
      renderBody();
      const cursorLine = app.lastCursor ? app.lastCursor.line : 1;
      applyActiveHeading(cursorLine);
    }, 300);
  }

  /** 取消挂起的的重绘（切走 / 关闭时调用）。 */
  function cancelOutlineSync() {
    if (outlineTimer) {
      window.clearTimeout(outlineTimer);
      outlineTimer = 0;
    }
  }

  /**
   * 符号类型中文标签。
   * @param {string} kind
   * @return {string}
   */
  function kindLabel(kind) {
    switch (kind) {
      case 'function':
        return 'func';
      case 'class':
        return 'type';
      case 'variable':
        return 'var';
      case 'heading':
        return 'h';
      case 'method':
        return 'meth';
      default:
        return 'sym';
    }
  }

  /* -------------------------------------------------------------- 目录读取 */

  /**
   * 读取并缓存一个目录。
   * @param {string} path
   * @param {FileSystemDirectoryHandle} handle
   * @return {Promise<void>}
   */
  async function loadDir(path, handle) {
    if (cache.has(path)) return;
    const entries = await readDirectory(handle);
    cache.set(path, entries);
  }

  /**
   * 打开一个文件夹。
   * @param {FileSystemDirectoryHandle} handle
   */
  async function setFolder(handle) {
    dirHandle = handle;
    cache.clear();
    expanded.clear();
    activePath = null;
    await loadDir('', handle);
    render();
  }

  /** 关闭文件夹。 */
  function clearFolder() {
    dirHandle = null;
    cache.clear();
    expanded.clear();
    activePath = null;
    render();
  }

  /** 刷新目录树（保留展开状态）。 */
  async function refresh() {
    if (!dirHandle) {
      app.toast(t('还没有打开文件夹', 'No folder is open yet.'), 'info');
      return;
    }
    const keepExpanded = new Set(expanded);
    cache.clear();
    await loadDir('', dirHandle);
    // 重新加载已展开的目录
    for (const path of keepExpanded) {
      const handle = await resolveDirHandle(path);
      if (handle) {
        try {
          await loadDir(path, handle);
        } catch {
          expanded.delete(path);
        }
      } else {
        expanded.delete(path);
      }
    }
    render();
  }

  /**
   * 按路径找到目录句柄。
   * @param {string} path
   * @return {Promise<FileSystemDirectoryHandle|null>}
   */
  async function resolveDirHandle(path) {
    if (!dirHandle) return null;
    if (!path) return dirHandle;
    const parts = path.split('/').filter(Boolean);
    let cur = dirHandle;
    for (const part of parts) {
      try {
        cur = await cur.getDirectoryHandle(part);
      } catch {
        return null;
      }
    }
    return cur;
  }

  /**
   * 按路径找到文件句柄。
   * @param {string} path
   * @return {Promise<FileSystemFileHandle|null>}
   */
  async function resolveFileHandle(path) {
    if (!dirHandle) return null;
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parent = await resolveDirHandle(parts.join('/'));
    if (!parent || !fileName) return null;
    try {
      return await parent.getFileHandle(fileName);
    } catch {
      return null;
    }
  }

  /**
   * 展开某个路径的所有父级目录（用于「在文件树中定位」）。
   * @param {string} path
   * @return {Promise<boolean>}
   */
  async function revealPath(path) {
    if (!dirHandle || !path) return false;
    const parts = path.split('/').filter(Boolean);
    parts.pop(); // 去掉文件名
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      expanded.add(acc);
      const handle = await resolveDirHandle(acc);
      if (handle) await loadDir(acc, handle);
    }
    activePath = path;
    state.sidebarTab = 'files';
    render();
    // 滚动到可见
    requestAnimationFrame(() => {
      const el = root.querySelector('.tree-node.is-active');
      if (el) el.scrollIntoView({ block: 'center' });
    });
    return true;
  }

  /* ------------------------------------------------------------------ 事件 */

  root.addEventListener('click', async (e) => {
    const tabBtn = e.target.closest('[data-side-tab]');
    if (tabBtn) {
      state.sidebarTab = tabBtn.dataset.sideTab;
      app.persistSettings();
      render();
      return;
    }

    const actBtn = e.target.closest('[data-side-act]');
    if (actBtn) {
      const act = actBtn.dataset.sideAct;
      if (act === 'refresh') await refresh();
      else if (act === 'close-sidebar') app.setSidebarVisible(false);
      else if (act === 'close-folder') app.closeFolder();
      else if (act === 'open-folder') app.openFolder();
      else if (act === 'restore-folder') app.restoreFolder();
      return;
    }

    const dirNode = e.target.closest('[data-dir]');
    if (dirNode) {
      const path = dirNode.dataset.dir;
      if (expanded.has(path)) {
        expanded.delete(path);
        renderBody();
        return;
      }
      expanded.add(path);
      renderBody();
      const handle = await resolveDirHandle(path);
      if (handle) {
        await loadDir(path, handle);
        renderBody();
      }
      return;
    }

    const fileNode = e.target.closest('[data-file]');
    if (fileNode) {
      const path = fileNode.dataset.file;
      activePath = path;
      const handle = await resolveFileHandle(path);
      if (handle) {
        await app.openFromHandle(handle, `${dirHandle.name}/${path}`);
        renderBody();
      } else {
        app.toast(t('无法读取该文件', 'This file could not be read.'), 'error');
      }
      return;
    }

    const outlineItem = e.target.closest('[data-line]');
    if (outlineItem) {
      app.editor.gotoLine(Number(outlineItem.dataset.line));
    }
  });

  /* -------------------------------------------------------------- 宽度拖动 */

  let dragging = false;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const left = root.getBoundingClientRect().left;
    const width = clamp(e.clientX - left, SIDEBAR_MIN, SIDEBAR_MAX);
    state.sidebarWidth = width;
    root.style.width = `${width}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    app.persistSettings();
  });

  resizer.addEventListener('dblclick', () => {
    state.sidebarWidth = 248;
    root.style.width = '248px';
    app.persistSettings();
  });

  /* ------------------------------------------------------------------ 导出 */

  render();

  return {
    render,
    renderBody,
    setFolder,
    clearFolder,
    refresh,
    revealPath,
    resolveFileHandle,
    syncActiveHeading,
    scheduleOutlineSync,
    cancelOutlineSync,
    /** 大纲重绘次数（`scripts/v2-check.mjs` T09 ② 断言用） */
    get outlineRenderCount() {
      return outlineRenderTotal;
    },
    /** 当前文件夹句柄 */
    get handle() {
      return dirHandle;
    },
    /** 当前高亮的文件路径 */
    setActivePath(path) {
      activePath = path;
      renderBody();
    },
    /** 遍历目录下所有文本文件（用于「在文件中查找」） */
    async walkFiles(maxFiles = 800, maxDepth = 6) {
      /** @type {Array<{path: string, handle: FileSystemFileHandle}>} */
      const out = [];
      if (!dirHandle) return out;
      /**
       * @param {FileSystemDirectoryHandle} dir
       * @param {string} prefix
       * @param {number} depth
       */
      const walk = async (dir, prefix, depth) => {
        if (depth > maxDepth || out.length >= maxFiles) return;
        let entries = [];
        try {
          entries = await readDirectory(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (out.length >= maxFiles) return;
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.kind === 'file') {
            if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|exe|dll|so|dylib|mp4|mp3|woff2?|ttf|otf)$/i.test(entry.name)) {
              continue;
            }
            out.push({ path, handle: /** @type {FileSystemFileHandle} */ (entry.handle) });
          } else {
            await walk(/** @type {FileSystemDirectoryHandle} */ (entry.handle), path, depth + 1);
          }
        }
      };
      await walk(dirHandle, '', 0);
      return out;
    },
  };
}
