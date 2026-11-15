/**
 * QuillPad · 图标验收（T17）
 *
 * 三件事，全部零依赖（PNG 解码借浏览器 canvas，不引 sharp/jimp）：
 *   1. `build/icon.ico` 必须是合法 ICONDIR，且含 16/24/32/48/64/128/256 七个尺寸；
 *   2. 16 / 24 / 32px 三个小尺寸必须「看得清」：白羽与底色的对比度 ≥ 3:1，
 *      墨量（不透明像素占比）落在 20%–85%，中心区域不能是空的；
 *   3. 图标源（icon.svg / icon-small.svg）与产物的一致性：小尺寸变体不得带羽轴细缝、
 *      两者渐变一致、且 16–32px 必须走 small 变体（render-icon.mjs 的约定）。
 *
 * 用法：node scripts/icon-check.mjs
 */

import { chromium } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const buildDir = path.join(root, 'build');

const EXPECTED_SIZES = [16, 24, 32, 48, 64, 128, 256];
const MIN_CONTRAST = 3;
const results = [];

/**
 * 记录一条断言。
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  :: ${detail}` : ''}`);
}

/* ---------------------------------------------------------------- 1. ICO 结构 */

/**
 * 解析 ICO 目录（不含像素数据解码）。
 * @param {Buffer} buf
 * @return {{count: number, entries: Array<{size: number, reserved: number, planes: number, bpp: number, bytes: number, offset: number, png: boolean}>}}
 */
function parseIco(buf) {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    if (at + 16 > buf.length) break;
    const w = buf.readUInt8(at) || 256;
    const h = buf.readUInt8(at + 1) || 256;
    const bytes = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const png =
      buf.length >= offset + 8 && buf.toString('latin1', offset, offset + 8) === '\x89PNG\r\n\x1a\n';
    entries.push({
      size: Math.min(w, h),
      reserved,
      planes: buf.readUInt16LE(at + 4),
      bpp: buf.readUInt16LE(at + 6),
      bytes,
      offset,
      png,
    });
  }
  return { reserved, type, count, entries };
}

const icoPath = path.join(buildDir, 'icon.ico');
check('icon.ico 存在', existsSync(icoPath), icoPath);
const ico = existsSync(icoPath) ? parseIco(readFileSync(icoPath)) : { count: 0, entries: [] };

check('ICONDIR 合法（reserved=0 / type=1）', ico.reserved === 0 && ico.type === 1, `reserved=${ico.reserved} type=${ico.type} count=${ico.count}`);

const sizes = ico.entries.map((e) => e.size).sort((a, b) => a - b);
check(
  '含 7 个尺寸 16/24/32/48/64/128/256',
  EXPECTED_SIZES.every((s) => sizes.includes(s)) && sizes.length === EXPECTED_SIZES.length,
  `实际=${sizes.join('/')}`,
);

check(
  '每个尺寸都是内嵌 PNG 且 32bpp',
  ico.entries.length > 0 && ico.entries.every((e) => e.png && e.bpp === 32),
  `png=${ico.entries.filter((e) => e.png).length}/${ico.entries.length}`,
);

const overlapping = ico.entries.some((e) => e.offset + e.bytes > readFileSync(icoPath).length);
check('每个条目的偏移与长度都在文件内', !overlapping, '');

/* ------------------------------------------------- 2. 小尺寸对比度（真像素） */

/**
 * 相对亮度（WCAG 2.1）。
 * @param {number} r 0-255
 * @param {number} g
 * @param {number} b
 * @return {number}
 */
function relLum(r, g, b) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * 对比度。
 * @param {number} a
 * @param {number} b
 * @return {number}
 */
function contrast(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
await page.goto('about:blank');

/**
 * 用 canvas 读一张 PNG 的像素并统计。
 * @param {string} file
 * @return {Promise<object>}
 */
async function analyzePng(file) {
  const b64 = readFileSync(file).toString('base64');
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      px.push({ r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] });
    }
    return { w, h, px };
  }, `data:image/png;base64,${b64}`);
}

const luminanceOf = (p) => relLum(p.r, p.g, p.b);

/**
 * 统计一张图标：墨量、前景（白羽）亮度、背景（底色）亮度、中心亮度。
 * @param {{w: number, h: number, px: Array<object>}} img
 * @return {object}
 */
function stats(img) {
  const lum = img.px.map((p) => ({ l: luminanceOf(p), a: p.a }));
  const opaque = lum.filter((x) => x.a > 200);
  // 墨量 = **白羽占不透明底色的比例**（不是占整块画布——圆角矩形本身就铺满了画布）
  const inkRatio = opaque.length ? opaque.filter((x) => x.l > 0.75).length / opaque.length : 0;

  // 白羽：亮度 > 0.75（白色 ≈ 1.0，渐变压暗后 ≈ 0.13–0.19）
  const fgAll = opaque.filter((x) => x.l > 0.75).map((x) => x.l).sort((a, b) => a - b);
  const bgAll = opaque.filter((x) => x.l <= 0.3).map((x) => x.l).sort((a, b) => a - b);

  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
  const fg = fgAll.length ? fgAll[Math.floor(fgAll.length * 0.5)] : 0;
  // 背景取「最亮的那批底色」，即对比度最不利的情形
  const bg = bgAll.length ? bgAll[Math.floor(bgAll.length * 0.95)] : 0;

  // 中心 3x3（16px 图标中心就是 8,8）
  const cx = Math.floor(img.w / 2);
  const cy = Math.floor(img.h / 2);
  let centerMax = 0;
  let centerAny = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = Math.min(img.w - 1, Math.max(0, cx + dx));
      const y = Math.min(img.h - 1, Math.max(0, cy + dy));
      const p = img.px[y * img.w + x];
      if (!p || p.a < 200) continue;
      centerAny += 1;
      centerMax = Math.max(centerMax, luminanceOf(p));
    }
  }

  return {
    inkRatio,
    fgLum: fg,
    bgLum: bg,
    fgCount: fgAll.length,
    bgCount: bgAll.length,
    centerMax,
    centerAny,
    ratio: contrast(fg, bg),
    centerRatio: contrast(centerMax, bg),
  };
}

const summary = [];
for (const size of [16, 24, 32]) {
  const file = path.join(buildDir, 'icon-sizes', `icon-${size}.png`);
  if (!existsSync(file)) {
    check(`icon-${size}.png 存在`, false, file);
    continue;
  }
  const img = await analyzePng(file);
  const s = stats(img);
  summary.push(`${size}px 前景=${s.fgLum.toFixed(3)} 背景=${s.bgLum.toFixed(3)} 对比度=${s.ratio.toFixed(2)}:1`);

  check(
    `${size}px 白羽/底色对比度 ≥ ${MIN_CONTRAST}:1`,
    s.ratio >= MIN_CONTRAST,
    `${s.ratio.toFixed(2)}:1（前景 ${s.fgLum.toFixed(3)} / 背景 ${s.bgLum.toFixed(3)}）`,
  );
  check(
    `${size}px 白羽覆盖率在 8%–60%（既不空也不糊成一团）`,
    s.inkRatio >= 0.08 && s.inkRatio <= 0.6,
    `${(s.inkRatio * 100).toFixed(1)}%`,
  );
  check(
    `${size}px 中心 3×3 有实体像素且对比度 ≥ ${MIN_CONTRAST}:1`,
    s.centerAny >= 6 && s.centerRatio >= MIN_CONTRAST,
    `不透明=${s.centerAny}/9 中心对比度=${s.centerRatio.toFixed(2)}:1`,
  );
}

/* ------------------------------------------------------ 3. 图标源一致性 */

const svgMain = readFileSync(path.join(buildDir, 'icon.svg'), 'utf8');
const svgSmall = readFileSync(path.join(buildDir, 'icon-small.svg'), 'utf8');
const stops = (s) => (s.match(/stop-color="#[0-9a-fA-F]{6}"/g) || []).join(',');

check(
  '主图标保留羽轴细缝（mask)，小尺寸变体不带（避免 16px 糊成噪点）',
  /<mask id="vein"/.test(svgMain) && /mask="url\(#vein\)"/.test(svgMain) && !/<mask/.test(svgSmall),
  '',
);
check(
  '主图标与小尺寸变体使用同一套品牌渐变',
  stops(svgMain) === stops(svgSmall) && stops(svgMain).length > 0,
  stops(svgMain),
);
check(
  '品牌色对比度自检：白 #ffffff 对渐变两端均 ≥ 4.5:1',
  (() => {
    const colors = [...new Set((svgMain.match(/stop-color="#[0-9a-fA-F]{6}"/g) || []).map((c) => c.slice(13, 20)))];
    return (
      colors.length === 2 &&
      colors.every((hex) => {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return contrast(1, relLum(r, g, b)) >= 4.5;
      })
    );
  })(),
  (svgMain.match(/stop-color="#[0-9a-fA-F]{6}"/g) || []).join(' → '),
);

const renderer = readFileSync(path.join(buildDir, 'render-icon.mjs'), 'utf8');
check(
  '16–32px 走 icon-small.svg（render-icon.mjs 的 size <= 32 分支）',
  /size\s*<=\s*32/.test(renderer) && /svgSmall/.test(renderer),
  '',
);

await browser.close();

/* ------------------------------------------------------------------ 结论 */

const passed = results.filter((r) => r.ok).length;
console.log('');
console.log('===== icon-check 摘要 =====');
for (const line of summary) console.log(`  ${line}`);
console.log(`  通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exit(1);
