/**
 * QuillPad · 通用小工具
 */

/**
 * HTML 转义。
 * @param {string} str
 * @return {string}
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 防抖。
 * @param {Function} fn
 * @param {number} wait 毫秒
 * @return {Function & {cancel: () => void}}
 */
export function debounce(fn, wait = 150) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/**
 * 节流（尾触发）。
 * @param {Function} fn
 * @param {number} wait
 * @return {Function}
 */
export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = 0;
  return (...args) => {
    const now = Date.now();
    const remain = wait - (now - last);
    if (remain <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = window.setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...args);
      }, remain);
    }
  };
}

/**
 * 千分位数字。
 * @param {number} n
 * @return {string}
 */
export function formatNumber(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

/**
 * 字节数人性化。
 * @param {number} bytes
 * @return {string}
 */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 统计词数（英文按空白分词，中文按字计）。
 * @param {string} text
 * @return {number}
 */
export function countWords(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + latin;
}

/**
 * 生成一段文本的高亮 HTML（其余内容会被转义）。
 * @param {string} text 原始行
 * @param {RegExp|null} re 匹配用的正则（需带 g 标志）
 * @return {string}
 */
export function highlightHtml(text, re) {
  if (!re) return escapeHtml(text);
  const src = String(text);
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let guard = 0;
  let m = re.exec(src);
  while (m && guard < 200) {
    guard += 1;
    if (m[0] === '') {
      re.lastIndex += 1;
      m = re.exec(src);
      continue;
    }
    out += escapeHtml(src.slice(last, m.index));
    out += `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
    m = re.exec(src);
  }
  out += escapeHtml(src.slice(last));
  return out;
}

/**
 * 把用户输入的安全正则（用户勾选「正则」时）编译，失败返回 null。
 *
 * 默认情况下编译失败会退回「字面量匹配」（把特殊字符转义后重试），
 * 这样普通搜索不会因为一个括号就整个失灵；但在「正则模式」下这种静默降级
 * 会让用户误以为自己写对了正则，因此用 strict: true 关闭该降级。
 * @param {string} pattern
 * @param {{caseSensitive?: boolean, wholeWord?: boolean, strict?: boolean}} opts
 * @return {RegExp|null}
 */
export function buildRegExp(pattern, opts = {}) {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  let body = pattern;
  if (opts.wholeWord) body = `\\b(?:${body})\\b`;
  try {
    return new RegExp(body, flags);
  } catch {
    if (opts.strict) return null;
    try {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
      return null;
    }
  }
}

/**
 * 转义正则里的特殊字符。
 * @param {string} str
 * @return {string}
 */
export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 展开替换串中的 $1 / $& / $<name> 引用。
 * @param {string} replacement
 * @param {Array<string>|undefined} groups 正则捕获结果（match 数组）
 * @return {string}
 */
export function expandReplacement(replacement, groups) {
  if (!groups) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (whole, token) => {
    if (token === '$') return '$';
    if (token === '&') return String(groups[0] ?? '');
    if (token.startsWith('<')) {
      const name = token.slice(1, -1);
      const named = groups.groups || {};
      return named[name] != null ? String(named[name]) : whole;
    }
    const idx = Number(token);
    const val = groups[idx];
    return val != null ? String(val) : whole;
  });
}

/**
 * 下一帧执行。
 * @param {Function} fn
 */
export function raf(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * 简单的模糊匹配：返回得分（越高越好），不匹配返回 0。
 * @param {string} query
 * @param {string} target
 * @return {number}
 */
export function fuzzyScore(query, target) {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 600 - idx - (t.length - q.length) * 0.2;

  // 逐字符子序列匹配
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      qi += 1;
      streak += 1;
      score += 8 + streak * 3;
      if (i === 0 || t[i - 1] === ' ' || t[i - 1] === '/' || t[i - 1] === '.') score += 12;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

/**
 * 取路径的最后一段。
 * @param {string} p
 * @return {string}
 */
export function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * 取目录部分。
 * @param {string} p
 * @return {string}
 */
export function dirName(p) {
  if (!p) return '';
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i < 0 ? '' : s.slice(0, i);
}
