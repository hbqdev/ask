# Authoring the Ask architecture docs

This site is the **handover documentation** for Ask. Audience: a human engineer who
must understand, operate and extend Ask **without any AI assistant**. Write for them.

Run it: `cd docs-site && bun install && bun run docs:dev` (live-reload editing) or
`bun run docs:build && bun run docs:preview`. Containerised: `docker compose -p ask-docs up -d --build` → http://<host>:3750.
Regenerate the code-derived reference data: `bun run gen` (see `scripts/gen/`).

## Page map (fixed)

All pages are Markdown under `docs-site/docs/`. Paths are fixed — link to them with
root-relative links without the `.md` extension, e.g. `[streaming](/request-lifecycle/streaming)`.

| Section | Page | Covers |
|---|---|---|
| Home | `index.md` | What Ask is, how to navigate, interactive system map |
| Getting started | `getting-started/overview.md` | Product, stack, mental model, the 10-minute tour |
| | `getting-started/local-dev.md` | Toolchain, running each env, commands, env files |
| | `getting-started/repo-tour.md` | Directory-by-directory map of the repo |
| Operations | `operations/environments.md` | Lab / staging / prod: worktrees, branches, compose projects, ports |
| | `operations/deploy.md` | Lab-first → cherry-pick → rebuild → reclaim; rollback |
| | `operations/runbooks.md` | Incident playbooks (reboot, VPN/search down, crawl4ai, Ollama, disk…) |
| | `operations/testing-qa.md` | Tests, known failures, lab A/B method, mobile/browser QA |
| | `operations/telemetry.md` | `[latency]` lines, `latency:log`, how to diagnose slowness |
| Infrastructure | `infrastructure/fleet.md` | Hosts, GPUs, what runs where |
| | `infrastructure/services.md` | Every service: host, port, auth, role, config |
| | `infrastructure/security.md` | Threat model, auth/RLS, SSRF guard, signed URLs, known exposures |
| | `infrastructure/data-layer.md` | Postgres (schema, RLS, roles, migrations), Redis keys |
| Request lifecycle | `request-lifecycle/chat-turn.md` | One chat turn end-to-end (interactive walkthrough) |
| | `request-lifecycle/streaming.md` | SSE, resumable streams, Stop, abort reasons, persistence |
| | `request-lifecycle/client-state.md` | useChat, new-chat pushState flow, sidebar, refresh invariants |
| | `request-lifecycle/frontend.md` | Component map, homepage, mobile layout, citations UI |
| Search | `search/pipeline.md` | Search modes, source tiers, crawl, rerank, excerpting, caps |
| | `search/models-reasoning.md` | Model roster, classifier, reasoning control, narration stripping |
| Knowledge | `knowledge/rag-uploads.md` | Uploads, ingestor, doc/URL RAG, context budget, signed URLs |
| | `knowledge/memory-recall.md` | Long-term memory, conversation recall, embeddings, rerank |
| | `knowledge/media.md` | Image generation, voice (TTS/STT), weather, Discover |
| Reference (generated) | `reference/env-flags.md` | `<EnvFlags />` — every env var, where read, default |
| | `reference/api-routes.md` | `<ApiRoutes />` — every route, methods, auth |
| | `reference/database.md` | `<DbSchema />` — tables, columns, RLS |
| | `reference/compose-services.md` | `<ComposeServices />` — services per env |
| History | `history/decisions.md` | Decision records incl. negative results (what NOT to retry) |
| | `history/known-issues.md` | Open issues, gotchas, pre-existing test failures |
| | `history/changelog.md` | Condensed timeline of significant changes |
| | `history/glossary.md` | Terms |

## Conventions

- **Verify against code.** Every non-trivial claim should be checkable. Cite code as
  `` `lib/streaming/create-chat-stream-response.ts:412` `` (repo-relative path, optional line).
  If you can't verify something, say so: *(unverified)*.
- **Explain WHY**, not just what. Include the reason a design exists and what breaks if it's changed.
  Add "How to change X" recipes where useful.
- **Diagrams:** fenced ```` ```mermaid ```` blocks (flowchart / sequenceDiagram / erDiagram).
- **Callouts:** `::: tip`, `::: warning`, `::: danger` … `:::` (VitePress containers).
- **Neutral voice.** Third person / imperative. No "I", no references to AI assistants,
  subagents, or chat sessions. Commit hashes are fine as evidence.
- **Front matter:** each page starts with `---\ntitle: <Title>\n---`.
- **Components** (registered globally, usable in any page): `<SystemMap />`, `<TurnWalkthrough />`,
  `<EnvFlags />`, `<ApiRoutes />`, `<DbSchema />`, `<ComposeServices />`.

## Safety rules (non-negotiable)

- **Never write a secret value** (tokens, keys, passwords, connection strings with credentials,
  private keys) into any page or generated data file. Names of variables are fine; values are not.
- Generated data must redact any value whose name matches `KEY|TOKEN|SECRET|PASSWORD|PRIVATE|DSN|DATABASE_URL`.
- Infrastructure detail (LAN IPs, ports) is fine — this site is served on the LAN only.
