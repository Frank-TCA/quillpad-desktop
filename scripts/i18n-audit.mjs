#!/usr/bin/env node
/**
 * QuillPad · 中英双语完整性静态扫描器
 *
 * 用途：证明「用户可见文案没有漏翻」。全应用采用内联双语写法
 * `t('中文原文', 'English')` / `pickLocalized(obj, 'title')` / `tCount(...)`，
 * 因此判定方式是：把这三种调用的整段挖掉，再在剩余源码里找仍含中文的
 * 字符串字面量 —— 剩下的每一条都是待确认的漏翻（或已知豁免）。
 *
 * 实现说明：
 *   - 零新增依赖，纯 Node ESM，`node scripts/i18n-audit.mjs` 直接跑。
 *   - 不用正则做主逻辑：字符级扫描器能正确处理嵌套括号、模板字符串里的
 *     `${...}`、转义引号、正则字面量、行/块注释，避免「简单正则漏报」。
 *   - 若项目里装了 acorn 本可以走 AST，但本仓库没有且要求零依赖，
 *     所以统一使用字符级扫描器；它同时兼容 .js / .cjs / .mjs 与 index.html
 *     内嵌脚本，不需要区分模块语法。
 *
 * 扫描范围：src/**\/*.js、desktop/**\/*.cjs、desktop/**\/*.js、index.html。
 * 排除项（单独计数，不计入漏翻）：注释、console.* 参数、正则字面量、
 * 错误码 / CSS 类名 / data-* 属性名这类标识串。
 *
 * 用法：
 *   node scripts/i18n-audit.mjs             # 只报告，退出码 0
 *   node scripts/i18n-audit.mjs --strict    # 有漏翻时退出码 1（验收闸门）
 *   node scripts/i18n-audit.mjs --quiet     # 只打印汇总，不逐条列
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录（本脚本位于 scripts/ 下）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 命令行开关。 */
const STRICT = process.argv.includes('--strict');
const QUIET = process.argv.includes('--quiet');

/** 中文字符范围（按需求用 \u4e00-\u9fa5；扩展区与全角标点不算）。 */
const CJK = /[\u4e00-\u9fa5]/;

/** 标识符起始 / 组成字符。 */
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** 会被整体挖掉的本地化调用（取点号链最后一段比较）。 */
const I18N_CALLEES = new Set(['t', 'pickLocalized', 'tCount']);

/**
 * 「成对参数」型双语函数：只有传了 ≥2 个参数（zh, en）才算双语调用。
 *
 * `desktop/inject.js` 在页面上下文里跑，不能 import core/i18n.js，
 * 于是自带 `function label(zh, en)` 按 `<html lang>` 取值。单参数的
 * `label('中文')` 不在此列，仍会被当成漏翻报出来。
 */
const PAIR_CALLEES = new Set(['label']);

/** 开发期错误对象：`throw new Error('...')` 里的文案不面向用户。 */
const DEV_ERROR_CALLEES = /^(?:Error|TypeError|RangeError|SyntaxError|AggregateError|EvalError|URIError|ReferenceError)$/;

/**
 * 已知静态文案文件：这些中文是首屏兜底值，运行时由 JS 覆写。
 * 单列一节展示，但不计入漏翻总数、也不影响 --strict 的判定。
 */
const KNOWN_STATIC_FILES = new Map([
  ['index.html', '静态 HTML 兜底值，由 src/app.js 的 applyStaticLabels() / updateTitle() 启动时覆写'],
]);

/**
 * 精确白名单：文件 + 字面量原文。行号会随重构漂移，所以按内容匹配。
 * 每一项都必须写明原因，报告里会逐条列出，避免变成「悄悄放水」。
 */
const EXACT_ALLOWLIST = [
  {
    file: 'src/core/i18n.js',
    text: '简体中文',
    reason: 'LOCALE_LABELS 用各语言自身的显示名，英文界面也必须显示「简体中文」才能切回来，永不翻译',
  },
];

/**
 * 已知双语但形态不同的写法（仅用于报告说明，判定逻辑见 isBilingualPair）：
 * `desktop/main.cjs` 的保存过滤器写成 `[中文名, 英文名]`，取值时才按语言选。
 */
const KNOWN_BILINGUAL_NOTES = [
  'desktop/main.cjs: [中文名, 英文名] 过滤器数组，由 saveDialogFilters() 按当前语言取值',
];

/** 不递归进入的目录（二进制资源 / 构建产物 / 依赖）。 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'release', 'out', '.git', '.cache',
  'fonts', 'assets', '__pycache__', 'coverage',
]);

/** 允许扫描的源码后缀。 */
const SOURCE_EXT = /\.(?:js|cjs|mjs)$/;

/**
 * 标识类字符串：错误码、CSS 类名 / 选择器、data-* / aria-* 属性名、
 * 文件扩展名、MIME / 颜色 / 十六进制值。这类串不是用户可见文案。
 * 只有「整串完全匹配」才排除，避免把中文句子误判成标识串。
 */
const IDENTIFIER_PATTERNS = [
  /^data-[a-z0-9-]+$/i,
  /^aria-[a-z0-9-]+$/i,
  /^[A-Z][A-Z0-9_.:/-]{1,}$/,
  /^(?:[.#]?[a-z][a-z0-9_-]*)(?:[>:+][.#]?[a-z][a-z0-9_-]*)*$/i,
  /^\.[a-z0-9]+(?:,[.\w-]+)*$/i,
  /^#[0-9a-f]{3,8}$/i,
  /^https?:\/\/\S+$/i,
  /^(?:[a-z0-9-]+\/)*[a-z0-9.-]+\.[a-z0-9]+$/i,
];

/**
 * HTML 里这些属性的值不算用户可见文案（结构 / 资源 / 样式用途）。
 * 注意 aria-label / title / placeholder 是有文案的，故意不在名单里。
 */
const NON_TEXT_HTML_ATTRS = new Set([
  'class', 'id', 'style', 'src', 'href', 'rel', 'type', 'charset',
  'role', 'hidden', 'name', 'value', 'for', 'tabindex', 'spellcheck',
  'autocomplete', 'contenteditable', 'draggable', 'width', 'height',
  'viewBox', 'xmlns', 'stroke', 'fill', 'd', 'accept', 'min', 'max', 'step',
]);

/* ------------------------------------------------------------------ 报告对象 */

/**
 * 一次扫描的全部结果。
 * @typedef {{line: number, text: string}} Finding
 */
const report = {
  /** @type {Map<string, Finding[]>} 相对路径 → 漏翻列表 */
  byFile: new Map(),
  /** 排除项计数 */
  excluded: {
    /** 含中文的注释块数 */
    comments: 0,
    /** console.* 调用里含中文的字符串数 */
    consoleArgs: 0,
    /** throw new Error(...) 里的中文字符串数（开发期断言） */
    throwErrors: 0,
    /** 含中文的正则字面量数 */
    regex: 0,
    /** 字符串字面量内部的 /* *\/ 与 // 注释（生成代码里的中文说明） */
    embeddedComments: 0,
    /** 「中文 → 英文」字典对象的键（如 CATEGORY_EN 的 '全部': 'All'） */
    dictKeys: 0,
    /** 带 <字段>En 兄弟字段的数据项（如 label:'源码', labelEn:'Source'） */
    pairedEn: 0,
    /** `[中文, English]` 双元素数组（如原生对话框过滤器） */
    bilingualPairs: 0,
    /** 精确白名单命中的条数 */
    allowlisted: 0,
    /** `label(zh, en)` 这类成对双语调用被整体剥离的次数 */
    pairCalls: 0,
    /** 匹配标识类模式的字符串数（本来就不含中文） */
    identifiers: 0,
  },
  /** @type {Map<string, Finding[]>} 已知静态文案，单列展示、不计入漏翻 */
  staticHtml: new Map(),
  /** 被跳过（二进制 / 不可读）的文件 */
  skipped: [],
  /** 实际扫描的文件数 */
  fileCount: 0,
};

/**
 * 记录一条漏翻。
 * @param {string} file 相对路径
 * @param {number} line 行号（1 基）
 * @param {string} text 字符串内容
 * @param {string} [key] 若它是对象属性 `key: '...'` 的值，记下属性名
 */
function addFinding(file, line, text, key = '') {
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
  // 已知静态兜底文案：单列一节，不算漏翻、不触发 --strict 失败
  if (KNOWN_STATIC_FILES.has(file)) {
    if (!report.staticHtml.has(file)) report.staticHtml.set(file, []);
    report.staticHtml.get(file).push({ line, text: clean, key });
    return;
  }
  if (!report.byFile.has(file)) report.byFile.set(file, []);
  report.byFile.get(file).push({ line, text: clean, key });
}

/**
 * 后处理：把「`label: '中文'` + `labelEn: 'English'`」这类成对数据项从
 * 漏翻列表里剔除。渲染点会用 `t(seg.label, seg.labelEn)` 取值，中文只是数据源。
 *
 * @param {string} src 文件全文
 * @param {string} file 相对路径
 */
function resolveEnPairs(src, file) {
  const enKeys = new Set();
  const re = /\b([A-Za-z_$][\w$]*)En\s*:/g;
  let m;
  while ((m = re.exec(src)) !== null) enKeys.add(m[1]);
  if (!enKeys.size) return;
  const items = report.byFile.get(file);
  if (!items) return;
  /** @type {Array<{line: number, text: string, key: string}>} */
  const kept = [];
  for (const it of items) {
    if (it.key && enKeys.has(it.key)) report.excluded.pairedEn += 1;
    else kept.push(it);
  }
  if (kept.length) report.byFile.set(file, kept);
  else report.byFile.delete(file);
}

/* ------------------------------------------------------------------ 文件收集 */

/**
 * 递归收集源码文件。
 * @param {string} dir 绝对目录
 * @param {string[]} out 输出数组
 */
function collectFrom(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      collectFrom(full, out);
    } else if (SOURCE_EXT.test(ent.name)) {
      out.push(full);
    }
  }
}

/**
 * 取本次要扫描的全部文件（绝对路径）。
 * @return {string[]}
 */
function collectFiles() {
  /** @type {string[]} */
  const out = [];
  collectFrom(path.join(ROOT, 'src'), out);
  collectFrom(path.join(ROOT, 'desktop'), out);
  const html = path.join(ROOT, 'index.html');
  if (fs.existsSync(html)) out.push(html);
  return out.sort();
}

/**
 * 读文件；二进制或不可读时返回 null 并计入跳过列表。
 * @param {string} abs
 * @param {string} rel
 * @return {string|null}
 */
function readText(abs, rel) {
  try {
    const buf = fs.readFileSync(abs);
    // 字体 / 图片等二进制即使误收进后缀也要跳过
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] === 0) {
        report.skipped.push(`${rel}（二进制）`);
        return null;
      }
    }
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    report.skipped.push(`${rel}（读取失败）`);
    return null;
  }
}

/* ------------------------------------------------------------------ 行号工具 */

/**
 * 构造「字符下标 → 行号」查询器。
 * @param {string} src
 * @param {number} lineOffset 该片段在整文件里的起始行偏移
 * @return {(pos: number) => number}
 */
function makeLineLookup(src, lineOffset = 0) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lineOffset + lo + 1;
  };
}

/* ------------------------------------------------------------------ 词法片段 */

/**
 * 读一个标识符。
 * @param {string} src
 * @param {number} i 起始下标
 * @param {number} to 上界（不含）
 * @return {number} 结束下标（不含）
 */
function readIdent(src, i, to) {
  let j = i + 1;
  while (j < to && IDENT_PART.test(src[j])) j += 1;
  return j;
}

/**
 * 跳过空白后的下标。
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @return {number}
 */
function skipSpace(src, i, to) {
  let j = i;
  while (j < to && /\s/.test(src[j])) j += 1;
  return j;
}

/**
 * 读普通字符串（单/双引号），处理反斜杠转义。
 * @param {string} src
 * @param {number} i 引号下标
 * @param {number} to
 * @return {{end: number, value: string}}
 */
function consumeString(src, i, to) {
  const quote = src[i];
  let j = i + 1;
  while (j < to) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return { end: j + 1, value: src.slice(i + 1, j) };
    j += 1;
  }
  return { end: to, value: src.slice(i + 1, to) };
}

/**
 * 读到行尾（行注释 / 正则未闭合时兜底）。
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @return {number}
 */
function consumeLine(src, i, to) {
  const nl = src.indexOf('\n', i);
  return nl < 0 || nl >= to ? to : nl;
}

/**
 * 读块注释。
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @return {number}
 */
function consumeBlockComment(src, i, to) {
  const end = src.indexOf('*/', i + 2);
  return end < 0 || end + 2 > to ? to : end + 2;
}

/**
 * 判断 `/` 是否是正则字面量的开头（而不是除号）。
 *
 * 依据「前一个有效 token」：若它是运算符 / 左括号 / 关键字，则此处只能是正则；
 * 若它是标识符、数字、右括号、右方括号，则只能是除号。
 *
 * @param {string} src
 * @param {number} i `/` 的下标
 * @param {number} from 当前扫描区起点（限制回溯范围）
 * @return {boolean}
 */
function isRegexStart(src, i, from) {
  let k = i - 1;
  while (k >= from && /\s/.test(src[k])) k -= 1;
  if (k < from) return true;
  const prev = src[k];
  if (IDENT_PART.test(prev) || prev === ')' || prev === ']' || prev === '}') return false;
  // 前一个词是 return / case / throw 等关键字时，反查整词
  if (IDENT_START.test(prev)) {
    let s = k;
    while (s >= from && IDENT_PART.test(src[s])) s -= 1;
    const word = src.slice(s + 1, k + 1);
    return /^(?:return|case|throw|new|typeof|instanceof|in|of|delete|void|yield|await|else|do)$/.test(word);
  }
  return true;
}

/**
 * 读正则字面量（含 flags）。找不到结尾 `/` 时按普通字符处理。
 * @param {string} src
 * @param {number} i
 * @param {number} to
 * @return {{end: number, value: string, ok: boolean}}
 */
function consumeRegex(src, i, to) {
  let j = i + 1;
  let inClass = false;
  while (j < to) {
    const c = src[j];
    if (c === '\n') break;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { inClass = true; j += 1; continue; }
    if (c === ']') { inClass = false; j += 1; continue; }
    if (c === '/' && !inClass) {
      let e = j + 1;
      while (e < to && /[a-z]/i.test(src[e])) e += 1;
      return { end: e, value: src.slice(i + 1, j), ok: true };
    }
    j += 1;
  }
  return { end: i + 1, value: '', ok: false };
}

/* ------------------------------------------------------------------ JS 扫描器 */

/**
 * 扫描一段 JavaScript 源码，登记漏翻与排除项。
 *
 * @param {string} src 源码片段
 * @param {object} ctx 上下文
 * @param {string} ctx.file 相对路径
 * @param {number} [ctx.lineOffset] 该片段在整文件里的行偏移
 * @param {''|'console'|'throw-error'} [ctx.exclusion] 当前上下文的排除类别
 * @param {number} [ctx.from] 起点
 * @param {number} [ctx.to] 终点
 */
function walkJs(src, ctx) {
  const from = ctx.from ?? 0;
  const to = ctx.to ?? src.length;
  const lineOffset = ctx.lineOffset ?? 0;
  const exclusion = ctx.exclusion ?? '';
  const file = ctx.file;
  const lineOf = makeLineLookup(src, lineOffset);
  /** 最近遇到的对象属性名（`label: '...'` 里的 label），供 En 兄弟字段识别 */
  let pendingKey = '';

  /**
   * 判断字符串是否是「中文 → 英文」字典对象的键。
   *
   * 条件：前一个有效字符是 `{` 或 `,`（确实是对象属性开头，排除三元表达式
   * `cond ? '中文' : 'English'`），且冒号后紧跟一个不含中文的字符串值。
   *
   * @param {number} start 字符串起始下标
   * @param {number} end 字符串结束下标
   * @return {boolean}
   */
  function isDictKey(start, end) {
    let p = start - 1;
    while (p >= from && /\s/.test(src[p])) p -= 1;
    if (p < from || (src[p] !== '{' && src[p] !== ',')) return false;
    let k = skipSpace(src, end, to);
    if (src[k] !== ':') return false;
    k = skipSpace(src, k + 1, to);
    if (src[k] !== '"' && src[k] !== "'") return false;
    const v = consumeString(src, k, to);
    return v.value.length > 0 && !CJK.test(v.value);
  }

  /**
   * 判断字符串是否是 `[中文名, 英文名]` 双元素数组的第一项。
   *
   * 窄口径：前一个有效字符必须是 `[`，且英文串之后紧跟 `]`。
   * 这样 `foo(a, '中文', 'info')` 这类函数调用不会被误当成双语数组。
   *
   * @param {number} start 字符串起始下标
   * @param {number} end 字符串结束下标
   * @return {boolean}
   */
  function isBilingualPair(start, end) {
    let p = start - 1;
    while (p >= from && /\s/.test(src[p])) p -= 1;
    if (p < from || src[p] !== '[') return false;
    let k = skipSpace(src, end, to);
    if (src[k] !== ',') return false;
    k = skipSpace(src, k + 1, to);
    if (src[k] !== '"' && src[k] !== "'") return false;
    const v = consumeString(src, k, to);
    if (!v.value || CJK.test(v.value)) return false;
    k = skipSpace(src, v.end, to);
    return src[k] === ']';
  }

  /**
   * 精确白名单命中（文件 + 字面量原文）。
   * @param {string} value
   * @return {boolean}
   */
  function isAllowlisted(value) {
    const text = value.trim();
    return EXACT_ALLOWLIST.some((e) => e.file === file && e.text === text);
  }

  /**
   * 统计一次调用顶层参数个数（用于判定 `label(zh, en)` 这类成对写法）。
   * @param {number} open `(` 下标
   * @param {number} close 配对 `)` 之后的下标
   * @return {number}
   */
  function countTopLevelArgs(open, close) {
    let depth = 0;
    let commas = 0;
    let hasToken = false;
    let i = open + 1;
    while (i < close - 1) {
      const c = src[i];
      if (c === "'" || c === '"') { i = consumeString(src, i, close).end; hasToken = true; continue; }
      if (c === '`') { i = consumeTemplate(i, true).end; hasToken = true; continue; }
      if (c === '/' && src[i + 1] === '/') { i = consumeLine(src, i, close); continue; }
      if (c === '/' && src[i + 1] === '*') { i = consumeBlockComment(src, i, close); continue; }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ',' && depth === 0) commas += 1;
      else if (!/\s/.test(c)) hasToken = true;
      i += 1;
    }
    return hasToken ? commas + 1 : 0;
  }

  /**
   * 判断并登记一个字符串字面量。
   * @param {number} start 字面量起始下标
   * @param {number} end 字面量结束下标（不含）
   * @param {string} value 字面量内容（原始文本）
   */
  function register(start, end, value) {
    if (isAllowlisted(value)) {
      report.excluded.allowlisted += 1;
      return;
    }
    if (IDENTIFIER_PATTERNS.some((re) => re.test(value.trim()))) {
      report.excluded.identifiers += 1;
      return;
    }
    if (!CJK.test(value)) return;
    // `[中文名, 英文名]` 双语数组：取值时才按语言选，属于已双语
    if (isBilingualPair(start, end)) {
      report.excluded.bilingualPairs += 1;
      return;
    }
    // 生成代码（如插件 Worker 引导脚本）会把 JS 源码整段放进字符串，
    // 其中文只出现在 /**/ 或 // 注释里，属于开发者说明而非界面文案。
    // `[^:]`  guard 是为了不把 `https://` 里的 `//` 当成行注释。
    const withoutComments = value
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    if (!CJK.test(withoutComments)) {
      report.excluded.embeddedComments += 1;
      return;
    }
    if (exclusion === 'console') {
      report.excluded.consoleArgs += 1;
      return;
    }
    if (exclusion === 'throw-error') {
      report.excluded.throwErrors += 1;
      return;
    }
    addFinding(file, lineOf(start), value, pendingKey);
  }

  /**
   * 读模板字符串：把 `${...}` 表达式交给 walkJs 递归扫描，
   * 只把模板的「静态文本部分」当作一个字面量登记。
   * @param {number} i 反引号下标
   * @param {boolean} silent 只跳读、不登记（用于跳过调用参数内部）
   * @return {{end: number, value: string}}
   */
  function consumeTemplate(i, silent) {
    const parts = [];
    let j = i + 1;
    let textStart = j;
    while (j < to) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') {
        parts.push(src.slice(textStart, j));
        return { end: j + 1, value: parts.join('') };
      }
      if (c === '$' && src[j + 1] === '{') {
        parts.push(src.slice(textStart, j));
        const exprStart = j + 2;
        // 大括号配对：表达式里可能还有字符串 / 模板 / 嵌套花括号
        let depth = 1;
        let k = exprStart;
        while (k < to && depth > 0) {
          const ch = src[k];
          if (ch === "'" || ch === '"') { k = consumeString(src, k, to).end; continue; }
          if (ch === '`') { k = consumeTemplate(k, true).end; continue; }
          if (ch === '{') depth += 1;
          else if (ch === '}') depth -= 1;
          k += 1;
        }
        const exprEnd = k - 1;
        if (!silent) walkJs(src, { ...ctx, from: exprStart, to: Math.max(exprStart, exprEnd) });
        j = k;
        textStart = j;
        continue;
      }
      j += 1;
    }
    parts.push(src.slice(textStart, to));
    return { end: to, value: parts.join('') };
  }

  /**
   * 从 `(` 起跳到配对 `)` 之后。内部字符串 / 模板 / 注释一律跳过，
   * 避免其中的括号干扰配对。
   * @param {number} open `(` 下标
   * @return {number} 配对右括号之后的下标
   */
  function skipCall(open) {
    let depth = 0;
    let i = open;
    while (i < to) {
      const c = src[i];
      if (c === "'" || c === '"') { i = consumeString(src, i, to).end; continue; }
      if (c === '`') { i = consumeTemplate(i, true).end; continue; }
      if (c === '/' && src[i + 1] === '/') { i = consumeLine(src, i, to); continue; }
      if (c === '/' && src[i + 1] === '*') { i = consumeBlockComment(src, i, to); continue; }
      // 正则字面量里若出现括号（如 /(\d+)/），不跳读会破坏括号配对
      if (c === '/' && isRegexStart(src, i, open)) {
        const r = consumeRegex(src, i, to);
        if (r.ok) { i = r.end; continue; }
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
    return to;
  }

  let i = from;
  while (i < to) {
    const c = src[i];

    // 1. 注释：含中文的只计入排除统计
    if (c === '/' && src[i + 1] === '/') {
      const end = consumeLine(src, i, to);
      if (CJK.test(src.slice(i, end))) report.excluded.comments += 1;
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = consumeBlockComment(src, i, to);
      if (CJK.test(src.slice(i, end))) report.excluded.comments += 1;
      i = end;
      continue;
    }

    // 2. 普通字符串
    if (c === '"' || c === "'") {
      const r = consumeString(src, i, to);
      if (isDictKey(i, r.end)) {
        report.excluded.dictKeys += 1;
        pendingKey = '';
      } else {
        register(i, r.end, r.value);
        pendingKey = '';
      }
      i = r.end;
      continue;
    }

    // 3. 模板字符串（${} 里的表达式另走递归）
    if (c === '`') {
      const r = consumeTemplate(i, false);
      register(i, r.end, r.value);
      pendingKey = '';
      i = r.end;
      continue;
    }

    // 4. 正则字面量：含中文也只计入排除统计
    if (c === '/' && isRegexStart(src, i, from)) {
      const r = consumeRegex(src, i, to);
      if (r.ok) {
        if (CJK.test(r.value)) report.excluded.regex += 1;
        i = r.end;
        continue;
      }
    }

    // 5. 标识符 + 调用
    if (IDENT_START.test(c)) {
      let nameEnd = readIdent(src, i, to);
      const segments = [src.slice(i, nameEnd)];
      // 点号链：console.warn / i18n.t
      while (src[nameEnd] === '.' && nameEnd + 1 < to && IDENT_START.test(src[nameEnd + 1])) {
        const s = nameEnd + 1;
        const e = readIdent(src, s, to);
        segments.push(src.slice(s, e));
        nameEnd = e;
      }
      const last = segments[segments.length - 1];
      const full = segments.join('.');
      const paren = skipSpace(src, nameEnd, to);
      if (src[paren] === '(') {
        // 调用形式：属性名不会被当成 En 兄弟字段的候选
        pendingKey = '';
        const callEnd = skipCall(paren);
        const isPairCall = PAIR_CALLEES.has(last) && countTopLevelArgs(paren, callEnd) >= 2;
        const isI18nCall = I18N_CALLEES.has(last) || isPairCall;
        if (isI18nCall) {
          // 本地化调用（含 label(zh, en)）：整段挖掉，不检查内部任何字符串
          if (isPairCall) report.excluded.pairCalls += 1;
          i = callEnd;
          continue;
        }
        if (full === 'console' || /^(?:window\.)?console\./.test(full)) {
          // console.* 的参数里出现中文是允许的（日志面向开发者）
          walkJs(src, {
            ...ctx,
            from: paren + 1,
            to: Math.max(paren + 1, callEnd - 1),
            exclusion: 'console',
          });
          i = callEnd;
          continue;
        }
        if (DEV_ERROR_CALLEES.test(last)) {
          // throw new Error('...')：开发期断言，文案不面向用户
          walkJs(src, {
            ...ctx,
            from: paren + 1,
            to: Math.max(paren + 1, callEnd - 1),
            exclusion: 'throw-error',
          });
          i = callEnd;
          continue;
        }
        // 其它调用：递归扫描参数（保持当前上下文）
        walkJs(src, { ...ctx, from: paren + 1, to: Math.max(paren + 1, callEnd - 1) });
        i = callEnd;
        continue;
      }
      // `label: '...'` 形态：记住属性名，供 resolveEnPairs 判定 <字段>En 配对
      const colon = skipSpace(src, nameEnd, to);
      if (src[colon] === ':') {
        const valStart = skipSpace(src, colon + 1, to);
        if (src[valStart] === '"' || src[valStart] === "'" || src[valStart] === '`') {
          pendingKey = last;
        }
      }
      i = nameEnd;
      continue;
    }

    i += 1;
  }
}

/* ------------------------------------------------------------------ HTML 扫描 */

/**
 * 用空格遮蔽源码中的一段（保留换行，保持行号对齐）。
 * @param {string[]} chars 字符数组
 * @param {number} from
 * @param {number} to
 */
function mask(chars, from, to) {
  for (let i = from; i < to && i < chars.length; i += 1) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

/**
 * 扫描 index.html：内嵌脚本按 JS 扫，HTML 注释 / 标签属性 / 文本节点分别处理。
 * @param {string} src
 * @param {string} file
 */
function scanHtml(src, file) {
  const chars = src.split('');
  const lineOf = makeLineLookup(src, 0);

  // 1. 内嵌 <script>：内容按 JS 扫描，然后遮蔽
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = scriptRe.exec(src)) !== null) {
    const contentStart = m.index + m[0].indexOf('>') + 1;
    const contentEnd = contentStart + m[1].length;
    walkJs(src, {
      file,
      from: contentStart,
      to: contentEnd,
      lineOffset: lineOf(contentStart) - 1,
    });
    mask(chars, contentStart, contentEnd);
  }

  // 2. <style> 内容：CSS 里的中文只允许出现在注释里，整体遮蔽并计入注释排除
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  while ((m = styleRe.exec(src)) !== null) {
    const contentStart = m.index + m[0].indexOf('>') + 1;
    const contentEnd = contentStart + m[1].length;
    if (CJK.test(m[1])) report.excluded.comments += 1;
    mask(chars, contentStart, contentEnd);
  }

  // 3. HTML 注释：含中文计入排除统计
  const commentRe = /<!--([\s\S]*?)-->/g;
  while ((m = commentRe.exec(src)) !== null) {
    if (CJK.test(m[1])) report.excluded.comments += 1;
    mask(chars, m.index, m.index + m[0].length);
  }

  const html = chars.join('');

  /**
   * 登记 HTML 里的一段用户可见中文。
   * @param {number} pos
   * @param {string} text
   */
  const addHtmlFinding = (pos, text) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || !CJK.test(clean)) return;
    addFinding(file, lineOf(pos), clean);
  };

  // 4. 逐字符走 HTML：标签内解析属性，标签外是文本节点
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const end = next < 0 ? html.length : next;
      addHtmlFinding(i, html.slice(i, end));
      i = end;
      continue;
    }
    // 找到标签结束的 `>`（跳过引号里的 `>`）
    let j = i + 1;
    let quote = '';
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    const tag = html.slice(i + 1, Math.min(j, html.length));
    // 属性：name 或 name="value" / name='value' / name=value
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let am;
    while ((am = attrRe.exec(tag)) !== null) {
      const name = am[1].toLowerCase();
      const value = am[2] ?? am[3] ?? am[4] ?? '';
      if (IDENTIFIER_PATTERNS.some((re) => re.test(value.trim()))) {
        report.excluded.identifiers += 1;
        continue;
      }
      if (name.startsWith('data-') || name.startsWith('aria-hidden') ||
          NON_TEXT_HTML_ATTRS.has(name)) {
        continue;
      }
      if (!CJK.test(value)) continue;
      addFinding(file, lineOf(i + 1 + am.index), value);
    }
    i = Math.min(j + 1, html.length);
  }
}

/* ------------------------------------------------------------------ 汇总输出 */

/**
 * 把文件归到目录域。
 * @param {string} rel
 * @return {string}
 */
function domainOf(rel) {
  if (rel.startsWith('src/ui/')) return 'src/ui';
  if (rel.startsWith('src/editor/')) return 'src/editor';
  if (rel.startsWith('src/core/')) return 'src/core';
  if (rel.startsWith('desktop/')) return 'desktop';
  return '其它';
}

/** 打印最终报告。 */
function printReport() {
  const domains = ['src/ui', 'src/editor', 'src/core', 'desktop', '其它'];
  /** @type {Record<string, number>} */
  const domainCount = Object.fromEntries(domains.map((d) => [d, 0]));
  let total = 0;
  let fileHit = 0;

  console.log('QuillPad · 中英双语完整性静态扫描');
  console.log('='.repeat(64));
  console.log(`扫描文件：${report.fileCount} 个（src/**/*.js + desktop/**/*.{js,cjs} + index.html）`);
  if (report.skipped.length) console.log(`跳过文件：${report.skipped.length} 个`);
  console.log(
    `排除项：含中文注释 ${report.excluded.comments} 处 · ` +
    `console.* 中文参数 ${report.excluded.consoleArgs} 处 · ` +
    `throw new Error 断言 ${report.excluded.throwErrors} 处 · ` +
    `中文正则 ${report.excluded.regex} 处 · ` +
    `字符串内嵌注释 ${report.excluded.embeddedComments} 处 · ` +
    `zh→en 字典键 ${report.excluded.dictKeys} 处 · ` +
    `<字段>En 数据项 ${report.excluded.pairedEn} 处 · ` +
    `[中文, English] 双语数组 ${report.excluded.bilingualPairs} 处 · ` +
    `label(zh, en) 双语调用 ${report.excluded.pairCalls} 处 · ` +
    `精确白名单 ${report.excluded.allowlisted} 处 · ` +
    `标识类字符串 ${report.excluded.identifiers} 个`,
  );
  if (report.excluded.allowlisted) {
    for (const e of EXACT_ALLOWLIST) {
      console.log(`  · 白名单 ${e.file} → ${JSON.stringify(e.text)}：${e.reason}`);
    }
  }
  for (const note of KNOWN_BILINGUAL_NOTES) console.log(`  · 已知双语：${note}`);
  console.log('');

  // 已知静态兜底文案：单列一节，既提示也不计入 strict
  if (report.staticHtml.size) {
    let staticTotal = 0;
    for (const items of report.staticHtml.values()) staticTotal += items.length;
    console.log(`—— 已知静态文案（运行时覆写，不计入漏翻 / strict）：${staticTotal} 处 ——`);
    for (const [file, items] of report.staticHtml.entries()) {
      console.log(`  ${file}：${KNOWN_STATIC_FILES.get(file) || ''}`);
      if (!QUIET) {
        for (const it of items) {
          console.log(`    L${String(it.line).padStart(4)}  ${JSON.stringify(it.text)}`);
        }
      }
    }
    console.log('');
  }

  if (!QUIET) {
    console.log('—— 仍含中文的字符串字面量 ——');
    for (const [file, items] of [...report.byFile.entries()].sort()) {
      console.log(`\n${file}  (${items.length})`);
      for (const it of items) {
        console.log(`  L${String(it.line).padStart(4)}  ${JSON.stringify(it.text)}`);
      }
    }
    console.log('');
  }

  for (const [file, items] of report.byFile.entries()) {
    total += items.length;
    if (items.length) fileHit += 1;
    domainCount[domainOf(file)] += items.length;
  }

  console.log('—— 按目录域汇总 ——');
  for (const d of domains) {
    console.log(`  ${d.padEnd(12)} ${String(domainCount[d]).padStart(4)}`);
  }
  console.log('');
  console.log(`合计：${total} 处，分布在 ${fileHit} 个文件`);
  if (STRICT) {
    console.log(total ? '[--strict] FAIL：存在未双语化的字符串。' : '[--strict] PASS：未发现漏翻。');
    process.exitCode = total ? 1 : 0;
  } else {
    console.log('（报告模式，退出码恒为 0；加 --strict 可作为验收闸门）');
  }
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const files = collectFiles();
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const src = readText(abs, rel);
    if (src === null) continue;
    report.fileCount += 1;
    if (rel === 'index.html') scanHtml(src, rel);
    else walkJs(src, { file: rel });
    // 成对数据项（label / labelEn）要等整份文件扫完才能判定
    resolveEnPairs(src, rel);
  }
  if (report.skipped.length && !QUIET) {
    console.log('跳过明细：' + report.skipped.join('、'));
  }
  printReport();
}

// 既可以直接跑，也可以被别的验收脚本 import 后在内存字符串上复用。
export { walkJs, scanHtml, collectFiles, resolveEnPairs, report };

/**
 * 是否作为 CLI 直接执行（被 import 时不自动跑全量扫描）。
 * @return {boolean}
 */
function isCli() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCli()) main();
