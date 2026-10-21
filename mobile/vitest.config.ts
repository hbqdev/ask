import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { alias, dedupe } from './vite.config'

export default defineConfig({
  plugins: [react()],
  resolve: { alias, dedupe },
  // A fixed stand-in for the package version, so tests don't follow releases.
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/test/**'
      ],
      reporter: ['text', 'html'],
      // The gate: a run below any of these fails.
      thresholds: {
        functions: 100,
        lines: 95,
        branches: 90,
        statements: 95
      }
    }
  }
})
