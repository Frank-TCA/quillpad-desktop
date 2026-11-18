/**
 * QuillPad · CodeMirror 主题
 *
 * 每套应用主题都配一份 CM 编辑器主题 + 语法高亮配色，
 * 保证切换主题时编辑区（含语法色）整体跟着换。
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** 可选主题清单（顺序即循环切换顺序）。 */
export const THEMES = [
  { id: 'aurora', label: 'Aurora Dark', dark: true },
  { id: 'ivory', label: 'Ivory Light', dark: false },
  { id: 'nord', label: 'Nord', dark: true },
  { id: 'solarized', label: 'Solarized Light', dark: false },
];

/** @type {Map<string, {id: string, label: string, dark: boolean}>} */
const THEME_BY_ID = new Map(THEMES.map((x) => [x.id, x]));

/**
 * @typedef {object} EditorPalette
 * @property {string} bg 编辑区底色
 * @property {string} fg 正文色
 * @property {string} caret 光标色
 * @property {string} selection 选区底色
 * @property {string} activeLine 当前行底色
 * @property {string} gutterBg 行号槽底色
 * @property {string} gutterFg 行号色
 * @property {string} gutterActive 当前行号色
 * @property {string} border 分隔线
 * @property {string} match 搜索命中底色
 * @property {string} matchSelected 当前命中底色
 * @property {string} bracket 括号匹配底色
 * @property {string} popup 悬浮层底色
 * @property {string} popupBorder 悬浮层描边
 */

/**
 * 每套主题的编辑器调色板 + 语法色。
 * @type {Record<string, EditorPalette & Record<string, any>>}
 */
const PALETTES = {
  aurora: {
    dark: true,
    bg: '#0d1015',
    fg: '#dbe3ec',
    caret: '#6ea8fe',
    selection: '#1e3552',
    activeLine: 'rgba(110,168,254,0.055)',
    gutterBg: '#0d1015',
    gutterFg: '#737f8f',
    gutterActive: '#9fb3cc',
    border: '#1b222b',
    match: 'rgba(226,179,65,0.22)',
    matchSelected: 'rgba(226,179,65,0.45)',
    bracket: 'rgba(180,140,255,0.28)',
    popup: '#171c24',
    popupBorder: '#2e3742',
    /* 语法 */
    keyword: '#c792ea',
    control: '#8b9cff',
    string: '#8fd1a8',
    number: '#f0a97a',
    comment: '#707c8d',
    name: '#dbe3ec',
    def: '#6ea8fe',
    type: '#63d3c4',
    prop: '#b48cff',
    tag: '#ef8f8f',
    attr: '#e2b341',
    op: '#9aa7b8',
    punct: '#7b8797',
    invalid: '#ef6a6a',
    heading: '#6ea8fe',
    link: '#b48cff',
    meta: '#7f8ea3',
    insert: '#4ec9a8',
    delete: '#ef6a6a',
  },
  ivory: {
    dark: false,
    bg: '#ffffff',
    fg: '#1c2126',
    caret: '#2563eb',
    selection: '#cfe0fc',
    activeLine: 'rgba(37,99,235,0.045)',
    gutterBg: '#ffffff',
    gutterFg: '#6b7583',
    gutterActive: '#2563eb',
    border: '#eceff3',
    match: 'rgba(234,179,8,0.32)',
    matchSelected: 'rgba(234,179,8,0.62)',
    bracket: 'rgba(124,58,237,0.16)',
    popup: '#ffffff',
    popupBorder: '#dfe3e9',
    keyword: '#7c3aed',
    control: '#4f46e5',
    string: '#0f7b4f',
    number: '#b45309',
    comment: '#6c7786',
    name: '#1c2126',
    def: '#2563eb',
    type: '#0e7490',
    prop: '#9333ea',
    tag: '#b91c1c',
    attr: '#9a6700',
    op: '#4b5563',
    punct: '#6b7280',
    invalid: '#d93a3a',
    heading: '#1d4ed8',
    link: '#7c3aed',
    meta: '#6b7280',
    insert: '#12805c',
    delete: '#d93a3a',
  },
  nord: {
    dark: true,
    bg: '#2b3038',
    fg: '#dfe6f0',
    caret: '#88c0d0',
    selection: '#3b4859',
    activeLine: 'rgba(136,192,208,0.06)',
    gutterBg: '#2b3038',
    gutterFg: '#939fb0',
    gutterActive: '#a9bccb',
    border: '#353c46',
    match: 'rgba(235,203,139,0.22)',
    matchSelected: 'rgba(235,203,139,0.46)',
    bracket: 'rgba(180,142,173,0.3)',
    popup: '#313741',
    popupBorder: '#4a5563',
    keyword: '#81a1c1',
    control: '#8fbcbb',
    string: '#a3be8c',
    number: '#b48ead',
    comment: '#8d98a6',
    name: '#dfe6f0',
    def: '#88c0d0',
    type: '#8fbcbb',
    prop: '#d8a0c0',
    tag: '#e0787c',
    attr: '#ebcb8b',
    op: '#9aa7b8',
    punct: '#8c99a8',
    invalid: '#e0787c',
    heading: '#88c0d0',
    link: '#b48ead',
    meta: '#8c99a8',
    insert: '#a3be8c',
    delete: '#e0787c',
  },
  solarized: {
    dark: false,
    bg: '#fdf6e3',
    fg: '#40525f',
    caret: '#1f72ac',
    selection: '#e3ddc7',
    activeLine: 'rgba(38,139,210,0.05)',
    gutterBg: '#fdf6e3',
    gutterFg: '#586e75',
    gutterActive: '#1f72ac',
    border: '#efe7d0',
    match: 'rgba(181,137,0,0.26)',
    matchSelected: 'rgba(181,137,0,0.5)',
    bracket: 'rgba(108,113,196,0.18)',
    popup: '#fdf6e3',
    popupBorder: '#ded6bd',
    keyword: '#657400',
    control: '#657400',
    string: '#207a73',
    number: '#c82c77',
    comment: '#617070',
    name: '#40525f',
    def: '#1f72ac',
    type: '#8a6800',
    prop: '#5e64bf',
    tag: '#d22623',
    attr: '#8a6800',
    op: '#586e75',
    punct: '#5c7077',
    invalid: '#d22623',
    heading: '#1f72ac',
    link: '#5e64bf',
    meta: '#617070',
    insert: '#657400',
    delete: '#d22623',
  },
};

/**
 * 创建编辑器主题扩展。
 * @param {Record<string, any>} p
 * @return {import('@codemirror/state').Extension}
 */
function makeEditorTheme(p) {
  return EditorView.theme(
    {
      '&': {
        color: p.fg,
        backgroundColor: p.bg,
        height: '100%',
      },
      '.cm-scroller': {
        fontFamily:
          '"JetBrains Mono","Cascadia Code","Fira Code",Consolas,"Microsoft YaHei",monospace',
        lineHeight: '1.62',
      },
      '.cm-content': {
        caretColor: p.caret,
        padding: '10px 0',
      },
      '.cm-line': {
        /* 行盒左右呼吸区走变量：源码 / 分栏保持 6 / 14px（等宽代码需要贴边的
           点选边缘），所见即所得在 `.qp-wy` 上把两个变量置 0 —— 那样正文、
           分隔线、表格、引用才共用同一条 46em 内容边界。
           不能直接用一条 `.qp-wy .cm-line { padding: 0 }` 去覆盖：那会把
           `.cm-line.qp-quote` / `.qp-li` 自己的缩进一起压掉（特异性更高）。 */
        padding: '0 var(--qp-line-pad-r, 14px) 0 var(--qp-line-pad-l, 6px)',
      },
      '&.cm-focused .cm-cursor, .cm-cursor': {
        borderLeftColor: p.caret,
        borderLeftWidth: '2px',
      },
      '&.cm-focused .cm-dropCursor, .cm-dropCursor': {
        borderLeftColor: p.caret,
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: p.selection,
      },
      '.cm-activeLine': {
        backgroundColor: p.activeLine,
      },
      '.cm-gutters': {
        backgroundColor: p.gutterBg,
        color: p.gutterFg,
        borderRight: `1px solid ${p.border}`,
        userSelect: 'none',
      },
      '.cm-activeLineGutter': {
        backgroundColor: p.activeLine,
        color: p.gutterActive,
      },
      '.cm-lineNumbers .cm-gutterElement': {
        /* 槽宽收紧：原先 `0 10px 0 16px` + minWidth 42px 让两位行号也占 42px，
           实际数字只有 16px 宽，行号栏里一半是空白。改成 12/8 的呼吸区、
           minWidth 36px —— 两位数正好贴住，四位数仍按内容自动撑开。
           源码模式与所见即所得共用这一条，两边宽度恒等。 */
        padding: '0 8px 0 12px',
        minWidth: '36px',
      },
      '.cm-foldGutter .cm-gutterElement': {
        padding: '0 4px',
        cursor: 'pointer',
        color: p.gutterFg,
      },
      '.cm-foldGutter .cm-gutterElement:hover': {
        color: p.gutterActive,
      },
      '.cm-selectionMatch': {
        backgroundColor: p.match,
        borderRadius: '2px',
      },
      '.cm-searchMatch': {
        backgroundColor: p.match,
        outline: `1px solid ${p.matchSelected}`,
        borderRadius: '2px',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: p.matchSelected,
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: p.bracket,
        outline: `1px solid ${p.matchSelected}`,
        borderRadius: '2px',
      },
      '.cm-tooltip': {
        backgroundColor: p.popup,
        border: `1px solid ${p.popupBorder}`,
        borderRadius: '8px',
        boxShadow: '0 8px 28px rgba(0,0,0,.35)',
        overflow: 'hidden',
        color: p.fg,
      },
      '.cm-tooltip-autocomplete > ul': {
        fontFamily:
          '"JetBrains Mono","Cascadia Code",Consolas,"Microsoft YaHei",monospace',
        fontSize: '12px',
        maxHeight: '220px',
      },
      '.cm-tooltip-autocomplete > ul > li': {
        padding: '4px 10px',
        lineHeight: '1.5',
      },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        backgroundColor: p.bracket,
        color: p.fg,
      },
      '.cm-completionDetail': {
        fontStyle: 'normal',
        opacity: 0.6,
        marginLeft: '8px',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: p.bracket,
        border: 'none',
        color: p.fg,
        padding: '0 6px',
        borderRadius: '4px',
        margin: '0 2px',
      },
      '.cm-panels': {
        backgroundColor: p.bg,
        color: p.fg,
      },
      '.cm-placeholder': {
        color: p.gutterFg,
      },
      '.cm-scroller::-webkit-scrollbar': {
        width: '10px',
        height: '10px',
      },
      '.cm-scroller::-webkit-scrollbar-thumb': {
        backgroundColor: p.dark ? '#2a323d' : '#cdd3dc',
        borderRadius: '999px',
        border: '3px solid transparent',
        backgroundClip: 'padding-box',
      },
      '.cm-scroller::-webkit-scrollbar-thumb:hover': {
        backgroundColor: p.dark ? '#3d4956' : '#aab3c0',
      },
      '.cm-scroller::-webkit-scrollbar-track': {
        backgroundColor: 'transparent',
      },
    },
    { dark: p.dark },
  );
}

/**
 * 创建语法高亮样式。
 * @param {Record<string, any>} p
 * @return {HighlightStyle}
 */
function makeHighlightStyle(p) {
  return HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword], color: p.keyword, fontWeight: '600' },
    {
      tag: [t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
      color: p.control,
      fontWeight: '600',
    },
    { tag: [t.string, t.special(t.string), t.docString], color: p.string },
    { tag: [t.character, t.attributeValue], color: p.string },
    { tag: [t.number, t.integer, t.float, t.unit], color: p.number },
    { tag: [t.bool, t.null, t.atom], color: p.number, fontWeight: '600' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.variableName, t.name], color: p.name },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: p.def },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.def },
    { tag: [t.definition(t.function(t.variableName))], color: p.def, fontWeight: '600' },
    { tag: [t.className, t.definition(t.className), t.typeName, t.namespace], color: p.type },
    { tag: [t.propertyName], color: p.prop },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.attr },
    { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator], color: p.op },
    {
      tag: [t.punctuation, t.separator, t.bracket, t.angleBracket, t.paren, t.brace, t.squareBracket],
      color: p.punct,
    },
    { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], color: p.meta },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], color: p.heading, fontWeight: '700' },
    { tag: [t.link, t.url], color: p.link, textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: '700' },
    { tag: [t.strikethrough], textDecoration: 'line-through' },
    { tag: [t.inserted], color: p.insert },
    { tag: [t.deleted], color: p.delete },
    { tag: [t.invalid], color: p.invalid, textDecoration: 'underline wavy' },
    { tag: [t.regexp, t.escape], color: p.number },
    { tag: [t.color, t.constant(t.variableName)], color: p.number },
    { tag: [t.self], color: p.keyword, fontStyle: 'italic' },
    { tag: [t.macroName], color: p.def },
    { tag: [t.labelName], color: p.prop },
    { tag: [t.list], color: p.keyword },
    { tag: [t.quote], color: p.comment },
  ]);
}

/**
 * 文档（WYSIWYG）模式的着色：**只保留代码语义色**，Markdown 结构色全部交给
 * 装饰层（`.qp-h*` / `.qp-node-*`）去表达。
 *
 * 为什么必须单独一套：源码 / 分屏里标题染语法蓝、加粗染紫、链接加下划线是
 * 编辑器该有的高亮；但所见即所得的基准是分屏预览，那些颜色会盖掉装饰层
 * 设在父级节点上的 `color`，于是标题变蓝、粗体变紫，与预览对不上。
 *
 * 这里刻意不定义的 tag：heading / link / url / emphasis / strong /
 * strikethrough / list / quote / meta / 各类标点 —— 不定义即不着色，
 * 文本颜色回落到 `.cm-line` 的 `--text`，由装饰层决定最终表现。
 *
 * @param {object} p 调色板
 * @return {HighlightStyle}
 */
function makeDocHighlightStyle(p) {
  return HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword], color: p.keyword, fontWeight: '600' },
    {
      tag: [t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
      color: p.control,
      fontWeight: '600',
    },
    { tag: [t.string, t.special(t.string), t.docString], color: p.string },
    { tag: [t.character, t.attributeValue], color: p.string },
    { tag: [t.number, t.integer, t.float, t.unit], color: p.number },
    { tag: [t.bool, t.null, t.atom], color: p.number, fontWeight: '600' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.variableName, t.name], color: p.name },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: p.def },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.def },
    { tag: [t.definition(t.function(t.variableName))], color: p.def, fontWeight: '600' },
    { tag: [t.className, t.definition(t.className), t.typeName, t.namespace], color: p.type },
    { tag: [t.propertyName], color: p.prop },
    { tag: [t.tagName], color: p.tag },
    { tag: [t.attributeName], color: p.attr },
    { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator], color: p.op },
    { tag: [t.regexp, t.escape], color: p.number },
    { tag: [t.color, t.constant(t.variableName)], color: p.number },
    { tag: [t.macroName], color: p.def },
    { tag: [t.self], color: p.keyword, fontStyle: 'italic' },
  ]);
}

/** 主题扩展缓存。 */
const cache = new Map();

/**
 * 取主题定义。
 * @param {string} id
 * @return {{id: string, label: string, dark: boolean}}
 */
export function getThemeMeta(id) {
  return THEME_BY_ID.get(id) || THEMES[0];
}

/**
 * 取主题的语法高亮配色（PDF 导出「跟随主题」用）。
 *
 * 字段与 `print.js` 的 `--tok-*` 变量一一对应；`function` 取 def
 * （定义/调用名），与编辑器 HighlightStyle 的着色口径一致。
 * @param {string} id 主题 id
 * @return {{bg: string, fg: string, border: string, keyword: string, string: string,
 *           number: string, comment: string, function: string, type: string,
 *           punct: string, dark: boolean}}
 */
export function getThemeSyntaxPalette(id) {
  const meta = getThemeMeta(id);
  const p = PALETTES[meta.id] || PALETTES.aurora;
  return {
    bg: p.bg,
    fg: p.fg,
    border: p.border,
    keyword: p.keyword,
    string: p.string,
    number: p.number,
    comment: p.comment,
    function: p.def,
    type: p.type,
    punct: p.punct,
    dark: !!p.dark,
  };
}

/**
 * 取某主题的 CodeMirror **皮肤**扩展（已缓存）。
 *
 * 只含 `makeEditorTheme`（颜色变量、行号、选区等）；语法着色拆到
 * {@link getSyntaxExtension}，因为所见即所得要用另一套中性配色。
 *
 * @param {string} id 主题 id
 * @return {import('@codemirror/state').Extension}
 */
export function getEditorThemeExtension(id) {
  const meta = getThemeMeta(id);
  if (cache.has(meta.id)) return cache.get(meta.id);
  const palette = PALETTES[meta.id] || PALETTES.aurora;
  const ext = makeEditorTheme(palette);
  cache.set(meta.id, ext);
  return ext;
}

/** 语法着色扩展缓存（key = 主题 + 模式）。 */
const syntaxCache = new Map();

/**
 * 取某主题的语法着色扩展。
 *
 * @param {string} id 主题 id
 * @param {'code'|'doc'} [mode] `code`：源码/分屏，全量语法色；
 *   `doc`：所见即所得，只保留代码语义色，Markdown 结构色交给装饰层。
 * @return {import('@codemirror/state').Extension}
 */
export function getSyntaxExtension(id, mode = 'code') {
  const meta = getThemeMeta(id);
  const key = `${meta.id}|${mode}`;
  if (syntaxCache.has(key)) return syntaxCache.get(key);
  const p = PALETTES[meta.id] || PALETTES.aurora;
  const ext = syntaxHighlighting(mode === 'doc' ? makeDocHighlightStyle(p) : makeHighlightStyle(p));
  syntaxCache.set(key, ext);
  return ext;
}

/**
 * 行号槽的固定字号（像素）。
 *
 * 行号 / 折叠箭头等 gutter 元素是 `.cm-scroller` 的子节点，会跟着正文字号一起
 * 缩放 —— 正文调到 300px 时行号也会变成 300px，槽宽被撑到 500px 以上，把正文
 * 挤到几乎没有。
 *
 * 所以 gutter 恒为 14px：**放大不跟、缩小也不跟**。正文 14–300px 全程行号纹丝
 * 不动，槽宽稳定；正文最小 14px（见 `FONT_SIZE_MIN`），也永远不会出现「行号比
 * 正文还大」的倒挂。
 */
export const GUTTER_FONT_SIZE = 14;

/**
 * 生成「字体大小 / 缩进 / 自动换行」等外观扩展。
 * @param {{fontSize: number, indentSize: number, useTabs: boolean, wordWrap: boolean}} opts
 * @return {import('@codemirror/state').Extension[]}
 */
export function buildAppearanceExtension(opts) {
  const fontSize = opts.fontSize;
  const indentSize = opts.indentSize;
  const exts = [
    EditorView.theme({
      '.cm-scroller': { fontSize: `${fontSize}px` },
      // 行号槽不跟随正文缩放：恒为 GUTTER_FONT_SIZE（14px），放大缩小都不动。
      // 行号元素的高度由 CM 按行盒写死，字号不变也能逐行对齐，不会错行。
      '.cm-gutters': { fontSize: `${GUTTER_FONT_SIZE}px` },
      '.cm-content': {
        tabSize: String(indentSize),
      },
    }),
    EditorView.contentAttributes.of({ 'data-indent': String(indentSize) }),
  ];
  void opts.useTabs;
  void opts.wordWrap;
  return exts;
}

export { PALETTES as EDITOR_PALETTES };
