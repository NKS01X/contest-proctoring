# Contest Proctoring System

A cross-platform proctoring system for programming contests. A desktop app records participant activity and ships it to a server; the host reviews it in a dashboard. Participants connect their Codeforces handle to the running app so the host can see who is who.

## Architecture

1. **Desktop app (`/daemon`)**: Go + [Wails](https://wails.io). Records every active-window change and every process start/stop, flags blacklisted ones, buffers events and uploads them every 10s (events stay buffered while offline). Shows the session token and connects the Codeforces handle in-app.
2. **Backend (`/backend`)**: Node.js/Express + Postgres. Stores all activity per session, handles connecting handles to sessions, and serves the host API and dashboard.
3. **Portal (`/frontend`)**: Optional web page for connecting a handle and token.

## Backend

```bash
cd backend
npm install
DATABASE_URL=postgres://... HOST_KEY=choose-a-long-key npm start
```

| Env var | Purpose |
|---|---|
| `HOST_KEY` | Protects host endpoints (required) |
| `DATABASE_URL` | Postgres connection string (required) |
| `RETENTION_HOURS` | Auto-delete events not seen again for N hours (0 = off) |
| `PRUNE_KEEP_FLAGGED` | Keep flagged events when pruning (default 1) |

### Host dashboard

Open `/host` on the backend, enter `HOST_KEY`. Lists sessions (online, handle, event and flag counts); click one to see its activity, newest first.

API (send header `x-host-key`):
- `GET /api/host/sessions`
- `GET /api/host/sessions/:token/activity?limit=200&flagged=1&after=<seq>`

## Desktop app

Requires Go 1.23+ and the [Wails CLI](https://wails.io/docs/gettingstarted/installation).

```bash
cd daemon
go mod tidy
wails dev      # run with live reload
wails build    # output in daemon/build/bin
```

Or run `./comp.sh`. Point at a different server with `BACKEND_URL`.

## Participating

1. Launch the app and keep it open for the whole contest.
2. Enter your Codeforces handle and click **Connect**.

> Windows Defender may flag the app because it reads window titles and the process list. Add an exclusion for the contest duration if needed.
