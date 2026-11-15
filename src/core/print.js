/**
 * QuillPad · PDF / 打印管线
 *
 * 一条管线服务两个出口（PDF 导出、打印），三条硬约束贯穿全文：
 *
 *  ① **自包含**：产出的 HTML 里没有 `<script>`、没有外链（`src="http…"` / `href="http…css"`）,
 *     图片全部 data URL、字体全部 base64 —— 因为这份 HTML 会被主进程写进临时文件、
 *     丢进隐藏 BrowserWindow，任何外链都意味着"导出结果取决于网络"。
 *  ② **版式一致**：排版数值全部来自主题 token（运行时用 `getComputedStyle` 从
 *     `documentElement` 读 `--qp-*`），所以"屏幕上看到的"和"打印出来的"是同一套数。
 *  ③ **分页可控**：纸张 / 边距写成 CSS `@page`，由 `preferCSSPageSize:true` 让
 *     Chromium 认 CSS 而不是自己算 —— 否则 Electron 的"英寸"与我们的"毫米"必然漂移。
 *
 * 刻意**不**做的事：
 *  - 不解析 PDF（用 Chromium 生成、不读回，避免引入 AGPL 的 Poppler/MuPDF）；
 *  - 不回填目录页码（Chromium 打印前无法知道分页结果，两阶段测量会让分页整体漂移，
 *    详见 `docs/CHANGELOG-v2.md`「交互差异」）。
 */

import printCssText from '../styles/print.css?inline';
import { renderMarkdown } from './markdown.js';
import { escapeHtml } from './utils.js';
import { highlightCode, resolveLangId } from './code-highlight.js';
import { state, activeTab } from './state.js';
import { languageLabel } from '../editor/languages.js';
import { getThemeSyntaxPalette } from '../editor/cm-themes.js';
import { resolveImageUrl, joinPath, toFileUrl, bytesToBase64 } from '../editor/wysiwyg/image.js';
import * as desktop from './desktop.js';
import {
  loadPrintFonts,
  fontFaceCss,
  PRINT_SANS_STACK,
  PRINT_SERIF_STACK,
  PRINT_MONO_STACK,
} from './print-fonts.js';

/** 代码块超过这个行数就允许跨页断行（`is-tall`）。 */
export const TALL_CODE_LINES = 40;

/** 单张图片内联上限（超过就保留占位，避免打印 HTML 膨胀到几十 MB）。 */
export const MAX_INLINE_IMAGE = 8 * 1024 * 1024;

/**
 * @typedef {object} PdfOptions
 * @property {'A4'|'Letter'|'custom'} paper
 * @property {number} customWidth
 * @property {number} customHeight
 * @property {'portrait'|'landscape'} orientation
 * @property {{top:number,bottom:number,left:number,right:number}} margin
 * @property {'follow'|'light'|'dark'} theme
 * @property {'follow'|'github-light'|'one-dark'|'solarized'} codeTheme
 * @property {25|50|75|100} imageMaxWidth
 * @property {'off'|'footer-center'|'footer-right'} pageNumber
 * @property {boolean} toc
 * @property {{mode:'none'|'filename'|'custom', text:string}} header
 * @property {{mode:'none'|'filename-date'|'custom', text:string}} footer
 * @property {string} fileName
 * @property {string|null} dir
 */

/* ------------------------------------------------------------------ 纸张尺寸 */

/** A4 / Letter 的毫米尺寸（自定义纸张走 customWidth/Height）。 */
export const PAPER_MM = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
};

/* -------------------------------------------------------------- 代码配色方案 */

/**
 * 打印用代码配色。
 *
 * `follow` 不写死颜色，而是由 `collectThemeTokens()` 从当前主题里取值，
 * 这样"跟随主题"才真的是跟随，而不是把某个主题硬编码进来。
 */
export const PRINT_CODE_PALETTES = {
  'github-light': {
    bg: '#f6f8fa',
    fg: '#24292f',
    keyword: '#cf222e',
    string: '#0a3069',
    number: '#0550ae',
    comment: '#6e7781',
    function: '#8250df',
    type: '#953800',
    punct: '#24292f',
    border: '#d0d7de',
  },
  'one-dark': {
    bg: '#282c34',
    fg: '#abb2bf',
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    comment: '#5c6370',
    function: '#61afef',
    type: '#e5c07b',
    punct: '#abb2bf',
    border: '#3a4049',
  },
  solarized: {
    bg: '#fdf6e3',
    fg: '#657b83',
    keyword: '#859900',
    string: '#2aa198',
    number: '#d33682',
    comment: '#93a1a1',
    function: '#268bd2',
    type: '#b58900',
    punct: '#657b83',
    border: '#eee8d5',
  },
};

/* ------------------------------------------------------------ 主题 token 采集 */

/**
 * 需要从应用主题里"搬"到打印页的 token。
 * 键 = 打印页里的变量名，值 = 应用里的变量名。
 */
const TOKEN_MAP = {
  '--qp-body-size': '--qp-body-size',
  '--qp-body-leading': '--qp-body-leading',
  '--qp-para-gap': '--qp-para-gap',
  '--qp-measure': '--qp-measure',
  '--qp-code-size': '--qp-code-size',
  '--qp-code-radius': '--qp-code-radius',
  '--qp-img-max': '--qp-img-max',
  '--qp-text': '--text',
  '--qp-text-dim': '--text-dim',
  '--qp-text-faint': '--text-faint',
  '--qp-accent': '--accent',
  '--qp-panel': '--bg-panel',
  '--qp-border': '--border',
  '--qp-border-strong': '--border-strong',
  '--qp-code-bg': '--bg-hover',
  '--qp-code-text': '--text',
};

/**
 * 从当前文档的 computedStyle 里读出 token，拼成 `:root{…}` 块。
 *
 * 取不到（比如在 Node 里跑）时用一组与 `theme.css` 默认值一致的字面量兜底，
 * 保证 `buildPrintHtml` 在任何环境都能产出合法 CSS。
 *
 * @return {Record<string, string>}
 */
export function collectThemeTokens() {
  const fallback = {
    '--qp-body-size': '16px',
    '--qp-body-leading': '1.75',
    '--qp-para-gap': '0.9em',
    '--qp-measure': '46em',
    '--qp-code-size': '14px',
    '--qp-code-radius': '10px',
    '--qp-img-max': '100%',
    '--qp-text': '#1c1f26',
    '--qp-text-dim': '#4a5260',
    '--qp-text-faint': '#7c8493',
    '--qp-accent': '#2f6feb',
    '--qp-panel': '#f4f5f7',
    '--qp-border': '#e3e5e9',
    '--qp-border-strong': '#d3d7de',
    '--qp-code-bg': '#f2f3f5',
    '--qp-code-text': '#24292f',
  };
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  const cs = getComputedStyle(document.documentElement);
  const out = { ...fallback };
  for (const [target, source] of Object.entries(TOKEN_MAP)) {
    const value = cs.getPropertyValue(source);
    if (value && value.trim()) out[target] = value.trim();
  }
  return out;
}

/**
 * 把 token 表拼成 `:root` 声明。
 * @param {Record<string, string>} tokens
 * @return {string}
 */
function tokensToCss(tokens) {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  return `:root{${body}}`;
}

/* --------------------------------------------------------------- 代码块着色 */

// 着色实现已抽到 `core/code-highlight.js`，与分屏预览共用（见顶部 import）。

/* ------------------------------------------------------------------ 图片内联 */

/**
 * 把一张图片解析成 data URL。
 *
 * 三条路径：
 *  1. 本来就是 data URL → 直接用；
 *  2. 相对路径 + 有文档目录 → 拼绝对路径后走 `qp:read-file` 读字节（桌面壳）；
 *  3. 其它（http 外链、解析不出）→ 返回 null，调用方换成占位符。
 *
 * 刻意**不**走 `fetch(file://…)`：Electron 渲染进程里 `file:` 受同源策略限制，
 * 读不到就静默失败，反而不如显式失败给占位符清楚。
 *
 * @param {string} src
 * @param {string|null} docDir
 * @return {Promise<string|null>}
 */
async function inlineOneImage(src, docDir) {
  const original = String(src || '').trim();
  if (!original) return null;
  if (/^data:image\//i.test(original)) return original;
  if (/^https?:/i.test(original)) return null; // 自包含：不外链

  // marked 会把相对路径里的非 ASCII 字符百分号编码（`01_%E5%B0%81…png`），
  // 直接拿去拼绝对路径会读不到中文文件名。file:/// 本身是合法编码，不要动。
  let raw = original;
  if (!/^file:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // 含非法 % 序列时保持原样，最终走占位符
    }
  }

  let absPath = '';
  if (/^file:\/\//i.test(raw)) {
    try {
      absPath = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ''));
      if (/^[a-zA-Z]:/.test(absPath) === false && docDistLike(absPath)) {
        // UNC 或 POSIX 路径，原样使用
        absPath = decodeURIComponent(new URL(raw).pathname);
      }
    } catch {
      return null;
    }
  } else if (docDir) {
    absPath = joinPath(docDir, raw.replace(/^\.\//, ''));
  } else {
    return null;
  }

  if (!absPath || !desktop.canReadLocalFile()) return null;
  const res = await desktop.readLocalFile(absPath);
  if (!res.ok || !res.bytes || !res.bytes.length) return null;
  if (res.bytes.length > MAX_INLINE_IMAGE) return null;
  const ext = (absPath.split('.').pop() || 'png').toLowerCase();
  const mimeMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
  };
  const mime = mimeMap[ext] || 'image/png';
  return `data:${mime};base64,${bytesToBase64(res.bytes)}`;
}

/** `file://` URL 的 pathname 是否已经是一个完整路径（POSIX / UNC）。 */
function docDistLike(p) {
  return /^\/(Users|home|Volumes|mnt|tmp)\//.test(`/${p.replace(/^\//, '')}`) || p.startsWith('//');
}

/* -------------------------------------------------------------- HTML 后处理 */

/**
 * 从 Markdown 里剥出 front matter（`---` 包起来的头部），返回 [front, body]。
 * @param {string} markdown
 * @return {{front: string, body: string}}
 */
export function splitFrontMatter(markdown) {
  const text = String(markdown || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { front: '', body: text };
  return { front: m[1], body: text.slice(m[0].length) };
}

/**
 * 把渲染出来的 HTML 加工成打印形态。
 *
 * 加工项（都在 DOM 上做，避免正则误伤代码块里的尖括号）：
 *  1. 代码块：语言标签 + `is-tall` + 语法着色；
 *  2. 任务列表：`<li><input type=checkbox>` → `.qp-task-item`；
 *  3. 图片：内联成 data URL，失败换占位；
 *  4. 标题：补 `id` 并收集成目录条目；
 *  5. `[pagebreak]` 段落 → 分页标记。
 *
 * @param {string} markdown
 * @param {{docDir: string|null}} doc
 * @param {PdfOptions} opts
 * @return {Promise<{bodyHtml: string, headings: Array<{level:number,text:string,id:string}>}>}
 */
async function renderPrintBody(markdown, doc, opts) {
  const { front, body } = splitFrontMatter(markdown);
  const html = renderMarkdown(body);
  const dom = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="qp-root">${html}</div></body></html>`,
    'text/html',
  );
  const root = dom.getElementById('qp-root');

  /* ---- 1. 代码块：语言标签 + 超高标记 + 着色 ---- */
  const pres = [...root.querySelectorAll('pre')];
  for (const pre of pres) {
    const codeEl = pre.querySelector('code');
    const rawText = (codeEl ? codeEl.textContent : pre.textContent) || '';
    const cls = codeEl ? codeEl.className : '';
    const langMatch = /language-([\w+#-]+)/i.exec(cls);
    const langId = langMatch ? resolveLangId(langMatch[1]) : '';
    const lines = rawText.split('\n').length;
    if (lines > TALL_CODE_LINES) pre.classList.add('is-tall');
    pre.setAttribute('data-lang', langId);
    const colored = await highlightCode(rawText, langId);
    const wrapper = dom.createElement('div');
    wrapper.className = 'qp-code-block';
    const label = dom.createElement('span');
    label.className = 'qp-code-lang';
    label.textContent = langId ? languageLabel(langId) : 'CODE';
    const freshPre = dom.createElement('pre');
    if (lines > TALL_CODE_LINES) freshPre.className = 'is-tall';
    freshPre.setAttribute('data-lang', langId);
    const freshCode = dom.createElement('code');
    freshCode.innerHTML = colored;
    freshPre.appendChild(freshCode);
    wrapper.appendChild(label);
    wrapper.appendChild(freshPre);
    pre.replaceWith(wrapper);
  }

  /* ---- 2. 任务列表 ---- */
  for (const input of [...root.querySelectorAll('li > input[type="checkbox"]')]) {
    const li = input.parentElement;
    if (!li) continue;
    const done = input.hasAttribute('checked') || input.checked;
    li.classList.add('qp-task-item');
    if (done) li.classList.add('is-done');
    input.remove();
  }

  /* ---- 3. 图片 ---- */
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || '图片';
    // eslint-disable-next-line no-await-in-loop
    const dataUrl = await inlineOneImage(src, doc.docDir);
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
      // 打印稿里图片不能有固定宽高，否则会被拉变形
      img.removeAttribute('width');
      img.removeAttribute('height');
    } else {
      const ph = dom.createElement('span');
      ph.className = 'qp-img-missing';
      ph.textContent = `[图片无法内联：${alt}]`;
      img.replaceWith(ph);
    }
  }

  /* ---- 4. 标题 id + 目录条目 ---- */
  const headings = [];
  const used = new Set();
  for (const h of [...root.querySelectorAll('h1,h2,h3')]) {
    const level = Number(h.tagName.slice(1));
    const text = (h.textContent || '').trim();
    let id = `qp-h-${headings.length + 1}`;
    while (used.has(id)) id += 'x';
    used.add(id);
    h.setAttribute('id', id);
    headings.push({ level, text, id });
  }

  /* ---- 5. 分页标记 ---- */
  for (const p of [...root.querySelectorAll('p')]) {
    if (/^\s*\[pagebreak\]\s*$/i.test(p.textContent || '')) {
      const br = dom.createElement('div');
      br.className = 'qp-page-break';
      p.replaceWith(br);
    }
  }

  let frontHtml = '';
  if (front.trim()) {
    frontHtml = `<div class="qp-frontmatter">${escapeHtml(front)}</div>`;
  }

  return { bodyHtml: frontHtml + root.innerHTML, headings };
}

/**
 * 把标题列表渲染成打印目录（章节列表，不带页码 —— 取舍见文件头注释）。
 * @param {Array<{level:number,text:string,id:string}>} headings
 * @return {string}
 */
export function buildTocHtml(headings) {
  if (!headings.length) return '';
  const items = headings
    .map(
      (h) =>
        `<li class="qp-toc__item qp-toc__item--${Math.min(3, Math.max(1, h.level))}">` +
        `<span class="qp-toc__text">${escapeHtml(h.text || '（无标题）')}</span>` +
        `<span class="qp-toc__lead"></span></li>`,
    )
    .join('');
  return (
    `<nav class="qp-toc"><div class="qp-toc__title">目录</div>` +
    `<ul class="qp-toc__list">${items}</ul></nav>`
  );
}

/* ------------------------------------------------------------- @page 与页眉页脚 */

/**
 * 纸张毫米尺寸。
 * @param {PdfOptions} opts
 * @return {{width: number, height: number}}
 */
export function paperSizeMm(opts) {
  if (opts.paper === 'custom') {
    return {
      width: Number(opts.customWidth) || 210,
      height: Number(opts.customHeight) || 297,
    };
  }
  return PAPER_MM[opts.paper] || PAPER_MM.A4;
}

/**
 * 生成 `@page` 块。
 *
 * 默认值（A4 / 20/20/18/18）与 `print.css` 里的基线完全一致，
 * 所以默认参数下这条规则只是"再声明一次"，不会引起任何漂移。
 *
 * @param {PdfOptions} opts
 * @return {string}
 */
export function buildPageCss(opts) {
  const { width, height } = paperSizeMm(opts);
  const landscape = opts.orientation === 'landscape';
  const w = landscape ? Math.max(width, height) : Math.min(width, height);
  const h = landscape ? Math.min(width, height) : Math.max(width, height);
  const m = opts.margin || { top: 20, bottom: 20, left: 18, right: 18 };
  const round = (n) => Math.round(Number(n) * 100) / 100;
  return `@page{size:${round(w)}mm ${round(h)}mm;margin:${round(m.top)}mm ${round(m.right)}mm ${round(m.bottom)}mm ${round(m.left)}mm}`;
}

/**
 * 页眉 / 页脚文本（Chromium 模板里只能有内联样式）。
 * @param {PdfOptions} opts
 * @param {{name: string}} doc
 * @param {boolean} header
 * @return {string}
 */
function buildHeaderFooterHtml(opts, doc, header) {
  const cfg = header ? opts.header : opts.footer;
  const mode = (cfg && cfg.mode) || 'none';
  // 页码挂在页脚上，与「页脚文本」是两个独立开关：
  // 用户完全可能只要页码、不要页脚文字（默认值就是这样）。
  const wantPage = !header && !!opts.pageNumber && opts.pageNumber !== 'off';
  if (mode === 'none' && !wantPage) return '<span></span>';
  let text = '';
  if (mode === 'filename') text = doc.name || '';
  else if (mode === 'filename-date') {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    text = `${doc.name || ''}  ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  } else text = (cfg && cfg.text) || '';
  // 页码放在页脚时与自定义文本拼在同一行
  if (wantPage) {
    const align = opts.pageNumber === 'footer-right' ? 'right' : 'center';
    return (
      `<div style="width:100%;padding:0 18mm;font-size:9px;color:#8d96a3;` +
      `font-family:sans-serif;display:flex;align-items:center;justify-content:${align};gap:8px;">` +
      `<span>${escapeHtml(text)}</span>` +
      `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
    );
  }
  return (
    `<div style="width:100%;padding:0 18mm;font-size:9px;color:#8d96a3;font-family:sans-serif;` +
    `display:flex;justify-content:${header ? 'left' : 'center'};">` +
    `<span>${escapeHtml(text)}</span></div>`
  );
}

/**
 * 把对话框参数映射成 Electron `printToPDF` 选项。
 *
 * **不传 `margins`**：Electron 的 margins 单位是英寸，而我们所有边距都是毫米，
 * 双写必然漂移（ARCH §4.6）。改由 CSS `@page` + `preferCSSPageSize:true` 决定。
 *
 * @param {PdfOptions} opts
 * @param {{name?: string}} [doc]
 * @return {object}
 */
export function buildElectronPrintOptions(opts, doc = {}) {
  const { width, height } = paperSizeMm(opts);
  const landscape = opts.orientation === 'landscape';
  const hasHeader = opts.header && opts.header.mode !== 'none';
  const hasFooter = (opts.footer && opts.footer.mode !== 'none') || opts.pageNumber !== 'off';
  const options = {
    printBackground: true,
    preferCSSPageSize: true,
    landscape,
    displayHeaderFooter: !!(hasHeader || hasFooter),
    headerTemplate: buildHeaderFooterHtml(opts, doc, true),
    footerTemplate: buildHeaderFooterHtml(opts, doc, false),
    // 自定义纸张时兜底给一个尺寸（CSS 仍然优先）；micro 单位是 Electron 的约定
    pageSize:
      opts.paper === 'A4' || opts.paper === 'Letter'
        ? opts.paper
        : {
            width: Math.round(landscape ? Math.max(width, height) * 1000 : Math.min(width, height) * 1000),
            height: Math.round(landscape ? Math.min(width, height) * 1000 : Math.max(width, height) * 1000),
          },
  };
  return options;
}

/* ---------------------------------------------------------------- 主构建入口 */

/**
 * 生成自包含打印 HTML。
 *
 * @param {{markdown: string, title?: string, name?: string, docDir: string|null}} doc
 * @param {PdfOptions} opts
 * @return {Promise<{html: string, stats: {chars:number, images:number, headings:number, fontBytes:number}}>}
 */
export async function buildPrintHtml(doc, opts) {
  const safeOpts = { ...opts };
  const title = doc.title || doc.name || '未命名';
  const isDark = safeOpts.theme === 'dark';

  const { bodyHtml, headings } = await renderPrintBody(doc.markdown || '', doc, safeOpts);
  const tocHtml = safeOpts.toc ? buildTocHtml(headings) : '';

  // 字体：缩略图路径不需要（`inlineFonts === false`），导出/打印必须有
  const wantFonts = safeOpts.inlineFonts !== false;
  const fonts = wantFonts ? await loadPrintFonts({ sans: true, serif: false }) : { sans: '', serif: '' };

  const tokens = collectThemeTokens();
  // 代码配色：显式三选一用固定调色板；「跟随主题」用当前编辑器主题的语法色，
  // 与 QuillPad WYSIWYG 里的高亮完全一致（用户需求：按渲染效果导出彩色 PDF）。
  // 仅当导出页面明暗（theme）与主题明暗不一致时，退到该明暗的基准主题
  // （深→aurora / 浅→ivory）并连底色一起换，避免浅色语法色落在深底上不可读。
  let palette = null;
  let overrideCodeBox = true;
  if (safeOpts.codeTheme && safeOpts.codeTheme !== 'follow') {
    palette = PRINT_CODE_PALETTES[safeOpts.codeTheme] || null;
  } else {
    const follow = getThemeSyntaxPalette(state.theme);
    if (follow.dark === isDark) {
      palette = follow;
      // 默认场景：代码块底色保持 token（--qp-code-bg，与 WYSIWYG 同源），只换语法色
      overrideCodeBox = false;
    } else {
      palette = getThemeSyntaxPalette(isDark ? 'aurora' : 'ivory');
    }
  }

  const codeVars = palette
    ? `${overrideCodeBox ? `--qp-code-bg:${palette.bg};--qp-code-text:${palette.fg};--qp-code-border:${palette.border};` : ''}` +
      `--tok-keyword:${palette.keyword};--tok-string:${palette.string};--tok-number:${palette.number};` +
      `--tok-comment:${palette.comment};--tok-function:${palette.function};--tok-type:${palette.type};` +
      `--tok-punct:${palette.punct};`
    : '';

  const imgMax =
    Number(safeOpts.imageMaxWidth) >= 25 && Number(safeOpts.imageMaxWidth) <= 100
      ? `${Number(safeOpts.imageMaxWidth)}%`
      : '100%';

  const html =
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${fontFaceCss(fonts)}` +
    `${tokensToCss(tokens).replace(/\}$/, `;${imgMax ? `--qp-img-max:${imgMax};` : ''}${codeVars}}`)}` +
    `\n${printCssText}\n${buildPageCss(safeOpts)}` +
    // 字体栈必须挂在 `.qp-print` 上、且排在 print.css 之后：
    // print.css 自己在 `.qp-print` 里写了兜底栈，元素级自定义属性优先于 `:root` 继承，
    // 写在 `:root` 上会被直接盖掉（曾经因此静默回退到系统字体）。
    `\n.qp-print{--qp-print-sans:${PRINT_SANS_STACK};--qp-print-mono:${PRINT_MONO_STACK};` +
    `--qp-print-serif:${PRINT_SERIF_STACK}}` +
    `</style></head>` +
    `<body class="qp-print${isDark ? ' qp-print--dark' : ''}">` +
    `<div class="qp-print__body">${tocHtml}${bodyHtml}</div>` +
    `</body></html>`;

  return {
    html,
    stats: {
      chars: html.length,
      images: (bodyHtml.match(/<img /g) || []).length,
      headings: headings.length,
      fontBytes: fonts.bytes || 0,
    },
  };
}

/* ------------------------------------------------------------------- 入口参数 */

/**
 * 从默认可信值 + 用户设置拼一份完整 PdfOptions。
 * @param {object} [pdfSettings]
 * @param {object} [tab]
 * @return {PdfOptions}
 */
export function defaultPdfOptions(pdfSettings = {}, tab = null) {
  const base = pdfSettings || {};
  return {
    paper: base.paper || 'A4',
    customWidth: base.customWidth || 210,
    customHeight: base.customHeight || 297,
    orientation: base.orientation || 'portrait',
    margin: {
      top: 20,
      bottom: 20,
      left: 18,
      right: 18,
      ...(base.margin || {}),
    },
    theme: base.theme || 'follow',
    codeTheme: base.codeTheme || 'follow',
    imageMaxWidth: base.imageMaxWidth || 100,
    pageNumber: base.pageNumber || 'footer-center',
    toc: !!base.toc,
    header: { mode: 'none', text: '', ...(base.header || {}) },
    footer: { mode: 'none', text: '', ...(base.footer || {}) },
    fileName: base.fileName || pdfFileNameFor(tab),
    dir: base.lastDir || null,
    // 自动化脚本/插件可以直接给死目标路径，跳过保存对话框（正常交互仍是弹框）
    targetPath: base.targetPath || null,
  };
}

/**
 * 由标签推导 PDF 文件名。
 * @param {object|null} tab
 * @return {string}
 */
export function pdfFileNameFor(tab) {
  const name = (tab && (tab.name || tab.path || tab.nativePath)) || '';
  const base = String(name).split(/[\\/]/).pop() || '';
  if (!base) return '未命名.pdf';
  return `${base.replace(/\.[^.]+$/, '')}.pdf`;
}

/* --------------------------------------------------------------------- 导出 */

/**
 * 在降级模式（浏览器）里把打印 HTML 丢进新窗口并调 `print()`。
 * @param {string} html
 * @return {boolean}
 */
export function printHtmlInNewWindow(html) {
  try {
    const win = window.open('', '_blank', 'width=900,height=1000');
    if (!win) {
      console.warn('[QuillPad] 打印窗口被拦截');
      return false;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // 等一帧让字体与图片就位，否则 print() 会打到空白页
    win.setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch (err) {
        console.warn('[QuillPad] 调起打印失败：', err && err.message);
      }
    }, 260);
    return true;
  } catch (err) {
    console.warn('[QuillPad] 打开打印窗口失败：', err && err.message);
    return false;
  }
}

/**
 * 导出 PDF。
 *
 * 阶段：parse(10) → layout(35) → render(60) → write(95)，
 * 供对话框进度条直接消费；`ctrl.signal` 可在任意阶段中断。
 *
 * @param {object} app
 * @param {object} tab
 * @param {PdfOptions} opts
 * @param {{onProgress?: (stage: string, pct: number) => void,
 *          signal?: AbortSignal}} [ctrl]
 * @return {Promise<{ok: boolean, path?: string, bytes?: number, degraded?: boolean,
 *                  code?: string, error?: string, stats?: object}>}
 */
export async function exportPdf(app, tab, opts, ctrl = {}) {
  const onProgress = typeof ctrl.onProgress === 'function' ? ctrl.onProgress : () => {};
  const aborted = () => ctrl.signal && ctrl.signal.aborted;

  state.pdfExporting = true;
  try {
    onProgress('parse', 10);
    if (aborted()) return { ok: false, code: 'EABORT', error: '已取消' };

    const doc = {
      markdown: (tab && tab.content) || '',
      title: opts.fileName ? opts.fileName.replace(/\.pdf$/i, '') : '未命名',
      name: (tab && tab.name) || '未命名.md',
      docDir: app && typeof app.docDirOf === 'function' ? app.docDirOf(tab) : null,
    };

    const built = await buildPrintHtml(doc, opts);
    if (aborted()) return { ok: false, code: 'EABORT', error: '已取消' };

    onProgress('layout', 35);
    const printOptions = buildElectronPrintOptions(opts, doc);

    onProgress('render', 60);
    if (aborted()) return { ok: false, code: 'EABORT', error: '已取消' };

    const targetPath = opts.targetPath || null;

    if (desktop.canExportPdf()) {
      const res = await desktop.exportPdf({
        html: built.html,
        options: printOptions,
        suggestedName: opts.fileName || pdfFileNameFor(tab),
        filePath: targetPath,
        directory: opts.dir || null,
        // 前端对话框已选定路径：主进程不再弹保存框
        skipDialog: !!opts.skipDialog,
      });
      onProgress('write', 95);
      if (!res.ok) {
        return { ok: false, code: res.code || 'EEXPORT', error: res.error || '导出失败', stats: built.stats };
      }
      if (res.canceled) return { ok: false, code: 'ECANCELED', error: '已取消' };
      return { ok: true, path: res.path, bytes: res.bytes, stats: built.stats };
    }

    // 浏览器降级：只能调起系统打印对话框让用户「另存为 PDF」
    const ok = printHtmlInNewWindow(built.html);
    onProgress('write', 95);
    if (!ok) {
      return { ok: false, code: 'EPRINT', error: '浏览器拦截了打印窗口，请允许弹出窗口后重试', stats: built.stats };
    }
    return { ok: true, degraded: true, stats: built.stats };
  } catch (err) {
    console.warn('[QuillPad] 导出 PDF 失败：', err);
    return { ok: false, code: 'EINTERNAL', error: (err && err.message) || String(err) };
  } finally {
    state.pdfExporting = false;
  }
}

/**
 * 打印文档（与 PDF 共用同一份打印 HTML）。
 * @param {object} app
 * @param {object} tab
 * @param {PdfOptions} opts
 * @return {Promise<{ok: boolean, degraded?: boolean, code?: string, error?: string}>}
 */
export async function printDocument(app, tab, opts) {
  try {
    const doc = {
      markdown: (tab && tab.content) || '',
      title: (tab && tab.name) || '未命名',
      name: (tab && tab.name) || '未命名.md',
      docDir: app && typeof app.docDirOf === 'function' ? app.docDirOf(tab) : null,
    };
    const built = await buildPrintHtml(doc, opts);
    if (desktop.canPrint()) {
      const res = await desktop.printDocument({
        html: built.html,
        options: buildElectronPrintOptions(opts, doc),
      });
      return res.ok ? { ok: true } : { ok: false, code: res.code || 'EPRINT', error: res.error };
    }
    const ok = printHtmlInNewWindow(built.html);
    return ok ? { ok: true, degraded: true } : { ok: false, code: 'EPRINT', error: '打印窗口被拦截' };
  } catch (err) {
    return { ok: false, code: 'EINTERNAL', error: (err && err.message) || String(err) };
  }
}

/**
 * 打印页内测量：把标题的竖向位置换算成"页内比例"。
 *
 * 真正的页码回填需要两阶段渲染，实测会让分页整体漂移，所以产品里**不用**它；
 * 保留这个函数是为了：
 *  - `pdf-check.mjs` 能验证"标题确实按顺序排布"；
 *  - 将来若要接 `pdf-lib` 之类的后处理，有一份可用的测量数据。
 *
 * @param {Window} win
 * @return {Array<{level: number, text: string, pageRatio: number}>}
 */
export function measureTocPages(win) {
  try {
    const doc = win && win.document;
    if (!doc) return [];
    const pageHeight = Math.max(1, (win.innerHeight || 1123));
    const list = [];
    for (const h of doc.querySelectorAll('h1,h2,h3')) {
      list.push({
        level: Number(h.tagName.slice(1)),
        text: (h.textContent || '').trim(),
        pageRatio: Math.round((h.getBoundingClientRect().top / pageHeight) * 1000) / 1000,
      });
    }
    return list;
  } catch {
    return [];
  }
}

/**
 * 当前标签是否还能导出（供命令 `enabled()` 使用）。
 * @return {boolean}
 */
export function canExportCurrent() {
  const tab = activeTab();
  return !!tab && !!String(tab.content || '').length;
}
