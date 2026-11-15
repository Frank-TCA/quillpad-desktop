/**
 * 插件快捷键检查（静态 + 两道闸一致性）。
 *
 * 为什么单独一个脚本：快捷键是「插件清单里写一行、宿主运行时挂上去」的隐式契约，
 * 出错的方式全是静默的 —— 键位拼错只是永远按不出来、和内置命令撞车会被宿主
 * 悄悄丢掉、社区包的 zip 忘记重打则用户装到的还是旧清单。这三种情况都不会报错，
 * 只能靠一条条断言守住。
 *
 * 检查内容：
 *  1. 市场里每个包（官方目录 + 社区 zip）的每条命令都声明了 key，且格式合法；
 *  2. 键位全局唯一（跨包不撞），且不占用内置命令的任何键位；
 *  3. 插件键位一律落在 Mod-Alt 家族（第三方包不得染指 Ctrl+S 这类主键位）；
 *  4. 渲染层 validateManifest 与主进程 validateInstallManifest 对同一批
 *     键位的判定完全一致（含负数矩阵）；
 *  5. 社区 zip 里的 plugin.json 与源目录逐字段一致（防止忘了重打包）。
 *
 * 运行：node scripts/plugin-keys-check.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { validateManifest, isValidKeyChord } from '../src/core/plugins/manifest.js';
import { APP_VERSION } from '../src/core/version.js';
import { defineCommand, defineCommands, allCommands, filterAvailableChords, normalizeChord } from '../src/core/commands.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseZip, validateInstallManifest, isValidKeyChord: isValidKeyChordMain } = require(
  path.join(root, 'desktop', 'plugin-fs.cjs'),
);

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
const entries = Array.isArray(catalog.plugins) ? catalog.plugins : [];

/* ------------------------------------------------------------------ 内置键位 */
/**
 * 从 actions.js 里抽出内置命令的全部键位（keys 数组 + 两段式首段）。
 * 命令注册表本身依赖 CodeMirror / DOM，Node 里 import 不动，只能读源码。
 * @return {Map<string, string>} 归一化键位 → 命令 id
 */
function builtinChords() {
  const src = readFileSync(path.join(root, 'src', 'core', 'actions.js'), 'utf8');
  const lines = src.split('\n');
  /** @type {Map<string, string>} */
  const map = new Map();
  let currentId = '';
  for (const line of lines) {
    const idMatch = line.match(/^\s*id: '([^']+)',\s*$/);
    if (idMatch) currentId = idMatch[1];
    const keysMatch = line.match(/^\s*keys: \[([^\]]*)\],?\s*$/);
    if (keysMatch && currentId) {
      for (const raw of keysMatch[1].split(',')) {
        const chord = raw.trim().replace(/^'|'$/g, '');
        if (chord) map.set(normalizeChord(chord), currentId);
      }
    }
    const chordMatch = line.match(/^\s*chord: '([^']+)',\s*$/);
    if (chordMatch && currentId) {
      for (const seg of chordMatch[1].split(/\s+/)) map.set(normalizeChord(seg), currentId);
    }
  }
  return map;
}

const builtin = builtinChords();
check('内置命令键位可枚举', builtin.size >= 40, `${builtin.size} 组`);

/* --------------------------------------------------------------- 收集插件声明 */
/** @type {{id: string, name: string, official: boolean, manifest: any, source: string}[]} */
const packs = [];
for (const entry of entries) {
  const dirManifest = path.join(root, 'public', 'plugins', entry.id, 'plugin.json');
  if (!existsSync(dirManifest)) {
    check(`${entry.id} 源目录清单存在`, false, dirManifest);
    continue;
  }
  const manifest = JSON.parse(readFileSync(dirManifest, 'utf8'));
  packs.push({ id: entry.id, name: manifest.name, official: entry.official === true, manifest, source: 'dir' });

  if (entry.official) continue;

  // 社区包：用户真正装到的是 zip，必须逐字段与源目录一致
  const zipPath = path.join(root, 'public', entry.download);
  if (!existsSync(zipPath)) {
    check(`${entry.id} 的 zip 已打包`, false, '先跑 npm run plugins:pack');
    continue;
  }
  const parsed = parseZip(readFileSync(zipPath));
  if (!parsed.ok) {
    check(`${entry.id} 的 zip 可解析`, false, parsed.error);
    continue;
  }
  const file = parsed.files.find((f) => f.name === 'plugin.json');
  if (!file) {
    check(`${entry.id} 的 zip 内含 plugin.json`, false, '');
    continue;
  }
  const zipManifest = JSON.parse(Buffer.from(file.bytes).toString('utf8'));
  const same = JSON.stringify(zipManifest) === JSON.stringify(manifest);
  check(
    `${entry.id} 的 zip 清单与源目录一致`,
    same,
    same ? '' : 'zip 过期，重跑 npm run plugins:pack',
  );
  if (same) packs.push({ id: `${entry.id} (zip)`, name: manifest.name, official: false, manifest: zipManifest, source: 'zip' });
}

/* ------------------------------------------------------------- 逐条校验每条命令 */
/** @type {Map<string, {plugin: string, command: string}>} 归一化键位 → 使用者 */
const owners = new Map();
let totalCommands = 0;
let totalKeys = 0;

for (const pack of packs) {
  const commands = (pack.manifest.contributes && pack.manifest.contributes.commands) || [];
  const renderer = validateManifest(pack.manifest, { quillpadVersion: APP_VERSION });
  const main = validateInstallManifest(pack.manifest, APP_VERSION);
  check(`${pack.id} 通过渲染层清单校验`, renderer.ok === true, renderer.ok ? '' : renderer.error);
  check(`${pack.id} 通过主进程清单校验`, main.ok === true, main.ok ? '' : main.error);
  if (!commands.length) {
    check(`${pack.id} 声明了命令`, false, 'contributes.commands 为空');
    continue;
  }
  for (const cmd of commands) {
    totalCommands += 1;
    const label = `${pack.id} · ${cmd.id}`;
    if (typeof cmd.key !== 'string' || !cmd.key) {
      check(`${label} 声明了快捷键`, false, '缺 key');
      continue;
    }
    totalKeys += 1;
    check(`${label} 键位合法（${cmd.key}）`, isValidKeyChord(cmd.key) && isValidKeyChordMain(cmd.key), '');
    check(`${label} 两道闸判定一致`, isValidKeyChord(cmd.key) === isValidKeyChordMain(cmd.key), cmd.key);

    const norm = normalizeChord(cmd.key);
    // 只在「官方目录」这一轮登记键位，zip 副本不重复登记
    if (!pack.id.endsWith('(zip)')) {
      const builtinOwner = builtin.get(norm);
      check(`${label} 未占用内置键位`, !builtinOwner, builtinOwner ? `与 ${builtinOwner} 撞车` : '');
      const pluginOwner = owners.get(norm);
      check(
        `${label} 键位全局唯一`,
        !pluginOwner,
        pluginOwner ? `与 ${pluginOwner.plugin}/${pluginOwner.command} 撞车` : '',
      );
      if (!pluginOwner) owners.set(norm, { plugin: pack.id, command: cmd.id });
      // 家族约定：插件只用 Mod+Alt（或 Ctrl+Alt），避免第三方包抢走 Ctrl+S 这类主键位
      const mods = norm.split('-').slice(0, -1);
      const inFamily = mods.includes('alt') && (mods.includes('mod') || mods.includes('ctrl'));
      check(`${label} 落在 Ctrl/Cmd+Alt 家族`, inFamily, norm);
    }
  }
}

check('所有命令都带快捷键', totalKeys === totalCommands, `${totalKeys}/${totalCommands}`);

/* --------------------------------------------------- 负数矩阵：两道闸必须同步拒绝 */
const base = {
  id: 'community.key-probe',
  name: '键位探针',
  description: '用于比对面两套校验实现的探针插件',
  author: 'QuillPad 测试',
  version: '1.0.0',
  license: 'MIT',
  engines: { quillpad: '>=1.0.0' },
  main: 'main.js',
  permissions: [],
  contributes: { commands: [{ id: 'probe', title: '探针', key: 'Mod-Alt-u' }] },
};
const keyMatrix = [
  ['Mod-Alt-u', true],
  ['Ctrl-Shift-Alt-x', true],
  ['Mod-Alt-F12', true],
  ['Mod-Alt-ArrowUp', true],
  ['F5', false],
  ['u', false],
  ['Mod-Alt-', false],
  ['Ctrl+U', false],
  ['Hyper-u', false],
  ['Mod-Alt-u v', false],
  ['Mod-Alt-Shift', false],
  ['Mod-Alt-£', false],
];
for (const [key, want] of keyMatrix) {
  const fixture = { ...base, contributes: { commands: [{ id: 'probe', title: '探针', key }] } };
  const rendererOk = validateManifest(fixture, { quillpadVersion: APP_VERSION }).ok === true;
  const mainOk = validateInstallManifest(fixture, APP_VERSION).ok === true;
  check(
    `键位「${key}」判定为${want ? '合法' : '非法'}（两道闸一致）`,
    rendererOk === want && mainOk === want,
    `renderer=${rendererOk} main=${mainOk}`,
  );
}

// 同一插件内重复键位必须被两道闸同时拒绝
const dupFixture = {
  ...base,
  contributes: {
    commands: [
      { id: 'one', title: '一', key: 'Mod-Alt-k' },
      { id: 'two', title: '二', key: 'Alt-Mod-k' },
    ],
  },
};
check('插件内重复键位被渲染层拒绝', validateManifest(dupFixture, { quillpadVersion: APP_VERSION }).ok === false, '');
check('插件内重复键位被主进程拒绝', validateInstallManifest(dupFixture, APP_VERSION).ok === false, '');

/* ------------------------------------------------ 宿主运行时：撞车就必须让位 */
defineCommands([
  { id: 'file.save', title: '保存', keys: ['Mod-s'], run: () => true },
  { id: 'view.toggleSidebar', title: '侧边栏', keys: ['Mod-b'], run: () => true },
  { id: 'file.openFolder', title: '打开文件夹', chord: 'Mod-k o', run: () => true },
  { id: 'edit.columnInsert', title: '列编辑', keys: ['Mod-Alt-u'], run: () => true },
]);
check('占用内置键位会被让位', filterAvailableChords(['Mod-s']).conflicts[0]?.owner === 'file.save', '');
check('占用两段式首段会被让位', filterAvailableChords(['Mod-k']).conflicts[0]?.owner === 'file.openFolder', '');
check('空闲键位照常下发', filterAvailableChords(['Mod-Alt-z']).keys.length === 1, '');
check(
  '重复注册自身不算冲突',
  filterAvailableChords(['Mod-Alt-z'], 'plugin.x.y').conflicts.length === 0,
  '',
);
check(
  '修饰键顺序无关',
  filterAvailableChords(['Alt-Mod-u']).conflicts[0]?.owner === 'edit.columnInsert',
  '',
);
const granted = filterAvailableChords(['Mod-Alt-z']);
defineCommand({ id: 'plugin.demo.upper', title: '演示包：转为大写', category: '插件', keys: granted.keys, run: () => true });
check(
  '插件命令挂上键位后出现在注册表',
  allCommands().some((c) => c.id === 'plugin.demo.upper' && (c.keys || []).includes('Mod-Alt-z')),
  '',
);

/* -------------------------------------------------------------------- 汇总 */
console.log('\n插件命令快捷键一览：');
for (const pack of packs.filter((p) => !p.id.endsWith('(zip)'))) {
  const commands = (pack.manifest.contributes && pack.manifest.contributes.commands) || [];
  console.log(`  ${pack.name}（${pack.id}）`);
  for (const cmd of commands) console.log(`    ${String(cmd.key).padEnd(20)} ${cmd.title}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exitCode = 1;
}
