/**
 * QuillPad · 图片：路径解析 / 占位 / 拖拽插入
 *
 * 解析基准 = **当前文档所在目录**（A6）。v1 的预览直接用相对路径（相对 index.html
 * 或 dist/），本地图片几乎必然 404，这是 A6 要修的核心问题。
 *
 * 落盘策略见 `src/core/assets.js`（原生 IPC → FSA → data URL 三级降级）。
 * 本文件只负责「路径解析 / 占位 / 把 Markdown 插进文档」这三件事。
 */

import { state } from '../../core/state.js';
import { writeAsset as writeAssetShared } from '../../core/assets.js';

/** data URL 降级的上限（2MB，PRD A6）。 */
export const DATA_URL_LIMIT = 2 * 1024 * 1024;

/** 资源子目录名。 */
export const ASSETS_DIR = 'assets';

/** 可识别的图片扩展名。 */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];

/**
 * 是否是可原样使用的 URL（网络 / data / blob）。
 * @param {string} src
 * @return {boolean}
 */
function isExternalUrl(src) {
  return /^(https?:|data:|blob:|mailto:)/i.test(src);
}

/**
 * 是否绝对路径（`/x`、`D:/x`、`D:\x`、`file://`）。
 * @param {string} src
 * @return {boolean}
 */
function isAbsolutePath(src) {
  return /^file:\/\//i.test(src) || /^[a-zA-Z]:[\\/]/.test(src) || /^\/[^/]/.test(src) || /^\\\\/.test(src);
}

/**
 * 拼接目录与相对路径（统一成 `/` 分隔，消掉 `./` 与 `../`）。
 * @param {string} dir
 * @param {string} rel
 * @return {string}
 */
export function joinPath(dir, rel) {
  const base = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = `${base}/${String(rel).replace(/\\/g, '/')}`.split('/');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  // 保留 Windows 盘符后的斜杠形态：D:/docs/x.png
  return joined;
}

/**
 * 把本地绝对/相对路径转成 `file:///` URL。
 * @param {string} path
 * @return {string}
 */
export function toFileUrl(path) {
  const p = String(path).replace(/\\/g, '/');
  if (/^file:\/\//i.test(p)) return p;
  // 盘符（`D:`）不参与百分号编码，否则会得到 `file:///D%3A/...` 这种不可用地址
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(p);
  const head = drive ? drive[1] : '';
  const rest = drive ? p.slice(drive[1].length).replace(/^\/+/, '') : p.replace(/^\/+/, '');
  const encoded = rest
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const tail = rest ? `/${encoded}` : '/';
  return `file:///${head}${tail}`.replace(/^file:\/\/\/\//, 'file:///');
}

/**
 * 解析图片地址。
 *
 * @param {string} src markdown 里的原始地址
 * @param {string|null} docDir 文档所在目录（形如 `D:/docs`）
 * @return {{url: string, resolved: boolean, reason?: string}}
 */
export function resolveImageUrl(src, docDir) {
  const raw = String(src || '').trim();
  if (!raw) return { url: '', resolved: false, reason: 'empty' };
  if (isExternalUrl(raw)) return { url: raw, resolved: true };

  if (isAbsolutePath(raw)) {
    return { url: toFileUrl(raw), resolved: true };
  }

  if (!docDir) {
    // 未保存到磁盘的文档：无法确定基准目录
    return { url: raw, resolved: false, reason: 'no-doc-dir' };
  }
  return { url: toFileUrl(joinPath(docDir, raw)), resolved: true };
}

/**
 * 生成资源文件名：`img-<yyyymmdd-HHMMSS>-<4 位随机>.<ext>`。
 * @param {string} [ext]
 * @return {string}
 */
export function makeAssetName(ext = 'png') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).padEnd(4, '0');
  const clean = String(ext || 'png')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `img-${stamp}-${rand}.${clean || 'png'}`;
}

/**
 * 从文件名里取扩展名。
 * @param {string} name
 * @return {string}
 */
export function extOf(name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : 'png';
  return IMAGE_EXT.includes(ext) ? ext : 'png';
}

/**
 * 把 File 读成 Uint8Array。
 * @param {File|Blob} file
 * @return {Promise<Uint8Array>}
 */
async function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Uint8Array(0);
}

/**
 * 插入一张图片（拖拽 / 粘贴 / 命令入口）。
 *
 * @param {object} app
 * @param {File|{name: string, bytes: Uint8Array}} input
 * @return {Promise<{ok: boolean, markdown?: string, error?: string, degraded?: boolean}>}
 */
export async function insertMarkdownImage(app, input) {
  if (!input) return { ok: false, error: '没有可插入的图片' };
  const name = input.name || 'image.png';
  const ext = extOf(name);
  const assetName = makeAssetName(ext);
  const bytes =
    input instanceof Uint8Array
      ? input
      : input.bytes instanceof Uint8Array
        ? input.bytes
        : await readBytes(input);

  // ① 原生 IPC / ② FSA：统一走 assets.js（原生优先，失败自动降级）
  const docDir = typeof app.docDirOf === 'function' ? app.docDirOf(app.activeTab()) : null;
  const wrote = await writeAssetShared({ docDir, fileName: assetName, bytes });
  if (wrote.relPath) {
    const md = `![${name}](${wrote.relPath})`;
    insertMarkdown(app, md);
    return { ok: true, markdown: md, via: wrote.via };
  }

  // ③ data URL 降级（≤2MB）
  if (bytes.byteLength > DATA_URL_LIMIT) {
    return {
      ok: false,
      error: `图片过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB），请先「另存为」到磁盘再插入`,
    };
  }
  const accepted = await confirmDataUrlInsert(app, name);
  if (!accepted) return { ok: false, error: '已取消插入' };
  const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bytesToBase64(bytes)}`;
  const md = `![${name}](${dataUrl})`;
  insertMarkdown(app, md);
  return { ok: true, markdown: md, degraded: true };
}

/**
 * 未保存文档插入图片时征询用户（二选一）。
 * @param {object} app
 * @param {string} name
 * @return {Promise<boolean>}
 */
async function confirmDataUrlInsert(app, name) {
  const message =
    `「${name}」需要落到文档同目录的 assets/ 下，但当前文档尚未保存到磁盘。\n\n` +
    '是否改为以 data URL 内联插入（≤2MB）？\n（推荐先「另存为」再插入图片）';
  try {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 字节转 base64（分块，避免大数组爆栈）。
 * @param {Uint8Array} bytes
 * @return {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

/**
 * 在光标处插入 markdown 文本。
 * @param {object} app
 * @param {string} markdown
 */
export function insertMarkdown(app, markdown) {
  const view = app.editor.view;
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  // 图片必须独占一行：前后若有文本就补换行，否则新内容会和相邻文本粘连
  const before = line.text.slice(0, sel.from - line.from);
  const after = line.text.slice(sel.to - line.from);
  const prefix = before.trim() ? '\n' : '';
  const suffix = after.trim() ? '\n' : '';
  const text = `${prefix}${markdown}${suffix}`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + prefix.length + markdown.length },
  });
  app.editor.focus();
}
