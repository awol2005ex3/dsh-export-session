# dsh-session-export

DeepSeek Harness（`dsh`）插件：把**当前会话的完整内容**一键导出为
**Markdown（`.md`）/ Word（`.docx`）/ PDF（`.pdf`）**。

对标 [`dsh-md-table-export`](https://github.com/)，但导出范围是整段对话，
而非单个 Markdown 表格。

## 一、安装（Node 半 + 浏览器半一次完成）

```bash
# 1. 安装依赖
npm install

# 2. 类型检查 + 单元测试（质量门）
npm run typecheck
npm test

# 3. 构建（tsc 编译 lib/ + 把 client.js 包成 dsh 闭包工厂外壳）
npm run build

# 4. 把当前插件加入 web profile（同时作为 bundle 层进入配置树）
npx @deepseek-ai/dsh plugin --profile web add .

# 5. 重启 dsh web 进程，刷新浏览器页面
```

安装后效果：

- **浏览器半**：dsh Web 对话页右下角出现「导出 Markdown / 导出 Word / 导出 PDF」浮动工具条。
- **Node 半**：对话中让模型调用 `export_session` 工具导出文件。

> 注意：插件集合的变更在宿主重启后生效（客户端模块系统按名缓存包元数据）；
> 若只改了 bundle 内容，开发环境经 HMR 的 `rebuilt()` 到达图。

### 配置（`overlay` / `cordis.yml`）

patch 是按 `id` 整体替换 `config`（非深合并），overlay 需写全字段：

```yaml
- id: session-export
  name: dsh-session-export
  config:
    defaultOutputDir: "/tmp/dsh-exports"   # 缺省导出目录；留空则回退到会话 cwd → 进程 cwd
    defaultFormat: md                       # md | docx | pdf
```

## 二、使用

### 方式 A：对话里触发（Node 半，数据最完整）

直接对模型说「把当前会话导出成 PDF / Word / Markdown」。模型会调用
`export_session` 工具，把文件写到 `defaultOutputDir`（或对话里指定的
`outputDir`），并以文本卡片回告绝对路径。

```
用户：把这个会话导出成 PDF
模型：已导出会话到 /tmp/dsh-exports/标题-会话尾号-2026-09-01.pdf
```

### 方式 B：Web 浮动按钮（浏览器半，扫描已渲染 DOM）

会话页右下角的工具条提供：

- **导出 Markdown**：把当前已渲染的消息区内容拼成 Markdown，触发浏览器下载。
- **导出 Word**：经 CDN 动态注入 `docx` 库（jsdelivr），把页面文本渲染成 `.docx` 下载。
- **导出 PDF**：调用 `window.print()` 走浏览器「另存为 PDF」对话框。

> 适用：快速保存肉眼可见的对话。长会话需先滚动加载全部消息，否则只导出已渲染部分。

## 三、工具参数（`export_session`）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `format` | `md` \| `docx` \| `pdf` | ✅ | 导出格式 |
| `outputDir` | string | | 输出目录（绝对或相对）；缺省用 Config `defaultOutputDir` → 会话 cwd → 进程 cwd |
| `fileName` | string | | 文件名（不含扩展名）；缺省 `标题-会话尾号-日期` |
| `title` | string | | 文档标题，缺省「会话导出」 |
| `includeToolCalls` | boolean | | 包含工具调用与结果，默认 `true` |
| `includeReasoning` | boolean | | 包含模型推理过程（reasoning block），默认 `false` |
| `includeInjectedContext` | boolean | | 包含插件注入的上下文（AGENTS.md / skills / 文件变更通知等），默认 `false` |
| `includeTimestamps` | boolean | | 包含时间戳与元信息（模型 / 服务商 / 回复数 / 每条时间），默认 `true` |

示例：

```
用户：导出会话为 docx，标题写「Rust 并发笔记」，包含推理过程
```

## 四、为什么能「一个包、两端生效」

较新版本的 deepseek-harness 提供**客户端模块系统**（`ctx.clientModules`，
见主仓库 `docs/subsystems/client-modules.zh.md`）：宿主扫描所有声明了
`dsh.client`（`platform: 'web'`）并导出 `exports["./client"]` 的包，组合进浏览器
启动图（`window.__DSH_BOOT__`），经 `/plugins/<id>/client.js` 路由把 bundle 送进
浏览器执行。因此：

- 无需 Tampermonkey 等用户脚本管理器；
- 无需 fork 主仓库或参与 web-app from-source 构建；
- 一个 npm 包同时声明 Node 半与浏览器半，`plugin --profile web add .` 即两端生效。

浏览器 bundle 采用官方「惰性 CJS 闭包工厂」契约：脚本执行时只调用
`window.__ModuleLoader__.load({ id, factory })` 注册工厂；副作用位于工厂闭包内，
待 shell 物化时运行。`scripts/wrap-client.mjs` 按官方 banner/intro/footer 契约
包装 `lib/client.js`。

## 五、目录结构

```
dsh-session-export/
├── package.json                 # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml             # bundle 层贡献的配置行（Node 半插件注册）
├── scripts/wrap-client.mjs      # 构建后处理：包装客户端闭包工厂外壳
├── tsconfig.json                # strict + NodeNext
├── vitest.config.ts
├── src/
│   ├── index.ts                 # 插件四导出规范：name / inject / Config / apply（Node 半）
│   ├── tool.ts                  # defineTool 注册 export_session
│   ├── collect.ts               # 从 exec.agent.session 采集结构化 transcript（四开关）
│   ├── md-blocks.ts             # 轻量块级 Markdown 解析器（三种格式共用）
│   ├── render-markdown.ts       # transcript → Markdown
│   ├── render-docx.ts           # transcript → .docx（docx 包，真表格 + 中文字体）
│   ├── render-pdf.ts            # transcript → .pdf（pdfkit + fontkit 嵌入系统字体）
│   ├── fonts.ts                 # PDF 中文字体探测（Windows/macOS/Linux + 环境变量覆盖）
│   ├── export.ts                # 统一调度：采集 → 选渲染器 → 落盘（路径清洗/建目录/取消）
│   └── client.ts                # 浏览器半模块体（编译+包装为 lib/client.js）
└── test/                        # vitest：块解析/采集/三种渲染器/工具执行集成
```

## 六、实现要点

- 数据来自 `exec.agent.session`：`deriveMessages()` 拿到折叠后的正确消息序列（0.1.7+ 里
  工具结果是 `role: 'tool'` 的一等消息），`snapshotEvents()`（0.0.x 回退 `events`）仅用于
  补全时间戳、中断标记与工具名（见 `packages/core/session`、`packages/llm`）。
- PDF 必须嵌入本机中文字体（`pdfkit` 内置字体无中文）。`src/fonts.ts` 自动探测
  Windows / macOS / Linux 的中文字体；也可用环境变量 `DSH_EXPORT_PDF_FONT`
  强制指定（值为字体文件路径或 `字体名@字体路径`）。
- DOCX 用 [`docx`](https://docx.js.org) 真表格 + 中文字体；三种格式共用同一套
  块级 Markdown 解析器（`src/md-blocks.ts`），排版一致。

## 七、Known Limitations

- Web 按钮是**尽力而为版**：扫描页面已渲染的消息 DOM，只能导出肉眼可见部分；
  长会话需先滚动加载。若需要完整数据，用方式 A（Node 半从 session 取数）。
- PDF 依赖本机中文字体文件；纯服务器/容器环境若探测不到，请设
  `DSH_EXPORT_PDF_FONT` 指到某 `.ttf/.ttc/.otf`。
- Node 半的 `docx` / `pdfkit` / `fontkit` 经 npm 安装；浏览器半导出不含这些依赖
  （Markdown 走 Blob 下载，PDF 走 `window.print()`）。浏览器半的 **Word 导出**例外：
  经 CDN 动态注入 `docx` 库（jsdelivr `docx@9.7.1/dist/index.iife.js`）生成 `.docx`，
  首次点击需联网拉取该库（约 1.1MB，失败会弹窗提示检查网络）。
- 客户端模块系统要求较新的 deepseek-harness 版本（存在 `ctx.clientModules` 服务
  与 `dsh.client` 包声明扫描）。
- Node 半按 deepseek-harness **0.1.7-rc.2** 的消息模型实现：工具结果是 `role: 'tool'`
  的一等消息、`source.kind` 由各生产者自行声明、事件日志经 `snapshotEvents()` 读取
  （0.0.x 的 `events` getter 仍作为回退读法保留）。更老的 harness 不受支持：旧式
  `tool-result` 内容块只会被展开为文本，不再识别为工具结果条目。

## 八、质量门

| 检查项 | 命令 |
| --- | --- |
| 类型安全 | `npm run typecheck`（`strict`，无 any 逃逸） |
| 单元测试 | `npm test`（vitest） |
| 构建 + 外壳包装 | `npm run build`（tsc → wrap-client.mjs） |
| 组合验证 | `npx @deepseek-ai/dsh --profile web --dump-config` |

## License

MIT
