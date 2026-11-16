/**
 * QuillPad · README 界面截图（1440×900，固定 Ivory Light 主题）
 *
 * 产出两套，中英文 README 各用一套：
 *   docs/screenshots/01-editor.png        中文界面
 *   docs/screenshots/en/01-editor.png     英文界面
 *
 * 四张图：主界面（所见即所得）/ 分栏 / 命令面板 / Ivory Light 代码配色。
 * 界面语言与主题都在页面启动前写进 localStorage，避免切换时弹 toast 污染画面。
 *
 * 用法：
 *   npm run build
 *   npx vite preview --port 4173 --host 127.0.0.1
 *   node scripts/readme-shots.mjs
 *
 * 只覆盖 README 引用的这四张；QA 的 shots/theme-*.png 是另一批产物，不要混用。
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QUILLPAD_URL || 'http://localhost:4173/';
const ROOT = 'docs/screenshots';

/** 第 4 张图用的代表性代码：够长以铺满编辑区，又能看出缩进与语法配色。 */
const TS_SAMPLE = `/**
 * QuillPad · 语法高亮示例
 */
import { EditorView } from '@codemirror/view';

export type ThemeId = 'aurora' | 'ivory' | 'nord' | 'solarized';

export interface EditorOptions {
  readonly theme: ThemeId;
  readonly fontSize: number;
  readonly wordWrap?: boolean;
}

export class QuillPad {
  private views = new Map<string, EditorView>();

  constructor(private options: EditorOptions = { theme: 'ivory', fontSize: 14 }) {}

  open(name: string): EditorView {
    const view = new EditorView({ parent: document.body });
    this.views.set(name, view);
    return view;
  }

  get size(): number {
    return this.views.size;
  }
}

const total = 42;
console.log(\`ready · \${total} items\`);
`;

const LOCALES = [
  { code: 'zh-CN', dir: ROOT },
  { code: 'en', dir: `${ROOT}/en` },
];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [];

for (const { code, dir } of LOCALES) {
  mkdirSync(dir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  // 启动前预置：浅色主题 + 指定界面语言 + 干净的会话（不恢复上次的标签）
  await context.addInitScript((locale) => {
    try {
      window.localStorage.clear();
      window.localStorage.setItem('quillpad.settings.v1', JSON.stringify({
        theme: 'ivory',
        themePinned: true,
        locale,
        sidebarVisible: true,
        sidebarTab: 'files',
        autoSave: false,
        fontSize: 14,
      }));
    } catch {
      /* 隐私模式下 localStorage 可能不可用，退化为默认设置 */
    }
  }, code);

  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${code}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${code}] pageerror: ${e.message}`));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#tabbar .tab', { timeout: 20000 });
  await page.waitForTimeout(900);

  /** 清掉提示条，避免截图里挂着 toast。 */
  const cleanToasts = async () => {
    await page.evaluate(() => {
      document.querySelectorAll('.toast-root .toast').forEach((n) => n.remove());
    });
    await page.waitForTimeout(120);
  };

  // ① 主界面：内置欢迎文档，所见即所得
  await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
  await page.waitForTimeout(700);
  await cleanToasts();
  await page.screenshot({ path: `${dir}/01-editor.png` });
  console.log(`已生成 ${dir}/01-editor.png（${code} · 主界面）`);

  // ② 分栏：源码与预览并排
  await page.evaluate(() => window.quillpad.setViewMode('split'));
  await page.waitForTimeout(900);
  await cleanToasts();
  await page.screenshot({ path: `${dir}/02-preview-split.png` });
  console.log(`已生成 ${dir}/02-preview-split.png（${code} · 分栏）`);

  // ③ 命令面板：不输关键词，让它把全部命令铺开（比只筛出两三条更能说明「汇集全部功能」）
  await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.quillpad.run('view.commandPalette'));
  await page.waitForTimeout(800);
  await cleanToasts();
  await page.screenshot({ path: `${dir}/03-command-palette.png` });
  console.log(`已生成 ${dir}/03-command-palette.png（${code} · 命令面板）`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ④ Ivory Light 代码配色：新建一个 TypeScript 标签并激活
  await page.evaluate((ts) => {
    window.quillpad.createTab({ name: 'quillpad.ts', content: ts, language: 'typescript' });
  }, TS_SAMPLE);
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.quillpad.setViewMode('source'));
  await page.waitForTimeout(600);
  await cleanToasts();
  await page.screenshot({ path: `${dir}/04-theme-ivory.png` });
  console.log(`已生成 ${dir}/04-theme-ivory.png（${code} · Ivory Light）`);

  await context.close();
}

console.log('console 错误:', errors.length ? errors.join('\n') : '(无)');
await browser.close();
process.exit(errors.length ? 1 : 0);
