// public/js/chart.js
// A small dependency-free SVG line/area chart, styled to match the
// dashboard: gradient-filled area for the left-axis (Mbps) series, and
// dotted/dashed lines for the right-axis (ms) series, with a hover
// tooltip. No charting library needed.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

/**
 * @param {HTMLElement} container
 * @param {Object} opts
 *   points: [{ t: number (ms epoch), label: string }]  x positions
 *   series: [{ key, label, color, axis: 'left'|'right', style: 'area'|'dotted'|'dashed', values: number[]|null[] }]
 *   leftLabel, rightLabel: axis titles
 *   visible: { [key]: boolean } which series are toggled on
 *   errorIndices: number[] — x-positions (indices into `points`) where the
 *     test failed, drawn as a thin dashed red marker line
 */
function renderChart(container, opts) {
  const { points, series, leftLabel, rightLabel, visible, errorIndices } = opts;
  container.innerHTML = '';

  if (!points.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'No data yet for this range — run a test to get started.';
    container.appendChild(empty);
    return;
  }

  const width = 900;
  const height = 320;
  const padding = { top: 16, right: 48, bottom: 30, left: 46 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const shown = series.filter((s) => visible[s.key] !== false);
  const leftSeries = shown.filter((s) => s.axis === 'left');
  const rightSeries = shown.filter((s) => s.axis === 'right');

  const leftMax = niceMax(maxOf(leftSeries));
  const rightMax = niceMax(maxOf(rightSeries));

  const n = points.length;
  const xAt = (i) => padding.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAtLeft = (v) => padding.top + plotH - (leftMax ? (v / leftMax) * plotH : 0);
  const yAtRight = (v) => padding.top + plotH - (rightMax ? (v / rightMax) * plotH : 0);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'speed-chart-svg',
    preserveAspectRatio: 'none'
  });

  // Gridlines + left axis labels
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = padding.top + (plotH / gridSteps) * i;
    svg.appendChild(el('line', {
      x1: padding.left, x2: width - padding.right, y1: y, y2: y,
      class: 'chart-grid'
    }));
    const val = Math.round(leftMax - (leftMax / gridSteps) * i);
    const t = el('text', { x: padding.left - 8, y: y + 4, class: 'chart-axis-label chart-axis-left' });
    t.textContent = val;
    svg.appendChild(t);
    if (rightSeries.length) {
      const rval = Math.round(rightMax - (rightMax / gridSteps) * i);
      const rt = el('text', { x: width - padding.right + 8, y: y + 4, class: 'chart-axis-label chart-axis-right' });
      rt.textContent = rval;
      svg.appendChild(rt);
    }
  }

  // X axis labels (sparse so they don't overlap)
  const maxLabels = 8;
  const stride = Math.max(1, Math.ceil(n / maxLabels));
  for (let i = 0; i < n; i += stride) {
    const t = el('text', { x: xAt(i), y: height - 8, class: 'chart-axis-label chart-axis-x', 'text-anchor': 'middle' });
    t.textContent = points[i].label;
    svg.appendChild(t);
  }

  const defs = el('defs');
  svg.appendChild(defs);

  // Draw area/line series
  shown.forEach((s) => {
    const yAt = s.axis === 'left' ? yAtLeft : yAtRight;
    const segments = toSegments(s.values);
    const bridges = toBridges(segments);

    if (s.style === 'area') {
      const gradId = `grad-${s.key}`;
      const grad = el('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': '0.35' }));
      grad.appendChild(el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': '0.02' }));
      defs.appendChild(grad);

      segments.forEach((seg) => {
        if (seg.length < 2) return;
        const top = seg.map((p) => `${xAt(p.i)},${yAt(p.v)}`).join(' L ');
        const areaPath = `M ${xAt(seg[0].i)},${padding.top + plotH} L ${top} L ${xAt(seg[seg.length - 1].i)},${padding.top + plotH} Z`;
        svg.appendChild(el('path', { d: areaPath, fill: `url(#${gradId})`, stroke: 'none' }));
        const linePath = `M ${top}`;
        svg.appendChild(el('path', { d: linePath, fill: 'none', stroke: s.color, 'stroke-width': '2' }));
      });
    } else {
      const dash = s.style === 'dotted' ? '1,5' : s.style === 'dashed' ? '7,5' : null;
      segments.forEach((seg) => {
        if (seg.length < 2) return;
        const d = 'M ' + seg.map((p) => `${xAt(p.i)},${yAt(p.v)}`).join(' L ');
        const attrs = { d, fill: 'none', stroke: s.color, 'stroke-width': '2' };
        if (dash) attrs['stroke-dasharray'] = dash;
        svg.appendChild(el('path', attrs));
      });
    }

    // Bridge the gap over any failed test(s) between two good readings,
    // in a thin red dashed line, so a single bad run doesn't make the
    // whole graph look like it restarted.
    bridges.forEach(([a, b]) => {
      const d = `M ${xAt(a.i)},${yAt(a.v)} L ${xAt(b.i)},${yAt(b.v)}`;
      svg.appendChild(el('path', {
        d, fill: 'none', stroke: 'var(--danger)',
        'stroke-width': '1.5', 'stroke-dasharray': '4,3', opacity: '0.85'
      }));
    });
  });

  // Vertical markers at each failed test, so it's clear exactly where a
  // gap in the data came from an error rather than just missing data.
  if (Array.isArray(errorIndices)) {
    errorIndices.forEach((i) => {
      const x = xAt(i);
      svg.appendChild(el('line', {
        x1: x, x2: x, y1: padding.top, y2: padding.top + plotH,
        stroke: 'var(--danger)', 'stroke-width': '1',
        'stroke-dasharray': '2,3', opacity: '0.5'
      }));
    });
  }

  // Axis titles
  if (leftLabel) {
    const t = el('text', {
      x: 12, y: padding.top + plotH / 2, class: 'chart-axis-title',
      transform: `rotate(-90 12 ${padding.top + plotH / 2})`
    });
    t.textContent = leftLabel;
    svg.appendChild(t);
  }
  if (rightLabel && rightSeries.length) {
    const t = el('text', {
      x: width - 12, y: padding.top + plotH / 2, class: 'chart-axis-title',
      transform: `rotate(90 ${width - 12} ${padding.top + plotH / 2})`
    });
    t.textContent = rightLabel;
    svg.appendChild(t);
  }

  // Hover interaction: vertical guide + tooltip
  const hoverLine = el('line', { class: 'chart-hover-line', x1: 0, x2: 0, y1: padding.top, y2: padding.top + plotH, style: 'display:none' });
  svg.appendChild(hoverLine);
  const hitRect = el('rect', {
    x: padding.left, y: padding.top, width: plotW, height: plotH,
    fill: 'transparent'
  });
  svg.appendChild(hitRect);

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);
  container.style.position = 'relative';

  hitRect.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const xPix = (ev.clientX - rect.left) * scaleX;
    let idx = Math.round(((xPix - padding.left) / plotW) * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));

    hoverLine.setAttribute('x1', xAt(idx));
    hoverLine.setAttribute('x2', xAt(idx));
    hoverLine.style.display = 'block';

    const rows = shown.map((s) => {
      const v = s.values[idx];
      const unit = s.axis === 'left' ? 'Mbps' : 'ms';
      return `<div class="chart-tooltip-row"><span class="dot" style="background:${s.color}"></span>${s.label}: <b>${v == null ? '—' : v}</b> ${unit}</div>`;
    }).join('');
    const isError = Array.isArray(errorIndices) && errorIndices.includes(idx);
    const errorRow = isError ? '<div class="chart-tooltip-row chart-tooltip-error">⚠ Test failed at this point</div>' : '';
    tooltip.innerHTML = `<div class="chart-tooltip-title">${points[idx].fullLabel || points[idx].label}</div>${rows}${errorRow}`;

    const containerRect = container.getBoundingClientRect();
    let left = (ev.clientX - containerRect.left) + 14;
    if (left + 200 > containerRect.width) left = (ev.clientX - containerRect.left) - 214;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${(ev.clientY - containerRect.top) - 10}px`;
    tooltip.style.display = 'block';
  });

  hitRect.addEventListener('mouseleave', () => {
    hoverLine.style.display = 'none';
    tooltip.style.display = 'none';
  });
}

function toSegments(values) {
  // Splits an array with nulls into contiguous runs of {i, v}
  const segments = [];
  let current = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ i, v });
    }
  });
  if (current.length) segments.push(current);
  return segments;
}

/** The straight connector between the end of one run and the start of the
 * next — i.e. the bit that spans over one or more failed/missing points.
 * Drawing these (in a distinct "error" style) instead of just leaving a
 * gap keeps the trend line continuous rather than looking like the graph
 * restarted from scratch after every failure. */
function toBridges(segments) {
  const bridges = [];
  for (let k = 0; k < segments.length - 1; k++) {
    const endOfPrev = segments[k][segments[k].length - 1];
    const startOfNext = segments[k + 1][0];
    bridges.push([endOfPrev, startOfNext]);
  }
  return bridges;
}

function maxOf(seriesList) {
  let max = 0;
  seriesList.forEach((s) => s.values.forEach((v) => { if (v != null && v > max) max = v; }));
  return max;
}

function niceMax(v) {
  if (v <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / magnitude;
  let niceNorm;
  if (norm <= 1) niceNorm = 1;
  else if (norm <= 2) niceNorm = 2;
  else if (norm <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * magnitude * 1.15;
}

window.NetPulseChart = { renderChart };
