// public/js/app.js
(function () {
  const state = {
    settings: null,
    range: { local: '7d', global: '7d' },
    visible: {
      local: { download: true, upload: true, latency: true, jitter: true },
      global: { download: true, upload: true, latency: true, jitter: true }
    }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------------- API helpers ----------------
  async function api(path, opts) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error((body && body.message) || `Request failed (${res.status})`);
    return body;
  }

  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------------- Tabs ----------------
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.view').forEach((v) => v.classList.remove('active'));
      $('#view-' + btn.dataset.view).classList.add('active');
    });
  });

  // ---------------- Formatting ----------------
  function fmt(n, digits = 2) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toFixed(digits).replace(/\.00$/, '');
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtShort(iso, range) {
    const d = new Date(iso);
    if (range === '1h' || range === '24h') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function fmtAgo(iso) {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  }

  // ---------------- Dashboard: stat cards ----------------
  async function loadStats() {
    const [latest, summary] = await Promise.all([
      api('/tests/latest'),
      api('/tests/summary?range=7d')
    ]);

    fillStatGroup('local', latest.local, summary.local);
    fillStatGroup('global', latest.global, summary.global);

    const times = [latest.local, latest.global].filter(Boolean).map((t) => new Date(t.timestamp).getTime());
    if (times.length) {
      $('#last-run-text').textContent = `Last test run: ${fmtDate(new Date(Math.max(...times)).toISOString())}`;
    } else {
      $('#last-run-text').textContent = 'No tests yet — hit "Run test now" below.';
    }

    // Both Local and Global pick their own server per run (Cloudflare's
    // anycast routing / M-Lab's locate service do their own selection),
    // so just show whichever server the most recent test actually used.
    $('#local-server-name').textContent = latest.local?.serverLabel ? `· ${latest.local.serverLabel}` : '';
    $('#global-server-name').textContent = latest.global?.serverLabel ? `· ${latest.global.serverLabel}` : '';
  }

  function fillStatGroup(type, latest, summary) {
    const grid = $(`#${type}-stats`);
    ['latency', 'download', 'upload', 'jitter'].forEach((metric) => {
      const card = grid.querySelector(`[data-metric="${metric}"]`);
      const vEl = card.querySelector('.v');
      const avgEl = card.querySelector('.avg');
      if (latest && latest.success) {
        vEl.textContent = fmt(latest[metric]);
      } else if (latest && !latest.success) {
        vEl.textContent = 'Err';
      } else {
        vEl.textContent = '—';
      }
      const avgVal = summary ? summary[metric] : null;
      const unit = metric === 'download' || metric === 'upload' ? 'Mbps' : 'ms';
      avgEl.textContent = avgVal != null ? `${fmt(avgVal)} ${unit}` : '—';
    });
  }

  // ---------------- Charts ----------------
  async function loadChart(type) {
    const range = state.range[type];
    const list = await api(`/tests?type=${type}&range=${range}&limit=500`);
    const asc = list.slice().reverse(); // oldest -> newest for plotting

    const points = asc.map((t) => ({
      label: fmtShort(t.timestamp, range),
      fullLabel: fmtDate(t.timestamp)
    }));

    const seriesDefs = [
      { key: 'download', label: 'Download', color: '#4c8dff', axis: 'left', style: 'area' },
      { key: 'upload', label: 'Upload', color: '#22c55e', axis: 'left', style: 'area' },
      { key: 'latency', label: 'Latency', color: '#eab308', axis: 'right', style: 'dotted' },
      { key: 'jitter', label: 'Jitter', color: '#a855f7', axis: 'right', style: 'dashed' }
    ];

    const series = seriesDefs.map((def) => ({
      ...def,
      values: asc.map((t) => (t.success ? t[def.key] : null))
    }));

    const errorIndices = asc.reduce((acc, t, i) => {
      if (!t.success) acc.push(i);
      return acc;
    }, []);

    window.NetPulseChart.renderChart($(`#chart-${type}`), {
      points,
      series,
      leftLabel: 'Speed (Mbps)',
      rightLabel: 'Latency / Jitter (ms)',
      visible: state.visible[type],
      errorIndices
    });
  }

  $$('.legend-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('[data-series-toggles]').dataset.seriesToggles;
      const key = btn.dataset.key;
      state.visible[group][key] = !state.visible[group][key];
      btn.classList.toggle('active', state.visible[group][key]);
      loadChart(group);
    });
  });

  $$('.range-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const group = sel.dataset.rangeFor;
      state.range[group] = sel.value;
      loadChart(group);
    });
  });

  // ---------------- Table ----------------
  let allTests = [];
  async function loadTable() {
    allTests = await api('/tests?type=all&range=all&limit=500');
    renderTable();
  }

  function renderTable() {
    const filterText = $('#table-filter').value.trim().toLowerCase();
    const typeFilter = $('#table-type-filter').value;
    const rows = allTests.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (filterText && !(t.serverLabel || '').toLowerCase().includes(filterText)) return false;
      return true;
    });

    const tbody = $('#tests-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted center">No matching tests.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((t) => {
      const badge = `<span class="type-badge ${t.type}">${t.type}</span>`;
      if (!t.success) {
        return `<tr>
          <td>${badge}</td>
          <td>${fmtDate(t.timestamp)}</td>
          <td>${escapeHtml(t.serverLabel || '')}</td>
          <td colspan="4" class="cell-error">${escapeHtml(t.error || 'Failed')}</td>
        </tr>`;
      }
      return `<tr>
        <td>${badge}</td>
        <td>${fmtDate(t.timestamp)}</td>
        <td>${escapeHtml(t.serverLabel || '')}</td>
        <td class="cell-latency">${fmt(t.latency)}ms</td>
        <td class="cell-jitter">${fmt(t.jitter)}ms</td>
        <td class="cell-download">${fmt(t.download)} Mbps</td>
        <td class="cell-upload">${fmt(t.upload)} Mbps</td>
      </tr>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('#table-filter').addEventListener('input', renderTable);
  $('#table-type-filter').addEventListener('change', renderTable);

  // ---------------- Run now ----------------
  async function runTests(type) {
    const label = type === 'both' ? 'Local + Global' : type;
    toast(`Running ${label} speed test… this can take ${type === 'both' ? '20-30' : '10-15'}s.`, 6000);
    $('#run-both-btn').disabled = true;
    try {
      await api('/tests/run', { method: 'POST', body: JSON.stringify({ type }) });
      toast('Speed test complete.');
      await refreshDashboard();
    } catch (e) {
      toast('Speed test failed: ' + e.message, 4000);
    } finally {
      $('#run-both-btn').disabled = false;
    }
  }

  $('#run-both-btn').addEventListener('click', () => runTests('both'));
  $('#run-dropdown-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#run-dropdown-menu').classList.toggle('open');
  });
  document.addEventListener('click', () => $('#run-dropdown-menu').classList.remove('open'));
  $$('#run-dropdown-menu button').forEach((b) => b.addEventListener('click', () => runTests(b.dataset.run)));

  // ---------------- Settings ----------------
  async function loadSettings() {
    state.settings = await api('/settings');
    const s = state.settings;
    $('#schedule-enabled').checked = !!s.schedule.enabled;
    $('#schedule-interval').value = String(s.schedule.intervalMinutes || 60);
    $('#retention-days').value = s.retentionDays;
  }

  $('#save-settings-btn').addEventListener('click', async () => {
    const payload = {
      schedule: {
        enabled: $('#schedule-enabled').checked,
        intervalMinutes: Number($('#schedule-interval').value)
      },
      retentionDays: Number($('#retention-days').value)
    };
    const resultEl = $('#save-result');
    try {
      state.settings = await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      resultEl.textContent = 'Saved ✓';
      resultEl.className = 'test-result ok';
      toast('Settings saved.');
    } catch (e) {
      resultEl.textContent = e.message;
      resultEl.className = 'test-result err';
    }
    setTimeout(() => { resultEl.textContent = ''; }, 4000);
  });

  $('#clear-history-btn').addEventListener('click', async () => {
    if (!confirm('Delete all stored speed test history? This cannot be undone.')) return;
    await api('/tests', { method: 'DELETE' });
    toast('History cleared.');
    await refreshDashboard();
  });

  // ---------------- Boot ----------------
  async function refreshDashboard() {
    await loadStats();
    await Promise.all([loadChart('local'), loadChart('global'), loadTable()]);
  }

  // ---------------- Running indicator ----------------
  // Polls whether a test is in progress (manual or scheduled) so the
  // top-bar badge reflects reality even for runs this tab didn't trigger.
  let wasRunning = false;
  async function pollRunStatus() {
    let status;
    try {
      status = await api('/tests/status');
    } catch (e) {
      return; // don't let a transient poll failure hide/show the badge incorrectly
    }
    const el = $('#running-indicator');
    const textEl = $('#running-indicator-text');
    el.hidden = !status.running;
    if (status.running) {
      const label = status.type === 'both' ? 'Running Global + Local…' : `Running ${status.type}…`;
      textEl.textContent = label;
    }
    if (wasRunning && !status.running) {
      // A run (possibly scheduled, possibly from another tab/device) just
      // finished — refresh so results show up without waiting a full minute.
      refreshDashboard();
    }
    wasRunning = status.running;
  }

  (async function init() {
    await loadSettings();
    await refreshDashboard();
    await pollRunStatus();
    // Light auto-refresh so the dashboard stays current if a scheduled run
    // happens while the tab is open.
    setInterval(refreshDashboard, 60 * 1000);
    setInterval(pollRunStatus, 4 * 1000);
  })();
})();
