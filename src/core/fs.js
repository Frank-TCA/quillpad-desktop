/**
 * QuillPad · 文件系统层
 *
 * - 优先使用 File System Access API：真正读写磁盘、打开文件夹。
 * - 不支持的浏览器降级为 <input type=file> 读取 + Blob 下载保存。
 * - 统一处理：编码探测（UTF-8 / GBK / UTF-16）、BOM 剔除、换行符归一化。
 *
 * 约定：内存中的正文一律以 LF 存储，EOL 作为标签属性单独记录，
 *       保存时再按 tab.eol 还原，这样「转换行尾」只需要改属性即可。
 */

import { t } from './i18n.js';

/** 换行符序列映射。 */
export const EOL_SEQ = {
  LF: '\n',
  CRLF: '\r\n',
  CR: '\r',
};

/**
 * 浏览器是否支持 File System Access API。
 * @return {boolean}
 */
export function supportsFsa() {
  return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
}

/**
 * 解码二进制内容为文本，自动处理 UTF-8 BOM / UTF-16 / GBK 回退。
 * @param {ArrayBuffer} buffer
 * @return {{text: string, encoding: string, hadBom: boolean}}
 */
export function decodeBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) return { text: '', encoding: 'UTF-8', hadBom: false };

  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = safeDecode(bytes.subarray(3), 'utf-8');
    return { text: normalizeNewlines(text), encoding: 'UTF-8', hadBom: true };
  }
  // UTF-16 LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = safeDecode(bytes.subarray(2), 'utf-16le');
    return { text: normalizeNewlines(text), encoding: 'UTF-16 LE', hadBom: true };
  }
  // UTF-16 BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = safeDecode(bytes.subarray(2), 'utf-16be');
    return { text: normalizeNewlines(text), encoding: 'UTF-16 BE', hadBom: true };
  }

  // 先尝试严格 UTF-8（fatal: true），失败再回退 GBK
  try {
    const strict = new TextDecoder('utf-8', { fatal: true });
    const text = strict.decode(bytes);
    return { text: normalizeNewlines(text), encoding: 'UTF-8', hadBom: false };
  } catch {
    /* 不是合法 UTF-8，继续 */
  }

  try {
    const gbk = new TextDecoder('gbk');
    const text = gbk.decode(bytes);
    return { text: normalizeNewlines(text), encoding: 'GBK', hadBom: false };
  } catch {
    const loose = new TextDecoder('utf-8', { fatal: false });
    return { text: normalizeNewlines(loose.decode(bytes)), encoding: t('UTF-8 (含无法解码字符)', 'UTF-8 (with undecodable characters)'), hadBom: false };
  }
}

/**
 * 安全解码，异常时返回空字符串。
 * @param {Uint8Array} bytes
 * @param {string} label
 * @return {string}
 */
function safeDecode(bytes, label) {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }
  }
}

/**
 * 把文本编码为 UTF-8 字节。
 * @param {string} text
 * @return {Uint8Array}
 */
export function encodeText(text) {
  return new TextEncoder().encode(text);
}

/**
 * 判定文本的主换行符。
 * @param {string} text
 * @return {'LF'|'CRLF'|'CR'}
 */
export function detectEol(text) {
  if (!text) return 'LF';
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r/g) || []).length - crlf;
  if (crlf >= lf && crlf >= cr && crlf > 0) return 'CRLF';
  if (cr > lf && cr > 0) return 'CR';
  return 'LF';
}

/**
 * 把任意换行风格归一化为 LF。
 * @param {string} text
 * @return {string}
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 把 LF 文本转换为指定换行风格。
 * @param {string} text 内部 LF 文本
 * @param {'LF'|'CRLF'|'CR'} eol
 * @return {string}
 */
export function toEol(text, eol) {
  const seq = EOL_SEQ[eol] || '\n';
  if (seq === '\n') return text;
  return text.replace(/\n/g, seq);
}

/**
 * 把一个 File 读成统一的文件描述对象。
 * FileSystemFileHandle 与 <input type="file"> / 拖拽拿到的都是 File，
 * 统一在这里做解码、编码探测与换行符探测，避免两条读取路径各写一遍。
 * @param {File} file
 * @return {Promise<{name: string, content: string, encoding: string, eol: string, size: number, modified: number}>}
 */
async function readFile(file) {
  const buffer = await file.arrayBuffer();
  const decoded = decodeBytes(buffer);
  return {
    name: file.name,
    content: decoded.text,
    encoding: decoded.encoding,
    eol: detectEol(decoded.text),
    size: file.size,
    modified: file.lastModified || Date.now(),
  };
}

/**
 * 用 FileSystemFileHandle 读取文件。
 * @param {FileSystemFileHandle} handle
 * @return {Promise<{name: string, content: string, encoding: string, eol: string, size: number, modified: number}>}
 */
export async function readFileHandle(handle) {
  return readFile(await handle.getFile());
}

/**
 * 用 File 对象（input / 拖拽）读取。
 * @param {File} file
 * @return {Promise<{name: string, content: string, encoding: string, eol: string, size: number, modified: number}>}
 */
export async function readFileObject(file) {
  return readFile(file);
}

/**
 * 写回 FileSystemFileHandle。
 * @param {FileSystemFileHandle} handle
 * @param {string} text 已按目标 EOL 转换好的文本
 * @return {Promise<void>}
 */
export async function writeFileHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(encodeText(text));
  await writable.close();
}

/**
 * 弹出系统「打开文件」对话框。
 * @return {Promise<FileSystemFileHandle[]>} 用户取消时返回空数组
 */
export async function pickOpenFiles() {
  if (!supportsFsa()) return [];
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: t('文本 / 代码文件', 'Text / code files'),
          accept: {
            'text/plain': [
              '.txt', '.md', '.markdown', '.log', '.ini', '.toml', '.conf', '.env',
              '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.html', '.htm',
              '.css', '.scss', '.less', '.vue', '.py', '.java', '.c', '.h', '.cpp',
              '.hpp', '.cc', '.cs', '.go', '.rs', '.php', '.rb', '.sh', '.bash',
              '.sql', '.xml', '.yaml', '.yml', '.bat', '.ps1', '.lua', '.swift',
              '.kt', '.gradle', '.dockerfile', '.gitignore', '.editorconfig',
            ],
          },
        },
      ],
    });
    return handles || [];
  } catch (err) {
    if (err && err.name === 'AbortError') return [];
    console.warn('[QuillPad] showOpenFilePicker 失败：', err);
    return [];
  }
}

/**
 * 弹出系统「保存文件」对话框。
 * @param {string} suggestedName
 * @return {Promise<FileSystemFileHandle|null>}
 */
export async function pickSaveFile(suggestedName = t('未命名.txt', 'Untitled.txt')) {
  if (!supportsFsa()) return null;
  try {
    return await window.showSaveFilePicker({ suggestedName });
  } catch (err) {
    if (err && err.name === 'AbortError') return null; // 用户取消
    console.warn('[QuillPad] showSaveFilePicker 失败：', err);
    throw new Error(t('当前环境无法打开保存对话框，请改用浏览器下载', 'This environment cannot open a save dialog; use the browser download instead'));
  }
}

/**
 * 弹出系统「选择文件夹」对话框。
 * @return {Promise<FileSystemDirectoryHandle|null>}
 */
export async function pickDirectory() {
  if (!supportsFsa() || typeof window.showDirectoryPicker !== 'function') return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    console.warn('[QuillPad] showDirectoryPicker 失败：', err);
    return null;
  }
}

/**
 * 降级方案：用 <input type=file> 选择文件。
 * @param {boolean} multiple
 * @return {Promise<File[]>}
 */
export function pickFilesLegacy(multiple = true) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.accept = 'text/*,.md,.js,.ts,.json,.css,.html,.py,.java,.go,.rs,.php,.sql,.xml,.yaml,.yml,.ini,.toml,.log,.txt';
    document.body.appendChild(input);
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => {
      finish(Array.from(input.files || []));
    });
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!settled && (!input.files || input.files.length === 0)) finish([]);
        }, 800);
      },
      { once: true },
    );
    input.click();
  });
}

/**
 * 降级方案：把文本作为文件下载。
 * @param {string} name
 * @param {string} text
 */
export function downloadText(name, text) {
  const blob = new Blob([encodeText(text)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || t('未命名.txt', 'Untitled.txt');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * 从拖拽事件里提取所有文件（含目录展开的降级处理）。
 * @param {DataTransfer} dt
 * @return {Promise<File[]>}
 */
export async function filesFromDataTransfer(dt) {
  if (!dt) return [];
  if (dt.items && dt.items.length) {
    const files = [];
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      const file = item.getAsFile();
      if (file) files.push(file);
      void entry;
    }
    if (files.length) return files;
  }
  return Array.from(dt.files || []);
}

/**
 * 读取一个目录下的直接子项（已排序：目录在前，按名称升序）。
 * @param {FileSystemDirectoryHandle} dirHandle
 * @return {Promise<Array<{name: string, kind: 'file'|'directory', handle: FileSystemHandle}>>}
 */
export async function readDirectory(dirHandle) {
  const entries = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (name.startsWith('.')) continue;
      entries.push({ name, kind: handle.kind, handle });
    }
  } catch (err) {
    console.warn('[QuillPad] 读取目录失败：', err);
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return entries;
}
