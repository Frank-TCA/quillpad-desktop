/**
 * QuillPad · 插件沙箱（T20）
 *
 * 架构 §G-1 定案：**module Worker**，不是 iframe。唯一能杀掉 `while(true)`
 * 且不冻结主线程的手段是 `worker.terminate()`（G5-6）。
 *
 * 两道隔离：
 *  1. 宿主生成的 `__qp_bootstrap.js`（prelude）先删掉危险全局，再 `import()` 插件 main；
 *  2. `/__plugins/<id>/…` 本地路由只放行该插件目录内的 js/json，不返回 dist 任何内容。
 *
 * 协议：`__qp:ready` / `__qp:heartbeat` / `__qp:rpc` / `__qp:rpc-result` /
 * `__qp:register` / `__qp:invoke` / `__qp:invoke-result` / `__qp:error`。
 */

import { HEARTBEAT_MS, HEARTBEAT_MAX_MISS, RPC_MAX_INFLIGHT } from './rpc.js';

/** prelude 要删除的全局（删除失败时再用 defineProperty 兜底遮蔽）。 */
export const BLOCKED_GLOBALS = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'document',
  'process',
  'require',
  '__dirname',
  '__filename',
  'indexedDB',
  'caches',
  'SharedWorker',
  'Worker',
  'EventSource',
  'WebTransport',
  'BroadcastChannel',
  'eval',
  'Function',
]);

/** prelude 暴露给插件的 API 方法名（点号路径）。 */
export const API_METHODS = Object.freeze([
  'commands.register',
  'editor.getSelection',
  'editor.getText',
  'editor.replaceSelection',
  'editor.insertText',
  'files.getCurrent',
  'files.save',
  'files.saveAs',
  'clipboard.read',
  'clipboard.write',
  'storage.get',
  'storage.set',
  'net.fetch',
  'ui.showToast',
  'ui.registerSidebarView',
  'events.on',
]);

/**
 * 生成 prelude 源码（宿主唯一可控的引导脚本，插件改不到）。
 *
 * @param {string} pluginId
 * @param {string[]} [apiMethods] 方法名清单
 * @param {string} [mainFile] 相对路径，如 `./main.js`
 * @return {string}
 */
export function buildPrelude(pluginId, apiMethods = API_METHODS, mainFile = './main.js') {
  const id = JSON.stringify(String(pluginId || ''));
  const main = JSON.stringify(String(mainFile || './main.js'));
  const globals = JSON.stringify(BLOCKED_GLOBALS);
  const methods = JSON.stringify(Array.from(apiMethods || API_METHODS));
  return [
    '/* QuillPad 插件引导脚本：由宿主生成，插件无法修改。 */',
    `const PLUGIN_ID = ${id};`,
    `const MAIN_FILE = ${main};`,
    `const BLOCKED = ${globals};`,
    `const METHODS = ${methods};`,
    'for (const key of BLOCKED) {',
    '  try { delete self[key]; } catch (e) { /* 不可配置时走下一行 */ }',
    '  try { Object.defineProperty(self, key, { value: undefined, writable: false, configurable: false }); } catch (e) { /* 已存在即忽略 */ }',
    '}',
    '// 缓存原生 postMessage：心跳固定使用缓存引用，插件覆写 self.postMessage 不影响心跳',
    'const __qpPostMessage = self.postMessage.bind(self);',
    'const pending = new Map();',
    'const handlers = new Map();',
    'const viewRenders = new Map();',
    'let seq = 0;',
    'function call(method, params) {',
    '  return new Promise((resolve, reject) => {',
    "    const id = 'p' + (++seq) + '-' + Date.now().toString(36);",
    '    const timer = setTimeout(() => {',
    '      pending.delete(id);',
    "      reject({ code: 'ETIMEOUT', message: '插件无响应' });",
    '    }, 10000);',
    '    pending.set(id, { resolve, reject, timer });',
    "    __qpPostMessage({ __qp: 'rpc', req: { v: 1, id, method, params: params || {} } });",
    '  });',
    '}',
    'function setPath(root, dotted, fn) {',
    "  const parts = dotted.split('.');",
    '  let cur = root;',
    '  for (let i = 0; i < parts.length - 1; i += 1) {',
    '    if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};',
    '    cur = cur[parts[i]];',
    '  }',
    '  cur[parts[parts.length - 1]] = fn;',
    '}',
    'const api = {};',
    'for (const method of METHODS) {',
    '  if (method === "commands.register") {',
    '    setPath(api, method, (id, title, run) => {',
    '      if (typeof run === "function") handlers.set(String(id), run);',
    "      return call(method, { id: String(id || ''), title: String(title || id || '') });",
    '    });',
    '  } else if (method === "editor.replaceSelection" || method === "editor.insertText") {',
    '    setPath(api, method, (text) => call(method, { text: String(text == null ? "" : text) }));',
    '  } else if (method === "ui.showToast") {',
    '    setPath(api, method, (message, type) => call(method, { message: String(message || ""), type: String(type || "info") }));',
    '  } else if (method === "storage.get") {',
    '    setPath(api, method, (key) => call(method, { key: String(key || "") }));',
    '  } else if (method === "storage.set") {',
    '    setPath(api, method, (key, value) => call(method, { key: String(key || ""), value }));',
    '  } else if (method === "net.fetch") {',
    '    setPath(api, method, (url, options) => call(method, { url: String(url || ""), options: options || {} }));',
    '  } else if (method === "events.on") {',
    '    setPath(api, method, (event, cb) => call(method, { event: String(event || ""), callbackId: typeof cb === "function" ? String(event) : "" }));',
    '  } else if (method === "ui.registerSidebarView") {',
    '    setPath(api, method, (spec) => {',
    '      const s = spec || {};',
    '      if (typeof s.render === "function") viewRenders.set(String(s.id), s.render);',
    '      return call(method, { id: String(s.id || ""), title: String(s.title || s.id || "") });',
    '    });',
    '  } else {',
    '    setPath(api, method, (arg) => call(method, arg && typeof arg === "object" ? arg : {}));',
    '  }',
    '}',
    'Object.freeze(api);',
    'self.quillpad = api;',
    "self.addEventListener('message', (event) => {",
    '  const m = event.data || {};',
    "  if (m.__qp === 'rpc-result') {",
    '    const entry = m.msg && pending.get(String(m.msg.id));',
    '    if (!entry) return;',
    '    pending.delete(String(m.msg.id));',
    '    clearTimeout(entry.timer);',
    '    if (m.msg.ok) entry.resolve(m.msg.data);',
    '    else entry.reject(m.msg.error || { code: "EINVALID" });',
    '    return;',
    '  }',
    "  if (m.__qp === 'invoke') {",
    '    const fn = handlers.get(String(m.id));',
    '    Promise.resolve()',
    '      .then(() => (typeof fn === "function" ? fn(m.params || {}) : null))',
    '      .then((data) => __qpPostMessage({ __qp: "invoke-result", reqId: m.reqId, data }))',
    '      .catch((err) => __qpPostMessage({ __qp: "invoke-result", reqId: m.reqId, error: String(err && err.message || err) }));',
    '  }',
    '});',
    "setInterval(() => __qpPostMessage({ __qp: 'heartbeat', pluginId: PLUGIN_ID, t: Date.now() }), 1000);",
    "__qpPostMessage({ __qp: 'ready', pluginId: PLUGIN_ID, fetch: typeof self.fetch, document: typeof self.document, require: typeof self.require });",
    '// 限制动态 import：只允许包内相对路径，禁止远端 URL 和 data: 载荷',
    '// 注意：模块 Worker 中 import() 是 ImportCall 语法表达式，无法通过覆写 self.import 拦截；',
    '// 此处覆写仅在 import 可覆写的环境下生效，主要防线是安装期静态扫描规则（SCAN_RULES / SCAN_PATTERNS）。',
    'const __qpOrigImport = self.import;',
    'if (typeof __qpOrigImport === "function") {',
    '  self.import = function(specifier) {',
    '    const s = String(specifier);',
    "    if (!s.startsWith('./') && !s.startsWith('../')) {",
    "      return Promise.reject(new Error('[qp-sandbox] dynamic import only allows relative paths within the plugin package'));",
    '    }',
    '    return __qpOrigImport.call(self, s);',
    '  };',
    '}',
    'import(MAIN_FILE).catch((err) => {',
    '  __qpPostMessage({ __qp: "error", message: String(err && err.message || err) });',
    '});',
  ].join('\n');
}

/**
 * 创建插件沙箱。
 *
 * @param {object} opts
 * @param {object} opts.manifest
 * @param {string} opts.baseUrl `/__plugins/<id>/` 绝对地址
 * @param {(req: object) => Promise<object>} opts.onCall RPC 宿主回调
 * @param {(reason: string) => void} opts.onDead 心跳超时 / 崩溃
 * @param {(payload: object) => void} [opts.onRegister] 命令 / 视图注册
 * @param {(msg: object) => void} [opts.onReady]
 * @param {string} [opts.bootstrapFile]
 * @param {string} [opts.transport] 'blob' 时用 prelude 直接建 Worker（QA 用）
 * @return {{worker: Worker, post: Function, terminate: Function, alive: Function,
 *           invoke: Function, stats: Function}}
 */
export function createSandbox(opts = {}) {
  const manifest = opts.manifest || { id: 'unknown', main: 'main.js' };
  const onCall = typeof opts.onCall === 'function' ? opts.onCall : async () => null;
  const onDead = typeof opts.onDead === 'function' ? opts.onDead : () => {};
  const onRegister = typeof opts.onRegister === 'function' ? opts.onRegister : () => {};
  const onReady = typeof opts.onReady === 'function' ? opts.onReady : () => {};
  const mainFile = manifest.main ? `./${String(manifest.main).replace(/^\.\//, '')}` : './main.js';

  let alive = true;
  let deadCalled = false;
  let lastBeat = Date.now();
  let missed = 0;
  const invokes = new Map();
  let invokeSeq = 0;
  let messageHandler = null;

  /** onDead 一次性闩：防止 __qp:'error' / error 事件 / 心跳超时双触发导致重复 toast。 */
  function safeOnDead(reason) {
    if (deadCalled) return;
    deadCalled = true;
    onDead(reason);
  }

  let workerUrl = `${String(opts.baseUrl || '').replace(/\/?$/, '/')}${opts.bootstrapFile || '__qp_bootstrap.js'}`;
  let blobUrl = '';
  if (opts.transport === 'blob' || typeof Worker === 'undefined') {
    const source = buildPrelude(manifest.id, API_METHODS, mainFile);
    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
      blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      workerUrl = blobUrl;
    }
  }

  const worker = new Worker(workerUrl, { type: 'module', name: `qp-plugin-${manifest.id}` });

  /**
   * 安全终止（幂等）。
   */
  function terminate() {
    if (!alive) return;
    alive = false;
    if (messageHandler) {
      try {
        worker.removeEventListener('message', messageHandler);
      } catch {
        /* 忽略 */
      }
    }
    try {
      worker.terminate();
    } catch {
      /* 已销毁 */
    }
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* 忽略 */
      }
    }
    clearInterval(watchdog);
    for (const entry of invokes.values()) {
      clearTimeout(entry.timer);
      entry.reject({ code: 'EDEAD', message: '插件已停用（无响应）' });
    }
    invokes.clear();
  }

  /**
   * 宿主 → 沙箱投递一条消息。
   * @param {object} msg
   */
  function post(msg) {
    if (!alive) return;
    worker.postMessage(msg);
  }

  messageHandler = async (event) => {
    if (!alive) return;
    const m = (event && event.data) || {};
    if (m.__qp === 'heartbeat') {
      lastBeat = Date.now();
      missed = 0;
      return;
    }
    if (m.__qp === '__qp:ready' || m.__qp === 'ready') {
      lastBeat = Date.now();
      onReady(m);
      return;
    }
    if (m.__qp === 'rpc') {
      const reply = await onCall(m.req);
      post({ __qp: 'rpc-result', msg: reply });
      return;
    }
    if (m.__qp === 'register') {
      onRegister(m.payload || {});
      return;
    }
    if (m.__qp === 'invoke-result') {
      const entry = invokes.get(String(m.reqId));
      if (!entry) return;
      invokes.delete(String(m.reqId));
      clearTimeout(entry.timer);
      if (m.error) entry.reject({ code: 'EINVALID', message: String(m.error) });
      else entry.resolve(m.data);
      return;
    }
    if (m.__qp === 'error') {
      safeOnDead(String(m.message || '插件运行异常'));
      terminate();
    }
  };
  worker.addEventListener('message', messageHandler);

  worker.addEventListener('error', (event) => {
    safeOnDead(String((event && event.message) || '插件未捕获异常'));
    terminate();
  });

  const watchdog = setInterval(() => {
    if (!alive) return;
    const gap = Date.now() - lastBeat;
    if (gap <= HEARTBEAT_MS) return;
    missed += 1;
    if (missed <= HEARTBEAT_MAX_MISS) return;
    safeOnDead(`心跳超时 ${gap}ms`);
    terminate();
  }, 1000);

  /**
   * 让沙箱执行一条已注册命令。
   * @param {string} commandId 插件内部 id（不含命名空间）
   * @param {object} [params]
   * @return {Promise<any>}
   */
  function invoke(commandId, params = {}) {
    if (!alive) return Promise.reject({ code: 'EDEAD', message: '插件已停用（无响应）' });
    invokeSeq += 1;
    const reqId = `i${invokeSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        invokes.delete(reqId);
        reject({ code: 'ETIMEOUT', message: '插件无响应' });
      }, 10_000);
      invokes.set(reqId, { resolve, reject, timer });
      post({ __qp: 'invoke', reqId, id: String(commandId), params: params || {} });
    });
  }

  return {
    worker,
    post,
    terminate,
    alive: () => alive,
    invoke,
    stats: () => ({ alive, lastBeat, missed, invokes: invokes.size, maxInflight: RPC_MAX_INFLIGHT }),
  };
}
