/**
 * QuillPad · 表格模型（纯函数，无 DOM）
 *
 * 设计要点：
 * - `parseTable(text)` **保真**保存了原始排版（行首/行尾竖线、单元格两侧空格、
 *   分隔行每列的短横数量），因此 `serializeTable(parseTable(x)).text === x`
 *   对任意合法 GFM 表格成立 —— 这是 T06 验收⑥与「撤销后逐项复原」的地基。
 * - 单元格文本以**原始（已转义）形态**存储：显示时走 `unescapeCell`，写回时走
 *   `escapeCell`。这样未编辑的单元格字节级不变。
 * - 列宽 `computeWidths` 是纯函数（内容长度加权 + 最小 8% + 和恰为 100），
 *   所以「撤销一次 → colgroup 宽度数组逐项相同」是**结构保证**，不依赖时序。
 */

/** @typedef {'left'|'center'|'right'|null} TableAlign */

/**
 * @typedef {object} TableModel
 * @property {number} from 块起始偏移
 * @property {number} to 块结束偏移（不含）
 * @property {string[]} headers 表头单元格（原始转义形态）
 * @property {TableAlign[]} aligns 对齐
 * @property {string[][]} rows 数据行（不含表头与分隔行）
 * @property {number[]} widths 百分比列宽，和为 100
 * @property {string[]} rawLines 原始行文本
 * @property {number[]} dashes 分隔行每列的短横数量（保真用）
 * @property {boolean} lead 行首是否有 `|`
 * @property {boolean} trail 行尾是否有 `|`
 * @property {boolean} pad 单元格两侧是否有单个空格
 */

/** 单元格最小列宽（百分比）。 */
export const MIN_COL_PCT = 8;

/**
 * 拆分一行为单元格（保留 `\|` 转义）。
 * @param {string} line
 * @return {{cells: string[], lead: boolean, trail: boolean}}
 */
function splitRow(line) {
  let s = String(line).trim();
  const lead = s.startsWith('|');
  if (lead) s = s.slice(1);
  const trail = s.endsWith('|') && !s.endsWith('\\|');
  if (trail) s = s.slice(0, -1);
  /** @type {string[]} */
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return { cells, lead, trail };
}

/**
 * 这一行是否含**未转义**的竖线（即「像一条表格行」）。
 *
 * 用途：判定表格块到哪里结束。GFM 规范里表格要一直续到空行或另一个块级结构，
 * 所以 `| a | b |` 下面紧跟的 `你好` 会被规范当成一行（`你好` + 空单元格）——
 * GitHub 与 marked 都是这个行为。但在编辑器里这就成了「表下正文被吞进表格」，
 * 而且任何一次表格操作（切换对齐等）都会把那一行**改写成真正的表格行**写回源文件。
 * 因此 QuillPad 的渲染统一采用更符合直觉的规则：**不含竖线的行结束表格**。
 *
 * @param {string} line
 * @return {boolean}
 */
export function rowHasPipe(line) {
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1; // 跳过被转义的字符（`\|` 不是分隔符）
      continue;
    }
    if (s[i] === '|') return true;
  }
  return false;
}

/**
 * 是否为合法的分隔行（只允许 `-` `:` `|` 空格）。
 * @param {string} line
 * @return {boolean}
 */
export function isDelimiterRow(line) {
  const s = String(line).trim();
  if (!s.includes('-')) return false;
  if (!/^[|\s:-]+$/.test(s)) return false;
  const { cells } = splitRow(s);
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

/**
 * 解析分隔行，得到对齐与短横数量。
 * @param {string} line
 * @return {{aligns: TableAlign[], dashes: number[]}}
 */
function parseDelimiter(line) {
  const { cells } = splitRow(line);
  /** @type {TableAlign[]} */
  const aligns = [];
  /** @type {number[]} */
  const dashes = [];
  for (const raw of cells) {
    const c = raw.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    dashes.push(Math.max(1, (c.match(/-/g) || []).length));
    if (left && right) aligns.push('center');
    else if (left) aligns.push('left');
    else if (right) aligns.push('right');
    else aligns.push(null);
  }
  return { aligns, dashes };
}

/**
 * 解析一段表格源码。
 *
 * @param {string} text 表格块源码（不含前后空行）
 * @param {number} [from] 块起始偏移
 * @param {number} [to] 块结束偏移
 * @return {TableModel|null}
 */
export function parseTable(text, from = 0, to = from + String(text || '').length) {
  if (typeof text !== 'string' || !text) return null;
  const rawLines = text.split('\n');
  if (rawLines.length < 2) return null;
  if (!isDelimiterRow(rawLines[1])) return null;

  const headerRow = splitRow(rawLines[0]);
  const { aligns, dashes } = parseDelimiter(rawLines[1]);
  const colCount = Math.max(headerRow.cells.length, aligns.length);
  if (colCount < 1) return null;

  const headers = [];
  for (let i = 0; i < colCount; i += 1) headers.push((headerRow.cells[i] || '').trim());

  /** @type {string[][]} */
  const rows = [];
  /* 只把「含竖线」的行当数据行：解析器（lezer 的 GFM 表格）会把紧随表格的
     普通正文行也算进 Table 节点，逐行吃掉。这里做一次截断，`to` / `rawLines`
     一起收窄 —— 否则序列化时会把那些行的内容当成单元格写回去，用户的正文就没了。 */
  let used = 2;
  for (let i = 2; i < rawLines.length; i += 1) {
    if (!rowHasPipe(rawLines[i])) break;
    used = i + 1;
    const { cells } = splitRow(rawLines[i]);
    /** @type {string[]} */
    const row = [];
    for (let c = 0; c < colCount; c += 1) row.push((cells[c] || '').trim());
    rows.push(row);
  }

  const keptLines = rawLines.slice(0, used);

  const firstCell = headerRow.cells[0] || '';
  const model = {
    from,
    to: from + keptLines.join('\n').length,
    headers,
    aligns,
    rows,
    widths: [],
    rawLines: keptLines,
    dashes: dashes.length === colCount ? dashes : new Array(colCount).fill(3),
    lead: headerRow.lead,
    trail: headerRow.trail,
    pad: /^\s/.test(firstCell) || /\s$/.test(firstCell),
  };
  model.widths = computeWidths(model);
  return model;
}

/**
 * 单元格内容长度（用于列宽加权；中日韩按 2 列宽）。
 * @param {string} cell
 * @return {number}
 */
function cellWeight(cell) {
  const text = unescapeCell(cell || '');
  let n = 0;
  for (const ch of text) {
    n += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  }
  return n;
}

/**
 * 列宽：内容长度加权 + 最小 8%，和恰为 100。纯函数 → 撤销后必然复原。
 * @param {{headers: string[], rows: string[][], aligns?: TableAlign[], widths?: number[]}} model
 * @return {number[]}
 */
export function computeWidths(model) {
  const colCount = Math.max(1, (model.headers || []).length);
  const weights = new Array(colCount).fill(0);
  const feed = (row) => {
    for (let c = 0; c < colCount; c += 1) {
      const raw = (row && row[c]) || '';
      weights[c] = Math.max(weights[c], cellWeight(raw));
    }
  };
  feed(model.headers || []);
  for (const row of model.rows || []) feed(row);

  // 0.65 次方压缩长短差异，避免长列吃掉全部宽度
  const raw = weights.map((w) => Math.pow(Math.max(w, 4), 0.65));
  const total = raw.reduce((a, b) => a + b, 0) || colCount;

  const pct = raw.map((w) => Math.max(MIN_COL_PCT, Math.round((w / total) * 100)));

  // 修正到恰好 100：差额加到最宽的列（保持确定性 → 撤销后数组逐项相同）
  let diff = 100 - pct.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard < 200) {
    const idx = diff > 0 ? widestIndex(pct) : widestIndex(pct);
    const step = diff > 0 ? 1 : -1;
    if (pct[idx] + step < MIN_COL_PCT) {
      // 防死循环：所有列都已到下限（列数 > 12 时可能出现），放宽下限
      pct[idx] += step;
    } else {
      pct[idx] += step;
    }
    diff = 100 - pct.reduce((a, b) => a + b, 0);
    guard += 1;
  }
  return pct;
}

/**
 * 最宽列的下标（并列时取靠前者，保证确定性）。
 * @param {number[]} pct
 * @return {number}
 */
function widestIndex(pct) {
  let idx = 0;
  for (let i = 1; i < pct.length; i += 1) {
    if (pct[i] > pct[idx]) idx = i;
  }
  return idx;
}

/**
 * 生成分隔行的一个单元格。
 * @param {TableAlign} align
 * @param {number} dashes
 * @return {string}
 */
function delimiterCell(align, dashes) {
  const dash = '-'.repeat(Math.max(1, dashes || 3));
  if (align === 'center') return `:${dash}:`;
  if (align === 'left') return `:${dash}`;
  if (align === 'right') return `${dash}:`;
  return dash;
}

/**
 * 把一行单元格拼回源码（保真 lead/trail/pad）。
 * @param {string[]} cells
 * @param {{lead: boolean, trail: boolean, pad: boolean}} shape
 * @return {string}
 */
function joinRow(cells, shape) {
  const body = cells.map((c) => (shape.pad ? ` ${c} ` : c)).join('|');
  return `${shape.lead ? '|' : ''}${body}${shape.trail ? '|' : ''}`;
}

/**
 * 序列化表格模型。
 * @param {TableModel} model
 * @return {{text: string, from: number, to: number}}
 */
export function serializeTable(model) {
  const shape = { lead: model.lead, trail: model.trail, pad: model.pad };
  const lines = [];
  lines.push(joinRow(model.headers, shape));
  lines.push(
    joinRow(
      model.aligns.map((a, i) => delimiterCell(a, model.dashes?.[i] ?? 3)),
      shape,
    ),
  );
  for (const row of model.rows) {
    const cells = [];
    for (let c = 0; c < model.headers.length; c += 1) cells.push(row[c] ?? '');
    lines.push(joinRow(cells, shape));
  }
  return { text: lines.join('\n'), from: model.from, to: model.to };
}

/**
 * `|` → `\|`，换行 → `<br>`，去首尾空白。先反转义再转义，避免反斜杠累积。
 * @param {string} v
 * @return {string}
 */
export function escapeCell(v) {
  return String(v == null ? '' : v)
    .replace(/\\\|/g, '|')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
    .trim();
}

/**
 * `\|` → `|`，`<br>` → 换行。
 * @param {string} v
 * @return {string}
 */
export function unescapeCell(v) {
  return String(v == null ? '' : v)
    .replace(/\\\|/g, '|')
    .replace(/<br\s*\/?>/gi, '\n');
}

/**
 * 把单元格的编辑值写回模型（返回新模型，不改原对象）。
 * @param {TableModel} model
 * @param {number} r 行下标；-1 表示表头
 * @param {number} c 列下标
 * @param {string} value 用户输入的**未转义**文本
 * @return {TableModel}
 */
export function applyCellEdit(model, r, c, value) {
  const next = cloneModel(model);
  const raw = escapeCell(value);
  if (r < 0) next.headers[c] = raw;
  else if (next.rows[r]) next.rows[r][c] = raw;
  next.widths = computeWidths(next);
  return next;
}

/**
 * 深拷贝模型（禁止在操作里改原对象 → 撤销语义可预测）。
 * @param {TableModel} model
 * @return {TableModel}
 */
export function cloneModel(model) {
  return {
    from: model.from,
    to: model.to,
    headers: model.headers.slice(),
    aligns: model.aligns.slice(),
    rows: model.rows.map((r) => r.slice()),
    widths: (model.widths || []).slice(),
    rawLines: (model.rawLines || []).slice(),
    dashes: (model.dashes || []).slice(),
    lead: !!model.lead,
    trail: !!model.trail,
    pad: !!model.pad,
  };
}
