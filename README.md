# Contest Proctoring System

A cross-platform proctoring system for programming contests. A desktop app records participant activity and ships it to a server; the host reviews it in a dashboard. The contest password is released only to participants whose app is running.

## Architecture

1. **Desktop app (`/daemon`)**: Go + [Wails](https://wails.io). Records every active-window change and every process start/stop, flags blacklisted ones, buffers events and uploads them every 10s (events stay buffered while offline). Shows the session token and pairs the Codeforces handle in-app.
2. **Backend (`/backend`)**: Node.js/Express + SQLite. Stores all activity per session, handles pairing, and serves the host API and dashboard.
3. **Portal (`/frontend`)**: Optional web page for pairing a handle and token.

## Backend

```bash
cd backend
npm install
CONTEST_PASSWORD=secret HOST_KEY=choose-a-long-key npm start
```

| Env var | Purpose |
|---|---|
| `CONTEST_PASSWORD` | Released on successful pairing (required) |
| `HOST_KEY` | Protects host endpoints (required) |
| `DB_PATH` | SQLite file path (default `backend/proctoring.db`). Use a persistent disk in production. |

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
2. Enter your Codeforces handle and click **Get contest password**.

> Windows Defender may flag the app because it reads window titles and the process list. Add an exclusion for the contest duration if needed.
