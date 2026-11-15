/**
 * QuillPad · 交付用主视觉截图（1440×900）
 *
 * 与 QA 的 shots/theme-*.png 分离，输出 shots/hero-{theme}.png。
 * 布局：三个标签（QuillPad.ts / theme.css / README.md）+ 侧栏大纲 + 状态栏信息，
 * 真实反映多标签、语法高亮、符号大纲与整体排版。
 *
 * 用法：
 *   npm run build
 *   npx vite preview --port 4173 --host 127.0.0.1
 *   node scripts/hero-shots.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';
mkdirSync('shots', { recursive: true });

const TS_SAMPLE = `/**
 * QuillPad · 轻量、快速、键盘优先的编辑器
 * 现代编辑体验，但不牺牲启动速度。
 */
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';

export type ThemeId = 'aurora' | 'ivory' | 'nord' | 'solarized';

export interface EditorOptions {
  readonly theme: ThemeId;
  readonly fontSize: number;
  readonly wordWrap?: boolean;
}

export class QuillPad {
  private views = new Map<string, EditorView>();

  constructor(private options: EditorOptions = { theme: 'aurora', fontSize: 14 }) {}

  open(name: string, parent: HTMLElement): EditorView {
    const view = new EditorView({
      parent,
      extensions: [keymap.of(defaultKeymap)],
    });
    this.views.set(name, view);
    return view;
  }

  /** 切换主题时同步语法高亮配色 */
  setTheme(theme: ThemeId): void {
    this.options = { ...this.options, theme };
    for (const view of this.views.values()) {
      view.dispatch({ effects: [] });
    }
  }

  get size(): number {
    return this.views.size;
  }
}

const total = 42;
console.log(\`ready · \${total} items · 100%\`);
`;

const CSS_SAMPLE = `/* QuillPad 主题变量：一处定义，全局换肤 */
:root[data-theme='aurora'] {
  --bg: #0a0c10;
  --bg-editor: #0d1015;
  --border: #232a34;
  --text: #dbe3ec;
  --accent: #6ea8fe;
  --radius: 5px;
}

.tab.is-active {
  background: var(--bg-editor);
  border-top: 2px solid var(--accent);
}

.tab__dirty::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
`;

const MD_SAMPLE = `# QuillPad

> 一支安静的羽毛笔，写给认真写字的人。

## 为什么是它

- **多标签 + 会话恢复**：关掉浏览器，回来还在原处
- **真实文件读写**：保存直接写回磁盘，可打开整个文件夹
- **四套主题**：Aurora / Ivory / Nord / Solarized
- **56 条命令**：菜单、工具栏、快捷键、命令面板共用一份定义

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 命令面板 | Ctrl + Shift + P |
| 在文件中查找 | Ctrl + Shift + F |
| 复制当前行 | Ctrl + D |
| 禅模式 | F11 |
`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.menubar__item', { timeout: 20000 });
await page.waitForTimeout(700);

// 用真实 API 建三个有名字的标签，让标签栏看起来像真的在工作
await page.evaluate(
  ({ ts, css, md }) => {
    const qp = window.quillpad;
    qp.createTab({ name: 'QuillPad.ts', content: ts, language: 'typescript' });
    qp.createTab({ name: 'theme.css', content: css, language: 'css' });
    qp.createTab({ name: 'README.md', content: md, language: 'markdown' });
    qp.tabsView.render();
  },
  { ts: TS_SAMPLE, css: CSS_SAMPLE, md: MD_SAMPLE },
);
await page.waitForTimeout(500);

// 关掉首次运行的欢迎标签，标签栏只保留三个真实文件
const welcomeTab = page.locator('#tabbar .tab', { hasText: '欢迎.md' }).first();
if (await welcomeTab.count()) {
  await welcomeTab.click();
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(500);
}

// 激活 TypeScript 标签
await page.locator('#tabbar .tab', { hasText: 'QuillPad.ts' }).first().click();
await page.waitForTimeout(600);

// 侧栏切到「大纲」，比空文件树更有信息量
const outlineTab = page.locator('.sidebar__tab', { hasText: '大纲' }).first();
if (await outlineTab.count()) {
  await outlineTab.click();
  await page.waitForTimeout(400);
}

const THEMES = [
  ['aurora', 'Aurora Dark'],
  ['ivory', 'Ivory Light'],
  ['nord', 'Nord'],
  ['solarized', 'Solarized Light'],
];

for (const [id, label] of THEMES) {
  await page.evaluate((t) => window.quillpad.setTheme(t), id);
  // 等主题切换的 toast 消失，截图更干净
  await page.waitForTimeout(2800);
  const path = `shots/hero-${id}.png`;
  await page.screenshot({ path });
  console.log(`已生成 ${path}  （${label}）`);
}

// 额外一张：Markdown 预览分栏（Aurora）
await page.evaluate(() => window.quillpad.setTheme('aurora'));
await page.locator('#tabbar .tab', { hasText: 'README.md' }).first().click();
await page.waitForTimeout(400);
await page.evaluate(() => window.quillpad.run('view.preview'));
await page.waitForTimeout(2800);
await page.screenshot({ path: 'shots/hero-preview.png' });
console.log('已生成 shots/hero-preview.png  （Markdown 预览）');

console.log('console 错误:', errors.length ? errors.join('\n') : '(无)');
await browser.close();
process.exit(errors.length ? 1 : 0);
