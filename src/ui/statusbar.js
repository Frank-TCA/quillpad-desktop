/**
 * QuillPad · 状态栏
 * 左侧：行 / 列 / 选区 / 总行数 / 字符 / 词数
 * 右侧：语言 / 缩进 / 换行符 / 编码 / 保存状态
 */

import { state, activeTab, isDirty } from '../core/state.js';
import { languageLabel, languageMenuList } from '../editor/languages.js';
import { openDropdown } from './dropdown.js';
import { formatNumber, countWords } from '../core/utils.js';
import { viewModeLabel } from './viewswitch.js';
import { rectInfo } from '../editor/columns.js';
import { isRecording } from '../core/macro.js';
import { openMacroManager } from './macrodialog.js';
import { t } from '../core/i18n.js';

/**
 * 状态栏骨架 HTML。
 *
 * 是函数而不是模块级常量：里面的 `t()` 必须在渲染点求值，否则切换界面语言后
 * 骨架上的提示文字永远是 import 时那一种语言。
 *
 * @return {string}
 */
function skeletonHtml() {
  return (
    `<span class="status-item" data-cell="cursor" data-tip="${t('行 / 列', 'Line / Column')}">` +
    `${t('行', 'Line')} 1, ${t('列', 'Col')} 1</span>` +
    `<span class="status-item" data-cell="selection" hidden></span>` +
    `<span class="status-item" data-cell="lines" data-tip="${t('总行数', 'Total lines')}">0 ${t('行', 'lines')}</span>` +
    `<span class="status-item" data-cell="chars" data-tip="${t('字符数', 'Character count')}">0 ${t('字符', 'chars')}</span>` +
    `<span class="status-item" data-cell="words" data-tip="${t('词数', 'Word count')}">0 ${t('词', 'words')}</span>` +
    // v2：列模式提示（Alt+拖拽选出矩形后出现）
    `<span class="status-item status-item--colmode" data-cell="colmode" hidden ` +
    `data-tip="${t('已进入列（矩形）选择模式', 'Column (rectangular) selection mode')}">` +
    `${t('列模式', 'Column mode')}</span>` +
    // 唯一的分隔线：把左侧「文档信息」与右侧「文档属性」分成两组
    `<span class="status-sep"></span>` +
    `<span class="status-spacer"></span>` +
    // v2：宏录制红点。放在右侧组（与「源码 / 视图」胶囊同一侧），
    // 这样「状态栏右下角出现红点」的说法与视觉一致。
    // 红点本体是 `.qp-rec-dot`（components.css 里与工具栏共用同一个 7px 呼吸点），
    // 早期版本只写了文字「录制中」、没插这个元素，于是「红点」实际从未渲染出来。
    `<span class="status-item status-item--macro" data-cell="macro" hidden data-clickable="true" ` +
    `data-tip="${t('正在录制宏，点击停止', 'Recording a macro — click to stop')}">` +
    `<span class="qp-rec-dot" data-rec-dot aria-hidden="true"></span>${t('录制中', 'Recording')}</span>` +
    `<span class="status-item" data-cell="lang" data-clickable="true" ` +
    `data-tip="${t('点击切换语言', 'Click to change language')}">${t('纯文本', 'Plain Text')}</span>` +
    // v2：视图模式胶囊（A1）。插在 lang 之后，不改动既有格与首个格的位置。
    `<span class="status-item status-item--mode" data-cell="mode" data-clickable="true" ` +
    `data-tip="${t('点击切换视图模式（Ctrl+E）', 'Click to switch view mode (Ctrl+E)')}">` +
    `${t('源码', 'Source')}</span>` +
    `<span class="status-item" data-cell="indent" data-clickable="true" ` +
    `data-tip="${t('点击切换缩进', 'Click to change indentation')}">` +
    `${t('空格 2', 'Spaces 2')}</span>` +
    `<span class="status-item" data-cell="eol" data-clickable="true" ` +
    `data-tip="${t('点击切换换行符', 'Click to change line endings')}">LF</span>` +
    `<span class="status-item" data-cell="encoding" data-clickable="true" ` +
    `data-tip="${t('文件编码', 'File encoding')}">UTF-8</span>` +
    `<span class="status-item" data-cell="saved" data-clickable="true" ` +
    `data-tip="${t('点击保存', 'Click to save')}">${t('已保存', 'Saved')}</span>`
  );
}

/**
 * 初始化状态栏。
 * @param {HTMLElement} root
 * @param {object} app
 */
export function initStatusbar(root, app) {
  root.innerHTML = skeletonHtml();

  /** @type {{line: number, column: number, selectionLength: number, lines: number, chars: number}} */
  const cursor = { line: 1, column: 1, selectionLength: 0, lines: 0, chars: 0 };

  const cell = (name) => root.querySelector(`[data-cell="${name}"]`);

  /**
   * 刷新骨架上的静态提示文案与固定文本。
   *
   * `update()` 每次都会调它，这样切换界面语言后即使不重建 DOM，
   * data-tip 与「录制中」这类只写了一次的元素也能跟上。
   */
  function applyStaticLabels() {
    const tips = {
      cursor: t('行 / 列', 'Line / Column'),
      lines: t('总行数', 'Total lines'),
      chars: t('字符数', 'Character count'),
      words: t('词数', 'Word count'),
      colmode: t('已进入列（矩形）选择模式', 'Column (rectangular) selection mode'),
      macro: t('正在录制宏，点击停止', 'Recording a macro — click to stop'),
      lang: t('点击切换语言', 'Click to change language'),
      mode: t('点击切换视图模式（Ctrl+E）', 'Click to switch view mode (Ctrl+E)'),
      indent: t('点击切换缩进', 'Click to change indentation'),
      eol: t('点击切换换行符', 'Click to change line endings'),
      encoding: t('文件编码', 'File encoding'),
      saved: t('点击保存', 'Click to save'),
    };
    for (const [name, text] of Object.entries(tips)) {
      const el = cell(name);
      if (el) el.dataset.tip = text;
    }
    // 列模式格没有子元素，可直接改文本
    const colCell = cell('colmode');
    if (colCell) colCell.textContent = t('列模式', 'Column mode');
    // 宏格内还有红点 span，只能改它后面的文本节点，别把红点洗掉
    const macroCell = cell('macro');
    if (macroCell && macroCell.lastChild && macroCell.lastChild.nodeType === 3) {
      macroCell.lastChild.textContent = t('录制中', 'Recording');
    }
  }

  /**
   * 更新光标信息。
   * @param {object} info
   */
  function setCursor(info) {
    Object.assign(cursor, info);
    const c = cell('cursor');
    if (c) {
      c.textContent = t(
        `行 ${formatNumber(info.line)}, 列 ${formatNumber(info.column)}`,
        `Line ${formatNumber(info.line)}, Col ${formatNumber(info.column)}`,
      );
    }

    const linesCell = cell('lines');
    if (linesCell) {
      linesCell.textContent = t(
        `${formatNumber(info.lines || 0)} 行`,
        `${formatNumber(info.lines || 0)} lines`,
      );
    }

    const charsCell = cell('chars');
    if (charsCell) {
      charsCell.textContent = t(
        `${formatNumber(info.chars || 0)} 字符`,
        `${formatNumber(info.chars || 0)} chars`,
      );
    }

    const sel = cell('selection');
    if (sel) {
      if (info.selectionLength > 0) {
        sel.hidden = false;
        const selLines = info.selectionLines || 1;
        sel.textContent = t(
          `选中 ${formatNumber(info.selectionLength)} 字符 / ${formatNumber(selLines)} 行`,
          `Selected ${formatNumber(info.selectionLength)} chars / ${formatNumber(selLines)} lines`,
        );
        sel.dataset.tip = t('当前选区字符数 / 行数', 'Selected characters / lines');
      } else {
        sel.hidden = true;
      }
    }

    // 选区变化会改变矩形判定，这里同步一次（拖动 Alt 选区时状态栏立即亮起）
    syncColumnMode();
  }

  /** 列模式提示（矩形选区才亮起）。 */
  function syncColumnMode() {
    const colCell = cell('colmode');
    if (!colCell) return;
    let rect = null;
    try {
      rect = app.editor && app.editor.view ? rectInfo(app.editor.view.state) : null;
    } catch {
      rect = null;
    }
    colCell.hidden = !rect;
    if (rect) {
      colCell.textContent = t(
        `列 ${rect.col + 1} · ${rect.lineCount} 行`,
        `Col ${rect.col + 1} · ${rect.lineCount} lines`,
      );
      colCell.dataset.tip = t(
        `列（矩形）选择：第 ${rect.col + 1} 列起，共 ${rect.lineCount} 行`,
        `Column selection: from column ${rect.col + 1}, ${rect.lineCount} lines`,
      );
    }
  }

  /** 宏录制红点。 */
  function syncMacroCell() {
    const macroCell = cell('macro');
    if (!macroCell) return;
    const recording = isRecording();
    macroCell.hidden = !recording;
    macroCell.classList.toggle('is-recording', recording);
  }

  /** 完整刷新。 */
  function update() {
    const tab = activeTab();
    // 静态提示与固定文本也在这里重算：切换界面语言后无需重建 DOM
    applyStaticLabels();

    const linesCell = cell('lines');
    if (linesCell) {
      linesCell.textContent = t(
        `${formatNumber(cursor.lines || 0)} 行`,
        `${formatNumber(cursor.lines || 0)} lines`,
      );
    }

    const charsCell = cell('chars');
    if (charsCell) {
      charsCell.textContent = t(
        `${formatNumber(cursor.chars || 0)} 字符`,
        `${formatNumber(cursor.chars || 0)} chars`,
      );
    }

    const wordsCell = cell('words');
    if (wordsCell) {
      if (!tab) {
        wordsCell.textContent = t('0 词', '0 words');
      } else if (tab.content.length > 400000) {
        wordsCell.textContent = t('词数统计已跳过', 'Word count skipped');
      } else {
        const n = formatNumber(countWords(tab.content));
        wordsCell.textContent = t(`${n} 词`, `${n} words`);
      }
    }

    const langCell = cell('lang');
    if (langCell) langCell.textContent = tab ? languageLabel(tab.language) : t('纯文本', 'Plain Text');

    // v2：视图模式胶囊（有效模式，非偏好）
    const modeCell = cell('mode');
    if (modeCell) {
      modeCell.textContent = viewModeLabel(state.viewMode);
      modeCell.dataset.mode = state.viewMode;
      const markdownLike = !!tab && tab.language === 'markdown';
      modeCell.classList.toggle('is-disabled', !markdownLike);
      modeCell.setAttribute('aria-disabled', markdownLike ? 'false' : 'true');
      modeCell.setAttribute(
        'data-tip',
        markdownLike
          ? t('点击切换视图模式（Ctrl+E）', 'Click to switch view mode (Ctrl+E)')
          : t('仅 Markdown 支持视图切换', 'Only Markdown supports view switching'),
      );
    }

    const indentCell = cell('indent');
    if (indentCell) {
      indentCell.textContent = state.useTabs
        ? 'Tab'
        : t(`空格 ${state.indentSize}`, `Spaces ${state.indentSize}`);
    }

    const eolCell = cell('eol');
    if (eolCell) eolCell.textContent = tab ? tab.eol : 'LF';

    const encCell = cell('encoding');
    if (encCell) encCell.textContent = tab ? tab.encoding : 'UTF-8';

    syncColumnMode();
    syncMacroCell();

    const savedCell = cell('saved');
    if (savedCell) {
      savedCell.classList.remove('is-success', 'is-warning', 'is-danger');
      if (!tab) {
        savedCell.textContent = t('就绪', 'Ready');
      } else if (app.savingTabs.has(tab.id)) {
        savedCell.textContent = t('保存中…', 'Saving…');
        savedCell.classList.add('is-warning');
      } else if (isDirty(tab)) {
        savedCell.textContent = state.autoSave
          ? t('自动保存中…', 'Auto-saving…')
          : t('未保存', 'Unsaved');
        savedCell.classList.add('is-warning');
      } else {
        savedCell.textContent = t('已保存', 'Saved');
        savedCell.classList.add('is-success');
      }
    }
  }

  /**
   * 让某个状态格短暂高亮，给用户明确的「点击已生效」反馈。
   * @param {string} name 单元格名
   */
  function flash(name) {
    const el = cell(name);
    if (!el) return;
    el.classList.remove('is-flash');
    // 强制重排，保证连续点击时动画可以重新播放
    void el.offsetWidth;
    el.classList.add('is-flash');
    window.setTimeout(() => el.classList.remove('is-flash'), 700);
  }

  /* ------------------------------------------------------------------ 交互 */

  root.addEventListener('click', (e) => {
    const item = e.target.closest('[data-cell]');
    if (!item) return;
    const name = item.dataset.cell;
    const rect = item.getBoundingClientRect();

    if (name === 'mode') {
      if (activeTab() && activeTab().language !== 'markdown') {
        app.toast(t('仅 Markdown 支持切换视图模式', 'Only Markdown supports switching view modes'), 'info', 2000);
        return;
      }
      app.cycleViewMode();
      flash('mode');
      return;
    }

    if (name === 'lang') {
      const current = app.currentLanguageId();
      openDropdown({
        x: rect.left,
        y: rect.top - 8,
        items: languageMenuList().map((lang) => ({
          label: lang.label,
          checked: lang.id === current,
          run: () => app.setLanguage(lang.id),
        })),
        minWidth: 190,
      });
      // 让菜单朝上弹出
      const menu = document.querySelector('.dropdown');
      if (menu) {
        const h = menu.getBoundingClientRect().height;
        menu.style.top = `${Math.max(8, rect.top - h - 8)}px`;
      }
      return;
    }

    if (name === 'indent') {
      app.cycleIndent();
      flash('indent');
      return;
    }

    if (name === 'eol') {
      app.toggleEol();
      flash('eol');
      return;
    }

    if (name === 'encoding') {
      const tab = activeTab();
      app.toast(
        tab
          ? t(
            `当前编码：${tab.encoding}（保存时统一写入 UTF-8）`,
            `Current encoding: ${tab.encoding} (files are always written as UTF-8)`,
          )
          : t('当前编码：UTF-8', 'Current encoding: UTF-8'),
        'info',
        3200,
      );
      return;
    }

    if (name === 'macro') {
      void openMacroManager(app);
      return;
    }

    if (name === 'saved') {
      app.saveActive();
      return;
    }
  });

  update();

  return { update, setCursor, syncColumnMode, syncMacroCell };
}
