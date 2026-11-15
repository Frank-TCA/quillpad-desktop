/**
 * electron-builder afterPack 钩子
 * 由于 winCodeSign-2.6.0 无法下载（GitHub 504），win.signAndEditExecutable 设为 false。
 * 此钩子在 app 打包到 win-unpacked 后手动调用 rcedit 设置 exe 图标与版本元数据，
 * 保证 NSIS 安装包与便携版内部的 QuillPad.exe 均带 QuillPad 图标。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  // electronDist 指向「已解包的 electron 目录」时，electron-builder 不做
  // isFullCleanup，会把 resources/default_app.asar 和根目录的 version 一起拷进来。
  // 这两个文件在正式产物里没有意义（app.asar 优先加载；version 只是 electron-builder
  // 判断能否复用目录的标记），逐个删掉，让产物与默认 zip 解压路径完全一致。
  for (const rel of [['resources', 'default_app.asar'], ['version']]) {
    const p = path.join(context.appOutDir, ...rel);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      console.warn(`[afterPack] 跳过清理 ${p}: ${err.message}`);
    }
  }

  const appName = context.packager.appInfo.productFilename; // "QuillPad"
  const exePath = path.join(context.appOutDir, `${appName}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

  // rcedit.exe 随 npm rcedit 包分发（x86 版可编辑 x64 exe 的资源段）
  // rcedit 的 exports 字段不允许 require.resolve 子路径，直接按 node_modules 布局定位。
  const rcedit = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit.exe');

  const args = [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'ProductName', appName,
    '--set-version-string', 'FileDescription', 'QuillPad 文本编辑器',
    '--set-version-string', 'CompanyName', 'QuillPad',
    '--set-version-string', 'LegalCopyright', 'QuillPad',
    '--set-version-string', 'ProductVersion', context.packager.appInfo.version,
    '--set-file-version', context.packager.appInfo.version,
  ];

  execFileSync(rcedit, args, { stdio: 'pipe' });
  console.log(`[afterPack] rcedit applied icon + version metadata to ${exePath}`);
};
