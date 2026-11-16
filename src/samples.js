/**
 * 首次运行时的欢迎文档内容。
 * 关闭所有标签后，主界面会显示独立的欢迎页（见 ui/welcome.js）。
 */

import { t, getLocale } from './core/i18n.js';

const TICK = '```';

/** 欢迎文档（Markdown），用于展示 QuillPad 的排版与语法高亮能力。 */
const WELCOME_MD_ZH = t(`# 欢迎使用 QuillPad

> 一支安静的羽毛笔，写给认真写字的人。QuillPad 是一个用 TypeScript 之外的一切
> 现代 Web 能力堆出来的桌面级文本 / 代码编辑器：多标签、文件夹树、全文检索、
> 命令面板、四套主题、Markdown 实时预览，一个都不少。

---

## 从这里开始

| 想做什么 | 快捷键 | 说明 |
| --- | --- | --- |
| 新建文件 | \`Ctrl + N\` | 立刻写下第一行 |
| 打开文件 | \`Ctrl + O\` | 支持多选，直接落到标签页 |
| 打开文件夹 | \`Ctrl + K O\` | 左侧出现可展开的文件树 |
| 保存 | \`Ctrl + S\` | 写回原位置，无需另存 |
| 命令面板 | \`Ctrl + Shift + P\` | 所有能力，一句话召唤 |

> 提示：如果浏览器支持 File System Access API（Chrome / Edge），QuillPad 会
> **真正写回磁盘文件**；否则自动降级为下载保存，并在右下角提示。

---

## 编辑能力一览

- **多光标**：\`Ctrl + Alt + ↑ / ↓\` 向上、向下追加光标
- **整行操作**：\`Ctrl + D\` 复制当前行，\`Ctrl + Shift + K\` 删除当前行
- **移动行**：\`Alt + ↑ / ↓\`
- **注释切换**：\`Ctrl + /\`
- **选区高亮**：选中任意词，全文同名内容自动高亮
- **括号匹配**：光标停在括号旁试试看
- **代码折叠**：鼠标移到行号槽的折叠箭头

---

## 一套看得见的代码

${TICK}typescript
interface Document {
  readonly id: string;
  name: string;
  content: string;
  language: LanguageId;
  eol: 'LF' | 'CRLF';
}

/** 归纳标签状态，用于状态栏渲染。 */
export function summarize(docs: readonly Document[]) {
  const dirty = docs.filter((d) => d.content.length > 0);
  return {
    total: docs.length,
    dirty: dirty.length,
    bytes: docs.reduce((sum, d) => sum + d.content.length, 0),
  };
}
${TICK}

${TICK}python
def read_text(path: str) -> str:
    """按 UTF-8 读取；失败时回退到 GBK。"""
    raw = open(path, "rb").read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk")
${TICK}

---

## 主题

四套主题，编辑区的语法配色会整体跟着换：

1. **Aurora Dark** —— 默认。深空底色 + 蓝紫渐变强调色
2. **Ivory Light** —— 纸白底，长时间阅读更舒服
3. **Nord** —— 冷调灰蓝，夜里的第二选择
4. **Solarized Light** —— 经典暖色低对比方案

用 \`Ctrl + K T\` 循环切换，选择会被记住。

---

## 一些小细节

- 状态栏可以点：语言、缩进、换行符、编码都是可切换的
- 侧栏右边缘可以拖动调整宽度，双击恢复默认
- 标签页可以拖动排序，中键关闭，右键有更多操作
- 打开超过 2MB 的文件时，QuillPad 会关掉语法高亮以保证流畅
- 按 \`F1\` 随时查看完整快捷键表

---

*现在，关掉这个标签，开始写你自己的东西吧。*
`);

/** 欢迎文档（Markdown，英文）。主题名 / 语言名是专有名词，保持原样。 */
const WELCOME_MD_EN = `# Welcome to QuillPad

> A quiet quill for people who take writing seriously. QuillPad is a desktop-grade
> text / code editor built with every modern web capability except TypeScript:
> tabs, a folder tree, full-text search, a command palette, four themes and live
> Markdown preview — all of them included.

---

## Getting Started

| What you want | Shortcut | Notes |
| --- | --- | --- |
| New file | \`Ctrl + N\` | Start writing the first line right away |
| Open file | \`Ctrl + O\` | Multi-select supported; files land straight in tabs |
| Open folder | \`Ctrl + K O\` | An expandable file tree appears on the left |
| Save | \`Ctrl + S\` | Writes back in place, no Save As needed |
| Command palette | \`Ctrl + Shift + P\` | Every feature, one phrase away |

> Tip: if the browser supports the File System Access API (Chrome / Edge), QuillPad
> will **really write back to files on disk**; otherwise it falls back to a download
> and shows a notice in the lower-right corner.

---

## Editing at a Glance

- **Multiple cursors**: \`Ctrl + Alt + ↑ / ↓\` adds a cursor above or below
- **Whole-line operations**: \`Ctrl + D\` duplicates the current line, \`Ctrl + Shift + K\` deletes it
- **Move lines**: \`Alt + ↑ / ↓\`
- **Toggle comment**: \`Ctrl + /\`
- **Selection highlight**: select any word and matching text is highlighted document-wide
- **Bracket matching**: park the caret next to a bracket and see
- **Code folding**: hover over the fold arrow in the line-number gutter

---

## Code You Can Actually See

${TICK}typescript
interface Document {
  readonly id: string;
  name: string;
  content: string;
  language: LanguageId;
  eol: 'LF' | 'CRLF';
}

/** Summarize tab state for the status bar. */
export function summarize(docs: readonly Document[]) {
  const dirty = docs.filter((d) => d.content.length > 0);
  return {
    total: docs.length,
    dirty: dirty.length,
    bytes: docs.reduce((sum, d) => sum + d.content.length, 0),
  };
}
${TICK}

${TICK}python
def read_text(path: str) -> str:
    """Read as UTF-8; fall back to GBK on failure."""
    raw = open(path, "rb").read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk")
${TICK}

---

## Themes

Four themes. The syntax colours in the editor change along with them:

1. **Aurora Dark** — the default. Deep-space background with blue-violet accents
2. **Ivory Light** — paper white, easier on the eyes during long reading sessions
3. **Nord** — cool grey-blue, a second choice for night work
4. **Solarized Light** — a classic warm, low-contrast palette

Cycle through them with \`Ctrl + K T\`; your choice is remembered.

---

## Small Details

- The status bar is clickable: language, indent, line endings and encoding can all be switched
- Drag the right edge of the sidebar to resize it; double-click to restore the default
- Tabs can be reordered by dragging, closed with the middle button, and right-clicked for more actions
- When a file larger than 2 MB is opened, QuillPad turns off syntax highlighting to stay responsive
- Press \`F1\` any time for the full shortcut list

---

*Now close this tab and start writing your own things.*
`;

/**
 * 按当前界面语言返回欢迎文档。
 *
 * 必须在读取点调用：`main.js` 的 `setLocale()` 晚于本模块的 import 期，
 * 顶层常量会把语言冻结成默认中文。
 *
 * @return {string}
 */
export function welcomeMarkdown() {
  return getLocale() === 'en' ? WELCOME_MD_EN : WELCOME_MD_ZH;
}

/**
 * 欢迎文档的两种标签名 / 虚拟文档路径（中文名与英文名成对，作为标识逐一
 * 匹配用；显示用的标签名在渲染点经 t('欢迎.md','Welcome.md') 取值）。
 * @type {readonly [string, string]}
 */
export const WELCOME_NAMES = ['欢迎.md', 'Welcome.md'];

/**
 * 判断正文是否仍是某语言版本的欢迎模板原文。
 * 切换界面语言时据此决定能否安全替换正文：仍是模板（或会话瘦身恢复出的
 * 空正文）就整体换成当前语言模板；用户改过的一律不动，只改标签名。
 * @param {string} content
 * @return {boolean}
 */
export function isWelcomeTemplate(content) {
  return content === WELCOME_MD_ZH || content === WELCOME_MD_EN;
}

/**
 * 兼容既有 `import { WELCOME_MD }` 的常量导出（导出时按 `getLocale()` 取一份）。
 * 新建欢迎标签时请改用 `welcomeMarkdown()`，以便切换语言后立即生效。
 */
export const WELCOME_MD = welcomeMarkdown();

/**
 * 一个新文件的默认名称模板。
 * @param {number} index
 * @return {string}
 */
export function untitledName(index) {
  return index <= 1
    ? t('未命名.txt', 'Untitled.txt')
    : t(`未命名${index}.txt`, `Untitled${index}.txt`);
}
