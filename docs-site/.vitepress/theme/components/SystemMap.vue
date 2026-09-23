<script setup lang="ts">
import { useRouter, withBase } from 'vitepress'
import { computed, ref } from 'vue'

import raw from '../../../data/system-map.json'

/**
 * <SystemMap /> — interactive architecture map rendered from data/system-map.json.
 * Schema: { nodes: [{ id, label, kind: client|host|service|external|datastore,
 *   host?, port?, description, link? }], edges: [{ from, to, label }] }
 * Services/datastores with `host` are drawn inside their host box.
 * Hover = tooltip, click = open `link` (touch: first tap = tooltip, second = open).
 * Props: focus="crawl4ai" highlights a node (and its edges) initially.
 */
const props = defineProps<{ focus?: string }>()
const router = useRouter()

type Kind = 'client' | 'host' | 'service' | 'external' | 'datastore'
type Node = { id: string; label: string; kind: Kind; host?: string; port?: string; description?: string; link?: string }
type Edge = { from: string; to: string; label?: string }
const data = raw as { nodes: Node[]; edges: Edge[] }

const CELL_W = 156
const CELL_H = 54
const GAP_IN = 10
const PAD = 14
const HEAD = 30
const GAP = 28
const ROW_GAP = 70
const MARGIN = 16

type Box = { x: number; y: number; w: number; h: number }

const layout = computed(() => {
  const nodes = data.nodes
  const byId = new Map(nodes.map(n => [n.id, n]))
  const hosts = nodes.filter(n => n.kind === 'host')
  const hostIds = new Set(hosts.map(h => h.id))
  const children = new Map<string, Node[]>()
  for (const n of nodes) {
    if (n.kind !== 'host' && n.host && hostIds.has(n.host)) {
      children.set(n.host, [...(children.get(n.host) ?? []), n])
    }
  }
  const loose = nodes.filter(n => n.kind !== 'host' && !(n.host && hostIds.has(n.host)))
  // Top row: clients plus anything a client talks to directly (ingress).
  const clientIds = new Set(loose.filter(n => n.kind === 'client').map(n => n.id))
  const ingress = new Set(
    data.edges.filter(e => clientIds.has(e.from) && !byId.get(e.to)?.host && byId.get(e.to)?.kind !== 'host').map(e => e.to)
  )
  const top = loose.filter(n => clientIds.has(n.id) || ingress.has(n.id))
  const bottom = loose.filter(n => !top.includes(n))

  const boxes = new Map<string, Box>()
  // Host boxes.
  const hostSizes = hosts.map(h => {
    const kids = children.get(h.id) ?? []
    const n = Math.max(kids.length, 1)
    const cols = n <= 2 ? n : n <= 4 ? 2 : 3
    const rows = Math.ceil(kids.length / cols) || 1
    return {
      h,
      kids,
      cols,
      w: PAD * 2 + cols * CELL_W + (cols - 1) * GAP_IN,
      hh: HEAD + PAD + rows * CELL_H + (rows - 1) * GAP_IN
    }
  })
  const hostRowW = hostSizes.reduce((s, x) => s + x.w, 0) + GAP * Math.max(hostSizes.length - 1, 0)
  const rowW = (list: Node[]) => list.length * CELL_W + Math.max(list.length - 1, 0) * GAP
  const width = Math.max(hostRowW, rowW(top), rowW(bottom)) + MARGIN * 2
  const topY = MARGIN + 18
  const hostY = top.length ? topY + CELL_H + ROW_GAP : MARGIN
  const hostRowH = Math.max(0, ...hostSizes.map(x => x.hh))

  const placeRow = (list: Node[], y: number) => {
    let x = (width - rowW(list)) / 2
    for (const n of list) {
      boxes.set(n.id, { x, y, w: CELL_W, h: CELL_H })
      x += CELL_W + GAP
    }
  }
  placeRow(top, topY)
  let hx = (width - hostRowW) / 2
  for (const s of hostSizes) {
    boxes.set(s.h.id, { x: hx, y: hostY, w: s.w, h: s.hh })
    s.kids.forEach((k, i) => {
      const c = i % s.cols
      const r = Math.floor(i / s.cols)
      boxes.set(k.id, {
        x: hx + PAD + c * (CELL_W + GAP_IN),
        y: hostY + HEAD + r * (CELL_H + GAP_IN),
        w: CELL_W,
        h: CELL_H
      })
    })
    hx += s.w + GAP
  }
  const bottomY = hostY + hostRowH + ROW_GAP
  placeRow(bottom, bottomY)
  const height = (bottom.length ? bottomY + CELL_H : hostY + hostRowH) + MARGIN + 18
  return { boxes, width, height, hosts, byId }
})

function center(b: Box) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}
// Point where the segment from the box centre towards (tx,ty) leaves the box.
function clip(b: Box, tx: number, ty: number) {
  const c = center(b)
  const dx = tx - c.x
  const dy = ty - c.y
  if (!dx && !dy) return c
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: c.x + dx * s, y: c.y + dy * s }
}

const edges = computed(() =>
  data.edges
    .map((e, i) => {
      const a = layout.value.boxes.get(e.from)
      const b = layout.value.boxes.get(e.to)
      if (!a || !b) return null
      const ca = center(a)
      const cb = center(b)
      const p1 = clip(a, cb.x, cb.y)
      const p2 = clip(b, ca.x, ca.y)
      return { ...e, i, p1, p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
)

const hovered = ref<string | null>(props.focus ?? null)
const tip = ref<{ x: number; y: number; node: Node } | null>(null)
const wrap = ref<HTMLElement | null>(null)
const scale = ref(1)

const active = computed(() => hovered.value)
function isLinked(e: { from: string; to: string }) {
  return active.value !== null && (e.from === active.value || e.to === active.value)
}
const neighbours = computed(() => {
  const s = new Set<string>()
  if (!active.value) return s
  s.add(active.value)
  for (const e of data.edges) {
    if (e.from === active.value) s.add(e.to)
    if (e.to === active.value) s.add(e.from)
  }
  // Hovering a host also lights its services.
  for (const n of data.nodes) if (n.host === active.value) s.add(n.id)
  return s
})

function showTip(ev: MouseEvent | PointerEvent, node: Node) {
  const el = wrap.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // The tooltip is absolutely positioned inside the scrolling wrapper, so
  // add the scroll offset; keep it inside the visible width.
  tip.value = {
    x: el.scrollLeft + Math.min(ev.clientX - r.left + 14, r.width - 290),
    y: el.scrollTop + ev.clientY - r.top + 14,
    node
  }
}
function enter(ev: MouseEvent, node: Node) {
  hovered.value = node.id
  showTip(ev, node)
}
function leave() {
  hovered.value = null
  tip.value = null
}
function open(node: Node) {
  if (node.link) router.go(withBase(node.link))
}
// Touch: first tap shows the tooltip, a second tap on the same box opens it.
let lastPointer = 'mouse'
let tapped: string | null = null
function onPointerDown(ev: PointerEvent) {
  lastPointer = ev.pointerType || 'mouse'
}
// Touch emulation fires a synthetic mouseleave right after the tap; only a
// real mouse leaving the map should hide the tooltip.
function onWrapLeave() {
  if (lastPointer === 'mouse') leave()
}
function onTap(ev: MouseEvent, node: Node) {
  if (lastPointer !== 'mouse') {
    if (tapped === node.id) {
      tapped = null
      open(node)
    } else {
      tapped = node.id
      hovered.value = node.id
      showTip(ev, node)
    }
    return
  }
  open(node)
}

function zoom(d: number) {
  scale.value = Math.min(3, Math.max(0.6, +(scale.value + d).toFixed(2)))
}

const kinds: { kind: Kind; label: string }[] = [
  { kind: 'client', label: 'Client' },
  { kind: 'host', label: 'Host (machine)' },
  { kind: 'service', label: 'Service' },
  { kind: 'datastore', label: 'Datastore' },
  { kind: 'external', label: 'External / cloud' }
]
function lines(label: string): string[] {
  if (label.length <= 20) return [label]
  const words = label.split(' ')
  let a = ''
  let i = 0
  while (i < words.length && (a + ' ' + words[i]).trim().length <= 20) a = (a + ' ' + words[i++]).trim()
  const b = words.slice(i).join(' ')
  return [a || label.slice(0, 20), b.length > 22 ? b.slice(0, 21) + '…' : b].filter(Boolean)
}
</script>

<template>
  <div class="ask-widget system-map">
    <div class="sm-toolbar">
      <div class="sm-legend">
        <span v-for="k in kinds" :key="k.kind" class="sm-legend-item">
          <span class="sm-swatch" :style="{ background: `var(--ask-kind-${k.kind})` }" />{{ k.label }}
        </span>
      </div>
      <div class="sm-zoom">
        <button type="button" class="ask-btn" aria-label="Zoom out" @click="zoom(-0.2)">−</button>
        <button type="button" class="ask-btn" aria-label="Reset zoom" @click="scale = 1">{{ Math.round(scale * 100) }}%</button>
        <button type="button" class="ask-btn" aria-label="Zoom in" @click="zoom(0.2)">+</button>
      </div>
    </div>
    <div ref="wrap" class="sm-wrap" @mouseleave="onWrapLeave" @pointermove="onPointerDown">
      <svg
        class="sm-svg"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
        :style="{ width: `${scale * 100}%`, minWidth: `${Math.round(720 * scale)}px` }"
        role="img"
        aria-label="Ask system architecture map"
        @mousemove="e => e.target === e.currentTarget && lastPointer === 'mouse' && leave()"
        @click="e => { if (e.target === e.currentTarget) { tapped = null; leave() } }"
      >
        <defs>
          <marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="sm-arrowhead" />
          </marker>
          <marker id="sm-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" class="sm-arrowhead on" />
          </marker>
        </defs>
        <!-- host boxes -->
        <g v-for="h in layout.hosts" :key="h.id">
          <g
            v-if="layout.boxes.get(h.id)"
            class="sm-host"
            :class="{ dim: active && !neighbours.has(h.id), on: active === h.id, link: !!h.link }"
            @mouseenter="enter($event, h)"
            @mousemove="showTip($event, h)"
            @pointerdown="onPointerDown"
            @click.stop="onTap($event, h)"
          >
            <rect :x="layout.boxes.get(h.id)!.x" :y="layout.boxes.get(h.id)!.y" :width="layout.boxes.get(h.id)!.w" :height="layout.boxes.get(h.id)!.h" rx="12" />
            <text :x="layout.boxes.get(h.id)!.x + 12" :y="layout.boxes.get(h.id)!.y + 20" class="sm-host-label">{{ h.label }}</text>
          </g>
        </g>
        <!-- edges -->
        <g class="sm-edges">
          <g v-for="e in edges" :key="e.i" :class="{ on: isLinked(e), dim: active && !isLinked(e) }" class="sm-edge">
            <line :x1="e.p1.x" :y1="e.p1.y" :x2="e.p2.x" :y2="e.p2.y" :marker-end="isLinked(e) ? 'url(#sm-arrow-on)' : 'url(#sm-arrow)'" />
            <g v-if="isLinked(e) && e.label">
              <rect :x="e.mid.x - e.label.length * 3.4 - 6" :y="e.mid.y - 10" :width="e.label.length * 6.8 + 12" height="18" rx="4" class="sm-edge-label-bg" />
              <text :x="e.mid.x" :y="e.mid.y + 3" text-anchor="middle" class="sm-edge-label">{{ e.label }}</text>
            </g>
          </g>
        </g>
        <!-- nodes -->
        <g
          v-for="n in data.nodes.filter(x => x.kind !== 'host' && layout.boxes.get(x.id))"
          :key="n.id"
          class="sm-node"
          :class="{ dim: active && !neighbours.has(n.id), on: active === n.id, link: !!n.link }"
          tabindex="0"
          role="link"
          :aria-label="`${n.label}${n.port ? ' :' + n.port : ''} — ${n.description ?? ''}`"
          @mouseenter="enter($event, n)"
          @mousemove="showTip($event, n)"
          @pointerdown="onPointerDown"
          @click.stop="onTap($event, n)"
          @keydown.enter="open(n)"
          @focus="hovered = n.id"
          @blur="hovered = null"
        >
          <rect :x="layout.boxes.get(n.id)!.x" :y="layout.boxes.get(n.id)!.y" :width="CELL_W" :height="CELL_H" rx="8" class="sm-node-bg" />
          <rect :x="layout.boxes.get(n.id)!.x" :y="layout.boxes.get(n.id)!.y" width="5" :height="CELL_H" rx="2" :style="{ fill: `var(--ask-kind-${n.kind})` }" />
          <text :x="layout.boxes.get(n.id)!.x + 14" :y="layout.boxes.get(n.id)!.y + (lines(n.label).length > 1 ? 20 : 24)" class="sm-node-label">
            <tspan v-for="(l, i) in lines(n.label)" :key="i" :x="layout.boxes.get(n.id)!.x + 14" :dy="i ? 15 : 0">{{ l }}</tspan>
          </text>
          <text v-if="n.port" :x="layout.boxes.get(n.id)!.x + 14" :y="layout.boxes.get(n.id)!.y + CELL_H - 8" class="sm-node-port">:{{ n.port }}</text>
          <text v-else :x="layout.boxes.get(n.id)!.x + 14" :y="layout.boxes.get(n.id)!.y + CELL_H - 8" class="sm-node-port">{{ n.kind }}</text>
        </g>
      </svg>
      <div v-if="tip" class="sm-tip" :style="{ left: `${Math.max(4, tip.x)}px`, top: `${tip.y}px` }">
        <div class="sm-tip-title">
          <span class="sm-swatch" :style="{ background: `var(--ask-kind-${tip.node.kind})` }" />
          <strong>{{ tip.node.label }}</strong>
          <code v-if="tip.node.port">:{{ tip.node.port }}</code>
        </div>
        <div v-if="tip.node.host && layout.byId.get(tip.node.host)" class="ask-muted sm-tip-host">on {{ layout.byId.get(tip.node.host)!.label }}</div>
        <div class="sm-tip-desc">{{ tip.node.description }}</div>
        <div v-if="tip.node.link" class="sm-tip-link">
          <a :href="withBase(tip.node.link)" @click.prevent="open(tip.node)">Open {{ tip.node.link }} →</a>
        </div>
      </div>
    </div>
    <p class="ask-muted sm-hint">Hover a box for details, click to open its page. On touch screens: tap once for details, tap again to open. Scroll or zoom to explore.</p>
    <details class="sm-list">
      <summary>All components as a list</summary>
      <ul>
        <li v-for="n in data.nodes" :key="n.id">
          <a v-if="n.link" :href="withBase(n.link)">{{ n.label }}</a><strong v-else>{{ n.label }}</strong>
          <span class="ask-muted"> ({{ n.kind }}<template v-if="n.host"> on {{ layout.byId.get(n.host)?.label ?? n.host }}</template><template v-if="n.port">, port {{ n.port }}</template>)</span>
          — {{ n.description }}
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.sm-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.sm-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.sm-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sm-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 3px;
}
.sm-zoom {
  display: flex;
  gap: 4px;
}
.sm-zoom .ask-btn {
  min-width: 36px;
  padding: 2px 8px;
}
.sm-wrap {
  position: relative;
  overflow: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-alt);
  -webkit-overflow-scrolling: touch;
}
.sm-svg {
  display: block;
  height: auto;
  user-select: none;
}
.sm-host rect {
  fill: var(--vp-c-bg-soft);
  stroke: var(--ask-kind-host);
  stroke-width: 1.2;
  stroke-dasharray: 5 4;
  transition: opacity 0.15s;
}
.sm-host.on rect {
  stroke-width: 2;
  stroke-dasharray: none;
}
.sm-host-label {
  font-size: 13px;
  font-weight: 600;
  fill: var(--vp-c-text-2);
}
.sm-host.link,
.sm-node.link {
  cursor: pointer;
}
.sm-node-bg {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-divider);
  stroke-width: 1;
  transition: stroke 0.15s;
}
.sm-node.on .sm-node-bg,
.sm-node:focus-visible .sm-node-bg {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
}
.sm-node:focus {
  outline: none;
}
.sm-node-label {
  font-size: 12.5px;
  font-weight: 600;
  fill: var(--vp-c-text-1);
}
.sm-node-port {
  font-size: 11px;
  fill: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}
.dim {
  opacity: 0.28;
}
.sm-node,
.sm-host,
.sm-edge {
  transition: opacity 0.15s;
}
.sm-edge line {
  stroke: var(--vp-c-text-3);
  stroke-width: 1.1;
  opacity: 0.55;
}
.sm-edge.on line {
  stroke: var(--vp-c-brand-1);
  stroke-width: 2;
  opacity: 1;
}
.sm-arrowhead {
  fill: var(--vp-c-text-3);
}
.sm-arrowhead.on {
  fill: var(--vp-c-brand-1);
}
.sm-edge-label-bg {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-brand-1);
  stroke-width: 0.8;
}
.sm-edge-label {
  font-size: 11px;
  fill: var(--vp-c-brand-1);
}
.sm-tip {
  position: absolute;
  z-index: 5;
  width: 280px;
  max-width: calc(100% - 8px);
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-3);
  font-size: 13px;
  line-height: 1.45;
  pointer-events: auto;
}
.sm-tip-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sm-tip-host {
  font-size: 12px;
}
.sm-tip-desc {
  margin-top: 4px;
  color: var(--vp-c-text-2);
}
.sm-tip-link {
  margin-top: 6px;
  font-size: 12px;
}
.sm-hint {
  font-size: 12px;
  margin: 6px 0 0;
}
.sm-list {
  font-size: 13px;
  margin-top: 8px;
}
</style>
