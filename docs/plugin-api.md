# 插件 API

QuillPad 的插件是一组静态文件加一份 `plugin.json` 清单。插件运行在独立的 module **Worker**
沙箱里：拿不到 DOM、`require`、Node API 与文件系统，只能通过宿主注入的 `self.quillpad`
调用下面这些方法，且**每次调用都逐次鉴权** —— 权限不是安装时盖一次章就永久放行。

本文对应 `v1.0.0` 的冻结面。改动 API 需先开 Issue 讨论。

## 目录

- [30 秒上手](#30-秒上手)
- [包结构](#包结构)
- [plugin.json 字段](#pluginjson-字段)
- [权限](#权限)
- [API 参考](#api-参考)
- [返回值与错误码](#返回值与错误码)
- [沙箱限制](#沙箱限制)
- [本地调试与分发](#本地调试与分发)
- [参考实现](#参考实现)

## 30 秒上手

`plugin.json`：

```json
{
  "id": "yourname.shout",
  "name": "转大写",
  "nameEn": "Shout",
  "description": "把选中文本变成大写。",
  "descriptionEn": "Turns the selection into uppercase.",
  "author": "你的名字",
  "version": "1.0.0",
  "license": "MIT",
  "engines": { "quillpad": ">=1.0.0" },
  "main": "main.js",
  "permissions": ["editor:read", "editor:write"],
  "contributes": {
    "commands": [
      { "id": "shout", "title": "转大写", "titleEn": "Shout", "key": "Mod-Alt-h" }
    ]
  }
}
```

`main.js`：

```js
// 运行在 Worker 里：self.quillpad 是宿主注入的冻结对象
quillpad.commands.register('shout', '转大写', async () => {
  const { text } = await quillpad.editor.getSelection();
  await quillpad.editor.replaceSelection(text.toUpperCase());
  return true;
}, 'Shout');
```

把两个文件打成 zip（**zip 根目录下就是 `plugin.json`**，不要再套一层文件夹），
在「插件管理器 → 安装本地插件」选中即可。装上后命令立刻出现在命令面板与 F1 速查表里，
`Mod-Alt-h` 直接可用。

## 包结构

```
your-plugin/
├── plugin.json      清单（必需）
├── main.js          入口（由清单的 main 指定）
└── lib/*.js         可选，只能被 main.js 以相对路径 import
```

- 入口必须是 **ESM**（`import` / `export`），不能用 `require`。
- 动态 `import()` 只允许包内相对路径 `./` `../`，远端 URL 与 `data:` 载荷会被拒绝。
- 包内文件不限制层级，但路径不能越出包根目录。

## plugin.json 字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 形如 `yourname.plugin-name`：小写字母数字，至少一个点，点后允许连字符 |
| `name` | ✅ | 中文名，显示在插件管理器与命令面板 |
| `nameEn` | — | 英文名，英文界面下优先使用 |
| `description` | ✅ | 一句话说明 |
| `descriptionEn` | — | 英文说明 |
| `author` | ✅ | 作者名 |
| `version` | ✅ | `MAJOR.MINOR.PATCH`，不含 `v` |
| `license` | ✅ | 必须在白名单内：`MIT` / `Apache-2.0` / `BSD-2-Clause` / `BSD-3-Clause` / `ISC` / `0BSD` |
| `engines.quillpad` | ✅ | 支持的宿主版本，运算符支持 `^` `>=` `~` `>` `=` `*` |
| `main` | ✅ | 入口文件名，如 `main.js` |
| `permissions` | — | 权限数组，见下节；未声明即无权 |
| `contributes.commands` | — | 命令声明，见下 |
| `contributes.sidebarViews` | — | 侧栏视图声明 |

未知顶层字段会被直接拒绝（防止拼错字段却静默失效）。

### contributes.commands

```json
{ "id": "shout", "title": "转大写", "titleEn": "Shout", "key": "Mod-Alt-h" }
```

| 字段 | 说明 |
| --- | --- |
| `id` | 命令 id，小写字母开头，只含小写字母、数字与连字符；注册后全名为 `plugin.<插件id>.<命令id>` |
| `title` / `titleEn` | 显示名 |
| `key` | 快捷键，可省略。语法与内置命令同源：`Mod-Alt-u`、`Ctrl-Shift-k` |

快捷键有三条硬约束：

1. **必须带主修饰键**（`Mod` / `Ctrl` / `Cmd` / `Meta` / `Win`）—— 只写 `u` 会把正常键入抢走；
2. **只允许单段组合**，不能写两段式（如 `Mod-k o`）；
3. **不能占用内置键位**：撞车时该键被放弃、命令本身照常可用，控制台留一条记录。

> `contributes.menus` / `statusItems` / `themes` / `languages` 目前能通过清单校验，
> 但**宿主还没有对应的渲染实现**，写进去不会有任何效果。等实现后再补文档。

## 权限

安装时用户会逐项看到并确认；`network` 与 `files:write` 属于高风险权限，需二次勾选。

| 权限 | 授权后可用 | 用户看到的说明 |
| --- | --- | --- |
| `editor:read` | `editor.getSelection` · `editor.getText` | 读取你正在编辑的文本与选区 |
| `editor:write` | `editor.replaceSelection` · `editor.insertText` | 替换选区、插入文本，会改动当前文档 |
| `files:read` | `files.getCurrent` | 读取当前文档路径与内容 |
| `files:write` | `files.save` · `files.saveAs` | 触发保存或另存，可覆盖磁盘上的文件 |
| `clipboard` | `clipboard.read` · `clipboard.write` | 读取或写入系统剪贴板 |
| `network` | `net.fetch` | 该插件可访问网络，可能把文件内容发送到外部服务器 |
| `settings` | `storage.get` · `storage.set` | 保存插件自己的配置（≤ 1 MB） |

未授权调用不会「静默失败」，而是返回 `{ ok: false, code: 'EPERM_*' }`。
声明了用不到的权限会让用户在安装时多犹豫一秒，**只声明实际用到的**。

## API 参考

所有方法都返回 `Promise`：成功时 resolve 结果对象，失败时 reject 一个
`{ code, message }` 错误对象。调用超时上限 **10 秒**（`ETIMEOUT`）。

### 命令与视图

```js
quillpad.commands.register(id, title, run, titleEn?)
quillpad.ui.registerSidebarView({ id, title, titleEn, render })
```

- `run` 是命令执行体，可以是 `async`；返回值通过 RPC 回传，抛错会变成一条失败记录。
- `render` 收到容器节点信息，用于在侧栏视图里绘制自己的界面（只能返回宿主支持的描述，
  不能直接操作 DOM）。

### 编辑器

```js
quillpad.editor.getSelection()          // → { text, from, to }
quillpad.editor.getText()               // → { text }
quillpad.editor.replaceSelection(text)  // → { ok: true }
quillpad.editor.insertText(text)        // 同上，replaceSelection 的别名
```

`from` / `to` 是文档偏移量（与 CodeMirror 的 `EditorState` 一致，按 UTF-16 码元计数）。

### 文件

```js
quillpad.files.getCurrent()  // → { path, name, content }
quillpad.files.save()        // → { ok: true }，等价于用户按 Ctrl+S
quillpad.files.saveAs()      // → { ok: true }，弹出「另存为」
```

未保存过的新文件，`path` 是显示名（如 `未命名.md`），不是空串。

### 剪贴板

```js
quillpad.clipboard.read()      // → { text }
quillpad.clipboard.write(text) // → { ok: true }
```

读剪贴板在用户拒绝浏览器授权时会返回空串，不抛错。

### 私有存储

```js
quillpad.storage.get(key)         // → { value }，未设置时为 null
quillpad.storage.set(key, value)  // → { ok: true }
```

单插件上限 **1 MB**，超出返回 `ESTORAGE_FULL`。值必须是可 JSON 序列化的数据。
存储随插件卸载一并删除。

### 网络

```js
quillpad.net.fetch(url, options)  // → { ok: true, data }
```

`options` 透传给主进程的 `net` 请求。没有 `network` 权限时**不会发起任何真实请求**，
直接返回 `EPERM_NETWORK`。

### 提示

```js
quillpad.ui.showToast(message, type)  // type: 'info' | 'success' | 'warn' | 'error'
```

### 事件

```js
quillpad.events.on(event, callback)
```

向宿主登记对某个事件的关注；回调用命令 id 关联。

## 返回值与错误码

```js
{ ok: true, ... }                 // 成功
{ ok: false, code, message }      // 业务失败（权限不足、参数不合法等）
reject({ code, message })         // RPC 层失败（超时、插件崩溃等）
```

| 错误码 | 含义 |
| --- | --- |
| `EPERM_EDITOR_READ` | 未声明 `editor:read` |
| `EPERM_EDITOR_WRITE` | 未声明 `editor:write` |
| `EPERM_FILES_READ` / `EPERM_FILES_WRITE` | 未声明 `files:read` / `files:write` |
| `EPERM_CLIPBOARD` | 未声明 `clipboard` |
| `EPERM_NETWORK` | 未声明 `network`，或宿主未开网络通道 |
| `EPERM_SETTINGS` | 未声明 `settings` |
| `ESCHEMA` | 参数不合规（如命令 id 不合法） |
| `ENOTFOUND` | 调用了不存在的 API |
| `ESTORAGE_FULL` | 私有存储超过 1 MB |
| `ETIMEOUT` | 单次调用超过 10 秒 |
| `EINVALID` | 编辑器 / 参数状态不可用 |

错误文案本身是双语的：宿主按当前界面语言返回中文或英文 `message`。

## 沙箱限制

插件启动前，引导脚本会先删除这些全局：`fetch`、`XMLHttpRequest`、`WebSocket`、
`importScripts`、`document`、`process`、`require`、`__dirname`、`__filename`、
`indexedDB`、`caches`、`SharedWorker`、`Worker`、`EventSource`、`WebTransport`、
`BroadcastChannel`、`eval`、`Function`。

**安装前还有一道静态扫描**：命中危险调用会直接拒绝安装并报出行号，规则包括
`eval(`、`new Function(`、`document.`、`fetch(`、`XMLHttpRequest`、`importScripts(`、
`process.`、远程动态 `import(` 等。不要试图绕过 —— 运行时还有第二道兜底。

**心跳**：Worker 每秒上报一次，连续 5 秒无响应会被终止并自动禁用插件
（插件管理器里状态显示为「已崩溃」，可手动重新启用）。

## 本地调试与分发

1. 按上面的结构建目录，`main.js` 里直接 `console.log` 就能在开发工具里看到输出。
2. 打包成 zip：根目录下就是 `plugin.json`，不要把外层文件夹打进去。
3. 「插件管理器 → 安装本地插件」选择该 zip；改完重装即生效（同名插件会覆盖升级）。
4. 分发时把 zip 交给用户即可，不需要上架市场；上架需要向仓库提交 `plugin.json`
   与包，并跑通 `npm run test:plugins` 的目录校验。

`npm run plugins:pack` 会把 `public/plugins/*` 下的源目录打成社区分发的 zip，
并回填 `catalog.json` 里的 `sha256` —— 安装前宿主会逐字节自检。

## 参考实现

三个官方包都是 MIT，直接读源码比看文档快：

| 包 | 内容 | 值得看的地方 |
| --- | --- | --- |
| `quillpad.text-tools` | 13 条命令 | 纯文本变换、选区读写、多命令批量注册 |
| `quillpad.md-tools` | 4 条命令 | Markdown 结构处理（表格、列表） |
| `quillpad.dev-tools` | 4 条命令 + 1 个侧栏视图 | 侧栏视图注册与渲染 |

源码在 `public/plugins/` 下。

## 兼容性承诺

- `v2` 冻结面内的 API 不会在 1.x 里移除或改签名；新增以追加方式进行。
- 清单字段同理：新增字段会先经过一个 minor 版本的告警期。
- 破坏性变更只在大版本里发生，并在 [CHANGELOG](../CHANGELOG.md) 里写明迁移方式。
