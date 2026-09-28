import { describe, expect, it } from 'vitest'

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { collectTranscript } from '../src/collect.js'

/** 构造一条消息（绕过 brand / readonly，只为喂给采集层）。 */
function makeMessage(
  id: string,
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool',
  content: unknown,
  source: unknown,
  extra: Record<string, unknown> = {},
): Message {
  return { id, role, content, source, ...extra } as unknown as Message
}

function event(type: string, time: number, data: unknown): SessionEvent {
  return { type, time, data } as unknown as SessionEvent
}

/**
 * 一个覆盖用户/助手/工具/上下文的完整假会话，形态对齐 0.1.7-rc.2：
 * 工具结果是 `tool` 角色消息，注入上下文用生产者自己的 `source.kind`，
 * 会话对象只暴露 `snapshotEvents()`（无 `events` getter）。
 */
function makeSession(overrides: { events?: SessionEvent[] } = {}): Session {
  const userMsg = makeMessage('u1', 'user', [{ type: 'text', text: '用户问题' }], { kind: 'user' })
  const assistantMsg = makeMessage(
    'a1',
    'assistant',
    [
      { type: 'reasoning', text: '我正在思考' },
      { type: 'text', text: '助手回复' },
      { type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
    ],
    { kind: 'model', model: 'gpt-4', provider: 'openai' },
  )
  const toolResultMsg = makeMessage(
    't1',
    'tool',
    [{ type: 'text', text: '结果内容' }],
    { kind: 'tool', callId: 'call_1' },
    { toolCallId: 'call_1', isError: false },
  )
  const contextMsg = makeMessage(
    'c1',
    'user',
    [{ type: 'text', text: '注入的系统上下文' }],
    { kind: 'user-approval', form: 'notice', summary: '已批准' },
  )

  const events: SessionEvent[] = [
    event('user/message', 1000, userMsg),
    event('assistant/message', 2000, { message: assistantMsg }),
    event('tool/call', 2100, { callId: 'call_1', name: 'search', arguments: '{"q":"x"}' }),
    event('tool/result', 2200, { message: toolResultMsg }),
    event('user/message', 2300, contextMsg),
  ]

  return {
    id: 'session-abc',
    header: { version: 4, id: 'session-abc', createdAt: 1000, cwd: '/work', agentPreset: 'default' },
    snapshotEvents: () => overrides.events ?? events,
    deriveMessages: () => [userMsg, assistantMsg, toolResultMsg, contextMsg],
  } as unknown as Session
}

describe('collectTranscript', () => {
  it('默认开关下折叠出 用户 + 助手 + 工具结果', () => {
    const t = collectTranscript(makeSession())
    const kinds = t.entries.map(e => e.kind)
    expect(kinds).toEqual(['user', 'assistant', 'tool'])
    expect(t.meta.turnCount).toBe(1)
    expect(t.meta.toolCallCount).toBe(1)
    expect(t.meta.model).toBe('gpt-4')
    expect(t.meta.cwd).toBe('/work')
  })

  it('助手段携带工具调用（callId 与 name 配对）', () => {
    const t = collectTranscript(makeSession())
    const assistant = t.entries.find(e => e.kind === 'assistant')
    expect(assistant).toBeDefined()
    if (assistant && assistant.kind === 'assistant') {
      expect(assistant.toolCalls).toHaveLength(1)
      expect(assistant.toolCalls[0]).toMatchObject({ callId: 'call_1', name: 'search' })
    }
    const tool = t.entries.find(e => e.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', name: 'search', output: '结果内容', isError: false })
  })

  it('includeReasoning 控制推理过程', () => {
    const off = collectTranscript(makeSession(), { includeReasoning: false })
    const on = collectTranscript(makeSession(), { includeReasoning: true })
    const aOff = off.entries.find(e => e.kind === 'assistant')
    const aOn = on.entries.find(e => e.kind === 'assistant')
    if (aOff && aOff.kind === 'assistant') expect(aOff.reasoning).toBeUndefined()
    if (aOn && aOn.kind === 'assistant') expect(aOn.reasoning).toBe('我正在思考')
  })

  it('includeToolCalls=false 隐藏工具结果与助手工具调用', () => {
    const t = collectTranscript(makeSession(), { includeToolCalls: false })
    expect(t.entries.some(e => e.kind === 'tool')).toBe(false)
    const assistant = t.entries.find(e => e.kind === 'assistant')
    if (assistant && assistant.kind === 'assistant') expect(assistant.toolCalls).toHaveLength(0)
    expect(t.meta.toolCallCount).toBe(0)
  })

  it('includeInjectedContext=true 保留插件上下文（标签取生产者 kind / form）', () => {
    const off = collectTranscript(makeSession(), { includeInjectedContext: false })
    const on = collectTranscript(makeSession(), { includeInjectedContext: true })
    expect(off.entries.some(e => e.kind === 'context')).toBe(false)
    const ctx = on.entries.find(e => e.kind === 'context')
    expect(ctx).toBeDefined()
    if (ctx && ctx.kind === 'context') {
      expect(ctx.plugin).toBe('user-approval')
      expect(ctx.form).toBe('notice')
    }
  })

  it('includeTimestamps=false 时条目不携带 time', () => {
    const t = collectTranscript(makeSession(), { includeTimestamps: false })
    expect(t.entries.every(e => e.time === undefined)).toBe(true)
    expect(t.meta.options.includeTimestamps).toBe(false)
  })

  it('事件日志不可读时仍从派生消息补齐工具名/参数与模型', () => {
    const t = collectTranscript(makeSession({ events: [] }))
    const tool = t.entries.find(e => e.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', name: 'search', arguments: '{"q":"x"}' })
    expect(t.entries.every(e => e.time === undefined)).toBe(true)
    expect(t.meta.model).toBe('gpt-4')
  })

  it('assistant 被中断时带 interrupted 标记与事件时间', () => {
    const message = makeMessage('a9', 'assistant', [{ type: 'text', text: '半句' }], { kind: 'model', model: 'm', provider: 'p' })
    const session = {
      id: 's-int',
      header: { version: 4, id: 's-int', createdAt: 1 },
      snapshotEvents: () => [event('assistant/message', 5000, { message, interrupted: true })],
      deriveMessages: () => [message],
    } as unknown as Session

    const entry = collectTranscript(session).entries.find(e => e.kind === 'assistant')
    expect(entry).toMatchObject({ kind: 'assistant', text: '半句', interrupted: true, time: 5000 })
  })

  it('旧版形态兜底：events getter、source.plugin 标签与 tool-result 块展开为文本', () => {
    const legacyUser = makeMessage('u1', 'user', [{ type: 'text', text: '旧版提问' }], { kind: 'user' })
    const legacyContext = makeMessage('c1', 'user', [{ type: 'text', text: '旧版注入' }], { kind: 'plugin', plugin: 'AGENTS' })
    const legacyToolResult = makeMessage(
      't1',
      'user',
      [{ type: 'tool-result', toolCallId: 'call_old', content: [{ type: 'text', text: '旧版结果' }], isError: false }],
      { kind: 'plugin', plugin: 'legacy-tool' },
    )
    const session = {
      id: 's-legacy',
      header: { version: 1, id: 's-legacy', createdAt: 1 },
      events: [
        event('user/message', 10, legacyUser),
        event('user/message', 20, legacyContext),
        event('user/message', 30, legacyToolResult),
      ],
      deriveMessages: () => [legacyUser, legacyContext, legacyToolResult],
    } as unknown as Session

    const t = collectTranscript(session, { includeInjectedContext: true })
    expect(t.entries[0]).toMatchObject({ kind: 'user', text: '旧版提问', time: 10 })
    // 旧版注入消息仍被识别为上下文，标签优先取 source.plugin。
    expect(t.entries[1]).toMatchObject({ kind: 'context', text: '旧版注入', plugin: 'AGENTS', time: 20 })
    // 旧版 tool-result 内容块按嵌套文本展开，不丢弃。
    expect(t.entries[2]).toMatchObject({ kind: 'context', text: '旧版结果' })
  })
})
