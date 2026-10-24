// server/ooklaSpeedtest.js
//
// Runs the official Ookla Speedtest CLI (the engine behind speedtest.net) for
// the "Local" test. Ookla's server network includes servers hosted inside
// local ISPs, and the CLI automatically picks the closest/fastest one, which
// is what makes a ~1 Gbps local (e.g. BDIX) reading possible.
//
// The CLI is a small standalone program. It is downloaded automatically the
// first time it's needed from Ookla's own site and stored in the data folder
// (DATA_DIR/bin), so it survives container restarts and never needs to be
// downloaded again.
//
// Licence note: Ookla permits this CLI for personal, non-commercial use. By
// running it, NetPulse accepts Ookla's licence + GDPR terms on your behalf
// (--accept-license / --accept-gdpr):
//   https://www.speedtest.net/about/eula

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { DATA_DIR } = require('./db');

const VERSION = '1.2.0';
const BIN_DIR = path.join(DATA_DIR, 'bin');
const HOME_DIR = path.join(DATA_DIR, 'ookla-home'); // CLI writes small config files here
const BIN_PATH = path.join(BIN_DIR, 'speedtest');

const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const RUN_TIMEOUT_MS = 150 * 1000;
// "Local" must be local: if the nearest Ookla server is further than this,
// it's effectively an international test (that's the Global test's job).
const MAX_LOCAL_LATENCY_MS = 60;

const ARCH_NAMES = { x64: 'x86_64', arm64: 'aarch64', arm: 'armhf', ia32: 'i386' };

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim().slice(0, 300)));
      else resolve(stdout.toString());
    });
  });
}

let installing = null;

/** Makes sure the CLI binary exists; downloads + unpacks it on first use. */
function ensureBinary() {
  if (fs.existsSync(BIN_PATH)) return Promise.resolve(BIN_PATH);
  if (installing) return installing;
  installing = (async () => {
    const arch = ARCH_NAMES[process.arch];
    if (!arch) throw new Error(`Ookla CLI is not available for this CPU type (${process.arch})`);
    const url = `https://install.speedtest.net/app/cli/ookla-speedtest-${VERSION}-linux-${arch}.tgz`;
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.mkdirSync(HOME_DIR, { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let buf;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new Error(`could not download the Ookla CLI from install.speedtest.net (${e.name === 'AbortError' ? 'timed out' : e.message})`);
    } finally {
      clearTimeout(timer);
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ookla-'));
    try {
      const tgz = path.join(tmp, 'cli.tgz');
      fs.writeFileSync(tgz, buf);
      await run('tar', ['-xzf', tgz, '-C', tmp, 'speedtest']);
      fs.copyFileSync(path.join(tmp, 'speedtest'), BIN_PATH);
      fs.chmodSync(BIN_PATH, 0o755);
    } catch (e) {
      try { fs.unlinkSync(BIN_PATH); } catch (_) { /* ignore */ }
      throw new Error(`could not unpack the Ookla CLI (${e.message})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return BIN_PATH;
  })();
  installing.then(() => { installing = null; }, () => { installing = null; });
  return installing;
}

/** Runs the CLI once and returns its parsed JSON result. */
function runCli(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--accept-license', '--accept-gdpr', '--format=json'], {
      env: { ...process.env, HOME: HOME_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the Ookla test did not finish within ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start the Ookla CLI (${e.message})`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // --format=json prints one JSON object per line; the last "result" is what we want.
      let result = null;
      let message = null;
      (out + '\n' + err).split('\n').forEach((line) => {
        line = line.trim();
        if (!line.startsWith('{')) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'result') result = obj;
          else if (obj.error) message = obj.error;
          else if (obj.type === 'log' && obj.level === 'error') message = obj.message;
        } catch (e) { /* ignore partial lines */ }
      });
      if (result) return resolve(result);
      const detail = message || err.trim().split('\n').pop() || `exit code ${code}`;
      reject(new Error(`Ookla CLI failed: ${detail}`.slice(0, 300)));
    });
  });
}

async function runOoklaTest() {
  const bin = await ensureBinary();
  const r = await runCli(bin);

  const latency = r.ping && r.ping.latency;
  if (!(r.download && r.download.bandwidth > 0) || !(r.upload && r.upload.bandwidth > 0) || typeof latency !== 'number') {
    throw new Error('Ookla CLI returned an incomplete result');
  }
  const server = r.server || {};
  const where = [server.name, server.location].filter(Boolean).join(', ');
  if (latency > MAX_LOCAL_LATENCY_MS) {
    throw new Error(`the nearest Ookla server ("${where || server.host}") is ${Math.round(latency)} ms away, which is not local (limit ${MAX_LOCAL_LATENCY_MS} ms)`);
  }

  return {
    latency: round(latency),
    jitter: round(r.ping.jitter || 0),
    download: round((r.download.bandwidth * 8) / 1e6), // bytes/s -> Mbps
    upload: round((r.upload.bandwidth * 8) / 1e6),
    serverLabel: where ? `Ookla (${where})` : 'Ookla',
    serverUrl: server.host || ''
  };
}

module.exports = { runOoklaTest };
