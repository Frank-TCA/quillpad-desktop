/**
 * QuillPad · 第三方组件清单与许可检查（T17）
 *
 * 两个模式：
 *   node scripts/notices.mjs           生成清单（build/、仓库根目录、licenses/ 三份）
 *   node scripts/notices.mjs --check   只校验（CI 用，不写文件）
 *
 * 根目录那一份是 ARCH T17③ 要求的交付物（QA D-1②），`licenses/` 那一份会被
 * electron-builder.yml 打进 app.asar 随安装包分发，三者必须始终字节一致；
 * --check 会逐份比对，防止只改一处导致随包声明的版本号与实际版本脱节。
 *
 * 校验项：
 *   1. 全量扫描 node_modules，出现 GPL / AGPL / SSPL 等传染性许可就失败；
 *   2. 打包进安装包的运行时依赖必须都能解析到版本与许可（不许 UNKNOWN）；
 *   3. 内置字体必须有 OFL.txt；
 *   4. src/core/version.js 与 package.json 的版本必须一致；
 *   5. --check 模式下比对磁盘上的清单是否与当前依赖树一致（防止改依赖不更新清单）。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nm = path.join(root, 'node_modules');
const OUT = path.join(root, 'build', 'THIRD-PARTY-NOTICES.txt');
/** 仓库根目录的随包交付副本（ARCH T17③ / QA D-1②）。 */
const ROOT_OUT = path.join(root, 'THIRD-PARTY-NOTICES.txt');
/**
 * `licenses/` 下的副本也被 electron-builder.yml 的 `licenses/**\/*` 打进 app.asar，
 * 是与安装包一起分发的那一份；三个落点必须逐字节一致，否则随包声明的版本号会说谎。
 */
const LICENSES_OUT = path.join(root, 'licenses', 'THIRD-PARTY-NOTICES.txt');
/** 所有必须保持同步的清单落点。 */
const OUTPUTS = [OUT, ROOT_OUT, LICENSES_OUT];

/** 允许的宽松许可（SPDX 前缀匹配）。 */
const ALLOWED_PREFIXES = [
  'MIT',
  'ISC',
  'BSD',
  'Apache-2.0',
  '0BSD',
  'CC0',
  'Unlicense',
  'BlueOak',
  'Python-2.0',
  'OFL',
  'CC-BY-4.0',
  'WTFPL',
  'Zlib',
];

/** 明确禁止的传染性 / 商用限制许可。 */
const FORBIDDEN = [
  'GPL-2.0',
  'GPL-3.0',
  'AGPL-3.0',
  'SSPL',
  'BUSL',
  'CC-BY-NC',
  'OSL',
  'EPL',
];

/** 随包分发的运行时依赖（= package.json 的 dependencies + 主进程用的 electron）。 */
function shippedDeps() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const names = Object.keys(pkg.dependencies || {});
  const dev = Object.keys(pkg.devDependencies || {});
  return { pkg, names, dev };
}

/**
 * 读一个包的 package.json。
 * @param {string} name
 * @return {object|null}
 */
function readPkg(name) {
  const file = path.join(nm, name, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 归一化 license 字段（可能是字符串、对象或数组）。
 * @param {object} pkg
 * @return {string}
 */
function licenseOf(pkg) {
  if (!pkg) return 'UNKNOWN';
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return String(pkg.license.type);
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l && l.type)).filter(Boolean).join(' OR ');
  }
  if (typeof pkg.licenses === 'string') return pkg.licenses;
  return 'UNKNOWN';
}

/**
 * 许可是否命中禁止清单。
 * @param {string} license
 * @return {string|null} 命中的许可标识
 */
function forbiddenHit(license) {
  const upper = String(license || '').toUpperCase();
  for (const bad of FORBIDDEN) {
    if (upper.includes(bad.toUpperCase())) return bad;
  }
  return null;
}

/**
 * 全量扫描 node_modules（含 @scope/name 二级目录）。
 * @return {Array<{name: string, version: string, license: string}>}
 */
function scanAll() {
  const out = [];
  if (!existsSync(nm)) return out;
  for (const entry of readdirSync(nm, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nm, entry.name);
      for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const name = `${entry.name}/${sub.name}`;
        const pkg = readPkg(name);
        out.push({ name, version: (pkg && pkg.version) || '0.0.0', license: licenseOf(pkg) });
      }
      continue;
    }
    const pkg = readPkg(entry.name);
    out.push({ name: entry.name, version: (pkg && pkg.version) || '0.0.0', license: licenseOf(pkg) });
  }
  return out;
}

/**
 * 归一后的许可名排序键。
 * @param {string} license
 * @return {string}
 */
function licenseKind(license) {
  const raw = String(license || 'UNKNOWN').replace(/[()]/g, ' ').trim();
  const first = raw.split(/\s+(?:OR|AND)\s+/i)[0].trim();
  return first || 'UNKNOWN';
}

const MIT_TEXT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ISC_TEXT = `ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

/**
 * 生成清单正文。
 * @return {string}
 */
function buildNotices() {
  const { pkg, names, dev } = shippedDeps();
  const all = scanAll();
  const byName = new Map(all.map((p) => [p.name, p]));

  const shipped = names
    .map((n) => byName.get(n) || { name: n, version: 'MISSING', license: 'UNKNOWN' })
    .sort((a, b) => a.name.localeCompare(b.name));

  const runtimeToolchain = ['electron']
    .map((n) => byName.get(n) || { name: n, version: 'MISSING', license: 'UNKNOWN' })
    .filter((p) => p.version !== 'MISSING');

  const kinds = new Map();
  for (const p of all) kinds.set(licenseKind(p.license), (kinds.get(licenseKind(p.license)) || 0) + 1);

  const lines = [];
  lines.push('QuillPad 第三方组件许可声明');
  lines.push('================================');
  lines.push('');
  lines.push(`版本：${pkg.version}`);
  lines.push(`生成方式：node scripts/notices.mjs（依赖有变动后请重新生成）`);
  lines.push('');
  lines.push('QuillPad 自身为自有软件。本文件列出随应用分发的第三方组件及其许可，');
  lines.push('全部为 MIT / ISC / BSD / Apache-2.0 / SIL OFL 1.1 等宽松许可，');
  lines.push('不包含 GPL / AGPL / SSPL 等传染性许可组件。');
  lines.push('');
  lines.push('--------------------------------------------------------------------');
  lines.push('1. 打包进应用的运行时依赖');
  lines.push('--------------------------------------------------------------------');
  lines.push('');
  for (const p of shipped) {
    lines.push(`  ${p.name} ${p.version}`);
    lines.push(`    许可：${p.license}`);
  }
  lines.push('');
  lines.push('--------------------------------------------------------------------');
  lines.push('2. 桌面外壳');
  lines.push('--------------------------------------------------------------------');
  lines.push('');
  for (const p of runtimeToolchain) {
    lines.push(`  ${p.name} ${p.version}`);
    lines.push(`    许可：${p.license}`);
  }
  lines.push('');
  lines.push('--------------------------------------------------------------------');
  lines.push('3. 内置字体');
  lines.push('--------------------------------------------------------------------');
  lines.push('');
  lines.push('  noto-sans-sc-subset.ttf / noto-serif-sc-subset.ttf');
  lines.push('    来源：Google Noto Sans SC / Noto Serif SC（上游 Adobe & Google）');
  lines.push('    许可：SIL Open Font License 1.1');
  lines.push('    说明：由 scripts/font-subset.py 生成的子集（Modified Version），');
  lines.push('          完整许可全文见 src/assets/fonts/OFL.txt（随安装包分发）。');
  lines.push('');
  lines.push('--------------------------------------------------------------------');
  lines.push('4. 构建期依赖许可分布（全量 node_modules 统计）');
  lines.push('--------------------------------------------------------------------');
  lines.push('');
  for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind}: ${count} 个包`);
  }
  lines.push('');
  lines.push('--------------------------------------------------------------------');
  lines.push('5. 常见许可全文');
  lines.push('--------------------------------------------------------------------');
  lines.push('');
  lines.push(MIT_TEXT);
  lines.push('');
  lines.push(ISC_TEXT);
  lines.push('');
  lines.push('Apache-2.0 全文：https://www.apache.org/licenses/LICENSE-2.0');
  lines.push('SIL OFL 1.1 全文：见 src/assets/fonts/OFL.txt');
  lines.push('');
  lines.push(`共收录 ${shipped.length} 个运行时依赖、${runtimeToolchain.length} 个桌面外壳组件。`);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------- main */

const check = process.argv.includes('--check');
const { pkg } = shippedDeps();
const problems = [];

// 1. 全量扫描禁止许可
const all = scanAll();
for (const p of all) {
  const hit = forbiddenHit(p.license);
  if (hit) problems.push(`传染性许可：${p.name}@${p.version} 使用 ${p.license}（命中 ${hit}）`);
}

// 2. 运行时依赖必须可解析
for (const name of Object.keys(pkg.dependencies || {})) {
  const p = all.find((x) => x.name === name);
  if (!p) problems.push(`运行时依赖未安装：${name}`);
  else if (String(p.license).toUpperCase() === 'UNKNOWN') {
    problems.push(`运行时依赖许可未知：${name}@${p.version}`);
  }
}

// 3. 字体许可文件
if (!existsSync(path.join(root, 'src', 'assets', 'fonts', 'OFL.txt'))) {
  problems.push('缺少 src/assets/fonts/OFL.txt（内置字体必须在 OFL 1.1 下分发）');
}

// 4. 版本一致性
const versionFile = path.join(root, 'src', 'core', 'version.js');
if (!existsSync(versionFile)) {
  problems.push('缺少 src/core/version.js（版本号唯一来源）');
} else {
  const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(versionFile, 'utf8'));
  if (!m) problems.push('src/core/version.js 里找不到 APP_VERSION');
  else if (m[1] !== pkg.version) {
    problems.push(`版本不一致：package.json=${pkg.version} version.js=${m[1]}`);
  }
}

const notices = buildNotices();

// 5. 清单与依赖树一致（三个落点逐份比对，QA D-1②）
if (check) {
  const fresh = notices.replace(/\r\n/g, '\n');
  for (const target of OUTPUTS) {
    const rel = path.relative(root, target).replace(/\\/g, '/');
    if (!existsSync(target)) {
      problems.push(`缺少 ${rel}，请先运行 node scripts/notices.mjs`);
      continue;
    }
    const disk = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (disk !== fresh) problems.push(`${rel} 与当前依赖树不一致，请重新生成`);
  }
} else {
  for (const target of OUTPUTS) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, notices, 'utf8');
  }
}

/* ----------------------------------------------------------------- 输出 */

const shipped = Object.keys(pkg.dependencies || {}).length;
if (problems.length) {
  console.log('license:check 失败：');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log(
  `${check ? 'license:check 通过' : 'notices 已生成'}：` +
    `运行时依赖 ${shipped} 个、node_modules 共 ${all.length} 个包、` +
    `无 GPL/AGPL/SSPL、版本 ${pkg.version} 一致`,
);
if (!check) {
  for (const target of OUTPUTS) {
    console.log(`清单：${path.relative(root, target).replace(/\\/g, '/')}`);
  }
}
