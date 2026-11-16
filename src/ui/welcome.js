/**
 * QuillPad · 欢迎页
 * 无标签时展示：品牌标识、三个入口卡片、最近文件、快捷键速查。
 */

import { state } from '../core/state.js';
import { icon, brandSvg } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { getCommand, commandShortcutLabels } from '../core/commands.js';
import { t } from '../core/i18n.js';

/** 欢迎页上展示的快捷键（命令 id）。 */
const HINTS = [
  'file.new',
  'file.open',
  'view.commandPalette',
  'search.find',
  'file.save',
  'search.gotoLine',
  'view.zen',
  'help.shortcuts',
];

/**
 * 初始化欢迎页。
 * @param {HTMLElement} root
 * @param {object} app
 */
export function initWelcome(root, app) {
  /** 渲染欢迎页内容。 */
  function render() {
    const recent = state.recent.slice(0, 6);
    const recentHtml = recent.length
      ? recent
          .map(
            (r) =>
              `<button class="recent-item" data-recent="${escapeHtml(r.path || r.name)}">` +
              `${icon('fileText', 13)}` +
              `<span class="recent-item__name">${escapeHtml(r.name)}</span>` +
              `<span class="recent-item__path">${escapeHtml(r.path || '')}</span>` +
              `</button>`,
          )
          .join('')
      : `<div style="font-size:11.5px;color:var(--text-faint);padding:6px 2px">${t('还没有打开过文件', 'No files opened yet')}</div>`;

    const hintsHtml = HINTS.map((id) => {
      const cmd = getCommand(id);
      if (!cmd) return '';
      const keys = commandShortcutLabels(cmd)
        .map((chord) => chord.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(''))
        .join(' ');
      return (
        `<div class="kbd-row"><span>${escapeHtml(cmd.title)}</span>` +
        `<span style="display:flex;gap:3px">${keys}</span></div>`
      );
    }).join('');

    root.innerHTML =
      `<div class="welcome__inner">` +
      `<div class="welcome__glow"></div>` +
      `<div class="welcome__head">` +
      `<div class="welcome__logo">${brandSvg(32)}</div>` +
      `<h1 class="welcome__title">QuillPad</h1>` +
      `<p class="welcome__sub">${t('一个安静、快速、键盘优先的文本与代码编辑器', 'A quiet, fast, keyboard-first text and code editor.')}</p>` +
      `</div>` +
      `<div class="welcome__cards">` +
      `<button class="welcome-card" data-welcome-act="new">` +
      `<span class="welcome-card__icon">${icon('newFile', 16)}</span>` +
      `<span class="welcome-card__title">${t('新建文件', 'New File')}</span>` +
      `<span class="welcome-card__desc">${t('从一张白纸开始，立刻写下第一行', 'Start from a blank page and write the first line right away.')}</span>` +
      `</button>` +
      `<button class="welcome-card" data-welcome-act="open">` +
      `<span class="welcome-card__icon">${icon('openFile', 16)}</span>` +
      `<span class="welcome-card__title">${t('打开文件', 'Open File')}</span>` +
      `<span class="welcome-card__desc">${t('支持多选，直接落到标签页', 'Select multiple files and open them straight into tabs.')}</span>` +
      `</button>` +
      `<button class="welcome-card" data-welcome-act="folder">` +
      `<span class="welcome-card__icon">${icon('openFolder', 16)}</span>` +
      `<span class="welcome-card__title">${t('打开文件夹', 'Open Folder')}</span>` +
      `<span class="welcome-card__desc">${t('左侧出现可展开的文件树', 'An expandable file tree appears on the left.')}</span>` +
      `</button>` +
      `</div>` +
      `<div class="welcome__cols">` +
      `<div class="welcome-block">` +
      `<div class="welcome-block__title">${t('最近文件', 'Recent Files')}</div>` +
      `<div class="recent-list">${recentHtml}</div>` +
      `</div>` +
      `<div class="welcome-block">` +
      `<div class="welcome-block__title">${t('常用快捷键', 'Shortcuts')}</div>` +
      `<div class="kbd-grid">${hintsHtml}</div>` +
      `</div>` +
      `</div>` +
      `</div>`;

    root.querySelectorAll('[data-welcome-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.welcomeAct;
        if (act === 'new') app.newFileWithType();
        else if (act === 'open') app.openFiles();
        else if (act === 'folder') app.openFolder();
      });
    });

    root.querySelectorAll('[data-recent]').forEach((btn) => {
      btn.addEventListener('click', () => app.openRecent(btn.dataset.recent));
    });
  }

  /** 显示欢迎页。 */
  function show() {
    render();
    root.hidden = false;
  }

  /** 隐藏欢迎页。 */
  function hide() {
    root.hidden = true;
  }

  return { render, show, hide };
}
