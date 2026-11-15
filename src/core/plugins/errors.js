/**
 * QuillPad · 插件错误码（唯一来源）
 *
 * PRD §4.G / ARCH §4 表格：RPC、manifest 校验、安装管线、面板 toast 全部从这里取文案，
 * 避免同一个错误在三个地方写出三种说法。
 */

/** @typedef {string} PluginErrorCode */

/** 错误码 → 用户可见中文文案。 */
export const PLUGIN_ERRORS = Object.freeze({
  ESCHEMA: '清单格式不合法',
  ELICENSE: 'License 不在白名单，仅允许 MIT/Apache-2.0/BSD/ISC/0BSD',
  EENGINE: 'QuillPad 版本不匹配',
  ESCAN: '源码存在禁用调用',
  ESHA256: '下载内容校验失败',
  EPATH: '安装包包含非法路径',
  EEXISTS: '已安装更高版本',
  EBUSY: '插件繁忙，请稍后重试',
  ETIMEOUT: '插件无响应',
  EDEAD: '插件已停用（无响应）',
  EPERM_EDITOR_READ: '插件缺少编辑器读权限',
  EPERM_EDITOR_WRITE: '插件缺少编辑器写权限',
  EPERM_FILES_READ: '插件缺少文件读权限',
  EPERM_FILES_WRITE: '插件缺少文件写权限',
  EPERM_CLIPBOARD: '插件缺少剪贴板权限',
  EPERM_NETWORK: '插件缺少网络权限',
  EPERM_SETTINGS: '插件缺少存储权限',
  ESTORAGE_FULL: '插件存储已超过 1 MB',
  ENOTFOUND: '找不到指定插件',
  EINVALID: '参数不合法',
  EWRITE: '写入失败',
  EUNZIP: '压缩包解析失败',
  ETOOBIG: '安装包体积超限',
  EBLOCKED: '插件已被阻止',
});

/** 全部错误码（供测试枚举）。 */
export const PLUGIN_ERROR_CODES = Object.freeze(Object.keys(PLUGIN_ERRORS));

/**
 * 取一条错误的完整描述。
 * @param {string} code
 * @param {string} [detail]
 * @return {{code: string, message: string, detail?: string}}
 */
export function errorOf(code, detail = '') {
  const key = PLUGIN_ERRORS[code] ? code : 'EINVALID';
  const out = { code: key, message: PLUGIN_ERRORS[key] };
  if (detail) out.detail = String(detail);
  return out;
}

/**
 * 组装 RPC 失败信封。
 * @param {string} id 请求 id
 * @param {string} code
 * @param {string} [detail]
 * @return {{v: 1, id: string, ok: false, error: object}}
 */
export function rpcError(id, code, detail = '') {
  return { v: 1, id: String(id || ''), ok: false, error: errorOf(code, detail) };
}

/**
 * 组装 RPC 成功信封。
 * @param {string} id
 * @param {*} data
 * @return {{v: 1, id: string, ok: true, data: *}}
 */
export function rpcOk(id, data) {
  return { v: 1, id: String(id || ''), ok: true, data };
}

/**
 * 把任意异常归一成 `{ok:false, code, message}`（防止 IPC 抛穿界面）。
 * @param {*} err
 * @param {string} [fallback]
 * @return {{ok: false, code: string, message: string, detail: string}}
 */
export function normalizeFailure(err, fallback = 'EINVALID') {
  if (err && typeof err === 'object' && err.code && PLUGIN_ERRORS[err.code]) {
    return {
      ok: false,
      code: err.code,
      message: PLUGIN_ERRORS[err.code],
      detail: String(err.detail || err.message || ''),
    };
  }
  const code = PLUGIN_ERRORS[fallback] ? fallback : 'EINVALID';
  return {
    ok: false,
    code,
    message: PLUGIN_ERRORS[code],
    detail: String((err && err.message) || err || ''),
  };
}
