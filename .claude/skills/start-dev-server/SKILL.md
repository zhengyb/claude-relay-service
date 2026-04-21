---
name: start-dev-server
description: |
  Start the Claude Relay Service locally for debugging. Prepares Redis,
  config, admin credentials, and launches the backend via `npm run dev`
  (nodemon hot-reload). Use when asked to "启动开发服务器", "start the dev
  server", "run locally for debugging", "launch the relay service", or
  when debugging requires a running backend. Also use before any
  skill/task that needs to hit `http://127.0.0.1:3000/*` endpoints.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - AskUserQuestion
---

# Start Claude Relay Service for debugging

Use this when the user wants a running local instance to poke at. The goal is a
backend on `http://127.0.0.1:3000` with a working admin login.

## 1. Sanity checks (run in parallel)

```bash
node --version                                    # need >=18
redis-cli ping 2>&1 || echo REDIS_MISSING         # must return PONG
ss -tln 2>/dev/null | grep -E ':3000\b' || echo PORT_FREE
ls .env config/config.js data/init.json 2>&1      # three setup artifacts
```

Interpret:
- `redis-cli` missing / not `PONG` → Redis not ready. Stop and ask the user how
  to provide it (install `redis-server`, Docker, or a remote host). Do NOT try
  `sudo apt install` on your own.
- Port 3000 already taken → something is already running. Ask before killing
  — it might be a previous session's `npm run dev` the user still wants.
- `config/config.js` missing → copy from `config/config.example.js` (step 2).
- `.env` or `data/init.json` missing → run `npm run setup` (step 2).

## 2. One-time setup (only if artifacts missing)

```bash
[ -f config/config.js ] || cp config/config.example.js config/config.js
[ -f .env ] || npm run setup        # also creates data/init.json
```

`npm run setup` is a chicken-and-egg: it `require`s `config/config.js`, so the
copy MUST happen first. It generates a random `JWT_SECRET` / `ENCRYPTION_KEY`
and picks random admin credentials.

After setup, capture the admin credentials — they won't be printed again:

```bash
cat data/init.json
```

Relay the `adminUsername` / `adminPassword` to the user once, so they can log in
at `/admin-next/`.

## 3. Start the server (dev mode)

```bash
npm run dev
```

Run in **background** via `run_in_background: true` and tee the output:

```bash
npm run dev 2>&1 | tee /tmp/claude-relay-dev.log
```

`npm run dev` runs nodemon against `src/`, auto-restarting on backend changes.
It does NOT rebuild the frontend — see step 5.

## 4. Verify it came up

Wait for the `Claude Relay Service started on 0.0.0.0:3000` log line, then:

```bash
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

Expect `"status": "healthy"` with `redis.connected: true`. If not, grep the
log for the failure:

```bash
grep -E 'Error|failed|ECONNREFUSED|Cannot find' /tmp/claude-relay-dev.log
```

## 5. Frontend dist (admin UI)

`npm run dev` only watches the backend. The admin SPA is served as static
files from `web/admin-spa/dist/`. If the user edits Vue source under
`web/admin-spa/src/`, those changes DO NOT appear until you rebuild:

```bash
cd web/admin-spa && npx vite build
```

Use `npx vite build` (not `npm run build`) — the npm script also runs eslint
and can fail the build over prettier formatting warnings. `vite build` alone
does not.

For live HMR on the frontend, run a second process in a separate terminal:

```bash
cd web/admin-spa && npm run dev    # Vite dev server, usually on :5173
```

Tell the user both URLs if they take this path.

## 6. Key endpoints (print these back to the user)

- Admin UI — http://127.0.0.1:3000/admin-next/
- Health  — http://127.0.0.1:3000/health
- API    — http://127.0.0.1:3000/api/v1/messages
- Logs   — `/tmp/claude-relay-dev.log` (live) and `logs/claude-relay-*.log`

## 7. Stopping the server

- If started with `run_in_background: true`: call `TaskStop` with the task id.
- Otherwise: `pkill -f 'node src/app.js'`

## Common failure modes

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `Cannot find module '../config/config'` during setup | `config/config.js` not copied | step 2 |
| `ECONNREFUSED 127.0.0.1:6379` on boot | Redis not running | start `redis-server` |
| `/admin-next/` shows stale behavior despite code edits | dist not rebuilt | step 5 (`npx vite build`) |
| 登录失败 / admin 凭据未知 | init.json lost | `cat data/init.json`; if missing, delete `.env` + `data/init.json` and re-run `npm run setup` (destroys existing admin login only, not Redis data) |
| Port 3000 in use | previous `npm run dev` still alive | confirm with user before killing |

## Things NOT to do

- Do not suggest Docker Compose (`npm run docker:up`) for a debug session — it
  hides nodemon's restart signal and slows iteration.
- Do not run `npm start` for debugging — it runs eslint first and exits on any
  lint error, which is painful mid-refactor.
- Do not commit `data/init.json`, `.env`, or `config/config.js` — they are
  per-environment artifacts, already gitignored.
- Do not regenerate admin credentials silently. If `data/init.json` already
  exists, keep it; the user may have memorised those creds.
