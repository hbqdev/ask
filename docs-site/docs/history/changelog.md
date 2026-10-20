---
title: Changelog
---

# Changelog

A condensed timeline of significant changes, newest first. Commit hashes are the **prod (`dev`)**
commits unless marked *lab*. Staging (`admin-feature`) carries the same change as a
cherry-pick. Every entry below was shipped to prod unless it says otherwise. For the reasoning
behind a change, follow the **D-number** to [decisions](/history/decisions). For what is still
open, see [known issues](/history/known-issues).

::: tip How to get the full detail
`git log dev --since=<date> --until=<date>`. Most commits carry a long body with the measurement
behind the change. Lab-first work lives on `flow-design`. `git cherry-pick -x` leaves a
`(cherry picked from commit …)` trailer that points back to the lab original.
:::

## 2026-10 — October

- **10-19** — Model roster: `minimax-m3.1-flash:cloud`, `beam:cloud` and `muse-spark-open:cloud`
  **added** in all three envs (config only, no code change). Prod via the Model Manager (backup
  `.env.bak.2026-10-20T05-11-17-578Z`); staging and lab via `.env` plus `--force-recreate --no-deps ask`.
  Each passed a real tool-calling, thinking and vision probe and one lab browser turn. See
  [models](/search/models-reasoning).
- **10-17** — Local small-model jobs (titles, memory extraction, the expander fallback) move from
  `granite4.2:8b` to **`gemma4:12b`** on Serenity's P5000 (`7778ea2e`). A bake-off on Ask's real
  functions found that granite invented "Prefers concise answers" memories and missed durable facts.
  gemma4:12b caught 12/12 cases with none invented and gave the most varied on-topic expansions.
  granite and the other candidates were deleted from .171. The boot warm-up now loads gemma4 (`fleet-boot/deploy.sh`).
  The classifier is unchanged (`deepseek-v4-pro:cloud` everywhere); only its unused local fallback default moved.
- **10-17** — Read-aloud no longer speaks the related-questions ```` ```spec ```` JSON block or
  `---` rules (`9dc2fbc9`). `firstSentences` no longer splits on decimals such as "1.6" (`7214c1d3`).

**A near-duplicate search skip with no false skips on labelled pairs, citation evidence on every
turn, shortened citation ids that resolve, a planning draft cut from the answer, and a search
cap that stops a model that ignores it**

- **10-07** — **`search` withdrawn as soon as the budget is spent; refused calls shown as one
  line** (lab `a623c905` + `88aa5c5b`; staging `31fac5dd` + `4b43ac71`; prod `8a48c04c` + `9400412c`;
  [D45 addendum](/history/decisions#addendum-2026-10-07-search-withdrawn-as-soon-as-the-budget-is-spent)).
  - Trigger: on a later turn of prod chat `cznh8gc1gz41vq2lwjb560br`, with the three stages
    below shipped, mistral-large-4 was still offered `search` on the step after its budget ran
    out and made 4 refused calls there, then 4 on the withdrawn step and 4 on the answer-only
    step (6 steps, 17 `search` calls of which 5 ran, 148k prompt tokens, 104 s). Stage 1 fired
    only after a refusal, so every capped turn spent a step discovering the cap.
  - The researcher now shares the search tool's per-turn round counter (`SearchRoundCounter`,
    new `lib/tools/search-rounds.ts`, which also holds the budget and the cap notice, re-exported
    from `search.ts`). `search` is withdrawn on the first step that starts with the budget spent
    (a refused result stays the fallback), and stages 2 and 3 count from that step. A withdrawn
    step that is not answer-only gets a note saying why (`buildSearchWithdrawnNote`; balanced:
    answer now; quality: fetching found URLs still allowed).
  - Log: `[search-cap] search withdrawn at step N after the round cap (rounds U/B, chat=…)`, which
    can now appear with no refused search; U can exceed B after a parallel overshoot.
  - Lab replay of 60 stored capped turns: 49 withdraw a step earlier, and that step held 72 of
    their 115 refused calls (assuming the model behaves the same without `search`: plausible,
    not measured). One lab turn after the change: withdrawn at step 2 (`rounds 5/3`), mistral
    called `search` anyway (4 refused), answer-only at step 3: 4 steps, 9 tool calls, 140k
    prompt tokens, 121 s.
  - UI: refused `search`/`fetch` calls fold into one muted line at the first refusal, "Search
    limit reached — N extra searches skipped" (or "Research limit reached — …"); the user had
    counted 18 "searches" on a turn where 5 ran. "Completed N steps" still counts every call.
    `lib/utils/skipped-tool-calls.ts`, `components/skipped-tool-calls-section.tsx`.
    → [pipeline › round cap](/search/pipeline#round-cap), [telemetry](/operations/telemetry#the-lines), [frontend › refused calls](/request-lifecycle/frontend#refused-calls-fold-into-one-line)
- **10-07** — **After the search round cap, `search` is withdrawn, then the turn is made to
  answer** (lab `6d17dfa5` + `4144072f` + `52d53a9f`; staging `b65f95b8` + `9cb265f0` +
  `ab0e9ca1`; prod `ef840d59` + `e33827d8` + `84c6aaac`;
  [D45](/history/decisions#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps)).
  - Trigger: prod chat `cznh8gc1gz41vq2lwjb560br` (mistral-large-4, balanced, cap 3) had 80
    `search` calls refused by the cap over about 30 steps: 36 steps, 89 tool calls, 2,066,500
    prompt tokens, 259 s, with `search` still advertised throughout. Every other model in stored
    history stopped after at most 5 refusals.
  - New `lib/agents/search-cap.ts`, applied in `prepareStep` between the flow variant and the
    time deadline. Stage 1: from the step after the first refusal, `search` is no longer
    offered. Stage 2 (every mode): a `search` call after that makes every remaining step
    answer-only (no tools, the deadline's "TIME TO ANSWER" note, calls refused in `execute`).
    Stage 3 (modes without a fetch budget: speed and balanced): the same after
    `POST_CAP_TOOL_STEPS_MAX` (default 4) tool-using steps past the cap. `answerNowOverrides`
    is factored out of `applyAnswerDeadline`.
  - Lab, one turn per build: stage 1 cut the turn to 9 steps, 0.40M prompt tokens, 163 s, but
    the model still called `search` on 4 later steps; with stages 1–2 it fetched instead (13
    single fetches, 17 steps, 1.21M, 268 s); with all three it answered on its own at step 4
    after the withdrawal (5 steps, 221k, 162 s, 50 citations, 0 unresolved). No stored turn of a
    currently listed model is affected; quality is unchanged.
  - Logs: `[search-cap] search withdrawn at step N …`, `… model kept calling search after
    withdrawal …`, `… N tool steps after the round cap …`, `… refused <tool> call on an
    answer-now step …`.
  - Not fixed: parallel calls in one step can overshoot the budget (5 searches ran on that
    turn with a budget of 3).
    → [pipeline › round cap](/search/pipeline#round-cap), [chat turn › caps](/request-lifecycle/chat-turn#_10-the-tool-loop-and-its-caps), [telemetry](/operations/telemetry#the-lines), [models & reasoning › `activeTools`](/search/models-reasoning#activetools-does-not-block-a-tool), [known issue (open)](/history/known-issues#parallel-search-calls-can-overshoot-the-round-cap)
- **10-06** — **Shortened and one-character-off citation ids resolve; a planning draft in front
  of a glued restart is cut** (lab `72f2d2cb` + `0c42230b`; staging `ced112b6` + `5bf81ec0`;
  prod `c0cf276e` + `bfb71369`; the 4 affected prod answers backfilled 2026-10-07;
  [D44](/history/decisions#d44-shortened-and-one-character-off-citation-ids-resolve),
  [D20 › Decision 7](/history/decisions#decision-7-a-planning-draft-in-front-of-a-glued-restart-is-cut)).
  - `resolveCitationAnchor` gains two repairs, both counted as `citations_recovered`:
    `id-prefix` (at least 8 hex/dash characters, after trimming a trailing `...` / `…` and
    dashes, that start exactly one of the message's citable call ids) and `id-typo` (one
    substitution, insertion or deletion from exactly one UUID-shaped call id). Trigger:
    glm-5.3-flash wrote `[3](#17d98f5d)` / `[1](#71cee5ba...)`, and 48 of its 121 prod citations
    rendered as nothing. Replay over every stored answer: unresolved prod 750 → 700, staging
    1048 → 1044, lab 323 → 289; 0 previously rendered citations changed.
  - The recovered glm anchors sat in planning text leaked in front of the answer, so the draft
    cut ships with the repair. `stripDraftBeforeRestart`, inside `stripNarrationPreamble`, cuts
    at the first glued `## ` after the prompt's internal vocabulary ("toolCallIds", "cite
    strings", "spec block", elided anchors) when the kept answer has at least 400 prose
    characters and either restates an outline heading or, with no outline, the notes use two
    vocabulary families and cite nothing. Replay over every stored assistant text part (prod
    495, staging 522, lab 425): exactly the 4 leaked prod answers cut (one glm-5.3-flash chat,
    drafts 2.0–15.1 KB), 0 elsewhere.
  - The live transform is unchanged, so an outline draft is shown while the answer streams
    until the answer after the seam qualifies; the render view then drops it.
    → [telemetry](/operations/telemetry#tokens-citations-and-totals), [frontend › Citations](/request-lifecycle/frontend#citations), [models & reasoning › planning draft](/search/models-reasoning#narration-planning-draft), [known issue](/history/known-issues#a-planning-draft-shows-while-the-answer-streams)
- **10-01** — **Near-duplicate search skip only for true repeats** (prod `0ca3c4ed`; lab
  `30741f18`; staging `4da6f664`;
  [D42](/history/decisions#d42-near-duplicate-search-skip-only-for-true-repeats)).
  - New module `lib/tools/search/query-dedup.ts`. A later search of the turn (same search mode)
    is skipped only when it is an **exact** repeat (equal once case, punctuation and quotes are
    ignored; no embedding needed, so it works with the embedder down) or a **near** repeat:
    cosine ≥ `SEARCH_DEDUP_THRESHOLD` (default 0.92 → **0.90**) and the later query adds no
    content word, drops no number other than a year and does not reverse the word order around
    to/from/than.
  - Evidence: on 446 real query pairs labelled blind (kappa 0.916), the old cosine-only rule made
    332 skips, 137 of them not repeats (precision 0.587, recall 0.796); the new rule makes 61, all
    repeats (precision 1.000, recall 0.249). Of the 76 skips stored before the change, 34 had
    dropped a real search. Trade-off: more true repeats run, each using a search round.
  - Logs: a skip line ends with `(exact)` or `(near, cos=…)`; a kept search with cosine ≥ 0.92
    logs `[search-dedup] kept … but adds: … / drops: … / reverses word order`.
  - `SEARCH_DEDUP_TOKEN_GUARD=off` restores the old rule (cosine ≥ 0.92 alone); an empty or
    invalid threshold now falls back to the default.
    → [pipeline › dedup](/search/pipeline#round-cap), [known issue (fixed)](/history/known-issues#near-duplicate-dedup-drops-templated-queries)
- **10-01** — **Citation evidence telemetry** (prod `0b0f1af8`; lab `cad59b06`; staging
  `890f9f7c`; [D43](/history/decisions#d43-snippet-citations-measured-not-re-pointed)).
  - Evidence-only helpers in `lib/utils/citation.ts` (`SNIPPET_MAX_CHARS`, `samePageKey`,
    `findPageTextForUrl`, `auditCitationEvidence`) and three new `[latency]` fields:
    `citations_snippet`, `citations_snippet_read`, `fetch_pages_uncited`. No rendering, hover or
    prompt change.
  - Diagnosis of the 71 % unsupported snippet citations (68 re-judged): 28 % right for the
    reader, 32 % the wrong page, 40 % supported by nothing retrieved (mostly assembled numbers and
    table rows). Same-URL fetches, the first theory, account for almost none (prod: 1 of 133).
  - Measured and rejected: repeated in-page cite markers (citations moved onto pages, support did
    not improve, 2 of 17 answers lost every anchor) and automatic re-pointing (would move 9 of 16
    correct citations to unsupporting pages).
    → [telemetry](/operations/telemetry#tokens-citations-and-totals), [frontend › Citation evidence](/request-lifecycle/frontend#citation-evidence), [known issue (open)](/history/known-issues#citations-point-at-a-snippet-instead-of-the-fetched-page)

## 2026-09 — September

**Streaming lifecycle, mobile QA, the end of the latency campaign, a fleet clean-up, every
question searches, citations the model copies instead of counting, search that survives a
Redis restart, narration cleanup in any language (and in storage), a WSL boot fix, and quality
research that reads pages past the search cap**

- **09-30** — **Quality mode reads pages past the search cap** (prod `b26acdb5` + `ed465eb8`;
  lab `6f651230` + `175020c3`; staging `c9251b7e` + `77d1cdd2`;
  [D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap)).
  - A search skipped as a near-duplicate no longer uses a round of the cap.
  - In quality mode the round-cap notice stops the searching only: the model may still `fetch`
    URLs this turn's searches returned. A new per-turn fetch cap bounds that:
    `FETCH_ROUNDS_MAX_QUALITY` (8 calls); other modes have none unless `FETCH_ROUNDS_MAX` is set.
    Telemetry: `fetch_allowed` on `kind:"round-cap"` lines and a `[fetch] fetch cap reached`
    stdout line.
  - `SEARCH_ROUNDS_MAX_QUALITY` default 5 → 10.
  - Evidence (lab, kimi-k2.6, recall and memory off): cap 15 beat cap 5 because it fetched
    34 pages against 1; with fetching past the cap allowed, cap 10 and cap 5 measured the same
    (q1–q3 209 s vs 203 s) and cap 10 tied the stored cap-15 answers.
  - An answer-step citation reminder (`lib/agents/citation-reminder.ts`,
    `lib/agents/answer-step-reminder.ts`) was built and measured, and ships **off**
    (`CITATION_REMINDER=on` enables it): running-count numbering still appeared in 2 of 3 armed
    long turns, and each re-run cost 58–104k extra prompt tokens.
  - The prod and staging ports call `getModel` with two arguments; the lab's turn-mode argument
    (for `ANSWER_THINK=targeted`) exists only on the lab.
  - Open: citations of search snippets were unsupported 71 % of the time against 23 % for page
    text (re-diagnosed 10-01, D43); the 0.92 dedup threshold dropped 6 of 7 templated queries
    falsely (fixed 10-01, D42); the "URLs found this turn" limit is advisory
    ([known issues](/history/known-issues)).
    → [pipeline](/search/pipeline#round-cap), [telemetry](/operations/telemetry#emitted-by-the-search-tool)
- **09-29** — **Four small fixes** (lab `25ff9829`, `7ce5e6c1`, `4f81508d`, `a9e99f28`; prod
  `7a351a38`, `51516a89`, `2edddf3d`, `1658df97`; staging `adaf4d48`, `fd543310`, `f35edb95`,
  `10b47275`).
  - `update-images.sh` reports a failed image pull: `FAIL pull …` and `<stack>:pull` in
    `FAILED: …` (exit 1); the stack is still recreated and verified with the images it has.
    → [fleet scripts](/operations/fleet-scripts#update-images-sh)
  - Narration: at persist and read time a glued seam before the first line-start heading now
    wins, as it does live, so `narration.## A … \n## B` no longer loses section A; new English
    starters "I have converging/corroborating evidence" and "I'm ready to write the (final)
    answer" (narrow object). A scan of every stored message changed exactly 1, which the
    backfill cleaned on prod the same day.
    → [D20 › Decision 6](/history/decisions#decision-6-the-glued-seam-wins-at-persist-too)
  - Recall indexing strips only the message's own tool-call ids and `#<uuid>` anchors; other
    UUIDs (GUIDs, image-URL ids) are indexed. 25 older prod/staging messages keep their old
    chunks until re-indexed
    ([known issue](/history/known-issues#older-recall-chunks-lack-uuids-the-answer-contained)).
  - `todoWrite`: item `id` and `timestamp` are optional and filled server-side; 13 of 14 stored
    validation failures were a missing timestamp.
- **09-29** — **A WSL host no longer deadlocks at boot** (prod `e76c0d4d`; lab `21ecddf8`;
  staging `47d5b6d0`; [D41](/history/decisions#d41-on-wsl-hosts-nothing-that-waits-for-docker-is-enabled-at-boot)).
  - Serenity (.171) rebooted and hung for about 8 minutes ("Bootup is not yet finished", Docker
    Desktop's integration never came up): `deploy.sh` had enabled the Docker-waiting
    `ask-fleet-boot.service` into `multi-user.target` everywhere (2026-09-23), and on WSL Docker
    Desktop attaches only after boot finishes. Recovered with `wsl --shutdown` and a Docker
    Desktop restart; boot then took 1.6 s.
  - `deploy.sh` now leaves the unit disabled when `systemd-detect-virt --container` is `wsl`
    (.17, .160, .171), where `fleet-boot.timer` pulls it in 75 s after boot; it stays enabled on
    .231 (bare metal).
    → [fleet](/infrastructure/fleet#docker-desktop-on-17-and-the-boot-recovery-chain),
    [runbook](/operations/runbooks#wsl-host-hangs-at-boot)
- **09-28/29** — **Stored narration backfilled** (tool: prod `15b58f82`, lab `5801c67d`, staging
  `278810d5`; [D20 › Backfill](/history/decisions#backfill-2026-09-28-29)).
  - `scripts/backfill-narration.ts` (run through `scripts/backfill-narration.sh <env>`): dry run
    → backup → apply (one locked transaction per message, refuses without a matching backup)
    → verify through the app's loader → re-index recall with the app's `indexMessage` (refuses
    any embedder but Qwen3-Embedding-0.6B).
  - 2026-09-28: staging 99 messages (242 part deletes, 5 rewrites), prod 92 (177 deletes, 4
    rewrites); 2026-09-29: 1 more prod rewrite after the new English rule. Verify 100 %, a
    re-run finds 0 changes, recall chunks holding removed text → 0 (prod: 8 messages
    re-indexed, 68 → 56 chunks).
    → [evaluation › narration backfill](/operations/evaluation#narration-backfill),
    [runbook](/operations/runbooks#re-run-the-narration-backfill)

- **09-28** — **The live stream cuts a glued preamble and streams the answer** (`82254324`;
  lab `0f3439cb`; staging `32a1cbae`;
  [D20 addendum › Decision 5](/history/decisions#decision-5-the-live-transform-cuts-the-glued-seam)).
  - The trigger: a lab deepseek-v4-pro turn (chat `bllkvux84ck1uz3wwrwnydg5`) whose final
    answer opened with a 785-character English preamble glued to its heading
    (`…the detailed chapter breakdown.## …`). The transform kept buffering for a line-start
    heading that never came and released all 4,916 characters at text-end: about 72 s with
    nothing on screen after the last tool call.
  - The persist glued rule was split into shared helpers, `findGluedPreambleSeam` (seam and
    prefix guards) and `gluedAnswerOutweighsPreamble`; `stripGluedHeadingPreamble` is built from
    them with unchanged behaviour. The transform runs the same helpers on every held delta and
    emits from the `##` as soon as the text after the seam outweighs the prefix, then passes
    deltas through 1:1. The answer only grows, so the live cut is exactly the persisted cut. It
    waits for the end of the line when a backtick precedes the seam, lets a seam before a later
    `\n## ` win, and keeps holding (ceiling 16,000 characters, or an unchanged flush at
    text-end) while the cut is undecidable. On a replay of the real turn the answer starts 792
    characters after the seam instead of at the end.
  - Also fixed: when the transform stripped a preamble in front of a line-start heading, it
    trimmed the partial buffer and dropped the heading's newline, so the stream and the saved
    answer read `## Remedying Canker SoresCanker sores are painful.`
  - Tests: a replay of the recorded turn pair under six chunkings
    (`lib/streaming/helpers/__tests__/smooth-and-strip-narration-replay.test.ts`, fixtures
    `narration-replay-t{1,2}.json`) plus guards in `smooth-and-strip-narration.test.ts`.
    → [streaming](/request-lifecycle/streaming#narration),
    [models & reasoning](/search/models-reasoning#how-the-stream-transform-decides)
  - Open at the time: persist still ran the English phrase rule before the glued rule, so
    unstripped `narration.## A … \n## B` could lose section A; fixed 2026-09-29 (entry above).
- **09-28** — **Narration cleanup works in any language and applies wherever text is read**
  (`a90e4b83`; lab `05c90289`; staging `7730d899`; ported the same day for release after a lab
  browser check; [D20 addendum](/history/decisions#addendum-2026-09-28-language-agnostic-structural-rules)).
  - The trigger: a Vietnamese prod chat (deepseek-v4-pro, balanced) saved every status note
    written before a tool call, and its answers began with "…chương.## " (a preamble glued to the
    heading, the `</think>` between them hidden by the sanitizer). The persist-time rules only
    knew English phrases, and a heading glued to a sentence was never recognised.
  - Two structural rules, run after the unchanged English rules: a non-final text part directly
    followed by a tool call is dropped when it is ≤600 characters, unstructured (no heading,
    table, code fence, 3+ item list or citation) and not longer than the final answer; a `## `
    glued to preceding text outside code is the narration/answer seam, and the prefix is cut
    when it has no heading or citation of its own, is ≤2000 characters and is shorter than the
    rest. A proper `\n\n## ` heading is never touched.
  - The same cleanup now runs wherever text is read: the chat view (`narrationCleanView`, also
    for the live message), the "research still running" indicator, copy, the history sent to
    the model and the classifier (logged-in and guest), the spoken gist, recall indexing and
    sidebar/Library search snippets. Already-stored answers display clean without a DB rewrite.
    → [models & reasoning](/search/models-reasoning#narration-and-chain-of-thought-leak-handling),
    [streaming](/request-lifecycle/streaming#narration)
  - Review of all 88 new removals in stored history (15 Vietnamese, 73 English): 0 false
    positives; of the 118 messages the old rules changed, 95 identical, 23 cleaner, 0 regressions.
  - Open at the time: stored rows were unchanged, so keyword search still matched stored status
    notes and 39 recall chunks kept a glued preamble; the backfill ran 2026-09-28/29 (entry
    above). A glued
    answer appears a moment later while streaming, and an English-looking glued preamble was
    still held by the live transform until the part ended; fixed the same day (entry above)
    ([known issue](/history/known-issues#an-answer-with-a-glued-preamble-appears-late-while-streaming)).
- **09-27** — **Incident: a Redis restart hung every balanced/quality search; the fix**
  (`aeb6f4fa`; lab `6f354732`; staging `3912d8ab`; deployed about 20:45 UTC;
  [D39](/history/decisions#d39-every-local-redis-client-goes-through-local-redis-ts)).
  - The weekly sidecar update (04:30 PDT = 11:30 UTC) recreated `redis`, `gluetun` and
    `searxng` for prod and staging under the running apps. The app's node-redis clients had no
    `'error'` listener, threw before reconnecting and queued every later command, so
    `/api/advanced-search` never answered and turns died silently at 300 s. Health checks,
    the homepage and the update's own verification stayed green. Restarting both apps at about
    20:03 UTC mitigated it.
    → [known issues](/history/known-issues#search-hung-after-the-weekly-redis-update),
    [runbook](/operations/runbooks#search-hangs-after-a-redis-restart)
  - `lib/redis/local-redis.ts`: one resilient local client factory (error listener,
    `disableOfflineQueue`, 2 s connect timeout, backoff capped at 2 s, every command bounded at
    1 s via `LOCAL_REDIS_COMMAND_TIMEOUT_MS`, dead clients rebuilt), used by all seven modules
    that had a bare client. Per-caller outage behaviour unchanged; the basic-search cache and
    the ingest heartbeat now also recover from a failed first connect.
    → [data layer](/infrastructure/data-layer#redis-clients)
  - The search tool bounds its internal call: `ADVANCED_SEARCH_HEADERS_TIMEOUT_MS` (20 s, stream
    mode) and `ADVANCED_SEARCH_TIMEOUT_MS` (180 s total), then falls back to a basic SearXNG
    search with a `[search] advanced-search timed out …` line and a
    `[latency:search] kind:"advanced-fallback"` line.
    → [pipeline](/search/pipeline#advanced-search-deadline-and-fallback),
    [telemetry](/operations/telemetry#emitted-by-the-search-tool)
  - New token-gated `GET /api/advanced-search`: PINGs Redis through the route's client, no search.
    `update-images.sh` restarts the app when a sidecar changed under it and runs that probe.
    → [fleet scripts](/operations/fleet-scripts#update-images-sh)
  - Open follow-up: the same morning the lab's image pull failed and the script reported success
    ([known issue](/history/known-issues#image-pull-failures-are-swallowed-by-update-images-sh));
    fixed 2026-09-29.
- **09-27** — **The forced search is the first search, not the only one** (`bf479a9f`; lab
  `959c8a93`; staging `0c619b89`;
  [D37 addendum](/history/decisions#addendum-2026-09-27-the-forced-search-is-the-first-search)).
  The always-search prompt addendum told the model to search again or fetch "only if those
  results leave a specific gap you can name" and, if they were irrelevant, to "answer from what
  you know". It now says to treat the forced search as the first of the turn's searches and
  continue the mode's research protocol, and to search again with a better query when the
  results are irrelevant. A test guards the wording.
- **09-27** — **Citations: ready-made citation handles; reloaded citations keep their page**
  (`a9f3970f`, `e77b7d9f`, `ee90b8a5`; lab `5fb4966f`, `0cc68543`, `af507504`; staging
  `f9b9d843`, `e98a4dfb`, `6a020f82`; [D38](/history/decisions#d38-ready-made-citation-handles)).
  - Every search result, fetched page and attached-document excerpt the answering model sees
    carries `"cite":"[N](#<real toolCallId>)"`, with N exactly what the renderer resolves
    (search numbered after the per-turn URL dedup; fetch with failed URLs left out; documents
    by excerpt). The prompts say to copy it and never compute, renumber or edit a citation; the
    counting rule and its worked example are gone. Added only in `toModelOutput` (search, a new
    one for fetch) and the `documentRetrieval` model message, never in stored parts.
  - New `CITATION_HANDLES` flag (`lib/utils/citation-handles.ts`), **default on**; only the
    literal `off` disables it, read per call. Off is byte-identical to the 09-26 behaviour, and a
    container recreate applies it without a rebuild. Model Manager: "Ready-made citation handles"
    switch in the Search tab.
  - Lab A/B (blind support judge, 4 questions × 2 models per arm): unsupported citations
    deepseek-v4.1-flash 64.0 % → 11.0 %, kimi-k2.6 47.8 % → 18.7 %, lower in all 8 pairs; every
    on-arm citation an exact handle copy; answer quality 4 wins, 2 losses, 2 ties. Cost about
    +370 prompt tokens per balanced call. Open: deepseek fetched on 4 of 4 turns with handles
    (0 of 4 without, about +30 s), confounded with recall; kimi dropped 3 citations by copying
    the id with one character missing.
    → [known issues](/history/known-issues#running-count-citation-numbers-can-point-at-the-wrong-result),
    [telemetry](/operations/telemetry#tokens-citations-and-totals)
  - `rehydrateFullContent` swaps saved full text in by URL, keeping the live results' order and
    length. It used to replace the list wholesale; on the speed fast path that list predates the
    per-turn URL dedup, so a reloaded answer's citation could resolve to a different page.
    → [known issues](/history/known-issues#reloaded-speed-mode-answers-cited-a-different-page)
- **09-26** — **Citations: one numbering scheme, no copyable placeholders, an honest audit**
  (lab `18e0faf1`; cherry-picked to `dev` as `96c8b006` and to staging as `c55e6a52`).
  - One resolver, `resolveCitationAnchor` (`lib/utils/citation.ts`), now decides every anchor
    for rendering, the `[latency]` audit and `[cite-urls]`, so they always agree. It repairs an
    anchor only when the source is unambiguous: a real id wrapped as `<id-UUID>` is unwrapped; a
    placeholder id (`<token>`, `id-X`, `toolCallId`, any example id the prompts have used)
    resolves only in a turn with one citable call; a too-high number on a one-page fetch
    resolves to that page. A wrong number on a search or a multi-page fetch stays dropped, and
    nothing resolves across turns.
  - Prompts: one shared citation guidance for every mode. N is the source's position within
    that call's `results`, restarting at 1 per call; a one-page fetch is always `[1]`; the
    worked example uses realistic ids that the resolver recognises if copied. All `<id-A>`-style
    placeholders are gone, and the forced-search addendum no longer shows a `[n](#toolCallId)`
    example.
  - `citations_unresolved` now counts every anchor that renders nothing, including out-of-range
    numbers it used to score as resolved, so it reads **higher** than before for the same
    answers; `citations_recovered` covers every repair.
    → [telemetry](/operations/telemetry#tokens-citations-and-totals)
  - Replay of 60 days of stored answers: visible citations prod 1,460 → 1,470, lab 3,880 →
    3,925; 0 lost, 0 rendered links changed; audit matches rendering on 374 of 374 messages
    (was 333). Still open: in-range running-count numbers that render the wrong result of the
    right search (prompt-mitigated, unmeasured on live turns; fixed 09-27 by citation handles,
    above).
    → [known issues](/history/known-issues#running-count-citation-numbers-can-point-at-the-wrong-result),
    [D36 addendum](/history/decisions#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)
- **09-26** — **Every question gets a web search** (`6224a9e4`, lab `ace42ae5`, staging
  `c40c2cd3`; owner decision, [D37](/history/decisions#d37-always-search-every-question),
  reversing [D3](/history/decisions#d3-needssources-skip-retrieval-for-stable-knowledge)).
  Over the previous 60 days 69 of 164 prod turns had used no tools, many of them product,
  policy, repair and safety questions answered from memory (one recommended acetone for melted
  plastic on an oven tray with no fire warning).
  - New `ALWAYS_SEARCH` flag (`lib/agents/always-search.ts`), **default on**; only the literal
    `off` disables it. `ALWAYS_SEARCH=off` plus a container recreate restores the old behaviour
    without a rebuild.
  - New classifier prompt: `skipSearch` only for non-questions (greetings/thanks/venting, pure
    transforms of text already present, pure arithmetic, image requests). `needsSources` is
    logged only; the old prompt is kept as `LEGACY_CLASSIFIER_SYSTEM_PROMPT` for the flag's off
    state. A replay of the 164 prod turns: 145 search, 19 skip.
  - Guaranteed first search: `prepareStep` gives step 0 of a research turn to a synthetic model
    that emits one `search` call on the classifier's `standaloneQuery`, because `ai-sdk-ollama`
    ignores `toolChoice`. The real `search` tool runs it; logged-in and guest turns alike.
  - `[latency]` gains `turn_mode` and `forced_search`. On forced turns `ttft_ms` is only the
    pre-work; use `stream["text-start"]` for first prose.
  - Lab blind A/B on the 6 valid formerly unsearched pairs: 2W-1L-3T for searching. Cost: first
    prose about 7–20 s later on those questions. Found along the way: an image plus "what is
    this?" force-searches the words alone (fixed by the follow-up below,
    [known issues](/history/known-issues#image-attachment-forces-a-generic-search)), and models
    sometimes cite the prompt's `<id-A>` placeholders or out-of-range numbers (fixed by the
    citation entry above).
  - Docs: the env reference generator now also finds reads through a name bound to
    `process.env` (`env.ALWAYS_SEARCH`).
  - **Follow-ups (`84af51c3`; `dev` `1c773145`, `admin-feature` `ceb3216c`):** a research turn is **not** forced when the user
    supplied the source: a URL (inline or a link chip; such a turn is again exactly the
    pre-D37 research turn, read with `fetch` or the attached-source path), an attachment with no
    typed text, or an attachment whose text only points at it ("what is this", "summarise this
    file"). `detectUserSuppliedSource` in `lib/agents/always-search.ts`; `[latency]` gains
    `forced_skip`. An attachment with a real question is still forced. Explicit memory
    instructions ("remember that …", "forget …", "update my …") are named in the classifier's
    skip list with examples, so they stay `direct` turns and `remember` writes a confirmed
    memory. The Model Manager gains an "Always search" switch (Search tab; `on`/`off`, rejects
    `false`), and `ALWAYS_SEARCH` is in `.env.local.example`. The classifier eval gains three
    memory cases and its baseline was re-captured on `deepseek-v4-pro:cloud` with the current
    prompt ([evaluation](/operations/evaluation)).
- **09-25** (UTC; the evening of 09-24 local time) — **Rendering, recall and Model Manager fixes**
  (built on the lab, then ported to staging and prod):
  - **No "[blocked]" flash for a half-streamed citation** (`6658c4a0`, lab `bc74ace9`). A citation
    anchor cut off at the stream tail (`[1](#<toolCallId>` with no `)` yet) used to render as
    "1 [blocked]": Streamdown's `remend` completed it as `streamdown:incomplete-link`, sanitize
    dropped that href and `rehype-harden` labelled the empty link. Because reloaded answers also
    render in streaming mode, an answer stopped mid-anchor kept the marker for good.
    `stripIncompleteCitationTail()` now drops the unfinished anchor (skipping code, leaving a
    bare `[1]`), and Streamdown runs with `remend` `linkMode: 'text-only'` in the answer and the
    reasoning view. Sanitize and harden are unchanged.
    → [frontend › half-streamed links](/request-lifecycle/frontend#blocked-flash)
  - **Scrolled text no longer shows through the header** at ≥1024px (`c683085b`, lab
    `004cba7a`): an opaque sticky strip (`sticky -top-14 -mt-14 h-14 bg-background z-[15]`) at
    the top of the message scroller, with the header raised to `z-20`.
    → [frontend › header backdrop](/request-lifecycle/frontend#header-backdrop)
  - **Title lead-ins skipped** (`daaaf271`, lab `93f0f684`): the title generator ignores lines
    ending with `:` ("Here is the short, concise title (4 words):") and a leading `Title:`
    label; colons inside a title are kept. → [chat turn](/request-lifecycle/chat-turn)
  - **Recall rerank pool 8 on prod and lab.** Refetch-path bench on 40 real prod queries: p50
    1365 → 1088 ms, samples over 1.2 s 63/80 → 0/80, same injected set on 40 of 40. Prod sets
    `RECALL_RERANK_POOL=8` in `.env` (through the Model Manager), the lab in
    `docker-compose.lab.yaml` (`42c8a2cb`, lab `18a7c9cd`); staging and the code default stay at
    10. Prod afterwards: `recall_ms` 1080–1342 ms, 0 of 4 budget hits. Under a concurrent search
    rerank recall still misses the budget at either size (a new known issue).
    → [D34](/history/decisions#d34-recall-rerank-deferred-not-aborted),
    [memory & recall](/knowledge/memory-recall#recall-pool-8)
  - **Model Manager** (`3182583c`, lab `df96ef27`; image rebuilt): every `.env` write (apply,
    restore) is atomic **and keeps the file's owner and mode**, backups are always 0600. An apply
    earlier that day had turned prod's `nightfury:nightfury 0600` `.env` into `root:root 0644`;
    the fix does not repair an already-damaged file, which needs a one-off `chown` + `chmod`.
    Boolean switches now show the app's real unset default and write what the app honours:
    `RECALL_ENABLED`, `MEMORY_ENABLED` and `OLLAMA_SEARCH_ENABLED` write `on`/`off` and reject
    `false` (the old `false` left them on).
    → [Model Manager](/infrastructure/model-manager#file-ownership-and-mode),
    [known issues](/history/known-issues#prod-env-left-root-root-0644)
  - **Found, not fixed:** the RLS fail-closed guard runs only for `ENABLE_AUTH === 'true'`, while
    the app treats unset as auth on. → [known issues](/history/known-issues#rls-guard-ignores-an-unset-enable-auth)
- **09-24** — **Bug-fix batch** (built on the lab, then ported to staging and prod):
  - **"Stopped" label.** A stopped answer shows a muted "Stopped" pill in its action row, live
    (`markMessageStopped`, set by the client when the Stop lands) and after a reload (the
    persisted `metadata.stopped`). The action row wraps on narrow phones.
    → [streaming](/request-lifecycle/streaming#stop)
  - **Unresolved citations**, three pipeline causes: fetch results now carry their
    `toolCallId`; earlier answers' anchors are stripped from the model-bound history
    (`strip-citation-anchors-from-history.ts`); a strict single-match URL-fragment resolver
    (`resolveByUrlFragment`) renders anchors that name a page's URL instead of an id. New
    `citations_recovered` field on `[latency]`. Replay on prod history: unresolved 16.6 % → 14.5 %
    (last 45 days 7.1 % → 5.2 %) from the resolver alone.
    → [D36](/history/decisions#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)
  - **Memory consolidation scheduled**: `fleet-boot/memory-consolidate-nightly.sh`, .17 cron
    03:45, each env's secret read from its own `.env` and sent on stdin.
    → [memory & recall](/knowledge/memory-recall#how-to-schedule-memory-consolidation)
  - **Auth middleware page gate works**: `/` is matched exactly and public prefixes match whole
    segments, so signed-out visitors to unknown or new paths go to `/auth/login` (never with
    `ENABLE_AUTH=false`). Dead `hooks/use-auth-check.tsx` and `components/auth-modal.tsx`
    deleted. → [auth & accounts](/request-lifecycle/auth-and-accounts#the-page-gate-fixed-2026-09-24)
  - **Model Manager**: random per-login sessions with a server-side 24 h expiry and revoking
    logout; `/api/restore` accepts only listed app-made backups and snapshots `.env` first;
    hand-made `.env.bak.*` files are ignored; a **Clear this secret** action.
    → [Model Manager](/infrastructure/model-manager#authentication)
  - **Ingestor** (`ba5fc5c`): 401/403 and 503 on claim are logged once as config errors and
    re-checked every 300 s instead of crash-looping or retrying silently; a per-job heartbeat
    (`HEARTBEAT_INTERVAL`, 180 s) stops long jobs being re-claimed as stale; `.env.example` is
    tracked. → [ingestor](/knowledge/ingestor#main-loop-and-claim-back-off)
  - **Fleet scripts**: `update-ask.sh` and its timer units are on `flow-design` too;
    `update-images.sh` gained an `ask-lab` entry, and the weekly run goes lab (canary) → prod →
    staging. → [fleet scripts](/operations/fleet-scripts#update-ask-sh-fleet-update-ask-service-timer)
  - **Eval scripts** target the lab on .17 (`ASK_LAB_DIR`, `ASK_LAB_URL`) and refuse to recreate
    `ask-lab` from another worktree; `judge-flow-arms.py` uses the .17 Ollama; `EVAL_MODEL` is
    honoured everywhere; `bun chat --no-search` removed. → [evaluation](/operations/evaluation)
  - **Hygiene**: `granite4.2:8b` in comments; the lab's copies of `docker-compose.yaml` and
    `docker-compose.admin-feature.yaml` synced to prod and staging (degoog disabled everywhere);
    `engines.node` is `^20.19.0 || 22.x`.
- **09-24** — **.231 fully cleaned.** The retired stacks' kept volumes, their images and the old
  `ask`/`ask-prod`/`ask-flow` checkouts on MiniNightFury were deleted. The 42 commits that
  existed only in .231's lab checkout were kept as local branches `archive/231-flow-design-pipeline`
  and `archive/231-wip-context-latency-budget` (not on `origin`).
  → [D35](/history/decisions#d35-retire-and-remove-the-231-ask-stacks)
- **09-23** — **Documentation-audit fixes**, shipped to lab, staging and prod the same day (prod
  `b1942c57`..`8ac4aeff`, lab `5a39df94`..`69a8107e`):
  - A SearXNG failure no longer empties an advanced search: it counts as an empty SearXNG share,
    the other providers' results are returned, the degraded result is **not cached**, and
    `[latency:search]` carries `searxng=ok|failed` (`b1942c57`).
  - The legacy crawler (`lib/utils/legacy-fetch-html.ts`) runs the SSRF guard on the start URL and
    on **every redirect hop**, max 5 (`7ef2bb61`). → [security](/infrastructure/security)
  - The 200 s answer deadline is **enforced inside each tool's `execute`**, and its clock starts
    at the start of the turn (`53eba161`, `lib/agents/answer-deadline.ts`).
  - The memory consolidator lists users through `dbAdmin`, so RLS no longer hides them
    (`7339850d`). Scheduling it followed on 09-24.
  - Follow-ups in home-started chats bump the chat and call `touchChat` (`ef5fa3ae`).
  - Fast-path uploads start as `processing`, so the ingestor cannot ingest them twice;
    `UPLOAD_TTL_DAYS` has one parser, `lib/config/upload-ttl.ts` (`313b0284`).
  - **Recall latency:** candidates (embed + DB) are prefetched during classification and the
    rerank runs once on the final query; `RECALL_RERANK_POOL` 20 → 10, new
    `RECALL_RERANK_MAX_LENGTH` 384. Recall p50 about 1.3 s, inside the 1.5 s budget (`d7f3ed9b`).
    → [D34](/history/decisions#d34-recall-rerank-deferred-not-aborted)
  - Model Manager: `EMBEDDING_MODEL` is read-only; `RECALL_RERANK_MAX_LENGTH` is editable
    (`2d20b3d6`).
  - Test suite fully green (`12e350c7`). → [testing](/operations/testing-qa)
- **09-23** — **Infra fixes:**
  - Serenity (.171) Ollama bound to `0.0.0.0` again via the drop-in
    `/etc/systemd/system/ollama.service.d/host.conf`; `granite4.2:8b` re-pinned. The LAN exposure
    was accepted by the owner.
  - Compose: the staging `CRAWL4AI_URL` pin was removed, and the staging and lab classifiers point
    at `.17` like prod (`7fd361c3`).
  - FlareSolverr is published on `192.168.50.231:8191` and `FLARESOLVERR_URL` points there in
    every env. Prod and staging set `SEARXNG_FALLBACK_API_URL=http://192.168.50.231:8127`; lab
    has no fallback.
  - The retired .231 Ask stacks, which a stale boot script had recreated on 09-16, were removed
    (containers and networks).
  - fleet-boot: `rotate-mullvad.sh` uses each env's own worktree; `rebuild-ask.sh` exits 1 (and
    keeps the old image) when the app never serves 200; boot reconciles all three ingestors;
    `deploy.sh` syncs .231 (`79ecd188`, `23e35de3`, `57f97d01`). .231's rotation and weekly
    public-search update run from `~/fleet-boot` (`967d900c`); `update-images.sh` health-checks
    the Ask stacks on localhost (`6aa8bf41`).
  - The reranker and Whisper are pinned to the 2080 Ti by GPU UUID. The ingestor directory became
    a git repo, and the worker backs off when Ask is unreachable instead of crash-looping (it had
    restarted more than 1,100 times during Ask outages).
  → [known issues](/history/known-issues), [fleet](/infrastructure/fleet)
- **09-22** — **QA sweep fixes** (two rounds):
  - **A new chat's first answer vanishing about 1 s after it finished** (a critical bug introduced
    on 09-21) is fixed. `app/search/[id]/page.tsx` now reads `loadChatUncached`. A home-started
    chat's `onFinish` sends an optimistic `chat-bump` instead of a refresh. A stream-activity
    registry defers sidebar refreshes while anything streams. Stop now reaches home-started
    chats. Edit and Retry refuse while a turn is in flight (`54db51e5`).
    → [D28](/history/decisions#d28-sidebar-refresh-invariants-and-uncached-conversation-reads)
  - **Stop keeps the partial answer** (sanitised, `metadata.stopped`, newer-turn guard). **Resume
    after a disconnect** no longer duplicates parts, and a 204 reloads from the new owner-only
    `GET /api/chat/[chatId]/messages` (`1c2bbf13`).
    → [D29](/history/decisions#d29-stop-keeps-the-partial-answer), [streaming](/request-lifecycle/streaming)
  - Sidebar times render in the viewer's timezone; compact one-line weather on mobile
    (`e2745bc7`).
  - Mobile: composer toolbar overlap fixed, popover bounds, Discover/Library layout (`22471a8e`).
    Settings dialog height uses `dvh`, touch-visible delete buttons, tap-to-preview citations, and
    provider `<strong>` markup stripped from snippets (`4a7a07e0`).
    → [frontend](/request-lifecycle/frontend)
- **09-21** — Sidebar never runs `router.refresh()` mid-stream: `chat-bump` was removed from
  `REFRESH_EVENTS`. This fixed the UI blanking during an answer (`3cd2ee45`).
- **09-20** — Mobile: the composer anchors near the top while focused, so the typed line stays
  visible above the keyboard (`e99fc4ff`).
- **09-19** — The 404 flash on a new chat's first prompt is fixed (`e97d0d9d`). **Follow-up
  re-search prompt nudge** shipped (`91bda83f`; [D19](/history/decisions#d19-follow-up-re-search-prompt-nudge)).
  **Targeted reasoning** was built and A/B'd but not shipped (lab `c23542fd`;
  [D18](/history/decisions#d18-targeted-reasoning-reasoning-only-on-research-turns)). A security ops
  runbook was written (outside the repo).
- **09-17** — Round-cap reasoning dumps and stray `</think>` tags are stripped from answer text
  (`9a24e1da`; [D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live)).
  The weather widget stops re-prompting for location on every load (Permissions API gate +
  6 h coordinate cache, `233148f9`).
- **09-15** — Security defence in depth from the 09-14 review (`2bd0af83`): href scheme sanitising
  (`lib/utils/safe-url.ts`), fail-closed chat ownership, a mathjs expression bound, and `nosniff`
  on ingest file downloads. Model Manager re-verifies the session inside `/api/apply` (`01a8d053`).
  The world-readable `.env` files were `chmod 600`'d. → [security](/infrastructure/security)
- **09-14** — Full A-to-Z security review: **strong**, with no critical or high finding on the
  public surface. The remaining items are operational; see
  [known issues](/history/known-issues#security-awaiting-ops-action).
- **09-12** — **Doc-RAG token budget**: injected document/URL sources are trimmed to the real
  remaining context window, so they can no longer overflow and cause a 400 (`12fef49b`).
  **Signed, expiring upload URLs** shipped dormant (`f4cded03`;
  [D25](/history/decisions#d25-signed-upload-urls-shipped-dormant)). A mobile homepage series:
  the real overflow fix in `chat.tsx` (`f0fa0876`), centred hero restored (`bb91e039`), voice
  controls moved behind a `⋯` menu (`500f6904`), toolbar bounds (`a7741714`).
- **09-11** — Model roster reconciled across all three envs; `deepseek-v4.1-flash:cloud` added and
  `deepseek-v4-flash:cloud` removed (env only). Prompt caching investigated and rejected
  ([D13](/history/decisions#d13-prompt-caching-on-ollama-cloud)). The **ingestor heartbeat**
  shipped: a user-visible "processing is down" signal (`837beaca`).
- **09-10** — **Single-pass search** A/B'd on lab and **reverted**
  ([D12](/history/decisions#d12-single-pass-search-instead-of-the-agentic-loop)). Inter-step
  narration is stripped from persisted answers (`572c38c9`). The sidebar "Recent" list reorders
  optimistically (`e4897454`). RAG hardening: bounded ingest wait (default 30 s, 8 s
  unclaimed early-bail), a `RAG_MIN_SCORE` relevance floor, and a fixed stale embedder comment
  (`82adcf2b`). A read-only RAG/upload review corrected the storage picture: upload chunks are on
  disk, not in pgvector ([D23](/history/decisions#d23-uploads-and-url-rag-on-disk-not-pgvector)).
- **09-09** — **Answering-model reasoning OFF by default** (`a9aee9ef`;
  [D10](/history/decisions#d10-answering-model-reasoning-off-by-default)). **Raw reasoning hidden**
  behind a "Thinking…" pill (`cfe627cf`; [D11](/history/decisions#d11-hide-raw-reasoning-in-the-ui)).
  Time hints added to the search-mode descriptions (`185161d9`).
- **09-08** — Observability: `recall_wait_ms` / `recall_budget_hit`; `recall_ms` now records the
  true background cost (`5dc87fe7`). → [telemetry](/operations/telemetry)
- **09-07** — The rest of the latency campaign:
  - **Brave crawl cap** `BRAVE_CRAWL_MAX=3` (`728bc643`; [D7](/history/decisions#d7-cap-the-brave-crawl-to-the-top-3)).
  - **Timeboxes** for recall (1.5 s), the classifier (4 s soft) and LangSearch (2.5 s)
    (`003b8168`; [D8](/history/decisions#d8-timebox-recall-classifier-and-langsearch)).
  - **Search round cap**, 3 balanced / 5 quality, enforced in the tool (`8ed7fe52`;
    [D9](/history/decisions#d9-search-round-cap-enforced-inside-the-tool)).
  - Per-env degoog moved from `.231` to `.17` and **disabled** (`0a05bcff`, `8307ed1f`;
    [D30](/history/decisions#d30-degoog-public-instance-kept-per-env-scrapers-disabled)).
- **09-02 → 09-04** — **Search pipeline rework**: fast mode is Ollama-web only with no crawl
  (`421947a3`); speed mode skips the classifier and recall (`487fbe29`); **source tiering by mode**
  (`3339eb4b`); Brave is crawled rather than prefetched (`3931d25b`); **classifier moved to
  `deepseek-v4-pro:cloud`** (config).
  → [D5](/history/decisions#d5-source-tiering-by-search-mode), [D6](/history/decisions#d6-classifier-on-a-cloud-model-with-expansion-fused-in), [search pipeline](/search/pipeline)
- **09-01** — The `images` SearXNG category is limited to advanced depth (`2d0cf97c`, search_ms
  ~28 s → 8–16 s). `RERANK_PASSAGE_BUDGET` 320 → 160 (env). The `calculate` tool renders inside
  the research accordion (`25acd124`, `e4c56230`).

## 2026-08 — August

**Host migration to NightFuryX, boot resilience, features (voice, docs & URLs, history, homepage)**

- **08-30** — All tool stage timings folded into the single per-turn `[latency]` line (`dce2bb90`).
- **08-29** — Weekly fleet-wide Ollama auto-update (`6c0fba63`). → [fleet](/infrastructure/fleet)
- **08-28** — Model refresh: `glm-5.2` → `glm-5.3-flash` (list and, at the time, the classifier);
  local jobs moved to `granite4.2:8b` (`1a7b49ff`, `27b67637`). The embedder was deliberately left
  pinned ([D24](/history/decisions#d24-the-embedding-model-is-data-locked)). The old `.231` Ask
  stacks were retired; their DB and upload volumes were archived to `.17:/home/nightfury/backups/ask-231-retire-2026-08-28/`.
- **08-27** — The fleet went on a **UPS**. The `.17` crontab was restored: daily upload-TTL sweep
  (`9a826070`), docker/disk maintenance with a Postgres `amcheck` index check (`ec0f3e53`), and the
  daily Mullvad rotation.
- **08-26** — **Wait for ingest** before the first reply (`6810f051`). One ingestor per env
  (`ingestor`, `ingestor-staging`, `ingestor-lab`). fleet-boot retries gluetun and SearXNG after a
  power loss (`4db71d6e`). → [RAG & uploads](/knowledge/rag-uploads), [runbooks](/operations/runbooks)
- **08-25** — Image uploads stuck in the queue: `ingest/complete` now uses the RLS-bypassing
  `dbAdmin` for its lookup (`6cee5d0f`), which the move to the `app_user` role had exposed.
  `rebuild-ask.sh` wrapper (build + health + reclaim, `132edfa9`). Read-aloud overhaul:
  single-flight TTS, configurable speed and voice, Listen moved into the answer row, progressive
  (streamed) playback (`ffe202b5` … `4213ca79`). → [media](/knowledge/media)
- **08-24** — Boot resilience on the WSL2/Docker Desktop hosts: `wait_docker()` and app-stack
  reconcile on NightFuryX (`45c8f6be`). Proven through three later power losses.
- **08-23** — **Ask moved from MiniNightFury (.231) to NightFuryX (.17)**. The public
  `ask.hbqnexus.win` is now served by a new cloudflared tunnel running as a Windows service on
  `.17`. TTS moved to `.17` on the Quadro P2200 (`b4ca8e05`). A weekly auto-update timer covers the
  app stacks (`f35472e2`). Model Manager moved to `.17`.
  → [environments](/operations/environments), [fleet](/infrastructure/fleet)
- **08-22** — Lab reconciled onto prod by merging `dev` → `flow-design` (lab `23960a92`). The
  **hands-free voice loop** was built on lab and then removed (lab `13d50db4`;
  [D31](/history/decisions#d31-hands-free-voice-conversation-loop)). crawl4ai 0.9.1 → 0.9.2 plus a
  weekly version check (notify only). Weekly auto-update for the public search stacks.
- **08-20** — **Cosmic "Orbit" homepage redesign** (`b3b898ed`). bun pinned to 1.3.14
  (`44ba6d3e`). Geolocation restored: `Permissions-Policy` set to `geolocation=(self)`, plus the
  visitor-IP fallback (`dd7f8adc`).
  → [D32](/history/decisions#d32-homepage-and-mobile-layout)
- **08-16 → 08-18** — **History & Library overhaul (Slice 1)**: a collapsible, date-grouped
  "Recent" sidebar, a real chat count, and `pg_trgm` trigram search (migration `0021`; 15 ms seq
  scan → 1.7 ms index scan) (`55d314cf` … `8cad223d`). The prod app-host boot self-heal was
  added (`7a6f2736`). → [client state](/request-lifecycle/client-state), [data layer](/infrastructure/data-layer)
- **08-16** — **Chat with docs & URLs (Slice 1)**: attached documents and pasted URLs are grounded
  **and citable** through a synthetic `tool-documentRetrieval` part (`df56e152` … `f9c02654`).
  → [RAG & uploads](/knowledge/rag-uploads)
- **08-12 → 08-18** — **Voice mode**: read-aloud through Kokoro TTS and dictation through Whisper
  on the 2080 Ti. Dictation is click-to-record plus press-and-hold (`33451ae9`), and the transcript
  goes into the composer for review. Microphone allowed in `Permissions-Policy` (`148d125c`).
  Whisper kept resident (`WHISPER__TTL=-1`). → [media](/knowledge/media)
- **08-09 → 08-11** — **Exhaustive architecture audit** (59 findings). Fixes: fail-fast RLS guard
  (`e4844314`), post-auth open redirect (`d10cf0c8`), prompt-injection boundary plus candidate-only
  `remember` on retrieval turns (`6447a6fb`), Discover through the SearXNG breaker (`1f9b5ac1`),
  `/api/health` plus a Docker HEALTHCHECK (`8bea95e6`), a legacy-crawl cap on crawl4ai outage
  (`fc14ec2b`). Model Manager applies the real prod compose command (`b2649ab1`, `4ca2a19d`) and
  binds to loopback (`7de70dd5`).
  → [D26](/history/decisions#d26-model-manager-is-the-sanctioned-env-editor), [security](/infrastructure/security)
- **08-06** — 20k per-page crop plus the crop-position shadow on prod and staging (`aea4b75d`;
  [D17](/history/decisions#d17-20k-per-page-crop-with-a-crop-position-shadow)).
- **08-05** — **Resumable streams**: authed turns survive a client disconnect and can be resumed
  live (`e6265a48`, `2f669f06`). Image-edit fixes, with the edit model pinned to `nano-banana-2`.
  **Two-stage full-content rerank** measured and **shelved**
  ([D16](/history/decisions#d16-two-stage-full-content-rerank)).
  → [streaming](/request-lifecycle/streaming)
- **08-04** — Mobile pass (compact composer, drawer behaviour, home widgets on phones). Lab:
  **multi-agent deep research** A/B'd and shelved ([D22](/history/decisions#d22-multi-agent-deep-research)).
  crawl4ai parallelism benchmark (don't raise it).
- **08-02 → 08-03** — Lab security and correctness sweep, later ported: the **app runs as the
  non-superuser `app_user` so RLS is enforced**, the SSRF hole is closed, advanced search is
  authenticated, security headers added, the image-exfiltration channel is closed at render time,
  and owner-scoping of message/title/feedback writes. Fetched pages are made citable so the model
  can no longer invent anchors (`cf28de80`).
- **08-01** — **Source excerpts retired**, because the A/B measured them down (`de2b4fa6`;
  [D15](/history/decisions#d15-source-excerpts-instead-of-full-pages)). Separate worktrees per env
  ([D2](/history/decisions#d2-lab-first-and-env-flag-isolation-no-per-env-builds)).

## 2026-07 — July

**Ask becomes its own product: retrieval quality, latency instrumentation, uploads, memory**

- **07-30** — **`needsSources`**: stop searching for stable-knowledge questions (`7f6165da`;
  [D3](/history/decisions#d3-needssources-skip-retrieval-for-stable-knowledge); reversed
  2026-09-26 by [D37](/history/decisions#d37-always-search-every-question)). Chat titles are
  written by the local model, not the chat model (`de4372c3`).
- **07-28 → 07-29** — The search loop no longer thrashes on its own deduplicated results
  (`53e86a80`). The research loop no longer runs out the clock and returns nothing (`e4276491`). A
  turn retrieval budget was tried and **reverted** (`5bd24bb1`;
  [D21](/history/decisions#d21-other-latency-knobs-measured)). Prod held at the strict quality
  filter (`b775fae2`). The lab became an isolated third instance (`ec3ba1d5`).
- **07-26 → 07-27** — SearXNG egress goes through **Mullvad via gluetun**, per env, with a daily
  exit rotation (`1a96e977` … `9267735e`). SearXNG engine health gate. Pre-crawl snippet gate
  built (left off). **LangSearch** added as a block-immune source (`492cd7f5`). The `fetch` rescue
  chain is bounded and batched. fleet-boot put under version control (`6ea55caf`).
- **07-24 → 07-25** — **Latency instrumentation**: a per-turn `[latency]` line (`f0af995f`),
  persisted to Redis `latency:log` (`1877b16c`), plus search-stage timings. Recall gated on
  `skipSearch` and overlapped with the classifier (`202cea62`). Cloud classifier trial reverted
  (`5142a711`). Brave API wired into the fan-out (`7ea0e377`). Crawl routed through Crawl4AI
  (`b3b9e3fb`). Waiting-quotes indicator.
- **07-23** — **Image generation** through Replicate (a 32-model registry, round-robin pools,
  monthly budget, SVG hardening). The saved per-account model pick is remembered (`abfd18a3`;
  [D27](/history/decisions#d27-saved-model-pick-outranks-the-default)). Default model
  `kimi-k2.6:cloud`.
- **07-22** — Tavily and Brave added to the fan-out. The "Wild Breath" three-body brand mark and
  research indicator.
- **07-19 → 07-20** — **Uploads**: streamed uploads up to 2 GB, a token-authed ingest job API with
  an external worker, vision-capability gating, idle-chat TTL expiry (`UPLOAD_TTL_DAYS`). Remote
  GPU embedder and **Qwen3-Embedding-0.6B** (`6c2afa82`, `2259f327`). Minimal CI (`3854e763`).
- **07-17 → 07-18** — **Ask Model Manager** config UI (`selfhosted/model-manager/`).
- **07-15 → 07-16** — **Long-term memory** (pgvector `user_memories`, `remember` tool) and
  **conversation recall** (`conversation_chunks`, hybrid Library search). Ollama web search merged
  into the advanced path. Conversation history is built from an uncached read (`19aee11b`).
- **07-13 → 07-14** — Pre-search **query classifier** (`eaef9564`). Cross-encoder reranker service
  (`ab287959`, `becfe399`). Accuracy workstreams: fetch rescue chain, recency, expansion,
  corroboration (`fb20e52c`).
- **07-06 → 07-08** — Rebrand to **Ask**. `calculate`, weather and academic tools. Native Ollama
  cloud models. A Vane-inspired UI (weather, search modes, Discover). A Vane-style RAG pipeline for
  files (`d08265c8`). An isolated compose overlay for staging (`32e75e71`).

## 2026-06 — June

- **06-26** — **Fork point.** Ask's custom work was applied on top of upstream
  [morphic](https://github.com/miurla/morphic) 1.5.0 (`23a5f22a` "Apply all custom changes from
  morphic-build"). Everything before this commit is upstream morphic history (from 2024-04).
