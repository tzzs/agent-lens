import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@agentlens/event-model': r('./packages/event-model/src/index.ts'),
      '@agentlens/storage': r('./packages/storage/src/index.ts'),
      '@agentlens/collector': r('./packages/collector/src/index.ts'),
      '@agentlens/pricing': r('./packages/pricing/src/index.ts'),
      '@agentlens/query': r('./packages/query/src/index.ts'),
      '@agentlens/adapter-claude-code': r('./adapters/claude-code/src/index.ts'),
      '@agentlens/cli': r('./apps/cli/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'adapters/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    pool: 'forks',
  },
})
