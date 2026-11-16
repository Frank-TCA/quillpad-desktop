/**
 * QuillPad · 特殊字符数据
 *
 * Notepad++ 的「插入特殊字符」在中文写作场景里真正被用到的是一小撮：
 * 标点、数学符号、箭头、货币、序号、框线。全部 Unicode 有 15 万个码位，
 * 塞进面板既慢又没法用，所以这里维护一份**约 620 个常用符号**的分类表，
 * 外加「最近使用 20 条」。
 *
 * 数据用「字符串 + 空格分隔」的方式写：可读性远好于码位数组，
 * 也让 `scripts/v2-unit.mjs` 能直接断言「总数 ≥ 600」。
 */

import { t } from './i18n.js';

/** 最近使用条数上限（PRD C11）。 */
export const RECENT_LIMIT = 20;

/** localStorage 键。 */
export const RECENT_KEY = 'quillpad.chars.recent.v1';

/**
 * 分类表。`chars` 里的字符会被拆成单个码位（含 emoji 变体走 codePoint）。
 * @type {Array<{id: string, name: string, chars: string}>}
 */
export const CHAR_GROUPS = [
  {
    id: 'punct-cn',
    get name() {
      return t('中文标点', 'Chinese Punctuation');
    },
    nameEn: 'Chinese Punctuation',
    chars:
      '、。〃〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〰‥…‧﹏' +
      '·×÷±§¶†‡•‥′″‴℃℉№℡™©®°′″‰‱' +
      '─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋' +
      '═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬',
  },
  {
    id: 'punct-en',
    get name() {
      return t('西文标点', 'Western Punctuation');
    },
    nameEn: 'Western Punctuation',
    chars: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿',
  },
  {
    id: 'math',
    get name() {
      return t('数学符号', 'Math Symbols');
    },
    nameEn: 'Math Symbols',
    chars:
      '±×÷≠≈≡≤≥≦≧∞∝∵∴∑∏√∛∜∫∬∭∮∂∇∈∉∋∌⊂⊃⊄⊅⊆⊇⊈⊉∩∪∧∨¬⇒⇔∀∃∄∅∆∇' +
      '⌈⌉⌊⌋⟨⟩∥∦∟∠∡∢°′″‴⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞',
  },
  {
    id: 'arrow',
    get name() {
      return t('箭头', 'Arrows');
    },
    nameEn: 'Arrows',
    chars:
      '←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏' +
      '⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪⇫⇬⇭⇮⇯⇰⇱⇲⇳⇴⇵⇶⇷⇸⇹⇺⇻⇼⇽⇾⇿⟵⟶⟷⟸⟹⟺',
  },
  {
    id: 'number',
    get name() {
      return t('序号与圈号', 'Numbers & Circled');
    },
    nameEn: 'Numbers & Circled',
    chars:
      '①①⓪⓫⓬⓭⓮⓯⓰⓱⓲⓳⓴⓵⓶⓷⓸⓹⓺⓻⓼⓽⓾⓿' +
      '⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛' +
      'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ' +
      '⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇' +
      '⒜⒝⒞⒟⒠⒡⒢⒣⒤⒥⒦⒧⒨⒩⒪⒫⒬⒭⒮⒯⒰⒱⒲⒳⒴⒵',
  },
  {
    id: 'currency',
    get name() {
      return t('货币', 'Currency');
    },
    nameEn: 'Currency',
    chars: '¥$¢£¤₠₡₢₣₤₥₦₧₨₩₪₫€₭₮₯₰₱₲₳₴₵₶₷₸₹₺₻₼₽₾₿￥＄￠￡￢',
  },
  {
    id: 'shape',
    get name() {
      return t('几何形状', 'Geometric Shapes');
    },
    nameEn: 'Geometric Shapes',
    chars:
      '■□▪▫▲△▼▽◆◇○◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯' +
      '★☆☀☁☂☃☄★☆☇☈☉☊☋☌☍☎☏☐☑☒☓☔☕☖☗☘☙☚☛☜☝☞☟☠☡☢☣☤☥☦☧☨☩☪☫☬☭' +
      '░▒▓█▀▄▐▌▖▗▘▙▚▛▜▝▞▟▔▕▖▗▘▙▚▛▜▝▞▟',
  },
  {
    id: 'check',
    get name() {
      return t('勾叉与提示', 'Checks & Symbols');
    },
    nameEn: 'Checks & Symbols',
    chars: '✓✔✗✘✕✖☑☒⚠⚡⚐⚑⚖⚗⚙⚚⚛⚜⛔⛔⛔☺☻☹☹♠♣♥♦♤♧♡♢♨♩♪♫♬♭♮♯',
  },
  {
    id: 'letter',
    get name() {
      return t('拉丁与希腊', 'Latin & Greek');
    },
    nameEn: 'Latin & Greek',
    chars:
      'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ' +
      'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψωϑϕϖϰϱϵ',
  },
  {
    id: 'misc',
    get name() {
      return t('其他', 'Other');
    },
    nameEn: 'Other',
    chars: '§¶†‡•‣⁃⁌⁍※⁂⁎⁑⁕⁜⌘⌥⇧⌃⌫⌦⏎⏏⏚⌚⌛⏰⏱⏲☯☮☸☽☾♈♉♊♋♌♍♎♏♐♑♒♓',
  },
];

/**
 * 全部字符（去重、保序）。
 * @return {string[]}
 */
export function allChars() {
  const seen = new Set();
  const out = [];
  for (const group of CHAR_GROUPS) {
    for (const ch of group.chars) {
      if (ch === ' ' || ch === '\n') continue;
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

/** 字符总数。 */
export function charCount() {
  return allChars().length;
}

/**
 * 码位文本（面板上做 tooltip 用）。
 * @param {string} ch
 * @return {string} 形如 `U+4E2D`
 */
export function codepointLabel(ch) {
  try {
    const cp = ch.codePointAt(0) || 0;
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  } catch {
    return '';
  }
}

/**
 * 搜索：支持直接粘码位（`4E2D` / `U+4E2D`）或按分组名过滤。
 * @param {string} query
 * @return {string[]}
 */
export function searchChars(query) {
  const q = String(query || '').trim();
  if (!q) return allChars();
  const hex = /^(?:u\+|u|0x)?([0-9a-f]{2,6})$/i.exec(q);
  if (hex) {
    const cp = Number.parseInt(hex[1], 16);
    if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
      try {
        return [String.fromCodePoint(cp)];
      } catch {
        return [];
      }
    }
  }
  const matchedGroups = CHAR_GROUPS.filter((g) =>
    g.name.includes(q) || String(g.nameEn || '').toLowerCase().includes(q.toLowerCase()));
  if (matchedGroups.length) {
    const out = [];
    const seen = new Set();
    for (const g of matchedGroups) {
      for (const ch of g.chars) {
        if (seen.has(ch)) continue;
        seen.add(ch);
        out.push(ch);
      }
    }
    return out;
  }
  // 否则按字符本身过滤
  return allChars().filter((ch) => ch.includes(q));
}

/**
 * 读最近使用列表。
 * @return {string[]}
 */
export function loadRecentChars() {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/**
 * 记一次使用（去重、最新在前、上限 20）。
 * @param {string} ch
 * @return {string[]} 更新后的列表
 */
export function pushRecentChar(ch) {
  if (!ch) return loadRecentChars();
  const list = loadRecentChars().filter((x) => x !== ch);
  list.unshift(ch);
  const trimmed = list.slice(0, RECENT_LIMIT);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed));
    }
  } catch {
    // 忽略配额错误
  }
  return trimmed;
}
