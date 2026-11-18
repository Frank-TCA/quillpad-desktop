/**
 * QuillPad · 版本常量
 *
 * 全应用只在这里写一次版本号：关于对话框、欢迎页脚注、导出的 PDF 元信息
 * 都从这里取。发版时改这一行 + `package.json`（两处必须一致，`license:check`
 * 会比对，不一致就报错）。
 */

/**
 * 应用版本（纯语义化数字，与 package.json 的 version 必须相同）。
 *
 * 保持 `x.y.z` 不带前缀：打包元数据（ProductVersion）、Windows 的版本比较、
 * `license:check` 的比对都要求纯数字形式。要给人看的带 `v` 形式用下面的
 * `APP_VERSION_LABEL`。
 */
export const APP_VERSION = '1.0.4';

/** 展示用版本号：`v1.0.4`（界面上只要出现版本号，一律用这个）。 */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/** 产品名。 */
export const APP_NAME = 'QuillPad';
