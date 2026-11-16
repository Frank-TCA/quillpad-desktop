/**
 * QuillPad · §G0.1 能力边界声明（唯一原文来源）
 *
 * 市场首页横幅 / Npp 导入向导末页 / `.dll` 拒绝弹窗三处都引用 `EXPECTED_NOTICE`，
 * 保证 G5-15 的 `不存在 HWND` / `不加载任何 .dll` 可检索且不漂移。
 */

import { t } from '../i18n.js';

/**
 * 能力边界声明原文（5 条，顺序固定，不得改写）。
 *
 * 这是中文原文（也是 t() 的 key）：G5-15 的关键词断言直接在这份数组上跑，
 * 因此用单参数 t('中文原文') 保留恒定中文；英文副本放在 NOTICE_EN，
 * 由 localizedNotice() 在渲染点按语言取值。
 */
export const EXPECTED_NOTICE = Object.freeze([
  t('1. QuillPad v2 不加载任何 .dll，不是 Notepad++ 的二进制兼容宿主。'),
  t('2. 不支持任何依赖原生 Scintilla 控件句柄（_scintillaMainHandle）、NPPM_* 宿主消息、Docking Dialog、Lexer 接口或系统级注入的插件——QuillPad 的编辑区是 CodeMirror 6 的 DOM，不存在 HWND。'),
  t('3. 不支持 GPL / AGPL / SSPL 授权插件的分发与代装；Notepad++ 本体为 GPL-2.0、其官方插件库多数为 GPL，不能合法随 QuillPad 打包。'),
  t('4. 提供的是能力等价而非实现等价：Notepad++ 常用插件的高频功能子集由官方 MIT 插件包原生重写；不保证第三方插件的行为、配置格式与快捷键逐一一致。'),
  t('5. 用户自行从第三方渠道获取并安装 GPL 插件属用户个人行为，QuillPad 不加载、不代管、不承担其合规责任，但会在安装入口以 UI 明确提示风险。'),
]);

/** 5 条声明的英文副本，顺序与 EXPECTED_NOTICE 一一对应。 */
export const NOTICE_EN = Object.freeze([
  '1. QuillPad v2 loads no .dll files and is not a binary-compatible host for Notepad++.',
  '2. Plugins that depend on native Scintilla control handles (_scintillaMainHandle), NPPM_* host messages, Docking Dialog, Lexer interfaces or system-wide injection are not supported — QuillPad\'s editor is a CodeMirror 6 DOM with no HWND.',
  '3. Distribution and installation of GPL / AGPL / SSPL licensed plugins on a user\'s behalf is not supported; Notepad++ itself is GPL-2.0 and most of its official plugins are GPL, so they cannot legally be bundled with QuillPad.',
  '4. What we offer is capability equivalence, not implementation equivalence: a high-frequency subset of popular Notepad++ plugins has been natively rewritten as official MIT packages; third-party behaviour, configuration formats and shortcuts are not guaranteed to match one by one.',
  '5. Obtaining and installing GPL plugins from third-party sources is the user\'s own action. QuillPad does not load, manage or assume compliance responsibility for them, but clearly warns about the risk at the installation entry point in the UI.',
]);

/** G5-15 要求可检索的关键词。 */
export const NOTICE_KEYWORDS = Object.freeze([t('不存在 HWND'), t('不加载任何 .dll'), 'GPL', 'NPPM_*']);

/**
 * 按当前界面语言逐条取声明（读取点求值，避免 import 期冻结）。
 * @return {string[]}
 */
export function localizedNotice() {
  return EXPECTED_NOTICE.map((line, index) => t(line, NOTICE_EN[index] || line));
}

/**
 * 拼成可直接塞进 DOM 的纯文本。
 * @return {string}
 */
export function noticeText() {
  return localizedNotice().join('\n');
}

/**
 * 拼成 HTML（已转义）。
 * @param {(s: string) => string} escapeHtml
 * @return {string}
 */
export function noticeHtml(escapeHtml) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (s) => String(s);
  return localizedNotice().map((line) => `<p>${esc(line)}</p>`).join('');
}

/** `.dll` 拒绝弹窗正文第 2 段（G5-9 必须含 Scintilla / NPPM_ / GPL）。 */
export const DLL_REJECT_REASON =
  t('该类插件依赖 Scintilla 原生控件句柄（SCI_*）与宿主消息（NPPM_*），') +
  t('而 QuillPad 的编辑区是 CodeMirror 6 的 DOM，不存在 HWND；') +
  t('同时 Notepad++ 本体及其多数插件采用 GPL 授权，QuillPad 不分发、不加载 GPL 组件。');

/** DLL_REJECT_REASON 的英文副本，供 UI 在渲染点用 t() 取用。 */
export const DLL_REJECT_REASON_EN =
  'These plugins depend on native Scintilla control handles (SCI_*) and host messages (NPPM_*), ' +
  'while QuillPad’s editor is a CodeMirror 6 DOM with no HWND. ' +
  'Notepad++ itself and most of its plugins are GPL-licensed, and QuillPad neither distributes nor loads GPL components.';
