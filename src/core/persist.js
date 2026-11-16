/**
 * QuillPad · 持久化
 *
 * 1) localStorage：会话（打开的标签、活动标签、最近文件、文件夹信息）。
 * 2) IndexedDB：FileSystemFileHandle / FileSystemDirectoryHandle 的持久化，
 *    让刷新页面后 Ctrl+S 仍能写回同一个磁盘文件。
 */

import { t } from './i18n.js';

const SESSION_KEY = 'quillpad.session.v1';
const DB_NAME = 'quillpad-handles';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_DIRS = 'dirs';

/* ------------------------------------------------------------ localStorage */

/**
 * 读取会话。
 * @return {object|null}
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.tabs)) parsed.tabs = [];
    return parsed;
  } catch (err) {
    console.warn('[QuillPad] 读取会话失败：', err);
    return null;
  }
}

/**
 * 写入会话。若因体积超限失败，则退化为「不保存正文」再试一次。
 * @param {object} session
 * @return {boolean} 是否成功（不含正文时也返回 true）
 */
export function saveSession(session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch (err) {
    console.warn('[QuillPad] 会话过大，改为只保存结构：', err);
  }
  try {
    const slim = {
      ...session,
      tabs: (session.tabs || []).map((t) => ({ ...t, content: '', savedContent: '' })),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(slim));
    return true;
  } catch (err) {
    console.warn('[QuillPad] 会话保存失败：', err);
    return false;
  }
}

/** 清空会话。 */
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    console.warn('[QuillPad] 清理会话失败：', err);
  }
}

/* --------------------------------------------------------------- IndexedDB */

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/**
 * 打开（并升级）句柄数据库。
 * @return {Promise<IDBDatabase>}
 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(t('当前环境不支持 IndexedDB', 'IndexedDB is not available in this environment')));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES);
      if (!db.objectStoreNames.contains(STORE_DIRS)) db.createObjectStore(STORE_DIRS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(t('打开 IndexedDB 失败', 'Failed to open IndexedDB')));
  });
  return dbPromise;
}

/**
 * 事务包装。
 * @param {string} store 存储名
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} action
 * @return {Promise<any>}
 */
async function withStore(store, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(t('IndexedDB 操作失败', 'IndexedDB operation failed')));
  });
}

/**
 * 保存一个文件句柄。
 * @param {string} key
 * @param {FileSystemFileHandle} handle
 * @return {Promise<void>}
 */
export async function putFileHandle(key, handle) {
  try {
    await withStore(STORE_FILES, 'readwrite', (s) => s.put(handle, key));
  } catch (err) {
    console.warn('[QuillPad] 保存文件句柄失败：', err);
  }
}

/**
 * 读取一个文件句柄。
 * @param {string} key
 * @return {Promise<FileSystemFileHandle|null>}
 */
export async function getFileHandle(key) {
  try {
    const h = await withStore(STORE_FILES, 'readonly', (s) => s.get(key));
    return h || null;
  } catch (err) {
    console.warn('[QuillPad] 读取文件句柄失败：', err);
    return null;
  }
}

/**
 * 删除文件句柄。
 * @param {string} key
 * @return {Promise<void>}
 */
export async function deleteFileHandle(key) {
  try {
    await withStore(STORE_FILES, 'readwrite', (s) => s.delete(key));
  } catch (err) {
    console.warn('[QuillPad] 删除文件句柄失败：', err);
  }
}

/**
 * 保存目录句柄。
 * @param {string} key
 * @param {FileSystemDirectoryHandle} handle
 * @return {Promise<void>}
 */
export async function putDirHandle(key, handle) {
  try {
    await withStore(STORE_DIRS, 'readwrite', (s) => s.put(handle, key));
  } catch (err) {
    console.warn('[QuillPad] 保存目录句柄失败：', err);
  }
}

/**
 * 读取目录句柄。
 * @param {string} key
 * @return {Promise<FileSystemDirectoryHandle|null>}
 */
export async function getDirHandle(key) {
  try {
    const h = await withStore(STORE_DIRS, 'readonly', (s) => s.get(key));
    return h || null;
  } catch (err) {
    console.warn('[QuillPad] 读取目录句柄失败：', err);
    return null;
  }
}

/**
 * 删除目录句柄。
 * @param {string} key
 * @return {Promise<void>}
 */
export async function deleteDirHandle(key) {
  try {
    await withStore(STORE_DIRS, 'readwrite', (s) => s.delete(key));
  } catch (err) {
    console.warn('[QuillPad] 删除目录句柄失败：', err);
  }
}

/**
 * 生成一个稳定的句柄 key。
 * @return {string}
 */
export function newHandleKey() {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 检查句柄权限（不触发弹窗）。
 * @param {FileSystemHandle} handle
 * @param {'read'|'readwrite'} mode
 * @return {Promise<boolean>}
 */
export async function hasPermission(handle, mode = 'readwrite') {
  if (!handle || !handle.queryPermission) return true;
  try {
    return (await handle.queryPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 请求句柄权限（必须在用户手势内调用）。
 * @param {FileSystemHandle} handle
 * @param {'read'|'readwrite'} mode
 * @return {Promise<boolean>}
 */
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  if (!handle.queryPermission) return true;
  try {
    if ((await handle.queryPermission({ mode })) === 'granted') return true;
    return (await handle.requestPermission({ mode })) === 'granted';
  } catch (err) {
    console.warn('[QuillPad] 申请文件权限失败：', err);
    return false;
  }
}
