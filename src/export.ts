/**
 * 导出调度层：把一份 live session 采集、渲染并落盘为 md / docx / pdf。
 *
 * 这一层是 host 侧工具与（未来的）程序化调用共用的唯一出口，负责：
 *   1. 调 {@link collectTranscript} 折叠会话事件；
 *   2. 按 format 选对应渲染器；
 *   3. 解析 / 清洗输出路径，必要时建目录；
 *   4. 遵守取消信号。
 *
 * 渲染器是无副作用的纯函数（见 render-*.ts），本文件只处理 IO 与路径。
 *
 * @module dsh-session-export/export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { Session } from '@deepseek-ai/dsh-session'

import { collectTranscript, type TranscriptOptions } from './collect.js'
import { FontNotFoundError } from './fonts.js'
import { renderDocx } from './render-docx.js'
import { renderMarkdown } from './render-markdown.js'
import { renderPdf } from './render-pdf.js'

/** 支持的三种导出格式。 */
export type ExportFormat = 'md' | 'docx' | 'pdf'

/** 导出请求参数（host 工具与程序化调用共用）。 */
export interface ExportArgs {
  /** 目标格式。 */
  format: ExportFormat
  /** 输出目录（缺省用 fallbackDir）。 */
  outputDir?: string
  /** 文件名（不含扩展名）；缺省按标题 + 会话 id + 日期生成。 */
  fileName?: string
  /** 文档标题（缺省「会话导出」）。 */
  title?: string
  /** 是否包含工具调用与结果（缺省跟随插件默认）。 */
  includeToolCalls?: boolean
  /** 是否包含模型推理过程（缺省跟随插件默认）。 */
  includeReasoning?: boolean
  /** 是否包含插件注入的上下文（缺省跟随插件默认）。 */
  includeInjectedContext?: boolean
  /** 是否包含时间戳与元信息（缺省跟随插件默认）。 */
  includeTimestamps?: boolean
}

/** 落盘结果。 */
export interface ExportResult {
  /** 文件的绝对路径。 */
  file: string
  /** 实际写出的格式。 */
  format: ExportFormat
  /** 使用的文档标题。 */
  title: string
  /** 导出的条目数（消息 + 工具结果）。 */
  entryCount: number
}

/** 各格式的文件扩展名。 */
const EXT: Record<ExportFormat, string> = { md: '.md', docx: '.docx', pdf: '.pdf' }

/** Windows / 多数文件系统禁止出现在文件名里的字符。 */
const ILLEGAL_NAME = /[<>:"/\\|?*\x00-\x1f]/g

/** 清洗文件名片段：保留中文与常用符号，去掉路径分隔与引号等。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_NAME, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim()
  const truncated = cleaned.slice(0, 160)
  return truncated === '' ? 'session' : truncated
}

/** 只把显式给出的开关传给采集层（缺省走插件默认）。 */
function toOptions(args: ExportArgs): TranscriptOptions {
  const options: TranscriptOptions = {}
  if (args.includeToolCalls !== undefined) options.includeToolCalls = args.includeToolCalls
  if (args.includeReasoning !== undefined) options.includeReasoning = args.includeReasoning
  if (args.includeInjectedContext !== undefined) options.includeInjectedContext = args.includeInjectedContext
  if (args.includeTimestamps !== undefined) options.includeTimestamps = args.includeTimestamps
  return options
}

/** 缺省文件名：标题 + 会话后 6 位 + 日期，尽量降低误覆盖概率。 */
function defaultFileName(title: string, sessionId: string): string {
  const stamp = new Date().toISOString().slice(0, 10)
  const tail = sessionId.length > 6 ? sessionId.slice(-6) : sessionId
  return `${sanitizeFileName(title)}-${tail}-${stamp}`
}

/** 若信号已取消则抛 AbortError（避免大会话导出时被打断后仍写盘）。 */
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('导出已取消')
    error.name = 'AbortError'
    throw error
  }
}

/**
 * 把一个会话导出为指定格式的本地文件。
 *
 * @param session - live session（通常来自 `exec.agent.session`）。
 * @param args - 导出参数（见 {@link ExportArgs}）。
 * @param fallbackDir - `outputDir` 缺省时使用的目录（会话 cwd 优先，否则进程 cwd）。
 * @param signal - 取消信号；已取消时抛 `AbortError`。
 * @returns 落盘结果（绝对路径、格式、标题、条目数）。
 * @throws 会话为空时抛普通错误；PDF 找不到中文字体时抛 {@link FontNotFoundError}。
 */
export async function exportSession(
  session: Session,
  args: ExportArgs,
  fallbackDir: string,
  signal?: AbortSignal,
): Promise<ExportResult> {
  checkSignal(signal)

  const options = toOptions(args)
  const transcript = collectTranscript(session, options)
  if (transcript.entries.length === 0) {
    throw new Error('当前会话没有可导出的内容（既无用户消息也无助手消息）。')
  }

  const title = args.title?.trim() || '会话导出'
  const base = args.fileName?.trim()
    ? sanitizeFileName(args.fileName.trim())
    : defaultFileName(title, transcript.meta.sessionId)

  const rawDir = args.outputDir?.trim()
  const dir = rawDir
    ? (isAbsolute(rawDir) ? rawDir : join(fallbackDir, rawDir))
    : fallbackDir

  await mkdir(dir, { recursive: true })
  checkSignal(signal)

  const file = join(dir, base + EXT[args.format])
  let buffer: Buffer | string
  switch (args.format) {
    case 'md':
      buffer = renderMarkdown(transcript, title)
      break
    case 'docx':
      buffer = await renderDocx(transcript, title)
      break
    case 'pdf':
      buffer = await renderPdf(transcript, title)
      break
  }

  await writeFile(file, buffer)
  return { file, format: args.format, title, entryCount: transcript.entries.length }
}

/** 仅取目录（供工具层在非绝对路径时拼接 fallbackDir，无需重复实现）。 */
export function resolveOutputDir(outputDir: string | undefined, fallbackDir: string): string {
  if (outputDir?.trim() === undefined || outputDir.trim() === '') return fallbackDir
  const raw = outputDir.trim()
  return isAbsolute(raw) ? raw : join(fallbackDir, raw)
}
