/**
 * QuillPad · 资源落盘（图片写入文档同目录的 `assets/`）
 *
 * 三种落盘通路，按可靠性排序（对应 PRD A6 与 ARCH §4.12）：
 *
 *  ① **桌面壳原生**：`quillpadDesktop.writeAsset` → `qp:write-asset`。
 *     主进程负责路径防护（禁 `..`、禁绝对路径、禁越界）、同名自动加随机后缀。
 *     这是唯一「文档已保存到磁盘、但用户没打开文件夹句柄」时也能工作的通路。
 *  ② **File System Access API**：用户通过「打开文件夹」授权过目录时直接写，
 *     浏览器里也能用。
 *  ③ 都不行 → 由调用方降级成 data URL（≤2MB）或提示「先另存为」。
 *
 * 之所以把 ①②③ 的判断收在一个函数里：v1 的教训是「落盘逻辑分散在三个地方，
 * 每个分支的错误提示都不一样」，用户看到的报错完全取决于当时走的是哪条路。
 */

import { getDirHandle, ensurePermission } from './persist.js';
import { state } from './state.js';
import * as desktop from './desktop.js';

/** 资源子目录名。 */
export const ASSETS_DIR = 'assets';

/**
 * 文件名合法性（与主进程保持同一套规则，前端先拦一次能给更快的反馈）。
 * @param {string} name
 * @return {boolean}
 */
export function isSafeAssetName(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  // `.` 与 `..` 在文件系统里是目录项而不是文件名，必须单独挡掉
  // （`..` 被下面的 includes 覆盖，`.` 不会）
  if (raw === '.' || raw === '..') return false;
  if (raw.includes('..')) return false;
  if (/[\\/]/.test(raw)) return false;
  if (/^[a-zA-Z]:/.test(raw)) return false;
  return true;
}

/**
 * 走桌面壳原生通路写字节。
 *
 * @param {{docDir: string, fileName: string, bytes: Uint8Array}} payload
 * @return {Promise<string|null>} 成功返回 `assets/xxx.png`
 */
export async function writeAssetNative(payload) {
  const { docDir, fileName, bytes } = payload || {};
  if (!docDir || !isSafeAssetName(fileName) || !bytes) return null;
  if (!desktop.canWriteAsset()) return null;
  const res = await desktop.writeAsset({ docDir, fileName, bytes });
  if (!res.ok || !res.name) {
    if (res.code && res.code !== 'ENOBRIDGE') {
      console.warn('[QuillPad] 原生写入 assets 失败：', res.code, res.error);
    }
    return null;
  }
  return `${ASSETS_DIR}/${res.name}`;
}

/**
 * 通过 File System Access API 把字节写到「文档目录/assets/」。
 *
 * @param {string} assetName
 * @param {Uint8Array} bytes
 * @return {Promise<string|null>} 成功返回 `assets/xxx.png`
 */
export async function writeAssetViaFsa(assetName, bytes) {
  if (!isSafeAssetName(assetName) || !bytes) return null;
  const folder = state.folder;
  if (!folder || !folder.handleKey) return null;
  try {
    const root = await getDirHandle(folder.handleKey);
    if (!root) return null;
    if (!(await ensurePermission(root, 'readwrite'))) return null;
    const assets = await root.getDirectoryHandle(ASSETS_DIR, { create: true });
    const fileHandle = await assets.getFileHandle(assetName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return `${ASSETS_DIR}/${assetName}`;
  } catch (err) {
    console.warn('[QuillPad] 写入 assets 失败：', err && err.message);
    return null;
  }
}

/**
 * 统一落盘入口：原生优先，FSA 兜底。
 *
 * @param {{docDir: string|null, fileName: string, bytes: Uint8Array}} payload
 * @return {Promise<{relPath: string|null, via: 'native'|'fsa'|'none'}>}
 */
export async function writeAsset(payload) {
  const native = await writeAssetNative(payload);
  if (native) return { relPath: native, via: 'native' };
  const fsa = await writeAssetViaFsa(payload.fileName, payload.bytes);
  if (fsa) return { relPath: fsa, via: 'fsa' };
  return { relPath: null, via: 'none' };
}
