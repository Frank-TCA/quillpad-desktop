/**
 * 生成 `desktop/plugin-prelude.txt` —— 主进程在安装时写进插件目录的
 * `__qp_bootstrap.js` 模板。
 *
 * 唯一真源是 `src/core/plugins/sandbox.js` 的 `buildPrelude()`；这里只是把它
 * 序列化成一份带占位符的纯文本，供 CJS 主进程读取（打包后 `src/` 不在 asar 里）。
 * 改了 prelude 就重跑本脚本，`scripts/data-check.mjs` 会比对两份是否漂移。
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrelude, API_METHODS } from '../src/core/plugins/sandbox.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = buildPrelude('__QP_ID__', API_METHODS, '__QP_MAIN__');
const text = source
  .replace('"__QP_ID__"', '__QP_ID_JSON__')
  .replace('"__QP_MAIN__"', '__QP_MAIN_JSON__');

if (!text.includes('__QP_ID_JSON__') || !text.includes('__QP_MAIN_JSON__')) {
  throw new Error('prelude 占位符替换失败，请检查 buildPrelude 的输出');
}
writeFileSync(path.join(root, 'desktop', 'plugin-prelude.txt'), `${text}\n`, 'utf8');
console.log(`已生成 desktop/plugin-prelude.txt（${text.length} 字符）`);
