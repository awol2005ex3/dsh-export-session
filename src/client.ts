/**
 * Web 客户端半：在会话页注入"导出会话"浮动按钮。
 *
 * 提供三种格式（均「尽力而为」，扫描页面已渲染的消息 DOM `[data-chat-flow-kind]`）：
 *   - 导出 Markdown：页面文本直接拼成 .md 下载；
 *   - 导出 Word：经 CDN 注入 docx 库把页面文本渲染成 .docx 下载（与参考项目注入
 *     SheetJS 同模式，client 模块不允许 import 任何包）；
 *   - 导出 PDF：打开打印窗口，借浏览器「另存为 PDF」。
 * 局限：只能导出页面已渲染的可见消息，长会话需先滚动加载。
 *
 * 本文件是纯浏览器逻辑，**不得** import 任何 node 依赖（export.ts / collect.ts
 * 用到 `node:fs`），否则会被打进 web bundle 导致运行期报错。
 *
 * 入口遵循 dsh client 模块约定：本文件**刻意不含任何 import/export 语句**，
 * `apply` 为普通函数声明；末尾用 `module.exports = { name, inject, apply }` 导出，
 * 与 host 侧 index.ts 同名函数语义一致，宿主以 cordis 插件对象方式加载。
 *
 * @module dsh-session-export/client
 */

const BAR_ID = 'dsh-session-export-bar'
const CONTAINER_SELECTOR = '[data-chat-flow-kind]'

/** 把一种 flow-kind 映射到 Markdown 的小节标题。 */
function headingFor(kind: string | undefined): string {
  switch (kind) {
    case 'user':
      return '### 用户'
    case 'assistant':
      return '### 助手'
    case 'reasoning':
      return '### 思考过程'
    case 'tool':
    case 'tool-call':
    case 'tool-result':
      return '### 工具'
    case 'context':
      return '### 上下文'
    case 'interrupted':
    case 'running':
    case 'settled':
      return `### ${kind}`
    default:
      return kind === undefined ? '### 消息' : `### ${kind}`
  }
}

/** 转义 HTML 特殊字符，供 PDF 预览用。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 扫描会话 DOM，返回 (kind, 纯文本) 列表。 */
function collectFromDom(): Array<{ kind: string | undefined; text: string }> {
  const nodes = Array.from(document.querySelectorAll(CONTAINER_SELECTOR)) as HTMLElement[]
  const out: Array<{ kind: string | undefined; text: string }> = []
  for (const node of nodes) {
    const text = node.innerText?.trim() ?? ''
    if (text === '') continue
    out.push({ kind: node.getAttribute('data-chat-flow-kind') ?? undefined, text })
  }
  return out
}

/** 把扫描结果拼成 Markdown 文档。 */
function buildMarkdown(): string {
  const items = collectFromDom()
  if (items.length === 0) return '# 会话导出\n\n（页面上未找到任何已渲染的会话消息。）\n'
  const parts = ['# 会话导出', '']
  for (const item of items) {
    parts.push(headingFor(item.kind), '', item.text, '')
  }
  return parts.join('\n')
}

/** 触发浏览器下载一个 Blob。 */
function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 触发浏览器下载一段文本。 */
function downloadText(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

/** 打开新窗口渲染 HTML 并调用打印（→ 另存为 PDF）。 */
function printHtml(html: string): void {
  const win = window.open('', '_blank')
  if (win === null) {
    alert('浏览器拦截了打印窗口，请允许弹出窗口后重试。')
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
  win.addEventListener('load', () => {
    win.focus()
    win.print()
  })
  // 部分浏览器在 document.write 后立即可打印
  setTimeout(() => {
    try {
      win.focus()
      win.print()
    } catch {
      /* 已在 load 事件里处理 */
    }
  }, 300)
}

/** 把扫描结果拼成用于打印的极简 HTML。 */
function buildPrintHtml(): string {
  const items = collectFromDom()
  const body = items.length === 0
    ? '<p>（页面上未找到任何已渲染的会话消息。）</p>'
    : items
      .map(item => `<section class="msg"><h3>${escapeHtml(headingFor(item.kind).replace(/^### /, ''))}</h3><pre>${escapeHtml(item.text)}</pre></section>`)
      .join('\n')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>会话导出</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; line-height: 1.6; padding: 24px; }
  h1 { font-size: 20px; } h3 { font-size: 15px; margin: 18px 0 6px; color: #333; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f6f6f6; padding: 10px; border-radius: 6px; margin: 0; }
  section.msg { border-bottom: 1px solid #eee; padding-bottom: 10px; }
  @media print { body { padding: 0; } }
</style></head><body><h1>会话导出</h1>${body}</body></html>`
}

/** docx 库（IIFE 构建）经 CDN 注入；浏览器半生成 .docx 复用，与参考注入 SheetJS 同模式。 */
const DOCX_CDN = 'https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.iife.js'

let docxPromise: Promise<unknown> | undefined

/** 加载 docx 全局对象（带缓存与 CDN 失败提示）。 */
function loadDocx(): Promise<any> {
  const w = window as unknown as { docx?: any }
  if (w.docx !== undefined) return Promise.resolve(w.docx)
  if (docxPromise !== undefined) return docxPromise
  docxPromise = new Promise<any>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = DOCX_CDN
    script.onload = () => {
      if (w.docx !== undefined) resolve(w.docx)
      else reject(new Error('docx 库已加载但未暴露全局对象'))
    }
    script.onerror = () => reject(new Error('无法从 CDN 加载 docx 库，请检查网络后重试'))
    document.head.appendChild(script)
  })
  return docxPromise
}

/** 把一段 Markdown 文本（含 ### 用户 等小标题）转为 docx 段落数组（轻量解析）。 */
function markdownToDocxParagraphs(markdown: string): any[] {
  const DX = (window as unknown as { docx: any }).docx
  const out: any[] = []
  const lines = markdown.split('\n')
  let inCode = false
  let codeBuffer: string[] = []
  const flushCode = (): void => {
    for (const line of codeBuffer) {
      out.push(new DX.Paragraph({ children: [new DX.TextRun({ text: line, font: 'Consolas' })] }))
    }
    codeBuffer = []
  }
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.trim().startsWith('```')) {
      if (inCode) { inCode = false; flushCode() }
      else { inCode = true; codeBuffer = [] }
      continue
    }
    if (inCode) { codeBuffer.push(line); continue }
    if (line.trim() === '') continue
    if (line.startsWith('### ')) out.push(new DX.Paragraph({ heading: DX.HeadingLevel.HEADING_3, children: [new DX.TextRun(line.slice(4))] }))
    else if (line.startsWith('## ')) out.push(new DX.Paragraph({ heading: DX.HeadingLevel.HEADING_2, children: [new DX.TextRun(line.slice(3))] }))
    else if (line.startsWith('# ')) out.push(new DX.Paragraph({ heading: DX.HeadingLevel.HEADING_1, children: [new DX.TextRun(line.slice(2))] }))
    else if (line.startsWith('> ')) out.push(new DX.Paragraph({ children: [new DX.TextRun({ text: line.slice(2), italics: true })] }))
    else if (/^[-*]\s+/.test(line)) out.push(new DX.Paragraph({ children: [new DX.TextRun('• ' + line.replace(/^[-*]\s+/, ''))] }))
    else out.push(new DX.Paragraph({ children: [new DX.TextRun(line)] }))
  }
  flushCode()
  return out
}

/** 扫描会话 DOM，生成 .docx 并触发下载。 */
async function exportDocx(): Promise<void> {
  try {
    const DX = await loadDocx()
    const doc = new DX.Document({ sections: [{ children: markdownToDocxParagraphs(buildMarkdown()) }] })
    const blob: Blob = await DX.Packer.toBlob(doc)
    downloadBlob(`session-${Date.now()}.docx`, blob)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[dsh-session-export]', err)
    window.alert(`导出 Word 失败：${message}`)
  }
}

/** 注入浮动工具条（幂等）。 */
function ensureBar(): void {
  if (document.getElementById(BAR_ID) !== null) return

  const bar = document.createElement('div')
  bar.id = BAR_ID
  bar.style.cssText = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'z-index: 2147483647',
    'display: flex',
    'gap: 8px',
    'padding: 8px',
    'background: rgba(24,24,28,0.92)',
    'border-radius: 10px',
    'box-shadow: 0 4px 16px rgba(0,0,0,0.3)',
    'font: 13px/1 -apple-system, "Microsoft YaHei", sans-serif',
  ].join(';')

  const mkButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = [
      'cursor: pointer',
      'border: none',
      'border-radius: 6px',
      'padding: 6px 10px',
      'color: #fff',
      'background: #3b82f6',
    ].join(';')
    btn.addEventListener('click', onClick)
    return btn
  }

  bar.appendChild(mkButton('导出 Markdown', () => {
    downloadText(`session-${Date.now()}.md`, buildMarkdown(), 'text/markdown;charset=utf-8')
  }))
  bar.appendChild(mkButton('导出 Word', () => {
    void exportDocx()
  }))
  bar.appendChild(mkButton('导出 PDF', () => {
    printHtml(buildPrintHtml())
  }))

  document.body.appendChild(bar)
}

/**
 * client 模块入口。会话 DOM 可能尚未渲染，用 MutationObserver 在它出现后
 * 注入工具条；同时立即尝试一次（处理已加载完成的页面）。
 */
function apply(): void {
  if (typeof document === 'undefined') return
  ensureBar()
  if (document.querySelector(CONTAINER_SELECTOR) !== null) return

  const observer = new MutationObserver(() => {
    if (document.querySelector(CONTAINER_SELECTOR) !== null) {
      ensureBar()
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
// 注意：本文件刻意不含 import/export（否则 tsc 会生成具名 export，使经典脚本语法错误）。
module.exports = { name: 'dsh-session-export', inject: [], apply }
