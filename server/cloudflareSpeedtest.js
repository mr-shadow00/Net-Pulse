// server/cloudflareSpeedtest.js
//
// Wraps Cloudflare's public speed test endpoints for the "Local" test.
// These are the same endpoints that power speed.cloudflare.com itself —
// no API key, no rate limits that matter for occasional use, and no
// server selection needed on our end at all: speed.cloudflare.com is
// anycast, meaning the same hostname always automatically routes to
// whichever of Cloudflare's ~300+ edge data centers is closest/fastest
// for this connection. That's exactly "nearest, fastest server" with
// zero configuration, and it's commercial CDN infrastructure (not shared
// research infra), so it isn't artificially bandwidth-limited the way
// some free measurement platforms can be.
//
// This also means Local no longer depends on a downloadable binary or
// closed-source CLI — it's plain HTTPS requests, so it's simpler and
// more portable than the previous Ookla-based approach, and completely
// independent of Ookla, so a problem on Ookla's side can never affect it.

const TRACE_URL = 'https://speed.cloudflare.com/cdn-cgi/trace';
const DOWN_URL = 'https://speed.cloudflare.com/__down';
const UP_URL = 'https://speed.cloudflare.com/__up';

const DOWNLOAD_DURATION_MS = 8000;
const UPLOAD_DURATION_MS = 6000;
const DOWNLOAD_CHUNK_BYTES = 25 * 1000 * 1000; // 25 MB per request
const UPLOAD_CHUNK_BYTES = 4 * 1000 * 1000; // 4 MB per request
const PING_COUNT = 8; // first is discarded (connection warm-up)
const PING_TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 8000;

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Parses the newline-delimited key=value trace response into an object. */
function parseTrace(text) {
  const out = {};
  text.trim().split('\n').forEach((line) => {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  });
  return out;
}

/** Confirms Cloudflare is reachable and identifies which edge answered. */
async function fetchTrace() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(TRACE_URL, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseTrace(await res.text());
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Could not reach Cloudflare within ${CONNECT_TIMEOUT_MS / 1000}s — check that this device has internet access.`);
    }
    throw new Error(`Could not reach Cloudflare: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Repeatedly downloads chunks for `durationMs`, summing bytes actually
 * received, and returns a Mbps figure. */
async function measureDownload(durationMs) {
  const start = performance.now();
  let bytes = 0;

  while (performance.now() - start < durationMs) {
    const remaining = durationMs - (performance.now() - start);
    if (remaining <= 0) break;
    const url = `${DOWN_URL}?bytes=${DOWNLOAD_CHUNK_BYTES}&r=${Math.random()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(remaining, 250));
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok || !res.body) throw new Error(`Download endpoint returned HTTP ${res.status}`);
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (performance.now() - start >= durationMs) {
          controller.abort();
          break;
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  const elapsedSec = (performance.now() - start) / 1000;
  if (elapsedSec <= 0 || bytes === 0) return 0;
  return (bytes * 8) / elapsedSec / 1e6; // Mbps
}

/** Repeatedly uploads random buffers for `durationMs`, summing bytes sent,
 * and returns a Mbps figure. */
async function measureUpload(durationMs) {
  const payload = require('crypto').randomBytes(UPLOAD_CHUNK_BYTES);
  const start = performance.now();
  let bytes = 0;

  while (performance.now() - start < durationMs) {
    const remaining = durationMs - (performance.now() - start);
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(remaining, 250));
    try {
      const res = await fetch(UP_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: payload,
        cache: 'no-store'
      });
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      bytes += payload.length;
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      // Cut off mid-flight when time ran out — don't count partial bytes.
    } finally {
      clearTimeout(timer);
    }
  }

  const elapsedSec = (performance.now() - start) / 1000;
  if (elapsedSec <= 0 || bytes === 0) return 0;
  return (bytes * 8) / elapsedSec / 1e6; // Mbps
}

/** Sends a handful of near-empty requests and times the round trip, the
 * same way Cloudflare's own speed test measures latency/jitter. */
async function measureLatencyJitter() {
  const samples = [];
  for (let i = 0; i < PING_COUNT; i++) {
    const url = `${DOWN_URL}?bytes=0&r=${Math.random()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const t0 = performance.now();
    try {
      await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
      samples.push(performance.now() - t0);
    } catch (e) {
      // skip a failed ping rather than aborting the whole test
    } finally {
      clearTimeout(timer);
    }
  }
  const usable = samples.slice(1); // drop the warm-up ping
  if (usable.length === 0) throw new Error('No successful ping responses from Cloudflare.');

  const latency = usable.reduce((a, b) => a + b, 0) / usable.length;
  let jitterSum = 0;
  for (let i = 1; i < usable.length; i++) jitterSum += Math.abs(usable[i] - usable[i - 1]);
  const jitter = usable.length > 1 ? jitterSum / (usable.length - 1) : 0;

  return { latency, jitter };
}

/**
 * Runs a full test (trace, then latency/jitter, then download, then
 * upload) against Cloudflare's anycast speed test endpoints.
 */
async function runCloudflareTest() {
  const trace = await fetchTrace();
  const { latency, jitter } = await measureLatencyJitter();
  const download = await measureDownload(DOWNLOAD_DURATION_MS);
  const upload = await measureUpload(UPLOAD_DURATION_MS);

  const colo = trace.colo || null;
  const label = colo ? `Cloudflare (${colo})` : 'Cloudflare';

  return {
    latency: round(latency),
    jitter: round(jitter),
    download: round(download),
    upload: round(upload),
    serverLabel: label,
    serverUrl: colo ? `speed.cloudflare.com (${colo})` : 'speed.cloudflare.com'
  };
}

module.exports = { runCloudflareTest };
