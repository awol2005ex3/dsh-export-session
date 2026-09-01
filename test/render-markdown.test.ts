import { describe, expect, it } from 'vitest'

import { collectTranscript } from '../src/collect.js'
import { renderMarkdown } from '../src/render-markdown.js'
import type { Session } from '../src/collect.js'

function fakeSession(): Session {
  return {
    id: 's1',
    header: { version: 1, id: 's1', createdAt: 1000, cwd: '/w', agentPreset: 'd' },
    events: [],
    deriveMessages: () => ([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好，世界' }], source: { kind: 'user' } },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '# 标题\n\n正文一行' },
          { type: 'tool-call', id: 'c1', name: 'calc', arguments: '{"x":1}' },
        ],
        source: { kind: 'model', model: 'm', provider: 'p' },
      },
      {
        id: 't1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '结果是 2' }], isError: false }],
        source: { kind: 'tool' },
      },
    ] as unknown as Message[]),
  } as unknown as Session
}

describe('renderMarkdown', () => {
  it('生成带标题与元信息的 Markdown', () => {
    const md = renderMarkdown(collectTranscript(fakeSession()), '我的会话')
    expect(md).toContain('# 我的会话')
    expect(md).toContain('会话 ID')
  })

  it('包含用户、助手、工具结果三个角色小节', () => {
    const md = renderMarkdown(collectTranscript(fakeSession()), 't')
    expect(md).toContain('## 用户')
    expect(md).toContain('你好，世界')
    expect(md).toContain('## 助手')
    expect(md).toContain('正文一行')
    expect(md).toContain('### 工具调用')
    expect(md).toContain('结果是 2')
  })

  it('includeToolCalls=false 时不输出工具结果小节', () => {
    const md = renderMarkdown(collectTranscript(fakeSession(), { includeToolCalls: false }), 't')
    expect(md).not.toContain('工具结果')
  })

  it('includeTimestamps=false 时去掉元信息表', () => {
    const md = renderMarkdown(collectTranscript(fakeSession(), { includeTimestamps: false }), 't')
    expect(md).not.toContain('会话 ID')
  })
})

// 局部类型占位，避免上面 fixture 里的 unknown 数组被误判。
interface Message {
  id: string
  role: string
  content: unknown[]
  source: unknown
}
