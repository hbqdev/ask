import { existsSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

// The page map is fixed (see AUTHORING.md). Keep nav + sidebar in sync with it.
const sections = [
  {
    text: 'Getting started',
    base: '/getting-started/',
    items: [
      ['Overview', 'overview'],
      ['Local development', 'local-dev'],
      ['Repo tour', 'repo-tour']
    ]
  },
  {
    text: 'Operations',
    base: '/operations/',
    items: [
      ['Environments', 'environments'],
      ['Deploy', 'deploy'],
      ['Runbooks', 'runbooks'],
      ['Testing & QA', 'testing-qa'],
      ['Telemetry', 'telemetry']
    ]
  },
  {
    text: 'Infrastructure',
    base: '/infrastructure/',
    items: [
      ['Fleet', 'fleet'],
      ['Services', 'services'],
      ['Security', 'security'],
      ['Data layer', 'data-layer']
    ]
  },
  {
    text: 'Request lifecycle',
    base: '/request-lifecycle/',
    items: [
      ['Chat turn', 'chat-turn'],
      ['Streaming', 'streaming'],
      ['Client state', 'client-state'],
      ['Frontend', 'frontend']
    ]
  },
  {
    text: 'Search',
    base: '/search/',
    items: [
      ['Pipeline', 'pipeline'],
      ['Models & reasoning', 'models-reasoning']
    ]
  },
  {
    text: 'Knowledge',
    base: '/knowledge/',
    items: [
      ['RAG & uploads', 'rag-uploads'],
      ['Memory & recall', 'memory-recall'],
      ['Media', 'media']
    ]
  },
  {
    text: 'Reference',
    base: '/reference/',
    items: [
      ['Env flags', 'env-flags'],
      ['API routes', 'api-routes'],
      ['Database', 'database'],
      ['Compose services', 'compose-services']
    ]
  },
  {
    text: 'History',
    base: '/history/',
    items: [
      ['Decisions', 'decisions'],
      ['Known issues', 'known-issues'],
      ['Changelog', 'changelog'],
      ['Glossary', 'glossary']
    ]
  }
]

const sidebar = sections.map(s => ({
  text: s.text,
  collapsed: false,
  items: s.items.map(([text, slug]) => ({ text, link: s.base + slug }))
}))

// Top nav: dropdowns that group the page-map sections (each lists its pages).
function navGroup(text: string, names: string[]) {
  const picked = sections.filter(s => names.includes(s.text))
  return {
    text,
    activeMatch: `^(${picked.map(s => s.base).join('|')})`,
    items: picked.map(s => ({
      text: s.text,
      items: s.items.map(([t, slug]) => ({ text: t, link: s.base + slug }))
    }))
  }
}

// `lastUpdated` shells out to git; the container build has no .git, so only
// enable it when the repo metadata is present.
const hasGit = existsSync(path.resolve(__dirname, '..', '..', '.git'))

export default withMermaid(
  defineConfig({
    srcDir: 'docs',
    title: 'Ask — Architecture & Handover',
    titleTemplate: ':title · Ask docs',
    description:
      'Architecture, operations and handover documentation for Ask, the self-hosted answer engine.',
    lang: 'en-US',
    cleanUrls: true,
    // Internal dead links fail the build; localhost URLs in runbooks are fine.
    ignoreDeadLinks: 'localhostLinks',
    lastUpdated: hasGit,
    appearance: true,
    head: [['meta', { name: 'robots', content: 'noindex, nofollow' }]],
    markdown: {
      lineNumbers: false,
      config(md) {
        // Inline code is literal: add v-pre so `{{ … }}` (Go templates in
        // docker --format strings, etc.) is not parsed as a Vue interpolation.
        const render = md.renderer.rules.code_inline!
        md.renderer.rules.code_inline = (tokens, idx, opts, env, self) => {
          tokens[idx].attrSet('v-pre', '')
          return render(tokens, idx, opts, env, self)
        }
      }
    },
    themeConfig: {
      siteTitle: 'Ask — Architecture & Handover',
      nav: [
        { text: 'Home', link: '/' },
        navGroup('Guide', ['Getting started', 'Operations', 'Infrastructure']),
        navGroup('Internals', ['Request lifecycle', 'Search', 'Knowledge']),
        navGroup('Reference', ['Reference']),
        navGroup('History', ['History'])
      ],
      sidebar,
      outline: { level: [2, 3] },
      search: { provider: 'local' },
      docFooter: { prev: 'Previous', next: 'Next' },
      lastUpdated: hasGit ? { text: 'Last updated' } : undefined
    },
    vite: {
      server: { fs: { allow: [path.resolve(__dirname, '..')] } },
      optimizeDeps: { include: ['mermaid'] },
      build: { chunkSizeWarningLimit: 4000 }
    },
    mermaid: {},
    mermaidPlugin: { class: 'mermaid' }
  })
)
