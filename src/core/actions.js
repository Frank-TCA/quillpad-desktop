/**
 * QuillPad · 全部命令定义
 *
 * 每一条命令都对应一个真实动作，菜单 / 工具栏 / 快捷键 / 命令面板共用同一份定义。
 */

import { defineCommands, allCommands } from './commands.js';
import { activeTab, isDirty, state } from './state.js';
import { undo, redo, selectAll, cursorMatchingBracket, addCursorAbove, addCursorBelow, deleteLine, moveLineUp, moveLineDown, toggleComment, copyLineDown } from '@codemirror/commands';
import { openFindPanel } from '../ui/findbar.js';
import { gotoLineDialog, shortcutsDialog, aboutDialog } from '../ui/dialogs.js';
import { toast } from '../ui/toast.js';
import {
  changeCase,
  sortAsc,
  sortDesc,
  dedupeLines,
  trimTrailingWhitespace,
  tabsToSpaces,
  spacesToTabs,
} from '../editor/transforms.js';
import { FONT_SIZE_MIN, FONT_SIZE_MAX, fontStepFor } from './settings.js';
import { isHardLimited } from '../editor/viewmode.js';
import { scanMarkdown } from '../editor/wysiwyg/scan.js';
import { parseTable, serializeTable } from '../editor/wysiwyg/table-model.js';
import { applyTableOp } from '../editor/wysiwyg/table-ops.js';
import { insertMarkdownImage } from '../editor/wysiwyg/image.js';
import { openDropdown } from '../ui/dropdown.js';
import { languageMenuList, isMarkdown } from '../editor/languages.js';
import {
  wrapSelection,
  prefixLines,
  insertBlock,
  insertLink,
} from '../editor/markdown-format.js';
import { openPdfDialog } from '../ui/pdf-dialog.js';
import { openCharsDialog } from '../ui/chars.js';
import { openMacroManager } from '../ui/macrodialog.js';
import {
  rectInfo,
  columnInsert,
  columnDelete,
  columnAlign,
  columnNumber,
} from '../editor/columns.js';
import {
  startRecording,
  stopRecording,
  cancelRecording,
  isRecording,
  recordStep,
  playMacro,
  getMacros,
  loadMacros,
  NON_REPLAYABLE,
} from './macro.js';
import { defaultPdfOptions, printDocument } from './print.js';
import { promptInput, confirmAction } from '../ui/dialogs.js';
import { applyMark, clearMarks, clearMarksInSelection } from '../editor/marks.js';

/* ------------------------------------------------------------------ 表格辅助 */

/**
 * 找光标附近的表格块（A4）。
 *
 * 表格在 wysiwyg 下是块级 widget，光标通常落在块的上下边界，
 * 因此这里做「包含 → 最近」两级回退，保证 7 个命令在任何模式下都能作用于「当前表格」。
 *
 * @param {import('@codemirror/view').EditorView} view
 * @return {object|null}
 */
function nearestTableBlock(view) {
  const state = view.state;
  const scan = scanMarkdown(state);
  const pos = state.selection.main.head;
  const tables = scan.blocks.filter((b) => b.kind === 'table');
  if (!tables.length) return null;
  const hit = tables.find((b) => pos >= b.from && pos <= b.to);
  if (hit) return hit;
  let best = null;
  let bestDist = Infinity;
  for (const b of tables) {
    const dist = pos < b.from ? b.from - pos : pos - b.to;
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return bestDist <= 400 ? best : null;
}

/**
 * 由光标位置推导表格内的行 / 列（0 基数据行；-1 表示表头）。
 * @param {object} block
 * @param {import('@codemirror/state').EditorState} state
 * @return {{row: number, col: number}}
 */
function tableCursorAt(block, state) {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(Math.min(Math.max(pos, block.from), block.to));
  const startLine = state.doc.lineAt(block.from).number;
  const rel = line.number - startLine; // 0 = 表头行，1 = 分隔行，2+ = 数据行
  const row = rel <= 2 ? 0 : rel - 2;
  const before = state.doc.sliceString(line.from, Math.max(line.from, Math.min(pos, line.to)));
  const pipes = (before.match(/\|/g) || []).length;
  const col = Math.max(0, pipes - 1);
  return { row, col };
}

/**
 * 对一个表格块执行行列操作并写回文档。
 * @param {import('@codemirror/view').EditorView} view
 * @param {string} op
 * @return {boolean}
 */
function runTableOp(view, op) {
  const block = nearestTableBlock(view);
  if (!block) {
    toast('光标不在表格内', 'info', 1800);
    return false;
  }
  const model = parseTable(view.state.doc.sliceString(block.from, block.to), block.from, block.to);
  if (!model) {
    toast('未能解析该表格', 'error', 2000);
    return false;
  }
  const at = tableCursorAt(block, view.state);
  const next = applyTableOp(model, op, at);
  const out = serializeTable(next);
  view.dispatch({ changes: { from: model.from, to: model.to, insert: out.text } });
  view.focus();
  return true;
}

/**
 * 把当前选中的文本写入剪贴板。
 * @param {string} text
 * @return {Promise<boolean>}
 */
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 读取剪贴板文本。
 * @return {Promise<string|null>}
 */
async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * 注册全部命令。
 * @param {object} app
 */
export function registerCommands(app) {
  const view = () => app.editor.view;
  const hasTab = () => !!activeTab();

  /**
   * 列编辑的统一前置检查。
   *
   * 四个列命令都要求「已经用 Alt+拖拽选出一个矩形」，没有就明确 toast ——
   * N++ 的同类命令是静默失败，用户会以为按键没生效。
   *
   * @param {string} title 命令名（拼进提示）
   * @return {boolean}
   */
  const requireRect = (title) => {
    const v = view();
    if (!v) return false;
    if (!rectInfo(v.state)) {
      toast(`「${title}」需要先用 Alt+拖拽选出一块矩形区域`, 'info', 2800);
      return false;
    }
    return true;
  };

  /**
   * 录制 / 停止录制的开关（工具栏按钮与命令共用）。
   * @return {Promise<void>}
   */
  const toggleRecord = async () => {
    if (isRecording()) {
      const name = await promptInput({
        title: '停止录制并保存宏',
        label: '宏名称',
        value: `宏 ${getMacros().length + 1}`,
        okLabel: '保存',
      });
      if (name === null) {
        cancelRecording(app);
        toast('已放弃本次录制', 'info', 2000);
        return;
      }
      const res = await stopRecording(name, app);
      if (!res.ok) {
        toast(res.reason === 'empty' ? '没有录到任何命令' : '保存宏失败', 'error', 2400);
        return;
      }
      toast(`已保存宏「${res.macro.name}」（${res.macro.steps.length} 步）`, 'success', 2600);
      return;
    }
    const res = startRecording(app);
    if (!res.ok) {
      toast(res.reason === 'playing' ? '宏回放中，无法录制' : '已经在录制中', 'info', 2200);
      return;
    }
    toast('开始录制宏：状态栏出现红点，再按一次停止', 'info', 2800);
  };

  /**
   * wysiwyg / split 是否可用：必须当前标签是 markdown，且未超硬上限（A9）。
   * 工具栏分段控件、菜单、命令面板三处共用这一份判断。
   * @return {boolean}
   */
  const canMarkdownMode = () => {
    const tab = activeTab();
    if (!tab || tab.language !== 'markdown') return false;
    return !isHardLimited(tab);
  };

  /**
   * Markdown 格式命令的可用性：必须有活动标签且当前语言是 Markdown。
   * currentLanguageId 在 app 装配较晚才赋值，首次调用需 typeof 守卫。
   */
  const mdEnabled = () =>
    hasTab() &&
    typeof app.currentLanguageId === 'function' &&
    isMarkdown(app.currentLanguageId());

  defineCommands([
    /* ------------------------------------------------------------- 文件 */
    {
      id: 'file.new',
      title: '新建文件…',
      category: '文件',
      keys: ['Mod-n'],
      global: true,
      run: () => app.newFileWithType(),
    },
    {
      id: 'file.newUntitled',
      title: '新建空白文件（不询问类型）',
      category: '文件',
      global: true,
      run: () => app.newFile(),
    },
    {
      id: 'file.open',
      title: '打开文件…',
      category: '文件',
      keys: ['Mod-o'],
      global: true,
      run: () => app.openFiles(),
    },
    {
      id: 'file.openFolder',
      title: '打开文件夹…',
      category: '文件',
      chord: 'Mod-k o',
      global: true,
      run: () => app.openFolder(),
    },
    {
      id: 'file.save',
      title: '保存',
      category: '文件',
      keys: ['Mod-s'],
      global: true,
      enabled: hasTab,
      run: () => app.saveActive(),
    },
    {
      id: 'file.saveAs',
      title: '另存为…',
      category: '文件',
      keys: ['Mod-Shift-s'],
      global: true,
      enabled: hasTab,
      run: () => app.saveActiveAs(),
    },
    {
      id: 'file.saveAll',
      title: '全部保存',
      category: '文件',
      keys: ['Mod-Alt-s'],
      global: true,
      enabled: () => state.tabs.some((t) => isDirty(t)),
      run: () => app.saveAll(),
    },
    {
      id: 'file.reload',
      title: '从磁盘重新加载',
      category: '文件',
      enabled: hasTab,
      run: () => app.reloadActive(),
    },
    {
      id: 'file.close',
      title: '关闭当前标签',
      category: '文件',
      keys: ['Mod-w'],
      global: true,
      enabled: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) app.closeTab(tab.id);
      },
    },
    {
      id: 'file.closeOthers',
      title: '关闭其他标签',
      category: '文件',
      enabled: () => state.tabs.length > 1,
      run: () => {
        const tab = activeTab();
        if (tab) app.closeOtherTabs(tab.id);
      },
    },
    {
      id: 'file.closeAll',
      title: '关闭全部标签',
      category: '文件',
      enabled: () => state.tabs.length > 0,
      run: () => app.closeAllTabs(),
    },
    {
      id: 'file.copyPath',
      title: '复制文件路径',
      category: '文件',
      enabled: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) app.copyTabPath(tab.id);
      },
    },
    {
      id: 'file.refreshFolder',
      title: '刷新文件夹树',
      category: '文件',
      run: () => app.refreshFolder(),
    },
    {
      id: 'file.closeFolder',
      title: '关闭文件夹',
      category: '文件',
      enabled: () => !!state.folder,
      run: () => app.closeFolder(),
    },

    /* ------------------------------------------------------------- 编辑 */
    {
      id: 'edit.undo',
      title: '撤销',
      category: '编辑',
      keys: ['Mod-z'],
      enabled: hasTab,
      run: () => undo(view()),
    },
    {
      id: 'edit.redo',
      title: '重做',
      category: '编辑',
      keys: ['Mod-Shift-z', 'Mod-y'],
      enabled: hasTab,
      run: () => redo(view()),
    },
    {
      id: 'edit.cut',
      title: '剪切',
      category: '编辑',
      enabled: hasTab,
      run: async () => {
        const text = app.editor.getSelectionText();
        if (!text) {
          toast('没有选中的内容', 'info', 1600);
          return;
        }
        const ok = await copyToClipboard(text);
        if (!ok) {
          toast('剪贴板不可用，请使用 Ctrl+X', 'error', 2400);
          return;
        }
        app.editor.view.dispatch(app.editor.state.replaceSelection(''));
        app.editor.focus();
      },
    },
    {
      id: 'edit.copy',
      title: '复制',
      category: '编辑',
      enabled: hasTab,
      run: async () => {
        const text = app.editor.getSelectionText();
        if (!text) {
          toast('没有选中的内容', 'info', 1600);
          return;
        }
        const ok = await copyToClipboard(text);
        toast(ok ? `已复制 ${text.length} 个字符` : '剪贴板不可用，请使用 Ctrl+C', ok ? 'success' : 'error', 1800);
      },
    },
    {
      id: 'edit.paste',
      title: '粘贴',
      category: '编辑',
      enabled: hasTab,
      run: async () => {
        const text = await readClipboard();
        if (text == null) {
          app.editor.focus();
          toast('无法读取剪贴板，请在编辑区按 Ctrl+V', 'error', 2800);
          return;
        }
        app.editor.insertText(text);
      },
    },
    {
      id: 'edit.selectAll',
      title: '全选',
      category: '编辑',
      keys: ['Mod-a'],
      enabled: hasTab,
      run: () => selectAll(view()),
    },
    {
      id: 'edit.duplicateLine',
      title: '复制当前行',
      category: '编辑',
      keys: ['Mod-d'],
      enabled: hasTab,
      run: () => {
        if (!copyLineDown(view())) toast('无法复制该行', 'info', 1600);
        else app.editor.focus();
      },
    },
    {
      id: 'edit.deleteLine',
      title: '删除当前行',
      category: '编辑',
      keys: ['Mod-Shift-k'],
      enabled: hasTab,
      run: () => deleteLine(view()),
    },
    {
      id: 'edit.moveLineUp',
      title: '上移当前行',
      category: '编辑',
      keys: ['Alt-ArrowUp'],
      enabled: hasTab,
      run: () => moveLineUp(view()),
    },
    {
      id: 'edit.moveLineDown',
      title: '下移当前行',
      category: '编辑',
      keys: ['Alt-ArrowDown'],
      enabled: hasTab,
      run: () => moveLineDown(view()),
    },
    {
      id: 'edit.toggleComment',
      title: '切换注释',
      category: '编辑',
      keys: ['Mod-/'],
      enabled: hasTab,
      run: () => {
        const v = view();
        // 纯文本等语言没有注释 token，直接调用 toggleComment 会「静默无反应」，
        // 这里先探测当前语言的注释支持，给出明确提示。
        const data = v.state.languageDataAt('commentTokens', v.state.selection.main.head, 1);
        const tokens = data.length ? data[0] : null;
        if (!tokens || (!tokens.line && !tokens.block)) {
          toast('当前语言不支持注释，请先在状态栏切换语法', 'info', 2200);
          return;
        }
        toggleComment(v);
      },
    },
    {
      id: 'edit.jumpToBracket',
      title: '跳转到匹配括号',
      category: '编辑',
      keys: ['Mod-Shift-\\'],
      enabled: hasTab,
      run: () => {
        if (!cursorMatchingBracket(view())) toast('光标附近没有可匹配的括号', 'info', 1800);
      },
    },
    {
      id: 'edit.multiCursorUp',
      title: '向上添加光标',
      category: '编辑',
      keys: ['Mod-Alt-ArrowUp'],
      enabled: hasTab,
      run: () => addCursorAbove(view()),
    },
    {
      id: 'edit.multiCursorDown',
      title: '向下添加光标',
      category: '编辑',
      keys: ['Mod-Alt-ArrowDown'],
      enabled: hasTab,
      run: () => addCursorBelow(view()),
    },
    {
      id: 'edit.upperCase',
      title: '转换为大写',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!changeCase(view(), 'upper')) toast('没有可转换的文本', 'info', 1600);
      },
    },
    {
      id: 'edit.lowerCase',
      title: '转换为小写',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!changeCase(view(), 'lower')) toast('没有可转换的文本', 'info', 1600);
      },
    },
    {
      id: 'edit.titleCase',
      title: '首字母大写',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!changeCase(view(), 'title')) toast('没有可转换的文本', 'info', 1600);
      },
    },
    {
      id: 'edit.sortAsc',
      title: '排序行（升序）',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!sortAsc(view())) toast('没有可排序的内容', 'info', 1800);
      },
    },
    {
      id: 'edit.sortDesc',
      title: '排序行（降序）',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!sortDesc(view())) toast('没有可排序的内容', 'info', 1800);
      },
    },
    {
      id: 'edit.dedupLines',
      title: '去除重复行',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!dedupeLines(view())) toast('没有可去重的内容', 'info', 1800);
      },
    },
    {
      id: 'edit.trimTrailing',
      title: '去除行尾空白',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        const n = trimTrailingWhitespace(view());
        toast(n ? `已清理 ${n} 行` : '没有需要清理的行尾空白', n ? 'success' : 'info', 1800);
      },
    },
    {
      id: 'edit.convertIndentSpaces',
      title: '缩进转空格',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        const n = tabsToSpaces(view(), state.indentSize);
        toast(n ? `已转换 ${n} 行` : '没有找到制表符缩进', n ? 'success' : 'info', 2000);
      },
    },
    {
      id: 'edit.convertIndentTabs',
      title: '缩进转制表符',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        const n = spacesToTabs(view(), state.indentSize);
        toast(n ? `已转换 ${n} 行` : '没有找到空格缩进', n ? 'success' : 'info', 2000);
      },
    },

    /* ------------------------------------------------------------- 搜索 */
    {
      id: 'search.find',
      title: '查找…',
      category: '搜索',
      keys: ['Mod-f'],
      global: true,
      enabled: hasTab,
      run: () => {
        app.editor.focus();
        openFindPanel(view(), false);
      },
    },
    {
      id: 'search.replace',
      title: '替换…',
      category: '搜索',
      keys: ['Mod-h'],
      global: true,
      enabled: hasTab,
      run: () => {
        app.editor.focus();
        openFindPanel(view(), true);
      },
    },
    {
      id: 'search.findNext',
      title: '查找下一个',
      category: '搜索',
      keys: ['F3'],
      enabled: hasTab,
      run: () => {
        const panel = document.querySelector('.qp-search [data-role="search"]');
        if (!panel) {
          openFindPanel(view(), false);
          return;
        }
        const btn = document.querySelector('.qp-search [data-act="next"]');
        if (btn) btn.click();
      },
    },
    {
      id: 'search.findPrev',
      title: '查找上一个',
      category: '搜索',
      keys: ['Shift-F3'],
      enabled: hasTab,
      run: () => {
        const btn = document.querySelector('.qp-search [data-act="prev"]');
        if (btn) btn.click();
        else openFindPanel(view(), false);
      },
    },
    {
      id: 'search.gotoLine',
      title: '转到行…',
      category: '搜索',
      keys: ['Mod-g'],
      global: true,
      enabled: hasTab,
      run: async () => {
        const info = { totalLines: app.editor.state.doc.lines, current: app.lastCursor.line };
        const line = await gotoLineDialog(info);
        if (line) app.editor.gotoLine(line);
      },
    },
    {
      id: 'search.findInFiles',
      title: '在文件中查找…',
      category: '搜索',
      keys: ['Mod-Shift-f'],
      global: true,
      run: () => app.findInFiles.open(),
    },

    /* ------------------------------------------------------------- 视图 */
    {
      id: 'view.commandPalette',
      title: '命令面板…',
      category: '视图',
      keys: ['Mod-Shift-p'],
      global: true,
      run: () => app.palette.open(),
    },
    {
      id: 'view.toggleSidebar',
      title: '显示 / 隐藏侧边栏',
      category: '视图',
      keys: ['Mod-b'],
      toggle: () => state.sidebarVisible,
      run: () => app.setSidebarVisible(),
    },
    {
      id: 'view.wordWrap',
      title: '自动换行',
      category: '视图',
      keys: ['Alt-z'],
      toggle: () => state.wordWrap,
      run: () => app.setWordWrap(),
    },
    {
      id: 'view.fontIncrease',
      title: '放大字号',
      category: '视图',
      keys: ['Mod-=', 'Mod-+'],
      run: () => app.setFontSize(Math.min(FONT_SIZE_MAX, state.fontSize + fontStepFor(state.fontSize))),
    },
    {
      id: 'view.fontDecrease',
      title: '缩小字号',
      category: '视图',
      keys: ['Mod--'],
      run: () => app.setFontSize(Math.max(FONT_SIZE_MIN, state.fontSize - fontStepFor(state.fontSize - 1))),
    },
    {
      id: 'view.fontReset',
      title: '重置字号',
      category: '视图',
      keys: ['Mod-0'],
      run: () => {
        app.setFontSize(14);
        toast('字号已重置为 14px', 'info', 1400);
      },
    },
    {
      id: 'view.preview',
      title: 'Markdown 预览',
      category: '视图',
      keys: ['Mod-Shift-v'],
      toggle: () => state.previewVisible,
      enabled: () => {
        const tab = activeTab();
        // 超过硬上限（20MB / 500k 行）时与「所见即所得」一起置灰（T08 ③）
        return !!tab && tab.language === 'markdown' && !isHardLimited(tab);
      },
      run: () => app.togglePreview(),
    },

    /*  v2：三态视图模式（A1）
     *  - 三条独立命令供命令面板 / 菜单直接选中某个模式；
     *  - QA D-3 / CHANGELOG §二.30：`Ctrl+Shift+1/2/3` 三态直切，
     *    与 `Mod-E` 循环并存；`global: true` 保证焦点在表单控件里也生效
     *    （与 view.modeCycle 一致）。keys.js 的数字别名负责 US 布局下
     *    Shift 数字键产生的 `!` / `@` / `#`。
     *  - `view.modeCycle` 承载 `Mod-E` 循环（固定顺序 source → split → wysiwyg）；
     *  - 非 markdown 时 wysiwyg / split 置灰，且与工具栏分段控件共用
     *    同一份 `enabled()`（保证三入口可用性一致）。 */
    {
      id: 'view.modeSource',
      title: '源码模式',
      category: '视图',
      keys: ['Mod-Shift-1'],
      global: true,
      enabled: hasTab,
      run: () => app.setViewMode('source', { user: true }),
    },
    {
      id: 'view.modeWysiwyg',
      title: '所见即所得模式',
      category: '视图',
      keys: ['Mod-Shift-2'],
      global: true,
      enabled: () => canMarkdownMode(),
      run: () => app.setViewMode('wysiwyg', { user: true }),
    },
    {
      id: 'view.modeSplit',
      title: '分屏模式',
      category: '视图',
      keys: ['Mod-Shift-3'],
      global: true,
      enabled: () => canMarkdownMode(),
      run: () => app.setViewMode('split', { user: true }),
    },
    {
      id: 'view.modeCycle',
      title: '切换视图模式',
      category: '视图',
      keys: ['Mod-e'],
      global: true,
      enabled: hasTab,
      run: () => app.cycleViewMode(),
    },
    {
      id: 'view.zen',
      title: '禅模式',
      category: '视图',
      keys: ['F11'],
      toggle: () => state.zen,
      run: () => app.setZen(),
    },
    {
      id: 'view.focusMode',
      title: '专注模式',
      category: '视图',
      toggle: () => state.focusMode,
      run: () => app.setFocusMode(),
    },
    {
      id: 'view.typewriter',
      title: '打字机模式',
      category: '视图',
      toggle: () => state.typewriter,
      run: () => app.setTypewriter(),
    },
    {
      id: 'view.reduceMotion',
      title: '减少动效',
      category: '视图',
      toggle: () => state.reduceMotion,
      run: () => app.setReduceMotion(),
    },
    {
      id: 'view.minimap',
      title: '迷你地图',
      category: '视图',
      toggle: () => state.minimapVisible,
      run: () => app.setMinimap(),
    },
    {
      id: 'view.autoSave',
      title: '自动保存',
      category: '视图',
      toggle: () => state.autoSave,
      run: () => {
        state.autoSave = !state.autoSave;
        app.persistSettings();
        app.statusbar.update();
        toast(state.autoSave ? '自动保存已开启（停止输入 1.5 秒后写盘）' : '自动保存已关闭', 'info', 2200);
      },
    },
    {
      id: 'view.themeMenu',
      title: '切换主题',
      category: '视图',
      run: () => app.cycleTheme(),
    },
    {
      id: 'view.nextTab',
      title: '下一个标签页',
      category: '视图',
      // Ctrl+Tab 在部分浏览器里会被浏览器占用，因此同时提供 Ctrl+PageDown
      keys: ['Mod-Tab', 'Mod-PageDown'],
      global: true,
      enabled: () => state.tabs.length > 1,
      run: () => app.cycleTab(1),
    },
    {
      id: 'view.prevTab',
      title: '上一个标签页',
      category: '视图',
      keys: ['Mod-Shift-Tab', 'Mod-PageUp'],
      global: true,
      enabled: () => state.tabs.length > 1,
      run: () => app.cycleTab(-1),
    },

    /* ------------------------------------------------- v2 表格（A4 / T06） */
    {
      id: 'markdown.table.rowAbove',
      title: '表格：上方插入行',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'rowAbove'),
    },
    {
      id: 'markdown.table.rowBelow',
      title: '表格：下方插入行',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'rowBelow'),
    },
    {
      id: 'markdown.table.rowDelete',
      title: '表格：删除行',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'rowDelete'),
    },
    {
      id: 'markdown.table.colLeft',
      title: '表格：左侧插入列',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'colLeft'),
    },
    {
      id: 'markdown.table.colRight',
      title: '表格：右侧插入列',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'colRight'),
    },
    {
      id: 'markdown.table.colDelete',
      title: '表格：删除列',
      category: '格式',
      enabled: hasTab,
      run: () => runTableOp(view(), 'colDelete'),
    },
    {
      id: 'markdown.table.cycleAlign',
      title: '表格：切换列对齐',
      category: '格式',
      enabled: hasTab,
      // op 名为 `alignCycle`（table-ops 的命名），命令 id 沿用 ARCH §4 的 `cycleAlign`
      run: () => runTableOp(view(), 'alignCycle'),
    },

    /* --------------------------------------------- v2 插入（A2 / A6 / A7） */
    {
      id: 'insert.math',
      title: '插入：数学公式',
      category: '插入',
      enabled: hasTab,
      hidden: false,
      run: () => {
        const v = view();
        const sel = v.state.selection.main;
        const selected = v.state.sliceDoc(sel.from, sel.to);
        const body = selected || 'a^2+b^2';
        const text = `$${body}$`;
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + 1, head: sel.from + 1 + body.length },
        });
        v.focus();
        toast('已插入行内公式，光标移出该行即可预览', 'info', 2200);
      },
    },
    {
      id: 'insert.footnote',
      title: '插入：脚注',
      category: '插入',
      enabled: hasTab,
      run: () => {
        const v = view();
        const scan = scanMarkdown(v.state);
        const used = new Set(
          scan.inline.filter((e) => e.kind === 'footnote-ref').map((e) => e.id),
        );
        let n = 1;
        while (used.has(String(n))) n += 1;
        const id = String(n);
        const sel = v.state.selection.main;
        const text = `[^${id}]`;
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
        });
        // 文末追加定义行（若已存在同名定义则跳过）
        const doc = v.state.doc;
        const hasDef = scan.lines.some((l) => l && l.kind === 'footnote-def' && l.footnoteId === id);
        if (!hasDef) {
          const end = doc.length;
          const prefix = doc.lines > 1 && doc.line(doc.lines).text.trim() ? '\n\n' : '';
          v.dispatch({
            changes: { from: end, insert: `${prefix}[^${id}]: 脚注内容\n` },
          });
        }
        v.focus();
        toast(`已插入脚注 [^${id}]`, 'success', 1800);
      },
    },
    {
      id: 'insert.toc',
      title: '插入：目录 [TOC]',
      category: '插入',
      enabled: hasTab,
      run: () => {
        const v = view();
        const line = v.state.doc.line(1);
        v.dispatch({
          changes: { from: line.from, insert: '[TOC]\n\n' },
          selection: { anchor: line.from + 8 },
        });
        v.focus();
        toast('目录已插入到文档开头', 'success', 1800);
      },
    },
    {
      id: 'markdown.insertImage',
      title: '插入：图片…',
      category: '插入',
      enabled: hasTab,
      run: async () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const res = await insertMarkdownImage(app, file);
          if (!res.ok) toast(res.error || '插入图片失败', 'error', 3200);
          else if (res.degraded) toast('已以内联 data URL 插入（建议先另存为再插入图片）', 'info', 3200);
        });
        input.click();
      },
    },
    {
      id: 'markdown.pickCodeLanguage',
      title: '代码块：切换语言',
      category: '格式',
      enabled: hasTab,
      hidden: true,
      run: (ctx, args0) => {
        const args = args0 && typeof args0 === 'object' ? args0 : {};
        const v = view();
        const anchor = args.anchor || null;
        const headFrom = typeof args.headFrom === 'number' ? args.headFrom : null;
        const rect = anchor && anchor.getBoundingClientRect
          ? anchor.getBoundingClientRect()
          : { left: 40, bottom: 80 };
        openDropdown({
          x: rect.left,
          y: rect.bottom + 4,
          minWidth: 190,
          items: languageMenuList().map((lang) => ({
            label: lang.label,
            run: () => {
              if (headFrom == null) return;
              const scan = scanMarkdown(v.state);
              const fence = scan.lines.find(
                (l) => l && l.kind === 'fence' && l.from === headFrom,
              );
              if (!fence) return;
              const from = fence.fenceFrom;
              const to = fence.fenceTo;
              v.dispatch({ changes: { from, to, insert: `\`\`\`${lang.id}` } });
              v.focus();
            },
          })),
        });
      },
    },

    /* ------------------------------------------------- v2 PDF / 打印（T10–T12） */
    {
      id: 'pdf.export',
      title: '导出为 PDF…',
      category: '文件',
      keys: ['Mod-Shift-e'],
      enabled: hasTab,
      run: () => {
        openPdfDialog(app);
        return true;
      },
    },
    {
      id: 'pdf.print',
      title: '打印…',
      category: '文件',
      keys: ['Mod-Alt-p'],
      enabled: hasTab,
      run: async () => {
        const tab = activeTab();
        if (!tab) return false;
        const opts = defaultPdfOptions((app.settings && app.settings.pdf) || {}, tab);
        const res = await printDocument(app, tab, opts);
        if (!res.ok) {
          toast(res.error || '打印失败', 'error', 3200);
          return false;
        }
        if (res.degraded) toast('已调起系统打印对话框', 'info', 2400);
        return true;
      },
    },

    /* --------------------------------------------------------------- v2 宏（T13） */
    {
      id: 'macro.record',
      title: '录制宏',
      category: '编辑',
      keys: ['Mod-Shift-r'],
      toggle: () => isRecording(),
      enabled: hasTab,
      run: () => {
        void toggleRecord();
        return true;
      },
    },
    {
      id: 'macro.play',
      title: '回放最近的宏',
      category: '编辑',
      keys: ['Mod-Shift-m'],
      enabled: hasTab,
      run: async () => {
        await loadMacros();
        const list = getMacros();
        if (!list.length) {
          toast('还没有录制任何宏', 'info', 2200);
          return false;
        }
        const latest = list[list.length - 1];
        const res = await playMacro(latest, app);
        if (!res.played && !res.skipped.length) {
          toast('这个宏里没有任何可回放的步骤', 'info', 2400);
          return false;
        }
        toast(`已回放「${latest.name}」${res.played} 步`, 'success', 2200);
        return true;
      },
    },
    {
      id: 'macro.manage',
      title: '宏管理…',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        void openMacroManager(app);
        return true;
      },
    },

    /* ------------------------------------------------------ v2 列编辑（T14） */
    {
      id: 'edit.columnInsert',
      title: '列编辑：插入文本…',
      category: '编辑',
      keys: ['Mod-Alt-i'],
      enabled: hasTab,
      run: async () => {
        if (!requireRect('列插入文本')) return false;
        const text = await promptInput({
          title: '列插入文本',
          label: '要插入到每一行的文本',
          value: '',
          okLabel: '插入',
        });
        if (text === null || text === '') {
          toast('已取消', 'info', 1600);
          return false;
        }
        const res = columnInsert(view(), text);
        if (!res.ok) {
          toast('列插入失败：需要矩形选区', 'info', 2400);
          return false;
        }
        toast(`已插入到 ${res.lines} 行`, 'success', 1800);
        return true;
      },
    },
    {
      id: 'edit.columnDelete',
      title: '列编辑：删除列',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!requireRect('删除列')) return false;
        const res = columnDelete(view());
        if (!res.ok) {
          toast('删除列失败：列内容为空', 'info', 2400);
          return false;
        }
        toast(`已删除 ${res.lines} 行的同一列`, 'success', 1800);
        return true;
      },
    },
    {
      id: 'edit.columnAlign',
      title: '列编辑：列对齐',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!requireRect('列对齐')) return false;
        const res = columnAlign(view());
        if (!res.ok) {
          toast('列对齐失败', 'info', 2400);
          return false;
        }
        toast(`已按第 ${res.column} 显示列对齐 ${res.lines} 行`, 'success', 2000);
        return true;
      },
    },
    {
      id: 'edit.columnNumber',
      title: '列编辑：列编号',
      category: '编辑',
      enabled: hasTab,
      run: () => {
        if (!requireRect('列编号')) return false;
        const res = columnNumber(view());
        if (!res.ok) {
          toast('列编号失败', 'info', 2400);
          return false;
        }
        toast(`已为 ${res.lines} 行编号`, 'success', 1800);
        return true;
      },
    },

    /* -------------------------------------------------- v2 特殊字符面板（T15） */
    {
      id: 'insert.char',
      title: '插入特殊字符…',
      category: '格式',
      keys: ['Mod-Alt-c'],
      enabled: hasTab,
      run: () => {
        openCharsDialog(app);
        return true;
      },
    },

    /* ----------------------------------------------------------- 插件生态（T22–T24）
     * 三个入口只做「打开 UI」，真正的安装/沙箱/鉴权都在 core/plugins/*。
     * 标题不含 ivory / nord / python，避免干扰 p1-check 的命令面板首项断言。 */
    {
      id: 'plugins.market',
      title: '插件市场',
      category: '插件',
      run: () => {
        if (typeof app.openPluginMarket === 'function') app.openPluginMarket();
        else toast('插件市场尚未就绪', 'info', 2000);
        return true;
      },
    },
    {
      id: 'plugins.importNpp',
      title: '从 Notepad++ 导入插件',
      category: '插件',
      run: () => {
        if (typeof app.openNppImport === 'function') void app.openNppImport();
        else toast('导入向导尚未就绪', 'info', 2000);
        return true;
      },
    },
    {
      id: 'plugins.installFromUrl',
      title: '从 URL 安装插件',
      category: '插件',
      run: () => {
        if (typeof app.openInstallFromUrl === 'function') app.openInstallFromUrl();
        else toast('安装入口尚未就绪', 'info', 2000);
        return true;
      },
    },

    /* ------------------------------------------------------ 标记颜色（T-mark） */
    {
      id: 'mark.red',
      title: '标记：红色',
      category: '标记',
      enabled: hasTab,
      run: () => applyMark(app, 'red'),
    },
    {
      id: 'mark.yellow',
      title: '标记：黄色',
      category: '标记',
      enabled: hasTab,
      run: () => applyMark(app, 'yellow'),
    },
    {
      id: 'mark.green',
      title: '标记：绿色',
      category: '标记',
      enabled: hasTab,
      run: () => applyMark(app, 'green'),
    },
    {
      id: 'mark.blue',
      title: '标记：蓝色',
      category: '标记',
      enabled: hasTab,
      run: () => applyMark(app, 'blue'),
    },
    {
      id: 'mark.purple',
      title: '标记：紫色',
      category: '标记',
      enabled: hasTab,
      run: () => applyMark(app, 'purple'),
    },
    {
      id: 'mark.clear',
      title: '清除标记',
      category: '标记',
      enabled: hasTab,
      run: () => clearMarksInSelection(app),
    },

    /* ------------------------------------------------------------- 帮助 */
    {
      id: 'help.shortcuts',
      title: '快捷键速查',
      category: '帮助',
      keys: ['F1'],
      global: true,
      run: () => shortcutsDialog(),
    },
    {
      id: 'help.about',
      title: '关于 QuillPad',
      category: '帮助',
      run: () => aboutDialog(),
    },

    /* ------------------------------------- Markdown 基础格式化（工具栏 / 命令面板） */
    {
      id: 'md.bold',
      title: '加粗',
      category: '格式',
      keys: ['Mod-b'],
      enabled: mdEnabled,
      run: () => wrapSelection(view(), '**', '**', '加粗文字'),
    },
    {
      id: 'md.italic',
      title: '斜体',
      category: '格式',
      keys: ['Mod-i'],
      enabled: mdEnabled,
      run: () => wrapSelection(view(), '*', '*', '斜体文字'),
    },
    {
      id: 'md.strike',
      title: '删除线',
      category: '格式',
      enabled: mdEnabled,
      run: () => wrapSelection(view(), '~~', '~~', '删除线'),
    },
    {
      id: 'md.inlineCode',
      title: '行内代码',
      category: '格式',
      enabled: mdEnabled,
      run: () => wrapSelection(view(), '`', '`', '代码'),
    },
    {
      id: 'md.link',
      title: '插入链接',
      category: '格式',
      enabled: mdEnabled,
      run: () => insertLink(view()),
    },
    {
      id: 'md.h1',
      title: '一级标题',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '# '),
    },
    {
      id: 'md.h2',
      title: '二级标题',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '## '),
    },
    {
      id: 'md.h3',
      title: '三级标题',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '### '),
    },
    {
      id: 'md.quote',
      title: '引用',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '> '),
    },
    {
      id: 'md.ul',
      title: '无序列表',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '- '),
    },
    {
      id: 'md.ol',
      title: '有序列表',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), (i) => `${i + 1}. `, { strip: /^\d+\.\s/ }),
    },
    {
      id: 'md.task',
      title: '任务列表',
      category: '格式',
      enabled: mdEnabled,
      run: () => prefixLines(view(), '- [ ] '),
    },
    {
      id: 'md.hr',
      title: '分隔线',
      category: '格式',
      enabled: mdEnabled,
      run: () => insertBlock(view(), '---'),
    },
    {
      id: 'md.codeBlock',
      title: '代码块',
      category: '格式',
      enabled: mdEnabled,
      run: () => {
        const v = view();
        const sel = v.state.selection.main;
        const insert = '```\n\n```';
        const cursor = sel.from + 4; // 落在两行围栏之间的空行
        v.dispatch({
          changes: { from: sel.from, to: sel.to, insert },
          selection: { anchor: cursor, head: cursor },
        });
        v.focus();
      },
    },
  ]);

  /* ------------------------------------------------------------------ 宏录制
   * 唯一的命令执行收口是 `runCommand()`，它在调用时才读 `cmd.run`，
   * 所以这里把注册表里的每条命令包一层记录器即可 —— 菜单 / 工具栏 /
   * 快捷键 / 命令面板四个入口全部覆盖，不需要各自埋点。
   * 非幂等命令不录（会弹保存对话框、覆盖文件），并给一次可见提示。 */
  for (const cmd of allCommands()) {
    const original = cmd.run;
    if (typeof original !== 'function' || original.__qpRecorded) continue;
    const wrapped = function wrappedRun(ctx, evt) {
      if (isRecording()) {
        if (NON_REPLAYABLE.has(cmd.id)) {
          toast(`「${cmd.title}」不会录进宏（回放时无法安全重放）`, 'info', 2400);
        } else {
          const v = app.editor && app.editor.view;
          const sel = v
            ? { anchor: v.state.selection.main.anchor, head: v.state.selection.main.head }
            : null;
          recordStep(cmd.id, undefined, sel);
        }
      }
      return original.call(this, ctx, evt);
    };
    wrapped.__qpRecorded = true;
    cmd.run = wrapped;
  }
}
