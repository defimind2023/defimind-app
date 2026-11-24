import { defineConfig } from 'vitest/config'

// The panel in a real Chromium against a mock guard-core: slower, and it needs Chromium installed.
export default defineConfig({
  test: {
    name: 'panel-web',
    environment: 'node',
    include: ['test/web/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
