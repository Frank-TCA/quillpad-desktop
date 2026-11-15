/**
 * QuillPad · 独立功能 / 视觉审计脚本（QA）
 *
 * 使用系统已安装的 Edge（msedge channel）+ playwright-core，无需下载浏览器。
 *
 * 用法:
 *   node scripts/qa.mjs                     # 全量测试 + 4 套主题截图
 *   node scripts/qa.mjs --url http://localhost:4173
 *   node scripts/qa.mjs --skip=visual        # 跳过截图
 *
 * 产物:
 *   shots/qa-report.json   结构化结果
 *   shots/theme-*.png      4 套主题截图（1440x900）
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const BASE = argOf('url') || process.env.QUILLPAD_URL || 'http://localhost:4173';
const SKIP_VISUAL = args.includes('--skip=visual');
const OUT = path.resolve('shots');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ 框架 */

const results = [];
const consoleErrors = [];
const consoleWarnings = [];
const networkErrors = [];
let currentGroup = '启动';

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 54 - name.length))}`);
}

async function test(name, fn) {
  try {
    const r = await fn();
    const ok = r === undefined ? true : !!r.ok;
    const detail = r && r.detail !== undefined ? r.detail : '';
    results.push({ group: currentGroup, name, ok, detail });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
    return ok;
  } catch (err) {
    results.push({ group: currentGroup, name, ok: false, detail: `异常: ${err.message}` });
    console.log(`  FAIL  ${name}  :: 异常: ${err.message}`);
    return false;
  }
}

/* --------------------------------------------------------------- 浏览器 */

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();

page.on('console', (m) => {
  const t = m.text();
  const loc = m.location();
  const rec = loc && loc.url ? `${t} @ ${loc.url}:${loc.lineNumber}` : t;
  if (m.type() === 'error') consoleErrors.push(rec);
  else if (m.type() === 'warning') consoleWarnings.push(rec);
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  networkErrors.push(`${r.url()} :: ${r.failure()?.errorText || 'failed'}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) networkErrors.push(`${r.status()} ${r.url()}`);
});

/* -------------------------------------------------------------- 工具函数 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docText = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'),
  );

const statusText = () => page.locator('#statusbar').innerText().then((t) => t.replace(/\s+/g, ' ').trim());
const tabNames = () => page.locator('.tab .tab__name').allInnerTexts();
const activeTabName = async () => {
  const t = page.locator('.tab.is-active .tab__name');
  return (await t.count()) ? await t.first().innerText() : '';
};
const statusCell = async (name) => {
  const c = page.locator(`#statusbar [data-cell="${name}"]`);
  return (await c.count()) ? (await c.first().innerText()).trim() : '';
};

/** 用真实输入事件把编辑器正文替换为指定内容。 */
async function setDoc(text) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
  await sleep(150);
  let got = await docText();
  if (got !== text) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) await page.keyboard.press('Enter');
      if (lines[i]) await page.keyboard.insertText(lines[i]);
    }
    await sleep(150);
    got = await docText();
  }
  return got;
}

/** 选中从第 from 行到第 to 行（含）。 */
async function selectLines(from, to) {
  await page.evaluate(
    ({ from, to }) => {
      const view = window.quillpad.editor.view;
      const a = view.state.doc.line(from).from;
      const b = view.state.doc.line(to).to;
      view.dispatch({ selection: { anchor: a, head: b } });
      view.focus();
    },
    { from, to },
  );
  await sleep(80);
}

async function gotoLine(n) {
  await page.evaluate((ln) => {
    const view = window.quillpad.editor.view;
    const line = view.state.doc.line(Math.min(ln, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
    view.focus();
  }, n);
  await sleep(80);
}

const cursorLine = () =>
  page.evaluate(() => {
    const s = window.quillpad.editor.view.state;
    return s.doc.lineAt(s.selection.main.head).number;
  });

/** 通过拖拽事件打开一个「虚拟文件」，走真实的 openFileObject 管线。 */
async function openVirtualFile(name, content) {
  await page.evaluate(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/plain' }));
      window.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    },
    { name, content },
  );
  await sleep(260);
}

/** 通过命令面板执行一条命令。 */
async function runPalette(query, titleMatch) {
  await page.keyboard.press('Control+Shift+P');
  await sleep(320);
  if (!(await page.locator('.palette-backdrop').count())) return false;
  await page.locator('.palette__input').fill(query);
  await sleep(320);
  const items = page.locator('.palette__item');
  const n = await items.count();
  if (!n) {
    await page.keyboard.press('Escape');
    return false;
  }
  let idx = 0;
  if (titleMatch) {
    for (let i = 0; i < n; i += 1) {
      const t = await items.nth(i).innerText();
      if (t.includes(titleMatch)) {
        idx = i;
        break;
      }
    }
  }
  await items.nth(idx).click();
  await sleep(320);
  return true;
}

/** 关闭「所有」标签（走命令，不触发未保存弹窗）。 */
async function closeAllTabs() {
  await page.evaluate(() => {
    window.quillpad.state.tabs.slice().forEach((t) => window.quillpad.closeTab(t.id, true));
  });
  await sleep(400);
}

/* ==================================================================== 启动 */

group('启动与基础结构');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.cm-editor', { timeout: 15000 });
await sleep(1000);

await test('应用完成启动（#app[data-ready]）', async () => {
  const ready = await page.evaluate(() => document.getElementById('app').dataset.ready);
  return { ok: ready === 'true', detail: `data-ready=${ready}` };
});

await test('核心骨架齐全', async () => {
  const sel = ['#titlebar', '#menubar', '#toolbar', '#sidebar', '#tabbar', '#editor-host', '#statusbar'];
  const miss = [];
  for (const s of sel) if (!(await page.locator(s).count())) miss.push(s);
  return { ok: miss.length === 0, detail: miss.length ? '缺少 ' + miss.join(',') : '7/7 全部存在' };
});

await test('CodeMirror 6 已挂载且内容可读', async () => {
  const n = await page.locator('.cm-editor').count();
  const t = await docText();
  return { ok: n > 0 && t.length > 0, detail: `.cm-editor=${n} 内容长度=${t.length}` };
});

await test('首屏默认打开欢迎文档（欢迎.md）', async () => {
  const names = await tabNames();
  return { ok: names.some((n) => /欢迎/.test(n)), detail: names.join(' | ') };
});

await test('工具栏 / 标题栏按钮的 tooltip 与 aria-label 是中文命令名（非命令 id）', async () => {
  // 回归：命令注册表必须早于任何「会读取命令标题」的 UI 初始化，
  // 否则按钮的 data-tip / aria-label 会退化成 file.new / view.themeMenu 这类原始 id。
  const info = await page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll('#toolbar [data-cmd]'),
      ...document.querySelectorAll('#titlebar-actions [data-cmd]'),
    ];
    const rows = btns.map((b) => ({
      cmd: b.dataset.cmd,
      tip: b.dataset.tip || '',
      aria: b.getAttribute('aria-label') || '',
    }));
    return { rows, total: rows.length };
  });
  const idLike = /^[a-z]+\.[a-zA-Z]+$/;
  const bad = info.rows.filter((r) => idLike.test(r.aria) || idLike.test(r.tip.split(' · ')[0]));
  const noChinese = info.rows.filter((r) => !/[一-龥]/.test(r.aria));
  return {
    ok: info.total > 0 && bad.length === 0 && noChinese.length === 0,
    detail:
      bad.length === 0 && noChinese.length === 0
        ? `${info.total} 个按钮全部为中文命令名，例：${info.rows[0].aria}（${info.rows[0].tip}）`
        : `${info.total} 个按钮中 ${bad.length} 个仍是命令 id（${bad.slice(0, 3).map((r) => r.cmd).join(',')}），${noChinese.length} 个无中文`,
  };
});

await test('页面无 favicon 404（资源完整性）', async () => {
  // 注意：不要主动 fetch('/favicon.ico') —— 站点使用内联 data-URI 图标，
  // 服务器上并不存在 favicon.ico，主动请求反而会自己制造一条 404 控制台错误。
  const icon = await page.evaluate(() => {
    const el = document.querySelector('link[rel~="icon"]');
    if (!el) return { exists: false, href: '', isData: false };
    const href = el.getAttribute('href') || '';
    return { exists: true, href: href.slice(0, 40), isData: /^data:image\//.test(href) };
  });
  const fav = networkErrors.filter((e) => /favicon/i.test(e));
  const consoleFav = consoleErrors.filter((e) => /favicon/i.test(e));
  const ok = icon.exists && icon.href.length > 0 && fav.length === 0 && consoleFav.length === 0;
  return {
    ok,
    detail: ok
      ? `<link rel="icon"> 存在（${icon.isData ? '内联 data-URI' : icon.href}）；浏览器未请求 /favicon.ico，无 404`
      : `<link rel="icon"> ${icon.exists ? '存在' : '缺失'}；favicon 网络失败=${fav.length}；favicon 控制台错误=${consoleFav.length}` +
        (consoleFav[0] ? `（${consoleFav[0]}）` : ''),
  };
});

await test('首次加载无 console error', async () => {
  const errs = consoleErrors.filter((e) => !/favicon/i.test(e));
  return {
    ok: errs.length === 0,
    detail: errs.length
      ? errs.slice(0, 3).join(' | ')
      : consoleErrors.length
        ? `仅 favicon 404（${consoleErrors[0]}）`
        : '干净',
  };
});

/* ================================================================ 多标签 */

group('多标签');

await test('Ctrl+N 新建标签', async () => {
  const before = (await tabNames()).length;
  await page.keyboard.press('Control+n');
  await sleep(450);
  const after = (await tabNames()).length;
  return { ok: after === before + 1, detail: `${before} -> ${after}` };
});

await test('新建标签命名为「未命名.txt / 未命名N.txt」', async () => {
  const names = await tabNames();
  return { ok: names.some((n) => /^未命名\d*\.txt$/.test(n)), detail: names.join(' | ') };
});

await test('新建标签不会与已有标签重名', async () => {
  await closeAllTabs();
  const created = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Control+n');
    await sleep(320);
    created.push(await activeTabName());
  }
  const dup = created.filter((n, i) => created.indexOf(n) !== i);
  return {
    ok: dup.length === 0,
    detail: dup.length
      ? `出现重名：${[...new Set(dup)].join(', ')}（全部：${created.join(', ')}）`
      : created.join(', '),
  };
});

await test('编辑后标签显示未保存脏标记 + 标题栏圆点', async () => {
  await setDoc('const dirtyProbe = 1;');
  await sleep(450);
  const dirty = await page.locator('.tab.is-active .tab__dirty').count();
  const titleDot = await page.evaluate(() => !!document.querySelector('#titlebar-title .doc-dirty'));
  return { ok: dirty === 1 && titleDot, detail: `tab 脏标记=${dirty} 标题栏圆点=${titleDot}` };
});

await test('点击标签可切换活动标签', async () => {
  const names = await tabNames();
  await page.locator('.tab').first().click();
  await sleep(380);
  const now = await activeTabName();
  return { ok: now === names[0], detail: `活动标签=${now}，期望=${names[0]}` };
});

await test('Ctrl+W 关闭标签', async () => {
  const before = (await tabNames()).length;
  await page.keyboard.press('Control+w');
  await sleep(700);
  const after = (await tabNames()).length;
  return { ok: after === before - 1, detail: `${before} -> ${after}` };
});

await test('Ctrl+Tab 在标签之间循环切换', async () => {
  while ((await tabNames()).length < 3) {
    await page.keyboard.press('Control+n');
    await sleep(280);
  }
  const before = await activeTabName();
  const bound = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.palette__item'));
    return null; // 占位，下面用命令面板枚举
  });
  void bound;
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Tab');
  await sleep(450);
  const after = await activeTabName();
  return {
    ok: before !== after,
    detail:
      before !== after
        ? `${before} -> ${after}`
        : `活动标签未变（${before}）；命令注册表中不存在 Mod-Tab / Ctrl+Tab 绑定（见命令面板枚举）`,
  };
});

await test('标签拖拽排序生效', async () => {
  const names = await tabNames();
  if (names.length < 3) return { ok: false, detail: '标签不足 3 个' };
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab')).map((n) => n.dataset.tabId),
  );
  const before = await tabNames();
  const moved = await page.evaluate(
    ({ fromId, toId }) => {
      const dt = new DataTransfer();
      const src = document.querySelector(`[data-tab-id="${fromId}"]`);
      const tgt = document.querySelector(`[data-tab-id="${toId}"]`);
      if (!src || !tgt) return false;
      const rect = tgt.getBoundingClientRect();
      const clientX = rect.right - 2;
      const clientY = rect.top + rect.height / 2;
      src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      tgt.dispatchEvent(
        new DragEvent('dragover', {
          dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY,
        }),
      );
      tgt.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY,
        }),
      );
      src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return true;
    },
    { fromId: ids[0], toId: ids[2] },
  );
  await sleep(420);
  const after = await tabNames();
  return {
    ok: moved && after.join('|') !== before.join('|'),
    detail: `${before.join('|')}  ->  ${after.join('|')}`,
  };
});

await test('中键关闭标签', async () => {
  const before = (await tabNames()).length;
  await page.locator('.tab').first().click({ button: 'middle' });
  await sleep(550);
  const after = (await tabNames()).length;
  return { ok: after === before - 1, detail: `${before} -> ${after}` };
});

await test('右键标签弹出上下文菜单', async () => {
  await page.locator('.tab').first().click({ button: 'right' });
  await sleep(450);
  const items = await page.locator('.context-menu .dropdown__item-label').allInnerTexts();
  await page.keyboard.press('Escape');
  await sleep(250);
  return {
    ok: items.length >= 4 && items.includes('关闭'),
    detail: `菜单项=[${items.join(', ')}]`,
  };
});

/* ================================================================== 编辑 */

group('编辑');

await test('键盘输入文本生效', async () => {
  await page.keyboard.press('Control+n');
  await sleep(380);
  await page.locator('.cm-content').click();
  await page.keyboard.type('hello quillpad');
  await sleep(280);
  const t = await docText();
  return { ok: t.includes('hello quillpad'), detail: t.slice(0, 40) };
});

await test('Ctrl+Z 撤销 / Ctrl+Shift+Z 重做', async () => {
  await setDoc('UNDO_PROBE');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await sleep(280);
  const afterUndo = await docText();
  await page.keyboard.press('Control+Shift+z');
  await sleep(280);
  const afterRedo = await docText();
  return {
    ok: afterUndo !== 'UNDO_PROBE' && afterRedo === 'UNDO_PROBE',
    detail: `undo=>${JSON.stringify(afterUndo.slice(0, 20))} redo=>${JSON.stringify(afterRedo.slice(0, 20))}`,
  };
});

await test('Ctrl+D 复制当前行', async () => {
  await setDoc('dup-line');
  await gotoLine(1);
  await page.keyboard.press('Control+d');
  await sleep(320);
  const t = await docText();
  return {
    ok: t.split('\n').filter((l) => l === 'dup-line').length === 2,
    detail: JSON.stringify(t),
  };
});

await test('Ctrl+Shift+K 删除当前行', async () => {
  await setDoc('keep-me\ndelete-me\nkeep-me2');
  await gotoLine(2);
  await page.keyboard.press('Control+Shift+k');
  await sleep(320);
  const t = await docText();
  return {
    ok: !t.includes('delete-me') && t.includes('keep-me'),
    detail: JSON.stringify(t),
  };
});

await test('Alt+↑ / Alt+↓ 上下移动行', async () => {
  await setDoc('L1\nL2\nL3');
  await gotoLine(3);
  await page.keyboard.press('Alt+ArrowUp');
  await sleep(280);
  const up = await docText();
  await page.keyboard.press('Alt+ArrowDown');
  await sleep(280);
  const down = await docText();
  return {
    ok: up === 'L1\nL3\nL2' && down === 'L1\nL2\nL3',
    detail: `up=${JSON.stringify(up)} down=${JSON.stringify(down)}`,
  };
});

await test('Ctrl+/ 在代码文件中切换行注释', async () => {
  await openVirtualFile('comment-probe.js', 'const a = 1;\nconst b = 2;');
  await sleep(500);
  await gotoLine(1);
  await page.keyboard.press('Control+/');
  await sleep(400);
  const commented = await docText();
  await page.keyboard.press('Control+/');
  await sleep(400);
  const uncommented = await docText();
  return {
    ok: /\/\/\s*const a = 1;/.test(commented) && uncommented === 'const a = 1;\nconst b = 2;',
    detail: `注释后=${JSON.stringify(commented.split('\n')[0])} 还原后=${JSON.stringify(uncommented.split('\n')[0])}`,
  };
});

await test('Ctrl+/ 在纯文本文件中给出反馈（不静默失败）', async () => {
  await openVirtualFile('comment-probe.txt', 'plain text line');
  await sleep(500);
  await gotoLine(1);
  const before = consoleErrors.length;
  await page.keyboard.press('Control+/');
  await sleep(600);
  const t = await docText();
  const toastTxt = await page
    .locator('.toast')
    .last()
    .innerText()
    .catch(() => '');
  const err = consoleErrors.slice(before);
  return {
    ok: t === 'plain text line' && (toastTxt.length > 0 || err.length > 0),
    detail: `正文未变=${t === 'plain text line'}；提示="${toastTxt.trim()}"；error=${err.length}`,
  };
});

await test('转换为大写 / 小写（命令面板）', async () => {
  await setDoc('Hello World');
  await page.keyboard.press('Control+a');
  await runPalette('大写', '转换为大写');
  await sleep(320);
  const up = await docText();
  await page.keyboard.press('Control+a');
  await runPalette('小写', '转换为小写');
  await sleep(320);
  const low = await docText();
  return {
    ok: up === 'HELLO WORLD' && low === 'hello world',
    detail: `大写=${JSON.stringify(up)} 小写=${JSON.stringify(low)}`,
  };
});

await test('排序行（选中多行时升序 / 降序生效）', async () => {
  await setDoc('banana\napple\ncherry');
  await selectLines(1, 3);
  await runPalette('排序行', '排序行（升序）');
  await sleep(350);
  const asc = await docText();
  await selectLines(1, 3);
  await runPalette('排序行', '排序行（降序）');
  await sleep(350);
  const desc = await docText();
  return {
    ok: asc === 'apple\nbanana\ncherry' && desc === 'cherry\nbanana\napple',
    detail: `asc=${JSON.stringify(asc)} desc=${JSON.stringify(desc)}`,
  };
});

await test('排序行在「仅光标、无选区」时对全文排序', async () => {
  await setDoc('banana\napple\ncherry');
  await gotoLine(1);
  await runPalette('排序行', '排序行（升序）');
  await sleep(450);
  const t = await docText();
  return {
    ok: t === 'apple\nbanana\ncherry',
    detail: `无选区时结果=${JSON.stringify(t)}（期望对全文排序）`,
  };
});

await test('去除重复行', async () => {
  await setDoc('x\ny\nx\nz\ny');
  await selectLines(1, 5);
  await runPalette('重复行', '去除重复行');
  await sleep(350);
  const t = await docText();
  return { ok: t === 'x\ny\nz', detail: JSON.stringify(t) };
});

await test('去除行尾空白', async () => {
  await setDoc('a   \nb\t\nc');
  await runPalette('行尾空白', '去除行尾空白');
  await sleep(320);
  const t = await docText();
  return { ok: t === 'a\nb\nc', detail: JSON.stringify(t) };
});

await test('缩进转空格 / 缩进转制表符', async () => {
  await setDoc('\tindented\nsecond');
  await runPalette('缩进转空格', '缩进转空格');
  await sleep(380);
  const sp = await docText();
  await runPalette('缩进转制表符', '缩进转制表符');
  await sleep(380);
  const tb = await docText();
  return {
    ok: sp === '  indented\nsecond' && tb === '\tindented\nsecond',
    detail: `spaces=${JSON.stringify(sp)} tabs=${JSON.stringify(tb)}`,
  };
});

await test('Tab 键插入缩进（indentWithTab）', async () => {
  await setDoc('');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Tab');
  await sleep(250);
  const t = await docText();
  return { ok: t === '  ' || t === '\t', detail: JSON.stringify(t) };
});

await test('复制 / 粘贴（剪贴板通路）', async () => {
  await setDoc('CLIP_ME');
  await page.keyboard.press('Control+a');
  await sleep(200);
  await runPalette('复制', '复制');
  await sleep(450);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  await setDoc('');
  await page.keyboard.press('Control+v');
  await sleep(400);
  const t = await docText();
  return {
    ok: clip === 'CLIP_ME' && t.includes('CLIP_ME'),
    detail: `剪贴板=${JSON.stringify(clip.slice(0, 20))} 粘贴结果=${JSON.stringify(t.slice(0, 20))}`,
  };
});

/* ============================================================ 查找 / 替换 */

group('查找与替换');

await test('Ctrl+F 打开查找面板且样式与整体一致', async () => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+f');
  await sleep(600);
  const vis = await page.locator('.qp-search').isVisible().catch(() => false);
  const st = await page.evaluate(() => {
    const field = document.querySelector('.qp-search__field');
    const input = document.querySelector('.qp-search__input');
    const panel = document.querySelector('.qp-search');
    if (!field || !input || !panel) return null;
    const cf = getComputedStyle(field);
    const ci = getComputedStyle(input);
    const cp = getComputedStyle(panel);
    return {
      fieldBg: cf.backgroundColor,
      fieldBorder: cf.borderColor,
      fieldRadius: cf.borderRadius,
      fieldH: cf.height,
      inputFont: ci.fontFamily.slice(0, 30),
      panelBg: cp.backgroundColor,
      panelFont: cp.fontFamily.slice(0, 30),
      bodyFont: getComputedStyle(document.body).fontFamily.slice(0, 30),
    };
  });
  return {
    ok: vis && !!st && st.fieldBg !== 'rgba(0, 0, 0, 0)' && st.panelFont === st.bodyFont,
    detail: `visible=${vis} ${JSON.stringify(st)}`,
  };
});

await test('选中文本后 Ctrl+F 不会触发 CodeMirror 插件崩溃（回归）', async () => {
  await page.keyboard.press('Escape');
  await sleep(350);
  await setDoc('SHORT_SELECTION_PROBE');
  await page.keyboard.press('Control+a');
  await sleep(200);
  const before = consoleErrors.length;
  await page.keyboard.press('Control+f');
  await sleep(900);
  const errs = consoleErrors.slice(before);
  const val = await page.locator('.qp-search [data-role="search"]').inputValue().catch(() => '');
  const count = await page.locator('.qp-search [data-role="count"]').innerText().catch(() => '');
  return {
    ok: errs.length === 0,
    detail: `预填="${val}" 计数=${count} error=${errs.length ? errs[0].split('\n')[0] : '无'}`,
  };
});

await test('查找面板能统计命中数并高亮', async () => {
  await page.keyboard.press('Escape');
  await sleep(300);
  await setDoc('alpha\nbeta\nalpha\ngamma');
  await page.keyboard.press('Control+f');
  await sleep(450);
  await page.locator('.qp-search [data-role="search"]').fill('alpha');
  await sleep(600);
  const count = await page.locator('.qp-search [data-role="count"]').innerText();
  const marks = await page.locator('.cm-searchMatch').count();
  const total = Number((count.match(/\/\s*(\d+)/) || [])[1] || 0);
  return { ok: total === 2 && marks >= 1, detail: `count="${count}" 高亮节点=${marks}` };
});

await test('Ctrl+H 打开替换面板（替换行可见可输入）', async () => {
  await page.keyboard.press('Escape');
  await sleep(350);
  await page.keyboard.press('Control+h');
  await sleep(700);
  const rowVisible = await page.locator('.qp-search [data-row="replace"]').isVisible().catch(() => false);
  const inputVisible = await page.locator('.qp-search [data-role="replace"]').isVisible().catch(() => false);
  return { ok: rowVisible && inputVisible, detail: `替换行=${rowVisible} 输入框=${inputVisible}` };
});

await test('菜单「搜索 → 替换…」同样能展开替换行', async () => {
  await page.keyboard.press('Escape');
  await sleep(350);
  await page.locator('#menubar .menubar__item').nth(2).click();
  await sleep(500);
  const items = await page.locator('.dropdown__item-label').allInnerTexts();
  const idx = items.findIndex((t) => /替换/.test(t));
  if (idx < 0) {
    await page.keyboard.press('Escape');
    return { ok: false, detail: '菜单中没有「替换…」项' };
  }
  await page.locator('.dropdown__item').nth(idx).click();
  await sleep(700);
  const rowVisible = await page.locator('.qp-search [data-row="replace"]').isVisible().catch(() => false);
  return { ok: rowVisible, detail: `替换行可见=${rowVisible}` };
});

await test('「全部替换」生效', async () => {
  await setDoc('foo foo foo');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('foo');
  await sleep(350);
  await page.locator('.qp-search [data-role="replace"]').fill('bar');
  await sleep(350);
  await page.locator('.qp-search [data-act="replace-all"]').click();
  await sleep(700);
  const t = await docText();
  return { ok: t === 'bar bar bar', detail: JSON.stringify(t) };
});

await test('正则模式生效（.* 切换 + 捕获组替换）', async () => {
  await setDoc('a1 b22 c333');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-toggle="regexp"]').click();
  await sleep(300);
  await page.locator('.qp-search [data-role="search"]').fill('([a-z])(\\d+)');
  await sleep(600);
  const count = await page.locator('.qp-search [data-role="count"]').innerText();
  const total = Number((count.match(/\/\s*(\d+)/) || [])[1] || 0);
  await page.locator('.qp-search [data-role="replace"]').fill('$2-$1');
  await sleep(300);
  await page.locator('.qp-search [data-act="replace-all"]').click();
  await sleep(700);
  const t = await docText();
  return {
    ok: total === 3 && t === '1-a 22-b 333-c',
    detail: `count="${count}"（总数=${total}） 结果=${JSON.stringify(t)}`,
  };
});

await test('「区分大小写」开关真正改变搜索结果', async () => {
  await setDoc('cat Cat CAT');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('cat');
  await sleep(600);
  const c0 = await page.locator('.qp-search [data-role="count"]').innerText();
  const total0 = Number((c0.match(/\/\s*(\d+)/) || [])[1] || 0);
  await page.locator('.qp-search [data-toggle="case"]').click();
  await sleep(700);
  const c1 = await page.locator('.qp-search [data-role="count"]').innerText();
  const total1 = Number((c1.match(/\/\s*(\d+)/) || [])[1] || 0);
  const btnOn = await page.locator('.qp-search [data-toggle="case"]').evaluate((el) => el.classList.contains('is-on'));
  return {
    ok: total0 === 3 && total1 === 1,
    detail:
      total1 === 1
        ? `不区分=${total0} 区分=${total1}`
        : `不区分命中=${total0}，点「Aa」后按钮点亮(${btnOn})但命中数仍为 ${total1} —— 开关无效`,
  };
});

await test('「全词匹配」开关真正改变搜索结果', async () => {
  await setDoc('cat cats cat2');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('cat');
  await sleep(600);
  const c0 = await page.locator('.qp-search [data-role="count"]').innerText();
  const total0 = Number((c0.match(/\/\s*(\d+)/) || [])[1] || 0);
  await page.locator('.qp-search [data-toggle="word"]').click();
  await sleep(700);
  const c1 = await page.locator('.qp-search [data-role="count"]').innerText();
  const total1 = Number((c1.match(/\/\s*(\d+)/) || [])[1] || 0);
  return {
    ok: total0 === 3 && total1 === 1,
    detail:
      total1 === 1
        ? `不区分词=${total0} 全词=${total1}`
        : `点「W」后命中数仍为 ${total1}（应为 1）—— 开关无效`,
  };
});

await test('查找面板标注的 Alt+C / Alt+W / Alt+R 快捷键可用', async () => {
  await setDoc('cat Cat');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('cat');
  await sleep(500);
  const before = await page.locator('.qp-search [data-role="count"]').innerText();
  await page.locator('.qp-search [data-role="search"]').press('Alt+c');
  await sleep(700);
  const after = await page.locator('.qp-search [data-role="count"]').innerText();
  const on = await page.locator('.qp-search [data-toggle="case"]').evaluate((el) => el.classList.contains('is-on'));
  return {
    ok: before !== after,
    detail:
      before !== after
        ? `Alt+C 生效：${before} -> ${after}`
        : `按 Alt+C 后计数仍为 ${after}，按钮点亮=${on} —— tooltip 承诺的快捷键未实现`,
  };
});


await test('查找面板「下一个 / 上一个」可导航', async () => {
  await setDoc('needle one\nneedle two\nneedle three');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('needle');
  await sleep(550);
  const c1 = await page.locator('.qp-search [data-role="count"]').innerText();
  await page.locator('.qp-search [data-act="next"]').click();
  await sleep(400);
  const c2 = await page.locator('.qp-search [data-role="count"]').innerText();
  await page.locator('.qp-search [data-act="prev"]').click();
  await sleep(400);
  const c3 = await page.locator('.qp-search [data-role="count"]').innerText();
  return { ok: c1 !== c2 && c3 === c1, detail: `初始=${c1} next=${c2} prev=${c3}` };
});

await test('在文件中查找 Ctrl+Shift+F 列出结果并可点击跳转', async () => {
  await page.keyboard.press('Escape');
  await sleep(300);
  await openVirtualFile('findme-a.txt', 'UNIQUE_TOKEN_ONE\nnothing');
  await openVirtualFile('findme-b.txt', 'nothing\nUNIQUE_TOKEN_TWO');
  await sleep(450);
  await page.keyboard.press('Control+Shift+f');
  await sleep(600);
  const panelVisible = await page.locator('#find-files').isVisible().catch(() => false);
  await page.locator('#find-files [data-role="search"]').fill('UNIQUE_TOKEN');
  await sleep(350);
  await page.keyboard.press('Enter');
  await sleep(900);
  const hits = await page.locator('.ff-hit').count();
  const files = await page.locator('.ff-file').count();
  const summary = await page.locator('#find-files [data-role="summary"]').innerText();
  let jumped = false;
  if (hits > 0) {
    await page.locator('.ff-hit').first().click();
    await sleep(700);
    const ln = await cursorLine();
    const t = await docText();
    jumped = /UNIQUE_TOKEN/.test(t) && ln >= 1;
  }
  return {
    ok: panelVisible && hits >= 2 && files >= 2 && jumped,
    detail: `panel=${panelVisible} 命中=${hits} 文件=${files} 摘要="${summary}" 跳转=${jumped}`,
  };
});

/* ================================================================ 转到行 */

/* ============================== 代码审查线索的回归用例 ============================== */

group('代码审查回归');

await test('「在文件中查找」面板的「区分大小写」开关真正生效', async () => {
  // 素材必须能区分大小写：每行要么只有大写 Cat，要么只有小写 cat，
  // 否则「区分大小写」前后命中数相同，用例就失去鉴别力。
  await openVirtualFile('case-a.txt', 'Cat\ncat\nCAT');
  await openVirtualFile('case-b.txt', 'Cat\ncat');
  await sleep(400);
  await page.keyboard.press('Control+Shift+f');
  await sleep(700);
  const search = page.locator('#find-files [data-role="search"]');
  await search.fill('cat');
  await sleep(1100);
  const t0 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#find-files [data-hit]')];
    return rows.length;
  });
  await page.locator('#find-files [data-toggle="case"]').click();
  await sleep(1100);
  const t1 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#find-files [data-hit]')];
    return rows.length;
  });
  const on = await page
    .locator('#find-files [data-toggle="case"]')
    .evaluate((el) => el.classList.contains('is-on'));
  await page.keyboard.press('Escape');
  await sleep(300);
  return {
    ok: t0 === 5 && t1 === 2,
    detail:
      t1 === 2 && t0 === 5
        ? `不区分命中 ${t0} 处 → 区分后 ${t1} 处（2 个文件）`
        : `不区分命中=${t0}（期望 5），点「Aa」后按钮点亮(${on})但命中=${t1}（期望 2）`,
  };
});

await test('「在文件中查找」面板也提供「全词匹配」开关且真实生效', async () => {
  // 能力对齐：编辑器面板有 case/word/regexp 三个开关，文件面板也必须有
  // 注意：文件查找面板默认扫描「所有打开的标签」，所以关键词必须用
  // 独占词（其它测试文件里不会出现），否则计数会被前面用例的素材污染。
  await openVirtualFile('zebra.txt', 'zebra\nzebras\nzebra2');
  await sleep(400);
  await page.keyboard.press('Control+Shift+f');
  await sleep(700);
  const hasBtn = await page.locator('#find-files [data-toggle="word"]').count();
  if (!hasBtn) {
    await page.keyboard.press('Escape');
    await sleep(200);
    return { ok: false, detail: '「在文件中查找」面板缺少「全词匹配」开关（与编辑器面板能力不对齐）' };
  }
  await page.locator('#find-files [data-role="search"]').fill('zebra');
  await sleep(1100);
  const t0 = await page.evaluate(() => document.querySelectorAll('#find-files [data-hit]').length);
  await page.locator('#find-files [data-toggle="word"]').click();
  await sleep(1100);
  const t1 = await page.evaluate(() => document.querySelectorAll('#find-files [data-hit]').length);
  await page.keyboard.press('Escape');
  await sleep(300);
  return {
    ok: t0 === 3 && t1 === 1,
    detail:
      t1 === 1 && t0 === 3
        ? `不区分词命中 ${t0} 处 → 全词后 ${t1} 处`
        : `不区分词命中=${t0}（期望 3），点「W」后=${t1}（期望 1）`,
  };
});

await test('「在文件中查找」按出现次数统计命中（同一行多次应分别计数）', async () => {
  // 回归：原实现用 regex.test(line) 逐行判断，统计的是「命中行数」，
  // 同一行出现 3 次也只算 1 处，开关效果在计数上观察不到。
  await openVirtualFile('kiwi.txt', 'kiwi kiwi kiwi');
  await sleep(400);
  await page.keyboard.press('Control+Shift+f');
  await sleep(700);
  await page.locator('#find-files [data-role="search"]').fill('kiwi');
  await sleep(1100);
  const hits = await page.evaluate(() => document.querySelectorAll('#find-files [data-hit]').length);
  const summary = await page.evaluate(
    () => document.querySelector('#find-files [data-role="summary"]')?.textContent,
  );
  await page.keyboard.press('Escape');
  await sleep(300);
  return {
    ok: hits === 3,
    detail:
      hits === 3
        ? `同一行 3 处出现计为 ${hits} 处（summary：${summary}）`
        : `同一行 3 处出现只计为 ${hits} 处（期望 3，summary：${summary}）`,
  };
});

await test('「在文件中查找」点击命中跳转到具体列（而非行首）', async () => {
  await openVirtualFile('mango.txt', 'prefix mango suffix');
  await sleep(400);
  await page.keyboard.press('Control+Shift+f');
  await sleep(700);
  await page.locator('#find-files [data-role="search"]').fill('mango');
  await sleep(1100);
  await page.locator('#find-files [data-hit]').first().click();
  await sleep(700);
  const cur = await page.evaluate(() => {
    const st = window.quillpad.editor.state;
    const s = st.selection.main;
    const line = st.doc.lineAt(s.head);
    return {
      from: s.from,
      to: s.to,
      head: s.head,
      line: line.number,
      col: line.number === 1 ? s.from + 1 : null,
      selected: st.sliceDoc(s.from, s.to),
      doc: st.doc.toString(),
    };
  });
  // 点击命中后应「选中该处命中」（编辑器通用行为）：
  // 选区 from = 命中起点偏移，to = 命中终点偏移，而不是把光标放到行首。
  const expectedFrom = 'prefix mango suffix'.indexOf('mango');
  const expectedTo = expectedFrom + 'mango'.length;
  await page.keyboard.press('Escape');
  await sleep(200);
  const ok =
    cur.from === expectedFrom && cur.to === expectedTo && cur.doc === 'prefix mango suffix';
  return {
    ok,
    detail: ok
      ? `第 ${cur.line} 行第 ${cur.col} 列起选中「${cur.selected}」（选区 ${cur.from}..${cur.to}）`
      : `选区 ${cur.from}..${cur.to}（期望 ${expectedFrom}..${expectedTo}），选中文本=${JSON.stringify(cur.selected)}，当前文档=${JSON.stringify(cur.doc.slice(0, 40))}`,
  };
});

await test('命令面板对「当前不可用」的命令给出禁用标识或执行提示', async () => {
  // 切到纯文本标签，使「Markdown 预览」处于 enabled() === false 的状态
  await page.evaluate(() => window.quillpad.newFile());
  await sleep(600);
  const r = await page.evaluate(async () => {
    const app = window.quillpad;
    const before = app.state.previewVisible;
    app.palette.open();
    await new Promise((r) => setTimeout(r, 250));
    const input = document.querySelector('.palette__input');
    input.value = 'Markdown 预览';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const item = [...document.querySelectorAll('.palette__item')].find(
      (n) => n.querySelector('.palette__item-title')?.textContent === 'Markdown 预览',
    );
    const marked = !!item && (item.getAttribute('aria-disabled') === 'true' || /disabled|is-disabled/.test(item.className));
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const toasts = [...document.querySelectorAll('.toast')].map((n) => n.textContent.trim());
    // 不可用的命令会「toast 提示并保持面板打开」，这里主动关闭，
    // 否则遮罩会拦截后续用例的点击。
    const stillOpen = !!document.querySelector('.palette-backdrop');
    if (app.palette && typeof app.palette.close === 'function') app.palette.close();
    else {
      const pi = document.querySelector('.palette__input');
      pi?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 300));
    return {
      found: !!item,
      marked,
      changed: app.state.previewVisible !== before,
      toasts,
      stillOpen,
      closedNow: !document.querySelector('.palette-backdrop'),
    };
  });
  return {
    ok: r.found && (r.marked || r.toasts.length > 0),
    detail: r.marked
      ? '命令面板已对不可用命令做禁用标识'
      : `面板未标注禁用态(aria-disabled=${r.marked})，执行后无效果也无提示（toast=${r.toasts.length}）—— 静默失败`,
  };
});

await test('正则模式下输入非法正则时给出错误提示', async () => {
  await setDoc('value = a(b;');
  await page.keyboard.press('Control+h');
  await sleep(500);
  await page.locator('.qp-search [data-role="search"]').fill('(b');
  await sleep(600);
  const literal = await page.locator('.qp-search [data-role="count"]').innerText();
  await page.locator('.qp-search [data-toggle="regexp"]').click();
  await sleep(700);
  const regex = await page.locator('.qp-search [data-role="count"]').innerText();
  const hint = await page.evaluate(() => {
    const panel = document.querySelector('.qp-search')?.textContent || '';
    const toasts = [...document.querySelectorAll('.toast')].map((n) => n.textContent.trim());
    return { panel, toasts };
  });
  const hasError =
    /无效|错误|不合法|invalid/i.test(hint.panel) ||
    hint.toasts.some((t) => /正则|无效|错误|invalid/i.test(t));
  await page.keyboard.press('Escape');
  await sleep(200);
  return {
    ok: hasError,
    detail: hasError
      ? '非法正则已给出提示'
      : `字面量模式命中=${literal}，勾选正则后显示「${regex}」，面板无任何错误提示 —— 用户无法区分「正则写错」与「确实没匹配」`,
  };
});

group('转到行 / 命令面板');

await test('Ctrl+G 转到行对话框可用并跳转', async () => {
  await setDoc('l1\nl2\nl3\nl4\nl5');
  await page.keyboard.press('Control+g');
  await sleep(600);
  const modal = await page.locator('.modal').isVisible().catch(() => false);
  const title = await page.locator('.modal__title').innerText().catch(() => '');
  await page.locator('#modal-input').fill('4');
  await page.locator('.modal .btn.is-primary').click();
  await sleep(550);
  const ln = await cursorLine();
  return { ok: modal && /转到行/.test(title) && ln === 4, detail: `modal=${modal} 行=${ln}` };
});

await test('命令面板 Ctrl+Shift+P 可搜索并执行命令', async () => {
  await setDoc('z\ny\nx');
  await selectLines(1, 3);
  await page.keyboard.press('Control+Shift+P');
  await sleep(450);
  const open = await page.locator('.palette-backdrop').count();
  await page.locator('.palette__input').fill('排序');
  await sleep(450);
  const count = await page.locator('.palette__item').count();
  const titles = await page.locator('.palette__item-title').allInnerTexts();
  await page.locator('.palette__item').first().click();
  await sleep(450);
  const t = await docText();
  return {
    ok: open > 0 && count > 0 && t === 'x\ny\nz',
    detail: `打开=${open} 命中=${count} [${titles.join(',')}] 执行后=${JSON.stringify(t)}`,
  };
});

await test('命令面板列出全部命令', async () => {
  await page.keyboard.press('Control+Shift+P');
  await sleep(450);
  const total = await page.locator('.palette__item').count();
  const countText = await page.locator('.palette__count').innerText();
  await page.keyboard.press('Escape');
  await sleep(300);
  return { ok: total > 40, detail: `${countText}（DOM ${total} 项）` };
});

await test('命令注册表存在标签切换（Ctrl+Tab）命令', async () => {
  const cmds = await page.evaluate(() => {
    const out = [];
    // 通过命令面板拿到全部命令（hidden=false），再检查有没有 Tab 相关快捷键
    return out;
  });
  void cmds;
  await page.keyboard.press('Control+Shift+P');
  await sleep(400);
  const keys = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.palette__item-keys')).map((n) => n.textContent.trim()),
  );
  await page.keyboard.press('Escape');
  await sleep(250);
  const hasTab = keys.some((k) => /Tab/i.test(k));
  return {
    ok: hasTab,
    detail: hasTab ? '存在 Tab 快捷键' : `全部 ${keys.length} 条命令里没有任何 Tab 快捷键`,
  };
});

/* ============================================================ 语言识别 */

group('语言识别');

const LANG_CASES = [
  ['app.js', 'JavaScript'],
  ['app.ts', 'TypeScript'],
  ['comp.jsx', 'JavaScript (JSX)'],
  ['comp.tsx', 'TypeScript (TSX)'],
  ['index.html', 'HTML'],
  ['style.css', 'CSS'],
  ['style.scss', 'SCSS'],
  ['style.less', 'Less'],
  ['data.json', 'JSON'],
  ['readme.md', 'Markdown'],
  ['main.py', 'Python'],
  ['Main.java', 'Java'],
  ['a.c', 'C'],
  ['a.cpp', 'C++'],
  ['a.cs', 'C#'],
  ['a.go', 'Go'],
  ['a.rs', 'Rust'],
  ['a.php', 'PHP'],
  ['a.rb', 'Ruby'],
  ['a.sh', 'Shell'],
  ['a.bat', 'Batch'],
  ['a.ps1', 'PowerShell'],
  ['q.sql', 'SQL'],
  ['a.xml', 'XML'],
  ['c.yaml', 'YAML'],
  ['c.yml', 'YAML'],
  ['c.toml', 'TOML'],
  ['a.ini', 'INI / Properties'],
  ['a.lua', 'Lua'],
  ['a.pl', 'Perl'],
  ['a.r', 'R'],
  ['a.swift', 'Swift'],
  ['a.vue', 'Vue'],
  ['Dockerfile', 'Dockerfile'],
  ['a.diff', 'Diff / Patch'],
  ['a.txt', '纯文本'],
  ['a.tex', 'LaTeX'],
];

await test(`语言识别（${LANG_CASES.length} 种扩展名 → 状态栏语言）`, async () => {
  const wrong = [];
  for (const [file, expect] of LANG_CASES) {
    await openVirtualFile(file, 'x = 1');
    const lang = await statusCell('lang');
    if (lang !== expect) wrong.push(`${file}: 期望「${expect}」实际「${lang}」`);
    await page.keyboard.press('Control+w');
    await sleep(220);
  }
  return {
    ok: wrong.length === 0,
    detail: wrong.length ? wrong.join('; ') : `${LANG_CASES.length}/${LANG_CASES.length} 全部正确`,
  };
});

await test('JavaScript 文件真实产生语法高亮 token', async () => {
  await openVirtualFile('highlight-probe.js', 'const x = 42; // comment\nfunction f() { return "s"; }');
  await sleep(900);
  const tokens = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.cm-content span'));
    return {
      n: spans.length,
      colors: Array.from(new Set(spans.map((s) => getComputedStyle(s).color))),
    };
  });
  return {
    ok: tokens.n > 0 && tokens.colors.length >= 2,
    detail: `token 节点=${tokens.n} 不同颜色数=${tokens.colors.length}`,
  };
});

/* ================================================================== 主题 */

group('主题');

const THEME_EXPECT = [
  ['aurora', 'Aurora Dark'],
  ['ivory', 'Ivory Light'],
  ['nord', 'Nord'],
  ['solarized', 'Solarized Light'],
];

await test('切换 4 套主题：data-theme 正确 + 编辑区语法配色同步变化', async () => {
  const detail = [];
  let ok = true;
  const seen = [];
  for (const [id] of THEME_EXPECT) {
    await page.evaluate((t) => window.quillpad.setTheme(t), id);
    await sleep(750);
    const info = await page.evaluate(() => {
      const ed = document.querySelector('.cm-editor');
      const spans = Array.from(document.querySelectorAll('.cm-content span'));
      return {
        theme: document.documentElement.dataset.theme,
        editorBg: getComputedStyle(ed).backgroundColor,
        editorFg: getComputedStyle(ed).color,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        tokenColors: Array.from(new Set(spans.map((s) => getComputedStyle(s).color))).sort(),
      };
    });
    seen.push({ id, ...info });
    detail.push(
      `${id}: data-theme=${info.theme} 编辑区底色=${info.editorBg} 语法色=${info.tokenColors.length} 种`,
    );
    if (info.theme !== id) ok = false;
  }
  if (new Set(seen.map((s) => s.editorBg)).size !== THEME_EXPECT.length) ok = false;
  if (new Set(seen.map((s) => s.tokenColors.join('|'))).size !== THEME_EXPECT.length) ok = false;
  if (new Set(seen.map((s) => s.bodyBg)).size !== THEME_EXPECT.length) ok = false;
  return { ok, detail: detail.join(' || ') };
});

await test('主题菜单可列出全部 4 套主题', async () => {
  await page.locator('#menubar .menubar__item').nth(5).click();
  await sleep(500);
  const items = await page.locator('.dropdown__item-label').allInnerTexts();
  await page.keyboard.press('Escape');
  await sleep(280);
  const want = THEME_EXPECT.map((x) => x[1]);
  return {
    ok: want.every((w) => items.includes(w)),
    detail: `菜单项=[${items.join(',')}]`,
  };
});

await test('刷新后主题保持（data-theme 持久化）', async () => {
  await page.evaluate(() => window.quillpad.setTheme('nord'));
  await sleep(600);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.cm-editor');
  await sleep(1000);
  const t = await page.evaluate(() => document.documentElement.dataset.theme);
  return { ok: t === 'nord', detail: `刷新后 data-theme=${t}` };
});

/* ================================================================ 状态栏 */

group('状态栏');

await test('状态栏：行/列/字符/词数/语言/缩进/EOL/编码/保存状态 实时正确', async () => {
  await setDoc('const abc = "def";\nconst ghi = "jkl";');
  await gotoLine(2);
  await page.keyboard.press('End');
  await sleep(450);
  const st = {
    cursor: await statusCell('cursor'),
    lines: await statusCell('lines'),
    chars: await statusCell('chars'),
    words: await statusCell('words'),
    lang: await statusCell('lang'),
    indent: await statusCell('indent'),
    eol: await statusCell('eol'),
    encoding: await statusCell('encoding'),
    saved: await statusCell('saved'),
  };
  const t = await docText();
  const ok =
    /行\s*2/.test(st.cursor) &&
    st.lines === '2 行' &&
    st.chars.replace(/\D/g, '') === String(t.length) &&
    /\d/.test(st.words) &&
    st.lang.length > 0 &&
    /空格|Tab/.test(st.indent) &&
    ['LF', 'CRLF', 'CR'].includes(st.eol) &&
    st.encoding === 'UTF-8' &&
    /未保存|已保存|自动保存/.test(st.saved);
  return { ok, detail: JSON.stringify(st) + ` 实际字符数=${t.length}` };
});

await test('状态栏词数按中英混排统计合理（中文按字计）', async () => {
  await setDoc('hello world 你好世界');
  await sleep(450);
  const words = await statusCell('words');
  // countWords：CJK 按字计 + 拉丁按词计 → 4 + 2 = 6
  return { ok: /6/.test(words), detail: `「hello world 你好世界」→ ${words}（预期 6 = 4 汉字 + 2 英文词）` };
});

await test('状态栏换行符可点击切换 LF ↔ CRLF', async () => {
  const before = await statusCell('eol');
  await page.locator('#statusbar [data-cell="eol"]').click();
  await sleep(500);
  const after = await statusCell('eol');
  await page.locator('#statusbar [data-cell="eol"]').click();
  await sleep(500);
  const back = await statusCell('eol');
  return { ok: before !== after && back === before, detail: `${before} -> ${after} -> ${back}` };
});

await test('状态栏缩进可点击循环', async () => {
  const before = await statusCell('indent');
  await page.locator('#statusbar [data-cell="indent"]').click();
  await sleep(500);
  const after = await statusCell('indent');
  return { ok: before !== after, detail: `${before} -> ${after}` };
});

await test('状态栏语言下拉可切换语言', async () => {
  await page.locator('#statusbar [data-cell="lang"]').click();
  await sleep(550);
  const items = await page.locator('.dropdown__item-label').allInnerTexts();
  const has = items.includes('Python') && items.includes('Markdown') && items.length >= 40;
  await page.locator('.dropdown__item-label', { hasText: 'Python' }).first().click();
  await sleep(700);
  const lang = await statusCell('lang');
  return { ok: has && lang === 'Python', detail: `下拉 ${items.length} 项，切换后=${lang}` };
});

/* ================================================================== 侧栏 */

group('侧栏');

await test('侧栏「大纲」面板列出符号（JS 文件）', async () => {
  await openVirtualFile('outline-probe.js', 'function alpha() {}\nclass Beta {}\nconst gamma = 1;\nfunction delta() {}');
  await sleep(700);
  await page.locator('#sidebar [data-side-tab="outline"]').click();
  await sleep(600);
  const items = await page.locator('.outline-item').count();
  const labels = await page.locator('.outline-item__label').allInnerTexts();
  return { ok: items >= 3, detail: `符号数=${items} [${labels.join(',')}]` };
});

await test('大纲支持 Markdown 标题', async () => {
  await openVirtualFile('outline-probe.md', '# 一级标题\n## 二级标题\n正文');
  await sleep(700);
  await page.locator('#sidebar [data-side-tab="outline"]').click();
  await sleep(600);
  const labels = await page.locator('.outline-item__label').allInnerTexts();
  return { ok: labels.includes('一级标题'), detail: `[${labels.join(',')}]` };
});

await test('点击大纲条目跳转到对应行', async () => {
  const items = await page.locator('.outline-item');
  const n = await items.count();
  if (!n) return { ok: false, detail: '无大纲条目' };
  const lastLine = await items.nth(n - 1).getAttribute('data-line');
  await items.nth(n - 1).click();
  await sleep(550);
  const ln = await cursorLine();
  return { ok: String(ln) === String(lastLine), detail: `目标行=${lastLine} 光标行=${ln}` };
});

await test('侧栏宽度可拖动调整并生效', async () => {
  const before = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
  const box = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(450);
  const after = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
  return { ok: Math.abs(after - before) > 20, detail: `${Math.round(before)}px -> ${Math.round(after)}px` };
});

await test('侧栏宽度有上下限（180–420）', async () => {
  let box = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(-2000, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const min = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
  // 拖动后 resizer 位置变了，必须重新取一次包围盒
  box = await page.locator('#sidebar-resizer').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3000, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const max = await page.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
  return {
    ok: min >= 175 && min <= 185 && max >= 415 && max <= 425,
    detail: `拖到最左=${Math.round(min)}px 拖到最右=${Math.round(max)}px（应夹在 180–420）`,
  };
});

await test('侧栏可折叠 / 展开', async () => {
  const before = await page.locator('#sidebar').isVisible();
  await page.locator('#toolbar [data-cmd="view.toggleSidebar"]').click();
  await sleep(500);
  const mid = await page.locator('#sidebar').isVisible();
  await page.locator('#toolbar [data-cmd="view.toggleSidebar"]').click();
  await sleep(500);
  const after = await page.locator('#sidebar').isVisible();
  return { ok: before && !mid && after, detail: `${before} -> ${mid} -> ${after}` };
});

await test('侧栏「文件」面板在未打开文件夹时给出引导', async () => {
  await page.locator('#sidebar [data-side-tab="files"]').click();
  await sleep(450);
  const txt = await page.locator('#sidebar-body').innerText();
  return {
    ok: /还没有打开文件夹|上次打开的文件夹/.test(txt),
    detail: txt.replace(/\s+/g, ' ').slice(0, 60),
  };
});

await test('文件树渲染 + 点击文件可打开（mock File System Access API）', async () => {
  await page.evaluate(() => {
    const mkFile = (name, content) => ({
      kind: 'file',
      name,
      async getFile() {
        const bytes = new TextEncoder().encode(content);
        return {
          name,
          size: bytes.length,
          lastModified: Date.now(),
          async arrayBuffer() {
            return bytes.buffer;
          },
        };
      },
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
    });
    const sub = {
      kind: 'directory',
      name: 'src',
      async *entries() {
        yield ['demo.js', mkFile('demo.js', 'const fromTree = 1;')];
      },
      async getFileHandle(n) {
        return mkFile(n, 'const fromTree = 1;');
      },
      async getDirectoryHandle() {
        throw new Error('not found');
      },
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
    };
    const root = {
      kind: 'directory',
      name: 'demo-folder',
      async *entries() {
        yield ['src', sub];
        yield ['readme.md', mkFile('readme.md', '# Tree\n')];
      },
      async getFileHandle(n) {
        return mkFile(n, 'from tree');
      },
      async getDirectoryHandle(n) {
        if (n === 'src') return sub;
        throw new Error('not found');
      },
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
    };
    window.showDirectoryPicker = async () => root;
    window.__mockTree = root;
  });
  await page.locator('#sidebar [data-side-tab="files"]').click();
  await sleep(400);
  await page.locator('#sidebar [data-side-act="open-folder"]').click();
  await sleep(1200);
  const nodes = await page.locator('#sidebar .tree-node__label').allInnerTexts();
  // 展开子目录
  const dirNode = page.locator('#sidebar [data-dir="src"]');
  if (await dirNode.count()) {
    await dirNode.click();
    await sleep(900);
  }
  const nodes2 = await page.locator('#sidebar .tree-node__label').allInnerTexts();
  const fileNode = page.locator('#sidebar [data-file="readme.md"]');
  let opened = false;
  if (await fileNode.count()) {
    await fileNode.click();
    await sleep(900);
    opened = (await tabNames()).some((n) => /readme\.md/.test(n));
  }
  return {
    ok: nodes.includes('src') && nodes.includes('readme.md') && nodes2.includes('demo.js') && opened,
    detail: `根节点=[${nodes.join(',')}] 展开后=[${nodes2.join(',')}] 点击文件已打开=${opened}`,
  };
});

/* ========================================================== Markdown 预览 */

group('Markdown 预览');

await test('.md 文件可开启右侧分栏预览并渲染', async () => {
  await openVirtualFile('preview-probe.md', '# 标题一\n\n正文 **加粗**\n\n- 列表项\n');
  await sleep(700);
  const hiddenBefore = await page.locator('#preview-pane').isHidden();
  await page.keyboard.press('Control+Shift+v');
  await sleep(800);
  const hiddenAfter = await page.locator('#preview-pane').isHidden();
  const html = await page.locator('#preview-pane').innerHTML();
  return {
    ok:
      hiddenBefore &&
      !hiddenAfter &&
      /<h1[^>]*>标题一<\/h1>/.test(html) &&
      /<strong>加粗<\/strong>/.test(html) &&
      /<li>列表项<\/li>/.test(html),
    detail: `初始隐藏=${hiddenBefore} 打开后隐藏=${hiddenAfter}`,
  };
});

await test('预览随输入实时刷新', async () => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## 动态标题');
  await sleep(800);
  const html = await page.locator('#preview-pane').innerHTML();
  return { ok: /动态标题/.test(html), detail: html.replace(/\s+/g, ' ').slice(0, 90) };
});

await test('非 Markdown 文件不显示预览入口', async () => {
  await openVirtualFile('not-md.txt', 'plain');
  await sleep(600);
  const disabled = await page.evaluate(() => {
    const cmd = window.quillpad && window.quillpad.state ? true : false;
    return cmd;
  });
  void disabled;
  const before = await page.locator('#preview-pane').isHidden();
  await page.keyboard.press('Control+Shift+v');
  await sleep(600);
  const after = await page.locator('#preview-pane').isHidden();
  return { ok: before && after, detail: `切换前隐藏=${before} 切换后隐藏=${after}` };
});

/* ================================================== 禅模式 / 字号 / 其它 */

group('视图与对话框');

await test('禅模式可进入 / 退出', async () => {
  await page.locator('#titlebar-actions [data-cmd="view.zen"]').click();
  await sleep(600);
  const on = await page.evaluate(() => document.getElementById('app').classList.contains('is-zen'));
  const menubarHidden = await page.locator('#menubar').isHidden();
  await page.keyboard.press('Escape');
  await sleep(600);
  const off = await page.evaluate(() => document.getElementById('app').classList.contains('is-zen'));
  return { ok: on && !off, detail: `进入=${on} 菜单栏隐藏=${menubarHidden} 退出后=${off}` };
});

await test('字号缩放生效并写入设置', async () => {
  const before = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-scroller')).fontSize);
  await page.locator('#toolbar [data-cmd="view.fontIncrease"]').click();
  await page.locator('#toolbar [data-cmd="view.fontIncrease"]').click();
  await sleep(550);
  const after = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-scroller')).fontSize);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('quillpad.settings.v1')).fontSize);
  return {
    ok: parseFloat(after) > parseFloat(before) && stored === parseFloat(after),
    detail: `${before} -> ${after}，localStorage=${stored}`,
  };
});

await test('自动换行开关生效', async () => {
  await page.locator('#toolbar [data-cmd="view.wordWrap"]').click();
  await sleep(550);
  const on = await page.evaluate(() =>
    document.querySelector('.cm-content').classList.contains('cm-lineWrapping'),
  );
  await page.locator('#toolbar [data-cmd="view.wordWrap"]').click();
  await sleep(500);
  const off = await page.evaluate(() =>
    document.querySelector('.cm-content').classList.contains('cm-lineWrapping'),
  );
  return { ok: on && !off, detail: `开启=${on} 关闭后=${off}` };
});

await test('F1 快捷键速查对话框打开且内容完整', async () => {
  await page.locator('.cm-content').click();
  await page.keyboard.press('F1');
  await sleep(700);
  const vis = await page.locator('.modal').isVisible().catch(() => false);
  const title = await page.locator('.modal__title').innerText().catch(() => '');
  const rows = await page.locator('.shortcut-row').count();
  const kbds = await page.locator('.shortcut-row kbd').count();
  await page.keyboard.press('Escape');
  await sleep(400);
  const closed = (await page.locator('.modal').count()) === 0;
  return {
    ok: vis && /快捷键速查/.test(title) && rows >= 20 && kbds >= 20 && closed,
    detail: `visible=${vis} 标题=${title} 行数=${rows} 按键=${kbds} Esc关闭=${closed}`,
  };
});

await test('关于对话框可打开', async () => {
  await runPalette('关于', '关于 QuillPad');
  await sleep(600);
  const vis = await page.locator('.modal').isVisible().catch(() => false);
  const txt = await page.locator('.modal__body').innerText().catch(() => '');
  await page.keyboard.press('Escape');
  await sleep(350);
  return {
    ok: vis && /QuillPad/.test(txt),
    detail: `visible=${vis} 内容="${txt.replace(/\s+/g, ' ').slice(0, 70)}"`,
  };
});

await test('自动保存开关可切换并给出提示', async () => {
  await runPalette('自动保存', '自动保存');
  await sleep(600);
  const toastTxt = await page.locator('.toast').last().innerText().catch(() => '');
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('quillpad.settings.v1')).autoSave);
  await runPalette('自动保存', '自动保存');
  await sleep(500);
  const state2 = await page.evaluate(() => JSON.parse(localStorage.getItem('quillpad.settings.v1')).autoSave);
  return {
    ok: state !== state2 && /自动保存/.test(toastTxt),
    detail: `on=${state} off=${state2} toast="${toastTxt.trim()}"`,
  };
});

/* ============================================================== 持久化 */

group('持久化');

await test('刷新后恢复标签内容 / 主题 / 字号 / 侧栏宽度', async () => {
  await page.evaluate(() => {
    window.quillpad.setTheme('solarized');
    window.quillpad.setFontSize(19);
    window.quillpad.createTab({ name: 'persist-probe.txt', content: 'PERSIST_MARKER_123' });
  });
  await sleep(500);
  await page.evaluate(() => {
    document.getElementById('sidebar').style.width = '300px';
    window.quillpad.state.sidebarWidth = 300;
    window.quillpad.persistSettings();
  });
  await sleep(1400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.cm-editor');
  await sleep(1600);
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    fontSize: getComputedStyle(document.querySelector('.cm-scroller')).fontSize,
    sidebarWidth: document.getElementById('sidebar').getBoundingClientRect().width,
    tabs: Array.from(document.querySelectorAll('.tab .tab__name')).map((n) => n.textContent),
  }));
  const hasMarker = (await tabNames()).some((n) => /persist-probe/.test(n));
  let content = '';
  if (hasMarker) {
    await page.locator('.tab', { hasText: 'persist-probe' }).click();
    await sleep(600);
    content = await docText();
  }
  return {
    ok:
      after.theme === 'solarized' &&
      parseFloat(after.fontSize) === 19 &&
      Math.round(after.sidebarWidth) === 300 &&
      hasMarker &&
      content.includes('PERSIST_MARKER_123'),
    detail: JSON.stringify(after) + ` 内容="${content.slice(0, 40)}"`,
  };
});

/* ============================================================== 健壮性 */

group('健壮性 / 布局');

for (const [w, h] of [[1280, 800], [1920, 1080]]) {
  await test(`${w}×${h} 视口下无横向溢出`, async () => {
    await page.setViewportSize({ width: w, height: h });
    await sleep(750);
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      bodyW: document.body.scrollWidth,
      winW: window.innerWidth,
      statusRight: document.getElementById('statusbar').getBoundingClientRect().right,
      titleRight: document.getElementById('titlebar').getBoundingClientRect().right,
    }));
    return {
      ok: m.docW <= m.winW + 1 && m.bodyW <= m.winW + 1 && m.statusRight <= m.winW + 1,
      detail: JSON.stringify(m),
    };
  });
}

await test('各主要区块互不重叠（纵向堆叠）', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(600);
  const rects = await page.evaluate(() => {
    const g = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    return {
      titlebar: g('titlebar'), menubar: g('menubar'), toolbar: g('toolbar'),
      workspace: g('workspace'), statusbar: g('statusbar'), tabbar: g('tabbar'),
      editor: g('editor-host'), sidebar: g('sidebar'),
    };
  });
  const overlapV = (a, b) => a && b && a.bottom > b.top + 1 && b.bottom > a.top + 1;
  const problems = [];
  if (overlapV(rects.titlebar, rects.menubar)) problems.push('titlebar/menubar');
  if (overlapV(rects.menubar, rects.toolbar)) problems.push('menubar/toolbar');
  if (overlapV(rects.toolbar, rects.workspace)) problems.push('toolbar/workspace');
  if (overlapV(rects.workspace, rects.statusbar)) problems.push('workspace/statusbar');
  if (overlapV(rects.tabbar, rects.editor)) problems.push('tabbar/editor');
  return {
    ok: problems.length === 0,
    detail: problems.length ? '纵向重叠: ' + problems.join(',') : JSON.stringify(rects),
  };
});

await test('侧栏与编辑区横向不重叠', async () => {
  const r = await page.evaluate(() => {
    const s = document.getElementById('sidebar').getBoundingClientRect();
    const e = document.getElementById('editor-host').getBoundingClientRect();
    const res = document.getElementById('sidebar-resizer').getBoundingClientRect();
    return {
      sidebar: { l: +s.left.toFixed(1), r: +s.right.toFixed(1) },
      resizer: { l: +res.left.toFixed(1), r: +res.right.toFixed(1) },
      editor: { l: +e.left.toFixed(1), r: +e.right.toFixed(1) },
    };
  });
  // 分隔条是骑在侧栏边界上的（居中 2~4px），允许 ±3px 的正常骑边
  const ok = r.sidebar.r <= r.editor.l + 1 && r.resizer.l >= r.sidebar.r - 3 && r.resizer.r <= r.editor.l + 3;
  return {
    ok,
    detail: ok
      ? `侧栏→${JSON.stringify(r.sidebar)} 分隔条→${JSON.stringify(r.resizer)} 编辑区→${JSON.stringify(r.editor)}（分隔条骑边属正常）`
      : `异常：${JSON.stringify(r)}`,
  };
});

await test('全流程结束后无 console error（favicon 404 除外）', async () => {
  const errs = consoleErrors.filter((e) => !/favicon/i.test(e) && !/status of 404/.test(e));
  const notFound = consoleErrors.filter((e) => /status of 404/.test(e));
  return {
    ok: errs.length === 0,
    detail:
      errs.length
        ? errs.slice(0, 5).join(' || ')
        : `${notFound.length} 条 404 资源错误${notFound.length ? '（' + notFound[0] + '）' : ''}；其余 console error=${errs.length}`,
  };
});

await test('无失败的网络请求 / 404 资源', async () => {
  const real = networkErrors.filter((e) => !/favicon/i.test(e));
  const fav = networkErrors.filter((e) => /favicon/i.test(e));
  return {
    ok: real.length === 0,
    detail: `非 favicon 失败=${real.length}${real.length ? ': ' + real.slice(0, 4).join(' | ') : ''}；favicon=${fav.length}`,
  };
});

/* ============================================================ 主题截图 */

group('视觉截图');

await page.setViewportSize({ width: 1440, height: 900 });
await sleep(700);
await page.evaluate(() => {
  const app = window.quillpad;
  app.createTab({
    name: 'demo.ts',
    content: [
      '/**',
      ' * QuillPad 视觉审查样例',
      ' */',
      "import { EditorView } from '@codemirror/view';",
      '',
      'interface Options {',
      '  readonly theme: "aurora" | "ivory" | "nord";',
      '  readonly fontSize: number;',
      '}',
      '',
      'export class QuillPad {',
      '  private views = new Map<string, EditorView>();',
      '',
      '  constructor(private options: Options = { theme: "aurora", fontSize: 14 }) {}',
      '',
      '  open(name: string): EditorView {',
      '    const view = new EditorView({ parent: document.body });',
      '    this.views.set(name, view);',
      '    return view;',
      '  }',
      '}',
      '',
      'const total = 42;',
      'const label = `打开 ${total} 个标签`;',
      '',
      '// TODO: 支持多光标批量重命名',
      '/* 多行注释',
      '   第二行 */',
      '',
    ].join('\n'),
  });
});
await sleep(1400);
await page.evaluate(() => {
  const app = window.quillpad;
  const tab = app.state.tabs.find((t) => t.name === 'demo.ts');
  if (tab) app.activateTab(tab.id);
});
await sleep(900);

if (!SKIP_VISUAL) {
  for (const [id, label] of THEME_EXPECT) {
    await page.evaluate((t) => window.quillpad.setTheme(t), id);
    await sleep(1000);
    await page.screenshot({ path: path.join(OUT, `theme-${id}.png`) });
    // 额外保存一份 qa-theme-* 副本，避免与其他并行任务的截图互相覆盖
    await page.screenshot({ path: path.join(OUT, `qa-theme-${id}.png`) });
    console.log(`  截图 shots/theme-${id}.png + shots/qa-theme-${id}.png  (${label})`);
  }
  await page.evaluate(() => window.quillpad.setTheme('aurora'));
  await sleep(600);
}

/* ============================================================== 汇总 */

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(70));
console.log(`总计 ${results.length} 项 · 通过 ${passed} · 失败 ${failed.length}`);
if (failed.length) {
  console.log('\n失败清单：');
  failed.forEach((f) => console.log(`  ✗ [${f.group}] ${f.name} — ${f.detail}`));
}
console.log('\nconsole error:', consoleErrors.length);
consoleErrors.slice(0, 10).forEach((e) => console.log('   ! ' + e.split('\n')[0]));
console.log('网络失败/404:', networkErrors.length);
networkErrors.slice(0, 10).forEach((e) => console.log('   ! ' + e));
console.log('console warning:', consoleWarnings.length);
consoleWarnings.slice(0, 8).forEach((e) => console.log('   ~ ' + e.split('\n')[0]));
console.log('='.repeat(70));

writeFileSync(
  path.join(OUT, 'qa-report.json'),
  JSON.stringify(
    {
      base: BASE,
      when: new Date().toISOString(),
      total: results.length,
      passed,
      failed: failed.length,
      results,
      consoleErrors,
      consoleWarnings,
      networkErrors,
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(failed.length ? 1 : 0);
