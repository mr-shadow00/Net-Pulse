// server/routes/settings.js
const express = require('express');
const { withLock, save, load } = require('../db');

module.exports = function createSettingsRouter({ onScheduleChanged }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(load().settings);
  });

  router.put('/', async (req, res) => {
    const body = req.body || {};
    try {
      const updated = await withLock(async (db) => {
        if (body.schedule) {
          if (typeof body.schedule.enabled === 'boolean') db.settings.schedule.enabled = body.schedule.enabled;
          if (body.schedule.intervalMinutes) {
            const n = Number(body.schedule.intervalMinutes);
            if (Number.isFinite(n) && n >= 1) db.settings.schedule.intervalMinutes = Math.round(n);
          }
        }
        if (body.retentionDays) {
          const n = Number(body.retentionDays);
          if (Number.isFinite(n) && n >= 1) db.settings.retentionDays = Math.round(n);
        }
        save(db);
        return db.settings;
      });
      onScheduleChanged();
      res.json(updated);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'server_error', message: 'Could not save settings.' });
    }
  });

  return router;
};
