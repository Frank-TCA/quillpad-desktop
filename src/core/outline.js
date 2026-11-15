/**
 * QuillPad · 文档大纲提取
 *
 * 用轻量正则从正文里挑出「符号」：函数、类、变量、标题。
 * 不依赖语法树，对几十万行的文件也足够快（逐行扫描）。
 */

/**
 * @typedef {object} OutlineSymbol
 * @property {number} line 行号（1 基）
 * @property {string} name 名称
 * @property {string} kind 类型：function / class / variable / heading / method
 */

/** 各语言的符号规则。 */
const RULES = {
  markdown: [{ re: /^(#{1,6})\s+(.+?)\s*#*\s*$/, kind: 'heading', name: 2 }],
  javascript: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', name: 1 },
    { re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/, kind: 'function', name: 1 },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=]/, kind: 'variable', name: 1 },
    { re: /^\s*(?:export\s+)?(?:\/\/\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, kind: 'method', name: 1 },
    { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
  ],
  python: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  ],
  java: [
    { re: /^\s*(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
    { re: /^\s*(?:public|private|protected|static|final|synchronized|\s)+[\w<>\[\],\s]+\s+([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/, kind: 'method', name: 1 },
  ],
  cpp: [
    { re: /^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
    { re: /^[A-Za-z_][\w:<>\*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: 'function', name: 1 },
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function', name: 1 },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'class', name: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
    { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(?:<[^>]*>\s*)?([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  ],
  php: [
    { re: /^\s*(?:public|private|protected|static|\s)*function\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
    { re: /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  ],
  ruby: [
    { re: /^\s*def\s+([A-Za-z_]\w*[?!]?)/, kind: 'function', name: 1 },
    { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  ],
  shell: [{ re: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/, kind: 'function', name: 1 }],
  css: [
    { re: /^\s*([.#][\w-]+(?:[^{,]*)?)\s*\{\s*$/, kind: 'class', name: 1 },
    { re: /^\s*([a-zA-Z][\w-]*)\s*\{\s*$/, kind: 'method', name: 1 },
  ],
  html: [{ re: /^\s*<(section|article|nav|header|footer|main|aside)\b[^>]*id=["']([^"']+)/i, kind: 'heading', name: 2 }],
};

/** 语言 id 到规则集的映射。 */
const RULE_MAP = {
  markdown: RULES.markdown,
  javascript: RULES.javascript,
  jsx: RULES.javascript,
  typescript: RULES.javascript,
  tsx: RULES.javascript,
  json: [],
  python: RULES.python,
  java: RULES.java,
  c: RULES.cpp,
  cpp: RULES.cpp,
  csharp: RULES.java,
  java_: RULES.java,
  kotlin: RULES.java,
  scala: RULES.java,
  go: RULES.go,
  rust: RULES.rust,
  php: RULES.php,
  ruby: RULES.ruby,
  shell: RULES.shell,
  batch: RULES.shell,
  powershell: RULES.shell,
  css: RULES.css,
  scss: RULES.css,
  less: RULES.css,
  html: RULES.html,
  vue: RULES.javascript,
};

/** 通用兜底规则：找 function / class 关键字。 */
const FALLBACK = [
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function', name: 1 },
  { re: /^\s*class\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
];

/**
 * 提取符号大纲。
 * @param {string} text 文档正文
 * @param {string} language 语言 id
 * @param {number} [limit] 最多返回多少条
 * @return {OutlineSymbol[]}
 */
export function extractSymbols(text, language, limit = 600) {
  if (!text) return [];
  const rules = RULE_MAP[language] || FALLBACK;
  if (!rules || !rules.length) return [];

  const lines = text.split('\n');
  /** @type {OutlineSymbol[]} */
  const out = [];
  const seen = new Set();

  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const line = lines[i];
    if (!line || line.length > 400) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 跳过注释行
    if (/^(\/\/|#(?!\s*#)|--|\*)/.test(trimmed) && language !== 'python' && language !== 'markdown') {
      continue;
    }
    for (const rule of rules) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = (m[rule.name] || '').trim();
      if (!name || name.length > 90) continue;
      const key = `${i + 1}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line: i + 1, name, kind: rule.kind });
      break;
    }
  }
  return out;
}
