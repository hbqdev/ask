# Model-Manager UI — Build Report

**Date:** 2026-07-17 → 2026-07-18
**Branch:** `admin-feature` (not pushed — prod untouched)
**Feature range:** `67ed4b5..9c9d0db` (26 commits)
**Status:** Build **complete** and **merge-approved** by a whole-branch review. Two steps remain, both **gated on your approval**: removing Ask's now-redundant Models settings tab (Task 21, touches the live Ask app), and pushing/merging to `dev` + redeploying prod.

---

## 1. What was built

A **standalone Next.js web app** (`selfhosted/model-manager/`) that manages Ask's entire `.env` from a structured UI, writes it safely, and applies changes by restarting the affected containers — locally (`ask`) and cross-host over SSH (`reranker` on nightfuryS). It has **zero code coupling to Ask**; the only shared contract is the `.env` file plus docker/ssh commands. 63 TS/TSX files, 116 test blocks.

Plus two small, behavior-preserving **enabling changes to Ask itself** so the UI can control model names that were previously hardcoded.

**Design decisions (from the brainstorm), all captured in the spec:**
- Apply model: **edit + one-click apply** (the tool writes `.env` and recreates the container itself).
- Serenity model names (`granite4.1:8b`): made **env-driven** so the UI can change them.
- Reranker: **full cross-host control** (SSH to nightfuryS to change `RERANKER_MODEL` + restart).
- Config scope: **every `.env` var**, structured by category.
- Build approach: **standalone Next.js app** reusing Ask's shadcn/Tailwind/TS stack.

**Spec:** `docs/superpowers/specs/2026-07-17-model-manager-ui-design.md`
**Plan:** `docs/superpowers/plans/2026-07-17-model-manager-ui.md` (21 bite-sized TDD tasks)

---

## 2. Process

1. **Brainstorm** (superpowers:brainstorming) — mapped how Ask configures models today (three planes: chat, serenity classifier/expander/extractor, embeddings+reranker), then 5 decisions via Q&A. Wrote + committed the spec (`a551c86`), self-reviewed, you approved.
2. **Plan** (superpowers:writing-plans) — 21 TDD tasks with full code/tests, self-reviewed against the spec, committed (`67ed4b5`).
3. **Execution** (superpowers:subagent-driven-development) — a fresh implementer subagent per task, a task reviewer after each (spec-compliance + code-quality verdicts), fix loops where reviews found issues, then a final whole-branch review on the most capable model. Durable progress tracked in `.superpowers/sdd/progress.md`.

Every commit was made with **no AI-attribution trailer** (per your standing rule).

---

## 3. Per-task execution and outcomes

| Task | What | Commit(s) | Outcome |
|---|---|---|---|
| 1 | Ask: serenity model ids env-driven (`CLASSIFIER_/EXPANDER_/MEMORY_EXTRACTOR_MODEL_ID`, default `granite4.1:8b`) | `d9aa2b1` | review clean, 3/3 |
| 2 | Reranker: `RERANKER_MODEL` moved compose→`.env` | `d9a409f` | review clean, 2/2 |
| 3 | Scaffold standalone Next.js app | `0cb6346` | review clean; pinned Turbopack `root` to keep the build from pulling in Ask's files |
| 4 | Tool runtime-config reader (`lib/config.ts`) | `f045879` | review clean, 3/3 |
| 5 | Env-schema registry + `.env`-parity test | `b604752` | review clean; reviewer independently verified fixture == real `.env` keys (29/29) + zero secret leakage |
| 6 | Lossless `.env` parser/serializer | `fec3785` + fix `27c4cc0` | **review caught a Critical** (see §4), fixed, re-reviewed clean, 11/11 |
| 7 | Model-list codec | `ed42eec` | review clean, 4/4 |
| 8 | Diff + secret masking | `16ce482` + `248bec9` | Important test-gap fixed (secret add/remove masking) |
| 9 | Backup manager (timestamped + prune + restore) | `267f984` | review clean; sort/prune direction independently verified |
| 10 | Command runner + apply orchestrator | `88ace91` + fix `7a6a892` | **review caught TWO Criticals** (see §4), fixed, re-reviewed clean, 11/11 |
| 11 | Connection testers (ollama/reranker) | `890b3ce` | review clean, 4/4 |
| 12 | Auth: fail-closed gate + signed session | `9477126` | review clean; fail-closed + constant-time independently verified |
| 13 | Server routes + proxy auth guard | `01d0715` + fix `94f132d` | **Important fixed**: added server-side `validateEdits` (reject unknown keys/bad values before any write/restart) |
| 14 | shadcn primitives (copied from Ask) + login page | `592ebae` | review clean; isolation grep-verified across every copied file |
| — | Tooling fix: eslint/prettier config so lint+format work | `966fb19` | mechanical; all gates green |
| 16 | Model-list editor component | `bfd0573` | review clean; sound deviation (boundary buttons omitted, not disabled) |
| 17 | Apply bar (review diff → stream apply → backups) | `75e27fd` + fix `f87696d` | fixed a stale-state toast bug; **2 Important fixed**: streaming test coverage + fetch guards (no stuck spinner) |
| 15 | Field renderers + categorized config form + `app/page.tsx` | `bad4d2d` | review clean; secret path traced (no plaintext to client) |
| 18 | Connection-test buttons + model picker | `72efca3` | review clean; fetch guarded (no stuck spinner) |
| 19 | Dockerfile, compose, README, `.env.example` | `4318b19` | **caught 3 real Dockerfile bugs** (see §4); verified via real `docker build` + live smoke test |
| 20 | Live E2E vs a **copy** of `.env` | (verification only) | **12/12 PASS** (see §5) |
| — | Final whole-branch review (opus) | — | **MERGE** verdict |
| — | Final fix wave (2 Minors) | `9c9d0db` | apply/restore lock + unique temp name; honest model chips |
| 21 | Remove Ask's Models tab | — | **GATED on your approval** (touches live Ask) |

---

## 4. Real bugs the reviews caught (in the plan's own reference code)

These were latent defects in the implementation the plan specified — the per-task adversarial reviews found and fixed each before merge:

- **`.env` parser (Task 6, Critical):** an inline trailing comment (`KEY=value # comment`) was captured into the value. `getValue` then returned `"value # comment"`, and a read-modify-write (pre-fill form → save) re-quoted it — **corrupting the live env var**. Fixed: split inline comments out (quoted + unquoted, escape-aware); also fixed dup-key `getValue`/`toValueMap` disagreement and CRLF/trailing-newline handling.
- **Apply orchestrator (Task 10, two Criticals):** (a) an unguarded `await runner.run(...)` **threw past the status emit** on a spawn error (e.g. `docker`/`ssh` missing) — `applyPlan` rejected instead of reporting failure, and the reranker step was silently skipped. (b) Raw subprocess stderr was streamed to the client, and `docker compose`'s `.env` parser **echoes an offending line including a secret value** on a parse error → secret leak. Fixed: every step try/caught → fail-emit + `applyPlan` always resolves; a redactor strips secret values from every emitted detail before truncation.
- **Routes (Task 13, Important):** `/api/apply` and `/api/preview` did **no server-side validation** — an arbitrary key or malformed value could be written into the live `.env` and restart the stack. Fixed: `validateEdits` rejects unknown keys / validator failures with 400 before any side effect.
- **Apply bar (Task 17, two Important):** the streaming failure→error-toast path had zero test coverage (a regression would go unnoticed); and no try/catch around the fetch/stream, so a mid-stream error left the "Applying…" button **permanently disabled with no toast** (a never-resolving spinner). Fixed: guarded all four fetch flows with try/catch/finally; added streaming tests (the re-reviewer mutation-tested them by reverting the fix and confirming the test fails).
- **Dockerfile (Task 19, three real bugs):** the plan's literal Dockerfile referenced a nonexistent `public/` dir (build failure), lacked the `docker-compose-plugin` apt source (install failure), and omitted `PORT=3939` (Next standalone would silently bind 3000, not the mapped port). All fixed and verified with an actual `docker build` + smoke test.

---

## 5. Live end-to-end verification (Task 20) — 12/12 PASS

Run against a **copy** of the real `.env` (never the real one; no container was restarted; the copy was md5-identical before/after, proving nothing was applied):

- `/api/health` 200; `/api/config` **401** without a cookie; wrong password **401**; correct password **200** + `Set-Cookie`.
- `/api/config`: a non-secret key showed its **real** value; secret keys returned `""` + `secretSet:true`; the **actual real `SUPABASE_SECRET_KEY` and `RERANKER_API_TOKEN` values were grep-confirmed ABSENT** from the response body.
- `/api/preview`: correct masked diff for model edits (`targets:["ask"]`); a secret edit rendered as `••••••` with **no plaintext**; an unknown key was rejected **400** with violations.
- Fail-closed: with `MODEL_MANAGER_PASSWORD` unset, `GET /` returned **503**.

---

## 6. Final whole-branch review — verdict: MERGE (no blockers)

The opus reviewer confirmed cross-cutting: isolation holds (zero escapes + the Turbopack pin), the **secret-handling chain is airtight end-to-end** (no `console.*` anywhere; nothing leaks to client/log/event; apply-stream and rollback both redact), the apply orchestrator meets every invariant, the two Ask enabling changes are behavior-preserving, and types are coherent lib→routes→UI. 10 carried-forward Minors were triaged as safe-to-defer. Two NEW Minors were fixed in `9c9d0db`:
1. The spec promised a concurrency lock but none existed (+ pid-only temp name) → added an in-process apply/restore mutex (`lib/lock.ts`) and a `randomUUID` temp name.
2. The `/api/tags` model chips rendered as dead clickable buttons → now non-interactive info chips unless a picker handler is wired.

**Deferred Minors (non-blocking, for future polish):** `move()` bounds test; a code comment that `Change` holds raw values; backups edge-case tests; session token has no expiry (LAN-only, 24h cookie); `validateEdits` skips empty-value validation; cookie not `Secure` (LAN, no TLS); `storage` category renders an empty pane (the deployment has no storage vars); a weak enum Field test.

---

## 7. Current state & what's left (needs your go-ahead)

**Done and merge-approved** — all on branch `admin-feature`, **not pushed**, prod **untouched**.

**Remaining, gated on your approval:**
1. **Task 21 — remove Ask's read-only Models settings tab** (`components/settings-dialog.tsx`). This changes the live Ask app, so I paused per your rule. It's the payoff you described (the standalone UI supersedes it).
2. **Ship it** — per your push-to-production workflow (merge `admin-feature`→`dev`, push, rebuild/redeploy). The model-manager also needs its own one-time deploy: build its image, set `MODEL_MANAGER_PASSWORD` + the `RERANKER_SSH_*` vars, mount the `.env` + docker socket + SSH key, `docker compose up -d`. And the reranker box's live `.env` needs `RERANKER_MODEL=BAAI/bge-reranker-v2-m3` added before its next recreate (so its model is unchanged).

**⚠️ Deploy note (in the app's README):** the model-manager container has rw access to Ask's `.env`, the host Docker socket, and an SSH key to nightfuryS — together effectively **root on the host**. Run it **LAN-only, behind the password, never internet-exposed**.
