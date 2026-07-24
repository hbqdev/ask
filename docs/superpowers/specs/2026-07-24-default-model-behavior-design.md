# Default & Remembered Chat Model — Design

**Date:** 2026-07-24
**Status:** Operator-approved behavior; implemented inline (tightly-coupled
change set: schema → action → resolution → client).

## Behavior (operator-specified)

1. **New chat:** use the model the user last explicitly picked — remembered
   per ACCOUNT, so it follows them across devices and logins.
2. **Never picked / new account:** the deployment default
   (`DEFAULT_CHAT_MODEL` env → code fallback `kimi-k2.6:cloud`).
3. **Login boundary:** a different user logging in on the same browser sees
   THEIR pick or the default — never the previous user's model.
4. Only **explicit picks** are saved. Users who ride the default are not
   pinned to it, so a later `DEFAULT_CHAT_MODEL` change reaches them.

## Mechanics

- `user_settings.preferred_chat_model varchar(512) NULL` — stores the
  cookie-serialized `providerId:modelId` (reuses
  `serializeModelSelectionCookie` / `parseModelSelectionCookie`; one format
  everywhere). Migration via drizzle-kit.
- `lib/db/model-preference-actions.ts`: `getPreferredChatModel(userId)` /
  `savePreferredChatModel(userId, providerId, modelId)` under
  `withOptionalRLS`, upsert on the `user_settings` PK.
- **Answering path** (`selectModel`): gains `userId?: string | null`.
  - Authed (`userId` set): DB pick (provider enabled) → DEFAULT_MODEL
    (provider enabled) → first fetched. The COOKIE IS IGNORED — this is what
    enforces the login boundary.
  - Guest (`userId` null): unchanged cookie → DEFAULT_MODEL → first fetched.
- **Selector display** (`getModelSelectorData`): same order, keyed on the
  current user; a DB/cookie pick that is not in the fetched list falls
  through to `pickFallbackModel` (default-aware, from the prior change).
- **Client** (`model-selector-client.tsx`): picking a model still writes the
  cookie (guest UX + instant SSR hint) and now also fire-and-forgets a
  server action to persist the pick for the account.
- Anonymous deployments (`ENABLE_AUTH=false`) keep pure cookie behavior —
  the shared anon user never has a DB pick saved (the save action no-ops
  without a real user).

## Testing

- Action: upsert writes / reads back; no-op on missing user id.
- `selectModel`: authed DB-pick wins over cookie; authed with no pick →
  default; guest cookie honored; disabled-provider pick falls through.
- Selector data resolution covered via the existing pure-function tests
  plus a user-pick variant.

## Out of scope

- Per-mode model memory; syncing the cookie back from the DB; clearing the
  cookie on logout (authed resolution ignores it, so it can only affect the
  logged-out home screen).
