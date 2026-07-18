# model-manager

A small standalone Next.js app for managing Ask's `.env` configuration from a
web UI: view/edit env vars, write changes with an automatic backup, and
restart the `ask` service. It also supports cross-host management of the
`reranker` container over SSH.

## ⚠️ Privilege warning — read before deploying

This container is granted, by design:

- **Read-write access to Ask's `.env`** (`/home/nightfury/selfhosted/ask/.env`)
- **The host Docker socket** (`/var/run/docker.sock`)
- **An SSH private key** used to reach `nightfuryS` (the reranker host)

Put together, these are **effectively root on the host**: write access to the
Docker socket lets a container start arbitrary containers with arbitrary
mounts (including `/`), and the SSH key grants access to another machine on
the network. There is no meaningful sandbox around this app's capabilities.

**Because of this:**

- Run it **only on the trusted host** (the same machine that runs Ask) — never
  on a shared or untrusted host.
- Keep it **LAN-only**. Do not port-forward, tunnel, or otherwise expose it
  to the public internet. There is no rate limiting or additional hardening
  beyond the password gate below.
- It is gated by `MODEL_MANAGER_PASSWORD` (see **Fail-closed** below) — treat
  that password with the same care as root credentials for the host, and set
  it to something you wouldn't mind protecting the whole machine.
- Do not add reverse-proxy exposure, Cloudflare tunnels, or similar without
  first adding real authentication/authorization on top of the single shared
  password.

If you don't need cross-host reranker management, leave the `RERANKER_SSH_*`
variables unset (see below) — the SSH key mount is still present but the
feature that uses it is disabled in the UI.

## Fail-closed behavior

If `MODEL_MANAGER_PASSWORD` is unset, the app refuses to serve normal
requests and responds with **HTTP 503** instead of falling back to an
unauthenticated or default-credentialed state. There is no way to run this
tool without setting a password.

## Setup

1. Copy the example env file and fill it in:

   ```bash
   cd selfhosted/model-manager
   cp .env.example .env
   ```

2. Set a strong `MODEL_MANAGER_PASSWORD` in `.env` (required — see
   **Fail-closed** above). Optionally set `MODEL_MANAGER_SESSION_SECRET`;
   if left unset it is derived from the password.

3. If you want cross-host reranker management, set `RERANKER_SSH_TARGET`,
   `RERANKER_REMOTE_DIR`, and (if needed) override `RERANKER_SSH_KEY`,
   `RERANKER_ENV_FILE`, `RERANKER_SERVICE`. Otherwise leave them blank.

4. Provide the SSH private key that `docker-compose.yaml` mounts into the
   container. By default it looks for `./keys/nightfurys` on the host
   (override the host-side path with `RERANKER_SSH_KEY_HOST` if your key
   lives elsewhere). Make sure the key file has restrictive permissions
   (`chmod 600`).

5. Build and start:

   ```bash
   docker compose up -d
   ```

   The UI is served on `http://<host>:${MODEL_MANAGER_PORT:-3939}`.

6. Log in with `MODEL_MANAGER_PASSWORD`.

## What it mounts and why

| Mount                                                                                  | Purpose                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/home/nightfury/selfhosted/ask/.env` → `/ask/.env` (rw)                               | Read and write Ask's live configuration.                        |
| `/home/nightfury/selfhosted/ask/docker-compose.yaml` → `/ask/docker-compose.yaml` (ro) | Know how to recreate the `ask` service after an env change.     |
| `/home/nightfury/selfhosted/ask` → `/ask/context` (ro)                                 | Read-only context for the Ask repo (e.g. for validation).       |
| `/var/run/docker.sock`                                                                 | Run `docker compose up -d ask` on the host to apply changes.    |
| SSH key → `/keys/nightfurys` (ro)                                                      | Reach `nightfuryS` to manage the `reranker` container remotely. |

## Configuration reference

See [`.env.example`](./.env.example) for the full list of environment
variables (`MODEL_MANAGER_PASSWORD`, `MODEL_MANAGER_PORT`, `ASK_ENV_PATH`,
`ASK_COMPOSE_FILE`, `ASK_SERVICE`, `MODEL_MANAGER_BACKUP_KEEP`, and the
`RERANKER_SSH_*` cross-host variables).

## Development

```bash
bun install
bun dev        # http://localhost:3939
bun run build
bun run test
bun run typecheck
```

This app is fully standalone: it does not import from or depend on the
parent Ask application's code, even though it manages Ask's configuration
at runtime.
