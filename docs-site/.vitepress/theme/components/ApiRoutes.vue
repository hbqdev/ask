<script setup lang="ts">
import { computed, ref } from 'vue'

import data from '../../../data/api-routes.json'

/**
 * <ApiRoutes /> — every app/…/route.ts handler (data/api-routes.json).
 * Props: auth="ingest-token" preselects an auth filter; prefix="/api/chat" limits rows.
 */
const props = defineProps<{ auth?: string; prefix?: string }>()

const q = ref('')
const methods = ref<Set<string>>(new Set())
const auths = ref<Set<string>>(new Set(props.auth ? [props.auth] : []))

const base = computed(() =>
  props.prefix ? data.routes.filter(r => r.path.startsWith(props.prefix!)) : data.routes
)
const allMethods = computed(() => [...new Set(base.value.flatMap(r => r.methods))].sort())
const allAuth = computed(() => {
  const m = new Map<string, number>()
  for (const r of base.value) for (const a of r.auth) m.set(a, (m.get(a) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})
const authDesc = data.authMechanisms as Record<string, string>

const rows = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return base.value.filter(r => {
    if (methods.value.size && !r.methods.some(m => methods.value.has(m))) return false
    if (auths.value.size && !r.auth.some(a => auths.value.has(a))) return false
    if (!needle) return true
    return (
      r.path.toLowerCase().includes(needle) ||
      r.file.toLowerCase().includes(needle) ||
      (r.summary ?? '').toLowerCase().includes(needle)
    )
  })
})

function flip(set: typeof methods, v: string) {
  const s = new Set(set.value)
  s.has(v) ? s.delete(v) : s.add(v)
  set.value = s
}
function authClass(a: string) {
  return a === 'public' ? 'warn' : a === 'user-session' ? 'brand' : 'tip'
}
</script>

<template>
  <div class="ask-widget api-routes">
    <div class="ask-toolbar">
      <input v-model="q" class="ask-input" type="search" placeholder="Filter by path, file or summary…" aria-label="Filter routes" />
      <span class="ask-count">{{ rows.length }} / {{ base.length }}</span>
    </div>
    <div class="ask-chips">
      <span class="ask-muted chip-label">Method</span>
      <button v-for="m in allMethods" :key="m" type="button" class="ask-chip" :class="{ active: methods.has(m) }" @click="flip(methods, m)">{{ m }}</button>
      <span class="ask-muted chip-label">Auth</span>
      <button
        v-for="[a, n] in allAuth"
        :key="a"
        type="button"
        class="ask-chip"
        :class="{ active: auths.has(a) }"
        :title="authDesc[a]"
        @click="flip(auths, a)"
      >
        {{ a }}<span class="n">{{ n }}</span>
      </button>
    </div>
    <div class="ask-list">
      <div v-if="!rows.length" class="ask-empty">No routes match.</div>
      <div v-for="r in rows" :key="r.path" class="ask-row route-row">
        <div class="route-main">
          <span class="route-methods">
            <span v-for="m in r.methods" :key="m" class="method" :class="m.toLowerCase()">{{ m }}</span>
          </span>
          <code class="route-path">{{ r.path }}</code>
          <span class="route-auth">
            <span v-for="a in r.auth" :key="a" class="ask-badge" :class="authClass(a)" :title="authDesc[a]">{{ a }}</span>
            <span v-if="r.authVia.length" class="ask-muted via" :title="r.authVia.join(', ')">via helper</span>
            <span v-if="r.guestAllowed" class="ask-badge" title="Guests (no session) are served too, with limits">guests ok</span>
          </span>
        </div>
        <div class="route-sub">
          <span v-if="r.summary">{{ r.summary }}</span>
          <code class="ask-muted route-file">{{ r.file }}</code>
        </div>
      </div>
    </div>
    <details class="auth-legend">
      <summary>Auth mechanisms</summary>
      <ul>
        <li v-for="(d, k) in authDesc" :key="k"><code>{{ k }}</code> — {{ d }}</li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.chip-label {
  font-size: 12px;
  align-self: center;
  margin: 0 2px 0 6px;
}
.chip-label:first-child {
  margin-left: 0;
}
.route-row {
  padding: 8px 12px;
}
.route-main {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
}
.route-methods {
  display: inline-flex;
  gap: 4px;
  min-width: 52px;
}
.method {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
  padding: 0 5px;
  border-radius: 4px;
  line-height: 18px;
  color: #fff;
  background: var(--vp-c-text-3);
}
.method.get { background: var(--ask-get); }
.method.post { background: var(--ask-post); }
.method.put, .method.patch { background: var(--ask-put); }
.method.delete { background: var(--ask-delete); }
.route-path {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.route-auth {
  margin-left: auto;
}
.via {
  font-size: 11px;
  margin-right: 4px;
}
.route-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 2px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.route-file {
  font-size: 12px;
}
.auth-legend {
  margin-top: 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
@media (max-width: 640px) {
  .route-auth {
    margin-left: 0;
  }
}
</style>
