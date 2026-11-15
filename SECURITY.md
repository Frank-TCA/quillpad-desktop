# 安全策略

## 支持的版本

| 版本 | 是否接受安全更新 |
| --- | --- |
| 1.x | ✅ |

## 报告漏洞

**请勿通过公开 Issue 报告安全漏洞。**

请通过以下方式私下联系维护者：

- 使用 GitHub 的 [私密漏洞报告](https://github.com/Frank-TCA/quillpad-desktop/security/advisories/new) 功能（推荐）

请在报告中包含：

- 漏洞类型与影响范围
- 复现步骤或 PoC
- 受影响的版本
- 可能的修复建议（如有）

维护者会在 **72 小时内**确认收到，并在修复发布后公开致谢（除非你要求匿名）。

## 安全边界说明

QuillPad 是本地桌面应用，安全模型围绕「不信任第三方插件」设计：

### 插件沙箱

- 插件运行在独立的 module **Worker** 中，无法直接访问 DOM、`require`、Node API 或文件系统
- 每次 API 调用由主线程**逐次鉴权**（`editor:read` / `editor:write` / `files:read` / `files:write` / `clipboard` / `network` / `settings`）
- Worker 5 秒心跳无响应会被终止并自动禁用插件
- 安装前**静态扫描**拦截 `eval`、`new Function`、远程动态 `import()`、`process` 访问等危险调用，命中即拒绝并报告行号
- 主进程**独立复核**清单（不信任渲染层传来的结论）
- License 白名单：仅 MIT / Apache-2.0 / BSD / ISC / 0BSD

### 渲染进程隔离

- 开启 `contextIsolation`，`nodeIntegration` 关闭
- 渲染层只能通过 `preload.cjs` 暴露的窄接口访问主进程能力
- 所有 IPC 通道显式白名单

### CSP 与网络

- 生产构建不加载任何 CDN / 外部脚本
- PDF 导出页自包含：字体 data: 内联、图片内联或占位、无脚本、无外链

### 已知的非目标

- **不防御本地提权**：应用以当前用户权限运行，不尝试抵御已获得本机代码执行权的攻击者
- **不验证插件来源真实性**：插件签名校验已预留字段但尚未启用，当前依赖用户自行确认来源
- **未签名二进制**：本项目未购买代码签名证书，Windows SmartScreen 会告警。这是发布渠道限制，不是漏洞

## 依赖安全

- 全部依赖为 MIT / Apache-2.0 / BSD / ISC / OFL，无 GPL / AGPL / SSPL
- `npm run license:check` 在 CI 中校验许可合规
- 建议贡献者在提交 PR 前执行 `npm audit`
