/**
 * QuillPad 社区示例插件 · JSON Schema 速查（BSD-3-Clause）· 1 条命令
 *
 * 从选中的 JSON 推断一份「最小可用」schema：只给 type / properties / items /
 * required，不做 anyOf、pattern、format 这些需要业务语义的推断。
 * 顶层为数组时取首元素作为 items 的形状，空数组只给 type。
 */

const MAX_DEPTH = 5;

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
 * JSON 值 → schema 类型名。
 * @param {any} value
 * @return {string}
 */
function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * 递归推断 schema。
 * @param {any} value
 * @param {number} depth
 * @return {object}
 */
function schemaOf(value, depth) {
  const type = typeOf(value);
  if (depth >= MAX_DEPTH) return { type };
  if (type === 'array') {
    const schema = { type: 'array' };
    if (value.length > 0) schema.items = schemaOf(value[0], depth + 1);
    return schema;
  }
  if (type === 'object') {
    const properties = {};
    const keys = Object.keys(value);
    for (const key of keys) properties[key] = schemaOf(value[key], depth + 1);
    const schema = { type: 'object', properties };
    const required = keys.filter((key) => value[key] !== null && value[key] !== undefined);
    if (required.length > 0) schema.required = required;
    return schema;
  }
  return { type };
}

/**
 * 生成带 $schema 头的完整片段。
 * @param {any} value
 * @return {string}
 */
function buildSchema(value) {
  const body = schemaOf(value, 0);
  const merged = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...body };
  return JSON.stringify(merged, null, 2);
}

quillpad.commands.register('make-schema', '由选中 JSON 生成 Schema', async () => {
  const text = await readSelection();
  const raw = String(text || '').trim();
  if (!raw) {
    await quillpad.ui.showToast('请先选中一段 JSON 文本', 'info');
    return false;
  }
  let value = null;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    const detail = err && err.message ? err.message : '语法错误';
    await quillpad.ui.showToast(`JSON 解析失败：${detail}`, 'info');
    return false;
  }
  await writeSelection(buildSchema(value));
  return true;
});
