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
