/**
 * host 侧工具 `export_session`：把当前会话导出为 Markdown / Word / PDF 文件。
 *
 * 这一文件是插件「主机半」的核心：注册一个可被 agent 调用的工具，让用户在
 * 对话里直接说「把会话导出成 PDF」就能落地文件。数据来自 `exec.agent.session`，
 * 渲染与落盘走 {@link exportSession}（见 export.ts）。
 *
 * @module dsh-session-export/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { exportSession, type ExportArgs, type ExportFormat } from './export.js'

/** 插件的部署配置（与 index.ts 的 `Config` 一致）。 */
export interface ToolConfig {
  /** 缺省输出目录；调用方未给 outputDir 时使用（再退化为会话 cwd / 进程 cwd）。 */
  defaultOutputDir?: string
  /** 缺省导出格式。 */
  defaultFormat?: ExportFormat
}

const FORMATS: ExportFormat[] = ['md', 'docx', 'pdf']

function isValidFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (FORMATS as string[]).includes(value)
}

/**
 * 构造绑定到插件配置的 `export_session` 工具。
 *
 * @param config - 插件部署配置（缺省目录与缺省格式）。
 * @returns 一个可被 `ctx.tools.register` 注册的 {@link defineTool} 定义。
 */
export function createExportTool(config: ToolConfig) {
  return defineTool({
    name: 'export_session',
    description: [
      'Export the ENTIRE current conversation of this session to a local file in one of three formats:',
      'Markdown (.md), Word (.docx), or PDF (.pdf). Use this when the user asks to save, download, archive,',
      'or share the whole chat. The tool captures user messages, assistant replies (optionally with the',
      'model reasoning), tool calls with their arguments and results, and per-message timestamps.',
      'Pass format = "md" | "docx" | "pdf". Optional flags toggle tool calls, reasoning, injected plugin',
      'context, and timestamps. Returns the absolute file path on success.',
    ].join(' '),
    parameters: {
      format: {
        type: 'string',
        required: true,
        description: 'Output format: "md" for Markdown, "docx" for Word, "pdf" for PDF.',
      },
      outputDir: {
        type: 'string',
        description:
          'Directory to write the file into. Absolute, or relative to the plugin/session working directory. '
          + 'Falls back to the plugin defaultOutputDir, then the session cwd, then the process cwd.',
      },
      fileName: {
        type: 'string',
        description: 'Output file base name (no extension). Auto-generated from title + session id + date when omitted.',
      },
      title: {
        type: 'string',
        description: 'Document title shown in the header. Defaults to "会话导出".',
      },
      includeToolCalls: {
        type: 'boolean',
        description: 'Include tool calls with their arguments and results. Default true.',
      },
      includeReasoning: {
        type: 'boolean',
        description: 'Include the model reasoning / thinking process as quoted blocks. Default false.',
      },
      includeInjectedContext: {
        type: 'boolean',
        description: 'Include plugin-injected context (AGENTS.md, skills, file-change notices). Default false.',
      },
      includeTimestamps: {
        type: 'boolean',
        description: 'Include per-message timestamps and a metadata header. Default true.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          format: { type: 'string' },
          title: { type: 'string' },
          entryCount: { type: 'number' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Exported session to ${value.file} (${value.format}, ${value.entryCount} entries).`,
        },
      ],
    },
    async execute(args, exec) {
      if (!isValidFormat(args.format)) {
        throw new Error(`format 必须是 md / docx / pdf 之一，收到：${String(args.format)}`)
      }

      const agent = exec.agent
      if (agent === undefined || agent.session === undefined) {
        throw new Error('export_session 只能在 agent 会话上下文中调用（exec.agent.session 不可用）。')
      }

      // 取消信号透传给渲染层，长会话导出时尊重 agent 关闭。
      void exec.signal

      const sessionCwd = (agent.session as unknown as { header?: { cwd?: string } }).header?.cwd
      const fallbackDir = config.defaultOutputDir?.trim()
        || sessionCwd
        || process.cwd()

      const call: ExportArgs = {
        format: args.format,
        outputDir: typeof args.outputDir === 'string' ? args.outputDir : undefined,
        fileName: typeof args.fileName === 'string' ? args.fileName : undefined,
        title: typeof args.title === 'string' ? args.title : undefined,
        includeToolCalls: typeof args.includeToolCalls === 'boolean' ? args.includeToolCalls : undefined,
        includeReasoning: typeof args.includeReasoning === 'boolean' ? args.includeReasoning : undefined,
        includeInjectedContext: typeof args.includeInjectedContext === 'boolean' ? args.includeInjectedContext : undefined,
        includeTimestamps: typeof args.includeTimestamps === 'boolean' ? args.includeTimestamps : undefined,
      }

      return exportSession(agent.session, call, fallbackDir, exec.signal)
    },
  })
}
