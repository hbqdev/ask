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
- `deploy.sh` — push both files to all hosts. The service is **enabled only on
  bare metal** (.231); on WSL hosts (.17, .160, .171) it is left **disabled**.

> **Never enable anything that waits for Docker into `multi-user.target` on a
> WSL host.** Docker Desktop attaches its WSL integration only after systemd
> reports boot finished, so such a unit deadlocks the boot: it waits for a
> Docker that is waiting for it (Serenity .171, 2026-09-29 — "Bootup is not yet
> finished" for 8 min, Docker never came up). On WSL hosts `fleet-boot.timer`
> (75 s after boot) pulls `ask-fleet-boot.service` in via `Wants=`/`After=`, so
> it still runs every boot — after boot finishes. Check:
> `systemctl is-enabled ask-fleet-boot.service` → `disabled` on .17/.160/.171,
> `enabled` on .231; `systemctl show ask-fleet-boot.service -p WantedBy` on a
> WSL host lists only `fleet-boot.service`.

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

Deployed to all four hosts; enabled at boot only on .231 (bare metal). On the WSL hosts it runs via `fleet-boot.timer` after boot (see the warning above; changed 2026-09-29).

## Weekly sidecar image updates

- `update-images.sh` — pulls newer sidecar images (postgres/redis/searxng/
  gluetun/kokoro; never the source-built app image) for one stack or all,
  recreates via the VPN overlays, health-checks and verifies VPN egress, then
  reclaims space. Stacks: `ask-lab`, `ask-prod`, `ask-staging` (each from its
  own worktree), `degoog`, `public-searxng`. For an Ask stack, if any sidecar
  container changed it also `docker restart`s the app (keeps its networks) and
  verifies the search path's Redis via the token-gated
  `GET /api/advanced-search` probe, run inside the app container — since
  2026-09-27, when a recreated redis wedged the running app's clients and
  every first search hung while the homepage still answered 200.
- `update-ask.sh` + `fleet-update-ask.{service,timer}` — on NightFuryX (.17),
  Sundays 04:30: runs `update-images.sh` for `ask-lab` (canary), `ask-prod`,
  `ask-staging`. Logs to `/home/nightfury/selfhosted/logs/update-ask.log`.
- `update-public-search.sh` + `fleet-update-public-search.{service,timer}` —
  the public stacks on .231.
