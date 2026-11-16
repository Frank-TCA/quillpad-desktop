/**
 * QuillPad · 三态视图模式分段控件（A1）
 *
 * DOM 契约（`scripts/qa-v2.mjs` A 域断言依据）：
 *   `.qp-viewswitch` 内 3 个 `.qp-viewswitch__seg[data-mode="source|wysiwyg|split"]`
 *   当前项 `aria-pressed="true"`，其余 `false`；不可用时 `disabled`。
 *
 * 三处复用：① 工具栏右侧（主入口，本文件负责渲染）；
 *           ② 状态栏胶囊（`data-cell="mode"`，只显示当前态，见 `ui/statusbar.js`）；
 *           ③ 命令面板 3 条独立命令（`view.modeSource|modeWysiwyg|modeSplit`）。
 */

import { icon } from './icons.js';
import { isCommandAvailable, runCommand } from '../core/commands.js';
import { VIEW_MODE_UI_ORDER } from '../editor/viewmode.js';
import { t } from '../core/i18n.js';

/**
 * 每段的展示元数据，文案已按当前界面语言算好。
 *
 * 是函数而不是模块级常量：`t()` 必须到渲染 / update 时才求值，否则切换界面语言后
 * 按钮文字与 tooltip 会一直停留在 import 时的那一种语言。
 * `cmd` 必须与 `core/actions.js` 中的命令 id 一致。
 *
 * @param {'source'|'wysiwyg'|'split'} mode
 * @return {{label: string, cmd: string, glyph: string, tip: string, tipShortcut: string, tipMarkdownOnly: string}}
 */
function segmentMeta(mode) {
  const all = {
    source: {
      label: t('源码', 'Source'),
      cmd: 'view.modeSource',
      glyph: 'sourceMode',
      tip: t('源码模式', 'Source mode'),
      tipShortcut: t('源码模式 · Ctrl+E', 'Source mode · Ctrl+E'),
      tipMarkdownOnly: t('仅 Markdown 支持源码模式', 'Only Markdown supports Source mode'),
    },
    wysiwyg: {
      label: t('所见即所得', 'WYSIWYG'),
      cmd: 'view.modeWysiwyg',
      glyph: 'wysiwygMode',
      tip: t('所见即所得模式', 'WYSIWYG mode'),
      tipShortcut: t('所见即所得模式 · Ctrl+E', 'WYSIWYG mode · Ctrl+E'),
      tipMarkdownOnly: t('仅 Markdown 支持所见即所得模式', 'Only Markdown supports WYSIWYG mode'),
    },
    split: {
      label: t('分屏', 'Split'),
      cmd: 'view.modeSplit',
      glyph: 'splitMode',
      tip: t('分屏模式（左源码 + 右预览）', 'Split mode (source left + preview right)'),
      tipShortcut: t('分屏模式（左源码 + 右预览） · Ctrl+E', 'Split mode (source left + preview right) · Ctrl+E'),
      tipMarkdownOnly: t('仅 Markdown 支持分屏模式（左源码 + 右预览）', 'Only Markdown supports Split mode (source left + preview right)'),
    },
  };
  return all[mode] || all.source;
}

/**
 * 初始化分段控件。
 * @param {HTMLElement} root 挂载点（工具栏右侧的占位 span）
 * @param {object} app
 * @return {{update: () => void, root: HTMLElement}}
 */
export function initViewSwitch(root, app) {
  const html = VIEW_MODE_UI_ORDER.map((mode) => {
    const seg = segmentMeta(mode);
    return (
      `<button type="button" class="qp-viewswitch__seg" data-mode="${mode}" ` +
      `data-cmd="${seg.cmd}" data-tip="${seg.tipShortcut}" aria-label="${seg.tip}" ` +
      `aria-pressed="false">${icon(seg.glyph, 14)}<span class="qp-viewswitch__label">${seg.label}</span>` +
      `</button>`
    );
  }).join('');

  root.className = 'qp-viewswitch';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', t('视图模式', 'View Mode'));
  root.innerHTML = html;

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    e.preventDefault();
    // 交给命令系统：可用性判断（非 markdown 置灰）与行为只有一处实现
    runCommand(btn.dataset.cmd, app);
  });

  /** 同步选中态与可用态。 */
  function update() {
    const current = app.state.viewMode;
    root.querySelectorAll('[data-mode]').forEach((btn) => {
      const on = btn.dataset.mode === current;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-active', on);
      const cmd = btn.dataset.cmd;
      const available = isCommandAvailable(cmd);
      btn.disabled = !available;
      const seg = segmentMeta(btn.dataset.mode);
      btn.setAttribute('data-tip', available ? seg.tipShortcut : seg.tipMarkdownOnly);
      // 语言切换后按钮文字与 aria-label 也要跟着变（applyLocale() 会调用本 update()）
      const labelEl = btn.querySelector('.qp-viewswitch__label');
      if (labelEl) labelEl.textContent = seg.label;
      btn.setAttribute('aria-label', seg.tip);
    });
    root.dataset.mode = current;
  }

  update();
  return { update, root };
}

/**
 * 状态栏胶囊的文案。
 * @param {'source'|'wysiwyg'|'split'} mode
 * @return {string}
 */
export function viewModeLabel(mode) {
  if (mode === 'source') return t('源码', 'Source');
  if (mode === 'split') return t('分屏', 'Split');
  return t('所见即所得', 'WYSIWYG');
}
