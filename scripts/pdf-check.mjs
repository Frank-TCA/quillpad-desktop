/**
 * QuillPad · PDF / 打印管线验收
 *
 * 分两段跑，缺一不可：
 *
 *  **A 段（浏览器 / Vite dev server）**：直接调 `buildPrintHtml()`，
 *  断言自包含性、分页规则、字体内联、目录生成、Electron 参数映射。
 *  这一段跑得快，能定位"HTML 生成错了"。
 *
 *  **B 段（真实 Electron）**：用 `_electron.launch` 起真实壳，
 *  走 `qp:export-pdf` 完整链路导出一次真 PDF 到 `%TEMP%`，然后**直接读 PDF 字节**
 *  做断言：
 *    - 文件头 `%PDF-1.`
 *    - 存在 `/FontFile2` 或 `/FontFile3` ⇒ **字体真的被嵌入**（不是引用系统字体）
 *    - `/BaseFont` 出现次数 ⇒ 嵌入了几种字体
 *    - `/Type /Page` 出现次数 ⇒ 页数
 *  不用 `pdfinfo`：本机没装 poppler，而且 Poppler 是 GPL（PRD §4.F2 明确禁止进产品，
 *  测试期也不引入，避免任何人"顺手"打包进去）。
 *
 * 用法：node scripts/pdf-check.mjs
 * 前置：`npm run build` 已跑过（B 段加载的是 dist/），dev server 已在 4173 端口。
 */

import { chromium, _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BASE = process.env.QP_BASE || 'http://localhost:4173';

const results = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/* ==========================================================================
 * A 段：打印 HTML 结构
 * ========================================================================== */

const FIXTURE = `---
title: 测试文档
author: Quartz
---

# 第一章 排版

正文段落，包含 **粗体**、*斜体*、~~删除线~~ 与 \`行内代码\`，以及中文标点：，。；：

## 1.1 列表与任务

- 第一项
- 第二项
  - 嵌套项

- [x] 已完成任务
- [ ] 未完成任务

## 1.2 表格与代码

| 列 A | 列 B |
| :--- | ---: |
| 1 | 2 |
| 3 | 4 |

\`\`\`js
// 一段足够长的代码，用于验证超高代码块的分页分支
${Array.from({ length: 46 }, (_, i) => `const line${i} = ${i};`).join('\n')}
\`\`\`

### 1.2.1 短代码块

\`\`\`py
print("hi")
\`\`\`

> 引用一段话。
> 第二行。

---

![缺失的图片](not-exists/local.png)

[内部链接](#第一章-排版)

\`\`\`
纯文本代码块
\`\`\`

[pagebreak]

## 第二章 收尾

结尾段落。
`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const built = await page.evaluate(async (markdown) => {
  // 不能 dynamic import('/src/core/print.js')：Electron 段加载的是 dist/ 生产包，
  // 浏览器段虽然能 import，但两条路径会各写一遍。统一走 app.js 挂出来的同一份管线。
  const mod = window.quillpad.print;
  const opts = mod.defaultPdfOptions({ toc: true }, { name: 'Q2 报告.md' });
  const out = await mod.buildPrintHtml(
    { markdown, title: '测试文档', name: 'Q2 报告.md', docDir: null },
    opts,
  );
  const printOptions = mod.buildElectronPrintOptions(opts, { name: 'Q2 报告.md' });
  return {
    html: out.html,
    stats: out.stats,
    printOptions,
    pageCss: mod.buildPageCss(opts),
    opts,
  };
}, FIXTURE);

const html = built.html;

/* ---- 1. @page ---- */
check(
  'A1 @page 含 size:210mm 297mm 与 20/18mm 边距',
  html.includes('@page{size:210mm 297mm;margin:20mm 18mm 20mm 18mm}'),
  (html.match(/@page\{[^}]*\}/g) || []).join(' | ').slice(0, 120),
);

/* ---- 2. break-inside 覆盖面 ---- */
const breakTargets = ['p', 'li', 'blockquote', 'td', 'th', 'img', 'pre'];
const breakCovered = breakTargets.filter((sel) => {
  const re = new RegExp(`\\.qp-print ${sel}\\b[^{]*\\{[^}]*break-inside:\\s*avoid`);
  return re.test(html);
});
check(
  'A2 break-inside:avoid 覆盖 p/li/blockquote/td/th/img/pre',
  breakCovered.length === breakTargets.length,
  `覆盖 ${breakCovered.length}/${breakTargets.length}`,
);

/* ---- 3. 表头重复 + 行不切 ---- */
check(
  'A3 thead{display:table-header-group} 与 tr{break-inside:avoid}',
  /thead\s*\{[^}]*display:\s*table-header-group/.test(html) &&
    /(^|\})\s*\.qp-print tr\s*\{[^}]*break-inside:\s*avoid/.test(html),
  '',
);

/* ---- 4. 超高 pre 走软换行分支 ---- */
check(
  'A4 超高代码块打上 is-tall 且 pre-wrap',
  /<pre class="is-tall"/.test(html) && /\.qp-print pre\.is-tall\s*\{[^}]*white-space:\s*pre-wrap/.test(html),
  `is-tall 块数=${(html.match(/<pre class="is-tall"/g) || []).length}`,
);

/* ---- 5. 自包含：无 script、无外链 ---- */
check(
  'A5 输出无 <script、无 src="http',
  !/<script/i.test(html) && !/src="http/i.test(html),
  `script=${(html.match(/<script/gi) || []).length} http-src=${(html.match(/src="http/gi) || []).length}`,
);

/* ---- 6. 字体内联 ---- */
const fontDataUrls = html.match(/data:font\/(?:ttf|woff2);base64,/g) || [];
check(
  'A6 中文字体以 data:font/*;base64 内联',
  fontDataUrls.length >= 1 && html.length > 1024 * 1024,
  `字体 data URL=${fontDataUrls.length}，HTML=${(html.length / 1024 / 1024).toFixed(2)} MB`,
);

/* ---- 7. 目录 ---- */
const tocCount = (html.match(/class="qp-toc__item/g) || []).length;
check(
  'A7 目录页按 H1–H3 生成且条目数一致',
  tocCount === built.stats.headings && tocCount >= 4,
  `toc=${tocCount} headings=${built.stats.headings}`,
);

/* ---- 8. 任务列表 / 代码着色 / 缺图占位 / 分页标记 ---- */
check(
  'A8 任务项 .qp-task-item / 代码 tok-* 着色 / .qp-img-missing 占位 / .qp-page-break',
  /qp-task-item/.test(html) &&
    /class="tok-/.test(html) &&
    /qp-img-missing/.test(html) &&
    /qp-page-break/.test(html),
  '',
);

/* ---- 9. Electron 参数映射 ---- */
const po = built.printOptions;
check(
  'A9 不传 margins 且 preferCSSPageSize + printBackground 为真',
  !('margins' in po) && po.preferCSSPageSize === true && po.printBackground === true,
  JSON.stringify({ keys: Object.keys(po) }),
);
check(
  'A10 displayHeaderFooter + footerTemplate 带 pageNumber/totalPages',
  po.displayHeaderFooter === true &&
    /class="pageNumber"/.test(po.footerTemplate) &&
    /class="totalPages"/.test(po.footerTemplate),
  po.footerTemplate.slice(0, 80),
);

/* ---- 11. 横向与自定义纸张 ---- */
const pageCss = await page.evaluate(async () => {
  const mod = window.quillpad.print;
  const land = mod.defaultPdfOptions(
    { paper: 'A4', orientation: 'landscape', margin: { top: 10, bottom: 12, left: 8, right: 9 } },
    null,
  );
  const custom = mod.defaultPdfOptions({ paper: 'custom', customWidth: 100, customHeight: 150 }, null);
  return { land: mod.buildPageCss(land), custom: mod.buildPageCss(custom) };
});
check(
  'A11 横向交换宽高 / 自定义纸张 mm 直出',
  pageCss.land.includes('size:297mm 210mm') &&
    pageCss.land.includes('margin:10mm 9mm 12mm 8mm') &&
    pageCss.custom.includes('size:100mm 150mm'),
  `${pageCss.land} | ${pageCss.custom}`,
);

/* ---- 12. 打印 CSS 不复用交互态 ---- */
check(
  'A12 打印 CSS 不含交互态类（qp-md-hide / qp-table-ops / :hover）',
  !/qp-md-hide/.test(html) && !/qp-table-ops/.test(html) && !/qp-print [^{]*:hover/.test(html),
  '',
);

await browser.close();

/* ==========================================================================
 * B 段：真实 Electron 导出
 * ========================================================================== */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-pdf-'));
const targetPdf = path.join(tmpDir, 'qp-check.pdf');

let electronApp = null;
try {
  electronApp = await electron.launch({
    args: ['.'],
    cwd: root,
    timeout: 90000,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'),
    ),
  });
  const win = await electronApp.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.quillpad, null, { timeout: 30000 });
  await win.waitForTimeout(800);

  // 用真实的欢迎文档（有中文、表格、引用），保证字体确实被用到
  const payload = await win.evaluate(async () => {
    const mod = window.quillpad.print;
    const tab = window.quillpad.state.tabs.find((t) => t.id === window.quillpad.state.activeTabId);
    const opts = mod.defaultPdfOptions({ toc: true }, tab);
    const doc = {
      markdown: tab.content,
      title: '导出验收',
      name: tab.name || 'welcome.md',
      docDir: null,
    };
    const builtHtml = await mod.buildPrintHtml(doc, opts);
    return {
      html: builtHtml.html,
      options: mod.buildElectronPrintOptions(opts, doc),
      stats: builtHtml.stats,
    };
  });

  // 注意：filePath 必须给绝对路径。给 null 会走 `dialog.showSaveDialog`，
  // 自动化里没人点按钮，测试会挂在那里。
  const exported2 = await win.evaluate(
    async ({ html: htmlText, options, target }) =>
      window.quillpadDesktop.exportPdf({
        html: htmlText,
        options,
        suggestedName: 'qp-check.pdf',
        filePath: target,
      }),
    { html: payload.html, options: payload.options, target: targetPdf },
  );

  check(
    'B1 隐藏窗口导出返回 ok + 目标文件存在',
    exported2.ok === true && fs.existsSync(targetPdf),
    JSON.stringify({ ok: exported2.ok, path: exported2.path, bytes: exported2.bytes, code: exported2.code }),
  );

  const buf = fs.existsSync(targetPdf) ? fs.readFileSync(targetPdf) : Buffer.alloc(0);
  const text = buf.toString('latin1');

  check('B2 文件头为 %PDF-1. 且体积 > 1000 字节', text.startsWith('%PDF-1.') && buf.length > 1000, `${buf.length} 字节`);

  const fontFile2 = (text.match(/\/FontFile2/g) || []).length;
  const fontFile3 = (text.match(/\/FontFile3/g) || []).length;
  check(
    'B3 存在 /FontFile2 或 /FontFile3（字体真嵌入，非系统引用）',
    fontFile2 + fontFile3 > 0,
    `FontFile2=${fontFile2} FontFile3=${fontFile3}`,
  );

  const baseFonts = [...text.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-#]+)/g)].map((m) => m[1]);
  check(
    'B4 /BaseFont ≥ 2 条（正文 + 等宽/粗体至少两种）',
    baseFonts.length >= 2,
    baseFonts.join(', '),
  );

  const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('B5 页数 ≥ 1（含 /Type /Page 对象）', pageCount >= 1, `${pageCount} 页`);

  check(
    'B6 文本可选中（存在文本绘制算子 Tj/TJ）',
    /\bT[Jj]\b/.test(text),
    `Tj/TJ 命中=${(text.match(/\bT[Jj]\b/g) || []).length}`,
  );

  const windowCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check('B7 导出后隐藏窗口已销毁（只剩主窗口 1 个）', windowCount === 1, `窗口数=${windowCount}`);

  /* ---- 失败路径：目标路径不合法 ---- */
  const bad = await win.evaluate(async ({ html: htmlText, options }) =>
    window.quillpadDesktop.exportPdf({ html: htmlText, options, filePath: 'relative/out.pdf' }),
  { html: payload.html, options: payload.options });
  check(
    'B8 相对路径被拒（EPATH）且未产出文件',
    bad.ok === false && bad.code === 'EPATH' && !fs.existsSync(path.join(root, 'relative/out.pdf')),
    JSON.stringify(bad),
  );

  /* ---- write-asset 路径防护 ---- */
  const asset = await win.evaluate(async (dir) => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const evil = await window.quillpadDesktop.writeAsset({
      docDir: dir,
      fileName: '../evil.png',
      bytes,
    });
    const abs = await window.quillpadDesktop.writeAsset({
      docDir: dir,
      fileName: 'C:/Windows/evil.png',
      bytes,
    });
    const ok1 = await window.quillpadDesktop.writeAsset({ docDir: dir, fileName: 'shot.png', bytes });
    const ok2 = await window.quillpadDesktop.writeAsset({ docDir: dir, fileName: 'shot.png', bytes });
    return { evil, abs, ok1, ok2 };
  }, tmpDir);

  check(
    'B9 write-asset 拒绝 `..` 与绝对路径（EPATH）',
    asset.evil.ok === false && asset.evil.code === 'EPATH' && asset.abs.ok === false && asset.abs.code === 'EPATH',
    JSON.stringify({ evil: asset.evil.code, abs: asset.abs.code }),
  );
  check(
    'B10 write-asset 成功落盘到 assets/ 且重名自动加后缀',
    asset.ok1.ok === true &&
      /assets[\\/]shot\.png$/.test(asset.ok1.path) &&
      asset.ok2.ok === true &&
      asset.ok2.name !== asset.ok1.name &&
      fs.existsSync(asset.ok1.path) &&
      fs.existsSync(asset.ok2.path),
    JSON.stringify({ a: asset.ok1.name, b: asset.ok2.name }),
  );
  check(
    'B11 write-asset 越界文件不存在（`..` 未逃逸出文档目录）',
    !fs.existsSync(path.join(tmpDir, '..', 'evil.png')),
    '',
  );

  /* ---- open-external 协议白名单 ---- */
  const ext = await win.evaluate(async () => {
    const js = await window.quillpadDesktop.openExternal({ url: 'javascript:alert(1)' });
    const data = await window.quillpadDesktop.openExternal({ url: 'data:text/html,<b>x</b>' });
    const file = await window.quillpadDesktop.openExternal({ url: 'file:///C:/definitely-not-here-xyz.txt' });
    return { js, data, file };
  });
  check(
    'B12 open-external 拒绝 javascript:/data:（EPROTO）与不存在的 file:（EPATH）',
    ext.js.code === 'EPROTO' && ext.data.code === 'EPROTO' && ext.file.code === 'EPATH',
    JSON.stringify({ js: ext.js.code, data: ext.data.code, file: ext.file.code }),
  );

  /* ---- 宏持久化 ---- */
  const macroRoundTrip = await win.evaluate(async () => {
    const sample = [
      { id: 'macro-test', name: '测试宏', createdAt: Date.now(), version: 1, steps: [
        { cmd: 'edit.upperCase', sel: { anchor: 0, head: 4 } },
        { cmd: 'edit.duplicateLine', sel: { anchor: 4, head: 4 } },
        { cmd: 'edit.trimTrailing', sel: { anchor: 0, head: 0 } },
      ] },
    ];
    const wrote = await window.quillpadDesktop.writeMacros(sample);
    const read = await window.quillpadDesktop.readMacros();
    const file = await window.quillpadDesktop.macrosPath();
    return { wrote, read, file, exists: !!wrote.path };
  });
  check(
    'B13 宏写入后能读回（3 步 / version 1）',
    macroRoundTrip.wrote.ok === true &&
      Array.isArray(macroRoundTrip.read.macros) &&
      macroRoundTrip.read.macros[0].steps.length === 3 &&
      macroRoundTrip.read.macros[0].version === 1,
    JSON.stringify({ path: macroRoundTrip.wrote.path, count: macroRoundTrip.read.macros.length }),
  );
  check(
    'B14 宏文件落在 userData 目录（%APPDATA%\\QuillPad 或便携版目录）',
    typeof macroRoundTrip.file.path === 'string' && /macros\.json$/.test(macroRoundTrip.file.path),
    macroRoundTrip.file.path,
  );
} catch (err) {
  check('B0 Electron 段执行未抛异常', false, (err && err.message) || String(err));
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => {});
  }
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */

const pdfReport = fs.existsSync(targetPdf)
  ? {
      path: targetPdf,
      bytes: fs.statSync(targetPdf).size,
    }
  : null;

console.log('\n===== pdf-check 摘要 =====');
if (pdfReport) {
  const raw = fs.readFileSync(pdfReport.path).toString('latin1');
  const baseFonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-#]+)/g)].map((m) => m[1]);
  console.log(`产物：${pdfReport.path}`);
  console.log(`字节：${pdfReport.bytes}（${(pdfReport.bytes / 1024).toFixed(1)} KB）`);
  console.log(`字体嵌入标志：/FontFile2=${(raw.match(/\/FontFile2/g) || []).length} /FontFile3=${(raw.match(/\/FontFile3/g) || []).length}`);
  console.log(`嵌入字体：${baseFonts.join(', ') || '（无）'}`);
  console.log(`页数：${(raw.match(/\/Type\s*\/Page[^s]/g) || []).length}`);
} else {
  console.log('产物：未生成（B 段失败）');
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n通过 ${passed}/${results.length}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exitCode = 1;
}

// 清理临时目录（保留 PDF 便于人工目视，调试时可设 QP_KEEP_TMP=1）
if (!process.env.QP_KEEP_TMP) {
  try {
    fs.unlinkSync(targetPdf);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
} else {
  console.log(`临时目录保留：${tmpDir}`);
}
