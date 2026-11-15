/**
 * QuillPad · 编辑区右键菜单
 *
 * 委托监听 contextmenu，目标在 `.cm-editor` 内时弹出编辑操作菜单：
 * 剪切/复制/粘贴、全选、标记颜色（submenu）、查找/替换、命令面板。
 */

import { openContextMenu } from './dropdown.js';
import { runCommand, getCommand, commandShortcutText } from '../core/commands.js';
import { applyMarkToRanges, clearMarkRanges } from '../editor/marks.js';

/**
 * 标记色块图例基色（与 theme.css `.qp-tmark--*` 的 color-mix 基色一致）。
 * 用纯色渲染，保证 light / dark 主题下都一眼可辨。
 * @type {Record<string, string>}
 */
const MARK_SWATCHES = {
  red: '#e5484d',
  yellow: '#f5a623',
  green: '#46a758',
  blue: '#3b82f6',
  purple: '#8e4ec6',
};

/**
 * 初始化编辑区右键菜单。
 * @param {object} app
 * @param {HTMLElement} editorRoot 编辑器挂载容器
 */
export function initEditorContextMenu(app, editorRoot) {
  editorRoot.addEventListener('contextmenu', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.cm-editor')) return;
    e.preventDefault();

    // 选区快照：CM6 的 DOMObserver 会在 contextmenu 派发前把选区折叠到鼠标位置，
    // 若等到菜单项 run 时再读 selection，拿到的已是空选区（标记颜色会静默失效）。
    // 这里在菜单构建的同步阶段先抓一份副本。
    const snapshot = app.editor.state.selection.ranges
      .filter((r) => r.to > r.from)
      .map((r) => ({ from: r.from, to: r.to }));
    const hasSelection = snapshot.length > 0;

    /**
     * 生成带快捷键的菜单项。
     * @param {string} cmdId
     * @param {boolean} [disabled]
     * @return {object}
     */
    const cmdItem = (cmdId, disabled) => {
      const cmd = getCommand(cmdId);
      const shortcut = commandShortcutText(cmd);
      return {
        label: cmd ? cmd.title : cmdId,
        keys: shortcut ? [[shortcut]] : undefined,
        disabled: !!disabled,
        run: () => runCommand(cmdId, app),
      };
    };

    /** 标记颜色 submenu（五色带颜色图例小色块）。 */
    const markSubmenu = [
      { label: '红色', swatch: MARK_SWATCHES.red, disabled: !hasSelection, run: () => applyMarkToRanges(app, snapshot, 'red') },
      { label: '黄色', swatch: MARK_SWATCHES.yellow, disabled: !hasSelection, run: () => applyMarkToRanges(app, snapshot, 'yellow') },
      { label: '绿色', swatch: MARK_SWATCHES.green, disabled: !hasSelection, run: () => applyMarkToRanges(app, snapshot, 'green') },
      { label: '蓝色', swatch: MARK_SWATCHES.blue, disabled: !hasSelection, run: () => applyMarkToRanges(app, snapshot, 'blue') },
      { label: '紫色', swatch: MARK_SWATCHES.purple, disabled: !hasSelection, run: () => applyMarkToRanges(app, snapshot, 'purple') },
      { separator: true },
      { label: '清除标记', disabled: !hasSelection, run: () => clearMarkRanges(app, snapshot) },
    ];

    openContextMenu(e, [
      cmdItem('edit.cut', !hasSelection),
      cmdItem('edit.copy', !hasSelection),
      cmdItem('edit.paste'),
      { separator: true },
      cmdItem('edit.selectAll'),
      { separator: true },
      {
        label: '标记颜色',
        submenu: markSubmenu,
      },
      { separator: true },
      cmdItem('search.find'),
      cmdItem('search.replace'),
      { separator: true },
      cmdItem('view.commandPalette'),
    ]);
  });
}
