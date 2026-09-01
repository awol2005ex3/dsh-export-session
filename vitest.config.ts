import { defineConfig } from 'vitest/config'

/**
 * 显式把 Vite 开发服务器绑定到 127.0.0.1：
 * 部分环境（如本机 DNS 不解析 "localhost"、hosts 未映射）会让 Vite 的
 * resolveHostname 触发 getaddrinfo("localhost") 并以 EAI_FAIL 崩溃，
 * 导致 vitest 启动失败。绑定 IP 可完全绕开该 DNS 查询。
 */
export default defineConfig({
  server: { host: '127.0.0.1' },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
