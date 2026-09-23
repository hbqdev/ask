---
title: Env flags
---

# Env flags

Every environment variable the application reads, where it is read, the default the code falls back to, and which compose files set it.

This table is **generated from the code** by `scripts/gen/env.ts`: it scans `app/`, `lib/`, `components/`, `hooks/`, `config/`, `instrumentation*`, `next.config*` and `proxy.ts` for `process.env.X` reads (tests excluded), detects literal defaults (`?? 'x'`, `|| 5`, ternary fallbacks, `=== 'true'` style switches), and cross-references every `docker-compose*.yaml` and `.env*.example`. Refresh it with `bun run gen` in `docs-site/`.

::: warning Code default ≠ deployed value
The column shows the fallback **in code**. The running value comes from the compose overlay of that environment and its host-local `.env` (which this site never reads). Always confirm with `docker exec <container> printenv VAR` before reasoning about behaviour.
:::

::: tip
Values of secret-named variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `DATABASE_*URL`, …) are never shown. `NEXT_PUBLIC_*` variables are marked **build-time**: they are inlined into the client bundle when the image is built, so changing them needs a rebuild, not just a restart. Link to a single variable with `/reference/env-flags#env-NAME`.
:::

<EnvFlags />
