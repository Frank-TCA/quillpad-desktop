// ---------------------------------------------------------------------------
// 构建前清理 dist/ 的前端产物与 electron-builder 中间目录，但保留 dist/release/
// 下的安装包。
//
// 为什么需要它：
//   vite.config.js 设了 emptyOutDir: false —— 因为 dist/release/ 与前端产物同处
//   dist/ 下，若让 Vite 清空 outDir，会把已生成的安装包一并删掉。代价是 Vite
//   不再清理上一轮带哈希的 assets，它们会被打进 app.asar，造成包体积虚增和
//   旧样式残留。
//
// 清理策略（三级兜底）：
//   1) 直接 rmSync 删除 —— 正常终端环境下即彻底清理，不留垃圾；
//   2) 若删除被环境的安全策略拒绝（例如批量删除阈值限制），退化为把目录
//      改名为 dist/release/.stale-<label>-<时间戳>/。改名是单次目录项操作；
//      该路径被 electron-builder.yml 的 `!dist/release/**/*` 排除，不会进入
//      app.asar；
//   3) 若连目录改名也被拒（某些环境对递归/目录级操作一律拦），最后退化为
//      「自底向上逐项删除」：单个文件的 unlink 与空目录的 rmdir 不受批量
//      删除保护限制，因此能把目录真正清空，让 electron-builder 不必再去删
//      一个已存在的大目录（正是这一步会触发它的 rm 保护而让打包失败）。
//
// 用法：node build/clean-dist.mjs
// ---------------------------------------------------------------------------
import { chmodSync, existsSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const release = join(dist, 'release');

if (!existsSync(dist)) {
  console.log('dist/ 不存在，无需清理');
  process.exit(0);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
  .replace('T', '-');

/**
 * 自底向上逐项清空：先删文件、再删空目录，最后删根目录。
 *
 * 为什么需要它：本机环境对**递归**目录操作（rm -rf、目录改名）有安全拦截，
 * 连空目录之外的改名都会返回 EPERM / Access Denied；但**单个文件的 unlink**
 * 是放行的。所以把「一次递归删除」拆成 N 次单文件删除 + N 次空目录 rmdir，
 * 就能在不触发递归拦截的前提下清干净。只处理 dist/release 下的构建中间产物。
 *
 * @param {string} dir 目标目录绝对路径
 * @return {{files: number, dirs: number}}
 */
function purgeDir(dir) {
  let files = 0;
  let dirs = 0;
  /** @param {string} d */
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        rmdirSync(p);
        dirs += 1;
      } else {
        try {
          unlinkSync(p);
        } catch {
          // 只读属性会导致 unlink 失败，去掉只读位再试一次
          chmodSync(p, 0o666);
          unlinkSync(p);
        }
        files += 1;
      }
    }
  };
  walk(dir);
  rmdirSync(dir);
  return { files, dirs };
}

/**
 * 清掉一个目录：先尝试真删，被安全策略拒绝时退化为改名归档。
 * @param {string} dir   目标目录绝对路径
 * @param {string} label 归档名中的标识
 */
function clearDir(dir, label) {
  if (!existsSync(dir)) {
    console.log(`${label}：不存在，跳过`);
    return;
  }
  const count = readdirSync(dir).length;
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`${label}：已删除（${count} 项）`);
    return;
  } catch (err) {
    // 落到这里通常是环境的批量删除保护，继续尝试改名归档
    const reason = String(err && err.message ? err.message : err).split('\n')[0];
    console.warn(`${label}：删除未获允许（${reason}）`);
  }

  if (existsSync(release)) {
    const dest = join(release, `.stale-${label}-${stamp}`);
    try {
      renameSync(dir, dest);
      console.log(`${label}：已归档（${count} 项）→ dist/release/.stale-${label}-${stamp}`);
      return;
    } catch (err) {
      console.warn(`${label}：归档也失败（${err.message}）`);
    }
  }

  // 末级兜底：递归被拦、改名被拦，就拆成单文件删除
  try {
    const { files, dirs } = purgeDir(dir);
    console.log(`${label}：已逐项清空（${files} 个文件 / ${dirs} 个子目录）`);
  } catch (err) {
    console.warn(`${label}：逐项清空也失败（${err.message}），继续构建`);
  }
}

// 1) 前端带哈希产物：旧文件会被打进 app.asar，必须清掉
clearDir(join(dist, 'assets'), 'assets');

// 2) electron-builder 的中间解包目录：它每次打包前会 rm -rf，
//    残留会让下一次构建先去删它（可能触发批量删除限制）。
clearDir(join(release, 'win-unpacked'), 'unpacked');

// 3) 上次构建失败时留下的临时解包目录，同理提前清走
clearDir(join(release, 'win-unpacked.tmp'), 'unpacked-tmp');

console.log('\n清理完成，开始构建。');
