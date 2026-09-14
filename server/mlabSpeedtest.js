// server/mlabSpeedtest.js
//
// Wraps M-Lab's NDT7 protocol client for the "Global" test. NDT7 is the
// same underlying measurement tech behind Google's own "speed test" pop-up
// (search "speed test" on Google) — M-Lab is a non-profit measurement
// platform whose partners include Google. It runs entirely independent
// infrastructure from Cloudflare (used for the Local test), so a problem
// on one side can't take down both tests at once.
//
// Worth being upfront about: M-Lab is an open measurement platform and
// publishes collected test results publicly for internet-research
// purposes (see https://www.measurementlab.net/privacy/). That's the
// tradeoff for using their free, globally-distributed server network —
// which, being free and research-oriented rather than commercial, is also
// more prone to individual servers being busy or briefly unreachable than
// a large commercial network.
//
// Reliability notes:
//   - The official @m-lab/ndt7 client library only ever tries the *first*
//     server the Locate API suggests, with no fallback — its own source
//     code even has a "TODO: do not discard unused results" comment
//     acknowledging this. M-Lab's Locate API actually returns several
//     ranked candidate servers for exactly this reason. We call the
//     Locate API ourselves and try each candidate in turn — using the
//     library's own lower-level downloadTest/uploadTest functions (its
//     public, documented API, not an internal hack) — before giving up.
//   - We also treat the *nearest* candidate's country as "home" and skip
//     it, so Global always ends up testing against a server outside your
//     own country.

const ndt7 = require('@m-lab/ndt7');

const LOCATE_URL = 'https://locate.measurementlab.net/v2/nearest/ndt/ndt7';
const CLIENT_METADATA = { client_library_name: 'ndt7-js', client_library_version: '0.0.6' };
const LOCATE_TIMEOUT_MS = 10000;
const MAX_CANDIDATES = 4; // try up to this many ranked, non-domestic servers before giving up
const PER_CANDIDATE_TIMEOUT_MS = 35000; // download + upload together, per candidate

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Asks M-Lab's Locate service for the ranked list of nearby NDT7 servers. */
async function fetchCandidates() {
  const url = new URL(LOCATE_URL);
  Object.entries(CLIENT_METADATA).forEach(([k, v]) => url.searchParams.set(k, v));

  let res;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(LOCATE_TIMEOUT_MS), cache: 'no-store' });
  } catch (e) {
    throw new Error(`Could not reach M-Lab's locate service: ${e.message} (check that this device has internet access)`);
  }
  if (!res.ok) throw new Error(`M-Lab's locate service returned HTTP ${res.status}`);

  const data = await res.json();
  if (!data || !Array.isArray(data.results) || !data.results.length) {
    throw new Error('M-Lab\'s locate service did not return any candidate servers.');
  }
  return data.results;
}

/** Builds the {'///ndt/v7/download', '///ndt/v7/upload'} shape the
 * library's worker scripts expect, straight from one locate candidate's
 * pre-signed URLs (skipping the library's own discovery step entirely). */
function urlsFor(candidate) {
  const download = candidate.urls && candidate.urls['wss:///ndt/v7/download'];
  const upload = candidate.urls && candidate.urls['wss:///ndt/v7/upload'];
  if (!download || !upload) throw new Error('This candidate did not include usable download/upload URLs.');
  return { '///ndt/v7/download': download, '///ndt/v7/upload': upload };
}

/** Runs download+upload against one specific candidate server. */
async function tryCandidate(candidate) {
  let downloadMbps = null;
  let uploadMbps = null;
  const rttSamplesMs = [];
  let lastError = null;

  function collectRtt(measurement) {
    const t = measurement && measurement.Source === 'server' && measurement.Data && measurement.Data.TCPInfo;
    if (t && typeof t.RTT === 'number' && t.RTT > 0) rttSamplesMs.push(t.RTT / 1000);
  }

  const callbacks = {
    downloadMeasurement: collectRtt,
    uploadMeasurement: collectRtt,
    downloadComplete: (data) => {
      if (data && data.LastClientMeasurement && typeof data.LastClientMeasurement.MeanClientMbps === 'number') {
        downloadMbps = data.LastClientMeasurement.MeanClientMbps;
      }
    },
    uploadComplete: (data) => {
      const t = data && data.LastServerMeasurement && data.LastServerMeasurement.TCPInfo;
      if (t && t.ElapsedTime) uploadMbps = (t.BytesReceived * 8) / t.ElapsedTime;
    },
    error: (e) => { lastError = (e && e.message) ? e.message : String(e); }
  };

  const config = { userAcceptedDataPolicy: true };
  const urlPromise = Promise.resolve(urlsFor(candidate));

  const runPromise = (async () => {
    await ndt7.downloadTest(config, callbacks, urlPromise);
    await ndt7.uploadTest(config, callbacks, urlPromise);
  })();
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${PER_CANDIDATE_TIMEOUT_MS / 1000}s`)), PER_CANDIDATE_TIMEOUT_MS);
  });

  try {
    await Promise.race([runPromise, timeoutPromise]);
  } catch (e) {
    lastError = lastError || e.message;
  }

  if (downloadMbps == null || uploadMbps == null) {
    throw new Error(lastError || 'no usable result');
  }

  const label = candidate.location
    ? [candidate.location.city, candidate.location.country].filter(Boolean).join(', ')
    : (candidate.machine || 'M-Lab NDT7');

  let latency = null;
  let jitter = null;
  if (rttSamplesMs.length) {
    latency = rttSamplesMs.reduce((a, b) => a + b, 0) / rttSamplesMs.length;
    if (rttSamplesMs.length > 1) {
      let sum = 0;
      for (let i = 1; i < rttSamplesMs.length; i++) sum += Math.abs(rttSamplesMs[i] - rttSamplesMs[i - 1]);
      jitter = sum / (rttSamplesMs.length - 1);
    }
  }

  return {
    latency: latency != null ? round(latency) : null,
    jitter: jitter != null ? round(jitter) : null,
    download: round(downloadMbps),
    upload: round(uploadMbps),
    serverLabel: label,
    serverUrl: candidate.machine || ''
  };
}

/**
 * Core runner: fetches candidates, optionally drops the ones in your own
 * country, then tries the best few until one gives a full result.
 * @param {boolean} excludeHomeCountry
 */
async function runMLabCore(excludeHomeCountry) {
  const candidates = await fetchCandidates();

  let pool = candidates;
  if (excludeHomeCountry) {
    const homeCountry = candidates[0] && candidates[0].location ? candidates[0].location.country : null;
    const nonDomestic = homeCountry
      ? candidates.filter((c) => !c.location || !c.location.country || c.location.country.toLowerCase() !== homeCountry.toLowerCase())
      : candidates;
    pool = nonDomestic.length ? nonDomestic : candidates; // degrade gracefully if everything looked domestic
  }

  const attemptErrors = [];
  for (const candidate of pool.slice(0, MAX_CANDIDATES)) {
    try {
      return await tryCandidate(candidate);
    } catch (e) {
      attemptErrors.push(`${candidate.machine || 'unknown server'}: ${e.message}`);
    }
  }

  const tried = Math.min(pool.length, MAX_CANDIDATES);
  throw new Error(`All ${tried} M-Lab server${tried === 1 ? '' : 's'} tried failed to respond (${attemptErrors.join('; ')})`);
}

/**
 * Runs an NDT7 download+upload test, falling back through M-Lab's ranked
 * list of nearby candidate servers if the top pick doesn't respond. Also
 * treats the nearest candidate's country as "home" and skips it, so this
 * always ends up outside your country — used for the Global test.
 */
async function runMLabTest() {
  return runMLabCore(true);
}

module.exports = { runMLabTest };
