/**
 * QuillPad · 卸载器自检
 *
 * 卸载器最容易骗自己的地方是「以为删干净了」。所以这里分三层验证：
 *
 *   S) 静态覆盖：build/traces.nsh 的痕迹清单是否覆盖所有历史遗留位置，
 *      安装器与独立卸载器是否引用同一份清单（而不是各写一套）。
 *   R) 运行扫描：用 /SCAN 真扫一遍本机，断言它能认出已安装版本与各类痕迹，
 *      包括「注册表键名是 GUID」这种没法硬编码的情况。
 *   C) 清后断言（--verify-clean）：卸载之后跑，断言机器上真的一干二净 ——
 *      目录、快捷方式、注册表键、MuiCache/Toast 值、以及扫描器自己的退出码。
 *
 * 用法：
 *   node scripts/uninstall-check.mjs                 # 静态 + 扫描（只读，不动任何东西）
 *   node scripts/uninstall-check.mjs --verify-clean  # 卸载后跑，断言干净
 *
 * 前置：`npm run build:uninstaller` 已产出 dist/release/QuillPad-Uninstaller-<ver>.exe
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const EXE = join(ROOT, 'dist', 'release', `QuillPad-Uninstaller-v${VERSION}.exe`);
const LOG = join(process.env.TEMP || '/tmp', 'QuillPad-Uninstall.log');
const VERIFY_CLEAN = process.argv.includes('--verify-clean');

const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
const PROFILE = process.env.USERPROFILE || homedir();
const PROGRAMS = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAMS86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const results = [];
/**
 * 记录一条断言。
 * @param {string} name 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 附加信息
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

/** 读 UTF-16LE 日志（卸载器带 BOM 写入）。 */
function readLog() {
  if (!existsSync(LOG)) return '';
  const raw = readFileSync(LOG);
  const text = raw.toString('utf16le');
  return text.replace(/^\uFEFF/, '');
}

/** 跑一次 /SCAN（静默、只读），返回 { status, log }。 */
function runScan() {
  if (existsSync(LOG)) rmSync(LOG, { force: true });
  const r = spawnSync(EXE, ['/SCAN', '/S'], { windowsHide: true, timeout: 120000 });
  return { status: r.status, log: readLog() };
}

/**
 * 通过 PowerShell 读注册表（reg.exe 在本机安全策略里被禁）。
 * @return {{uninstKeys:number, progId:boolean, appPaths:boolean, contextMenu:boolean, mui:number, toasts:number, openWithList:number}}
 */
function readRegistry() {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
$uninst = 0
foreach ($r in $roots) {
  if (Test-Path $r) {
    Get-ChildItem $r | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ($p.DisplayName -match 'QuillPad') { $uninst++ }
    }
  }
}
$mui = 0
$mk = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
if (Test-Path $mk) {
  (Get-Item $mk).GetValueNames() | Where-Object { $_ -match 'QuillPad' } | ForEach-Object { $mui++ }
}
$toasts = 0
$tk = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ApplicationAssociationToasts'
if (Test-Path $tk) {
  (Get-Item $tk).GetValueNames() | Where-Object { $_ -match 'QuillPad' } | ForEach-Object { $toasts++ }
}
$owl = 0
$ek = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
if (Test-Path $ek) {
  Get-ChildItem $ek | ForEach-Object {
    $k = Join-Path $_.PSPath 'OpenWithList'
    if (Test-Path $k) {
      (Get-Item $k).GetValueNames() | ForEach-Object {
        $v = (Get-ItemProperty $k).$_
        if ("$v" -match 'QuillPad') { $owl++ }
      }
    }
  }
}
$out = [ordered]@{
  uninstKeys  = $uninst
  progId      = [bool](Test-Path 'HKCU:\\Software\\Classes\\QuillPad.TextFile')
  appPaths    = [bool](Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\QuillPad.exe')
  contextMenu = [bool](Test-Path 'HKCU:\\Software\\Classes\\*\\shell\\QuillPad')
  mui         = $mui
  toasts      = $toasts
  openWithList= $owl
}
$out | ConvertTo-Json -Compress
`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ S) 静态
const tracesPath = join(ROOT, 'build', 'traces.nsh');
const traces = existsSync(tracesPath) ? readFileSync(tracesPath, 'utf8') : '';
const uninstNsi = readFileSync(join(ROOT, 'build', 'uninstaller.nsi'), 'utf8');
const instNsh = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8');

check('痕迹清单 build/traces.nsh 存在', traces.length > 2000, `${traces.length} 字符`);
check(
  '安装器与独立卸载器引用同一份痕迹清单',
  /!include\s+"traces\.nsh"/.test(uninstNsi) && /!include\s+"traces\.nsh"/.test(instNsh),
);
check(
  '独立卸载器不再「转交」官方卸载器（自己扫自己删）',
  !/Exec\s+'"\$UninstPath"\s*\/currentuser/.test(uninstNsi),
);
check(
  '卸载器支持 /SCAN 与静默 /S',
  /\/scan/.test(uninstNsi) && /IfSilent|Silent/.test(uninstNsi),
);
check('卸载器支持按需提权（UAC）', /runas/.test(uninstNsi) && /QpNeedsElevation/.test(uninstNsi));

const needDirs = [
  '$PROGRAMFILES64\\QuillPad',
  '$PROGRAMFILES\\QuillPad',
  '$LOCALAPPDATA\\Programs\\QuillPad',
  '$APPDATA\\QuillPad',
  '$LOCALAPPDATA\\QuillPad',
  '$LOCALAPPDATA\\quillpad-updater',
  '$LOCALAPPDATA\\Temp\\QuillPad',
];
for (const d of needDirs) {
  check(`清单覆盖目录 ${d}`, traces.includes(`"${d}"`));
}

const needFiles = [
  '$DESKTOP\\QuillPad.lnk',
  '$SMPROGRAMS\\QuillPad.lnk',
  '$SMPROGRAMS\\卸载 QuillPad.lnk',
  '$QUICKLAUNCH\\User Pinned\\TaskBar\\QuillPad.lnk',
  '$LOCALAPPDATA\\CrashDumps\\QuillPad.exe.*.dmp',
];
for (const f of needFiles) {
  check(`清单覆盖文件 ${f}`, traces.includes(`"${f}"`));
}

const needReg = [
  'Software\\Classes\\${QP_PROGID}',
  'Software\\Classes\\Applications\\${QP_APP_EXE}',
  'Software\\Classes\\*\\shell\\QuillPad',
  'App Paths\\${QP_APP_EXE}',
  'MuiCache',
  'ApplicationAssociationToasts',
];
for (const k of needReg) {
  check(`清单覆盖注册表 ${k}`, traces.includes(k));
}
check(
  '清单枚举 Uninstall 子树（键名是 GUID 也能找到）',
  /QP_SWEEP_UNINST_ROOT/.test(traces) && /EnumRegKey/.test(traces),
);
check(
  '清单两个注册表视图都扫（64 位 / 32 位）',
  /SetRegView\s+64/.test(traces) && /SetRegView\s+32/.test(traces),
);

const extCount = (traces.match(/!insertmacro \$\{CALLER\} "/g) || []).length;
check('扩展名清单集中在一处（QP_EACH_EXT）', extCount >= 45, `${extCount} 项`);
check(
  '安装器没有硬编码扩展名列表（避免两边漂移）',
  (instNsh.match(/WriteRegStr HKCU "Software\\Classes\\\./g) || []).length === 0,
  `硬编码 ${(instNsh.match(/WriteRegStr HKCU "Software\\Classes\\\./g) || []).length} 处`,
);

// ------------------------------------------------------------------ R) 运行
check(`卸载器产物存在（${VERSION}）`, existsSync(EXE), EXE);
if (existsSync(EXE)) {
  const sizeKb = Math.round(statSync(EXE).size / 1024);
  check('卸载器体积合理（不是空壳）', sizeKb > 40 && sizeKb < 2048, `${sizeKb} KB`);
}

const installedDirs = [join(PROGRAMS, 'QuillPad'), join(PROGRAMS86, 'QuillPad')].filter((p) =>
  existsSync(p),
);

if (VERIFY_CLEAN) {
  // ---------------------------------------------- C) 清后断言
  for (const d of [
    join(PROGRAMS, 'QuillPad'),
    join(PROGRAMS86, 'QuillPad'),
    join(LOCALAPPDATA, 'Programs', 'QuillPad'),
    join(APPDATA, 'QuillPad'),
    join(LOCALAPPDATA, 'QuillPad'),
    join(LOCALAPPDATA, 'quillpad-updater'),
    join(LOCALAPPDATA, 'Temp', 'QuillPad'),
  ]) {
    check(`已删除目录 ${d}`, !existsSync(d));
  }

  for (const f of [
    join(PROFILE, 'Desktop', 'QuillPad.lnk'),
    join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'QuillPad.lnk'),
    join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '卸载 QuillPad.lnk'),
    join(
      APPDATA,
      'Microsoft',
      'Internet Explorer',
      'Quick Launch',
      'User Pinned',
      'TaskBar',
      'QuillPad.lnk',
    ),
  ]) {
    check(`已删除快捷方式 ${f}`, !existsSync(f));
  }

  const reg = readRegistry();
  check('能读取注册表状态', reg !== null, reg ? '' : 'PowerShell 查询失败');
  if (reg) {
    check('注册表无 QuillPad 卸载项', reg.uninstKeys === 0, `剩 ${reg.uninstKeys} 项`);
    check('注册表无 ProgID', reg.progId === false);
    check('注册表无 App Paths', reg.appPaths === false);
    check('注册表无「用 QuillPad 打开」右键菜单', reg.contextMenu === false);
    check('MuiCache 无 QuillPad 残留', reg.mui === 0, `剩 ${reg.mui} 个值`);
    check('关联 Toast 无 QuillPad 残留', reg.toasts === 0, `剩 ${reg.toasts} 个值`);
    check('「打开方式」列表无 QuillPad 残留', reg.openWithList === 0, `剩 ${reg.openWithList} 个值`);
  }

  const scan = runScan();
  check(
    '自扫描确认干净（退出码 0）',
    scan.status === 0,
    `exit=${scan.status}；日志末尾：${scan.log.split('\n').filter(Boolean).slice(-2).join(' / ')}`,
  );
} else {
  // ---------------------------------------------- R) 扫描能力
  const reg = readRegistry();
  if (reg) {
    check('扫描前能读到注册表状态', true, JSON.stringify(reg));
  }

  const scan = runScan();
  const hasTraces = (reg && reg.uninstKeys > 0) || installedDirs.length > 0 || (reg && reg.progId);
  check(
    hasTraces ? '有安装时扫描返回「发现痕迹」(exit=1)' : '无安装时扫描返回「干净」(exit=0)',
    hasTraces ? scan.status === 1 : scan.status === 0,
    `exit=${scan.status}（期望 ${hasTraces ? 1 : 0}）`,
  );
  check('日志确实写入并带 BOM（UTF-16LE 可读）', scan.log.includes(`QuillPad 卸载器 ${VERSION}`), LOG);
  check('日志里能列出安装目录', /目录\s+.*QuillPad/i.test(scan.log));

  if (hasTraces) {
    // 逐项只在「本机确实存在」时断言 —— 刚装完还没启动过时没有 %APPDATA% 数据目录，
    // 那不是扫描器的错。
    if (installedDirs.length) {
      check(
        '能认出 Program Files 下的安装目录',
        scan.log.includes(join(PROGRAMS, 'QuillPad')) ||
          scan.log.includes(join(PROGRAMS86, 'QuillPad')),
      );
    }
    const dataDir = join(APPDATA, 'QuillPad');
    if (existsSync(dataDir)) {
      check('能认出用户数据目录 %APPDATA%\\QuillPad', scan.log.includes(dataDir));
    }
    if (reg && reg.uninstKeys > 0) {
      check(
        '能认出注册表卸载项（含 GUID 命名的键）',
        /卸载项\s+HK(LM|CU)\\.*Uninstall\\/i.test(scan.log),
      );
    }
    if (reg && reg.contextMenu) {
      check('能认出「用 QuillPad 打开」右键菜单', scan.log.includes('*\\shell\\QuillPad'));
    }
    if (reg && reg.appPaths) {
      check('能认出 App Paths 注册项', scan.log.includes('App Paths\\QuillPad.exe'));
    }
  }
}

// ------------------------------------------------------------------ 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
process.exit(failed.length ? 1 : 0);
