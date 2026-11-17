/**
 * QuillPad · 对话框
 * 通用模态框 / 未保存确认 / 转到行 / 快捷键速查 / 关于
 */

import { icon, brandSvg } from './icons.js';
import { escapeHtml } from '../core/utils.js';
import { allCommands, commandShortcutLabels, IS_MAC } from '../core/commands.js';
import { APP_VERSION_LABEL } from '../core/version.js';
import { LANGUAGES, languageLabel } from '../editor/languages.js';
import { assocGroups, assocAllExts, ASSOC_PROGID } from '../core/associations.js';
import { assocStatus, assocApply, openDefaultApps, canManageAssociations } from '../core/desktop.js';
import { toast } from './toast.js';
import { t } from '../core/i18n.js';

/** 当前打开的模态框栈。 */
const stack = [];

/**
 * 取遮罩容器。
 * @return {HTMLElement}
 */
function getRoot() {
  let root = document.getElementById('overlay-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'overlay-root';
    document.body.appendChild(root);
  }
  return root;
}

/**
 * 关闭某个模态框。
 * @param {object} entry
 * @param {*} result
 */
function closeEntry(entry, result) {
  const idx = stack.indexOf(entry);
  if (idx >= 0) stack.splice(idx, 1);
  entry.backdrop.remove();
  entry.resolve(result);
}

/**
 * 打开一个模态框。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} [opts.bodyHtml] 正文 HTML
 * @param {string} [opts.glyph] 图标名
 * @param {'info'|'danger'|'warning'} [opts.glyphKind]
 * @param {boolean} [opts.wide] 是否使用宽版
 * @param {Array<{label: string, value: any, kind?: 'primary'|'danger'|'ghost', defaultAction?: boolean}>} [opts.actions]
 * @param {(bodyEl: HTMLElement, api: {resolve: Function, close: Function}) => void} [opts.onMount]
 * @return {Promise<any>}
 */
export function openModal(opts) {
  const {
    title = '',
    bodyHtml = '',
    glyph = 'info',
    glyphKind = 'info',
    wide = false,
    actions = [{ label: t('好', 'OK'), value: true, kind: 'primary', defaultAction: true }],
    onMount = null,
  } = opts;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const actionsHtml = actions
    .map(
      (a, i) =>
        `<button class="btn ${a.kind === 'primary' ? 'is-primary' : a.kind === 'danger' ? 'is-danger' : a.kind === 'ghost' ? 'is-ghost' : ''}" data-action-index="${i}">${escapeHtml(
          a.label,
        )}</button>`,
    )
    .join('');

  backdrop.innerHTML =
    `<div class="modal ${wide ? 'is-wide' : ''}" role="dialog" aria-modal="true">` +
    `<div class="modal__head">` +
    `<span class="modal__glyph is-${glyphKind}">${icon(glyph, 15)}</span>` +
    `<span class="modal__title">${escapeHtml(title)}</span>` +
    `</div>` +
    `<div class="modal__body">${bodyHtml}</div>` +
    `<div class="modal__foot">${actionsHtml}</div>` +
    `</div>`;

  getRoot().appendChild(backdrop);

  return new Promise((resolve) => {
    const entry = { backdrop, resolve };
    stack.push(entry);
    /** 打开时刻：用于挡住「双击触发按钮」时第二下落在遮罩上把刚开的框关掉。 */
    const openedAt = Date.now();

    const close = (value) => closeEntry(entry, value);

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target !== backdrop) return;
      // 双击 / 三击触发按钮时，第二下会直接压到刚出现的遮罩上；不挡住的话
      // 对话框会「开了又立刻关」，看起来像没反应。
      if (Date.now() - openedAt < 350) return;
      close(null);
    });

    backdrop.querySelectorAll('[data-action-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.actionIndex);
        close(actions[idx] ? actions[idx].value : null);
      });
    });

    if (onMount) {
      onMount(backdrop.querySelector('.modal__body'), { resolve: close, close });
    } else {
      // 默认聚焦第一个按钮
      const first = backdrop.querySelector('[data-action-index]');
      if (first) first.focus();
    }
  });
}

/**
 * Esc 关闭最上层模态框（由 app 的全局键盘统一调用）。
 * @return {boolean} 是否消费了事件
 */
export function dismissTopModal() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  closeEntry(top, null);
  return true;
}

/** 是否有模态框打开。 */
export function hasModal() {
  return stack.length > 0;
}

/**
 * 未保存确认框。
 * @param {string} fileName
 * @return {Promise<'save'|'discard'|'cancel'>}
 */
export function confirmClose(fileName) {
  return openModal({
    title: t('有未保存的更改', 'Unsaved Changes'),
    glyph: 'alert',
    glyphKind: 'warning',
    bodyHtml:
      `<p>${t('文件', 'The file')} <strong>${escapeHtml(fileName)}</strong> ${t(
        '有尚未保存的修改。',
        'has unsaved changes.',
      )}</p>` +
      `<p style="color:var(--text-faint);font-size:11.5px;margin-top:6px">` +
      `${t(
        '选择「保存」将写回原位置，选择「不保存」将丢弃本次修改。',
        'Choose "Save" to write the changes back, or "Don\'t Save" to discard them.',
      )}</p>`,
    actions: [
      { label: t('取消', 'Cancel'), value: 'cancel', kind: 'ghost' },
      { label: t('不保存', "Don't Save"), value: 'discard', kind: 'ghost' },
      { label: t('保存', 'Save'), value: 'save', kind: 'primary', defaultAction: true },
    ],
  }).then((v) => v || 'cancel');
}

/**
 * 通用确认框。
 * @param {{title: string, message: string, okLabel?: string, danger?: boolean}} opts
 * @return {Promise<boolean>}
 */
export function confirmAction(opts) {
  return openModal({
    title: opts.title || t('请确认', 'Please Confirm'),
    glyph: opts.danger ? 'alert' : 'info',
    glyphKind: opts.danger ? 'danger' : 'info',
    bodyHtml: `<p>${opts.message || ''}</p>`,
    actions: [
      { label: t('取消', 'Cancel'), value: false, kind: 'ghost' },
      {
        label: opts.okLabel || t('确定', 'OK'),
        value: true,
        kind: opts.danger ? 'danger' : 'primary',
        defaultAction: true,
      },
    ],
  }).then((v) => v === true);
}

/**
 * 单行输入框。
 * @param {{title: string, label?: string, value?: string, okLabel?: string, placeholder?: string}} opts
 * @return {Promise<string|null>}
 */
export function promptInput(opts) {
  return openModal({
    title: opts.title || t('输入', 'Input'),
    glyph: 'chevronRight',
    bodyHtml:
      `<label class="field-label">${escapeHtml(opts.label || '')}</label>` +
      `<input class="text-input" id="modal-input" value="${escapeHtml(opts.value || '')}" ` +
      `placeholder="${escapeHtml(opts.placeholder || '')}" />`,
    actions: [
      { label: t('取消', 'Cancel'), value: null, kind: 'ghost' },
      {
        label: opts.okLabel || t('确定', 'OK'),
        value: '__OK__',
        kind: 'primary',
        defaultAction: true,
      },
    ],
    onMount: (body, api) => {
      const input = body.querySelector('#modal-input');
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            api.resolve(input.value);
          }
        });
      }
      // 拦截「确定」按钮，回传输入值
      const modal = body.parentElement;
      const ok = modal.querySelector('.btn.is-primary');
      if (ok) {
        ok.addEventListener('click', (e) => {
          e.stopPropagation();
          api.resolve(input ? input.value : '');
        }, true);
      }
    },
  }).then((v) => (v === '__OK__' ? '' : v));
}

/** 新建文件对话框里「最常用」的两种类型排在最前面。 */
const TYPE_RANK = { plaintext: 0, markdown: 1 };

/**
 * 新建文件时可选的文件类型。
 *
 * 直接从语言表推导（取每种语言的第一个扩展名），这样「能选到的类型」和
 * 「有语法高亮的类型」永远是同一份清单，加语言不用回来改这里。
 *
 * 注意：`label` 是模块期快照（「纯文本」这类名字会跟随界面语言），因此只作兜底；
 * 真正渲染到下拉框时走 `languageLabel(id)`，在渲染点按当前语言求值。
 *
 * @type {Array<{id: string, ext: string, label: string}>}
 */
export const NEW_FILE_TYPES = LANGUAGES.filter((lang) => lang.exts && lang.exts[0])
  .map((lang) => ({ id: lang.id, ext: lang.exts[0], label: lang.label }))
  // Array#sort 是稳定排序：同档内保持语言表原有顺序（JS/TS/HTML… 的常见度顺序）
  .sort((a, b) => (TYPE_RANK[a.id] ?? 9) - (TYPE_RANK[b.id] ?? 9));

/** 类型清单里收录的扩展名集合，用于判断「用户输入的后缀算不算已知类型」。 */
const KNOWN_EXTS = new Set(NEW_FILE_TYPES.map((t) => t.ext));

/**
 * 取文件名末尾的扩展名（不含点，小写）。
 * @param {string} name
 * @return {string} 没有扩展名时返回空串
 */
function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const m = /\.([A-Za-z0-9_+-]+)$/.exec(base);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 新建文件对话框：可输入文件名，并选择文件类型（.txt / .md / .js …）。
 *
 * 两个输入互相跟随：
 *   - 换类型 → 名字的扩展名跟着改（「未命名」→「未命名.md」）；
 *   - 改名字 → 后缀是已知类型时，下拉框自动跳到该类型（输入 README.md 就是 Markdown）。
 * 用户没手动改过名字时，换类型会顺带换掉默认名（未命名.txt → 未命名.md）。
 *
 * @param {{suggestName?: (ext: string) => string, defaultExt?: string}} [opts]
 *   `suggestName`：按扩展名给出默认文件名（由 app 提供，以便与「未命名N」编号一致）
 * @return {Promise<{name: string} | null>} 取消时返回 null
 */
export function newFileDialog(opts = {}) {
  const suggestName =
    typeof opts.suggestName === 'function'
      ? opts.suggestName
      : (ext) => `${t('未命名', 'Untitled')}.${ext}`;
  const defaultExt = KNOWN_EXTS.has(opts.defaultExt) ? opts.defaultExt : NEW_FILE_TYPES[0].ext;

  // 标签在渲染点才求值：语言切换后重新打开对话框即得到新语言的类型名
  const optionsHtml = NEW_FILE_TYPES.map(
    (item) =>
      `<option value="${escapeHtml(item.ext)}"${item.ext === defaultExt ? ' selected' : ''}>` +
      `${escapeHtml(languageLabel(item.id) || item.label)}（.${escapeHtml(item.ext)}）</option>`,
  ).join('');

  return openModal({
    title: t('新建文件', 'New File'),
    glyph: 'newFile',
    bodyHtml:
      `<label class="field-label" for="newfile-name">${t('文件名', 'File Name')}</label>` +
      `<input class="text-input" id="newfile-name" spellcheck="false" autocomplete="off" ` +
      `value="${escapeHtml(suggestName(defaultExt))}" />` +
      `<label class="field-label" for="newfile-type">${t('文件类型', 'File Type')}</label>` +
      `<select class="text-input" id="newfile-type">${optionsHtml}</select>` +
      `<p class="field-hint">${t(
        '也可以直接输入带扩展名的文件名（如 README.md），类型会自动跟随。',
        'You can also type a file name with an extension (e.g. README.md) — the type follows automatically.',
      )}</p>`,
    actions: [
      { label: t('取消', 'Cancel'), value: null, kind: 'ghost' },
      { label: t('创建', 'Create'), value: '__OK__', kind: 'primary', defaultAction: true },
    ],
    onMount: (body, api) => {
      const nameEl = body.querySelector('#newfile-name');
      const typeEl = body.querySelector('#newfile-type');
      if (!nameEl || !typeEl) return;

      /** 用户是否手动改过文件名（改过就不再被下拉框覆盖）。 */
      let edited = false;

      /**
       * 把文件名换成指定扩展名：已知后缀直接替换，纯名字补一个，
       * 带未知后缀（v1.2、archive.tar）则原样保留，只在后面补。
       * @param {string} name
       * @param {string} ext
       * @return {string}
       */
      const withExt = (name, ext) => {
        const v = String(name || '').trim();
        if (!v) return suggestName(ext);
        const known = extOf(v);
        if (known && KNOWN_EXTS.has(known)) return v.slice(0, v.length - known.length) + ext;
        const base = v.split(/[\\/]/).pop() || v;
        return base.includes('.') ? v : `${v}.${ext}`;
      };

      typeEl.addEventListener('change', () => {
        const ext = typeEl.value;
        nameEl.value = edited
          ? withExt(nameEl.value, ext)
          : suggestName(ext);
        // 只有「改名」这一种情况需要把光标留在名字里；默认名整段选中方便直接覆盖
        if (edited) nameEl.focus();
        else selectBase();
      });

      /** 选中文件名中「不含扩展名」的部分，直接打字就能替换。 */
      function selectBase() {
        const v = nameEl.value;
        const known = extOf(v);
        const keep = known && KNOWN_EXTS.has(known) ? v.length - known.length : v.length;
        nameEl.focus();
        nameEl.setSelectionRange(0, keep);
      }

      nameEl.addEventListener('input', () => {
        edited = true;
        const known = extOf(nameEl.value);
        if (known && KNOWN_EXTS.has(known)) typeEl.value = known;
      });

      const submit = () => {
        let v = nameEl.value.trim();
        if (!v) {
          nameEl.focus();
          return;
        }
        if (!extOf(v) || !KNOWN_EXTS.has(extOf(v))) v = withExt(v, typeEl.value);
        // 只取文件名本身：粘贴了整条路径时不要把目录带进标签名
        v = v.split(/[\\/]/).pop() || v;
        api.resolve({ name: v });
      };

      [nameEl, typeEl].forEach((el) => {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });
      });

      // 拦截「创建」按钮，把输入值交回去（默认动作只会回传 '__OK__'）
      const ok = body.parentElement.querySelector('.btn.is-primary');
      if (ok) {
        ok.addEventListener(
          'click',
          (e) => {
            e.stopPropagation();
            submit();
          },
          true,
        );
      }

      selectBase();
    },
  }).then((v) => (v && v.name ? v : null));
}

/**
 * 转到行对话框。
 * @param {{totalLines: number, current: number}} info
 * @return {Promise<number|null>}
 */
export function gotoLineDialog(info) {
  return openModal({
    title: t('转到行', 'Go to Line'),
    glyph: 'chevronRight',
    bodyHtml:
      `<label class="field-label">${t('行号', 'Line number')}（1 - ${info.totalLines}）</label>` +
      `<input class="text-input" id="modal-input" type="number" min="1" max="${info.totalLines}" ` +
      `value="${info.current}" />`,
    actions: [
      { label: t('取消', 'Cancel'), value: null, kind: 'ghost' },
      { label: t('跳转', 'Go'), value: '__OK__', kind: 'primary', defaultAction: true },
    ],
    onMount: (body, api) => {
      const input = body.querySelector('#modal-input');
      const ok = body.parentElement.querySelector('.btn.is-primary');
      const submit = () => {
        const n = Number(input && input.value);
        api.resolve(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
      };
      if (input) {
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });
      }
      if (ok) {
        ok.addEventListener('click', (e) => {
          e.stopPropagation();
          submit();
        }, true);
      }
    },
  });
}

/**
 * 快捷键速查表分组定义。
 *
 * 必须是函数：分组名走 `t()`，写成模块级常量会在 import 期被冻结成当时的语言。
 * @return {{name: string, ids: string[]}[]}
 */
function shortcutGroups() {
  return [
    {
      name: t('文件', 'File'),
      ids: [
        'file.new', 'file.open', 'file.openFolder', 'file.save', 'file.saveAs',
        'file.saveAll', 'file.close', 'file.reload',
      ],
    },
    {
      name: t('编辑', 'Edit'),
      ids: [
        'edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll',
        'edit.duplicateLine', 'edit.deleteLine', 'edit.moveLineUp', 'edit.moveLineDown',
        'edit.toggleComment', 'edit.multiCursorUp', 'edit.multiCursorDown',
      ],
    },
    {
      name: t('搜索', 'Search'),
      ids: ['search.find', 'search.replace', 'search.findNext', 'search.findPrev', 'search.gotoLine', 'search.findInFiles'],
    },
    {
      name: t('视图', 'View'),
      ids: ['view.commandPalette', 'view.toggleSidebar', 'view.wordWrap', 'view.zen', 'view.fontIncrease', 'view.fontDecrease', 'view.fontReset', 'view.preview', 'help.shortcuts'],
    },
  ];
}

/**
 * 已安装插件贡献的快捷键，按插件包分组。
 *
 * 插件命令是运行时才注册的，静态的分组表写不下它们的 id，
 * 只能按 `plugin.` 前缀现取；没声明快捷键的插件不会出现在这里。
 *
 * @return {{name: string, ids: string[]}[]}
 */
function pluginShortcutGroups() {
  /** @type {Map<string, string[]>} 包名 → 命令 id */
  const byPack = new Map();
  for (const cmd of allCommands()) {
    if (!cmd.id.startsWith('plugin.')) continue;
    if (!cmd.keys || !cmd.keys.length) continue;
    // 标题形如「文本处理包：转为大写」/「Text Tools: To Uppercase」，冒号前是包名。
    // 中文全角与英文半角都要认：英文界面下包名分隔可能换成半角冒号 + 空格。
    const title = String(cmd.title);
    const sepZh = title.indexOf('：');
    const sepEn = title.indexOf(': ');
    const sep = sepZh >= 0 && sepEn >= 0 ? Math.min(sepZh, sepEn) : Math.max(sepZh, sepEn);
    const pack = sep > 0 ? title.slice(0, sep).trim() : t('插件', 'Plugin');
    if (!byPack.has(pack)) byPack.set(pack, []);
    byPack.get(pack).push(cmd.id);
  }
  return [...byPack.entries()].map(([pack, ids]) => ({
    name: t(`插件 · ${pack}`, `Plugin · ${pack}`),
    ids,
  }));
}

/**
 * 快捷键速查。
 */
export function shortcutsDialog() {
  const groupsHtml = [...shortcutGroups(), ...pluginShortcutGroups()].map((group) => {
    const rows = group.ids
      .map((id) => allCommands().find((c) => c.id === id))
      .filter(Boolean)
      .filter((cmd) => cmd.keys.length || cmd.chord)
      .map((cmd) => {
        const keys = commandShortcutLabels(cmd);
        const keysHtml = keys
          .map((chord) => `<span class="shortcut-row__keys">${chord.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>`)
          .join('<span style="color:var(--text-faint);font-size:10px">›</span>');
        return (
          `<div class="shortcut-row"><span>${escapeHtml(cmd.title)}</span>` +
          `<span class="shortcut-row__keys" style="display:flex;gap:4px;align-items:center">${keysHtml}</span></div>`
        );
      })
      .join('');
    if (!rows) return '';
    return (
      `<div style="margin-bottom:14px">` +
      `<div class="welcome-block__title">${escapeHtml(group.name)}</div>` +
      `<div class="shortcut-grid">${rows}</div></div>`
    );
  }).join('');

  return openModal({
    title: t('快捷键速查', 'Keyboard Shortcuts'),
    glyph: 'help',
    wide: true,
    bodyHtml:
      `${groupsHtml}` +
      `<p style="color:var(--text-faint);font-size:11px;margin:14px 0 4px">` +
      `${t('提示：', 'Tip: ')}${IS_MAC ? t('⌘ 对应 Command', '⌘ is Command') : t('Ctrl 对应 Control', 'Ctrl is Control')}${t(
        '，所有快捷键在命令面板（Ctrl+Shift+P）里也能找到；插件命令的键位由各插件包的 plugin.json 声明，装或卸插件后这张表会跟着变。',
        '. Every shortcut is also listed in the Command Palette (Ctrl+Shift+P). Plugin shortcuts are declared in each package\'s plugin.json, so this table changes when you install or remove a plugin.',
      )}</p>`,
    actions: [{ label: t('知道了', 'Got it'), value: true, kind: 'primary', defaultAction: true }],
  });
}

/**
 * 关于对话框。
 */
export function aboutDialog() {
  return openModal({
    title: t('关于 QuillPad', 'About QuillPad'),
    glyph: 'feather',
    bodyHtml:
      `<div class="about-body">` +
      `<div class="about-logo">${brandSvg(28)}</div>` +
      `<div class="about-name">QuillPad</div>` +
      `<div class="about-ver">${t('版本', 'Version')} ${APP_VERSION_LABEL} · ${t(
        '构建于',
        'Built with',
      )} Vite + CodeMirror 6</div>` +
      `<p class="about-desc">${t(
        '一个现代、克制、键盘优先的文本与代码编辑器。',
        'A modern, restrained, keyboard-first text and code editor.',
      )}<br/>` +
      `${t(
        '所有数据都留在你自己的机器上，没有账号，没有云端。',
        'All your data stays on your own machine — no accounts, no cloud.',
      )}</p>` +
      `<div class="about-meta">` +
      `<span class="about-chip">File System Access</span>` +
      `<span class="about-chip">CodeMirror 6</span>` +
      `<span class="about-chip">${t('40+ 语言', '40+ languages')}</span>` +
      `<span class="about-chip">${t('4 套主题', '4 themes')}</span>` +
      `<span class="about-chip">${t('零 CDN', 'Zero CDN')}</span>` +
      `</div>` +
      `<div class="about-licenses" data-role="licenses">` +
      `<div class="about-licenses__title">${t('开源许可', 'Open Source Licenses')}</div>` +
      `<p class="about-licenses__text">${t(
        'QuillPad 本身为自有软件；随包分发的第三方组件使用 MIT / ISC / BSD / Apache-2.0 / SIL OFL 1.1 等宽松许可，完整清单与许可全文见安装目录下 ',
        'QuillPad itself is proprietary software. Bundled third-party components are distributed under permissive licenses such as MIT / ISC / BSD / Apache-2.0 / SIL OFL 1.1. The full list and license texts are in ',
      )}<code>resources/licenses/</code> ${t('中的', 'as')} ` +
      `<code>THIRD-PARTY-NOTICES.txt</code> ${t('与', 'and')} <code>OFL.txt</code>${t(
        '（随安装包分发）。',
        ' (shipped with the installer).',
      )}</p>` +
      `<p class="about-licenses__text">${t(
        '内置中文字体为 Noto Sans SC 子集（SIL OFL 1.1，由 ',
        'The bundled CJK font is a subset of Noto Sans SC (SIL OFL 1.1, generated by ',
      )}<code>scripts/font-subset.py</code> ${t(
        '生成，可自由随应用再分发）。',
        'and freely redistributable with the app).',
      )}</p>` +
      `</div>` +
      `</div>`,
    actions: [{ label: t('关闭', 'Close'), value: true, kind: 'primary', defaultAction: true }],
  });
}

/**
 * 文件关联对话框。
 *
 * 勾选框 = 「这一组默认用 QuillPad 打开」。打开时按注册表的真实状态回填
 * （全是我们就是勾上、部分是我们就是半选），点「应用」只对**发生变化的组**
 * 下发一次写操作 —— 全部都没变时不会白跑一遍注册表写入。
 *
 * 写注册表在主进程（`qp:assoc-apply`），这里只管界面与状态回读。
 * 浏览器模式下不可用，命令本身会被置灰。
 *
 * @return {Promise<{changed: number}|null>} 取消返回 null
 */
export function associationsDialog() {
  if (!canManageAssociations()) {
    return openModal({
      title: t('文件关联', 'File Associations'),
      glyph: 'info',
      bodyHtml:
        `<p class="field-hint">${t(
          '只有桌面版（Windows 安装版 / 便携版）能修改文件关联，浏览器里没有这个能力。',
          'File associations can only be changed in the desktop build (installed or portable); a browser cannot.',
        )}</p>`,
    }).then(() => null);
  }

  const groups = assocGroups();
  const exts = assocAllExts();

  /**
   * 组内的扩展名摘要：前 4 个原样列出，剩下的折成「+N」。
   * 从清单动态生成，增删扩展名时不会和界面文案脱节。
   * @param {string[]} list
   * @return {string}
   */
  const summarize = (list) =>
    list.length <= 4 ? list.join(' ') : `${list.slice(0, 4).join(' ')} +${list.length - 4}`;

  const rows = groups
    .map(
      (g) =>
        `<label class="qp-assoc__row">` +
        `<input type="checkbox" data-group="${escapeHtml(g.id)}" />` +
        `<span class="qp-assoc__name">${escapeHtml(g.label)}</span>` +
        `<span class="qp-assoc__exts">${escapeHtml(summarize(g.exts))}</span>` +
        `<span class="qp-assoc__state" data-state="${escapeHtml(g.id)}">${t('读取中…', 'Checking…')}</span>` +
        `</label>`,
    )
    .join('');

  return openModal({
    title: t('文件关联', 'File Associations'),
    glyph: 'info',
    wide: true,
    bodyHtml:
      `<p class="qp-assoc__intro">${t(
        '勾选的类型双击时用 QuillPad 打开。取消勾选会把指向 QuillPad 的默认关联撤下（系统回到它原来的默认程序）。',
        'Checked types open in QuillPad on double-click. Unchecking removes the association pointing at QuillPad and lets Windows fall back to its previous default.',
      )}</p>` +
      rows +
      `<p class="qp-assoc__note" data-note>${t(
        '状态来自注册表：显示「全部为默认」的组不用再应用一次。',
        'Status is read from the registry — groups already fully associated need no change.',
      )}</p>` +
      `<button class="btn is-ghost qp-assoc__sysbtn" data-open-default-apps type="button">${t(
        '打开 Windows 默认应用设置…',
        'Open Windows Default Apps…',
      )}</button>`,
    actions: [
      { label: t('取消', 'Cancel'), value: null, kind: 'ghost' },
      { label: t('应用', 'Apply'), value: '__APPLY__', kind: 'primary', defaultAction: true },
    ],
    onMount: (body, api) => {
      const note = body.querySelector('[data-note]');
      /** @type {Map<string, {def: string, userChoice: string}>} 扩展名 -> 当前指向 */
      let current = new Map();

      /** 该组里有多少扩展名当前指向我们。 */
      const oursCount = (g) =>
        g.exts.filter((e) => {
          const item = current.get(e);
          if (!item) return false;
          return (item.userChoice || item.def) === ASSOC_PROGID;
        }).length;

      const fillChecked = () => {
        for (const g of groups) {
          const box = body.querySelector(`[data-group="${g.id}"]`);
          const cell = body.querySelector(`[data-state="${g.id}"]`);
          const n = oursCount(g);
          if (cell) {
            cell.textContent =
              n === 0
                ? t('未设为默认', 'Not default')
                : n === g.exts.length
                  ? t('全部为默认', 'All default')
                  : t(`${n}/${g.exts.length} 为默认`, `${n}/${g.exts.length} default`);
            cell.dataset.state = n === 0 ? 'none' : n === g.exts.length ? 'all' : 'some';
          }
          if (box) {
            box.checked = n === g.exts.length;
            box.indeterminate = n > 0 && n < g.exts.length;
          }
        }
      };

      const refresh = async () => {
        const res = await assocStatus(exts);
        if (!res.ok) {
          if (note) note.textContent = res.error || t('读取文件关联失败', 'Could not read file associations');
          return false;
        }
        current = new Map((res.items || []).map((i) => [i.ext, i]));
        fillChecked();
        return true;
      };

      const applyBtn = body.parentElement.querySelector('.btn.is-primary');
      const apply = async () => {
        if (applyBtn) applyBtn.disabled = true;
        if (note) note.textContent = t('正在写入…', 'Applying…');
        let changed = 0;
        const errs = [];
        try {
          for (const g of groups) {
            const box = body.querySelector(`[data-group="${g.id}"]`);
            const wantOn = !!(box && box.checked);
            const n = oursCount(g);
            // 已经是目标状态就跳过：没变化的组不值得再跑一次写入
            if (wantOn ? n === g.exts.length : n === 0) continue;
            const res = await assocApply(g.exts, wantOn);
            if (!res.ok) errs.push(`${g.label}：${res.error || res.code || 'error'}`);
            else changed += res.count || g.exts.length;
          }
        } finally {
          if (applyBtn) applyBtn.disabled = false;
        }
        if (errs.length) {
          if (note) {
            note.textContent = errs.join('；');
            note.classList.add('is-error');
          }
          await refresh();
          return;
        }
        if (changed) toast(t(`已更新 ${changed} 个文件关联`, `Updated ${changed} file associations`), 'success');
        api.resolve({ changed });
      };

      // 「应用」自己接管：要先落盘再关框（默认动作只会把 '__APPLY__' 回传）
      if (applyBtn) {
        applyBtn.addEventListener(
          'click',
          (e) => {
            e.preventDefault();
            e.stopPropagation();
            void apply();
          },
          true,
        );
      }

      const sysBtn = body.querySelector('[data-open-default-apps]');
      if (sysBtn) {
        sysBtn.addEventListener('click', async () => {
          const res = await openDefaultApps();
          if (!res.ok && note) {
            note.textContent = res.error || t('打不开系统设置', 'Could not open Windows settings');
            note.classList.add('is-error');
          }
        });
      }

      void refresh();
    },
  });
}
