/**
 * 系统字体探测：为 pdfkit 找到可用的中文正文字体、粗体与等宽字体。
 *
 * pdfkit 只能绘制已注册字体的字形，内置 14 种标准字体**不含中文**，
 * 直接写中文会渲染成空白或方块，所以必须嵌入一个真实的字体文件。
 *
 * 三个坑：
 *  1. `.ttc` / `.otc` 是字体集合，pdfkit 的 `registerFont(name, path)` 直接
 *     传集合文件会失败；必须给出集合内某个字体的 PostScript 名作为
 *     第三个参数（`fontkit.openSync(path, family)` 的路径）。这里用
 *     fontkit 枚举集合内的字体，取第一个可用的 PostScript 名。
 *  2. 候选字体的 PostScript 名不同机器可能不同，所以**探测时读取，不硬编码**。
 *  3. 等宽字体（Consolas / DejaVu Sans Mono）同样没有中文字形，代码块里
 *     出现中文时会缺字；渲染器在检测到代码块含 CJK 时自动改用中文正文字体。
 *
 * @module dsh-session-export/fonts
 */

import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 一个已确认存在的字体（集合文件附带集合内的字体名）。 */
export interface FontSpec {
  /** 字体文件绝对路径。 */
  path: string
  /** `.ttc` / `.otc` 集合内的 PostScript 名；单字体文件无此字段。 */
  family?: string
}

/** 渲染一份 PDF 所需的字体组。 */
export interface FontSet {
  /** 中文正文（同时用于标题，找不到粗体时标题也用它）。 */
  cjk: FontSpec
  /** 中文粗体；缺失时标题退化为普通字重。 */
  cjkBold?: FontSpec
  /** 等宽字体（无中文，仅用于纯 ASCII 代码块）。 */
  mono?: FontSpec
}

/** 没有任何可用中文字体时抛出，消息里带上探测过的路径便于排查。 */
export class FontNotFoundError extends Error {
  override readonly name = 'FontNotFoundError'
  constructor(readonly probed: readonly string[]) {
    super(
      '未找到可用的中文字体，无法生成 PDF。'
      + '请安装任一中文字体（Windows 自带 等线/微软雅黑/黑体），'
      + `或通过环境变量 DSH_EXPORT_PDF_FONT 指定字体文件路径。探测过的路径：${probed.join('、')}`,
    )
  }
}

/** 用户显式指定的字体（最高优先级）。 */
function explicitFont(): string | undefined {
  const value = process.env.DSH_EXPORT_PDF_FONT
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

/** 中文正文候选，按视觉效果从好到差排列。 */
const CJK_CANDIDATES: readonly string[] = [
  // Windows —— 等线（Office 2013+ / Win10+ 自带，单文件 TTF，最省事）
  'C:/Windows/Fonts/Deng.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhl.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/simkai.ttf',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/simsun.ttc',
  // macOS / iOS
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  // Linux —— Noto CJK 与文泉驿
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/ukai.ttc',
]

/** 中文粗体候选。 */
const CJK_BOLD_CANDIDATES: readonly string[] = [
  'C:/Windows/Fonts/Dengb.ttf',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
]

/** 等宽候选（无中文）。 */
const MONO_CANDIDATES: readonly string[] = [
  'C:/Windows/Fonts/CascadiaMono.ttf',
  'C:/Windows/Fonts/consola.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
]

/** 集合文件的扩展名。 */
const COLLECTION_EXT = /\.(ttc|otc)$/i

/** fontkit 形状（只声明用到的部分，避免依赖它的完整类型）。 */
interface FontLike {
  postscriptName?: string
}
interface FontkitLike {
  openSync(path: string, family?: string): unknown
}

let fontkitCache: FontkitLike | undefined

/** 惰性加载 fontkit；不可用时返回 undefined（探测退化为"只用单字体文件"）。 */
function loadFontkit(): FontkitLike | undefined {
  if (fontkitCache !== undefined) return fontkitCache
  try {
    const require = createRequire(import.meta.url)
    const loaded = require('fontkit') as FontkitLike
    fontkitCache = loaded
  } catch {
    fontkitCache = undefined
  }
  return fontkitCache
}

/** 文件存在且非空。 */
function usable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

/**
 * 把一个候选路径解析为 {@link FontSpec}。
 * 集合文件会用 fontkit 取出集合内第一个字体的 PostScript 名；
 * 取不到则放弃该候选（pdfkit 无法注册无名的集合）。
 */
function toSpec(path: string): FontSpec | undefined {
  if (!usable(path)) return undefined
  if (!COLLECTION_EXT.test(path)) return { path }

  const fontkit = loadFontkit()
  if (fontkit === undefined) return undefined
  try {
    const opened = fontkit.openSync(path) as FontLike & { fonts?: FontLike[] }
    const first = opened.fonts?.[0] ?? opened
    const family = first.postscriptName
    if (typeof family !== 'string' || family === '') return undefined
    return { path, family }
  } catch {
    return undefined
  }
}

/** 在候选列表里找到第一个可用字体。 */
function firstOf(candidates: readonly string[], probed: string[]): FontSpec | undefined {
  for (const path of candidates) {
    probed.push(path)
    const spec = toSpec(path)
    if (spec !== undefined) return spec
  }
  return undefined
}

/**
 * 探测本机字体，返回渲染 PDF 所需的字体组。
 *
 * @throws {@link FontNotFoundError} 找不到任何可用中文字体。
 */
export function resolveFonts(): FontSet {
  const probed: string[] = []

  const explicit = explicitFont()
  if (explicit !== undefined) probed.push(explicit)
  const cjk = explicit === undefined ? firstOf(CJK_CANDIDATES, probed) : toSpec(explicit)
  if (cjk === undefined) throw new FontNotFoundError(probed)

  const bold = firstOf(CJK_BOLD_CANDIDATES, probed)
  const mono = firstOf(MONO_CANDIDATES, probed)

  return {
    cjk,
    ...(bold === undefined ? {} : { cjkBold: bold }),
    ...(mono === undefined ? {} : { mono }),
  }
}
