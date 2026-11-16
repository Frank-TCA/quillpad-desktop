/**
 * QuillPad · `[TOC]` 目录渲染
 *
 * lezer 不解析 `[TOC]`（ARCH §5 校正②），因此由 `scan.js` 的行级扫描识别，
 * 这里只负责「从标题列表生成 `<nav>`」。目录项最多三级（H1–H3），
 * 每级缩进 24px（PRD §4.D2）。
 */

import { t } from '../../core/i18n.js';

/** 目录最多收录的标题层级。 */
export const TOC_MAX_LEVEL = 3;

/**
 * 从扫描结果里收集标题。
 *
 * @param {object[]} lines `scanMarkdown().lines`
 * @param {import('@codemirror/state').EditorState} state
 * @return {Array<{level: number, text: string, lineNumber: number, from: number}>}
 */
export function collectHeadingsFromScan(lines, state) {
  const out = [];
  for (const info of lines) {
    if (!info || info.kind !== 'heading') continue;
    if ((info.level || 1) > TOC_MAX_LEVEL) continue;
    const raw = state.doc.sliceString(info.from, info.to);
    const text = raw.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s*#+\s*$/, '').trim();
    if (!text) continue;
    out.push({ level: info.level || 1, text, lineNumber: info.number, from: info.from });
  }
  return out;
}

/**
 * 生成目录 DOM。
 *
 * @param {Array<{level: number, text: string, lineNumber: number, from: number}>} headings
 * @param {{onJump?: (heading: object) => void, onEdit?: () => void}} [opts]
 * @return {HTMLElement}
 */
export function buildTocElement(headings, opts = {}) {
  const nav = document.createElement('nav');
  nav.className = 'qp-toc';
  nav.setAttribute('data-qp-node', 'toc');
  nav.setAttribute('aria-label', t('目录', 'Table of Contents'));

  const title = document.createElement('div');
  title.className = 'qp-toc__title';
  title.textContent = t('目录', 'Table of Contents');
  nav.appendChild(title);

  const list = document.createElement('div');
  list.className = 'qp-toc__list';
  if (!headings.length) {
    const empty = document.createElement('div');
    empty.className = 'qp-toc__empty';
    empty.textContent = t('文档中还没有标题（H1–H3）', 'No headings in the document yet (H1–H3)');
    list.appendChild(empty);
  }
  for (const h of headings) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `qp-toc__item qp-toc__item--l${h.level}`;
    item.dataset.qpLevel = String(h.level);
    item.dataset.qpLine = String(h.lineNumber);
    item.textContent = h.text;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (opts.onJump) opts.onJump(h);
    });
    list.appendChild(item);
  }
  nav.appendChild(list);

  // 「编辑」入口：把选区落进 `[TOC]` 源码行（A3：进入即露出源码）
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'qp-toc__edit';
  edit.setAttribute('data-role', 'toc-edit');
  edit.textContent = t('编辑', 'Edit');
  edit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  edit.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (opts.onEdit) opts.onEdit();
  });
  nav.appendChild(edit);

  return nav;
}
