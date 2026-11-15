/**
 * QuillPad · 全局 Tooltip
 *
 * 所有带 data-tip 属性的元素都会获得统一风格的提示气泡。
 * 用 fixed 定位渲染在 body 上，避免被 sidebar / statusbar 的 overflow 裁掉。
 */

/**
 * 初始化全局 tooltip。
 * @return {{hide: () => void}}
 */
export function initTooltips() {
  const tip = document.createElement('div');
  tip.className = 'qp-tooltip';
  document.body.appendChild(tip);

  let timer = 0;
  /** @type {HTMLElement|null} */
  let current = null;

  /** 隐藏气泡。 */
  function hide() {
    window.clearTimeout(timer);
    timer = 0;
    current = null;
    tip.classList.remove('is-visible');
  }

  /**
   * 显示某个元素的提示。
   * @param {HTMLElement} target
   */
  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('is-visible');

    const rect = target.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const margin = 8;

    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(margin, Math.min(window.innerWidth - box.width - margin, left));

    let top = rect.bottom + 7;
    if (top + box.height > window.innerHeight - margin) {
      top = rect.top - box.height - 7;
    }
    if (top < margin) top = rect.bottom + 7;

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const target = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!target) {
        if (current) hide();
        return;
      }
      if (target === current) return;
      hide();
      current = target;
      timer = window.setTimeout(() => show(target), 300);
    },
    true,
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      if (!current) return;
      if (e.relatedTarget && current.contains(e.relatedTarget)) return;
      hide();
    },
    true,
  );

  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);

  return { hide };
}
