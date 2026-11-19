/**
 * QuillPad · Markdown 渲染
 * 使用 marked 解析，并做一层轻量净化（移除脚本与事件属性）。
 * 由于所有内容都来自本机文件、且渲染在本地页面里，这里采用白名单式清理即可。
 */

import { marked } from 'marked';
import { t } from './i18n.js';
import { isDelimiterRow, rowHasPipe } from '../editor/wysiwyg/table-model.js';
import { promoteLooseEmphasis } from '../editor/wysiwyg/loose-emphasis.js';

marked.setOptions({
  gfm: true,
  breaks: false,
});

/** 代码围栏起始行。 */
const RE_FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** 「另一个块级结构」的开头：这类行本来就由 GFM 自己结束表格，不必补空行。 */
const RE_BLOCK_START = /^\s{0,3}(?:>|#{1,6}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,}|\$\$)/;

/**
 * 在「表格后面紧跟普通正文」处补一个空行，让表格在那里结束。
 *
 * 为什么需要：GFM 规定表格一直续到空行或另一个块级结构为止，所以
 * `| a | b |` 下面那行 `你好` 会被当成一行表格（`你好` + 空单元格）——
 * GitHub 与 marked 都这样。编辑器里这非常反直觉（看上去像正文被吞进表格），
 * 而且所见即所得的块层也按同一规则收窄了表格范围（见 `scan.js`），
 * 两处必须一致，否则同一个文档在两个窗格里长得不一样。
 *
 * 只影响**渲染输入**，不改文档；代码围栏内原样跳过。
 *
 * @param {string} text
 * @return {string}
 */
function breakTableTails(text) {
  const lines = String(text).split('\n');
  const out = [];
  let fence = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = RE_FENCE_LINE.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = '';
      continue;
    }
    if (m) {
      fence = m[1];
      out.push(line);
      continue;
    }
    // 表头行 + 分隔行都带竖线，才算一张表的开头
    if (
      rowHasPipe(line) &&
      i + 1 < lines.length &&
      rowHasPipe(lines[i + 1]) &&
      isDelimiterRow(lines[i + 1])
    ) {
      out.push(line, lines[i + 1]);
      let j = i + 2;
      while (j < lines.length && rowHasPipe(lines[j])) {
        out.push(lines[j]);
        j += 1;
      }
      if (j < lines.length) {
        const tail = lines[j];
        if (tail.trim() !== '' && !RE_BLOCK_START.test(tail)) out.push('');
      }
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 轻量净化：移除 <script> / <style> / 内联事件 / javascript: 协议。
 * @param {string} html
 * @return {string}
 */
function sanitize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

/**
 * 把一段**行内** Markdown 渲染为 HTML（表格单元格里用）。
 *
 * 表格 widget 的单元格是普通 DOM，拿不到 CodeMirror 的行内装饰，只能自己把
 * `**粗**` / `*斜*` / `` `代码` `` / `~~删除~~` / `[链接](url)` 渲染出来 ——
 * 否则同一份表格在预览里是加粗、在所见即所得里却是星号。
 *
 * 只走 `parseInline`：不产生 `<p>` 包裹，也不会把单元格里的 `|` 当表格语法。
 *
 * @param {string} text 单元格原文（已去掉 `\|` 转义）
 * @return {string}
 */
export function renderInlineMarkdown(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return '';
  if (!/([*_~`\[]|https?:\/\/)/.test(src)) {
    // 没有任何行内语法：直接转义，省一次解析（表格最常见的路径）
    return src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  try {
    const html = marked.parseInline(promoteLooseEmphasis(src), { async: false });
    return sanitize(typeof html === 'string' ? html : '');
  } catch (err) {
    console.warn('[QuillPad] 行内 Markdown 渲染失败：', err && err.message);
    return src
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

/**
 * 把 Markdown 渲染为 HTML。
 * @param {string} text
 * @return {string}
 */
export function renderMarkdown(text) {
  if (!text) return '';
  try {
    const html = marked.parse(promoteLooseEmphasis(breakTableTails(text)), { async: false });
    return sanitize(typeof html === 'string' ? html : '');
  } catch (err) {
    console.warn('[QuillPad] Markdown 渲染失败：', err);
    return t('<p style="color:var(--danger)">Markdown 渲染失败</p>', '<p style="color:var(--danger)">Markdown rendering failed</p>');
  }
}
