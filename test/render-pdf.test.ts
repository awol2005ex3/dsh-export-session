import { describe, expect, it } from 'vitest'

import { FontNotFoundError, resolveFonts } from '../src/fonts.js'
import { renderPdfFromMarkdown } from '../src/render-pdf.js'

/** 探测本机是否有可用中文字体（决定真实渲染测试能否跑）。 */
function hasFonts(): boolean {
  try {
    resolveFonts()
    return true
  } catch (error) {
    if (error instanceof FontNotFoundError) return false
    throw error
  }
}

describe('renderPdf', () => {
  it('markdownToPlain 剥离标记保留文本', async () => {
    const { markdownToPlain } = await import('../src/render-pdf.js')
    const plain = markdownToPlain('# 标题\n\n正文 **加粗** `代码`')
    expect(plain).toContain('标题')
    expect(plain).toContain('正文 加粗 代码')
  })

  it('含中文的 Markdown 能渲染为 PDF（本机有中文字体时）', async () => {
    if (!hasFonts()) {
      // 没有中文字体的环境（如部分 CI）跳过真实渲染，仅验证失败路径。
      expect(() => resolveFonts()).toThrow(FontNotFoundError)
      return
    }
    const buffer = await renderPdfFromMarkdown('# 测试\n\n这是中文内容，含 `code` 与表格：\n\n| A | B |\n| --- | --- |\n| 1 | 2 |', 'PDF 测试')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect(buffer.length).toBeGreaterThan(200)
    // PDF 文件魔数为 %PDF-
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
