---
title: Models & reasoning
---

# Models & reasoning

Ask uses several language models in each turn. They have different jobs and
are configured separately:

| Role | What it does | Model (running) | Configured by | Tunable for latency? |
|---|---|---|---|---|
| **Answering model** | runs the research agent (tool loop) and writes the answer | the user's pick from `OLLAMA_MODELS`; default `kimi-k2.6:cloud` | picker / `DEFAULT_CHAT_MODEL` | **No, not as a fix.** See [the principle](#optimize-the-pipeline-not-the-model) |
| **Query classifier** (with fused query expansion) | decides search vs no search, rewrites the query into standalone form, emits expansion variants | `deepseek-v4-pro:cloud` | `CLASSIFIER_MODEL_ID` | **Yes.** It is a fixed pipeline component |
| Expansion fallback, title generation, memory extraction | local small-model jobs | `granite4.2:8b` on Serenity (`LOCAL_LLM_BASE_URL`, `192.168.50.171:11434`) | `EXPANDER_MODEL_ID`, `TITLE_MODEL_ID`, `MEMORY_EXTRACTOR_MODEL_ID` | yes |
| Reranker / embedders | scoring, not generation | see [Search pipeline](/search/pipeline) and [Memory & recall](/knowledge/memory-recall) | | |

## Model roster

### Cloud means Ollama Cloud, and nothing else

Every answering model is an **Ollama Cloud** model (`<name>:cloud`), served by
ollama.com. The request goes to the **local Ollama daemon on NightFuryX**
(`OLLAMA_BASE_URL=http://192.168.50.17:11434`), which is signed in to
ollama.com and forwards `:cloud` models to it. The fleet uses Ollama everywhere
(local and cloud) so that there is one provider and one bill. **Do not add direct
Anthropic, OpenAI, or Google API models** for any stage, even where one would fit
well. The registry still contains those providers (`lib/utils/registry.ts`,
inherited from the upstream project), and they activate only if their API keys are set.

### The list

The picker is populated from **`OLLAMA_MODELS`**, a comma-separated list
(`lib/models/fetch-models.ts:393`). It is read when the container starts, so
changing it needs a `--force-recreate`, not a rebuild. As of 2026-09-22 the three
envs run the same list:

```
kimi-k3:cloud, minimax-m3:cloud, deepseek-v4-pro:cloud, kimi-k2.6:cloud,
qwen3.5:397b:cloud, glm-5.3-flash:cloud, kimi-k2.7-code:cloud, deepseek-v4.1-flash:cloud
```

`deepseek-v4-flash:cloud` was **delisted** on 2026-09-11 (replaced by
`deepseek-v4.1-flash`). Older telemetry and some saved preferences still
reference it (see the next section).

The sanctioned way to edit the list or `DEFAULT_CHAT_MODEL` is the **Ask Model
Manager** UI (`http://localhost:3939` on NightFuryX, LAN-only, password-gated).
It edits the prod `.env`, keeps a backup, and runs the exact prod
`docker compose -p ask-stack -f … up -d --force-recreate --no-deps ask`.
See [Services](/infrastructure/services).

::: warning "The model exists" is not "the model works": extra-usage models can return 402
Some Ollama Cloud models are billed as **extra usage** and are not covered by
the plan. When the account's extra-usage balance is empty, generation returns
**HTTP 402** ("this model uses extra usage only … your extra usage balance is
empty") on the **first token**, even though `/api/show` and
`https://ollama.com/api/tags` list the model with full metadata. In July 2026
`kimi-k3:cloud` was the `DEFAULT_CHAT_MODEL` and broke every new session this
way (`steps:0`, `tool_calls:0`, `stream.error` at ~7s). It worked again by
2026-09-11 after the balance was topped up. **Before making any model the
default, send it one real generation** (`POST /api/generate` on the daemon).
A metadata probe proves nothing. A 402 is an account and billing state, so
code-level checks cannot see it.
:::

### How the picker chooses a model, and why a saved choice beats the default

`selectModel` (`lib/utils/model-selection.ts:118`, self-hosted branch)
resolves in this order:

1. **Logged-in user:** their saved pick, `user_settings.preferred_chat_model`
   (Postgres, stored as `providerId:modelId`). The browser cookie is
   **ignored** for logged-in users, so a different account on a shared browser
   does not inherit someone else's model.
2. **Guest:** the `selectedModel` cookie.
3. `DEFAULT_MODEL`, which is `DEFAULT_CHAT_MODEL` or the code fallback `kimi-k2.6:cloud`
   (`lib/config/default-model.ts`, read when the module loads).
4. The first model in the fetched list.

The saved pick is checked **only for whether its provider is enabled**. It is
never checked against `OLLAMA_MODELS`. Two consequences:

- **Changing `DEFAULT_CHAT_MODEL` only affects sessions with no saved pick.**
  Everyone who ever picked a model keeps that model indefinitely.
- **Delisting a model does not move anyone off it.** The stale id is still
  sent to Ollama. This was observed on staging: a turn ran on a model minutes
  after it was removed from the list. The picker UI makes this worse:
  `lib/model-selector/get-model-selector-data.ts` re-validates the saved pick
  against the list and falls back **for display only**. The UI can show one
  model while another one answers.

**To see which model actually answered**, read `modelId` in the turn's
`[latency]` line ([Telemetry](/operations/telemetry)). Never infer it from the
picker. **To move existing users**, clear `user_settings.preferred_chat_model`
(and ask guests to clear the cookie).

## The query classifier

`classifyQuery` (`lib/agents/query-classifier.ts`) runs once per turn, in
parallel with message preparation, **before** the answering model starts. It
returns:

| Field | Meaning |
|---|---|
| `skipSearch` | the conversation already answers this. The turn mode becomes `direct` |
| `standaloneQuery` | the latest message rewritten so it makes sense without the conversation (used as a hint and for recall) |
| `needsRecent` | the answer changes over time. Searches get `time_range=month` |
| `needsSources` | whether citing sources would improve the answer at all |
| `intent` | e.g. `news`. Adds an intent-specific SearXNG category or engine |
| `expandedQueries` | up to 3 alternative phrasings. **Expansion is fused into this call** |

**Why expansion is fused into the classifier.** Classification and expansion
used to be two calls in a row to the same model (classify 6.9–9s, then expand
6.6–12.3s). The second could not start until the first returned, because it
needed `standaloneQuery`. Folding expansion into the classifier removed that
round trip, so `expand_ms` is now ~0. The standalone expander
(`lib/agents/query-expander.ts`, granite on Serenity, 15s timeout) runs only as
a **fallback** when the classifier returns no variants
(`lib/agents/classifier-expansion.ts`). Splitting them again so that expansion
could "overlap" was considered and rejected, because it would be slower: the
first advanced search already runs without waiting on the variants.

### Turn modes

`resolveTurnMode` (`lib/agents/researcher.ts:142`) maps the classifier's
output to one of three configurations:

| Turn mode | Condition | Prompt | Tools advertised | `maxSteps` |
|---|---|---|---|---|
| `direct` | `skipSearch` | `DIRECT_ANSWER_PROMPT` (answer from the conversation) | escape hatch: search, fetch, calculate, weather, remember, recall | 10 |
| `stable-knowledge` | `!needsSources && !needsRecent` | `STABLE_KNOWLEDGE_PROMPT` (answer from knowledge) | calculate, weather, remember, recall. **`search` is not advertised** | 10 |
| `research` | otherwise | the search mode's prompt | per mode (see [Search pipeline](/search/pipeline#the-three-search-modes)) | 20 / 50 / 100 |

`stable-knowledge` exists because of a blind pairwise judge over 46 turns: when
Ask searched a settled question and the comparison system did not, the
comparison won 13–2. Searching settled questions padded answers with citations
to introductory pages. A separate evaluation found the gate is right
to suppress search: forcing retrieval on the turns it suppressed scored 1W-7L-3T
(operational questions) and 1W-8L-1T (concept questions). **Source counts and
gate rates describe what Ask did. They do not show whether the answer was
better.** Judge the answers before deciding a gate is wrong.

The classifier is **bypassed** (defaults to "search, needsSources=true") when
the message contains a URL, when the user hits Retry, and in **speed mode**
(`create-chat-stream-response.ts:271`).

### Classifier model, host, and budget

| Setting | Value | Notes |
|---|---|---|
| `CLASSIFIER_MODEL_ID` | `deepseek-v4-pro:cloud` (all envs) | code default is `granite4.2:8b`, but every env overrides it. Chosen 2026-09-04 in a bake-off of the 7 roster models: the fastest usable one (~0.9s isolated, ~1.1–1.3s in a real turn), made the same search/no-search decisions as granite, and rewrote follow-ups better. `glm-5.3-flash` spiked to ~10s on follow-ups. kimi-k3 and minimax returned empty or failed tool calls |
| Host | `CLASSIFIER_OLLAMA_BASE_URL`, falling back to `OLLAMA_BASE_URL` | prod: NightFuryX `:11434`. **Staging and lab hardcode `192.168.50.231:11434`** (MiniNightFury's Ollama) in their overlays |
| Call shape | tool calling (not schema/`format`), `temperature: 0`, `think: false`, `keep_alive: -1` | cloud Ollama models honor tool calls reliably, and schema-constrained output is less reliable. `think:false` keeps the gate fast |
| `CLASSIFIER_BUDGET_MS` | **4000** (soft) | aborts the in-flight request and falls back to "always search". Logged as `outcome:"budget"` |
| `CLASSIFIER_TIMEOUT_MS` | 10000 (hard, constant) | logged as `outcome:"failed"` |
| History shown | last 20 messages, each clipped | full research reports otherwise overflow the context window and the classifier answers the *previous* question |

**Where the classifier model is set (three places).** Prod reads it from the
host-local `ask-prod/.env`. Staging and lab **hardcode** it in
`docker-compose.admin-feature.yaml` and `docker-compose.lab.yaml`, and an
overlay's `environment:` takes precedence over `.env`. To change it
everywhere, edit the prod `.env` **and** both overlays, then commit the
overlays. A `?? 'default'` in code is not what is deployed. Always
confirm with `docker exec <container> printenv CLASSIFIER_MODEL_ID`.

**Cost in production.** Recent prod `[latency:classify]` lines (84): median total
~1.9s. 76 `ok`, 6 `failed`, 2 `budget`. Real turns cost more than the isolated
bake-off number because the same call also generates the expansion variants.

## Reasoning control (`ANSWER_THINK`)

### What it does

The answering model's reasoning ("thinking") is controlled per request by
`resolveAnswerThink()` (`lib/utils/ollama-think.ts`). The result is passed as a
**model-level** setting where the answering model is created:
`provider(modelId, { think })` in `getModel()` (`lib/utils/registry.ts:98`).
This is the only setting that takes effect. `ai-sdk-ollama` reads `think`
from model settings and ignores the AI SDK's call-level `providerOptions`. The
`providerOptions.ollama.think: true` still set in `lib/config/default-model.ts`
and `model-selection.ts` therefore **does nothing**. It is harmless but misleading.

Precedence: `ANSWER_THINK` → the legacy `OLLAMA_THINK` (only the exact string
`false` disables) → the code default `ANSWER_THINK_DEFAULT = false`.

| `ANSWER_THINK` | Effect |
|---|---|
| unset / empty | code default: **off** (`think:false`) |
| `off` / `false` / `0` / … | reasoning off |
| `on` / `true` / `1` / … | full reasoning |
| `low` / `medium` / `high` | a graded effort level. **A no-op on the fleet's models** (see below) |
| anything else | **on**. An unknown value fails safe to reasoning on |
| `targeted` / `auto` | **lab only, not in prod/staging code.** On for `research` turns, off otherwise |

The value is read on every call, so an env change takes effect on the next turn
after the container is recreated.

### Why the default is off

A reasoning model on a hard question produced **~66k characters of raw chain of
thought** in one turn (plus a 17k-character answer, ~25k output tokens). On
another prod turn, 85s of a 132s turn passed between the search finishing and
the first word. A 2026-09-09 lab A/B found:

- **Graded levels (`low`/`medium`/`high`) are a no-op** on the fleet's cloud
  models (deepseek, kimi, minimax, …). Only gpt-oss honors levels, and
  any truthy value means full reasoning. **Only `think:false` actually reduces
  reasoning.**
- `think:false` cut completion tokens by **13–42%**, and answer quality held on
  the hardest case tested.

It shipped fleet-wide with the default off. Separately,
`NEXT_PUBLIC_SHOW_REASONING=false` (inlined at build time) replaces the raw
chain-of-thought display with a compact "Thinking… / Thought" pill
(`components/reasoning-section.tsx`). The raw text never reaches the DOM.
Hiding the display does not make anything faster, because the model still
generated the text. The speed gain comes from turning reasoning off.

::: warning Known side effects of reasoning-off
Turning reasoning off does not remove the model's reasoning. It **moves it into
the visible text**, and it makes some models rely on earlier context instead of
searching. Two symptoms were seen, both worst on `deepseek-v4-flash` (now
delisted) and `glm-5.3-flash`:
1. **Chain-of-thought in the answer text**, e.g. ~15k characters of "The search
   limit has been reached … the source gave me …" before the `## ` heading on
   a turn that hit the round cap. The narration strippers below handle this.
2. **Follow-ups that should search but don't:** the model answers a follow-up
   that needs a *new* fact from the earlier context, and sometimes invents
   citation anchors. The prompt nudge below reduces this.
If these keep appearing on the current roster, the next option to consider is
`targeted` reasoning. Its current evidence is below.
:::

### `targeted` reasoning: built, A/B'd, not shipped

In `targeted` mode, reasoning is on only when `resolveTurnMode === 'research'`,
and off for `direct` and `stable-knowledge` turns. The researcher passes
`turnMode` into `getModel(model, abortSignal, turnMode)`. This exists **only on
the lab branch** (`flow-design`, commit `68e3490d`). Prod and staging code have
no `targeted` branch and pass no `turnMode`. It does nothing until
`ANSWER_THINK=targeted` is set.

Lab A/B (2026-09-19, pinned to `deepseek-v4.1-flash`): **neither side effect
reproduced**. With reasoning off everywhere, the model already searched ~100%
of research follow-ups, and 0 of 12 turns leaked in either arm. The test
could therefore measure only the cost: **~+14s per research turn
(+58–72% total time, 2× completion tokens)**. Quick turns were unaffected. It
was not shipped: that cost is not worth paying for a problem that does not
reproduce on the current roster. To decide properly, re-run the A/B pinned to
`glm-5.3-flash` and include a turn that hits the round cap.

## Narration and chain-of-thought leak handling

"Narration" is the model talking about its process ("Let me search for…",
"I have comprehensive data now…") in visible text instead of in reasoning parts.
It happens in three places, and each is handled at a different layer:

| Leak shape | Live (while streaming) | Persisted (what reload, history, and search indexing see) |
|---|---|---|
| **Reasoning parts** (the model's native thinking) | shown as a "Thinking…" pill; raw text not rendered | stored unchanged in the message; the display is gated by `NEXT_PUBLIC_SHOW_REASONING` |
| **Inter-step narration**: a separate text part, then more tool calls, then the answer | **muted by the renderer**: while streaming, a text part renders as answer text only if it starts with a markdown heading (`components/render-message.tsx:225`); after the stream completes, only the last text part renders | **dropped** by `stripNarrationFromMessage` (`lib/streaming/helpers/strip-narration-from-message.ts`): a non-final text part that looks like narration and is followed by a later tool or text part is removed |
| **Fused preamble**: narration in the same text part as the answer, before its `## ` heading | **stripped by the stream transform** `smoothAndStripNarration()` (`smooth-and-strip-narration.ts`), passed as `experimental_transform` to `researchAgent.stream` | stripped again by `stripNarrationPreamble` at persist time |

How the stream transform decides (`strip-narration-preamble.ts`):

- It buffers the start of every text part. If a `## ` heading appears at
  offset 0, it flushes immediately. If a heading appears later, it strips the
  text before the heading when that text **starts with a known narration
  phrase** (`NARRATION_STARTERS`, which includes the round-cap and
  "source inventory" phrases). There is also a **structural backstop**
  (`shouldStripPreamble`): a preamble longer than 1000 characters that shows a
  strong reasoning signal (a stray `<think>`/`</think>` tag, or ≥3 first-person
  research sentences) is stripped even without a matching phrase. The
  thresholds come from measurement: real introductions were ≤~700 characters,
  and the smallest real leak was ~8KB.
- If no heading has appeared, it keeps buffering only while the text still
  looks like narration, up to `NARRATION_HARD_MAX` (16000 characters, sized for
  the largest observed ~15KB dump). A normal answer with no heading is released
  after ~64 characters.
- `stripStrayThinkTags` removes a leading `<think>` block or a stray
  `</think>`, but leaves the tag alone when an answer genuinely mentions it.

Limits to know about:

- **A final answer with fused narration and no `## ` heading is left intact.**
  With no heading there is nothing safe to cut at, and removing real content
  would be worse. It is rare because every mode's prompt requires the answer to
  start with a heading.
- **Cleaning is model-specific in practice.** The leak families were collected
  from specific models (deepseek-v4-flash, glm-5.3-flash). A new model can
  narrate in a way no pattern matches yet. Add its phrasing to
  `NARRATION_STARTERS`, with a test in `lib/streaming/helpers/__tests__`.
- **Live and persisted views can differ.** A leak that gets past the live
  transform (for example, glm narration that doesn't match a starter pattern
  and doesn't meet the structural threshold) can briefly appear while
  streaming and then be gone after a reload, once the persist-time pass has
  run. *(Reported for glm. The 2026-09-19 A/B saw 0 of 12 leaks on the current
  roster.)*
- **Cleaning applies only to new answers.** A message that was saved with a
  leak stays that way until the user regenerates it.
- The round-cap notice itself tells the model not to restate the limit or
  describe its sources, and to start with the heading (`lib/tools/search.ts:408`).

## Follow-up re-search prompt nudge

Every research prompt has an exception, "clarifying your own prior answer",
under which the model answers from context without searching. On 2026-09-19 a
clause was added after it, in the speed prompt and in `getApproachStrategy`
(which balanced and quality inherit)
(`lib/agents/prompts/search-mode-prompts.ts:135,258`):

> A follow-up that needs a NEW fact is not clarification: if answering the
> follow-up requires any current fact, entity, number, date, or detail NOT
> already established earlier in THIS conversation … call `search` before answering.

It only changes prompt text, so it adds **no latency**. It is a **soft** lever. On
the lab, kimi-k2.6 still skipped the search on 1 of 2 follow-ups that needed a
new fact. It did not cause extra searching on pure clarifications, because the
classifier routes those to `direct` before the prompt applies. It shipped
as low-cost insurance (lab `61ee1708`, staging `f83ede19`, prod `03e70c52`).

## `activeTools` does not block a tool

In AI SDK v6 (`ai@^6`), `activeTools`, both on the agent and when returned
from `prepareStep`, only filters which tool **definitions are sent to the
model**. Execution looks the tool up in the **full `tools` map** and never
checks `activeTools`. A tool left out of `activeTools` is still callable. This
was observed on the lab: with `activeTools: []`, kimi-k2.6 still emitted a
`search` call and the SDK ran it. With `maxSteps: 1`, the result was a
zero-character answer after 32s. Also, `ai-sdk-ollama` silently drops
`toolChoice`, so `toolChoice: 'none'` is not a substitute.

How Ask handles this:

- **To actually block a tool, remove it from the `tools` map.** An unknown tool
  name does not crash the turn: the SDK marks the call `invalid` and the loop
  continues.
- **To enforce a budget, do it inside `execute`.** The search round cap works
  this way.
- **`stable-knowledge` hides `search` from the advertised list but deliberately
  keeps it in the map** as an escape hatch. A wrong "no sources needed" decision
  should lead to an extra search, not an ungrounded answer.
- `applyAnswerDeadline` (`lib/agents/answer-deadline.ts`) returns
  `activeTools: []` after 200s together with a "TIME TO ANSWER" note. Because of
  the behavior above, that alone only stops *advertising* tools, so the deadline
  is also **enforced in `execute`**: `enforceAnswerDeadline` wraps every tool in
  the researcher's `tools` map, and once the turn is past the deadline a call
  returns a non-error "answer now" result (shaped like that tool's normal output)
  without running, and logs `[deadline] refused <tool> call`. A test drives the
  real SDK with a mock model that emits a `fetch` call under `activeTools: []` and
  checks the tool never runs. (Fixed 2026-09-23; before that a late `fetch` still
  ran.)

## Optimize the pipeline, not the model

**Rule:** latency and quality work targets the **pipeline**. It never changes
which answering model is used.

**Why:**

- Users switch answering models freely, even from turn to turn (glm, deepseek,
  kimi, minimax, …). A fix that depends on one model disappears as soon as
  someone picks another. A pipeline fix helps every model.
- Tying a fix to a model hides the real cause. On prod in September 2026, turns
  took 60–269s, and the model was the largest single factor (glm-5.3-flash
  looped 3–6 tool calls with slow reasoning between calls). The fixes that
  worked were all model-agnostic: the speed fast path, source tiers, the Brave
  crawl cap, the recall/classifier/LangSearch timeouts, the search-round cap,
  and turning reasoning off. Each of these helps every model.
- Prompt caching for the answering model was investigated (2026-09-11) and does
  not help. Ollama Cloud exposes no controllable prefix cache and always
  reports 0 cached tokens. Also, `pruneMessages({toolCalls:'before-last-2-messages'})`
  already strips earlier turns' crawled pages, so each turn's prompt is mostly
  *this* turn's search payload, and there is little shared prefix to reuse.

**Levers that fit the rule:** smaller prompts (crop, source count, rerank
budget), fewer search rounds, faster or parallel stages, timeboxes on
non-critical stages, reasoning effort (a per-request parameter applied the same
way to any model), and the **classifier model**, which is a fixed internal
component and can be tuned. It is fine to *record* the model's share of a slow
turn (`modelId` is on every `[latency]` line). Do not respond by changing the
default model or A/B-ing models as the fix.
