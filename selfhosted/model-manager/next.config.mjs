/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin the Turbopack/workspace root to this app's own directory. Without
  // this, Next.js detects the parent Ask app's bun.lock alongside this
  // app's own lockfile and infers the workspace root as the parent
  // directory — which then pulls the parent's instrumentation.ts and
  // proxy.ts (middleware) into THIS app's build. model-manager is a fully
  // standalone app with zero imports from Ask, so it must never resolve
  // files outside this directory.
  turbopack: { root: import.meta.dirname }
}
export default nextConfig
