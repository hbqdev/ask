# Engine Health Gate — Design

**Status:** proposed
**Date:** 2026-07-26

## Problem

SearXNG reports which engines failed but keeps calling them. Measured on
prod's instance:

```
unresponsive_engines: [['brave', 'too many requests'], ['startpage', 'CAPTCHA']]
results returned: 10
```

Those two have failed continuously. Every search pays a round trip to both, and
every attempt burns IP reputation against providers already blocking us — which
is what caused the blocking in the first place.

### The `engines` pin never restricted anything

Ask pins its engines:

```
SEARXNG_ENGINES_ADVANCED = 'bing,duckduckgo,wikipedia,google cse'
SEARXNG_ENGINES_BASIC    = 'bing,google cse'
```

brave, startpage and mojeek appear in _neither_ list — yet all three are
queried on every Ask search. Measured from SearXNG's own logs during a single
staging turn:

```
8 startpage   8 startpage images   8 google cse   8 google cse images
8 brave       6 mojeek             4 duckduckgo
```

**SearXNG UNIONS `categories` with `engines`.** With `categories=general` every
enabled general-category engine runs, and the `engines` pin only ADDS to that
selection. It has never narrowed anything. This also means enabling an engine
in `settings.yml` changes what Ask queries even when Ask does not name it —
which is how today's bing/mojeek change took results from 10 to 30.

So the gate needs a mechanism that actually excludes. Verified against staging,
holding `q` constant across two queries:

| request                                                                                                                   | unresponsive                       |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `engines=bing,duckduckgo,wikipedia,google cse` + `disabled_engines=brave__general,startpage__general,google cse__general` | duckduckgo, **google cse**, mojeek |
| `engines=bing,duckduckgo,wikipedia` + `disabled_engines=…,google cse__general,mojeek__general`                            | duckduckgo                         |

`disabled_engines` (SearXNG's `name__category` form) does exclude — brave and
startpage vanished immediately. But an engine named in `engines` **overrides**
the disable, which is why `google cse` survived the first request and only
disappeared once removed from both.

**Suspension therefore requires both halves:** drop the engine from `engines`
AND list it in `disabled_engines` for every category in play.

Enabling engines is not the fix on its own: bing and mojeek were enabled today
and took results from 10 to 30, but brave/startpage/google-cse still sit in the
path failing.

## Why not the existing watchdog

`fleet-boot/degoog-engine-watchdog.py` has the right shape — breach counting,
suspend, cooldown, never-strand-the-last-engine — but it drove **degoog's
settings API**, and degoog was removed from the stack. It is inert and not
running as a service.

More importantly, its approach does not port: **SearXNG has no runtime API to
enable or disable an engine.** Doing it SearXNG-side would mean rewriting
`settings.yml` and restarting the container, which drops in-flight searches and
is far too heavy for a transient CAPTCHA.

## Design: gate on the client, not the server

Ask already chooses which engines to request — it passes
`engines=bing,duckduckgo,wikipedia,google cse` on every call. So the gate
belongs there: **drop known-bad engines from that parameter** and let SearXNG
serve only what can actually answer.

This needs no SearXNG change, no restart, and no separate health probing —
because SearXNG already reports `unresponsive_engines` on every response. The
signal is free; we are simply discarding it today.

```
search request  ──> engineHealth.filter(requested)   ──> SearXNG
                                                          │
response  <── record(unresponsive_engines) <──────────────┘
```

### State

Redis, shared across requests and workers (a per-process map would let each
worker re-learn the same failures independently).

- `engine:health:<engine>` — rolling breach count, TTL = window
- Failure counts come only from `unresponsive_engines`; a successful response
  clears the engine's counter.

### Parameters

| name                      | default | why                                                  |
| ------------------------- | ------- | ---------------------------------------------------- |
| `ENGINE_BREACH_THRESHOLD` | 3       | one CAPTCHA is noise; three in a window is a pattern |
| `ENGINE_BREACH_WINDOW_S`  | 600     | 10 min, matching the degoog watchdog                 |
| `ENGINE_COOLDOWN_S`       | 1800    | 30 min before retrying, also from degoog             |
| `ENGINE_HEALTH_ENABLED`   | `true`  | off switch, since this changes which engines run     |

### The guard that matters

**Never filter the last engine.** If every requested engine is suspended, send
the original list unchanged. A search against a blocked engine may still
return something; a search against an empty engine list returns nothing at
all, guaranteed. Degrading to "try anyway" is strictly better than degrading
to "no results".

This is the same invariant the degoog watchdog had, and it is the one that
must not be lost in the port.

### Recovery

A suspended engine is retried once its cooldown expires — it re-enters the
requested list, and either succeeds (counter clears, fully restored) or fails
(one breach, suspended again). No separate probe loop; the next real search is
the probe.

## What this does NOT do

- **Does not disable engines in SearXNG.** They stay enabled and available to
  any other client, including direct browsing.
- **Does not change which engines are configured.** `SEARXNG_ENGINES_ADVANCED`
  remains the intent; this only filters it at call time.
- **Does not help other providers.** Tavily/Brave-API/Ollama have their own
  budget gates and circuit breakers already.

## Risks

**Suppressing an engine that was only briefly down.** Three breaches in ten
minutes is deliberately conservative, and the 30-minute cooldown bounds the
cost of a false positive to one retry cycle. The alternative — calling a
CAPTCHA'd engine on every search forever — is the status quo and demonstrably
worse.

**Redis unavailable.** Then no health is recorded and every engine is treated
as healthy, i.e. exactly today's behaviour. Fail-open is correct here: the
gate is an optimisation, not a correctness requirement.

**A silent-failure engine.** `presearch` returned 0 results today without
appearing in `unresponsive_engines`. This gate cannot see that class of
failure — it only reacts to engines SearXNG reports as unresponsive. Engines
that fail silently still need to be caught by inspection, as presearch was.

## Verification

**Deterministic first:**

- With a known-blocked engine (brave), issue 3 searches and confirm the
  Redis counter reaches the threshold.
- Issue a 4th and confirm the outgoing `engines=` parameter **no longer
  contains brave**, by asserting on the request the client builds.
- Confirm that suspending every engine leaves the list unchanged — the
  never-strand guard.

**Then behaviour:**

- `unresponsive_engines` in `[latency:search]` should trend to empty, since we
  stop asking engines that cannot answer.
- `search_ms` should fall slightly: a CAPTCHA round trip is pure latency.
- **Source counts must not fall.** This removes engines that contribute zero
  results, so `candidates` should be flat or up. A drop means the gate is
  suppressing a working engine and is a bug, not a tradeoff.

## Scope

- `lib/search/engine-health.ts` (new) — pure breach/suspension logic, plus a
  Redis-backed store
- `lib/tools/search/engines.ts` — filter the requested list through the gate
- Telemetry: add `engines_suspended` to `[latency:search]` so suppression is
  visible rather than mysterious
