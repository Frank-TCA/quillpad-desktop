/**
 * QuillPad · 语言支持
 *
 * 扩展名 → 语言 的映射表，以及按需动态加载的语言扩展（Vite 会为每个
 * 动态 import 生成独立 chunk，首屏不会加载全部语言包）。
 */

import { StreamLanguage } from '@codemirror/language';
import { t } from '../core/i18n.js';

/**
 * 从 legacy-modes 模块里挑出可用的 StreamParser。
 * @param {object} mod 动态 import 的模块命名空间
 * @param {string} prefer 期望的导出名
 * @return {object|null}
 */
function pickMode(mod, prefer) {
  if (!mod) return null;
  if (mod[prefer]) return mod[prefer];
  if (mod.default) return mod.default;
  for (const value of Object.values(mod)) {
    if (value && typeof value === 'object' && typeof value.token === 'function') return value;
  }
  return null;
}

/**
 * 包装 legacy 模式为 CodeMirror 扩展。
 * @param {() => Promise<object>} importer
 * @param {string} prefer
 * @return {() => Promise<any>}
 */
function legacy(importer, prefer) {
  return async () => {
    const mod = await importer();
    const mode = pickMode(mod, prefer);
    return mode ? StreamLanguage.define(mode) : [];
  };
}

/**
 * @typedef {object} LanguageDef
 * @property {string} id 内部 id
 * @property {string} label 展示名
 * @property {string[]} exts 关联扩展名（不含点）
 * @property {string[]} [files] 关联的完整文件名
 * @property {() => Promise<any>} load 加载扩展
 */

/** @type {LanguageDef[]} */
export const LANGUAGES = [
  {
    id: 'plaintext',
    // 语言名是专有名词不翻，但「纯文本」要跟随界面语言。
    // LANGUAGES 是模块级数组：label 用 getter 在读取点求值，labelEn 供
    // pickLocalized() 这类按 `<字段>En` 约定取值的渲染点直接命中。
    get label() {
      return t('纯文本', 'Plain Text');
    },
    labelEn: 'Plain Text',
    exts: ['txt', 'text', 'log', 'csv', 'tsv', 'env', 'gitignore', 'editorconfig'],
    files: ['.gitignore', '.editorconfig', '.env'],
    load: async () => [],
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    exts: ['js', 'mjs', 'cjs'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  },
  {
    id: 'jsx',
    label: 'JavaScript (JSX)',
    exts: ['jsx'],
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    exts: ['ts', 'mts', 'cts'],
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  },
  {
    id: 'tsx',
    label: 'TypeScript (TSX)',
    exts: ['tsx'],
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  },
  {
    id: 'json',
    label: 'JSON',
    exts: ['json', 'jsonc', 'json5', 'map'],
    load: async () => (await import('@codemirror/lang-json')).json(),
  },
  {
    id: 'html',
    label: 'HTML',
    exts: ['html', 'htm', 'xhtml', 'shtml'],
    load: async () => (await import('@codemirror/lang-html')).html(),
  },
  {
    id: 'vue',
    label: 'Vue',
    exts: ['vue'],
    load: async () => (await import('@codemirror/lang-vue')).vue(),
  },
  {
    id: 'css',
    label: 'CSS',
    exts: ['css'],
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  {
    id: 'scss',
    label: 'SCSS',
    exts: ['scss'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/sass'), 'sass'),
  },
  {
    id: 'less',
    label: 'Less',
    exts: ['less'],
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  {
    id: 'markdown',
    label: 'Markdown',
    exts: ['md', 'markdown', 'mdown', 'mkd'],
    // GFM：表格 / 任务列表 / 删除线是 WYSIWYG 装饰层的前提（ARCH §5 表格 & 任务项）
    load: async () => {
      const mod = await import('@codemirror/lang-markdown');
      return mod.markdown({
        base: mod.markdownLanguage,
        // 围栏代码块按 info string 嵌套真实语言解析 —— 否则 ```js / ```python
        // 里没有语法树，WYSIWYG 的代码行只能是纯文本色，关键字不会着色。
        codeLanguages: (info) => {
          const id = resolveLangId(info);
          if (!id || id === 'plaintext' || id === 'markdown') return null;
          if (!BY_ID.has(id)) return null;
          // 预热过就直接给 Language —— 本次解析即可产出语法树（关键字着色）。
          const ready = loadedLanguages.get(id);
          if (ready) return ready;
          // 没预热：先开始加载，本次按「跳过」处理；editor.js 会在语言就绪后
          // 重新配置一次 compartment，触发第二次解析（CodeMirror 不会自己重来）。
          void loadLanguage(id);
          return null;
        },
      });
    },
  },
  {
    id: 'python',
    label: 'Python',
    exts: ['py', 'pyw', 'pyi'],
    load: async () => (await import('@codemirror/lang-python')).python(),
  },
  {
    id: 'java',
    label: 'Java',
    exts: ['java'],
    load: async () => (await import('@codemirror/lang-java')).java(),
  },
  {
    id: 'c',
    label: 'C',
    exts: ['c', 'h'],
    load: async () => (await import('@codemirror/lang-cpp')).cpp(),
  },
  {
    id: 'cpp',
    label: 'C++',
    exts: ['cpp', 'cxx', 'cc', 'hpp', 'hxx', 'hh', 'ino'],
    load: async () => (await import('@codemirror/lang-cpp')).cpp(),
  },
  {
    id: 'csharp',
    label: 'C#',
    exts: ['cs'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp'),
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    exts: ['kt', 'kts'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  },
  {
    id: 'scala',
    label: 'Scala',
    exts: ['scala', 'sc'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'scala'),
  },
  {
    id: 'go',
    label: 'Go',
    exts: ['go'],
    load: async () => (await import('@codemirror/lang-go')).go(),
  },
  {
    id: 'rust',
    label: 'Rust',
    exts: ['rs'],
    load: async () => (await import('@codemirror/lang-rust')).rust(),
  },
  {
    id: 'php',
    label: 'PHP',
    exts: ['php', 'phtml'],
    load: async () => (await import('@codemirror/lang-php')).php(),
  },
  {
    id: 'ruby',
    label: 'Ruby',
    exts: ['rb', 'rake', 'gemspec'],
    files: ['Gemfile', 'Rakefile'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  },
  {
    id: 'shell',
    label: 'Shell',
    exts: ['sh', 'bash', 'zsh', 'fish', 'ksh', 'command'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  },
  {
    id: 'batch',
    label: 'Batch',
    exts: ['bat', 'cmd'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    exts: ['ps1', 'psm1', 'psd1'],
    load: legacy(
      () => import('@codemirror/legacy-modes/mode/powershell'),
      'powershell',
    ),
  },
  {
    id: 'sql',
    label: 'SQL',
    exts: ['sql', 'mysql', 'pgsql', 'sqlite'],
    load: async () => (await import('@codemirror/lang-sql')).sql(),
  },
  {
    id: 'xml',
    label: 'XML',
    exts: ['xml', 'xsd', 'xsl', 'svg', 'plist', 'csproj', 'props'],
    load: async () => (await import('@codemirror/lang-xml')).xml(),
  },
  {
    id: 'yaml',
    label: 'YAML',
    exts: ['yaml', 'yml'],
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  },
  {
    id: 'toml',
    label: 'TOML',
    exts: ['toml', 'cargo'],
    files: ['Cargo.lock'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  },
  {
    id: 'ini',
    label: 'INI / Properties',
    exts: ['ini', 'cfg', 'conf', 'properties', 'prefs'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/properties'), 'properties'),
  },
  {
    id: 'lua',
    label: 'Lua',
    exts: ['lua'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/lua'), 'lua'),
  },
  {
    id: 'perl',
    label: 'Perl',
    exts: ['pl', 'pm', 't'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/perl'), 'perl'),
  },
  {
    id: 'r',
    label: 'R',
    exts: ['r', 'rmd'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/r'), 'r'),
  },
  {
    id: 'swift',
    label: 'Swift',
    exts: ['swift'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  },
  {
    id: 'dockerfile',
    label: 'Dockerfile',
    exts: ['dockerfile'],
    files: ['Dockerfile', 'Containerfile'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  },
  {
    id: 'diff',
    label: 'Diff / Patch',
    exts: ['diff', 'patch'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff'),
  },
  {
    id: 'cmake',
    label: 'CMake',
    exts: ['cmake'],
    files: ['CMakeLists.txt', 'Makefile'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/cmake'), 'cmake'),
  },
  {
    id: 'nginx',
    label: 'Nginx',
    exts: ['nginx'],
    files: ['nginx.conf'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx'),
  },
  {
    id: 'latex',
    label: 'LaTeX',
    exts: ['tex', 'latex'],
    load: legacy(() => import('@codemirror/legacy-modes/mode/stex'), 'stex'),
  },
];

/** @type {Map<string, LanguageDef>} */
const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

/** @type {Map<string, LanguageDef>} */
const BY_EXT = new Map();
for (const lang of LANGUAGES) {
  for (const ext of lang.exts) BY_EXT.set(ext, lang);
}

/** @type {Map<string, LanguageDef>} */
const BY_FILE = new Map();
for (const lang of LANGUAGES) {
  for (const file of lang.files || []) BY_FILE.set(file.toLowerCase(), lang);
}
// 常见特殊文件名补充
BY_FILE.set('makefile', BY_EXT.get('cmake'));
BY_FILE.set('dockerfile', BY_EXT.get('dockerfile'));
BY_FILE.set('gemfile', BY_EXT.get('ruby'));
BY_FILE.set('rakefile', BY_EXT.get('ruby'));

/** 语言扩展缓存（缓存 Promise，避免重复加载）。 */
const extCache = new Map();

/** 已解析出的 Language 实例（供 Markdown 围栏代码同步取用）。 */
const loadedLanguages = new Map();

/**
 * 取语言定义。
 * @param {string} id
 * @return {LanguageDef}
 */
export function getLanguageDef(id) {
  return BY_ID.get(id) || BY_ID.get('plaintext');
}

/**
 * 语言显示名。
 * @param {string} id
 * @return {string}
 */
export function languageLabel(id) {
  return getLanguageDef(id).label;
}

/**
 * 根据文件名推断语言 id。
 * @param {string} name 文件名（可含路径）
 * @return {string}
 */
export function guessLanguage(name) {
  if (!name) return 'plaintext';
  const base = String(name).split(/[\\/]/).pop() || '';
  const lower = base.toLowerCase();

  const byFile = BY_FILE.get(lower);
  if (byFile) return byFile.id;

  const dot = lower.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = lower.slice(dot + 1);
  const byExt = BY_EXT.get(ext);
  return byExt ? byExt.id : 'plaintext';
}

/**
 * 从加载回来的扩展里挑出 Language 实例。
 *
 * 语言包可能返回 `LanguageSupport`、裸 `Language`、`StreamLanguage` 或它们的数组，
 * 这里统一收敛成一个能 `.parser.parse()` 的实例，供围栏代码嵌套解析与着色复用。
 *
 * @param {any} ext
 * @return {object|null}
 */
export function pickLanguage(ext) {
  if (!ext) return null;
  const list = Array.isArray(ext) ? ext.flat(4) : [ext];
  for (const item of list) {
    if (!item) continue;
    if (item.language && item.language.parser) return item.language;
    if (item.parser && typeof item.parser.parse === 'function') return item;
  }
  return null;
}

/**
 * 把围栏语言标记归一成语言 id。
 *
 * Markdown 里惯用 ```js / ```py / ```sh 这类**扩展名式**别名，而本表的 id 是
 * `javascript` / `python` / `shell`。只按 id 查会让这些块静默退化成纯文本
 * （WYSIWYG 语言标签显示「纯文本」、分屏预览与 PDF 不着色），所以再用扩展名表兜底。
 *
 * @param {string} raw 围栏后的语言标记，如 `js`
 * @return {string} 语言 id；解析不出时原样返回（空串表示没有标记）
 */
export function resolveLangId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase();
  if (!id) return '';
  if (BY_ID.has(id)) return id;
  const byExt = guessLanguage(`x.${id}`);
  return byExt === 'plaintext' ? id : byExt;
}

/**
 * 围栏标记的展示名（`bash` → `Shell`）。
 *
 * @param {string} raw 围栏标记
 * @return {string} 中文展示名；无法识别时原样返回标记
 */
export function codeTagLabel(raw) {
  const tag = String(raw || '').trim();
  if (!tag) return t('纯文本', 'Plain Text');
  const id = resolveLangId(tag);
  return BY_ID.has(id) ? languageLabel(id) : tag;
}

/**
 * 按需加载语言扩展。
 * @param {string} id 语言 id
 * @return {Promise<any>} CodeMirror 扩展
 */
export function loadLanguage(id) {
  const def = getLanguageDef(id);
  if (extCache.has(def.id)) return extCache.get(def.id);
  const p = Promise.resolve()
    .then(() => def.load())
    .then((ext) => {
      const lang = pickLanguage(ext);
      if (lang) loadedLanguages.set(def.id, lang);
      return ext;
    })
    .catch((err) => {
      console.warn(`[QuillPad] 加载语言 "${def.id}" 失败：`, err);
      return [];
    });
  extCache.set(def.id, p);
  return p;
}

/**
 * 取**已经加载好**的语言实例（同步）。
 *
 * Markdown 的 `codeLanguages` 是同步回调，只有拿得到现成 Language 才能让围栏
 * 代码立刻带语法树 —— 返回 LanguageDescription 会走 `getSkippingParser`，
 * 而 CodeMirror 在文档已解析完后不会再为它重新解析（实测无高亮）。
 * 所以要在打开文档 / 输入围栏时先预热（见 `primeFenceLanguages`）。
 *
 * @param {string} id 语言 id
 * @return {object|null}
 */
export function getLoadedLanguage(id) {
  const def = getLanguageDef(id);
  return loadedLanguages.get(def.id) || null;
}

/**
 * 预热一段 Markdown 文本里所有围栏代码块用到的语言。
 *
 * @param {string} text Markdown 源码
 * @return {Promise<string[]>} 本次真正需要等待加载的语言 id
 */
export async function primeFenceLanguages(text) {
  const ids = new Set();
  const src = String(text || '');
  const re = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gm;
  let m = re.exec(src);
  while (m) {
    const id = resolveLangId(m[1]);
    if (id && id !== 'plaintext' && id !== 'markdown' && BY_ID.has(id)) ids.add(id);
    m = re.exec(src);
  }
  const pending = [...ids].filter((id) => !loadedLanguages.has(id));
  if (pending.length) await Promise.all(pending.map((id) => loadLanguage(id)));
  return pending;
}

/** 供「语言」菜单使用的按 label 排序列表。 */
export function languageMenuList() {
  return LANGUAGES.slice().sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/**
 * 语言分组（供「语言」菜单二级子菜单使用）。
 *
 * 按技术领域把 40 种语言归入 5 组，避免一级下拉过长。
 * @return {Array<{label: string, items: Array<{id: string, label: string}>}>}
 */
export function languageGroups() {
  /**
   * 分组名用 t() 在**函数体内**求值：languageGroups() 是渲染时才调用的，
   * 写成模块级常量就会在 import 期把语言冻结住。
   * 语言条目本身的 label（JavaScript / C++ / Python…）是专有名词，不翻。
   * @type {Array<{label: string, ids: string[]}>}
   */
  const GROUP_IDS = [
    { label: t('Web 前端', 'Web'), ids: ['javascript', 'jsx', 'typescript', 'tsx', 'html', 'vue', 'css', 'scss', 'less'] },
    { label: t('数据与配置', 'Data'), ids: ['json', 'yaml', 'toml', 'ini', 'xml', 'sql'] },
    { label: t('脚本与 Shell', 'Scripts'), ids: ['python', 'ruby', 'php', 'perl', 'lua', 'r', 'shell', 'batch', 'powershell'] },
    { label: t('系统与编译型', 'System'), ids: ['java', 'c', 'cpp', 'csharp', 'kotlin', 'scala', 'go', 'rust', 'swift'] },
    { label: t('文档与运维', 'Documents'), ids: ['markdown', 'latex', 'dockerfile', 'cmake', 'nginx', 'plaintext', 'diff'] },
  ];
  const byId = new Map(LANGUAGES.map((l) => [l.id, l]));
  const used = new Set();
  const groups = GROUP_IDS.map(({ label, ids }) => ({
    label,
    items: ids
      .filter((id) => byId.has(id))
      .map((id) => {
        used.add(id);
        const l = byId.get(id);
        return { id: l.id, label: l.label };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')),
  }));
  // 兜底：未归组的语言塞进「其他」
  const rest = LANGUAGES.filter((l) => !used.has(l.id))
    .map((l) => ({ id: l.id, label: l.label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  if (rest.length) groups.push({ label: t('其他', 'Other'), items: rest });
  return groups;
}

/**
 * 是否是 Markdown（用于决定是否显示预览按钮）。
 * @param {string} id
 * @return {boolean}
 */
export function isMarkdown(id) {
  return id === 'markdown';
}
