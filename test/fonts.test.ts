import { afterEach, describe, expect, it } from 'vitest'

import { FontNotFoundError, resolveFonts } from '../src/fonts.js'

describe('resolveFonts', () => {
  const original = process.env.DSH_EXPORT_PDF_FONT

  afterEach(() => {
    if (original === undefined) delete process.env.DSH_EXPORT_PDF_FONT
    else process.env.DSH_EXPORT_PDF_FONT = original
  })

  it('显式指向不存在的字体时抛出 FontNotFoundError', () => {
    process.env.DSH_EXPORT_PDF_FONT = '/no/such/font.ttf'
    expect(() => resolveFonts()).toThrow(FontNotFoundError)
  })

  it('FontNotFoundError 携带探测路径', () => {
    process.env.DSH_EXPORT_PDF_FONT = '/no/such/font.ttf'
    try {
      resolveFonts()
      expect.unreachable('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(FontNotFoundError)
      expect((error as FontNotFoundError).probed).toContain('/no/such/font.ttf')
    }
  })
})
