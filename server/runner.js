// server/runner.js
// Shared "go run a test and record the result" logic, used by both the
// manual "Run test now" API route and the background scheduler.
//
// Local and Global deliberately use two completely independent engines:
//   - Local  -> Cloudflare's public speed test endpoints
//               (cloudflareSpeedtest.js) — anycast, so the same hostname
//               always automatically routes to the nearest/fastest edge,
//               with zero server selection needed on our end.
//   - Global -> M-Lab's NDT7 protocol (mlabSpeedtest.js) — the tech behind
//               Google's own speed-test pop-up, excluding your own
//               country so it's a genuine overseas measurement.
// These run on completely separate infrastructure from each other, so a
// problem with one can't take down both tests.
//
// Local and Global are run one after the other, never at the same time —
// running them concurrently would have both tests fighting over the same
// uplink/downlink, making both readings unreliable.

const { withLock, save, genId } = require('./db');
const { runCloudflareTest } = require('./cloudflareSpeedtest');
const { runMLabTest } = require('./mlabSpeedtest');

function pruneOldTests(db) {
  const days = Number(db.settings.retentionDays) || 90;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  db.tests = db.tests.filter((t) => new Date(t.timestamp).getTime() >= cutoff);
}

async function runEngine(type) {
  const runFn = type === 'local' ? runCloudflareTest : runMLabTest;
  const fallbackLabel = type === 'local' ? 'Cloudflare Speedtest' : 'M-Lab NDT7';
  try {
    const result = await runFn();
    return {
      serverLabel: result.serverLabel || fallbackLabel,
      serverUrl: result.serverUrl || '',
      metrics: { latency: result.latency, jitter: result.jitter, download: result.download, upload: result.upload },
      error: null
    };
  } catch (e) {
    return { serverLabel: fallbackLabel, serverUrl: '', metrics: null, error: e.message || String(e) };
  }
}

/**
 * Runs a single test of the given type ('local' | 'global'), records the
 * result (success or failure) to the db, and returns the stored record.
 */
async function runAndRecord(type) {
  if (type !== 'local' && type !== 'global') throw new Error(`Unknown test type: ${type}`);

  const outcome = await runEngine(type);

  const record = {
    id: genId('test'),
    type,
    timestamp: new Date().toISOString(),
    serverLabel: outcome.serverLabel,
    serverUrl: outcome.serverUrl,
    download: outcome.metrics ? outcome.metrics.download : null,
    upload: outcome.metrics ? outcome.metrics.upload : null,
    latency: outcome.metrics ? outcome.metrics.latency : null,
    jitter: outcome.metrics ? outcome.metrics.jitter : null,
    success: !!outcome.metrics,
    error: outcome.error
  };

  await withLock(async (db) => {
    db.tests.push(record);
    db.tests.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    pruneOldTests(db);
    save(db);
  });

  return record;
}

// ---------------------------------------------------------------------
// "Is a test running right now?" — used by the dashboard's top-bar
// indicator (GET /api/tests/status) so it can show something's in
// progress whether it was triggered manually or by the schedule.
// ---------------------------------------------------------------------
let activeRun = null; // { type: 'local'|'global'|'both', startedAt } | null

function getRunStatus() {
  return activeRun
    ? { running: true, type: activeRun.type, startedAt: activeRun.startedAt }
    : { running: false, type: null, startedAt: null };
}

async function withActivity(type, fn) {
  activeRun = { type, startedAt: new Date().toISOString() };
  try {
    return await fn();
  } finally {
    activeRun = null;
  }
}

/** Runs a single test type with the activity indicator set — used by the
 * manual "Run test now" route for a standalone local-only/global-only run. */
async function runOne(type) {
  return withActivity(type, () => runAndRecord(type));
}

async function runBothCore() {
  const global = await runAndRecord('global');
  const local = await runAndRecord('local');
  return { local, global };
}

/**
 * Runs Global, then Local, one at a time — never concurrently, since two
 * simultaneous saturating speed tests would each starve the other of
 * bandwidth and produce misleadingly low numbers on both.
 */
async function runBoth() {
  return withActivity('both', runBothCore);
}

const RETRY_DELAY_MS = 2 * 60 * 1000; // wait 2 minutes before retrying a failed scheduled run
const MAX_ATTEMPTS = 3; // the original attempt plus up to 2 retries

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Used by the background scheduler: runs Global + Local, and if either one
 * failed (server busy / no response / etc.), waits a couple of minutes and
 * retries the *whole* Global+Local pair again — up to MAX_ATTEMPTS times —
 * rather than leaving a failed run sitting there until the next scheduled
 * hour. Every attempt (successful or not) is recorded as its own test, same
 * as always, so the history shows exactly what happened. The "running"
 * indicator stays on for the whole retry sequence, including the wait
 * between attempts, since a scheduled run is still meaningfully "in
 * progress" from the person's point of view during that wait.
 *
 * Manual "Run test now" clicks intentionally do NOT use this — a person
 * watching the button expects one attempt and an immediate result; they
 * can just click again if it fails.
 */
async function runBothWithRetry() {
  return withActivity('both', async () => {
    let result;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      result = await runBothCore();
      const ok = result.local.success && result.global.success;
      if (ok) break;
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[scheduler] attempt ${attempt}/${MAX_ATTEMPTS} had a failure (local: ${result.local.success ? 'ok' : 'failed'}, global: ${result.global.success ? 'ok' : 'failed'}) — retrying in ${RETRY_DELAY_MS / 60000} min`);
        await sleep(RETRY_DELAY_MS);
      }
    }
    return result;
  });
}

module.exports = { runAndRecord, runOne, runBoth, runBothWithRetry, getRunStatus };
