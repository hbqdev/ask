# Relocate the Ask stacks to NightFuryX — design

**Date:** 2026-08-22
**Status:** Design (pending plan)

## Goal

Move all three Ask stacks (prod, staging, lab) off **MiniNightFury** (192.168.50.231, "here") onto **NightFuryX** (192.168.50.17). crawl4ai, public SearXNG, public degoog, and the cloudflared tunnel daemon stay on MiniNightFury. Downtime during cutover is acceptable.

## Motivation (from the 2026-08-22 survey)

- **MiniNightFury is memory-saturated:** 31Gi RAM, ~340Mi free, **swap 100% full**, 54 containers, load ~5-7/16 threads. Handling it, but zero headroom (OOM risk).
- **NightFuryX is idle and far larger:** Threadripper 3970X (**64 threads**), **117Gi RAM (115Gi free)**, load ~0.00, 945G free disk.
- **Ask's ML backends already live on NightFuryX:** `ask-whisper` (STT), `reranker-qwen`, `ingestor`. Today Ask calls them over the LAN; after the move they become **local** calls — a latency win for STT/rerank/embeddings.

## Locked decisions

- **crawl4ai stays on MiniNightFury.** Its work is single-thread / tail-latency bound ([[crawl4ai-parallelism-ceiling]]) and MiniNightFury's Alder Lake P-cores are faster single-thread than NightFuryX's Zen2 cores. Ask reaches it as a sub-ms LAN call. Its memory-watchdog + cgroup-cap ([[crawl4ai-cgroup-blind]]) stay as-is.
- **TTS (ask-tts, Kokoro) moves to NightFuryX, pinned to the Quadro P2200** (GPU 1, UUID `GPU-7b3c2a28-e2ae-9cd4-2e25-7e7d164548c9`, 5GB) — a dedicated GPU, isolated from the 2080 Ti that whisper/reranker/ingestor share. (Today ask-tts runs CPU-only on MiniNightFury, which has no NVIDIA GPU — so this is also a TTS speedup.)
- **Public SearXNG + public degoog stay on MiniNightFury** — standalone public services, not Ask.
- **Cloudflared stays on MiniNightFury** (host process). The tunnel ingress is repointed to NightFuryX — **this is a USER action** (the user reconfigures the tunnel post-migration).
- **Downtime OK** → simple `pg_dump`→restore + cutover per env; **order lab → staging → prod**; old stacks kept **stopped-but-intact** on MiniNightFury for instant rollback.

## Topology

| Component | Before (.231) | After |
|---|---|---|
| Ask app ×3 (prod/staging/lab) | .231 | **.17** |
| per-env searxng + gluetun | .231 | **.17** |
| per-env postgres + redis | .231 | **.17** (data migrated) |
| degoog-lab/staging/prod | .231 | **.17** |
| model-manager | .231 | **.17** |
| ask-tts (Kokoro) | .231 (CPU) | **.17 (P2200 GPU)** |
| whisper / reranker / ingestor | .17 (already) | .17 (now local to Ask) |
| crawl4ai | .231 | **.231 (stays)** |
| public searxng / public degoog | .231 | **.231 (stays)** |
| cloudflared | .231 | .231 (ingress repointed → .17) |

## What moves (containers)

Per env (×3): `ask[-env]` app, `ask-searxng[-env]`, `ask-gluetun[-env]`, `ask-postgres[-env]`, `ask-redis[-env]`. Plus `degoog-lab/staging/prod` (+ their valkey), `model-manager`, `ask-tts` (+ `ask-tts-lab`). State to migrate = the 3 `ask-postgres-data*` volumes only (~114/136/117 MB); redis/searxng volumes are cache (rebuild).

## Mechanics

1. **`.env` service-URL rewrites (per env)** — the crux. On NightFuryX:
   - whisper / reranker / ingestor URLs → **localhost** (were 192.168.50.17) — now co-located.
   - TTS URL → **local** (Kokoro on .17/P2200).
   - **crawl4ai URL → `http://192.168.50.231:<port>`** (crawl4ai stays on MiniNightFury) — was localhost.
   - Everything else (DB creds, VPN creds, API keys, model lists) copied verbatim.
2. **Postgres migration** — `pg_dump` on MiniNightFury → restore into the new NightFuryX postgres per env. Small DBs → seconds. Do it as the cutover step (dump the live DB right before flipping traffic) so no writes are lost.
3. **gluetun VPN** — the wireguard creds (in each `.env`) run gluetun on NightFuryX. Same LAN → same egress public IP, so the provider should accept it. Verify the tunnel is up + the searxng/degoog egress IP is the VPN's before serving.
4. **GPU pinning (TTS → P2200)** — in ask-tts's compose on NightFuryX, reserve the P2200 by UUID (`deploy.resources.reservations.devices: [{driver: nvidia, device_ids: ["GPU-7b3c2a28-e2ae-9cd4-2e25-7e7d164548c9"], capabilities: [gpu]}]`) so Kokoro never touches the 2080 Ti. Verify via the WSL `nvidia-smi` that Kokoro loads on the P2200.
5. **Ports + reachability** — bind the same host ports on NightFuryX (3738 prod, 3739 staging, 3742 lab, etc.). NightFuryX already serves whisper/reranker on the LAN, so LAN reachability works.
6. **Cloudflare tunnel** — cloudflared stays on MiniNightFury; its ingress rules repoint `ask.hbqnexus.win` (+ staging/lab hostnames) from `localhost:<port>` to `http://192.168.50.17:<port>`. **USER action** post-migration.

## WSL2 considerations (NightFuryX runs Linux under WSL2, GPU-PV)

- GPUs are paravirtualized (Microsoft GPU-PV); `nvidia-smi` is at `/usr/lib/wsl/lib/nvidia-smi`. Per-GPU pinning by UUID works (whisper/reranker already pin the 2080 Ti).
- **Boot resilience must be verified:** on a Windows/WSL2 reboot, WSL2 + Docker + the containers must come back. The existing ML services use `restart: unless-stopped`; confirm WSL2 auto-starts on Windows boot and Docker starts with it (else the whole Ask fleet is down after a Windows update/reboot). This is the single biggest operational risk of the target and must be nailed before prod cutover.
- LAN reachability of `192.168.50.17:<port>` from cloudflared (.231) already proven for whisper/reranker.

## Order, verification, rollback

- **Lab first** (full rehearsal), then **staging**, then **prod** (last, briefest window).
- Per env: deploy on NightFuryX → migrate DB → verify (app up on the port, VPN egress correct, whisper/rerank/TTS/crawl4ai reachable, a real query end-to-end, voice) → then the tunnel repoint (prod).
- **Rollback:** the old stack stays stopped-but-intact on MiniNightFury; revert = repoint the tunnel back + `up -d` the old stack. Keep the old DBs until the new home is proven over a few days.

## Risks

- **WSL2 boot autostart** (above) — highest.
- **VPN egress from NightFuryX** — verify the provider accepts gluetun from the new host before trusting search.
- **GPU/VRAM** — TTS on the dedicated P2200 avoids 2080 Ti contention; verify Kokoro fits in 5GB.
- **DB cutover write-loss** — dump at cutover (after quiescing writes / accepting the brief window).

## Non-goals

Not moving crawl4ai or the public services; not changing app code; not true zero-downtime (a brief cutover window is accepted); not consolidating the 3 envs.
