/**
 * QuillPad · §G0.1 能力边界声明（唯一原文来源）
 *
 * 市场首页横幅 / Npp 导入向导末页 / `.dll` 拒绝弹窗三处都引用 `EXPECTED_NOTICE`，
 * 保证 G5-15 的 `不存在 HWND` / `不加载任何 .dll` 可检索且不漂移。
 */

/** 能力边界声明原文（5 条，顺序固定，不得改写）。 */
export const EXPECTED_NOTICE = Object.freeze([
  '1. QuillPad v2 不加载任何 .dll，不是 Notepad++ 的二进制兼容宿主。',
  '2. 不支持任何依赖原生 Scintilla 控件句柄（_scintillaMainHandle）、NPPM_* 宿主消息、Docking Dialog、Lexer 接口或系统级注入的插件——QuillPad 的编辑区是 CodeMirror 6 的 DOM，不存在 HWND。',
  '3. 不支持 GPL / AGPL / SSPL 授权插件的分发与代装；Notepad++ 本体为 GPL-2.0、其官方插件库多数为 GPL，不能合法随 QuillPad 打包。',
  '4. 提供的是能力等价而非实现等价：Notepad++ 常用插件的高频功能子集由官方 MIT 插件包原生重写；不保证第三方插件的行为、配置格式与快捷键逐一一致。',
  '5. 用户自行从第三方渠道获取并安装 GPL 插件属用户个人行为，QuillPad 不加载、不代管、不承担其合规责任，但会在安装入口以 UI 明确提示风险。',
]);

/** G5-15 要求可检索的关键词。 */
export const NOTICE_KEYWORDS = Object.freeze(['不存在 HWND', '不加载任何 .dll', 'GPL', 'NPPM_*']);

/**
 * 拼成可直接塞进 DOM 的纯文本。
 * @return {string}
 */
export function noticeText() {
  return EXPECTED_NOTICE.join('\n');
}

/**
 * 拼成 HTML（已转义）。
 * @param {(s: string) => string} escapeHtml
 * @return {string}
 */
export function noticeHtml(escapeHtml) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s);
  return EXPECTED_NOTICE.map((line) => `<p>${esc(line)}</p>`).join('');
}

/** `.dll` 拒绝弹窗正文第 2 段（G5-9 必须含 Scintilla / NPPM_ / GPL）。 */
export const DLL_REJECT_REASON =
  '该类插件依赖 Scintilla 原生控件句柄（SCI_*）与宿主消息（NPPM_*），' +
  '而 QuillPad 的编辑区是 CodeMirror 6 的 DOM，不存在 HWND；' +
  '同时 Notepad++ 本体及其多数插件采用 GPL 授权，QuillPad 不分发、不加载 GPL 组件。';
