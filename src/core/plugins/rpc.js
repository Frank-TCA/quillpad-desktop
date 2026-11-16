/**
 * QuillPad · 插件 RPC 信封与并发护栏（T20）
 *
 * 一次 RPC = 沙箱 → 宿主的一次方法调用。宿主侧统一在这里做：
 *  - 并发上限 16（第 17 个直接 EBUSY，不留悬挂 Promise）；
 *  - 单次超时 10s（net.fetch 30s），超时返回 ETIMEOUT 且 inflight 归零；
 *  - 所有异常归一成 `{ok:false, code, message}`，绝不抛穿渲染层。
 */

import { rpcError, rpcOk, normalizeFailure } from './errors.js';
import { t } from '../i18n.js';

export const RPC_TIMEOUT_MS = 10_000;
export const RPC_NET_TIMEOUT_MS = 30_000;
export const RPC_MAX_INFLIGHT = 16;
export const HEARTBEAT_MS = 5_000;
export const HEARTBEAT_MAX_MISS = 1;

let seq = 0;

/**
 * 生成唯一请求 id。
 * @return {string}
 */
export function nextRequestId() {
  seq += 1;
  return `r${Date.now().toString(36)}-${seq.toString(36)}`;
}

/**
 * 构造请求信封。
 * @param {string} method
 * @param {object} [params]
 * @return {{v: 1, id: string, method: string, params: object}}
 */
export function makeRequest(method, params = {}) {
  return { v: 1, id: nextRequestId(), method: String(method), params: params || {} };
}

export { rpcOk, rpcError };

/**
 * 创建 RPC 宿主（每个插件一个实例）。
 *
 * @param {object} opts
 * @param {(req: object) => Promise<any>|any} opts.onCall 真正执行 API 的函数
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxInflight]
 * @param {() => number} [opts.now]
 * @return {{handle: Function, stats: Function, reset: Function}}
 */
export function createRpcHost(opts = {}) {
  const onCall = typeof opts.onCall === 'function' ? opts.onCall : async () => null;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RPC_TIMEOUT_MS;
  const maxInflight = Number(opts.maxInflight) > 0 ? Number(opts.maxInflight) : RPC_MAX_INFLIGHT;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  let inflight = 0;
  let settled = 0;
  let busyCount = 0;
  let timeoutCount = 0;

  /**
   * 处理一条请求。
   * @param {object} req
   * @return {Promise<object>} RpcOk | RpcErr
   */
  async function handle(req) {
    const id = req && req.id ? String(req.id) : '';
    if (!req || req.v !== 1 || typeof req.method !== 'string') {
      return rpcError(id, 'EINVALID', t('RPC 信封不合法', 'Invalid RPC envelope'));
    }
    if (inflight >= maxInflight) {
      busyCount += 1;
      return rpcError(id, 'EBUSY', t(`并发 ${inflight}/${maxInflight}`, `Concurrency ${inflight}/${maxInflight}`));
    }
    inflight += 1;
    const limit = req.method === 'net.fetch' || req.method === 'network.fetch' ? RPC_NET_TIMEOUT_MS : timeoutMs;
    let timer = null;
    let timedOut = false;
    try {
      const work = Promise.resolve().then(() => onCall(req));
      const result = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject({ code: 'ETIMEOUT', message: t('插件无响应', 'Plugin timed out'), detail: t(`${req.method} 超过 ${limit}ms`, `${req.method} exceeded ${limit}ms`) });
          }, limit);
        }),
      ]);
      settled += 1;
      // onCall 可能已经返回完整信封（api.js 的失败分支）
      if (result && typeof result === 'object' && 'ok' in result && 'v' in result) return result;
      if (result && typeof result === 'object' && result.ok === false && result.code) {
        return rpcError(id, result.code, result.detail || result.message);
      }
      return rpcOk(id, result && typeof result === 'object' && 'data' in result ? result.data : result);
    } catch (err) {
      settled += 1;
      if (timedOut || (err && err.code === 'ETIMEOUT')) {
        timeoutCount += 1;
        return rpcError(id, 'ETIMEOUT', t(`调用超时（${limit}ms）`, `Call timed out (${limit}ms)`));
      }
      const f = normalizeFailure(err);
      return rpcError(id, f.code, f.detail);
    } finally {
      if (timer) clearTimeout(timer);
      inflight -= 1;
    }
  }

  return {
    handle,
    stats: () => ({ inflight, settled, busyCount, timeoutCount, maxInflight }),
    reset: () => {
      inflight = 0;
      settled = 0;
      busyCount = 0;
      timeoutCount = 0;
    },
  };
}

/**
 * 沙箱侧 RPC 客户端（供单元 / QA 在浏览器里验证协议）。
 * 真正的 Worker 里用的是 buildPrelude 内联的同一套协议。
 *
 * @param {{post: Function, timeoutMs?: number}} opts
 * @return {{call: Function, onMessage: Function, pending: Function}}
 */
export function createRpcClient(opts = {}) {
  const post = typeof opts.post === 'function' ? opts.post : () => {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RPC_TIMEOUT_MS;
  /** @type {Map<string, {resolve: Function, reject: Function, timer: number}>} */
  const pending = new Map();

  /**
   * 发起调用。
   * @param {string} method
   * @param {object} params
   * @return {Promise<any>}
   */
  function call(method, params = {}) {
    const req = makeRequest(method, params);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req.id);
        reject({ code: 'ETIMEOUT', message: t('插件无响应', 'Plugin timed out') });
      }, timeoutMs);
      pending.set(req.id, { resolve, reject, timer });
      post(req);
    });
  }

  /**
   * 收到宿主回信。
   * @param {object} msg
   * @return {boolean} 是否命中一个待处理请求
   */
  function onMessage(msg) {
    if (!msg || !msg.id) return false;
    const entry = pending.get(String(msg.id));
    if (!entry) return false;
    pending.delete(String(msg.id));
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(msg.error || { code: 'EINVALID' });
    return true;
  }

  return { call, onMessage, pending: () => pending.size };
}
