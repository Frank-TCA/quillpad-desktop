/**
 * 插件市场「能不能装上」的回归检查。
 *
 * 为什么单独一个脚本：`scripts/data-check.mjs` 只看数据形状，早期 QA 脚本
 * 的单测把 quillpadVersion 写死成 '2.0.0'。结果版本号从 2.x 重置为 1.0.0 之后，
 * 三个官方包的 `engines: ^2.0.0` 让市场里点「安装」全部报 EENGINE，而 6 条
 * community.* 又指向根本不存在的 zip，点下去只有 HTTP 404 —— 两处都没人发现。
 *
 * 这个脚本按市场条目的真实路径走一遍：
 *  - 官方包：读目录 → validateManifest(真实 APP_VERSION) → staticScan(main.js)
 *  - 社区包：读 zip → 校验 sha256 → 解析清单 → 真的调主进程 installPlugin 落盘
 *  - 目录里**不允许**存在装不上的条目（available=false）：市场只展示真能装上的包，
 *    做不到的要么补成真包、要么从目录里删掉，不能拿「未上架」灰卡片充数
 *
 * 运行：node scripts/plugin-pack-check.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateManifest, staticScan } from '../src/core/plugins/manifest.js';
import { APP_VERSION } from '../src/core/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseZip, installPlugin, listPlugins, uninstallPlugin, validateInstallManifest } = require(path.join(root, 'desktop', 'plugin-fs.cjs'));

const results = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`);
}

const catalog = JSON.parse(readFileSync(path.join(root, 'src', 'data', 'catalog.json'), 'utf8'));
const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];

/*
 * 两道闸必须一致：渲染层 validateManifest（ESM）与主进程 validateInstallManifest
 * （CJS，真正的安装闸门）是同一套规则的两份实现。主进程曾经只认 `^x.y.z` 与裸
 * `x.y.z`，官方包的 `>=1.0.0` 在渲染层通过、到主进程被判「需要 QuillPad 3.x」，
 * 于是安装静默失败。这里用同一组 (版本, 范围) 对两边逐一比对。
 */
const gateMatrix = [
  ['1.0.0', '>=1.0.0', true],
  ['1.0.0', '^1.0.0', true],
  ['1.4.2', '^1.0.0', true],
  ['1.0.0', '^2.0.0', false],
  ['2.0.0', '^2.0.0', true],
  ['2.0.0', '>=1.0.0', true],
  ['1.0.0', '3.0.0', false],
  ['1.0.0', '*', true],
  ['1.0.0', 'latest', true],
  ['1.0.0', '=1.0.0', true],
];
const gateFixture = {
  id: 'community.gate-probe',
  name: '闸门探针',
  description: '用于比对面两套校验实现的探针插件',
  author: 'QuillPad 测试',
  version: '1.0.0',
  license: 'MIT',
  engines: { quillpad: '>=1.0.0' },
  main: 'main.js',
  permissions: [],
  contributes: {},
};
for (const [version, range, want] of gateMatrix) {
  const fixture = { ...gateFixture, engines: { quillpad: range } };
  const rendererOk = validateManifest(fixture, { quillpadVersion: version }).ok === true;
  const mainOk = validateInstallManifest(fixture, version).ok === true;
  check(
    `双闸一致：${version} vs engines ${range} → ${want ? '放行' : '拒绝'}`,
    rendererOk === want && mainOk === want,
    `渲染层=${rendererOk} 主进程=${mainOk}`,
  );
}

// 临时「用户数据目录」：installPlugin 会往里写插件目录与状态文件
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'qp-pack-check-'));
const pluginsRoot = path.join(sandbox, 'plugins');
const stateFile = path.join(sandbox, 'plugins-state.json');
writeFileSync(stateFile, '{}\n', 'utf8');

/** @type {string[]} 已落盘的插件 id，最后统一卸载 */
const installedIds = [];

try {
  for (const plugin of plugins) {
    const isOfficial = plugin.official === true || String(plugin.id).startsWith('quillpad.');
    const listed = plugin.available !== false;

    // 市场只允许放「点下去真能装上」的条目：装不上就必须删掉，不许留灰卡片
    check(`目录条目 ${plugin.id} 可安装（不允许 available=false）`, listed, listed ? '' : '装不上就删掉，不要留在市场里置灰');
    if (!listed) continue;

    if (isOfficial) {
      const dir = path.join(root, 'public', 'plugins', plugin.id);
      const manifestFile = path.join(dir, 'plugin.json');
      if (!existsSync(manifestFile)) {
        check(`官方包 ${plugin.id} 有 plugin.json`, false, manifestFile);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const validated = validateManifest(manifest, { quillpadVersion: APP_VERSION });
      check(
        `官方包 ${plugin.id} 可通过 ${APP_VERSION} 的 engines 校验`,
        validated.ok === true,
        validated.ok ? `engines ${manifest.engines.quillpad}` : `${validated.code}: ${validated.message}`,
      );
      const mainGate = validateInstallManifest(manifest, APP_VERSION);
      check(
        `官方包 ${plugin.id} 通过主进程安装闸门`,
        mainGate.ok === true,
        mainGate.ok ? `engines ${manifest.engines.quillpad}` : `${mainGate.code}: ${mainGate.error}`,
      );
      const mainFile = path.join(dir, String(manifest.main || ''));
      const mainExists = existsSync(mainFile);
      check(`官方包 ${plugin.id} 的入口文件存在`, mainExists, String(manifest.main || ''));
      if (mainExists) {
        const scan = staticScan(readFileSync(mainFile, 'utf8'), String(manifest.main));
        check(`官方包 ${plugin.id} 通过静态扫描`, scan.ok === true, scan.ok ? '' : `${scan.rule} @${scan.line}`);
      }
      continue;
    }

    // 社区包：zip 必须存在、sha256 必须对得上、清单必须过校验、必须能真的装上
    const zipPath = path.join(root, 'public', 'plugins', `${plugin.id}.zip`);
    if (!existsSync(zipPath)) {
      check(`社区包 ${plugin.id} 的 zip 存在`, false, path.relative(root, zipPath));
      continue;
    }
    const zipBytes = readFileSync(zipPath);
    const digest = crypto.createHash('sha256').update(zipBytes).digest('hex');
    check(
      `社区包 ${plugin.id} 的 sha256 与 catalog 一致`,
      !plugin.sha256 || String(plugin.sha256).toLowerCase() === digest,
      `catalog=${String(plugin.sha256).slice(0, 12)} 实际=${digest.slice(0, 12)}`,
    );
    check(`社区包 ${plugin.id} 已回填 sha256`, typeof plugin.sha256 === 'string' && plugin.sha256.length === 64, '');

    const parsed = parseZip(zipBytes);
    check(`社区包 ${plugin.id} 可被主进程解压`, parsed.ok === true, parsed.ok ? `${parsed.files.length} 个文件` : `${parsed.code} ${parsed.error}`);
    if (!parsed.ok) continue;

    const manifestFile = parsed.files.find((f) => f.name === 'plugin.json');
    if (!manifestFile) {
      check(`社区包 ${plugin.id} 含 plugin.json`, false, '');
      continue;
    }
    const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    check(`社区包 ${plugin.id} 的 id 与 catalog 一致`, String(manifest.id) === String(plugin.id), String(manifest.id));
    const validated = validateManifest(manifest, { quillpadVersion: APP_VERSION });
    check(
      `社区包 ${plugin.id} 清单合法`,
      validated.ok === true,
      validated.ok ? `v${manifest.version}` : `${validated.code}: ${validated.message}`,
    );
    if (!validated.ok) continue;
    const mainGate = validateInstallManifest(manifest, APP_VERSION);
    check(`社区包 ${plugin.id} 通过主进程安装闸门`, mainGate.ok === true, mainGate.ok ? '' : `${mainGate.code} ${mainGate.error}`);

    const mainEntry = parsed.files.find((f) => f.name === String(manifest.main || ''));
    if (mainEntry) {
      const scan = staticScan(mainEntry.bytes.toString('utf8'), String(manifest.main));
      check(`社区包 ${plugin.id} 入口通过静态扫描`, scan.ok === true, scan.ok ? '' : `${scan.rule} @${scan.line}`);
    }

    const res = installPlugin({
      pluginsRoot,
      stateFile,
      manifest,
      zipBytes,
      expectedSha256: String(plugin.sha256 || ''),
      bootstrap: '',
      update: false,
    });
    check(`社区包 ${plugin.id} 真实安装落盘`, res.ok === true, res.ok ? String(res.dir) : `${res.code} ${res.error}`);
    if (res.ok) {
      installedIds.push(String(plugin.id));
      const onDisk = path.join(pluginsRoot, String(plugin.id));
      check(
        `社区包 ${plugin.id} 落盘文件齐备`,
        existsSync(path.join(onDisk, 'plugin.json')) && existsSync(path.join(onDisk, String(manifest.main))),
        readdirSync(onDisk).join(','),
      );
    }
  }

  // 每个社区条目都必须真的装上了（数量对不上就是有条目被跳过了）
  const communityCount = plugins.filter(
    (p) => !(p.official === true || String(p.id).startsWith('quillpad.')),
  ).length;
  check(
    '目录内全部社区包都真实安装成功',
    installedIds.length === communityCount,
    `${installedIds.length}/${communityCount}`,
  );

  // 已装列表应能看到所有本次装上的社区包
  const listedNow = listPlugins(pluginsRoot, stateFile);
  const listOk = Array.isArray(listedNow) && installedIds.every((id) => listedNow.some((p) => p.id === id));
  check('已安装列表包含全部社区包', listOk, `${installedIds.length} 个`);

  // 卸载一遍，顺带验证卸载不会留目录
  const storageRoot = path.join(sandbox, 'storage');
  let uninstallOk = true;
  for (const id of installedIds) {
    const res = uninstallPlugin(pluginsRoot, stateFile, storageRoot, id);
    if (!res.ok || existsSync(path.join(pluginsRoot, id))) uninstallOk = false;
  }
  check('社区包可正常卸载且不留目录', uninstallOk, '');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== plugin-pack-check 结果 =====\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length > 0) {
  for (const f of failed) console.log(` - ${f.name}`);
  process.exitCode = 1;
}
