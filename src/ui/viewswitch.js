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

/** 每段的展示元数据。`cmd` 必须与 `core/actions.js` 中的命令 id 一致。 */
const SEGMENTS = {
  source: { label: '源码', cmd: 'view.modeSource', glyph: 'sourceMode', tip: '源码模式' },
  wysiwyg: {
    label: '所见即所得',
    cmd: 'view.modeWysiwyg',
    glyph: 'wysiwygMode',
    tip: '所见即所得模式',
  },
  split: { label: '分屏', cmd: 'view.modeSplit', glyph: 'splitMode', tip: '分屏模式（左源码 + 右预览）' },
};

/**
 * 初始化分段控件。
 * @param {HTMLElement} root 挂载点（工具栏右侧的占位 span）
 * @param {object} app
 * @return {{update: () => void, root: HTMLElement}}
 */
export function initViewSwitch(root, app) {
  const html = VIEW_MODE_UI_ORDER.map((mode) => {
    const seg = SEGMENTS[mode];
    return (
      `<button type="button" class="qp-viewswitch__seg" data-mode="${mode}" ` +
      `data-cmd="${seg.cmd}" data-tip="${seg.tip} · Ctrl+E" aria-label="${seg.tip}" ` +
      `aria-pressed="false">${icon(seg.glyph, 14)}<span class="qp-viewswitch__label">${seg.label}</span>` +
      `</button>`
    );
  }).join('');

  root.className = 'qp-viewswitch';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', '视图模式');
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
      if (!available) {
        btn.setAttribute('data-tip', `仅 Markdown 支持${SEGMENTS[btn.dataset.mode].tip}`);
      } else {
        btn.setAttribute('data-tip', `${SEGMENTS[btn.dataset.mode].tip} · Ctrl+E`);
      }
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
  if (mode === 'source') return '源码';
  if (mode === 'split') return '分屏';
  return '所见即所得';
}
