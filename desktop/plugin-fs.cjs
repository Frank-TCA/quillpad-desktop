'use strict';

/**
 * QuillPad 桌面壳 · 插件文件系统与安装管线（T21）
 *
 * 只用 Node 内置模块：zlib（zip 解压）、crypto（sha256）、fs、path。
 * 三层路径防护（G5 / S4）：
 *  ① entry name 拒绝 `..` / 反斜杠 / 绝对路径 / 盘符 / NUL / 符号链接；
 *  ② 拼出的绝对路径 `path.resolve` 后必须仍在临时根目录内；
 *  ③ 落盘前 `realpath` 复核（S4-5），临时目录 rename 到 plugins/<id> 后仍在根内。
 *
 * sha256 校验在任何写盘之前完成；更新时先备份旧目录，失败回滚。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ENTRIES = 512;
const STORAGE_LIMIT = 1024 * 1024;
const { t } = require('./i18n.cjs');

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/**
 * 读取小端整数。
 * @param {Buffer} buf
 * @param {number} at
 * @param {number} size
 * @return {number}
 */
function readLE(buf, at, size) {
  if (size === 2) return buf.readUInt16LE(at);
  return buf.readUInt32LE(at);
}

/**
 * 解析 zip（不依赖第三方库）。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} input
 * @return {{ok: boolean, files?: Array<{name: string, bytes: Buffer}>, code?: string, error?: string}}
 */
function parseZip(input) {
  const buf = input instanceof Uint8Array ? Buffer.from(input) : Buffer.isBuffer(input) ? input : null;
  if (!buf || buf.length < 22) return { ok: false, code: 'EUNZIP', error: t('不是合法的 zip 文件', "Not a valid zip file") };

  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, code: 'EUNZIP', error: t('找不到 zip 结束记录', "Zip end-of-central-directory record not found") };

  const count = readLE(buf, eocd + 10, 2);
  let cursor = readLE(buf, eocd + 16, 4);
  if (count > MAX_ENTRIES) return { ok: false, code: 'ETOOBIG', error: t(`条目数超过 ${MAX_ENTRIES}`, `Too many entries (limit ${MAX_ENTRIES})`) };

  const files = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      return { ok: false, code: 'EUNZIP', error: t('中央目录损坏', "Corrupt zip central directory") };
    }
    const method = readLE(buf, cursor + 10, 2);
    const compressed = readLE(buf, cursor + 20, 4);
    const uncompressed = readLE(buf, cursor + 24, 4);
    const nameLen = readLE(buf, cursor + 28, 2);
    const extraLen = readLE(buf, cursor + 30, 2);
    const commentLen = readLE(buf, cursor + 32, 2);
    const localAt = readLE(buf, cursor + 42, 4);
    const externalAttrs = readLE(buf, cursor + 38, 4);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);

    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0o170000) === 0o120000;
    if (isSymlink) return { ok: false, code: 'EPATH', error: t(`安装包包含符号链接：${name}`, `Package contains a symlink: ${name}`) };

    if (uncompressed > MAX_FILE_BYTES) return { ok: false, code: 'ETOOBIG', error: t(`单文件超过 6MB：${name}`, `Single file exceeds 6 MB: ${name}`) };
    total += uncompressed;
    if (total > MAX_TOTAL_BYTES) return { ok: false, code: 'ETOOBIG', error: t('解压总量超过 60MB', "Uncompressed size exceeds 60 MB") };

    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== 0x04034b50) {
      return { ok: false, code: 'EUNZIP', error: t(`本地文件头损坏：${name}`, `Corrupt local file header: ${name}`) };
    }
    const localNameLen = readLE(buf, localAt + 26, 2);
    const localExtraLen = readLE(buf, localAt + 28, 2);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    if (dataAt + compressed > buf.length) return { ok: false, code: 'EUNZIP', error: t('压缩数据越界', "Compressed data out of bounds") };
    const raw = buf.subarray(dataAt, dataAt + compressed);

    let bytes;
    try {
      if (method === 0) bytes = Buffer.from(raw);
      else if (method === 8) bytes = zlib.inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES });
      else return { ok: false, code: 'EUNZIP', error: t(`不支持的压缩方式 ${method}`, `Unsupported compression method ${method}`) };
    } catch (err) {
      return { ok: false, code: 'EUNZIP', error: t(`解压失败：${err && err.message}`, `Extraction failed: ${err && err.message}`) };
    }
    if (bytes.length !== uncompressed) {
      return { ok: false, code: 'EUNZIP', error: t(`解压长度不符：${name}`, `Uncompressed size mismatch: ${name}`) };
    }
    files.push({ name, bytes });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, files };
}

/**
 * 路径合法性（第一层）。
 * @param {string} name
 * @return {boolean}
 */
function isSafeEntryName(name) {
  const raw = String(name || '');
  if (!raw || raw.includes('\u0000')) return false;
  if (raw.includes('\\')) return false;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return false;
  const parts = raw.split('/');
  if (parts.some((p) => p === '..' || p === '.')) return false;
  if (raw.endsWith('/')) return false; // 目录项在下面单独放行
  return true;
}

/**
 * 计算 sha256。
 * @param {Buffer|Uint8Array} bytes
 * @return {string}
 */
function sha256Of(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes || [])).digest('hex');
}

/**
 * 计算目录内容的真实 sha256（按相对路径排序保证确定性）。
 * @param {string} dir
 * @return {string}
 */
function sha256OfDir(dir) {
  const hash = crypto.createHash('sha256');
  const rels = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) rels.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  })(dir);
  rels.sort();
  for (const rel of rels) {
    hash.update(rel);
    hash.update(fs.readFileSync(path.join(dir, rel)));
  }
  return hash.digest('hex');
}

/**
 * 安全地把一组文件写进临时目录（第二、三层防护在这里）。
 *
 * @param {string} tmpDir
 * @param {Array<{name: string, bytes: Buffer}>} files
 * @param {string} bootstrapSource
 * @return {{ok: boolean, code?: string, error?: string}}
 */
function writeSafeFiles(tmpDir, files, bootstrapSource) {
  for (const file of files) {
    const raw = String(file.name || '');
    if (raw.endsWith('/')) continue; // 目录项
    if (!isSafeEntryName(raw)) return { ok: false, code: 'EPATH', error: t(`非法路径：${raw}`, `Illegal path: ${raw}`) };
    const target = path.resolve(tmpDir, raw);
    if (!target.startsWith(path.resolve(tmpDir) + path.sep)) {
      return { ok: false, code: 'EPATH', error: t(`路径越界：${raw}`, `Path outside plugin directory: ${raw}`) };
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
      // realpath 复核：防符号链接把写入点甩到目录外
      const real = fs.realpathSync(target);
      if (!real.startsWith(fs.realpathSync(tmpDir) + path.sep) && real !== fs.realpathSync(tmpDir)) {
        return { ok: false, code: 'EPATH', error: t(`realpath 越界：${raw}`, `realpath outside plugin directory: ${raw}`) };
      }
    } catch (err) {
      return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
    }
  }
  if (bootstrapSource) {
    try {
      fs.writeFileSync(path.join(tmpDir, '__qp_bootstrap.js'), bootstrapSource, 'utf8');
    } catch (err) {
      return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
    }
  }
  return { ok: true };
}

/**
 * 读状态文件（`plugins-state.json`）。
 * @param {string} stateFile
 * @return {Record<string, object>}
 */
function readState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写状态文件。
 * @param {string} stateFile
 * @param {Record<string, object>} data
 */
function writeState(stateFile, data) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 安装 / 更新插件。
 *
 * @param {object} payload
 * @param {string} payload.pluginsRoot 插件根目录
 * @param {string} payload.stateFile 状态文件绝对路径
 * @param {object} payload.manifest 已由主进程校验过的清单
 * @param {string} [payload.bootstrap] prelude 源码
 * @param {Buffer|Uint8Array} [payload.zipBytes] 原始 zip（用于 sha256）
 * @param {Array<{name: string, bytes: Buffer|Uint8Array}>} [payload.files] 目录安装的裸文件
 * @param {string} [payload.expectedSha256] catalog 提供的摘要
 * @param {boolean} [payload.update] 是否为更新
 * @return {{ok: boolean, code?: string, error?: string, id?: string, dir?: string, version?: string}}
 */
function installPlugin(payload = {}) {
  const pluginsRoot = path.resolve(String(payload.pluginsRoot || ''));
  const stateFile = path.resolve(String(payload.stateFile || ''));
  const manifest = payload.manifest || {};
  const id = String(manifest.id || '');
  if (!ID_RE.test(id)) return { ok: false, code: 'ESCHEMA', error: t('插件 id 不合法', "Invalid plugin id") };

  let files;
  if (payload.zipBytes) {
    const parsed = parseZip(payload.zipBytes);
    if (!parsed.ok) return parsed;
    files = parsed.files;
  } else if (Array.isArray(payload.files)) {
    files = payload.files.map((f) => ({ name: String(f.name), bytes: Buffer.from(f.bytes || []) }));
  } else {
    return { ok: false, code: 'EINVALID', error: t('没有可安装的内容', "Nothing to install") };
  }

  // sha256 必须在任何写盘之前：篡改 → ESHA256 且已装版本不被覆盖
  const expected = String(payload.expectedSha256 || '').trim();
  if (expected && payload.zipBytes) {
    if (sha256Of(payload.zipBytes).toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, code: 'ESHA256', error: t('下载内容校验失败', "Downloaded content failed the checksum") };
    }
  }

  // 路径检查在写任何文件之前做一遍，避免「前 3 个文件已落盘才发现第 4 个越界」
  for (const f of files) {
    if (String(f.name).endsWith('/')) continue;
    if (!isSafeEntryName(f.name)) return { ok: false, code: 'EPATH', error: t(`安装包包含非法路径：${f.name}`, `Package contains an illegal path: ${f.name}`) };
  }

  // plugin.json 必须存在
  const fromZip = files.find((f) => path.posix.normalize(String(f.name).replace(/\\/g, '/')).replace(/^\.\//, '') === 'plugin.json');
  if (!fromZip) return { ok: false, code: 'ESCHEMA', error: t('安装包缺少 plugin.json', "Package is missing plugin.json") };
  const mainName = path.posix.normalize(String(manifest.main || '').replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!files.some((f) => path.posix.normalize(String(f.name).replace(/\\/g, '/')).replace(/^\.\//, '') === mainName)) {
    return { ok: false, code: 'ESCHEMA', error: t(`main 指向的文件不存在：${mainName}`, `File referenced by main does not exist: ${mainName}`) };
  }

  fs.mkdirSync(pluginsRoot, { recursive: true });
  const tmpDir = path.join(pluginsRoot, `.tmp-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const finalDir = path.join(pluginsRoot, id);
  const backupDir = path.join(pluginsRoot, `.bak-${id}-${Date.now().toString(36)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const wrote = writeSafeFiles(tmpDir, files, String(payload.bootstrap || ''));
    if (!wrote.ok) return wrote;

    // 主文件与所有 .js 的静态扫描由主进程做（manifest.js 是 ESM），这里保证文件齐备
    const hadOld = fs.existsSync(finalDir);
    if (hadOld) fs.renameSync(finalDir, backupDir);
    fs.renameSync(tmpDir, finalDir);

    // rename 后再复核一次 realpath（S4-5）
    const real = fs.realpathSync(finalDir);
    if (!real.startsWith(fs.realpathSync(pluginsRoot) + path.sep) && real !== fs.realpathSync(pluginsRoot)) {
      throw new Error(t('落盘目标越界', "Install target is outside the plugin directory"));
    }

    const state = readState(stateFile);
    state[id] = {
      enabled: state[id] ? state[id].enabled !== false : true,
      version: String(manifest.version || ''),
      sha256: expected || sha256OfDir(finalDir),
      installedAt: Date.now(),
      ...(state[id] && state[id].disabledReason && !payload.update ? { disabledReason: state[id].disabledReason } : {}),
    };
    if (payload.update) delete state[id].disabledReason;
    writeState(stateFile, state);
    if (hadOld) fs.rmSync(backupDir, { recursive: true, force: true });
    return { ok: true, id, dir: finalDir, version: state[id].version, sha256: state[id].sha256 };
  } catch (err) {
    // 回滚：删掉新目录、把旧目录搬回来、清临时目录
    try {
      fs.rmSync(finalDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    if (fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, finalDir);
      } catch {
        /* 忽略 */
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
}

/**
 * 列出已安装插件。
 * @param {string} pluginsRoot
 * @param {string} stateFile
 * @return {Array<object>}
 */
function listPlugins(pluginsRoot, stateFile) {
  const state = readState(stateFile);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of names) {
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(pluginsRoot, id, 'plugin.json'), 'utf8'));
    } catch {
      /* 坏包仍列出，UI 标记可卸载 */
    }
    const s = state[id] || {};
    out.push({
      id,
      manifest,
      version: String(s.version || manifest.version || ''),
      enabled: s.enabled !== false && !s.disabledReason,
      disabledReason: String(s.disabledReason || ''),
      blocked: !!s.blocked,
      sha256: String(s.sha256 || ''),
      installedAt: Number(s.installedAt) || 0,
      dir: path.join(pluginsRoot, id),
    });
  }
  return out;
}

/**
 * 启用 / 禁用（崩溃停用会写死原因，重启不复活）。
 * @param {string} stateFile
 * @param {string} id
 * @param {boolean} enabled
 * @param {string} [reason]
 * @return {{ok: boolean}}
 */
function setEnabled(stateFile, id, enabled, reason = '') {
  const state = readState(stateFile);
  const prev = state[id] || {};
  state[id] = { ...prev, enabled: !!enabled, disabledReason: enabled ? '' : String(reason || '') };
  if (enabled) delete state[id].disabledReason;
  writeState(stateFile, state);
  return { ok: true, state: state[id] };
}

/**
 * 卸载（删目录 + 清 storage + 清状态，不触碰其它插件）。
 * @param {string} pluginsRoot
 * @param {string} stateFile
 * @param {string} storageRoot
 * @param {string} id
 * @return {{ok: boolean}}
 */
function uninstallPlugin(pluginsRoot, stateFile, storageRoot, id) {
  if (!ID_RE.test(String(id || ''))) return { ok: false, code: 'ESCHEMA', error: t('插件 id 不合法', "Invalid plugin id") };
  try {
    fs.rmSync(path.join(pluginsRoot, String(id)), { recursive: true, force: true });
    fs.rmSync(path.join(storageRoot, `${id}.json`), { force: true });
    const state = readState(stateFile);
    delete state[id];
    writeState(stateFile, state);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
}

/**
 * 读插件私有 storage。
 * @param {string} storageRoot
 * @param {string} id
 * @return {Record<string, *>}
 */
function storageGet(storageRoot, id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(storageRoot, `${id}.json`), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写插件私有 storage（>1MB → ESTORAGE_FULL 且不写盘）。
 * @param {string} storageRoot
 * @param {string} id
 * @param {string} key
 * @param {*} value
 * @return {{ok: boolean, code?: string, error?: string}}
 */
function storageSet(storageRoot, id, key, value) {
  const file = path.join(storageRoot, `${id}.json`);
  const data = storageGet(storageRoot, id);
  data[String(key)] = value;
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > STORAGE_LIMIT) {
    return { ok: false, code: 'ESTORAGE_FULL', error: t('插件存储已超过 1 MB', "Plugin storage exceeds 1 MB") };
  }
  try {
    fs.mkdirSync(storageRoot, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'EWRITE', error: (err && err.message) || String(err) };
  }
}

/**
 * 读插件目录内某个文本文件（主进程做静态扫描用）。
 * @param {string} pluginsRoot
 * @param {string} id
 * @param {string} rel
 * @return {{ok: boolean, text?: string, code?: string}}
 */
function readPluginFile(pluginsRoot, id, rel) {
  const dir = path.resolve(pluginsRoot, String(id || ''));
  const target = path.resolve(dir, String(rel || ''));
  if (!target.startsWith(path.resolve(dir) + path.sep)) return { ok: false, code: 'EPATH' };
  try {
    return { ok: true, text: fs.readFileSync(target, 'utf8') };
  } catch {
    return { ok: false, code: 'ENOTFOUND' };
  }
}

/**
 * 版本比较（与渲染层 `src/core/plugins/manifest.js` 的 compareVersions 同语义）。
 * @param {string} a
 * @param {string} b
 * @return {number} -1 / 0 / 1
 */
function compareVersions(a, b) {
  const pa = String(a || '0.0.0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0.0.0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * `engines.quillpad` 范围匹配。
 *
 * 必须与渲染层 `satisfies()` 逐条对齐：主进程才是真正的安装闸门，两份实现
 * 一旦漂移，就会出现「渲染层放行、主进程拒绝」的怪现象。曾经这里只认
 * `^x.y.z` 和裸 `x.y.z`，于是官方包的 `>=1.0.0` 被判成「需要 QuillPad 3.x」，
 * 市场上点安装全部失败。
 *
 * @param {string} version 当前版本
 * @param {string} range 约束
 * @return {boolean}
 */
function satisfiesVersion(version, range) {
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
 * 校验插件清单里声明的快捷键（与渲染层 `src/core/plugins/manifest.js`
 * 的 `isValidKeyChord` 等价；安装闸门刻意不 import ESM）。
 *
 * @param {string} chord
 * @return {boolean}
 */
function isValidKeyChord(chord) {
  const MODS = ['mod', 'cmd', 'ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'win', 'super'];
  const PRIMARY = ['mod', 'cmd', 'ctrl', 'control', 'meta', 'win', 'super'];
  if (typeof chord !== 'string') return false;
  const raw = chord.trim();
  if (!raw || /\s/.test(raw)) return false;
  const parts = raw.split('-');
  if (parts.length < 2) return false;
  const main = parts.pop();
  if (!/^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|arrow(?:up|down|left|right))$/i.test(main)) return false;
  const mods = parts.map((p) => String(p).toLowerCase());
  if (!mods.every((m) => MODS.includes(m))) return false;
  return mods.some((m) => PRIMARY.includes(m));
}

/**
 * 校验 `contributes.commands`（主进程侧第二道闸）。
 *
 * 渲染层已经查过一遍，但清单是随 zip 一起进来的**不可信输入**：绕过 UI 直接
 * 调 IPC 时只有这里生效，所以 id / key 的规则必须自己再判一次。
 *
 * @param {any} commands
 * @return {{ok: true}|{ok: false, code: string, error: string}}
 */
function validateContributedCommands(commands) {
  if (commands === undefined || commands === null) return { ok: true };
  if (!Array.isArray(commands)) return { ok: false, code: 'ESCHEMA', error: t('contributes.commands 必须是数组', "contributes.commands must be an array") };
  const ids = new Set();
  const keys = new Map();
  for (const cmd of commands) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      return { ok: false, code: 'ESCHEMA', error: t('contributes.commands 条目必须是对象', "contributes.commands entries must be objects") };
    }
    if (typeof cmd.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(cmd.id)) {
      return { ok: false, code: 'ESCHEMA', error: t('命令 id 不合法', "Invalid command id") };
    }
    if (typeof cmd.title !== 'string' || !cmd.title.trim()) {
      return { ok: false, code: 'ESCHEMA', error: t(`命令 ${cmd.id} 缺少 title`, `Command ${cmd.id} is missing a title`) };
    }
    if (ids.has(cmd.id)) return { ok: false, code: 'ESCHEMA', error: t(`命令 id 重复：${cmd.id}`, `Duplicate command id: ${cmd.id}`) };
    ids.add(cmd.id);
    if (cmd.key === undefined || cmd.key === null) continue;
    if (!isValidKeyChord(cmd.key)) {
      return { ok: false, code: 'ESCHEMA', error: t(`命令 ${cmd.id} 的快捷键不合法：${String(cmd.key)}`, `Invalid shortcut for command ${cmd.id}: ${String(cmd.key)}`) };
    }
    const norm = String(cmd.key).trim().toLowerCase().split('-').sort().join('-');
    if (keys.has(norm)) {
      return { ok: false, code: 'ESCHEMA', error: t(`快捷键 ${cmd.key} 在插件内重复（${keys.get(norm)} 与 ${cmd.id}）`, `Shortcut ${cmd.key} is duplicated within the plugin (${keys.get(norm)} and ${cmd.id})`) };
    }
    keys.set(norm, cmd.id);
  }
  return { ok: true };
}

/**
 * 主进程独立复核清单（不信任渲染层传来的任何结论）。
 *
 * 与 `src/core/plugins/manifest.js` 是同一套规则的两份实现：渲染层负责 UI 提示，
 * 主进程负责**真正的安装闸门**。刻意不 dynamic import renderer 的 ESM —— 打包后
 * `src/` 不在 asar 里，且安全边界上主进程不该依赖渲染层代码。
 *
 * @param {object} m
 * @param {string} quillpadVersion
 * @return {{ok: boolean, code?: string, error?: string}}
 */
function validateInstallManifest(m, quillpadVersion = require('./../package.json').version) {
  // 英文字段是界面双语化的本地化副本，不参与校验，但必须放行 —— 否则新包会被
  // 「未知字段」拒之门外。与渲染层 manifest.js 的 MANIFEST_KEYS 保持一致。
  const allowed = ['id', 'name', 'nameEn', 'description', 'descriptionEn', 'author', 'version', 'license', 'engines', 'main', 'permissions', 'contributes', 'signature'];
  const licenses = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'];
  const perms = ['editor:read', 'editor:write', 'files:read', 'files:write', 'clipboard', 'network', 'settings'];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, code: 'ESCHEMA', error: t('清单必须是对象', "Manifest must be an object") };
  for (const key of Object.keys(m)) {
    if (!allowed.includes(key)) return { ok: false, code: 'ESCHEMA', error: t(`未知字段：${key}`, `Unknown field: ${key}`) };
  }
  for (const key of ['id', 'name', 'description', 'author', 'version', 'license', 'main']) {
    if (typeof m[key] !== 'string' || !m[key].trim()) return { ok: false, code: 'ESCHEMA', error: t(`字段 ${key} 不合法`, `Invalid field: ${key}`) };
  }
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id)) return { ok: false, code: 'ESCHEMA', error: t('插件 id 不合法', "Invalid plugin id") };
  if (m.name.length > 40 || m.description.length > 200) return { ok: false, code: 'ESCHEMA', error: t('名称或描述超长', "Name or description is too long") };
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) return { ok: false, code: 'ESCHEMA', error: t('version 必须是 x.y.z', "version must be x.y.z") };
  if (!licenses.includes(m.license)) return { ok: false, code: 'ELICENSE', error: t(`License 不在白名单：${m.license}`, `License not allowlisted: ${m.license}`) };
  const range = m.engines && m.engines.quillpad;
  if (typeof range !== 'string') return { ok: false, code: 'ESCHEMA', error: t('engines.quillpad 缺失', "engines.quillpad is missing") };
  if (!satisfiesVersion(quillpadVersion, range)) {
    const major = String(range).replace(/[^\d.]/g, '').split('.')[0] || '3';
    return { ok: false, code: 'EENGINE', error: t(`需要 QuillPad ${major}.x`, `Requires QuillPad ${major}.x`) };
  }
  if (!/\.(js|mjs)$/i.test(m.main) || m.main.includes('..') || m.main.startsWith('/')) {
    return { ok: false, code: 'ESCHEMA', error: t('main 不合法', "main is invalid") };
  }
  if (!Array.isArray(m.permissions) || m.permissions.some((p) => !perms.includes(p))) {
    return { ok: false, code: 'ESCHEMA', error: t('permissions 含未知权限', "permissions contains an unknown permission") };
  }
  if (!m.contributes || typeof m.contributes !== 'object' || Array.isArray(m.contributes)) {
    return { ok: false, code: 'ESCHEMA', error: t('contributes 不合法', "contributes is invalid") };
  }
  const cmdCheck = validateContributedCommands(m.contributes.commands);
  if (!cmdCheck.ok) return cmdCheck;
  return { ok: true };
}

/** 安装期静态扫描规则（PRD 6 项 + document. / fetch( 等新增 4 项 + P0-1 增补 Function( / import( / EventSource / WebTransport）。 */
const SCAN_PATTERNS = [
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/<script[^>]+src\s*=\s*["']?https?:/i, '<script src="http'],
  [/\brequire\s*\(/, 'require('],
  [/\bprocess\s*\./, 'process.'],
  [/\b__dirname\b/, '__dirname'],
  [/\bdocument\s*\./, 'document.'],
  [/\bfetch\s*\(/, 'fetch('],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bFunction\s*\(/, 'Function('],
  [/\bimport\s*\(/, 'import('],
  [/\bEventSource\b/, 'EventSource'],
  [/\bWebTransport\b/, 'WebTransport'],
];

/**
 * 静态扫描一段源码。
 * @param {string} source
 * @param {string} file
 * @return {{ok: boolean, code?: string, rule?: string, line?: number, file?: string}}
 */
function scanSource(source, file = 'main.js') {
  const lines = String(source || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const [re, rule] of SCAN_PATTERNS) {
      if (re.test(line)) return { ok: false, code: 'ESCAN', rule, line: i + 1, file, text: trimmed.slice(0, 160) };
    }
  }
  return { ok: true };
}

/**
 * 版本比较（严格小于）。
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function compareLess(a, b) {
  const pa = String(a || '0.0.0').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '0.0.0').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}

module.exports = {
  parseZip,
  isSafeEntryName,
  sha256Of,
  installPlugin,
  listPlugins,
  setEnabled,
  uninstallPlugin,
  storageGet,
  storageSet,
  readPluginFile,
  readState,
  writeState,
  validateInstallManifest,
  validateContributedCommands,
  isValidKeyChord,
  scanSource,
  compareLess,
  STORAGE_LIMIT,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
