import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const askLib = fileURLToPath(new URL('../lib/', import.meta.url))

// `@ask/` is Ask's pure modules in the repo's lib/ (reused, not copied), and
// `@/` is this app's own src/. Ask's lib modules import each other as
// `@/lib/...`, so that prefix maps to lib/ too and is listed first (the first
// matching alias wins); src/ therefore has no `lib/` folder. Keep these in
// step with tsconfig.json `paths`.
export const alias = {
  '@/lib/': askLib,
  '@ask/': askLib,
  '@/': fileURLToPath(new URL('./src/', import.meta.url))
}

// Ask's lib/ modules sit outside this app, so a bare `ai` or `react` import
// in them would resolve to the repo root's node_modules: a second copy, with
// its own classes and React contexts. Dedupe makes every import of these
// packages, wherever it comes from, use the app's single copy.
export const dedupe = [
  'react',
  'react-dom',
  'ai',
  '@ai-sdk/react',
  'zod',
  '@json-render/core'
]

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias, dedupe },
  // Capacitor serves dist/ from the app bundle, so asset URLs stay relative.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true }
})
