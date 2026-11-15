/**
 * QuillPad · 插件数据校验（T19 验收 ⑤ + G5-4 / G5-10 数据侧）
 *
 * 运行：node scripts/data-check.mjs
 * 校验源码态与发布态两份 JSON 一致、catalog 规模与 License 白名单、
 * npp-compat 40 条与 12/12/16 分布、unsupported reason ≥10 字、7 条首版可装。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LICENSE_WHITELIST, validateManifest, staticScan, satisfies } from '../src/core/plugins/manifest.js';
import { APP_VERSION } from '../src/core/version.js';
import { PLUGIN_ERROR_CODES } from '../src/core/plugins/errors.js';
import { EXPECTED_NOTICE, NOTICE_KEYWORDS } from '../src/core/plugins/notice.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`);
}

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const srcCatalog = JSON.parse(read('src/data/catalog.json'));
const srcCompat = JSON.parse(read('src/data/npp-compat.json'));
const pubCatalog = JSON.parse(read('public/plugins/catalog.json'));
const pubCompat = JSON.parse(read('public/npp-compat.json'));

const list = Array.isArray(srcCatalog.plugins) ? srcCatalog.plugins : [];
// 数量下限跟着真实包走：目录里只准放「点下去真能装上」的条目，
// 装不上的删掉，所以这里保 7 条真实包的下限，并由 plugin-pack-check 逐个真装。
check('catalog 至少 7 条真实插件', list.length >= 7, `${list.length} 条`);
check(
  'catalog 没有「未上架」占位条目',
  list.every((p) => p.available !== false),
  list.filter((p) => p.available === false).map((p) => p.id).join(',') || '无',
);
check(
  'catalog 每条都有 license 且在白名单内',
  list.every((p) => typeof p.license === 'string' && LICENSE_WHITELIST.includes(p.license)),
  [...new Set(list.map((p) => p.license))].join('/'),
);
const jsonHits = list.filter((p) => (p.keywords || []).some((k) => String(k).toLowerCase() === 'json'));
check('catalog 关键词 json 命中 ≥ 3 条', jsonHits.length >= 3, `${jsonHits.length} 条：${jsonHits.map((p) => p.id).join(',')}`);
check(
  'catalog 搜索「正则」能命中 quillpad.dev-tools',
  list.some((p) => p.id === 'quillpad.dev-tools' && (p.keywords || []).includes('正则')),
  '',
);
check(
  'catalog 三个官方包分别声明 13 / 4 / 4 条命令，合计 21',
  list.filter((p) => p.official).reduce((n, p) => n + (Number(p.commands) || 0), 0) === 21,
  list.filter((p) => p.official).map((p) => `${p.id}=${p.commands}`).join(' '),
);
check(
  '源码态与发布态 catalog 一致',
  JSON.stringify(srcCatalog) === JSON.stringify(pubCatalog),
  '',
);

/*
 * 官方内置包必须能装在**当前**版本上。
 * 教训：版本号从 2.x 重置为 1.0.0 后，三个官方包仍写 `engines: ^2.0.0`，
 * 市场里点「安装」全部报 EENGINE（QuillPad 版本不匹配），而既有单测把
 * quillpadVersion 硬编码成 '2.0.0'，谁都没发现。这里用真实 APP_VERSION 跑一遍。
 */
const officialIds = list.filter((p) => p.official).map((p) => p.id);
for (const id of officialIds) {
  const manifestFile = path.join(root, 'public', 'plugins', id, 'plugin.json');
  if (!existsSync(manifestFile)) {
    check(`官方包 ${id} 有 plugin.json`, false, manifestFile);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const validated = validateManifest(manifest, { quillpadVersion: APP_VERSION });
  check(
    `官方包 ${id} 可被当前版本 ${APP_VERSION} 安装`,
    validated.ok === true,
    validated.ok
      ? `engines ${manifest.engines && manifest.engines.quillpad}`
      : `${validated.code}: ${validated.message}（engines ${manifest.engines && manifest.engines.quillpad}）`,
  );
  check(
    `官方包 ${id} 的入口 ${manifest.main} 存在`,
    existsSync(path.join(root, 'public', 'plugins', id, String(manifest.main || ''))),
    '',
  );
}

const items = Array.isArray(srcCompat.items) ? srcCompat.items : [];
const count = (s) => items.filter((r) => r.status === s).length;
check('npp-compat 恰好 40 条', items.length === 40, `${items.length} 条`);
check(
  'npp-compat 分布 builtin 12 / port 12 / unsupported 16',
  count('builtin') === 12 && count('port') === 12 && count('unsupported') === 16,
  `${count('builtin')}/${count('port')}/${count('unsupported')}`,
);
check(
  'status 全属三枚举',
  items.every((r) => ['builtin', 'port', 'unsupported'].includes(r.status)),
  '',
);
check(
  '16 条 unsupported 的 reason 均 ≥ 10 字',
  items.filter((r) => r.status === 'unsupported').every((r) => String(r.reason || '').length >= 10),
  '',
);
const firstBatch = items.filter((r) => r.status === 'port' && r.batch === '首版');
check(
  'port + 首版恰好 7 条，且编号 = 4/6/13/19/20/24/29',
  firstBatch.length === 7 && firstBatch.map((r) => r.no).join(',') === '4,6,13,19,20,24,29',
  firstBatch.map((r) => r.no).join(','),
);
check(
  '一键安装标记只落在 port+首版',
  items.every((r) => !!r.installable === (r.status === 'port' && r.batch === '首版')),
  '',
);
check('源码态与发布态 npp-compat 一致', JSON.stringify(srcCompat) === JSON.stringify(pubCompat), '');

/* manifest 校验：8 类非法输入 + License + engines + 静态扫描 */
const good = {
  id: 'quillpad.demo',
  name: '示例',
  description: '一个示例插件',
  author: 'QuillPad',
  version: '1.0.0',
  license: 'MIT',
  engines: { quillpad: '^2.0.0' },
  main: 'main.js',
  permissions: ['editor:read'],
  contributes: { commands: [{ id: 'hello', title: '你好' }] },
};
check('validateManifest：合法清单通过', validateManifest(good, { quillpadVersion: '2.0.0' }).ok === true, '');

const badCases = [
  ['缺字段', { ...good, name: undefined }, 'ESCHEMA'],
  ['未知字段', { ...good, hacker: 1 }, 'ESCHEMA'],
  ['id 非法', { ...good, id: 'Bad ID' }, 'ESCHEMA'],
  ['version 非法', { ...good, version: '1.0' }, 'ESCHEMA'],
  ['main 路径穿越', { ...good, main: '../evil.js' }, 'EPATH'],
  ['未知权限', { ...good, permissions: ['root'] }, 'ESCHEMA'],
  ['命令 id 非法', { ...good, contributes: { commands: [{ id: 'a.b', title: 'x' }] } }, 'ESCHEMA'],
  ['contributes 类型错', { ...good, contributes: [] }, 'ESCHEMA'],
];
for (const [name, obj, want] of badCases) {
  const r = validateManifest(obj, { quillpadVersion: '2.0.0' });
  check(`validateManifest：${name} → ${want}`, r.ok === false && r.code === want, `实际=${r.ok ? 'ok' : r.code}`);
}
check(
  'validateManifest：license GPL-3.0 → ELICENSE',
  validateManifest({ ...good, license: 'GPL-3.0' }, { quillpadVersion: '2.0.0' }).code === 'ELICENSE',
  '',
);
check(
  'validateManifest：engines ^3.0.0 → EENGINE 且提示 3.x',
  (() => {
    const r = validateManifest({ ...good, engines: { quillpad: '^3.0.0' } }, { quillpadVersion: '2.0.0' });
    return r.code === 'EENGINE' && /3\.x/.test(r.detail || '');
  })(),
  '',
);
check('satisfies：^2.0.0 接受 2.9.9、拒绝 3.0.0', satisfies('2.9.9', '^2.0.0') && !satisfies('3.0.0', '^2.0.0'), '');

const scanSource = [
  'const a = eval(code);',
  'const F = new Function("return 1");',
  '<script src="https://evil"></script>',
  'const x = require("fs");',
  'console.log(process.cwd());',
  'console.log(__dirname);',
  'document.querySelector("body");',
  'fetch("/secret");',
].join('\n');
const scanHit = staticScan(scanSource, 'main.js');
check('staticScan：命中禁用调用并返回行号', scanHit.ok === false && scanHit.line === 1 && scanHit.rule === 'eval(', JSON.stringify(scanHit));
for (const [idx, rule] of ['eval(', 'new Function', '<script src="http', 'require(', 'process.', '__dirname', 'document.', 'fetch('].entries()) {
  const one = staticScan(scanSource.split('\n')[idx], 'main.js');
  check(`staticScan：单独命中 ${rule}`, one.ok === false && one.rule === rule, `实际=${one.ok ? 'ok' : one.rule}`);
}
check('staticScan：干净源码通过', staticScan('export function hi(){ return 1; }', 'main.js').ok === true, '');

check('错误码表覆盖 16 条 G 域必需码', [
  'ESCHEMA', 'ELICENSE', 'EENGINE', 'ESCAN', 'ESHA256', 'EPATH', 'EEXISTS', 'EBUSY',
  'ETIMEOUT', 'EDEAD', 'EPERM_NETWORK', 'EPERM_EDITOR_READ', 'EPERM_FILES_WRITE',
  'EPERM_CLIPBOARD', 'EPERM_SETTINGS', 'ESTORAGE_FULL',
].every((c) => PLUGIN_ERROR_CODES.includes(c)), `${PLUGIN_ERROR_CODES.length} 条`);

const notice = EXPECTED_NOTICE.join('\n');
check(
  'G0.1 原文含 5 条且可检索 G5-15 关键词',
  EXPECTED_NOTICE.length === 5 && NOTICE_KEYWORDS.every((k) => notice.includes(k)),
  NOTICE_KEYWORDS.join('/'),
);
check('构建后 public 数据文件均在', existsSync(path.join(root, 'public', 'plugins', 'catalog.json')) && existsSync(path.join(root, 'public', 'npp-compat.json')), '');

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== data-check 结果 =====\n通过 ${passed}/${results.length}`);
if (passed !== results.length) {
  for (const f of results.filter((r) => !r.ok)) console.log(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
