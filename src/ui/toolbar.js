/**
 * QuillPad · 工具栏 & 标题栏按钮组
 *
 * 所有按钮都是命令注册表的入口，tooltip 自动带上快捷键。
 *
 * 布局约定：
 * - 左侧是高频的文件 / 编辑 / 搜索 / 视图动作；
 * - 右侧是「当前文档信息 + 两个开关型视图命令」，
 *   让顶栏左右都有内容，避免右侧上千像素的空白。
 */

import { icon } from './icons.js';
import {
  getCommand,
  runCommand,
  commandShortcutText,
  isCommandAvailable,
} from '../core/commands.js';
import { openDropdown, openContextMenu } from './dropdown.js';
import { languageMenuList, languageLabel, isMarkdown } from '../editor/languages.js';
import { activeTab } from '../core/state.js';
import { t, getLocale, LOCALE_ZH, LOCALE_EN, LOCALE_LABELS } from '../core/i18n.js';

/** 工具栏左侧定义：'|' 为分组分隔线。 */
const TOOLBAR_SPEC = [
  ['file.new', 'newFile'],
  ['file.open', 'openFile'],
  ['file.openFolder', 'openFolder'],
  ['file.save', 'save'],
  ['file.saveAll', 'saveAll'],
  '|',
  ['edit.undo', 'undo'],
  ['edit.redo', 'redo'],
  '|',
  ['search.find', 'search'],
  ['search.replace', 'replace'],
  ['search.findInFiles', 'findInFiles'],
  '|',
  ['view.fontDecrease', 'zoomOut'],
  ['view.fontIncrease', 'zoomIn'],
  '|',
  ['view.wordWrap', 'wrap'],
  ['view.toggleSidebar', 'sidebar'],
  '|',
  // v2：自动保存与宏录制（高频入口，放最右一组）
  ['view.autoSave', 'autoSave'],
  ['macro.record', 'command'],
];

/** 工具栏右侧的开关型命令（与左侧按钮共用同一套命令注册表）。 */
const TOOLBAR_RIGHT_SPEC = [
  ['view.preview', 'preview'],
  ['pdf.export', 'fileText'],
];

/**
 * Markdown 专用格式按钮组。
 *
 * 只在当前文档是 Markdown 时显示；包在 `.qp-md-tools` 里作为
 * `#toolbar` 的直接子元素，避免打乱既有「左侧 .tool-btn 直接子元素」
 * 的顺序 / 间距断言（既有视觉回归脚本按「左侧 .tool-btn」逐个量间距）。
 */
const MD_TOOLBAR_SPEC = [
  ['md.bold', 'bold'],
  ['md.italic', 'italic'],
  ['md.strike', 'strike'],
  ['md.h2', 'heading'],
  ['md.quote', 'quote'],
  ['md.inlineCode', 'codeInline'],
  ['md.link', 'link'],
  ['markdown.insertImage', 'image'],
  ['md.table', 'table'],
  ['md.ul', 'list'],
  ['md.ol', 'listOrdered'],
  ['md.task', 'listChecks'],
  ['md.hr', 'minus'],
];

/** 标题栏右侧按钮。 */
const TITLE_ACTIONS = [
  ['view.commandPalette', 'command'],
  ['view.themeMenu', 'theme'],
  ['view.zen', 'zen'],
  ['help.shortcuts', 'help'],
];

/**
 * 初始化工具栏。
 * @param {HTMLElement} toolbarRoot
 * @param {HTMLElement} titleActionsRoot
 * @param {object} app
 * @return {{update: () => void}}
 */
export function initToolbar(toolbarRoot, titleActionsRoot, app) {
  /**
   * 按钮的悬停提示：`标题 · 快捷键`。
   * @param {string} id 命令 id
   * @return {{title: string, tip: string}}
   */
  const tipFor = (id) => {
    const cmd = getCommand(id);
    const title = cmd ? cmd.title : id;
    const shortcut = commandShortcutText(cmd);
    return { title, tip: shortcut ? `${title} · ${shortcut}` : title };
  };

  /** 生成按钮 HTML。 */
  const buttonHtml = (id, glyph, extraClass) => {
    const { title, tip } = tipFor(id);
    return (
      `<button class="${extraClass}" data-cmd="${id}" data-tip="${tip}" aria-label="${title}">` +
      `${icon(glyph, 16)}</button>`
    );
  };

  const leftHtml = TOOLBAR_SPEC.map((entry) => {
    if (entry === '|') return '<span class="toolbar-sep"></span>';
    return buttonHtml(entry[0], entry[1], 'tool-btn');
  }).join('');

  const rightHtml =
    // v2：三态视图模式分段控件（主入口）。注意它**不是** `.tool-btn`，
    // 以免改变既有「左侧 .tool-btn 顺序 / 首个按钮位置」的断言（p1-check.mjs）。
    `<span class="qp-viewswitch-host" id="toolbar-viewswitch" data-role="viewswitch-host"></span>` +
    TOOLBAR_RIGHT_SPEC.map((entry) => buttonHtml(entry[0], entry[1], 'tool-btn')).join('') +
    // 只读信息芯片：显示当前文件的语法与编码，点击可切换语法
    `<button class="tool-chip" data-role="doc-chip" data-tip="${t('点击切换语法', 'Click to change syntax')}" ` +
    `aria-label="${t('当前文件语言与编码', 'Current file language and encoding')}">` +
    `<span data-role="chip-text">${t('纯文本', 'Plain Text')} · UTF-8</span></button>`;

  // Markdown 格式按钮组：作为 #toolbar 的直接子元素，插在左侧按钮与 .toolbar__right 之间。
  // 组内按钮不是 #toolbar 的直接子元素，故不影响左侧 .tool-btn 的顺序 / 间距断言。
  const mdHtml =
    `<span class="qp-md-tools" data-role="md-tools" hidden>` +
    '<span class="toolbar-sep"></span>' +
    MD_TOOLBAR_SPEC.map((entry) => buttonHtml(entry[0], entry[1], 'tool-btn')).join('') +
    '</span>';

  toolbarRoot.innerHTML = leftHtml + mdHtml + `<div class="toolbar__right">${rightHtml}</div>`;

  titleActionsRoot.innerHTML =
    TITLE_ACTIONS.map((entry) => buttonHtml(entry[0], entry[1], 'tool-btn')).join('') +
    // 「切换界面语言」按钮：不是单一命令入口（下拉两项分别对应
    // app.locale.zh / app.locale.en），与 doc-chip 同样在 onClick 里拦截弹出。
    `<button class="tool-btn" data-role="locale-btn" ` +
    `data-tip="${t('界面语言', 'Language')}" aria-label="${t('界面语言', 'Language')}">` +
    `${icon('globe', 16)}</button>`;

  /** 点击交给命令系统。 */
  const onClick = (e) => {
    const chip = e.target.closest('[data-role="doc-chip"]');
    if (chip) {
      openLanguageMenu(chip);
      return;
    }
    const localeBtn = e.target.closest('[data-role="locale-btn"]');
    if (localeBtn) {
      openLocaleMenu(localeBtn);
      return;
    }
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    runCommand(btn.dataset.cmd, app);
  };
  toolbarRoot.addEventListener('click', onClick);
  titleActionsRoot.addEventListener('click', onClick);

  /* ------------------------------------------------------- 工具栏右键菜单 */
  toolbarRoot.addEventListener('contextmenu', (e) => {
    // 只在工具栏按钮/空白处右键，不在文档芯片上
    if (e.target.closest('[data-role="doc-chip"]')) return;
    e.preventDefault();
    openContextMenu(e, [
      {
        label: t('自动保存', 'Auto Save'),
        checked: app.state.autoSave,
        run: () => runCommand('view.autoSave', app),
      },
      {
        label: t('Markdown 预览', 'Markdown Preview'),
        checked: app.state.previewVisible,
        // 非 Markdown 文档（含无标签页，currentLanguageId 回落 plaintext）灰化不可用
        disabled: !isMarkdown(app.currentLanguageId()),
        run: () => runCommand('view.preview', app),
      },
      {
        label: t('侧边栏', 'Sidebar'),
        checked: app.state.sidebarVisible,
        run: () => runCommand('view.toggleSidebar', app),
      },
      { separator: true },
      { label: t('缩小字号', 'Decrease Font Size'), run: () => runCommand('view.fontDecrease', app) },
      { label: t('放大字号', 'Increase Font Size'), run: () => runCommand('view.fontIncrease', app) },
      { label: t('重置字号', 'Reset Font Size'), run: () => runCommand('view.fontReset', app) },
      { separator: true },
      { label: t('命令面板…', 'Command Palette…'), run: () => runCommand('view.commandPalette', app) },
      { label: t('快捷键速查', 'Keyboard Shortcuts'), run: () => runCommand('help.shortcuts', app) },
    ]);
  });

  /**
   * 在按钮下方弹出界面语言菜单。菜单项在「打开时」按当前语言求值，
   * 切换语言后重开即见新文案；当前语言打勾。
   * @param {HTMLElement} btn
   */
  function openLocaleMenu(btn) {
    const rect = btn.getBoundingClientRect();
    const current = getLocale();
    openDropdown({
      x: rect.left,
      y: rect.bottom + 4,
      items: [LOCALE_ZH, LOCALE_EN].map((locale) => ({
        label: LOCALE_LABELS[locale],
        checked: current === locale,
        run: () => app.applyLocale(locale),
      })),
      minWidth: 140,
    });
  }

  /**
   * 在芯片下方弹出语法选择菜单。
   * @param {HTMLElement} chip
   */
  function openLanguageMenu(chip) {
    const rect = chip.getBoundingClientRect();
    const current = app.currentLanguageId();
    openDropdown({
      x: rect.left,
      y: rect.bottom + 4,
      items: languageMenuList().map((lang) => ({
        label: lang.label,
        checked: lang.id === current,
        run: () => app.setLanguage(lang.id),
      })),
      minWidth: 190,
    });
  }

  /** 同步按钮的激活态 / 可用态，以及右侧信息芯片的文本。 */
  function update() {
    const toggles = {
      'view.wordWrap': app.state.wordWrap,
      'view.toggleSidebar': app.state.sidebarVisible,
      'view.zen': app.state.zen,
      'view.preview': app.state.previewVisible,
      'view.autoSave': app.state.autoSave,
      'macro.record': !!(app.state.macro && app.state.macro.recording),
    };
    toolbarRoot.querySelectorAll('[data-cmd]').forEach((btn) => {
      const id = btn.dataset.cmd;
      if (id in toggles) btn.classList.toggle('is-active', !!toggles[id]);
      // 与菜单栏 / 命令面板共用同一套可用性判断
      btn.disabled = !isCommandAvailable(id);
      // 提示文字重新取一遍：切换界面语言后命令标题会变，这里顺手刷新
      const { title, tip } = tipFor(id);
      btn.setAttribute('data-tip', tip);
      btn.setAttribute('aria-label', title);
    });
    titleActionsRoot.querySelectorAll('[data-cmd]').forEach((btn) => {
      const id = btn.dataset.cmd;
      if (id in toggles) btn.classList.toggle('is-active', !!toggles[id]);
      btn.disabled = !isCommandAvailable(id);
      const { title, tip } = tipFor(id);
      btn.setAttribute('data-tip', tip);
      btn.setAttribute('aria-label', title);
    });
    // 语言按钮非命令入口，tooltip 随界面语言单独刷新
    const localeBtn = titleActionsRoot.querySelector('[data-role="locale-btn"]');
    if (localeBtn) {
      const label = t('界面语言', 'Language');
      localeBtn.setAttribute('data-tip', label);
      localeBtn.setAttribute('aria-label', label);
    }

    // 右侧芯片：当前文件的语法与编码
    const tab = activeTab();
    const chipText = toolbarRoot.querySelector('[data-role="chip-text"]');
    const label = tab ? languageLabel(tab.language) : t('纯文本', 'Plain Text');
    const encoding = tab ? tab.encoding : 'UTF-8';
    if (chipText) chipText.textContent = `${label} · ${encoding}`;
    const chip = toolbarRoot.querySelector('[data-role="doc-chip"]');
    if (chip) {
      chip.setAttribute(
        'aria-label',
        t(
          `当前文件：${label}，编码 ${encoding}，点击切换语法`,
          `Current file: ${label}, encoding ${encoding}. Click to change syntax`,
        ),
      );
      chip.setAttribute(
        'data-tip',
        t(
          `当前文件：${label} · ${encoding}（点击切换语法）`,
          `Current file: ${label} · ${encoding} (click to change syntax)`,
        ),
      );
    }
    // 视图模式分段控件（v2）：存在即同步（初始化晚于本函数首次调用）
    if (app.viewSwitch) app.viewSwitch.update();

    // Markdown 格式按钮组：仅当当前文档为 Markdown 时显示。
    // currentLanguageId 在 app 装配较晚才赋值，首次 update 需判空守卫。
    const mdTools = toolbarRoot.querySelector('[data-role="md-tools"]');
    if (mdTools) {
      const isMd =
        typeof app.currentLanguageId === 'function' && isMarkdown(app.currentLanguageId());
      mdTools.hidden = !isMd;
    }
  }

  update();
  return { update };
}
