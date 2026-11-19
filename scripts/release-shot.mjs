/**
 * QuillPad · GitHub Release 页面截图（docs/screenshots/07-github-release.png）
 *
 * 截取 Release 卡片从标题到 SHA256 块结束这一段：标题 + Latest 徽章 + 摘要 +
 * 下载表 + 系统要求 + SHA256。卡片左右边框完整保留，不含站点导航与侧栏。
 *
 * 用法：
 *   node scripts/release-shot.mjs              # 版本号取 package.json
 *   node scripts/release-shot.mjs --tag v1.0.5 # 指定标签
 *   node scripts/release-shot.mjs --out xxx.png
 *
 * 页面必须是公开可访问的；需要网络与 msedge（playwright-core 的 channel）。
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = argOf('--tag', `v${pkg.version}`);
const out = argOf('--out', 'docs/screenshots/07-github-release.png');
const repo = argOf('--repo', 'Frank-TCA/quillpad-desktop');
const vw = Number(argOf('--width', '1440'));
const url = `https://github.com/${repo}/releases/tag/${tag}`;

console.log(`[release-shot] ${url}`);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  viewport: { width: vw, height: 1200 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('.markdown-body', { timeout: 60000 });
// 表格与最后一段（SHA256）渲染完再量，避免 React 分批挂载导致高度算短
await page.waitForTimeout(2200);

const box = await page.evaluate(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
  };
  const h1 = document.querySelector('h1');
  if (!h1) throw new Error('页面上找不到 h1，Release 可能未发布或未公开');
  const md = document.querySelector('.markdown-body');
  if (!md) throw new Error('页面上找不到 .markdown-body');

  /* 卡片本体 = 同时包含标题与正文的最小祖先。不能靠「向上找第一个有边框的元素」：
     标题区内部就有带 border-top 的包装层，会量出比卡片窄一圈的框，截出来缺左右边框。 */
  let card = md;
  while (card && card !== document.body && !card.contains(h1)) card = card.parentElement;
  if (!card || card === document.body) throw new Error('找不到标题与正文的公共祖先');

  // 兜底：公共祖先若本身没有边框，再向上找到第一个带可见边框的祖先（真正的卡片）
  let framed = card;
  while (framed && framed !== document.body) {
    const cs = getComputedStyle(framed);
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') break;
    framed = framed.parentElement;
  }
  const cardBox = rect(framed && framed !== document.body ? framed : card);

  const mdBox = rect(md);
  // 最后一块：SHA256 代码块（若无 pre 则退化为正文底部）
  const pres = md.querySelectorAll('pre');
  const tail = pres.length ? rect(pres[pres.length - 1]) : null;

  return {
    title: h1.textContent.trim(),
    card: cardBox,
    md: mdBox,
    tailBottom: tail ? tail.bottom : mdBox.bottom,
    tailTag: tail ? 'pre' : 'markdown-body',
  };
});

if (!box.tailBottom || box.tailBottom <= box.card.y) throw new Error('内容区块测量异常');

/* 外扩 1px：clip 边界正好落在 1px 边框上时，Chrome 会把那一条边框裁掉，
   截出来就成了「只有右侧有竖线」的半张卡。外扩之后再四舍五入。 */
const pad = 24;
const left = Math.floor(box.card.x) - 1;
const top = Math.floor(box.card.y) - 1;
const clip = {
  x: left,
  y: top,
  width: Math.ceil(box.card.x + box.card.w) + 1 - left,
  height: Math.ceil(box.tailBottom + pad) - top,
};

console.log(
  `[release-shot] 标题「${box.title}」· 截取 ${clip.width}×${clip.height} @ (${clip.x}, ${clip.y}) · 收尾=${box.tailTag}`,
);

await page.screenshot({ path: out, clip });
await browser.close();
console.log(`[release-shot] 已写出 ${out}`);
