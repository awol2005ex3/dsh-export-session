import { describe, expect, it } from 'vitest'

import { collectTranscript } from '../src/collect.js'
import { renderDocx } from '../src/render-docx.js'
import type { Session } from '../src/collect.js'

function fakeSession(): Session {
  return {
    id: 's1',
    header: { version: 1, id: 's1', createdAt: 1000, cwd: '/w', agentPreset: 'd' },
    events: [],
    deriveMessages: () => ([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '用户问题' }], source: { kind: 'user' } },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: '# 标题\n\n正文，含 `代码` 与 **加粗**。\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |' },
        ],
        source: { kind: 'model', model: 'm', provider: 'p' },
      },
    ] as unknown as Message[]),
  } as unknown as Session
}

interface Message {
  id: string
  role: string
  content: unknown[]
  source: unknown
}

describe('renderDocx', () => {
  it('返回一个非空的 docx 二进制 Buffer（ZIP 头部 PK）', async () => {
    const buffer = await renderDocx(collectTranscript(fakeSession()), '标题测试')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.length).toBeGreaterThan(100)
    // docx 是 OOXML，本质是一个 ZIP 包，魔数为 PK\x03\x04
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK')
  })
})
