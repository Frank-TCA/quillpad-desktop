/**
 * QuillPad · Markdown 渲染
 * 使用 marked 解析，并做一层轻量净化（移除脚本与事件属性）。
 * 由于所有内容都来自本机文件、且渲染在本地页面里，这里采用白名单式清理即可。
 */

import { marked } from 'marked';
import { t } from './i18n.js';

marked.setOptions({
  gfm: true,
  breaks: false,
});

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
 * 把 Markdown 渲染为 HTML。
 * @param {string} text
 * @return {string}
 */
export function renderMarkdown(text) {
  if (!text) return '';
  try {
    const html = marked.parse(text, { async: false });
    return sanitize(typeof html === 'string' ? html : '');
  } catch (err) {
    console.warn('[QuillPad] Markdown 渲染失败：', err);
    return t('<p style="color:var(--danger)">Markdown 渲染失败</p>', '<p style="color:var(--danger)">Markdown rendering failed</p>');
  }
}
