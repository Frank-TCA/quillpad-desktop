/**
 * QuillPad 官方插件 · 开发者工具包（MIT）· 4 条命令 + 1 个侧栏视图
 *
 * 侧栏视图按架构「事实校正 #14」只登记声明式元数据，不返回 DOM 节点。
 */

const MIME = Object.freeze({
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'application/typescript',
  css: 'text/css',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  wasm: 'application/wasm',
});

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
    await quillpad.ui.showToast('请先选中一段文本', 'info');
    return;
  }
  await writeSelection(fn(text));
}

/** 用选区第一行做正则，其余行做被测文本，输出逐行命中结果。 */
function regexTrainer(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const pattern = lines.shift() || '';
  let re;
  try {
    re = new RegExp(pattern, 'g');
  } catch (err) {
    return '无效正则：' + pattern;
  }
  const out = ['/ ' + pattern + ' /g', ''];
  for (const line of lines) {
    const hits = line.match(re) || [];
    out.push((hits.length ? '✓' : '·') + ' ' + line + (hits.length ? '  → ' + hits.join(' , ') : ''));
    re.lastIndex = 0;
  }
  return out.join('\n');
}

/** 把选区转义成可嵌入 JSON 的字符串字面量。 */
function jsonEscape(text) {
  return JSON.stringify(text);
}

/** 查表给出 MIME。 */
function mimeLookup(text) {
  const name = String(text).trim();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** 代码行排序：保留空行位置，只排非空行。 */
function lineSorter(text) {
  const trailing = /\n$/.test(text) ? '\n' : '';
  const lines = text.replace(/\n$/, '').split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  let i = 0;
  const out = lines.map((l) => (l.trim() ? nonEmpty[i++] : l));
  return out.join('\n') + trailing;
}

const handlers = [
  ['regex-trainer', '正则匹配练习', regexTrainer],
  ['json-escape', 'JSON 字符串转义', jsonEscape],
  ['mime-lookup', 'MIME 类型查询', mimeLookup],
  ['line-sorter', '代码行排序', lineSorter],
];

for (const [id, title, fn] of handlers) {
  quillpad.commands.register(id, title, async () => {
    await withSelection(fn);
    return true;
  });
}

quillpad.ui.registerSidebarView({
  id: 'dev-panel',
  title: '开发者面板',
  render: () => ({ type: 'text', value: '4 条开发者命令已就绪：正则练习 / JSON 转义 / MIME 查询 / 代码行排序' }),
});
