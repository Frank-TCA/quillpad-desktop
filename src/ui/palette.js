/**
 * QuillPad · 命令面板
 *
 * Ctrl+Shift+P 打开；模糊搜索「命令 + 主题 + 语言」，↑↓ 选择，Enter 执行，Esc 关闭。
 * 主题名（Ivory / Nord / Aurora / Solarized）与语言名（JavaScript / Python…）
 * 都可以直接搜到并一键切换。
 */

import { allCommands, commandShortcutLabels, runCommand, isCommandAvailable } from '../core/commands.js';
import { icon } from './icons.js';
import { escapeHtml, fuzzyScore } from '../core/utils.js';
import { toast } from './toast.js';
import { THEMES } from '../editor/cm-themes.js';
import { languageMenuList } from '../editor/languages.js';

/**
 * @typedef {object} PaletteEntry
 * @property {string} cat 分类（命令分类 / 主题 / 语言）
 * @property {string} title 显示名
 * @property {string[][]} keys 快捷键标签
 * @property {string} [hint] 补充说明
 * @property {boolean} enabled 当前是否可用（不可用时置灰，回车给出提示）
 * @property {() => void} run 执行动作
 */

/**
 * 构造全部可搜索条目：命令 + 主题 + 语言。
 * @param {object} app
 * @param {boolean} withThemes 是否包含主题 / 语言（空查询时只列命令，更聚焦）
 * @return {PaletteEntry[]}
 */
function collectEntries(app, withThemes) {
  /** @type {PaletteEntry[]} */
  const entries = [];
  for (const cmd of allCommands()) {
    if (cmd.hidden) continue;
    entries.push({
      cat: cmd.category,
      title: cmd.title,
      keys: commandShortcutLabels(cmd),
      // 与菜单栏 / 工具栏保持一致：enabled() 为 false 的命令要置灰并阻止静默失败
      enabled: isCommandAvailable(cmd.id),
      run: () => runCommand(cmd.id, app),
    });
  }
  if (!withThemes) return entries;

  for (const theme of THEMES) {
    entries.push({
      cat: '主题',
      title: theme.label,
      keys: [],
      hint: '切换主题',
      enabled: true,
      run: () => app.setTheme(theme.id),
    });
  }
  for (const lang of languageMenuList()) {
    entries.push({
      cat: '语言',
      title: lang.label,
      keys: [],
      hint: '切换语法',
      enabled: true,
      run: () => app.setLanguage(lang.id),
    });
  }
  return entries;
}

/**
 * 条目匹配得分（越高越靠前）。
 * @param {string} query
 * @param {PaletteEntry} entry
 * @return {number}
 */
function scoreEntry(query, entry) {
  const a = fuzzyScore(query, entry.title);
  const b = fuzzyScore(query, entry.cat) * 0.6;
  const c = fuzzyScore(query, `${entry.cat} ${entry.title}`) * 0.85;
  return Math.max(a, b, c);
}

/**
 * 初始化命令面板。
 * @param {object} app
 * @return {{open: (initial?: string) => void, close: () => void, isOpen: () => boolean}}
 */
export function initPalette(app) {
  /** @type {HTMLElement|null} */
  let backdrop = null;
  /** @type {PaletteEntry[]} */
  let visible = [];
  let activeIndex = 0;

  /** 关闭面板。 */
  function close() {
    if (!backdrop) return;
    backdrop.remove();
    backdrop = null;
    visible = [];
    activeIndex = 0;
    app.editor.focus();
  }

  /**
   * 过滤条目。
   * @param {string} query
   * @return {PaletteEntry[]}
   */
  function filterEntries(query) {
    const list = collectEntries(app, !!query.trim());
    if (!query.trim()) return list;
    return list
      .map((entry) => ({ entry, score: scoreEntry(query, entry) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.entry);
  }

  /**
   * 渲染列表。
   * @param {string} query
   */
  function renderList(query) {
    const listEl = backdrop.querySelector('.palette__list');
    const countEl = backdrop.querySelector('.palette__count');
    if (!listEl || !countEl) return;

    visible = filterEntries(query).slice(0, 200);
    if (activeIndex >= visible.length) activeIndex = Math.max(0, visible.length - 1);

    countEl.textContent = visible.length ? `${visible.length} 项` : '0 项';

    if (!visible.length) {
      listEl.innerHTML = '<div class="palette__empty">没有匹配的命令</div>';
      return;
    }

    listEl.innerHTML = visible
      .map((entry, i) => {
        const keysHtml = (entry.keys || [])
          .map((chord) => chord.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join(''))
          .join('<span style="color:var(--text-faint)">›</span>');
        const hintHtml = entry.hint
          ? `<span class="palette__item-hint">${escapeHtml(entry.hint)}</span>`
          : '';
        const disabled = entry.enabled === false;
        return (
          `<div class="palette__item ${i === activeIndex ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}" ` +
          `data-cmd-index="${i}" aria-disabled="${disabled}">` +
          `<span class="palette__item-cat">${escapeHtml(entry.cat)}</span>` +
          `<span class="palette__item-title">${escapeHtml(entry.title)}</span>` +
          hintHtml +
          `<span class="palette__item-keys">${keysHtml}</span>` +
          `</div>`
        );
      })
      .join('');

    const activeEl = listEl.querySelector('.palette__item.is-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  /**
   * 让当前项保持可见。
   */
  function highlightActive() {
    if (!backdrop) return;
    const items = backdrop.querySelectorAll('.palette__item');
    items.forEach((n, i) => n.classList.toggle('is-active', i === activeIndex));
    const activeEl = backdrop.querySelector('.palette__item.is-active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  /** 执行当前选中条目。 */
  function runActive() {
    const entry = visible[activeIndex];
    if (!entry) return;
    if (entry.enabled === false) {
      // 与菜单栏 / 工具栏一致：不可用的命令给出明确提示，而不是静默失败
      toast(`「${entry.title}」当前不可用`, 'info', 2400);
      return;
    }
    close();
    entry.run();
  }

  /**
   * 打开面板。
   * @param {string} [initial] 初始搜索词
   */
  function open(initial = '') {
    if (backdrop) {
      const input = backdrop.querySelector('.palette__input');
      if (input) input.focus();
      return;
    }
    activeIndex = 0;
    backdrop = document.createElement('div');
    backdrop.className = 'palette-backdrop';
    backdrop.innerHTML =
      `<div class="palette" role="dialog" aria-modal="true" aria-label="命令面板">` +
      `<div class="palette__head">` +
      `${icon('command', 16)}` +
      `<input class="palette__input" placeholder="输入命令、主题或语言名称…" value="${escapeHtml(initial)}" ` +
      `aria-label="搜索命令" autocomplete="off" spellcheck="false" />` +
      `<span class="palette__count">0 项</span>` +
      `</div>` +
      `<div class="palette__list"></div>` +
      `<div class="palette__foot">` +
      `<span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span>` +
      `</div>` +
      `</div>`;
    document.body.appendChild(backdrop);

    const input = backdrop.querySelector('.palette__input');
    renderList(initial);

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });

    backdrop.addEventListener('click', (e) => {
      const item = e.target.closest('[data-cmd-index]');
      if (!item) return;
      activeIndex = Number(item.dataset.cmdIndex);
      runActive();
    });

    backdrop.addEventListener('mousemove', (e) => {
      const item = e.target.closest('[data-cmd-index]');
      if (!item) return;
      const i = Number(item.dataset.cmdIndex);
      if (i !== activeIndex) {
        activeIndex = i;
        highlightActive();
      }
    });

    input.addEventListener('input', () => {
      activeIndex = 0;
      renderList(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = visible.length ? (activeIndex + 1) % visible.length : 0;
        highlightActive();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = visible.length
          ? (activeIndex - 1 + visible.length) % visible.length
          : 0;
        highlightActive();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        runActive();
      }
    });

    input.focus();
    if (initial) input.select();
  }

  return {
    open,
    close,
    isOpen: () => !!backdrop,
  };
}
