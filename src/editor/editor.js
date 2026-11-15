/**
 * QuillPad · CodeMirror 编辑器管理器
 *
 * 设计要点：
 * - 全场只有一个 EditorView，每个标签持有一份独立的 EditorState。
 *   切换标签 = view.setState()，滚动位置与选区都被保留，开销极小。
 * - 主题、外观、语言、应用快捷键分别放在 Compartment 里，
 *   需要变更时对「所有」标签 state 做 reconfigure，保证切回去也是新样式。
 */

import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  keymap,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { EditorState, Compartment, EditorSelection, Prec } from '@codemirror/state';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  foldKeymap,
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import {
  search,
  openSearchPanel,
  closeSearchPanel,
  highlightSelectionMatches,
} from '@codemirror/search';
import { getEditorThemeExtension, getSyntaxExtension, buildAppearanceExtension } from './cm-themes.js';
import { loadLanguage, primeFenceLanguages } from './languages.js';
import { createSearchPanel } from '../ui/findbar.js';
import { textMarks } from './marks.js';

/** 大文件阈值：超过后关闭语法高亮。 */
const BIG_FILE = 2 * 1024 * 1024;

/**
 * WYSIWYG 阅读面容器扩展（QA D-2）。
 *
 * 只在 WYSIWYG 装饰层启用时，给 `.cm-content` 挂上 `qp-doc` 类；
 * `wysiwyg.css` 里的 `.cm-content.qp-doc` 规则随即把 `--qp-*` 排版
 * token（16px / 1.75 / 46em / 无衬线）套到编辑面，与分栏预览、
 * PDF 打印稿共用同一组变量（PRD §4.D2「三处一致」）。
 *
 * source / split 模式不挂该类，编辑区继续由 `appearanceCompartment`
 * 的 14px 等宽基线控制 —— 代码编辑器不是阅读面，且既有几何断言
 * （smoke.mjs:54 / edit-ops-check.mjs:19）依赖这条基线。
 *
 * 同时**强制开启自动换行**：所见即所得的基准是分屏预览，而预览会把长段落
 * 折成多行；编辑面若按源码方式横向溢出，同一条长句会一直顶到右边界被裁掉，
 * 段落高度、换行位置、整体节奏全都对不上。该扩展只在本模式生效，
 * source / split 仍尊重用户自己的「自动换行」开关。
 */
const WYSIWYG_DOC_EXTENSION = [
  EditorView.contentAttributes.of({ class: 'qp-doc' }),
  EditorView.lineWrapping,
];

export class EditorManager {
  /**
   * @param {HTMLElement} host 编辑器挂载点
   * @param {object} [opts]
   * @param {(tabId: string, content: string) => void} [opts.onChange]
   * @param {(info: object) => void} [opts.onCursor]
   * @param {(state: EditorState) => void} [opts.onUpdateAny]
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.onChange = opts.onChange || (() => {});
    this.onCursor = opts.onCursor || (() => {});

    /** @type {Map<string, EditorState>} */
    this.states = new Map();
    /** @type {Map<string, number>} 每个标签的滚动位置 */
    this.scrollTops = new Map();
    /** @type {Map<string, string>} 每个标签当前已装载的语言 */
    this.loadedLang = new Map();
    /** 围栏语言预热的防抖句柄（输入 ```rust 这类新语言后补一次解析）。 */
    this._fenceTimer = null;

    this.activeTabId = null;
    this._suspend = false;
    this._appearance = { fontSize: 14, indentSize: 2, useTabs: false, wordWrap: false };
    this._themeId = 'ivory';
    /** @type {import('@codemirror/view').KeyBinding[]} */
    this._appKeymap = [];

    this.themeCompartment = new Compartment();
    /** 语法着色：wysiwyg 用中性配色，源码/分屏用全量语法色（见 cm-themes.js）。 */
    this.syntaxCompartment = new Compartment();
    this.langCompartment = new Compartment();
    this.appearanceCompartment = new Compartment();
    this.keymapCompartment = new Compartment();
    /** v2：WYSIWYG 装饰层（source 模式装 `[]`）。 */
    this.wysiwygCompartment = new Compartment();
    /** @type {import('@codemirror/state').Extension} */
    this._wysiwyg = [];
    /** v2 · QA D-2：`.cm-content` 的阅读面排版容器（按视图模式切换）。 */
    this.docTypographyCompartment = new Compartment();
    /** v2：专注模式 / 打字机模式（`focus.js`）。 */
    this.aidsCompartment = new Compartment();
    /** @type {import('@codemirror/state').Extension} */
    this._aids = [];

    this.view = new EditorView({
      parent: host,
      state: this._buildEmptyState(),
    });
    this.view.contentDOM.setAttribute('aria-label', '编辑区');
  }

  /* -------------------------------------------------------------- 内部构建 */

  /**
   * 通用扩展（与具体文档无关）。
   * @return {import('@codemirror/state').Extension[]}
   */
  _baseExtensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, defaultKeymap: false }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 1 }),
      search({ top: true, createPanel: createSearchPanel }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      cmPlaceholder('以「Ctrl + N」新建文件，或把文件拖到这里打开'),
      Prec.high(keymap.of([indentWithTab])),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
      ]),
      this.themeCompartment.of(getEditorThemeExtension(this._themeId)),
      this.syntaxCompartment.of(this._syntaxExtension()),
      this.langCompartment.of([]),
      this.appearanceCompartment.of(this._appearanceExtensions(this._appearance)),
      this.keymapCompartment.of(this._appKeymapExtension()),
      this.wysiwygCompartment.of(this._wysiwyg),
      this.docTypographyCompartment.of(this._docTypographyExtension()),
      this.aidsCompartment.of(this._aids),
      textMarks(),
      EditorView.updateListener.of((u) => this._handleUpdate(u)),
      EditorView.theme({ '&': { height: '100%', outline: 'none' } }),
    ];
  }

  /**
   * 当前是否应把编辑面当作 `.qp-doc` 阅读容器（QA D-2）。
   *
   * 与 WYSIWYG 装饰层的启用状态严格同源：只在高亮装饰生效时排版成
   * 阅读面；source / split 一律返回空扩展。放在方法里而不是缓存，
   * 是为了让「wysiwyg 模式下再新建标签」的 `createState()` 也拿到
   * 正确值（否则新 state 会漏掉 `qp-doc` 类）。
   *
   * @return {import('@codemirror/state').Extension}
   */
  _docTypographyExtension() {
    return this.wysiwygActive ? WYSIWYG_DOC_EXTENSION : [];
  }

  /**
   * 当前模式该用的语法着色扩展。
   *
   * 所见即所得必须走 `doc` 模式：源码那套会给标题染蓝、给加粗和列表符号
   * 染紫、给链接加下划线，颜色挂在**内容 span 自身**上，会盖掉装饰层设在
   * 父级节点的样式，导致与分屏预览对不上（预览里标题是正文色、链接是主色
   * 边框而非下划线）。
   *
   * @return {import('@codemirror/state').Extension}
   */
  _syntaxExtension() {
    return getSyntaxExtension(this._themeId, this.wysiwygActive ? 'doc' : 'code');
  }

  /**
   * 生成外观扩展（字号 / 缩进 / 换行）。
   * @param {{fontSize: number, indentSize: number, useTabs: boolean, wordWrap: boolean}} opts
   * @return {import('@codemirror/state').Extension[]}
   */
  _appearanceExtensions(opts) {
    const unit = opts.useTabs ? '\t' : ' '.repeat(opts.indentSize);
    return [
      indentUnit.of(unit),
      EditorState.tabSize.of(opts.indentSize),
      ...buildAppearanceExtension(opts),
      opts.wordWrap ? EditorView.lineWrapping : [],
    ];
  }

  /**
   * 空状态（无标签时）。
   * @return {EditorState}
   */
  _buildEmptyState() {
    return EditorState.create({
      doc: '',
      extensions: [this._baseExtensions(), EditorState.readOnly.of(true)],
    });
  }

  /**
   * 为一个标签创建独立 state。
   * @param {object} tab
   * @return {EditorState}
   */
  createState(tab) {
    return EditorState.create({
      doc: tab.content,
      extensions: [this._baseExtensions()],
    });
  }

  /* --------------------------------------------------------------- 事件回调 */

  /**
   * 统一处理视图更新。
   * @param {import('@codemirror/view').ViewUpdate} u
   */
  _handleUpdate(u) {
    if (this._suspend) return;
    const id = this.activeTabId;
    if (!id) return;
    if (u.docChanged) {
      this.states.set(id, u.state);
      this.onChange(id, u.state.doc.toString());
      if (this.loadedLang.get(id) === 'markdown') this._primeFencesSoon(id, u.state);
    } else if (u.state !== this.states.get(id)) {
      this.states.set(id, u.state);
    }
    if (u.docChanged || u.selectionSet || u.focusChanged) {
      this.emitCursor(u.state);
    }
  }

  /**
   * 输入/粘贴后，若文档里出现了尚未加载的围栏语言，预热并重新解析一次。
   *
   * CodeMirror 在文档已经解析完之后不会因为异步语言就绪而自动重来，
   * 所以这里主动 reconfigure 语言 compartment（内容不变，只换 parser）。
   *
   * @param {string} id 标签 id
   * @param {EditorState} state 变化后的 state
   */
  _primeFencesSoon(id, state) {
    if (this._fenceTimer) clearTimeout(this._fenceTimer);
    this._fenceTimer = setTimeout(async () => {
      this._fenceTimer = null;
      if (!id || this.loadedLang.get(id) !== 'markdown') return;
      const pending = await primeFenceLanguages(state.doc.toString());
      if (!pending.length) return;
      if (this.loadedLang.get(id) !== 'markdown') return;
      const ext = await loadLanguage('markdown');
      this._reconfigureFor(id, this.langCompartment, ext);
    }, 400);
  }

  /**
   * 派发光标信息。
   * @param {EditorState} state
   */
  emitCursor(state) {
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const multi = state.selection.ranges.length;
    this.onCursor({
      line: line.number,
      column: sel.head - line.from + 1,
      selectionLength: sel.to - sel.from,
      selectionLines:
        sel.to > sel.from
          ? state.doc.lineAt(sel.to).number - line.number + 1
          : 0,
      lines: state.doc.lines,
      chars: state.doc.length,
      cursorCount: multi,
      hasSelection: sel.to > sel.from,
    });
  }

  /* ----------------------------------------------------------------- 标签切换 */

  /**
   * 记录当前滚动位置。
   */
  saveScroll() {
    if (this.activeTabId) {
      this.scrollTops.set(this.activeTabId, this.view.scrollDOM.scrollTop);
    }
  }

  /**
   * 恢复滚动位置。
   * @param {string} id
   */
  restoreScroll(id) {
    const top = this.scrollTops.get(id) || 0;
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = top;
    });
  }

  /**
   * 切换到某个标签。
   * @param {object|null} tab
   */
  switchTo(tab) {
    this.saveScroll();
    if (!tab) {
      this.activeTabId = null;
      this._suspend = true;
      this.view.setState(this._buildEmptyState());
      this._suspend = false;
      this.emitCursor(this.view.state);
      return;
    }
    this.activeTabId = tab.id;
    let st = this.states.get(tab.id);
    if (!st) {
      st = this.createState(tab);
      this.states.set(tab.id, st);
    }
    this._suspend = true;
    this.view.setState(st);
    this._suspend = false;
    this.restoreScroll(tab.id);
    this.ensureLanguage(tab);
    this.emitCursor(this.view.state);
  }

  /**
   * 丢弃某标签的 state。
   * @param {string} id
   */
  destroyState(id) {
    this.states.delete(id);
    this.scrollTops.delete(id);
    this.loadedLang.delete(id);
  }

  /**
   * 用新内容重置某标签的 state（例如重新加载文件）。
   * @param {object} tab
   */
  resetContent(tab) {
    const st = this.createState(tab);
    this.states.set(tab.id, st);
    if (tab.id === this.activeTabId) {
      this._suspend = true;
      this.view.setState(st);
      this._suspend = false;
      this.ensureLanguage(tab);
    }
    this.loadedLang.delete(tab.id);
  }

  /* ------------------------------------------------------------------ 语言 */

  /**
   * 确保当前标签已装载正确语言。
   * @param {object} tab
   */
  async ensureLanguage(tab) {
    if (!tab) return;
    const want = tab.content.length > BIG_FILE ? 'plaintext' : tab.language;
    if (this.loadedLang.get(tab.id) === want) return;
    this.loadedLang.set(tab.id, want);
    // Markdown 围栏里的语言要先就位：`codeLanguages` 是同步回调，只有拿到
    // 现成的 Language 实例才能在这一次解析里产出代码语法树。
    if (want === 'markdown') await primeFenceLanguages(tab.content);
    const ext = await loadLanguage(want);
    // 加载期间用户可能已经切走，仍然要写回对应 state
    if (this.loadedLang.get(tab.id) !== want) return;
    this._reconfigureFor(tab.id, this.langCompartment, ext);
  }

  /**
   * 手动切换语言。
   * @param {object} tab
   * @param {string} langId
   */
  async setLanguage(tab, langId) {
    this.loadedLang.delete(tab.id);
    tab.language = langId;
    this.loadedLang.set(tab.id, langId);
    if (langId === 'markdown') await primeFenceLanguages(tab.content);
    const ext = await loadLanguage(langId);
    this._reconfigureFor(tab.id, this.langCompartment, ext);
  }

  /**
   * 对指定标签（或全部标签）重新配置一个 compartment。
   * @param {string} tabId
   * @param {Compartment} compartment
   * @param {import('@codemirror/state').Extension} ext
   */
  _reconfigureFor(tabId, compartment, ext) {
    if (tabId === this.activeTabId) {
      this.view.dispatch({ effects: compartment.reconfigure(ext) });
      this.states.set(tabId, this.view.state);
      return;
    }
    const st = this.states.get(tabId);
    if (!st) return;
    this.states.set(tabId, st.update({ effects: compartment.reconfigure(ext) }).state);
  }

  /**
   * 对所有 state 应用 compartment 重配置。
   * @param {Compartment} compartment
   * @param {import('@codemirror/state').Extension} ext
   */
  _reconfigureAll(compartment, ext) {
    const active = this.activeTabId;
    for (const [id, st] of this.states) {
      if (id === active) continue;
      this.states.set(id, st.update({ effects: compartment.reconfigure(ext) }).state);
    }
    if (active) {
      this.view.dispatch({ effects: compartment.reconfigure(ext) });
      this.states.set(active, this.view.state);
    }
  }

  /**
   * 切换编辑区主题。
   * @param {string} themeId
   */
  setTheme(themeId) {
    this._themeId = themeId;
    this._reconfigureAll(this.themeCompartment, getEditorThemeExtension(themeId));
    this._reconfigureAll(this.syntaxCompartment, this._syntaxExtension());
  }

  /**
   * 更新外观（字号 / 自动换行 / 缩进）。
   * @param {{fontSize?: number, indentSize?: number, useTabs?: boolean, wordWrap?: boolean}} patch
   */
  setAppearance(patch) {
    this._appearance = { ...this._appearance, ...patch };
    this._reconfigureAll(
      this.appearanceCompartment,
      this._appearanceExtensions(this._appearance),
    );
  }

  /**
   * 装载 / 卸载 WYSIWYG 装饰层（v2）。
   *
   * 走 `Compartment.reconfigure` 而不是 `view.setState()`：撤销栈、选区、滚动全保留。
   * 切换后必须 `requestMeasure()`（行高变了）并按旧 scrollTop 复原（ARCH R6）。
   *
   * @param {import('@codemirror/state').Extension} ext
   */
  setWysiwyg(ext) {
    const next = ext || [];
    this._wysiwyg = next;
    const top = this.view.scrollDOM.scrollTop;
    this._reconfigureAll(this.wysiwygCompartment, next);
    // 语法着色随模式切换：wysiwyg 用中性配色，避免语法色盖掉装饰层样式。
    this._reconfigureAll(this.syntaxCompartment, this._syntaxExtension());
    // QA D-2：装饰层与阅读面排版容器同进同退，保证三态切换后
    // `.cm-content` 的计算样式与当前模式一致（撤销栈/选区/滚动仍保留）。
    this._reconfigureAll(this.docTypographyCompartment, this._docTypographyExtension());
    this.view.requestMeasure();
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = top;
    });
  }

  /**
   * 当前是否装载了 WYSIWYG 装饰层。
   * @return {boolean}
   */
  get wysiwygActive() {
    return Array.isArray(this._wysiwyg) ? this._wysiwyg.length > 0 : true;
  }

  /**
   * 装载 / 卸载专注模式与打字机模式（v2 T09）。
   *
   * @param {import('@codemirror/state').Extension} ext
   */
  setAids(ext) {
    const next = ext || [];
    this._aids = next;
    this._reconfigureAll(this.aidsCompartment, next);
  }

  /**
   * 按比例滚动（迷你地图点击 / PDF 目录跳转用）。
   * @param {number} ratio 0..1
   */
  scrollToRatio(ratio) {
    const scroller = this.view.scrollDOM;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const r = Math.min(1, Math.max(0, Number(ratio) || 0));
    scroller.scrollTop = max * r;
  }

  /**
   * 当前滚动比例（0..1）。
   * @return {number}
   */
  getScrollRatio() {
    const scroller = this.view.scrollDOM;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return max > 0 ? scroller.scrollTop / max : 0;
  }

  /**
   * 应用级快捷键扩展（从缓存的 bindings 生成）。
   * @return {import('@codemirror/state').Extension}
   */
  _appKeymapExtension() {
    if (!this._appKeymap.length) return [];
    return Prec.high(keymap.of(this._appKeymap));
  }

  /**
   * 装载应用级快捷键。
   * @param {import('@codemirror/view').KeyBinding[]} bindings
   */
  setAppKeymap(bindings) {
    this._appKeymap = bindings || [];
    this._reconfigureAll(this.keymapCompartment, this._appKeymapExtension());
  }

  /* -------------------------------------------------------------- 编辑辅助 */

  /** 聚焦编辑区。 */
  focus() {
    this.view.focus();
  }

  /**
   * 取当前文档文本。
   * @return {string}
   */
  getContent() {
    return this.view.state.doc.toString();
  }

  /**
   * 整篇替换（保留历史）。
   * @param {string} text
   */
  replaceAll(text) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: Math.min(this.view.state.selection.main.head, text.length) },
    });
  }

  /**
   * 在当前光标处插入文本。
   * @param {string} text
   */
  insertText(text) {
    this.view.dispatch(this.view.state.replaceSelection(text));
    this.view.focus();
  }

  /**
   * 跳转到指定行（1 基）。
   * @param {number} lineNo
   */
  gotoLine(lineNo) {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Math.floor(lineNo) || 1));
    const line = doc.line(n);
    this.view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      scrollIntoView: false,
    });
    this.view.focus();
  }

  /**
   * 跳转到字符偏移并居中。
   * @param {number} pos
   * @param {number} [len] 选中长度
   */
  gotoPos(pos, len = 0) {
    const max = this.view.state.doc.length;
    const from = Math.max(0, Math.min(max, pos));
    const to = Math.max(from, Math.min(max, from + len));
    this.view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    this.view.focus();
  }

  /**
   * 当前选中文本（无选区时返回空串）。
   * @return {string}
   */
  getSelectionText() {
    const s = this.view.state;
    const sel = s.selection.main;
    return s.sliceDoc(sel.from, sel.to);
  }

  /**
   * 打开 / 关闭 CodeMirror 搜索面板。
   * @param {boolean} [open]
   */
  toggleSearchPanel(open = true) {
    if (open) openSearchPanel(this.view);
    else closeSearchPanel(this.view);
  }

  /**
   * 当前 state。
   * @return {EditorState}
   */
  get state() {
    return this.view.state;
  }
}
