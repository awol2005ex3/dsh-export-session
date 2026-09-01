/**
 * transcript → Markdown 文本。
 *
 * 产出的 Markdown 同时也是 PDF 与 DOCX 渲染器的输入（两者都先
 * 调用本模块，再用各自的块解析器排版），因此格式必须稳定、可预测。
 *
 * 排版约定：
 *   - 一级标题是文件名级别的文档标题，其后是会话元信息表格；
 *   - 每条消息用二级标题 + 时间戳，角色以文字标注（不用 emoji）；
 *   - 工具调用折叠为四级标题，参数与结果各占一个代码块；
 *   - 代码块围栏长度自适应内容里最长的反引号串，避免内容逃逸。
 *
 * @module dsh-session-export/render-markdown
 */

import { formatTimestamp, type Transcript, type TranscriptEntry, type ToolCallEntry } from './collect.js'

/** 角色的人类可读标签。 */
const ROLE_LABEL: Record<TranscriptEntry['kind'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  context: '上下文',
}

/**
 * 为一段代码挑选围栏：内容里出现的最长连续反引号串 +1，至少 3 个。
 * 这样即使会话内容本身含有 ``` 也不会提前闭合代码块。
 */
function fenceFor(code: string): string {
  let longest = 0
  let current = 0
  for (const ch of code) {
    if (ch === '`') {
      current += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 把参数 JSON 字符串美化输出；非法 JSON 原样返回。 */
function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** 元信息表格行；值为空时跳过该行。 */
function metaRows(transcript: Transcript): Array<[string, string]> {
  const { meta } = transcript
  const rows: Array<[string, string]> = [['会话 ID', meta.sessionId]]
  if (meta.createdAt !== undefined) rows.push(['创建时间', formatTimestamp(meta.createdAt)])
  if (meta.updatedAt !== undefined) rows.push(['最后更新', formatTimestamp(meta.updatedAt)])
  if (meta.cwd !== undefined && meta.cwd !== '') rows.push(['工作目录', meta.cwd])
  if (meta.model !== undefined && meta.model !== '') rows.push(['模型', meta.model])
  if (meta.provider !== undefined && meta.provider !== '') rows.push(['服务商', meta.provider])
  if (meta.agentPreset !== undefined && meta.agentPreset !== '') rows.push(['Agent 预设', meta.agentPreset])
  rows.push(['助手回复数', String(meta.turnCount)])
  rows.push(['工具调用数', String(meta.toolCallCount)])
  return rows
}

/** 渲染文档头部的元信息（时间戳开关关闭时退化为纯标题）。 */
function renderHeader(transcript: Transcript, title: string): string {
  const lines: string[] = [`# ${title}`, '']

  if (transcript.meta.options.includeTimestamps) {
    lines.push('| 项目 | 值 |', '| --- | --- |')
    for (const [key, value] of metaRows(transcript)) {
      lines.push(`| ${key} | ${value.replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** 单条消息的时间戳后缀；未开启时间戳时返回空串。 */
function timeSuffix(time: number | undefined, enabled: boolean): string {
  if (!enabled || time === undefined) return ''
  return `（${formatTimestamp(time)}）`
}

/** 渲染一次工具调用（参数 + 结果）。 */
function renderToolCall(call: ToolCallEntry, result: TranscriptEntry | undefined, indentLevel: number): string {
  const hashes = '#'.repeat(indentLevel)
  const lines: string[] = [`${hashes} 工具调用：\`${call.name}\``, '']

  if (call.arguments !== undefined && call.arguments !== '') {
    const args = prettyArguments(call.arguments)
    const fence = fenceFor(args)
    lines.push(`${fence}json`, args, fence, '')
  }

  if (result !== undefined && result.kind === 'tool') {
    if (result.output !== '') {
      const fence = fenceFor(result.output)
      lines.push(result.isError ? '**调用失败**' : '**调用结果**', '', fence, result.output, fence, '')
    } else {
      lines.push(result.isError ? '**调用失败**（无输出）' : '**调用结果**：无输出', '')
    }
  }

  return lines.join('\n')
}

/**
 * 把一份 transcript 渲染为 Markdown。
 *
 * @param transcript - {@link collectTranscript} 的产物。
 * @param title - 文档标题；缺省为「会话导出」。
 * @returns 完整的 Markdown 文本。
 */
export function renderMarkdown(transcript: Transcript, title = '会话导出'): string {
  const withTime = transcript.meta.options.includeTimestamps
  const chunks: string[] = [renderHeader(transcript, title), '---', '']

  // 工具结果按 callId 索引，供所属助手消息内联渲染；孤儿结果在兜底分支输出。
  const consumed = new Set<string>()
  const resultByCallId = new Map<string, TranscriptEntry>()
  for (const entry of transcript.entries) {
    if (entry.kind === 'tool') resultByCallId.set(entry.callId, entry)
  }

  let lastWasText = false

  for (const entry of transcript.entries) {
    switch (entry.kind) {
      case 'tool':
        // 已在其所属助手消息里渲染过的跳过；孤儿结果（无配对的 assistant）在此兜底渲染。
        if (consumed.has(entry.callId)) continue
        chunks.push(`## 工具结果：\`${entry.name}\`${timeSuffix(entry.time, withTime)}`, '')
        if (entry.output !== '') {
          const fence = fenceFor(entry.output)
          if (entry.isError) chunks.push('**调用失败**', '')
          chunks.push(fence, entry.output, fence, '')
        } else {
          chunks.push(entry.isError ? '**调用失败**（无输出）' : '**调用结果**：无输出', '')
        }
        lastWasText = false
        break

      case 'user':
        chunks.push(`## ${ROLE_LABEL.user}${timeSuffix(entry.time, withTime)}`, '', entry.text, '')
        lastWasText = true
        break

      case 'context': {
        const plugin = entry.plugin === undefined ? '' : ` · ${entry.plugin}`
        chunks.push(`## ${ROLE_LABEL.context}${plugin}${timeSuffix(entry.time, withTime)}`, '', entry.text, '')
        lastWasText = true
        break
      }

      case 'assistant': {
        chunks.push(`## ${ROLE_LABEL.assistant}${timeSuffix(entry.time, withTime)}`, '')

        if (entry.reasoning !== undefined && entry.reasoning !== '') {
          chunks.push('> **推理过程**', '>')
          for (const line of entry.reasoning.split('\n')) chunks.push(`> ${line}`)
          chunks.push('')
        }

        if (entry.text !== '') chunks.push(entry.text, '')
        if (entry.interrupted === true) chunks.push('*（该回复被中断）*', '')
        lastWasText = entry.text !== ''

        for (const call of entry.toolCalls) {
          const result = resultByCallId.get(call.callId)
          if (result !== undefined) consumed.add(call.callId)
          chunks.push(renderToolCall(call, result, 3), '')
          lastWasText = false
        }
        break
      }
    }

    // 两个连续的纯文本块之间补一条分隔线，避免角色边界糊在一起。
    if (lastWasText) chunks.push('---', '')
  }

  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
