/**
 * QuillPad · 打印字体内联
 *
 * PDF 里中文必须是真的嵌入字体，不能靠系统字体：
 * 同一份文件在不同机器上导出，字形/行宽会不一样。所以打印 HTML 会把
 * `src/assets/fonts/noto-sans-sc-subset.ttf` 读成 base64 塞进 `@font-face`，
 * 让 Chromium 打印引擎去嵌入子集。
 *
 * 字体是 SIL OFL 1.1（见同目录 `OFL.txt`），可随应用再分发。
 * 子集由 `scripts/font-subset.py` 生成（GB2312 全集 + ASCII + 中文标点）。
 */

import sansUrl from '../assets/fonts/noto-sans-sc-subset.ttf?url';
import serifUrl from '../assets/fonts/noto-serif-sc-subset.ttf?url';
import { bytesToBase64 } from '../editor/wysiwyg/image.js';
import { t } from './i18n.js';

/** `@font-face` 里用的族名（打印页里只有这一个字体源）。 */
export const PRINT_SANS_FAMILY = 'QPPrintSans';
export const PRINT_SERIF_FAMILY = 'QPPrintSerif';

/**
 * 打印页的完整 font-family 栈。
 *
 * 子集字体覆盖 GB2312 全集；万一文档里有生僻字落在子集之外，
 * 后面的系统字体负责兜底（此时 PDF 里那个字用的是系统字体）。
 * 等宽字体不打包（`JetBrains Mono` 授权允许打包但体积收益低），
 * 用系统栈：Windows 上是 Cascadia/Consolas，macOS 上是 Menlo。
 */
export const PRINT_SANS_STACK = `'${PRINT_SANS_FAMILY}', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif`;
export const PRINT_SERIF_STACK = `'${PRINT_SERIF_FAMILY}', 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', serif`;
export const PRINT_MONO_STACK =
  `'JetBrains Mono', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace`;

/** 内存缓存：一次导出会话里只读一次磁盘。 */
const cache = {
  /** @type {string|null} */
  sans: null,
  /** @type {string|null} */
  serif: null,
};

/**
 * base64 → Uint8Array（不依赖 Buffer，沙箱里也能跑）。
 * @param {string} base64
 * @return {Uint8Array}
 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 走桌面壳主进程读资源字节。
 *
 * 打包后页面在 `file://` 上，`fetch(file:…)` 会被同源策略直接拒掉；
 * 而字体就是 `dist/assets/*.ttf` 的绝对 file URL。主进程 `qp:read-asset`
 * 做了「只能在应用目录内」的路径防护，所以这条兜底既不越权也不漏读。
 *
 * @param {string} url
 * @return {Promise<Uint8Array|null>}
 */
async function readBytesViaBridge(url) {
  if (!/^file:/i.test(String(url || ''))) return null;
  const bridge = typeof window !== 'undefined' ? window.quillpadDesktop : null;
  if (!bridge || typeof bridge.readAsset !== 'function') return null;
  try {
    const res = await bridge.readAsset({ url: String(url) });
    if (!res || !res.ok || !res.base64) return null;
    const bytes = base64ToBytes(res.base64);
    return bytes.length ? bytes : null;
  } catch (err) {
    console.warn('[QuillPad] 主进程读取字体失败：', err && err.message);
    return null;
  }
}

/**
 * 把一个 URL 读成 `data:font/ttf;base64,...`。
 * @param {string} url
 * @param {string} mime
 * @return {Promise<string>} 失败时返回空字符串
 */
async function fetchAsDataUrl(url, mime) {
  let buf = null;
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) throw new Error(t('字体文件为空', 'Font file is empty'));
  } catch (err) {
    buf = await readBytesViaBridge(url);
    if (!buf) {
      console.warn('[QuillPad] 读取打印字体失败，将回退系统字体：', err && err.message);
      return '';
    }
  }
  return `data:${mime};base64,${bytesToBase64(buf)}`;
}

/**
 * 载入打印字体（首次读盘，之后走内存缓存）。
 *
 * @param {{serif?: boolean, sans?: boolean}} [opts]
 * @return {Promise<{sans: string, serif: string, bytes: number}>}
 */
export async function loadPrintFonts(opts = {}) {
  const wantSans = opts.sans !== false;
  const wantSerif = opts.serif === true;

  if (wantSans && !cache.sans) cache.sans = await fetchAsDataUrl(sansUrl, 'font/ttf');
  if (wantSerif && !cache.serif) cache.serif = await fetchAsDataUrl(serifUrl, 'font/ttf');

  const sans = wantSans ? cache.sans || '' : '';
  const serif = wantSerif ? cache.serif || '' : '';
  return { sans, serif, bytes: sans.length + serif.length };
}

/**
 * 拼 `@font-face` 声明块（没有字体时返回空串，打印页自动回退系统字体）。
 *
 * `font-weight: 400` 是硬的：子集字体是 `instancer` 实例化出来的**静态**字重，
 * 不是可变字体。声明成 `100 900` 会让 Chromium 按可变字体去找轴，
 * 找不到轴时整条 `@font-face` 被判定不可用 —— 表现就是打印稿静默回退系统字体。
 * 粗体由 Chromium 合成（synthetic bold），中文正文里视觉差别可接受。
 *
 * @param {{sans: string, serif: string}} fonts
 * @return {string}
 */
export function fontFaceCss(fonts) {
  const parts = [];
  if (fonts && fonts.sans) {
    parts.push(
      `@font-face{font-family:'${PRINT_SANS_FAMILY}';font-style:normal;font-weight:400;` +
        `font-display:block;src:url(${fonts.sans}) format('truetype')}`,
    );
  }
  if (fonts && fonts.serif) {
    parts.push(
      `@font-face{font-family:'${PRINT_SERIF_FAMILY}';font-style:normal;font-weight:400;` +
        `font-display:block;src:url(${fonts.serif}) format('truetype')}`,
    );
  }
  return parts.join('\n');
}

/** 清空缓存（测试用）。 */
export function clearPrintFontCache() {
  cache.sans = null;
  cache.serif = null;
}
