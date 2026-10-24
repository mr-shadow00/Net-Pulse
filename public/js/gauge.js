// public/js/gauge.js
// Small dependency-free speedometer used twice per network card (one for
// download, one for upload). It only ever shows a *finished* result - it is
// updated after a test ends, never during one.
//
// The scale uses fine, even steps (e.g. 0, 5, 10, 15 ... 50) so low speeds
// are easy to read, and an optional dashed marker shows the ISP plan speed.

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const CX = 100, CY = 88, R = 64;
  const START = -135, SWEEP = 270; // degrees clockwise from 12 o'clock

  // Tick spacing options. The smallest step that keeps the dial to at most
  // 10 segments is used, so the numbers stay fine-grained.
  const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const MAX_SEGMENTS = 10;

  function scaleFor(value, plan) {
    const need = Math.max((plan || 0) * 1.1, (value || 0) * 1.05, 10);
    const step = STEPS.find((s) => need / s <= MAX_SEGMENTS) || 5000;
    return { step, max: Math.ceil(need / step) * step };
  }

  function polar(angleDeg, radius) {
    const a = (angleDeg * Math.PI) / 180;
    return { x: CX + radius * Math.sin(a), y: CY - radius * Math.cos(a) };
  }

  function el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  }

  function arcPath(r) {
    const a = polar(START, r);
    const b = polar(START + SWEEP, r);
    return `M ${a.x} ${a.y} A ${r} ${r} 0 1 1 ${b.x} ${b.y}`;
  }

  function create(container) {
    container.innerHTML = '';
    const svg = el('svg', { viewBox: '0 0 200 150', class: 'gauge-svg-el', role: 'img' });

    svg.appendChild(el('path', { d: arcPath(R), class: 'gauge-track', pathLength: 100 }));
    const valueArc = el('path', { d: arcPath(R), class: 'gauge-value-arc', pathLength: 100 });
    valueArc.style.strokeDasharray = '100';
    valueArc.style.strokeDashoffset = '100';
    svg.appendChild(valueArc);

    const ticks = el('g', {});
    svg.appendChild(ticks);
    const planMark = el('g', {});
    svg.appendChild(planMark);

    const needle = el('g', { class: 'gauge-needle' });
    needle.appendChild(el('polygon', {
      points: `${CX - 3},${CY} ${CX + 3},${CY} ${CX},${CY - R + 10}`, class: 'gauge-needle-shape'
    }));
    needle.style.transform = `rotate(${START}deg)`;
    svg.appendChild(needle);
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: 6, class: 'gauge-hub' }));

    const valueText = el('text', { x: CX, y: CY + 36, 'text-anchor': 'middle', class: 'gauge-value-text' });
    valueText.textContent = '—';
    svg.appendChild(valueText);
    const unitText = el('text', { x: CX, y: CY + 50, 'text-anchor': 'middle', class: 'gauge-unit-text' });
    unitText.textContent = 'Mbps';
    svg.appendChild(unitText);

    container.appendChild(svg);
    return { svg, valueArc, ticks, planMark, needle, valueText, scaleKey: null, shown: 0, raf: null };
  }

  function drawScale(g, scale, plan) {
    g.ticks.innerHTML = '';
    g.planMark.innerHTML = '';
    const count = Math.round(scale.max / scale.step);
    for (let i = 0; i <= count; i++) {
      const angle = START + SWEEP * ((i * scale.step) / scale.max);
      const a = polar(angle, R + 8);
      const b = polar(angle, R + 13);
      g.ticks.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'gauge-tick' }));
      const p = polar(angle, R + 23);
      const t = el('text', {
        x: p.x, y: p.y + 3, 'text-anchor': 'middle',
        class: 'gauge-tick-label' + (i % 2 ? ' odd' : '')
      });
      t.textContent = String(i * scale.step);
      g.ticks.appendChild(t);
    }
    if (plan) {
      const angle = START + SWEEP * Math.min(1, plan / scale.max);
      const a = polar(angle, R - 8);
      const b = polar(angle, R + 8);
      g.planMark.appendChild(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'gauge-plan-line' }));
    }
  }

  function tweenNumber(g, from, to, ms) {
    cancelAnimationFrame(g.raf);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * eased;
      g.valueText.textContent = v >= 100 ? String(Math.round(v)) : v.toFixed(1);
      if (k < 1) g.raf = requestAnimationFrame(step);
      else g.shown = to;
    };
    g.raf = requestAnimationFrame(step);
  }

  /** value: Mbps of the latest finished test (null = no result); plan: ISP plan Mbps or null. */
  function update(g, value, plan) {
    const has = value != null && !Number.isNaN(value);
    const scale = scaleFor(has ? value : 0, plan);
    const key = `${scale.max}|${scale.step}|${plan || ''}`;
    if (g.scaleKey !== key) {
      drawScale(g, scale, plan);
      g.scaleKey = key;
    }
    const frac = has ? Math.max(0, Math.min(1, value / scale.max)) : 0;
    g.needle.style.transform = `rotate(${START + SWEEP * frac}deg)`;
    g.valueArc.style.strokeDashoffset = String(100 - frac * 100);
    if (has) {
      tweenNumber(g, g.shown || 0, value, 900);
    } else {
      cancelAnimationFrame(g.raf);
      g.shown = 0;
      g.valueText.textContent = '—';
    }
  }

  window.NetPulseGauge = { create, update };
})();
