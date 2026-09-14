// server/db.js
// Tiny file-based data store, same philosophy as most single-container NAS
// apps: one JSON file, written atomically (temp file + rename) so a crash
// mid-write can't corrupt it. No native modules, so it builds cleanly on
// any architecture.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function defaultData() {
  return {
    settings: {
      // Local (Cloudflare, nearest edge) and Global (M-Lab NDT7, excluding
      // your own country) both auto-select their own server — nothing to
      // configure here.
      schedule: {
        enabled: false,
        intervalMinutes: 60
      },
      retentionDays: 90
    },
    tests: [] // { id, type: 'local'|'global', timestamp, serverLabel, serverUrl, download, upload, latency, jitter, success, error }
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function migrate(data) {
  // Fill in any missing keys for forward-compatibility with older db
  // files, and drop settings from older versions (manual/auto server
  // configs, the old Ookla-based Global fallback list) that no longer
  // apply now that both engines self-select with their own strategy.
  const fresh = defaultData().settings;
  const settings = data.settings || {};
  data.settings = {
    schedule: Object.assign({}, fresh.schedule, settings.schedule || {}),
    retentionDays: settings.retentionDays || fresh.retentionDays
  };
  if (!Array.isArray(data.tests)) data.tests = [];
  return data;
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    const fresh = defaultData();
    save(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    const backupPath = DB_FILE + '.corrupt.' + Date.now();
    fs.copyFileSync(DB_FILE, backupPath);
    console.error(`[db] db.json was corrupt. Backed up to ${backupPath} and starting fresh.`);
    const fresh = defaultData();
    save(fresh);
    return fresh;
  }
}

function save(data) {
  ensureDataDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Serializes read-modify-write operations so a scheduled test and a manual
// "run now" click can't stomp on each other.
let queue = Promise.resolve();
function withLock(fn) {
  const run = queue.then(() => {
    const db = load();
    return fn(db);
  });
  queue = run.then(() => {}, () => {});
  return run;
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = { load, save, withLock, genId, DATA_DIR, DB_FILE };
