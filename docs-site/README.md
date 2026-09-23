# Ask — Architecture & Handover docs site

A [VitePress](https://vitepress.dev) site that documents how Ask is built, deployed
and operated. It lives inside the Ask repo so every branch/worktree documents itself;
it is **not** part of the Ask app (excluded from the app's tsconfig, ESLint, Vitest,
Prettier and Docker build context).

Writing content? Read [`AUTHORING.md`](./AUTHORING.md) first — page map, conventions,
safety rules.

## Layout

| Path | What |
|---|---|
| `docs/` | Markdown pages (`srcDir`). The page map is fixed — see AUTHORING.md. |
| `docs/reference/*.md` | Thin wrappers around the generated-data components. |
| `.vitepress/config.mts` | Site config: nav, sidebar (mirrors the page map), local search, Mermaid. |
| `.vitepress/theme/` | Theme extension + the interactive components (registered globally). |
| `data/*.json` | Data the components render. `env`, `api-routes`, `db-schema`, `compose-services` are **generated**; `system-map` and `turn-steps` are **hand-written**. |
| `scripts/gen/` | The generators (`bun run gen`). |
| `scripts/check-links.ts` | Dead-link checker used by `bun run check`. |
| `Dockerfile`, `Dockerfile.dockerignore`, `docker-compose.yaml` | Container build (nginx). |

## Commands (run in `docs-site/`)

```sh
bun install            # once
bun run docs:dev       # live-reload dev server on 0.0.0.0:5173
bun run gen            # regenerate data/{env,api-routes,db-schema,compose-services}.json from the repo
bun run docs:build     # static build → .vitepress/dist
bun run docs:preview   # serve the build on 0.0.0.0:3750
bun run check          # build + fail on dead internal links / anchors / data-file links
```

`bun run check` fails on: internal links to missing pages, links to missing `#anchors`,
`link` fields in `data/system-map.json` / `data/turn-steps.json` that don't resolve, and
system-map edges that reference unknown nodes. Missing `code` paths in
`turn-steps.json` are warnings (line numbers drift).

## Generated reference data

The generators read the repository at `..` (never a real `.env` file) and write
deterministic JSON — commit the result after `bun run gen`.

| File | Source | Generator |
|---|---|---|
| `data/env.json` | `process.env.X` reads in `app/ lib/ components/ hooks/ config/ instrumentation* next.config* proxy.ts` (tests excluded), every `docker-compose*.yaml`, `.env*.example` | `scripts/gen/env.ts` |
| `data/api-routes.json` | `app/**/route.ts` | `scripts/gen/api-routes.ts` |
| `data/db-schema.json` | `lib/db/schema.ts` via drizzle `getTableConfig`, `drizzle/*.sql` | `scripts/gen/db-schema.ts` |
| `data/compose-services.json` | `docker-compose*.yaml` (base + overlays) | `scripts/gen/compose.ts` |

**Redaction:** any variable whose name matches
`KEY|TOKEN|SECRET|PASSWORD|PRIVATE|DSN|DATABASE_URL|DATABASE_*URL|CREDENTIAL…`
is emitted as `(secret — not shown)`, and so is any value that carries URL credentials
(`scheme://user:pass@`), a PEM block or a long opaque token. See `scripts/gen/lib.ts`.

The db generator imports `lib/db/schema.ts`, which needs `drizzle-orm` and
`@paralleldrive/cuid2`; locally they resolve from the app's `node_modules`, in the
container from `docs-site/node_modules` (symlinked).

## Components

Usable in any page:

| Component | Data | Props |
|---|---|---|
| `<SystemMap />` | `data/system-map.json` | `focus="<node id>"` highlight a node initially |
| `<TurnWalkthrough />` | `data/turn-steps.json` | `start="<step id>"`; deep link `#step-<id>` |
| `<EnvFlags />` | `data/env.json` | `category="search"`, `query="RERANK"`, `names="A,B,C"` (only those vars); deep link `/reference/env-flags#env-NAME` |
| `<ApiRoutes />` | `data/api-routes.json` | `auth="ingest-token"`, `prefix="/api/chat"` |
| `<DbSchema />` | `data/db-schema.json` | `table="chats"`, `er` (open the ER diagram); deep link `#table-<name>` |
| `<ComposeServices />` | `data/compose-services.json` | `env="lab"` (or a compose file name) |

Schemas for the two hand-written files are documented at the top of
`SystemMap.vue` and `TurnWalkthrough.vue`.

## Deploy (container)

From the **repo root** (the build context must be the repo, because the generators
read it):

```sh
docker compose -p ask-docs -f docs-site/docker-compose.yaml up -d --build
curl -I http://localhost:3750          # → 200
bash fleet-boot/reclaim-space.sh       # prune build cache + dangling images
```

The image is multi-stage: `oven/bun` installs deps, runs `bun run gen` and
`docs:build`; `nginx:alpine` serves `.vitepress/dist` with clean-URL rewriting, gzip and
immutable caching for hashed assets. `docs-site/Dockerfile.dockerignore` (BuildKit's
per-Dockerfile ignore file, which takes precedence over the root `.dockerignore`)
whitelists only the source the generators need and excludes **every** `.env*` file —
including `.env.local.example`, so the container's `env.json` lacks the "example file"
column that a local `bun run gen` fills in. `lastUpdated` timestamps are only
shown when built from a git checkout (the container has no `.git`).

The site is intended for the LAN only (it shows LAN IPs and ports); it sets
`noindex` and has no auth.
