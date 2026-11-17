/**
 * QuillPad · 菜单栏
 * 完全自绘的下拉菜单，菜单项全部来自命令注册表。
 *
 * v3 扩展：
 *   - 编辑 / 语言菜单重组为二级子菜单（分组减少一级下拉长度）
 *   - 新增「插件」顶级菜单（位于「主题」与「帮助」之间，按用户要求的入口位置）
 *   - 菜单栏右键上下文菜单（插件管理器 / 命令面板 / 快捷键 / 关于）
 *   - 菜单适配窗口：窄窗口下溢出项折叠进「⋯」溢出菜单；下拉超高自动滚动
 *
 * i18n：菜单布局是**函数**而不是模块级常量 —— 顶层 `t()` 会在 import 期被
 * 冻结成当时的语言，切换语言后不再更新。改成 `menuLayout()` 后，每次打开菜单
 * 与重新渲染顶级按钮都读当前语言。
 */

import { openDropdown, openContextMenu, isInsideFloatingMenu } from './dropdown.js';
import {
  getCommand,
  runCommand,
  commandShortcutLabels,
  isCommandAvailable,
} from '../core/commands.js';
import { languageGroups } from '../editor/languages.js';
import { THEMES } from '../editor/cm-themes.js';
import { allCommands } from '../core/commands.js';
import { openPluginManager } from './plugin-manager.js';
import { t } from '../core/i18n.js';

/**
 * 菜单结构约定：
 *   - 字符串：命令 id
 *   - '-'：分隔线
 *   - '@languages' / '@themes' / '@plugins'：动态子菜单
 *   - { sub, items }：静态二级子菜单
 *
 * 注意：必须是函数。写成模块级常量的话，`t()` 会在 import 期求值一次，
 * 之后切换界面语言时菜单标签永远不会变。
 *
 * @return {Array<{label: string, items: Array<string|object>}>}
 */
function menuLayout() {
  return [
    {
      label: t('文件', 'File'),
      items: [
        'file.new',
        'file.open',
        'file.openFolder',
        '-',
        'file.save',
        'file.saveAs',
        'file.saveAll',
        '-',
        'file.reload',
        '-',
        'file.close',
        'file.closeOthers',
        'file.closeAll',
        '-',
        'file.copyPath',
        '-',
        // 默认打开方式：安装时勾过一次，事后要改就从这里进
        'file.associations',
        '-',
        'pdf.export',
        'pdf.print',
        '-',
        'file.refreshFolder',
        'file.closeFolder',
      ],
    },
    {
      label: t('编辑', 'Edit'),
      items: [
        'edit.undo',
        'edit.redo',
        '-',
        'edit.cut',
        'edit.copy',
        'edit.paste',
        '-',
        'edit.selectAll',
        '-',
        // 二级子菜单：行操作
        {
          sub: t('行操作', 'Lines'),
          items: [
            'edit.duplicateLine',
            'edit.deleteLine',
            'edit.moveLineUp',
            'edit.moveLineDown',
            '-',
            'edit.trimTrailing',
          ],
        },
        // 二级子菜单：大小写
        {
          sub: t('大小写', 'Case'),
          items: ['edit.upperCase', 'edit.lowerCase', 'edit.titleCase'],
        },
        // 二级子菜单：排序与去重
        {
          sub: t('排序与去重', 'Sort & Dedupe'),
          items: ['edit.sortAsc', 'edit.sortDesc', 'edit.dedupLines'],
        },
        // 二级子菜单：缩进
        {
          sub: t('缩进', 'Indent'),
          items: ['edit.convertIndentSpaces', 'edit.convertIndentTabs'],
        },
        // 二级子菜单：列编辑
        {
          sub: t('列编辑', 'Column Editing'),
          items: [
            'edit.columnInsert',
            'edit.columnDelete',
            'edit.columnAlign',
            'edit.columnNumber',
          ],
        },
        '-',
        'edit.toggleComment',
        'edit.jumpToBracket',
        '-',
        'edit.multiCursorUp',
        'edit.multiCursorDown',
        '-',
        // 二级子菜单：宏
        {
          sub: t('宏', 'Macro'),
          items: ['macro.record', 'macro.play', 'macro.manage'],
        },
        // 二级子菜单：插入
        {
          sub: t('插入', 'Insert'),
          items: [
            'insert.char',
            '-',
            'insert.math',
            'insert.footnote',
            'insert.toc',
            'markdown.insertImage',
          ],
        },
        // 二级子菜单：表格
        {
          sub: t('表格', 'Table'),
          items: [
            'markdown.table.rowAbove',
            'markdown.table.rowBelow',
            'markdown.table.rowDelete',
            '-',
            'markdown.table.colLeft',
            'markdown.table.colRight',
            'markdown.table.colDelete',
            '-',
            'markdown.table.cycleAlign',
          ],
        },
      ],
    },
    {
      label: t('搜索', 'Search'),
      items: [
        'search.find',
        'search.replace',
        'search.findNext',
        'search.findPrev',
        '-',
        'search.gotoLine',
        'search.findInFiles',
      ],
    },
    {
      label: t('视图', 'View'),
      items: [
        'view.toggleSidebar',
        'view.wordWrap',
        '-',
        'view.fontIncrease',
        'view.fontDecrease',
        'view.fontReset',
        '-',
        'view.preview',
        '-',
        'view.modeSource',
        'view.modeWysiwyg',
        'view.modeSplit',
        '-',
        'view.zen',
        'view.focusMode',
        'view.typewriter',
        'view.minimap',
        'view.reduceMotion',
        '-',
        'view.autoSave',
        '-',
        'view.commandPalette',
      ],
    },
    // 语言：改为按领域分组的二级子菜单（@languageGroups）
    { label: t('语言', 'Language'), items: ['@languageGroups'] },
    { label: t('主题', 'Theme'), items: ['@themes'] },
    // 插件：按用户要求位于「主题」与「帮助」之间
    // 「打开插件市场」入口已移除——与「插件管理器」进同一对话框，冗余
    {
      label: t('插件', 'Plugins'),
      items: [
        'plugins.manager',
        '-',
        '@plugins',
        '-',
        'plugins.installUrl',
        'plugins.importNpp',
      ],
    },
    {
      label: t('帮助', 'Help'),
      items: [
        'help.shortcuts',
        // 界面语言：放在「关于」附近，不打断既有的帮助项顺序
        { sub: t('界面语言', 'Language'), items: ['app.locale.zh', 'app.locale.en'] },
        'help.about',
      ],
    },
  ];
}

/**
 * 把命令 id 转换为菜单项。
 * @param {string} id
 * @param {object} app
 * @return {object}
 */
function commandItem(id, app) {
  const cmd = getCommand(id);
  if (!cmd) {
    return { label: t('未知命令', 'Unknown command') + ` ${id}`, disabled: true, checked: null };
  }
  return {
    label: cmd.title,
    keys: commandShortcutLabels(cmd),
    checked: cmd.toggle ? cmd.toggle() : null,
    // 与工具栏 / 命令面板共用同一个「可用性」判断，避免三处表现不一致
    disabled: !isCommandAvailable(id),
    run: () => runCommand(id, app),
  };
}

/**
 * 语言二级子菜单（按领域分组）。
 * @param {object} app
 * @return {object[]}
 */
function languageGroupItems(app) {
  const current = app.currentLanguageId();
  // 返回 dropdown 的 {label, submenu} 形状（返回 {sub, items} 会被当普通项渲染成空白）
  return languageGroups().map((group) => ({
    label: group.label,
    submenu: group.items.map((lang) => ({
      label: lang.label,
      checked: lang.id === current,
      run: () => app.setLanguage(lang.id),
    })),
  }));
}

/**
 * 主题子菜单。
 * @param {object} app
 * @return {object[]}
 */
function themeItems(app) {
  return THEMES.map((theme) => ({
    label: theme.label,
    checked: app.state.theme === theme.id,
    run: () => app.setTheme(theme.id),
  }));
}

/**
 * 插件命令二级子菜单（按插件分组）。
 *
 * 遍历命令注册表中 `plugin.` 前缀的命令，按插件 id 聚合。
 * @param {object} app
 * @return {object[]}
 */
function pluginCommandItems(app) {
  /** @type {Map<string, object[]>} pluginId -> menu items */
  const byPlugin = new Map();
  for (const cmd of allCommands()) {
    if (!cmd.id.startsWith('plugin.')) continue;
    // plugin.<pluginId>.<cmdId>
    const rest = cmd.id.slice('plugin.'.length);
    const dot = rest.indexOf('.');
    if (dot <= 0) continue;
    const pluginId = rest.slice(0, dot);
    if (!byPlugin.has(pluginId)) byPlugin.set(pluginId, []);
    byPlugin.get(pluginId).push({
      label: cmd.title,
      keys: commandShortcutLabels(cmd),
      checked: cmd.toggle ? cmd.toggle() : null,
      disabled: !isCommandAvailable(cmd.id),
      run: () => runCommand(cmd.id, app),
    });
  }
  if (!byPlugin.size) {
    return [{ label: t('（暂无插件命令）', '(No plugin commands)'), disabled: true, checked: null }];
  }
  // 同 languageGroupItems：必须是 dropdown 的 {label, submenu} 形状
  return [...byPlugin.entries()].map(([pluginId, items]) => ({
    label: pluginId,
    submenu: items,
  }));
}

/**
 * 把菜单定义展开成下拉项。
 * @param {object} menu
 * @param {object} app
 * @return {object[]}
 */
function expandMenu(menu, app) {
  /** @type {object[]} */
  const out = [];
  for (const entry of menu.items) {
    if (entry === '-') {
      out.push({ separator: true });
    } else if (entry === '@languageGroups') {
      out.push(
        { groupTitle: t('切换语法', 'Switch Syntax') },
        ...languageGroupItems(app),
      );
    } else if (entry === '@themes') {
      out.push({ groupTitle: t('选择主题', 'Choose Theme') }, ...themeItems(app));
    } else if (entry === '@plugins') {
      out.push({ groupTitle: t('插件命令', 'Plugin Commands') }, ...pluginCommandItems(app));
    } else if (entry && typeof entry === 'object' && entry.sub) {
      // 二级子菜单：展开 items 中的命令 id
      const subItems = entry.items.map((it) => {
        if (it === '-') return { separator: true };
        return typeof it === 'string' ? commandItem(it, app) : it;
      });
      out.push({
        label: entry.sub,
        submenu: subItems.filter((item, i, arr) => {
          if (!item.separator) return true;
          if (i === 0 || i === arr.length - 1) return false;
          return !arr[i - 1].separator;
        }),
      });
    } else if (typeof entry === 'string') {
      out.push(commandItem(entry, app));
    }
  }
  // 去掉开头 / 结尾 / 连续的分隔线
  return out.filter((item, i, arr) => {
    if (!item.separator) return true;
    if (i === 0 || i === arr.length - 1) return false;
    return !arr[i - 1].separator;
  });
}

/**
 * 初始化菜单栏。
 * @param {HTMLElement} root
 * @param {object} app
 */
export function initMenubar(root, app) {
  /**
   * 重绘顶级菜单按钮。
   *
   * 单独抽成函数是为了让切换界面语言后能刷新标签：菜单项内容每次打开菜单都会
   * 重新算（见 `open()`），但顶级按钮的 innerHTML 只在初始化时写一次。
   * 语言切换的编排（`applyLocale`）只要调用 `app.refreshMenubar()` 即可。
   */
  const renderLabels = () => {
    // 重绘前先收起已展开的下拉：它的条目是打开那一瞬的语言，留着会新旧混杂
    close();
    root.innerHTML =
      menuLayout()
        .map(
          (m, i) =>
            `<button class="menubar__item" data-menu="${i}" role="menuitem">${m.label}</button>`,
        )
        .join('') +
      `<button class="menubar__item menubar__overflow" data-menu-overflow ` +
      `title="${t('更多菜单', 'More menus')}" aria-label="${t('更多菜单', 'More menus')}" hidden>⋯</button>`;
    requestAnimationFrame(fitToWindow);
  };
  // 供 app 的语言切换流程调用（app.js 里已有 refreshChrome 这类统一入口）
  app.refreshMenubar = renderLabels;

  let openIndex = -1;
  /** @type {{close: () => void}|null} */
  let handle = null;

  /** 关闭菜单。 */
  const close = () => {
    openIndex = -1;
    root.querySelectorAll('.menubar__item').forEach((n) => n.classList.remove('is-open'));
    if (handle) {
      const h = handle;
      handle = null;
      h.close();
    }
  };

  /**
   * 打开指定菜单。
   * @param {number} index
   */
  const open = (index) => {
    const btn = root.querySelector(`[data-menu="${index}"]`);
    if (!btn || btn.hidden) return;
    if (handle) {
      const h = handle;
      handle = null;
      h.close();
    }
    openIndex = index;
    root.querySelectorAll('.menubar__item').forEach((n) => {
      n.classList.toggle('is-open', n.dataset.menu === String(index));
    });
    const rect = btn.getBoundingClientRect();
    const items = expandMenu(menuLayout()[index], app);
    handle = openDropdown({
      x: rect.left,
      y: rect.bottom + 2,
      items,
      minWidth: 220,
      onClose: () => {
        if (openIndex === index) {
          openIndex = -1;
          root.querySelectorAll('.menubar__item').forEach((n) => n.classList.remove('is-open'));
        }
      },
    });
  };

  root.addEventListener('click', (e) => {
    const overflowBtn = e.target.closest('[data-menu-overflow]');
    if (overflowBtn && !overflowBtn.hidden) {
      e.preventDefault();
      openOverflowMenu(overflowBtn);
      return;
    }
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    const idx = Number(btn.dataset.menu);
    if (openIndex === idx) close();
    else open(idx);
  });

  root.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn || btn.hidden) return;
    const idx = Number(btn.dataset.menu);
    if (openIndex >= 0 && idx !== openIndex) open(idx);
  });

  // 菜单栏右键上下文菜单
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    close();
    openContextMenu(e, [
      {
        label: t('插件管理器…', 'Plugin Manager…'),
        run: () => openPluginManager(app),
      },
      { separator: true },
      {
        label: t('命令面板', 'Command Palette'),
        keys: [['Ctrl', 'Shift', 'P']],
        run: () => runCommand('view.commandPalette', app),
      },
      { separator: true },
      {
        label: t('快捷键速查', 'Keyboard Shortcuts'),
        run: () => runCommand('help.shortcuts', app),
      },
      {
        label: t('关于 QuillPad', 'About QuillPad'),
        run: () => runCommand('help.about', app),
      },
    ]);
  });

  /**
   * 打开溢出菜单（窄窗口折叠的顶级菜单）。
   * @param {HTMLElement} anchor
   */
  const openOverflowMenu = (anchor) => {
    if (handle) {
      const h = handle;
      handle = null;
      h.close();
    }
    const hidden = [...root.querySelectorAll('.menubar__item[data-menu]')]
      .filter((n) => n.hidden)
      .map((n) => Number(n.dataset.menu));
    if (!hidden.length) return;
    const rect = anchor.getBoundingClientRect();
    const layout = menuLayout();
    const items = hidden.map((idx) => ({
      sub: layout[idx].label,
      items: expandMenu(layout[idx], app),
    }));
    handle = openDropdown({
      x: rect.left,
      y: rect.bottom + 2,
      items,
      minWidth: 200,
      onClose: () => {
        anchor.classList.remove('is-open');
      },
    });
    anchor.classList.add('is-open');
  };

  // 菜单打开时用左右方向键切换顶层菜单
  document.addEventListener(
    'keydown',
    (e) => {
      if (openIndex < 0) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const visible = [...root.querySelectorAll('.menubar__item[data-menu]')]
        .filter((n) => !n.hidden)
        .map((n) => Number(n.dataset.menu));
      if (!visible.length) return;
      const pos = visible.indexOf(openIndex);
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = visible[(pos + delta + visible.length) % visible.length];
      open(next);
    },
    true,
  );

  // 点击菜单栏空白处关闭。
  // 注意：下拉面板挂在 document.body 上，不在 root 内，
  // 因此必须显式排除 .dropdown / .context-menu，
  // 否则 mousedown 会抢先关闭下拉，导致随后的 click 落空、菜单项点不动。
  document.addEventListener(
    'mousedown',
    (e) => {
      if (openIndex < 0) return;
      if (root.contains(e.target)) return;
      if (isInsideFloatingMenu(e.target)) return;
      close();
    },
    true,
  );

  /* ---------------------------------------------------------- 菜单适配窗口 */

  /**
   * 窄窗口下把放不下的顶级菜单折叠进「⋯」溢出菜单。
   *
   * 测量策略：先把所有项显示出来量总宽，超出 root 宽度时从右往左隐藏，
   * 保证「文件 / 编辑 / 搜索」等核心菜单优先保留。
   */
  function fitToWindow() {
    const buttons = [...root.querySelectorAll('.menubar__item[data-menu]')];
    const overflowBtn = root.querySelector('[data-menu-overflow]');
    if (!buttons.length || !overflowBtn) return;
    // 先全部显示、隐藏溢出按钮，测量自然宽度
    buttons.forEach((b) => { b.hidden = false; });
    overflowBtn.hidden = true;
    const rootW = root.clientWidth;
    let total = overflowBtn.offsetWidth + 8;
    for (const b of buttons) total += b.offsetWidth + 4;
    if (total <= rootW) return; // 放得下，无需折叠
    // 从右往左隐藏，直到放得下（含溢出按钮）
    overflowBtn.hidden = false;
    let used = overflowBtn.offsetWidth + 8;
    for (let i = 0; i < buttons.length; i++) {
      used += buttons[i].offsetWidth + 4;
      if (used > rootW) {
        // 从 i 开始全部隐藏
        for (let j = i; j < buttons.length; j++) buttons[j].hidden = true;
        break;
      }
    }
    // 至少保留前 3 个核心菜单
    const visibleCount = buttons.filter((b) => !b.hidden).length;
    if (visibleCount < 3) {
      buttons.forEach((b, i) => { b.hidden = i >= 3; });
    }
  }

  // 初次布局 + 窗口尺寸变化时重新适配
  renderLabels();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitToWindow, 120);
  });

  // 供 app 的 applyLocale 调用：`app.menubar?.render?.()`
  return { render: renderLabels };
}

export { menuLayout, menuLayout as MENU_LAYOUT };
