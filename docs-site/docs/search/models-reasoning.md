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
| `skipSearch` | the message is **not a question**: social talk that asks for nothing (greeting, thanks, acknowledgement, chit-chat, venting), a pure transform of text already present (rewrite, translate, summarise, reformat; asking for a recommendation or verdict is not a transform), pure arithmetic or unit conversion, an image request, or an explicit instruction to remember or forget something about the user that asks nothing else. The turn mode becomes `direct`. Every question, including a follow-up that confirms or chooses, is `false`; when unsure, `false` |
| `standaloneQuery` | the latest message rewritten so it makes sense without the conversation. It is the **query of the forced first search**, the scope hint in the system prompt, the recall query and the document-retrieval query |
| `needsRecent` | the answer changes over time. Searches get `time_range=month` |
| `needsSources` | whether the answer turns on citable specifics or on advice where a mistake could cause harm. **Recorded for analysis only** while `ALWAYS_SEARCH` is on; it gated the `stable-knowledge` mode before 2026-09-26 |
| `intent` | e.g. `news`. Adds an intent-specific SearXNG category or engine |
| `expandedQueries` | up to 3 alternative phrasings. **Expansion is fused into this call** |

The prompt is chosen per call by `getClassifierSystemPrompt`
(`lib/agents/query-classifier.ts:296-302`): `CLASSIFIER_SYSTEM_PROMPT` (`:234`, the
"every question searches" definition above) while `ALWAYS_SEARCH` is on, and the old prompt, kept
verbatim as `LEGACY_CLASSIFIER_SYSTEM_PROMPT` (`:165`), when it is `off`. The legacy prompt set
`skipSearch` for "the conversation already answers this" and steered `needsSources` towards
`false` for well-known concepts. The new prompt's examples deliberately avoid the questions used
for the lab browser check, so that check measures generalisation, not a memorised example.

The explicit memory-instruction skip (`:241`, with examples 17–19) keeps "remember that …",
"forget …" and "update my …" on a `direct` turn, where the `remember` tool writes a
**confirmed** memory; on a `research` turn it would write an unconfirmed candidate and run a
meaningless forced search first. A memory instruction that also asks a question ("remember I'm
vegetarian — what can I cook tonight?") is a question and searches. On `deepseek-v4-pro:cloud`
the legacy prompt and the first ALWAYS_SEARCH prompt already skipped these messages (the model
read past a skip list that did not name them); the rule makes the behaviour explicit, so it does
not depend on the classifier model.

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

`resolveTurnMode` (`lib/agents/researcher.ts:155-189`) maps the classifier's
output to one of three configurations. Which ones are reachable depends on
`ALWAYS_SEARCH` (`lib/agents/always-search.ts:32-36`; default on, only the literal
`off` disables it, read per call):

| Turn mode | Condition | Prompt | Tools advertised | `maxSteps` |
|---|---|---|---|---|
| `direct` | `skipSearch` | `DIRECT_ANSWER_PROMPT` (answer from the conversation) | escape hatch: search, fetch, calculate, weather, remember, recall | 10 |
| `stable-knowledge` | only with `ALWAYS_SEARCH=off`: `!needsSources && !needsRecent` | `STABLE_KNOWLEDGE_PROMPT` (answer from knowledge) | calculate, weather, remember, recall. **`search` is not advertised** | 10 |
| `research` | everything else (with `ALWAYS_SEARCH` on: every turn that is not `direct`) | the search mode's prompt, plus the forced-search addendum when step 0 is forced | per mode (see [Search pipeline](/search/pipeline#the-three-search-modes)) | 20 / 50 / 100 |

**Every question searches (since 2026-09-26).** With `ALWAYS_SEARCH` on, step 0
of a `research` turn is a **forced web search**: `prepareStep` hands that step to
a synthetic model (`createForcedSearchModel`, `lib/agents/always-search.ts:264`)
whose only output is one `search` call on `standaloneQuery` (URLs removed, at most
400 characters). The real `search` tool runs it with every wrapper, and the
user's model answers from step 1. `toolChoice` could not do this: the Ollama
provider ignores it. The mechanism, evidence and cost are in
[D37](/history/decisions#d37-always-search-every-question). A turn whose resolved
**The exception: the user supplied the source.** A `research` turn is **not**
forced when the latest message carries a URL (typed inline or pasted as a link
chip), an attachment with no typed text, or an attachment whose text only points
at it ("what is this", "summarise this file"). `detectUserSuppliedSource`
(`lib/agents/always-search.ts:118-137`) decides this from the message's parts,
because the classifier sees text only and does not run on the bypass paths. The
turn keeps its mode prompt and advertised tools, so the model reads the page with
`fetch` (or the injected attached source) and may still search; it just is not
made to search first. A URL turn is therefore exactly what it was before
2026-09-26. The attachment check (`isAttachmentReferenceOnly`,
`always-search.ts:183-193`) is deliberately conservative: a closed English word
list of question frames, pronouns, verbs that act on the attachment ("read",
"describe", "summarise") and medium nouns ("picture", "file", "pdf"), capped at 10
words. Any subject word ("what is this **plant**", "is this **mushroom** safe")
keeps the forced search, because a wrongly skipped search would break "every
question searches" while a wrongly kept one costs only a round. A turn whose
resolved query is empty once URLs are removed is also not forced.

**Why `stable-knowledge` existed, and why it is off.** A blind pairwise judge over
46 turns found that when Ask searched a settled question and the comparison system
did not, the comparison won 13–2: searching settled questions padded answers with
citations to introductory pages. A separate evaluation found that forcing
retrieval on the turns the gate suppressed scored 1W-7L-3T (operational
questions) and 1W-8L-1T (concept questions). The owner reversed the gate on
2026-09-26 after prod turns showed it answering named-product, policy, repair and
safety questions from memory (one recommended acetone for melted plastic on an
oven tray with no fire warning). A small blind A/B on the lab scored forced search
2W-1L-3T. See [D3](/history/decisions#d3-needssources-skip-retrieval-for-stable-knowledge)
and [D37](/history/decisions#d37-always-search-every-question). **Source counts
and gate rates describe what Ask did. They do not show whether the answer was
better.** Judge the answers before deciding a gate is right or wrong.

The classifier is **bypassed** when the message contains a URL, when the user hits
Retry, and in **speed mode** (`create-chat-stream-response.ts:282-318`). A
bypassed turn gets a fixed classification: `skipSearch:false`,
`needsSources:true`, `standaloneQuery` = the raw message, no expansions. A
classifier failure, empty reply or soft-budget timeout falls back to the same
values (`query-classifier.ts:363-378`). All of these are therefore `research`
turns. A URL turn is not forced (above). Retry, speed and classifier-failure
turns are forced on the raw message minus its URLs, which is what those paths
searched before, now guaranteed, unless the message carries an attachment it
only points at. Guests (`create-ephemeral-chat-stream-response.ts:92-107`)
bypass only for a URL; they run the classifier in speed mode and have no Retry.

### Classifier model, host, and budget

| Setting | Value | Notes |
|---|---|---|
| `CLASSIFIER_MODEL_ID` | `deepseek-v4-pro:cloud` (all envs) | code default is `granite4.2:8b`, but every env overrides it. Chosen 2026-09-04 in a bake-off of the 7 roster models: the fastest usable one (~0.9s isolated, ~1.1–1.3s in a real turn), made the same search/no-search decisions as granite, and rewrote follow-ups better. `glm-5.3-flash` spiked to ~10s on follow-ups. kimi-k3 and minimax returned empty or failed tool calls |
| Host | `CLASSIFIER_OLLAMA_BASE_URL`, falling back to `OLLAMA_BASE_URL` | NightFuryX `http://192.168.50.17:11434` in every env: prod from `.env`, staging and lab hardcoded in their overlays (they pointed at MiniNightFury's `.231:11434` until 2026-09-23, `20f59696`) |
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

::: warning `targeted` is no longer selective
Since 2026-09-26 `ALWAYS_SEARCH` makes every turn except the few `direct` ones a
`research` turn. `targeted` would therefore turn reasoning on for almost every
turn and pay the +14s nearly everywhere. Rethink its trigger before trying it
again ([D18](/history/decisions#d18-targeted-reasoning-reasoning-only-on-research-turns),
[D37](/history/decisions#d37-always-search-every-question)). `ANSWER_THINK` is
unset on all three envs.
:::

## Narration and chain-of-thought leak handling

"Narration" is the model talking about its process in visible text instead of in
reasoning parts: "Let me search for…", "I have comprehensive data now…", or the same in
another language ("Tôi cần đọc trang này…", "让我搜索一下…"). Every mode's prompt requires
the final answer to start with a `## ` heading (the "first-token rule"), and all of the
cleanup below anchors on that rule. Each leak shape is handled at a different layer:

| Leak shape | Live (while streaming) | At persist (`stripNarrationFromMessage`) |
|---|---|---|
| **Reasoning parts** (the model's native thinking) | shown as a "Thinking…" pill; raw text not rendered | stored unchanged; the display is gated by `NEXT_PUBLIC_SHOW_REASONING` |
| **Inter-step narration**: a separate text part, then a tool call, then later the answer | **hidden by the renderer**: while streaming, a text part renders as answer text only if it starts with a markdown heading (`components/render-message.tsx:237`); after the stream completes, only the last text part renders | **dropped**, in any language (the rules are below) |
| **Fused preamble after a line break**: narration, then `\n## ` in the same part | **stripped by the stream transform** `smoothAndStripNarration()` (`lib/streaming/helpers/smooth-and-strip-narration.ts:57`) when it matches the English rules | stripped again by `stripNarrationPreamble` (English rules only) |
| **Glued preamble**: `## ` directly after a sentence or a stray tag, e.g. `…câu trả lời.## ` or `…chương.</think>## ` | not stripped by the transform; the renderer's cleaned view cuts it once the answer after the seam outweighs it (until then the part does not start with a heading, so it stays hidden) | **cut**, in any language (`stripGluedHeadingPreamble`) |

Since 2026-09-28 the persist-time cleanup is also applied **at read time**, everywhere the
text is read (table below). A message saved before a rule existed therefore displays clean
without a database rewrite.

### How the stream transform decides

`smoothAndStripNarration()` is passed as `experimental_transform` to
`researchAgent.stream`. Its decisions come from `strip-narration-preamble.ts`:

- It buffers the start of every text part. If a `## ` heading appears at
  offset 0, it flushes immediately. If a heading appears later (at a line start, after a
  `<channel|>` marker or after a closing think tag, `findHeadingMatch`, `:160`), it strips
  the text before the heading when that text **starts with a known narration
  phrase** (`NARRATION_STARTERS`, `:18`, which includes the round-cap and
  "source inventory" phrases). There is also a **structural backstop**
  (`shouldStripPreamble`, `:115`): a preamble longer than 1000 characters that shows a
  strong reasoning signal (a stray `<think>`/`</think>` tag, or ≥3 first-person
  research sentences) is stripped even without a matching phrase. The
  thresholds come from measurement: real introductions were ≤~700 characters,
  and the smallest real leak was ~8KB.
- If no heading has appeared, it keeps buffering only while the text still
  looks like narration, up to `NARRATION_HARD_MAX` (16000 characters, sized for
  the largest observed ~15KB dump). A normal answer with no heading is released
  after ~64 characters.
- `stripStrayThinkTags` (`:204`) is **not** part of the live transform: it runs at persist
  and read time, inside `stripNarrationPreamble`. It removes a leading `<think>` block, or a
  stray `</think>` whose preceding text reads like reasoning (`looksLikeReasoningPrefix`,
  `:175`), and leaves the tag alone when an answer genuinely mentions it.

Apart from the think-tag signal on a preamble over 1000 characters, every one of these
decisions is anchored on English wording. The transform was **not**
changed on 2026-09-28: a live stripper has to decide from a prefix, and an aggressive one
once dropped real answers ([D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live)).
The language-agnostic rules run at persist and at read time instead.

### Language-agnostic structural rules (2026-09-28) {#narration-structural-rules}

Before 2026-09-28 a status note in Vietnamese or Chinese, or in English with unlisted
wording ("Let me try…", "One more check…"), was saved: the persist-time drop needed
`looksLikeNarrationStart` to match an English starter. A preamble in front of the answer
leaked for two reasons. The cut needed an English decider (`looksLikeReasoningPrefix` /
`shouldStripPreamble`) even when `findHeadingMatch` had found `</think>## `. And a heading
glued straight after a sentence, with no tag and no newline, was never found at all. The
markdown sanitizer drops the unknown `</think>` element, so users saw "…chương.## " followed
by the answer. The fix keys off the **shape** of the leak instead of its wording. Each rule
fires only when several independent signals agree, and both run **after** the English rules,
so English behaviour is unchanged ([D20 addendum](/history/decisions#addendum-2026-09-28-language-agnostic-structural-rules)).

**Rule 1: inter-step chatter.** In `stripNarrationFromMessage`
(`lib/streaming/helpers/strip-narration-from-message.ts:111-121`) a non-final text part is
dropped when either:

- it starts (or has a sentence that starts) with an English narration phrase, at any
  length (the older rule); or
- all of these hold:
  - its next significant part (skipping `step-start`, reasoning, `data-*` and empty
    text) is a **tool call** (`isFollowedByToolCall`, `:34`), so it was written before
    the tool ran and cannot be an answer grounded in that tool's result;
  - it is short, unstructured prose (`looksLikeInterStepChatter`,
    `strip-narration-preamble.ts:341`): at most 600 characters (`INTER_STEP_CHATTER_MAX`,
    `:331`), and no heading, table, code fence, list of 3 or more items, or citation marker;
  - it is **not longer than the final answer** (`strip-narration-from-message.ts:93-96`).
    This guard keeps the shape
    "short real reply → side-effect tool (`remember`, `generateImage`) → shorter sign-off".

*Why 600:* in stored history (831 assistant messages across prod and the lab), text written
right before a tool call was 110–180 characters at the median and 250–460 at p90; every
Vietnamese and Chinese one was 67–247. 600 covers the chatter with headroom and stays below
the ~700 characters D20 measured for genuine intro prose. A structured partial answer
written before a tool call (a `## Key Findings` block) is kept by the structure checks.

**Rule 2: the glued seam.** `findGluedHeadingSeam` (`strip-narration-preamble.ts:285`)
finds the first `## ` outside code (fences and inline code are blanked first, `maskCode`,
`:257`) whose preceding character is not whitespace, not `#` (so `###` is never split) and
not `\` (an escaped hash). A `## ` glued to text on the same line does not even render as a
heading, so it is where narration ends and the answer begins. `stripGluedHeadingPreamble`
(`:306`) cuts the prefix only when it has no heading and no citation marker of its own, is at
most 2000 characters (`GLUED_PREAMBLE_MAX`, `:275`) and is shorter than what follows the seam.
A proper `\n\n## ` heading after an intro paragraph is never a seam.

*Why 2000:* the three Vietnamese preambles on prod were 613, 653 and 673 characters (6–9 % of
their answers), and a stray glyph glued in front of a heading ("និ## How to…") was 2. Real
reasoning dumps start around 8 KB and carry English starters, which the phrase rules already
handle. 2000 is about 3× the largest non-English preamble seen while staying far below the
dump range.

`stripNarrationPreamble` (`:357`) is the per-part entry point: the English phrase and
think-tag rules first (`stripPhraseAnchoredPreamble`, `:362`), then the glued-seam cut on
what remains. Both rules are pure and idempotent.

### Read time: one cleanup wherever text is read {#narration-read-time}

The same functions run wherever an answer's text is used, so what the user sees, what the
model is fed back and what search finds agree:

| Reader | Code | What runs |
|---|---|---|
| Chat view (stored and streaming messages) | `components/render-message.tsx:158` | `narrationCleanView` |
| "Research still running" indicator (`endsInActiveResearch`) | `components/render-message.tsx:54` | `narrationCleanView` |
| Copy shortcut (Mod+Shift+C) | `components/chat.tsx:686` | `narrationCleanView` |
| Copy and Save in the answer's action row | `components/answer-section.tsx:320` | receives the rendered (cleaned) answer text |
| History fed to the classifier and the model | `lib/streaming/create-chat-stream-response.ts:258` | `stripNarrationFromMessages` |
| Guest history (sent by the browser) | `lib/streaming/create-ephemeral-chat-stream-response.ts:62` | `stripNarrationFromMessages` |
| Spoken gist (voice turns) | `lib/streaming/create-chat-stream-response.ts:959` | `stripNarrationPreamble` on the final step's text |
| Recall indexing and the recall backfill | `lib/memory/extract-indexable-text.ts:96-103` | `stripNarrationPreamble` on each assistant text part |
| Sidebar and Library keyword-search snippets | `lib/db/keyword-search.ts:76-79` | `stripNarrationPreamble` on an assistant snippet |
| Persist | `lib/streaming/create-chat-stream-response.ts:1072`, `lib/streaming/helpers/persist-stream-results.ts:39` | `stripNarrationFromMessage` |

`narrationCleanView` (`strip-narration-from-message.ts:156`) is `stripNarrationFromMessage`
memoized in a `WeakMap` keyed by the message object (`:147`). That is safe because
`@ai-sdk/react` `structuredClone()`s a message into state on every streamed update: a changed
message is a new object and an unchanged one keeps its identity. The chat re-renders every
message on each streamed delta, so the memo keeps that cost proportional to the messages that
changed.

Recall indexing never needed the inter-step rule: `extractIndexableText` keeps only the text
after the last tool call ([memory & recall](/knowledge/memory-recall)). It did index a glued
preamble, because that preamble sits inside the final answer part.

### Limits to know about

- **A final answer with fused narration and no `## ` heading is left intact.**
  With no heading there is nothing safe to cut at, and removing real content
  would be worse. It is rare because every mode's prompt requires the answer to
  start with a heading.
- **Non-English narration before a proper `\n\n## ` heading is not cut.** Only the English
  phrase rules apply there; cutting an unrecognised intro paragraph risks eating real prose.
  The 2026-09-28 scan found no such case.
- **Long or structured status notes are kept.** A non-final part over 600 characters, or with
  a heading, table, code fence, 3+ item list or citation, or longer than the final answer, is
  not dropped unless it starts with an English phrase. The review found 6 such narration parts
  in stored history, kept by design ([known issues](/history/known-issues#narration-the-structural-rules-keep-by-design)).
- **A glued answer appears late while streaming.** Until the text after the seam is longer
  than the preamble (a few hundred characters), the part neither starts with a heading nor
  qualifies for the cut, so nothing is shown; then the answer appears from its heading. The
  preamble never flashes ([known issues](/history/known-issues#an-answer-with-a-glued-preamble-appears-late-while-streaming)).
- **The English phrase list is still model-specific.** Its families were collected from
  specific models (deepseek-v4-flash, glm-5.3-flash). A new English phrasing in front of a
  proper heading needs its pattern in `NARRATION_STARTERS`, with a test in
  `lib/streaming/helpers/__tests__`. Status notes before a tool call and glued preambles need
  no pattern.
- **Live and persisted views can differ.** A leak that gets past the live
  transform (for example, glm narration that doesn't match a starter pattern
  and doesn't meet the structural threshold) can briefly appear while
  streaming. Since 2026-09-28 the renderer also applies the persist-time rules to the
  streaming message, so anything those rules catch is hidden live as well. *(Reported for
  glm. The 2026-09-19 A/B saw 0 of 12 leaks on the current roster.)*
- **Stored rows are not rewritten.** The display, copy, history and snippets are clean, but
  the rows keep what was saved: keyword search still **matches** words that only occur in a
  stored status note (and shows that note as the snippet), and recall chunks indexed before
  2026-09-28 keep a glued preamble until the message is re-indexed. A backfill is an open
  decision ([known issues](/history/known-issues#old-answers-with-leaked-reasoning-stay-leaked)).
- The round-cap notice itself tells the model not to restate the limit or
  describe its sources, and to start with the heading (`lib/tools/search.ts:420`).

## Follow-up re-search prompt nudge

Every research prompt has an exception, "clarifying your own prior answer",
under which the model answers from context without searching. On 2026-09-19 a
clause was added after it, in the speed prompt and in `getApproachStrategy`
(which balanced and quality inherit)
(`lib/agents/prompts/search-mode-prompts.ts:150,273`):

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
  should lead to an extra search, not an ungrounded answer. (That mode is only
  reachable with `ALWAYS_SEARCH=off`.)
- **To force a tool call, override the step's model, not `toolChoice`.** The
  forced first search (`ALWAYS_SEARCH`) returns `model: <synthetic model>` from
  `prepareStep` for step 0; the AI SDK resolves that itself, so the Ollama
  provider cannot drop it (`lib/agents/researcher.ts:1039-1041`).
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
