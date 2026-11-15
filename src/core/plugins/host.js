/**
 * QuillPad · 插件宿主生命周期（T21 / T23）
 *
 * 装 → 校验（主进程）→ 落盘 → 起 Worker → 注册命令/视图；
 * 禁用 → 注销命令 + terminate Worker（G5-5 / R10）；
 * 卸载 → 删目录 + 清 storage + 注销注册（G5-11）。
 *
 * 刻意不 import app.js：宿主通过 `app` 参数拿到能力，避免循环依赖。
 */

import * as desktop from '../desktop.js';
import { defineCommand, unregisterCommand, allCommands, filterAvailableChords } from '../commands.js';
import { bytesToBase64 } from '../../editor/wysiwyg/image.js';
import { createPluginApi, dispatchApi, apiMethodNames } from './api.js';
import { createRpcHost } from './rpc.js';
import { API_METHODS, createSandbox } from './sandbox.js';
import { validateManifest, staticScan } from './manifest.js';
import * as state from './state.js';
import { APP_VERSION } from '../version.js';

/** @type {Map<string, object>} 运行中的插件会话 */
const sessions = new Map();

/** @type {Array<object>} 最近一次 list 的快照 */
let installed = [];

/**
 * 把字节转 base64（走 image.js 的分块实现，2MB 不会爆栈）。
 * @param {Uint8Array} bytes
 * @return {string}
 */
function b64(bytes) {
  return bytesToBase64(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
}

/**
 * 从发布态目录读取一个「官方插件包」并交给主进程安装（目录式安装）。
 *
 * @param {object} app
 * @param {string} id
 * @param {{update?: boolean}} [opts]
 * @return {Promise<object>}
 */
export async function installBuiltin(app, id, opts = {}) {
  const base = new URL('./plugins/', document.baseURI).href;
  const manifestRes = await fetch(`${base}${id}/plugin.json`, { cache: 'no-cache' });
  if (!manifestRes.ok) return { ok: false, code: 'ENOTFOUND', error: `找不到官方包 ${id}` };
  const manifest = await manifestRes.json();
  const checked = validateManifest(manifest, { quillpadVersion: APP_VERSION });
  if (!checked.ok) return checked;

  const names = ['plugin.json', manifest.main, ...((manifest.contributes && manifest.contributes.assets) || [])];
  const files = [];
  for (const name of [...new Set(names)]) {
    const res = await fetch(`${base}${id}/${name}`, { cache: 'no-cache' });
    if (!res.ok) return { ok: false, code: 'ESCHEMA', error: `包内缺少 ${name}` };
    const buf = new Uint8Array(await res.arrayBuffer());
    const scan = /\.m?js$/i.test(name) ? staticScan(new TextDecoder().decode(buf), name) : { ok: true };
    if (!scan.ok) return scan;
    files.push({ name, base64: b64(buf) });
  }

  // prelude 由主进程从唯一真源模板生成（它才知道 zip 里真正的 id / main）
  const res = await desktop.pluginInstall({
    files,
    update: opts.update ? 'true' : 'false',
    force: opts.update ? 'true' : 'false',
    expectedSha256: '',
  });
  if (!res.ok) return res;
  await refresh(app);
  return res;
}

/**
 * 从 zip 字节或 URL 安装（本地拖入 / URL 下载 / 市场第三方包）。
 *
 * 管线：URL → fetch 下载 → Uint8Array → base64 → `zipBase64` → 主进程解压安装。
 *
 * @param {object} app
 * @param {{bytes?: Uint8Array|number[], url?: string, expectedSha256?: string, update?: boolean, force?: boolean}} input
 * @return {Promise<object>}
 */
export async function installFromZip(app, input = {}) {
  let bytes = input.bytes;

  // URL 分支：先下载 zip 内容
  if (!bytes && input.url) {
    try {
      const resp = await fetch(String(input.url));
      if (!resp.ok) {
        return { ok: false, code: 'EDOWNLOAD', error: `下载失败: HTTP ${resp.status}` };
      }
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      return { ok: false, code: 'EDOWNLOAD', error: `下载失败: ${(err && err.message) || String(err)}` };
    }
  }

  if (!bytes || !bytes.length) return { ok: false, code: 'EINVALID', error: '安装包为空' };

  // Uint8Array / number[] → base64
  const zipBase64 = b64(bytes);

  const res = await desktop.pluginInstall({
    zipBase64,
    expectedSha256: String(input.expectedSha256 || ''),
    update: input.update ? 'true' : 'false',
    force: (input.force || input.update) ? 'true' : 'false',
  });
  if (!res.ok) return res;
  await refresh(app);
  return res;
}

/**
 * 拉回主进程的权威状态并重建会话。
 * @param {object} app
 * @return {Promise<Array<object>>}
 */
export async function refresh(app) {
  const res = await desktop.pluginList();
  installed = res.ok && Array.isArray(res.plugins) ? res.plugins : [];
  state.replaceState(installed);

  // 关掉不该再跑的会话
  for (const [id, session] of [...sessions.entries()]) {
    const found = installed.find((p) => p.id === id);
    if (!found || !found.enabled) stopSession(id);
  }
  // 启动新增的、启用的会话
  for (const plugin of installed) {
    if (!plugin.enabled || sessions.has(plugin.id)) continue;
    if (plugin.disabledReason) continue; // G5-16：崩溃停用不自动复活
    startSession(app, plugin);
  }
  return installed;
}

/**
 * 启动一个插件的 Worker 与命令注册。
 * @param {object} app
 * @param {object} plugin
 * @return {object|null}
 */
export function startSession(app, plugin) {
  const manifest = plugin.manifest || {};
  const id = String(plugin.id || manifest.id || '');
  if (!id || sessions.has(id)) return sessions.get(id) || null;
  const name = String(manifest.name || id);
  const commandIds = new Set();
  const viewIds = new Set();

  /*
   * 清单里 `contributes.commands[].key` 是**声明式**的：插件在 Worker 里
   * `commands.register(id, title, run)` 时只报 id / title，宿主据此把清单里
   * 声明的快捷键挂到命令上。这样插件作者改键位只动 plugin.json、不用碰代码，
   * 也不让沙箱拥有「自己决定全局热键」的能力。
   */
  /** @type {Map<string, string>} 插件内部命令 id → 组合键 */
  const declaredKeys = new Map();
  for (const item of (manifest.contributes && manifest.contributes.commands) || []) {
    if (item && typeof item.id === 'string' && typeof item.key === 'string' && item.key) {
      declaredKeys.set(item.id, item.key);
    }
  }

  const storage = {
    get: async (key) => {
      const r = await desktop.pluginStorage({ action: 'get', id, key });
      return r && r.ok ? r.value : null;
    },
    set: async (key, value) => desktop.pluginStorage({ action: 'set', id, key, value }),
  };

  let sandbox = null;
  const onRegister = (payload) => {
    if (!payload) return;
    if (payload.type === 'command') {
      const cmdId = `plugin.${id}.${payload.id}`;
      /** @type {string[]} */
      const keys = [];
      const declared = declaredKeys.get(String(payload.id));
      if (declared) {
        // 插件不得覆盖内置命令的键位：撞了就放弃这个键，命令本身照常注册
        const { keys: usable, conflicts } = filterAvailableChords([declared], cmdId);
        if (conflicts.length) {
          console.warn(
            `[QuillPad] 插件「${name}」的 ${payload.id} 想用 ${declared}，但已被 ${conflicts[0].owner} 占用，已忽略该快捷键`,
          );
        } else {
          keys.push(...usable);
        }
      }
      defineCommand({
        id: cmdId,
        title: `${name}：${payload.title || payload.id}`,
        category: '插件',
        keys,
        run: async () => (sandbox ? sandbox.invoke(String(payload.id), {}) : false),
      });
      commandIds.add(cmdId);
    } else if (payload.type === 'sidebarView') {
      viewIds.add(String(payload.id));
      if (app && typeof app.registerPluginView === 'function') {
        app.registerPluginView({ id: `${id}.${payload.id}`, title: payload.title, pluginId: id });
      }
    }
  };

  const methods = createPluginApi({
    manifest,
    app,
    runCommand: (cid) => (app && typeof app.run === 'function' ? app.run(cid) : false),
    toast: (msg, type) => (app && typeof app.toast === 'function' ? app.toast(msg, type || 'info') : undefined),
    storage,
    // 宿主侧真正发网络请求的唯一出口；没有 network 权限时 api.js 已提前拦下
    netFetch: async (url, options) => {
      const r = await fetch(String(url), options || {});
      return { status: r.status, text: await r.text() };
    },
    onRegister,
  });

  const rpc = createRpcHost({ onCall: (req) => dispatchApi(methods, req) });

  const onDead = async (reason) => {
    // 崩溃即停用，并写死 disabledReason —— 重启后不会被自动复活（G5-16）
    state.markCrashed(id);
    await desktop.pluginEnable(id, false, 'crashed');
    const session = sessions.get(id);
    if (session) session.alive = false;
    stopSession(id);
    if (app && typeof app.toast === 'function') {
      app.toast(`插件「${name}」已停用（无响应）`, 'error', 3200);
    }
    if (app && typeof app.emitPluginsChanged === 'function') app.emitPluginsChanged();
    console.warn('[QuillPad] 插件沙箱停用：', id, reason);
  };

  const base = `${String(desktopBaseUrl()).replace(/\/?$/, '/')}__plugins/${id}/`;
  try {
    sandbox = createSandbox({
      manifest: { ...manifest, id },
      baseUrl: base,
      onCall: rpc.handle,
      onDead,
      onRegister,
    });
  } catch (err) {
    console.warn('[QuillPad] 插件 Worker 启动失败：', err && err.message);
    return null;
  }

  const session = { id, manifest, sandbox, rpc, commandIds, viewIds, alive: true, apiMethods: apiMethodNames(methods) };
  sessions.set(id, session);
  return session;
}

/** 本地服务地址缓存（同步返回，由 refresh 前置调用时写入）。 */
let cachedBaseUrl = '';

/**
 * 取 baseUrl（同步版本）；异步刷新由 primeBaseUrl 完成。
 * @return {string}
 */
function desktopBaseUrl() {
  return cachedBaseUrl || (typeof location !== 'undefined' ? location.origin + '/' : 'http://127.0.0.1:41731/');
}

/**
 * 预取本地服务地址（应用启动时调一次）。
 * @return {Promise<string>}
 */
export async function primeBaseUrl() {
  const res = await desktop.pluginBaseUrl();
  if (res && res.ok && res.baseUrl) cachedBaseUrl = String(res.baseUrl);
  else if (typeof location !== 'undefined') cachedBaseUrl = location.origin + '/';
  return cachedBaseUrl;
}

/**
 * 停掉一个会话并注销它注册的全部命令。
 * @param {string} id
 * @return {void}
 */
export function stopSession(id) {
  const session = sessions.get(String(id));
  if (!session) return;
  for (const cmdId of session.commandIds) unregisterCommand(cmdId);
  for (const viewId of session.viewIds) {
    // 视图由 app 侧按 pluginId 统一清理（见 unregisterViews）
  }
  try {
    session.sandbox.terminate();
  } catch {
    /* 已销毁 */
  }
  sessions.delete(String(id));
}

/**
 * 禁用插件（G5-5：命令计数立刻回落）。
 * @param {object} app
 * @param {string} id
 * @param {string} [reason]
 * @return {Promise<object>}
 */
export async function disable(app, id, reason = '') {
  stopSession(id);
  const res = await desktop.pluginEnable(id, false, reason);
  state.setEntry(id, { enabled: false, disabledReason: reason || '' });
  await refresh(app);
  return res;
}

/**
 * 启用插件。
 * @param {object} app
 * @param {string} id
 * @return {Promise<object>}
 */
export async function enable(app, id) {
  const reason = state.getEntry(id);
  if (reason && reason.blocked) return { ok: false, code: 'EBLOCKED', error: '该插件已被阻止（License 不合规）' };
  await desktop.pluginEnable(id, true, '');
  state.setEntry(id, { enabled: true, disabledReason: '' });
  await refresh(app);
  return { ok: true };
}

/**
 * 卸载插件。
 * @param {object} app
 * @param {string} id
 * @return {Promise<object>}
 */
export async function uninstall(app, id) {
  stopSession(id);
  const res = await desktop.pluginUninstall(id);
  state.removeEntry(id);
  await refresh(app);
  return res;
}

/**
 * 已安装插件快照。
 * @return {Array<object>}
 */
export function getInstalled() {
  return installed.slice();
}

/**
 * 某个插件贡献的命令数（QA G5-5 用）。
 * @param {string} id
 * @return {number}
 */
export function commandCountFor(id) {
  const prefix = `plugin.${id}.`;
  return allCommands().filter((c) => c.id.startsWith(prefix)).length;
}

/**
 * 全部插件命令数。
 * @return {number}
 */
export function totalPluginCommands() {
  return allCommands().filter((c) => c.id.startsWith('plugin.')).length;
}

/**
 * 会话诊断（QA 用）。
 * @return {Array<object>}
 */
export function sessionStats() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    alive: s.sandbox.alive(),
    commands: s.commandIds.size,
    views: s.viewIds.size,
    rpc: s.rpc.stats(),
  }));
}

/** 测试用：清空全部会话与命令。 */
export function __resetHost() {
  for (const id of [...sessions.keys()]) stopSession(id);
  installed = [];
  state.__resetState();
}
