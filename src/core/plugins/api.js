/**
 * QuillPad · 沙箱内 `quillpad` API 的宿主实现（T20）
 *
 * v2 冻结面（PRD §4.G1）：commands.register / editor.* / ui.* / storage.* /
 * net.fetch / events.on。每次调用**逐次鉴权**——权限不是安装时盖一次章就永久放行。
 * 未授权返回 `{ok:false, code:'EPERM_*'}`，由 rpc.js 转成 RPC 失败信封。
 */

/** 权限 → 错误码映射（唯一来源）。 */
export const PERMISSION_ERROR = Object.freeze({
  'editor:read': 'EPERM_EDITOR_READ',
  'editor:write': 'EPERM_EDITOR_WRITE',
  'files:read': 'EPERM_FILES_READ',
  'files:write': 'EPERM_FILES_WRITE',
  clipboard: 'EPERM_CLIPBOARD',
  network: 'EPERM_NETWORK',
  settings: 'EPERM_SETTINGS',
});

/** 单插件 storage 上限（字节）。 */
export const STORAGE_LIMIT = 1024 * 1024;

/**
 * 创建一个插件专属的 API 方法表。
 *
 * @param {object} opts
 * @param {object} opts.manifest
 * @param {object} [opts.app] 宿主 app（只通过 app.editor 读文档，不直接 import app.js）
 * @param {(id: string, args?: object) => any} [opts.runCommand]
 * @param {(msg: string, type?: string) => void} [opts.toast]
 * @param {{get: Function, set: Function}} [opts.storage]
 * @param {(url: string, init?: object) => Promise<any>} [opts.netFetch]
 * @param {(id: string, cb: Function) => void} [opts.onEvent]
 * @param {(payload: object) => void} [opts.onRegister]
 * @return {Record<string, Function>}
 */
export function createPluginApi(opts = {}) {
  const manifest = opts.manifest || { permissions: [], id: '' };
  const granted = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const app = opts.app || null;
  const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
  const runCommand = typeof opts.runCommand === 'function' ? opts.runCommand : () => false;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const onRegister = typeof opts.onRegister === 'function' ? opts.onRegister : () => {};
  const netFetch = typeof opts.netFetch === 'function' ? opts.netFetch : null;

  const storage = opts.storage || {
    get: async () => null,
    set: async () => ({ ok: true }),
  };

  /**
   * 权限闸门。
   * @param {string} permission
   * @return {{ok:false, code:string, message:string}|null}
   */
  function deny(permission) {
    if (granted.has(permission)) return null;
    const code = PERMISSION_ERROR[permission] || 'EINVALID';
    return { ok: false, code, message: `缺少权限 ${permission}`, detail: code };
  }

  /**
   * 当前 EditorView（不存在时返回 null，不抛错）。
   * @return {object|null}
   */
  function view() {
    return app && app.editor && app.editor.view ? app.editor.view : null;
  }

  /** @type {Record<string, Function>} */
  const methods = {
    'commands.register': async (params = {}) => {
      const id = String((params && params.id) || '');
      const title = String((params && params.title) || id);
      if (!/^[a-z][a-z0-9-]*$/.test(id)) return { ok: false, code: 'ESCHEMA', message: '命令 id 不合法' };
      onRegister({ type: 'command', pluginId: manifest.id, id, title });
      return { ok: true, id: `plugin.${manifest.id}.${id}` };
    },
    'editor.getSelection': async () => {
      const d = deny('editor:read');
      if (d) return d;
      const v = view();
      if (!v) return { ok: false, code: 'EINVALID', message: '编辑器不可用' };
      const sel = v.state.selection.main;
      return { text: v.state.sliceDoc(sel.from, sel.to), from: sel.from, to: sel.to };
    },
    'editor.getText': async () => {
      const d = deny('editor:read');
      if (d) return d;
      const v = view();
      return { text: v ? v.state.doc.toString() : '' };
    },
    'editor.replaceSelection': async (params = {}) => {
      const d = deny('editor:write');
      if (d) return d;
      const v = view();
      if (!v) return { ok: false, code: 'EINVALID', message: '编辑器不可用' };
      const text = String((params && params.text) || '');
      v.dispatch({ ...v.state.replaceSelection(text), scrollIntoView: true });
      return { ok: true };
    },
    'editor.insertText': async (params = {}) => {
      return methods['editor.replaceSelection'](params);
    },
    'files.getCurrent': async () => {
      const d = deny('files:read');
      if (d) return d;
      const tab = app && typeof app.activeTab === 'function' ? app.activeTab() : null;
      return { path: (tab && (tab.nativePath || tab.path)) || '', name: (tab && tab.name) || '', content: (tab && tab.content) || '' };
    },
    'files.save': async () => {
      const d = deny('files:write');
      if (d) return d;
      runCommand('file.save');
      return { ok: true };
    },
    'files.saveAs': async () => {
      const d = deny('files:write');
      if (d) return d;
      runCommand('file.saveAs');
      return { ok: true };
    },
    'clipboard.read': async () => {
      const d = deny('clipboard');
      if (d) return d;
      try {
        return { text: await navigator.clipboard.readText() };
      } catch {
        return { text: '' };
      }
    },
    'clipboard.write': async (params = {}) => {
      const d = deny('clipboard');
      if (d) return d;
      try {
        await navigator.clipboard.writeText(String((params && params.text) || ''));
        return { ok: true };
      } catch {
        return { ok: false, code: 'EWRITE', message: '剪贴板写入失败' };
      }
    },
    'storage.get': async (params = {}) => {
      const d = deny('settings');
      if (d) return d;
      const value = await storage.get(String((params && params.key) || ''));
      return { value: value === undefined ? null : value };
    },
    'storage.set': async (params = {}) => {
      const d = deny('settings');
      if (d) return d;
      const res = await storage.set(String((params && params.key) || ''), params && params.value);
      if (res && res.ok === false) return res;
      return { ok: true };
    },
    'net.fetch': async (params = {}) => {
      // G5-2：没有 network 权限时**绝不**发起真实请求，直接给错误码
      const d = deny('network');
      if (d) return d;
      if (!netFetch) return { ok: false, code: 'EPERM_NETWORK', message: '宿主未提供网络通道' };
      try {
        const data = await netFetch(String((params && params.url) || ''), (params && params.options) || {});
        return { ok: true, data };
      } catch (err) {
        return { ok: false, code: 'ENETWORK', message: '网络请求失败', detail: String((err && err.message) || err) };
      }
    },
    'network.fetch': async (params = {}) => methods['net.fetch'](params),
    'ui.showToast': async (params = {}) => {
      toast(String((params && params.message) || ''), String((params && params.type) || 'info'));
      return { ok: true };
    },
    'ui.registerSidebarView': async (params = {}) => {
      const id = String((params && params.id) || '');
      if (!id) return { ok: false, code: 'ESCHEMA', message: '视图 id 不能为空' };
      onRegister({ type: 'sidebarView', pluginId: manifest.id, id, title: String((params && params.title) || id) });
      return { ok: true };
    },
    'events.on': async (params = {}) => {
      onEvent(String((params && params.event) || ''), (params && params.callbackId) || '');
      return { ok: true };
    },
  };

  return methods;
}

/**
 * 把 RPC 请求分派到方法表（不存在的方法返回 ENOTFOUND）。
 * @param {Record<string, Function>} methods
 * @param {{method: string, params?: object}} req
 * @return {Promise<any>}
 */
export async function dispatchApi(methods, req) {
  const fn = methods[String(req.method || '')];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'ENOTFOUND', message: `未知 API：${String(req.method)}` };
  }
  return fn(req.params || {});
}

/**
 * 供沙箱 prelude 生成 API 代理用的方法名清单。
 * 点号分隔的键会展开成嵌套对象（editor.getSelection → quillpad.editor.getSelection）。
 * @param {Record<string, Function>} methods
 * @return {string[]}
 */
export function apiMethodNames(methods) {
  return Object.keys(methods);
}
