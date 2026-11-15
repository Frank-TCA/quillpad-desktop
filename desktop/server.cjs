'use strict';

/**
 * QuillPad 桌面壳 · 内置静态服务器
 *
 * 为什么不用 file:// 直接加载 dist/index.html：
 *   1. Vite 产物里的资源路径是绝对的（/assets/xxx.js），file:// 下会 404；
 *   2. File System Access API 要求「安全上下文」，file:// 下部分能力被禁用；
 *   3. IndexedDB 中的文件句柄按 origin 隔离，固定 origin 才能让「上次保存过的文件」在重启后继续写回。
 * 因此这里起一个只监听回环地址的 HTTP 服务，窗口加载 http://127.0.0.1:<port>。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/** 只覆盖前端产物实际会用到的类型，避免引入额外依赖。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * 把请求路径解析为磁盘上的绝对路径，并挡掉路径穿越。
 * @param {string} rootDir 静态根目录
 * @param {string} requestUrl 原始请求地址
 * @return {string|null} 命中的文件路径；null 表示应当回落
 */
function resolveFile(rootDir, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const abs = path.resolve(rootDir, '.' + pathname);
  // 目录穿越防护：解析结果必须仍在根目录内
  const rootWithSep = path.resolve(rootDir) + path.sep;
  if (abs !== path.resolve(rootDir) && !abs.startsWith(rootWithSep)) return null;

  try {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return path.join(abs, 'index.html');
    return abs;
  } catch {
    return null;
  }
}

/**
 * 判断请求 Origin 是否来自 Electron 应用自身（白名单收敛）。
 *
 * 允许的来源：
 *   - `null`：blob Worker / sandboxed iframe 的 opaque origin
 *   - `file://`：Electron 通过 file 协议加载
 *   - `http://127.0.0.1:<port>`：dev server 自身（回环地址）
 *
 * 其余来源（外部网页等）一律拒绝，不返回 ACAO 头。
 *
 * @param {string|undefined} origin 请求的 Origin 头
 * @return {boolean} true 表示允许该来源
 */
function isSelfOrigin(origin) {
  if (origin === 'null') return true;
  if (origin === 'file://') return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * 创建静态文件服务器（尚未监听）。
 *
 * 额外挂载 `/__plugins/<id>/…`：插件 module Worker 的代码入口。
 * 这条路由**只**读 `pluginsRoot/<id>/` 内的 `.js` / `.mjs` / `.json`，
 * 既不回落 `index.html`，也不返回 `dist/` 的任何内容（架构 §R9）。
 *
 * @param {string} rootDir 静态根目录（通常是 dist）
 * @param {{pluginsRoot?: string}} [options]
 * @return {http.Server}
 */
function createStaticServer(rootDir, options = {}) {
  const indexPath = path.join(rootDir, 'index.html');
  const pluginsRoot = path.resolve(String(options.pluginsRoot || path.join(rootDir, '__plugins')));
  const PLUGIN_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
  const ALLOWED_EXT = new Set(['.js', '.mjs', '.json']);

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    let pathname = '';
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    /* ------------------------------------------------ /__plugins/<id>/… */
    if (pathname === '/__plugins' || pathname.startsWith('/__plugins/')) {
      const parts = pathname.split('/').filter(Boolean); // ['__plugins', id, ...rest]
      const id = parts[1] || '';
      const rel = parts.slice(2).join('/');
      if (!PLUGIN_ID_RE.test(id) || !rel) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const pluginDir = path.resolve(pluginsRoot, id);
      const target = path.resolve(pluginDir, rel);
      const guard = pluginDir + path.sep;
      if (!target.startsWith(guard) || target === pluginDir) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      if (!ALLOWED_EXT.has(path.extname(target).toLowerCase())) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      fs.readFile(target, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        const ext = path.extname(target).toLowerCase();
        const headers = {
          'Content-Type': ext === '.json' ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
        };
        // blob Worker 走跨域模块导入时需要 ACAO；同域 module Worker 用不到。
        // 只对白名单内的 Origin（null / file:// / http://127.0.0.1:*）回显，拒绝任意外部网页。
        const origin = req.headers.origin;
        if (origin && isSelfOrigin(origin)) {
          headers['Access-Control-Allow-Origin'] = origin;
        }
        res.writeHead(200, headers);
        if (req.method === 'HEAD') res.end();
        else res.end(data);
      });
      return;
    }

    let file = resolveFile(rootDir, req.url || '/');
    // 单页应用：未命中的路径一律回落 index.html
    if (!file) file = indexPath;

    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        // 本地应用没有 CDN，禁用缓存避免更新后仍加载旧产物
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(data);
    });
  });
}

/**
 * 监听回环地址。端口被占用时自动退让到系统分配的空闲端口。
 * @param {http.Server} server
 * @param {number} preferredPort 期望端口；0 表示随机
 * @return {Promise<number>} 实际监听端口
 */
function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    let attempt = preferredPort;

    const onError = (err) => {
      // 固定端口被占用 → 退回随机端口，保证应用仍能启动
      if (err && err.code === 'EADDRINUSE' && attempt !== 0) {
        attempt = 0;
        server.listen(0, '127.0.0.1');
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };

    server.on('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });

    server.listen(attempt, '127.0.0.1');
  });
}

module.exports = { createStaticServer, listen };
