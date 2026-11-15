/**
 * QuillPad 社区示例插件 · 行排序增强（BSD-2-Clause）· 4 条命令
 *
 * 只排非空行，空行留在原位（和官方 text-tools 的「行升序排序」保持同一手感）；
 * 末尾换行按原样保留，避免反复操作后文件尾部空行越积越多。
 */

/** 读取当前选区文本。 */
async function readSelection() {
  const result = await quillpad.editor.getSelection();
  return result && typeof result.text === 'string' ? result.text : '';
}

/** 用结果替换选区。 */
async function writeSelection(text) {
  await quillpad.editor.replaceSelection(String(text));
}

/**
 * 拆成 { lines, trailing }，trailing 记录原来是否以换行结尾。
 * @param {string} text
 * @return {{lines: string[], trailing: string}}
 */
function splitLines(text) {
  const trailing = /\n$/.test(text) ? '\n' : '';
  return { lines: String(text || '').replace(/\n$/, '').split('\n'), trailing };
}

/**
 * 按比较函数重排非空行，空行位置不动。
 * @param {string} text
 * @param {(a: string, b: string) => number} compare
 * @return {string}
 */
function sortKeepingBlanks(text, compare) {
  const { lines, trailing } = splitLines(text);
  const nonEmpty = lines.filter((line) => line.trim() !== '').sort(compare);
  let cursor = 0;
  const out = lines.map((line) => (line.trim() === '' ? line : nonEmpty[cursor++]));
  return out.join('\n') + trailing;
}

/**
 * 取行首数字（没有则视为 +Infinity，排到最后）。
 * @param {string} line
 * @return {number}
 */
function leadingNumber(line) {
  const match = /^[\s"'([{-]*(-?\d+(?:\.\d+)?)/.exec(line);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/**
 * 删除相邻重复行（保留第一次出现的位置）。
 * @param {string} text
 * @return {string}
 */
function dedupeAdjacent(text) {
  const { lines, trailing } = splitLines(text);
  const out = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
  }
  return out.join('\n') + trailing;
}

/**
 * 读选区 → 转换 → 回写。
 * @param {(text: string) => string} transform
 * @return {Promise<boolean>}
 */
async function run(transform) {
  const text = await readSelection();
  if (!String(text).trim()) {
    await quillpad.ui.showToast('请先选中要排序的文本', 'info');
    return false;
  }
  await writeSelection(transform(text));
  return true;
}

quillpad.commands.register('by-length', '按行长排序', () =>
  run((text) => sortKeepingBlanks(text, (a, b) => a.length - b.length || a.localeCompare(b, 'zh-CN'))));

quillpad.commands.register('by-numeric', '按行首数字排序', () =>
  run((text) => sortKeepingBlanks(text, (a, b) => leadingNumber(a) - leadingNumber(b) || a.localeCompare(b, 'zh-CN'))));

quillpad.commands.register('natural', '按自然序排序', () =>
  run((text) => sortKeepingBlanks(text, (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))));

quillpad.commands.register('dedupe-adjacent', '删除相邻重复行', () =>
  run(dedupeAdjacent));
