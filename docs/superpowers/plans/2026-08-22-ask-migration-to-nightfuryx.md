# Ask → NightFuryX Migration Runbook

> **For agentic workers:** this is an OPS RUNBOOK, not a TDD code plan. Each task is a phase with concrete commands, a verification gate, and a rollback. Do phases in order; do NOT start prod (Phase 4) until lab (Phase 2) + staging (Phase 3) are verified. Steps use `- [ ]`.

**Goal:** Relocate all 3 Ask stacks (prod/staging/lab) from MiniNightFury (192.168.50.231) to NightFuryX (192.168.50.17). crawl4ai, public SearXNG, public degoog, cloudflared stay on .231.

**Spec:** `docs/superpowers/specs/2026-08-22-ask-migration-to-nightfuryx-design.md`

## Global Constraints
- **Downtime OK**, but keep prod's window short; **order: lab → staging → prod**.
- **Old stacks on .231 are stopped-but-intact until the new home is proven** (rollback = restart old + repoint tunnel). Keep old DBs ≥ a few days.
- **Author = Tin Tran**, no AI attribution on any commit.
- **NightFuryX is WSL2** (GPU-PV): `nvidia-smi` at `/usr/lib/wsl/lib/nvidia-smi`; pin GPUs by UUID.
- **The Cloudflare tunnel repoint is a USER ACTION** (Phase 5) — do not attempt it; surface it.

## Topology after migration (accurate call map for Ask@.17)
- **Local on .17:** whisper (:8788), reranker (:8787), TTS (Kokoro on the **P2200**), **Ollama (:11434 — already running on .17; it's a Cloud proxy so inference is Ollama Cloud regardless)**, each env's own searxng+postgres+redis+gluetun.
- **Remote LAN:** crawl4ai `.231:11235` (newly remote — negligible, crawl-bound), embeddings `.160:8788` (unchanged), secondary LLM `.171:11434` (unchanged).
- crawl4ai reference changes from container-name → LAN IP (Phase 0.1); Ollama URLs repoint to .17 (Phase 1.2), which requires .17's Ollama to be Cloud-authed (Phase 0.7).

## Per-env facts
| env | worktree (.231) | branch | project | app port | notes |
|---|---|---|---|---|---|
| prod | ask-prod | dev | ask-stack | 3738 | public via tunnel |
| staging | ask | admin-feature | ask-stack-admin-feature | 3739 (gluetun UI 3740) | |
| lab | ask-flow | flow-design | ask-stack-lab | 3742 | rehearsal target |

DB: postgres user `morphic`, db `morphic` (per env, separate volume). TTS P2200 UUID: `GPU-7b3c2a28-e2ae-9cd4-2e25-7e7d164548c9`.

---

## Phase 0 — Pre-flight (no downtime; both hosts)

- [ ] **0.1 crawl4ai LAN reachability from .17.** On .231 confirm crawl4ai publishes 11235 to the LAN: `docker inspect crawl4ai --format '{{json .NetworkSettings.Ports}}'`. If 11235 is NOT published (only on the internal network), add `ports: ["11235:11235"]` to `crawl4ai/docker-compose.yaml`, `docker compose -p crawl4ai up -d`, and commit. Then from .17: `curl -fsS http://192.168.50.231:11235/health` (or the crawl4ai health path) → expect 200. **This must pass before any env cutover** (Ask@.17 needs it).
- [ ] **0.2 NightFuryX readiness.** `ssh nightfury@192.168.50.17`: `docker version`; `df -h /` (≥50G free — have 945G); `/usr/lib/wsl/lib/nvidia-smi -L` shows the 2080 Ti + **P2200** + 1070; confirm reranker/whisper/ingestor healthy.
- [ ] **0.3 WSL2 boot posture (THE key risk).** Determine what brings the existing .17 containers back after a Windows reboot: is WSL2 set to auto-start (Windows Task Scheduler / `wsl.exe` on logon / `systemd` enabled in `/etc/wsl.conf`), and does Docker start with it? Document the exact mechanism. If the Ask fleet would NOT survive a Windows reboot, fix that (enable docker.service in WSL systemd, ensure WSL auto-starts) BEFORE prod. Test with a real WSL restart during lab (Phase 2.6).
- [x] **0.4 VPN cred staged on .17 (2026-08-23).** The account-wide Ask Mullvad WireGuard cred (`MULLVAD_PRIVATE_KEY`/`ADDRESSES`/`COUNTRY` — identical across all 3 ask stacks, hash `8e4dc450…`) is copied to `/home/nightfury/selfhosted/ask-mullvad-wg.env` on .17 (0600, hash-verified). degoog uses a SEPARATE key (`6dce3090…`) — moves with the degoog-* stacks. Still to verify at Phase 2: gluetun on .17 actually gets the VPN's public IP (same LAN → same provider POP).
- [ ] **0.5 Get the code onto .17.** Clone the repo on .17 and create the three checkouts mirroring .231's worktrees (dev, admin-feature, flow-design). Match the paths the compose/scripts assume, or set the corresponding env/paths. Record the chosen layout (e.g. `/home/nightfury/selfhosted/ask{,-flow,-prod}` on .17 too).
- [ ] **0.6 Snapshot current state for rollback proof.** On .231: `docker ps` list + `git -C ask-prod rev-parse HEAD` (all 3) recorded; note current tunnel ingress config path.
- [x] **0.7 Ollama Cloud auth on .17 — VERIFIED DONE (2026-08-23).** .17's ollama (daemon user `ollama`, v0.32.1) is already signed into Ollama Cloud and serves Ask's `*:cloud` models — tested end-to-end: `POST .17:11434/api/generate {model:"deepseek-v4-flash:cloud"}` returned a response. No action needed for the cloud side. (Note: newer ollama stores the signin under the `ollama` service user and does NOT pre-list `:cloud` models in `ollama list` — the API test is the real check, not the list.) So `OLLAMA_BASE_URL → .17:11434` is safe.
- [x] **0.8 granite stays on Serenity — DECIDED.** Serenity (.171) has a **Quadro P5000 (16GB)** and runs `granite4.1:8b` **100% on GPU** (~11GB with 16k context). GPU-over-LAN beats .17 CPU (LAN adds ~ms per request, not per token), and no .17 GPU fits granite anyway (it needs ~11GB; the 2080 Ti/P2200/1070 free VRAM are all far below that, and the 1070 is the vision fallback). So `LOCAL_LLM_BASE_URL` stays `http://192.168.50.171:11434`; Serenity is retained as the granite GPU box (NOT retired). No granite move, no change to Serenity.

---

## Phase 1 — Prepare per-env config on .17 (no downtime; nothing serving yet)

For EACH env (do lab fully first as the rehearsal, then staging, then prod):

- [ ] **1.1 Copy `.env`** from the .231 worktree to the matching .17 checkout (over a secure copy — it holds VPN creds + API tokens). Do NOT commit `.env` (gitignored).
- [ ] **1.2 Apply `.env` rewrites:**
  - `CRAWL4AI_URL=http://crawl4ai:11235` → **`http://192.168.50.231:11235`**.
  - `OLLAMA_BASE_URL`, `CLASSIFIER_OLLAMA_BASE_URL`, `NEXT_PUBLIC_OLLAMA_BASE_URL` → **.17's ollama** (`http://192.168.50.17:11434`) — it's a Cloud proxy (see 0.7), so this just moves the proxy local. (`NEXT_PUBLIC_*` is a LAN URL used client-side; keep it a reachable .17 address.)
  - `LOCAL_LLM_BASE_URL` stays `http://192.168.50.171:11434` (Serenity/P5000 GPU-runs granite — see 0.8; faster than any .17 option). Unchanged.
  - Leave `RERANKER_URL=192.168.50.17:8787`, `EMBEDDING_SERVICE_URL=192.168.50.160:8788`, `LOCAL_LLM_BASE_URL=192.168.50.171:11434` unchanged.
  - `SEARXNG_API_URL=http://ask-searxng...:8080` stays (searxng moves with the stack, same network).
- [ ] **1.3 Apply compose rewrites** (these live in `docker-compose.yaml`, committed): `WHISPER_SERVICE_URL` (=`192.168.50.17:8788`) and `TTS_SERVICE_URL` — after the move these are local; keep the IP (`192.168.50.17`) which still resolves on .17, or switch to the container/localhost. **TTS: add a GPU reservation pinning the P2200:**
  ```yaml
  # ask-tts service (on .17)
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            device_ids: ["GPU-7b3c2a28-e2ae-9cd4-2e25-7e7d164548c9"]
            capabilities: [gpu]
  ```
  Ensure Kokoro is configured for CUDA. These compose edits are env-specific for the .17 deploy — decide whether to commit them on a `.17` overlay or keep local; do NOT push changes that would break the .231 stacks if rolled back.
- [ ] **1.4 Ports:** confirm the .17 compose binds the same host ports (3738/3739/3742 + gluetun 3740/3741). No collisions on .17 (only whisper/reranker/ingestor there today).

---

## Phase 2 — Migrate LAB (rehearsal; downtime on lab only)

- [ ] **2.1 Build/pull on .17:** from the lab checkout, `docker compose -p ask-stack-lab -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml build ask` (+ pull the rest). Do NOT `up` the app yet.
- [ ] **2.2 Bring up infra (postgres/redis/searxng/gluetun/tts/degoog-lab/model-manager)** on .17 via `up -d` for those services (app last).
- [ ] **2.3 Migrate the lab DB:** on .231 `docker exec ask-postgres-lab pg_dump -U morphic -Fc morphic > /tmp/ask-lab.dump`; copy to .17; `docker exec -i ask-postgres-lab pg_restore -U morphic -d morphic --clean --if-exists < /tmp/ask-lab.dump` (into the fresh .17 postgres). Verify row counts (chats/users) match.
- [ ] **2.4 Start the app** on .17 (`up -d ask`); boot runs `bun migrate` (should be a no-op — same schema).
- [ ] **2.5 Verify lab end-to-end** (browser to `http://192.168.50.17:3742`): app loads; a real search query returns a cited answer (proves Ollama@.231 + crawl4ai@.231 + searxng + reranker@.17 + embeddings@.160 all reachable); voice read-aloud works (TTS on P2200 — confirm via WSL `nvidia-smi` that Kokoro loaded on the P2200); check `unresponsive_engines`/logs for VPN egress correctness. Console clean.
- [ ] **2.6 WSL reboot test:** restart WSL/Docker on .17 and confirm the lab stack (and whisper/reranker) all come back automatically (validates Phase 0.3). If not, fix autostart before proceeding.
- [ ] **2.7 Stop the OLD lab stack on .231** (`docker compose -p ask-stack-lab ... stop`) — do NOT remove volumes. Lab now lives on .17.
- **Rollback:** if any gate fails, `up -d` the old lab on .231; investigate on .17 without time pressure.

---

## Phase 3 — Migrate STAGING (repeat Phase 2 for admin-feature)

- [ ] **3.1–3.7:** same as Phase 2 with project `ask-stack-admin-feature`, the admin-feature overlays, ports 3739/3740, DB `ask-postgres-admin-feature`, verify at `http://192.168.50.17:3739`. Stop the old staging on .231 after verify.

---

## Phase 4 — Migrate PROD (short window)

- [ ] **4.1** Pre-stage: build + bring up prod infra on .17 (postgres/redis/searxng/gluetun/tts) ahead of time, app not yet serving public traffic.
- [ ] **4.2 Cutover window (brief):** stop writes to prod (stop the old `ask` app on .231 so no new chats land mid-dump) → `pg_dump -U morphic -Fc morphic` of `ask-postgres` → restore into .17 prod postgres → `up -d ask` on .17 → verify at `http://192.168.50.17:3738` (query e2e + voice + sources, console clean, VPN egress correct).
- [ ] **4.3 Keep the old prod stack STOPPED (not removed) on .231** for rollback.

---

## Phase 5 — Public cutover — **USER ACTION (reminder)**

The tunnel serves **ONLY prod's public DNS** (`ask.hbqnexus.win`). Staging + lab are LAN-only — accessed directly at `192.168.50.17:3739` / `:3742`, so they need **no DNS change**. The user does this switchover after everything is moved + verified.

- [ ] **5.1 >> USER: switch over the Cloudflare tunnel** — repoint ONLY the prod ingress (`ask.hbqnexus.win`) from `.231`'s `localhost:3738` to **`http://192.168.50.17:3738`** and reload cloudflared (it stays on .231; only the ingress target changes).
- [ ] **5.2 Verify public** `https://ask.hbqnexus.win` serves from .17 (login, a query, voice). Confirm the test account works ([[ask-test-account]]).
- **Rollback (fast):** repoint the tunnel back to .231 + `up -d` the old prod stack.

---

## Phase 6 — Soak + decommission

- [ ] **6.1** Soak 2–3 days; watch .17 resource use + Ask logs; confirm no regressions (recall/rerank/voice/search).
- [ ] **6.2** Reclaim on .231: the freed ~4GB relieves memory pressure; run `fleet-boot/reclaim-space.sh`.
- [ ] **6.3** After soak, remove the old Ask stacks + volumes on .231 (`docker compose -p ... down -v` per env) — ONLY once .17 is trusted and the DBs are confirmed migrated. Update `fleet-boot/update-images.sh` + any fleet scripts for the new host layout.
- [ ] **6.4** Update memory: [[ask-architecture-map]] deploy topology, [[fleet-topology-and-ssh]], and the audit log.

---

## Open items to resolve during execution (not blockers)
- Exact `DATABASE_URL` / `DATABASE_RESTRICTED_URL` per env (masked) — confirm they point at the local postgres (should need no change; they use the container/service name).
- Whether to commit the `.17` compose GPU/URL tweaks on an overlay vs keep local (avoid breaking .231 rollback).
- crawl4ai 11235 LAN publish (Phase 0.1) is the one change to .231.

## Self-review
- **Spec coverage:** every locked decision (crawl4ai stays, TTS→P2200, public stay, downtime-OK, lab→staging→prod, tunnel=user) maps to a phase. ✓
- **Accuracy fix vs spec:** co-location is narrower than first stated — only whisper+reranker become local; Ollama+crawl4ai become LAN-remote (negligible). Captured in the topology map. ✓
- **Rollback** present per phase; old stacks + DBs retained. ✓
