/**
 * QuillPad · 中文标点边界的强调补丁（loose emphasis）
 *
 * 为什么需要：CommonMark 的强调定界符有严格的中文「左右侧翼（flanking）」规则 ——
 * `**` 想开启强调，后面不能紧跟标点；`**` 想闭合强调，前面不能紧跟标点。
 * 中文句子里 `**“正文”**` 恰好两头都踩线（后是 `“`、前是 `”`），于是
 * **整段强调失效**，源码里的星号原样显示。同理 `*“斜体”*`、`~~“删除”~~`。
 *
 * 这条规则对英文写作是必要的（否则 `a*b*c` 到处误伤），但中文正文里
 * 「引号包住要加粗的话」极其常见，用户预期就是加粗。因此这里补一条**收窄**的
 * 豁免：仅当定界符**内侧紧邻字符是中文/全角标点**时才忽略 flanking 限制 ——
 * 只覆盖「中文标点贴边」这一种形态，英文与普通中文句子完全不受影响。
 *
 * 编辑器（`scan.js`）与预览/导出（`core/markdown.js` 的 marked 扩展）
 * **共用本模块**，保证同一份文档在两个窗格里长得一样。
 */

/** 中文 / 全角标点（不含全角字母 A-Z、a-z，它们仍按普通字符处理）。 */
const RE_CJK_PUNCT =
  /[\u3000-\u303F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00B7\u30FB"]/;

/**
 * 是否中文 / 全角标点。
 * @param {string} ch 单个字符
 * @return {boolean}
 */
export function isCjkPunct(ch) {
  return typeof ch === 'string' && ch.length === 1 && RE_CJK_PUNCT.test(ch);
}

/** 支持的定界符（长符优先，避免 `**` 被当成两个 `*`）。 */
const DELIMS = [
  { mark: '**', kind: 'strong' },
  { mark: '~~', kind: 'del' },
  { mark: '*', kind: 'em' },
];

/**
 * 取 `pos` 处的定界符。
 * @param {string} src
 * @param {number} pos
 * @return {{mark: string, kind: string}|null}
 */
function delimAt(src, pos) {
  for (const d of DELIMS) {
    if (!src.startsWith(d.mark, pos)) continue;
    // 更长的同字符串（`***`、`~~~~`）交给标准解析器，不接管
    if (src[pos + d.mark.length] === d.mark[0]) continue;
    if (d.mark === '*' && src[pos - 1] === '*') continue;
    return d;
  }
  return null;
}

/**
 * 在 `src` 的 `pos` 处尝试匹配一个「中文标点贴边」的强调对。
 *
 * @param {string} src 单行文本（调用方保证不含换行；含换行时遇 `\n` 放弃）
 * @param {number} pos 定界符起始下标
 * @return {{kind: string, mark: string, from: number, to: number,
 *           contentFrom: number, contentTo: number, content: string}|null}
 */
export function matchLooseEmphasis(src, pos = 0) {
  if (typeof src !== 'string' || pos < 0 || pos >= src.length) return null;
  if (pos > 0 && src[pos - 1] === '\\') return null; // 转义的 `\*`
  const d = delimAt(src, pos);
  if (!d) return null;

  const contentFrom = pos + d.mark.length;
  const first = src[contentFrom];
  if (!first || first === '\n' || first === ' ' || first === '\t') return null;

  // 找闭合定界符：不跨行、跳过转义、拒绝更长定界符串
  let closeFrom = -1;
  let i = contentFrom;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') return null;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (src.startsWith(d.mark, i) && src[i - 1] !== d.mark[0]) {
      const after = src[i + d.mark.length];
      if (after !== d.mark[0]) {
        closeFrom = i;
        break;
      }
    }
    i += 1;
  }
  if (closeFrom < 0) return null;

  const last = src[closeFrom - 1];
  if (!last || last === ' ' || last === '\t' || last === '\n') return null;

  // 收窄条件：至少一侧内侧紧邻中文/全角标点，否则交给标准解析器
  if (!isCjkPunct(first) && !isCjkPunct(last)) return null;

  return {
    kind: d.kind,
    mark: d.mark,
    from: pos,
    to: closeFrom + d.mark.length,
    contentFrom,
    contentTo: closeFrom,
    content: src.slice(contentFrom, closeFrom),
  };
}

/** 行内类型 → 编辑器标记类型（与 `scan.js` 的 MARK_KIND_BY_INLINE 对应）。 */
export const MARK_KIND = {
  strong: 'bold',
  em: 'italic',
  del: 'strike',
};

/**
 * 扫描一行里所有「中文标点贴边」的强调对。
 * @param {string} src
 * @return {Array<ReturnType<typeof matchLooseEmphasis>>}
 */
export function findLooseEmphasis(src) {
  const out = [];
  if (typeof src !== 'string' || (!src.includes('*') && !src.includes('~~'))) return out;
  let i = 0;
  while (i < src.length) {
    const m = matchLooseEmphasis(src, i);
    if (m) {
      out.push(m);
      i = m.to;
      continue;
    }
    i += 1;
  }
  return out;
}

/* ------------------------------------------------ 预览 / 导出侧：预处理 */

/** 代码围栏起始行（与 `core/markdown.js` 的判定一致）。 */
const RE_FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** 行内代码 span：`` `x` `` / ``` ``x`` ```。 */
const RE_CODESPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
/** 链接 / 图片目标 `](url)` 与引用式 `][id]`。 */
const RE_LINK_TARGET = /\][(（][^)）]*[)）]|\]\[[^\]]*\]/g;
/** 行内 HTML / 自动链接 `<…>`。 */
const RE_ANGLE = /<[^<>\n]*>/g;

/**
 * 收集本行内「不该被改写」的区间：行内代码、链接目标、尖括号标签。
 * @param {string} line
 * @return {Array<[number, number]>}
 */
function collectSkipRanges(line) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (const re of [RE_CODESPAN, RE_LINK_TARGET, RE_ANGLE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/**
 * 把一行里命中的定界符换成 HTML 标签（保持其余文本不变）。
 *
 * 为什么换标签而不是整段包起来：marked 的 inline HTML 是「标签 token + 中间的
 * 普通文本照常解析」，于是 `<strong>“*斜*”</strong>` 里的斜体仍然生效，
 * 与直接在编辑器里看到的效果一致。
 *
 * @param {string} line
 * @return {string}
 */
function promoteLine(line) {
  if (!line.includes('*') && !line.includes('~~')) return line;
  const skip = collectSkipRanges(line);
  const hits = findLooseEmphasis(line).filter(
    (h) => !skip.some(([a, b]) => h.from < b && h.to > a),
  );
  if (!hits.length) return line;

  let out = line;
  // 从后往前替换：后面的偏移不受前面长度变化影响
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const h = hits[i];
    const tag = h.kind === 'del' ? 'del' : h.kind === 'em' ? 'em' : 'strong';
    out = `${out.slice(0, h.to - h.mark.length)}</${tag}>${out.slice(h.to)}`;
    out = `${out.slice(0, h.from)}<${tag}>${out.slice(h.from + h.mark.length)}`;
  }
  return out;
}

/**
 * 渲染前预处理：把「中文标点贴边」的强调定界符提升为 HTML 标签。
 *
 * 只改渲染输入，不改文档；代码围栏内的行原样跳过。
 *
 * @param {string} text
 * @return {string}
 */
export function promoteLooseEmphasis(text) {
  const src = String(text == null ? '' : text);
  if (!src.includes('*') && !src.includes('~~')) return src;
  const lines = src.split('\n');
  const out = [];
  let fence = '';
  for (const line of lines) {
    const m = RE_FENCE_LINE.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = '';
      continue;
    }
    if (m) {
      fence = m[1];
      out.push(line);
      continue;
    }
    out.push(promoteLine(line));
  }
  return out.join('\n');
}
