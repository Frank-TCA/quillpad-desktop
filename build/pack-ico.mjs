/**
 * 把 build/icon-sizes/*.png 打包成多尺寸 .ico。
 *
 * Vista 起 ICO 允许直接内嵌 PNG 数据，所以这里不需要 BMP/DIB 编码，
 * 只需拼出 ICONDIR + ICONDIRENTRY 头，再把各尺寸 PNG 原样接上。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const pngs = [];
for (const size of SIZES) {
  const buf = await readFile(path.join(here, 'icon-sizes', `icon-${size}.png`));
  pngs.push({ size, buf });
}

const HEADER = 6;
const ENTRY = 16;
let offset = HEADER + ENTRY * pngs.length;

const dir = Buffer.alloc(HEADER);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(pngs.length, 4);

const entries = [];
for (const { size, buf } of pngs) {
  const entry = Buffer.alloc(ENTRY);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // 调色板颜色数
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(buf.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += buf.length;
}

const ico = Buffer.concat([dir, ...entries, ...pngs.map((p) => p.buf)]);
await writeFile(path.join(here, 'icon.ico'), ico);

console.log(`icon.ico 已生成：${pngs.length} 个尺寸，${(ico.length / 1024).toFixed(1)} KB`);
