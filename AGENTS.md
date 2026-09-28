# AGENTS.md — dsh-session-export

本文件为后续开发（人或 agent）提供**代码地图与硬约束**，无需每次重读全部源码。
代码变更后请同步更新本文件与 README.md。

## 1. 项目定位

DeepSeek Harness（`dsh`）的独立插件，把**当前会话整段内容**导出为
Markdown / Word(.docx) / PDF。对标 `dsh-md-table-export`，但对象是整段对话而非单个表格。

双交付架构（一个 npm 包、两端生效）：

| 半 | 文件 | 形态 | 作用 |
| --- | --- | --- | --- |
| Node 半 | `src/index.ts` → `lib/index.js` | Cordis 插件（bundle patch） | 注册 `export_session` 工具，从 `exec.agent.session` 取数落盘 |
| 浏览器半 | `src/client.ts` → `lib/client.js` | dsh Web 客户端模块（`dsh.client.platform: "web"`） | 会话页右下角浮动工具条：导出 Markdown / Word / PDF（均为扫描 DOM 的「尽力而为」版） |

## 2. 数据流（必读）

```
dsh session
  └─ exec.agent.session           (Agent.session，见 packages/core/agent)
       ├─ deriveMessages()        → 折叠后的正确消息序列（含 tool-call 块 + role:'tool' 的结果消息）
       └─ snapshotEvents()        → 仅补 time / 中断标记 / 工具名（message.id 做 key；0.0.x 回退 events[]）
  ↓ collectTranscript(session, opts)
Transcript { meta, entries[] }    (src/collect.ts)
  ↓ 三种渲染器（共用 src/md-blocks.ts 的块解析）
  ├─ renderMarkdown → string
  ├─ renderDocx    → Buffer (.docx, docx 包真表格)
  └─ renderPdf     → Buffer (.pdf, pdfkit + fontkit 嵌系统字体)
  ↓ exportSession(args, ctx)      (src/export.ts：清洗路径/建目录/尊重 signal)
落盘文件 + 返回 ExportResult{ path, format, byteSize }
```

`TranscriptEntry.kind` ∈ `user | assistant | tool | context`：
- `user`：真人文本 / 图片（`ContentBlock`）
- `assistant`：正文 + 可选 `reasoning` + `toolCalls[]`（0.1.7+ 还会带 `interrupted`）
- `tool`：0.1.7+ 的一等 `role: 'tool'` 消息（`toolCallId` / `isError` 在消息本身上），按 `callId` 与助手的 tool-call 配对
- `context`：注入的上下文（`source.kind !== 'user'` 的 user 消息），标签 `plugin` 取 `source.kind`（0.0.x 取 `source.plugin`）
- 四条开关：`includeToolCalls` / `includeReasoning` / `includeInjectedContext` / `includeTimestamps`
  （`includeInjectedContext` 默认 false，过滤注入噪音消息）

## 3. 代码地图（src/）

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `collect.ts` | 会话采集，产出与渲染无关的结构化 `Transcript` | `collectTranscript(session, opts)`, `Transcript`, `TranscriptEntry`, `TranscriptMeta`, `TranscriptOptions`, `DEFAULT_TRANSCRIPT_OPTIONS`, `formatTimestamp(ms)` |
| `md-blocks.ts` | 轻量块级 Markdown 解析器（标题/代码/表格/引用/列表/分隔线 + 行内 run） | `parseMarkdownBlocks`, `Block`, `parseInline`, `inlineToPlain` |
| `render-markdown.ts` | `Transcript → Markdown` | `renderMarkdown(transcript, title?)` |
| `render-docx.ts` | `Transcript → .docx`（真表格 + 中文字体） | `renderDocx(transcript, title?): Promise<Buffer>` |
| `render-pdf.ts` | `Transcript → .pdf`（pdfkit 排版 + 字体） | `renderPdf(transcript, title?, signal?): Promise<Buffer>`, `markdownToPlain(md)` |
| `fonts.ts` | PDF 中文字体探测 | `resolveFonts(): FontSpec`, `FontNotFoundError` |
| `export.ts` | 统一调度落盘 | `exportSession(session, args, fallbackDir, signal?)`, `ExportArgs`, `ExportResult`, `ExportFormat`, `resolveOutputDir(dir, fallback)`, `sanitizeFileName(name)` |
| `tool.ts` | `defineTool` 注册 `export_session` | `createExportTool(config)` |
| `index.ts` | 插件四导出规范 | `name`, `inject`, `Config`（schemastery `Schema.object`）, `apply(ctx, config)` |
| `client.ts` | 浏览器半模块体（`apply(ctx, config?)` 供 shell 物化）。扫描 `[data-chat-flow-kind]` DOM 注入浮动按钮：Markdown（Blob 下载）/ Word（CDN 注入 docx 库渲染）/ PDF（`window.print()`） | `apply`、`loadDocx`、`markdownToDocxParagraphs`、`exportDocx` |

## 4. 硬编码契约（改前必看）

- **插件四导出**：`name` 字符串、`inject: ['tools']`、`Config` 为 schemastery `Schema.object`、
  `apply(ctx, config)` 内所有注册走 `ctx.effect(() => {...})` 并返回 disposer。
- **`defineTool` 的 `output.schema`**：`ValueSchemaSpec`，object 类型必须带 `additionalProperties: false`
  （精确收窄返回类型，避免 `Record<string, JsonValue>` 索引签名污染 `ExportResult`）。
- **`exec.agent.session`**：工具 `execute(args, exec)` 的第二个参数 `exec` 携带 `agent?.session`
  与 `signal`（`exec.signal` 需遵守取消）。
- **harness 版本契约**：`@deepseek-ai/dsh-tools` peer/dev 均为 `^0.1.7-rc.2`；采集层还
  直接 `import type` 了 `@deepseek-ai/dsh-llm`（`Message` / `ContentBlock` / `ToolResultMessage`）
  与 `@deepseek-ai/dsh-session`（`Session` / `SessionEvent`）——它们经 dsh-tools 的 peer
  依赖解析到顶层 `node_modules`（均为类型导入，运行期不解析）。升级 harness 时必须同步
  核对这三件事：`ContentBlock` 联合成员、工具结果的消息形态、会话事件日志的读法。
- **`cordis.patch.yml`**：声明 `- insert: [{ id: session-export, name: dsh-session-export }]`，
  由 `package.json` 的 `dsh.bundle.patch` 指向；`dsh.client` 声明 `platform: web` + `immediately: true`。
- **客户端闭包工厂**：`lib/client.js` 经 `scripts/wrap-client.mjs` 包装成
  `window.__ModuleLoader__.load({ id, factory })`，脚本执行期无副作用，副作用在工厂闭包内。

## 5. 开发约定

- TypeScript **strict**，禁止 `any` 逃逸；新逻辑优先纯函数（便于 vitest）。
- 三种渲染器**共用 `md-blocks.ts`** 的块解析，保证排版一致；新增 Markdown 语法支持只改一处。
- `client.ts` 是浏览器环境：**禁用任何 node 内置模块 import**（fs/path），只用 DOM + `window.*`。
- 命名：`Transcript*`（采集层）、`render*(transcript, ...)`（渲染层）、`Block/Inline`（语法树）。

## 6. 质量门（每次改动后跑）

```bash
npm run typecheck   # tsc --noEmit（strict）
npm test            # vitest（解析/采集/三种渲染器/工具集成，当前 38 用例）
npm run build       # tsc + scripts/wrap-client.mjs；构建后 node --check lib/client.js 验语法
```

## 7. 踩坑记录（已验证）

1. **pdfkit 无中文字体** → 用 `fontkit` 注册本机字体；`.ttc` 集合需 `OpenType` 的
   `family` 取名（如 `'Microsoft YaHei'`），否则全字重塌成一种。探测逻辑见 `fonts.ts`，
   可用 `DSH_EXPORT_PDF_FONT`（路径或 `名@路径`）强制覆盖。
2. **`render-pdf.ts` 的 `drawRow` 里 `minCell` 必须在使用前声明**（曾触发 TDZ 运行时错误）。
3. **构建后必须跑 `wrap-client.mjs`**：它把 `lib/client.js` 包成惰性 CJS 闭包工厂外壳
   （`window.__ModuleLoader__.load({ id, factory })`）。`src/client.ts` 必须零 import/export，
   否则 tsc 生成的具名 `export` 会让经典脚本语法错误、整段不执行（见第 7 条）。
4. **`deriveMessages()` vs 原始 `events`**：只用 `deriveMessages()` 会丢时间戳与工具名，
   必须回查 `events` 按 `message.id` 补；`source.kind === 'plugin'` 是注入噪音，默认排除。
5. **patch `config` 整块替换**：overlay 需写全 `defaultOutputDir` + `defaultFormat` 两字段，
   不能只写其中一个（否则另一项被清掉）。
6. **`export_session` 工具参数 `format` 必填**；缺省格式来自 `Config.defaultFormat`，非工具参数。
7. **`src/client.ts` 必须零 `import`/`export`**：浏览器半被当作经典脚本加载。若源文件写
   `export function apply`，tsc 生成的具名 `export` 会使整段脚本（含首行的 `__ModuleLoader__.load`）
   语法错误、工厂永不注册，宿主报 `loaded without registering "<pkg>"`。正确写法：`apply`
   为普通函数声明 + 文件末尾 `module.exports = { name, inject, apply }`，交给 `wrap-client.mjs` 包外壳。
8. **浏览器半生成 .docx 走 CDN 注入 `docx` 库**（IIFE 全局 `window.docx`，见 `loadDocx()`），
   与参考项目注入 SheetJS 同模式——client 模块不能 import 任何包。`DOCX_CDN` 锁定
   `docx@9.7.1/dist/index.iife.js`：docx 9 的 IIFE 全局名即 `docx`，`Packer.toBlob()` 在浏览器
   返回 Blob。务必在 `loadDocx().catch()` 里 `alert` 提示网络失败，不要静默吞错。
9. **harness 0.1.7-rc.2 的消息模型变了（曾让 `npm run build` 直接报 TS2678/TS2339）**：
   - `ContentBlock` 联合里**没有 `tool-result` 了**（现为 `text | reasoning | image | file |
     tool-call | tool-addition | tool-removal`）。工具结果是一等的 `role: 'tool'` 消息
     （`ToolResultMessage`：`toolCallId` / `isError` 在消息上，`source: { kind: 'tool', callId }`）；
     `switch (block.type)` 里写 `case 'tool-result'` 会因比较类型不重叠而编译失败——旧块只在
     `default` 分支里按鸭子类型展开为文本（不再算作工具结果条目）。
   - `Session` **没有 `events` getter 了**（`Object.getOwnPropertyNames(Session.prototype)` 只剩
     `eventAt` / `snapshotEvents` / `ownEvents` / `deriveMessages` …）。采集层改为优先调
     `snapshotEvents()`（官方已标记 deprecated，但仍是唯一同步读法，官方
     `dsh-session-projection` 同样如此），失败再回退 `events`。
   - **`source.kind === 'plugin'` 不存在了**：`MessageSourceMap` 是可合并扩展的，每个生产者
     声明自己的 kind（`'user'` / `'model'` / `'tool'` / `'system-prompt'` / `'user-approval'` /
     `'model-selection'` / `'tool-registry'` …），真人输入固定 `kind: 'user'`。因此「注入上下文」
     的判据是 **`role === 'user' && source.kind !== 'user'`**，标签取 `source.kind`，语义标签取
     `source.form`（`ContextForm`）。
   - 工具名不再强依赖事件日志：派生消息里 assistant 的 `tool-call` 块已含 name/arguments，
     事件里的 `tool/call` 仅作补充（还带调用时间）。

## 8. 如何扩展

- **新增导出格式**：在 `md-blocks.ts` 之上加 `render-xxx.ts`（`(transcript, title?) => Buffer|string`），
  在 `export.ts` 的 `format` 分发里加分支，并在 `tool.ts` 的 `format` 枚举与 `Config` 里登记。
- **新内容开关**：在 `CollectOptions` / `TranscriptEntry` 加字段，`collect.ts` 采集，
  三个 `render-*` 各自决定是否使用；工具参数与 `Config` 同步曝露。
- **Web 按钮升级为「完整数据」**：把 `client.ts` 从「扫描 DOM」改为调用后端 `session`
  RPC（`packages/client` 的 `session.export` / `session.messages`），与 Node 半共用同一份 `Transcript`。

## 9. 关键 dsh 源码索引（只读参考）

- 会话数据模型：`packages/core/session/src/types.ts`（`Session` / `SessionEvent`）
- 消息模型：`packages/llm/llm/src/{message,types}.ts`（`Message` / `ContentBlock` / `ModelMessageSource`）
- 工具执行上下文：`packages/core/tools/src`（ToolRunContext / ToolExecution）
- 客户端模块机制：`docs/subsystems/client-modules.zh.md`、`docs/cordis-tutorial/01-first-plugin.zh.md`
