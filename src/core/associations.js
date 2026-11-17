/**
 * QuillPad · 文件关联分组
 *
 * 「哪些扩展名算一类」的**唯一出处**在这里和 `build/traces.nsh` 的 QP_EXTS_*
 * 两组定义里各写一份 —— NSIS 与前端没法共享代码，改一处必须同步另一处：
 *
 *   build/traces.nsh :  QP_EXTS_MARKDOWN / _PLAIN / _CODE / _CONFIG
 *   src/core/associations.js : assocGroups() 的 exts 数组
 *
 * 两侧都要求：分组顺序一致、每组的扩展名集合一致（共 50 个）。安装器的「文件
 * 关联」页与应用内「文件关联…」对话框展示的是同一批类型，对不上会让用户勾了
 * 一组却只生效一半。
 */

import { t } from './i18n.js';

/** 与 installer.nsh / traces.nsh 的 QP_PROGID、main.cjs 的 ASSOC_PROGID 一致。 */
export const ASSOC_PROGID = 'QuillPad.TextFile';

/**
 * 文件关联分组。
 *
 * 标签在调用点求值（不是模块级常量）：语言切换后重新打开对话框要跟着变。
 * 每组只给扩展名清单，展示用的「.js、.ts、…」由界面自己从清单截取生成 ——
 * 手写摘要迟早和清单对不上（增删扩展名时最容易漏改）。
 *
 * @return {Array<{id: string, label: string, exts: string[]}>}
 */
export function assocGroups() {
  return [
    {
      id: 'markdown',
      label: t('Markdown 文档', 'Markdown documents'),
      exts: ['.md', '.markdown'],
    },
    {
      id: 'plain',
      label: t('纯文本与日志', 'Plain text & logs'),
      exts: ['.txt', '.log'],
    },
    {
      id: 'code',
      label: t('代码文件', 'Source code'),
      exts: [
        '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
        '.html', '.htm', '.css', '.scss', '.less', '.vue',
        '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
        '.go', '.rs', '.php', '.rb', '.lua',
        '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.sql',
      ],
    },
    {
      id: 'config',
      label: t('配置与数据', 'Config & data'),
      exts: [
        '.json', '.jsonc', '.xml', '.svg', '.yml', '.yaml', '.toml',
        '.ini', '.cfg', '.conf', '.properties', '.env',
        '.csv', '.tex', '.rst',
      ],
    },
  ];
}

/**
 * 全部支持关联的扩展名（四组并集，50 个）。
 * @return {string[]}
 */
export function assocAllExts() {
  const out = [];
  for (const group of assocGroups()) {
    for (const ext of group.exts) if (!out.includes(ext)) out.push(ext);
  }
  return out;
}
