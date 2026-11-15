/**
 * 首次运行时的欢迎文档内容。
 * 关闭所有标签后，主界面会显示独立的欢迎页（见 ui/welcome.js）。
 */

const TICK = '```';

/** 欢迎文档（Markdown），用于展示 QuillPad 的排版与语法高亮能力。 */
export const WELCOME_MD = `# 欢迎使用 QuillPad

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
`;

/** 一个新文件的默认名称模板。 */
export function untitledName(index) {
  return index <= 1 ? '未命名.txt' : `未命名${index}.txt`;
}
