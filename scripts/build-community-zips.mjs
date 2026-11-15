/**
 * 打包社区插件 zip 并回填 sha256。
 *
 * 为什么需要这个脚本：
 *  - 官方三个包走「目录式安装」（`public/plugins/<id>/` 直接 fetch），
 *    而社区包走「zip 安装」，市场里的 `download` 字段必须指向真实存在的 zip；
 *  - 曾经 `catalog.json` 里 6 条 community.* 都指向不存在的 zip，点安装必报
 *    HTTP 404 —— 这个脚本让「源码目录 → zip → sha256 → catalog」形成闭环，
 *    `scripts/data-check.mjs` 再反过来校验三者一致。
 *
 * 只依赖 Node 内置模块：自写 zip 写入（deflate + crc32），与主进程
 * `desktop/plugin-fs.cjs` 的自写解压对称，不引入第三方打包库。
 *
 * 运行：node scripts/build-community-zips.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseZip } = require(path.join(root, 'desktop', 'plugin-fs.cjs'));

/* ------------------------------------------------------------------ crc32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @return {number}
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/* --------------------------------------------------------------- zip 写入 */

/** 固定的 DOS 时间戳（1980-01-01 00:00），保证同内容产出同一份字节。 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/**
 * 生成 zip 字节。
 * @param {Array<{name: string, bytes: Buffer}>} entries
 * @return {Buffer}
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(bytes, { level: 9 });
    const sum = crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(deflated.length, 20);
    head.writeUInt32LE(bytes.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通文件
    head.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, deflated);
    central.push(head, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* -------------------------------------------------------------------- 主流程 */

const catalogPath = path.join(root, 'src', 'data', 'catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];

/** 参与打包 = 非官方（official=false）且已上架（available !== false）。 */
const targets = plugins.filter((p) => !p.official && p.available !== false);
const skipped = plugins.filter((p) => !p.official && p.available === false);

// 市场里不允许出现「装不上」的条目：做不到就删掉，不能靠 available=false 置灰充数
if (skipped.length) {
  throw new Error(
    `catalog 里有装不上的条目：${skipped.map((p) => p.id).join(', ')}\n` +
    '要么补成真实插件包，要么从 src/data/catalog.json 删除，不要留在市场里置灰。',
  );
}

if (targets.length === 0) {
  console.log('没有需要打包的社区插件。');
  process.exit(0);
}

const report = [];
for (const plugin of targets) {
  const dir = path.join(root, 'public', 'plugins', plugin.id);
  if (!existsSync(path.join(dir, 'plugin.json'))) {
    throw new Error(`缺少插件源目录：public/plugins/${plugin.id}/plugin.json`);
  }
  const files = readdirSync(dir)
    .filter((name) => statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, bytes: readFileSync(path.join(dir, name)) }));

  const zip = buildZip(files);
  const zipPath = path.join(root, 'public', 'plugins', `${plugin.id}.zip`);
  writeFileSync(zipPath, zip);

  // 自检：用主进程的解析器把自己写的 zip 读回来，逐文件比对字节
  const parsed = parseZip(zip);
  if (!parsed.ok) throw new Error(`${plugin.id}.zip 自检失败：${parsed.code} ${parsed.error}`);
  const back = new Map(parsed.files.map((f) => [f.name, f.bytes]));
  for (const file of files) {
    const got = back.get(file.name);
    if (!got || !got.equals(file.bytes)) throw new Error(`${plugin.id}.zip 自检失败：${file.name} 内容不一致`);
  }
  if (back.size !== files.length) throw new Error(`${plugin.id}.zip 自检失败：条目数不符`);

  plugin.sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  plugin.download = `plugins/${plugin.id}.zip`;
  report.push({ id: plugin.id, files: files.length, bytes: zip.length, sha256: plugin.sha256 });
}

writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

// 发布态由 scripts/gen-plugin-data.mjs 从源码态复制，保持两份逐字节一致
execFileSync(process.execPath, [path.join(root, 'scripts', 'gen-plugin-data.mjs')], { stdio: 'inherit' });

for (const row of report) {
  console.log(`打包 ${row.id} · ${row.files} 个文件 · ${row.bytes} 字节 · sha256 ${row.sha256.slice(0, 12)}…`);
}
console.log(`完成：${report.length} 个社区包已打包，catalog 已回填 sha256。`);
