/**
 * 块级 Markdown 解析器。
 *
 * 会话导出产物里的 Markdown 由本插件自己生成（见 render-markdown.ts），
 * 但用户消息里可能本来就带着 Markdown。PDF 与 DOCX 渲染器不能依赖外部
 * Markdown 库，因此这里实现一个够用的块级解析器：
 *
 *   - ATX 标题（# ~ ######）
 *   - 围栏代码块（``` / ~~~，可带语言）
 *   - 管道表格（表头行 + 对齐行），按未转义的 `|` 拆分，支持 `\|` 转义
 *   - 引用块（>，自动折叠连续行）
 *   - 有序 / 无序列表
 *   - 分隔线（--- / *** / ___）
 *   - 段落（连续非空行合并为一行，保留软换行语义交由渲染器决定）
 *
 * 刻意不做的事情（保持小而可测）：HTML 内联、嵌套列表缩进层级、
 * 脚注、任务列表复选框、Setext 标题。
 *
 * @module dsh-session-export/md-blocks
 */

/** 行内片段：PDF 用它切换字体，DOCX 用它生成 TextRun。 */
export interface InlineRun {
  /** 片段文本（已剥离 Markdown 标记）。 */
  text: string
  bold?: boolean
  italic?: boolean
  /** 行内代码：渲染器等宽字体 + 浅底色。 */
  code?: boolean
  /** 链接目标地址。 */
  href?: string
}

/** 一个块级节点。 */
export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang?: string; code: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'rule' }

/** 表格对齐行：只允许 `|`、`:`、`-` 和空白，且至少有一个 `-`。 */
const ALIGN_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** 围栏起始行：` ```ts ` 或 ` ~~~ `，语言可选。 */
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/

/** 分隔线：`---`、`***`、`___`（至少三个，允许空白）。 */
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/

/** ATX 标题：1~6 个 `#` 后跟至少一个空格。 */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/

/** 无序列表标记。 */
const BULLET = /^\s*([-*+])\s+(.*)$/

/** 有序列表标记。 */
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/

/**
 * 按未转义的 `|` 拆分一行表格单元格。
 * `\|` 视为字面量竖线，不参与拆分。
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)

  // 去掉首尾因"| a | b |"写法产生的空单元格。
  if (cells.length > 0 && cells[0]?.trim() === '') cells.shift()
  const last = cells[cells.length - 1]
  if (cells.length > 0 && last !== undefined && last.trim() === '') cells.pop()

  return cells.map(cell => cell.trim())
}

/** 是否像表格行（含至少一个未转义的 `|`）。 */
function looksLikeRow(line: string): boolean {
  let sawPipe = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '|') sawPipe = true
  }
  return sawPipe
}

/**
 * 解析 Markdown 文本为块级节点序列。
 * @param markdown - 任意 Markdown 文本；空输入返回空数组。
 */
export function parseMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''

    // ── 围栏代码块 ──
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const lang = fence[2] || undefined
      const code: string[] = []
      i += 1
      while (i < lines.length) {
        const inner = lines[i] ?? ''
        const closer = FENCE.exec(inner)
        if (closer !== null && inner.trim().startsWith(marker[0]!.repeat(3)) && closer[2] === '') {
          i += 1
          break
        }
        code.push(inner)
        i += 1
      }
      blocks.push({ kind: 'code', ...(lang === undefined ? {} : { lang }), code: code.join('\n') })
      continue
    }

    // ── 空行 ──
    if (line.trim() === '') {
      i += 1
      continue
    }

    // ── 表格：表头行 + 对齐行 ──
    const next = lines[i + 1]
    if (next !== undefined && looksLikeRow(line) && ALIGN_ROW.test(next)) {
      const headers = splitTableRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length) {
        const rowLine = lines[i] ?? ''
        if (rowLine.trim() === '' || !looksLikeRow(rowLine)) break
        const cells = splitTableRow(rowLine)
        // 补齐/截断到表头宽度，保证表格矩形完整。
        while (cells.length < headers.length) cells.push('')
        rows.push(cells.slice(0, headers.length))
        i += 1
      }
      blocks.push({ kind: 'table', headers, rows })
      continue
    }

    // ── 分隔线 ──
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    // ── 标题 ──
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      i += 1
      continue
    }

    // ── 引用块（连续 `>` 行折叠成一段） ──
    if (/^\s{0,3}>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length) {
        const quotedLine = lines[i] ?? ''
        const match = /^\s{0,3}>\s?(.*)$/.exec(quotedLine)
        if (match === null) break
        quoted.push(match[1] ?? '')
        i += 1
      }
      blocks.push({ kind: 'quote', text: quoted.join('\n').trim() })
      continue
    }

    // ── 列表（连续同类标记收成一个 list 块） ──
    const bullet = BULLET.exec(line)
    const ordered = bullet === null ? ORDERED.exec(line) : null
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null
      const items: string[] = []
      while (i < lines.length) {
        const itemLine = lines[i] ?? ''
        const m = isOrdered ? ORDERED.exec(itemLine) : BULLET.exec(itemLine)
        if (m === null) break
        items.push((isOrdered ? m[2] : m[2]) ?? '')
        i += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    // ── 段落：连续非空、非块起始行 ──
    const paragraph: string[] = []
    while (i < lines.length) {
      const pLine = lines[i] ?? ''
      if (pLine.trim() === '') break
      if (
        FENCE.test(pLine)
        || RULE.test(pLine)
        || HEADING.test(pLine)
        || /^\s{0,3}>\s?/.test(pLine)
        || BULLET.test(pLine)
        || ORDERED.test(pLine)
      ) break
      const pNext = lines[i + 1]
      if (pNext !== undefined && looksLikeRow(pLine) && ALIGN_ROW.test(pNext)) break
      paragraph.push(pLine.trim())
      i += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    else i += 1
  }

  return blocks
}

/** 行内标记：反引号代码 > 加粗 > 斜体 > 链接。 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]*\))/g

/**
 * 解析一行文本的行内标记为片段序列。
 * 未匹配到的部分按普通文本保留，标记字符被剥离。
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index
    if (start > last) {
      const plain = text.slice(last, start)
      if (plain !== '') runs.push({ text: plain })
    }
    const token = match[0]
    if (token.startsWith('`')) {
      runs.push({ text: token.slice(1, -1), code: true })
    } else if (token.startsWith('**') || token.startsWith('__')) {
      runs.push({ text: token.slice(2, -2), bold: true })
    } else if (token.startsWith('*') || token.startsWith('_')) {
      runs.push({ text: token.slice(1, -1), italic: true })
    } else {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)$/.exec(token)
      if (link !== null) {
        runs.push({ text: link[1] ?? '', ...(link[2] ? { href: link[2] } : {}) })
      } else {
        runs.push({ text: token })
      }
    }
    last = start + token.length
  }
  if (last < text.length) {
    const tail = text.slice(last)
    if (tail !== '') runs.push({ text: tail })
  }
  if (runs.length === 0) runs.push({ text })
  return runs
}

/** 把行内片段还原成纯文本（PDF 的纯文本回退路径与宽度估算用）。 */
export function inlineToPlain(runs: readonly InlineRun[]): string {
  return runs.map(run => run.text).join('')
}

/** 剥离一行文本的行内标记，得到纯文本。 */
export function stripInline(text: string): string {
  return inlineToPlain(parseInline(text))
}

/**
 * 估算一段文本的显示宽度（用于 PDF 表格列宽）。
 * CJK 字符按 2 个半角计宽，其余按 1。
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}
