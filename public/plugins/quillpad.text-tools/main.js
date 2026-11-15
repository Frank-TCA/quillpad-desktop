/**
 * QuillPad 官方插件 · 文本处理包（MIT）· 13 条命令
 *
 * 运行在 module Worker 沙箱里，只能通过 self.quillpad 提供的冻结 API
 * 读写选区；不触碰 DOM、不使用全局网络能力。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 安全的 Base64 编码。 */
function toBase64(input) {
  const bytes = encoder.encode(String(input));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** UTF-8 安全的 Base64 解码。 */
function fromBase64(input) {
  try {
    const binary = atob(String(input).trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch (err) {
    return null;
  }
}

/** 读取当前选区文本（无选区返回空串）。 */
async function readSelection() {
  const result = await quillpad.editor.getSelection();
  return result && typeof result.text === 'string' ? result.text : '';
}

/** 用新文本替换当前选区。 */
async function writeSelection(text) {
  await quillpad.editor.replaceSelection(String(text));
}

/** 拆成行。 */
function toLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

/** 对每一行做变换（保留尾随换行）。 */
function mapLines(text, fn) {
  const trailing = /\n$/.test(text) ? '\n' : '';
  const body = text.replace(/\n$/, '');
  return fn(toLines(body)).join('\n') + trailing;
}

/** 需要选区，没有就提示。 */
async function withSelection(fn) {
  const text = await readSelection();
  if (!text) {
    await quillpad.ui.showToast('请先选中一段文本', 'info');
    return;
  }
  try {
    const out = fn(text);
    if (out === null || out === undefined) {
      await quillpad.ui.showToast('输入格式不合法，未做修改', 'error');
      return;
    }
    await writeSelection(out);
  } catch (err) {
    await quillpad.ui.showToast('处理失败：' + String(err && err.message), 'error');
  }
}

/** 标题式大小写（中文原样保留）。 */
function titleCase(text) {
  return text.replace(/[A-Za-z][A-Za-z']*/g, (word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** 按分隔符对齐成表格。 */
function alignColumns(text) {
  const rows = toLines(text).map((line) => line.split(/\s*\|\s*/));
  if (!rows.length || rows[0].length < 2) return text;
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, cell.length); });
  }
  return rows.map((row) =>
    row.map((cell, i) => String(cell).padEnd(widths[i] || 0, ' ')).join(' | ')).join('\n');
}

/** JSON 美化（失败返回 null）。 */
function formatJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return null;
  }
}

const commands = [
  ['upper', '转为大写', (t) => t.toUpperCase()],
  ['lower', '转为小写', (t) => t.toLowerCase()],
  ['title-case', '标题式大小写', titleCase],
  ['sort-asc', '行升序排序', (t) => mapLines(t, (ls) => ls.slice().sort((a, b) => a.localeCompare(b, 'zh-CN')))],
  ['sort-desc', '行降序排序', (t) => mapLines(t, (ls) => ls.slice().sort((a, b) => b.localeCompare(a, 'zh-CN')))],
  ['dedupe', '删除重复行', (t) => mapLines(t, (ls) => [...new Set(ls)])],
  ['remove-empty', '删除空行', (t) => mapLines(t, (ls) => ls.filter((x) => x.trim().length > 0))],
  ['reverse', '反转行序', (t) => mapLines(t, (ls) => ls.slice().reverse())],
  ['base64-encode', 'Base64 编码', toBase64],
  ['base64-decode', 'Base64 解码', fromBase64],
  ['url-encode', 'URL 编码', (t) => encodeURIComponent(t)],
  ['json-format', 'JSON 格式化', formatJson],
  ['align-columns', '按分隔符对齐列', alignColumns],
];

for (const [id, title, fn] of commands) {
  quillpad.commands.register(id, title, async () => {
    await withSelection(fn);
    return true;
  });
}
