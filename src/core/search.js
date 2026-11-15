/**
 * QuillPad · 搜索内核
 *
 * 用 CodeMirror 的 SearchQuery 做「当前文档」的匹配与高亮，
 * 同时提供自建的匹配枚举 / 替换能力，用于：
 * - 精确的匹配计数与循环开关
 * - 正则捕获组 $1 / $& / $<name> 替换
 * - 在文件中查找（扫描多个标签）
 */

import { SearchQuery, setSearchQuery } from '@codemirror/search';
import { expandReplacement } from './utils.js';

/**
 * @typedef {object} SearchOptions
 * @property {string} searchText 搜索词
 * @property {boolean} caseSensitive 区分大小写
 * @property {boolean} regexp 正则模式
 * @property {boolean} wholeWord 全词匹配
 * @property {string} [replaceText] 替换词
 * @property {boolean} [wrap] 循环查找
 */

/**
 * 构造 SearchQuery。
 * @param {SearchOptions} opts
 * @return {SearchQuery}
 */
export function makeSearchQuery(opts) {
  const regexp = !!opts.regexp;
  return new SearchQuery({
    search: opts.searchText || '',
    caseSensitive: !!opts.caseSensitive,
    literal: !regexp,
    regexp,
    wholeWord: !!opts.wholeWord,
    replace: opts.replaceText || '',
  });
}

/**
 * 把查询同步给 CodeMirror（用于命中高亮）。
 * @param {import('@codemirror/view').EditorView} view
 * @param {SearchOptions} opts
 * @return {SearchQuery}
 */
export function syncQuery(view, opts) {
  const q = makeSearchQuery(opts);
  try {
    view.dispatch({ effects: setSearchQuery.of(q) });
  } catch {
    // 在 CodeMirror 的 update 周期内部不允许 dispatch，
    // 延后一帧重试，避免整个插件崩溃。
    const retry = () => {
      try {
        view.dispatch({ effects: setSearchQuery.of(q) });
      } catch {
        /* 再次失败则放弃本次高亮同步 */
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(retry);
    else setTimeout(retry, 0);
  }
  return q;
}

/**
 * 枚举当前文档中的所有匹配。
 * @param {import('@codemirror/state').EditorState} state
 * @param {SearchOptions} opts
 * @param {number} [limit] 最多返回多少条
 * @return {Array<{from: number, to: number, match: Array<string>|RegExpExecArray, pos: number}>}
 */
export function collectMatches(state, opts, limit = 20000) {
  const out = [];
  if (!opts.searchText) return out;
  const query = makeSearchQuery(opts);
  if (!query.valid) return out;
  let cursor;
  try {
    cursor = query.getCursor(state);
  } catch {
    return out;
  }
  try {
    for (let it = cursor.next(); !it.done; it = cursor.next()) {
      out.push({ from: it.value.from, to: it.value.to, match: it.value.match });
      if (out.length >= limit) break;
    }
  } catch (err) {
    console.warn('[QuillPad] 搜索匹配失败（可能是非法正则）：', err);
  }
  return out;
}

/**
 * 计算下一个 / 上一个匹配的下标。
 * @param {Array<{from: number, to: number}>} matches
 * @param {number} cursorPos 当前光标
 * @param {boolean} forward 是否向前
 * @param {boolean} wrap 是否循环
 * @return {number} 匹配下标，-1 表示没有
 */
export function pickMatchIndex(matches, cursorPos, forward, wrap) {
  if (!matches.length) return -1;
  if (forward) {
    for (let i = 0; i < matches.length; i += 1) {
      if (matches[i].from >= cursorPos) return i;
    }
    return wrap ? 0 : -1;
  }
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].to <= cursorPos) return i;
  }
  return wrap ? matches.length - 1 : -1;
}

/**
 * 在当前文档执行「全部替换」。
 * @param {import('@codemirror/view').EditorView} view
 * @param {SearchOptions} opts
 * @return {number} 替换数量
 */
export function replaceAllInView(view, opts) {
  if (!opts.searchText) return 0;
  const matches = collectMatches(view.state, opts);
  if (!matches.length) return 0;
  const changes = matches.map((m) => ({
    from: m.from,
    to: m.to,
    insert: expandReplacement(opts.replaceText || '', m.match),
  }));
  view.dispatch({ changes });
  return changes.length;
}

/**
 * 替换从光标开始的第一个匹配。
 * @param {import('@codemirror/view').EditorView} view
 * @param {SearchOptions} opts
 * @return {boolean} 是否执行了替换
 */
export function replaceNextInView(view, opts) {
  if (!opts.searchText) return false;
  const state = view.state;
  const sel = state.selection.main;
  const matches = collectMatches(state, opts, 4000);
  if (!matches.length) return false;
  let target = matches.find((m) => m.from === sel.from && m.to === sel.to);
  if (!target) {
    const idx = pickMatchIndex(matches, sel.to, true, opts.wrap !== false);
    target = idx >= 0 ? matches[idx] : null;
  }
  if (!target) return false;
  const insert = expandReplacement(opts.replaceText || '', target.match);
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: target.from + insert.length },
  });
  return true;
}

/**
 * 在纯文本上做全部替换，返回新文本与数量。
 * @param {string} text
 * @param {SearchOptions} opts
 * @return {{text: string, count: number}}
 */
export function replaceAllInString(text, opts) {
  if (!opts.searchText) return { text, count: 0 };
  const query = makeSearchQuery(opts);
  if (!query.valid) return { text, count: 0 };
  const actual = buildActualRegex(query, opts);
  if (!actual) return { text, count: 0 };

  let count = 0;
  const result = text.replace(actual, (...args) => {
    const last = args[args.length - 1];
    const hasNamed = !!last && typeof last === 'object';
    const groups = args.slice(0, hasNamed ? -3 : -2);
    if (hasNamed) groups.groups = last;
    count += 1;
    return expandReplacement(opts.replaceText || '', groups);
  });
  return { text: result, count };
}

/**
 * 从 SearchQuery 还原出一个可用的全局 RegExp。
 * @param {SearchQuery} query
 * @param {SearchOptions} opts
 * @return {RegExp|null}
 */
export function buildActualRegex(query, opts) {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  try {
    if (opts.regexp) {
      const body = opts.wholeWord ? `\\b(?:${query.search})\\b` : query.search;
      return new RegExp(body, flags);
    }
    const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = opts.wholeWord ? `\\b${escaped}\\b` : escaped;
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * 统计一段文本里的匹配数量。
 * @param {string} text
 * @param {SearchOptions} opts
 * @param {number} [limit]
 * @return {number}
 */
export function countInString(text, opts, limit = 5000) {
  if (!opts.searchText) return 0;
  const query = makeSearchQuery(opts);
  if (!query.valid) return 0;
  const re = buildActualRegex(query, opts);
  if (!re) return 0;
  let n = 0;
  let m = re.exec(text);
  while (m && n < limit) {
    n += 1;
    if (m[0] === '') re.lastIndex += 1;
    m = re.exec(text);
  }
  return n;
}
