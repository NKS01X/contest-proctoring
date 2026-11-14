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
        ALTER TABLE proctor.sessions ADD COLUMN IF NOT EXISTS last_n  INTEGER NOT NULL DEFAULT 0;

        -- every distinct description is stored exactly once
        CREATE TABLE IF NOT EXISTS proctor.strings (
            id  SERIAL PRIMARY KEY,
            h   TEXT NOT NULL UNIQUE,
            txt TEXT NOT NULL
        );

        -- one row per unique (session, type, description): first/last time and repeat count
        CREATE TABLE IF NOT EXISTS proctor.uevents (
            token    TEXT NOT NULL,
            type     SMALLINT NOT NULL,
            sid      INTEGER NOT NULL,
            first_ts BIGINT NOT NULL,
            last_ts  BIGINT NOT NULL,
            cnt      INTEGER NOT NULL DEFAULT 1,
            flagged  SMALLINT NOT NULL DEFAULT 0,
            PRIMARY KEY (token, type, sid)
        );
        CREATE INDEX IF NOT EXISTS idx_uevents_token_last ON proctor.uevents (token, last_ts);
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
    evs.forEach((e, i) => { e.sid = sids[i]; });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // locks the session row; last_n makes client retries idempotent so counts stay exact
        const { rows: [sess] } = await client.query(
            `INSERT INTO proctor.sessions (token, first_seen, last_seen) VALUES ($1, $2, $2)
             ON CONFLICT (token) DO UPDATE SET last_seen = EXCLUDED.last_seen
             RETURNING last_n`,
            [token, now]
        );

        const fresh = evs.filter((e) => e.n > sess.last_n);
        if (fresh.length) {
            const agg = new Map();
            let maxN = sess.last_n;
            for (const e of fresh) {
                if (e.n > maxN) maxN = e.n;
                const k = e.type + ':' + e.sid;
                const g = agg.get(k);
                if (!g) agg.set(k, { type: e.type, sid: e.sid, first: e.ts, last: e.ts, cnt: 1, flagged: e.flagged });
                else {
                    g.first = Math.min(g.first, e.ts);
                    g.last = Math.max(g.last, e.ts);
                    g.cnt++;
                }
            }
            const g = [...agg.values()];
            await client.query(
                `WITH ins AS (
                     INSERT INTO proctor.uevents (token, type, sid, first_ts, last_ts, cnt, flagged)
                     SELECT $1, * FROM unnest($2::smallint[], $3::int[], $4::bigint[], $5::bigint[], $6::int[], $7::smallint[])
                     ON CONFLICT (token, type, sid) DO UPDATE SET
                         first_ts = LEAST(proctor.uevents.first_ts, EXCLUDED.first_ts),
                         last_ts  = GREATEST(proctor.uevents.last_ts, EXCLUDED.last_ts),
                         cnt      = proctor.uevents.cnt + EXCLUDED.cnt
                     RETURNING (xmax = 0) AS inserted, flagged
                 )
                 UPDATE proctor.sessions SET
                     total   = total + (SELECT COUNT(*) FROM ins WHERE inserted),
                     flagged = flagged + (SELECT COALESCE(SUM(flagged), 0) FROM ins WHERE inserted),
                     last_n  = $8
                 WHERE token = $1`,
                [
                    token,
                    g.map((x) => x.type), g.map((x) => x.sid),
                    g.map((x) => x.first), g.map((x) => x.last),
                    g.map((x) => x.cnt), g.map((x) => x.flagged),
                    maxN,
                ]
            );
            const nFlagged = fresh.reduce((s, e) => s + e.flagged, 0);
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

// total = unique events per session
app.get('/api/host/sessions', requireHost, wrap(async (req, res) => {
    const { rows } = await pool.query(
        'SELECT token, cf_handle, first_seen, last_seen, total, flagged FROM proctor.sessions ORDER BY last_seen DESC'
    );
    const now = Date.now();
    res.json(rows.map((r) => ({ ...r, online: now - r.last_seen < ONLINE_MS })));
}));

// Newest first. ?after=<seq> returns only events seen again at/after that time (seq = last_ts).
app.get('/api/host/sessions/:token/activity', requireHost, wrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const after = parseInt(req.query.after, 10) || 0;
    const flaggedOnly = req.query.flagged === '1' ? 'AND e.flagged = 1' : '';
    const { rows } = await pool.query(
        `SELECT e.type::text || ':' || e.sid AS k, e.last_ts AS seq, e.first_ts, e.last_ts AS ts,
                e.cnt, e.type, s.txt AS description, e.flagged
         FROM proctor.uevents e JOIN proctor.strings s ON s.id = e.sid
         WHERE e.token = $1 AND e.last_ts >= $2 ${flaggedOnly}
         ORDER BY e.last_ts DESC LIMIT $3`,
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
