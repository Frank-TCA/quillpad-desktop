/**
 * QuillPad 社区示例插件 · JSON 格式化助手（Apache-2.0）· 2 条命令
 *
 * 只处理选区文本：读取 → 解析 → 回写。不读取磁盘、不访问网络。
 * 刻意不用正则去「修」JSON：解析失败就如实报错，避免静默改坏数据。
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
 * 解析选区里的 JSON。
 * @param {string} text
 * @return {{ok: true, value: any}|{ok: false, reason: string}}
 */
function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: '请先选中一段 JSON 文本' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const detail = err && err.message ? err.message : '语法错误';
    return { ok: false, reason: `JSON 解析失败：${detail}` };
  }
}

/**
 * 读选区 → 转换 → 回写。
 * @param {(value: any) => string} transform
 * @return {Promise<boolean>}
 */
async function run(transform) {
  const text = await readSelection();
  const parsed = parseJson(text);
  if (!parsed.ok) {
    await quillpad.ui.showToast(parsed.reason, 'info');
    return false;
  }
  await writeSelection(transform(parsed.value));
  return true;
}

quillpad.commands.register('format', '格式化为 2 空格缩进', () =>
  run((value) => JSON.stringify(value, null, 2)));

quillpad.commands.register('minify', '压缩成单行', () =>
  run((value) => JSON.stringify(value)));
