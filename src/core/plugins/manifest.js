/**
 * QuillPad · 插件清单校验与静态扫描（纯函数，可 Node 单测）
 *
 * 校验分三层：schema（字段/类型/未知字段）→ License 白名单 → engines 版本。
 * 静态扫描是「安装前」的最后一道闸：命中任一禁用调用即拒绝并给出行号，
 * 运行时还有 prelude 删除全局作为第二道兜底（G5-1 / R9）。
 */

import { errorOf } from './errors.js';
import { APP_VERSION } from '../version.js';

/** 允许随 QuillPad 分发的 License（PRD §4.G4）。 */
export const LICENSE_WHITELIST = Object.freeze([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
]);

/** 权限枚举（未声明即无权）。 */
export const PERMISSIONS = Object.freeze([
  'editor:read',
  'editor:write',
  'files:read',
  'files:write',
  'clipboard',
  'network',
  'settings',
]);

/** 权限的中文名与后果说明（权限确认弹窗用）。 */
export const PERMISSION_LABELS = Object.freeze({
  'editor:read': { name: '读取编辑内容', effect: '读取你正在编辑的文本与选区', apis: 'editor.getSelection / editor.getText' },
  'editor:write': { name: '修改编辑内容', effect: '替换选区、插入文本，会改动当前文档', apis: 'editor.replaceSelection / editor.insertText' },
  'files:read': { name: '读取文件信息', effect: '读取当前文档路径与内容', apis: 'files.getCurrent' },
  'files:write': { name: '写入文件', effect: '触发保存或另存，可覆盖磁盘上的文件', apis: 'files.save / files.saveAs' },
  clipboard: { name: '剪贴板', effect: '读取或写入系统剪贴板', apis: 'clipboard.read / clipboard.write' },
  network: { name: '网络访问', effect: '该插件可访问网络，可能把文件内容发送到外部服务器', apis: 'net.fetch' },
  settings: { name: '插件私有存储', effect: '保存插件自己的配置（≤ 1 MB）', apis: 'storage.get / storage.set' },
});

/** 高风险权限（需二次勾选确认）。 */
export const HIGH_RISK_PERMISSIONS = Object.freeze(['network', 'files:write']);

/** 清单允许的顶层字段（未知字段拒绝）。 */
const MANIFEST_KEYS = Object.freeze([
  'id',
  'name',
  'description',
  'author',
  'version',
  'license',
  'engines',
  'main',
  'permissions',
  'contributes',
  'signature',
]);

/** contributes 允许的字段。 */
const CONTRIBUTION_KEYS = Object.freeze([
  'commands',
  'menus',
  'sidebarViews',
  'statusItems',
  'themes',
  'languages',
]);

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CMD_ID_RE = /^[a-z][a-z0-9-]*$/;

/** 组合键里允许出现的修饰键名（与 src/core/keys.js 的 parseChord 同集）。 */
const MODIFIER_NAMES = Object.freeze([
  'mod',
  'cmd',
  'ctrl',
  'control',
  'shift',
  'alt',
  'option',
  'meta',
  'win',
  'super',
]);

/** 主修饰键：插件快捷键必须至少带一个，否则会抢走正常键入。 */
const PRIMARY_MODIFIERS = Object.freeze(['mod', 'cmd', 'ctrl', 'control', 'meta', 'win', 'super']);

/** 结尾键名白名单：单字符（字母 / 数字）、F1–F24、方向键。 */
const MAIN_KEY_RE = /^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|arrow(?:up|down|left|right))$/i;

/**
 * 校验插件清单里声明的快捷键。
 *
 * 与 `src/core/keys.js` 的 `parseChord` 保持同一套语法（`Mod-Alt-u` 这种
 * 连字符连接的写法），额外收紧三点：
 *  1. **必须**带主修饰键（只写 `u` 会把普通键入抢掉）；
 *  2. 只允许单段组合（两段式要空格分隔，而本编辑器的第二段不带修饰键，
 *     语义上无法由清单表达）；
 *  3. 结尾必须是单字符 / 功能键 / 方向键，名字不在白名单里一律拒绝。
 *
 * 主进程 `desktop/plugin-fs.cjs` 有一份等价实现（安装闸门不能依赖 ESM），
 * 两侧一致性由 `scripts/plugin-keys-check.mjs` 逐条比对。
 *
 * @param {string} chord
 * @return {boolean}
 */
export function isValidKeyChord(chord) {
  if (typeof chord !== 'string') return false;
  const raw = chord.trim();
  if (!raw || /\s/.test(raw)) return false;
  const parts = raw.split('-');
  if (parts.length < 2) return false;
  const main = parts.pop();
  if (!MAIN_KEY_RE.test(main)) return false;
  const mods = parts.map((p) => p.toLowerCase());
  if (!mods.every((m) => MODIFIER_NAMES.includes(m))) return false;
  if (!mods.some((m) => PRIMARY_MODIFIERS.includes(m))) return false;
  return true;
}

/** 静态扫描规则（PRD 6 项 + 设计新增 document. / fetch( / importScripts / XMLHttpRequest + P0-1 增补 Function( / import( / EventSource / WebTransport）。 */
export const SCAN_RULES = Object.freeze([
  { rule: 'eval(', re: /\beval\s*\(/ },
  { rule: 'new Function', re: /\bnew\s+Function\s*\(/ },
  { rule: '<script src="http', re: /<script[^>]+src\s*=\s*["']?https?:/i },
  { rule: 'require(', re: /\brequire\s*\(/ },
  { rule: 'process.', re: /\bprocess\s*\./ },
  { rule: '__dirname', re: /\b__dirname\b/ },
  { rule: 'document.', re: /\bdocument\s*\./ },
  { rule: 'fetch(', re: /\bfetch\s*\(/ },
  { rule: 'importScripts', re: /\bimportScripts\s*\(/ },
  { rule: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { rule: 'Function(', re: /\bFunction\s*\(/ },
  { rule: 'import(', re: /\bimport\s*\(/ },
  { rule: 'EventSource', re: /\bEventSource\b/ },
  { rule: 'WebTransport', re: /\bWebTransport\b/ },
]);

/**
 * 静态扫描：返回**首个**命中（含行号）。
 * @param {string} source 源码文本
 * @param {string} [fileName]
 * @return {{ok: true}|{ok: false, code: 'ESCAN', rule: string, file: string, line: number, text: string}}
 */
export function staticScan(source, fileName = 'main.js') {
  const text = String(source == null ? '' : source);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    // 去掉整行注释，避免「示例里提到 eval(」误伤（但字符串内的仍算命中，从严）
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const item of SCAN_RULES) {
      if (item.re.test(line)) {
        return {
          ok: false,
          code: 'ESCAN',
          rule: item.rule,
          file: String(fileName),
          line: i + 1,
          text: trimmed.slice(0, 160),
        };
      }
    }
  }
  return { ok: true };
}

/**
 * 极简 semver 比较。
 * @param {string} a
 * @param {string} b
 * @return {number} -1 / 0 / 1
 */
export function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0.0.0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * semver range 极简实现：支持 `^x.y.z` / `>=x.y.z` / `x.y.z` / `*`。
 * @param {string} version 当前版本
 * @param {string} range 约束
 * @return {boolean}
 */
export function satisfies(version, range) {
  const r = String(range || '').trim();
  if (!r || r === '*' || r === 'latest') return true;
  const m = /^(\^|>=|~|>|=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (!m) return false;
  const base = `${m[2]}.${m[3]}.${m[4]}`;
  const cmp = compareVersions(version, base);
  const op = m[1] || '=';
  if (op === '^' || op === '~') {
    const major = Number(m[2]);
    const parts = String(version || '0.0.0').split('.').map((n) => Number(n) || 0);
    return cmp >= 0 && parts[0] === major;
  }
  if (op === '>=') return cmp >= 0;
  if (op === '>') return cmp > 0;
  return cmp === 0;
}

/**
 * 严格校验 `plugin.json`。
 *
 * @param {string|object} raw JSON 文本或对象
 * @param {{quillpadVersion?: string, requireFiles?: boolean}} [ctx]
 * @return {{ok: true, manifest: object}|{ok: false, code: string, message: string, field?: string, detail?: string}}
 */
export function validateManifest(raw, ctx = {}) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      return { ok: false, ...errorOf('ESCHEMA', '不是合法 JSON'), field: 'root' };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, ...errorOf('ESCHEMA', '清单必须是对象'), field: 'root' };
  }

  const unknown = Object.keys(obj).filter((k) => !MANIFEST_KEYS.includes(k));
  if (unknown.length) {
    return { ok: false, ...errorOf('ESCHEMA', `未知字段：${unknown[0]}`), field: unknown[0] };
  }

  const required = ['id', 'name', 'description', 'author', 'version', 'license', 'engines', 'main', 'permissions', 'contributes'];
  for (const key of required) {
    if (!(key in obj)) return { ok: false, ...errorOf('ESCHEMA', `缺少字段 ${key}`), field: key };
  }

  for (const key of ['id', 'name', 'description', 'author', 'version', 'license', 'main']) {
    if (typeof obj[key] !== 'string' || !obj[key].trim()) {
      return { ok: false, ...errorOf('ESCHEMA', `字段 ${key} 必须是非空字符串`), field: key };
    }
  }
  if (!ID_RE.test(obj.id)) {
    return { ok: false, ...errorOf('ESCHEMA', 'id 必须是反向域名式（如 quillpad.dev-tools）'), field: 'id' };
  }
  if (obj.name.length > 40) {
    return { ok: false, ...errorOf('ESCHEMA', 'name 不得超过 40 字'), field: 'name' };
  }
  if (obj.description.length > 200) {
    return { ok: false, ...errorOf('ESCHEMA', 'description 不得超过 200 字'), field: 'description' };
  }
  if (!VERSION_RE.test(obj.version)) {
    return { ok: false, ...errorOf('ESCHEMA', 'version 必须是 x.y.z'), field: 'version' };
  }
  if (!LICENSE_WHITELIST.includes(obj.license)) {
    return { ok: false, ...errorOf('ELICENSE', obj.license), field: 'license' };
  }
  if (!obj.engines || typeof obj.engines !== 'object' || typeof obj.engines.quillpad !== 'string') {
    return { ok: false, ...errorOf('ESCHEMA', 'engines.quillpad 缺失'), field: 'engines' };
  }
  const current = String(ctx.quillpadVersion || APP_VERSION);
  if (!satisfies(current, obj.engines.quillpad)) {
    const major = String(obj.engines.quillpad).replace(/[^\d.]/g, '').split('.')[0] || '3';
    return { ok: false, ...errorOf('EENGINE', `需要 QuillPad ${major}.x`), field: 'engines.quillpad' };
  }
  if (!/\.(js|mjs)$/i.test(obj.main)) {
    return { ok: false, ...errorOf('ESCHEMA', 'main 必须是 .js / .mjs'), field: 'main' };
  }
  if (obj.main.includes('..') || obj.main.startsWith('/') || /[\\]/.test(obj.main)) {
    return { ok: false, ...errorOf('EPATH', 'main 路径不合法'), field: 'main' };
  }
  if (!Array.isArray(obj.permissions)) {
    return { ok: false, ...errorOf('ESCHEMA', 'permissions 必须是数组'), field: 'permissions' };
  }
  for (const p of obj.permissions) {
    if (!PERMISSIONS.includes(p)) {
      return { ok: false, ...errorOf('ESCHEMA', `未知权限：${String(p)}`), field: 'permissions' };
    }
  }
  const contrib = obj.contributes;
  if (!contrib || typeof contrib !== 'object' || Array.isArray(contrib)) {
    return { ok: false, ...errorOf('ESCHEMA', 'contributes 必须是对象'), field: 'contributes' };
  }
  for (const key of Object.keys(contrib)) {
    if (!CONTRIBUTION_KEYS.includes(key)) {
      return { ok: false, ...errorOf('ESCHEMA', `未知贡献项：${key}`), field: `contributes.${key}` };
    }
  }
  if (contrib.commands !== undefined) {
    if (!Array.isArray(contrib.commands)) {
      return { ok: false, ...errorOf('ESCHEMA', 'contributes.commands 必须是数组'), field: 'contributes.commands' };
    }
    /** @type {Map<string, string>} 归一化键位 → 命令 id（同一插件内不许撞车） */
    const keyOwners = new Map();
    const seenIds = new Set();
    for (const cmd of contrib.commands) {
      if (!cmd || typeof cmd.id !== 'string' || !CMD_ID_RE.test(cmd.id) || typeof cmd.title !== 'string') {
        return { ok: false, ...errorOf('ESCHEMA', '命令 id/title 不合法'), field: 'contributes.commands' };
      }
      if (seenIds.has(cmd.id)) {
        return { ok: false, ...errorOf('ESCHEMA', `命令 id 重复：${cmd.id}`), field: 'contributes.commands' };
      }
      seenIds.add(cmd.id);
      if (cmd.key === undefined || cmd.key === null) continue;
      if (!isValidKeyChord(cmd.key)) {
        return {
          ok: false,
          ...errorOf('ESCHEMA', `命令 ${cmd.id} 的快捷键不合法：${String(cmd.key)}（须形如 Mod-Alt-u）`),
          field: `contributes.commands.${cmd.id}.key`,
        };
      }
      const norm = cmd.key.trim().toLowerCase().split('-').sort().join('-');
      if (keyOwners.has(norm)) {
        return {
          ok: false,
          ...errorOf('ESCHEMA', `快捷键 ${cmd.key} 在插件内重复（${keyOwners.get(norm)} 与 ${cmd.id}）`),
          field: `contributes.commands.${cmd.id}.key`,
        };
      }
      keyOwners.set(norm, cmd.id);
    }
  }
  for (const key of ['menus', 'sidebarViews', 'statusItems', 'themes', 'languages']) {
    if (contrib[key] !== undefined && !Array.isArray(contrib[key])) {
      return { ok: false, ...errorOf('ESCHEMA', `contributes.${key} 必须是数组`), field: `contributes.${key}` };
    }
  }
  return { ok: true, manifest: obj };
}

/**
 * 判断某个权限是否属于高风险。
 * @param {string} p
 * @return {boolean}
 */
export function isHighRisk(p) {
  return HIGH_RISK_PERMISSIONS.includes(p);
}
