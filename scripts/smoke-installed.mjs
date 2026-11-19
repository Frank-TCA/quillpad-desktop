/**
 * QuillPad · 装机后验收冒烟（对已安装正式版一键跑，版本号自动读取 package.json）
 *
 * 覆盖 7 组断言（默认全量，对已安装应用）：
 *  1. 标题栏「界面语言」按钮：存在 / 排在按钮区最后 / tooltip 中英 /
 *     下拉含简体中文与 English / 勾选态 / 切换生效
 *  2. 插件管理器：市场安装 quillpad.text-tools → 已安装列表出现 → 卸载 →
 *     成功 toast + 行消失 + pluginList 真删（移植 plugin-manager-check.mjs）
 *  3. 插件安装对话框文件控件双语：EN "Choose File"/"No file chosen"，
 *     ZH 「选择文件」/「未选择任何文件」，选临时 zip 后显示文件名
 *  4. 行号栏 / 折叠箭头：所见即所得**也装**行号槽与折叠槽，且行号与该行首个可见
 *     字符 top 差 ≤1.5px（v1.0.4 需求反转，原「整列不装」断言已作废）；
 *     源码模式保留行号与折叠箭头，且行号与内容行逐行对齐（checked≥10 且 worst≤2.5px）
 *  5. 欢迎文档双语联动：切英文 → tab 变 Welcome.md 且英文模板且非脏；
 *     切回中文恢复；用户编辑过只改名不覆盖
 *  5b. 欢迎文档另存为：虚拟标签改完 → 另存为**新文件**能落盘、标签转为磁盘
 *     文件、二次保存走 nativePath 不再弹框（v1.0.4 第五轮修的 ENOENT）
 *  6. 文件级检查（无需启动应用）：docs/screenshots/ 四张截图存在非空且被
 *     README.md / README.en.md 引用；dist/release/ 三产物存在且达到体积门槛
 *  6d. 表格下沿：表下紧跟正文（无空行）时尾行不被吞进表格 —— 所见即所得表格
 *     行数正确、点「切换对齐」不改写尾行、浮层开着点对齐不产生 `||` 半行、
 *     分栏预览把尾行渲染成 <p>（v1.0.5）
 *  6e. 首开渲染 / 列表 / 单元格（v1.0.6）：视口外的表格首次打开即渲染成 widget、
 *     单元格里的 `**粗**` `*斜*` `` `代码` `` 渲染成真实标签、视口外的有序 / 无序
 *     列表保持序号与圆点、列表末行回车新行序号仍在、整篇其它结构数量不变
 *  6f. 中文标点边界的强调（v1.0.6）：句中的 `**“正文”**` / `*“斜体”*` /
 *     `~~“删除”~~` 都渲染（星号隐藏），表格单元格同样生效，行内代码与围栏内原样
 *  7. 启动参数与文件关联：安装器写下的 .md/.txt 默认关联、能力注册、应用内 IPC
 *     读得到；第二实例转交文件能打开，且不再误报「文件过大」（argv[0] 不再是
 *     待打开文件，程序自己的 238MB exe 不再被读一遍）
 *
 * 用法：
 *   node scripts/smoke-installed.mjs              # 全量（启动已安装应用）
 *   node scripts/smoke-installed.mjs --files-only # 只跑第 6 项文件级断言
 *
 * 前置：已安装同版本 QuillPad（%LOCALAPPDATA%\Programs\QuillPad\QuillPad.exe）。
 *       本脚本只读不装，全量模式结束时会把界面语言 / 欢迎文档 / 插件列表复原。
 * 环境坑：WorkBuddy 沙箱 shell 带 ELECTRON_RUN_AS_NODE=1 + NODE_OPTIONS，
 *        spawn 前必须从 env 删掉这两个键，否则 Electron 报 `bad option`。
 * 执行顺序：第 6 项（文件级，先行 fail-fast）→ 第 1–5、7 项（启动应用）。
 */

import { _electron as electron } from 'playwright-core';
import { existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn, spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
/** 当前版本（产物文件名里的版本号），从 package.json 取，避免发版后脚本失效。 */
const APP_VERSION = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const EXE = path.join(
  process.env.LOCALAPPDATA || 'C:\\Users\\hw\\AppData\\Local',
  'Programs', 'QuillPad', 'QuillPad.exe',
);
const filesOnly = process.argv.includes('--files-only');

const results = [];
/** @param {string} name @param {boolean} ok @param {string} detail */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function summarize() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) {
    console.log('FAILURES:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  return passed === results.length;
}

/** 人话体积：≥1MB 显示 MB，否则 KB。 */
function fmtSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes} B)`
    : `${(bytes / 1024).toFixed(1)} KB (${bytes} B)`;
}

/* ================================================ 第 6 项 · 文件级检查 */
const SHOTS = ['01-editor.png', '02-preview-split.png', '03-command-palette.png', '04-theme-ivory.png'];

function runFileChecks() {
  console.log('── 第 6 项 · 文件级检查（截图 / README 引用 / 发行产物）');
  for (const f of SHOTS) {
    const p = path.join(root, 'docs', 'screenshots', f);
    let size = 0;
    try { size = statSync(p).size; } catch { /* 不存在 */ }
    check(`6.1 docs/screenshots/${f} 存在且非空`, size > 0, size > 0 ? fmtSize(size) : '缺失或为空');
  }
  for (const readme of ['README.md', 'README.en.md']) {
    let text = '';
    try { text = readFileSync(path.join(root, readme), 'utf8'); } catch { /* 不存在 */ }
    const missing = SHOTS.filter((f) => !text.includes(f));
    check(`6.2 ${readme} 引用全部 4 张截图`, missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : '4/4');
  }
  // 独立卸载器按设计只有 ~80 KB（README / USER-GUIDE 均如此记载），门槛取 50 KB；
  // 安装包与便携版按常规要求 >1 MB。
  // 文件名里的版本号从 package.json 取，发版后不用再改这个脚本。
  const ARTIFACTS = [
    [`QuillPad-Setup-v${APP_VERSION}.exe`, 1024 * 1024],
    [`QuillPad-v${APP_VERSION}-portable.exe`, 1024 * 1024],
    [`QuillPad-Uninstaller-v${APP_VERSION}.exe`, 50 * 1024],
  ];
  for (const [f, min] of ARTIFACTS) {
    const p = path.join(root, 'dist', 'release', f);
    let size = 0;
    try { size = statSync(p).size; } catch { /* 不存在 */ }
    const ok = size > min;
    check(`6.3 dist/release/${f} 存在且 >${min >= 1024 * 1024 ? '1MB' : '50KB'}`, ok,
      ok ? fmtSize(size) : `实际 ${size} B（门槛 ${min} B）`);
  }
}

runFileChecks();

if (filesOnly) {
  console.log('\n（--files-only：跳过第 1–5 项应用断言）');
  process.exit(summarize() ? 0 : 1);
}

/* ================================================ 启动已安装正式版 */
if (!existsSync(EXE)) {
  console.error(`\n找不到已安装的 QuillPad：${EXE}`);
  console.error('请先安装同版本 QuillPad 再跑本脚本（或用 --files-only 只验文件级断言）。');
  process.exit(1);
}

/** 清掉可能占着单实例锁的旧进程。 */
function killStale() {
  try {
    execSync('taskkill /F /IM QuillPad.exe /T', { stdio: 'ignore' });
  } catch { /* 没在跑 */ }
}

const consoleLines = [];
const pageErrors = [];

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS'),
);

killStale();
await new Promise((r) => setTimeout(r, 500));

console.log(`── 启动已安装正式版：${EXE}`);
const app = await electron.launch({
  executablePath: EXE,
  args: [],
  timeout: 90000,
  env,
});
const win = await app.firstWindow();
win.on('console', (m) => {
  const rec = `[console.${m.type()}] ${m.text()}`;
  consoleLines.push(rec);
});
win.on('pageerror', (e) => {
  const rec = `[pageerror] ${e.message}`;
  pageErrors.push(rec);
  consoleLines.push(rec);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.quillpad, null, { timeout: 30000 });
await win.waitForTimeout(1000);

/* ================================================ 第 1 项 · 界面语言按钮 */
async function sectionLocaleButton() {
  console.log('── 第 1 项 · 标题栏「界面语言」按钮');
  const localeBtn = win.locator('[data-role="locale-btn"]');
  check('1.1 语言按钮存在', (await localeBtn.count()) === 1);
  const tipZh = await localeBtn.getAttribute('data-tip');
  check('1.2 tooltip 中文', tipZh === '界面语言', tipZh || '(空)');
  const btnOrder = await win.evaluate(() => {
    const rootEl = document.getElementById('titlebar-actions');
    const kids = rootEl ? [...rootEl.children] : [];
    return { last: kids.length ? kids[kids.length - 1].getAttribute('data-role') : null, n: kids.length };
  });
  check('1.3 按钮排在按钮区最后', btnOrder.last === 'locale-btn', JSON.stringify(btnOrder));

  await localeBtn.click();
  await win.waitForTimeout(400);
  const dd = win.locator('.dropdown').first();
  const ddText = await dd.innerText().catch(() => '');
  check('1.4 下拉含简体中文/English', /简体中文/.test(ddText) && /English/.test(ddText), ddText.replace(/\s+/g, '|'));
  const readItems = () => win.locator('.dropdown').first().evaluate((el) => {
    const items = [...el.querySelectorAll('.dropdown__item')];
    return items.map((i) => ({ txt: i.innerText.trim(), checked: !!i.querySelector('.dropdown__item-check svg') }));
  });
  const state1 = await readItems();
  check('1.5 中文态勾选简体中文',
    state1.some((i) => i.txt === '简体中文' && i.checked) && state1.some((i) => i.txt === 'English' && !i.checked),
    JSON.stringify(state1));

  await dd.locator('text=English').click();
  await win.waitForTimeout(1000);
  check('1.6 选 English 后菜单变英文', /\bFile\b/.test(await win.locator('#menubar').innerText()));
  const tipEn = await localeBtn.getAttribute('data-tip');
  check('1.7 tooltip 跟随英文', tipEn === 'Language', tipEn || '(空)');
  await localeBtn.click();
  await win.waitForTimeout(400);
  const state2 = await readItems();
  check('1.8 勾选转移到 English',
    state2.some((i) => i.txt === 'English' && i.checked) && state2.some((i) => i.txt === '简体中文' && !i.checked),
    JSON.stringify(state2));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
}

/* ================================================ 第 2 项 · 插件卸载 */
async function sectionPluginUninstall() {
  console.log('── 第 2 项 · 插件管理器安装→卸载 quillpad.text-tools');
  await win.evaluate(() => window.quillpad.openPluginMarket());
  const pm = win.locator('[data-dialog="plugin-manager"]');
  await pm.waitFor({ state: 'visible', timeout: 10000 });
  await win.waitForTimeout(600);

  const marketCard = win.locator('[data-plugin-row][data-plugin-id="quillpad.text-tools"]');
  await marketCard.waitFor({ state: 'visible', timeout: 15000 });
  await marketCard.locator('[data-plugin-action]').first().click();

  const perm = win.locator('[data-dialog="perm-confirm"]');
  await perm.waitFor({ state: 'visible', timeout: 10000 });
  await perm.locator('[data-btn="install"]').click();

  // 等安装 toast（文案随语言：已安装 / Installed）
  const installToast = win.locator('.toast .toast__msg').filter({ hasText: /已安装|Installed/ });
  let installToastText = '';
  try {
    await installToast.first().waitFor({ state: 'visible', timeout: 20000 });
    installToastText = (await installToast.first().textContent()) || '';
  } catch { /* 下面的 check 会记 FAIL */ }
  check('2.1 安装 toast 出现', /已安装|Installed/.test(installToastText), installToastText);

  const installedRow = win.locator('[data-pm-installed] [data-pm-row][data-plugin-id="quillpad.text-tools"]');
  let rowVisible = true;
  try {
    await installedRow.waitFor({ state: 'visible', timeout: 10000 });
  } catch { rowVisible = false; }
  check('2.2 已安装列表出现该插件行', rowVisible);

  const before = await win.evaluate(async () => {
    const r = await window.quillpadDesktop.pluginList();
    return (r.plugins || []).map((p) => p.id);
  });
  check('2.3 卸载前 pluginList 含插件', before.includes('quillpad.text-tools'), before.join(','));

  const errBefore = pageErrors.length;
  await installedRow.locator('[data-pm-action="uninstall"]').click();

  const anyToast = win.locator('.toast .toast__msg').filter({ hasText: /已卸载|卸载失败|Plugin uninstalled|Could not uninstall/ });
  let uninstallToastText = '';
  try {
    await anyToast.first().waitFor({ state: 'visible', timeout: 12000 });
    uninstallToastText = (await anyToast.first().textContent()) || '';
  } catch { /* check 记 FAIL */ }
  check('2.4 卸载后有 toast 反馈', /已卸载|卸载失败|Plugin uninstalled|Could not uninstall/.test(uninstallToastText), uninstallToastText);
  check('2.5 卸载 toast 是成功态', /已卸载插件|Plugin uninstalled/.test(uninstallToastText), uninstallToastText);

  let rowGone = true;
  try {
    await installedRow.waitFor({ state: 'detached', timeout: 8000 });
  } catch { rowGone = false; }
  check('2.6 已安装列表中的行已消失', rowGone);

  const after = await win.evaluate(async () => {
    const r = await window.quillpadDesktop.pluginList();
    return (r.plugins || []).map((p) => p.id);
  });
  check('2.7 pluginList 不再含该插件（真删）', !after.includes('quillpad.text-tools'), after.join(','));
  check('2.8 点击链路无未捕获异常', pageErrors.length === errBefore,
    pageErrors.slice(errBefore).map((e) => e.message).join(' | '));
}

/* ================================================ 第 3 项 · 安装对话框文件控件双语 */
async function sectionFilePicker() {
  console.log('── 第 3 项 · 插件安装对话框文件控件双语');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qp-smoke-'));
  const zipPath = path.join(tmpDir, 'demo-plugin.zip');
  writeFileSync(zipPath, Buffer.from('PK\x03\x04demo'));

  async function assertFilePicker(locale, btnText, emptyText, n0) {
    await win.evaluate((loc) => window.quillpad.applyLocale(loc), locale);
    await win.waitForTimeout(500);
    await win.evaluate(() => window.quillpad.openInstallFromUrl());
    const dlg = win.locator('[data-dialog="plugin-install"]');
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    const btn = dlg.locator('[data-install-file-btn]');
    const name = dlg.locator('[data-install-file-name]');
    const btnGot = ((await btn.textContent()) || '').trim();
    const nameGot = ((await name.textContent()) || '').trim();
    check(`3.${n0} [${locale}] 按钮文案 == ${btnText}`, btnGot === btnText, btnGot);
    check(`3.${n0 + 1} [${locale}] 占位文案 == ${emptyText}`, nameGot === emptyText, nameGot);

    await dlg.locator('[data-install-file]').setInputFiles(zipPath);
    await win.waitForTimeout(200);
    const nameAfter = ((await name.textContent()) || '').trim();
    check(`3.${n0 + 2} [${locale}] 选文件后显示文件名`, nameAfter === 'demo-plugin.zip', nameAfter);
    await dlg.locator('[data-role="close"]').first().click();
    await win.waitForTimeout(300);
  }

  try {
    await assertFilePicker('en', 'Choose File', 'No file chosen', 1);
    await assertFilePicker('zh-CN', '选择文件', '未选择任何文件', 4);
  } catch (err) {
    check('3.7 文件控件流程执行', false, String((err && err.message) || err));
  }
  rmSync(tmpDir, { recursive: true, force: true });

  // 收掉插件管理器，避免遮挡后续编辑器度量
  try {
    const pmClose = win.locator('[data-dialog="plugin-manager"] [data-role="close"]').first();
    if (await pmClose.count()) await pmClose.click();
  } catch { /* 已关 */ }
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
}

/* ============================================ 第 4 项 · 行号栏 / 折叠箭头 */
async function sectionGutterPolicy() {
  console.log('── 第 4 项 · 行号栏与折叠箭头按视图模式隐显');

  /* v1.0.4 需求反转：所见即得**重新**装上行号槽与折叠槽，并要求行号与每行首个可见
     字符垂直对齐（≤1.5px）；源码 / 分栏本来就是 CodeMirror 原生对齐。
     ⚠️ 4.1 的旧断言「所见即得下不显示行号栏与折叠箭头」因此被需求作废 —— 那不是
     回归，这里改成正向断言，其余断言（源码对齐、箭头数量）一条都没放宽。 */
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(900);
  /* 先把侧栏收起，让正文列宽度与用户实际阅读时一致（更宽的标题更容易暴露对齐误差） */
  await win.evaluate(() => window.quillpad.setSidebarVisible?.(false));
  await win.waitForTimeout(400);
  const wy = await win.evaluate(async () => {
    const view = window.quillpad.editor.view;
    const doc = view.state.doc;
    const g = document.querySelector('.cm-gutters');
    /** 行号数字的文本矩形 */
    const numRect = (el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const idx = (node.nodeValue || '').search(/\S/);
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 1);
          const r = range.getBoundingClientRect();
          if (r.height > 0) return r;
        }
        node = walker.nextNode();
      }
      return null;
    };
    /** 行内首个可见字符的矩形（跳过隐藏标记与 widget 内部文字） */
    const charRect = (line) => {
      const SKIP =
        '.qp-md-hide, .qp-code-head, .qp-code-ops, .qp-table-wrap, .qp-toc, .qp-frontmatter, .qp-math--block, .qp-footnotes, .qp-img-wrap';
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const idx = (node.nodeValue || '').search(/\S/);
        if (idx >= 0 && !(node.parentElement && node.parentElement.closest(SKIP))) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + 1);
          const r = range.getBoundingClientRect();
          if (r.height > 0) return r;
        }
        node = walker.nextNode();
      }
      return null;
    };
    let checked = 0;
    let worst = 0;
    const bad = [];
    const seen = new Set();
    const collect = () => {
      const nums = Array.from(
        view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
      ).filter((el) => el.style.visibility !== 'hidden' && /^\d+$/.test(el.textContent.trim()));
      for (const el of Array.from(view.contentDOM.querySelectorAll('.cm-line'))) {
        let no;
        try {
          no = doc.lineAt(view.posAtDOM(el, 0)).number;
        } catch {
          continue;
        }
        if (seen.has(no)) continue;
        const slot = nums.find((n) => n.textContent.trim() === String(no));
        if (!slot) continue;
        const cr = charRect(el);
        if (!cr) continue;
        const nr = numRect(slot);
        if (!nr) continue;
        seen.add(no);
        const d = Math.abs(nr.top - cr.top);
        checked += 1;
        if (d > worst) worst = Math.round(d * 10) / 10;
        if (d > 1.5) bad.push(`L${no} 差${Math.round(d * 10) / 10}`);
      }
    };
    const step = Math.round(view.scrollDOM.clientHeight * 0.6);
    for (let y = 0; y <= view.scrollDOM.scrollHeight; y += step) {
      view.scrollDOM.scrollTop = y;
      view.requestMeasure();
      await new Promise((res) => setTimeout(res, 130));
      collect();
    }
    view.scrollDOM.scrollTop = 0;
    view.requestMeasure();
    await new Promise((res) => setTimeout(res, 220));
    collect();
    return {
      gutters: g ? Math.round(g.getBoundingClientRect().width) : null,
      lineNumbers: !!document.querySelector('.cm-lineNumbers'),
      foldGutter: !!document.querySelector('.cm-foldGutter'),
      /* 布局验算：行号槽贴滚动区左缘（与源码模式同一水平位置），正文列在槽位
         右侧的剩余空间居中 —— 左、右两段留白应等宽。 */
      gutterLeft: Math.round(
        g.getBoundingClientRect().left - document.querySelector('.cm-scroller').getBoundingClientRect().left,
      ),
      gapLeft: Math.round(
        document.querySelector('.cm-content').getBoundingClientRect().left -
          g.getBoundingClientRect().right,
      ),
      gapRight: Math.round(
        document.querySelector('.cm-scroller').getBoundingClientRect().left +
          document.querySelector('.cm-scroller').clientWidth -
          document.querySelector('.cm-content').getBoundingClientRect().right,
      ),
      checked,
      worst,
      bad: bad.slice(0, 6),
    };
  });
  await win.evaluate(() => window.quillpad.setSidebarVisible?.(true));
  await win.waitForTimeout(300);
  check('4.1 所见即所得显示行号栏与折叠箭头（v1.0.4 需求变更，反向断言已作废）',
    wy.gutters !== null && wy.gutters > 0 && wy.lineNumbers && wy.foldGutter,
    `gutters=${wy.gutters} lineNumbers=${wy.lineNumbers} foldGutter=${wy.foldGutter}`);
  check('4.1b 所见即所得行号与该行首个可见字符 top 差 ≤1.5px',
    wy.checked >= 10 && wy.worst <= 1.5,
    `${wy.checked} 行 worst=${wy.worst}px${wy.bad.length ? ' ' + wy.bad.join(',') : ''}`);
  check('4.1c 所见即所得行号槽贴左、正文列在剩余空间居中',
    wy.gutterLeft === 0 && wy.gapLeft > 0 && Math.abs(wy.gapLeft - wy.gapRight) <= 1,
    `槽左偏=${wy.gutterLeft}px 左留白=${wy.gapLeft}px 右留白=${wy.gapRight}px`);

  await win.evaluate(() => window.quillpad.setViewMode('source', { user: true }));
  await win.waitForTimeout(800);

  /** 源码模式：行号槽与内容行的逐行对齐（行号槽文本 → 落在同一行盒内）。 */
  const measure = async () => win.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    const nums = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter(
      (el) => el.offsetHeight > 0 && el.style.visibility !== 'hidden' && el.textContent.trim(),
    );
    const folds = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')].filter(
      (el) => el.offsetHeight > 0 && el.style.visibility !== 'hidden' && el.innerHTML.trim(),
    );
    let checked = 0;
    let worst = 0;
    const bad = [];
    for (const n of nums) {
      const r = n.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const line = lines.find((l) => mid >= l.top - 0.5 && mid <= l.bottom + 0.5);
      if (!line) continue;
      const d = Math.abs(r.top - line.top);
      checked += 1;
      if (d > worst) worst = d;
      if (d > 2.5) bad.push(Math.round(d * 10) / 10);
    }
    return { checked, worst: Math.round(worst * 10) / 10, bad: bad.slice(0, 8), folds: folds.length };
  });

  let totalChecked = 0;
  let totalWorst = 0;
  let foldTotal = 0;
  const allBad = [];
  const scrollInfo = await win.evaluate(() => {
    const s = document.querySelector('.cm-scroller');
    return { h: s.scrollHeight, vh: s.clientHeight };
  });
  for (let y = 0; y <= scrollInfo.h; y += Math.max(300, scrollInfo.vh * 0.7)) {
    await win.evaluate((top) => {
      const s = document.querySelector('.cm-scroller');
      if (s) s.scrollTop = top;
    }, y);
    await win.waitForTimeout(200);
    const r = await measure();
    totalChecked += r.checked;
    if (r.worst > totalWorst) totalWorst = r.worst;
    if (r.folds > foldTotal) foldTotal = r.folds;
    allBad.push(...r.bad);
  }

  check('4.2 源码模式保留行号栏与折叠箭头',
    totalChecked >= 10 && foldTotal >= 1,
    `行号=${totalChecked} 箭头=${foldTotal}`);
  check('4.3 源码模式行号与内容行对齐（≤2.5px）',
    totalChecked >= 10 && totalWorst <= 2.5,
    `checked=${totalChecked} worst=${totalWorst}px bad=[${allBad.join(',')}]`);

  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(700);
}

/* ================================================ 第 5 项 · 欢迎文档双语联动 */
async function sectionWelcomeDoc() {
  console.log('── 第 5 项 · 欢迎文档双语联动');
  await win.evaluate(() => window.quillpad.applyLocale('en'));
  await win.waitForTimeout(900);
  const tabsText = await win.locator('#tabbar').innerText();
  check('5.1 切英文后 tab 名 Welcome.md',
    /Welcome\.md/.test(tabsText) && !/欢迎\.md/.test(tabsText),
    tabsText.replace(/\s+/g, '|').slice(0, 60));
  const w1 = await win.evaluate(() => {
    const t = window.quillpad.state.tabs.find((x) => x.path === 'Welcome.md' || x.path === '欢迎.md');
    return t ? { name: t.name, en: t.content.startsWith('# Welcome to QuillPad'), dirty: t.content !== t.savedContent } : null;
  });
  check('5.2 内容换成英文模板且非脏', !!w1 && w1.en && !w1.dirty, JSON.stringify(w1));

  await win.evaluate(() => window.quillpad.applyLocale('zh-CN'));
  await win.waitForTimeout(900);
  const w2 = await win.evaluate(() => {
    const t = window.quillpad.state.tabs.find((x) => x.path === 'Welcome.md' || x.path === '欢迎.md');
    return t ? { name: t.name, zh: t.content.startsWith('# 欢迎使用 QuillPad') } : null;
  });
  check('5.3 切回中文恢复', !!w2 && w2.name === '欢迎.md' && w2.zh, JSON.stringify(w2));

  await win.evaluate(() => {
    const t = window.quillpad.state.tabs.find((x) => x.path === '欢迎.md');
    t.content = '用户手写内容';
    t.savedContent = '用户手写内容';
    if (window.quillpad.state.activeTabId === t.id) window.quillpad.editor.resetContent(t);
  });
  await win.evaluate(() => window.quillpad.applyLocale('en'));
  await win.waitForTimeout(800);
  const w3 = await win.evaluate(() => {
    const t = window.quillpad.state.tabs.find((x) => x.path === 'Welcome.md' || x.path === '欢迎.md');
    return t ? { name: t.name, content: t.content } : null;
  });
  check('5.4 编辑过不覆盖内容只改名', !!w3 && w3.content === '用户手写内容' && w3.name === 'Welcome.md', JSON.stringify(w3));

  // 复原：清空后按空文档换回中文模板，界面语言回 zh-CN（不给会话留脏状态）
  await win.evaluate(() => {
    const t = window.quillpad.state.tabs.find((x) => x.path === 'Welcome.md' || x.path === '欢迎.md');
    if (t) {
      t.content = '';
      t.savedContent = '';
      if (window.quillpad.state.activeTabId === t.id) window.quillpad.editor.resetContent(t);
    }
  });
  await win.evaluate(() => window.quillpad.applyLocale('zh-CN'));
  await win.waitForTimeout(600);
}

/* ===================== 第 5b 项 · 欢迎文档另存为（v1.0.4 第五轮修复） */
/**
 * 欢迎文档是内存里的虚拟标签：`path` 只是显示名、`nativePath` / `handleKey`
 * 都为空，所以「保存」必然被路由到「另存为」。而 v1.0.0 起主进程的写入函数
 * 在写之前无条件 `stat` 目标，目标文件不存在就 ENOENT —— 于是欢迎文档（以及
 * 任何「未命名」标签）第一次保存永远失败，弹「保存失败：ENOENT …」。
 *
 * 这里用主进程桩把系统对话框换成临时目录里的**新文件名**，验证整条链路真的
 * 落盘，并且第二次保存走 `nativePath` 直接写回、不再弹框。
 */
async function sectionWelcomeSave() {
  console.log('── 第 5b 项 · 欢迎文档另存为（新文件）');
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(500);

  const info = await win.evaluate(() => {
    const app = window.quillpad;
    let t = app.state.tabs.find((x) => x.path === '欢迎.md' || x.path === 'Welcome.md');
    if (!t) {
      app.openWelcomeDocument();
      t = app.state.tabs.find((x) => x.path === '欢迎.md' || x.path === 'Welcome.md');
    }
    if (!t) return null;
    app.activateTab(t.id);
    return { id: t.id, name: t.name, path: t.path, nativePath: t.nativePath || null };
  });
  check(
    '5b.1 存在虚拟欢迎标签（无磁盘路径）',
    !!info && info.path === '欢迎.md' && info.nativePath === null,
    JSON.stringify(info),
  );
  if (!info) return;
  await win.waitForTimeout(500);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qp-welcome-'));
  const target = path.join(tmpDir, 'welcome-saved.md');
  await app.evaluate(async ({ dialog }, file) => {
    globalThis.__qpRealSave = dialog.showSaveDialog;
    globalThis.__qpSaveCalls = 0;
    dialog.showSaveDialog = async () => {
      globalThis.__qpSaveCalls += 1;
      return { canceled: false, filePath: file };
    };
  }, target);

  const edited = await win.evaluate((id) => {
    window.quillpad.editor.view.dispatch({ changes: { from: 0, insert: 'WELCOME-EDIT\n' } });
    const t = window.quillpad.state.tabs.find((x) => x.id === id);
    return { dirty: t.content !== t.savedContent, head: t.content.slice(0, 12) };
  }, info.id);
  check(
    '5b.2 欢迎文档可编辑并进入未保存态',
    edited.dirty && edited.head.startsWith('WELCOME-EDIT'),
    JSON.stringify(edited),
  );

  const saved1 = await win.evaluate(() => window.quillpad.saveActive());
  await win.waitForTimeout(500);
  const afterSave = await win.evaluate((id) => {
    const t = window.quillpad.state.tabs.find((x) => x.id === id);
    return t
      ? { dirty: t.content !== t.savedContent, path: t.path, nativePath: t.nativePath || null, name: t.name }
      : null;
  }, info.id);
  const calls1 = await app.evaluate(async () => globalThis.__qpSaveCalls);
  const onDisk = existsSync(target) ? readFileSync(target, 'utf8') : '';
  check(
    '5b.3 另存为到新文件成功落盘',
    saved1 === true && onDisk.startsWith('WELCOME-EDIT'),
    `ok=${saved1} 写出=${onDisk.length}B 弹框=${calls1}`,
  );
  check(
    '5b.4 保存后标签转为磁盘文件且不再脏',
    !!afterSave &&
      !afterSave.dirty &&
      path.isAbsolute(afterSave.path || '') &&
      afterSave.nativePath === afterSave.path,
    JSON.stringify(afterSave),
  );

  await win.evaluate(() => {
    window.quillpad.editor.view.dispatch({ changes: { from: 0, insert: 'SECOND-EDIT\n' } });
  });
  const saved2 = await win.evaluate(() => window.quillpad.saveActive());
  await win.waitForTimeout(400);
  const calls2 = await app.evaluate(async () => globalThis.__qpSaveCalls);
  const onDisk2 = existsSync(target) ? readFileSync(target, 'utf8') : '';
  check(
    '5b.5 二次保存直接写回、不再弹另存为',
    saved2 === true && calls2 === calls1 && onDisk2.startsWith('SECOND-EDIT'),
    `ok=${saved2} 弹框=${calls2} 开头=${JSON.stringify(onDisk2.slice(0, 12))}`,
  );

  /* 5b.6 英文欢迎文档走同一条路径（defaultName = Welcome.md） */
  const target2 = path.join(tmpDir, 'welcome-en.md');
  await app.evaluate(async ({ dialog }, file) => {
    dialog.showSaveDialog = async () => {
      globalThis.__qpSaveCalls += 1;
      return { canceled: false, filePath: file };
    };
  }, target2);
  await win.evaluate(() => window.quillpad.applyLocale('en'));
  await win.waitForTimeout(900);
  const enInfo = await win.evaluate(async () => {
    const app = window.quillpad;
    app.openWelcomeDocument();
    await new Promise((r) => setTimeout(r, 600));
    const t = app.state.tabs.find((x) => x.path === 'Welcome.md');
    if (!t) return null;
    app.activateTab(t.id);
    app.editor.view.dispatch({ changes: { from: 0, insert: 'EN-EDIT\n' } });
    return { id: t.id, name: t.name, path: t.path, dirty: t.content !== t.savedContent };
  });
  const savedEn = await win.evaluate(() => window.quillpad.saveActive());
  await win.waitForTimeout(400);
  const onDiskEn = existsSync(target2) ? readFileSync(target2, 'utf8') : '';
  check(
    '5b.6 英文欢迎文档同样能另存为',
    !!enInfo && enInfo.path === 'Welcome.md' && enInfo.dirty && savedEn === true && onDiskEn.startsWith('EN-EDIT'),
    `path=${enInfo && enInfo.path} ok=${savedEn} 写出=${onDiskEn.length}B`,
  );

  // 还原：恢复真实对话框、关掉这两个已落盘的标签、回中文、删临时目录、补回内置欢迎文档
  await app.evaluate(async ({ dialog }) => {
    if (globalThis.__qpRealSave) dialog.showSaveDialog = globalThis.__qpRealSave;
  });
  if (enInfo) await win.evaluate((id) => window.quillpad.closeTab(id, true), enInfo.id);
  await win.evaluate((id) => window.quillpad.closeTab(id, true), info.id);
  await win.waitForTimeout(400);
  await win.evaluate(() => window.quillpad.applyLocale('zh-CN'));
  await win.waitForTimeout(700);
  rmSync(tmpDir, { recursive: true, force: true });
  await win.evaluate(() => {
    const app = window.quillpad;
    if (!app.state.tabs.some((x) => x.path === '欢迎.md' || x.path === 'Welcome.md')) {
      app.openWelcomeDocument();
    }
  });
  await win.waitForTimeout(500);
}

/* =========================== 第 6b 项 · 分隔线的绘制位置与宽度（v1.0.4 第二轮） */
/**
 * 分隔线所在行是 `font-size/line-height: 0` + 上下 padding 撑出来的：
 * 前一行是空行时**上**内边距会被压到 4px（与预览的外边距折叠等价），
 * 行内布局的 `<hr>` 于是贴在行顶。改成绝对定位 `top: 50%` 后横线必须落在
 * 行高中线上，且仍铺满内容列（与表格 / 正文同宽）。
 */
async function sectionHrLayout() {
  console.log('── 第 6b 项 · 分隔线垂直居中');
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(800);
  const saved = await win.evaluate(() => {
    const app = window.quillpad;
    const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
    const before = tab.content;
    app.setTabContent(tab.id, '正文段落。\n\n---\n\n下一段。\n');
    app.refreshViewMode();
    return { id: tab.id, before };
  });
  await win.waitForTimeout(900);
  const m = await win.evaluate(() => {
    const line = document.querySelector('.cm-line.qp-hr-line');
    const bar = line && line.querySelector('.qp-hr');
    const content = document.querySelector('.cm-content');
    if (!line || !bar || !content) return { found: false };
    const lb = line.getBoundingClientRect();
    const hb = bar.getBoundingClientRect();
    const cb = content.getBoundingClientRect();
    return {
      found: true,
      lineH: Math.round(lb.height),
      above: Math.round(hb.top - lb.top),
      below: Math.round(lb.bottom - hb.bottom),
      width: Math.round(hb.width),
      contentW: Math.round(cb.width),
      left: Math.round(hb.left - cb.left),
    };
  });
  check(
    '6b.1 分隔线画在行盒垂直中线上',
    m.found && Math.abs(m.above - m.below) <= 1 && m.above >= 8,
    m.found ? `行高=${m.lineH}px 上=${m.above} 下=${m.below}` : '未找到 .qp-hr',
  );
  check(
    '6b.2 分隔线铺满内容列宽（与表格 / 正文同宽）',
    m.found && m.width === m.contentW && m.left === 0,
    m.found ? `横线=${m.width}px 内容列=${m.contentW}px 左偏=${m.left}px` : '未找到 .qp-hr',
  );
  // 还原文档，别把测过的短文档留给后续项目
  await win.evaluate((s) => {
    window.quillpad.setTabContent(s.id, s.before);
    window.quillpad.refreshViewMode();
  }, saved);
  await win.waitForTimeout(500);
}

/* ================================================ 第 6c 项 · 表格交互（v1.0.4 第五轮） */
/**
 * 1) 单击单元格就进编辑（不再需要双击）；
 * 2) 切换对齐按钮连点：每次都作用在**同一列**（widget 重建后列号不能漂回首列）；
 * 3) 末尾单元格回车 → 光标落到表格之外；
 * 4) 表格左右两侧空白点击 → 光标停在表外，Delete / Backspace 删掉整张表。
 */
async function sectionTableInteraction() {
  console.log('── 第 6c 项 · 表格交互');
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(700);

  const TABLE_DOC = '# 表\n\n| 列一 | 列二 | 列三 |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n\n表后段落。\n';
  const saved = await win.evaluate((d) => {
    const app = window.quillpad;
    const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
    const before = tab.content;
    app.setTabContent(tab.id, d);
    app.refreshViewMode();
    return { id: tab.id, before };
  }, TABLE_DOC);
  await win.waitForTimeout(900);

  const loadTable = async () => {
    await win.evaluate((d) => {
      const app = window.quillpad;
      const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
      app.setTabContent(tab.id, d);
      app.refreshViewMode();
    }, TABLE_DOC);
    await win.waitForTimeout(800);
  };
  /** 单元格中心点 */
  const cellAt = (r, c) =>
    win.evaluate(([rr, cc]) => {
      const el = document.querySelector(`.qp-table__cell[data-r="${rr}"][data-c="${cc}"]`);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, [r, c]);
  /** 点一格（并退出浮层，避免影响下一步按键） */
  const pickCell = async (r, c) => {
    const p = await cellAt(r, c);
    if (!p) return false;
    await win.mouse.click(p.x, p.y);
    await win.waitForTimeout(350);
    return true;
  };
  const delimiter = () =>
    win.evaluate(() => window.quillpad.editor.view.state.doc.line(4).text);
  const caret = () =>
    win.evaluate(() => {
      const v = window.quillpad.editor.view;
      const s = v.state.selection.main;
      const line = v.state.doc.lineAt(s.head);
      return { head: s.head, line: line.number, col: s.head - line.from, docLen: v.state.doc.length };
    });
  const overlay = () =>
    win.evaluate(() => {
      const el = document.querySelector('.qp-cell-editor:not([hidden])');
      return el
        ? { open: true, value: el.value, r: Number(el.dataset.r), c: Number(el.dataset.c) }
        : { open: false };
    });

  /* 6c.1 单击即编辑 */
  await pickCell(1, 1);
  const one = await overlay();
  check(
    '6c.1 单击单元格即进入编辑（浮层值 = 该格文本）',
    one.open && one.value === 'b1' && one.r === 1 && one.c === 1,
    JSON.stringify(one),
  );
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  /* 6c.2 对齐按钮连点：列不漂移 */
  await loadTable();
  await pickCell(2, 2);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  const alignBtn = () =>
    win.evaluate(() => {
      const b = document.querySelector('.qp-table-ops__btn[data-op="alignCycle"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  const d = [];
  for (let i = 0; i < 2; i += 1) {
    const a = await alignBtn();
    if (!a) break;
    await win.mouse.click(a.x, a.y);
    await win.waitForTimeout(400);
    d.push(await delimiter());
  }
  const colAt = (line, i) => (line || '').split('|').map((x) => x.trim()).filter(Boolean)[i] || '';
  check(
    '6c.2 切换对齐连点两次都作用在第三列（不会漂回首列）',
    d.length === 2 && colAt(d[0], 2) === ':---' && colAt(d[1], 2) === ':---:' && colAt(d[1], 0) === '---',
    JSON.stringify(d),
  );

  /* 6c.3 末格回车 → 光标出表 */
  await loadTable();
  const lastCell = await win.evaluate(() => {
    const cells = [...document.querySelectorAll('.qp-table__cell')];
    const el = cells[cells.length - 1];
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: el.dataset.r, c: el.dataset.c };
  });
  await win.mouse.click(lastCell.x, lastCell.y);
  await win.waitForTimeout(400);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);
  const afterEnter = await caret();
  const enterOverlay = await overlay();
  check(
    '6c.3 末尾单元格回车 → 光标落到表格之外的下一行',
    !enterOverlay.open && afterEnter.line === 7 && afterEnter.col === 0,
    `${JSON.stringify(lastCell)} → L${afterEnter.line}:${afterEnter.col} 浮层=${enterOverlay.open}`,
  );

  /* 6c.4 左侧空白 + Delete */
  await loadTable();
  const geoL = await win.evaluate(() => {
    const w = document.querySelector('.qp-table-wrap').getBoundingClientRect();
    const g = document.querySelector('.cm-gutters').getBoundingClientRect();
    return { x: (g.right + w.left) / 2, y: w.top + w.height / 2, from: w.left };
  });
  await win.mouse.click(geoL.x, geoL.y);
  await win.waitForTimeout(350);
  const atLeft = await caret();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(450);
  const afterDel = await win.evaluate(() => ({
    table: !!document.querySelector('.qp-table'),
    len: window.quillpad.editor.view.state.doc.length,
  }));
  check(
    '6c.4 点表格左侧空白 → 光标在表外，Delete 删掉整张表',
    atLeft.col === 0 && !afterDel.table && afterDel.len < TABLE_DOC.length - 40,
    `落点 L${atLeft.line}:${atLeft.col} 剩余表=${afterDel.table} docLen=${afterDel.len}`,
  );

  /* 6c.5 右侧空白 + Backspace */
  await loadTable();
  const geoR = await win.evaluate(() => {
    const w = document.querySelector('.qp-table-wrap').getBoundingClientRect();
    const sc = document.querySelector('.cm-scroller').getBoundingClientRect();
    return { x: (w.right + sc.right) / 2, y: w.top + w.height / 2 };
  });
  await win.mouse.click(geoR.x, geoR.y);
  await win.waitForTimeout(350);
  const atRight = await caret();
  await win.keyboard.press('Backspace');
  await win.waitForTimeout(450);
  const afterBs = await win.evaluate(() => ({
    table: !!document.querySelector('.qp-table'),
    len: window.quillpad.editor.view.state.doc.length,
  }));
  check(
    '6c.5 点表格右侧空白 → 光标在表外，Backspace 删掉整张表',
    !afterBs.table && afterBs.len < TABLE_DOC.length - 40,
    `落点 L${atRight.line}:${atRight.col} 剩余表=${afterBs.table} docLen=${afterBs.len}`,
  );

  /* 6c.6 左侧空白 + Backspace → 表格保留（只有 Delete 删表） */
  await loadTable();
  const geoL2 = await win.evaluate(() => {
    const w = document.querySelector('.qp-table-wrap').getBoundingClientRect();
    const g = document.querySelector('.cm-gutters').getBoundingClientRect();
    return { x: (g.right + w.left) / 2, y: w.top + w.height / 2 };
  });
  await win.mouse.click(geoL2.x, geoL2.y);
  await win.waitForTimeout(350);
  const atLeft2 = await caret();
  await win.keyboard.press('Backspace');
  await win.waitForTimeout(450);
  const afterBsL = await win.evaluate(() => ({
    table: !!document.querySelector('.qp-table'),
    len: window.quillpad.editor.view.state.doc.length,
  }));
  check(
    '6c.6 左侧空白 + Backspace → 表格保留（反方向键不回删表）',
    atLeft2.col === 0 && afterBsL.table && afterBsL.len >= TABLE_DOC.length - 2,
    `落点 L${atLeft2.line}:${atLeft2.col} 剩余表=${afterBsL.table} docLen=${afterBsL.len}`,
  );

  /* 6c.7 右侧空白 + Delete → 表格保留（只有 Backspace 删表） */
  await loadTable();
  const geoR2 = await win.evaluate(() => {
    const w = document.querySelector('.qp-table-wrap').getBoundingClientRect();
    const sc = document.querySelector('.cm-scroller').getBoundingClientRect();
    return { x: (w.right + sc.right) / 2, y: w.top + w.height / 2 };
  });
  await win.mouse.click(geoR2.x, geoR2.y);
  await win.waitForTimeout(350);
  const atRight2 = await caret();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(450);
  const afterDelR = await win.evaluate(() => ({
    table: !!document.querySelector('.qp-table'),
    len: window.quillpad.editor.view.state.doc.length,
  }));
  check(
    '6c.7 右侧空白 + Delete → 表格保留（反方向键不删表）',
    afterDelR.table && afterDelR.len >= TABLE_DOC.length - 2,
    `落点 L${atRight2.line}:${atRight2.col} 剩余表=${afterDelR.table} docLen=${afterDelR.len}`,
  );

  // 还原文档
  await win.evaluate((s) => {
    window.quillpad.setTabContent(s.id, s.before);
    window.quillpad.refreshViewMode();
  }, saved);
  await win.waitForTimeout(500);
}

/* =========================================== 第 6d 项 · 表格下沿（v1.0.5） */
/**
 * GFM 规范让表格一直续到空行，于是「表下紧跟正文」会被当成表格行。
 * QuillPad 统一改为「不含竖线的行结束表格」，这里盯四件事：
 *  1) 所见即所得里尾行不再被吞进表格（表格行数正确、正文仍是正文行）；
 *  2) 点一次「切换对齐」不会把尾行改写成 `| 正文 |  |`；
 *  3) 单元格浮层开着点对齐 → 先提交再操作，不产生半行拼接（`||`）；
 *  4) 分栏预览与所见即所得一致：尾行渲染成 <p>，不在 <table> 里。
 */
async function sectionTableTail() {
  console.log('── 第 6d 项 · 表格下沿不被吞');
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(700);

  /* 注意：最后一行「第二行正文」后面没有空行，正是用户报的场景 */
  const TAIL_DOC = '# 表\n\n| 列一 | 列二 |\n| --- | --- |\n| a1 | b1 |\n表尾正文\n第二行正文\n';
  const saved = await win.evaluate((d) => {
    const app = window.quillpad;
    const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
    const before = tab.content;
    app.setTabContent(tab.id, d);
    app.refreshViewMode();
    return { id: tab.id, before };
  }, TAIL_DOC);
  await win.waitForTimeout(900);

  const loadTail = async () => {
    await win.evaluate((d) => {
      const app = window.quillpad;
      const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
      app.setTabContent(tab.id, d);
      app.refreshViewMode();
    }, TAIL_DOC);
    await win.waitForTimeout(800);
  };
  const docNow = () => win.evaluate(() => window.quillpad.editor.view.state.doc.toString());
  const tableRows = () =>
    win.evaluate(() => document.querySelectorAll('.qp-table tr').length);
  const visibleLines = () =>
    win.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => l.textContent.trim()));
  const clickAlign = async () => {
    const p = await win.evaluate(() => {
      const b = document.querySelector('.qp-table-ops__btn[data-op="alignCycle"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!p) return false;
    await win.mouse.move(p.x, p.y);
    await win.waitForTimeout(160);
    await win.mouse.click(p.x, p.y);
    await win.waitForTimeout(420);
    return true;
  };

  /* 6d.1 尾行不被吞进表格 */
  const rows0 = await tableRows();
  const lines0 = await visibleLines();
  check(
    '6d.1 表下紧跟正文时，表格只渲染表头 + 数据行，正文仍是正文行',
    rows0 === 2 && lines0.includes('表尾正文') && lines0.includes('第二行正文'),
    `tr=${rows0} 可见行=${JSON.stringify(lines0)}`,
  );

  /* 6d.2 切换对齐不改写尾行 */
  await clickAlign();
  const docAfterAlign = await docNow();
  check(
    '6d.2 点「切换对齐」只改分隔行，不把尾行改写成表格行',
    docAfterAlign.includes('表尾正文\n第二行正文') &&
      !docAfterAlign.includes('| 表尾正文') &&
      docAfterAlign.split('\n')[3].includes(':---'),
    JSON.stringify(docAfterAlign),
  );

  /* 6d.3 浮层开着点对齐 → 先提交再操作，不留半行 */
  await loadTail();
  const cell = await win.evaluate(() => {
    const el = document.querySelector('.qp-table__cell[data-r="1"][data-c="0"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  if (cell) {
    await win.mouse.click(cell.x, cell.y);
    await win.waitForTimeout(350);
  }
  const alignRan = await clickAlign();
  await win.keyboard.press('Enter');
  await win.waitForTimeout(450);
  const docAfterRace = await docNow();
  check(
    '6d.3 单元格浮层开着时点对齐 → 提交不产生 `||` 半行',
    alignRan && !docAfterRace.includes('||') && !docAfterRace.includes('| 表尾正文'),
    JSON.stringify(docAfterRace),
  );

  /* 6d.4 分栏预览同规则：尾行是 <p> 不是表格单元格 */
  const preview = await win.evaluate(() => {
    window.quillpad.setViewMode('split');
    return new Promise((resolve) =>
      setTimeout(() => {
        const el = document.querySelector('#preview-pane .markdown-body');
        const table = el ? el.querySelector('table') : null;
        resolve({
          html: el ? el.innerHTML.replace(/\s+/g, ' ').trim() : '',
          rows: table ? table.querySelectorAll('tr').length : 0,
        });
      }, 500),
    );
  });
  check(
    '6d.4 分栏预览里尾行渲染为 <p>，表格只有表头 + 一行数据',
    preview.rows === 2 && preview.html.includes('<p>表尾正文 第二行正文</p>'),
    `tr=${preview.rows} html=${preview.html.slice(0, 120)}`,
  );
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
  await win.waitForTimeout(500);

  // 还原文档
  await win.evaluate((s) => {
    window.quillpad.setTabContent(s.id, s.before);
    window.quillpad.refreshViewMode();
  }, saved);
  await win.waitForTimeout(500);
}

/* ============================== 第 6e 项 · 首开渲染 / 列表 / 单元格（v1.0.6） */
/**
 * 造一份「表格 / 列表 / 引用都在视口外」的大文档。
 * 首次打开时语法树是惰性分片解析的，视口外的块结构过去会整段丢失
 * （表格不渲染、列表行首没有点与序号），必须靠全文解析 + 解析推进后重扫补上。
 */
function buildBigDoc() {
  const out = ['# 大文档', ''];
  for (let i = 0; i < 90; i += 1) {
    out.push(`前置段落 ${i}：撑大文档体积，让结构落在视口之外。`);
    out.push('');
  }
  out.push('## 表格区', '');
  out.push('| 样式 | 内容 |');
  out.push('| --- | --- |');
  out.push('| 粗体 | **加粗文字** |');
  out.push('| 斜体 | *斜体文字* |');
  out.push('| 代码 | `inline()` |');
  out.push('');
  out.push('## 列表区', '');
  out.push('1. 有序甲');
  out.push('2. 有序乙');
  out.push('');
  out.push('- 无序甲');
  out.push('- 无序乙');
  out.push('');
  out.push('> 引用尾巴');
  out.push('');
  for (let i = 0; i < 60; i += 1) {
    out.push(`尾部段落 ${i}：继续把文档拉长。`);
    out.push('');
  }
  return out.join('\n');
}

async function sectionWysiwygStructure() {
  console.log('── 第 6e 项 · 首开渲染 / 列表 / 单元格');
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(600);

  const saved = await win.evaluate(() => {
    const app = window.quillpad;
    const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
    return { id: tab.id, before: tab.content };
  });

  const BIG = buildBigDoc();
  await win.evaluate((d) => {
    const app = window.quillpad;
    app.setTabContent(app.state.activeTabId, d);
    app.refreshViewMode();
  }, BIG);
  await win.waitForTimeout(1100);

  /* 滚到「表格区」，表格应当已经渲染成 widget（不是裸源码） */
  const tableState = await win.evaluate(() => {
    const app = window.quillpad;
    const view = app.editor.view;
    const pos = view.state.doc.toString().indexOf('## 表格区');
    view.dispatch({ selection: { anchor: pos + 1 }, scrollIntoView: true });
    return new Promise((resolve) =>
      setTimeout(() => {
        const wrap = document.querySelector('.qp-table-wrap');
        resolve({
          wraps: document.querySelectorAll('.qp-table-wrap').length,
          rows: wrap ? wrap.querySelectorAll('tr').length : 0,
          strong: !!document.querySelector('.qp-table__cell strong'),
          em: !!document.querySelector('.qp-table__cell em'),
          code: !!document.querySelector('.qp-table__cell code'),
          pipeText: [...document.querySelectorAll('.cm-line')].some((l) =>
            l.textContent.includes('| 样式 |'),
          ),
        });
      }, 700),
    );
  });
  check(
    '6e.1 视口外的表格首次打开即渲染成 widget（不是裸源码）',
    tableState.wraps >= 1 && tableState.rows === 4 && !tableState.pipeText,
    `wrap=${tableState.wraps} tr=${tableState.rows} 露出源码=${tableState.pipeText}`,
  );
  check(
    '6e.2 单元格里的加粗 / 斜体 / 行内代码渲染成真实标签',
    tableState.strong && tableState.em && tableState.code,
    `strong=${tableState.strong} em=${tableState.em} code=${tableState.code}`,
  );

  /* 滚到「列表区」：有序 / 无序 / 引用都应有各自的装饰 */
  const listState = await win.evaluate(() => {
    const app = window.quillpad;
    const view = app.editor.view;
    const pos = view.state.doc.toString().indexOf('## 列表区');
    view.dispatch({ selection: { anchor: pos + 1 }, scrollIntoView: true });
    return new Promise((resolve) =>
      setTimeout(() => {
        const rows = [...document.querySelectorAll('.cm-line')].filter((el) =>
          /有序甲|无序甲|引用尾巴/.test(el.textContent),
        );
        resolve({
          lis: document.querySelectorAll('.qp-li').length,
          quotes: document.querySelectorAll('.qp-quote').length,
          rows: rows.map((el) => ({
            text: el.textContent.slice(0, 8),
            cls: el.className,
            num: el.getAttribute('data-qp-num'),
            before: getComputedStyle(el, '::before').content,
          })),
        });
      }, 700),
    );
  });
  const olRow = listState.rows.find((r) => r.text.includes('有序甲'));
  const ulRow = listState.rows.find((r) => r.text.includes('无序甲'));
  check(
    '6e.3 视口外的有序 / 无序列表保持行首序号与圆点',
    listState.lis >= 4 &&
      !!olRow &&
      olRow.num === '1' &&
      /1\./.test(olRow.before) &&
      !!ulRow &&
      /•/.test(ulRow.before),
    `li=${listState.lis} ol=${JSON.stringify(olRow)} ul=${JSON.stringify(ulRow)}`,
  );

  /* 引用块同理：滚到它所在的位置再数（视口外的行根本没有 DOM） */
  const quoteState = await win.evaluate(() => {
    const app = window.quillpad;
    const view = app.editor.view;
    const pos = view.state.doc.toString().indexOf('> 引用尾巴');
    view.dispatch({ selection: { anchor: pos + 1 }, scrollIntoView: true });
    return new Promise((resolve) =>
      setTimeout(() => {
        const rows = [...document.querySelectorAll('.cm-line')].filter((el) =>
          el.textContent.includes('引用尾巴'),
        );
        resolve({
          quotes: document.querySelectorAll('.qp-quote').length,
          row: rows.length ? rows[0].className : null,
        });
      }, 600),
    );
  });
  check(
    '6e.4 视口外的引用块渲染成引用样式（不是纯文本行）',
    quoteState.quotes >= 1 && /qp-quote/.test(quoteState.row || ''),
    `quote=${quoteState.quotes} row=${quoteState.row}`,
  );

  /* 在有序列表末行回车：新行要有序号，且整篇其它结构不塌 */
  const beforeKinds = await win.evaluate(() => ({
    h: document.querySelectorAll('.qp-h').length,
    quote: document.querySelectorAll('.qp-quote').length,
  }));
  await win.evaluate(() => {
    const app = window.quillpad;
    const view = app.editor.view;
    const text = view.state.doc.toString();
    const pos = text.indexOf('2. 有序乙') + '2. 有序乙'.length;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
  await win.waitForTimeout(300);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
  const afterEnter = await win.evaluate(() => {
    // 用文本定位：表格 widget 会替换掉若干 .cm-line，按下标取会错位
    const dom = [...document.querySelectorAll('.cm-line')].find(
      (el) => el.textContent.trim() === '3.',
    );
    return {
      cls: dom ? dom.className : '',
      num: dom ? dom.getAttribute('data-qp-num') : null,
      before: dom ? getComputedStyle(dom, '::before').content : 'none',
      h: document.querySelectorAll('.qp-h').length,
      quote: document.querySelectorAll('.qp-quote').length,
    };
  });
  check(
    '6e.5 列表末行回车后，新行的序号仍在（行首不空）',
    /qp-li/.test(afterEnter.cls) && afterEnter.num === '3' && /3\./.test(afterEnter.before),
    `cls=${afterEnter.cls} num=${afterEnter.num} ::before=${afterEnter.before}`,
  );
  check(
    '6e.6 列表编辑不影响整篇其它结构（标题 / 引用数量不变）',
    afterEnter.h === beforeKinds.h && afterEnter.quote === beforeKinds.quote,
    `h ${beforeKinds.h}→${afterEnter.h} quote ${beforeKinds.quote}→${afterEnter.quote}`,
  );

  // 还原文档
  await win.evaluate((s) => {
    window.quillpad.setTabContent(s.id, s.before);
    window.quillpad.refreshViewMode();
  }, saved);
  await win.waitForTimeout(500);
}

/* ============================== 第 6f 项 · 中文标点边界的强调（v1.0.6） */
/**
 * CommonMark 的定界符要过左右侧翼检查，`**“正文”**` 写在句子中间时两头都踩线
 * → 整段强调失效、星号原样露出来。v1.0.6 补了一条收窄的豁免（内侧紧贴中文标点
 * 才生效），这里验证装好的包里确实生效，且行内代码 / 围栏不受影响。
 */
async function sectionLooseEmphasis() {
  console.log('── 第 6f 项 · 中文标点边界的强调');

  const saved = await win.evaluate(() => {
    const app = window.quillpad;
    const tab = app.state.tabs.find((t) => t.id === app.state.activeTabId);
    return { id: tab.id, before: tab.content };
  });

  // ① 句中的加粗 / 斜体 / 删除线
  await win.evaluate((d) => {
    const app = window.quillpad;
    app.setTabContent(app.state.activeTabId, d);
    app.refreshViewMode();
  }, '这里是**“正文”**结束\n\n这里是*“斜体”*结束\n\n这里是~~“删除”~~结束\n');
  await win.waitForTimeout(700);

  const inline = await win.evaluate(() => ({
    strong: [...document.querySelectorAll('.cm-content [data-qp-node="strong"]')].map((e) => e.textContent),
    em: [...document.querySelectorAll('.cm-content [data-qp-node="em"]')].map((e) => e.textContent),
    del: [...document.querySelectorAll('.cm-content [data-qp-node="del"]')].map((e) => e.textContent),
    hidden: [...document.querySelectorAll('.qp-md-hide')].map((e) => e.textContent),
  }));
  check(
    '6f.1 句中 **“正文”** / *“斜体”* / ~~“删除”~~ 都渲染且标记已隐藏',
    inline.strong.join('') === '“正文”' &&
      inline.em.join('') === '“斜体”' &&
      inline.del.join('') === '“删除”' &&
      inline.hidden.length === 6 &&
      inline.hidden.every((t) => /^(?:\*+|~~)$/.test(t)),
    JSON.stringify(inline),
  );

  // ② 表格单元格里的中文引号加粗
  await win.evaluate((d) => {
    const app = window.quillpad;
    app.setTabContent(app.state.activeTabId, d);
    app.refreshViewMode();
  }, '| 列 | 值 |\n| --- | --- |\n| **“单元格”** | *“斜”* |\n');
  await win.waitForTimeout(700);
  check(
    '6f.2 表格单元格里的 **“单元格”** 也加粗',
    await win.evaluate(() => {
      const s = document.querySelector('.qp-table td strong');
      const e = document.querySelector('.qp-table td em');
      return !!s && s.textContent === '“单元格”' && !!e && e.textContent === '“斜”';
    }),
  );

  // ③ 行内代码 / 围栏里的星号原样保留
  await win.evaluate((d) => {
    const app = window.quillpad;
    app.setTabContent(app.state.activeTabId, d);
    app.refreshViewMode();
  }, '``**“代码”**`` 保持\n\n```\n**“围栏”**\n```\n');
  await win.waitForTimeout(700);
  check(
    '6f.3 行内代码 / 围栏里的中文引号强调保持原样',
    await win.evaluate(() => {
      const strong = document.querySelectorAll('.cm-content [data-qp-node="strong"]');
      const code = document.querySelector('.cm-content [data-qp-node="code-inline"]');
      return (
        strong.length === 0 &&
        !!code &&
        code.textContent === '**“代码”**' &&
        document.body.textContent.includes('**“围栏”**')
      );
    }),
  );

  // 还原文档
  await win.evaluate((s) => {
    window.quillpad.setTabContent(s.id, s.before);
    window.quillpad.refreshViewMode();
  }, saved);
  await win.waitForTimeout(500);
}

/* ================================================ 第 7 项 · 启动参数与文件关联 */
/**
 * 读文件关联相关注册表项（reg.exe 在本机安全策略里被禁，走 PowerShell）。
 * @return {{md?: string, txt?: string, capabilities?: boolean, registeredApp?: boolean}}
 */
function readAssocRegistry() {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
function Def([string]$k) {
  $v = ''
  if (Test-Path $k) { $v = [string](Get-Item -LiteralPath $k).GetValue('') }
  return $v
}
@{ md = (Def 'HKCU:\\Software\\Classes\\.md')
   txt = (Def 'HKCU:\\Software\\Classes\\.txt')
   capabilities = [bool](Test-Path 'HKCU:\\Software\\QuillPad\\Capabilities')
   registeredApp = [bool]((Get-Item 'HKCU:\\Software\\RegisteredApplications').GetValue('QuillPad')) } |
  ConvertTo-Json -Compress
`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  try {
    return JSON.parse(String(r.stdout || '').trim() || '{}');
  } catch {
    return {};
  }
}

async function sectionAssociations() {
  console.log('── 第 7 项 · 启动参数与文件关联');

  // ---- 7.1–7.3 安装器写下的默认关联 ----
  const reg = readAssocRegistry();
  check('7.1 .md 默认程序是 QuillPad', reg.md === 'QuillPad.TextFile', reg.md || '(空)');
  check('7.2 .txt 默认程序是 QuillPad', reg.txt === 'QuillPad.TextFile', reg.txt || '(空)');
  check(
    '7.3 能力注册存在（设置→默认应用里能看到）',
    reg.capabilities === true && reg.registeredApp === true,
    JSON.stringify(reg).slice(0, 140),
  );

  // ---- 7.4 应用内 IPC 读得到同样的状态 ----
  const st = await win.evaluate(() =>
    window.quillpadDesktop.assocStatus({ exts: ['.md', '.txt'] }),
  );
  check(
    '7.4 应用内能查到关联状态',
    !!st && st.ok === true && Array.isArray(st.items) && st.items.length === 2,
    JSON.stringify(st).slice(0, 160),
  );

  // ---- 7.5 第二个实例把文件转交给已开窗口 ----
  // 这条同时验证了关联命令行（"exe" "%1"）真的能打开文件，以及 argv[0]
  // （进程自身的 238MB exe）没有被当成待打开文件 —— 后者正是「文件过大，已跳过」
  // 那条误报的来源：以前每次启动 / 每次右键打开都会先把 exe 读进内存再被拦住。
  await win.evaluate(() => {
    window.__qpToasts = [];
    const root = document.getElementById('toast-root');
    if (!root) return;
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('toast')) {
            window.__qpToasts.push(n.textContent || '');
          }
        }
      }
    }).observe(root, { childList: true });
  });

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qp-assoc-'));
  const tmpFile = path.join(tmpDir, 'assoc-sample.md');
  writeFileSync(tmpFile, '# 关联测试\n\n由第二实例转交打开。\n', 'utf8');
  spawn(EXE, [tmpFile], { env, windowsHide: true, stdio: 'ignore' });

  const opened = await win
    .waitForFunction(
      (p) => (window.quillpad.state.tabs || []).some((t) => (t.nativePath || '') === p),
      tmpFile,
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  check('7.5 系统传入的文件被打开', opened, opened ? path.basename(tmpFile) : '25s 内没出现对应标签');

  await win.waitForTimeout(800);
  const toasts = await win.evaluate(() => window.__qpToasts || []);
  const oversize = toasts.filter((x) => /文件过大|too large/i.test(x));
  check('7.6 不再误报「文件过大」', oversize.length === 0, oversize.join(' | ') || '无相关提示');

  const selfTab = await win.evaluate(() =>
    (window.quillpad.state.tabs || []).some((t) => /QuillPad\.exe$/i.test(t.name || '')),
  );
  check('7.7 没把程序自身当成待打开文件', selfTab === false, selfTab ? '出现了 QuillPad.exe 标签' : '无');

  // 收尾：关掉临时标签并删目录，别把「打不开的文件」留在会话里
  await win
    .evaluate((p) => {
      const t = (window.quillpad.state.tabs || []).find((x) => (x.nativePath || '') === p);
      if (t) void window.quillpad.closeTab(t.id, true);
    }, tmpFile)
    .catch(() => {});
  rmSync(tmpDir, { recursive: true, force: true });
}

for (const [tag, fn] of [
  ['第 1 项', sectionLocaleButton],
  ['第 2 项', sectionPluginUninstall],
  ['第 3 项', sectionFilePicker],
  ['第 4 项', sectionGutterPolicy],
  ['第 5 项', sectionWelcomeDoc],
  ['第 5b 项', sectionWelcomeSave],
  ['第 6b 项', sectionHrLayout],
  ['第 6c 项', sectionTableInteraction],
  ['第 6d 项', sectionTableTail],
  ['第 6e 项', sectionWysiwygStructure],
  ['第 6f 项', sectionLooseEmphasis],
  ['第 7 项', sectionAssociations],
]) {
  try {
    await fn();
  } catch (err) {
    check(`${tag} 流程执行`, false, String((err && err.message) || err));
  }
}

/* ================================================ 汇总 */
console.log('\n── console 摘录（异常相关）');
const bad = consoleLines.filter((l) => /error|TypeError|is not a function|Uncaught/i.test(l));
console.log(bad.length ? bad.slice(0, 20).join('\n') : '  （无 error / TypeError）');

const allOk = summarize();
try { await app.close(); } catch { /* 已退出 */ }
process.exit(allOk ? 0 : 1);
