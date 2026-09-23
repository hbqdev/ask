<script setup lang="ts">
import { withBase } from 'vitepress'
import { computed, onMounted, ref } from 'vue'

import raw from '../../../data/turn-steps.json'

/**
 * <TurnWalkthrough /> — step through one chat turn (data/turn-steps.json).
 * Schema: [{ id, title, actor, description, code: ["path:line"], link? }]
 * actor ∈ browser | next-route | classifier | researcher | search | crawl |
 *         rerank | model | persist | redis | postgres
 * `description` supports a markdown-lite subset: `code`, **bold**, [text](/link), blank-line paragraphs.
 * Props: start="<step id>" opens on that step. Deep link: #step-<id>.
 */
const props = defineProps<{ start?: string }>()

type Step = { id: string; title: string; actor: string; description: string; code?: string[]; link?: string }
const steps = raw as Step[]

const ACTORS: { id: string; label: string }[] = [
  { id: 'browser', label: 'Browser' },
  { id: 'next-route', label: 'Next route' },
  { id: 'classifier', label: 'Classifier' },
  { id: 'researcher', label: 'Researcher' },
  { id: 'search', label: 'Search' },
  { id: 'crawl', label: 'Crawl' },
  { id: 'rerank', label: 'Rerank' },
  { id: 'model', label: 'Model' },
  { id: 'redis', label: 'Redis' },
  { id: 'postgres', label: 'Postgres' },
  { id: 'persist', label: 'Persist' }
]
// Any actor not in the canonical list still gets a lane.
const lanes = computed(() => {
  const extra = [...new Set(steps.map(s => s.actor))].filter(a => !ACTORS.some(x => x.id === a))
  const used = new Set(steps.map(s => s.actor))
  return [...ACTORS.filter(a => used.has(a.id)), ...extra.map(id => ({ id, label: id }))]
})

const idx = ref(Math.max(0, steps.findIndex(s => s.id === props.start)))
const step = computed(() => steps[idx.value])
const root = ref<HTMLElement | null>(null)

function go(i: number) {
  idx.value = Math.min(steps.length - 1, Math.max(0, i))
}
function onKey(e: KeyboardEvent) {
  if ((e.target as HTMLElement)?.closest('input, textarea')) return
  if (e.key === 'ArrowRight') { go(idx.value + 1); e.preventDefault() }
  if (e.key === 'ArrowLeft') { go(idx.value - 1); e.preventDefault() }
}
onMounted(() => {
  const m = /^#step-(.+)$/.exec(window.location.hash)
  if (m) {
    const i = steps.findIndex(s => s.id === decodeURIComponent(m[1]))
    if (i >= 0) {
      idx.value = i
      root.value?.scrollIntoView({ block: 'start' })
    }
  }
})

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
/** Markdown-lite → safe HTML (input is escaped first; only whitelisted constructs are re-introduced). */
function md(src: string): string {
  return src
    .split(/\n\s*\n/)
    .map(p => {
      let h = esc(p.trim())
      const codes: string[] = []
      h = h.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
      h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
        const ok = /^(\/|#|https?:\/\/)/.test(u)
        if (!ok) return t
        const href = u.startsWith('/') ? withBase(u) : u
        return `<a href="${href}"${u.startsWith('http') ? ' target="_blank" rel="noreferrer"' : ''}>${t}</a>`
      })
      h = h.replace(/\n/g, '<br>')
      h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`)
      return `<p>${h}</p>`
    })
    .join('')
}

const COL = 44
const LANE_H = 26
const LABEL_W = 92
const laneW = computed(() => LABEL_W + steps.length * COL + 12)
const laneH = computed(() => lanes.value.length * LANE_H + 8)
function laneY(actor: string) {
  return lanes.value.findIndex(l => l.id === actor) * LANE_H + LANE_H / 2 + 4
}
const pathD = computed(() =>
  steps.map((s, i) => `${i ? 'L' : 'M'} ${LABEL_W + i * COL + COL / 2} ${laneY(s.actor)}`).join(' ')
)
</script>

<template>
  <div ref="root" class="ask-widget turn-walk" tabindex="0" @keydown="onKey">
    <div v-if="!steps.length" class="ask-empty">No steps in data/turn-steps.json yet.</div>
    <template v-else>
      <div class="tw-lanes">
        <svg :viewBox="`0 0 ${laneW} ${laneH}`" :style="{ minWidth: `${laneW}px` }" role="img" aria-label="Actor lanes">
          <g v-for="(l, li) in lanes" :key="l.id">
            <rect x="0" :y="li * LANE_H + 4" :width="laneW" :height="LANE_H" :class="['tw-lane', { active: l.id === step.actor, odd: li % 2 }]" />
            <text x="8" :y="li * LANE_H + 4 + LANE_H / 2 + 4" :class="['tw-lane-label', { active: l.id === step.actor }]">{{ l.label }}</text>
          </g>
          <path :d="pathD" class="tw-path" />
          <g v-for="(s, i) in steps" :key="s.id" class="tw-dot-g" @click="go(i)">
            <title>{{ i + 1 }}. {{ s.title }}</title>
            <circle
              :cx="LABEL_W + i * COL + COL / 2"
              :cy="laneY(s.actor)"
              :r="i === idx ? 9 : 6"
              :class="['tw-dot', { done: i < idx, current: i === idx }]"
            />
            <text v-if="i === idx" :x="LABEL_W + i * COL + COL / 2" :y="laneY(s.actor) + 4" text-anchor="middle" class="tw-dot-n">{{ i + 1 }}</text>
          </g>
        </svg>
      </div>

      <div class="tw-progress" aria-hidden="true"><div :style="{ width: `${((idx + 1) / steps.length) * 100}%` }" /></div>

      <div class="tw-body">
        <ol class="tw-steps">
          <li v-for="(s, i) in steps" :key="s.id" :class="{ current: i === idx, done: i < idx }">
            <button type="button" @click="go(i)">
              <span class="tw-n">{{ i + 1 }}</span>
              <span class="tw-t">{{ s.title }}</span>
            </button>
          </li>
        </ol>
        <article class="tw-card" aria-live="polite">
          <div class="tw-card-head">
            <span class="ask-muted">Step {{ idx + 1 }} / {{ steps.length }}</span>
            <span class="ask-badge brand">{{ lanes.find(l => l.id === step.actor)?.label ?? step.actor }}</span>
          </div>
          <h3 :id="`step-${step.id}`" class="tw-title">{{ step.title }}</h3>
          <div class="tw-desc" v-html="md(step.description)" />
          <div v-if="step.code?.length" class="tw-code">
            <div class="ask-muted tw-code-h">Code</div>
            <code v-for="c in step.code" :key="c">{{ c }}</code>
          </div>
          <a v-if="step.link" :href="withBase(step.link)" class="tw-more">Read more →</a>
          <div class="tw-nav">
            <button type="button" class="ask-btn" :disabled="idx === 0" @click="go(idx - 1)">← Prev</button>
            <span class="ask-muted tw-keys">← → keys work too</span>
            <button type="button" class="ask-btn primary" :disabled="idx === steps.length - 1" @click="go(idx + 1)">Next →</button>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>

<style scoped>
.turn-walk:focus {
  outline: none;
}
.tw-lanes {
  overflow-x: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-alt);
}
.tw-lanes svg {
  display: block;
  width: 100%;
  height: auto;
}
.tw-lane {
  fill: transparent;
}
.tw-lane.odd {
  fill: var(--vp-c-bg-soft);
}
.tw-lane.active {
  fill: var(--vp-c-brand-soft);
}
.tw-lane-label {
  font-size: 11px;
  fill: var(--vp-c-text-3);
}
.tw-lane-label.active {
  fill: var(--vp-c-brand-1);
  font-weight: 700;
}
.tw-path {
  fill: none;
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
}
.tw-dot-g {
  cursor: pointer;
}
.tw-dot {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-text-3);
  stroke-width: 1.5;
  transition: r 0.15s;
}
.tw-dot.done {
  fill: var(--vp-c-brand-3);
  stroke: var(--vp-c-brand-3);
}
.tw-dot.current {
  fill: var(--vp-c-brand-1);
  stroke: var(--vp-c-brand-1);
}
.tw-dot-n {
  font-size: 10px;
  font-weight: 700;
  fill: var(--vp-c-white);
  pointer-events: none;
}
.tw-progress {
  height: 3px;
  margin: 10px 0 14px;
  background: var(--vp-c-divider);
  border-radius: 2px;
  overflow: hidden;
}
.tw-progress div {
  height: 100%;
  background: var(--vp-c-brand-1);
  transition: width 0.2s;
}
.tw-body {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 16px;
}
.tw-steps {
  list-style: none;
  margin: 0 !important;
  padding: 0 !important;
  max-height: 520px;
  overflow: auto;
}
.tw-steps li {
  margin: 0 !important;
}
.tw-steps button {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  text-align: left;
  font-size: 13px;
  line-height: 1.35;
  color: var(--vp-c-text-2);
}
.tw-steps button:hover {
  background: var(--vp-c-bg-soft);
}
.tw-steps li.current button {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
}
.tw-steps li.done button {
  color: var(--vp-c-text-1);
}
.tw-n {
  flex: none;
  width: 20px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-3);
}
.tw-card {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.tw-card-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.tw-title {
  margin: 6px 0 8px !important;
  padding: 0 !important;
  border: 0 !important;
  font-size: 18px;
}
.tw-desc :deep(p) {
  margin: 0 0 10px;
  line-height: 1.6;
  font-size: 14px;
}
.tw-code {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.tw-code-h {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tw-more {
  font-size: 13px;
}
.tw-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 14px;
}
.tw-keys {
  font-size: 11px;
}
@media (max-width: 760px) {
  .tw-body {
    grid-template-columns: 1fr;
  }
  .tw-steps {
    order: 2;
    max-height: 220px;
  }
  .tw-keys {
    display: none;
  }
}
</style>
