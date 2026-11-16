/**
 * QuillPad · 插件管理器「卸载」链路 + 安装对话框文件控件双语 验收（真实 Electron）
 *
 * 覆盖：
 *  1. 市场安装官方插件（quillpad.text-tools）→ 已安装列表出现行
 *  2. 点「卸载」→ toast 反馈 + 行消失 + 主进程 pluginList 里消失（真删）
 *  3. 安装对话框文件选择控件：EN 下 "Choose File" / "No file chosen"，
 *     选文件后显示文件名；ZH 下「选择文件」/「未选择任何文件」
 *
 * 用法：node scripts/plugin-manager-check.mjs
 * 前置：`npx vite build` 已跑过（Electron 壳加载 dist/）。
 * 环境坑：WorkBuddy 沙箱 shell 带 ELECTRON_RUN_AS_NODE=1 + NODE_OPTIONS，
 *        spawn 前必须从 env 删掉这两个键，否则 Electron 报 `bad option`。
 */

import { _electron as electron } from 'playwright-core';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.resolve(root, 'shots');
mkdirSync(OUT, { recursive: true });

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

/** 清掉可能占着单实例锁的旧进程（只杀 QuillPad / 本仓库的 electron）。 */
function killStale() {
  try {
    execSync('taskkill /F /IM QuillPad.exe /T', { stdio: 'ignore' });
  } catch { /* 没在跑 */ }
  try {
    const out = String(execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'electron.exe\'\\" | Where-Object { $_.CommandLine -like \'*应用开发*\' } | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ));
    for (const pid of out.split(/\s+/).map((s) => s.trim()).filter(Boolean)) {
      try { execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' }); } catch { /* 竞态 */ }
    }
  } catch { /* 拿不到就算了 */ }
}

const consoleLines = [];
const pageErrors = [];

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS'),
);

killStale();
await new Promise((r) => setTimeout(r, 500));

console.log('── 启动真实 Electron 壳（加载 dist/）');
const app = await electron.launch({
  args: ['.'],
  cwd: root,
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

/* ================================================== 1. 安装官方插件 */
console.log('── 安装 quillpad.text-tools（市场 → 权限确认）');
await win.evaluate(() => window.quillpad.openPluginMarket());
const pm = win.locator('[data-dialog="plugin-manager"]');
await pm.waitFor({ state: 'visible', timeout: 10000 });
await win.waitForTimeout(600);
await win.screenshot({ path: path.join(OUT, 'pm-01-manager.png') });

const marketCard = win.locator('[data-plugin-row][data-plugin-id="quillpad.text-tools"]');
await marketCard.waitFor({ state: 'visible', timeout: 15000 });
await marketCard.locator('[data-plugin-action]').first().click();

const perm = win.locator('[data-dialog="perm-confirm"]');
await perm.waitFor({ state: 'visible', timeout: 10000 });
await win.screenshot({ path: path.join(OUT, 'pm-02-perm.png') });
await perm.locator('[data-btn="install"]').click();

// 等安装 toast（文案随语言：已安装 / Installed）
const installToast = win.locator('.toast .toast__msg').filter({ hasText: /已安装|Installed/ });
let installToastText = '';
try {
  await installToast.first().waitFor({ state: 'visible', timeout: 20000 });
  installToastText = (await installToast.first().textContent()) || '';
} catch { /* 下面的 check 会记 FAIL */ }
check('安装 toast 出现', /已安装|Installed/.test(installToastText), installToastText);

// 已安装列表里出现该行
const installedRow = win.locator('[data-pm-installed] [data-pm-row][data-plugin-id="quillpad.text-tools"]');
let rowVisible = true;
try {
  await installedRow.waitFor({ state: 'visible', timeout: 10000 });
} catch { rowVisible = false; }
check('已安装列表出现该插件行', rowVisible);
await win.screenshot({ path: path.join(OUT, 'pm-03-installed.png') });

/* ================================================== 2. 卸载（核心断言） */
console.log('── 点击「卸载」');
const before = await win.evaluate(async () => {
  const r = await window.quillpadDesktop.pluginList();
  return (r.plugins || []).map((p) => p.id);
});
check('卸载前 pluginList 含插件', before.includes('quillpad.text-tools'), before.join(','));

const errBefore = pageErrors.length;
await installedRow.locator('[data-pm-action="uninstall"]').click();

// 等卸载 toast
const anyToast = win.locator('.toast .toast__msg').filter({ hasText: /已卸载|卸载失败|Plugin uninstalled|Could not uninstall/ });
let uninstallToastText = '';
try {
  await anyToast.first().waitFor({ state: 'visible', timeout: 12000 });
  uninstallToastText = (await anyToast.first().textContent()) || '';
} catch { /* check 记 FAIL */ }
check('卸载后有 toast 反馈', /已卸载|卸载失败|Plugin uninstalled|Could not uninstall/.test(uninstallToastText), uninstallToastText);
check('卸载 toast 是成功态', /已卸载插件|Plugin uninstalled/.test(uninstallToastText), uninstallToastText);

// 行从列表消失
let rowGone = true;
try {
  await installedRow.waitFor({ state: 'detached', timeout: 8000 });
} catch { rowGone = false; }
check('已安装列表中的行已消失', rowGone);

// 主进程侧真正删除
const after = await win.evaluate(async () => {
  const r = await window.quillpadDesktop.pluginList();
  return (r.plugins || []).map((p) => p.id);
});
check('pluginList 不再含该插件（真删）', !after.includes('quillpad.text-tools'), after.join(','));
check('点击链路无未捕获异常', pageErrors.length === errBefore,
  pageErrors.slice(errBefore).map((e) => e.message).join(' | '));
await win.screenshot({ path: path.join(OUT, 'pm-04-after-uninstall.png') });

/* ================================================== 3. 文件控件双语 */
console.log('── 安装对话框文件控件双语断言');
// 桥接断言用的 zip 文件（仅选中展示文件名，不提交）
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'qp-pm-'));
const zipPath = path.join(tmpDir, 'demo-plugin.zip');
writeFileSync(zipPath, Buffer.from('PK\x03\x04demo'));

async function assertFilePicker(locale, btnText, emptyText, shot) {
  await win.evaluate((loc) => window.quillpad.applyLocale(loc), locale);
  await win.waitForTimeout(500);
  await win.evaluate(() => window.quillpad.openInstallFromUrl());
  const dlg = win.locator('[data-dialog="plugin-install"]');
  await dlg.waitFor({ state: 'visible', timeout: 10000 });
  const btn = dlg.locator('[data-install-file-btn]');
  const name = dlg.locator('[data-install-file-name]');
  const btnGot = ((await btn.textContent()) || '').trim();
  const nameGot = ((await name.textContent()) || '').trim();
  check(`[${locale}] 按钮文案 == ${btnText}`, btnGot === btnText, btnGot);
  check(`[${locale}] 占位文案 == ${emptyText}`, nameGot === emptyText, nameGot);
  await win.screenshot({ path: path.join(OUT, shot) });

  // 选文件 → 显示文件名
  await dlg.locator('[data-install-file]').setInputFiles(zipPath);
  await win.waitForTimeout(200);
  const nameAfter = ((await name.textContent()) || '').trim();
  check(`[${locale}] 选文件后显示文件名`, nameAfter === 'demo-plugin.zip', nameAfter);
  await dlg.locator('[data-role="close"]').first().click();
  await win.waitForTimeout(300);
}

try {
  await assertFilePicker('en', 'Choose File', 'No file chosen', 'pm-05-filepicker-en.png');
  await assertFilePicker('zh-CN', '选择文件', '未选择任何文件', 'pm-06-filepicker-zh.png');
} catch (err) {
  check('文件控件流程执行', false, String(err && err.message || err));
}
rmSync(tmpDir, { recursive: true, force: true });

/* ================================================== 汇总 */
console.log('\n── console 摘录（异常相关）');
const bad = consoleLines.filter((l) => /error|TypeError|is not a function|Uncaught/i.test(l));
console.log(bad.length ? bad.slice(0, 20).join('\n') : '  （无 error / TypeError）');

const passed = results.filter((r) => r.ok).length;
console.log(`\n结果：${passed}/${results.length} 通过`);
await app.close();
if (passed !== results.length) {
  process.exitCode = 1;
  console.log('FAILURES:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
