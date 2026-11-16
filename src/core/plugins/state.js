/**
 * QuillPad · 插件状态（渲染层镜像 + localStorage 兜底）
 *
 * 真值在主进程 `%APPDATA%\QuillPad\plugins-state.json`（便携版在 QuillPad-Data 下），
 * 这里保存一份渲染层镜像，供面板 / 命令注册即时读取；刷新后由 `host.refresh()`
 * 从主进程拉回覆盖，避免两份状态漂移。
 *
 * G5-16：崩溃停用写的是 `disabledReason:'crashed'`，重启后**不会**被自动复活。
 */

import { t } from '../i18n.js';

const STATE_KEY = 'quillpad.plugins.state.v1';

/** @type {Record<string, {enabled: boolean, version: string, sha256: string, installedAt: number, disabledReason?: string, blocked?: boolean}>} */
let memory = {};
let loaded = false;

/**
 * 从 localStorage 读（任何异常都退化为空对象）。
 * @return {Record<string, object>}
 */
function readLocal() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写回 localStorage。
 * @return {void}
 */
function writeLocal() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STATE_KEY, JSON.stringify(memory));
  } catch {
    /* 隐私模式下记不住，主进程文件仍是真值 */
  }
}

/**
 * 载入状态（只做一次，除非 force）。
 * @param {boolean} [force]
 * @return {Record<string, object>}
 */
export function loadState(force = false) {
  if (loaded && !force) return { ...memory };
  memory = readLocal();
  loaded = true;
  return { ...memory };
}

/**
 * 用主进程的权威状态覆盖镜像。
 * @param {Record<string, object>|Array<object>} entries
 * @return {Record<string, object>}
 */
export function replaceState(entries) {
  memory = {};
  const list = Array.isArray(entries) ? entries : Object.entries(entries || {}).map(([id, v]) => ({ id, ...v }));
  for (const item of list) {
    if (!item || !item.id) continue;
    memory[String(item.id)] = {
      enabled: item.enabled !== false,
      version: String(item.version || ''),
      sha256: String(item.sha256 || ''),
      installedAt: Number(item.installedAt) || 0,
      ...(item.disabledReason ? { disabledReason: String(item.disabledReason) } : {}),
      ...(item.blocked ? { blocked: true } : {}),
    };
  }
  writeLocal();
  return { ...memory };
}

/**
 * 取单个插件的状态。
 * @param {string} id
 * @return {object|null}
 */
export function getEntry(id) {
  loadState();
  const entry = memory[String(id || '')];
  return entry ? { ...entry } : null;
}

/**
 * 合并写入一个插件的状态。
 * @param {string} id
 * @param {object} patch
 * @return {object} 更新后的完整状态
 */
export function setEntry(id, patch = {}) {
  loadState();
  const key = String(id || '');
  const prev = memory[key] || { enabled: true, version: '', sha256: '', installedAt: Date.now() };
  memory[key] = { ...prev, ...patch };
  writeLocal();
  return { ...memory[key] };
}

/**
 * 删除一个插件的状态（卸载时）。
 * @param {string} id
 * @return {void}
 */
export function removeEntry(id) {
  loadState();
  delete memory[String(id || '')];
  writeLocal();
}

/**
 * 是否处于启用状态（崩溃停用 / 被阻止 / 显式禁用都算停用）。
 * @param {string} id
 * @return {boolean}
 */
export function isEnabled(id) {
  const e = getEntry(id);
  return !!(e && e.enabled && !e.disabledReason && !e.blocked);
}

/** 崩溃停用（G5-16：写死原因，重启不复活）。 */
export function markCrashed(id) {
  return setEntry(id, { enabled: false, disabledReason: 'crashed' });
}

/** 标记为 License 不合规（已阻止）。 */
export function markBlocked(id, reason = t('License 不合规', 'Non-compliant license')) {
  return setEntry(id, { enabled: false, blocked: true, disabledReason: reason });
}

/**
 * 导出全部状态（面板用）。
 * @return {Record<string, object>}
 */
export function allState() {
  return loadState();
}

/** 测试用：清空内存与本地存储。 */
export function __resetState() {
  memory = {};
  loaded = true;
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STATE_KEY);
  } catch {
    /* 忽略 */
  }
}
