/**
 * QuillPad · 界面语言（i18n）
 *
 * 设计取舍 —— 「原文即键」的内联双语写法：`t('保存', 'Save')`。
 *
 * 没有采用 key + 字典表，理由有三个：
 *   1. 加文案时必须同时给两种语言，不存在「改了代码忘了补字典」的漏翻译；
 *   2. 读代码时能直接看到两种语言，review 不用在两份 JSON 之间跳；
 *   3. 中文原文就是 key，省掉给 1300 多条文案起名字的工作（也避免了
 *      「打开」既是动词又是名词这类同形不同义的 key 冲突）。
 *
 * 代价是每处多写一个字符串参数，但换来的是「不可能漏、不可能对不上」。
 *
 * ⚠️ 模块级常量陷阱：不要在模块顶层（import 期）就把 t() 的结果存进常量，
 * 那时语言可能还没设置，切换语言后也不会更新。正确做法是二选一：
 *   - 把常量改成函数（`function menuLayout() { return [...t('文件','File')] }`）；
 *   - 或在渲染点才求值（`label: t('文件', 'File')` 写在 render 函数里）。
 */

/** 简体中文（默认）。 */
export const LOCALE_ZH = 'zh-CN';

/** 英文。 */
export const LOCALE_EN = 'en';

/** 支持的界面语言，顺序即设置里的展示顺序。 */
export const LOCALES = Object.freeze([LOCALE_ZH, LOCALE_EN]);

/**
 * 语言在设置里的显示名。
 *
 * 一律用该语言自己的写法（简体中文 / English），不随当前界面语言变化 ——
 * 英文界面下看到「简体中文」才知道点哪个能切回来。
 */
export const LOCALE_LABELS = Object.freeze({
  [LOCALE_ZH]: '简体中文',
  [LOCALE_EN]: 'English',
});

/** 当前语言。默认中文：老用户升级后看到的界面与升级前完全一致。 */
let current = LOCALE_ZH;

/**
 * 把任意输入归一化为受支持的语言码（脏值一律回落中文）。
 * @param {unknown} value
 * @return {string}
 */
export function normalizeLocale(value) {
  return value === LOCALE_EN ? LOCALE_EN : LOCALE_ZH;
}

/**
 * 当前语言。
 * @return {string}
 */
export function getLocale() {
  return current;
}

/**
 * 设为英文？
 * @return {boolean}
 */
export function isEnglish() {
  return current === LOCALE_EN;
}

/**
 * 切换语言。
 *
 * 只改模块内状态与 `<html lang>`，**不负责重建界面** —— 重建由 app 层的
 * `applyLocale()` 统一编排（菜单、工具栏、状态栏、命令注册表都要重算一遍）。
 *
 * @param {unknown} value
 * @return {string} 归一化后的语言码
 */
export function setLocale(value) {
  current = normalizeLocale(value);
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = current;
  }
  return current;
}

/**
 * 取当前语言的文案。
 *
 * 英文缺失时回落中文，保证任何漏翻的地方也不会显示成空白。
 *
 * @param {string} zh 中文文案（同时充当 key）
 * @param {string} en 英文文案
 * @return {string}
 */
export function t(zh, en) {
  return current === LOCALE_EN && typeof en === 'string' && en ? en : zh;
}

/**
 * 从带本地化字段的对象里取值，例如插件目录条目的 `title` / `titleEn`。
 *
 * 约定：英文字段统一叫 `<字段>En`（`titleEn`、`descriptionEn`…），
 * 缺失或为空时回落原字段。
 *
 * @param {object|null|undefined} source
 * @param {string} key 中文字段名
 * @return {string}
 */
export function pickLocalized(source, key) {
  if (!source || typeof source !== 'object') return '';
  const en = source[`${key}En`];
  if (current === LOCALE_EN && typeof en === 'string' && en) return en;
  const zh = source[key];
  return typeof zh === 'string' ? zh : '';
}

/**
 * 数字 + 量词。中英文的量词位置不同，单独给一个助手避免各处拼错。
 *
 * @example tCount(3, '个文件', 'file', 'files') // 3 个文件 / 3 files
 * @param {number} n
 * @param {string} zhUnit 中文量词（含「个 / 条 / 项」等）
 * @param {string} enSingular
 * @param {string} enPlural
 * @return {string}
 */
export function tCount(n, zhUnit, enSingular, enPlural) {
  const num = Number(n) || 0;
  if (current !== LOCALE_EN) return `${num} ${zhUnit}`;
  return `${num} ${num === 1 ? enSingular : enPlural}`;
}
