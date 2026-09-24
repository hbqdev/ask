---
title: Code map
---

# Code map

Every source file in the repository: what it is, what it exports, who imports it, and which docs pages explain it. It covers the Ask app (`app/`, `components/`, `hooks/`, `lib/`, `scripts/`, `fleet-boot/`, `config/`, `drizzle/`, the root-level config and compose files), the Model Manager (`selfhosted/model-manager/`) and the separate **ingestor** repo (shown under `ingestor/` when it is checked out next to this repo at `../ingestor`). Tests, snapshots, lockfiles, images, Markdown and `.env*` files are left out.

This map is **generated from the code** by `scripts/gen/code-map.ts`. Refresh it with `bun run gen` in `docs-site/`.

## How to use it

- **Tree / Flat.** The tree groups files by directory; each directory shows how many of its files are mentioned somewhere in the docs. The flat list shows full paths and is better for scanning search results.
- **Filter.** The search box matches the path, the one-line purpose, the kind and every exported name, so `createChatStreamResponse`, `ssrf` and `lib/voice` all work. Space-separated words must all match. The chips narrow the list by project (Ask app, Model Manager, ingestor) and by kind (`route-handler`, `page`, `component`, `hook`, `server-action`, `lib-module`, `migration`, `ops-script`, …). **not in docs** shows only files that no docs page mentions yet. Those are the gaps to fill.
- **Expand a row** to see its exports, the files that import it (**Used by**, which you can click to jump to that file), its tests, and links to the docs sections that mention it.
- **Deep link** to one file with `/reference/code-map#file=<path>`, for example `/reference/code-map#file=lib/utils/ssrf-guard.ts`.

### How the columns are derived

| Field | Source |
|---|---|
| Kind | Path and file conventions: `app/**/route.ts` is a route handler, `page.tsx` a page, `'use server'` a server action, `use-*.ts` a hook, `components/ui/` a UI primitive, `drizzle/*.sql` a migration, and so on. |
| Methods | The HTTP-method functions a route file exports (`GET`, `POST`, …). |
| Exports | Top-level `export` declarations, `export { … }` lists and re-exports. Python files list their public top-level `def` and `class` names. |
| Used by | Reverse import edges. Specifiers with the `@/` alias and relative specifiers are resolved against the repo; the Model Manager resolves `@/` to its own root. For scripts, systemd units, compose files and migrations, it lists the files that name them, such as `rebuild-ask.sh` calling `reclaim-space.sh`. Framework-loaded files (pages, routes, layouts) usually have no importer. |
| Tests | `__tests__/` and `*.test.*` files that import the file. |
| Docs | Docs pages whose text contains the file's repo path, or its file name when that name is unique in the repo and not generic like `route.ts` or `index.ts`. The link goes to the nearest heading above the first mention. |

## Adding or refreshing a purpose

The one-line purpose comes from the first source that yields one, in this order:

1. **Header comment.** This is the first comment in the file preamble, after `'use client'` or `'use server'` and the imports, as long as it isn't glued to a declaration other than the main export. The first sentence is used, capped at about 200 characters. In shell, Python, YAML, TOML and Dockerfiles, the leading `#` block is used. Python files also use the module docstring, and SQL files the leading `--` block.
2. **Doc comment on the main export.** This is the `/** … */` or `//` block directly above the default export, the export named after the file, the HTTP handlers of a route file, or the file's only runtime export.
3. **Derived.** Some files can't carry a comment, so their purpose is built from their contents: the `Description=` line of a systemd unit, the `_comment` field of a JSON file, the image-model manifests in `lib/imagegen/models/`, and a summary of the DDL in each Drizzle migration.
4. **Override.** An entry in `docs-site/data/code-map-overrides.json`.

**The convention for new files is a header comment.** Put one or two sentences at the top of the file, or right after the imports and followed by a blank line, saying what the file is for. For example:

```ts
/**
 * Map over items with at most `limit` running at once, preserving input order.
 * A rejection is returned in place (as the Error) instead of aborting the rest,
 * …
 */
```

This is the header of `lib/utils/map-with-concurrency.ts`. Its first sentence becomes the purpose. The rest of the comment is still the place to explain *why*.

Use the overrides file only when a comment can't be added, or when the existing header comment doesn't describe the file (for example a lint note or leftover boilerplate). It has two maps:

```json
{
  "fallback": { "path/to/file.ts": "Used only when the file yields no purpose of its own." },
  "replace":  { "path/to/file.ts": "Always wins, for files whose header comment is misleading." }
}
```

`bun run gen` prints a coverage line (`N files, N with purposes (header …, jsdoc …, derived …, overrides …)`). **It exits non-zero if any file has no purpose**, and lists those files, so a new file fails the docs generation until it gets a header comment or an override. It also warns about overrides for files that no longer exist. Remove those entries when a file is deleted or renamed.

::: tip Safety
The generator emits only the one-line purpose, never file contents. It never reads `.env*` files, and it passes every purpose through the same secret-redaction rules as the other generated reference data.
:::

<CodeMap />
