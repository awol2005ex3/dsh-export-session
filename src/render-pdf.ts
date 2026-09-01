/**
 * transcript → PDF。
 *
 * pdfkit 是流式绘制 API：没有自动布局，行高、分页、表格网格都要自己算。
 * 因此本模块先走 {@link renderMarkdown} 得到稳定的 Markdown，再用块解析器
 * 逐块排版，好处是三种格式的块结构完全一致，只是排版后端不同。
 *
 * 中文处理见 {@link ./fonts.ts}：必须嵌入真实字体，且 `.ttc` 集合要给出
 * 集合内的 PostScript 名。代码块默认用等宽字体，但检测到中文时自动切回
 * 中文字体（Consolas 之类的等宽字体没有中文字形，会渲染成空白）。
 *
 * @module dsh-session-export/render-pdf
 */

import PDFDocument from 'pdfkit'

import { formatTimestamp, type Transcript, type TranscriptEntry, type ToolCallEntry } from './collect.js'
import { resolveFonts, type FontSet } from './fonts.js'
import { displayWidth, inlineToPlain, parseInline, parseMarkdownBlocks, stripInline, type MdBlock } from './md-blocks.js'
import { renderMarkdown } from './render-markdown.js'

/** A4 纵向（pt）。 */
const PAGE = { width: 595.28, height: 841.89 }
/** 页边距。 */
const MARGIN = { top: 56, bottom: 56, left: 50, right: 50 }
/** 内容区宽度。 */
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right
/** 正文可用高度的底部边界。 */
const BOTTOM = PAGE.height - MARGIN.bottom

/** 配色。 */
const COLOR = {
  text: '#1F2328',
  heading: '#111418',
  muted: '#6B7280',
  faint: '#8A94A6',
  codeText: '#24292F',
  codeBg: '#F4F5F7',
  quoteBg: '#FAFBFC',
  border: '#D8DEE9',
  headerBg: '#EEF1F5',
  link: '#1155CC',
  error: '#C0392B',
  role: '#2563EB',
}

/** 字号（pt）。 */
const SIZE = {
  h1: 19,
  h2: 13.5,
  h3: 12,
  h4: 11,
  h5: 10,
  h6: 10,
  body: 10.5,
  code: 8.8,
  meta: 9,
  footer: 8,
}

/** 行高系数。 */
const LINE_GAP = { body: 4.5, code: 2, heading: 3 }

/** 代码块 / 引用块的内边距。 */
const PAD = { code: 6, quote: 8, cell: 5 }

const ROLE_LABEL: Record<TranscriptEntry['kind'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  context: '上下文',
}

/** 是否包含 CJK 字符（决定代码块能否用等宽字体）。 */
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/

/** 一个轻量排版游标：维护当前 y，按需翻页。 */
class Layout {
  constructor(
    readonly doc: PDFKit.PDFDocument,
    readonly fonts: { body: string; bold: string; mono: string },
  ) {}

  /** 当前绘制位置（pt）。 */
  get y(): number {
    return this.doc.y
  }

  /** 剩余可用高度。 */
  get remaining(): number {
    return BOTTOM - this.doc.y
  }

  /** 若剩余空间不足则翻页（翻页后 y 归位到页顶）。 */
  ensure(height: number): void {
    if (this.doc.y + height <= BOTTOM) return
    this.doc.addPage()
    this.doc.y = MARGIN.top
  }

  /** 预估一段文本在给定宽度与字号下的高度。 */
  measure(text: string, width: number, size: number, font = this.fonts.body): number {
    this.doc.font(font)
    return this.doc.heightOfString(text, { width, size, lineGap: LINE_GAP.body } as never)
  }

  /** 预留一段垂直空白（不足则先翻页）。 */
  space(height: number): void {
    this.ensure(height)
    this.doc.moveDown(Math.max(0, height / (SIZE.body * 1.5)))
  }
}

/** 绘制一条水平分隔线。 */
function drawRule(layout: Layout): void {
  const doc = layout.doc
  layout.ensure(14)
  const y = doc.y + 5
  doc.save()
    .strokeColor(COLOR.border)
    .lineWidth(0.6)
    .moveTo(MARGIN.left, y)
    .lineTo(MARGIN.left + CONTENT_WIDTH, y)
    .stroke()
    .restore()
  doc.y = y + 9
}

/** 绘制代码块：逐行灰底，天然支持跨页。 */
function drawCode(layout: Layout, code: string, lang?: string): void {
  const doc = layout.doc
  const mono = layout.fonts.mono
  const font = CJK.test(code) ? layout.fonts.body : mono
  const lineHeight = SIZE.code * 1.45

  layout.ensure(lineHeight + 12)

  if (lang !== undefined && lang !== '') {
    doc.font(layout.fonts.body).fontSize(SIZE.meta).fillColor(COLOR.faint)
      .text(lang, MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
    doc.y += 2
  }

  const top = doc.y
  doc.save().rect(MARGIN.left, top, CONTENT_WIDTH, 0).fillColor(COLOR.codeBg).fill().restore()

  for (const line of code.split('\n')) {
    layout.ensure(lineHeight + PAD.code)
    const y = doc.y
    doc.save()
      .rect(MARGIN.left, y, CONTENT_WIDTH, lineHeight + 2)
      .fillColor(COLOR.codeBg)
      .fill()
      .restore()
    doc.font(font).fontSize(SIZE.code).fillColor(COLOR.codeText)
      .text(line === '' ? ' ' : line, MARGIN.left + PAD.code, y + 1, {
        width: CONTENT_WIDTH - PAD.code * 2,
        lineBreak: false,
      })
    doc.y = y + lineHeight + 2
  }

  doc.y += PAD.code
}

/** 绘制引用块：左侧竖线 + 浅底。 */
function drawQuote(layout: Layout, text: string): void {
  const doc = layout.doc
  const width = CONTENT_WIDTH - PAD.quote * 2 - 6
  const height = layout.measure(stripInline(text), width, SIZE.body) + PAD.quote * 2

  layout.ensure(height + 8)
  const top = doc.y

  doc.save()
    .rect(MARGIN.left + 6, top, CONTENT_WIDTH - 6, height)
    .fillColor(COLOR.quoteBg)
    .fill()
    .rect(MARGIN.left + 6, top, 2.5, height)
    .fillColor(COLOR.border)
    .fill()
    .restore()

  doc.y = top + PAD.quote
  for (const line of text.split('\n')) {
    doc.font(layout.fonts.body).fontSize(SIZE.body).fillColor(COLOR.muted)
      .text(stripInline(line), MARGIN.left + 6 + PAD.quote, doc.y, {
        width,
        lineGap: LINE_GAP.body,
      })
  }
  doc.y = Math.max(doc.y, top + height) + 6
}

/** 绘制列表。 */
function drawList(layout: Layout, items: string[], ordered: boolean): void {
  const doc = layout.doc
  const indent = 18
  const width = CONTENT_WIDTH - indent

  items.forEach((item, index) => {
    const marker = ordered ? `${index + 1}.` : '•'
    const height = layout.measure(stripInline(item), width, SIZE.body)
    layout.ensure(height + 4)
    const top = doc.y

    doc.font(layout.fonts.body).fontSize(SIZE.body).fillColor(COLOR.muted)
      .text(marker, MARGIN.left, top, { width: indent - 4, lineBreak: false, align: 'right' })

    doc.font(layout.fonts.body).fontSize(SIZE.body).fillColor(COLOR.text)
      .text(stripInline(item), MARGIN.left + indent, top, {
        width,
        lineGap: LINE_GAP.body,
      })
  })
  doc.y += 6
}

/** 按内容宽度比例分配列宽，并保证每列有一个可读的最小宽度。 */
function computeColumnWidths(headers: string[], rows: string[][], total: number): number[] {
  const columns = Math.max(1, headers.length)
  const weights = headers.map((header, index) => {
    const cellWidths = rows.map(row => displayWidth(row[index] ?? ''))
    return Math.max(displayWidth(header), ...cellWidths) + 2
  })
  const sum = weights.reduce((acc, value) => acc + value, 0) || 1
  const minWidth = total * 0.12

  return Array.from({ length: columns }, (_, index) => {
    const weight = weights[index] ?? 1
    return Math.max(minWidth, (total * weight) / sum)
  })
}

/** 绘制表格：逐格矩形边框，跨页安全（不做表头重复）。 */
function drawTable(layout: Layout, headers: string[], rows: string[][]): void {
  const doc = layout.doc
  const total = CONTENT_WIDTH
  const widths = computeColumnWidths(headers, rows, total)

  /** 单格最小宽度，防止内容极少的列被压成一条线。 */
  const minCell = 40

  /** 画一行。 */
  const drawRow = (cells: string[], bold: boolean): void => {
    const cellTexts = cells.map(cell => stripInline(cell))
    doc.font(layout.fonts.body)
    const heights = cellTexts.map((text, index) =>
      doc.heightOfString(text || ' ', {
        width: (widths[index] ?? minCell) - PAD.cell * 2,
        size: SIZE.body - 0.5,
        lineGap: 2,
      } as never))
    const rowHeight = Math.max(...heights) + PAD.cell * 2

    layout.ensure(rowHeight)
    const top = doc.y

    doc.save().lineWidth(0.5).strokeColor(COLOR.border)
    let x = MARGIN.left
    cellTexts.forEach((text, index) => {
      const width = widths[index] ?? minCell
      doc.rect(x, top, width, rowHeight)
        .fillColor(bold ? COLOR.headerBg : '#FFFFFF')
        .fill()
        .stroke()
      doc.font(bold ? layout.fonts.bold : layout.fonts.body)
        .fontSize(SIZE.body - 0.5)
        .fillColor(COLOR.text)
        .text(text, x + PAD.cell, top + PAD.cell, {
          width: width - PAD.cell * 2,
          lineGap: 2,
        })
      x += width
    })
    doc.restore()
    doc.y = top + rowHeight
  }

  layout.ensure(40)
  drawRow(headers, true)
  for (const row of rows) drawRow(row, false)
  doc.y += 8
}

/** 绘制章节标题（自动按级别选字号与字重）。 */
function drawHeading(layout: Layout, text: string, level: number): void {
  const doc = layout.doc
  const size = level <= 1 ? SIZE.h1 : level === 2 ? SIZE.h2 : level === 3 ? SIZE.h3 : level === 4 ? SIZE.h4 : SIZE.h5
  const height = layout.measure(stripInline(text), CONTENT_WIDTH, size) + LINE_GAP.heading * 2

  layout.ensure(height + 10)
  const top = doc.y + (level <= 2 ? 6 : 3)

  doc.font(level <= 2 ? layout.fonts.bold : layout.fonts.body)
    .fontSize(size)
    .fillColor(level <= 2 ? COLOR.heading : COLOR.text)
    .text(stripInline(text), MARGIN.left, top, {
      width: CONTENT_WIDTH,
      lineGap: LINE_GAP.heading,
    })

  doc.y += 4

  if (level <= 1) {
    doc.save()
      .strokeColor(COLOR.border)
      .lineWidth(0.8)
      .moveTo(MARGIN.left, doc.y + 2)
      .lineTo(MARGIN.left + CONTENT_WIDTH, doc.y + 2)
      .stroke()
      .restore()
    doc.y += 8
  }
}

/** 绘制普通段落（保留加粗 / 行内代码 / 链接颜色）。 */
function drawParagraph(layout: Layout, text: string): void {
  const doc = layout.doc
  const height = layout.measure(stripInline(text), CONTENT_WIDTH, SIZE.body)
  layout.ensure(height)

  for (const line of text.split('\n')) {
    doc.font(layout.fonts.body).fontSize(SIZE.body).fillColor(COLOR.text)
      .text(stripInline(line), MARGIN.left, doc.y, {
        width: CONTENT_WIDTH,
        lineGap: LINE_GAP.body,
      })
  }
  doc.y += 6
}

/** 一个 Markdown 块 → PDF 绘制。 */
function drawBlock(layout: Layout, block: MdBlock, baseLevel: number): void {
  switch (block.kind) {
    case 'heading':
      drawHeading(layout, block.text, block.level + baseLevel)
      break
    case 'code':
      drawCode(layout, block.code, block.lang)
      break
    case 'quote':
      drawQuote(layout, block.text)
      break
    case 'list':
      drawList(layout, block.items, block.ordered)
      break
    case 'table':
      drawTable(layout, block.headers, block.rows)
      break
    case 'rule':
      drawRule(layout)
      break
    case 'paragraph':
    default:
      drawParagraph(layout, block.text)
      break
  }
}

/** 一段 Markdown 文本 → PDF 绘制（baseLevel 用于整体降级，避免抢占文档 h1）。 */
function drawMarkdown(layout: Layout, markdown: string, baseLevel = 3): void {
  for (const block of parseMarkdownBlocks(markdown)) drawBlock(layout, block, baseLevel)
}

/** 会话元信息：两列紧凑表格。 */
function drawMeta(layout: Layout, transcript: Transcript): void {
  const { meta } = transcript
  const rows: Array<[string, string]> = [['会话 ID', meta.sessionId]]
  if (meta.createdAt !== undefined) rows.push(['创建时间', formatTimestamp(meta.createdAt)])
  if (meta.updatedAt !== undefined) rows.push(['最后更新', formatTimestamp(meta.updatedAt)])
  if (meta.cwd !== undefined && meta.cwd !== '') rows.push(['工作目录', meta.cwd])
  if (meta.model !== undefined && meta.model !== '') rows.push(['模型', meta.model])
  if (meta.provider !== undefined && meta.provider !== '') rows.push(['服务商', meta.provider])
  if (meta.agentPreset !== undefined) rows.push(['Agent 预设', meta.agentPreset])
  rows.push(['助手回复数', String(meta.turnCount)])
  rows.push(['工具调用数', String(meta.toolCallCount)])

  const doc = layout.doc
  const keyWidth = 78
  const valueWidth = CONTENT_WIDTH - keyWidth
  const rowHeight = SIZE.meta * 1.7

  for (const [key, value] of rows) {
    layout.ensure(rowHeight)
    const top = doc.y
    doc.font(layout.fonts.body).fontSize(SIZE.meta).fillColor(COLOR.muted)
      .text(key, MARGIN.left, top, { width: keyWidth - 6, lineBreak: false })
    doc.font(layout.fonts.body).fontSize(SIZE.meta).fillColor(COLOR.text)
      .text(value, MARGIN.left + keyWidth, top, { width: valueWidth, lineBreak: false })
    doc.y = top + rowHeight
  }
  doc.y += 6
}

/** 角色标题行：角色名（+ 时间戳）。 */
function drawRoleHeading(layout: Layout, label: string, time: number | undefined, withTime: boolean): void {
  const doc = layout.doc
  layout.ensure(30)
  const top = doc.y + 4

  doc.font(layout.fonts.bold).fontSize(SIZE.h2).fillColor(COLOR.role)
    .text(label, MARGIN.left, top, { width: CONTENT_WIDTH * 0.62, lineBreak: false })

  if (withTime && time !== undefined) {
    doc.font(layout.fonts.body).fontSize(SIZE.meta).fillColor(COLOR.faint)
      .text(formatTimestamp(time), MARGIN.left + CONTENT_WIDTH * 0.62, top + 2, {
        width: CONTENT_WIDTH * 0.38,
        align: 'right',
        lineBreak: false,
      })
  }

  doc.save()
    .strokeColor(COLOR.border)
    .lineWidth(0.5)
    .moveTo(MARGIN.left, top + SIZE.h2 + 5)
    .lineTo(MARGIN.left + CONTENT_WIDTH, top + SIZE.h2 + 5)
    .stroke()
    .restore()

  doc.y = top + SIZE.h2 + 12
}

/** 一次工具调用：标题 + 参数 + 结果。 */
function drawToolCall(layout: Layout, call: ToolCallEntry, result: TranscriptEntry | undefined): void {
  const doc = layout.doc

  layout.ensure(28)
  doc.font(layout.fonts.bold).fontSize(SIZE.h4).fillColor(COLOR.text)
    .text('工具调用：', MARGIN.left, doc.y, { width: 52, lineBreak: false, continued: true })
  doc.font(layout.fonts.mono).fontSize(SIZE.h4).fillColor(COLOR.heading)
    .text(call.name, { lineBreak: false })
  doc.y += 8

  if (call.arguments !== undefined && call.arguments !== '') drawCode(layout, call.arguments)

  if (result !== undefined && result.kind === 'tool') {
    layout.ensure(22)
    doc.font(layout.fonts.body).fontSize(SIZE.meta)
      .fillColor(result.isError ? COLOR.error : COLOR.muted)
      .text(result.isError ? '调用失败' : '调用结果', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
    doc.y += 2
    if (result.output === '') {
      doc.font(layout.fonts.body).fontSize(SIZE.code).fillColor(COLOR.faint)
        .text('（无输出）', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
      doc.y += 12
    } else {
      drawCode(layout, result.output)
    }
  }
}

/** 在每一页底部补页码（需要 `bufferPages: true`）。 */
function stampFooters(doc: PDFKit.PDFDocument, font: string): void {
  const range = doc.bufferedPageRange()
  const count = range.count
  for (let index = 0; index < count; index += 1) {
    doc.switchToPage(range.start + index)
    doc.font(font).fontSize(SIZE.footer).fillColor(COLOR.faint)
      .text(`第 ${index + 1} 页 / 共 ${count} 页`, MARGIN.left, PAGE.height - MARGIN.bottom + 18, {
        width: CONTENT_WIDTH,
        align: 'center',
        lineBreak: false,
      })
  }
}

/** 把 PDF 文档流收集成 Buffer。 */
function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

/** 注册字体并返回 pdfkit 内部使用的字体名。 */
function registerFonts(doc: PDFKit.PDFDocument, fonts: FontSet): { body: string; bold: string; mono: string } {
  doc.registerFont('dsh-cjk', fonts.cjk.path, fonts.cjk.family)
  const bold = fonts.cjkBold
  if (bold !== undefined) doc.registerFont('dsh-cjk-bold', bold.path, bold.family)
  const mono = fonts.mono
  if (mono !== undefined) doc.registerFont('dsh-mono', mono.path, mono.family)

  return {
    body: 'dsh-cjk',
    bold: bold === undefined ? 'dsh-cjk' : 'dsh-cjk-bold',
    mono: mono === undefined ? 'dsh-cjk' : 'dsh-mono',
  }
}

/**
 * 把一份 transcript 渲染为 PDF 二进制内容。
 *
 * @param transcript - {@link collectTranscript} 的产物。
 * @param title - 文档标题。
 * @returns PDF 文件的 Buffer。
 * @throws 找不到中文字体时抛出（见 {@link ./fonts.ts}）。
 */
export async function renderPdf(transcript: Transcript, title = '会话导出'): Promise<Buffer> {
  const fonts = resolveFonts()
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: MARGIN,
    bufferPages: true,
    info: {
      Title: title,
      Author: 'dsh-session-export',
      Subject: `DeepSeek Harness 会话导出（${transcript.meta.sessionId}）`,
      Creator: 'dsh-session-export',
    },
  })

  const names = registerFonts(doc, fonts)
  const layout = new Layout(doc, names)
  const withTime = transcript.meta.options.includeTimestamps

  doc.y = MARGIN.top
  drawHeading(layout, title, 1)
  if (withTime) drawMeta(layout, transcript)
  drawRule(layout)

  const consumed = new Set<string>()
  const resultByCallId = new Map<string, TranscriptEntry>()
  for (const entry of transcript.entries) {
    if (entry.kind === 'tool') resultByCallId.set(entry.callId, entry)
  }

  for (const entry of transcript.entries) {
    if (entry.kind === 'tool') {
      if (consumed.has(entry.callId)) continue
      drawRoleHeading(layout, `工具结果：${entry.name}`, entry.time, withTime)
      if (entry.isError) {
        doc.font(names.bold).fontSize(SIZE.meta).fillColor(COLOR.error)
          .text('调用失败', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
        doc.y += 3
      }
      if (entry.output === '') {
        doc.font(names.body).fontSize(SIZE.code).fillColor(COLOR.faint)
          .text('（无输出）', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
        doc.y += 12
      } else {
        drawCode(layout, entry.output)
      }
      continue
    }

    let label = ROLE_LABEL[entry.kind]
    if (entry.kind === 'context' && entry.plugin !== undefined) label = `${ROLE_LABEL.context} · ${entry.plugin}`
    drawRoleHeading(layout, label, entry.time, withTime)

    if (entry.kind === 'assistant' && entry.reasoning !== undefined && entry.reasoning !== '') {
      doc.font(names.body).fontSize(SIZE.meta).fillColor(COLOR.muted)
        .text('推理过程', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
      doc.y += 2
      drawQuote(layout, entry.reasoning)
    }

    if (entry.text !== '') drawMarkdown(layout, entry.text)

    if (entry.kind === 'assistant') {
      if (entry.interrupted === true) {
        doc.font(names.body).fontSize(SIZE.code).fillColor(COLOR.faint)
          .text('（该回复被中断）', MARGIN.left, doc.y, { width: CONTENT_WIDTH, lineBreak: false })
        doc.y += 12
      }
      for (const call of entry.toolCalls) {
        const result = resultByCallId.get(call.callId)
        if (result !== undefined) consumed.add(call.callId)
        drawToolCall(layout, call, result)
      }
    }

    layout.space(10)
  }

  stampFooters(doc, names.body)
  return toBuffer(doc)
}

/** 便捷入口：直接把一段 Markdown 渲染成 PDF（测试与复用）。 */
export async function renderPdfFromMarkdown(markdown: string, title = '会话导出'): Promise<Buffer> {
  const fonts = resolveFonts()
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: MARGIN,
    bufferPages: true,
    info: { Title: title, Author: 'dsh-session-export', Creator: 'dsh-session-export' },
  })
  const names = registerFonts(doc, fonts)
  const layout = new Layout(doc, names)

  doc.y = MARGIN.top
  drawHeading(layout, title, 1)
  drawMarkdown(layout, markdown, 1)
  stampFooters(doc, names.body)
  return toBuffer(doc)
}

/** 便于测试：导出纯文本投影（剥离所有标记）。 */
export function markdownToPlain(markdown: string): string {
  return parseMarkdownBlocks(markdown)
    .map(block => {
      if (block.kind === 'table') {
        return [block.headers.join(' | '), ...block.rows.map(row => row.join(' | '))].join('\n')
      }
      if (block.kind === 'code') return block.code
      if (block.kind === 'rule') return '---'
      if (block.kind === 'list') return block.items.join('\n')
      return inlineToPlain(parseInline(block.text)).trim()
    })
    .filter(part => part !== '')
    .join('\n\n')
}
