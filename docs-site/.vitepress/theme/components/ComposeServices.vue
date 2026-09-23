<script setup lang="ts">
import { computed, ref } from 'vue'

import data from '../../../data/compose-services.json'

/**
 * <ComposeServices /> — services per environment (data/compose-services.json).
 * Environments merge base + overlays the way `docker compose -f … -f …` does
 * (scalars replace, lists append unless the overlay marks `!override`, env merges by key).
 * Props: env="lab" preselects an environment (or a compose file name).
 */
const props = defineProps<{ env?: string }>()

type File = (typeof data.files)[number]
type Svc = File['services'][number]
type EnvEntry = { key: string; value: string | null; from: string }
type Merged = {
  name: string
  containerName: string | null
  image: string | null
  build: Svc['build']
  ports: string[]
  networks: string[]
  networkMode: string | null
  restart: string | null
  dependsOn: string[]
  volumes: string[]
  envFile: string[]
  healthcheck: boolean
  env: EnvEntry[]
  files: string[]
}

const options = computed(() => [
  ...data.environments.map(e => ({ id: e.id, label: `${e.label} (${e.project})`, files: e.files })),
  ...data.files.map(f => ({ id: f.file, label: `${f.file} — ${f.label}`, files: [f.file] }))
])
const selected = ref(props.env ?? data.environments[0]?.id ?? '')
const current = computed(() => options.value.find(o => o.id === selected.value) ?? options.value[0])
const openEnv = ref<Set<string>>(new Set())

const services = computed<Merged[]>(() => {
  const map = new Map<string, Merged>()
  for (const fname of current.value?.files ?? []) {
    const f = data.files.find(x => x.file === fname)
    if (!f) continue
    for (const s of f.services) {
      let m = map.get(s.name)
      if (!m) {
        m = { name: s.name, containerName: null, image: null, build: null, ports: [], networks: [], networkMode: null, restart: null, dependsOn: [], volumes: [], envFile: [], healthcheck: false, env: [], files: [] }
        map.set(s.name, m)
      }
      m.files.push(fname)
      const ov = new Set(s.overrides)
      m.containerName = s.containerName ?? m.containerName
      m.image = s.image ?? m.image
      m.build = s.build ?? m.build
      m.networkMode = s.networkMode ?? m.networkMode
      m.restart = s.restart ?? m.restart
      m.healthcheck = m.healthcheck || s.healthcheck
      for (const k of ['ports', 'networks', 'dependsOn', 'volumes', 'envFile'] as const) {
        const incoming = s[k] as string[]
        const yamlKey = k === 'dependsOn' ? 'depends_on' : k === 'envFile' ? 'env_file' : k
        if (ov.has(yamlKey)) m[k] = [...incoming]
        else if (incoming.length) m[k] = [...new Set([...m[k], ...incoming])]
      }
      for (const e of s.env) {
        const i = m.env.findIndex(x => x.key === e.key)
        const entry = { key: e.key, value: e.value, from: fname }
        if (i >= 0) m.env[i] = entry
        else m.env.push(entry)
      }
    }
  }
  const list = [...map.values()]
  for (const m of list) m.env.sort((a, b) => a.key.localeCompare(b.key))
  return list.sort((a, b) => a.name.localeCompare(b.name))
})

function toggle(name: string) {
  const s = new Set(openEnv.value)
  s.has(name) ? s.delete(name) : s.add(name)
  openEnv.value = s
}
function short(f: string) {
  return f.replace(/^docker-compose\.?/, '').replace(/\.ya?ml$/, '') || 'base'
}
</script>

<template>
  <div class="ask-widget compose-services">
    <div class="ask-toolbar">
      <select v-model="selected" class="ask-select" aria-label="Environment or compose file">
        <optgroup label="Environments (merged)">
          <option v-for="o in options.slice(0, data.environments.length)" :key="o.id" :value="o.id">{{ o.label }}</option>
        </optgroup>
        <optgroup label="Single file (raw)">
          <option v-for="o in options.slice(data.environments.length)" :key="o.id" :value="o.id">{{ o.label }}</option>
        </optgroup>
      </select>
      <span class="ask-count">{{ services.length }} services</span>
    </div>
    <div class="ask-muted files-line">
      <template v-if="current">
        <code>docker compose<template v-if="data.environments.find(e => e.id === current.id)"> -p {{ data.environments.find(e => e.id === current.id)!.project }}</template><template v-for="f in current.files" :key="f"> -f {{ f }}</template></code>
      </template>
    </div>
    <div class="svc-grid">
      <div v-for="s in services" :key="s.name" class="svc">
        <div class="svc-head">
          <strong>{{ s.name }}</strong>
          <code v-if="s.containerName" class="ask-muted">{{ s.containerName }}</code>
          <span v-if="s.healthcheck" class="ask-badge tip">healthcheck</span>
        </div>
        <dl>
          <template v-if="s.image"><dt>image</dt><dd><code>{{ s.image }}</code></dd></template>
          <template v-if="s.build"><dt>build</dt><dd><code>{{ s.build.context }}</code><span v-if="s.build.dockerfile"> · <code>{{ s.build.dockerfile }}</code></span></dd></template>
          <template v-if="s.ports.length"><dt>ports</dt><dd><code v-for="p in s.ports" :key="p" class="pill">{{ p }}</code></dd></template>
          <template v-if="s.networkMode"><dt>network</dt><dd><code>{{ s.networkMode }}</code></dd></template>
          <template v-else-if="s.networks.length"><dt>networks</dt><dd><span v-for="n in s.networks" :key="n" class="ask-badge">{{ n }}</span></dd></template>
          <template v-if="s.restart"><dt>restart</dt><dd>{{ s.restart }}</dd></template>
          <template v-if="s.dependsOn.length"><dt>depends on</dt><dd>{{ s.dependsOn.join(', ') }}</dd></template>
          <template v-if="s.envFile.length"><dt>env_file</dt><dd><code>{{ s.envFile.join(', ') }}</code></dd></template>
          <dt>from</dt><dd><span v-for="f in s.files" :key="f" class="ask-badge">{{ short(f) }}</span></dd>
        </dl>
        <button v-if="s.env.length" type="button" class="ask-btn env-btn" @click="toggle(s.name)">
          {{ openEnv.has(s.name) ? 'Hide' : 'Show' }} environment ({{ s.env.length }})
        </button>
        <div v-if="openEnv.has(s.name)" class="env-list">
          <div v-for="e in s.env" :key="e.key" class="env-item">
            <code class="k">{{ e.key }}</code>
            <code v-if="e.value != null" class="v">{{ e.value }}</code>
            <span v-else class="ask-muted">(host env)</span>
            <span class="ask-badge from">{{ short(e.from) }}</span>
          </div>
        </div>
      </div>
    </div>
    <p class="ask-muted note">{{ data.note }}</p>
  </div>
</template>

<style scoped>
.files-line {
  margin-bottom: 12px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.svc-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.svc {
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 12px;
  background: var(--vp-c-bg-soft);
  min-width: 0;
}
.svc-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: baseline;
  margin-bottom: 8px;
}
dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  font-size: 13px;
}
dt {
  color: var(--vp-c-text-3);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.pill {
  margin-right: 6px;
}
.env-btn {
  margin-top: 10px;
  font-size: 12px;
}
.env-list {
  margin-top: 8px;
  max-height: 320px;
  overflow: auto;
  font-size: 12px;
}
.env-item {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  align-items: baseline;
  padding: 3px 0;
  border-top: 1px dashed var(--vp-c-divider);
}
.env-item .v {
  color: var(--vp-c-text-2);
  overflow-wrap: anywhere;
}
.env-item .from {
  margin-left: auto;
}
.note {
  font-size: 12px;
  margin-top: 12px;
}
</style>
