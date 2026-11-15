/**
 * QuillPad 官方插件 · Markdown 增强包（MIT）· 4 条命令
 *
 * 只处理选区文本，不读取磁盘、不访问网络。
 */

/** 读取选区。 */
async function readSelection() {
  const result = await quillpad.editor.getSelection();
  return result && typeof result.text === 'string' ? result.text : '';
}

/** 替换选区。 */
async function writeSelection(text) {
  await quillpad.editor.replaceSelection(String(text));
}

/** 需要选区。 */
async function withSelection(fn) {
  const text = await readSelection();
  if (!text) {
    await quillpad.ui.showToast('请先选中一段 Markdown 文本', 'info');
    return;
  }
  await writeSelection(fn(text));
}

/** 把 GFM 表格的每列补齐到等宽，并统一分隔行。 */
function normalizeTable(text) {
  const rows = text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim());
  if (rows.length < 2) return text;
  const cells = rows.map((line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
  const count = Math.max(...cells.map((r) => r.length));
  if (count < 2) return text;
  const widths = new Array(count).fill(3);
  cells.forEach((row, ri) => {
    if (ri === 1 && row.every((c) => /^:?-{1,}:?$/.test(c))) return;
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length); });
  });
  return cells.map((row, ri) => {
    const padded = [];
    for (let i = 0; i < count; i += 1) {
      const cell = row[i] || '';
      if (ri === 1 && /^:?-{1,}:?$/.test(cell)) {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        padded.push((left ? ':' : '-') + '-'.repeat(Math.max(1, widths[i] - (left ? 1 : 0) - (right ? 1 : 0))) + (right ? ':' : '-'));
      } else {
        padded.push(cell.padEnd(widths[i], ' '));
      }
    }
    return '| ' + padded.join(' | ') + ' |';
  }).join('\n');
}

/** 按 H1–H3 生成无序目录。 */
function generateToc(text) {
  const out = ['[TOC]', ''];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const hit = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (!hit) continue;
    const level = hit[1].length;
    const slug = hit[2].toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '');
    out.push('  '.repeat(level - 1) + '- [' + hit[2] + '](#' + slug + ')');
  }
  return out.join('\n');
}

/** 在选区末尾追加脚注引用与定义。 */
function insertFootnote(text) {
  const stamp = String(Date.now()).slice(-6);
  return text + '[^' + stamp + ']\n\n[^' + stamp + ']: 在此填写脚注内容\n';
}

/** 中英字数 + 阅读时长（中文 300 字/分钟，英文 200 词/分钟）。 */
function wordCount(text) {
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9']+/g) || []).length;
  const minutes = Math.max(1, Math.round(chinese / 300 + words / 200));
  return '中文 ' + chinese + ' 字 · 英文 ' + words + ' 词 · 约 ' + minutes + ' 分钟';
}

let footnoteSeq = 0;
const handlers = [
  ['normalize-table', '规范表格对齐', async (t) => normalizeTable(t)],
  ['generate-toc', '生成目录', async (t) => generateToc(t)],
  ['insert-footnote', '插入脚注', async (t) => { footnoteSeq += 1; return insertFootnote(t); }],
  ['word-count', '字数与阅读时长', async (t) => {
    const info = wordCount(t);
    await quillpad.ui.showToast(info, 'info');
    return t;
  }],
];

for (const [id, title, fn] of handlers) {
  quillpad.commands.register(id, title, async () => {
    const text = await readSelection();
    if (!text) {
      await quillpad.ui.showToast('请先选中一段文本', 'info');
      return true;
    }
    await writeSelection(await fn(text));
    return true;
  });
}
