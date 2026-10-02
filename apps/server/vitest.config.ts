import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Server 测试多为 file-backed SQLite 上的完整 HTTP 闭环，CI runner 比开发机慢数倍；默认 5 秒会让较长的闭环偶发超时。
    testTimeout: 15_000,
  },
})
