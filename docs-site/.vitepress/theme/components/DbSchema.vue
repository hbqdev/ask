<script setup lang="ts">
import { useData } from 'vitepress'
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import data from '../../../data/db-schema.json'

/**
 * <DbSchema /> — tables from lib/db/schema.ts (data/db-schema.json).
 * Props: table="chats" preselects a table; er (boolean) opens the ER diagram.
 */
const props = defineProps<{ table?: string; er?: boolean }>()
const { isDark } = useData()

type Table = (typeof data.tables)[number]
const selected = ref<string>(props.table ?? data.tables[0]?.name ?? '')
const t = computed<Table | undefined>(() => data.tables.find(x => x.name === selected.value))
const showEr = ref(Boolean(props.er))
const erSvg = ref('')
const erError = ref('')

const inbound = computed(() =>
  data.tables.flatMap(x =>
    x.foreignKeys.filter(fk => fk.foreignTable === selected.value).map(fk => ({ table: x.name, fk }))
  )
)

function erText() {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+$/, '')
  const lines = ['erDiagram']
  for (const tb of data.tables) {
    lines.push(`  ${tb.name} {`)
    for (const c of tb.columns) {
      const key = c.primaryKey ? ' PK' : tb.foreignKeys.some(f => f.columns.includes(c.name)) ? ' FK' : ''
      lines.push(`    ${clean(c.type)} ${c.name}${key}`)
    }
    lines.push('  }')
  }
  for (const tb of data.tables) {
    for (const fk of tb.foreignKeys) {
      lines.push(`  ${fk.foreignTable} ||--o{ ${tb.name} : "${fk.columns.join(',')}"`)
    }
  }
  return lines.join('\n')
}

let renderSeq = 0
async function renderEr() {
  if (!showEr.value || typeof window === 'undefined') return
  const seq = ++renderSeq
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default', securityLevel: 'strict' })
    const { svg } = await mermaid.render(`db-er-${seq}`, erText())
    if (seq === renderSeq) erSvg.value = svg
    erError.value = ''
  } catch (e) {
    erError.value = String(e)
  }
}
watch([showEr, isDark], () => nextTick(renderEr))
onMounted(() => {
  const m = /^#table-([a-z0-9_]+)$/.exec(window.location.hash)
  if (m && data.tables.some(x => x.name === m[1])) selected.value = m[1]
  renderEr()
})
</script>

<template>
  <div class="ask-widget db-schema">
    <div class="ask-toolbar">
      <span class="ask-count">{{ data.tables.length }} tables · source <code>{{ data.source }}</code> · {{ data.migrations.length }} migrations in <code>{{ data.migrationsDir }}</code></span>
      <label class="ask-toggle" style="margin-left: auto"><input v-model="showEr" type="checkbox" /> ER diagram</label>
    </div>
    <div v-if="showEr" class="er-box">
      <div v-if="erError" class="ask-muted">ER render failed: {{ erError }}</div>
      <div v-else-if="!erSvg" class="ask-muted">Rendering…</div>
      <div v-else class="er-svg" v-html="erSvg" />
    </div>
    <div class="db-grid">
      <nav class="db-tables" aria-label="Tables">
        <button
          v-for="tb in data.tables"
          :id="`table-${tb.name}`"
          :key="tb.name"
          type="button"
          class="db-table-btn"
          :class="{ active: tb.name === selected }"
          @click="selected = tb.name"
        >
          <code>{{ tb.name }}</code>
          <span class="ask-muted">{{ tb.columns.length }}</span>
          <span v-if="tb.rlsEnabled" class="ask-badge tip" title="Row-level security enabled">RLS</span>
        </button>
      </nav>
      <section v-if="t" class="db-detail">
        <h3 class="db-title">
          <code>{{ t.name }}</code>
          <span v-if="t.rlsEnabled" class="ask-badge tip">RLS {{ t.policies.length }} polic{{ t.policies.length === 1 ? 'y' : 'ies' }}</span>
          <span class="ask-muted export">export <code>{{ t.exportName }}</code></span>
        </h3>
        <div class="scroll">
          <table>
            <thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th></tr></thead>
            <tbody>
              <tr v-for="c in t.columns" :key="c.name">
                <td>
                  <code>{{ c.name }}</code>
                  <span v-if="c.primaryKey" class="ask-badge brand">PK</span>
                  <span v-if="c.unique" class="ask-badge">unique</span>
                  <span v-if="t.foreignKeys.some(f => f.columns.includes(c.name))" class="ask-badge warn">FK</span>
                </td>
                <td>
                  <code>{{ c.type }}</code>
                  <div v-if="c.enumValues" class="ask-muted enum">{{ c.enumValues.join(' | ') }}</div>
                </td>
                <td>{{ c.notNull ? 'no' : 'yes' }}</td>
                <td><code v-if="c.default">{{ c.default }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
        <h4>RLS policies</h4>
        <div v-if="!t.policies.length" class="ask-muted">None.</div>
        <div v-for="p in t.policies" :key="p.name" class="policy">
          <div>
            <code>{{ p.name }}</code>
            <span class="ask-badge">{{ p.for }}</span>
            <span class="ask-badge">{{ p.as }}</span>
            <span class="ask-muted">to {{ p.to.join(', ') }}</span>
          </div>
          <div v-if="p.using"><span class="ask-muted">USING</span> <code class="sql">{{ p.using }}</code></div>
          <div v-if="p.withCheck"><span class="ask-muted">WITH CHECK</span> <code class="sql">{{ p.withCheck }}</code></div>
        </div>
        <h4>Foreign keys</h4>
        <div v-if="!t.foreignKeys.length && !inbound.length" class="ask-muted">None.</div>
        <div v-for="fk in t.foreignKeys" :key="fk.name">
          → <code>{{ fk.columns.join(', ') }}</code> references
          <a href="#" @click.prevent="selected = fk.foreignTable"><code>{{ fk.foreignTable }}</code></a>(<code>{{ fk.foreignColumns.join(', ') }}</code>)
          <span v-if="fk.onDelete" class="ask-badge">on delete {{ fk.onDelete }}</span>
        </div>
        <div v-for="i in inbound" :key="i.fk.name">
          ← referenced by <a href="#" @click.prevent="selected = i.table"><code>{{ i.table }}</code></a>.<code>{{ i.fk.columns.join(', ') }}</code>
        </div>
        <h4>Indexes</h4>
        <div v-if="!t.indexes.length" class="ask-muted">None.</div>
        <div v-for="ix in t.indexes" :key="ix.name ?? ix.columns.join()">
          <code>{{ ix.name }}</code>
          <span class="ask-muted"> on ({{ ix.columns.join(', ') }})</span>
          <span v-if="ix.unique" class="ask-badge">unique</span>
          <span v-if="ix.method !== 'btree'" class="ask-badge">{{ ix.method }}</span>
          <span v-if="ix.where" class="ask-muted"> where <code>{{ ix.where }}</code></span>
        </div>
        <template v-if="t.checks.length">
          <h4>Checks</h4>
          <div v-for="c in t.checks" :key="c.name"><code>{{ c.name }}</code>: <code class="sql">{{ c.value }}</code></div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.db-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
}
.db-tables {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.db-table-btn {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  border-radius: 8px;
  text-align: left;
  color: var(--vp-c-text-1);
}
.db-table-btn:hover {
  background: var(--vp-c-bg-soft);
}
.db-table-btn.active {
  background: var(--vp-c-brand-soft);
}
.db-table-btn .ask-badge {
  margin-left: auto;
}
.db-detail {
  min-width: 0;
}
.db-title {
  margin: 0 0 8px !important;
  padding: 0 !important;
  border: 0 !important;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.export {
  font-size: 12px;
  font-weight: 400;
}
.db-detail h4 {
  margin: 16px 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}
.scroll {
  overflow-x: auto;
}
.enum {
  font-size: 11px;
}
.policy {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-left: 3px solid var(--vp-c-tip-1);
  background: var(--vp-c-bg-soft);
  border-radius: 4px;
}
.sql {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.er-box {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 16px;
  overflow: auto;
  max-height: 80vh;
}
.er-svg :deep(svg) {
  max-width: none !important;
  min-width: 900px;
}
@media (max-width: 640px) {
  .db-grid {
    grid-template-columns: 1fr;
  }
  .db-tables {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .db-table-btn .ask-badge {
    margin-left: 0;
  }
}
</style>
