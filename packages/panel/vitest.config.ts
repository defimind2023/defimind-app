import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'panel',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/domain/**/*.ts', 'src/adapters/receipts.ts'] },
  },
})
