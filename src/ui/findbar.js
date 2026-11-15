/**
 * QuillPad · 查找 / 替换 & 在文件中查找
 *
 * 1) QuillSearchPanel：替换掉 CodeMirror 默认搜索面板的外观，
 *    但仍使用 CM 的 SearchQuery 完成命中高亮，交互与视觉与整体一致。
 * 2) FindInFilesPanel：底部抽屉，扫描「所有打开的标签」或「当前文件夹」。
 */

import { closeSearchPanel, openSearchPanel } from '@codemirror/search';
import { icon } from './icons.js';
import {
  escapeHtml,
  escapeRegExp,
  highlightHtml,
  buildRegExp,
  formatNumber,
  debounce,
} from '../core/utils.js';
import { collectMatches, pickMatchIndex, syncQuery, replaceAllInView, replaceNextInView, replaceAllInString, makeSearchQuery } from '../core/search.js';
import { readFileHandle } from '../core/fs.js';
import { state } from '../core/state.js';
import { runCommand } from '../core/commands.js';

/**
 * 面板按钮的 data-toggle 值 → 搜索选项键名的映射。
 *
 * 按钮沿用 CodeMirror 的短名（case / word），而搜索选项用的是 CM SearchQuery 的
 * 长名（caseSensitive / wholeWord）。两套命名如果直接用 dataset.toggle 当键，
 * 开关就会写进不存在的 opts.case / opts.word —— 按钮亮了但搜索条件始终不变。
 * @type {Record<string, string>}
 */
const TOGGLE_KEYS = {
  case: 'caseSensitive',
  word: 'wholeWord',
  regexp: 'regexp',
  wrap: 'wrap',
};

/**
 * 快捷键 Alt+C / Alt+W / Alt+R 对应的开关短名。
 * @type {Record<string, string>}
 */
const TOGGLE_SHORTCUTS = { c: 'case', w: 'word', r: 'regexp' };

/* ------------------------------------------------------------ 查找历史（v2） */

/** 查找历史的存储键（只存最近 20 条，纯本地，不上传）。 */
export const FIND_HISTORY_KEY = 'quillpad.findHistory.v1';

/** 历史条数上限。 */
export const FIND_HISTORY_LIMIT = 20;

/**
 * 读取查找历史。
 *
 * 永远返回数组：`localStorage` 里可能是坏 JSON、可能是被别的东西覆盖的字符串，
 * 这里任何异常都退化成空历史，绝不让查找面板打不开。
 *
 * @return {string[]} 从新到旧
 */
export function loadFindHistory() {
  try {
    const raw = window.localStorage.getItem(FIND_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, FIND_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * 记一条查找历史（去重后置顶）。
 * @param {string} text 查找词
 * @return {string[]} 写入后的完整历史
 */
export function pushFindHistory(text) {
  const value = String(text || '').trim();
  if (!value) return loadFindHistory();
  const list = loadFindHistory().filter((s) => s !== value);
  list.unshift(value);
  const next = list.slice(0, FIND_HISTORY_LIMIT);
  try {
    window.localStorage.setItem(FIND_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式 / 配额满：历史记不住不影响查找 */
  }
  return next;
}

/**
 * 清空查找历史。
 */
export function clearFindHistory() {
  try {
    window.localStorage.removeItem(FIND_HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 把按钮上的 data-toggle 解析成搜索选项键名。
 * @param {string} name 按钮的 data-toggle 值
 * @return {string} 搜索选项键名
 */
function toggleOptionKey(name) {
  return TOGGLE_KEYS[name] || name;
}

/* ==========================================================================
   1. 编辑器内查找 / 替换面板
   ========================================================================== */

class QuillSearchPanel {
  /**
   * @param {import('@codemirror/view').EditorView} view
   */
  constructor(view) {
    this.view = view;
    this.opts = {
      caseSensitive: false,
      regexp: false,
      wholeWord: false,
      wrap: true,
    };
    this.showReplace = false;
    /** 当前查询是否为非法正则（用于把「正则无效」与「无结果」区分开） */
    this.invalidRegexp = false;
    /** @type {Array<{from: number, to: number}>} */
    this.matches = [];
    this.activeMatch = 0;

    this.dom = document.createElement('div');
    this.dom.className = 'qp-search';
    this.dom.innerHTML = this.template();
    /** 查找历史是否展开（`[data-role="history"]` 下拉） */
    this.historyOpen = false;
    /** 下拉里键盘高亮的条目下标 */
    this.historyIndex = -1;
    this.bind();
    this.restoreQuery();
  }

  /**
   * 面板 DOM 模板。
   * @return {string}
   */
  template() {
    return (
      `<div class="qp-search__row">` +
      `<div class="qp-search__field">` +
      icon('search', 14) +
      `<input class="qp-search__input" data-role="search" placeholder="查找" spellcheck="false" autocomplete="off" />` +
      `<button class="qp-toggle" data-toggle="case" title="区分大小写 (Alt+C)">Aa</button>` +
      `<button class="qp-toggle" data-toggle="word" title="全词匹配 (Alt+W)">W</button>` +
      `<button class="qp-toggle" data-toggle="regexp" title="正则表达式 (Alt+R)">.*</button>` +
      `<button class="qp-toggle is-on" data-toggle="wrap" title="循环查找">↻</button>` +
      `<button class="qp-toggle" data-act="history" title="查找历史（输入框为空时按 ↓ 回填最近一条）">H</button>` +
      `</div>` +
      `<span class="qp-search__count" data-role="count">0 / 0</span>` +
      `<button class="qp-icon-btn" data-act="prev" title="上一个 (Shift+Enter)">${icon('chevronUp', 14)}</button>` +
      `<button class="qp-icon-btn" data-act="next" title="下一个 (Enter)">${icon('chevronDown', 14)}</button>` +
      `<span class="qp-search__sep"></span>` +
      `<button class="qp-icon-btn" data-act="toggle-replace" title="显示替换">${icon('replace', 14)}</button>` +
      `<span class="qp-search__sep"></span>` +
      `<button class="qp-icon-btn" data-act="close" title="关闭 (Esc)">${icon('close', 14)}</button>` +
      `</div>` +
      `<div class="qp-search__history" data-role="history" hidden></div>` +
      `<div class="qp-search__row" data-row="replace" hidden>` +
      `<div class="qp-search__field">` +
      icon('replace', 14) +
      `<input class="qp-search__input" data-role="replace" placeholder="替换为（支持 $1 捕获组）" spellcheck="false" autocomplete="off" />` +
      `</div>` +
      `<button class="btn is-ghost" data-act="replace-one">替换</button>` +
      `<button class="btn is-ghost" data-act="replace-all">全部替换</button>` +
      `</div>`
    );
  }

  /** 恢复上一次的查询（CM 会在多次打开间保留）。 */
  restoreQuery() {
    const input = this.dom.querySelector('[data-role="search"]');
    const replaceInput = this.dom.querySelector('[data-role="replace"]');
    const sel = this.view.state.selection.main;
    if (!sel.empty) {
      const text = this.view.state.sliceDoc(sel.from, sel.to);
      if (text && !text.includes('\n') && text.length <= 200 && input) input.value = text;
    }
    if (replaceInput) replaceInput.value = '';
  }

  /** 绑定事件。 */
  bind() {
    const searchInput = this.dom.querySelector('[data-role="search"]');
    const replaceInput = this.dom.querySelector('[data-role="replace"]');

    searchInput.addEventListener('input', () => {
      this.closeHistory();
      this.applySearch(true);
    });

    searchInput.addEventListener('keydown', (e) => {
      // 下拉展开时，方向键/回车先归下拉用（否则会一边挪高亮一边跳匹配）
      if (this.historyOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Escape') this.closeHistory();
        else if (e.key === 'Enter') this.pickHistory(this.historyIndex);
        else this.moveHistory(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this.closeHistory();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // 空输入框按 ↓：回填最近一条查找历史（有历史时），否则按「下一个匹配」走
        if (!searchInput.value.trim()) {
          const list = loadFindHistory();
          if (list.length) {
            searchInput.value = list[0];
            this.applySearch(true);
            return;
          }
        }
        this.step(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.step(-1);
      } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
        // Alt+C / Alt+W / Alt+R：与按钮 title 中承诺的快捷键保持一致
        if (e.key.toLowerCase() === 'h') {
          e.preventDefault();
          this.toggleHistory();
          return;
        }
        const name = TOGGLE_SHORTCUTS[e.key.toLowerCase()];
        if (name) {
          e.preventDefault();
          this.toggleOption(name);
        }
      }
    });

    // 失焦后收起下拉（延迟一拍，让点击下拉项的事件先到）
    searchInput.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (!this.dom.contains(document.activeElement)) this.closeHistory();
      }, 140);
    });

    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.replaceOne();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });

    this.dom.addEventListener('click', (e) => {
      const histItem = e.target.closest('[data-history]');
      if (histItem) {
        this.pickHistory(Number(histItem.dataset.history));
        return;
      }
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        this.toggleOption(toggle.dataset.toggle);
        searchInput.focus();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const name = act.dataset.act;
      if (name === 'next') this.step(1);
      else if (name === 'prev') this.step(-1);
      else if (name === 'close') this.close();
      else if (name === 'toggle-replace') this.toggleReplace();
      else if (name === 'replace-one') this.replaceOne();
      else if (name === 'replace-all') this.replaceAll();
      else if (name === 'history') this.toggleHistory();
      else if (name === 'clear-history') {
        clearFindHistory();
        this.renderHistory();
        this.closeHistory();
        searchInput.focus();
      }
    });
  }

  /**
   * 切换某个搜索开关，并同步按钮的亮灭状态。
   * @param {string} name 开关短名（case / word / regexp / wrap）
   */
  toggleOption(name) {
    const key = toggleOptionKey(name);
    if (!(key in this.opts)) return;
    this.opts[key] = !this.opts[key];
    const btn = this.dom.querySelector(`[data-toggle="${name}"]`);
    if (btn) btn.classList.toggle('is-on', this.opts[key]);
    this.applySearch(true);
  }

  /** 切换替换行显隐。 */
  toggleReplace() {
    this.showReplace = !this.showReplace;
    const row = this.dom.querySelector('[data-row="replace"]');
    const btn = this.dom.querySelector('[data-act="toggle-replace"]');
    if (row) row.hidden = !this.showReplace;
    if (btn) btn.classList.toggle('is-active', this.showReplace);
    if (this.showReplace) {
      const replaceInput = this.dom.querySelector('[data-role="replace"]');
      if (replaceInput) replaceInput.focus();
    }
  }

  /* --------------------------------------------------------- 查找历史下拉 */

  /**
   * 展开 / 收起历史下拉。
   */
  toggleHistory() {
    if (this.historyOpen) this.closeHistory();
    else this.openHistory();
  }

  /**
   * 展开历史下拉（最近 20 条，按时间倒序）。
   * 没有历史时不展开也不报错 —— 空下拉框只会挡住匹配高亮。
   */
  openHistory() {
    if (!loadFindHistory().length) {
      this.closeHistory();
      return;
    }
    this.historyOpen = true;
    this.historyIndex = -1;
    this.renderHistory();
  }

  /** 收起历史下拉。 */
  closeHistory() {
    this.historyOpen = false;
    this.historyIndex = -1;
    const box = this.dom.querySelector('[data-role="history"]');
    if (box) box.hidden = true;
  }

  /**
   * 重绘历史下拉内容（含清空按钮）。
   */
  renderHistory() {
    const box = this.dom.querySelector('[data-role="history"]');
    if (!box) return;
    const list = loadFindHistory();
    if (!list.length) {
      box.innerHTML = '';
      box.hidden = true;
      this.historyOpen = false;
      return;
    }
    box.innerHTML =
      `<div class="qp-search__history-head">` +
      `<span>最近查找</span>` +
      `<button class="qp-search__history-clear" data-act="clear-history" title="清空查找历史">清空</button>` +
      `</div>` +
      list
        .map(
          (q, i) =>
            `<button class="qp-search__history-item${i === this.historyIndex ? ' is-active' : ''}"` +
            ` data-history="${i}" title="${escapeHtml(q)}">${escapeHtml(q)}</button>`,
        )
        .join('');
    box.hidden = false;
    this.historyOpen = true;
  }

  /**
   * 在下拉里上下移动高亮。
   * @param {number} dir +1 向下 / -1 向上
   */
  moveHistory(dir) {
    const list = loadFindHistory();
    if (!list.length) return;
    const next = this.historyIndex + dir;
    // 从「无高亮」开始按 ↓ 落在第一条，按 ↑ 落在最后一条
    if (this.historyIndex < 0) this.historyIndex = dir > 0 ? 0 : list.length - 1;
    else this.historyIndex = (next + list.length) % list.length;
    this.renderHistory();
  }

  /**
   * 选中某条历史：回填输入框并立即检索。
   * @param {number} index 下拉里的下标；越界时取第一条
   */
  pickHistory(index) {
    const list = loadFindHistory();
    if (!list.length) return;
    const value = list[index] || list[0];
    const input = this.dom.querySelector('[data-role="search"]');
    this.closeHistory();
    if (!input) return;
    input.value = value;
    input.focus();
    this.applySearch(true);
  }

  /**
   * 当前查询条件。
   * @return {object}
   */
  get searchOptions() {
    const input = this.dom.querySelector('[data-role="search"]');
    const replaceInput = this.dom.querySelector('[data-role="replace"]');
    return {
      searchText: input ? input.value : '',
      replaceText: replaceInput ? replaceInput.value : '',
      caseSensitive: this.opts.caseSensitive,
      regexp: this.opts.regexp,
      wholeWord: this.opts.wholeWord,
      wrap: this.opts.wrap,
    };
  }

  /**
   * 重新计算匹配并（可选）跳到第一个。
   * @param {boolean} jump
   */
  applySearch(jump) {
    const opts = this.searchOptions;
    if (!opts.searchText) {
      this.matches = [];
      this.activeMatch = 0;
      this.invalidRegexp = false;
      this.renderCount();
      return;
    }
    // 非法正则必须与「确实没有匹配」区分开，否则用户无法判断自己是不是写错了
    if (!makeSearchQuery(opts).valid) {
      this.matches = [];
      this.activeMatch = 0;
      this.invalidRegexp = true;
      this.renderCount();
      return;
    }
    this.invalidRegexp = false;
    syncQuery(this.view, opts);
    this.matches = collectMatches(this.view.state, opts, 5000);
    this.activeMatch = 0;
    if (jump && this.matches.length) {
      const sel = this.view.state.selection.main;
      const idx = pickMatchIndex(this.matches, sel.head, true, true);
      this.activeMatch = idx >= 0 ? idx : 0;
      this.gotoMatch(this.activeMatch);
    } else {
      this.renderCount();
    }
  }

  /** 更新计数显示。 */
  renderCount() {
    const el = this.dom.querySelector('[data-role="count"]');
    if (!el) return;
    if (this.invalidRegexp) {
      el.textContent = '正则无效';
      el.classList.add('is-none');
      el.classList.add('is-error');
      return;
    }
    el.classList.remove('is-error');
    if (!this.matches.length) {
      el.textContent = this.searchOptions.searchText ? '无结果' : '0 / 0';
      el.classList.toggle('is-none', !!this.searchOptions.searchText);
      return;
    }
    el.classList.remove('is-none');
    const current = this.matches[this.activeMatch] || null;
    if (!current) {
      el.textContent = `${formatNumber(this.matches.length)} 个`;
      return;
    }
    el.textContent = `${formatNumber(this.activeMatch + 1)} / ${formatNumber(this.matches.length)}`;
  }

  /**
   * 跳到第 idx 个匹配。
   * @param {number} idx
   */
  gotoMatch(idx) {
    const m = this.matches[idx];
    if (!m) return;
    this.view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
    });
    this.activeMatch = idx;
    this.renderCount();
    // 让 CM 的 searchMatch-selected 生效
    syncQuery(this.view, this.searchOptions);
  }

  /**
   * 前进 / 后退一个匹配。
   * @param {number} dir
   */
  step(dir) {
    const opts = this.searchOptions;
    if (!opts.searchText) return;
    // 真正「用上了」的查询才进历史：只是敲字不算，回车/点上下才算
    pushFindHistory(opts.searchText);
    if (!this.matches.length) {
      this.applySearch(false);
      if (!this.matches.length) return;
    }
    // 重新定位（文档可能已变化）
    const sel = this.view.state.selection.main;
    const idx = pickMatchIndex(this.matches, dir > 0 ? sel.to : sel.from, dir > 0, this.opts.wrap);
    if (idx < 0) {
      this.activeMatch = dir > 0 ? this.matches.length - 1 : 0;
      this.renderCount();
      return;
    }
    this.gotoMatch(idx);
  }

  /** 替换当前匹配。 */
  replaceOne() {
    const opts = this.searchOptions;
    if (!opts.searchText) return;
    const ok = replaceNextInView(this.view, opts);
    if (ok) {
      this.applySearch(false);
      this.step(1);
    }
  }

  /** 全部替换。 */
  replaceAll() {
    const opts = this.searchOptions;
    if (!opts.searchText) return;
    const n = replaceAllInView(this.view, opts);
    this.applySearch(false);
    this.matches = [];
    this.renderCount();
    if (n > 0) {
      this.dom.dispatchEvent(new CustomEvent('qp-replaced', { detail: n, bubbles: true }));
    }
  }

  /** 关闭面板。 */
  close() {
    const input = this.dom.querySelector('[data-role="search"]');
    if (input && input.value.trim()) pushFindHistory(input.value);
    this.closeHistory();
    closeSearchPanel(this.view);
    this.view.focus();
  }

  /** 面板挂载后调用。 */
  mount() {
    const input = this.dom.querySelector('[data-role="search"]');
    if (input) {
      input.focus();
      input.select();
    }
    if (!this.showReplace) {
      const row = this.dom.querySelector('[data-row="replace"]');
      if (row) row.hidden = true;
    }
    if (input && input.value) {
      // 面板的 mount 发生在 CodeMirror 的 update 周期内部，此时同步 dispatch 会抛
      // "Calls to EditorView.update are not allowed while an update is in progress"。
      // 因此把首次检索推迟到下一帧，等 update 周期结束后再同步命中高亮。
      const run = () => this.applySearch(false);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 0);
    }
  }

  /**
   * CM 每次状态更新都会调用。
   * 注意：这里**不能**再 dispatch（会触发 "update are not allowed while an update
   * is in progress"），只需要重算匹配与计数——命中高亮由 search 扩展自动跟随。
   * @param {import('@codemirror/view').ViewUpdate} u
   */
  update(u) {
    if (u.docChanged) {
      const opts = this.searchOptions;
      if (opts.searchText) {
        this.matches = collectMatches(u.state, opts, 5000);
        if (this.activeMatch >= this.matches.length) {
          this.activeMatch = Math.max(0, this.matches.length - 1);
        }
      }
    }
    this.renderCount();
  }

  /** 关闭时清理。 */
  destroy() {
    this.matches = [];
  }
}

/**
 * 供 CodeMirror search() 扩展使用的面板工厂。
 * @param {import('@codemirror/view').EditorView} view
 * @return {QuillSearchPanel}
 */
export function createSearchPanel(view) {
  return new QuillSearchPanel(view);
}

/**
 * 等待查找面板挂载后展开替换行并聚焦输入框。
 *
 * CodeMirror 的搜索面板是在随后的 update 周期里才挂到 view.dom 上的，
 * 刚调用 openSearchPanel 时同步查询 DOM 常常还拿不到面板，
 * 于是「替换」按钮永远点不到、替换行始终不展开。
 * 这里轮询等待（最多 10 帧）后再展开。
 * @param {import('@codemirror/view').EditorView} view
 */
function expandReplaceRow(view) {
  let tries = 0;
  const attempt = () => {
    const panelEl = view.dom.querySelector('.qp-search');
    if (!panelEl) {
      if (tries < 10) {
        tries += 1;
        requestAnimationFrame(attempt);
      }
      return;
    }
    const row = panelEl.querySelector('[data-row="replace"]');
    const btn = panelEl.querySelector('[data-act="toggle-replace"]');
    if (row && row.hidden) {
      if (btn) btn.click();
      else row.hidden = false;
    }
    const input = row && row.querySelector('[data-role="replace"]');
    if (input) input.focus();
  };
  requestAnimationFrame(attempt);
}

/**
 * 打开查找 / 替换面板。
 * @param {import('@codemirror/view').EditorView} view
 * @param {boolean} withReplace
 */
export function openFindPanel(view, withReplace = false) {
  openSearchPanel(view);
  if (withReplace) expandReplaceRow(view);
}

/* ==========================================================================
   2. 在文件中查找
   ========================================================================== */

/** 单次搜索最多返回的命中条数。 */
const MAX_HITS = 1200;
/** 单个文件最多返回的命中条数。 */
const MAX_HITS_PER_FILE = 120;

export class FindInFilesPanel {
  /**
   * @param {HTMLElement} root
   * @param {object} app
   */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.opts = { caseSensitive: false, regexp: false, wholeWord: false };
    this.scope = 'tabs';
    /** @type {Array<{key: string, name: string, path: string, tabId: string|null, hits: Array<object>, collapsed: boolean}>} */
    this.groups = [];
    this.running = false;
    /** 自增令牌：保证只有最新一次搜索的结果会被采纳 */
    this.runToken = 0;
    /** 输入即搜索的防抖版本（250ms） */
    this.debouncedRun = debounce(() => this.run(), 250);
    this.build();
  }

  /** 构建面板骨架。 */
  build() {
    this.root.innerHTML =
      `<div class="find-files__head">` +
      `<div class="qp-search__field" style="flex:1;height:26px">` +
      icon('search', 14) +
      `<input class="qp-search__input" data-role="search" placeholder="在所有打开的文件中查找" spellcheck="false" autocomplete="off" />` +
      `<button class="qp-toggle" data-toggle="case" title="区分大小写 (Alt+C)">Aa</button>` +
      `<button class="qp-toggle" data-toggle="word" title="全词匹配 (Alt+W)">W</button>` +
      `<button class="qp-toggle" data-toggle="regexp" title="正则表达式 (Alt+R)">.*</button>` +
      `</div>` +
      `<select class="find-files__scope" data-role="scope">` +
      `<option value="tabs">所有打开的标签</option>` +
      `<option value="folder">当前文件夹</option>` +
      `</select>` +
      `<span class="find-files__summary" data-role="summary"></span>` +
      `<button class="qp-icon-btn" data-act="close" title="关闭">${icon('close', 14)}</button>` +
      `</div>` +
      `<div class="find-files__head">` +
      `<div class="qp-search__field" style="flex:1;height:26px">` +
      icon('replace', 14) +
      `<input class="qp-search__input" data-role="replace" placeholder="替换为（支持 $1 捕获组）" spellcheck="false" autocomplete="off" />` +
      `</div>` +
      `<button class="btn is-ghost" data-act="replace-all">全部替换</button>` +
      `</div>` +
      `<div class="find-files__results" data-role="results">` +
      `<div class="ff-empty">输入关键词即可自动搜索</div>` +
      `</div>`;

    const searchInput = this.root.querySelector('[data-role="search"]');
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.debouncedRun.cancel();
        this.run();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
        // Alt+C / Alt+W / Alt+R：与按钮 title 中承诺的快捷键保持一致
        const name = TOGGLE_SHORTCUTS[e.key.toLowerCase()];
        if (name) {
          e.preventDefault();
          this.toggleOption(name);
        }
      }
    });
    searchInput.addEventListener('input', () => {
      if (!searchInput.value) {
        this.debouncedRun.cancel();
        this.groups = [];
        this.renderResults();
        this.setSummary('');
        return;
      }
      // 输入即搜索（防抖 250ms），Enter 可立即触发
      this.debouncedRun();
    });

    this.root.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        this.toggleOption(toggle.dataset.toggle);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) {
        const name = act.dataset.act;
        if (name === 'close') this.close();
        else if (name === 'replace-all') this.replaceAll();
        else if (name === 'open-folder') runCommand('file.openFolder', this.app);
        return;
      }
      const fileRow = e.target.closest('[data-group]');
      if (fileRow) {
        const idx = Number(fileRow.dataset.group);
        if (this.groups[idx]) {
          this.groups[idx].collapsed = !this.groups[idx].collapsed;
          this.renderResults();
        }
        return;
      }
      const hit = e.target.closest('[data-hit]');
      if (hit) {
        const [g, h] = hit.dataset.hit.split(':').map(Number);
        this.revealHit(g, h);
      }
    });

    this.root
      .querySelector('[data-role="scope"]')
      .addEventListener('change', (e) => {
        this.scope = e.target.value;
        if (this.searchText) this.run();
        // 没有关键词时也要重绘，否则切换到「当前文件夹」看不到「先打开文件夹」的引导
        else this.renderResults();
      });
  }

  /**
   * 切换某个搜索开关，并同步按钮的亮灭状态。
   * @param {string} name 开关短名（case / word / regexp）
   */
  toggleOption(name) {
    const key = toggleOptionKey(name);
    if (!(key in this.opts)) return;
    this.opts[key] = !this.opts[key];
    const btn = this.root.querySelector(`[data-toggle="${name}"]`);
    if (btn) btn.classList.toggle('is-on', this.opts[key]);
    if (this.searchText) this.run();
  }

  /**
   * 当前搜索对应的正则。
   * run() 与 renderResults() 必须用同一套构造逻辑，否则高亮与计数会不一致。
   * @return {RegExp|null}
   */
  get matchRegex() {
    const opts = this.searchOptions;
    if (!opts.searchText) return null;
    // 正则模式下必须严格构造：非法正则不能悄悄退回字面量匹配，
    // 否则用户会看到「搜不到」却不知道自己写错了正则。
    return opts.regexp
      ? buildRegExp(opts.searchText, {
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        strict: true,
      })
      : buildRegExp(escapeRegExp(opts.searchText), {
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
      });
  }

  /** 当前搜索词。 */
  get searchText() {
    const input = this.root.querySelector('[data-role="search"]');
    return input ? input.value : '';
  }

  /** 是否已经打开了文件夹（「当前文件夹」范围的前提）。 */
  get hasFolder() {
    const sidebar = this.app.sidebar;
    return !!(sidebar && sidebar.handle);
  }

  /**
   * 当前搜索条件。
   * @return {object}
   */
  get searchOptions() {
    const replaceInput = this.root.querySelector('[data-role="replace"]');
    return {
      searchText: this.searchText,
      replaceText: replaceInput ? replaceInput.value : '',
      caseSensitive: this.opts.caseSensitive,
      regexp: this.opts.regexp,
      wholeWord: this.opts.wholeWord,
      wrap: true,
    };
  }

  /**
   * 打开面板。
   */
  open() {
    this.root.hidden = false;
    const input = this.root.querySelector('[data-role="search"]');
    if (input) {
      input.focus();
      input.select();
    }
  }

  /** 关闭面板。 */
  close() {
    this.root.hidden = true;
    this.app.editor.focus();
  }

  /** 切换。 */
  toggle() {
    if (this.root.hidden) this.open();
    else this.close();
  }

  /**
   * 设置摘要文本。
   * @param {string} text
   */
  setSummary(text) {
    const el = this.root.querySelector('[data-role="summary"]');
    if (el) el.textContent = text;
  }

  /** 执行搜索。 */
  async run() {
    const token = (this.runToken += 1);
    const opts = this.searchOptions;
    if (!opts.searchText) {
      this.groups = [];
      this.renderResults();
      this.setSummary('');
      return;
    }
    // 正则模式下必须严格构造：非法正则不能悄悄退回字面量匹配，
    // 否则用户会看到「搜不到」却不知道自己写错了正则。
    const regex = this.matchRegex;
    if (!regex) {
      this.groups = [];
      this.renderResults();
      this.setSummary('正则表达式无效');
      return;
    }

    this.running = true;
    this.setSummary('搜索中…');
    const groups = [];
    let total = 0;

    /**
     * 统计一个文件里的所有命中（按出现次数，而不是按行数），
     * 这样「区分大小写」之类的开关才能在计数上被真实观察到。
     * @param {string} key
     * @param {string} name
     * @param {string} path
     * @param {string|null} tabId
     * @param {string} content
     */
    const scan = (key, name, path, tabId, content) => {
      if (total >= MAX_HITS) return;
      const lines = content.split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        regex.lastIndex = 0;
        let m = regex.exec(line);
        while (m) {
          hits.push({ line: i + 1, text: line, index: m.index });
          if (hits.length >= MAX_HITS_PER_FILE) break;
          if (total + hits.length >= MAX_HITS) break;
          // 零宽匹配会让 exec 原地不动，这里手动推进避免死循环
          if (m[0] === '') regex.lastIndex += 1;
          m = regex.exec(line);
        }
        if (hits.length >= MAX_HITS_PER_FILE || total + hits.length >= MAX_HITS) break;
      }
      if (hits.length) {
        total += hits.length;
        groups.push({ key, name, path, tabId, hits, collapsed: false });
      }
    };

    if (this.scope === 'tabs') {
      for (const tab of state.tabs) {
        scan(tab.id, tab.name, tab.path, tab.id, tab.content);
      }
    } else {
      const sidebar = this.app.sidebar;
      if (!sidebar || !sidebar.handle) {
        // 没有打开文件夹时给出明确引导，而不是「没有找到匹配」
        // （否则用户会以为关键词写错了，实际上只是缺一个文件夹）
        this.setSummary('还没有打开文件夹');
        this.running = false;
        this.groups = [];
        this.renderResults();
        return;
      }
      const files = await sidebar.walkFiles(600, 6);
      for (const file of files) {
        if (total >= MAX_HITS) break;
        try {
          const data = await readFileHandle(file.handle);
          if (data.size > 512 * 1024) continue;
          if (!data.content) continue;
          if (data.content.includes('\u0000')) continue;
          scan(file.path, file.path.split('/').pop(), file.path, null, data.content);
        } catch {
          /* 忽略无法读取的文件 */
        }
      }
    }

    this.groups = groups;
    this.running = false;
    // 搜索期间又发起了新的搜索时，丢弃本次过期结果
    if (token !== this.runToken) return;
    this.renderResults();
    this.setSummary(
      total ? `${formatNumber(total)} 处匹配 · ${groups.length} 个文件` : '没有找到匹配',
    );
  }

  /** 渲染结果列表。 */
  renderResults() {
    const results = this.root.querySelector('[data-role="results"]');
    if (!results) return;
    // 选了「当前文件夹」但还没打开文件夹：先给操作引导
    if (this.scope === 'folder' && !this.hasFolder) {
      results.innerHTML =
        `<div class="ff-empty ff-empty--guide">` +
        `<div class="ff-empty__title">先打开一个文件夹再搜索</div>` +
        `<div class="ff-empty__hint">「当前文件夹」范围需要先打开一个文件夹（Ctrl+K O）</div>` +
        `<button class="btn" data-act="open-folder">打开文件夹…</button>` +
        `</div>`;
      return;
    }
    if (!this.groups.length) {
      results.innerHTML = `<div class="ff-empty">${
        this.searchText ? '没有找到匹配' : '输入关键词即可自动搜索'
      }</div>`;
      return;
    }
    const regex = this.matchRegex;

    results.innerHTML = this.groups
      .map((group, gi) => {
        const open = !group.collapsed;
        const hitsHtml = open
          ? group.hits
              .map(
                (h, hi) =>
                  `<div class="ff-hit" data-hit="${gi}:${hi}" title="第 ${h.line} 行">` +
                  `<span class="ff-hit__ln">${h.line}</span>` +
                  `<span class="ff-hit__text">${
                    regex ? highlightHtml(h.text.trim(), regex) : escapeHtml(h.text.trim())
                  }</span>` +
                  `</div>`,
              )
              .join('')
          : '';
        return (
          `<div class="ff-file" data-group="${gi}">` +
          `<span class="ff-file__caret ${open ? 'is-open' : ''}">${icon('chevronRight', 11)}</span>` +
          `${icon('fileText', 13)}` +
          `<span class="ff-file__name">${escapeHtml(group.path)}</span>` +
          `<span class="ff-file__count">${group.hits.length}</span>` +
          `</div>` +
          hitsHtml
        );
      })
      .join('');
  }

  /**
   * 跳转到某条命中。
   * @param {number} gi
   * @param {number} hi
   */
  async revealHit(gi, hi) {
    const group = this.groups[gi];
    if (!group) return;
    const hit = group.hits[hi];
    if (!hit) return;
    if (group.tabId) {
      this.app.activateTab(group.tabId);
    } else {
      // 来自文件夹：按路径重新打开
      const ok = await this.app.openFileByPath(group.path);
      if (!ok) return;
    }
    const tab = this.app.activeTab();
    if (!tab) return;
    this.app.editor.gotoLine(hit.line);
    // 定位到列：优先用命中时记录的列偏移，同一行有多次命中时也不会跳错
    const needle = this.searchText;
    if (needle && !this.opts.regexp) {
      const col = typeof hit.index === 'number'
        ? hit.index
        : hit.text.toLowerCase().indexOf(needle.toLowerCase());
      if (col >= 0) {
        const lineObj = this.app.editor.state.doc.line(hit.line);
        this.app.editor.gotoPos(lineObj.from + col, needle.length);
      }
    }
  }

  /** 全部替换（仅作用于搜索范围内的内容）。 */
  async replaceAll() {
    const opts = this.searchOptions;
    if (!opts.searchText) {
      this.app.toast('请先输入要查找的内容', 'info');
      return;
    }
    if (this.scope === 'folder') {
      this.app.toast('文件夹模式的批量替换请逐个文件打开后使用「替换」', 'info', 3200);
      return;
    }
    let total = 0;
    let files = 0;
    for (const group of this.groups) {
      const tab = state.tabs.find((t) => t.id === group.tabId);
      if (!tab) continue;
      const result = replaceAllInString(tab.content, opts);
      if (result.count > 0) {
        this.app.setTabContent(tab.id, result.text, { markEdited: true });
        total += result.count;
        files += 1;
      }
    }
    await this.run();
    this.app.toast(`已替换 ${formatNumber(total)} 处，涉及 ${files} 个文件`, total ? 'success' : 'info');
  }
}
