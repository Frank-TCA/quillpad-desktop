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

/**
 * 初始化状态栏。
 * @param {HTMLElement} root
 * @param {object} app
 */
export function initStatusbar(root, app) {
  root.innerHTML =
    `<span class="status-item" data-cell="cursor" data-tip="行 / 列">行 1, 列 1</span>` +
    `<span class="status-item" data-cell="selection" hidden></span>` +
    `<span class="status-item" data-cell="lines" data-tip="总行数">0 行</span>` +
    `<span class="status-item" data-cell="chars" data-tip="字符数">0 字符</span>` +
    `<span class="status-item" data-cell="words" data-tip="词数">0 词</span>` +
    // v2：列模式提示（Alt+拖拽选出矩形后出现）
    `<span class="status-item status-item--colmode" data-cell="colmode" hidden data-tip="已进入列（矩形）选择模式">列模式</span>` +
    // 唯一的分隔线：把左侧「文档信息」与右侧「文档属性」分成两组
    `<span class="status-sep"></span>` +
    `<span class="status-spacer"></span>` +
    // v2：宏录制红点。放在右侧组（与「源码 / 视图」胶囊同一侧），
    // 这样「状态栏右下角出现红点」的说法与视觉一致。
    // 红点本体是 `.qp-rec-dot`（components.css 里与工具栏共用同一个 7px 呼吸点），
    // 早期版本只写了文字「录制中」、没插这个元素，于是「红点」实际从未渲染出来。
    `<span class="status-item status-item--macro" data-cell="macro" hidden data-clickable="true" data-tip="正在录制宏，点击停止">` +
    `<span class="qp-rec-dot" data-rec-dot aria-hidden="true"></span>录制中</span>` +
    `<span class="status-item" data-cell="lang" data-clickable="true" data-tip="点击切换语言">纯文本</span>` +
    // v2：视图模式胶囊（A1）。插在 lang 之后，不改动既有格与首个格的位置。
    `<span class="status-item status-item--mode" data-cell="mode" data-clickable="true" data-tip="点击切换视图模式（Ctrl+E）">源码</span>` +
    `<span class="status-item" data-cell="indent" data-clickable="true" data-tip="点击切换缩进">空格 2</span>` +
    `<span class="status-item" data-cell="eol" data-clickable="true" data-tip="点击切换换行符">LF</span>` +
    `<span class="status-item" data-cell="encoding" data-clickable="true" data-tip="文件编码">UTF-8</span>` +
    `<span class="status-item" data-cell="saved" data-clickable="true" data-tip="点击保存">已保存</span>`;

  /** @type {{line: number, column: number, selectionLength: number, lines: number, chars: number}} */
  const cursor = { line: 1, column: 1, selectionLength: 0, lines: 0, chars: 0 };

  const cell = (name) => root.querySelector(`[data-cell="${name}"]`);

  /**
   * 更新光标信息。
   * @param {object} info
   */
  function setCursor(info) {
    Object.assign(cursor, info);
    const c = cell('cursor');
    if (c) c.textContent = `行 ${formatNumber(info.line)}, 列 ${formatNumber(info.column)}`;

    const linesCell = cell('lines');
    if (linesCell) linesCell.textContent = `${formatNumber(info.lines || 0)} 行`;

    const charsCell = cell('chars');
    if (charsCell) charsCell.textContent = `${formatNumber(info.chars || 0)} 字符`;

    const sel = cell('selection');
    if (sel) {
      if (info.selectionLength > 0) {
        sel.hidden = false;
        const selLines = info.selectionLines || 1;
        sel.textContent = `选中 ${formatNumber(info.selectionLength)} 字符 / ${formatNumber(selLines)} 行`;
        sel.dataset.tip = '当前选区字符数 / 行数';
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
      colCell.textContent = `列 ${rect.col + 1} · ${rect.lineCount} 行`;
      colCell.dataset.tip = `列（矩形）选择：第 ${rect.col + 1} 列起，共 ${rect.lineCount} 行`;
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

    const linesCell = cell('lines');
    if (linesCell) linesCell.textContent = `${formatNumber(cursor.lines || 0)} 行`;

    const charsCell = cell('chars');
    if (charsCell) charsCell.textContent = `${formatNumber(cursor.chars || 0)} 字符`;

    const wordsCell = cell('words');
    if (wordsCell) {
      if (!tab) {
        wordsCell.textContent = '0 词';
      } else if (tab.content.length > 400000) {
        wordsCell.textContent = '词数统计已跳过';
      } else {
        wordsCell.textContent = `${formatNumber(countWords(tab.content))} 词`;
      }
    }

    const langCell = cell('lang');
    if (langCell) langCell.textContent = tab ? languageLabel(tab.language) : '纯文本';

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
        markdownLike ? '点击切换视图模式（Ctrl+E）' : '仅 Markdown 支持视图切换',
      );
    }

    const indentCell = cell('indent');
    if (indentCell) {
      indentCell.textContent = state.useTabs ? 'Tab' : `空格 ${state.indentSize}`;
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
        savedCell.textContent = '就绪';
      } else if (app.savingTabs.has(tab.id)) {
        savedCell.textContent = '保存中…';
        savedCell.classList.add('is-warning');
      } else if (isDirty(tab)) {
        savedCell.textContent = state.autoSave ? '自动保存中…' : '未保存';
        savedCell.classList.add('is-warning');
      } else {
        savedCell.textContent = '已保存';
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
        app.toast('仅 Markdown 支持切换视图模式', 'info', 2000);
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
        tab ? `当前编码：${tab.encoding}（保存时统一写入 UTF-8）` : '当前编码：UTF-8',
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
