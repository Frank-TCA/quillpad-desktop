/**
 * QuillPad · 宏录制 / 回放 / 持久化
 *
 * 宏 = 一串「命令 id + 参数 + 当时的选区」的快照，回放时按顺序重新执行。
 * 刻意**不做**脚本引擎（N++ 的宏也是纯键序列，没有变量/循环）：
 * 引入 JS 求值就意味着一个可执行面，与「插件必须沙箱」的整体设计冲突。
 *
 * 三条硬约定：
 *  1. **录制只记命令层**：任何走 `runCommand` 的入口（菜单 / 工具栏 / 快捷键 /
 *     命令面板）都会被记录；直接在编辑器里敲的字**不会**被记录 ——
 *     因为那属于「文档编辑」，靠 `edit.*` 命令触发才进栈。
 *  2. **回放期间不再录制**：`playing` 标志同时挡住 `record`，否则一个
 *     `macro.play` 命令会把整段回放过程录成一条新宏。
 *  3. **非幂等命令不录**：打开/保存/关闭/导入导出这类命令录进去，
 *     回放时会弹出保存对话框甚至覆盖文件，属于"录制成功、回放灾难"。
 */

import { state } from './state.js';
import { getCommand, runCommand } from './commands.js';
import * as desktop from './desktop.js';

/** localStorage 兜底键（浏览器模式没有宏文件）。 */
const MACROS_KEY = 'quillpad.macros.v1';

/** 单条宏最多保留的步数（防止误录一整天的操作把文件撑爆）。 */
export const MAX_STEPS = 2000;

/** 宏总数上限。 */
export const MAX_MACROS = 200;

/**
 * 非幂等 / 危险命令：录制时跳过并 toast，回放时也拒绝执行。
 *
 * 与 ARCH §4.7 的清单一致。
 */
export const NON_REPLAYABLE = new Set([
  'file.new',
  'file.open',
  'file.openFolder',
  'file.save',
  'file.saveAs',
  'file.saveAll',
  'file.reload',
  'file.close',
  'pdf.export',
  'pdf.print',
  'macro.record',
  'macro.stop',
  'macro.play',
  'macro.manage',
  'plugin.install',
  'plugin.uninstall',
]);

/** @type {Array<object>} 内存里的宏列表 */
let macros = [];

/** 是否已经从磁盘读过一次。 */
let loaded = false;

/** 录制状态。 */
const rec = {
  active: false,
  steps: [],
  startedAt: 0,
  /** 回放中有没有正在跑（挡住二次录制） */
  playing: false,
};

/** 录制钩子：由 actions 层注入，避免 core 反向依赖 app。 */
let commandRecorder = null;

/**
 * 注入「当前命令被执行了」的钩子。
 *
 * `fn(cmdId, args, selection)` 会被每条命令调用一次；
 * 只有 `rec.active` 为真时才会落进 steps。
 *
 * @param {(cmdId: string, args: object|undefined,
 *          sel: {anchor: number, head: number}|null) => void} fn
 */
export function setCommandRecorder(fn) {
  commandRecorder = typeof fn === 'function' ? fn : null;
}

/** 是否正在录制。 */
export function isRecording() {
  return rec.active;
}

/** 是否正在回放。 */
export function isPlaying() {
  return rec.playing;
}

/** 当前已录步数。 */
export function recordedSteps() {
  return rec.steps.length;
}

/**
 * 记录一步（由命令层调用）。
 *
 * @param {string} cmdId
 * @param {object} [args]
 * @param {{anchor: number, head: number}|null} [sel]
 * @return {boolean} 是否真的记下了
 */
export function recordStep(cmdId, args, sel) {
  if (!rec.active || rec.playing) return false;
  if (!cmdId || NON_REPLAYABLE.has(cmdId)) return false;
  if (rec.steps.length >= MAX_STEPS) return false;
  rec.steps.push({
    cmd: String(cmdId),
    args: args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : undefined,
    sel: sel && typeof sel === 'object' ? { anchor: Number(sel.anchor) || 0, head: Number(sel.head) || 0 } : null,
    delay: 0,
  });
  return true;
}

/**
 * 开始录制。
 * @param {object} app
 * @return {{ok: boolean, reason?: string}}
 */
export function startRecording(app) {
  if (rec.active) return { ok: false, reason: 'already' };
  if (rec.playing) return { ok: false, reason: 'playing' };
  rec.active = true;
  rec.steps = [];
  rec.startedAt = Date.now();
  state.macro = { recording: true, steps: rec.steps, name: '' };
  if (app && app.statusbar) app.statusbar.update();
  return { ok: true };
}

/**
 * 停止录制并保存成一条宏。
 *
 * @param {string} name
 * @param {object} [app]
 * @return {Promise<{ok: boolean, macro?: object, reason?: string}>}
 */
export async function stopRecording(name, app) {
  if (!rec.active) return { ok: false, reason: 'not-recording' };
  rec.active = false;
  state.macro = { recording: false, steps: [], name: '' };
  if (app && app.statusbar) app.statusbar.update();

  const steps = rec.steps.slice();
  rec.steps = [];

  if (!steps.length) return { ok: false, reason: 'empty' };

  const macro = {
    id: `macro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: (name || '').trim() || `宏 ${macros.length + 1}`,
    createdAt: Date.now(),
    version: 1,
    steps,
  };
  macros.push(macro);
  if (macros.length > MAX_MACROS) macros = macros.slice(-MAX_MACROS);
  const saved = await saveMacros(macros);
  return { ok: true, macro, saved: saved.ok };
}

/**
 * 取消录制（丢弃已录步骤）。
 * @param {object} [app]
 */
export function cancelRecording(app) {
  rec.active = false;
  rec.steps = [];
  state.macro = { recording: false, steps: [], name: '' };
  if (app && app.statusbar) app.statusbar.update();
}

/**
 * 回放一条宏。
 *
 * 每一步都走 `runCommand`（与手工执行同一个入口），所以命令的
 * `enabled()` 判断、返回值信封、异常捕获全部一致。
 *
 * @param {object} macro
 * @param {object} app
 * @return {Promise<{played: number, skipped: Array<{index: number, cmd: string, reason: string}>}>}
 */
export async function playMacro(macro, app) {
  const result = { played: 0, skipped: [] };
  if (!macro || !Array.isArray(macro.steps)) return result;

  rec.playing = true;
  try {
    const view = app && app.editor ? app.editor.view : null;
    for (let i = 0; i < macro.steps.length; i += 1) {
      const step = macro.steps[i];
      if (!step || !step.cmd) {
        result.skipped.push({ index: i, cmd: '?', reason: 'empty' });
        continue;
      }
      if (NON_REPLAYABLE.has(step.cmd)) {
        result.skipped.push({ index: i, cmd: step.cmd, reason: 'non-replayable' });
        continue;
      }
      if (!getCommand(step.cmd)) {
        result.skipped.push({ index: i, cmd: step.cmd, reason: 'not-found' });
        continue;
      }
      if (view && step.sel) {
        const anchor = Math.min(Number(step.sel.anchor) || 0, view.state.doc.length);
        const head = Math.min(Number(step.sel.head) || 0, view.state.doc.length);
        view.dispatch({ selection: { anchor, head } });
      }
      const res = runCommand(step.cmd, app);
      if (res && res.ok === false) {
        result.skipped.push({ index: i, cmd: step.cmd, reason: res.reason || 'failed' });
      } else {
        result.played += 1;
      }
      // 让出主线程，避免长宏把界面卡死
      if (i % 8 === 7) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    rec.playing = false;
  }
  return result;
}

/* --------------------------------------------------------------- 持久化 */

/**
 * 读宏列表（桌面壳读文件，浏览器读 localStorage）。
 * @param {{force?: boolean}} [opts]
 * @return {Promise<Array<object>>}
 */
export async function loadMacros(opts = {}) {
  if (loaded && !opts.force) return macros;
  if (desktop.canPersistMacros()) {
    const res = await desktop.readMacros();
    macros = Array.isArray(res.macros) ? res.macros : [];
  } else {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(MACROS_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      macros = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.macros)
          ? parsed.macros
          : [];
    } catch {
      macros = [];
    }
  }
  macros = macros.filter((m) => m && typeof m.id === 'string').slice(0, MAX_MACROS);
  loaded = true;
  return macros;
}

/**
 * 写宏列表。
 * @param {Array<object>} list
 * @return {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function saveMacros(list) {
  macros = Array.isArray(list) ? list.slice(0, MAX_MACROS) : [];
  if (desktop.canPersistMacros()) {
    const res = await desktop.writeMacros(macros);
    return { ok: res.ok, path: res.path, error: res.error };
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MACROS_KEY, JSON.stringify({ version: 1, macros }));
    }
    return { ok: true, error: undefined };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/** 当前内存里的宏（同步读，UI 渲染用）。 */
export function getMacros() {
  return macros.slice();
}

/**
 * 重命名。
 * @param {string} id
 * @param {string} name
 * @return {Promise<{ok: boolean}>}
 */
export async function renameMacro(id, name) {
  const target = macros.find((m) => m.id === id);
  if (!target) return { ok: false };
  target.name = String(name || '').trim().slice(0, 120) || target.name;
  await saveMacros(macros);
  return { ok: true };
}

/**
 * 删除。
 * @param {string} id
 * @return {Promise<{ok: boolean}>}
 */
export async function deleteMacro(id) {
  const before = macros.length;
  macros = macros.filter((m) => m.id !== id);
  await saveMacros(macros);
  return { ok: macros.length < before };
}

/**
 * 把命令执行转发给录制器（由 app 的命令包装层调用）。
 * @param {string} cmdId
 * @param {object} [args]
 * @param {{anchor: number, head: number}|null} [sel]
 */
export function notifyCommand(cmdId, args, sel) {
  if (!rec.active) return;
  if (typeof commandRecorder === 'function') {
    commandRecorder(cmdId, args, sel);
    return;
  }
  recordStep(cmdId, args, sel);
}

/** 仅测试用：清空内存态。 */
export function __resetMacroState() {
  macros = [];
  loaded = false;
  rec.active = false;
  rec.steps = [];
  rec.playing = false;
}
