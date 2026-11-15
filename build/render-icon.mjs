/**
 * 把 build/icon.svg 渲染为各尺寸 PNG（透明背景），供 electron-builder 打包使用。
 *
 * 用系统已装的 Edge 走 Playwright，不额外下载浏览器；同样一份 SVG 即
 * 应用图标的设计源，改完重跑即可。
 */

import { chromium } from 'playwright-core';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const OUT_DIR = path.join(here, 'icon-sizes');

/**
 * 生成尺寸对应的 HTML，SVG 以 viewBox 自适应缩放。
 * @param {string} svg
 * @param {number} size
 * @return {string}
 */
function pageFor(svg, size) {
  const body = svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
svg{display:block}</style></head><body>${body}</body></html>`;
}

const svg = await readFile(path.join(here, 'icon.svg'), 'utf8');
// 小尺寸下细缝会糊成噪点，换成实心变体
const svgSmall = await readFile(path.join(here, 'icon-small.svg'), 'utf8');
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });

for (const size of SIZES) {
  const source = size <= 32 ? svgSmall : svg;
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(pageFor(source, size), { waitUntil: 'load' });
  const png = await page.screenshot({ omitBackground: true });
  const target = path.join(OUT_DIR, `icon-${size}.png`);
  await writeFile(target, png);
  if (size === 512) await writeFile(path.join(here, 'icon.png'), png);
  await page.close();
  console.log(`  ${size}x${size} → ${path.relative(root, target)}`);
}

await browser.close();
console.log('图标渲染完成');
