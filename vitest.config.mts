import react from '@vitejs/plugin-react'
import path from 'path'
import { defaultExclude, defineConfig } from 'vitest/config'

// Provide dummy env vars at configuration time to avoid import errors during bundling
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://user:pass@localhost:5432/testdb'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      'zod/v4': 'zod'
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    // Vitest's own defaults don't know about .claude/worktrees/ — leftover
    // git worktrees from background-agent isolation runs, each a full repo
    // checkout with its own copy of every test file. Without this, the same
    // handful of real failures gets counted once per stray worktree,
    // inflating the failed-file/test count several times over.
    // selfhosted/model-manager is a fully separate app with its own vitest
    // config, aliases, and deps — its tests must not be picked up (and broken)
    // by Ask's root suite.
    exclude: [
      ...defaultExclude,
      '**/.claude/**',
      '**/selfhosted/model-manager/**'
    ]
  }
})
