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
 *  4. 行号栏 / 折叠箭头按模式隐显：所见即所得整列不装（无 `.cm-gutters`）；
 *     源码模式保留行号与折叠箭头，且行号与内容行逐行对齐（checked≥10 且 worst≤2.5px）
 *  5. 欢迎文档双语联动：切英文 → tab 变 Welcome.md 且英文模板且非脏；
 *     切回中文恢复；用户编辑过只改名不覆盖
 *  6. 文件级检查（无需启动应用）：docs/screenshots/ 四张截图存在非空且被
 *     README.md / README.en.md 引用；dist/release/ 三产物存在且达到体积门槛
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

  /* v1.0.2 起：所见即所得是阅读面，不装行号槽与折叠槽（`.cm-gutters` 整个不出现）；
     源码 / 分栏保留，且是 CodeMirror 原生对齐，不需要任何补偿。 */
  await win.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
  await win.waitForTimeout(900);
  const wy = await win.evaluate(() => {
    const g = document.querySelector('.cm-gutters');
    return {
      gutters: g ? Math.round(g.getBoundingClientRect().width) : null,
      lineNumbers: !!document.querySelector('.cm-lineNumbers'),
      foldGutter: !!document.querySelector('.cm-foldGutter'),
    };
  });
  check('4.1 所见即所得不显示行号栏与折叠箭头',
    wy.gutters === null && !wy.lineNumbers && !wy.foldGutter,
    `gutters=${wy.gutters} lineNumbers=${wy.lineNumbers} foldGutter=${wy.foldGutter}`);

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
