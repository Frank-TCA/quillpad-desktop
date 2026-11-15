/**
 * QuillPad · 视觉审查（量化）
 *
 * 在真实 DOM 上量测 4 套主题的：
 *   · 关键文字/图标的 WCAG 对比度
 *   · 各条形栏的内边距、元素间距、圆角、描边一致性
 *   · 溢出 / 截断 / 重叠
 *
 * 用法: node scripts/visual-audit.mjs [--url http://localhost:4173]
 * 产物: shots/visual-audit.json
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EDITOR_PALETTES } from '../src/editor/cm-themes.js';

const args = process.argv.slice(2);
const i = args.indexOf('--url');
const BASE = i >= 0 ? args[i + 1] : 'http://localhost:4173';
const OUT = path.resolve('shots');
mkdirSync(OUT, { recursive: true });

const THEMES = ['aurora', 'ivory', 'nord', 'solarized'];

/* ------------------------------------------- 调色板级对比度（不依赖文档内容） */

/**
 * 把 #rgb / #rrggbb 解析成 rgb 三元组。
 * @param {string} hex
 * @return {{r: number, g: number, b: number}|null}
 */
function parseHex(hex) {
  const m = String(hex).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/**
 * WCAG 相对亮度。
 * @param {{r: number, g: number, b: number}} c
 * @return {number}
 */
function relLum(c) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/**
 * 两个不透明颜色之间的对比度。
 * @param {{r: number, g: number, b: number}} a
 * @param {{r: number, g: number, b: number}} b
 * @return {number}
 */
function contrast(a, b) {
  const la = relLum(a);
  const lb = relLum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

/** 需要按「前景色」校验的调色板字段。 */
const FOREGROUND_TOKENS = [
  'fg', 'gutterFg', 'gutterActive',
  'keyword', 'control', 'string', 'number', 'comment', 'name', 'def', 'type',
  'prop', 'tag', 'attr', 'op', 'punct', 'invalid', 'heading', 'link', 'meta',
  'insert', 'delete',
];

/**
 * 直接从调色板算出每个主题的语法色对比度。
 * 这比「从示例文档里采样 span 颜色」更严格：不依赖文档里恰好出现了哪些 token。
 * @param {string} themeId
 * @return {Array<{token: string, color: string, ratio: number}>}
 */
function paletteRatios(themeId) {
  const p = EDITOR_PALETTES[themeId];
  const bg = parseHex(p.bg);
  const out = [];
  for (const token of FOREGROUND_TOKENS) {
    const hex = p[token];
    if (typeof hex !== 'string' || !hex.startsWith('#')) continue;
    const fg = parseHex(hex);
    if (!fg || !bg) continue;
    out.push({ token, color: hex, ratio: contrast(fg, bg) });
  }
  return out;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-editor');
await page.waitForTimeout(1200);

// 造一份有代表性的内容
await page.evaluate(() => {
  const app = window.quillpad;
  app.createTab({
    name: 'demo.ts',
    content: [
      "import { EditorView } from '@codemirror/view';",
      '',
      'interface Options {',
      '  readonly theme: "aurora" | "ivory";',
      '}',
      '',
      'export class QuillPad {',
      '  private views = new Map<string, EditorView>();',
      '  // 注释',
      '  open(name: string): EditorView {',
      '    const total = 42;',
      '    return new EditorView({ parent: document.body });',
      '  }',
      '}',
    ].join('\n'),
  });
});
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const app = window.quillpad;
  const tab = app.state.tabs.find((t) => t.name === 'demo.ts');
  if (tab) app.activateTab(tab.id);
});
await page.waitForTimeout(800);

const MEASURE = () => {
  /* ---------- 工具 ---------- */
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg, bg) => {
    if (!fg || !bg) return null;
    const L1 = lum(fg);
    const L2 = lum(bg);
    const a = Math.max(L1, L2);
    const b = Math.min(L1, L2);
    return +((a + 0.05) / (b + 0.05)).toFixed(2);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.85) return c;
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const fgOf = (el) => {
    let n = el;
    while (n) {
      const c = parse(getComputedStyle(n).color);
      if (c && c.a > 0.2) return c;
      n = n.parentElement;
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  };
  const svgColor = (el) => {
    const svg = el.querySelector('svg') || (el.tagName === 'svg' ? el : null);
    if (!svg) return null;
    const c = parse(getComputedStyle(svg).color);
    if (c && c.a > 0.2) return c;
    const stroke = svg.querySelector('path,circle,rect,line,polyline');
    if (stroke) {
      const sc = parse(getComputedStyle(stroke).stroke);
      if (sc && sc.a > 0.2) return sc;
    }
    return c;
  };
  const padOf = (el) => {
    const cs = getComputedStyle(el);
    return {
      l: parseFloat(cs.paddingLeft) || 0,
      r: parseFloat(cs.paddingRight) || 0,
      t: parseFloat(cs.paddingTop) || 0,
      b: parseFloat(cs.paddingBottom) || 0,
    };
  };
  const gapBetween = (a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return +(rb.left - ra.right).toFixed(1);
  };

  const TARGETS = [
    ['标题栏文档名', '.titlebar__title .doc-name'],
    ['菜单栏项', '.menubar__item'],
    ['工具栏图标', '.toolbar .tool-btn'],
    ['侧栏页签', '.sidebar__tab'],
    ['侧栏正文', '.sidebar__body'],
    ['标签栏标签名', '.tab .tab__name'],
    ['状态栏左', '#statusbar [data-cell="cursor"]'],
    ['状态栏右', '#statusbar [data-cell="saved"]'],
    ['行号', '.cm-lineNumbers .cm-gutterElement'],
    ['代码正文', '.cm-content'],
  ];

  const rec = { contrast: [], spacing: {}, overflow: [], notes: [] };

  for (const [name, sel] of TARGETS) {
    const el = document.querySelector(sel);
    if (!el) {
      rec.contrast.push({ name, ratio: null, note: '未找到元素' });
      continue;
    }
    const bg = bgOf(el);
    const fg = name.includes('图标') ? svgColor(el) || fgOf(el) : fgOf(el);
    rec.contrast.push({
      name,
      fg: `rgb(${fg.r},${fg.g},${fg.b})`,
      bg: `rgb(${bg.r},${bg.g},${bg.b})`,
      ratio: ratio(fg, bg),
    });
  }

  const spans = Array.from(document.querySelectorAll('.cm-content span'));
  const ebg = bgOf(document.querySelector('.cm-content'));
  const syntaxColors = Array.from(new Set(spans.map((s) => getComputedStyle(s).color)));
  rec.syntaxRatios = syntaxColors.map((c) => ({ color: c, ratio: ratio(parse(c), ebg) }));
  rec.syntaxColors = syntaxColors.length;

  for (const b of ['#titlebar', '#menubar', '#toolbar', '#tabbar', '#statusbar']) {
    const el = document.querySelector(b);
    if (!el) continue;
    const first = el.firstElementChild;
    rec.spacing[b] = {
      padding: padOf(el),
      firstChildPadLeft: first ? padOf(first).l : null,
      height: +el.getBoundingClientRect().height.toFixed(1),
      borderBottom: getComputedStyle(el).borderBottomWidth,
      borderTop: getComputedStyle(el).borderTopWidth,
      bg: getComputedStyle(el).backgroundColor,
    };
  }
  const sb = document.querySelector('#statusbar');
  if (sb) {
    const items = Array.from(sb.querySelectorAll('.status-item:not([hidden])'));
    const gaps = [];
    for (let k = 1; k < items.length; k += 1) gaps.push(+gapBetween(items[k - 1], items[k]));
    rec.spacing.statusGaps = gaps;
    rec.spacing.statusUniqueGaps = [...new Set(gaps)];
    const first = items[0];
    const last = items[items.length - 1];
    rec.spacing.statusEdge = {
      left: first ? +first.getBoundingClientRect().left.toFixed(1) : null,
      right: last ? +(window.innerWidth - last.getBoundingClientRect().right).toFixed(1) : null,
    };
  }
  const mi = Array.from(document.querySelectorAll('.menubar__item'));
  rec.spacing.menuGaps = mi.slice(1).map((n, k) => +gapBetween(mi[k], n));
  // 只统计工具栏「左侧」按钮之间的间距：右侧控件组是独立分组，
  // 与左侧之间是一段空白（margin-left:auto），不是图标间距。
  const tb = Array.from(document.querySelectorAll('#toolbar > .tool-btn'));
  rec.spacing.toolbarGaps = tb.slice(1).map((n, k) => +gapBetween(tb[k], n));
  const radii = {};
  for (const sel of ['.tool-btn', '.tab', '.status-item', '.sidebar__tab', '.qp-search', '.modal', '.dropdown', '.btn']) {
    const el = document.querySelector(sel);
    if (el) radii[sel] = getComputedStyle(el).borderRadius;
  }
  rec.spacing.radius = radii;

  for (const sel of ['#titlebar', '#menubar', '#toolbar', '#tabbar', '#statusbar', '#sidebar', '.cm-scroller', '.cm-content']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      rec.overflow.push({ sel, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: el.scrollWidth - el.clientWidth });
    }
  }
  for (const sel of ['.tab .tab__name', '.status-item', '.menubar__item']) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (el.scrollWidth > el.clientWidth + 1) {
        rec.notes.push(`文字被截断: ${sel} "${el.textContent.trim().slice(0, 24)}"`);
      }
    }
  }
  // 状态栏分组之间是否有分隔符
  rec.spacing.statusSeparators = Array.from(sb.querySelectorAll('.status-sep')).length;
  // 各区域实际背景色（用于确认主题真的切换了）
  rec.bgs = {
    titlebar: getComputedStyle(document.getElementById('titlebar')).backgroundColor,
    menubar: getComputedStyle(document.getElementById('menubar')).backgroundColor,
    toolbar: getComputedStyle(document.getElementById('toolbar')).backgroundColor,
    sidebar: getComputedStyle(document.getElementById('sidebar')).backgroundColor,
    tabbar: getComputedStyle(document.getElementById('tabbar')).backgroundColor,
    statusbar: getComputedStyle(document.getElementById('statusbar')).backgroundColor,
    editor: getComputedStyle(document.querySelector('.cm-editor')).backgroundColor,
  };
  return rec;
};

const audit = {};
for (const theme of THEMES) {
  await page.evaluate((t) => window.quillpad.setTheme(t), theme);
  await page.waitForTimeout(700); // 等 CSS 过渡（--tr-slow 200ms）结束
  audit[theme] = await page.evaluate(MEASURE);
}

writeFileSync(path.join(OUT, 'visual-audit.json'), JSON.stringify(audit, null, 2));

/** 语法色的 WCAG AA 门槛：低于该比值即判 FAIL。 */
const SYNTAX_MIN_RATIO = 4.5;
/** 收集本次审计中的全部不达标项。 */
const failures = [];

for (const theme of THEMES) {
  const r = audit[theme];
  console.log(`\n══ ${theme.toUpperCase()} ════════════════════════════════════════`);
  console.log('  区域背景:', JSON.stringify(r.bgs));
  console.log('  对比度 (WCAG: 4.5=正文 / 3.0=大字与图形):');
  for (const c of r.contrast) {
    const flag = c.ratio == null ? '??' : c.ratio >= 4.5 ? 'OK ' : c.ratio >= 3 ? '低 ' : '差!';
    console.log(`    ${flag} ${String(c.name).padEnd(14)} ${String(c.ratio).padStart(6)}  fg=${c.fg} bg=${c.bg}`);
    if (c.ratio != null && c.ratio < 4.5) {
      failures.push(`[${theme}] 界面元素「${c.name}」对比度 ${c.ratio} < 4.5`);
    }
  }
  console.log(`  语法色 ${r.syntaxColors} 种（运行时采样，门槛 ≥${SYNTAX_MIN_RATIO}）:`);
  for (const s of r.syntaxRatios) {
    const flag = s.ratio >= SYNTAX_MIN_RATIO ? 'OK ' : s.ratio >= 3 ? '低 ' : '差!';
    console.log(`    ${flag} ${s.color.padEnd(22)} ${s.ratio}`);
    if (s.ratio < SYNTAX_MIN_RATIO) {
      failures.push(`[${theme}] 运行时语法色 ${s.color} 对比度 ${s.ratio} < ${SYNTAX_MIN_RATIO}`);
    }
  }
  const pal = paletteRatios(theme);
  console.log(`  调色板语法色 ${pal.length} 项（门槛 ≥${SYNTAX_MIN_RATIO}）:`);
  for (const s of pal) {
    const flag = s.ratio >= SYNTAX_MIN_RATIO ? 'OK ' : s.ratio >= 3 ? '低 ' : '差!';
    console.log(`    ${flag} ${s.token.padEnd(14)} ${s.color.padEnd(10)} ${s.ratio}`);
    if (s.ratio < SYNTAX_MIN_RATIO) {
      failures.push(`[${theme}] 调色板 ${s.token} = ${s.color} 对比度 ${s.ratio} < ${SYNTAX_MIN_RATIO}`);
    }
  }
  console.log('  间距：');
  console.log(`    状态栏元素间距 = ${JSON.stringify(r.spacing.statusUniqueGaps)}（含分隔符 ${r.spacing.statusSeparators} 个）`);
  console.log(`    状态栏左右边距 = ${JSON.stringify(r.spacing.statusEdge)}`);
  console.log(`    菜单栏项间距   = ${JSON.stringify(r.spacing.menuGaps)}`);
  console.log(`    工具栏图标间距= ${JSON.stringify(r.spacing.toolbarGaps)}`);
  console.log(`    圆角           = ${JSON.stringify(r.spacing.radius)}`);
  console.log(`    各条栏 padding = ${JSON.stringify(Object.fromEntries(Object.entries(r.spacing).filter(([k]) => k.startsWith('#')).map(([k, v]) => [k, v.padding])))}`);
  console.log(`    各条栏 高度   = ${JSON.stringify(Object.fromEntries(Object.entries(r.spacing).filter(([k]) => k.startsWith('#')).map(([k, v]) => [k, v.height])))}`);
  console.log(`    各条栏 描边   = ${JSON.stringify(Object.fromEntries(Object.entries(r.spacing).filter(([k]) => k.startsWith('#')).map(([k, v]) => [k, { t: v.borderTop, b: v.borderBottom }])))}`);
  if (r.overflow.length) {
    console.log('  ⚠ 横向溢出：');
    r.overflow.forEach((o) => console.log(`     ${o.sel} +${o.overflowX}px`));
  } else console.log('  ✓ 无横向溢出');
  if (r.notes.length) {
    console.log('  ⚠ 截断：');
    r.notes.forEach((n) => console.log('     ' + n));
  }
}

if (failures.length) {
  console.log('\n════ 视觉审计未通过 ════');
  failures.forEach((f) => console.log('  ✗ ' + f));
  console.log(`共 ${failures.length} 项不达标（门槛：对比度 ≥ ${SYNTAX_MIN_RATIO}）`);
  await browser.close();
  process.exit(1);
}
console.log('\n════ 视觉审计通过：四套主题的界面元素与语法色对比度均 ≥ ' + SYNTAX_MIN_RATIO + ' ════');

await browser.close();
