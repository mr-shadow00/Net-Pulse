// server/routes/tests.js
const express = require('express');
const { load, withLock, save } = require('../db');
const { runOne, runBoth, getRunStatus } = require('../runner');

const router = express.Router();

function rangeToMs(range) {
  switch (range) {
    case '1h': return 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d': return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
    case '90d': return 90 * 24 * 60 * 60 * 1000;
    default: return null; // 'all'
  }
}

// GET /api/tests?type=local|global|all&range=24h|7d|30d|90d|all&limit=200
router.get('/', (req, res) => {
  const db = load();
  const { type = 'all', range = '7d', limit } = req.query;
  let list = db.tests;
  if (type !== 'all') list = list.filter((t) => t.type === type);
  const ms = rangeToMs(range);
  if (ms) {
    const cutoff = Date.now() - ms;
    list = list.filter((t) => new Date(t.timestamp).getTime() >= cutoff);
  }
  list = list.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (limit) list = list.slice(0, Math.max(1, Number(limit) || 200));
  res.json(list);
});

// GET /api/tests/latest -> most recent local + global record
router.get('/latest', (req, res) => {
  const db = load();
  const latestOf = (type) => {
    const list = db.tests.filter((t) => t.type === type);
    return list.length ? list[list.length - 1] : null;
  };
  res.json({ local: latestOf('local'), global: latestOf('global') });
});

// GET /api/tests/summary?range=7d -> averages per type, for the "Average: x" subtext
router.get('/summary', (req, res) => {
  const db = load();
  const { range = '7d' } = req.query;
  const ms = rangeToMs(range);
  const cutoff = ms ? Date.now() - ms : 0;

  const summarize = (type) => {
    const list = db.tests.filter((t) => t.type === type && t.success && new Date(t.timestamp).getTime() >= cutoff);
    if (!list.length) return { download: null, upload: null, latency: null, jitter: null, count: 0 };
    const avg = (key) => list.reduce((a, b) => a + (b[key] || 0), 0) / list.length;
    return {
      download: round(avg('download')),
      upload: round(avg('upload')),
      latency: round(avg('latency')),
      jitter: round(avg('jitter')),
      count: list.length
    };
  };

  res.json({ local: summarize('local'), global: summarize('global') });
});

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// GET /api/tests/status -> is a test (manual or scheduled) running right now?
router.get('/status', (req, res) => {
  res.json(getRunStatus());
});

// POST /api/tests/run  { type: 'local' | 'global' | 'both' }
router.post('/run', async (req, res) => {
  const type = (req.body && req.body.type) || 'both';
  try {
    if (type === 'both') {
      const result = await runBoth();
      return res.json(result);
    }
    if (type !== 'local' && type !== 'global') {
      return res.status(400).json({ error: 'bad_request', message: "type must be 'local', 'global', or 'both'." });
    }
    const record = await runOne(type);
    res.json(record);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error', message: e.message || 'Speed test failed.' });
  }
});

// DELETE /api/tests -> clear all history
router.delete('/', async (req, res) => {
  await withLock(async (db) => {
    db.tests = [];
    save(db);
  });
  res.json({ ok: true });
});

module.exports = router;
