/**
 * 会话采集：把 dsh 的会话事件日志折叠成一份可渲染的结构化 transcript。
 *
 * 数据链路（已核对 deepseek-harness 源码）：
 *   1. `exec.agent.session` —— 该 agent 驱动的 live `Session`
 *      （`packages/core/agent/src/runtime-types.ts` 的 `Agent.session`）。
 *   2. `session.deriveMessages()` —— 当前 surface 的派生消息序列，
 *      已经过压缩替换折叠，因此不会重复导出被 shadow 掉的旧内容
 *      （`packages/core/session/src/index.ts`）。
 *   3. 事件日志快照（0.1.7+ 用 `session.snapshotEvents()`，0.0.x 回退
 *      `session.events`）—— 只用来补派生消息里没有的信息：每条消息的时间戳
 *      （按 `message.id` 精确匹配）、被中断标记（`assistant/message.interrupted`）
 *      与工具名（`tool/call` 事件才有 name；派生消息里虽也有 assistant 的
 *      tool-call block，但读不到工具结果事件本身）。
 *
 * 为什么不用 `ctx.sessionQuery.readSurface()`：那是持久化会话的正确读法，
 * 但 `sessionQuery` 不是默认挂载的服务（官方 `tool-session-query` 也要显式
 * 装包才 mount），inject 它会让插件在没有该服务时挂起。本工具只导出
 * 「当前会话」，live session 一定可用，故直接读 `exec.agent.session`。
 *
 * @module dsh-session-export/collect
 */

import type { ContentBlock, Message, ToolResultMessage } from '@deepseek-ai/dsh-llm'
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
  /**
   * 插件 / 宿主注入的上下文（AGENTS.md、技能、文件变更通知、定时提醒等）。
   * `plugin` 是内容生产者身份：0.1.7+ 取 `source.kind`（如 `user-approval`，
   * 已无统一的 `plugin` kind），0.0.x 取 `source.plugin` 的插件名；
   * `form` 是 `ContextForm`（instructions / catalog / snapshot / notice / relay / recall）。
   */
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

/** 会话对象的鸭子类型入口：只依赖这里实际读取的字段（跨 0.0.x / 0.1.7+ 兼容）。 */
interface EventSource {
  /** 0.0.x 的同步日志快照。 */
  readonly events?: readonly SessionEvent[]
  /**
   * 0.1.7+ 的同步日志快照。官方已把同步事件读法标记为 deprecated（新逻辑应
   * 走存储层读取），但本插件只 inject `tools`、只导出「当前 live 会话」，因此
   * 沿用既有读法（与官方 `dsh-session-projection` 的处理一致），仅取时间戳等
   * 派生消息里缺失的字段。
   */
  readonly snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
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
      default: {
        // 未知块（插件扩展的 ContentBlockMap 成员）按占位文本处理，不丢弃。
        // 兼容 0.0.x 的 `tool-result` 块：它自带嵌套 content，直接展开为文本
        // （0.1.7+ 起工具结果是一等的 tool 角色消息，见 isToolResult）。
        const unknown = block as unknown as { type?: string; content?: readonly ContentBlock[] }
        if (unknown.type === 'tool-result' && Array.isArray(unknown.content)) {
          const nested = readBlocks(unknown.content).text
          if (nested !== '') textParts.push(nested)
          break
        }
        textParts.push(`[未识别内容块 ${unknown.type ?? 'unknown'}]`)
        break
      }
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
 * 读取会话事件日志快照。
 *
 * 0.1.7+ 只有 `snapshotEvents()`（`events` getter 已移除），0.0.x 只有 `events`，
 * 两个版本都要能跑；任一读法失败都退化为「无事件」（最多少时间戳与工具名），
 * 不让整次导出失败。
 */
function readEvents(session: EventSource): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') {
    try {
      const events = session.snapshotEvents()
      if (Array.isArray(events) && events.length > 0) return events
    } catch {
      // 会话已销毁 / 日志不可读：退化为空日志。
    }
  }
  return session.events ?? []
}

/**
 * 从派生消息序列读取（优先）或从原始事件投影（回退）。
 * 回退路径用于 `deriveMessages` 不可用的场景，保证插件不会因为一个
 * 方法缺失就整体失效。
 */
function readMessages(session: EventSource, events: readonly SessionEvent[]): readonly Message[] {
  if (typeof session.deriveMessages === 'function') {
    const messages = session.deriveMessages()
    if (Array.isArray(messages) && messages.length > 0) return messages
  }
  return projectFromEvents(events)
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

/** 从事件日志里抽取「派生消息里没有」的信息。 */
interface EventIndex {
  timeById: Map<string, number>
  /** `callId → 工具名/参数`（事件里的 `tool/call` 才有 name）。 */
  toolByCallId: Map<string, { name: string; arguments: string; time?: number }>
  /** 被中断的 assistant 消息 id（`assistant/message.interrupted === true`）。 */
  interruptedById: Set<string>
  model?: string
  provider?: string
  lastTime?: number
}

function indexEvents(events: readonly SessionEvent[]): EventIndex {
  const timeById = new Map<string, number>()
  const toolByCallId = new Map<string, { name: string; arguments: string; time?: number }>()
  const interruptedById = new Set<string>()
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
        if (typeof message.id === 'string') {
          timeById.set(message.id, event.time)
          if (event.data.interrupted === true) interruptedById.add(message.id)
        }
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
    interruptedById,
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
  const events = readEvents(source)
  const index = indexEvents(events)
  const messages = readMessages(source, events)

  const entries: TranscriptEntry[] = []
  let turnCount = 0
  let toolCallCount = 0

  for (const message of messages) {
    const time = typeof message.id === 'string' ? index.timeById.get(message.id) : undefined
    const withTime = <T extends object>(entry: T): T & { time?: number } =>
      resolved.includeTimestamps && time !== undefined ? { ...entry, time } : entry

    // ── 工具结果：0.1.7+ 是一等的 `tool` 角色消息（不再有 tool-result 内容块）──
    if (isToolResult(message)) {
      if (!resolved.includeToolCalls) continue
      toolCallCount += 1
      const callId = message.toolCallId
      const call = index.toolByCallId.get(callId)
      entries.push(withTime({
        kind: 'tool',
        name: call?.name ?? 'tool',
        callId,
        ...(call?.arguments ? { arguments: call.arguments } : {}),
        output: readBlocks(message.content).text,
        isError: message.isError === true,
      }))
      continue
    }

    const messageSource = message.source as { kind?: unknown; plugin?: unknown; form?: unknown }
    const sourceKind = asString(messageSource.kind)

    // ── 插件 / 宿主注入的上下文 ──
    // 0.1.7+ 已无统一的 `plugin` kind（每个生产者声明自己的 kind，如
    // 'user-approval' / 'model-selection'），而真人输入恒为 `kind: 'user'`，
    // 因此「source.kind 不是 user 的 user 消息」即注入上下文；
    // 0.0.x 的 `source.plugin`（插件名）仍优先作为标签读取。
    if (message.role === 'user' && sourceKind !== 'user') {
      if (!resolved.includeInjectedContext) continue
      const text = readBlocks(message.content).text
      if (text === '') continue
      const plugin = asString(messageSource.plugin) ?? sourceKind
      const form = asString(messageSource.form)
      entries.push(withTime({
        kind: 'context',
        text,
        ...(plugin === undefined ? {} : { plugin }),
        ...(form === undefined ? {} : { form }),
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
      // 事件日志读不到时，派生消息里的 tool-call block 仍能补上工具名与参数；
      // 事件里的 `tool/call` 优先（它同时带调用时间）。
      for (const call of read.toolCalls) {
        if (!index.toolByCallId.has(call.callId)) {
          index.toolByCallId.set(call.callId, { name: call.name, arguments: call.arguments })
        }
      }
      index.model ??= asString(modelSource.model)
      index.provider ??= asString(modelSource.provider)
      const interrupted = typeof message.id === 'string' && index.interruptedById.has(message.id)
      const entry: TranscriptEntry = {
        kind: 'assistant',
        text: read.text,
        toolCalls: resolved.includeToolCalls ? read.toolCalls : [],
        ...(resolved.includeReasoning && read.reasoning !== undefined ? { reasoning: read.reasoning } : {}),
        ...(asString(modelSource.model) === undefined ? {} : { model: asString(modelSource.model) }),
        ...(asString(modelSource.provider) === undefined ? {} : { provider: asString(modelSource.provider) }),
        ...(interrupted ? { interrupted: true as const } : {}),
      }
      entries.push(withTime(entry))
      continue
    }

    // ── system / developer 角色：deriveMessages 会产出 system 与工具变更用的
    //    developer 消息，二者都不是会话内容，直接跳过 ──
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

/**
 * 是否为携带工具结果的消息。
 *
 * 0.1.7+：工具结果是一等的 `tool` 角色消息（`ToolResultMessage`，自带
 * `toolCallId` / `isError`），判断依据即角色本身。
 */
function isToolResult(message: Message): message is ToolResultMessage {
  return message.role === 'tool'
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
