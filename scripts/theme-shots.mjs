/**
 * QuillPad · 四套主题主界面截图（1440×900）
 *
 * 生成 shots/theme-{aurora,ivory,nord,solarized}.png：
 * 每张图都会先写入一段有代表性的 TypeScript 代码，
 * 这样能真实反映编辑区的语法高亮、gutter、行距与整体排版，而不是空文档。
 *
 * 用法：
 *   npm run build && npm run preview
 *   node scripts/theme-shots.mjs                # 输出 shots/theme-*.png
 *   node scripts/theme-shots.mjs --prefix=p1-   # 输出 shots/p1-theme-*.png
 *
 * 注意：shots/theme-*.png 是 QA 报告引用的正式产物，
 * 重新生成前请与 QA 确认，避免覆盖对方正在使用的截图。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';
const args = process.argv.slice(2);
const prefixArg = args.find((a) => a.startsWith('--prefix='));
const PREFIX = prefixArg ? prefixArg.slice('--prefix='.length) : 'theme-';

mkdirSync('shots', { recursive: true });

/** 截图用的代表性代码。 */
const SAMPLE = `/**
 * QuillPad · 视觉审查样例
 */
import { EditorView } from '@codemirror/view';

interface Options {
  readonly theme: 'aurora' | 'ivory' | 'nord';
  readonly fontSize: number;
}

export class QuillPad {
  private views = new Map<string, EditorView>();

  constructor(private options: Options = { theme: 'aurora', fontSize: 14 }) {}

  open(name: string): EditorView {
    const view = new EditorView({ parent: document.body });
    this.views.set(name, view);
    return view;
  }
}

const total = 42;
console.log(\`ready · \${total} items\`);
`;

const THEMES = [
  ['aurora', 'Aurora Dark'],
  ['ivory', 'Ivory Light'],
  ['nord', 'Nord'],
  ['solarized', 'Solarized Light'],
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.menubar__item', { timeout: 20000 });
await page.waitForTimeout(800);

// 写入代表性代码
await page.evaluate(async (sample) => {
  const qp = window.quillpad;
  qp.setLanguage('typescript');
  await new Promise((r) => setTimeout(r, 300));
  qp.editor.view.dispatch({
    changes: { from: 0, to: qp.editor.view.state.doc.length, insert: sample },
  });
  qp.editor.view.dispatch({ selection: { anchor: 0 } });
}, SAMPLE);
await page.waitForTimeout(700);

for (const [id, label] of THEMES) {
  await page.evaluate((themeId) => window.quillpad.setTheme(themeId), id);
  await page.waitForTimeout(500);
  const path = `shots/${PREFIX}${id}.png`;
  await page.screenshot({ path });
  console.log(`已生成 ${path}  （${label}）`);
}

console.log('console 错误:', errors.length ? errors.join('\n') : '(无)');
await browser.close();
process.exit(errors.length ? 1 : 0);
