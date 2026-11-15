/**
 * QuillPad v2 · 第一批（T02–T09）端到端验收
 *
 * 前置：`npx vite --port 4173 --strictPort` 已启动。
 * 运行：`node scripts/v2-check.mjs`
 *
 * 覆盖 ARCH-v2 §6 任务表 T02–T09 的验收标准，逐条输出 PASS / FAIL。
 * 说明：T02 ⑥ 与 T04 的 v1 回归由 `scripts/qa.mjs` 覆盖，本脚本只做 v2 新契约。
 */
import { chromium } from 'playwright-core';

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok, d });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' :: ' + d : ''}`);
};
const group = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const docText = () => page.evaluate(() => window.quillpad.editor.view.state.doc.toString());
const mode = () => page.evaluate(() => window.quillpad.state.viewMode);
const cursorLine = () => page.evaluate(() => window.quillpad.lastCursor.line);

/**
 * 写入一个 markdown 文档并回到 wysiwyg。
 * @param {string} text
 * @param {{language?: string, nativePath?: string, line?: number}} [opts]
 */
async function setDoc(text, opts = {}) {
  await page.evaluate(
    ({ text: t, language, nativePath, line }) => {
      const app = window.quillpad;
      let tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
      if (!tab) {
        app.newFile();
        tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
      }
      tab.language = language || 'markdown';
      if (nativePath !== undefined) tab.nativePath = nativePath;
      app.setTabContent(tab.id, t);
      app.refreshViewMode();
      if (line) app.editor.gotoLine(line);
    },
    { text, ...opts },
  );
  await wait(420);
}

const goto = async (line) => {
  await page.evaluate((n) => window.quillpad.editor.gotoLine(n), line);
  await wait(220);
};

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/* ============================================================== T02 三态视图 */
group('T02 三态视图模式');

await setDoc('# 标题\n\n正文一行。\n');
check('T02① 打开 .md 默认 wysiwyg', (await mode()) === 'wysiwyg', `mode=${await mode()}`);
check(
  'T02① .editor-split[data-view-mode="wysiwyg"] 且 #preview-pane hidden',
  await page.evaluate(() => {
    const split = document.getElementById('editor-split');
    const prev = document.getElementById('preview-pane');
    return split.dataset.viewMode === 'wysiwyg' && prev.hidden === true;
  }),
);

await page.locator('.cm-content').first().click();
const seq = [];
for (let i = 0; i < 4; i += 1) {
  await page.keyboard.press('Control+e');
  await wait(320);
  seq.push(await mode());
}
check(
  'T02② Mod-E 连按序列 = wysiwyg→source→split→wysiwyg',
  seq.join('→') === 'source→split→wysiwyg→source' && seq[0] === 'source',
  seq.join('→'),
);

const previewMirror = await page.evaluate(async () => {
  const app = window.quillpad;
  const out = [];
  for (const m of ['source', 'split', 'wysiwyg']) {
    app.setViewMode(m, { user: true });
    await new Promise((r) => requestAnimationFrame(r));
    out.push([m, app.state.previewVisible, app.state.viewMode === 'split']);
  }
  return out;
});
check(
  'T02⑤ previewVisible === (viewMode === "split") 恒成立',
  previewMirror.every((r) => r[1] === r[2]),
  JSON.stringify(previewMirror),
);

await page.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
await wait(400);
const storedMode = await page.evaluate(() => JSON.parse(localStorage.getItem('quillpad.settings.v1') || '{}').viewMode);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const modeAfterReload = await mode();
check(
  'T02③ 刷新后设置里的 viewMode 与当前一致',
  storedMode === 'wysiwyg' && modeAfterReload === 'wysiwyg',
  `stored=${storedMode} after=${modeAfterReload}`,
);

await setDoc('const a = 1;\n', { language: 'javascript' });
const jsState = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const w = q('[data-cmd="view.modeWysiwyg"]');
  const p = q('[data-cmd="view.preview"]');
  return {
    mode: window.quillpad.state.viewMode,
    wysiwygDisabled: !!(w && w.disabled),
    previewDisabled: !!(p && (p.disabled || p.getAttribute('aria-disabled') === 'true')),
  };
});
check(
  'T02④ 切 .js 标签 → source 且所见即所得/预览入口置灰',
  jsState.mode === 'source' && jsState.wysiwygDisabled && jsState.previewDisabled,
  JSON.stringify(jsState),
);

/* ============================================================ T03 行内 5 类 */
group('T03 装饰层骨架 + 行内 5 类');

const INLINE_DOC = [
  '# 一级标题',
  '',
  '这是**粗体**与*斜体*和~~删除线~~以及`行内代码`的段落。',
  '',
  '> 引用一行',
  '',
  '- 列表一',
  '- 列表二',
  '',
].join('\n');

await setDoc(INLINE_DOC, { line: 3 });
await wait(300);
const boldOn = await page.evaluate(
  () => document.querySelectorAll('.qp-md-mark[data-qp-mark="bold"]').length,
);
await goto(6);
const boldOff = await page.evaluate(
  () => document.querySelectorAll('.qp-md-mark[data-qp-mark="bold"]').length,
);
check('T03① 光标在粗体行 → bold 标记 2 个，移出 → 0 个', boldOn === 2 && boldOff === 0, `${boldOn} / ${boldOff}`);

// ② 10 次进出：滚动尺寸与位置不漂移
await page.evaluate(() => {
  const s = window.quillpad.editor.view.scrollDOM;
  window.__s0 = { h: s.scrollHeight, t: s.scrollTop };
});
for (let i = 0; i < 10; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await goto(3);
  // eslint-disable-next-line no-await-in-loop
  await goto(6);
}
const drift = await page.evaluate(() => {
  const s = window.quillpad.editor.view.scrollDOM;
  return { dh: Math.abs(s.scrollHeight - window.__s0.h), dt: Math.abs(s.scrollTop - window.__s0.t) };
});
check('T03② 10 次进出 scrollHeight / scrollTop 漂移 ≤1px', drift.dh <= 1 && drift.dt <= 1, JSON.stringify(drift));

// ③ 粗体中部 Backspace ×5
await setDoc('这是**粗体文字内容很长**段落。\n', { line: 1 });
await page.evaluate(() => {
  const app = window.quillpad;
  const pos = app.editor.view.state.doc.toString().indexOf('粗体文字') + 6;
  app.editor.gotoPos(pos);
});
await wait(260);
const beforeLen = (await docText()).length;
for (let i = 0; i < 5; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.keyboard.press('Backspace');
  // eslint-disable-next-line no-await-in-loop
  await wait(90);
}
const afterBackspace = await page.evaluate(() => ({
  len: window.quillpad.editor.view.state.doc.toString().length,
  strong: document.querySelectorAll('[data-qp-node="strong"]').length,
  text: window.quillpad.editor.view.state.doc.toString(),
}));
check(
  'T03③ 粗体中部 Backspace×5 → 字符 −5 且 strong 仍在',
  afterBackspace.len === beforeLen - 5 && afterBackspace.strong >= 1,
  `${beforeLen}→${afterBackspace.len} strong=${afterBackspace.strong} ${JSON.stringify(afterBackspace.text)}`,
);

// ④ wysiwyg ↔ source 往返 20 次
await setDoc(INLINE_DOC, { line: 3 });
const snap = await docText();
for (let i = 0; i < 20; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate(() => window.quillpad.setViewMode('source'));
  // eslint-disable-next-line no-await-in-loop
  await page.evaluate(() => window.quillpad.setViewMode('wysiwyg'));
}
await wait(400);
const snap2 = await docText();
check('T03④ wysiwyg↔source 往返 20 次字节一致', snap === snap2, `${snap.length} → ${snap2.length}`);

// ⑤ .cm-line 拼接文本 === 源码
const joined = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'),
);
check('T03⑤ .cm-line 拼接文本 === 源码', joined === snap, joined === snap ? '' : `${JSON.stringify(joined.slice(0, 60))}`);

// ⑥ 标记颜色
await goto(3);
await wait(220);
const markStyle = await page.evaluate(() => {
  const el = document.querySelector('.qp-md-mark[data-qp-mark="bold"]');
  if (!el) return null;
  const probe = document.createElement('span');
  probe.style.color = 'var(--text-faint)';
  document.body.appendChild(probe);
  const want = getComputedStyle(probe).color;
  probe.remove();
  const cs = getComputedStyle(el);
  return { color: cs.color, want, bg: cs.backgroundColor };
});
check(
  'T03⑥ .qp-md-mark 计算色 = --text-faint 且背景透明',
  !!markStyle &&
    markStyle.color === markStyle.want &&
    /rgba\(0, 0, 0, 0\)|transparent/.test(markStyle.bg),
  JSON.stringify(markStyle),
);

/* ========================================================== T04 块级层 */
group('T04 块级层（代码块 / 引用 / 列表 / 任务 / 分割线 / front matter）');

await setDoc('```js\nconst a = 1;\nconsole.log(a);\n```\n\n> 引用一行\n\n- 列表一\n- 列表二\n\n---\n', { line: 6 });
await wait(400);
const blockState = await page.evaluate(() => ({
  codeHead: document.querySelectorAll('[data-qp-node="code-block"][data-qp-lang="js"]').length,
  quote: document.querySelectorAll('[data-qp-node="quote"]').length,
  li: document.querySelectorAll('[data-qp-node="li"]').length,
  hr: document.querySelectorAll('hr[data-qp-node="hr"]').length,
}));
check(
  'T04① ```js → code-block[data-qp-lang="js"]',
  blockState.codeHead === 1,
  JSON.stringify(blockState),
);
check('T04② quote / li 计数 = 源码结构数', blockState.quote === 1 && blockState.li === 2, JSON.stringify(blockState));

await page.click('[data-role="code-copy"]');
await wait(400);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check(
  'T04① 复制按钮 → 剪贴板 = 代码正文',
  clip.replace(/\r\n/g, '\n') === 'const a = 1;\nconsole.log(a);',
  JSON.stringify(clip),
);

// 光标停在标题行，任务项才会渲染成复选框（A3：光标行露出源码）
await setDoc('# 任务\n\n- [ ] 未完成任务\n- [x] 已完成任务\n', { line: 1 });
await wait(500);
const taskBefore = await page.evaluate(() => {
  const app = window.quillpad;
  app.editor.gotoLine(1);
  return {
    head: app.editor.view.state.selection.main.head,
    boxes: document.querySelectorAll('.qp-task').length,
    firstChecked: (document.querySelector('.qp-task') || {}).getAttribute
      ? document.querySelector('.qp-task').getAttribute('data-qp-checked')
      : null,
  };
});
await page.locator('.qp-task').first().click();
await wait(420);
const taskAfter = await page.evaluate(() => ({
  doc: window.quillpad.editor.view.state.doc.toString(),
  head: window.quillpad.editor.view.state.selection.main.head,
  checked: (document.querySelector('.qp-task') || {}).getAttribute
    ? document.querySelector('.qp-task').getAttribute('data-qp-checked')
    : null,
}));
check(
  'T04③ 点击任务项 → 源码 - [x] 且 selection.head 不变',
  taskBefore.boxes === 2 &&
    /^- \[x\] 未完成任务/m.test(taskAfter.doc) &&
    taskAfter.head === taskBefore.head,
  `boxes=${taskBefore.boxes} head ${taskBefore.head}→${taskAfter.head} doc=${JSON.stringify(taskAfter.doc)}`,
);
check('T04③ data-qp-checked="true"', taskAfter.checked === 'true', String(taskAfter.checked));

await page.keyboard.press('Control+z');
await wait(500);
const undoDoc = await docText();
check('T04④ Mod-Z 一次回到 - [ ]', /^- \[ \] 未完成任务/m.test(undoDoc), JSON.stringify(undoDoc));

await setDoc('# 分割线\n\n---\n\n正文\n', { line: 1 });
await wait(500);
const hideState = await page.evaluate(() => {
  const line = Array.from(document.querySelectorAll('.cm-line')).find(
    (l) => l.textContent.indexOf('---') >= 0,
  );
  if (!line) return null;
  const hide = line.querySelector('.qp-md-hide');
  return {
    hr: document.querySelectorAll('hr[data-qp-node="hr"]').length,
    hidden: !!hide && hide.textContent === '---',
    fontSize: hide ? getComputedStyle(hide).fontSize : '',
  };
});
check('T04⑤ hr 渲染且源码 --- 被零宽隐藏', !!hideState && hideState.hr >= 1, JSON.stringify(hideState));
check('T04⑤ 隐藏的 --- 计算字号为 0px', !!hideState && hideState.fontSize === '0px', JSON.stringify(hideState));

const FM_DOC = ['---', 'title: 测试', 'author: 寇豆码', '---', '', '# 正文标题', '', '一段正文。', ''].join('\n');
await setDoc(FM_DOC, { line: 6 });
await wait(500);
const fm1 = await page.evaluate(() => {
  const el = document.querySelector('[data-qp-node="frontmatter"]');
  return el
    ? { collapsed: el.getAttribute('data-qp-collapsed'), h: el.getBoundingClientRect().height }
    : null;
});
check(
  'T04⑥ front matter 折叠态 data-qp-collapsed="true" 且高度 ≤120px',
  !!fm1 && fm1.collapsed === 'true' && fm1.h <= 120,
  JSON.stringify(fm1),
);
if (fm1) {
  await page.click('[data-role="frontmatter-edit"]');
  await wait(500);
  const fm2 = await page.evaluate(() => {
    const el = document.querySelector('[data-qp-node="frontmatter"]');
    const doc = window.quillpad.editor.view.state.doc.toString();
    return el ? { collapsed: el.getAttribute('data-qp-collapsed'), doc } : { collapsed: null, doc };
  });
  check(
    'T04⑥ 点击后 data-qp-collapsed="false" 且源码可见可编辑',
    fm2.collapsed === 'false' && fm2.doc.includes('title: 测试'),
    JSON.stringify(fm2.collapsed),
  );
} else {
  check('T04⑥ 点击后 data-qp-collapsed="false" 且源码可见可编辑', false, '折叠卡片未渲染');
}

/* ======================================================= T05 链接 + 图片 */
group('T05 链接 + 图片');

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ① 路径解析：直接对 `resolveImageUrl` 做单元断言（避免 dev server 下
//    Chromium 拦截 file:// 子资源导致 img 被移除 / 产生 console error）
const resolved = await page.evaluate(async () => {
  const m = await import('/src/editor/wysiwyg/image.js');
  return {
    rel: m.resolveImageUrl('img/x.png', 'D:/docs'),
    abs: m.resolveImageUrl('D:/pics/y.png', null),
    net: m.resolveImageUrl('https://a.com/z.png', null),
    noDir: m.resolveImageUrl('img/x.png', null),
  };
});
check(
  'T05① D:/docs/a.md + ![](img/x.png) → file:///D:/docs/img/x.png',
  resolved.rel.resolved === true && /^file:\/\/\/D:\/docs\/img\/x\.png$/.test(resolved.rel.url),
  JSON.stringify(resolved.rel),
);
check(
  'T05① 绝对路径 / 网络地址同样解析正确',
  /^file:\/\/\/D:\/pics\/y\.png$/.test(resolved.abs.url) && resolved.net.url === 'https://a.com/z.png',
  JSON.stringify([resolved.abs, resolved.net]),
);

// ③ 引用不存在的图片（未保存文档 → 无法定位基准目录 → 占位块，不发网络请求）
await setDoc('# 图\n\n![](img/missing.png)\n', { nativePath: '', line: 1 });
await wait(600);
const missingState = await page.evaluate(() => ({
  missing: document.querySelectorAll('.qp-img-missing').length,
  node: document.querySelectorAll('[data-qp-node="image-missing"]').length,
  reason: (document.querySelector('.qp-img-missing__reason') || {}).textContent || '',
}));
check('T05③ 引用不存在图片 → .qp-img-missing 占位', missingState.missing >= 1, JSON.stringify(missingState));

// 链接：不劫持跳转 + Mod+Click 派发 qp:open-external
await setDoc('# 链接\n\n[示例网站](https://example.com)\n', { line: 1 });
await wait(600);
const linkState = await page.evaluate(() => {
  const link = document.querySelector('[data-qp-node="link"]');
  return {
    linkHref: link ? link.getAttribute('href') : null,
    linkNodes: document.querySelectorAll('[data-qp-node="link"]').length,
  };
});
check('T05④ [data-qp-node="link"] 无 href（不劫持浏览器跳转）', linkState.linkHref === null, String(linkState.linkHref));

await page.evaluate(() => {
  window.__opened = 0;
  window.addEventListener('qp:open-external', () => {
    window.__opened += 1;
  });
});
const linkBox = await page.locator('[data-qp-node="link"]').first().boundingBox();
if (linkBox) {
  await page.keyboard.down('Control');
  await page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
  await page.keyboard.up('Control');
  await wait(400);
}
const opened = await page.evaluate(() => window.__opened);
check('T05④ Mod+Click 触发 qp:open-external 1 次', opened === 1, `count=${opened}`);

// 图片真的能渲染（用 data URL 验证 naturalWidth）
await setDoc(`# 图\n\n![像素](${PNG_1PX})\n`, { line: 1 });
await wait(700);
const natural = await page.evaluate(() => {
  const img = document.querySelector('.qp-img-wrap img');
  return img ? { w: img.naturalWidth, src: img.getAttribute('src').slice(0, 22) } : null;
});
check('T05① 已解析图片 naturalWidth > 0', !!natural && natural.w > 0, JSON.stringify(natural));

// 拖拽插入：用桌面壳 stub 断言 assets 落盘路径
await setDoc('# 拖拽\n\n正文\n', { nativePath: 'D:/docs/a.md', line: 1 });
await page.evaluate(() => {
  window.__wrote = [];
  // 契约（与 desktop/main.cjs 的 qp:write-asset 返回值一致）：
  //   { ok: true, name: <文件名>, path: <绝对路径> }  → 产品用 res.name 拼 assets/<name>
  window.quillpadDesktop = {
    writeAsset: async ({ docDir, fileName }) => {
      window.__wrote.push(fileName);
      return { ok: true, name: fileName, path: `${docDir}/assets/${fileName}` };
    },
  };
});
const dropped = await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'shot.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const target = document.querySelector('.cm-content');
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 700));
  return {
    wrote: window.__wrote,
    doc: window.quillpad.editor.view.state.doc.toString(),
  };
});
check(
  'T05② 拖入 shot.png → 落盘 assets/img-*.png 且源码插入对应行',
  /^!\[shot\.png\]\(assets\/img-\d{8}-\d{6}-[a-z0-9]{4}\.png\)$/m.test(dropped.doc) &&
    dropped.wrote.length === 1 &&
    /^img-\d{8}-\d{6}-[a-z0-9]{4}\.png$/.test(dropped.wrote[0] || ''),
  JSON.stringify(dropped),
);

// 未保存文档 → 二选一对话框
await page.evaluate(() => {
  window.quillpadDesktop = undefined;
});
await setDoc('# 未保存\n\n正文\n', { nativePath: '', line: 1 });
let dialogText = '';
page.once('dialog', async (d) => {
  dialogText = d.message();
  await d.dismiss();
});
await page.evaluate(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], 'shot.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document
    .querySelector('.cm-content')
    .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await wait(800);
check(
  'T05⑤ 未保存文档拖入图片 → 「另存为 / data URL」二选一',
  /另存为/.test(dialogText) && /data URL/i.test(dialogText),
  dialogText.replace(/\s+/g, ' ').slice(0, 80),
);

/* ============================================================ T06 表格 */
group('T06 表格（widget + 浮层编辑 + 7 操作）');

const TABLE_DOC = '# 表格\n\n| 姓名 | 年龄 |\n| :--- | ---: |\n| 甲 | 20 |\n| 乙 | 30 |\n';
await setDoc(TABLE_DOC, { line: 1 });
await wait(600);
const tableState = await page.evaluate(() => {
  const t = document.querySelector('[data-qp-node="table"]');
  if (!t) return null;
  return {
    rows: t.querySelectorAll('tr').length,
    cols: t.querySelectorAll('thead th').length,
    cols2: t.querySelectorAll('tbody tr')[0].children.length,
    ops: t.parentElement.querySelectorAll('.qp-table-ops__btn').length,
    width: Math.round(t.parentElement.getBoundingClientRect().width),
  };
});
check(
  'T06-1 表格渲染：3 行 × 2 列 + 7 个操作按钮',
  !!tableState && tableState.rows === 3 && tableState.cols === 2 && tableState.ops === 7,
  JSON.stringify(tableState),
);
check(
  'T06-1 块级 widget 宽度为像素值（非 1e6 哨兵）',
  !!tableState && tableState.width > 100 && tableState.width < 2000,
  JSON.stringify(tableState && tableState.width),
);

// 双击单元格 → 浮层 input
const cell = page.locator('[data-qp-node="table"] tbody td').first();
await cell.dblclick();
await wait(320);
const overlay = await page.evaluate(() => {
  const el = document.querySelector('.qp-cell-editor');
  return el
    ? { exists: true, hidden: el.hidden, parent: el.parentElement === document.body, value: el.value }
    : { exists: false };
});
check('T06-2 双击单元格 → 浮层 .qp-cell-editor（挂 body）', overlay.exists && !overlay.hidden && overlay.parent, JSON.stringify(overlay));

await page.fill('.qp-cell-editor', '丙');
await page.keyboard.press('Enter');
await wait(500);
const afterEdit = await docText();
check('T06-3 提交单元格 → 源码更新（甲→丙）', /\| 丙 \| 20 \|/.test(afterEdit), JSON.stringify(afterEdit.match(/\| 丙.*\|/)?.[0] || ''));

await page.locator('.cm-line').first().click();
await page.keyboard.press('Control+z');
await wait(520);
const afterUndo = await docText();
check('T06-3 一次 undo 复原单元格', /\| 甲 \| 20 \|/.test(afterUndo), JSON.stringify(afterUndo.match(/\| 甲.*\|/)?.[0] || ''));

// Tab 末格 → 下一行首格（重新装载干净文档，避免上一步的焦点状态干扰）
await setDoc(TABLE_DOC, { line: 1 });
await wait(600);
const readCell = () =>
  page.evaluate(() => {
    const el = document.querySelector('.qp-cell-editor');
    if (!el || el.hidden) return null;
    return { value: el.value, r: Number(el.dataset.r), c: Number(el.dataset.c) };
  });
let tabState = null;
for (let attempt = 0; attempt < 5 && !tabState; attempt += 1) {
  // 打开「第一行最后一格」的浮层
  // eslint-disable-next-line no-await-in-loop
  await page.mouse.move(300, 320);
  // eslint-disable-next-line no-await-in-loop
  await page.locator('[data-qp-node="table"] tbody tr').first().locator('td').last().dblclick();
  // eslint-disable-next-line no-await-in-loop
  await wait(400);
  // eslint-disable-next-line no-await-in-loop
  if (!(await readCell())) continue;
  // eslint-disable-next-line no-await-in-loop
  await page.keyboard.press('Tab');
  // eslint-disable-next-line no-await-in-loop
  await wait(700);
  // eslint-disable-next-line no-await-in-loop
  tabState = await readCell();
}
check(
  'T06-4 Tab 在末格 → 聚焦下一行首格（r=2,c=0 值=乙）',
  !!tabState && tabState.r === 2 && tabState.c === 0 && tabState.value === '乙',
  JSON.stringify(tabState),
);

// Esc → 关闭浮层且光标在表格块外（独立打开一次浮层，不依赖上一步）
for (let attempt = 0; attempt < 5; attempt += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.locator('[data-qp-node="table"] tbody tr').first().locator('td').last().dblclick();
  // eslint-disable-next-line no-await-in-loop
  await wait(400);
  // eslint-disable-next-line no-await-in-loop
  if (await readCell()) break;
}
await page.keyboard.press('Escape');
await wait(500);
const escState = await page.evaluate(() => {
  const app = window.quillpad;
  const el = document.querySelector('.qp-cell-editor');
  const pos = app.editor.view.state.selection.main.head;
  const doc = app.editor.view.state.doc.toString();
  const tableStart = doc.indexOf('| 姓名');
  const tableEnd = doc.lastIndexOf('| 乙 | 30 |') + '| 乙 | 30 |'.length;
  return { hidden: !!el && el.hidden, pos, outside: pos < tableStart || pos > tableEnd, tableEnd };
});
check(
  'T06-5 Esc → 关闭浮层且 selection.head 落在表格块外',
  escState.hidden && escState.outside,
  JSON.stringify(escState),
);

// 7 个操作：每个操作用「该操作合法」的干净文档
const opResults = await page.evaluate(async () => {
  const app = window.quillpad;
  const base = '# 表\n\n| A | B |\n| :--- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';
  const out = {};
  // op 名 → 命令 id（ARCH §4 里对齐命令叫 cycleAlign）
  const ops = [
    ['rowAbove', 'rowAbove'],
    ['rowBelow', 'rowBelow'],
    ['rowDelete', 'rowDelete'],
    ['colLeft', 'colLeft'],
    ['colRight', 'colRight'],
    ['colDelete', 'colDelete'],
    ['alignCycle', 'cycleAlign'],
  ];
  for (const [op, cmd] of ops) {
    app.setTabContent(app.state.activeTabId, base);
    app.refreshViewMode();
    await new Promise((r) => setTimeout(r, 260));
    // 光标放进表格第一格（表格因此露出源码，命令才定位得到）
    app.editor.gotoPos(base.indexOf('| A | B |') + 3);
    const before = app.editor.view.state.doc.toString();
    app.run('markdown.table.' + cmd);
    await new Promise((r) => setTimeout(r, 240));
    const after = app.editor.view.state.doc.toString();
    out[op] = before !== after;
  }
  return out;
});
check(
  'T06-6 7 个表格操作全部真实改动源码',
  Object.values(opResults).every(Boolean),
  JSON.stringify(opResults),
);

// 序列化无损
await setDoc('| a | b |\n| :-- | --: |\n| 1 | 2 |\n', { line: 1 });
await wait(500);
const roundTrip = await docText();
check('T06-7 表格源码 round-trip 不变形', roundTrip === '| a | b |\n| :-- | --: |\n| 1 | 2 |\n', JSON.stringify(roundTrip));

/* ====================================================== T07 公式 / 脚注 / TOC */
group('T07 数学公式 + 脚注 + TOC');

const MATH_DOC = [
  '# 一章',
  '',
  '## 二章',
  '',
  '公式 $a^2+b^2$ 结束。',
  '',
  '脚注引用[^1]',
  '',
  '[TOC]',
  '',
  '[^1]: 脚注正文在这里。',
  '',
].join('\n');
await setDoc(MATH_DOC, { line: 1 });
await wait(1400);
const mathState = await page.evaluate(() => ({
  inline: document.querySelectorAll('[data-qp-node="math-inline"] .katex').length,
  sup: document.querySelectorAll('sup[data-qp-node="footnote-ref"]').length,
  footnotes: document.querySelectorAll('[data-qp-node="footnotes"]').length,
  tocNav: document.querySelectorAll('nav[data-qp-node="toc"]').length,
  tocItems: document.querySelectorAll('.qp-toc__item').length,
  headings: document.querySelectorAll('.cm-line[data-qp-node="heading"]').length,
}));
check('T07① $a^2+b^2$ → [data-qp-node="math-inline"] .katex', mathState.inline >= 1, JSON.stringify(mathState));
check('T07② [^1] → sup[data-qp-node="footnote-ref"] 且文末脚注区存在', mathState.sup === 1 && mathState.footnotes === 1, JSON.stringify(mathState));
check(
  'T07③ [TOC] → nav 条目数 === H1–H3 数量',
  mathState.tocNav === 1 && mathState.tocItems === mathState.headings && mathState.tocItems > 0,
  `toc=${mathState.tocItems} headings=${mathState.headings}`,
);

await page.click('sup[data-qp-node="footnote-ref"]');
await wait(500);
const fnLine = await cursorLine();
check('T07② 点击脚注上标 → 光标行 = 定义行（11）', fnLine === 11, `line=${fnLine}`);

const tocBox = await page.locator('.qp-toc__item').nth(1).boundingBox();
if (tocBox) {
  await page.mouse.click(tocBox.x + tocBox.width / 2, tocBox.y + tocBox.height / 2);
  await wait(500);
}
const tocLine = await cursorLine();
check('T07③ 点击目录项 → 光标行 = 该标题行（3）', tocLine === 3, `line=${tocLine}`);

// ④ 模拟 KaTeX 加载失败 → 降级为等宽源码，且 console error = 0
const katexFail = await page.evaluate(async () => {
  const m = await import('/src/editor/wysiwyg/math.js');
  const el = document.createElement('div');
  document.body.appendChild(el);
  // 直接走「源码降级」路径
  m.renderMathSource(el, 'x^2', false);
  const out = { text: el.textContent, cls: el.className };
  el.remove();
  return out;
});
check(
  'T07④ KaTeX 不可用时降级为等宽源码（.qp-math-src）',
  katexFail.text === '$x^2$' && /qp-math-src/.test(katexFail.cls),
  JSON.stringify(katexFail),
);

/* ========================================================= T08 大文件降级 */
group('T08 大文件降级与装饰预算');

const bigDoc = `# 大文件\n\n${'压力测试一行文本，用于触发降级策略。\n'.repeat(25000)}`;
const bigSize = Buffer.byteLength(bigDoc);
check('T08 构造 1MB+ / 25k 行级样例', bigSize > 1024 * 1024 && bigDoc.split('\n').length > 20000, `${(bigSize / 1024 / 1024).toFixed(2)}MB / ${bigDoc.split('\n').length} 行`);

// ① 真正把 25k 行文档装进编辑器（走 setTabContent，模拟打开大文件）
await page.evaluate((text) => {
  const app = window.quillpad;
  const tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
  tab.language = 'markdown';
  app.setTabContent(tab.id, text);
  app.refreshViewMode();
}, bigDoc);
await wait(1400);
const degrade = await page.evaluate(() => ({
  mode: window.quillpad.state.viewMode,
  degraded: window.quillpad.state.wysiwygDegraded,
  banner: (document.querySelector('.qp-degrade-banner__text') || {}).textContent || '',
  docLines: window.quillpad.editor.view.state.doc.lines,
}));
check(
  'T08① 26k 行文档 → source + 降级提示（含 MB 与行数）',
  degrade.mode === 'source' &&
    degrade.degraded &&
    /MB/.test(degrade.banner) &&
    /行/.test(degrade.banner) &&
    degrade.docLines > 20000,
  JSON.stringify(degrade),
);

// ② 点「仍要启用」→ wysiwyg，且 5s 内编辑器仍可交互
await page.click('[data-role="force-wysiwyg"]').catch(() => {});
const interactive = await page.evaluate(async () => {
  const app = window.quillpad;
  const t0 = performance.now();
  // 等到 wysiwyg 装载完成（wysiwygActive + 一帧）
  while (performance.now() - t0 < 5000) {
    if (app.state.viewMode === 'wysiwyg' && app.editor.wysiwygActive) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  const waited = performance.now() - t0;
  // 交互性：插入一个字符并确认文档真的变了
  const view = app.editor.view;
  const len0 = view.state.doc.length;
  view.dispatch({ changes: { from: 0, insert: '#' }, selection: { anchor: 1 } });
  const len1 = view.state.doc.length;
  return {
    waited,
    mode: app.state.viewMode,
    wysiwygActive: app.editor.wysiwygActive,
    forced: Array.from(app.state.wysiwygForced),
    active: app.state.activeTabId,
    editable: len1 === len0 + 1,
  };
});
check(
  'T08② 「仍要启用」→ wysiwyg + wysiwygForced 含该 tabId + 5s 内可交互',
  interactive.mode === 'wysiwyg' &&
    interactive.wysiwygActive &&
    interactive.forced.includes(interactive.active) &&
    interactive.editable &&
    interactive.waited < 5000,
  JSON.stringify(interactive),
);

// ④ 降级后（source 模式）滚动 1MB 文档的帧率（先回到 source）
await page.evaluate(() => {
  const app = window.quillpad;
  const tab = app.state.tabs.find((x) => x.id === app.state.activeTabId);
  app.state.wysiwygForced.delete(tab.id);
  app.refreshViewMode();
  app.editor.gotoLine(1);
});
await wait(1200);
await page.bringToFront();
const scrollMode = await mode();
check('T08④ 1MB 文档滚动前处于 source 模式', scrollMode === 'source', scrollMode);
const visibility = await page.evaluate(() => document.visibilityState);
const fps = await page.evaluate(async () => {
  const app = window.quillpad;
  const scroller = app.editor.view.scrollDOM;
  const meter = app.frameMeter;
  meter.start();
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    scroller.scrollTop += 24;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { ...meter.stop(), lines: app.editor.view.state.doc.lines };
});
check(
  'T08④ 1MB 文档滚动 5s 平均帧间隔 ≤20ms',
  fps.avg > 0 && fps.avg <= 20,
  JSON.stringify({ ...fps, visibility }),
);

// ③ >20MB 硬上限：用独立标签，避免 22MB 字符串污染后续会话持久化
await page.evaluate(() => {
  const app = window.quillpad;
  const tab = app.createTab({ name: 'huge.md', language: 'markdown' });
  tab.content = '#' + 'x'.repeat(21 * 1024 * 1024);
  app.refreshViewMode();
});
await wait(700);
const hardLimit = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const w = q('[data-cmd="view.modeWysiwyg"]');
  const p = q('[data-cmd="view.preview"]');
  return {
    mode: window.quillpad.state.viewMode,
    wysiwygDisabled: !!(w && w.disabled),
    previewDisabled: !!(p && (p.disabled || p.getAttribute('aria-disabled') === 'true')),
  };
});
check(
  'T08③ >20MB → wysiwyg 与预览双置灰且停在 source',
  hardLimit.mode === 'source' && hardLimit.wysiwygDisabled && hardLimit.previewDisabled,
  JSON.stringify(hardLimit),
);

// 清理：关掉 21MB 标签，避免把巨型会话写进 localStorage
await page.evaluate(async () => {
  const app = window.quillpad;
  const huge = app.state.tabs.find((t) => t.name === 'huge.md');
  if (huge) await app.closeTab(huge.id, true);
  const first = app.state.tabs[0];
  if (first) app.activateTab(first.id);
  app.persistSession();
});
await wait(600);

/* ======================================== T09 大纲 / 专注 / 打字机 / 迷你地图 */
group('T09 大纲联动 + 专注模式 + 打字机 + 迷你地图');

const OUTLINE_DOC = [
  '# 第一章',
  '',
  '第一章正文。',
  '',
  '## 第二章',
  '',
  '第二章正文。',
  '',
  '## 第三章',
  '',
  '第三章正文。',
  '',
].join('\n');
await setDoc(OUTLINE_DOC, { line: 1 });
await page.evaluate(() => window.quillpad.setViewMode('wysiwyg', { user: true }));
await page.evaluate(() => {
  window.quillpad.state.sidebarVisible = true;
  window.quillpad.el.sidebar.hidden = false;
  window.quillpad.state.sidebarTab = 'outline';
  window.quillpad.sidebar.render();
});
await wait(400);
await goto(6);
await wait(500);
const outlineState = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#sidebar-body [data-outline-line]'));
  const active = items.filter((el) => el.getAttribute('aria-current') === 'true');
  return {
    count: items.length,
    activeCount: active.length,
    activeLine: active[0] ? Number(active[0].dataset.outlineLine) : null,
  };
});
check(
  'T09① 光标进 ## 第二章 → 该项 aria-current="true"，其余 !== "true"',
  outlineState.activeCount === 1 && outlineState.activeLine === 5,
  JSON.stringify(outlineState),
);

const renderBase = await page.evaluate(() => window.quillpad.sidebar.outlineRenderCount);
await page.evaluate(() => window.quillpad.editor.view.focus());
for (let i = 0; i < 5; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await page.keyboard.type('X');
  // eslint-disable-next-line no-await-in-loop
  await wait(60);
}
await wait(700);
const renderDelta = await page.evaluate((base) => window.quillpad.sidebar.outlineRenderCount - base, renderBase);
check('T09② 连续输入 5 次 → 大纲重绘 ≤2 次（300ms 防抖）', renderDelta <= 2, `delta=${renderDelta}`);

await page.evaluate(() => window.quillpad.setFocusMode(true));
await wait(500);
const focusState = await page.evaluate(() => {
  const dim = Array.from(document.querySelectorAll('.qp-focus-dim'));
  const active = document.querySelector('.cm-line.cm-activeLine');
  return {
    dimCount: dim.length,
    activeDimmed: !!(active && active.classList.contains('qp-focus-dim')),
  };
});
check(
  'T09③ 专注模式 → .qp-focus-dim ≥1 且当前段落未被淡化',
  focusState.dimCount >= 1 && !focusState.activeDimmed,
  JSON.stringify(focusState),
);
await page.evaluate(() => window.quillpad.setFocusMode(false));

await setDoc(`# 打字机\n\n${Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 行正文`).join('\n\n')}\n`, {
  line: 1,
});
await page.evaluate(() => window.quillpad.setTypewriter(true));
await wait(400);
await goto(30);
await wait(900);
const twState = await page.evaluate(() => {
  const view = window.quillpad.editor.view;
  const cur = document.querySelector('.cm-cursor');
  const box = view.scrollDOM.getBoundingClientRect();
  if (!cur) return null;
  const r = cur.getBoundingClientRect();
  return { ratio: (r.top - box.top) / box.height, h: box.height };
});
check(
  'T09④ 打字机模式 → 光标行位于视口垂直中央（0.48–0.52）',
  !!twState && twState.ratio >= 0.48 && twState.ratio <= 0.52,
  JSON.stringify(twState),
);
await page.evaluate(() => window.quillpad.setTypewriter(false));

await page.evaluate(() => window.quillpad.setMinimap(true));
await wait(700);
const mmBox = await page.locator('canvas.qp-minimap').boundingBox().catch(() => null);
check('T09⑤ canvas.qp-minimap 存在且可见', !!mmBox && mmBox.height > 40, JSON.stringify(mmBox));

if (mmBox) {
  const clickY = mmBox.y + mmBox.height * 0.6;
  await page.mouse.click(mmBox.x + mmBox.width / 2, clickY);
  await wait(700);
  const mmState = await page.evaluate(
    ({ y, top, h }) => ({
      cursorLine: window.quillpad.lastCursor.line,
      lines: window.quillpad.editor.view.state.doc.lines,
      expected: 1 + Math.round(((y - top) / h) * (window.quillpad.editor.view.state.doc.lines - 1)),
    }),
    { y: clickY, top: mmBox.y, h: mmBox.height },
  );
  check(
    'T09⑤ 点击迷你地图 → 光标行与映射一致（±3 行）',
    Math.abs(mmState.cursorLine - mmState.expected) <= 3,
    JSON.stringify(mmState),
  );
}

/* ============================================================ T11 PDF 对话框 */
group('T11 PDF 导出对话框（浏览器模式）');

await setDoc('# 报告\n\n正文一行。\n');
await page.evaluate(() => window.quillpad.run('pdf.export'));
await wait(600);

const pdfDialog = page.locator('[data-dialog="pdf-export"]');
const pdfFields = await pdfDialog
  .locator('[data-field]')
  .evaluateAll((els) => els.map((e) => e.dataset.field));
check(
  'T11① 对话框含 13 个字段（纸张/边距/主题/页码/目录/文件名…）',
  pdfFields.length >= 13 &&
    ['paper', 'orientation', 'theme', 'pageNumber', 'toc', 'fileName', 'marginTop'].every((f) =>
      pdfFields.includes(f),
    ),
  `${pdfFields.length} 个：${pdfFields.join(',')}`,
);

check(
  'T11② 预览缩略图已按需求移除（无 [data-role="thumb"]）',
  (await pdfDialog.locator('[data-role="thumb"]').count()) === 0,
  '',
);

const browserNotice = await pdfDialog.locator('[data-role="notice"]').innerText().catch(() => '');
const pagedDisabled = await page.evaluate(() => {
  const box = document.querySelector('[data-dialog="pdf-export"]');
  if (!box) return null;
  return ['pageNumber', 'toc', 'header', 'footer'].map((f) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    return { field: f, disabled: !!(el && el.disabled) };
  });
});
check(
  'T11③ 浏览器模式下分页相关控件（页码/目录/页眉页脚）置灰并给出说明',
  !!pagedDisabled && pagedDisabled.every((x) => x.disabled) && browserNotice.length > 0,
  `${JSON.stringify(pagedDisabled)} notice=${browserNotice.slice(0, 30)}`,
);

// 改纸张 → 表单值更新（预览已移除，不再断言缩略图重建）
await pdfDialog.locator('[data-field="paper"]').selectOption('Letter');
await wait(300);
const paperValue = await pdfDialog.locator('[data-field="paper"]').inputValue();
const hasBrowse = (await pdfDialog.locator('[data-role="browse"]').count()) === 1;
check(
  'T11④ 改纸张后表单值已更新；保存位置带「浏览…」按钮',
  paperValue === 'Letter' && hasBrowse,
  `paper=${paperValue} browse=${hasBrowse}`,
);

await pdfDialog.locator('[data-role="cancel"]').click().catch(() => {});
await wait(300);
check(
  'T11⑤ 取消后对话框关闭且不留残影',
  (await page.locator('[data-dialog="pdf-export"]').count()) === 0,
  '',
);

/* ============================================================ T12 打印管线 */
group('T12 打印 / PDF 主进程管线（暴露与能力探测）');

const printApi = await page.evaluate(() => {
  const p = window.quillpad.print || {};
  const d = window.quillpad.desktop || {};
  return {
    fns: ['buildPrintHtml', 'buildElectronPrintOptions', 'defaultPdfOptions', 'exportPdf', 'printDocument', 'paperSizeMm']
      .filter((k) => typeof p[k] === 'function'),
    canExport: typeof d.canExportPdf === 'function' ? d.canExportPdf() : null,
    canPrint: typeof d.canPrint === 'function' ? d.canPrint() : null,
    isDesktop: typeof d.isDesktop === 'function' ? d.isDesktop() : null,
  };
});
check('T12① app.print 暴露 6 个管线函数', printApi.fns.length === 6, printApi.fns.join(','));
check(
  'T12② 纯浏览器里 canExportPdf/canPrint 均为 false（不假装能写盘）',
  printApi.canExport === false && printApi.canPrint === false && printApi.isDesktop === false,
  JSON.stringify(printApi),
);

/* ============================================================ T13 宏录制回放 */
group('T13 宏录制 / 回放');

await page.evaluate(() => localStorage.removeItem('quillpad.macros.v1'));
await setDoc('hello world');
await page.evaluate(() => window.quillpad.run('macro.record'));
await wait(300);

const recState = await page.evaluate(async () => {
  // 模块可能带 ?t= HMR 时间戳（编辑源文件后 app 侧 URL 变化），
  // 必须按资源表现实 URL 导入才能拿到 app 同一实例，否则 isRecording 永远读到 false
  const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/core/macro.js')) || '/src/core/macro.js';
  const m = await import(u);
  const cell = document.querySelector('[data-cell="macro"]');
  // 红点必须是「真的画出来了」而不是只挂了个类名：早期版本状态栏只写了文字
  // 「录制中」，`.qp-rec-dot` 的样式在 CSS 里躺着却没人渲染，于是红点从未出现。
  const dot = cell ? cell.querySelector('.qp-rec-dot') : null;
  const box = dot ? dot.getBoundingClientRect() : null;
  const cs = dot ? getComputedStyle(dot) : null;
  return {
    recording: m.isRecording(),
    cellHidden: cell ? cell.hidden : null,
    cellsRight: cell ? cell.getBoundingClientRect().left > document.querySelector('[data-cell="words"]').getBoundingClientRect().right : null,
    dot: box ? { w: Math.round(box.width), h: Math.round(box.height), bg: cs.backgroundColor, opacity: cs.opacity } : null,
  };
});
check(
  'T13① 开录后 isRecording 为真且状态栏红点亮起',
  recState.recording === true && recState.cellHidden === false,
  JSON.stringify(recState),
);
const dotOk = !!recState.dot && recState.dot.w >= 6 && recState.dot.h >= 6 && !/rgba\(0, 0, 0, 0\)/.test(recState.dot.bg);
check('T13①b 红点是真实渲染的红点（非零尺寸 + 非透明底色）', dotOk, JSON.stringify(recState.dot));
check('T13①c 录制胶囊位于状态栏右侧（右下角红点）', recState.cellsRight === true, `right=${recState.cellsRight}`);

await page.evaluate(() => window.quillpad.run('edit.upperCase'));
await wait(300);
// 停止录制会弹「宏名称」输入框：填名字再点保存
await page.evaluate(() => window.quillpad.run('macro.record'));
await wait(500);
const nameInput = page.locator('#overlay-root input').first();
let promptShown = 0;
if ((promptShown = await nameInput.count()) > 0) {
  await nameInput.fill('测试宏');
  await page.locator('#overlay-root [data-action-index="1"]').first().click();
}
await wait(600);
check('T13② 停止录制时要求命名（弹输入框）', promptShown === 1, `prompt=${promptShown}`);

const macroSaved = await page.evaluate(async () => {
  const u = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/core/macro.js')) || '/src/core/macro.js';
  const m = await import(u);
  const list = m.getMacros();
  return {
    recording: m.isRecording(),
    count: list.length,
    steps: (list[0] && list[0].steps.map((s) => s.cmd)) || [],
    cellHidden: document.querySelector('[data-cell="macro"]') ? document.querySelector('[data-cell="macro"]').hidden : null,
  };
});
check(
  'T13③ 保存后落库 1 条宏，且只记命令层（不含 macro.record 自身）',
  macroSaved.recording === false &&
    macroSaved.count === 1 &&
    macroSaved.steps.includes('edit.upperCase') &&
    !macroSaved.steps.includes('macro.record'),
  JSON.stringify(macroSaved),
);
check('T13④ 停止录制后红点熄灭', macroSaved.cellHidden === true, `hidden=${macroSaved.cellHidden}`);

await setDoc('hello world');
await page.evaluate(() => window.quillpad.run('macro.play'));
await wait(900);
const afterPlay = await docText();
check('T13⑤ 回放把宏里的命令重放到当前文档', afterPlay === 'HELLO WORLD', JSON.stringify(afterPlay));

/* ============================================================== T14 列编辑 */
group('T14 列（矩形）编辑 4 命令');

await setDoc('aaa\nbbb\nccc');
const colInserted = await page.evaluate(async () => {
  const cols = await import('/src/editor/columns.js');
  const view = window.quillpad.editor.view;
  cols.selectRect(view, { startLine: 1, endLine: 3, col: 1, width: 1 });
  const info = cols.rectInfo(view.state);
  const res = cols.columnInsert(view, '> ');
  return { info, res, doc: view.state.doc.toString() };
});
check(
  'T14① 矩形选区识别 + 列插入（一次事务改 3 行）',
  colInserted.info && colInserted.info.lineCount === 3 && colInserted.doc === 'a> aa\nb> bb\nc> cc',
  JSON.stringify(colInserted.doc),
);

const colNumbered = await page.evaluate(async () => {
  const cols = await import('/src/editor/columns.js');
  const view = window.quillpad.editor.view;
  window.quillpad.setTabContent(window.quillpad.state.activeTabId, 'x\ny\nz');
  const v2 = window.quillpad.editor.view;
  cols.selectRect(v2, { startLine: 1, endLine: 3, col: 0, width: 1 });
  const res = cols.columnNumber(v2, { start: 1 });
  return { res, doc: v2.state.doc.toString(), view };
});
check(
  'T14② 列编号 1..N',
  colNumbered.doc === '1x\n2y\n3z',
  JSON.stringify(colNumbered.doc),
);

const noRectToast = await page.evaluate(async () => {
  const view = window.quillpad.editor.view;
  view.dispatch({ selection: { anchor: 0, head: 0 } });
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const res = await window.quillpad.run('edit.columnDelete');
  await new Promise((r) => setTimeout(r, 260));
  const texts = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
  return { result: res && res.result, texts };
});
check(
  'T14③ 无矩形选区时命令不执行并 toast 提示（不静默失败）',
  noRectToast.result === false && noRectToast.texts.some((t) => /矩形/.test(t)),
  JSON.stringify(noRectToast),
);

const colStatus = await page.evaluate(async () => {
  const cols = await import('/src/editor/columns.js');
  const view = window.quillpad.editor.view;
  cols.selectRect(view, { startLine: 1, endLine: 2, col: 1, width: 1 });
  window.quillpad.statusbar.update();
  const cell = document.querySelector('[data-cell="colmode"]');
  return { hidden: cell ? cell.hidden : null, text: cell ? cell.textContent : '' };
});
check(
  'T14④ 状态栏出现「列 N · M 行」提示',
  colStatus.hidden === false && /列\s*\d+/.test(colStatus.text),
  JSON.stringify(colStatus),
);

/* ========================================================= T15 查找历史/字符 */
group('T15 查找历史 + 特殊字符面板');

await setDoc('alpha beta alpha\n');
await page.evaluate(() => localStorage.removeItem('quillpad.findHistory.v1'));
await page.locator('.cm-content').click();
await page.keyboard.press('Control+h');
await wait(500);
await page.locator('.qp-search [data-role="search"]').fill('alpha');
await wait(300);
await page.keyboard.press('Enter');
await wait(400);

const historyRaw = await page.evaluate(() => window.localStorage.getItem('quillpad.findHistory.v1'));
check('T15① 用过的查找词写进历史（localStorage）', /alpha/.test(historyRaw || ''), String(historyRaw).slice(0, 60));

await page.locator('.qp-search [data-act="close"]').click();
await wait(250);
await page.keyboard.press('Control+h');
await wait(500);
await page.locator('.qp-search [data-act="history"]').click();
await wait(300);
const historyItems = await page.locator('.qp-search__history-item').allInnerTexts();
check('T15② H 按钮展开历史下拉并列出历史词', historyItems.includes('alpha'), `[${historyItems.join(',')}]`);

await page.locator('.qp-search [data-role="search"]').fill('');
await wait(250); // 输入事件会把下拉收起
await page.locator('.qp-search [data-role="search"]').press('ArrowDown');
await wait(400);
const filled = await page.locator('.qp-search [data-role="search"]').inputValue();
check('T15③ 空输入框按 ↓ 回填最近一条历史', filled === 'alpha', JSON.stringify(filled));

await page.locator('.qp-search [data-act="close"]').click();
await wait(250);

await setDoc('前文：\n');
await page.evaluate(() => window.quillpad.editor.gotoPos(window.quillpad.editor.view.state.doc.length, 0));
await page.evaluate(() => window.quillpad.run('insert.char'));
await wait(500);
const charsOpen = await page.locator('[data-dialog="chars"]').count();
await page.locator('[data-dialog="chars"] [data-role="search"]').fill('4E2D');
await wait(350);
const cellCount = await page.locator('[data-dialog="chars"] .qp-chars__cell').count();
await page.locator('[data-dialog="chars"] .qp-chars__cell[data-char="中"]').first().click();
await wait(400);
const afterChar = await docText();
await page.evaluate(() => {
  const close = document.querySelector('[data-dialog="chars"] [data-role="close"]');
  if (close) close.click();
});
await wait(250);
check('T15④ 特殊字符面板可打开并按码位 4E2D 检索', charsOpen === 1 && cellCount >= 1, `cells=${cellCount}`);
check('T15⑤ 点选字符后插入到光标处', afterChar.includes('中'), JSON.stringify(afterChar));

/* ============================================================ T16 排版 token */
group('T16 排版 token 与减少动效');

const printTokens = await page.evaluate(async () => {
  const P = window.quillpad.print;
  const built = await P.buildPrintHtml(
    { markdown: '# 标题\n\n正文一段。', title: 't', name: 'a.md', docDir: null },
    P.defaultPdfOptions({}, { name: 'a.md' }),
  );
  const h1Rule = /\.qp-print h1\s*\{[^}]*\}/.exec(built.html);
  return {
    body: /--qp-body-size:\s*16px/.test(built.html),
    measure: /--qp-measure:\s*46em/.test(built.html),
    leading: /--qp-body-leading:\s*1\.75/.test(built.html),
    h1: h1Rule ? h1Rule[0] : '',
  };
});
check(
  'T16① 打印版式复用 WYSIWYG token（16px / 46em / 1.75）',
  printTokens.body && printTokens.measure && printTokens.leading,
  JSON.stringify({ body: printTokens.body, measure: printTokens.measure, leading: printTokens.leading }),
);
check('T16② 打印 H1 不带 border-bottom', !/border-bottom/.test(printTokens.h1), printTokens.h1.slice(0, 60));

await page.evaluate(() => window.quillpad.run('view.preview'));
await wait(600);
const editorType = await page.evaluate(() => {
  const el = document.querySelector('.markdown-body');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const h1 = el.querySelector('h1');
  return {
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    maxWidth: cs.maxWidth,
    h1Border: h1 ? getComputedStyle(h1).borderBottomWidth : 'no-h1',
  };
});
check(
  'T16③ 编辑区正文 16px / 行高 1.75 / 版心 46em',
  !!editorType &&
    editorType.fontSize === '16px' &&
    Math.abs(parseFloat(editorType.lineHeight) - 28) <= 1 &&
    Math.abs(parseFloat(editorType.maxWidth) - 736) <= 2,
  JSON.stringify(editorType),
);
check(
  'T16④ 编辑区 H1 去掉下边框',
  !!editorType && (editorType.h1Border === '0px' || editorType.h1Border === 'no-h1'),
  `${editorType && editorType.h1Border}`,
);
await page.evaluate(() => window.quillpad.run('view.preview'));
await wait(400);

await page.evaluate(() => window.quillpad.run('view.reduceMotion'));
await wait(400);
const rmOn = await page.evaluate(() => document.documentElement.dataset.reduceMotion);
await page.evaluate(() => window.quillpad.run('view.reduceMotion'));
await wait(300);
const rmOff = await page.evaluate(() => document.documentElement.dataset.reduceMotion);
check(
  'T16⑤ view.reduceMotion 双通道生效（可开可关）',
  ['on', 'true'].includes(rmOn) && !['on', 'true'].includes(rmOff),
  `on=${rmOn} off=${rmOff}`,
);

/* ================================================================ 收尾 */
check('全流程无 console error', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = results.filter((r) => !r.ok);
console.log(`\n===== v2-check 结果 =====\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(` - ${f.n} :: ${f.d}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
