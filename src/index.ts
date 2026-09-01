/**
 * 插件入口（主机半）：向 dsh 注册 `export_session` 工具。
 *
 * 遵循 dsh 官方四导出契约：`name` / `inject` / `Config` / `apply`。
 * 本文件是 loader 解析到的主入口（lib/index.js），负责把导出工具以可逆
 * effect 形式注册进 `ctx.tools`，便于 HMR 与插件卸载时自动回收。
 *
 * @module dsh-session-export
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { createExportTool } from './tool.js'

/** 插件 id —— 必须与 profile patch（cordis.patch.yml）里的 name 一致。 */
export const name = 'dsh-session-export'

/** 声明本插件需要的服务；loader 会等待其就绪。 */
export const inject = ['tools']

/** 声明式、经 schema 校验的部署配置。 */
export interface Config {
  defaultOutputDir?: string
  defaultFormat?: 'md' | 'docx' | 'pdf'
}

export const Config = Schema.object({
  defaultOutputDir: Schema.string().description(
    'Default directory for exported files. Falls back to the session cwd, then the process cwd, when empty.',
  ),
  defaultFormat: Schema.union(['md', 'docx', 'pdf'] as const)
    .default('md')
    .description('Default export format when a tool call omits the format argument.'),
})

/**
 * 插件入口（具名导出，无默认导出）。
 *
 * 以可逆 effect 注册导出工具：返回 `ctx.tools.register` 的 disposer，使
 * HMR / 插件卸载时自动清理。同时把配置里的缺省目录与缺省格式传给工具工厂。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const tool = createExportTool({
      defaultOutputDir: config.defaultOutputDir,
      defaultFormat: config.defaultFormat,
    })
    ctx.logger.info('dsh-session-export: registered export_session tool')
    return ctx.tools.register(tool)
  })
}
