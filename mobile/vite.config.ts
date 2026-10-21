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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias },
  // Capacitor serves dist/ from the app bundle, so asset URLs stay relative.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true }
})
