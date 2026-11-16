/**
 * QuillPad · 脚注
 *
 * lezer 不解析脚注（ARCH §5 校正②），所以：
 *  - 定义行 `[^id]: 内容` 由 `scan.js` 的行级正则识别（`kind === 'footnote-def'`）；
 *  - 引用 `[^id]` 由 `scan.js` 的行内正则识别（`kind === 'footnote-ref'`）；
 *  - 本模块负责「编号」与「文末脚注区」的 DOM 构造。
 */

import { t } from '../../core/i18n.js';

/**
 * 汇总文档中的脚注引用与定义。
 *
 * @param {object[]} lines
 * @param {object[]} inline
 * @param {import('@codemirror/state').EditorState} state
 * @return {{refs: object[], defs: object[], order: string[], entries: object[]}}
 */
export function collectFootnotes(lines, inline, state) {
  /** @type {Map<string, object>} */
  const defs = new Map();
  for (const info of lines) {
    if (!info || info.kind !== 'footnote-def') continue;
    const id = info.footnoteId;
    if (!id || defs.has(id)) continue;
    defs.set(id, {
      id,
      lineNumber: info.number,
      from: info.from,
      text: state.doc.sliceString(info.from, info.to).replace(/^\s{0,3}\[\^[^\]]+\]:\s?/, ''),
    });
  }

  /** @type {Map<string, number>} id → 序号（按首次出现顺序） */
  const order = [];
  const refs = [];
  for (const entry of inline) {
    if (entry.kind !== 'footnote-ref') continue;
    if (!order.includes(entry.id)) order.push(entry.id);
    refs.push({
      id: entry.id,
      index: order.indexOf(entry.id) + 1,
      lineNumber: entry.lineNumber,
      from: entry.from,
      to: entry.to,
    });
  }

  const entries = order.map((id, i) => ({
    id,
    index: i + 1,
    text: defs.has(id)
      ? defs.get(id).text
      : t('（未找到该脚注的定义）', '(Footnote definition not found)'),
    def: defs.get(id) || null,
  }));

  return {
    refs,
    defs: [...defs.values()],
    order,
    entries,
  };
}

/**
 * 脚注引用上标（行内 widget）。
 * @param {number} index 序号（从 1 开始）
 * @param {string} id 脚注 id
 * @param {(id: string) => void} onJump
 * @return {HTMLElement}
 */
export function buildFootnoteRefElement(index, id, onJump) {
  const sup = document.createElement('sup');
  sup.className = 'qp-footnote-ref';
  sup.setAttribute('data-qp-node', 'footnote-ref');
  sup.setAttribute('data-qp-id', id);
  sup.setAttribute('role', 'link');
  sup.setAttribute('tabindex', '0');
  sup.textContent = String(index);
  const activate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onJump) onJump(id);
  };
  sup.addEventListener('click', activate);
  sup.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') activate(e);
  });
  sup.addEventListener('mousedown', (e) => e.preventDefault());
  return sup;
}

/**
 * 文末脚注区。
 * @param {object[]} entries `collectFootnotes().entries`
 * @param {(id: string) => void} onJump
 * @return {HTMLElement}
 */
export function buildFootnotesElement(entries, onJump) {
  const wrap = document.createElement('section');
  wrap.className = 'qp-footnotes';
  wrap.setAttribute('data-qp-node', 'footnotes');
  wrap.setAttribute('aria-label', t('脚注', 'Footnotes'));

  const title = document.createElement('div');
  title.className = 'qp-footnotes__title';
  title.textContent = t('脚注', 'Footnotes');
  wrap.appendChild(title);

  const list = document.createElement('ol');
  list.className = 'qp-footnotes__list';
  for (const item of entries) {
    const li = document.createElement('li');
    li.className = 'qp-footnotes__item';
    li.setAttribute('data-qp-id', item.id);
    li.setAttribute('data-qp-index', String(item.index));
    li.textContent = item.text || t('（空脚注）', '(Empty footnote)');
    if (item.def) {
      li.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onJump) onJump(item.id);
      });
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}
