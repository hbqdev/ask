<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import data from '../../../data/code-map.json'

/**
 * <CodeMap /> — every source file with its purpose, exports, reverse imports
 * and the docs pages that mention it (data/code-map.json, `bun run gen`).
 * Props (all optional):
 *   query="lib/streaming"   prefill the text filter
 *   kind="route-handler"    preselect a kind chip
 *   view="flat"             start in the flat list instead of the tree
 */
const props = defineProps<{ query?: string; kind?: string; view?: 'tree' | 'flat' }>()

type FileEntry = (typeof data.files)[number]

const q = ref(props.query ?? '')
const kinds = ref<Set<string>>(new Set(props.kind ? [props.kind] : []))
const projects = ref<Set<string>>(new Set())
const onlyUndocumented = ref(false)
const view = ref<'tree' | 'flat'>(props.view ?? 'tree')
const open = ref<Set<string>>(new Set())
const expandedDirs = ref<Set<string>>(new Set())

const PROJECT_LABEL: Record<string, string> = {
  ask: 'Ask app',
  'model-manager': 'model-manager',
  ingestor: 'ingestor'
}

const kindCounts = computed(() => {
  const m = new Map<string, number>()
  for (const f of data.files) m.set(f.kind, (m.get(f.kind) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})
const projectCounts = computed(() => {
  const m = new Map<string, number>()
  for (const f of data.files) m.set(f.project, (m.get(f.project) ?? 0) + 1)
  return [...m.entries()]
})

const filtering = computed(() => Boolean(q.value.trim() || kinds.value.size || projects.value.size || onlyUndocumented.value))

const rows = computed<FileEntry[]>(() => {
  const terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return data.files.filter(f => {
    if (kinds.value.size && !kinds.value.has(f.kind)) return false
    if (projects.value.size && !projects.value.has(f.project)) return false
    if (onlyUndocumented.value && f.docs.length) return false
    if (!terms.length) return true
    const hay = `${f.path}\n${f.purpose}\n${f.exports.join(' ')}\n${f.kind}\n${f.route ?? ''}`.toLowerCase()
    return terms.every(t => hay.includes(t))
  })
})

// ---- tree ---------------------------------------------------------------
interface DirNode {
  path: string
  name: string
  dirs: Map<string, DirNode>
  files: FileEntry[]
  count: number
  documented: number
}

function buildTree(files: FileEntry[]): DirNode {
  const root: DirNode = { path: '', name: '', dirs: new Map(), files: [], count: 0, documented: 0 }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    node.count++
    if (f.docs.length) node.documented++
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      let next = node.dirs.get(parts[i])
      if (!next) {
        next = { path: p, name: parts[i], dirs: new Map(), files: [], count: 0, documented: 0 }
        node.dirs.set(parts[i], next)
      }
      next.count++
      if (f.docs.length) next.documented++
      node = next
    }
    node.files.push(f)
  }
  return root
}

type VisibleRow =
  | { type: 'dir'; depth: number; node: DirNode; expanded: boolean }
  | { type: 'file'; depth: number; file: FileEntry }

const treeRows = computed<VisibleRow[]>(() => {
  const root = buildTree(rows.value)
  const out: VisibleRow[] = []
  const autoOpen = filtering.value
  const walk = (node: DirNode, depth: number) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirs) {
      // Collapse single-child chains ("selfhosted/model-manager") into one row.
      let n = d
      let label = d.name
      while (n.dirs.size === 1 && !n.files.length) {
        n = [...n.dirs.values()][0]
        label += '/' + n.name
      }
      const expanded = autoOpen ? !expandedDirs.value.has('!' + n.path) : expandedDirs.value.has(n.path)
      out.push({ type: 'dir', depth, node: { ...n, name: label }, expanded })
      if (expanded) walk(n, depth + 1)
    }
    for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ type: 'file', depth, file: f })
  }
  walk(root, 0)
  return out
})

function toggleDir(p: string) {
  const s = new Set(expandedDirs.value)
  const key = filtering.value ? '!' + p : p
  s.has(key) ? s.delete(key) : s.add(key)
  expandedDirs.value = s
}
function expandAll(on: boolean) {
  if (filtering.value) {
    // While filtering, dirs are open unless explicitly closed ("!path").
    expandedDirs.value = on ? new Set() : new Set(allDirs(rows.value).map(d => '!' + d))
  } else {
    expandedDirs.value = on ? new Set(allDirs(data.files)) : new Set()
  }
}
function allDirs(files: FileEntry[]): string[] {
  const s = new Set<string>()
  for (const f of files) {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'))
  }
  return [...s]
}

// ---- interactions -------------------------------------------------------
function toggleSet(r: typeof kinds, v: string) {
  const s = new Set(r.value)
  s.has(v) ? s.delete(v) : s.add(v)
  r.value = s
}
function toggle(p: string) {
  const s = new Set(open.value)
  s.has(p) ? s.delete(p) : s.add(p)
  open.value = s
}
const byPath = new Map(data.files.map(f => [f.path, f]))

/** Jump to another file in the map (from a used-by / tests entry). */
function focusFile(p: string) {
  if (!byPath.has(p)) return
  q.value = p
  kinds.value = new Set()
  projects.value = new Set()
  onlyUndocumented.value = false
  open.value = new Set([p])
  history.replaceState(null, '', `#file=${encodeURIComponent(p)}`)
  nextTick(() => {
    const scroll = () => document.getElementById(anchorId(p))?.scrollIntoView({ block: 'center' })
    scroll()
    setTimeout(scroll, 300) // after VitePress' own hash scroll on first load
  })
}

const anchorId = (p: string) => 'code-' + p.replace(/[^\w-]+/g, '-')
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const docHref = (d: FileEntry['docs'][number]) => d.page + (d.anchor ? `#${d.anchor}` : '')
const methodClass = (m: string) => `m-${m.toLowerCase()}`

watch(q, v => {
  if (!v && location.hash.startsWith('#file=')) history.replaceState(null, '', location.pathname)
})

onMounted(() => {
  // Deep link: /reference/code-map#file=lib/utils/ssrf-guard.ts
  const m = /^#file=(.+)$/.exec(window.location.hash)
  if (m) {
    const p = decodeURIComponent(m[1])
    if (byPath.has(p)) focusFile(p)
  }
})
</script>

<template>
  <div class="ask-widget code-map">
    <div class="ask-toolbar">
      <input
        v-model="q"
        class="ask-input"
        type="search"
        placeholder="Filter by path, purpose or export name…"
        aria-label="Filter source files"
      />
      <label class="ask-toggle"><input v-model="onlyUndocumented" type="checkbox" /> not in docs</label>
      <span class="cm-view" role="group" aria-label="View">
        <button type="button" class="ask-btn" :class="{ primary: view === 'tree' }" @click="view = 'tree'">Tree</button>
        <button type="button" class="ask-btn" :class="{ primary: view === 'flat' }" @click="view = 'flat'">Flat</button>
      </span>
      <span class="ask-count">{{ rows.length }} / {{ data.count }} files</span>
    </div>
    <div class="ask-chips">
      <button
        v-for="[p, n] in projectCounts"
        :key="p"
        class="ask-chip"
        :class="{ active: projects.has(p) }"
        type="button"
        @click="toggleSet(projects, p)"
      >
        {{ PROJECT_LABEL[p] ?? p }}<span class="n">{{ n }}</span>
      </button>
    </div>
    <div class="ask-chips">
      <button
        v-for="[k, n] in kindCounts"
        :key="k"
        class="ask-chip"
        :class="{ active: kinds.has(k) }"
        type="button"
        @click="toggleSet(kinds, k)"
      >
        {{ k }}<span class="n">{{ n }}</span>
      </button>
    </div>
    <div v-if="view === 'tree'" class="cm-treebar">
      <button type="button" class="ask-btn" @click="expandAll(true)">Expand all</button>
      <button type="button" class="ask-btn" @click="expandAll(false)">Collapse all</button>
    </div>

    <div class="ask-list">
      <div v-if="!rows.length" class="ask-empty">No files match.</div>
      <template v-for="r in view === 'tree' ? treeRows : rows.map(file => ({ type: 'file' as const, depth: 0, file }))">
        <div
          v-if="r.type === 'dir'"
          :key="'d:' + r.node.path"
          class="ask-row cm-dir"
          :class="{ open: r.expanded }"
        >
          <div
            class="ask-row-head cm-dir-head"
            :style="{ paddingLeft: 12 + r.depth * 16 + 'px' }"
            role="button"
            tabindex="0"
            :aria-expanded="r.expanded"
            @click="toggleDir(r.node.path)"
            @keydown.enter="toggleDir(r.node.path)"
          >
            <span class="ask-caret">▸</span>
            <span class="cm-dirname"><code>{{ r.node.name }}/</code></span>
            <span class="ask-muted cm-dircount" :title="`${r.node.documented} of ${r.node.count} mentioned in the docs`">
              {{ r.node.count }} file{{ r.node.count === 1 ? '' : 's' }} · {{ r.node.documented }} in docs
            </span>
          </div>
        </div>
        <div
          v-else
          :id="anchorId(r.file.path)"
          :key="'f:' + r.file.path"
          class="ask-row cm-file"
          :class="{ open: open.has(r.file.path) }"
        >
          <div
            class="ask-row-head cm-head"
            :style="{ paddingLeft: 12 + r.depth * 16 + 'px' }"
            role="button"
            tabindex="0"
            :aria-expanded="open.has(r.file.path)"
            @click="toggle(r.file.path)"
            @keydown.enter="toggle(r.file.path)"
          >
            <span class="ask-caret">▸</span>
            <span class="cm-name">
              <code :title="r.file.path">{{ view === 'tree' ? basename(r.file.path) : r.file.path }}</code>
            </span>
            <span class="cm-badges">
              <span class="ask-badge" :class="{ brand: r.file.kind === 'route-handler' || r.file.kind === 'page' }">{{ r.file.kind }}</span>
              <span v-for="m in r.file.methods" :key="m" class="ask-badge cm-method" :class="methodClass(m)">{{ m }}</span>
              <span v-if="!r.file.docs.length" class="ask-badge warn" title="No docs page mentions this file">no docs</span>
            </span>
            <span class="cm-purpose">{{ r.file.purpose }}</span>
          </div>
          <div v-if="open.has(r.file.path)" class="ask-row-body">
            <div class="cm-meta">
              <code class="cm-path">{{ r.file.path }}</code>
              <span v-if="r.file.route" class="ask-muted"> · route <code>{{ r.file.route }}</code></span>
              <span class="ask-muted" :title="`purpose from: ${r.file.purposeSource}`"> · purpose: {{ r.file.purposeSource }}</span>
              · <a :href="`#file=${encodeURIComponent(r.file.path)}`" class="ask-muted" @click.prevent="focusFile(r.file.path)">link</a>
            </div>
            <h4>Exports ({{ r.file.exports.length }})</h4>
            <div v-if="r.file.exports.length" class="cm-exports">
              <code v-for="e in r.file.exports" :key="e" class="cm-export">{{ e }}</code>
            </div>
            <div v-else class="ask-muted">None (script, config, page or side-effect module).</div>
            <h4>Used by ({{ r.file.usedBy.length }})</h4>
            <div v-if="!r.file.usedBy.length" class="ask-muted">
              No in-repo importer found (entry point, framework-loaded file, or referenced only at runtime).
            </div>
            <ul v-else class="cm-links">
              <li v-for="u in r.file.usedBy" :key="u">
                <a href="#" @click.prevent="focusFile(u)"><code>{{ u }}</code></a>
              </li>
            </ul>
            <template v-if="r.file.tests.length">
              <h4>Tests ({{ r.file.tests.length }})</h4>
              <ul class="cm-links">
                <li v-for="t in r.file.tests" :key="t"><code>{{ t }}</code></li>
              </ul>
            </template>
            <h4>Docs ({{ r.file.docs.length }})</h4>
            <div v-if="!r.file.docs.length" class="ask-muted">Not mentioned on any docs page yet.</div>
            <ul v-else class="cm-links">
              <li v-for="d in r.file.docs" :key="d.page">
                <a :href="docHref(d)">{{ d.title }}</a>
                <span v-if="d.section" class="ask-muted"> › {{ d.section }}</span>
              </li>
            </ul>
          </div>
        </div>
      </template>
    </div>
    <p class="ask-muted cm-foot">
      {{ data.coverage.files }} files · purposes from header comments {{ data.coverage.header }}, export doc comments
      {{ data.coverage.jsdoc }}, derived {{ data.coverage.derived }}, overrides {{ data.coverage.override }} ·
      {{ data.coverage.documented }} mentioned in the docs
    </p>
  </div>
</template>

<style scoped>
.cm-view {
  display: inline-flex;
  gap: 4px;
}
.cm-treebar {
  display: flex;
  gap: 6px;
  margin: -4px 0 10px;
}
.cm-head {
  grid-template-columns: 12px minmax(0, 1fr) auto;
  gap: 2px 12px;
}
.cm-dir-head {
  grid-template-columns: 12px minmax(0, 1fr) auto;
}
.cm-dir .ask-row-head {
  background: var(--vp-c-bg-soft);
}
.cm-dir .ask-row-head:hover {
  background: var(--vp-c-default-soft);
}
.cm-dirname code {
  font-weight: 600;
  color: var(--vp-c-text-1);
}
.cm-dircount {
  font-size: 12px;
  white-space: nowrap;
}
.cm-name,
.cm-purpose {
  min-width: 0;
  overflow-wrap: anywhere;
}
.cm-name code {
  color: var(--vp-c-brand-1);
}
.cm-badges {
  white-space: nowrap;
}
.cm-purpose {
  grid-column: 2 / 4;
  grid-row: 2;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.45;
}
.cm-method.m-get {
  color: var(--ask-get);
}
.cm-method.m-post {
  color: var(--ask-post);
}
.cm-method.m-put,
.cm-method.m-patch {
  color: var(--ask-put);
}
.cm-method.m-delete {
  color: var(--ask-delete);
}
.cm-meta {
  overflow-wrap: anywhere;
}
.cm-path {
  color: var(--vp-c-brand-1);
}
.cm-exports {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.cm-export {
  padding: 0 6px;
  border-radius: 4px;
  background: var(--vp-c-default-soft);
}
.vp-doc .cm-links {
  margin: 2px 0 4px;
  padding-left: 18px;
}
.vp-doc .cm-links li {
  margin: 2px 0;
  overflow-wrap: anywhere;
}
.cm-foot {
  margin-top: 8px;
  font-size: 12px;
}
@media (max-width: 640px) {
  .cm-badges {
    white-space: normal;
    text-align: right;
  }
  .cm-dircount {
    white-space: normal;
    text-align: right;
  }
  .ask-row-body {
    padding-left: 16px;
  }
}
</style>
