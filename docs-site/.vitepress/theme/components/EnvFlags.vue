<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import data from '../../../data/env.json'

/**
 * <EnvFlags /> — every env var the app reads (data/env.json, `bun run gen`).
 * Props (all optional):
 *   category="search"            preselect a category chip
 *   query="RERANK"               prefill the text filter
 *   names="SEARCH_ROUNDS_MAX,…"  show ONLY these vars (for embedding a subset in a page)
 */
const props = defineProps<{ category?: string; query?: string; names?: string }>()

type EnvVar = (typeof data.vars)[number]

const q = ref(props.query ?? '')
const cats = ref<Set<string>>(new Set(props.category ? [props.category] : []))
const onlyDefault = ref(false)
const onlyCompose = ref(false)
const open = ref<Set<string>>(new Set())

const only = computed(() =>
  props.names ? new Set(props.names.split(',').map(s => s.trim()).filter(Boolean)) : null
)
const base = computed<EnvVar[]>(() =>
  only.value ? data.vars.filter(v => only.value!.has(v.name)) : data.vars
)

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const v of base.value) counts.set(v.category, (counts.get(v.category) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
})

function hasDefault(v: EnvVar) {
  return Boolean(v.codeDefault || v.defaultHint || v.compose.some(c => c.default))
}

const rows = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return base.value.filter(v => {
    if (cats.value.size && !cats.value.has(v.category)) return false
    if (onlyDefault.value && !hasDefault(v)) return false
    if (onlyCompose.value && !v.compose.length) return false
    if (!needle) return true
    return (
      v.name.toLowerCase().includes(needle) ||
      v.reads.some(r => r.file.toLowerCase().includes(needle)) ||
      (v.codeDefault ?? '').toLowerCase().includes(needle)
    )
  })
})

function toggleCat(c: string) {
  const s = new Set(cats.value)
  s.has(c) ? s.delete(c) : s.add(c)
  cats.value = s
}
function toggle(name: string) {
  const s = new Set(open.value)
  s.has(name) ? s.delete(name) : s.add(name)
  open.value = s
}

function composeSummary(v: EnvVar) {
  const files = [...new Set(v.compose.map(c => c.file.replace(/^docker-compose\.?/, '').replace(/\.ya?ml$/, '') || 'base'))]
  return files
}

onMounted(() => {
  // Deep link: /reference/env-flags#env-SEARCH_ROUNDS_MAX opens that row.
  const m = /^#env-([A-Z0-9_]+)$/.exec(window.location.hash)
  if (m && data.vars.some(v => v.name === m[1])) {
    open.value = new Set([m[1]])
    if (!only.value) q.value = m[1]
    requestAnimationFrame(() => document.getElementById(`env-${m[1]}`)?.scrollIntoView({ block: 'center' }))
  }
})
</script>

<template>
  <div class="ask-widget env-flags">
    <div class="ask-toolbar">
      <input v-model="q" class="ask-input" type="search" placeholder="Filter by name, file or default…" aria-label="Filter env vars" />
      <label class="ask-toggle"><input v-model="onlyDefault" type="checkbox" /> has default</label>
      <label class="ask-toggle"><input v-model="onlyCompose" type="checkbox" /> set in compose</label>
      <span class="ask-count">{{ rows.length }} / {{ base.length }}</span>
    </div>
    <div class="ask-chips">
      <button
        v-for="[c, n] in categories"
        :key="c"
        class="ask-chip"
        :class="{ active: cats.has(c) }"
        type="button"
        @click="toggleCat(c)"
      >
        {{ c }}<span class="n">{{ n }}</span>
      </button>
    </div>
    <div class="ask-list">
      <div v-if="!rows.length" class="ask-empty">No variables match.</div>
      <div
        v-for="v in rows"
        :id="`env-${v.name}`"
        :key="v.name"
        class="ask-row"
        :class="{ open: open.has(v.name) }"
      >
        <div class="ask-row-head env-head" role="button" tabindex="0" @click="toggle(v.name)" @keydown.enter="toggle(v.name)">
          <span class="ask-caret">▸</span>
          <span class="env-name">
            <code>{{ v.name }}</code>
            <span v-if="v.nextPublic" class="ask-badge warn" title="Inlined into the client bundle at BUILD time">build-time</span>
            <span v-if="v.secret" class="ask-badge danger" title="Secret — values are never shown">secret</span>
          </span>
          <span class="env-default">
            <template v-if="v.codeDefault"><code>{{ v.codeDefault }}</code></template>
            <span v-else-if="v.defaultHint" class="ask-muted">{{ v.defaultHint }}</span>
            <span v-else class="ask-muted">—</span>
          </span>
          <span class="env-meta">
            <span class="ask-badge">{{ v.category }}</span>
            <span class="ask-muted" :title="`${v.reads.length} read site(s)`">{{ v.reads.length }}×</span>
          </span>
        </div>
        <div v-if="open.has(v.name)" class="ask-row-body">
          <h4>Default</h4>
          <div>
            <template v-if="v.codeDefaults.length">
              Code: <code v-for="d in v.codeDefaults" :key="d" style="margin-right: 6px">{{ d }}</code>
            </template>
            <span v-if="v.defaultHint"> {{ v.codeDefaults.length ? '·' : '' }} {{ v.defaultHint }}</span>
            <span v-if="!v.codeDefaults.length && !v.defaultHint" class="ask-muted">No literal default detected in code (unset = undefined, or the default lives in a helper).</span>
          </div>
          <h4>Read in code ({{ v.reads.length }})</h4>
          <div v-if="!v.reads.length" class="ask-muted">Not read by app code — consumed by compose/containers only.</div>
          <div v-for="r in v.reads" :key="r.file + r.line" class="env-read">
            <code class="env-path">{{ r.file }}:{{ r.line }}</code>
            <code v-if="r.snippet" class="env-snippet">{{ r.snippet }}</code>
          </div>
          <template v-if="v.compose.length">
            <h4>Compose</h4>
            <table>
              <thead><tr><th>File</th><th>Service</th><th>Value / default</th></tr></thead>
              <tbody>
                <tr v-for="(c, i) in v.compose" :key="i">
                  <td><code>{{ c.file }}</code></td>
                  <td>{{ c.service ?? (c.via === 'interpolation' ? '${…} ref' : '') }}</td>
                  <td>
                    <code v-if="c.value != null">{{ c.value }}</code>
                    <span v-else-if="c.default != null">default <code>{{ c.default }}</code></span>
                    <span v-else class="ask-muted">(from .env)</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
          <template v-if="v.example">
            <h4>Example file</h4>
            <code>{{ v.example.file }}</code>
            <span class="ask-muted"> {{ v.example.commented ? '(commented out)' : '' }}</span>
            <span v-if="v.example.value"> — <code>{{ v.example.value }}</code></span>
          </template>
          <div style="margin-top: 8px">
            <span class="ask-muted">Compose files: </span>
            <span v-for="f in composeSummary(v)" :key="f" class="ask-badge">{{ f }}</span>
            <span v-if="!v.compose.length" class="ask-muted">none</span>
            · <a :href="`#env-${v.name}`" class="ask-muted">link</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.env-head {
  grid-template-columns: 12px minmax(0, 1.4fr) minmax(0, 1fr) auto;
}
.env-name,
.env-default {
  min-width: 0;
  overflow-wrap: anywhere;
}
.env-meta {
  white-space: nowrap;
}
.env-read {
  display: flex;
  flex-direction: column;
  margin: 4px 0 8px;
}
.env-path {
  color: var(--vp-c-brand-1);
}
.env-snippet {
  color: var(--vp-c-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .env-head {
    grid-template-columns: 12px minmax(0, 1fr) auto;
  }
  .env-default {
    grid-column: 2 / 4;
    grid-row: 2;
  }
}
</style>
