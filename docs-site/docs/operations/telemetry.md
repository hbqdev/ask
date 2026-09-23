---
title: Telemetry
---

# Telemetry

Ask writes one structured JSON line per chat turn, plus one line per search
and one per classifier call. These lines are the main tool for questions like
"why was that answer slow?" and "did my change help?". This page lists every
field, explains where the lines are stored, gives a step-by-step procedure for
diagnosing slowness, and describes how to run a lab A/B test whose results can
be trusted.

::: danger Diagnose from telemetry, never from live probes
Do not fire test searches at SearXNG, degoog, Brave, Tavily, or the Google CSE
to diagnose a problem. The residential IP and the shared CSE key are already
flagged, and a handful of "just one query" probes has rate-limited them before.
Staging shares the same search infrastructure, so staging searches count too.
Work from the lines on this page, from container logs (for example SearXNG's
`unresponsive_engines` field in organic traffic), and from Redis counters. If a
probe is unavoidable, send one query, reuse it, and tell the team first.
:::

## The lines

| Tag | Emitted by | One per | Also stored in Redis `latency:log`? |
|---|---|---|---|
| `[latency]` | `LatencyTracker.emit` (`lib/streaming/latency-tracker.ts`), called from `onFinish` in `lib/streaming/create-chat-stream-response.ts` | chat turn | yes |
| `[latency:search]` | `StageTimer` (`lib/telemetry/stage-timer.ts`) in `app/api/advanced-search/route.ts` **or** in `lib/tools/search.ts` | search call | yes |
| `[latency:classify]` | `lib/agents/query-classifier-telemetry.ts` | classifier call | yes |
| `[search] round cap reached (N > B, mode=…)` | `lib/tools/search.ts:398` | capped search | no (stdout only). The matching `[latency:search] kind:"round-cap"` line is stored |
| `[crop-pos]`, `[cite-urls]` | `lib/search/crop-position.ts`, `create-chat-stream-response.ts` | advanced search / turn (only when `SEARCH_CROP_POSITION_SHADOW=true`) | no |
| `[stop] {outcome}` | `create-chat-stream-response.ts` | user-stopped turn (`partial_saved` / `nothing_to_save` / `stale_skipped`) | no |
| `[stall-suspect]` | `LatencyTracker.emit` | aborted turn that produced no text after ≥120s of silence (the signature of a provider stall) | no |
| `[search-dedup]`, `[search-expansion]`, `[advanced-search] crawl4ai enriched X/Y…`, `[Researcher] <Mode> mode: maxSteps=…` | various | event | no |

Read stdout with `docker logs <container>`. The containers are `ask` (prod),
`ask-admin-feature` (staging), and `ask-lab` (lab). Add `-t` to get timestamps:
**the JSON lines themselves have no timestamp.**

## `[latency]`: the per-turn line

Every field below is optional unless it says otherwise. A field that does not
apply to a turn is left out; it is not written as `0`. Offsets are in ms from
the moment the tracker was created, which is right before `prepareMessages`.

### Identity and routing

| Field | Meaning |
|---|---|
| `chatId` | Chat id. Joins to `[latency:search]`, `[crop-pos]`, and `[cite-urls]`. It is the id in `/search/<id>` |
| `mode` | The search mode: `speed` / `balanced` / `quality`. Written as `balanced` when the turn had no mode |
| `variant` | `FLOW_VARIANT` (lab control-flow arm). `baseline` everywhere else |
| `modelId` | **The model that actually answered**, e.g. `ollama:deepseek-v4.1-flash:cloud`. Use this, not the picker. See [Models & reasoning](/search/models-reasoning#how-the-picker-chooses-a-model-and-why-a-saved-choice-beats-the-default) |
| `skipSearch`, `needsRecent`, `needsSources` | The classifier's decision. Together they give the turn mode: `skipSearch` → direct; neither need → stable-knowledge; otherwise research |

### Pre-work, before the agent starts

| Field | Meaning |
|---|---|
| `prepare_ms` | `prepareMessages` (loading history, attaching files) |
| `attachments_ms` | Attachment preparation, only when files are attached |
| `classify_ms` | From the classifier's start until the turn **awaited** its result. The await comes after message conversion, pruning, and truncation. Because of that, a turn that **bypassed** the classifier (speed mode, URL, Retry) still shows a non-zero value (a prod speed turn showed 968ms). For the classifier's own cost, use `[latency:classify]` |
| `recall_wait_ms` | Time the turn actually **waited** for past-conversation recall. At most `RECALL_BUDGET_MS` (1500), since the wait is capped |
| `recall_ms` | The **full** background cost of recall, recorded when it finishes even if the turn had already moved on |
| `recall_budget_hit` | `true` when the 1500ms cap fired and the turn continued without recall |
| `expand_ms` | How long the expansion-variants promise was in flight. ~0 when the classifier supplied the variants itself (the normal case) |
| `doc_inject_clipped` | `true` when attached-document excerpts were trimmed to fit the context window |

### Time to first output and the step structure

| Field | Meaning |
|---|---|
| `ttft_ms` | First chunk of **any** type sent to the client. On a research turn this is usually the first step or tool call, **not** the first word of prose |
| `first_step_ms` | Offset of the agent's first `start-step`. A good proxy for all pre-work (prepare, classify, recall, agent build) |
| `steps` | Number of `start-step` parts, i.e. model steps |
| `tool_calls` | Number of `tool-input-available` parts (all tools, not only search) |
| `stream` | Map from UI-message part type to the offset where it **first** appeared, e.g. `{"start-step":3978,"tool-output-available":3980,"text-start":14071,"text-end":19855,"finish":19857}`. `stream["text-start"]` is when the prose began |
| `answer_wait_ms` (= `ingest_ms`, kept for old dashboards) | From the **last** tool output to the first prose. This is prompt processing plus thinking before the answer starts |
| `gen_ms` | Prose generation span, `text-start` → `text-end` |

### Tool stage totals, summed over the turn's calls

| Field | Meaning |
|---|---|
| `search_ms` | Fan-out time of every search call, **summed**. For an advanced call it is the route's concurrent fan-out; for a basic call, the provider round trip (cache hits add nothing). Expansion-variant searches are **not** included |
| `crawl_ms` | crawl4ai sidecar time (advanced calls only) |
| `enrich_ms` | Legacy in-process crawl and content assembly, after crawl4ai. ~0 when crawl4ai handled everything |
| `rerank_ms` | Rerank time. Advanced calls use the cross-encoder; speed-mode calls use local passage selection |
| `fetch_ms` | Total wall time of `fetch` tool calls, summed |

### Tokens, citations, and totals

| Field | Meaning |
|---|---|
| `prompt_tokens` | Input tokens **summed across all steps** (cost) |
| `last_prompt_tokens` | Input tokens of the **final** step, i.e. the answering prompt. **Use this to judge a change to prompt size** |
| `completion_tokens` | Output tokens summed across steps, **including reasoning**. Use this to judge a change to reasoning or `ANSWER_THINK` |
| `citations_total`, `citations_unresolved` | Citation anchors in the answer, and how many name a `toolCallId` this turn never produced. Those anchors were **invented** by the model and render as nothing or as the wrong source. Only written when the answer has at least one citation |
| `total_ms` | Wall time from tracker creation to `onFinish`. Always present |
| `abort_silence_ms`, `blank_abort` | Only on aborted turns: how long the turn was silent before the abort, and whether any prose had been written. Silence ≥120s with no prose looks like a provider stall; a short silence is a user pressing Stop or a disconnect |

Example (prod, balanced, a research turn; `chatId` omitted):

```json
{"mode":"balanced","variant":"baseline","modelId":"ollama:deepseek-v4.1-flash:cloud",
 "prepare_ms":2,"classify_ms":1681,"recall_wait_ms":1501,"expand_ms":1,"recall_ms":5527,
 "recall_budget_hit":true,"doc_inject_clipped":false,"ttft_ms":3978,"steps":3,"tool_calls":3,
 "answer_wait_ms":786,"ingest_ms":786,"gen_ms":5784,"first_step_ms":3978,
 "search_ms":6327,"crawl_ms":1407,"enrich_ms":2,"rerank_ms":3498,"fetch_ms":1108,
 "stream":{"start-step":3978,"tool-input-available":3979,"tool-output-available":3980,
           "finish-step":11374,"text-start":14071,"text-delta":14072,"text-end":19855,"finish":19857},
 "prompt_tokens":55200,"last_prompt_tokens":30815,"completion_tokens":2316,
 "citations_total":24,"citations_unresolved":0,"total_ms":19859,
 "skipSearch":false,"needsRecent":true,"needsSources":true}
```

::: warning What the turn line cannot show
- **The model's reasoning between tool calls has no field of its own.**
  `answer_wait_ms` covers only the wait after the *last* tool. The `stream` map
  records only the *first* time each part type appears, so the middle steps are
  hidden. Estimate the unattributed time as
  `total_ms − first_step_ms − (search+crawl+enrich+rerank+fetch) − answer_wait_ms − gen_ms`.
  Because tool calls can overlap in time, treat this as a rough figure.
- The stage totals are **sums**. A turn with 3 searches shows their total, not
  the slowest one. Use the `[latency:search]` lines (joined on `chatId`) to see
  each search.
:::

## `[latency:search]`: the per-search line

Two different code paths emit this tag. **If the line has a `provider` field,
the search tool emitted it** (a basic, speed, expansion, or round-cap search).
**If it has no `provider` field, `/api/advanced-search` emitted it.**

### Emitted by the advanced route

| Field | Meaning |
|---|---|
| `chatId`, `depth`, `intent` | identity |
| `mode`, `tier_sources` | `balanced`/`quality`/`legacy`, and `apis` or `apis+searxng`. **Only present on code from 2026-09-04 onward**; older lines don't have them |
| `cache`, `cache_ms` | `hit`/`miss` on the 1h advanced cache. A hit line carries only `cache_ms` |
| `search_ms` | Concurrent fan-out across all providers (no per-provider breakdown) |
| `preview_ms` | When the preview NDJSON line was sent to the UI |
| `snippet_gate` (+ `snippet_rank_ms`, `snippet_ranked`, `snippet_capped`) | Gate mode (`off` in every env) and its numbers when on |
| `candidates`, `crawled` | Pool size after the gate; URLs sent to crawl4ai |
| `chunks`, `chunk_failures`, `median_chunk_ms`, `slowest_chunk_ms` | crawl4ai batch stats. Tell apart "one bad chunk" from "everything slow" |
| `crawl_ms` | crawl4ai stage |
| `crawl4ai_outage` | `1` when crawl4ai returned nothing (legacy crawl then capped at 8 pages) |
| `legacy_crawled`, `legacy_timed_out`, `legacy_skipped` | Legacy JSDOM crawler counts |
| `enrich_ms` | Legacy crawl and assembly stage |
| `rerank_ms`, `rerank_tier`, `rerank_docs` | Rerank time; which tier ran (`cross-encoder` / `embedding` / `keyword` / `none`); docs scored. **A tier other than `cross-encoder` means the reranker failed or filtered everything out** |
| `returned`, `returned_ranks` | Sources returned; their pre-crawl ranks (only when the gate ran) |
| `total_ms` | Route wall time |

### Emitted by the search tool

| `kind` | When | Notable fields |
|---|---|---|
| *(absent)* | normal basic search, or a `type:"general"` Brave+SearXNG search | `provider` (`searxng`/`brave`), `depth`, `cache` hit/miss, `search_ms`, `variant_wait_ms`, `variant_found`, `variant_added`, `merged` (`brave+searxng`, …), `returned`, `images`, `videos`, `error` |
| `expansion` | the classifier's variants, first search only | `variants`, `search_ms` (the slowest variant; they run concurrently), `cache_misses`, `failed`, `returned` |
| `speed-ollama` | speed-mode fast path | `provider:"ollama-web"`, `search_ms`, `rerank_ms`, `passages`, `returned`, `fallthrough` (`empty`/`error` when it fell back to SearXNG), `rerank_error` |
| `round-cap` | a search call that went over the per-turn budget | `search_round`, `search_round_budget`, `search_round_capped:true`, `total_ms:0` |

Round-cap example: `[latency:search] {"chatId":"…","provider":"none","kind":"round-cap","search_round":4,"search_round_budget":3,"search_round_capped":true,"total_ms":0}`,
with the stdout line `[search] round cap reached (4 > 3, mode=balanced) — instructing model to answer from gathered sources`.

## `[latency:classify]`

`{total_ms, model_ms, overhead_ms, prompt_tokens, gen_tokens, gen_tok_per_s, model, outcome}`.

| `outcome` | Meaning | What to change if it is frequent |
|---|---|---|
| `ok` | classification used | — |
| `budget` | soft budget `CLASSIFIER_BUDGET_MS` (4000) ran out; the request was aborted and the turn fell back to always-search | the budget, or the classifier model |
| `failed` | threw, or hit the 10s hard timeout | the timeout or the host |
| `empty` | the model answered but returned nothing usable | the prompt |
| `unconfigured` | no classifier host set | the env |

Anything other than `ok` means the turn **lost the search gate and searched
anyway**. The line has **no `chatId`**, so it can only be matched to a turn by
its position in the log.

## `latency:log` in Redis

Docker's json-file logs are per container and are wiped by every rebuild. To
keep history, every tagged line above is also written to the per-env Redis
(`lib/telemetry/latency-store.ts`) as a fire-and-forget write that never fails
a turn:

- Key **`latency:log`**, written with **`LPUSH`** and trimmed with
  `LTRIM 0 4999`. **The newest entry is at the head.** `LRANGE latency:log 0 N`
  returns the *most recent* N+1 lines.
- `[latency]`, `[latency:search]`, and `[latency:classify]` lines are mixed in
  one list. Filter by the prefix.
- Redis containers: `ask-redis` (prod), `ask-redis-admin-feature` (staging),
  `ask-redis-lab` (lab). Staging's list can be empty when it has had no traffic.

```bash
# 50 most recent entries on prod (read-only)
docker exec ask-redis redis-cli LRANGE latency:log 0 49
# only turn lines
docker exec ask-redis redis-cli LRANGE latency:log 0 499 | grep '^\[latency\] '
```

::: danger The log survives deploys, so filter to lines from the current code
Because `latency:log` persists across rebuilds, it **mixes turns from before
and after a deploy**. A regression that seems to appear right after you ship is
often an old line. This has happened: slow classifier calls were blamed on a
new budget cap that "didn't work", and every one of them came from before the
cap was deployed. When verifying a change, keep only lines that contain a
field **only the new code writes**:

| Code era | Field to filter on |
|---|---|
| ≥ 2026-09-01 (consolidated turn line) | `answer_wait_ms` / `first_step_ms` / `search_ms` on `[latency]` |
| ≥ 2026-09-04 (source tiers) | `mode` / `tier_sources` on the route's `[latency:search]` |
| ≥ 2026-09-07 (round cap) | `kind:"round-cap"` exists at all |
| ≥ 2026-09-08 (recall cap telemetry) | `recall_wait_ms` / `recall_budget_hit` on `[latency]` |
| ≥ 2026-09-12 (doc budget) | `doc_inject_clipped` on `[latency]` |

For a change of your own, add a new field (or a new `kind`) so its lines can be
picked out.
:::

A quick summary script (read-only):

```bash
docker exec ask-redis redis-cli LRANGE latency:log 0 999 > /tmp/lat.txt
python3 - <<'EOF'
import json, statistics as st
turns = [json.loads(l.split(' ', 1)[1]) for l in open('/tmp/lat.txt') if l.startswith('[latency] ')]
cur = [t for t in turns if 'recall_wait_ms' in t]          # current-code filter
def med(k, ts): v = [t[k] for t in ts if isinstance(t.get(k), (int, float))]; return round(st.median(v)) if v else None
for name, ok in [('research', lambda t: not t['skipSearch'] and (t['needsSources'] or t['needsRecent'])),
                 ('stable',   lambda t: not t['skipSearch'] and not t['needsSources'] and not t['needsRecent']),
                 ('direct',   lambda t: t['skipSearch'])]:
    ts = [t for t in cur if ok(t)]
    print(name, len(ts), {k: med(k, ts) for k in ['total_ms', 'ttft_ms', 'last_prompt_tokens', 'completion_tokens']})
EOF
```

### Reference numbers (prod, mid-September 2026)

46 turns on current code, 45 of them balanced. Answering models were
deepseek-v4.1-flash (24), deepseek-v4-flash (10), glm-5.3-flash (7),
deepseek-v4-pro (3), and minimax-m3 (2).

| Slice | n | median `total_ms` | median `ttft_ms` | median `last_prompt_tokens` |
|---|---|---|---|---|
| research | 22 | ~19.5s (max ~300s, one abort) | ~4.2s | ~25k (max ~109k) |
| stable-knowledge | 17 | ~10.3s | ~3.9s | ~7k |
| direct | 7 | ~6.8s | ~2.3s | ~7k |
| balanced advanced search, cache miss (13) | | route ~9.9s: fan-out ~1.9s, crawl ~2.9s, rerank ~2.7s; ~29 candidates → 10 returned | | |
| classifier (84 calls) | | ~1.9s; 76 ok / 6 failed / 2 budget | | |

Observations from that sample worth watching:

- **`recall_budget_hit` was `true` on 31 of 46 turns**, with a real `recall_ms`
  of ~5.5s. The 1500ms cap protects latency as intended, but on most turns
  the past-conversation context was dropped. See [Memory & recall](/knowledge/memory-recall).
  Fixed on lab 2026-09-23 (recall about 1.3 s, see
  [recall latency](/knowledge/memory-recall#recall-latency)).
- **10 of 46 turns had `citations_unresolved > 0`**, i.e. invented anchors. One
  had 16 of 44, and another had 8 of 8. The invented anchors came from several
  models.

## Diagnosing "slow answers", step by step

1. **Find the turn.** Get the `chatId` from the URL (`/search/<id>`), then
   `docker logs ask 2>&1 | grep '<chatId>'`, or search `latency:log`. A chat
   has one `[latency]` line per turn, in order.
2. **Establish the context.** Read `modelId`, `mode`, and the turn mode
   (`skipSearch`/`needsSources`/`needsRecent`). Compare `total_ms` with the
   reference numbers for *that* slice. A 20s research turn is normal; a 20s direct
   turn is not.
3. **Split `total_ms` into four buckets:**
   - **Pre-work** ≈ `first_step_ms`. It should be a few seconds.
     - `classify_ms` high → check `[latency:classify]`. A `budget` or `failed`
       outcome means the classifier host or model is slow (the classifier model
       *can* be tuned).
     - `recall_wait_ms` ≈ 1500 with `recall_budget_hit:true` → the cap did its
       job and recall is not the cause.
     - `attachments_ms` high → the upload or ingest path (see [RAG & uploads](/knowledge/rag-uploads)).
   - **Tools** = `search_ms + crawl_ms + enrich_ms + rerank_ms + fetch_ms`.
     Open the turn's `[latency:search]` lines:
     - `search_ms` high on an advanced line → the fan-out waits for its slowest
       provider. Check provider logs and circuit-breaker warnings (`[tavily]`,
       `[brave]`, `[langsearch]`, `[ollama] … failed`) in `docker logs`.
     - `crawl_ms` high → `crawled`, `chunks`, `slowest_chunk_ms`,
       `chunk_failures`, `crawl4ai_outage`. Many `legacy_crawled` means pages
       went through the slow in-process JSDOM crawler, which also stalls the
       Node event loop. Check the crawl4ai sidecar ([Runbooks](/operations/runbooks)).
       On balanced, `crawled` should be ≤ `BRAVE_CRAWL_MAX` (3).
     - `rerank_ms` high or `rerank_tier` ≠ `cross-encoder` → reranker health
       (NightFuryX `:8787`), `rerank_docs`, `RERANK_PASSAGE_BUDGET`.
     - `fetch_ms` high → the model deep-read pages; each fetch can take up to
       40s. It was 30s on one observed turn.
     - Many basic searches → look for `kind:"round-cap"` lines. The model looped
       until the cap stopped it.
   - **Waiting for the answer** = `answer_wait_ms`. High together with a high
     `last_prompt_tokens` → prompt processing on a large prompt. The fix is a
     smaller payload (crop, source count, excerpts, rerank budget), not a
     different model.
   - **Writing** = `gen_ms`. High together with high `completion_tokens` →
     long answers or reasoning leaking into the text. Check `ANSWER_THINK`
     (should be off) and the narration strippers ([Models & reasoning](/search/models-reasoning)).
   - **The rest** (see the formula above) = the model reasoning between tool
     calls. It grows with `steps` and `tool_calls`.
4. **Aborted turns:** `abort_silence_ms` ≥ 120000 with `blank_abort:true` →
   a provider stall (look for `[stall-suspect]`). A short silence → the user
   pressed Stop or disconnected.
5. **Decide what to change.** If the time is in pipeline stages, tune the
   pipeline ([knobs](/search/pipeline#knobs)). If it is mostly the model's own
   reasoning and looping, say so in your write-up, and remember that switching
   the answering model is not the fix (see
   [the principle](/search/models-reasoning#optimize-the-pipeline-not-the-model)).
   The levers are the round cap, prompt size, and reasoning effort.
6. **Before shipping a fix, measure it on the lab** (next section) and confirm
   it on prod using lines from the new code only.

**Worked example** (a real prod balanced turn, 70.0s): `first_step_ms` 5.7s
(fine). Tools: `search_ms` 6.7s, `crawl_ms` 5.1s, `rerank_ms` 2.1s, **`fetch_ms`
30.1s**. `stream["text-start"]` came at 48.7s, then **`gen_ms` 21.4s**, with
**`last_prompt_tokens` 109k** and **16 of 44 citations unresolved**. Reading:
the model fetched pages for ~30s, then wrote a long answer from a very large
prompt and invented about a third of its citations. The levers are fetch
behavior and prompt size, not search or crawl.

## Running a lab A/B properly

Architecture changes are built and measured on the **lab** first (`ask-flow`
worktree, branch `flow-design`, container `ask-lab`, port 3742, auth off as the
`lab-harness` user). Only a win that is proven and isolated gets ported to
staging and prod ([Deploy](/operations/deploy), [Testing & QA](/operations/testing-qa)).

**Switch arms against one build.** `docker-compose.lab.yaml` exposes knobs as
`${VAR:-default}`, so an arm is just a shell variable plus a recreate. No rebuild:

```bash
cd /home/nightfury/selfhosted/ask-flow
ANSWER_THINK=on docker compose -p ask-stack-lab \
  -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml \
  up -d --force-recreate ask
docker exec ask-lab printenv ANSWER_THINK     # confirm the arm is live
```

Shell-togglable today: `FLOW_VARIANT`, `SEARCH_ROUNDS_MAX(_QUALITY)`,
`ANSWER_THINK`, `SEARCH_ENRICH_MAX_CHARS`, `SEARCH_QUALITY_FILTER`,
`SEARCH_SNIPPET_GATE(_TOP_N)`, `SEARCH_CROP_POSITION_SHADOW`,
`OLLAMA_SEARCH_ENABLED`, and others. To A/B a knob that isn't in the list, add
it to the overlay the same way.

**Rules for a result that holds up:**

1. **Hold the answering model fixed.** Pin it for the whole run and check
   `modelId` on every line. Remember that a saved pick outranks
   `DEFAULT_CHAT_MODEL`.
2. **Interleave the arms turn by turn** (A, B, A, B, …), not in blocks. Search
   results and provider latency drift over minutes.
3. **Remove confounders.** Flush the advanced/basic search cache between turns
   (`search:*` keys in `ask-redis-lab`), because a warm cache in one arm makes
   it look faster. Disable or hold constant anything the change doesn't touch,
   such as recall.
4. **Tag the arm.** `variant` covers only `FLOW_VARIANT`. For an env-knob arm,
   note the recreate times (`docker logs -t`), or add a field the change itself
   writes.
5. **Validity filter.** Keep a pair only if **both arms really were in their
   intended states**. Examples: the cap arm actually shows a `round-cap` line;
   the reasoning-off arm actually has lower `completion_tokens`. A turn where
   the model simply didn't search tells you nothing about a search change.
6. **Measure the metric the change can affect:** `completion_tokens` for
   reasoning, `last_prompt_tokens` for prompt size, per-search `crawl_ms` /
   `rerank_ms` for pipeline stages. `total_ms` on a single turn is heavily
   confounded by the model's own reasoning variance.
7. **Judge quality from answers, not counts.** Source counts, tool-call counts,
   and gate rates describe what Ask *did*. They do not show whether the answer
   was better. Use a blind pairwise judge with the sides swapped, and **split the
   results by question class**: a combined score can look positive while the
   class the feature exists for gets worse.
8. **Know your n.** With high run-to-run variance, n=2 can only detect large
   effects. Prefer a deterministic check where one exists. For example: prove a
   rejected URL never appeared in any run; use `lib/embeddings/__bench__/full-content-bench.ts`
   for rerank changes; use prod shadow logs (`[crop-pos]`) for crop changes.
   Live-browser A/Bs of retrieval changes are swamped by search
   non-determinism and by the model's own choice of whether to search.
9. **Use the fewest live queries you can.** The lab shares the flagged egress.
   Reuse a small fixed question set, and never probe engines directly.

**Examples from the project's history:** the rerank-budget cut (320→160)
passed because answers were judged comparable across three searching prompts
*and* rerank time fell 40%. The single-pass redesign failed an interleaved,
cache-flushed, model-pinned A/B (n=6) on both speed and multi-hop grounding.
Targeted reasoning came out **inconclusive**, because neither of the bugs it
was meant to fix reproduced in either arm. See [Decisions](/history/decisions).
