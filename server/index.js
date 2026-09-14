// server/index.js
const path = require('path');
const express = require('express');

const { load } = require('./db');
const scheduler = require('./scheduler');
const { runBothWithRetry } = require('./runner');
const createSettingsRouter = require('./routes/settings');
const testsRoutes = require('./routes/tests');

const PORT = process.env.PORT || 3000;

// Touch the db once so the data file exists before we start serving.
load();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

function armScheduler() {
  const db = load();
  scheduler.start(runBothWithRetry, () => db.settings.schedule);
}

app.use('/api/settings', createSettingsRouter({ onScheduleChanged: armScheduler }));
app.use('/api/tests', testsRoutes);
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Static frontend ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`NetPulse listening on port ${PORT}`);
  armScheduler();
});
