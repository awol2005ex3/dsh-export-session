/**
 * 会话采集：把 dsh 的会话事件日志折叠成一份可渲染的结构化 transcript。
 *
 * 数据链路（已核对 deepseek-harness 源码）：
 *   1. `exec.agent.session` —— 该 agent 驱动的 live `Session`
 *      （`packages/core/agent/src/runtime-types.ts` 的 `Agent.session`）。
 *   2. `session.deriveMessages()` —— 当前 surface 的派生消息序列，
 *      已经过压缩替换折叠，因此不会重复导出被 shadow 掉的旧内容
 *      （`packages/core/session/src/index.ts`）。
 *   3. `session.events` —— 原始事件日志，这里只用来补两类派生消息里没有的
 *      信息：每条消息的时间戳（按 `message.id` 精确匹配）与工具名
 *      （`tool/call` 事件才有 name，派生消息里只有 assistant 的 tool-call block）。
 *
 * 为什么不用 `ctx.sessionQuery.readSurface()`：那是持久化会话的正确读法，
 * 但 `sessionQuery` 不是默认挂载的服务（官方 `tool-session-query` 也要显式
 * 装包才 mount），inject 它会让插件在没有该服务时挂起。本工具只导出
 * 「当前会话」，live session 一定可用，故直接读 `exec.agent.session`。
 *
 * @module dsh-session-export/collect
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** 一条模型请求的工具调用。 */
export interface ToolCallEntry {
  /** 与 tool-result 配对的调用 id。 */
  callId: string
  /** 工具名。 */
  name: string
  /** 模型产出的原始 JSON 参数字符串（未解析）。 */
  arguments: string
}

/** transcript 里的一条记录。 */
export type TranscriptEntry =
  /** 真人输入。 */
  | { kind: 'user'; text: string; time?: number }
  /** 插件注入的上下文（AGENTS.md、技能、文件变更通知、定时提醒等）。 */
  | { kind: 'context'; text: string; time?: number; plugin?: string; form?: string }
  /** 模型输出（可能同时携带 reasoning 与 tool calls）。 */
  | {
    kind: 'assistant'
    text: string
    toolCalls: ToolCallEntry[]
    time?: number
    reasoning?: string
    model?: string
    provider?: string
    interrupted?: true
  }
  /** 一次工具调用的返回值。 */
  | { kind: 'tool'; name: string; callId: string; arguments?: string; output: string; isError: boolean; time?: number }

/** 会话级元信息，写进导出文件的头部。 */
export interface TranscriptMeta {
  /** 会话 id。 */
  sessionId: string
  /** 会话创建时间（epoch ms）。 */
  createdAt?: number
  /** 最后一条消息的时间（epoch ms）。 */
  updatedAt?: number
  /** 会话工作目录。 */
  cwd?: string
  /** 该会话使用的 agent preset id。 */
  agentPreset?: string
  /** 最后观察到的模型名。 */
  model?: string
  /** 最后观察到的服务商名。 */
  provider?: string
  /** 记录的 turn 数（按 assistant 消息计数）。 */
  turnCount: number
  /** 工具调用总数。 */
  toolCallCount: number
  /** 导出时使用的开关，便于复现。 */
  options: Required<TranscriptOptions>
}

/** 决定导出内容范围的开关。全部可选，缺省值见 {@link DEFAULT_TRANSCRIPT_OPTIONS}。 */
export interface TranscriptOptions {
  /** 是否包含工具调用与结果。默认 true。 */
  includeToolCalls?: boolean
  /** 是否包含模型的推理过程（reasoning block）。默认 false。 */
  includeReasoning?: boolean
  /** 是否包含插件注入的上下文消息。默认 false。 */
  includeInjectedContext?: boolean
  /** 是否包含时间戳与元信息。默认 true。 */
  includeTimestamps?: boolean
}

/** 未显式指定时的导出范围。 */
export const DEFAULT_TRANSCRIPT_OPTIONS: Required<TranscriptOptions> = {
  includeToolCalls: true,
  includeReasoning: false,
  includeInjectedContext: false,
  includeTimestamps: true,
}

/** 采集结果。 */
export interface Transcript {
  meta: TranscriptMeta
  entries: TranscriptEntry[]
}

/** `session.events` 的鸭子类型入口：只依赖这里实际读取的字段。 */
interface EventSource {
  readonly events?: readonly SessionEvent[]
  readonly header?: { readonly id?: unknown; readonly createdAt?: number; readonly cwd?: string; readonly agentPreset?: string }
  readonly deriveMessages?: () => readonly Message[]
}

/** image block 的形状（只需 attachment 的存在性，不读内部字段）。 */
interface ImageLike {
  type: 'image'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 把一组内容块拆成纯文本、推理文本与工具调用。
 * 未知块类型（插件扩展的 ContentBlockMap 成员）按占位文本处理，不丢弃。
 */
function readBlocks(blocks: readonly ContentBlock[]): {
  text: string
  reasoning?: string
  toolCalls: ToolCallEntry[]
} {
  const textParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls: ToolCallEntry[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') textParts.push(block.text)
        break
      case 'reasoning':
        if (block.text !== '') reasoningParts.push(block.text)
        break
      case 'tool-call':
        toolCalls.push({ callId: block.id, name: block.name, arguments: block.arguments })
        break
      case 'image':
        textParts.push(`[图片${readImageLabel(block)}]`)
        break
      case 'tool-result':
        // 嵌套的 tool-result（理论上不会出现在非 tool 消息里）按文本展开。
        textParts.push(readBlocks(block.content).text)
        break
      default:
        textParts.push(`[未识别内容块 ${(block as { type?: string }).type ?? 'unknown'}]`)
        break
    }
  }

  return {
    text: textParts.join('\n\n').trim(),
    toolCalls,
    ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join('\n\n').trim() } : {}),
  }
}

/** 图片块的可读标签（alt / 文件名 / mime），全部缺失时返回空串。 */
function readImageLabel(block: ImageLike): string {
  const attachment = (block as { attachment?: unknown }).attachment
  if (attachment === null || typeof attachment !== 'object') return ''
  const record = attachment as Record<string, unknown>
  const label = asString(record.alt) ?? asString(record.name) ?? asString(record.filename) ?? asString(record.mimeType)
  return label === undefined ? '' : `: ${label}`
}

/**
 * 从派生消息序列读取（优先）或从原始事件投影（回退）。
 * 回退路径用于 `deriveMessages` 不可用的场景，保证插件不会因为一个
 * 方法缺失就整体失效。
 */
function readMessages(session: EventSource): readonly Message[] {
  if (typeof session.deriveMessages === 'function') {
    const messages = session.deriveMessages()
    if (Array.isArray(messages) && messages.length > 0) return messages
  }
  return projectFromEvents(session.events ?? [])
}

/** 原始事件 → 消息序列的最小投影（无压缩折叠，仅回退使用）。 */
function projectFromEvents(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = []
  for (const event of events) {
    if (event.type === 'user/message') messages.push(event.data)
    else if (event.type === 'assistant/message') messages.push(event.data.message)
    else if (event.type === 'tool/result') messages.push(event.data.message)
  }
  return messages
}

/** 建立 `message.id → 时间戳` 映射，并顺带收集工具名与模型信息。 */
interface EventIndex {
  timeById: Map<string, number>
  toolByCallId: Map<string, { name: string; arguments: string; time: number }>
  model?: string
  provider?: string
  lastTime?: number
}

function indexEvents(events: readonly SessionEvent[]): EventIndex {
  const timeById = new Map<string, number>()
  const toolByCallId = new Map<string, { name: string; arguments: string; time: number }>()
  let model: string | undefined
  let provider: string | undefined
  let lastTime: number | undefined

  for (const event of events) {
    lastTime = event.time
    switch (event.type) {
      case 'user/message':
        if (typeof event.data.id === 'string') timeById.set(event.data.id, event.time)
        break
      case 'assistant/message': {
        const message = event.data.message
        if (typeof message.id === 'string') timeById.set(message.id, event.time)
        const source = message.source as unknown as Record<string, unknown> | undefined
        model = asString(source?.model) ?? model
        provider = asString(source?.provider) ?? provider
        break
      }
      case 'tool/result':
        if (typeof event.data.message.id === 'string') timeById.set(event.data.message.id, event.time)
        break
      case 'tool/call':
        toolByCallId.set(event.data.callId, {
          name: event.data.name,
          arguments: event.data.arguments,
          time: event.time,
        })
        break
      case 'request/context': {
        const data = event.data as { model?: unknown; provider?: unknown }
        model = asString(data.model) ?? model
        provider = asString(data.provider) ?? provider
        break
      }
      default:
        break
    }
  }

  return {
    timeById,
    toolByCallId,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(lastTime === undefined ? {} : { lastTime }),
  }
}

/**
 * 采集一个会话的完整内容。
 *
 * @param session - live session（`exec.agent.session`）。
 * @param options - 导出范围开关；缺省使用 {@link DEFAULT_TRANSCRIPT_OPTIONS}。
 * @returns 结构化 transcript，可直接交给任一渲染器。
 * @throws 当会话里没有任何可导出内容时抛错，由工具层转成失败结果。
 */
export function collectTranscript(session: Session, options: TranscriptOptions = {}): Transcript {
  const resolved: Required<TranscriptOptions> = { ...DEFAULT_TRANSCRIPT_OPTIONS, ...options }
  const source = session as unknown as EventSource
  const events = source.events ?? []
  const index = indexEvents(events)
  const messages = readMessages(source)

  const entries: TranscriptEntry[] = []
  let turnCount = 0
  let toolCallCount = 0

  for (const message of messages) {
    const time = typeof message.id === 'string' ? index.timeById.get(message.id) : undefined
    const withTime = <T extends object>(entry: T): T & { time?: number } =>
      resolved.includeTimestamps && time !== undefined ? { ...entry, time } : entry

    // ── 工具结果：role 是 user，但 source.kind 为 'tool' ──
    if (isToolResult(message)) {
      if (!resolved.includeToolCalls) continue
      const block = message.content[0]
      if (block === undefined) continue
      toolCallCount += 1
      const callId = block.toolCallId
      const call = index.toolByCallId.get(callId)
      const inner = readBlocks(block.content)
      entries.push(withTime({
        kind: 'tool',
        name: call?.name ?? 'tool',
        callId,
        ...(call?.arguments ? { arguments: call.arguments } : {}),
        output: inner.text,
        isError: block.isError === true,
      }))
      continue
    }

    const sourceKind = (message.source as { kind?: string } | undefined)?.kind

    // ── 插件注入的上下文 ──
    if (message.role === 'user' && sourceKind === 'plugin') {
      if (!resolved.includeInjectedContext) continue
      const pluginSource = message.source as { plugin?: unknown; form?: unknown }
      entries.push(withTime({
        kind: 'context',
        text: readBlocks(message.content).text,
        ...(asString(pluginSource.plugin) === undefined ? {} : { plugin: asString(pluginSource.plugin) }),
        ...(asString(pluginSource.form) === undefined ? {} : { form: asString(pluginSource.form) }),
      }))
      continue
    }

    // ── 真人输入 ──
    if (message.role === 'user') {
      const text = readBlocks(message.content).text
      if (text === '') continue
      entries.push(withTime({ kind: 'user', text }))
      continue
    }

    // ── 助手输出 ──
    if (message.role === 'assistant') {
      const read = readBlocks(message.content)
      const hasVisible = read.text !== '' || read.toolCalls.length > 0
      if (!hasVisible) continue
      turnCount += 1
      const modelSource = message.source as { model?: unknown; provider?: unknown }
      const entry: TranscriptEntry = {
        kind: 'assistant',
        text: read.text,
        toolCalls: resolved.includeToolCalls ? read.toolCalls : [],
        ...(resolved.includeReasoning && read.reasoning !== undefined ? { reasoning: read.reasoning } : {}),
        ...(asString(modelSource.model) === undefined ? {} : { model: asString(modelSource.model) }),
        ...(asString(modelSource.provider) === undefined ? {} : { provider: asString(modelSource.provider) }),
      }
      entries.push(withTime(entry))
      continue
    }

    // ── system 角色：deriveMessages 不产生，但回退路径可能出现 ──
    if (message.role === 'system') continue
  }

  const header = source.header
  const meta: TranscriptMeta = {
    sessionId: session.id,
    ...(header?.createdAt === undefined ? {} : { createdAt: header.createdAt }),
    ...(index.lastTime === undefined ? {} : { updatedAt: index.lastTime }),
    ...(asString(header?.cwd) === undefined ? {} : { cwd: asString(header?.cwd) }),
    ...(asString(header?.agentPreset) === undefined ? {} : { agentPreset: asString(header?.agentPreset) }),
    ...(index.model === undefined ? {} : { model: index.model }),
    ...(index.provider === undefined ? {} : { provider: index.provider }),
    turnCount,
    toolCallCount,
    options: resolved,
  }

  return { meta, entries }
}

/** 是否为携带工具结果的 user 消息（判断依据与 `createToolResultMessage` 一致）。 */
function isToolResult(message: Message): message is Message & { content: [{ type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }] } {
  if (message.role !== 'user') return false
  if ((message.source as { kind?: string } | undefined)?.kind !== 'tool') return false
  return message.content[0]?.type === 'tool-result'
}

/**
 * 把 epoch 毫秒格式化为本地时间的 `YYYY-MM-DD HH:mm:ss`。
 * 不用 `toLocaleString`，避免不同 Node ICU 构建产出的格式漂移。
 */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
