/**
 * 生成插件市场 / Npp 映射的发布态数据。
 *
 * 为什么用脚本而不是手抄两份 JSON：
 *  - `src/data/*.json` 是源码态（给 QA / 单测读），
 *    `public/*.json` 是 Vite 原样拷进 dist 的发布态，两份必须**逐字节一致**；
 *  - npp-compat 要求恰好 40 条且 12/12/16 分布，手写极易数错。
 *
 * 运行：node scripts/gen-plugin-data.mjs（改完表格重跑即可）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* [编号, N++ 插件, 原 License, status, 等价项, 批次/原因] */
const TABLE = [
  [1, 'NppExec', 'GPL-2.0', 'unsupported', '—', '需在沙箱外执行任意本地命令；插件模型不提供 Node/子进程权限'],
  [2, 'Python Script', 'GPL-2.0', 'unsupported', '—', '需嵌入 Python 运行时与原生绑定（体积 +150MB），且原插件 GPL'],
  [3, 'Compare', 'GPL-2.0', 'unsupported', '—', '需独立 diff 视图与三方合并语义，v2 未排期'],
  [4, 'JSON Viewer', 'GPL-3.0', 'port', 'quillpad.dev-tools', '首版'],
  [5, 'XML Tools', 'GPL-3.0', 'unsupported', '—', '需 XPath/XSD 校验引擎，使用频次低，v2 未排期'],
  [6, 'TextFX Characters', 'GPL-2.0', 'port', 'quillpad.text-tools', '首版'],
  [7, 'NppFTP', 'GPL-2.0', 'unsupported', '—', '网络凭据管理与 FTP/SFTP 协议栈，明确不做'],
  [8, 'Explorer', 'MIT', 'builtin', 'v1 文件树（sidebar.js）', ''],
  [9, 'DSpellCheck', 'LGPL/GPL/MPL', 'unsupported', '—', '安全分支仅 MPL，中文场景收益低，v2 不引入'],
  [10, 'MarkdownViewer++', 'MIT', 'builtin', 'WYSIWYG + split 预览', ''],
  [11, 'Markdown Panel', 'MIT', 'builtin', '大纲 + 文档地图', ''],
  [12, 'Preview HTML', 'MIT', 'builtin', 'split 预览', ''],
  [13, 'Converter', 'MIT', 'port', 'quillpad.text-tools', '首版'],
  [14, 'Column Tools', 'GPL-2.0', 'builtin', '列选择 + 列编辑', ''],
  [15, 'CSV Lint', 'MIT', 'port', 'quillpad.md-tools', '后续'],
  [16, 'Emmet', 'MIT', 'port', '—', '后续'],
  [17, 'QuickText', 'GPL-2.0', 'unsupported', '宏（命令序列）部分替代', '需 snippet 占位符/变量引擎，v2 以命令序列宏替代'],
  [18, 'Snippet', 'GPL-3.0', 'unsupported', '—', '需片段仓库与循环占位语义，沙箱不提供文件写入'],
  [19, 'Regex Trainer', 'MIT', 'port', 'quillpad.dev-tools', '首版'],
  [20, 'Insertion', 'GPL-2.0', 'port', 'quillpad.text-tools', '首版'],
  [21, 'Speech', '闭源', 'unsupported', '—', '需 Windows SAPI 原生 TTS 绑定，Electron 无标准接口'],
  [22, 'NppCalc', 'GPL-2.0', 'unsupported', '—', '需表达式求值引擎；插件沙箱禁用 eval 与 Function'],
  [23, 'RunMe', 'GPL-2.0', 'unsupported', '—', '同 NppExec，需要子进程执行能力，沙箱不提供'],
  [24, 'MIME Tools', 'Apache-2.0', 'port', 'quillpad.text-tools', '首版'],
  [25, 'BetterMultiSelection', 'MIT', 'builtin', '多光标 + 列编辑', ''],
  [26, 'WebEdit', 'GPL-2.0', 'unsupported', '—', '需浏览器内核双向定位，与 WYSIWYG 单一文档模型冲突'],
  [27, 'AutoSave', 'MIT', 'builtin', '自动保存（1.5s 防抖）', ''],
  [28, 'Bookmark', 'MIT', 'unsupported', '—', '书签能力登记为 P2，v2 不实现'],
  [29, 'Code Alignment', 'MIT', 'port', 'quillpad.text-tools', '首版'],
  [30, 'CCompletion', 'MIT', 'port', 'CodeMirror autocompletion', '后续'],
  [31, 'Light Explorer', 'MIT', 'builtin', '文件树 + 命令面板', ''],
  [32, 'LuaScript', 'GPL-2.0', 'unsupported', '—', '需 Lua 原生绑定；沙箱不允许嵌入执行引擎'],
  [33, 'NppCrypt', 'MIT', 'unsupported', '—', '加密属安全敏感能力，需独立审计，非编辑器核心'],
  [34, 'HTML Tag', 'MIT', 'port', '括号匹配扩展', '后续'],
  [35, 'Tags Jump', 'MIT', 'port', '大纲符号跳转', '后续'],
  [36, 'File Switcher', 'MIT', 'builtin', 'Tab 切换 + 命令面板', ''],
  [37, 'Session Manager', 'MIT', 'builtin', '会话持久化', ''],
  [38, 'Document Map', 'MIT', 'builtin', '文档地图', ''],
  [39, 'Terminal', 'MIT', 'unsupported', '—', '内嵌终端需 PTY 与原生模块，与沙箱/签名策略冲突'],
  [40, 'NppMenuSearch', 'MIT', 'builtin', '命令面板（Mod-Shift-P）', ''],
];

/**
 * 英文字段字典：中文原文 → English。
 *
 * 只给「含中文」的字段补 `<字段>En`，中文列保持一字不改（它是界面文案的 key，
 * 也是 data-check 的断言依据）。纯 ASCII 的值（如 `quillpad.dev-tools`、许可名）
 * 不需要英文副本，回落原值即可。
 */
const SOURCE_EN = 'QuillPad compatibility mapping (compiled by the author; plugin names and license identifiers belong to their respective owners)';
const REASON_EN = {
  '需在沙箱外执行任意本地命令；插件模型不提供 Node/子进程权限':
    'Requires running arbitrary local commands outside the sandbox; the plugin model exposes no Node or child-process permission.',
  '需嵌入 Python 运行时与原生绑定（体积 +150MB），且原插件 GPL':
    'Requires embedding a Python runtime and native bindings (+150 MB), and the original plugin is GPL-licensed.',
  '需独立 diff 视图与三方合并语义，v2 未排期':
    'Requires a dedicated diff view and three-way merge semantics; not scheduled for v2.',
  '需 XPath/XSD 校验引擎，使用频次低，v2 未排期':
    'Requires an XPath/XSD validation engine; low usage and not scheduled for v2.',
  '网络凭据管理与 FTP/SFTP 协议栈，明确不做':
    'Requires network credential management and an FTP/SFTP protocol stack; explicitly out of scope.',
  '安全分支仅 MPL，中文场景收益低，v2 不引入':
    'Only the MPL-licensed security branch is usable; limited benefit for Chinese-language use, so it is not included in v2.',
  '需 snippet 占位符/变量引擎，v2 以命令序列宏替代':
    'Requires a snippet placeholder/variable engine; v2 replaces it with command-sequence macros.',
  '需片段仓库与循环占位语义，沙箱不提供文件写入':
    'Requires a snippet repository and looping placeholder semantics; the sandbox provides no file-write access.',
  '需 Windows SAPI 原生 TTS 绑定，Electron 无标准接口':
    'Requires native Windows SAPI TTS bindings; Electron exposes no standard API for it.',
  '需表达式求值引擎；插件沙箱禁用 eval 与 Function':
    'Requires an expression evaluation engine; the plugin sandbox disables eval and Function.',
  '同 NppExec，需要子进程执行能力，沙箱不提供':
    'Same as NppExec: requires child-process execution, which the sandbox does not provide.',
  '需浏览器内核双向定位，与 WYSIWYG 单一文档模型冲突':
    'Requires two-way positioning in the browser engine, which conflicts with the single-document WYSIWYG model.',
  '书签能力登记为 P2，v2 不实现':
    'Bookmarks are tracked as a P2 feature and are not implemented in v2.',
  '需 Lua 原生绑定；沙箱不允许嵌入执行引擎':
    'Requires native Lua bindings; the sandbox does not allow embedding execution engines.',
  '加密属安全敏感能力，需独立审计，非编辑器核心':
    'Encryption is security-sensitive, needs an independent audit, and is outside the editor core.',
  '内嵌终端需 PTY 与原生模块，与沙箱/签名策略冲突':
    'An embedded terminal requires a PTY and native modules, which conflicts with the sandbox and signing policy.',
};
const EQUIVALENT_EN = {
  'v1 文件树（sidebar.js）': 'v1 File Tree (sidebar.js)',
  'WYSIWYG + split 预览': 'WYSIWYG + Split Preview',
  '大纲 + 文档地图': 'Outline + Document Map',
  'split 预览': 'Split Preview',
  '列选择 + 列编辑': 'Column Selection + Column Editing',
  '宏（命令序列）部分替代': 'Partially replaced by Macros (command sequences)',
  '多光标 + 列编辑': 'Multiple Cursors + Column Editing',
  '自动保存（1.5s 防抖）': 'Auto Save (1.5s debounce)',
  '文件树 + 命令面板': 'File Tree + Command Palette',
  '括号匹配扩展': 'Bracket Matching Extensions',
  '大纲符号跳转': 'Outline Symbol Navigation',
  'Tab 切换 + 命令面板': 'Tab Switching + Command Palette',
  '会话持久化': 'Session Persistence',
  '文档地图': 'Document Map',
  '命令面板（Mod-Shift-P）': 'Command Palette (Mod-Shift-P)',
};
const BATCH_EN = { '首版': 'First Release', '后续': 'Later' };
const LICENSE_EN = { '闭源': 'Proprietary' };

const rows = TABLE.map(([no, nppPlugin, nppLicense, status, quillpadEquivalent, extra]) => {
  const row = {
    no,
    nppPlugin,
    nppLicense,
    status,
    quillpadEquivalent,
    installable: status === 'port' && extra === '首版',
  };
  if (LICENSE_EN[nppLicense]) row.nppLicenseEn = LICENSE_EN[nppLicense];
  if (EQUIVALENT_EN[quillpadEquivalent]) row.quillpadEquivalentEn = EQUIVALENT_EN[quillpadEquivalent];
  if (status === 'port') {
    row.batch = extra;
    row.batchEn = BATCH_EN[extra] || extra;
  }
  if (status === 'unsupported') {
    row.reason = extra;
    row.reasonEn = REASON_EN[extra] || extra;
  }
  return row;
});

const counts = {
  builtin: rows.filter((r) => r.status === 'builtin').length,
  port: rows.filter((r) => r.status === 'port').length,
  unsupported: rows.filter((r) => r.status === 'unsupported').length,
  installable: rows.filter((r) => r.installable).length,
};
if (rows.length !== 40 || counts.builtin !== 12 || counts.port !== 12 || counts.unsupported !== 16 || counts.installable !== 7) {
  throw new Error(`映射表分布不对：${JSON.stringify({ total: rows.length, ...counts })}`);
}

const compat = {
  version: 1,
  source: 'QuillPad 兼容性映射（作者自行整理；插件名称与许可标识属各自权利人）',
  sourceEn: SOURCE_EN,
  counts,
  items: rows,
};
const compatText = `${JSON.stringify(compat, null, 2)}\n`;

const catalogText = readFileSync(path.join(root, 'src', 'data', 'catalog.json'), 'utf8');
JSON.parse(catalogText); // 坏 JSON 直接在这里暴露

mkdirSync(path.join(root, 'public', 'plugins'), { recursive: true });
writeFileSync(path.join(root, 'src', 'data', 'npp-compat.json'), compatText, 'utf8');
writeFileSync(path.join(root, 'public', 'npp-compat.json'), compatText, 'utf8');
writeFileSync(path.join(root, 'public', 'plugins', 'catalog.json'), catalogText, 'utf8');

console.log(
  `已生成：npp-compat.json 40 条（builtin ${counts.builtin} / port ${counts.port} / unsupported ${counts.unsupported}，` +
    `首版可一键安装 ${counts.installable} 条）；catalog.json ${JSON.parse(catalogText).plugins.length} 条`,
);
