/**
 * QuillPad · 全局键盘处理
 *
 * 统一把 keydown 事件映射到命令注册表，保证焦点在编辑区内外快捷键都生效。
 * 同时支持两段式快捷键（例如 Ctrl+K 然后 O）。
 */

import { allCommands, IS_MAC } from './commands.js';

/** 两段式快捷键的等待时间（毫秒）。 */
const CHORD_TIMEOUT = 1600;

/** 键名别名：同一个物理键的多种写法。 */
const KEY_ALIASES = {
  '=': ['=', '+'],
  '-': ['-', '_'],
  '/': ['/', '?'],
  ' ': ['space'],
  // QA D-3：Ctrl/Alt + Shift + 数字键在 US 布局下 e.key 是上位符号
  // （Ctrl+Shift+1 → '!'），而快捷键按物理数字键声明为 '1'。
  // 两个形态都列为别名，全局 keydown 处理器与 CodeMirror keymap 才能
  // 在任意布局下命中；shiftKey 的严格比较仍在 matchChord 里保留，
  // 因此不会把 `Mod-0` 误当成 `Mod-Shift-0`。
  '1': ['1', '!'],
  '2': ['2', '@'],
  '3': ['3', '#'],
  '4': ['4', '$'],
  '5': ['5', '%'],
  '6': ['6', '^'],
  '7': ['7', '&'],
  '8': ['8', '*'],
  '9': ['9', '('],
  '0': ['0', ')'],
};

/**
 * 归一化事件里的按键名。
 * @param {KeyboardEvent} e
 * @return {string}
 */
export function normalizeEventKey(e) {
  const k = e.key;
  if (k === ' ') return 'space';
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

/**
 * 拆解 CodeMirror 风格的组合键描述。
 * @param {string} chord 例如 "Mod-Shift-p"
 * @return {{ctrl: boolean, shift: boolean, alt: boolean, meta: boolean, key: string}}
 */
export function parseChord(chord) {
  const raw = String(chord);
  let parts = raw.split('-');
  let key;
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    // "Mod--" 表示减号键
    key = '-';
    parts = parts.slice(0, -2);
  } else {
    key = (parts.pop() || '').toLowerCase();
  }
  const res = { ctrl: false, shift: false, alt: false, meta: false, key };
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'mod' || p === 'cmd') {
      if (IS_MAC) res.meta = true;
      else res.ctrl = true;
    } else if (p === 'ctrl' || p === 'control') {
      res.ctrl = true;
    } else if (p === 'shift') {
      res.shift = true;
    } else if (p === 'alt' || p === 'option') {
      res.alt = true;
    } else if (p === 'meta' || p === 'win' || p === 'super') {
      res.meta = true;
    }
  }
  return res;
}

/**
 * 判断键盘事件是否匹配某个组合键。
 * @param {KeyboardEvent} e
 * @param {string} chord
 * @return {boolean}
 */
export function matchChord(e, chord) {
  const want = parseChord(chord);
  if (!!e.ctrlKey !== want.ctrl) return false;
  if (!!e.altKey !== want.alt) return false;
  if (!!e.metaKey !== want.meta) return false;
  // Shift：对于字母键我们不强校验，因为 e.key 已经是大写形态
  const eventKey = normalizeEventKey(e);
  const aliases = KEY_ALIASES[want.key] || [want.key];
  if (!aliases.includes(eventKey)) return false;
  if (e.shiftKey !== want.shift) {
    // 允许 Mod-= 匹配 Shift 产生的 '+'，其余情况严格比较
    if (!(want.key === '=' && !want.shift && e.shiftKey)) return false;
  }
  return true;
}

/**
 * 安装全局键盘处理器。
 * @param {{run: (id: string, evt: KeyboardEvent) => boolean, isSuppressed: () => boolean}} opts
 *   run 返回 true 表示已消费；isSuppressed 返回 true 时不做任何处理。
 * @return {() => void} 卸载函数
 */
export function installKeyHandler(opts) {
  /** @type {{prefix: string, at: number}|null} */
  let pending = null;
  let timer = 0;

  /** 清空两段式前缀。 */
  const clearPending = () => {
    pending = null;
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };

  /**
   * @param {KeyboardEvent} e
   */
  const onKeyDown = (e) => {
    if (e.isComposing) return;
    if (opts.isSuppressed && opts.isSuppressed()) return;

    const target = e.target;
    const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
    const inEditor = !!(target && target.closest && target.closest('.cm-editor'));
    // 编辑器内部由 CodeMirror 自己处理输入；这里只对「真正的表单控件」做让行判断
    const isTextField =
      !inEditor &&
      (tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (target && target.isContentEditable === true));

    const commands = allCommands();

    // 1) 两段式快捷键的第二段
    if (pending) {
      if (Date.now() - pending.at > CHORD_TIMEOUT) {
        clearPending();
      } else {
        const key = normalizeEventKey(e);
        const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
        if (!hasModifier) {
          const hit = commands.find((c) => {
            if (!c.chord) return false;
            if (isTextField && !c.global) return false;
            const [first, second] = c.chord.split(' ');
            return first === pending.prefix && second.toLowerCase() === key;
          });
          if (hit) {
            e.preventDefault();
            e.stopPropagation();
            clearPending();
            opts.run(hit.id, e);
            return;
          }
        }
        clearPending();
      }
    }

    // 2) 普通单步快捷键
    // Markdown 格式命令（md.*）优先：Ctrl+B 在 Markdown 文档里是「加粗」，
    // 在其它文档里回落到原本的「显示 / 隐藏侧边栏」。仅对 md.* 命令做
    // 「不可用就放行」，其余命令的消费行为保持原样，避免全局回归。
    const single = [
      ...commands.filter((c) => c.id.startsWith('md.')),
      ...commands.filter((c) => !c.id.startsWith('md.')),
    ];
    for (const cmd of single) {
      if (!cmd.keys || !cmd.keys.length) continue;
      // 表单控件里只放行标记为 global 的命令（如保存、打开、命令面板）
      if (isTextField && !cmd.global) continue;
      if (cmd.id.startsWith('md.') && cmd.enabled && !cmd.enabled()) continue;
      for (const chord of cmd.keys) {
        if (!matchChord(e, chord)) continue;
        e.preventDefault();
        e.stopPropagation();
        opts.run(cmd.id, e);
        return;
      }
    }

    // 3) 两段式快捷键的第一段
    for (const cmd of commands) {
      if (!cmd.chord) continue;
      const first = cmd.chord.split(' ')[0];
      if (!matchChord(e, first)) continue;
      e.preventDefault();
      e.stopPropagation();
      pending = { prefix: first, at: Date.now() };
      timer = window.setTimeout(clearPending, CHORD_TIMEOUT);
      return;
    }
  };

  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    clearPending();
  };
}

/**
 * 生成用于 CodeMirror keymap 的绑定数组。
 * @param {(id: string) => void} run 执行命令
 * @return {import('@codemirror/view').KeyBinding[]}
 */
export function buildCmKeymap(run) {
  /** @type {import('@codemirror/view').KeyBinding[]} */
  const bindings = [];
  const cmds = allCommands();
  // 与全局处理器同序：md.* 优先，且不可用时返回 false 让同键的后继绑定命中
  // （Ctrl+B 在纯文本里仍然是侧边栏开关）。
  const ordered = [
    ...cmds.filter((c) => c.id.startsWith('md.')),
    ...cmds.filter((c) => !c.id.startsWith('md.')),
  ];
  for (const cmd of ordered) {
    for (const chord of cmd.keys || []) {
      // CodeMirror 的键名不支持「减号」这种以 '-' 结尾的写法，
      // 这类组合由全局 keydown 处理器兜底，这里跳过。
      if (chord.endsWith('--')) continue;
      bindings.push({
        key: chord,
        run: () => {
          if (cmd.id.startsWith('md.') && cmd.enabled && !cmd.enabled()) return false;
          run(cmd.id);
          return true;
        },
        preventDefault: true,
      });
    }
  }
  return bindings;
}
