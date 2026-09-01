import { describe, expect, it } from 'vitest'

import { formatTimestamp } from '../src/collect.js'
import { resolveOutputDir, sanitizeFileName, sanitizeFileName as sanitize2 } from '../src/export.js'

describe('sanitizeFileName', () => {
  it('去掉路径分隔与引号等非法字符', () => {
    expect(sanitizeFileName('a/b:c*?"<>\0|\\name')).toBe('a_b_c_name')
  })

  it('空白折叠为下划线并裁剪超长', () => {
    const long = 'x '.repeat(200)
    const out = sanitizeFileName(long)
    expect(out.length).toBeLessThanOrEqual(160)
    expect(out).not.toMatch(/ {2,}/)
  })

  it('空串退化为 session', () => {
    expect(sanitizeFileName('   ')).toBe('session')
    expect(sanitize2('')).toBe('session')
  })
})

describe('formatTimestamp', () => {
  it('格式化为本地 YYYY-MM-DD HH:mm:ss', () => {
    // 2026-01-02 03:04:05 UTC+? 用固定 epoch 校验格式宽度
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5)
    const out = formatTimestamp(ms)
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(out.startsWith('2026-01-02')).toBe(true)
  })
})

describe('resolveOutputDir', () => {
  it('缺省时返回 fallbackDir', () => {
    expect(resolveOutputDir(undefined, '/fallback')).toBe('/fallback')
    expect(resolveOutputDir('   ', '/fallback')).toBe('/fallback')
  })

  it('绝对路径直接采用', () => {
    expect(resolveOutputDir('/abs/dir', '/fallback')).toBe('/abs/dir')
  })

  it('相对路径拼到 fallbackDir 之下', () => {
    expect(resolveOutputDir('out', '/fallback').replace(/\\/g, '/')).toBe('/fallback/out')
  })
})
