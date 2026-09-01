import { describe, expect, it } from 'vitest'

import {
  displayWidth,
  inlineToPlain,
  parseInline,
  parseMarkdownBlocks,
  stripInline,
} from '../src/md-blocks.js'

describe('parseMarkdownBlocks', () => {
  it('识别标题与正文', () => {
    const blocks = parseMarkdownBlocks('# 标题\n\n这是正文。\n')
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: '标题' })
    expect(blocks[1]).toMatchObject({ kind: 'paragraph', text: '这是正文。' })
  })

  it('识别围栏代码块（含语言）', () => {
    const blocks = parseMarkdownBlocks('```ts\nconst a = 1\n```\n')
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'ts', code: 'const a = 1' })
  })

  it('识别引用块', () => {
    const blocks = parseMarkdownBlocks('> 引用一行\n> 引用二行\n')
    expect(blocks[0]).toMatchObject({ kind: 'quote', text: '引用一行\n引用二行' })
  })

  it('识别有序与无序列表', () => {
    const ordered = parseMarkdownBlocks('1. 一\n2. 二\n')
    expect(ordered[0]).toMatchObject({ kind: 'list', ordered: true, items: ['一', '二'] })
    const unordered = parseMarkdownBlocks('- a\n- b\n')
    expect(unordered[0]).toMatchObject({ kind: 'list', ordered: false, items: ['a', 'b'] })
  })

  it('识别 Markdown 表格（分隔行带冒号也算）', () => {
    const blocks = parseMarkdownBlocks('| 列A | 列B |\n| --- | :---: |\n| 1 | 2 |\n')
    expect(blocks[0]).toMatchObject({
      kind: 'table',
      headers: ['列A', '列B'],
      rows: [['1', '2']],
    })
  })

  it('识别分隔线', () => {
    const blocks = parseMarkdownBlocks('上文\n\n---\n\n下文')
    const rule = blocks.find(b => b.kind === 'rule')
    expect(rule).toBeDefined()
  })
})

describe('parseInline / stripInline', () => {
  it('解析加粗、行内代码、链接', () => {
    const runs = parseInline('普通 **粗** `代码` [文本](https://x.com)')
    const codes = runs.filter(r => r.code).map(r => r.text)
    const bolds = runs.filter(r => r.bold).map(r => r.text)
    const links = runs.filter(r => r.href !== undefined).map(r => r.text)
    expect(codes).toContain('代码')
    expect(bolds).toContain('粗')
    expect(links).toContain('文本')
  })

  it('stripInline 去掉所有标记', () => {
    expect(stripInline('**粗** `代码` [文本](https://x.com)')).toBe('粗 代码 文本')
  })

  it('inlineToPlain 拼回纯文本', () => {
    expect(inlineToPlain(parseInline('a **b** c'))).toBe('a b c')
  })
})

describe('displayWidth', () => {
  it('中文记 2 宽，ASCII 记 1 宽', () => {
    expect(displayWidth('中文ab')).toBe(6)
    expect(displayWidth('abc')).toBe(3)
  })
})
