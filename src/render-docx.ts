/**
 * transcript → Word (.docx)。
 *
 * 先走 {@link renderMarkdown} 得到稳定 Markdown，再用块解析器排版成
 * 真正的 Word 结构：Markdown 表格变成 Word 表格（不是等宽文本），
 * 代码块带底纹与等宽字体，引用块带左侧竖线。
 *
 * 字体策略：正文用东亚字体名 `Microsoft YaHei`（Office 2010+ 自带，
 * 中文显示正常；缺字时 Word 自行回退），代码用 `Consolas`。
 * 这些只是 Word 里的字体名，不需要本机安装对应文件。
 *
 * @module dsh-session-export/render-docx
 */

import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

import { formatTimestamp, type Transcript, type TranscriptEntry, type ToolCallEntry } from './collect.js'
import { parseInline, parseMarkdownBlocks, type MdBlock } from './md-blocks.js'
import { renderMarkdown } from './render-markdown.js'

/** 正文字体（半角 + 东亚）。 */
const BODY_FONT = { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei', cs: 'Microsoft YaHei' }
/** 等宽字体，用于代码与工具名。 */
const MONO_FONT = { ascii: 'Consolas', eastAsia: 'Microsoft YaHei', hAnsi: 'Consolas', cs: 'Consolas' }

/** 代码块底纹。 */
const CODE_FILL = 'F2F3F5'
/** 引用块底纹（极浅，仅作视觉分区）。 */
const QUOTE_FILL = 'FAFAFA'

/** 正文尺寸（half-points）：22 = 11pt。 */
const BODY_SIZE = 22
/** 代码尺寸（half-points）：20 = 10pt。 */
const CODE_SIZE = 20

const ROLE_LABEL: Record<TranscriptEntry['kind'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  context: '上下文',
}

/** 行内片段 → Word TextRun（保留加粗/斜体/行内代码）。 */
function inlineRuns(text: string, options: { code?: boolean } = {}): TextRun[] {
  const runs = parseInline(text)
  if (runs.length === 0) return [new TextRun({ text: '', font: options.code === true ? MONO_FONT : BODY_FONT })]

  return runs.map(run => {
    const font = run.code === true || options.code === true ? MONO_FONT : BODY_FONT
    const size = run.code === true || options.code === true ? CODE_SIZE : BODY_SIZE
    const style: Record<string, unknown> = { text: run.text, font, size }
    if (run.bold === true) style.bold = true
    if (run.italic === true) style.italics = true
    if (run.code === true || options.code === true) {
      style.shading = { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' }
    }
    if (run.href !== undefined) {
      style.color = '1155CC'
      style.underline = {}
    }
    return new TextRun(style)
  })
}

/** 等宽段落（代码块的一行）。空行保留一个零宽内容，避免被 Word 折叠。 */
function codeLine(text: string): Paragraph {
  return new Paragraph({
    children: text === '' ? [new TextRun({ text: ' ', font: MONO_FONT, size: CODE_SIZE })] : inlineRuns(text, { code: true }),
    spacing: { before: 0, after: 0, line: 260 },
    shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
    indent: { left: 240, right: 240 },
  })
}

/** 构造一个带细边框的表格。 */
function buildTable(headers: string[], rows: string[][]): Table {
  const columns = Math.max(1, headers.length)
  const width = Math.floor(100 / columns)

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(cell => new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: 'EEF1F5', color: 'auto' },
      children: [new Paragraph({
        children: [new TextRun({ text: cell, font: BODY_FONT, size: BODY_SIZE, bold: true })],
        spacing: { before: 40, after: 40 },
      })],
    })),
  })

  const bodyRows = rows.map(row => new TableRow({
    children: Array.from({ length: columns }, (_, index) => new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      children: [new Paragraph({
        children: inlineRuns(row[index] ?? ''),
        spacing: { before: 40, after: 40 },
      })],
    })),
  }))

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  })
}

/** 一个 Markdown 块 → 一组 Word 段落 / 表格。 */
function renderBlock(block: MdBlock): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level + 2, 3), 6)
      const heading = level === 3
        ? HeadingLevel.HEADING_3
        : level === 4 ? HeadingLevel.HEADING_4
          : level === 5 ? HeadingLevel.HEADING_5
            : HeadingLevel.HEADING_6
      return [new Paragraph({
        heading,
        children: inlineRuns(block.text),
        spacing: { before: 200, after: 100 },
      })]
    }

    case 'code':
      return [
        new Paragraph({ children: [], spacing: { before: 120, after: 0 } }),
        ...block.code.split('\n').map(codeLine),
        new Paragraph({ children: [], spacing: { before: 0, after: 120 } }),
      ]

    case 'quote':
      return block.text.split('\n').map(line => new Paragraph({
        children: inlineRuns(line),
        spacing: { before: 60, after: 60, line: 300 },
        indent: { left: 360 },
        shading: { type: ShadingType.CLEAR, fill: QUOTE_FILL, color: 'auto' },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'B9C0CC', space: 8 } },
      }))

    case 'list':
      return block.items.map((item, index) => new Paragraph({
        children: [new TextRun({
          text: block.ordered ? `${index + 1}. ` : '• ',
          font: BODY_FONT,
          size: BODY_SIZE,
        }), ...inlineRuns(item)],
        spacing: { before: 40, after: 40, line: 300 },
        indent: { left: 480, hanging: 240 },
      }))

    case 'table':
      return [buildTable(block.headers, block.rows)]

    case 'rule':
      return [new Paragraph({
        children: [],
        spacing: { before: 120, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D8DEE9', space: 4 } },
      })]

    case 'paragraph':
    default:
      return block.text.split('\n').map(line => new Paragraph({
        children: inlineRuns(line),
        spacing: { before: 60, after: 60, line: 320 },
      }))
  }
}

/** 一段 Markdown 文本 → Word 块序列。 */
function markdownToBlocks(markdown: string): Array<Paragraph | Table> {
  return parseMarkdownBlocks(markdown).flatMap(renderBlock)
}

/** 一次工具调用（标题 + 参数 + 结果）。 */
function renderToolCall(call: ToolCallEntry, result: TranscriptEntry | undefined): Array<Paragraph | Table> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.HEADING_4,
      children: [new TextRun({ text: '工具调用：', font: BODY_FONT, size: BODY_SIZE, bold: true }),
        new TextRun({ text: call.name, font: MONO_FONT, size: BODY_SIZE, bold: true })],
      spacing: { before: 180, after: 80 },
    }),
  ]

  if (call.arguments !== undefined && call.arguments !== '') {
    children.push(new Paragraph({
      children: [new TextRun({ text: '参数', font: BODY_FONT, size: CODE_SIZE, bold: true, color: '5A6472' })],
      spacing: { before: 60, after: 40 },
    }))
    children.push(...call.arguments.split('\n').map(codeLine))
  }

  if (result !== undefined && result.kind === 'tool') {
    children.push(new Paragraph({
      children: [new TextRun({
        text: result.isError ? '调用失败' : '调用结果',
        font: BODY_FONT,
        size: CODE_SIZE,
        bold: true,
        color: result.isError ? 'C0392B' : '5A6472',
      })],
      spacing: { before: 100, after: 40 },
    }))
    if (result.output === '') {
      children.push(new Paragraph({
        children: [new TextRun({ text: '（无输出）', font: BODY_FONT, size: CODE_SIZE, color: '8A94A6' })],
        spacing: { before: 0, after: 60 },
      }))
    } else {
      children.push(...result.output.split('\n').map(codeLine))
    }
  }

  return children
}

/** 会话元信息表格。 */
function metaTable(transcript: Transcript): Table {
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

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([key, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 28, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.CLEAR, fill: 'EEF1F5', color: 'auto' },
          children: [new Paragraph({
            children: [new TextRun({ text: key, font: BODY_FONT, size: CODE_SIZE, bold: true })],
            spacing: { before: 40, after: 40 },
          })],
        }),
        new TableCell({
          width: { size: 72, type: WidthType.PERCENTAGE },
          children: [new Paragraph({
            children: [new TextRun({ text: value, font: BODY_FONT, size: CODE_SIZE })],
            spacing: { before: 40, after: 40 },
          })],
        }),
      ],
    })),
  })
}

/**
 * 把一份 transcript 渲染为 .docx 文件的二进制内容。
 *
 * @param transcript - {@link collectTranscript} 的产物。
 * @param title - 文档标题。
 * @returns docx 文件的 Buffer，可直接写盘。
 */
export async function renderDocx(transcript: Transcript, title = '会话导出'): Promise<Buffer> {
  const withTime = transcript.meta.options.includeTimestamps
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: title, font: BODY_FONT, bold: true })] }),
  ]

  if (withTime) children.push(metaTable(transcript))

  const consumed = new Set<string>()
  const resultByCallId = new Map<string, TranscriptEntry>()
  for (const entry of transcript.entries) {
    if (entry.kind === 'tool') resultByCallId.set(entry.callId, entry)
  }

  for (const entry of transcript.entries) {
    if (entry.kind === 'tool' && consumed.has(entry.callId)) continue

    const timeText = withTime && entry.time !== undefined ? `（${formatTimestamp(entry.time)}）` : ''
    let label = ROLE_LABEL[entry.kind]

    if (entry.kind === 'context' && entry.plugin !== undefined) label = `${ROLE_LABEL.context} · ${entry.plugin}`

    if (entry.kind === 'tool') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: `${ROLE_LABEL.tool}结果：${entry.name}${timeText}`, font: BODY_FONT, bold: true })],
        spacing: { before: 240, after: 100 },
      }))
      if (entry.isError) {
        children.push(new Paragraph({
          children: [new TextRun({ text: '调用失败', font: BODY_FONT, size: CODE_SIZE, bold: true, color: 'C0392B' })],
          spacing: { before: 60, after: 40 },
        }))
      }
      if (entry.output === '') {
        children.push(new Paragraph({
          children: [new TextRun({ text: '（无输出）', font: BODY_FONT, size: CODE_SIZE, color: '8A94A6' })],
          spacing: { before: 0, after: 60 },
        }))
      } else {
        children.push(...entry.output.split('\n').map(codeLine))
      }
      continue
    }

    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: `${label}${timeText}`, font: BODY_FONT, bold: true })],
      spacing: { before: 240, after: 100 },
    }))

    if (entry.kind === 'assistant' && entry.reasoning !== undefined && entry.reasoning !== '') {
      children.push(new Paragraph({
        children: [new TextRun({ text: '推理过程', font: BODY_FONT, size: CODE_SIZE, bold: true, color: '5A6472' })],
        spacing: { before: 80, after: 40 },
      }))
      for (const line of entry.reasoning.split('\n')) {
        children.push(new Paragraph({
          children: inlineRuns(line),
          spacing: { before: 20, after: 20, line: 300 },
          indent: { left: 360 },
          shading: { type: ShadingType.CLEAR, fill: QUOTE_FILL, color: 'auto' },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'C7CBD4', space: 8 } },
        }))
      }
    }

    if (entry.text !== '') children.push(...markdownToBlocks(entry.text))

    if (entry.kind === 'assistant') {
      if (entry.interrupted === true) {
        children.push(new Paragraph({
          children: [new TextRun({ text: '（该回复被中断）', font: BODY_FONT, size: CODE_SIZE, italics: true, color: '8A94A6' })],
          spacing: { before: 60, after: 60 },
        }))
      }
      for (const call of entry.toolCalls) {
        const result = resultByCallId.get(call.callId)
        if (result !== undefined) consumed.add(call.callId)
        children.push(...renderToolCall(call, result))
      }
    }
  }

  const doc = new Document({
    creator: 'dsh-session-export',
    title,
    description: `DeepSeek Harness 会话导出（${transcript.meta.sessionId}）`,
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: BODY_SIZE } },
      },
    },
    sections: [{ children }],
  })

  return Packer.toBuffer(doc)
}

/** 便捷入口：直接拿 Markdown 文本生成 docx（用于测试与复用已有 md）。 */
export async function renderDocxFromMarkdown(markdown: string, title = '会话导出'): Promise<Buffer> {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: title, font: BODY_FONT, bold: true })] }),
    ...markdownToBlocks(markdown),
  ]
  const doc = new Document({
    creator: 'dsh-session-export',
    title,
    styles: { default: { document: { run: { font: BODY_FONT, size: BODY_SIZE } } } },
    sections: [{ children }],
  })
  return Packer.toBuffer(doc)
}
