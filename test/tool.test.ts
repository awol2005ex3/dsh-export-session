import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createExportTool } from '../src/tool.js'
import type { Session } from '../src/collect.js'

interface Message {
  id: string
  role: string
  content: unknown[]
  source: unknown
}

function fakeSession(): Session {
  return {
    id: 's1',
    header: { version: 1, id: 's1', createdAt: 1000 },
    events: [],
    deriveMessages: () => ([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: '用户问题' }], source: { kind: 'user' } },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '助手回复内容' }],
        source: { kind: 'model', model: 'm', provider: 'p' },
      },
    ] as unknown as Message[]),
  } as unknown as Session
}

describe('createExportTool / export_session', () => {
  it('工具名为 export_session 且 format 为必填', () => {
    const tool = createExportTool({})
    expect(tool.name).toBe('export_session')
    expect((tool.parameters as { required?: string[] }).required).toContain('format')
  })

  it('agent 不可用时抛出可读错误', async () => {
    const tool = createExportTool({})
    await expect(
      tool.execute({ format: 'md' } as never, { agent: undefined, signal: new AbortController().signal } as never),
    ).rejects.toThrow(/exec\.agent\.session/)
  })

  it('完整路径：导出 md 并落盘，返回绝对路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-export-'))
    const tool = createExportTool({ defaultOutputDir: dir })
    const session = fakeSession()
    const exec = {
      agent: { session },
      signal: new AbortController().signal,
    } as never

    const result = (await tool.execute({ format: 'md', title: '集成测试' } as never, exec)) as {
      file: string
      format: string
      title: string
      entryCount: number
    }

    expect(result.format).toBe('md')
    expect(result.title).toBe('集成测试')
    expect(result.entryCount).toBe(2)
    expect(existsSync(result.file)).toBe(true)
    const content = readFileSync(result.file, 'utf8')
    expect(content).toContain('集成测试')
    expect(content).toContain('用户问题')
    expect(content).toContain('助手回复内容')
  })

  afterAll(async () => {
    await rm(join(tmpdir(), 'dsh-export-'), { recursive: true, force: true })
  })
})
