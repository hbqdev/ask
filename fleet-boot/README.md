# fleet-boot

Reboot hardening for the Ask GPU fleet. A single host-aware script plus a
systemd `oneshot` unit, deployed to each WSL2 GPU box, that on boot:

- **reconciles** the box's compose service(s) onto a fresh Docker network —
  fixes the WSL "network … not found" that `restart: unless-stopped` can't
  recover from (it recreates a container _only_ if it isn't running after
  `compose up -d`, so a healthy service is never reloaded), and
- **warms** the GPU-resident Ollama model with a `keep_alive=-1` request so the
  first real request isn't a cold load (Ollama does not preload on boot).

## Per host

| Host       | IP             | Boot actions                                               |
| ---------- | -------------- | ---------------------------------------------------------- |
| NightFuryX | 192.168.50.17  | reconcile `reranker-qwen` + `ingestor`, warm `qwen3-vl:4b` |
| NightFuryS | 192.168.50.160 | reconcile `embedder` (preloads its own model)              |
| Serenity   | 192.168.50.171 | warm `granite4.2:8b`                                       |

## Files

- `ask-fleet-boot.sh` — the boot script (source of truth). Deployed to
  `/home/nightfury/ask-fleet-boot.sh` on each host.
- `ask-fleet-boot.service` — systemd oneshot, `WantedBy=multi-user.target`,
  runs as `nightfury`. Deployed to `/etc/systemd/system/` on each host.
- `deploy.sh` — push both files to all hosts and enable the service.

## Usage

```sh
# edit ask-fleet-boot.sh, then re-push to all boxes:
./deploy.sh

# push AND trigger it once now (prints each host's journal):
./deploy.sh run
```

Check / run manually on a host:

```sh
ssh nightfury@192.168.50.17 sudo systemctl start ask-fleet-boot.service
ssh nightfury@192.168.50.17 journalctl -u ask-fleet-boot.service -n 20 -o cat
```

Already deployed and enabled on all three hosts (2026-07-21).

## Weekly sidecar image updates

- `update-images.sh` — pulls newer sidecar images (postgres/redis/searxng/
  gluetun/kokoro; never the source-built app image) for one stack or all,
  recreates via the VPN overlays, health-checks and verifies VPN egress, then
  reclaims space. Stacks: `ask-lab`, `ask-prod`, `ask-staging` (each from its
  own worktree), `degoog`, `public-searxng`.
- `update-ask.sh` + `fleet-update-ask.{service,timer}` — on NightFuryX (.17),
  Sundays 04:30: runs `update-images.sh` for `ask-lab` (canary), `ask-prod`,
  `ask-staging`. Logs to `/home/nightfury/selfhosted/logs/update-ask.log`.
- `update-public-search.sh` + `fleet-update-public-search.{service,timer}` —
  the public stacks on .231.
