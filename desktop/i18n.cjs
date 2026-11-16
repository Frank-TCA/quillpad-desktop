'use strict';

/**
 * QuillPad 桌面壳 · 界面语言（主进程 / 插件文件系统共用的 CJS 版）
 *
 * 为什么与 `src/core/i18n.js` 是两份实现而不是共享一份：
 *  - 渲染层是 ESM，主进程是 CJS，`require()` 不了 ESM 模块（也不该 require：
 *    打包后 `src/` 不在 asar 里，主进程只认 `desktop/`）；
 *  - 但两侧的**行为**必须完全一致（同样的归一化规则、同样的回落方向），
 *    否则会出现「界面是英文、原生对话框还是中文」这种割裂。
 *
 * 设计取舍与渲染层保持一致 —— 「原文即键」的内联双语写法 `t('打开', 'Open')`：
 * 中文原文既是 key 也是默认文案，漏写英文时自动回落中文，不会出现空白。
 *
 * 持久化：`<userData>/locale.json`，内容 `{ "locale": "en" }`。
 * 只认 `en` / `zh-CN` 两个值，其它一律回落 `zh-CN`（老用户升级后看到的
 * 界面与升级前完全一致）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 简体中文（默认）。 */
const LOCALE_ZH = 'zh-CN';

/** 英文。 */
const LOCALE_EN = 'en';

/** 当前语言。 */
let current = LOCALE_ZH;

/**
 * 把任意输入归一化为受支持的语言码（脏值一律回落中文）。
 *
 * 与渲染层 `src/core/i18n.js` 的 `normalizeLocale()` **逐字对齐**：只认精确的
 * `'en'`，其余一律中文。多接受 en-US 之类的变体看似友好，却会让「主进程英文、
 * 渲染层中文」这种割裂界面有机可乘，所以这里刻意不做宽松匹配。
 *
 * 为兼容直接把整份 `locale.json` 传进来的调用，额外接受 `{locale:'en'}`。
 *
 * @param {unknown} value
 * @return {string}
 */
function normalizeLocale(value) {
  let raw = value;
  if (raw && typeof raw === 'object') raw = raw.locale;
  return raw === LOCALE_EN ? LOCALE_EN : LOCALE_ZH;
}

/**
 * 语言文件的绝对路径。
 * @param {string} userDataDir 用户数据目录
 * @return {string}
 */
function localeFilePath(userDataDir) {
  return path.join(String(userDataDir || ''), 'locale.json');
}

/**
 * 从 userData 读语言设置。文件缺失 / 损坏 / 值非法时回落中文且不抛错。
 *
 * @param {string} userDataDir 用户数据目录（`app.getPath('userData')`）
 * @return {string} 生效的语言码
 */
function loadLocale(userDataDir) {
  let parsed = null;
  try {
    const raw = fs.readFileSync(localeFilePath(userDataDir), 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  current = normalizeLocale(parsed);
  return current;
}

/**
 * 写语言设置并立即生效。写盘失败只影响「下次启动是否记得」，不影响本次切换。
 *
 * @param {string} userDataDir 用户数据目录
 * @param {unknown} value 目标语言（脏值回落中文）
 * @return {string} 归一化后的语言码
 */
function setLocale(userDataDir, value) {
  current = normalizeLocale(value);
  try {
    const dir = String(userDataDir || '');
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localeFilePath(dir), `${JSON.stringify({ locale: current }, null, 2)}\n`, 'utf8');
    }
  } catch {
    // 目录只读等情况：静默忽略，本次会话仍然生效
  }
  return current;
}

/**
 * 当前语言。
 * @return {string}
 */
function getLocale() {
  return current;
}

/**
 * 当前是否是英文界面。
 * @return {boolean}
 */
function isEn() {
  return current === LOCALE_EN;
}

/**
 * 取当前语言的文案。英文缺失时回落中文，保证任何漏翻的地方也不会显示成空白。
 *
 * @param {string} zh 中文文案（同时充当 key）
 * @param {string} en 英文文案
 * @return {string}
 */
function t(zh, en) {
  return current === LOCALE_EN && typeof en === 'string' && en ? en : zh;
}

module.exports = {
  LOCALE_ZH,
  LOCALE_EN,
  normalizeLocale,
  loadLocale,
  setLocale,
  getLocale,
  isEn,
  t,
};
