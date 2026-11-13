const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT / COUNT -> number

const PORT = process.env.PORT || 8080;
const CONTEST_PASSWORD = process.env.CONTEST_PASSWORD;
const HOST_KEY = process.env.HOST_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const ONLINE_MS = 35000;
const MAX_BATCH = 1000;
const MAX_DESC = 4000;

if (!CONTEST_PASSWORD || !HOST_KEY || !DATABASE_URL) {
    console.error('FATAL: CONTEST_PASSWORD, HOST_KEY and DATABASE_URL must be set.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000,
});
pool.on('error', (err) => console.error('pg pool error:', err.message));

async function initDb() {
    await pool.query(`
        CREATE SCHEMA IF NOT EXISTS proctor;
        CREATE TABLE IF NOT EXISTS proctor.sessions (
            token      TEXT PRIMARY KEY,
            cf_handle  TEXT,
            first_seen BIGINT NOT NULL,
            last_seen  BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS proctor.activities (
            seq         BIGSERIAL PRIMARY KEY,
            token       TEXT NOT NULL,
            event_id    TEXT NOT NULL,
            ts          BIGINT NOT NULL,
            type        TEXT NOT NULL,
            description TEXT NOT NULL,
            flagged     INTEGER NOT NULL DEFAULT 0,
            UNIQUE (token, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_activities_token_seq ON proctor.activities (token, seq);
    `);
}

async function ingest(token, items, now) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO proctor.sessions (token, first_seen, last_seen) VALUES ($1, $2, $2)
             ON CONFLICT (token) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
            [token, now]
        );

        const ids = [], tss = [], types_ = [], descs = [], flags = [];
        for (const a of items) {
            if (!a || typeof a.id !== 'string' || typeof a.type !== 'string') continue;
            ids.push(a.id.slice(0, 80));
            tss.push(Date.parse(a.timestamp) || now);
            types_.push(a.type.slice(0, 64));
            descs.push(String(a.description ?? '').slice(0, MAX_DESC));
            flags.push(a.flagged ? 1 : 0);
        }

        if (ids.length) {
            await client.query(
                `INSERT INTO proctor.activities (token, event_id, ts, type, description, flagged)
                 SELECT $1, * FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::int[])
                 ON CONFLICT (token, event_id) DO NOTHING`,
                [token, ids, tss, types_, descs, flags]
            );
            const nFlagged = flags.reduce((s, f) => s + f, 0);
            if (nFlagged) console.log(`[FLAGGED] Token: ${token} | ${nFlagged} flagged event(s) in batch`);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
        console.error(err);
        res.status(500).json({ error: 'internal error' });
    });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Activity batch. Doubles as heartbeat: an empty batch still refreshes last_seen.
const handleActivity = wrap(async (req, res) => {
    const { session_token, activities } = req.body || {};
    if (typeof session_token !== 'string' || !session_token || session_token.length > 64) {
        return res.status(400).json({ error: 'session_token required' });
    }
    const items = Array.isArray(activities) ? activities.slice(0, MAX_BATCH) : [];
    await ingest(session_token, items, Date.now());
    res.status(200).send('OK');
});
app.post('/activity', handleActivity);
app.post('/heartbeat', handleActivity);

app.post('/link', wrap(async (req, res) => {
    const { cf_handle, session_token } = req.body || {};
    if (!cf_handle || !session_token) {
        return res.status(400).json({ error: 'cf_handle and session_token required' });
    }

    const { rows } = await pool.query('SELECT last_seen FROM proctor.sessions WHERE token = $1', [String(session_token)]);
    if (!rows.length) {
        return res.status(401).json({ error: 'Session not active. Please run the proctoring client.' });
    }
    if (Date.now() - rows[0].last_seen > ONLINE_MS) {
        return res.status(401).json({ error: 'Session not active (timeout). Please run the proctoring client.' });
    }

    await pool.query('UPDATE proctor.sessions SET cf_handle = $1 WHERE token = $2', [String(cf_handle).slice(0, 64), String(session_token)]);
    console.log(`[LINK] CF Handle: ${cf_handle} paired with Session: ${session_token}`);

    res.json({ success: true, password: CONTEST_PASSWORD, message: 'Successfully paired.' });
}));

// ---- Host API ----
function requireHost(req, res, next) {
    const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!crypto.timingSafeEqual(hash(req.get('x-host-key') || ''), hash(HOST_KEY))) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

app.get('/api/host/sessions', requireHost, wrap(async (req, res) => {
    const { rows } = await pool.query(`
        SELECT s.token, s.cf_handle, s.first_seen, s.last_seen,
               COUNT(a.seq) AS total,
               COALESCE(SUM(a.flagged), 0) AS flagged
        FROM proctor.sessions s LEFT JOIN proctor.activities a ON a.token = s.token
        GROUP BY s.token
        ORDER BY s.last_seen DESC
    `);
    const now = Date.now();
    res.json(rows.map((r) => ({ ...r, total: Number(r.total), flagged: Number(r.flagged), online: now - r.last_seen < ONLINE_MS })));
}));

// Newest first. Use ?after=<seq> to fetch only rows newer than a known seq.
app.get('/api/host/sessions/:token/activity', requireHost, wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const after = parseInt(req.query.after, 10) || 0;
    const flaggedOnly = req.query.flagged === '1' ? 'AND flagged = 1' : '';
    const { rows } = await pool.query(
        `SELECT seq, ts, type, description, flagged FROM proctor.activities
         WHERE token = $1 AND seq > $2 ${flaggedOnly}
         ORDER BY seq DESC LIMIT $3`,
        [req.params.token, after, limit]
    );
    res.json(rows);
}));

app.get('/host', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/', (req, res) => {
    res.send('Contest Proctoring Backend is running.');
});

initDb()
    .then(() => app.listen(PORT, () => console.log(`Backend gateway listening on port ${PORT}`)))
    .catch((err) => {
        console.error('FATAL: database init failed:', err.message);
        process.exit(1);
    });
