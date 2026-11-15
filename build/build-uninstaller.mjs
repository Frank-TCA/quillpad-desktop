// ---------------------------------------------------------------------------
// 构建 QuillPad 独立卸载器
//
// 用 electron-builder 自带的 makensis 编译 build/uninstaller.nsi，产出
// dist/release/QuillPad-Uninstaller-v<version>.exe。
//
// 为什么复用 electron-builder 的 NSIS 而不是自己装一套：
//   已随 electron-builder 下载到本地缓存，无需联网、无需管理员权限，
//   且版本（3.0.4.1）与官方安装器一致，行为可预期。
//
// 用法：node build/build-uninstaller.mjs
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const version = pkg.version;
const outDir = join(root, 'dist', 'release');
const outFile = join(outDir, `QuillPad-Uninstaller-v${version}.exe`);
const iconFile = join(root, 'build', 'icon.ico');

// ---- 定位 makensis：优先 electron-builder 缓存，再找系统 PATH ----
function findMakensis() {
  const cacheRoots = [
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache'),
    join(homedir(), 'AppData', 'Local', 'electron-builder', 'Cache'),
    join(homedir(), 'Library', 'Caches', 'electron-builder'),
    join(homedir(), '.cache', 'electron-builder'),
  ];

  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;
    // 缓存目录形如 nsis-3.0.4.1/nsis-3.0.4.1-xxxx/{Bin,}makensis.exe
    for (const entry of readdirSync(cacheRoot)) {
      if (!entry.startsWith('nsis-')) continue;
      const base = join(cacheRoot, entry);
      const candidates = [];
      try {
        for (const sub of readdirSync(base)) {
          candidates.push(join(base, sub, 'Bin', 'makensis.exe'));
          candidates.push(join(base, sub, 'makensis.exe'));
          candidates.push(join(base, sub, 'bin', 'makensis'));
        }
      } catch { /* 不是目录就跳过 */ }
      candidates.push(join(base, 'Bin', 'makensis.exe'));
      candidates.push(join(base, 'makensis.exe'));
      for (const c of candidates) {
        if (existsSync(c) && statSync(c).isFile()) return c;
      }
    }
  }

  // 系统 PATH
  const exe = process.platform === 'win32' ? 'makensis.exe' : 'makensis';
  try {
    execFileSync(exe, ['/VERSION'], { stdio: 'pipe' });
    return exe;
  } catch { /* 继续抛错 */ }

  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error('未找到 makensis。请先运行一次 `npm run build:exe` 以让 electron-builder 下载 NSIS，');
  console.error('或安装 NSIS 3.x 并加入 PATH。');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// NSIS 的相对路径以 .nsi 所在目录（build/）为基准，且含中文的绝对路径会被
// ANSI 命令行转坏。因此：先输出到 build/ 下的临时文件，编译后再移动到 dist/release/。
const tempOut = join(here, `_uninstaller-${version}.exe`);
const relOut = `_uninstaller-${version}.exe`;
// 图标路径同样相对 build/
const relIcon = 'icon.ico';

console.log(`makensis   : ${makensis}`);
console.log(`app version: ${version}`);
console.log(`output     : ${outFile}`);

const args = [
  '/V2',                          // 简洁输出
  `/DAPP_VERSION=${version}`,
  `/DOUT_FILE=${relOut}`,
];
if (existsSync(iconFile)) args.push(`/DICON_FILE=${relIcon}`);
args.push('build/uninstaller.nsi');

try {
  execFileSync(makensis, args, { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.error('编译卸载器失败：', err.message);
  process.exit(1);
}

if (!existsSync(tempOut)) {
  console.error('编译完成但未生成目标文件：' + tempOut);
  process.exit(1);
}

// 移动到最终交付位置
renameSync(tempOut, outFile);

const size = statSync(outFile).size;
console.log(`\n完成：${outFile}  (${(size / 1024).toFixed(0)} KB)`);
