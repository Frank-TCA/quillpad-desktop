# 贡献指南

感谢你愿意为 QuillPad 出力。本文档说明开发环境、代码约定与提交流程。

## 目录

- [行为准则](#行为准则)
- [开发环境](#开发环境)
- [项目结构](#项目结构)
- [代码风格](#代码风格)
- [提交 Pull Request](#提交-pull-request)
- [提交 Bug](#提交-bug)
- [开发自己的插件](#开发自己的插件)

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。请保持友善、就事论事。

## 开发环境

**必需**

- Node.js **20 或以上**（推荐 22 LTS）
- npm 10 或以上

**推荐**

- Windows 10 / 11（Electron 打包目标平台）
- VS Code + 推荐扩展：ESLint、Prettier

```bash
git clone https://github.com/Frank-TCA/quillpad-desktop.git
cd quillpad-desktop
npm install
npm run dev        # 浏览器开发模式，热更新
npm run desktop    # Electron 桌面壳开发模式
```

> 国内网络安装依赖可能较慢，可临时指定镜像：`npm install --registry=https://registry.npmmirror.com`

## 项目结构

```
src/
├── app.js          应用装配入口（DOM 挂载、模块接线、生命周期）
├── core/           与 UI 无关的核心逻辑
│   ├── state.js    全局状态（标签、设置、光标）
│   ├── commands.js 命令注册表（菜单 / 快捷键 / 命令面板共用）
│   ├── actions.js  命令的具体实现
│   ├── settings.js 持久化设置与常量
│   ├── print.js    PDF 导出与打印页构建
│   └── plugins/    插件宿主、清单校验、沙箱
├── editor/         CodeMirror 扩展
│   ├── editor.js   编辑器实例与 Compartment 装配
│   ├── languages.js 语言定义与加载器
│   ├── cm-themes.js 主题与语法色板
│   ├── marks.js    5 色文本标记 StateField
│   └── wysiwyg/    Markdown 就地渲染（装饰、表格、图片、公式）
├── ui/             自绘界面组件（无框架）
├── styles/         CSS 变量主题与样式表
└── data/           静态数据（语言清单、插件目录）

desktop/            Electron 主进程（main.cjs）、preload、IPC
build/              图标生成、afterPack 钩子、NSIS 安装器脚本
scripts/            测试与构建辅助脚本（端到端 / 视觉回归类脚本需先起本地服务）
docs/               架构图（Mermaid：类图、时序图）
```

### 关键约定

- **命令集中注册**：任何可触发动作都注册为命令（`src/core/actions.js`），菜单、工具栏、命令面板、快捷键共享同一份定义，不重复实现。
- **状态单一来源**：`src/core/state.js` 是唯一状态树；UI 只读不缓存。
- **样式走变量**：颜色、间距、圆角一律用 `src/styles/theme.css` 的 CSS 变量，不硬编码。四套主题靠变量切换。
- **无 UI 框架**：界面全部手写 DOM + 事件委托，保持首屏体积与交互延迟可控。

## 代码风格

- **ESM**：渲染层为原生 ES Module；主进程 `desktop/*.cjs` 为 CommonJS。
- **JSDoc**：每个导出函数写 JSDoc（中文），标注 `@param` / `@return`。
- **命名**：变量/函数 camelCase，常量 UPPER_SNAKE，CSS 类 `qp-block__element--modifier`（BEM 变体）。
- **缩进**：2 空格，单引号，语句结尾分号。
- **注释**：解释「为什么」而非「是什么」。遇到与直觉相悖的实现（例如为了绕过某个浏览器/CodeMirror 行为），务必写清原因。

修改后请确保以下命令通过：

```bash
npm run test:v2:unit   # 纯函数单元测试
npm run license:check  # 依赖许可合规
npm test               # 集成测试
```

> `npm test` 有 7 套用例（menu-fix / smoke / p1 / find-panel / statusbar / edit-ops / newfile）
> 会连 `http://localhost:4173`，直接跑首条就 `ERR_CONNECTION_REFUSED`。先另开终端
> `npm run build && npm run preview`，或 `npm run app` 起开发服务器。

涉及界面改动时，额外跑：

```bash
npm run app            # 另开终端起 http://localhost:4173
npm run test:v2        # 端到端验收
npm run test:e2e:full  # 完整端到端套件（较慢，需先 npm run preview 或 npm run app）
npm run test:visual    # 截图 + 视觉回归（同上，需先起服务）
```

## 提交 Pull Request

1. **先开 Issue**：较大的改动（新增功能、重构）请先开 Issue 讨论方向，避免白做。
2. **Fork + 分支**：从 `main` 切出功能分支，命名 `feat/xxx`、`fix/xxx` 或 `docs/xxx`。
3. **小步提交**：一个提交做一件事。提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
   ```
   feat(editor): 支持 Ctrl+滚轮缩放字号
   fix(tabs): 标签栏溢出时滚动位置错误
   docs(readme): 补充构建步骤
   ```
4. **保持整洁**：不要提交 `node_modules/`、`dist/`、编辑器配置、调试脚本、截图。
5. **PR 描述**：说明「改了什么 / 为什么改 / 怎么验证」。界面改动请附截图或录屏。
6. **CI 必须绿**：PR 会自动跑单元测试与许可检查。

### 版本号约定

应用版本只写两处，且必须一致（`npm run license:check` 会校验）：

- `package.json` → `version`
- `src/core/version.js` → `APP_VERSION`

采用语义化版本：`MAJOR.MINOR.PATCH`。

## 提交 Bug

请使用 [Bug 报告模板](https://github.com/Frank-TCA/quillpad-desktop/issues/new?template=bug_report.yml)，务必包含：

- QuillPad 版本（`帮助 → 关于`）
- Windows 版本
- 复现步骤（能稳定复现的最小步骤）
- 期望行为 vs 实际行为
- 截图或录屏（如果是界面问题）

## 开发自己的插件

插件是一组静态文件 + `plugin.json` 清单，运行在 Worker 沙箱内。

```json
{
  "id": "yourname.my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "你的名字",
  "license": "MIT",
  "engines": { "quillpad": ">=1.0.0" },
  "main": "index.js",
  "permissions": ["editor:read", "editor:write"],
  "contributes": { "commands": [{ "id": "hello", "title": "打个招呼" }] }
}
```

**硬性要求**

- `license` 必须在白名单内：MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / 0BSD
- `permissions` 只声明实际用到的能力（用户安装时会看到并逐项确认）
- 不得使用 `eval`、`new Function`、动态 `import()` 远程 URL（安装前静态扫描会拦截）

插件管理器中「导入本地插件包」可加载 `.zip`，便于本地调试。

## 问题咨询

- 使用问题 → [Discussions](https://github.com/Frank-TCA/quillpad-desktop/discussions)
- 安全漏洞 → 请勿公开 Issue，见 [SECURITY.md](SECURITY.md)
