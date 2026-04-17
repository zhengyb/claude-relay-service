# TODOS

## User-facing email update for API keys

**What:** Add email field to the user-facing API key management flow so users can update their
contact email after key creation (not just at creation time).

**Why:** Currently users can set email when creating a key (feature/email-notice), but cannot
update it — only admins can via the admin EditApiKeyModal. If a user enters the wrong email or
changes jobs/email, they must ask an admin to fix it.

**Pros:** Self-service for users; reduces admin toil for a user-owned field.

**Cons:** Requires updating the user-facing key detail/edit UI (ViewApiKeyModal or similar),
the user PUT route in `src/routes/userRoutes.js`, and potentially the `UserApiKeysManager.vue`
list to show the email column.

**Context:** The email field was added to API keys in the feature/email-notice PR. The backend
already supports updating `email` via `updateApiKey()` (it's in the allowedUpdates whitelist).
The missing piece is a user-facing route and UI for PATCH/PUT on their own key's email field.
Start by checking `src/routes/userRoutes.js` — currently there's no PUT route for user-owned
keys, only DELETE. That PUT route needs to be added first.

**Depends on:** feature/email-notice merged to main.

## Cache Intl.DateTimeFormat per-timezone in backupAccountHelper

**What:** In `src/utils/backupAccountHelper.js`, cache `Intl.DateTimeFormat` instances keyed by
timezone string instead of allocating a new formatter on every `getMinutesInTz()` call.

**Why:** Scheduler evaluates `isAccountInBackupWindow(account)` for every account in the pool on
every request. With 100 accounts and busy traffic, that's 100 formatter allocations per request.
Each allocation costs ~10-50μs; cumulative overhead is ~1-5ms per scheduling decision that isn't
needed. At high QPS this shows up on the scheduler's latency budget.

**Pros:** Drops allocation cost to near-zero (one formatter per timezone, typically <10 distinct
timezones across a deployment). ~15 lines of code. No behavior change.

**Cons:** Introduces small per-process cache (`Map<timezone, DateTimeFormat>`). Must never evict
because DateTimeFormat is thread-safe and stateless. Adds one more "thing to know" to
`backupAccountHelper.js`.

**Context:** Current implementation `getMinutesInTz(date, timezone)` creates `new
Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })`
per call. Cache it at module level: `const _fmtCache = new Map()`. Before creating, check cache;
after validating timezone once, store the formatter. The timezone validity check already happens
in `isValidTimezone`, so the cache never stores invalid entries.

**Depends on:** None. Self-contained optimization.
