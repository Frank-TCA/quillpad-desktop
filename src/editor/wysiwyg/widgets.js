/**
 * QuillPad · WYSIWYG Widget 集合
 *
 * 约定（ARCH R2，spike S1 已实测通过）：
 *  - widget DOM 一律**只读展示**，绝不在 widget 内做可编辑元素；
 *  - `ignoreEvent()` 恒为 `true`，并对 `mousedown/click/keydown/input/...` 全部
 *    `stopPropagation`，避免 CM 的 DOMObserver 误判导致文档被改写；
 *  - 需要「编辑」时把交互交给宿主（浮层 input / 命令系统），widget 只负责回调。
 */

import { EditorView, WidgetType } from '@codemirror/view';
import { icon } from '../../ui/icons.js';
import { renderMath } from './math.js';
import { buildTocElement } from './toc.js';
import { buildFootnoteRefElement, buildFootnotesElement } from './footnotes.js';
import { codeTagLabel } from '../languages.js';
import { isLocalImageUrl, loadImageSrc } from './image-src.js';
import { t } from '../../core/i18n.js';

/** 需要拦截的事件类型（子组件冒泡到 CM 的都在这里）。 */
const STOP_EVENTS = [
  'keydown',
  'beforeinput',
  'input',
  'paste',
  'compositionstart',
  'compositionend',
  'drop',
  'dragstart',
  'dblclick',
];

/**
 * 给 widget 根节点装上「不冒泡」护盾。
 * @param {HTMLElement} el
 */
export function shieldEvents(el) {
  for (const type of STOP_EVENTS) {
    el.addEventListener(type, (e) => e.stopPropagation());
  }
}

/* --------------------------------------------------------------- 图片 */

/**
 * 图片 widget（行内替换整段 `![alt](src)`）。
 */
export class ImageWidget extends WidgetType {
  /**
   * @param {{src: string, alt: string, raw: string, url: string, resolved: boolean, reason?: string}} info
   */
  constructor(info) {
    super();
    this.info = info;
  }

  eq(other) {
    return (
      other instanceof ImageWidget &&
      other.info.src === this.info.src &&
      other.info.alt === this.info.alt &&
      other.info.url === this.info.url
    );
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'qp-img-wrap';
    wrap.appendChild(buildImageNode(this.info));
    shieldEvents(wrap);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * 造一个图片节点（加载失败时就地降级成占位框）。
 *
 * `resolveImageUrl()` 对本地相对路径给的是 `file:///` URL，但主窗口由本地
 * HTTP server 提供，Chromium 会直接拒绝加载（"Not allowed to load local
 * resource"）。所以本地图片不直接写 `src`，而是先让主进程读成 data URL 再回填；
 * 网络 / data / blob 地址保持原样。浏览器模式（无桌面桥）读不到字节，就地
 * 显示占位框，理由与之前一致。
 *
 * @param {{src: string, alt: string, url: string, resolved: boolean}} info
 * @return {HTMLElement}
 */
function buildImageNode(info) {
  if (!info.resolved) {
    return buildMissingImage(info.alt || info.src, t('相对路径未解析', 'Relative path not resolved'));
  }
  const img = document.createElement('img');
  img.className = 'qp-img';
  img.setAttribute('data-qp-node', 'image');
  img.setAttribute('data-qp-src', info.src);
  img.alt = info.alt || '';
  img.title = info.alt || info.src;

  let failed = false;
  /** 本地图片改成 data URL 后行高会变，让 CM 重新量一次（行号对齐依赖它）。 */
  const scheduleMeasure = (view) => {
    if (!view) return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => view.requestMeasure());
    } else {
      view.requestMeasure();
    }
  };
  /** @param {HTMLElement} node */
  const viewOf = (node) =>
    typeof EditorView.findFromDOM === 'function' ? EditorView.findFromDOM(node) : null;
  /** @param {string} reason */
  const fail = (reason) => {
    if (failed) return;
    failed = true;
    // widget 可能已被 CM 卸载（滚动 / 光标进入源码），此时不要再去动 DOM
    if (!img.parentNode) return;
    const view = viewOf(img);
    img.replaceWith(buildMissingImage(info.alt || info.src, reason));
    scheduleMeasure(view);
  };
  img.addEventListener('error', () => fail(t('图片未能加载', 'Image failed to load')));
  img.addEventListener('load', () => scheduleMeasure(viewOf(img)));

  if (isLocalImageUrl(info.url)) {
    img.setAttribute('data-qp-loading', '1');
    loadImageSrc(info.url).then((src) => {
      if (failed) return;
      if (!src) {
        fail(t('图片未能加载', 'Image failed to load'));
        return;
      }
      img.removeAttribute('data-qp-loading');
      img.src = src;
    });
  } else {
    img.loading = 'lazy';
    img.src = info.url;
  }
  return img;
}

/**
 * 图片行组 widget（软换行合并）。
 *
 * Markdown 里「连续多行、每行只有图片」在预览中属于**同一个段落**，图片靠
 * inline 流排在一行里、超宽才折行；而编辑器每行是一个 `.cm-line` 块，会
 * 竖着堆成 4 行。这里把这组行整体替换成一个块级 widget，用同样的 inline
 * 流重排，几何尺寸才能和预览对上（徽章栏是最典型的受害者）。
 *
 * 只吃「纯素材行」：行内除图片外没有可见文本，因此替换不会藏掉任何可编辑
 * 文字。点击整组进入源码（与公式块 / front matter 同款交互）。
 */
export class ImageRowWidget extends WidgetType {
  /**
   * @param {{items: Array<{src: string, alt: string, url: string, resolved: boolean}>, from?: number, onActivate?: Function}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
  }

  eq(other) {
    if (!(other instanceof ImageRowWidget)) return false;
    // from 也要比：块在文档里挪了位置必须重建，否则旧闭包会把光标送错地方
    if (other.opts.from !== this.opts.from) return false;
    const a = this.opts.items || [];
    const b = other.opts.items || [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].url !== b[i].url || a[i].alt !== b[i].alt || a[i].resolved !== b[i].resolved) {
        return false;
      }
    }
    return true;
  }

  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'qp-img-row';
    box.setAttribute('data-qp-node', 'image-row');
    box.title = t('点击编辑图片源码', 'Click to edit the image source');
    for (const info of this.opts.items || []) {
      // 预览里同一段落的多张图片是**空格分隔**的 inline 内容，这里显式补空格，
      // 宽度与折行位置才能和 `<p>` 里一致。
      if (box.childNodes.length) box.appendChild(document.createTextNode(' '));
      box.appendChild(buildImageNode(info));
    }
    shieldEvents(box);
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onActivate) this.opts.onActivate();
      else if (view) view.focus();
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 28;
  }
}

/**
 * 缺失图片占位块。
 * @param {string} label
 * @param {string} reason
 * @return {HTMLElement}
 */
export function buildMissingImage(label, reason) {
  const box = document.createElement('span');
  box.className = 'qp-img-missing';
  box.setAttribute('data-qp-node', 'image-missing');
  box.innerHTML =
    `<span class="qp-img-missing__icon">${icon('image', 14)}</span>` +
    `<span class="qp-img-missing__label"></span>` +
    `<span class="qp-img-missing__reason"></span>`;
  const l = box.querySelector('.qp-img-missing__label');
  const r = box.querySelector('.qp-img-missing__reason');
  if (l) l.textContent = label || t('图片', 'Image');
  if (r) r.textContent = reason || t('相对路径未解析', 'Relative path not resolved');
  return box;
}

/* ------------------------------------------------------------- 任务框 */

/** 任务列表复选框。 */
export class TaskCheckboxWidget extends WidgetType {
  /**
   * @param {boolean} checked
   * @param {(next: boolean) => void} onToggle
   */
  constructor(checked, onToggle) {
    super();
    this.checked = checked;
    this.onToggle = onToggle;
  }

  eq(other) {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  toDOM() {
    const box = document.createElement('span');
    box.className = 'qp-task';
    box.setAttribute('data-qp-node', 'task');
    box.setAttribute('data-qp-checked', this.checked ? 'true' : 'false');
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', this.checked ? 'true' : 'false');
    box.setAttribute('tabindex', '0');
    box.setAttribute(
      'aria-label',
      this.checked
        ? t('已完成（点击取消）', 'Completed (click to uncheck)')
        : t('未完成（点击完成）', 'Not completed (click to check)'),
    );
    box.innerHTML = `<span class="qp-task__box">${this.checked ? icon('check', 11) : ''}</span>`;
    const activate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.onToggle) this.onToggle(!this.checked);
    };
    box.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    box.addEventListener('click', activate);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    shieldEvents(box);
    return box;
  }

  ignoreEvent() {
    return true;
  }
}

/* ------------------------------------------------------------- 分隔线 */

/** 分割线 widget（真实 `<hr>`，源码 `---` 由零宽 mark 隐藏但仍在 DOM）。 */
export class HrWidget extends WidgetType {
  eq() {
    return false;
  }

  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'qp-hr';
    hr.setAttribute('data-qp-node', 'hr');
    return hr;
  }

  ignoreEvent() {
    return true;
  }
}

/* --------------------------------------------------------------- 目录 */

/** `[TOC]` → `<nav>`。 */
export class TocWidget extends WidgetType {
  /**
   * @param {() => Array<object>} getHeadings
   * @param {{onJump?: Function, onEdit?: Function}} opts
   */
  constructor(getHeadings, opts) {
    super();
    this.getHeadings = getHeadings;
    this.opts = opts;
    this.key = '';
  }

  eq(other) {
    if (!(other instanceof TocWidget)) return false;
    // 标题变化才需要重建
    const key = (this.getHeadings() || []).map((h) => `${h.level}:${h.lineNumber}:${h.text}`).join('|');
    other.key = key;
    return other.key === this.key;
  }

  toDOM() {
    const headings = this.getHeadings() || [];
    this.key = headings.map((h) => `${h.level}:${h.lineNumber}:${h.text}`).join('|');
    const nav = buildTocElement(headings, this.opts || {});
    shieldEvents(nav);
    return nav;
  }

  ignoreEvent() {
    return true;
  }
}

/* --------------------------------------------------------------- 公式 */

/** 行内公式 `$…$`。 */
export class MathInlineWidget extends WidgetType {
  /** @param {string} tex */
  constructor(tex) {
    super();
    this.tex = tex;
  }

  eq(other) {
    return other instanceof MathInlineWidget && other.tex === this.tex;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'qp-math qp-math--inline';
    el.setAttribute('data-qp-node', 'math-inline');
    renderMath(el, this.tex, false);
    shieldEvents(el);
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

/** 块级公式 `$$…$$`（点击 → 选区进入块内 → 露出源码可编辑）。 */
export class MathBlockWidget extends WidgetType {
  /** @param {{tex: string, onActivate?: Function}} opts */
  constructor(opts) {
    super();
    this.opts = typeof opts === 'string' ? { tex: opts } : opts || { tex: '' };
  }

  eq(other) {
    return other instanceof MathBlockWidget && other.opts.tex === this.opts.tex;
  }

  toDOM(view) {
    const el = document.createElement('div');
    el.className = 'qp-math qp-math--block';
    el.setAttribute('data-qp-node', 'math-block');
    el.setAttribute('role', 'button');
    el.title = t('点击编辑公式源码', 'Click to edit the formula source');
    renderMath(el, this.opts.tex, true);
    shieldEvents(el);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onActivate) this.opts.onActivate();
      else if (view) view.focus();
    });
    return el;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 60;
  }
}

/* ----------------------------------------------------------- 代码块头 */

/** 代码块围栏头（语言标签 + 复制按钮）。 */
export class CodeHeadWidget extends WidgetType {
  /**
   * @param {{lang: string, getCode: () => string, onCopy: (text: string) => void, onPickLang: Function}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
  }

  eq(other) {
    return other instanceof CodeHeadWidget && other.opts.lang === this.opts.lang;
  }

  toDOM() {
    const head = document.createElement('div');
    head.className = 'qp-code-head';
    head.setAttribute('data-qp-node', 'code-block');
    head.setAttribute('data-qp-lang', this.opts.lang || '');
    head.setAttribute('contenteditable', 'false');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'qp-code-head__lang';
    label.setAttribute('data-role', 'code-lang');
    // 围栏标记常是扩展名式别名（```bash / ```js），先归一成语言 id 再取显示名，
    // 否则一律落到「纯文本」。
    label.textContent = codeTagLabel(this.opts.lang);
    label.title = t('切换代码语言', 'Switch Code Language');
    label.addEventListener('mousedown', (e) => e.preventDefault());
    label.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onPickLang) this.opts.onPickLang(label);
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'qp-code-head__copy';
    copy.setAttribute('data-role', 'code-copy');
    copy.setAttribute('aria-label', t('复制代码', 'Copy Code'));
    copy.title = t('复制代码（不含围栏）', 'Copy code (without fences)');
    copy.innerHTML = icon('copyCode', 14);
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const code = this.opts.getCode ? this.opts.getCode() : '';
      if (this.opts.onCopy) this.opts.onCopy(code);
    });

    head.appendChild(label);
    head.appendChild(copy);
    shieldEvents(head);
    return head;
  }

  ignoreEvent() {
    return true;
  }
}

/* ----------------------------------------------------- front matter */

/**
 * 前置元数据卡片。
 *
 * 两种形态（T04 ⑥ 验收要求同一 `data-qp-node="frontmatter"` 元素
 * 在折叠 / 展开两态都存在，只切换 `data-qp-collapsed`）：
 *  - `collapsed: true` —— 块级替换整块，展示源码摘要 + 「编辑」按钮；
 *  - `collapsed: false` —— 光标在块内，源码本身已可见，只插一条细标题栏。
 */
export class FrontmatterWidget extends WidgetType {
  /**
   * @param {{source: string, collapsed: boolean, onExpand?: Function, onCollapse?: Function}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
  }

  eq(other) {
    return (
      other instanceof FrontmatterWidget &&
      other.opts.source === this.opts.source &&
      other.opts.collapsed === this.opts.collapsed
    );
  }

  toDOM() {
    const collapsed = !!this.opts.collapsed;
    const wrap = document.createElement('div');
    wrap.className = collapsed ? 'qp-frontmatter' : 'qp-frontmatter qp-frontmatter--open';
    wrap.setAttribute('data-qp-node', 'frontmatter');
    wrap.setAttribute('data-qp-collapsed', collapsed ? 'true' : 'false');
    wrap.setAttribute('contenteditable', 'false');

    const bar = document.createElement('div');
    bar.className = 'qp-frontmatter__bar';
    const title = document.createElement('span');
    title.className = 'qp-frontmatter__title';
    title.textContent = 'front matter';
    bar.appendChild(title);

    if (collapsed) {
      const body = document.createElement('pre');
      body.className = 'qp-frontmatter__body';
      body.textContent = this.opts.source;
      wrap.appendChild(body);
    }

    const hint = document.createElement('button');
    hint.type = 'button';
    hint.className = 'qp-frontmatter__edit';
    hint.setAttribute('data-role', 'frontmatter-edit');
    hint.textContent = collapsed ? t('编辑', 'Edit') : t('收起', 'Collapse');
    hint.title = collapsed
      ? t('展开源码编辑', 'Expand to edit the source')
      : t('光标移出后自动折叠', 'Collapses automatically when the cursor leaves');
    hint.addEventListener('mousedown', (e) => e.preventDefault());
    hint.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (collapsed) {
        if (this.opts.onExpand) this.opts.onExpand();
      } else if (this.opts.onCollapse) {
        this.opts.onCollapse();
      }
    });
    bar.appendChild(hint);

    wrap.appendChild(bar);
    shieldEvents(wrap);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return this.opts.collapsed ? 96 : 28;
  }
}

/* ------------------------------------------------------------- 脚注 */

/** 脚注引用（上标）。 */
export class FootnoteRefWidget extends WidgetType {
  /** @param {{index: number, id: string, onJump: Function}} opts */
  constructor(opts) {
    super();
    this.opts = opts;
  }

  eq(other) {
    return (
      other instanceof FootnoteRefWidget &&
      other.opts.id === this.opts.id &&
      other.opts.index === this.opts.index
    );
  }

  toDOM() {
    const sup = buildFootnoteRefElement(this.opts.index, this.opts.id, this.opts.onJump);
    shieldEvents(sup);
    return sup;
  }

  ignoreEvent() {
    return true;
  }
}

/** 文末脚注区（块级，挂在文档末尾）。 */
export class FootnotesBlockWidget extends WidgetType {
  /** @param {{entries: object[], onJump: Function}} opts */
  constructor(opts) {
    super();
    this.opts = opts;
  }

  eq(other) {
    if (!(other instanceof FootnotesBlockWidget)) return false;
    return (
      JSON.stringify(other.opts.entries.map((e) => [e.id, e.text])) ===
      JSON.stringify(this.opts.entries.map((e) => [e.id, e.text]))
    );
  }

  toDOM() {
    const el = buildFootnotesElement(this.opts.entries, this.opts.onJump);
    shieldEvents(el);
    return el;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return Math.max(40, this.opts.entries.length * 26 + 28);
  }
}
