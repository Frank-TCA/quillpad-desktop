/**
 * QuillPad · 导出为 PDF 对话框（PRD §5.2 / B2）
 *
 * 布局：单栏 12 行设置 + 底部进度与按钮。
 * v3：按用户需求移除左栏缩略图预览；「浏览…」弹系统目录选择框，
 * 导出按钮直接写到选定路径、不再弹保存框。
 *
 * 几个刻意的决定：
 *
 *  1. **不复用 `openModal()`**：那个组件的按钮点击会立刻 resolve 并关闭，
 *     而这里需要在「导出中」把按钮换成进度条、允许取消、导出完成后才关闭。
 *     自己管 backdrop 更省事，也让 `[data-dialog="pdf-export"]` 的 DOM 结构
 *     完全由本文件决定（测试可以直接按 `data-field` 断言）。
 *  2. **浏览器模式置灰而不是隐藏**：用户需要知道「有这些功能，只是当前环境做不到」，
 *     隐藏会让人以为产品缺功能（PRD B1）。
 *  3. **取消只有一个语义**：关闭对话框 = 放弃；导出中点取消 = abort，
 *     且**不留下半成品文件**（主进程只在拿到完整 Buffer 后才写盘）。
 *  4. **路径在对话框里定死**：保存位置 + 文件名 → 绝对路径传 `targetPath` +
 *     `skipDialog`，导出不再弹保存框（用户需求：浏览时选路径，导出时直接写）。
 */

import { icon } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { state, activeTab } from '../core/state.js';
import {
  buildPrintHtml,
  defaultPdfOptions,
  pdfFileNameFor,
  exportPdf,
} from '../core/print.js';
import * as desktop from '../core/desktop.js';
import { toast } from './toast.js';
import { getThemeMeta } from '../editor/cm-themes.js';
import { t } from '../core/i18n.js';

/** 当前打开的对话框实例（同时只允许一个）。 */
let current = null;

/**
 * 读数并夹紧。
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @return {number}
 */
function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 构造一个 `<select>` 的选项 HTML。
 * @param {Array<{value: any, label: string}>} items
 * @param {any} value
 * @return {string}
 */
function optionsHtml(items, value) {
  return items
    .map(
      (it) =>
        `<option value="${escapeHtml(String(it.value))}"${String(it.value) === String(value) ? ' selected' : ''}>` +
        `${escapeHtml(it.label)}</option>`,
    )
    .join('');
}

/** 判断当前环境能否做真正的分页控制。 */
function isDesktopMode() {
  return desktop.canExportPdf();
}

/**
 * 打开导出对话框。
 *
 * @param {object} app
 * @param {object} [opts]
 * @param {(payload: object) => void} [opts.onDone] 导出完成后回调（测试可注入）
 * @return {{el: HTMLElement, close: () => void, refreshPreview: () => Promise<void>}}
 */
export function openPdfDialog(app, opts = {}) {
  if (current) {
    current.el.focus?.();
    return current;
  }

  const tab = activeTab();
  if (!tab) {
    toast(t('没有打开的文档', 'No document is open.'), 'info', 2000);
    return null;
  }

  const basePdf = (app.settings && app.settings.pdf) || {};
  const values = defaultPdfOptions(basePdf, tab);
  const desktopMode = isDesktopMode();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop qp-pdf-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal qp-dialog qp-pdf';
  modal.setAttribute('data-dialog', 'pdf-export');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', t('导出为 PDF', 'Export as PDF'));

  modal.innerHTML =
    `<div class="modal__head">` +
    `<span class="modal__glyph is-info">${icon('fileText', 15)}</span>` +
    `<span class="modal__title">${t('导出为 PDF', 'Export as PDF')}</span>` +
    `<button class="qp-pdf__close" data-role="close" aria-label="${t('关闭', 'Close')}">${icon('close', 14)}</button>` +
    `</div>` +
    `<div class="modal__body qp-pdf__body">` +
    /* --------------------------------- 设置 --------------------------------- */
    `<div class="qp-pdf__fields">` +
    `<div class="qp-pdf__group">${t('页面', 'Page')}</div>` +
    `<label class="qp-pdf__row"><span>${t('纸张', 'Page Size')}</span>` +
    `<select data-field="paper" data-role="field">` +
    optionsHtml(
      [
        { value: 'A4', label: t('A4（210 × 297 mm）', 'A4 (210 × 297 mm)') },
        { value: 'Letter', label: t('Letter（216 × 279 mm）', 'Letter (216 × 279 mm)') },
        { value: 'custom', label: t('自定义…', 'Custom…') },
      ],
      values.paper,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row qp-pdf__row--custom" data-role="custom-size">` +
    `<span>${t('尺寸', 'Size')}</span>` +
    `<span class="qp-pdf__pair">` +
    `<input type="number" min="50" max="2000" step="1" data-field="customWidth" data-role="field" value="${values.customWidth}" aria-label="${t('自定义宽度 mm', 'Custom width (mm)')}" />` +
    `<i>×</i>` +
    `<input type="number" min="50" max="2000" step="1" data-field="customHeight" data-role="field" value="${values.customHeight}" aria-label="${t('自定义高度 mm', 'Custom height (mm)')}" />` +
    `<i>mm</i></span></label>` +
    `<label class="qp-pdf__row"><span>${t('方向', 'Orientation')}</span>` +
    `<select data-field="orientation" data-role="field">` +
    optionsHtml(
      [
        { value: 'portrait', label: t('纵向', 'Portrait') },
        { value: 'landscape', label: t('横向', 'Landscape') },
      ],
      values.orientation,
    ) +
    `</select></label>` +
    `<div class="qp-pdf__row qp-pdf__row--margin"><span>${t('页边距', 'Margins')}</span>` +
    `<span class="qp-pdf__grid4">` +
    `<label><i>${t('上', 'Top')}</i><input type="number" min="0" max="50" data-field="marginTop" data-role="field" value="${values.margin.top}" aria-label="${t('上边距 mm', 'Top margin (mm)')}" /></label>` +
    `<label><i>${t('下', 'Bottom')}</i><input type="number" min="0" max="50" data-field="marginBottom" data-role="field" value="${values.margin.bottom}" aria-label="${t('下边距 mm', 'Bottom margin (mm)')}" /></label>` +
    `<label><i>${t('左', 'Left')}</i><input type="number" min="0" max="50" data-field="marginLeft" data-role="field" value="${values.margin.left}" aria-label="${t('左边距 mm', 'Left margin (mm)')}" /></label>` +
    `<label><i>${t('右', 'Right')}</i><input type="number" min="0" max="50" data-field="marginRight" data-role="field" value="${values.margin.right}" aria-label="${t('右边距 mm', 'Right margin (mm)')}" /></label>` +
    `</span></div>` +

    `<div class="qp-pdf__group">${t('外观', 'Appearance')}</div>` +
    `<label class="qp-pdf__row"><span>${t('主题', 'Theme')}</span>` +
    `<select data-field="theme" data-role="field">` +
    optionsHtml(
      [
        { value: 'follow', label: t('跟随当前', 'Follow Current') },
        { value: 'light', label: t('浅色', 'Light') },
        { value: 'dark', label: t('深色', 'Dark') },
      ],
      values.theme,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row"><span>${t('代码配色', 'Code Theme')}</span>` +
    `<select data-field="codeTheme" data-role="field">` +
    optionsHtml(
      [
        { value: 'follow', label: t('跟随主题', 'Follow Theme') },
        { value: 'github-light', label: 'GitHub Light' },
        { value: 'one-dark', label: 'One Dark' },
        { value: 'solarized', label: 'Solarized' },
      ],
      values.codeTheme,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row"><span>${t('图片最大宽度', 'Max Image Width')}</span>` +
    `<select data-field="imageMaxWidth" data-role="field">` +
    optionsHtml(
      [
        { value: 25, label: '25%' },
        { value: 50, label: '50%' },
        { value: 75, label: '75%' },
        { value: 100, label: '100%' },
      ],
      values.imageMaxWidth,
    ) +
    `</select></label>` +

    `<div class="qp-pdf__group">${t('装饰', 'Decorations')}</div>` +
    `<label class="qp-pdf__row"><span>${t('页码', 'Page Number')}</span>` +
    `<select data-field="pageNumber" data-role="field"${desktopMode ? '' : ' disabled'}>` +
    optionsHtml(
      [
        { value: 'off', label: t('关', 'Off') },
        { value: 'footer-center', label: t('页脚居中', 'Footer Center') },
        { value: 'footer-right', label: t('页脚右侧', 'Footer Right') },
      ],
      values.pageNumber,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row qp-pdf__row--check"><span>${t('目录页', 'Table of Contents')}</span>` +
    `<input type="checkbox" data-field="toc" data-role="field"${values.toc ? ' checked' : ''}${desktopMode ? '' : ' disabled'} />` +
    `<i class="qp-pdf__hint">${t('按 H1–H3 生成章节列表', 'Generate a chapter list from H1–H3 headings')}</i></label>` +
    `<label class="qp-pdf__row"><span>${t('页眉', 'Header')}</span>` +
    `<select data-field="header" data-role="field"${desktopMode ? '' : ' disabled'}>` +
    optionsHtml(
      [
        { value: 'none', label: t('无', 'None') },
        { value: 'filename', label: t('文件名', 'File Name') },
        { value: 'custom', label: t('自定义…', 'Custom…') },
      ],
      values.header.mode,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row qp-pdf__row--text" data-role="header-text" hidden><span></span>` +
    `<input type="text" maxlength="60" data-field="headerText" data-role="field" value="${escapeHtml(values.header.text || '')}" placeholder="${t('页眉文字（≤60 字）', 'Header text (≤60 characters)')}"${desktopMode ? '' : ' disabled'} />` +
    `</label>` +
    `<label class="qp-pdf__row"><span>${t('页脚', 'Footer')}</span>` +
    `<select data-field="footer" data-role="field"${desktopMode ? '' : ' disabled'}>` +
    optionsHtml(
      [
        { value: 'none', label: t('无', 'None') },
        { value: 'filename-date', label: t('文件名 + 日期', 'File Name + Date') },
        { value: 'custom', label: t('自定义…', 'Custom…') },
      ],
      values.footer.mode,
    ) +
    `</select></label>` +
    `<label class="qp-pdf__row qp-pdf__row--text" data-role="footer-text" hidden><span></span>` +
    `<input type="text" maxlength="60" data-field="footerText" data-role="field" value="${escapeHtml(values.footer.text || '')}" placeholder="${t('页脚文字（≤60 字）', 'Footer text (≤60 characters)')}"${desktopMode ? '' : ' disabled'} />` +
    `</label>` +

    `<div class="qp-pdf__group">${t('输出', 'Output')}</div>` +
    `<label class="qp-pdf__row"><span>${t('文件名', 'File Name')}</span>` +
    `<input type="text" data-field="fileName" data-role="field" value="${escapeHtml(values.fileName)}" />` +
    `</label>` +
    `<label class="qp-pdf__row"><span>${t('保存位置', 'Save Location')}</span>` +
    `<span class="qp-pdf__pair">` +
    `<input type="text" data-field="dir" data-role="field" value="${escapeHtml(values.dir || '')}" placeholder="${t('文档同目录', 'Same folder as the document')}" />` +
    `<button type="button" class="btn btn--ghost qp-pdf__browse" data-role="browse">${t('浏览…', 'Browse…')}</button>` +
    `</span></label>` +
    `</div>` +
    `</div>` +
    /* ------------------------------ 浏览器模式提示 ------------------------------ */
    `<div class="qp-pdf__notice" data-role="notice"${desktopMode ? ' hidden' : ''}>` +
    `${icon('alert', 14)}<span>${t('浏览器模式：无法控制页码与页眉页脚，请在打印窗口选择「另存为 PDF」。', 'Browser mode: page numbers, headers and footers cannot be controlled. Choose "Save as PDF" in the print dialog.')}</span>` +
    `</div>` +
    /* ---------------------------------- 底栏 ---------------------------------- */
    `<div class="modal__foot qp-pdf__foot">` +
    `<div class="qp-pdf__progress" data-role="progress" hidden>` +
    `<div class="qp-pdf__bar"><span data-role="bar"></span></div>` +
    `<span class="qp-pdf__stage" data-role="stage">${t('解析 Markdown…', 'Parsing Markdown…')}</span>` +
    `</div>` +
    `<span class="qp-pdf__error" data-role="error" hidden></span>` +
    `<button class="btn btn--ghost" data-role="cancel">${t('取消', 'Cancel')}</button>` +
    `<button class="btn is-primary" data-role="export">${t('导出 PDF', 'Export PDF')}</button>` +
    `</div>`;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const $ = (sel) => modal.querySelector(sel);
  const field = (name) => modal.querySelector(`[data-field="${name}"]`);
  const progressEl = $('[data-role="progress"]');
  const barEl = $('[data-role="bar"]');
  const stageEl = $('[data-role="stage"]');
  const errorEl = $('[data-role="error"]');
  const exportBtn = $('[data-role="export"]');
  const cancelBtn = $('[data-role="cancel"]');

  let abortCtrl = null;
  let exporting = false;
  let closed = false;

  /** 从 DOM 读回当前设置。 */
  function readValues() {
    const paper = field('paper').value;
    return {
      ...values,
      paper,
      customWidth: clampNum(field('customWidth').value, 50, 2000, 210),
      customHeight: clampNum(field('customHeight').value, 50, 2000, 297),
      orientation: field('orientation').value,
      margin: {
        top: clampNum(field('marginTop').value, 0, 50, 20),
        bottom: clampNum(field('marginBottom').value, 0, 50, 20),
        left: clampNum(field('marginLeft').value, 0, 50, 18),
        right: clampNum(field('marginRight').value, 0, 50, 18),
      },
      theme: field('theme').value,
      codeTheme: field('codeTheme').value,
      imageMaxWidth: Number(field('imageMaxWidth').value) || 100,
      pageNumber: field('pageNumber').value,
      toc: !!field('toc').checked,
      header: { mode: field('header').value, text: field('headerText').value || '' },
      footer: { mode: field('footer').value, text: field('footerText').value || '' },
      fileName: (field('fileName').value || '').trim() || pdfFileNameFor(tab),
      dir: (field('dir').value || '').trim() || null,
    };
  }

  /** 把「跟随当前」解析成具体主题。 */
  function resolvedTheme(v) {
    if (v.theme === 'dark') return 'dark';
    if (v.theme === 'light') return 'light';
    // 跟随当前：用当前主题的明暗来决定打印稿底色
    return getThemeMeta(state.theme).dark ? 'dark' : 'light';
  }

  /** 同步依赖字段的可见性与禁用态。 */
  function syncConditional() {
    const paper = field('paper').value;
    const customRow = modal.querySelector('[data-role="custom-size"]');
    if (customRow) customRow.hidden = paper !== 'custom';

    const headerRow = modal.querySelector('[data-role="header-text"]');
    if (headerRow) headerRow.hidden = field('header').value !== 'custom';
    const footerRow = modal.querySelector('[data-role="footer-text"]');
    if (footerRow) footerRow.hidden = field('footer').value !== 'custom';

    // 浏览器模式：分页相关控件必须 disabled（PRD B1 验收⑤）。
    // QA D-5：页眉/页脚的自定义文字输入是其子控件，同样要置灰，
    // 否则用户会输入一段永远不生效的内容。模板里也带上了 disabled
    // 属性，这里再统一兜一次（对话框重建 / 状态回写后仍成立）。
    if (!desktopMode) {
      for (const name of ['pageNumber', 'toc', 'header', 'footer', 'headerText', 'footerText']) {
        const el = field(name);
        if (el) el.disabled = true;
      }
    }
  }

  /** 设置进度显示。 */
  function setProgress(stage, pct) {
    const labels = {
      parse: t('解析 Markdown…', 'Parsing Markdown…'),
      layout: t('版式计算…', 'Calculating layout…'),
      render: t('渲染页面…', 'Rendering pages…'),
      write: t('写入文件…', 'Writing file…'),
    };
    progressEl.hidden = false;
    barEl.style.width = `${Math.max(4, Math.min(100, pct))}%`;
    stageEl.textContent = labels[stage] || t('处理中…', 'Working…');
  }

  /** 关闭对话框。 */
  function close() {
    if (closed) return;
    closed = true;
    if (abortCtrl) abortCtrl.abort();
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown, true);
    current = null;
  }

  /** Esc 关闭（导出中则等同取消）。 */
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (exporting) {
      if (abortCtrl) abortCtrl.abort();
      return;
    }
    close();
  }
  document.addEventListener('keydown', onKeydown, true);

  /**
   * 保存设置回 settings.pdf（PRD B2：上次选择要持久化）。
   * @param {object} v
   */
  function persistValues(v) {
    if (!app.settings) return;
    app.settings.pdf = {
      ...(app.settings.pdf || {}),
      paper: v.paper,
      customWidth: v.customWidth,
      customHeight: v.customHeight,
      orientation: v.orientation,
      margin: { ...v.margin },
      theme: v.theme,
      codeTheme: v.codeTheme,
      imageMaxWidth: v.imageMaxWidth,
      pageNumber: v.pageNumber,
      toc: v.toc,
      header: { ...v.header },
      footer: { ...v.footer },
      fileName: v.fileName,
      lastDir: v.dir || (app.settings.pdf && app.settings.pdf.lastDir) || null,
    };
    if (typeof app.persistSettings === 'function') app.persistSettings();
  }

  /* ------------------------------------------------------------------ 事件 */

  modal.addEventListener('input', () => {
    syncConditional();
  });
  modal.addEventListener('change', () => {
    syncConditional();
  });

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && !exporting) close();
  });

  $('[data-role="close"]').addEventListener('click', () => {
    if (!exporting) close();
  });

  cancelBtn.addEventListener('click', () => {
    if (exporting) {
      if (abortCtrl) abortCtrl.abort();
      return;
    }
    close();
  });

  $('[data-role="browse"]').addEventListener('click', async () => {
    // 浏览器模式没有目录选择 IPC，给出明确解释而不是静默失败
    const input = field('dir');
    if (!desktopMode) {
      toast(t('浏览器模式无法指定保存目录，请在打印窗口里选择位置', 'Browser mode cannot set a save folder. Choose the location in the print dialog.'), 'info', 2600);
      return;
    }
    // 弹系统目录选择框；选定后回填保存位置，导出时直接写入不再弹框
    const res = await desktop.pickDirectory();
    if (res && res.ok && res.path) {
      input.value = res.path;
      syncConditional();
      toast(t(`导出位置：${res.path}`, `Export location: ${res.path}`), 'info', 2400);
    }
  });

  exportBtn.addEventListener('click', async () => {
    if (exporting) return;
    const v = readValues();
    persistValues(v);

    // 保存位置 + 文件名 → 绝对路径；导出直写、不再弹保存框（浏览时已选定）
    const baseDir = v.dir || (typeof app.docDirOf === 'function' ? app.docDirOf(tab) : null);
    const targetPath = baseDir
      ? `${String(baseDir).replace(/[\\/]+$/, '')}/${v.fileName}`
      : null;

    exporting = true;
    exportBtn.disabled = true;
    errorEl.hidden = true;
    abortCtrl = new AbortController();

    const result = await exportPdf(app, tab, {
      ...v,
      targetPath,
      skipDialog: true,
      theme: resolvedTheme(v),
      inlineFonts: true,
    }, {
      onProgress: (stage, pct) => setProgress(stage, pct),
      signal: abortCtrl.signal,
    });

    exporting = false;
    exportBtn.disabled = false;
    progressEl.hidden = true;

    if (result.ok) {
      close();
      if (result.degraded) {
        toast(t('已调起打印窗口，请在系统对话框里选择「另存为 PDF」', 'The print dialog is open. Choose "Save as PDF" in the system dialog.'), 'info', 3600);
      } else {
        const kb = result.bytes ? ` · ${(result.bytes / 1024).toFixed(0)} KB` : '';
        toast(t(`已导出：${result.path || 'PDF'}${kb}`, `Exported: ${result.path || 'PDF'}${kb}`), 'success', 3200);
      }
      if (typeof opts.onDone === 'function') opts.onDone(result);
      return;
    }

    if (result.code === 'EABORT' || result.code === 'ECANCELED') {
      toast(t('已取消导出', 'Export cancelled'), 'info', 1800);
      return;
    }

    const message = result.error || t('导出失败', 'Export failed');
    const suffix = result.code ? t(`（${result.code}）`, ` (${result.code})`) : '';
    errorEl.hidden = false;
    errorEl.textContent = `${message}${suffix}`;
    toast(message, 'error', 3600);
    if (typeof opts.onDone === 'function') opts.onDone(result);
  });

  syncConditional();
  window.setTimeout(() => {
    const first = field('paper');
    if (first) first.focus();
  }, 30);

  current = { el: modal, close, readValues };
  return current;
}

/** 关闭当前对话框（如果开着）。 */
export function closePdfDialog() {
  if (current) current.close();
}

/** 是否有导出对话框打开。 */
export function isPdfDialogOpen() {
  return !!current;
}
