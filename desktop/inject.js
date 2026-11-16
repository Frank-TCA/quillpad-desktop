/**
 * QuillPad 桌面壳 · 页面注入脚本
 *
 * 目的：把应用自带的 38px 标题栏变成真正的窗口标题栏，避免出现
 * 「系统标题栏 + 应用标题栏」两层叠加。注入内容只做三件事：
 *   1. 在标题栏尾部追加最小化 / 最大化 / 关闭三个按钮；
 *   2. 修正拖拽区域（可拖区域内的按钮必须显式 no-drag，否则点击被吞掉）；
 *   3. 双击空白处切换最大化。
 *
 * 本文件不经打包，由主进程读取后 executeJavaScript 注入，故只能用 ES5+ 语法。
 */

(function initDesktopChrome() {
  'use strict';

  const api = window.quillpadDesktop;
  const titlebar = document.getElementById('titlebar');
  if (!api || !titlebar) return;
  if (document.getElementById('qp-winctl')) return;

  /**
   * 当前界面语言。
   *
   * 注入脚本跑在页面上下文里，拿不到主进程的 CJS i18n，也不该 require 渲染层
   * ESM；渲染层 `setLocale()` 会写 `<html lang>`，这就是这里唯一的真源。
   * 用 lang 而不是缓存布尔值：切换语言后按钮 tooltip 也要跟着变。
   * @return {boolean} 是否是英文界面
   */
  function isEnglish() {
    const root = document.documentElement;
    return /^en(?:-|_|$)/i.test(String((root && root.lang) || ''));
  }

  /**
   * 取当前语言的无障碍名称 / tooltip。中文原文逐字保留，作为 key。
   * @param {string} zh 中文文案
   * @param {string} en 英文文案
   * @return {string}
   */
  function label(zh, en) {
    return isEnglish() ? en : zh;
  }

  const ICON = {
    minimize:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
      '<path d="M0 5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
    maximize:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
      '<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
      '<path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close:
      '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">' +
      '<path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" fill="none"/></svg>',
  };

  const style = document.createElement('style');
  style.id = 'qp-winctl-style';
  style.textContent = [
    /* 第四列留给窗口按钮；标题区域自适应收窄 */
    '#titlebar{grid-template-columns:200px minmax(0,1fr) auto auto !important;padding-right:0 !important}',
    /* 可拖区域内的一切可点元素都必须排除，否则点击会被窗口拖拽吞掉 */
    '#titlebar button,#titlebar a,#titlebar input,#titlebar [role="button"]{-webkit-app-region:no-drag}',
    '#titlebar-actions{padding-right:8px}',
    '.winctl{display:flex;align-items:stretch;height:100%;-webkit-app-region:no-drag}',
    '.winctl__btn{width:46px;display:grid;place-items:center;padding:0;border:0;background:transparent;',
    'color:var(--text-dim);cursor:default;transition:background 90ms ease,color 90ms ease;',
    'outline-offset:-2px}',
    '.winctl__btn:hover{background:var(--hover);color:var(--text)}',
    '.winctl__btn:active{background:var(--border-strong)}',
    '.winctl__btn--close:hover{background:#e81123;color:#fff}',
    '.winctl__btn--close:active{background:#c50f1f;color:#fff}',
    '.winctl__btn svg{display:block}',
  ].join('');

  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'winctl';
  wrap.id = 'qp-winctl';

  /**
   * 创建一个窗口控制按钮。
   * @param {string} kind 按钮类型
   * @param {string} text 无障碍名称（已按当前语言取好）
   * @return {HTMLButtonElement}
   */
  function makeButton(kind, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'winctl__btn' + (kind === 'close' ? ' winctl__btn--close' : '');
    btn.dataset.kind = kind;
    btn.setAttribute('aria-label', text);
    btn.title = text;
    btn.innerHTML = ICON[kind] || '';
    return btn;
  }

  const btnMin = makeButton('minimize', label('最小化', 'Minimize'));
  const btnMax = makeButton('maximize', label('最大化', 'Maximize'));
  const btnClose = makeButton('close', label('关闭', 'Close'));
  wrap.append(btnMin, btnMax, btnClose);
  titlebar.appendChild(wrap);

  btnMin.addEventListener('click', () => api.minimize());
  btnClose.addEventListener('click', () => api.close());

  /** 当前是否最大化（语言重绘时要按它决定「最大化 / 向下还原」）。 */
  let maximizedNow = false;

  /**
   * 切换最大化，并同步按钮图标与无障碍名称。
   * @param {boolean} maximized
   * @return {boolean} 传入的最大化状态（便于回调透传）
   */
  function paintMax(maximized) {
    maximizedNow = Boolean(maximized);
    btnMax.innerHTML = maximizedNow ? ICON.restore : ICON.maximize;
    const text = maximizedNow ? label('向下还原', 'Restore Down') : label('最大化', 'Maximize');
    btnMax.setAttribute('aria-label', text);
    btnMax.title = text;
    return maximizedNow;
  }

  btnMax.addEventListener('click', () => api.toggleMaximize());
  api.onMaximizeChange(paintMax);

  // 语言由渲染层切换（只改 <html lang>），这里监听属性变化重画三个按钮的名称。
  // 不重建 DOM，避免丢掉已绑定的事件与窗口控制状态。
  let lastLang = String((document.documentElement && document.documentElement.lang) || '');
  function repaintLabels() {
    const lang = String((document.documentElement && document.documentElement.lang) || '');
    if (lang === lastLang) return;
    lastLang = lang;
    btnMin.setAttribute('aria-label', label('最小化', 'Minimize'));
    btnMin.title = label('最小化', 'Minimize');
    btnClose.setAttribute('aria-label', label('关闭', 'Close'));
    btnClose.title = label('关闭', 'Close');
    paintMax(maximizedNow);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(repaintLabels).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang'],
    });
  }

  // 双击标题栏空白区域切换最大化（原生窗口的惯例行为）
  titlebar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, a, input, .winctl, #titlebar-actions')) return;
    api.toggleMaximize();
  });

  // 首帧同步一次真实状态，避免以「已最大化」状态启动时图标不对
  if (api.isMaximized) {
    api.isMaximized().then(paintMax, () => {});
  }
})();
