/**
 * QuillPad · 代码块着色
 *
 * 渲染层（分屏预览）与导出层（PDF / 打印）共用同一份实现：拿语言 id 找到
 * CodeMirror 的 lezer 解析器，用 `classHighlighter` 产出 `tok-*` 类名的 span，
 * 颜色由 CSS 里的 `--tok-*` 变量决定（跟随当前主题的语法色）。
 *
 * 之所以自己做而不是用 highlight.js 之类：项目里已经带了 40 种 CodeMirror
 * 语言包，WYSIWYG 与预览用同一套解析器 + 同一份配色，才不会「编辑器里是彩的、
 * 预览里是灰的」。
 */

import { escapeHtml } from './utils.js';
import { loadLanguage, pickLanguage, resolveLangId } from '../editor/languages.js';

export { resolveLangId };

/**
 * 给一段代码上色。
 *
 * 语言包拿不到（比如 `plaintext` 或加载失败）时原样返回转义文本 —— 宁可不彩色，
 * 也不能因为高亮失败而丢代码。
 *
 * @param {string} code 源码
 * @param {string} langId 语言 id（已经过 `resolveLangId` 归一）
 * @return {Promise<string>} 已转义的 HTML
 */
export async function highlightCode(code, langId) {
  if (!code) return '';
  if (!langId || langId === 'plaintext' || langId === 'markdown') return escapeHtml(code);
  try {
    const [{ highlightTree, classHighlighter }, ext] = await Promise.all([
      import('@lezer/highlight'),
      loadLanguage(langId),
    ]);
    const language = pickLanguage(ext);
    if (!language || !language.parser) return escapeHtml(code);
    const tree = language.parser.parse(code);

    let out = '';
    let pos = 0;
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (from > pos) out += escapeHtml(code.slice(pos, from));
      out += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
      pos = to;
    });
    if (pos < code.length) out += escapeHtml(code.slice(pos));
    return out;
  } catch (err) {
    console.warn('[QuillPad] 代码着色失败，回退纯文本：', err && err.message);
    return escapeHtml(code);
  }
}
