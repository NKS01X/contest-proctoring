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
const MAX_STR_CACHE = 50000;

const TYPES = {
    process_snapshot: 1,
    process_start: 2,
    process_stop: 3,
    window: 4,
    session_start: 5,
    session_end: 6,
    linked: 7,
};
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));

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
        ALTER TABLE proctor.sessions ADD COLUMN IF NOT EXISTS total   INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE proctor.sessions ADD COLUMN IF NOT EXISTS flagged INTEGER NOT NULL DEFAULT 0;

        -- every distinct description is stored exactly once
        CREATE TABLE IF NOT EXISTS proctor.strings (
            id  SERIAL PRIMARY KEY,
            h   TEXT NOT NULL UNIQUE,
            txt TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS proctor.events (
            token   TEXT NOT NULL,
            n       INTEGER NOT NULL,
            ts      BIGINT NOT NULL,
            type    SMALLINT NOT NULL,
            sid     INTEGER NOT NULL,
            flagged SMALLINT NOT NULL DEFAULT 0,
            PRIMARY KEY (token, n)
        );
    `);
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const strCache = new Map(); // md5 -> strings.id

// Returns the strings.id for each text, inserting only texts never seen before.
async function internStrings(texts) {
    if (strCache.size > MAX_STR_CACHE) strCache.clear();

    const missing = new Map();
    for (const t of texts) {
        const h = md5(t);
        if (!strCache.has(h)) missing.set(h, t);
    }

    if (missing.size) {
        const hs = [...missing.keys()];
        const { rows } = await pool.query(
            `WITH ins AS (
                 INSERT INTO proctor.strings (h, txt)
                 SELECT * FROM unnest($1::text[], $2::text[])
                 ON CONFLICT (h) DO NOTHING
                 RETURNING id, h
             )
             SELECT id, h FROM ins
             UNION ALL
             SELECT id, h FROM proctor.strings WHERE h = ANY($1::text[])`,
            [hs, [...missing.values()]]
        );
        for (const r of rows) strCache.set(r.h, r.id);

        // a concurrent request may have inserted the same string after our snapshot
        const lost = hs.filter((h) => !strCache.has(h));
        if (lost.length) {
            const again = await pool.query('SELECT id, h FROM proctor.strings WHERE h = ANY($1::text[])', [lost]);
            for (const r of again.rows) strCache.set(r.h, r.id);
        }
    }
    return texts.map((t) => strCache.get(md5(t)));
}

async function ingest(token, items, now) {
    const evs = [];
    for (const a of items) {
        if (!a || typeof a.id !== 'string' || typeof a.type !== 'string') continue;
        const type = TYPES[a.type];
        const n = parseInt(a.id.slice(a.id.lastIndexOf('-') + 1), 10);
        if (!type || !Number.isInteger(n)) continue;
        evs.push({
            n,
            type,
            ts: Date.parse(a.timestamp) || now,
            desc: String(a.description ?? '').slice(0, MAX_DESC),
            flagged: a.flagged ? 1 : 0,
        });
    }

    const sids = evs.length ? await internStrings(evs.map((e) => e.desc)) : [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO proctor.sessions (token, first_seen, last_seen) VALUES ($1, $2, $2)
             ON CONFLICT (token) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
            [token, now]
        );

        if (evs.length) {
            await client.query(
                `WITH ins AS (
                     INSERT INTO proctor.events (token, n, ts, type, sid, flagged)
                     SELECT $1, * FROM unnest($2::int[], $3::bigint[], $4::smallint[], $5::int[], $6::smallint[])
                     ON CONFLICT DO NOTHING
                     RETURNING flagged
                 )
                 UPDATE proctor.sessions SET
                     total   = total + (SELECT COUNT(*) FROM ins),
                     flagged = flagged + (SELECT COALESCE(SUM(flagged), 0) FROM ins)
                 WHERE token = $1`,
                [token, evs.map((e) => e.n), evs.map((e) => e.ts), evs.map((e) => e.type), sids, evs.map((e) => e.flagged)]
            );
            const nFlagged = evs.reduce((s, e) => s + e.flagged, 0);
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
    const { rows } = await pool.query(
        'SELECT token, cf_handle, first_seen, last_seen, total, flagged FROM proctor.sessions ORDER BY last_seen DESC'
    );
    const now = Date.now();
    res.json(rows.map((r) => ({ ...r, online: now - r.last_seen < ONLINE_MS })));
}));

// Newest first. Use ?after=<seq> to fetch only rows newer than a known seq.
app.get('/api/host/sessions/:token/activity', requireHost, wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const after = parseInt(req.query.after, 10) || 0;
    const flaggedOnly = req.query.flagged === '1' ? 'AND e.flagged = 1' : '';
    const { rows } = await pool.query(
        `SELECT e.n AS seq, e.ts, e.type, s.txt AS description, e.flagged
         FROM proctor.events e JOIN proctor.strings s ON s.id = e.sid
         WHERE e.token = $1 AND e.n > $2 ${flaggedOnly}
         ORDER BY e.n DESC LIMIT $3`,
        [req.params.token, after, limit]
    );
    res.json(rows.map((r) => ({ ...r, type: TYPE_NAMES[r.type] || 'unknown' })));
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
