/**
 * QuillPad 图标库 —— 全部为自绘内联 SVG（24x24 viewBox，currentColor 描边）。
 * 不引用任何外部图标字体或 CDN 资源。
 */

/** @type {Record<string, string>} 图标内部路径集合 */
const PATHS = {
  /* 品牌 */
  feather:
    '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',

  /* 界面语言 */
  globe:
    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',

  /* 文件 */
  newFile:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  file:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  fileText:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  openFile:
    '<path d="M4 20V6a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v3"/><path d="M2.5 19.5 5 13h17l-2.5 6.5a2 2 0 0 1-1.9 1.5H4.4a2 2 0 0 1-1.9-1.5z"/>',
  openFolder:
    '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v2"/><path d="M2.6 19.4 5 12h17l-2.6 7.4A2 2 0 0 1 17.5 21H4.4a2 2 0 0 1-1.8-1.6z"/>',
  folder:
    '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z"/>',
  folderOpen:
    '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2"/><path d="M2.6 19.4 5 12h17l-2.6 7.4A2 2 0 0 1 17.5 21H4.4a2 2 0 0 1-1.8-1.6z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  saveAll:
    '<path d="M17 17H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v8a2 2 0 0 1-2 2z"/><path d="M15 15v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8"/><path d="M9 3v4h6"/>',

  /* 编辑 */
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 2.6-6.4L3 9"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-2.6-6.4L21 9"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',

  /* 搜索 */
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m20.5 20.5-5.4-5.4"/>',
  replace:
    '<path d="M4 4v6h6"/><path d="M4 10a8 8 0 0 1 14-3"/><path d="M20 20v-6h-6"/><path d="M20 14a8 8 0 0 1-14 3"/>',
  findInFiles:
    '<path d="M4 4v6h6"/><path d="M4 10a8 8 0 0 1 14-3"/><circle cx="13.5" cy="14.5" r="4.5"/><path d="m17.2 18.2 4 4"/>',

  /* 视图 */
  zoomIn: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="M10.5 7.5v6"/><path d="M7.5 10.5h6"/><path d="m20.5 20.5-5.4-5.4"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="M7.5 10.5h6"/><path d="m20.5 20.5-5.4-5.4"/>',
  wrap: '<path d="M4 6h16"/><path d="M4 12h13a3 3 0 1 1 0 6h-3"/><path d="m16.5 15.5-2.5 2.5 2.5 2.5"/><path d="M4 18h6"/>',
  sidebar:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  zen: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M4 12h16"/>',
  preview:
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M9 4v16"/><path d="M13 9h6"/><path d="M13 13h6"/><path d="M13 17h3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  autoSave:
    '<path d="M12 3v9"/><path d="m8 8 4 4 4-4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',

  /* 命令 */
  command:
    '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>',
  theme:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
  palette:
    '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="9.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.8 2.8 0 1 1 3.9 2.6c-.7.3-1.1 1-1.1 1.8v.4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none"/>',

  /* 通用 */
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  refresh:
    '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  alert:
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  code: '<path d="m15 6 6 6-6 6"/><path d="m9 18-6-6 6-6"/>',
  symbol:
    '<path d="M4 20V5h6a4 4 0 0 1 0 8H4"/><path d="M14 20V5h3a3 3 0 0 1 0 6h-3"/>',

  /* v2 · 视图模式（A1 分段控件） */
  sourceMode:
    '<path d="M8 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/><path d="M16 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3"/><path d="M10 8h4"/><path d="M10 12h4"/><path d="M10 16h2"/>',
  wysiwygMode:
    '<circle cx="12" cy="12" r="9"/><path d="M12 7.5a4.5 4.5 0 0 0 0 9 2.2 2.2 0 0 0 0-4.4 2.2 2.2 0 0 1 0-4.4z"/>',
  splitMode:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/><path d="M6 9h3"/><path d="M15 9h3"/>',

  /* v2 · 富内容 / 编辑辅助 */
  copyCode: '<path d="M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M5 15V4a2 2 0 0 1 2-2h9"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M3 15h18"/><path d="M10 4v16"/>',
  /* 删除行 / 删除列：两者原先共用 `trash`，在表格浮层里分不清。
     现在都用「两条边框 + 中间一个减号」表达「砍掉一整条」，方向区分意图：
     横条（上下两条边 + 中间横减号）= 删行，竖条（左右两条边 + 中间竖减号）= 删列。 */
  rowDelete: '<path d="M4 5h16"/><path d="M4 19h16"/><path d="M7 12h10"/>',
  colDelete: '<path d="M5 4v16"/><path d="M19 4v16"/><path d="M12 7v10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>',
  formula: '<path d="M4 20V6h8"/><path d="M4 13h6"/><path d="M14 20l6-9"/><path d="M20 20l-6-9"/>',
  footnote: '<path d="M6 4h6v16"/><path d="M9 4v16"/><path d="M15 9h5"/><path d="M15 14h5"/>',
  toc: '<path d="M4 6h16"/><path d="M7 12h13"/><path d="M10 18h10"/>',
  focusMode:
    '<circle cx="12" cy="12" r="3"/><path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M20 8V6a2 2 0 0 0-2-2h-2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/>',
  typewriter: '<path d="M4 7h16"/><path d="M7 12h10"/><path d="M9 17h6"/><path d="M12 20h.01"/>',
  minimap: '<rect x="15" y="4" width="6" height="16" rx="1"/><path d="M3 6h9"/><path d="M3 10h7"/><path d="M3 14h9"/><path d="M3 18h5"/>',

  /* Markdown 工具栏（24x24，currentColor 描边，Lucide 风格） */
  bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
  italic: '<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.8 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>',
  heading: '<path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/>',
  quote: '<path d="M4 5v14"/><path d="M8 8h11"/><path d="M8 12h11"/><path d="M8 16h7"/>',
  codeInline: '<path d="m9 8-4 4 4 4"/><path d="m15 8 4 4-4 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none"/>',
  listOrdered: '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 5h1v4"/><path d="M3.5 9h2"/><path d="M6 15H3l1.5-2H3"/>',
  listChecks: '<path d="m3 6 1.5 1.5L7 5"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/><path d="M11 6h10"/><path d="M11 12h10"/><path d="M11 18h10"/>',
  minus: '<path d="M5 12h14"/>',
};

/**
 * 生成一个内联 SVG 图标。
 * @param {string} name PATHS 中的键名
 * @param {number} size 像素尺寸，默认 16
 * @param {string} [extraClass] 额外 class
 * @return {string} SVG 字符串
 */
export function icon(name, size = 16, extraClass = '') {
  const d = PATHS[name] || PATHS.circle;
  return (
    `<svg class="icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${d}</svg>`
  );
}

/** 品牌 Logo（羽毛笔）SVG，用于标题栏与欢迎页。 */
export function brandSvg(size = 20) {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">` +
    `<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/>` +
    `<path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg>`
  );
}

export { PATHS as ICON_PATHS };
