import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@agentlens/event-model': r('./packages/event-model/src/index.ts'),
      '@agentlens/storage': r('./packages/storage/src/index.ts'),
      '@agentlens/collector': r('./packages/collector/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'adapters/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    pool: 'forks',
  },
})
