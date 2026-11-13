const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const CONTEST_PASSWORD = process.env.CONTEST_PASSWORD || "SuperSecretPassword2026";

// In-memory store: session_token -> { lastSeen: Date, violations: Array }
const activeSessions = new Map();

// Heartbeat Endpoint
app.post('/heartbeat', (req, res) => {
    const { session_token, timestamp, violations } = req.body;

    if (!session_token) {
        return res.status(400).json({ error: 'session_token required' });
    }

    if (!activeSessions.has(session_token)) {
        activeSessions.set(session_token, { violations: [] });
    }

    const session = activeSessions.get(session_token);
    session.lastSeen = new Date();
    
    if (violations && violations.length > 0) {
        session.violations.push(...violations);
        console.log(`[VIOLATION] Token: ${session_token} | Count: ${violations.length}`);
        // Here you would typically persist these to a database
    }

    res.status(200).send('OK');
});

// Link Endpoint
app.post('/link', (req, res) => {
    const { cf_handle, session_token } = req.body;

    if (!cf_handle || !session_token) {
        return res.status(400).json({ error: 'cf_handle and session_token required' });
    }

    const session = activeSessions.get(session_token);

    if (!session) {
        return res.status(401).json({ error: 'Session not active. Please run the proctoring client.' });
    }

    const now = new Date();
    const diffSeconds = (now - session.lastSeen) / 1000;

    if (diffSeconds > 30) {
        return res.status(401).json({ error: 'Session not active (timeout). Please run the proctoring client.' });
    }

    // Bind CF handle to session (just logging for this mock)
    session.cfHandle = cf_handle;
    console.log(`[LINK] CF Handle: ${cf_handle} paired with Session: ${session_token}`);

    // Return the secret Codeforces password
    res.json({
        success: true,
        password: CONTEST_PASSWORD,
        message: 'Successfully paired.'
    });
});

app.listen(PORT, () => {
    console.log(`Backend gateway listening on port ${PORT}`);
});
