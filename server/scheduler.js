// server/scheduler.js
// Simple interval-based scheduler. Re-armed any time settings change so a
// new interval takes effect immediately without restarting the container.

let timer = null;
let running = false; // guards against a new interval tick overlapping a run that's still retrying

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * @param {() => Promise<any>} runBothFn - runs local+global tests (with retry)
 * @param {() => {enabled:boolean, intervalMinutes:number}} getScheduleFn
 */
function start(runBothFn, getScheduleFn) {
  stop();
  const schedule = getScheduleFn();
  if (!schedule.enabled) return;
  const ms = Math.max(1, Number(schedule.intervalMinutes) || 60) * 60 * 1000;
  timer = setInterval(() => {
    if (running) {
      console.log('[scheduler] previous run (including retries) is still in progress — skipping this tick');
      return;
    }
    running = true;
    runBothFn()
      .catch((err) => console.error('[scheduler] scheduled run failed:', err.message))
      .finally(() => { running = false; });
  }, ms);
}

module.exports = { start, stop };
