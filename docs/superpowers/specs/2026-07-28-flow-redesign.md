# Prompt→answer flow redesign — experiment and findings

**Status:** measured, not shipped. Lives on the lab instance (`:3742`) behind
`FLOW_VARIANT`. Prod and staging are untouched.

## Why

The existing flow is a pipeline with a mandatory first stage. A classifier
decides `skipSearch` before the model sees anything; the system prompt then
forbids the model from revisiting that judgement —

> "For ALL other messages — questions, follow-ups, continuations, casual,
> anything — you MUST run at least one search before answering."

— and `resolveEffectiveDepth` discards the model's own `search_depth` argument.
Measured on 25 prod turns: every genuinely new question searched, however
trivial, and the only zero-tool turns were "summarise what we said" follow-ups.

## Setup

Third isolated instance, own Postgres/Redis/SearXNG, retrieval reduced to
**SearXNG alone** (every other source switched off and verified: 0 calls to
degoog/Tavily/Brave/LangSearch/Ollama-search). Model pinned to
`kimi-k2.6:cloud`, `SEARXNG_CRAWL_MULTIPLIER=2`.

Absolute latencies therefore do **not** match prod. Arms are compared against
each other only.

**96 turns** = 6 arms × 16 probes, run sequentially so latency is not distorted
by contention. Probes are hand-built with `expectSearch` labels, separate from
the mined `questions.json` — every mined question warrants searching, so that
set cannot test the retrieval *decision*.

## Arms

| id | control flow |
|---|---|
| `baseline` | unchanged; the control, deliberately a no-op |
| `adaptive` | no mandatory search; the model decides |
| `router` | the classifier decides, enforced in code |
| `react-gap` | assess → act → reassess, driven by named gaps |
| `plan-execute` | forced plan artifact, then execution |
| `wide-once` | one forced search, then answer with no tools |

`adaptive` and `router` are deliberately opposed, because the literature says
the obvious approach fails: prompting a model to decide whether it needs to
search was worth **+0.03 points** over always retrieving (SKR, EMNLP 2023),
verbalized confidence has **AUROC 0.63** (Xiong et al.), and suppression
prompts cut tool calls *indiscriminately* — **−34.7 accuracy points on hard
tasks** (When2Tool).

## Results

| arm | median | decisions | quality vs baseline | cites (searched turns) |
|---|---|---|---|---|
| baseline | 71.2s | 11/16 | — | 9/14 (64%) |
| **adaptive** | **29.4s** | **15/16** | **+2** (6W 4L 6T) | 3/8 (38%) |
| router | 74.5s | 10/16 | −4 | 5/13 (38%) |
| react-gap | 14.4s | 11/16 | +3 (7W 4L 4T) | 1/4 (25%) |
| plan-execute | 62.2s | 15/16 | +1 | 6/10 (60%) |
| wide-once | 42.5s | 12/16 | −6 | 7/9 (78%) |

Quality is blind pairwise, judged in **both orderings**, a win requiring the
same answer to win twice — LLM judges prefer whichever answer they see first,
and without that control the bias is indistinguishable from signal. Judged by
`glm-5.2`, not the model under test.

Split by question type (median seconds):

| arm | should NOT search | should search |
|---|---|---|
| baseline | 32.3s | 108.2s |
| **adaptive** | **9.7s** | **71.2s** |
| react-gap | 11.8s | 71.0s |
| plan-execute | 18.2s | 95.7s |

## Recommendation: `adaptive`

It is **2.4× faster overall**, faster on *both* question types, best on
decisions (15/16, zero over-searches), and does not regress judged quality.
Uniquely among the arms it uses **no per-step overrides** — its behaviour rests
entirely on a system prompt, which demonstrably applies (see caveats).

`react-gap` is faster still (14.4s) and judged best (+3), but it
**under-searched 5 times**. That is the dangerous error: it produces
confidently stale answers a user cannot detect, whereas over-searching only
costs time. Its heading compliance was also 9/16.

## Caveats, in order of how much they should worry you

**1. Per-step overrides are unreliable on this stack.** `wide-once` reached 4
tool calls with `activeTools: []` set from step 1 — impossible had the override
landed. A forced `todoWrite` fired on a complex question and not a trivial one.
So `react-gap`, `plan-execute`, `wide-once` and `router` were **not fully
testing what they were designed to test**. The leading arm is the one least
affected, which is fortunate rather than by design.

**2. `adaptive` cites less on searched turns (38% vs 64%) and I could not find
out why.** Two hypotheses tested, both failed: strengthening the citation rules
made it 25% (worse), and "it retrieves less" is contradicted by the data —
answers with ≤3 tool calls cited 67% of the time versus 38% for ≥6. This is
unresolved. What *is* established is that fabrication is **0/8** on turns that
never searched: the model does not invent anchors when answering from
knowledge, which is the failure the grounding contract exists to prevent.

**3. `expectSearch` labels are my judgement, not ground truth.** The one
`adaptive` "miss" — answering *"What is systemd-resolved and why do people
disable it?"* from knowledge — is arguably a better call than my label.

**4. n=1 per probe per arm.** No repeats. Given how often single measurements
misled during this work, treat rankings as directional.

**5. `adaptive` differs from baseline in two ways**, not one: it drops the
search mandate *and* has leaner search guidance. The latency gain cannot be
attributed solely to the retrieval decision.

## Also built

`lib/streaming/flow-progress.ts` generates research-panel status lines
**server-side** from facts already known (step number, which tools ran) and
emits them as `reasoning` parts, which the panel already renders. No model
tokens, no latency, and they cannot contradict the answer. Verified in the
browser: *"Reviewing 2 searches, 1 page read"* → *"Reviewing 5 searches, 3
pages read"*.

This is the alternative to asking the model to narrate — which was removed
earlier for good reason, since narration emitted as `text` lands in the answer
area and is then superseded.

## If this ships

`FLOW_VARIANT=adaptive` on staging first, with citation rate watched as the
regression metric, then a prod A/B against baseline on the mined question set
using the existing pairwise judge. The unexplained citation gap should be
resolved or accepted deliberately before prod.
