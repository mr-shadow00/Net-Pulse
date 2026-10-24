// server/localSpeedtest.js
//
// The "Local" test: Ookla's official Speedtest CLI first (picks the nearest
// server, including ISP-hosted local ones), and if that can't run for any
// reason — no internet to fetch it, a CLI error, no nearby server — it
// automatically falls back to the Cloudflare test so a run still produces
// a result. If both fail, the error says what each one reported.
//
// The Global test (M-Lab) is completely independent and is not affected.

const { runOoklaTest } = require('./ooklaSpeedtest');
const { runCloudflareTest } = require('./cloudflareSpeedtest');

async function runLocalTest() {
  const problems = [];
  try {
    return await runOoklaTest();
  } catch (e) {
    problems.push(`Ookla: ${e.message}`);
    console.warn(`[local test] Ookla failed, falling back to Cloudflare — ${e.message}`);
  }
  try {
    return await runCloudflareTest();
  } catch (e) {
    problems.push(`Cloudflare: ${e.message}`);
  }
  throw new Error(problems.join(' | '));
}

module.exports = { runLocalTest };
