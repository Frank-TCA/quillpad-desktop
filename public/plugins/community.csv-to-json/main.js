/**
 * QuillPad 社区示例插件 · CSV 转 JSON（ISC）· 1 条命令
 *
 * 支持双引号包裹与 "" 转义的单元格、CRLF/LF 混排、跳过空行。
 * 首行当表头；数字与布尔会自动转型，其余保持字符串。
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
 * 拆一行 CSV（处理引号包裹与 "" 转义）。
 * @param {string} line
 * @return {string[]}
 */
function splitRow(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * 单元格字面量 → 合理类型。
 * @param {string} text
 * @return {string|number|boolean}
 */
function coerce(text) {
  if (text === '') return '';
  if (/^-?\d+$/.test(text) || /^-?\d+\.\d+$/.test(text)) return Number(text);
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  return text;
}

/**
 * CSV 文本 → 对象数组。
 * @param {string} text
 * @return {{ok: true, rows: object[]}|{ok: false, reason: string}}
 */
function csvToRows(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return { ok: false, reason: '至少需要表头 + 一行数据' };
  const header = splitRow(lines[0]);
  if (header.length < 2) return { ok: false, reason: '看起来不是逗号分隔的表格' };
  const rows = lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row = {};
    header.forEach((key, index) => {
      const name = key || `列${index + 1}`;
      row[name] = coerce(cells[index] === undefined ? '' : cells[index]);
    });
    return row;
  });
  return { ok: true, rows };
}

quillpad.commands.register('to-json', 'CSV 转 JSON 数组', async () => {
  const text = await readSelection();
  const parsed = csvToRows(text);
  if (!parsed.ok) {
    await quillpad.ui.showToast(parsed.reason, 'info');
    return false;
  }
  await writeSelection(JSON.stringify(parsed.rows, null, 2));
  await quillpad.ui.showToast(`已转换 ${parsed.rows.length} 行`, 'info');
  return true;
});
