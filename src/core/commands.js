/**
 * QuillPad · 命令注册表
 *
 * 界面上所有可执行动作（菜单项 / 工具栏按钮 / 快捷键 / 命令面板）都来自这里，
 * 保证「一处定义，处处可用」，不会出现按钮和菜单行为不一致的问题。
 */

import { t } from './i18n.js';

/** @type {Map<string, object>} id -> command */
const registry = new Map();

/** @type {Array<object>} 注册顺序 */
const order = [];

/**
 * @typedef {object} Command
 * @property {string} id 唯一标识
 * @property {string} title 显示名
 * @property {string} category 分类（菜单 / 命令面板中显示）
 * @property {string[]} [keys] 单步快捷键，CodeMirror 键名格式，如 "Mod-s"
 * @property {string} [chord] 两段式快捷键，如 "Mod-k o"
 * @property {boolean} [hidden] 是否在命令面板中隐藏
 * @property {() => boolean} [toggle] 返回复选框状态
 * @property {() => boolean} [enabled] 返回是否可用
 * @property {(ctx: object, evt?: Event) => any} run 执行体
 */

/**
 * 注册一条命令。
 * @param {Command} cmd
 * @return {Command}
 */
export function defineCommand(cmd) {
  if (!cmd || !cmd.id) throw new Error('命令必须有 id');
  if (registry.has(cmd.id)) {
    console.warn(`[QuillPad] 命令 "${cmd.id}" 被重复注册，后者覆盖前者`);
    const i = order.findIndex((c) => c.id === cmd.id);
    if (i >= 0) order.splice(i, 1);
  }
  const full = {
    keys: [],
    chord: '',
    hidden: false,
    // 默认分类会出现在命令面板里（未显式指定 category 的插件命令用它），
    // 因此必须在注册时按当前语言求值。
    category: t('其他', 'Other'),
    title: cmd.id,
    ...cmd,
  };
  registry.set(cmd.id, full);
  order.push(full);
  return full;
}

/**
 * 批量注册。
 * @param {Command[]} list
 */
export function defineCommands(list) {
  list.forEach(defineCommand);
}

/**
 * 把组合键归一成可比较的形式（修饰键顺序、别名都不敏感）。
 *
 * `Mod-Alt-u` / `Alt-Mod-U` / `Ctrl-Alt-u`（非 mac）应当被判定为同一个键；
 * 两段式 `Mod-k o` 会逐段归一后重新拼回去。
 *
 * @param {string} chord
 * @return {string}
 */
export function normalizeChord(chord) {
  const raw = String(chord || '').trim().toLowerCase();
  if (!raw) return '';
  if (/\s/.test(raw)) {
    return raw
      .split(/\s+/)
      .map((part) => normalizeChord(part))
      .join(' ');
  }
  let main = '';
  let mods = [];
  if (raw.endsWith('--')) {
    // "Mod--"：结尾的减号键本身
    main = '-';
    mods = raw.slice(0, -2).split('-').filter(Boolean);
  } else {
    const parts = raw.split('-');
    main = parts.pop() || '';
    mods = parts;
  }
  const ALIAS = { cmd: 'mod', control: 'ctrl', win: 'meta', super: 'meta', option: 'alt' };
  const normalized = [...new Set(mods.map((m) => ALIAS[m] || m))].sort();
  return [...normalized, main].join('-');
}

/**
 * 找出已经占用某个组合键的命令。
 *
 * 插件注册快捷键前必须问一次：插件不该覆盖内置命令的键位（Ctrl+S 永远是保存）。
 * 两段式快捷键的首段也算占用 —— 抢走 `Mod-k` 会让 `Mod-k o` 失效。
 *
 * @param {string} chord
 * @param {string} [exceptId] 忽略的命令 id（重复注册自身时用）
 * @return {object|null} 占用者
 */
export function chordOwner(chord, exceptId = '') {
  const want = normalizeChord(chord);
  if (!want) return null;
  for (const cmd of order) {
    if (exceptId && cmd.id === exceptId) continue;
    const used = [...(cmd.keys || [])];
    if (cmd.chord) used.push(...String(cmd.chord).split(/\s+/));
    if (used.some((k) => normalizeChord(k) === want)) return cmd;
  }
  return null;
}

/**
 * 去掉冲突的键位，只留下真正可用的那一个。
 *
 * @param {string[]} chords
 * @param {string} [exceptId]
 * @return {{keys: string[], conflicts: {chord: string, owner: string}[]}}
 */
export function filterAvailableChords(chords, exceptId = '') {
  const keys = [];
  const conflicts = [];
  for (const chord of chords || []) {
    if (!chord) continue;
    const owner = chordOwner(chord, exceptId);
    if (owner) conflicts.push({ chord, owner: owner.id });
    else keys.push(chord);
  }
  return { keys, conflicts };
}

/**
 * 取命令。
 * @param {string} id
 * @return {Command|undefined}
 */
export function getCommand(id) {
  return registry.get(id);
}

/**
 * 全部命令（注册顺序）。
 * @return {Command[]}
 */
export function allCommands() {
  return order.slice();
}

/**
 * 注销一条命令（插件禁用 / 卸载时同时清 registry 与 order，防 R10 残留）。
 * @param {string} id
 * @return {boolean} 是否确实删掉了一条
 */
export function unregisterCommand(id) {
  if (!registry.has(id)) return false;
  registry.delete(id);
  const i = order.findIndex((c) => c.id === id);
  if (i >= 0) order.splice(i, 1);
  return true;
}

/**
 * 清空内置命令注册表，供界面语言切换后重新注册 —— 命令标题是注册时用 t()
 * 算出来的，不重注册就不会跟着语言变。
 *
 * 插件贡献的命令 id 一律以 `plugin.` 开头，它们由插件宿主动态注册，这里保留：
 * 否则切换一次语言就会把已启用插件的命令全部抹掉。
 *
 * @param {string} [keepPrefix='plugin.'] 保留的命令 id 前缀；传 '' 则全清
 */
export function resetCommands(keepPrefix = 'plugin.') {
  for (const id of [...registry.keys()]) {
    if (!keepPrefix || !id.startsWith(keepPrefix)) registry.delete(id);
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (keepPrefix && order[i].id.startsWith(keepPrefix)) continue;
    order.splice(i, 1);
  }
}

/** 是否 macOS（用于快捷键展示，不影响注册）。 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '');

const KEY_LABELS = {
  mod: IS_MAC ? '⌘' : 'Ctrl',
  cmd: IS_MAC ? '⌘' : 'Ctrl',
  ctrl: 'Ctrl',
  shift: IS_MAC ? '⇧' : 'Shift',
  alt: IS_MAC ? '⌥' : 'Alt',
  meta: IS_MAC ? '⌘' : 'Win',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  space: 'Space',
  plus: '+',
  minus: '-',
  equal: '=',
  slash: '/',
  backslash: '\\',
  '[': '[',
  ']': ']',
};

/**
 * 把 CodeMirror 风格的键名转成可展示的按键数组。
 * @param {string} chord 例如 "Mod-Shift-p"
 * @return {string[]}
 */
export function chordToLabels(chord) {
  let src = String(chord);
  let tail = '';
  // "Mod--" 表示减号键，需要单独处理
  if (src.endsWith('--')) {
    tail = '-';
    src = src.slice(0, -2);
  }
  const labels = src
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((part) => {
      const key = part.toLowerCase();
      if (KEY_LABELS[key]) return KEY_LABELS[key];
      if (key.length === 1) return key.toUpperCase();
      if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  if (tail) labels.push(tail);
  return labels;
}

/**
 * 取一条命令的完整快捷键展示（可能是两段式）。
 * @param {Command} cmd
 * @return {string[][]} 每一段是一个按键标签数组
 */
export function commandShortcutLabels(cmd) {
  if (!cmd) return [];
  if (cmd.chord) {
    return cmd.chord.split(' ').map(chordToLabels);
  }
  if (cmd.keys && cmd.keys.length) {
    return [chordToLabels(cmd.keys[0])];
  }
  return [];
}

/**
 * 单调快捷键文本，用于 tooltip。
 * @param {Command|undefined} cmd
 * @return {string}
 */
export function commandShortcutText(cmd) {
  const parts = commandShortcutLabels(cmd);
  if (!parts.length) return '';
  return parts.map((p) => p.join(IS_MAC ? '' : '+')).join(' ');
}

/**
 * 命令当前是否可用。
 *
 * 菜单栏、工具栏、命令面板三处必须用同一个判断，否则会出现
 * 「菜单里是灰的、命令面板里却是亮的、回车又没反应」的不一致（QA 建议 D-6）。
 *
 * @param {string} id
 * @return {boolean}
 */
export function isCommandAvailable(id) {
  const cmd = registry.get(id);
  if (!cmd) return false;
  return cmd.enabled ? !!cmd.enabled() : true;
}

/**
 * @typedef {object} CommandResult
 * @property {boolean} ok 命令是否成功执行
 * @property {string} [id] 命令 id
 * @property {'disabled'|'not-found'|'error'} [reason] 失败原因
 * @property {any} [result] 命令体自身的返回值（ok 为 true 时）
 * @property {Error} [error] 抛出的异常（reason 为 error 时）
 */

/**
 * 执行命令。
 *
 * 统一返回结构化结果，**不再静默返回 undefined**：
 * - 命令不存在 → { ok:false, reason:'not-found' }
 * - 命令当前不可用 → { ok:false, reason:'disabled' }
 * - 执行抛错 → { ok:false, reason:'error', error }
 * - 执行成功 → { ok:true, result }
 *
 * 这样菜单 / 工具栏 / 命令面板三个入口可以基于同一份返回值做出一致的反馈。
 *
 * @param {string} id
 * @param {object} ctx
 * @param {Event} [evt]
 * @return {CommandResult}
 */
export function runCommand(id, ctx, evt) {
  const cmd = registry.get(id);
  if (!cmd) {
    console.warn(`[QuillPad] 未找到命令：${id}`);
    return { ok: false, reason: 'not-found', id };
  }
  if (cmd.enabled && !cmd.enabled()) {
    // 不可用的命令必须显式返回，调用方才能给出「当前不可用」这类明确反馈
    return { ok: false, reason: 'disabled', id };
  }
  try {
    const result = cmd.run(ctx, evt);
    // 命令体若自行返回了标准信封，则原样透传，避免套娃
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      return result;
    }
    return { ok: true, id, result };
  } catch (err) {
    console.error(`[QuillPad] 命令 "${id}" 执行失败：`, err);
    return { ok: false, reason: 'error', id, error: err };
  }
}
