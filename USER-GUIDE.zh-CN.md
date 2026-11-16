# QuillPad 1.0.2 使用说明

> 简体中文 · 对应 v1.0.2 · MIT 许可 · 仓库 <https://github.com/Frank-TCA/quillpad-desktop>

安装包位于 `dist/release/` 目录（可复制到任意位置使用）：

| 文件 | 说明 | 大小 |
| --- | --- | --- |
| `QuillPad-Setup-v1.0.2.exe` | 安装版 | 约 127 MB |
| `QuillPad-v1.0.2-portable.exe` | 便携版 | 约 115 MB |
| `QuillPad-Uninstaller-v1.0.2.exe` | 独立卸载器（仅安装版需要） | 约 80 KB |

> 每个文件的精确字节数与 SHA256 见对应 Release 页面的附件说明。

本项目以 MIT 协议开源：<https://github.com/Frank-TCA/quillpad-desktop>

## 一、功能概览

### 新建与标签

- 新建文件会先问「叫什么名字、什么类型」：`Ctrl+N`（或工具栏「新建」、标签栏末尾的「+」）弹出对话框，可填文件名并在 40 种类型里选（`.txt` / `.md` / `.json` / `.js` / `.py` …）；类型清单与语言表同源，选到就一定有色。
- 名字与类型双向跟随：输入 `README.md` 下拉框自动跳到 Markdown；换类型则「未命名.txt」→「未命名.md」。回车创建，`Esc` 取消。
- 标签栏最后一个标签右侧有「+」按钮，点它等同 `Ctrl+N`；标签多到溢出时它会吸附在右边缘，不会被滚出视口。
- 不想要弹窗时，用命令面板（`Ctrl+Shift+P`）里的「新建空白文件（不询问类型）」。

### 排版与写作

- 三种视图：源码 / 所见即所得（WYSIWYG）/ 分栏；`Ctrl+Shift+1` / `2` / `3` 直切。源码模式是代码编辑器，保持 14px 等宽字体；WYSIWYG 与分栏预览是阅读面，统一 16px / 行高 28px / 栏宽 736px（46em）无衬线正文。**所见即所得不显示行号栏与折叠箭头**（阅读面不需要），需要行号与折叠请切到源码或分栏。
- WYSIWYG 就地渲染标题、粗斜体、删除线、行内代码、链接、引用、列表、任务项、代码块、表格、图片、公式（KaTeX）、脚注与目录；光标进入该行时按需露出源码标记。表格单击选中整个表格块，双击才进入单元格编辑。
- 表格解析/序列化、行列增删、列对齐循环、`Tab` 跳格；图片拖拽/粘贴后落到文档同目录 `assets\`，同名自动加随机后缀，不会覆盖已有文件。
- 宏录制/回放/持久化（录制中状态栏**右下角**出现红色呼吸圆点，点它即可停止并命名保存）；矩形（列）选区的插入、删除、对齐、编号；10 个分类、共约 840 个特殊字符的检索面板（另带「最近使用 20 条」）；查找历史（最多 20 条，空输入框按 `↓` 回填最近一条）。
- 排版 token（`--qp-*` 变量）与四套主题；支持「减少动效」。

### 打印与 PDF

- 自包含打印页：字体以 `data:` 内联、图片内联或占位、无外链、无脚本。
- 导出对话框是单栏设置（默认可见 12 行，选「自定义」纸张多出尺寸行、选「自定义」页眉/页脚多出文字行），无缩略图预览；中文字体 Noto Sans SC 子集真嵌入，导出 PDF 里的中文是子集嵌入而非系统字体引用。
- 页码由 Chromium 页脚模板回填；目录是章节列表，不带页码。

### 插件生态

- 入口是「插件管理器」对话框（命令面板搜「插件市场」，或右键点菜单栏 →「插件管理器…」）：上半是已安装列表（启用 / 禁用 / 卸载，四态状态标签：已启用 / 已禁用 / 已崩溃 / 已阻止（License 不合规）），下半是插件市场（搜索、分类、排序、License 徽标、安装）；安装前弹权限清单确认，`network` 与 `files:write` 属高风险权限，需要二次确认。
- 三个官方 MIT 包：`quillpad.text-tools`（13 命令）、`quillpad.md-tools`（4 命令）、`quillpad.dev-tools`（4 命令 + 1 个插件视图），合计 21 命令 + 1 视图（视图以卡片形式列在插件管理器对话框底部）；禁用即注销命令，重新启用恢复。
- 另有 4 个社区包：JSON 格式化（2 命令）、JSON Schema 速查（1 命令）、CSV 转 JSON（1 命令）、行排序增强（4 命令）—— 走 zip 安装，安装前校验 `sha256`。市场里 7 条目（3 官方 + 4 社区）逐条实测都能装上，装不上的包不会出现在列表里。
- 插件运行在 module Worker 沙箱里，主线程逐次鉴权；5 秒心跳无响应会终止 Worker 并禁用插件（重启不自动复活）。
- 「从 Notepad++ 导入插件」向导：扫描本机插件目录，给出 40 条兼容映射与已内置 / 可一键安装 / 不支持三类报告。

### 合规

- `THIRD-PARTY-NOTICES.txt` 与 Noto 字体 `OFL.txt` 随**两种安装包**分发，位置为 `<安装目录或便携解包目录>\resources\licenses\`；根目录也有一份 `THIRD-PARTY-NOTICES.txt`。运行时依赖 27 个，无 GPL / AGPL / SSPL。

## 二、安装版用法（推荐）

1. 双击 `QuillPad-Setup-v1.0.2.exe`。
2. 首次运行可能弹「Windows 已保护你的电脑」—— 这是未购买代码签名证书的新程序都会有的提示，不是病毒。点「更多信息」→「仍要运行」。
3. 安装器是中文界面，可选安装目录；`perMachine=false`，装到当前用户目录，不需要管理员权限、不弹 UAC。装完可勾选立即运行。
4. 会创建开始菜单与桌面快捷方式；卸载程序 `Uninstall QuillPad.exe` 就在安装目录里，不会单独留在下载文件夹。
5. `Win+R` 输入 `QuillPad` 可直接启动（已注册 App Paths）。

### 右键菜单 / 文件关联

安装时会注册 `QuillPad.TextFile` ProgID、App Paths、常见文本与代码扩展名的 `OpenWithProgids`，以及所有文件的右键菜单「用 QuillPad 打开(&Q)」。

对任意文件右键 →「用 QuillPad 打开」即可；也可在「打开方式」里选 QuillPad。选中多个文件时只会打开第一个（Windows 对自定义动词的限制）。

安装器只登记「候选程序」，不会抢走你已有的默认关联；想设为默认请在「打开方式」里勾选「始终使用此应用」。这些注册项都在 `HKCU` 下，不需要管理员权限，卸载时全部反注册。

## 三、便携版用法

1. 把 `QuillPad-v1.0.2-portable.exe` 单独放到一个空文件夹（例如 U 盘目录），双击即可运行。它是单文件自解压包，不需要安装、不写注册表、不创建快捷方式。
2. 启动要 3–5 秒：单文件版每次会先把自身解压到系统临时目录。
3. 所有用户数据（会话、主题、最近文件、窗口位置、宏、插件与插件状态、缓存）都写在 exe **同目录**下的 `QuillPad-Data\` 文件夹里。实测：运行后该目录含 `window-state.json` 等 81 个文件；`%APPDATA%\QuillPad` 在便携运行期间没有新增任何文件。
4. 更换电脑或移动 exe 时，连同 `QuillPad-Data\` 一起拷贝即可带走全部设置。
5. 便携版不写注册表，所以没有右键菜单和文件关联；把文件拖到窗口里、或用「打开文件」打开，同样能直接保存回原文件。

## 四、四种卸载入口与独立卸载器

1. 开始菜单 →「卸载 QuillPad」快捷方式；
2. 安装目录下的 `Uninstall QuillPad.exe`；
3. Windows「设置 → 应用 → 已安装的应用」（或控制面板「程序和功能」）里选中「QuillPad 文本编辑器」→ 卸载；
4. 直接双击分发文件 `QuillPad-Uninstaller-v1.0.2.exe`（独立卸载器，约 78 KB）。

四个入口执行的是同一套清理逻辑，效果一致，任选其一。

第四个是自带「清道夫」的独立小工具，不依赖安装目录里的任何文件：

- **扫描范围**：注册表 Uninstall 子树（`HKCU` / `HKLM`，64 位与 32 位两个视图，按显示名模糊匹配 —— 卸载键名是 GUID 也不影响）、常见的几处安装目录、用户数据与缓存、开始菜单/桌面/任务栏快捷方式、文件关联与右键菜单；
- 先弹窗列出「发现多少目录 / 文件 / 注册表项」，确认后才动手；
- 装在 `Program Files` 时自动请求提权（UAC），per-user 安装则不打扰；
- 删不掉（被占用或权限不足）的登记为「重启后清理」，最后报成功 / 失败数量；
- 全过程写进 `%TEMP%\QuillPad-Uninstall.log`（UTF-16，记事本可直接打开）；
- 本机已经没有 QuillPad 时只报「没有发现痕迹」，不会误删任何东西。

命令行用法（脚本 / 批处理）：

```bat
QuillPad-Uninstaller-v1.0.2.exe /S          静默卸载，不弹对话框
QuillPad-Uninstaller-v1.0.2.exe /SCAN /S    只扫描不删除
```

退出码：`0` = 干净，`1` = 有痕迹，`2` = 清理时有删不掉的项，`3` = 用户取消。

## 五、痕迹清理说明 —— 安装版与便携版的差异（重要）

### 安装版

四个卸载入口执行同一份痕迹清单（`build\traces.nsh`，安装与卸载共用）：

- **程序目录**：`%ProgramFiles%\QuillPad`、`%ProgramFiles(x86)%\QuillPad`、`%LOCALAPPDATA%\Programs\QuillPad`，以及注册表里登记过的「任何自定义安装位置」（当年装到 `D:\Apps\QuillPad` 的历史版本会被一起清掉）；
- **用户数据**：`%APPDATA%\QuillPad`（标签会话、主题、字号、最近文件、窗口位置、宏 `macros.json`、插件与插件状态、IndexedDB 文件句柄、各级缓存）、`%LOCALAPPDATA%\QuillPad`、`%LOCALAPPDATA%\quillpad-updater`、`%LOCALAPPDATA%\Temp\QuillPad`、`%LOCALAPPDATA%\CrashDumps\QuillPad.exe.*.dmp`；
- **快捷方式**：开始菜单（含「卸载 QuillPad.lnk」）、桌面、快速启动、任务栏固定项，当前用户与所有用户两个范围都扫；
- **注册表**：所有 QuillPad 卸载项（不论版本、不论键名是 GUID 还是名称）、`QuillPad.TextFile` ProgID、`Applications\QuillPad.exe`、`*\shell\QuillPad` 右键菜单、各扩展名的 `OpenWithProgids` / `OpenWithList` 槽位、App Paths、Run 自启项，以及资源管理器缓存里的 MuiCache 与关联 Toast 值；
- 若某个扩展名的默认程序就是 QuillPad，会撤销那条 `UserChoice`（恢复成「没有默认程序」），不会把默认关联指向一个已经删掉的程序；
- 最后通知资源管理器刷新文件关联图标。

只删安装目录会留下右键菜单与「打开方式」里的无效项，所以务必走卸载入口。任务栏上手动固定的图标：卸载器会删除对应的固定项文件；若系统仍显示，右键「从任务栏取消固定」即可。

### 便携版

不写任何注册表、不建快捷方式，因此**不需要卸载程序**：直接删除 `QuillPad-v1.0.2-portable.exe` 和同目录的 `QuillPad-Data\` 文件夹即可。实测删除 `QuillPad-Data\` 后，exe 所在目录只剩 exe 本身，`%APPDATA%\QuillPad` 无新增文件，系统里不残留用户数据。

### 一句话区别

安装版用卸载程序清程序目录 + 注册表 + 用户数据（含历史版本）；便携版直接删 exe + `QuillPad-Data` 目录即可，两者互不通用。安装版的数据在 `%APPDATA%\QuillPad`，便携版的数据在 exe 同目录 `QuillPad-Data\`，两者可以共存、互不影响。

## 六、插件市场与 Notepad++ 插件边界

打开方式：命令面板搜索「插件市场」（`plugins.market`），或右键点菜单栏 →「插件管理器…」——市场区就在对话框下半部分（侧栏的插件页已并入这个对话框）；「从 Notepad++ 导入插件」命令会扫描 `%ProgramFiles%\Notepad++\plugins`、`%ProgramFiles(x86)%\Notepad++\plugins`、`%APPDATA%\Notepad++\plugins`，目录不存在时显示空状态而不是报错。

以下 5 条是 QuillPad 的官方能力边界声明，在市场首页横幅、导入向导末页、`.dll` 拒绝弹窗三处保持同一原文：

1. QuillPad 不加载任何 `.dll`，不是 Notepad++ 的二进制兼容宿主。
2. 不支持任何依赖原生 Scintilla 控件句柄（`_scintillaMainHandle`）、`NPPM_*` 宿主消息、Docking Dialog、Lexer 接口或系统级注入的插件 —— QuillPad 的编辑区是 CodeMirror 6 的 DOM，不存在 HWND。
3. 不支持 GPL / AGPL / SSPL 授权插件的分发与代装；Notepad++ 本体为 GPL-2.0、其官方插件库多数为 GPL，不能合法随 QuillPad 打包。
4. 提供的是能力等价而非实现等价：Notepad++ 常用插件的高频功能子集由官方 MIT 插件包原生重写；不保证第三方插件的行为、配置格式与快捷键逐一一致。
5. 用户自行从第三方渠道获取并安装 GPL 插件属用户个人行为，QuillPad 不加载、不代管、不承担其合规责任，但会在安装入口以 UI 明确提示风险。

因此：把 `.dll` 文件拖进插件市场会被明确拒绝并给出上述理由；40 条兼容映射里 12 条「已内置」、12 条「移植版」（其中首版 7 条可一键安装、其余显示「移植版筹备中」）、16 条「不支持」。插件安装只允许 MIT / Apache-2.0 / BSD-2 / BSD-3 / ISC / 0BSD 白名单内的许可证，且必须通过 schema、静态扫描、sha256 与路径穿越校验；network 与 `files:write` 属高风险权限，需要二次确认。

## 七、PDF 导出用法

1. 打开 Markdown 文档，用「文件 → 导出为 PDF…」（或命令面板搜索「导出为 PDF」/ `pdf.export`）调出对话框；「打印…」走系统打印对话框。
2. 对话框是单栏设置，按四组排列：
   - **页面**：纸张（**A4 / Letter / 自定义**，选自定义时出现宽 × 高两个毫米输入框，范围 50–2000）、方向（纵向 / 横向）、页边距（上 / 下 / 左 / 右，0–50 mm）；
   - **外观**：主题（跟随当前 / 浅色 / 深色）、代码配色（跟随主题 / GitHub Light / One Dark / Solarized）、图片最大宽度（25% / 50% / 75% / 100%）；
   - **装饰**：页码（关 / 页脚居中 / 页脚右侧）、目录页（按 H1–H3 生成章节列表）、页眉（无 / 文件名 / 自定义）、页脚（无 / 文件名 + 日期 / 自定义）——选「自定义」时下方多出一行输入框，限 60 字以内；
   - **输出**：文件名、保存位置（点「浏览…」选目录，默认是文档同目录）。
3. 点「导出」**直接写到对话框里定好的路径**，不再另弹保存框；导出中按钮变成进度条并可取消（取消不会留下半成品文件）。主进程用隐藏 `BrowserWindow` + `printToPDF` 生成，中文字体子集随打印页内联，生成的 PDF 自包含、可离线查看。
4. 浏览器（非 Electron）模式下不能导出 PDF / 打印：页码、目录、页眉页脚及其文字字段都会置灰，并提示请在打印窗口选择「另存为 PDF」。要导出 PDF 请使用安装版或便携版。

已知限制：目录不带页码；超长代码块（> 40 行）改为软换行以避免跨页截断；字体子集在 PDF 内部的元数据名为 `NotoSansSC-Thin`，但实际字形是 Regular 400。

## 八、开源许可

- `THIRD-PARTY-NOTICES.txt`：27 个运行时依赖 + 桌面外壳 + 内置字体的许可清单。
- `OFL.txt`：Noto Sans SC / Noto Serif SC 子集字体的 SIL Open Font License 1.1 全文及子集生成说明。
- 两份文件在源码中位于 `build\THIRD-PARTY-NOTICES.txt` 与 `src\assets\fonts\OFL.txt`，并随安装版 / 便携版一起分发到 `<安装目录或便携解包目录>\resources\licenses\`；根目录也有一份 `THIRD-PARTY-NOTICES.txt`。
- 应用内「帮助 → 关于 QuillPad」也可查看版本与许可说明。
- 开发者可用 `npm run notices` 重新生成清单、`npm run license:check` 校验无 GPL / AGPL / SSPL 依赖。

## 九、常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | 新建（选类型）/ 打开 / 保存 / 另存为 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+F` / `Ctrl+H` / `Ctrl+Shift+F` | 查找 / 替换 / 在文件中查找 |
| `Ctrl+Shift+P` | 命令面板（所有功能都在里面，记不住快捷键就用它） |
| `Ctrl+G` | 转到行 |
| `Ctrl+/` | 注释切换 |
| `Ctrl+D` | 复制当前行 |
| `Alt+↑` / `Alt+↓` | 上移 / 下移当前行 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 还原字号 |
| `Alt+Z` | 自动换行 |
| `Ctrl+Shift+1` / `2` / `3` | 源码 / WYSIWYG / 分栏直切 |
| `F1` | 快捷键速查表 |
| `F12` | 打开开发者工具（一般用不到） |

字号范围 14–300px：`Ctrl+=` / `Ctrl+-` 步进放大缩小，`Ctrl+滚轮` 也能调。行号固定 14px，不跟着正文字号一起缩放（正文放到 300px 时行号仍是 14px）。

### 插件命令快捷键

插件命令和内置命令一样，都能用键盘直接触发。键位由各插件包的 `plugin.json` 里 `contributes.commands[].key` 声明，装包后才生效、卸包即消失，F1 速查表和 `Ctrl+Shift+P` 命令面板里都会跟着显示。

**文本处理包**（`Ctrl+Alt+字母`）

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Alt+U` / `Ctrl+Alt+L` | 转为大写 / 转为小写 |
| `Ctrl+Alt+T` | 标题式大小写 |
| `Ctrl+Alt+A` / `Ctrl+Alt+D` | 行升序 / 行降序排序 |
| `Ctrl+Alt+E` / `Ctrl+Alt+X` | 删除重复行 / 删除空行 |
| `Ctrl+Alt+R` | 反转行序 |
| `Ctrl+Alt+B` / `Ctrl+Alt+Shift+B` | Base64 编码 / 解码 |
| `Ctrl+Alt+Q` | URL 编码 |
| `Ctrl+Alt+F` | JSON 格式化 |
| `Ctrl+Alt+M` | 按分隔符对齐列 |

**Markdown 增强包**

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Alt+G` | 规范表格对齐 |
| `Ctrl+Alt+O` | 生成目录 |
| `Ctrl+Alt+N` | 插入脚注 |
| `Ctrl+Alt+W` | 字数与阅读时长 |

**开发者工具包**（`Ctrl+Alt+Shift+字母`）

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Alt+Shift+R` | 正则匹配练习 |
| `Ctrl+Alt+Shift+E` | JSON 字符串转义 |
| `Ctrl+Alt+Shift+M` | MIME 类型查询 |
| `Ctrl+Alt+Shift+S` | 代码行排序 |

**市场里的社区包**（示例包，键位同样由清单声明）

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+Alt+Shift+C` | CSV 转 JSON 数组 |
| `Ctrl+Alt+Shift+P` / `Ctrl+Alt+Shift+U` | JSON 格式化为 2 空格 / 压缩成单行 |
| `Ctrl+Alt+Shift+J` | 由选中 JSON 生成 Schema |
| `Ctrl+Alt+Shift+D` / `Ctrl+Alt+Shift+N` / `Ctrl+Alt+Shift+L` / `Ctrl+Alt+Shift+X` | 按行首数字 / 自然序 / 行长排序，删除相邻重复行 |

约定：插件键位一律落在 `Ctrl+Alt`（macOS 为 `⌘+Option`）家族，不占用 `Ctrl+S`、`Ctrl+F` 这类内置主键位；万一第三方包声明的键位与内置命令撞车，宿主会放弃该键并在控制台留下记录，命令本身照常可用（从命令面板执行）。

顶部「主题」菜单里有 4 套：Ivory Light（默认）、Aurora Dark、Nord、Solarized Light。切主题时编辑区的语法高亮配色会一起换。

## 十、常见问题

### 双击 exe 没反应？

请确认没有设置环境变量 `ELECTRON_RUN_AS_NODE=1`（本机开发环境下曾有此设置，会让 Electron 以纯 Node 模式启动而不开窗口）。清除该变量后重试。

### 安装版和便携版能装在一起吗？

可以。安装版数据在 `%APPDATA%\QuillPad`，便携版数据在 exe 同目录 `QuillPad-Data\`，两者互不影响。

### 插件禁用后命令面板里还有残留？

禁用会真正注销 `plugin.<id>.<cmd>` 命名空间的命令，命令面板、菜单栏、工具栏三处同时移除；重新启用后恢复。若插件崩溃被自动禁用，需手动启用。
