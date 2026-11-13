const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;
const CONTEST_PASSWORD = process.env.CONTEST_PASSWORD;
const HOST_KEY = process.env.HOST_KEY;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'proctoring.db');

const ONLINE_MS = 35000;
const MAX_BATCH = 1000;
const MAX_DESC = 4000;

if (!CONTEST_PASSWORD || !HOST_KEY) {
    console.error('FATAL: CONTEST_PASSWORD and HOST_KEY environment variables must be set.');
    process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        cf_handle  TEXT,
        first_seen INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        token       TEXT NOT NULL,
        event_id    TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        type        TEXT NOT NULL,
        description TEXT NOT NULL,
        flagged     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (token, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_activities_token_seq ON activities (token, seq);
`);

const touchSession = db.prepare(`
    INSERT INTO sessions (token, first_seen, last_seen) VALUES (?, ?, ?)
    ON CONFLICT (token) DO UPDATE SET last_seen = excluded.last_seen
`);
const insertActivity = db.prepare(`
    INSERT OR IGNORE INTO activities (token, event_id, ts, type, description, flagged)
    VALUES (?, ?, ?, ?, ?, ?)
`);
const getSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
const setHandle = db.prepare('UPDATE sessions SET cf_handle = ? WHERE token = ?');

const ingest = db.transaction((token, items, now) => {
    touchSession.run(token, now, now);
    for (const a of items) {
        if (!a || typeof a.id !== 'string' || typeof a.type !== 'string') continue;
        const ts = Date.parse(a.timestamp) || now;
        const desc = String(a.description ?? '').slice(0, MAX_DESC);
        insertActivity.run(token, a.id.slice(0, 80), ts, a.type.slice(0, 64), desc, a.flagged ? 1 : 0);
        if (a.flagged) {
            const row = getSession.get(token);
            console.log(`[FLAGGED] Token: ${token} | Handle: ${row?.cf_handle || 'unlinked'} | ${a.type}: ${desc.slice(0, 200)}`);
        }
    }
});

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Activity batch. Doubles as heartbeat: an empty batch still refreshes last_seen.
function handleActivity(req, res) {
    const { session_token, activities } = req.body || {};
    if (typeof session_token !== 'string' || !session_token || session_token.length > 64) {
        return res.status(400).json({ error: 'session_token required' });
    }
    const items = Array.isArray(activities) ? activities.slice(0, MAX_BATCH) : [];
    ingest(session_token, items, Date.now());
    res.status(200).send('OK');
}
app.post('/activity', handleActivity);
app.post('/heartbeat', handleActivity);

app.post('/link', (req, res) => {
    const { cf_handle, session_token } = req.body || {};
    if (!cf_handle || !session_token) {
        return res.status(400).json({ error: 'cf_handle and session_token required' });
    }

    const session = getSession.get(session_token);
    if (!session) {
        return res.status(401).json({ error: 'Session not active. Please run the proctoring client.' });
    }
    if (Date.now() - session.last_seen > ONLINE_MS) {
        return res.status(401).json({ error: 'Session not active (timeout). Please run the proctoring client.' });
    }

    setHandle.run(String(cf_handle).slice(0, 64), session_token);
    console.log(`[LINK] CF Handle: ${cf_handle} paired with Session: ${session_token}`);

    res.json({ success: true, password: CONTEST_PASSWORD, message: 'Successfully paired.' });
});

// ---- Host API ----
function requireHost(req, res, next) {
    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!crypto.timingSafeEqual(hash(req.get('x-host-key') || ''), hash(HOST_KEY))) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

app.get('/api/host/sessions', requireHost, (req, res) => {
    const rows = db.prepare(`
        SELECT s.token, s.cf_handle, s.first_seen, s.last_seen,
               COUNT(a.seq) AS total,
               COALESCE(SUM(a.flagged), 0) AS flagged
        FROM sessions s LEFT JOIN activities a ON a.token = s.token
        GROUP BY s.token
        ORDER BY s.last_seen DESC
    `).all();
    const now = Date.now();
    res.json(rows.map((r) => ({ ...r, online: now - r.last_seen < ONLINE_MS })));
});

// Newest first. Use ?after=<seq> to fetch only rows newer than a known seq.
app.get('/api/host/sessions/:token/activity', requireHost, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const after = parseInt(req.query.after, 10) || 0;
    const flaggedOnly = req.query.flagged === '1' ? 'AND flagged = 1' : '';
    const rows = db.prepare(`
        SELECT seq, ts, type, description, flagged FROM activities
        WHERE token = ? AND seq > ? ${flaggedOnly}
        ORDER BY seq DESC LIMIT ?
    `).all(req.params.token, after, limit);
    res.json(rows);
});

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/', (req, res) => {
    res.send('Contest Proctoring Backend is running.');
});

app.listen(PORT, () => {
    console.log(`Backend gateway listening on port ${PORT} (db: ${DB_PATH})`);
});
