# dsh-session-export

DeepSeek Harness（`dsh`）插件：把**当前会话的完整内容**一键导出为
**Markdown（`.md`）/ Word（`.docx`）/ PDF（`.pdf`）**。

对标 [`dsh-md-table-export`](https://github.com/)，但导出范围是整段对话，
而非单个 Markdown 表格。

## 能力

- **host 侧工具 `export_session`**：在对话里直接说「把会话导出成 PDF」即可落地文件。
- **Web 客户端按钮**：会话页右下角注入「导出 Markdown / 导出 PDF」浮动工具条
  （尽力而为版，扫描页面已渲染的消息 DOM）。
- 覆盖：用户消息、助手回复、模型推理过程（reasoning）、工具调用（名称 + 参数 +
  结果）、逐条时间戳与元信息（模型 / 服务商 / 工作目录 / 回复数）。

## 安装

```bash
cd dsh-session-export
npm install
npm run build      # tsc 产出 lib/，并把 client.js 包成 dsh 闭包工厂
```

把本包作为 dsh profile 的一行 patch 引入（`cordis.patch.yml` 已声明
`id: session-export`，主入口解析到 `lib/index.js`，Web 入口解析到 `lib/client.js`）。

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `format` | 是 | `md` / `docx` / `pdf` |
| `outputDir` | 否 | 输出目录（绝对或相对）；缺省用插件 `defaultOutputDir` → 会话 cwd → 进程 cwd |
| `fileName` | 否 | 文件名（不含扩展名）；缺省 `标题-会话尾号-日期` |
| `title` | 否 | 文档标题，缺省「会话导出」 |
| `includeToolCalls` | 否 | 包含工具调用与结果，默认 `true` |
| `includeReasoning` | 否 | 包含推理过程，默认 `false` |
| `includeInjectedContext` | 否 | 包含插件注入的上下文（AGENTS.md 等），默认 `false` |
| `includeTimestamps` | 否 | 包含时间戳与元信息，默认 `true` |

## 部署配置（`Config`）

```yaml
defaultOutputDir: ""   # 缺省导出目录
defaultFormat: md      # md | docx | pdf
```

## 实现要点

- 数据来自 `exec.agent.session`：`deriveMessages()` 拿到折叠后的正确消息序列，
  原始 `events` 仅用于补全时间戳与工具名（`packages/core/session`、`packages/llm`）。
- PDF 必须用本机中文字体（`pdfkit` 内置字体无中文）。`src/fonts.ts` 自动探测
  Windows / macOS / Linux 的中文字体；也可用环境变量 `DSH_EXPORT_PDF_FONT` 强制指定。
- DOCX 用 [`docx`](https://docx.js.org) 真表格 + 中文字体；三种格式共用同一套
  块级 Markdown 解析器（`src/md-blocks.ts`），排版一致。

## 质量门

```bash
npm run typecheck   # tsc --noEmit（strict）
npm test            # vitest，覆盖解析/采集/三种渲染器/工具执行
npm run build       # tsc + wrap-client
```
#License

Apache License 2.0