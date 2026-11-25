/* TGE Flow — UI. All numbers come from data/pilot-data.js (synthetic pilot data)
 * and js/engine.js (planning engine). Nothing on screen is hard-coded. */
'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const D = window.TGE_DATA;
const E = window.TGEEngine;

const FN_COLORS = { Inbound: '#0ea5a6', Sortation: '#2f8b2e', 'Dock/Yard': '#d99b24', Linehaul: '#536a64', 'Last mile': '#8a6fd1' };
const REJECT_REASONS = ['Not enough cross-skilled staff on the floor', 'Agency / EA notice terms prevent the change', 'Local knowledge: volume will differ', 'Safety or equipment constraint', 'Other'];

const state = {
  view: 'overview', guidedStep: -1,
  scenario: { demandPct: 0, absences: 0, linehaulDelayMin: 0 },
  approved: new Set(), rejected: new Map(), audit: [],
  boardMode: 'rostered',
};

/* ---------- formatting ---------- */
const money = (n) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(n);
const num = (n) => new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }).format(n);
const pct = (n, d = 1) => `${n.toFixed(d)}%`;
const dayFmt = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', opts);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- computation cache ---------- */
const cache = new Map();
function model(scenario = state.scenario) {
  const key = JSON.stringify(scenario);
  if (!cache.has(key)) {
    const rec = E.recommend(D, scenario);
    cache.set(key, { rec, headroom: E.headroom(D, E.applyOps(E.scenarioRoster(D, scenario), rec.ops), scenario) });
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
const baseModel = () => model({ demandPct: 0, absences: 0, linehaulDelayMin: 0 });
function approvedPlan() {
  const { rec } = baseModel();
  return E.planWith(D, {}, rec, [...state.approved]);
}

/* ---------- charts ---------- */
function lineChart({ series, band, labels, height = 300, yFmt = num, divider, markers = [] }) {
  const W = 820, H = height, p = { l: 52, r: 18, t: 18, b: 36 };
  const all = series.flatMap((s) => s.values.filter((v) => v != null)).concat(band ? [...band.lo, ...band.hi].filter((v) => v != null) : []);
  const min = Math.min(...all), max = Math.max(...all), pad = (max - min) * 0.08 || 1;
  const y0 = min - pad, y1 = max + pad, n = labels.length;
  const x = (i) => p.l + i * (W - p.l - p.r) / (n - 1);
  const y = (v) => p.t + (y1 - v) * (H - p.t - p.b) / (y1 - y0);
  let g = '';
  for (let k = 0; k < 5; k++) { const yy = p.t + k * (H - p.t - p.b) / 4; const val = y1 - k * (y1 - y0) / 4; g += `<line x1="${p.l}" x2="${W - p.r}" y1="${yy}" y2="${yy}" stroke="#e5eae7"/><text x="${p.l - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#7a8984">${yFmt(val)}</text>`; }
  const step = Math.ceil(n / 9);
  labels.forEach((l, i) => { if (i % step === 0 || i === n - 1) g += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle" font-size="9.5" fill="#7a8984">${l}</text>`; });
  let b = '';
  if (band) {
    const idx = band.lo.map((v, i) => (v == null ? null : i)).filter((i) => i != null);
    const top = idx.map((i) => `${x(i)},${y(band.hi[i])}`).join(' ');
    const bot = [...idx].reverse().map((i) => `${x(i)},${y(band.lo[i])}`).join(' ');
    b = `<polygon points="${top} ${bot}" fill="#dff3f5" opacity=".95"/>`;
  }
  const path = (vals) => { let d = '', pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `; pen = true; }); return d; };
  const lines = series.map((s) => `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 3}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`).join('');
  const div = divider != null ? `<line x1="${x(divider)}" x2="${x(divider)}" y1="${p.t}" y2="${H - p.b}" stroke="#9eb0aa" stroke-dasharray="5 5"/><text x="${x(divider) + 8}" y="${p.t + 12}" font-size="10" fill="#0ea5a6" font-weight="700">forecast window</text>` : '';
  const mk = markers.map((m) => `<circle cx="${x(m.i)}" cy="${y(m.v)}" r="4" fill="${m.color || '#c9564f'}"/><text x="${x(m.i)}" y="${y(m.v) - 9}" text-anchor="middle" font-size="9.5" font-weight="700" fill="${m.color || '#c9564f'}">${esc(m.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${g}${b}${div}${lines}${mk}<line x1="${p.l}" x2="${W - p.r}" y1="${H - p.b}" y2="${H - p.b}" stroke="#bcc8c3"/></svg>`;
}

function hourLabels() { return E.HOURS.map((h) => `${String(h).padStart(2, '0')}:00`); }

function gapChart(req, sup, sup2) {
  const W = 820, H = 300, p = { l: 42, r: 14, t: 16, b: 36 };
  const n = req.length, max = Math.max(...req, ...sup, ...(sup2 || [])) * 1.08;
  const x = (i) => p.l + (i + 0.5) * (W - p.l - p.r) / n, y = (v) => p.t + (max - v) * (H - p.t - p.b) / max;
  let g = '';
  for (let v = 0; v <= max; v += 5) { g += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e5eae7"/><text x="${p.l - 7}" y="${y(v) + 3}" text-anchor="end" font-size="9.5" fill="#7a8984">${v}</text>`; }
  let a = '';
  for (let i = 0; i < n - 1; i++) {
    const over = sup[i] + sup[i + 1] >= req[i] + req[i + 1];
    a += `<polygon points="${x(i)},${y(sup[i])} ${x(i + 1)},${y(sup[i + 1])} ${x(i + 1)},${y(req[i + 1])} ${x(i)},${y(req[i])}" fill="${over ? '#dff3f5' : '#fde9e7'}"/>`;
  }
  const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(v)}`).join(' ');
  hourLabels().forEach((l, i) => { if (i % 2 === 0) g += `<text x="${x(i)}" y="${H - 14}" text-anchor="middle" font-size="9.5" fill="#7a8984">${l}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rostered supply vs required FTE by hour">${g}${a}
    <path d="${line(sup)}" fill="none" stroke="#536a64" stroke-width="3"/>
    ${sup2 ? `<path d="${line(sup2)}" fill="none" stroke="#0ea5a6" stroke-width="2.6" stroke-dasharray="7 5"/>` : ''}
    <path d="${line(req)}" fill="none" stroke="#7edb3f" stroke-width="3.4"/>
    <text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle" font-size="10" fill="#7a8984">FTE on the floor</text></svg>`;
}

function stackedChart(byFn) {
  const W = 820, H = 260, p = { l: 42, r: 14, t: 12, b: 34 };
  const n = E.HOURS.length;
  const totals = E.HOURS.map((_, i) => E.FUNCTIONS.reduce((a, f) => a + byFn[f][i], 0));
  const max = Math.max(...totals) * 1.1;
  const bw = (W - p.l - p.r) / n;
  const y = (v) => p.t + (max - v) * (H - p.t - p.b) / max;
  let g = '';
  for (let v = 0; v <= max; v += 5) g += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1ef"/><text x="${p.l - 7}" y="${y(v) + 3}" text-anchor="end" font-size="9.5" fill="#7a8984">${v}</text>`;
  let bars = '';
  E.HOURS.forEach((h, i) => {
    let acc = 0;
    E.FUNCTIONS.forEach((f) => { const v = byFn[f][i]; if (v <= 0.01) return; bars += `<rect x="${p.l + i * bw + 3}" y="${y(acc + v)}" width="${bw - 6}" height="${y(acc) - y(acc + v)}" fill="${FN_COLORS[f]}" rx="2"><title>${f} ${h}:00 — ${v.toFixed(1)} FTE</title></rect>`; acc += v; });
    if (i % 2 === 0) g += `<text x="${p.l + i * bw + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="9.5" fill="#7a8984">${String(h).padStart(2, '0')}:00</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Required FTE by function and hour">${g}${bars}</svg>`;
}

function barChart(items, { height = 200, fmt = (v) => v.toFixed(2), ref = 1, color = '#2f8b2e' }) {
  const W = 820, H = height, p = { l: 10, r: 10, t: 18, b: 30 };
  const max = Math.max(...items.map((d) => d.v), ref) * 1.12, bw = (W - p.l - p.r) / items.length;
  const y = (v) => p.t + (max - v) * (H - p.t - p.b) / max;
  let s = `<line x1="${p.l}" x2="${W - p.r}" y1="${y(ref)}" y2="${y(ref)}" stroke="#9eb0aa" stroke-dasharray="4 4"/>`;
  items.forEach((d, i) => {
    s += `<rect x="${p.l + i * bw + bw * 0.18}" y="${y(d.v)}" width="${bw * 0.64}" height="${y(0) - y(d.v)}" rx="4" fill="${d.color || color}"/>`;
    s += `<text x="${p.l + i * bw + bw / 2}" y="${y(d.v) - 5}" text-anchor="middle" font-size="10" font-weight="700" fill="#0d201d">${fmt(d.v)}</text>`;
    s += `<text x="${p.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#7a8984">${esc(d.k)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${s}</svg>`;
}

function waterfall(steps) {
  const W = 820, H = 260, p = { l: 40, r: 10, t: 22, b: 40 };
  const lo = Math.floor(Math.min(...steps.filter((s) => s.total).map((s) => s.v)) - 3), hi = 101;
  const bw = (W - p.l - p.r) / steps.length;
  const y = (v) => p.t + (hi - v) * (H - p.t - p.b) / (hi - lo);
  let s = '', level = 100;
  for (let v = Math.ceil(lo); v <= 100; v += 2) s += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef1ef"/><text x="${p.l - 6}" y="${y(v) + 3}" text-anchor="end" font-size="9" fill="#7a8984">${v}</text>`;
  steps.forEach((st, i) => {
    const x0 = p.l + i * bw + bw * 0.2, w = bw * 0.6;
    if (st.total) {
      s += `<rect x="${x0}" y="${y(st.v)}" width="${w}" height="${y(lo) - y(st.v)}" rx="3" fill="${i === 0 ? '#0ea5a6' : '#7edb3f'}"/><text x="${x0 + w / 2}" y="${y(st.v) - 6}" text-anchor="middle" font-size="11" font-weight="800">${st.v.toFixed(1)}</text>`;
      level = st.v;
    } else {
      const top = y(level), bot = y(level - st.v);
      s += `<rect x="${x0}" y="${top}" width="${w}" height="${Math.max(2, bot - top)}" rx="3" fill="${st.v >= 0 ? '#e07a73' : '#9eb0aa'}"/><text x="${x0 + w / 2}" y="${top - 6}" text-anchor="middle" font-size="10.5" font-weight="700" fill="#8f302b">${st.v >= 0 ? '−' : '+'}${Math.abs(st.v).toFixed(1)}</text>`;
      level -= st.v;
    }
    s += `<text x="${x0 + w / 2}" y="${H - 22}" text-anchor="middle" font-size="9.5" fill="#687872">${esc(st.k.split('|')[0])}</text><text x="${x0 + w / 2}" y="${H - 10}" text-anchor="middle" font-size="9.5" fill="#687872">${esc(st.k.split('|')[1] || '')}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Labour cost per item index waterfall">${s}</svg>`;
}

function shiftBoard(ev) {
  const roster = [...ev.roster].sort((a, b) => a.start - b.start || a.home.localeCompare(b.home));
  const hours = E.HOURS;
  const head = hours.map((h) => `<div class="sb-h">${h % 2 === 1 ? '' : String(h).padStart(2, '0')}</div>`).join('');
  const rows = roster.map((p) => {
    const cells = hours.map((h, i) => {
      const f = ev.board[p.id] && ev.board[p.id][i];
      const pres = E.presence(p, h);
      if (!f || pres <= 0) return `<div class="sb-c"></div>`;
      const moved = f !== p.home;
      return `<div class="sb-c on ${moved ? 'moved' : ''}" style="background:${FN_COLORS[f]};opacity:${pres < 0.99 ? 0.55 : 1}" title="${p.id} ${h}:00 — ${f}${moved ? ' (moved from ' + p.home + ')' : ''}"></div>`;
    }).join('');
    const tag = p.added ? '<span class="pill warn">added</span>' : p.contract === 'agency' ? '<span class="pill">agency</span>' : p.contract === 'casual' ? '<span class="pill">casual</span>' : '';
    return `<div class="sb-row"><div class="sb-id"><b>${p.id}</b><small>${p.home} ${tag}</small></div>${cells}</div>`;
  }).join('');
  return `<div class="shift-board"><div class="sb-row sb-head"><div class="sb-id"></div>${head}</div>${rows}</div>`;
}

/* ---------- shared bits ---------- */
function kpi(label, value, sub, cls = '', delta = '') {
  return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub ${cls ? 'kpi-delta ' + cls : ''}">${delta || sub}</div>${delta ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}
const legend = (items) => `<div class="chart-legend">${items.map(([c, l, box]) => `<span class="legend-item"><i class="${box ? 'legend-box' : 'legend-swatch'}" style="background:${c}"></i>${l}</span>`).join('')}</div>`;

const T = D.tomorrow;
const isSat = (iso) => new Date(iso + 'T00:00:00').getDay() === 6;
function weekdays(n) {
  const idx = D.history.dates.map((d, i) => i).filter((i) => !isSat(D.history.dates[i])).slice(-n);
  return { dates: idx.map((i) => D.history.dates[i]), values: idx.map((i) => D.history.total[i]) };
}
const tomorrowLabel = dayFmt(T.date, { weekday: 'long', day: 'numeric', month: 'short' });

/* ---------- views ---------- */
function renderOverview() {
  const { rec, headroom } = baseModel();
  const b = rec.base, a = rec.after;
  const top = rec.actions[0];
  const directSaving = b.cost.aud - a.cost.aud;
  const totalBenefit = b.totalCost - a.totalCost;
  const wk = weekdays(30), histVals = wk.values, fc = D.forecast.filter((f) => !isSat(f.date));
  const labels = [...wk.dates, ...fc.map((f) => f.date)].map((d) => dayFmt(d, { day: 'numeric', month: 'short' }));
  const nH = histVals.length;
  const pad = (arr, before, after) => [...Array(before).fill(null), ...arr, ...Array(after).fill(null)];
  const bfIdx = fc.findIndex((f) => f.event === 'Cyber Monday');
  return `<div class="page">
    <div class="hero-card">
      <div>
        <div class="hero-title">Tomorrow · ${tomorrowLabel} · ${D.depot.name}</div>
        <div class="hero-value">${num(T.p50)} items <span class="up">+${T.delta_pct}%</span><span class="hero-vs">vs a typical Thursday (${num(T.typical_thursday)})</span></div>
        <div class="hero-copy">Pre-Black Friday freight is parcel-heavy and lands later in the day. As rostered, the depot runs <b>${pct(b.sim.ontimePct)}</b> on time, with ${num(b.sim.lateItems)} items missing a P&D run or linehaul cut-off. ${rec.actions.length} decisions take it to <b>${pct(a.sim.ontimePct)}</b> and cut direct labour cost by <b>${money(directSaving)}</b>, with no extra permanent hours.</div>
        <div class="hero-actions">
          <button class="btn primary" data-go="forecast">Why is demand changing?</button>
          <button class="btn secondary" data-go="workforce">Compare roster vs required</button>
          <button class="btn green" data-go="actions">Review ${rec.actions.length} actions</button>
        </div>
      </div>
      <div class="hero-side">
        <div><div class="caption">Decisions requiring attention</div><div class="decision-num">${rec.actions.length}</div></div>
        <div><strong>Resolve before 17:00 today</strong><div class="caption" style="margin-top:4px">${rec.actions.map((x) => x.type.toLowerCase()).join(' · ')}</div></div>
      </div>
    </div>
    <div class="kpi-grid">
      ${kpi('Forecast range (P10–P90)', `${num(T.p10)}–${num(T.p90)}`, `Back-test MAPE ${D.backtest.summary.weekday_model_mape}% vs ${D.backtest.summary.weekday_planner_mape}% today`)}
      ${kpi('Rostered paid hours', `${num(b.cost.hours)} h`, `${D.roster.length} people · ${b.cost.otHours} h planned OT`)}
      ${kpi('Required labour', `${num(b.requiredHours)} h`, 'Demand-led, incl. 12% PFD allowance', 'good', `${num(b.cost.hours - b.requiredHours)} h roster headroom`)}
      ${kpi('On-time dispatch', pct(a.sim.ontimePct), `As rostered: ${pct(b.sim.ontimePct)}`, a.sim.ontimePct >= 99 ? 'good' : 'warn', `+${(a.sim.ontimePct - b.sim.ontimePct).toFixed(1)} pts with actions`)}
      ${kpi('Plan holds to', `P${headroom.percentile}`, `+${headroom.demandPct}% demand before service drops`, headroom.percentile >= 80 ? 'good' : 'warn', `Value of tomorrow's plan ${money(totalBenefit)}`)}
    </div>
    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Tomorrow's operating shape</h2><div class="panel-sub">Last 30 weekdays of depot volume running into the forecast (Saturdays hidden for readability). Black Friday and Cyber Monday fall inside the window.</div></div><button class="mini-btn" data-go="forecast">Open forecast</button></div>
        <div class="chart-wrap">${lineChart({ labels, divider: nH - 1,
          series: [{ values: pad(histVals, 0, fc.length), color: '#2f8b2e' }, { values: pad([histVals[nH - 1], ...fc.map((f) => f.p50)], nH - 1, 0), color: '#0ea5a6', dash: '8 6' }],
          band: { lo: pad(fc.map((f) => f.p10), nH, 0), hi: pad(fc.map((f) => f.p90), nH, 0) },
          markers: [{ i: nH, v: fc[0].p50, label: 'Tomorrow', color: '#0d201d' }, ...(bfIdx >= 0 ? [{ i: nH + bfIdx, v: fc[bfIdx].p50, label: 'Cyber Monday' }] : [])] })}</div>
        ${legend([['#2f8b2e', 'Observed'], ['#0ea5a6', 'Forecast (P50)'], ['#dff3f5', 'P10–P90 band', true]])}
      </div>
      <div class="panel dark">
        <div class="panel-title-row"><div><h2>Top operating decision</h2><div class="panel-sub">Ranked by service risk, then value</div></div><span class="pill risk">Priority 1</span></div>
        <h3 style="font-size:16px;line-height:1.35">${esc(top.title)}</h3>
        <div class="metric-list" style="margin-top:18px">
          <div class="metric-row"><span>Late items avoided</span><strong>${num(top.lateBefore - top.lateAfter)}</strong></div>
          <div class="metric-row"><span>Value (recovery + service)</span><strong>${money(top.saving)}</strong></div>
          <div class="metric-row"><span>Confidence</span><strong>${top.confidence}%</strong></div>
        </div>
        <button class="btn green" style="margin-top:18px;width:100%" onclick="openAction('${top.id}')">Review recommendation</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Decision timeline</h2><div class="panel-sub">From the T−18h demand lock to next-day cost proof. Read-only: nothing is written back to rostering.</div></div></div>
      <div class="timeline">
        ${[['T−18h', 'Demand lock', 'Booked pickups, EDI manifests, linehaul ETAs', 'done'], ['T−12h', 'Roster option', 'Qualified re-allocations, re-timing, agency', 'done'], ['T−4h', 'Recheck', 'Latest scan wave, delays, absences', 'now'], ['T+0', 'Manager action', 'Approve / reject with reason codes', 'next'], ['T+12h', 'Cost proof', 'Payroll hours, agency invoices, SLA', 'next']]
          .map(([t, h, s, st]) => `<div class="tl-step ${st}"><span>${t}</span><strong>${h}</strong><small>${s}</small></div>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderForecast() {
  const bt = D.backtest, s = bt.summary;
  const wk = weekdays(40), hist = wk.values, fc = D.forecast.filter((f) => !isSat(f.date));
  const labels = [...wk.dates, ...fc.map((f) => f.date)].map((d) => dayFmt(d, { day: 'numeric', month: 'short' }));
  const nH = hist.length, pad = (arr, b, a) => [...Array(b).fill(null), ...arr, ...Array(a).fill(null)];
  const maxDrv = Math.max(...T.drivers.map((d) => Math.abs(d[1])));
  return `<div class="page">
    <div class="callout"><div><strong>Prediction before action</strong><span> · Daily depot volume with P10–P90 bands, explained by the signals that moved it.</span></div><button class="btn primary" data-go="workload">Translate to workload →</button></div>
    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Depot demand forecast</h2><div class="panel-sub">40 weekdays of history and the next two weeks (Saturdays hidden; see table for all operating days). The model is a log-linear regression on weekday, seasonality, NSW holidays, retail events, EDI manifests and booked pickups.</div></div><span class="pill good">P10–P90 coverage ${s.p10_p90_coverage_pct}%</span></div>
        <div class="chart-wrap">${lineChart({ labels, divider: nH - 1,
          series: [{ values: pad(hist, 0, fc.length), color: '#2f8b2e' }, { values: pad([hist[nH - 1], ...fc.map((f) => f.p50)], nH - 1, 0), color: '#0ea5a6', dash: '8 6' }],
          band: { lo: pad(fc.map((f) => f.p10), nH, 0), hi: pad(fc.map((f) => f.p90), nH, 0) },
          markers: fc.map((f, i) => ({ f, i })).filter(({ f }) => ['Black Friday', 'Cyber Monday'].includes(f.event)).map(({ f, i }) => ({ i: nH + i, v: f.p50, label: f.event })) })}</div>
        ${legend([['#2f8b2e', 'Observed depot volume'], ['#0ea5a6', 'Forecast P50'], ['#dff3f5', 'P10–P90', true]])}
      </div>
      <div class="panel">
        <div class="panel-title-row"><div><h2>Why tomorrow is +${T.delta_pct}%</h2><div class="panel-sub">Contribution vs the average of the last 8 normal Thursdays (${num(T.typical_thursday)} items).</div></div></div>
        <div class="driver-list">${T.drivers.map(([k, v]) => `<div class="driver-row"><span class="driver-label">${esc(k)}</span><span class="driver-val kpi-delta ${v < 0 ? 'risk' : 'good'}">${v > 0 ? '+' : ''}${v}%</span><div class="driver-bar"><span style="width:${Math.abs(v) / maxDrv * 100}%;background:${v < 0 ? '#c9564f' : '#7edb3f'}"></span></div></div>`).join('')}</div>
        <div class="callout" style="margin-top:16px"><div><strong>Next 12 days</strong><span> · Cyber Monday peaks at ${num(Math.max(...fc.map((f) => f.p50)))} items</span></div><strong>High</strong></div>
      </div>
    </div>
    <div class="split-equal">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Back-test: is the forecast good enough to act on?</h2><div class="panel-sub">Rolling 1-day-ahead forecasts over ${s.window_operating_days} operating days, refit weekly, compared with today's method (same-weekday 4-week average). Last 50 weekdays shown.</div></div></div>
        <div class="chart-wrap">${(() => { const ix = bt.dates.map((d, i) => i).filter((i) => !isSat(bt.dates[i])); const pick = (a) => ix.map((i) => a[i]);
          return lineChart({ labels: pick(bt.dates).map((d) => dayFmt(d, { day: 'numeric', month: 'short' })), height: 220,
          series: [{ values: pick(bt.actual), color: '#0d201d', width: 2 }, { values: pick(bt.planner), color: '#d99b24', width: 2, dash: '5 4' }, { values: pick(bt.model), color: '#0ea5a6', width: 2.4 }] }); })()}</div>
        ${legend([['#0d201d', 'Actual'], ['#0ea5a6', `TGE Flow · MAPE ${s.weekday_model_mape}%`], ['#d99b24', `Today's method · MAPE ${s.weekday_planner_mape}%`]])}
      </div>
      <div class="panel">
        <div class="panel-title-row"><div><h2>Forecast horizon</h2><div class="panel-sub">Operating days only (Sundays closed). The band widens with the horizon.</div></div></div>
        <table class="table"><thead><tr><th>Day</th><th>P10</th><th>P50</th><th>P90</th><th>Event</th></tr></thead><tbody>
          ${fc.map((f, i) => `<tr${i === 0 ? ' class="hl"' : ''}><td>${dayFmt(f.date)}</td><td>${num(f.p10)}</td><td><b>${num(f.p50)}</b></td><td>${num(f.p90)}</td><td>${f.event ? `<span class="pill ${/Cyber|Black/.test(f.event) ? 'risk' : 'warn'}">${esc(f.event)}</span>` : ''}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Signals the forecast uses</h2><div class="panel-sub">Every signal maps to a MyTeamGE / depot system TGE already runs. In the pilot these come through the read-only data contract.</div></div></div>
      <div class="workload-grid">
        ${[['Rate & transit', 'service · lane · promise', 'demand signal'], ['Create shipment (EDI)', 'manifested items in transit', 'demand signal'], ['Book pickup', 'customer bookings & bulk pre-advice', 'capacity signal'], ['Track & trace scans', 'linehaul ETAs, dwell, exceptions', 'risk signal'], ['Calendar', 'NSW holidays · Black Friday · EOFY', 'seasonality']]
          .map(([a, b2, c]) => `<div class="workload-card"><div class="name">${a}</div><div class="tiny">${b2}</div><div class="pill good" style="margin-top:10px">${c}</div></div>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderWorkload() {
  const { rec } = baseModel();
  const wl = rec.base.wl;
  const fnHours = E.FUNCTIONS.map((f) => ({ f, h: wl.required[f].reduce((a, b) => a + b, 0), items: wl.items[f].reduce((a, b) => a + b, 0), peak: Math.max(...wl.required[f]) }));
  const maxH = Math.max(...fnHours.map((x) => x.h));
  const sc = D.site_coefficients;
  const heat = (v) => { const t = Math.max(0, Math.min(1, (v - 0.78) / 0.34)); const r = Math.round(224 - t * 120), g = Math.round(110 + t * 110), b2 = Math.round(80 + t * 20); return `rgb(${r},${g},${b2})`; };
  return `<div class="page">
    <div class="callout"><div><strong>${num(T.p50)} items ≠ ${num(T.p50)} identical units of work</strong><span> · Required hours = volume × mix × arrival wave × engineered standard ÷ site coefficient ÷ (1 − PFD).</span></div><button class="btn primary" data-go="workforce">Compare roster →</button></div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Workload translator · tomorrow</h2><div class="panel-sub">Required labour-hours by function, including the 12% personal, fatigue and delay allowance.</div></div><span class="pill good">${num(rec.base.requiredHours)} h total</span></div>
      <div class="workload-grid">${fnHours.map((x) => `<div class="workload-card"><div class="name"><i class="dot" style="background:${FN_COLORS[x.f]}"></i>${x.f}</div><div class="big">${x.h.toFixed(1)} h</div><div class="tiny">${x.items > 0 ? num(x.items) + ' items/pallets · ' : ''}peak ${x.peak.toFixed(1)} FTE</div><div class="workload-bar"><span style="width:${x.h / maxH * 100}%;background:${FN_COLORS[x.f]}"></span></div></div>`).join('')}</div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Required FTE by hour and function</h2><div class="panel-sub">Two waves: overnight linehaul feeding P&D runs, then afternoon pickups feeding outbound linehaul.</div></div></div>
      <div class="chart-wrap">${stackedChart(wl.required)}</div>
      ${legend(E.FUNCTIONS.map((f) => [FN_COLORS[f], f, true]))}
    </div>
    <div class="split-equal">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Site productivity coefficients</h2><div class="panel-sub">Observed throughput ÷ engineered standard by function and window. In the pilot these are measured from scan timestamps against rostered hours.</div></div></div>
        <table class="heat"><thead><tr><th></th>${sc.windows.map((w) => `<th>${w}</th>`).join('')}</tr></thead><tbody>
          ${sc.functions.map((f, i) => `<tr><th>${f}</th>${sc.values[i].map((v) => `<td style="background:${heat(v)}">${v.toFixed(2)}</td>`).join('')}</tr>`).join('')}
        </tbody></table>
      </div>
      <div class="panel">
        <div class="panel-title-row"><div><h2>Engineered labour standards</h2><div class="panel-sub">Synthetic starting values. Week 1–2 of the pilot calibrates them with time-and-motion and scan data.</div></div></div>
        <table class="table"><thead><tr><th>Function</th><th>Task</th><th>Rate / labour-h</th></tr></thead><tbody>
          ${D.standards.map((s) => `<tr><td>${s.function}</td><td>${esc(s.task)}<div class="tiny">${esc(s.source)}</div></td><td><b>${s.rate}</b> ${esc(s.driver.split(' ')[0])}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Tomorrow's inbound linehaul</h2><div class="panel-sub">Scheduled arrivals and manifested items. Long-haul lanes carry the delay risk tested on the Scenarios page.</div></div></div>
      <table class="table"><thead><tr><th>Trailer</th><th>Origin</th><th>Distance</th><th>Transit</th><th>Sched. arrival</th><th>Items</th><th>Pallets</th><th>Delay risk</th></tr></thead><tbody>
        ${T.inbound_trailers.slice().sort((a, b2) => a.sched_arrival.localeCompare(b2.sched_arrival)).map((t) => `<tr><td>${t.trailer}</td><td>${t.origin}</td><td>${num(t.distance_km)} km</td><td>${t.transit_h} h</td><td><b>${t.sched_arrival}</b></td><td>${num(t.items)}</td><td>${t.pallets}</td><td><span class="pill ${t.delay_risk === 'High' ? 'risk' : t.delay_risk === 'Medium' ? 'warn' : 'good'}">${t.delay_risk}</span></td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;
}

function exceptionWindows(ev) {
  const rows = [];
  E.FUNCTIONS.forEach((f) => {
    let s = null;
    ev.gap[f].forEach((g, i) => {
      const bad = g >= 1.2 || g <= -0.6;
      const sign = g > 0 ? 1 : -1;
      if (bad && s === null) s = { i, sign };
      else if (s !== null && (!bad || sign !== s.sign)) { rows.push({ f, a: s.i, b: i, sign: s.sign }); s = bad ? { i, sign } : null; }
    });
    if (s) rows.push({ f, a: s.i, b: ev.gap[f].length, sign: s.sign });
  });
  return rows.filter((r) => r.b - r.a >= (r.sign < 0 ? 1 : 2)).map((r) => ({ ...r, mag: ev.gap[r.f].slice(r.a, r.b).reduce((x, y) => x + y, 0) / (r.b - r.a) })).sort((x, y) => (x.sign - y.sign) || Math.abs(y.mag) * (y.b - y.a) - Math.abs(x.mag) * (x.b - x.a)).slice(0, 7);
}

function renderWorkforce() {
  const { rec } = baseModel();
  const b = rec.base, a = rec.after;
  const plan = state.boardMode === 'rostered' ? b : state.boardMode === 'approved' ? approvedPlan() : a;
  const ex = exceptionWindows(b);
  return `<div class="page">
    <div class="two-col">
      <div class="panel">
        <div class="panel-title-row"><div><h2>Workforce requirement by hour</h2><div class="panel-sub">Where tomorrow's roster and the demand-led requirement diverge.</div></div><button class="btn primary" data-go="actions">Recommend actions →</button></div>
        <div class="chart-wrap">${gapChart(b.reqTotal, b.supTotal, a.supTotal)}</div>
        ${legend([['#7edb3f', 'Required (forecast)'], ['#536a64', 'As rostered'], ['#0ea5a6', 'TGE Flow plan'], ['#dff3f5', 'Over-staffed', true], ['#fde9e7', 'Under-staffed', true]])}
      </div>
      <div class="panel dark">
        <div class="panel-title-row"><div><h2>Roster at a glance</h2><div class="panel-sub">${D.roster.length} people built by today's method: recent-Thursday average × ${(1 + D.typical.buffer_pct / 100).toFixed(2)} buffer, typical-day shape.</div></div></div>
        <div class="metric-list" style="margin-top:14px">
          <div class="metric-row"><span>Permanent · casual · agency</span><strong>${D.depot.headcount.permanent} · ${D.depot.headcount.casual} · ${D.depot.headcount.agency}</strong></div>
          <div class="metric-row"><span>Paid hours (as rostered → plan)</span><strong>${num(b.cost.hours)} → ${num(a.cost.hours)}</strong></div>
          <div class="metric-row"><span>Direct labour cost</span><strong>${money(b.cost.aud)} → ${money(a.cost.aud)}</strong></div>
          <div class="metric-row"><span>Late items (as rostered → plan)</span><strong>${num(b.sim.lateItems)} → ${num(a.sim.lateItems)}</strong></div>
          <div class="metric-row"><span>Cross-skilled (2+ functions)</span><strong>${D.roster.filter((p) => p.skills.length > 1).length} of ${D.roster.length}</strong></div>
        </div>
        <div class="callout" style="margin-top:18px;background:#16312c;border-color:#2c5149;color:white"><div><strong>Manager value</strong><span style="color:#a8bbb5"> · who to move, when, why, and what cost and service risk changes.</span></div></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Exception windows · as rostered</h2><div class="panel-sub">The periods worth discussing in the room.</div></div></div>
      <table class="table"><thead><tr><th>Window</th><th>Function</th><th>Average gap</th><th>Likely effect</th><th>Handled by</th></tr></thead><tbody>
        ${ex.map((r) => `<tr><td>${E.fmt(E.HOURS[r.a])}–${E.fmt(E.HOURS[r.b - 1] + 1)}</td><td><i class="dot" style="background:${FN_COLORS[r.f]}"></i>${r.f}</td><td><b>${r.mag > 0 ? '+' : ''}${r.mag.toFixed(1)} FTE</b></td><td>${r.mag > 0 ? 'Paid idle time / redeployment pool' : 'Queue builds toward cut-off'}</td><td><span class="pill ${r.mag > 0 ? 'good' : 'risk'}">${r.mag > 0 ? 'Re-allocate / delay starts' : 'Re-allocate / re-time'}</span></td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Shift board</h2><div class="panel-sub">Each row is a rostered person and each cell an hour, coloured by the function they work. Outlined cells are moves away from the home function.</div></div>
        <div class="seg">${[['rostered', 'As rostered'], ['approved', `Approved (${state.approved.size})`], ['plan', 'Full TGE Flow plan']].map(([k, l]) => `<button class="${state.boardMode === k ? 'on' : ''}" onclick="setBoard('${k}')">${l}</button>`).join('')}</div></div>
      ${legend(E.FUNCTIONS.map((f) => [FN_COLORS[f], f, true]))}
      ${shiftBoard(plan)}
    </div>
  </div>`;
}

function actionCard(a) {
  const st = state.approved.has(a.id) ? '<span class="pill good">Approved</span>' : state.rejected.has(a.id) ? `<span class="pill risk">Rejected · ${esc(state.rejected.get(a.id))}</span>` : '<span class="pill warn">Pending</span>';
  return `<div class="action-card"><div class="priority ${a.priority}">${a.rank}</div><div><strong>${esc(a.title)}</strong><p>${esc(a.desc)}</p>
    <div class="action-meta"><span>Type <b>${a.type}</b></span><span>Value <b>${money(a.saving)}</b></span><span>Service <b>${esc(a.service)}</b></span><span>Confidence <b>${a.confidence}%</b></span>${st}</div></div>
    <div class="action-buttons"><button class="mini-btn" onclick="openAction('${a.id}')">Review</button><button class="mini-btn primary" onclick="openSim('${a.id}')">Simulate</button></div></div>`;
}

function renderActions() {
  const { rec } = baseModel();
  const plan = approvedPlan();
  const pending = rec.actions.length - state.approved.size - state.rejected.size;
  return `<div class="page">
    <div class="callout"><div><strong>${rec.actions.length} decisions need attention before 17:00</strong><span> · ranked by service risk, then value, then confidence.</span></div><button class="btn secondary" onclick="openSim('${rec.actions[0].id}')">Compare alternatives</button></div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Supervisor action queue</h2><div class="panel-sub">Every recommendation shows why, the action, cost and service impact, and confidence.</div></div></div>
      <div class="action-list">${rec.actions.map(actionCard).join('')}</div>
    </div>
    <div class="split-equal">
      <div class="panel dark"><h2>Approved plan · live readout</h2><div class="panel-sub">Recomputed by the engine from the approved subset. Nothing is written back to rostering.</div>
        <div class="metric-list" style="margin-top:16px">
          <div class="metric-row"><span>Approved · rejected · pending</span><strong>${state.approved.size} · ${state.rejected.size} · ${pending}</strong></div>
          <div class="metric-row"><span>On-time dispatch</span><strong>${pct(rec.base.sim.ontimePct)} → ${pct(plan.sim.ontimePct)}</strong></div>
          <div class="metric-row"><span>Late items</span><strong>${num(rec.base.sim.lateItems)} → ${num(plan.sim.lateItems)}</strong></div>
          <div class="metric-row"><span>Direct labour cost</span><strong>${money(rec.base.cost.aud)} → ${money(plan.cost.aud)}</strong></div>
          <div class="metric-row"><span>Cost incl. recovery & service</span><strong>${money(rec.base.totalCost)} → ${money(plan.totalCost)}</strong></div>
        </div></div>
      <div class="panel"><h2>Audit trail & feedback loop</h2><div class="panel-sub">Every decision is logged with a timestamp and reason code. Rejections feed the weekly model review.</div>
        <div class="audit">${state.audit.length ? state.audit.slice().reverse().map((e) => `<div class="audit-row"><span>${e.t}</span><b>${e.what}</b><small>${esc(e.title)}${e.reason ? ' · ' + esc(e.reason) : ''}</small></div>`).join('') : '<div class="tiny" style="padding:12px 0">No decisions recorded yet.</div>'}</div>
        <div class="callout" style="margin-top:12px"><div><strong>Decision rule</strong><span> · minimise labour cost + overtime + backlog risk, subject to SLA cut-offs, skills, breaks and labour rules.</span></div></div></div>
    </div>
  </div>`;
}

function renderScenarios() {
  const sc = state.scenario;
  const { rec, headroom } = model(sc);
  const b = rec.base, a = rec.after;
  const ref = baseModel().rec;
  return `<div class="page">
    <div class="panel">
      <div class="panel-title-row"><div><h2>Stress-test tomorrow</h2><div class="panel-sub">Change an assumption and the engine re-plans: workload, allocation, queues and recommendations are all recomputed.</div></div><button class="btn secondary" onclick="resetScenario()">Reset scenario</button></div>
      <div class="scenario-toolbar">
        <button class="scenario-chip" onclick="presetScenario('demand')">Demand +15%</button>
        <button class="scenario-chip" onclick="presetScenario('absence')">6 unplanned absences</button>
        <button class="scenario-chip" onclick="presetScenario('late')">Hume Hwy storm: linehaul +90 min</button>
        <button class="scenario-chip" onclick="presetScenario('combo')">Bad Thursday (all three)</button>
      </div>
      <div class="range-row"><label>Demand variance vs forecast</label><input id="demandRange" type="range" min="-15" max="25" step="1" value="${sc.demandPct}" oninput="updateScenario('demandPct',this.value)"><div class="range-value">${sc.demandPct > 0 ? '+' : ''}${sc.demandPct}%</div></div>
      <div class="range-row"><label>Unplanned absences</label><input id="absenceRange" type="range" min="0" max="12" step="1" value="${sc.absences}" oninput="updateScenario('absences',this.value)"><div class="range-value">${sc.absences}</div></div>
      <div class="range-row"><label>Interstate linehaul delay</label><input id="lateRange" type="range" min="0" max="180" step="15" value="${sc.linehaulDelayMin}" oninput="updateScenario('linehaulDelayMin',this.value)"><div class="range-value">${sc.linehaulDelayMin} min</div></div>
    </div>
    <div class="kpi-grid">
      ${kpi('Volume', num(b.wl.totalItems), 'Scenario-adjusted items')}
      ${kpi('Required labour', `${num(b.requiredHours)} h`, `vs ${num(b.cost.hours)} h rostered`, b.requiredHours > ref.base.requiredHours + 1 ? 'warn' : 'good', `${b.requiredHours >= ref.base.requiredHours ? '+' : ''}${(b.requiredHours - ref.base.requiredHours).toFixed(0)} h vs base`)}
      ${kpi('On-time · as rostered', pct(b.sim.ontimePct), `${num(b.sim.lateItems)} items late`, b.sim.ontimePct < 95 ? 'risk' : 'warn', 'If nothing changes')}
      ${kpi('On-time · TGE Flow plan', pct(a.sim.ontimePct), `${num(a.sim.lateItems)} items late`, a.sim.ontimePct >= 99 ? 'good' : 'warn', `${rec.actions.length} actions`)}
      ${kpi('Cost exposure avoided', money(Math.max(0, b.totalCost - a.totalCost)), 'Labour + recovery + service', 'good', `Plan holds to P${headroom.percentile}`)}
    </div>
    <div class="split-equal">
      <div class="panel"><h2>Recomputed recommendation</h2><div class="panel-sub">The action list changes with the scenario.</div>
        <div class="action-list compact" style="margin-top:14px">${rec.actions.map((x) => `<div class="mini-action"><span class="priority ${x.priority}">${x.rank}</span><div><b>${esc(x.title)}</b><small>${esc(x.service)} · ${money(x.saving)} · ${x.confidence}% confidence</small></div></div>`).join('') || '<div class="tiny">No action needed. The roster covers this scenario.</div>'}</div></div>
      <div class="panel"><h2>Requirement vs roster under this scenario</h2><div class="chart-wrap">${gapChart(b.reqTotal, b.supTotal, a.supTotal)}</div>${legend([['#7edb3f', 'Required'], ['#536a64', 'As rostered'], ['#0ea5a6', 'TGE Flow plan']])}</div>
    </div>
  </div>`;
}

function renderValue() {
  const v = D.value;
  const { rec } = baseModel();
  const bc = v.business_case;
  const before = v.cost_per_item_before;
  const steps = [{ k: 'Status quo|cost / item', v: 100, total: true }];
  v.levers.forEach((l) => steps.push({ k: l.lever.replace('Exception ', '').replace('Paid roster', 'Roster') + '|' + money(l.aud), v: (l.aud / v.annualised_aud) * (100 - (v.cost_per_item_after / before) * 100) }));
  steps.push({ k: 'TGE Flow|cost / item', v: (v.cost_per_item_after / before) * 100, total: true });
  const maxDaily = Math.max(...v.daily.map((d) => Math.abs(d.saving)));
  return `<div class="page">
    <div class="value-hero">
      <div class="value-big"><div class="label">Full-year back-test · ${v.window}</div><div class="num">${money(v.annualised_aud)}</div>
        <div class="sub">Gross avoided cost: forecast-led plan vs today's method on the same ${v.operating_days} operating days, same absences, same freight. Synthetic pilot data. This is an insight, not a booked saving, until it is matched to payroll and agency invoices.</div>
        <div class="value-mini"><div><span>Cost / item</span><b>$${before.toFixed(3)} → $${v.cost_per_item_after.toFixed(3)}</b></div><div><span>Items / paid hour</span><b>${v.items_per_hour_before} → ${v.items_per_hour_after}</b></div><div><span>On-time</span><b>${v.ontime_before}% → ${v.ontime_after}%</b></div></div></div>
      <div class="panel"><div class="panel-title-row"><div><h2>Cost-per-item waterfall</h2><div class="panel-sub">The economic anchor is labour cost per unit of throughput. Index: status quo = 100.</div></div></div><div class="chart-wrap">${waterfall(steps)}</div></div>
    </div>
    <div class="panel">
      <div class="panel-title-row"><div><h2>Reconciliation to the AIONOS × TGE business case</h2><div class="panel-sub">Same premium-only accounting: paid hours at A$48, overtime and agency premiums only, rework at A$45 per case. Nothing is counted twice.</div></div><span class="pill good">Business case = ${v.implied_realisation_pct}% realisation</span></div>
      <table class="table"><thead><tr><th>Lever</th><th>Units removed / yr</th><th>Rate</th><th>Synthetic pilot (100% adoption)</th><th>Business case</th></tr></thead><tbody>
        ${v.levers.map((l) => `<tr><td><b>${l.lever}</b></td><td>${num(l.removed)} ${l.unit}</td><td>A$${l.rate}</td><td><b>${money(l.aud)}</b></td><td>${money(l.business_case)}</td></tr>`).join('')}
        <tr class="hl"><td><b>Total per depot-year</b></td><td></td><td></td><td><b>${money(v.annualised_aud)}</b></td><td><b>${money(bc.total)}</b></td></tr>
      </tbody></table>
      <div class="callout" style="margin-top:14px"><div><strong>Reading it</strong><span> · The synthetic depot's technical potential is ${money(v.annualised_aud)} if every recommendation is adopted. The business case's ${money(bc.total)} is ${v.implied_realisation_pct}% of that, a prudent early-pilot realisation rate. The pilot measures the real rate.</span></div></div>
    </div>
    <div class="kpi-grid">
      ${kpi('Paid hours / yr', num(v.paid_hours_after), `from ${num(v.paid_hours_before)}`, 'good', `−${num(v.paid_hours_before - v.paid_hours_after)} h`)}
      ${kpi('Overtime hours / yr', num(v.ot_hours_after), `from ${num(v.ot_hours_before)}`, 'good', `−${Math.round(100 * (1 - v.ot_hours_after / v.ot_hours_before))}%`)}
      ${kpi('Agency hours / yr', num(v.agency_hours_after), `from ${num(v.agency_hours_before)}`, 'good', `−${Math.round(100 * (1 - v.agency_hours_after / v.agency_hours_before))}%`)}
      ${kpi('Idle hours / yr', num(v.idle_hours_after), `from ${num(v.idle_hours_before)}`, 'good', `−${Math.round(100 * (1 - v.idle_hours_after / v.idle_hours_before))}%`)}
      ${kpi('Late / backlog items', num(v.backlog_after), `from ${num(v.backlog_before)}`, 'good', 'Service held or better')}
    </div>
    <div class="two-col">
      <div class="panel"><h2>Daily avoided cost · back-test</h2><div class="panel-sub">One bar per operating day. Peaks and holiday weeks carry the most value, because that is where today's method mis-sizes the roster.</div>
        <div class="daily-bars">${v.daily.map((d) => `<i title="${d.date}: ${money(d.saving)}" style="height:${Math.max(2, Math.abs(d.saving) / maxDaily * 100)}%;background:${d.saving >= 0 ? '#2f8b2e' : '#c9564f'}"></i>`).join('')}</div>
        <div class="chart-legend"><span>${dayFmt(v.daily[0].date)}</span><span style="margin-left:auto">${dayFmt(v.daily[v.daily.length - 1].date)}</span></div></div>
      <div class="panel dark"><h2>KPI contract</h2><div class="panel-sub">Agreed before go-live. The pilot only succeeds if a staffing decision changes and the economics move without harming service.</div>
        <div class="metric-list" style="margin-top:16px">
          <div class="metric-row"><span>Base KPI</span><strong>Labour cost / item</strong></div>
          <div class="metric-row"><span>Productivity</span><strong>Items / paid hour</strong></div>
          <div class="metric-row"><span>Cost levers</span><strong>OT + agency + idle hours</strong></div>
          <div class="metric-row"><span>Guardrails</span><strong>SLA, backlog, missed departures</strong></div>
          <div class="metric-row"><span>Tomorrow's plan value</span><strong>${money(rec.base.totalCost - rec.after.totalCost)}</strong></div>
        </div></div>
    </div>
  </div>`;
}

function renderData() {
  const r = D.realism, s = D.backtest.summary;
  const wk = Object.entries(r.weekday_index).map(([k, v]) => ({ k, v }));
  const mo = Object.entries(r.monthly_index_2025).map(([k, v]) => ({ k, v, color: v > 1.1 ? '#c9564f' : v < 0.92 ? '#0ea5a6' : '#2f8b2e' }));
  const row = (c) => `<tr><td>${esc(c.metric)}</td><td><b>${esc(c.synthetic)}</b></td><td>${esc(c.benchmark)}</td><td class="tiny">${esc(c.basis)}</td><td><span class="pill ${c.status === 'pass' ? 'good' : 'warn'}">${c.status === 'pass' ? '✓ pass' : 'review'}</span></td></tr>`;
  const passed = [...r.checks, ...r.business_case_checks].filter((c) => c.status === 'pass').length;
  const total = r.checks.length + r.business_case_checks.length;
  return `<div class="page">
    <div class="hero-card"><div><div class="hero-title">Why the synthetic data is a fair stand-in for ${D.depot.name}</div><div class="hero-value" style="font-size:30px">${passed} / ${total} realism checks pass</div>
      <div class="hero-copy">The data is not drawn curves. It comes from a seeded causal model of a medium B2B/e-commerce depot: real NSW holiday dates, real Black Friday and Cyber Monday dates, interstate linehaul lanes with real road distances, a planner that rosters the way depots do today, and absences, overtime and agency use that follow from that plan. Every number regenerates with <code>python3 data/generator/generate_pilot_data.py</code>.</div></div>
      <div class="hero-side"><div><div class="caption">History</div><div class="decision-num" style="font-size:34px">${r.history_operating_days}</div><strong>operating days · Jul 2024 → Nov 2026</strong></div><div class="caption">Full argument: docs/SYNTHETIC_DATA_JUSTIFICATION.md</div></div></div>
    <div class="split-equal">
      <div class="panel"><h2>Weekly shape</h2><div class="panel-sub">Index vs weekday average, non-event days. Early-week B2B dispatch, light Friday, minimal Saturday.</div><div class="chart-wrap">${barChart(wk, { height: 190 })}</div></div>
      <div class="panel"><h2>Seasonality · 2025 weekdays</h2><div class="panel-sub">January shutdown trough, EOFY in June, Black Friday to Christmas peak.</div><div class="chart-wrap">${barChart(mo, { height: 190 })}</div></div>
    </div>
    <div class="panel"><div class="panel-title-row"><div><h2>Plausibility against real-world reference ranges</h2><div class="panel-sub">Each check compares the generated data with a published or industry-typical range.</div></div></div>
      <table class="table"><thead><tr><th>Check</th><th>Synthetic</th><th>Reference</th><th>Basis</th><th></th></tr></thead><tbody>${r.checks.map(row).join('')}</tbody></table></div>
    <div class="split-equal">
      <div class="panel"><div class="panel-title-row"><div><h2>Consistency with the business case</h2><div class="panel-sub">The pilot depot matches the representative depot in the AIONOS × TGE cost-savings case.</div></div></div>
        <table class="table"><thead><tr><th>Check</th><th>Synthetic</th><th>Business case</th><th></th></tr></thead><tbody>${r.business_case_checks.map((c) => `<tr><td>${esc(c.metric)}</td><td><b>${esc(c.synthetic)}</b></td><td>${esc(c.benchmark)}</td><td><span class="pill ${c.status === 'pass' ? 'good' : 'warn'}">${c.status === 'pass' ? '✓' : 'review'}</span></td></tr>`).join('')}</tbody></table></div>
      <div class="panel"><div class="panel-title-row"><div><h2>Not suspiciously easy</h2><div class="panel-sub">Synthetic data can make any model look brilliant. These numbers show it doesn't here.</div></div></div>
        <div class="metric-list">
          <div class="metric-row"><span>Model weekday MAPE (1-day ahead, ${s.window_operating_days} days)</span><strong>${s.weekday_model_mape}%</strong></div>
          <div class="metric-row"><span>Today's method weekday MAPE</span><strong>${s.weekday_planner_mape}%</strong></div>
          <div class="metric-row"><span>P10–P90 coverage (target ≈ 80%)</span><strong>${s.p10_p90_coverage_pct}%</strong></div>
          <div class="metric-row"><span>Model bias</span><strong>${s.model_bias_pct}%</strong></div>
          <div class="metric-row"><span>Unexplained daily noise left in the data</span><strong>~3–4%</strong></div>
        </div>
        <div class="callout" style="margin-top:14px"><div><strong>Swap-in path</strong><span> · Each synthetic file has the same schema as the pilot data contract (docs/DATA_CONTRACT.md). Week 1 replaces them with TGE extracts and the engine stays unchanged.</span></div></div></div>
    </div>
  </div>`;
}

function renderScale() {
  const v = D.value, bc = v.business_case;
  const real = v.implied_realisation_pct / 100;
  const per = v.annualised_aud * real;
  return `<div class="page">
    <div class="hero-card"><div><div class="hero-title">Scale only after the operating pattern proves itself</div><div class="hero-value" style="font-size:32px">One site → cluster → eligible network</div><div class="hero-copy">The site is the economic atom. Multiply only across depots that match the operating archetype: measured labour flexibility, reliable scans and real variable paid time. Never across all 650+ locations.</div><button class="btn primary" data-go="overview">Return to tomorrow's depot</button></div>
      <div class="hero-side"><div><div class="caption">First proof</div><div class="decision-num">6–8</div><strong>weeks to a go / no-go decision</strong></div><div class="caption">Read-only first · measured value at every step</div></div></div>
    <div class="scale-steps">
      ${[['01 · PROVE', '1 site', per, 'Baseline, build, simulate, then live advisory at Sydney West.'], ['02 · REPEAT', '5 sites', per * 5, 'Test portability across demand shapes and labour profiles.'], ['03 · CLUSTER', '20 → 50 sites', per * 50, 'Standardise templates, thresholds, role rules and governance.'], ['04 · ELIGIBLE NETWORK', '80 sites', per * 80, 'Business-case scenario: 80 qualifying depots of 650+ locations.']]
        .map(([st, site, val, p]) => `<div class="scale-card"><div class="step">${st}</div><div class="site">${site}</div><div class="scale-val">${money(val)}<small>/yr at ${Math.round(real * 100)}% realisation</small></div><p>${p}</p></div>`).join('')}
    </div>
    <div class="two-col">
      <div class="panel"><h2>Pilot plan · 6–8 weeks</h2><table class="table"><tbody>
        <tr><td><b>Wk 1–2 · Baseline</b></td><td>Site walkthrough, data contract live, KPI contract signed, roster economics baselined</td></tr>
        <tr><td><b>Wk 3–4 · Build</b></td><td>Forecast model, workload coefficients, optimisation rules calibrated on TGE extracts, which replace these synthetic files</td></tr>
        <tr><td><b>Wk 5 · Simulate</b></td><td>Back-test today's decisions against TGE Flow's on the same days, with ops feedback</td></tr>
        <tr><td><b>Wk 6–8 · Live advisory</b></td><td>Daily action queue, human-in-the-loop approval, payroll-matched impact readout, scale decision</td></tr>
      </tbody></table></div>
      <div class="panel dark"><h2>What TGE provides</h2><div class="metric-list" style="margin-top:14px">
        <div class="metric-row"><span>Medium-sized pilot site</span><strong>Sydney West (proposed)</strong></div>
        <div class="metric-row"><span>Ops + IT/data owners</span><strong>Named day 1</strong></div>
        <div class="metric-row"><span>6–12 months of site data</span><strong>Volumes, labour, service</strong></div>
        <div class="metric-row"><span>KPI contract</span><strong>Agreed upfront</strong></div>
        <div class="metric-row"><span>Weekly value review</span><strong>Ops + Finance</strong></div>
      </div></div>
    </div>
  </div>`;
}

/* ---------- routing ---------- */
const TITLES = { overview: "Tomorrow's depot", forecast: 'Demand forecast', workload: 'Workload translator', workforce: 'Workforce plan', actions: 'Action queue', scenarios: 'Scenario simulator', value: 'Value tracker', data: 'Data realism', scale: 'Scale pattern' };
const VIEWS = { overview: renderOverview, forecast: renderForecast, workload: renderWorkload, workforce: renderWorkforce, actions: renderActions, scenarios: renderScenarios, value: renderValue, data: renderData, scale: renderScale };

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#pageTitle').textContent = TITLES[view];
  render();
  window.scrollTo({ top: 0 });
}
function render() {
  $('#appContent').innerHTML = VIEWS[state.view]();
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.go)));
  const { rec } = baseModel();
  $('#navCount').textContent = rec.actions.length - state.approved.size - state.rejected.size;
}

/* ---------- dialogs & actions ---------- */
const findAction = (id) => baseModel().rec.actions.find((x) => x.id === id);
const nowStamp = () => new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

window.openAction = function (id) {
  const a = findAction(id); const dlg = $('#actionDialog');
  const ops = a.moves ? `<table class="table small"><thead><tr><th>From</th><th>To</th><th>Window</th><th>People</th></tr></thead><tbody>${a.moves.map((m) => `<tr><td>${m.from}</td><td>${m.to}</td><td>${E.fmt(m.start)}–${E.fmt(m.end)}</td><td>${m.people}</td></tr>`).join('')}</tbody></table>`
    : a.ops.length ? `<div class="tiny">Affects: ${a.ops.flatMap((o) => o.people ? (typeof o.people[0] === 'string' ? o.people : o.people.map((p) => p.id)) : [o.id]).join(', ')}</div>` : '';
  dlg.innerHTML = `<div class="dialog-inner"><div class="dialog-header"><div><h2>${a.type} recommendation</h2><p>${esc(a.title)}</p></div><button class="dialog-close" onclick="this.closest('dialog').close()">×</button></div>
    <div class="dialog-grid"><div class="dialog-stat"><span>Value</span><strong>${money(a.saving)}</strong></div><div class="dialog-stat"><span>Late items</span><strong>${num(a.lateBefore)} → ${num(a.lateAfter)}</strong></div><div class="dialog-stat"><span>Confidence</span><strong>${a.confidence}%</strong></div></div>
    <div class="panel-sub" style="font-size:12px">${esc(a.desc)}</div>
    <div class="callout" style="margin-top:12px"><div><strong>Why</strong><span> · ${esc(a.why)}</span></div></div>
    <div style="margin-top:12px">${ops}</div>
    <div class="reject-row hidden" id="rejectRow"><label>Reason code</label><select id="rejectReason">${REJECT_REASONS.map((r) => `<option>${r}</option>`).join('')}</select><button class="btn danger compact" onclick="rejectAction('${id}', document.getElementById('rejectReason').value)">Confirm reject</button></div>
    <div class="dialog-actions"><button class="btn secondary" onclick="document.getElementById('rejectRow').classList.remove('hidden')">Reject…</button><button class="btn secondary" onclick="openSim('${id}')">Simulate impact</button><button class="btn green" onclick="approveAction('${id}')">Approve for planner review</button></div></div>`;
  if (!dlg.open) dlg.showModal();
};
window.approveAction = function (id) {
  const a = findAction(id);
  state.approved.add(id); state.rejected.delete(id);
  state.audit.push({ t: nowStamp(), what: 'Approved', title: a.title });
  $$('dialog[open]').forEach((d) => d.close());
  toast('Approved for planner review. No write-back performed.');
  render();
};
window.rejectAction = function (id, reason) {
  const a = findAction(id);
  state.rejected.set(id, reason); state.approved.delete(id);
  state.audit.push({ t: nowStamp(), what: 'Rejected', title: a.title, reason });
  $$('dialog[open]').forEach((d) => d.close());
  toast('Rejected. Reason code captured for the model review.');
  render();
};
window.openSim = function (id) {
  const { rec } = baseModel();
  const a = findAction(id) || rec.actions[0];
  const ids = new Set([...state.approved, a.id]);
  const without = E.planWith(D, {}, rec, [...state.approved].filter((x) => x !== a.id));
  const withA = E.planWith(D, {}, rec, [...ids]);
  const otHours = Math.ceil(without.sim.lateItems / 58 * 10) / 10;
  const otCost = Math.round(otHours * D.rates.overtime);
  const dlg = $('#simDialog');
  dlg.innerHTML = `<div class="dialog-inner"><div class="dialog-header"><div><h2>Simulate before approving</h2><p>${esc(a.title)}</p></div><button class="dialog-close" onclick="this.closest('dialog').close()">×</button></div>
    <div class="dialog-grid"><div class="dialog-stat"><span>On-time dispatch</span><strong>${pct(without.sim.ontimePct)} → ${pct(withA.sim.ontimePct)}</strong></div><div class="dialog-stat"><span>Peak sort queue</span><strong>${num(without.sim.peakSortQueueItems)} → ${num(withA.sim.peakSortQueueItems)}</strong></div><div class="dialog-stat"><span>Direct labour cost</span><strong>${money(without.cost.aud)} → ${money(withA.cost.aud)}</strong></div></div>
    <h3 style="margin:16px 0 10px">Compare alternatives</h3>
    <div class="option-grid">
      <div class="option-card best"><h4>A · ${esc(a.type)} (recommended)</h4><p>${esc(a.desc)}</p><div class="option-metric">${num(withA.sim.lateItems)} late · ${money(withA.totalCost)} all-in</div></div>
      <div class="option-card"><h4>B · Hold staff back on overtime</h4><p>Leave the plan as is and clear the late freight with ${otHours} overtime hours after the cut-off. Service still slips on the day.</p><div class="option-metric">+${money(otCost)} overtime · ${num(without.sim.lateItems)} late</div></div>
      <div class="option-card"><h4>C · Do nothing</h4><p>Run as rostered. Late freight is recovered tomorrow at overtime rates, plus the service cost.</p><div class="option-metric">${num(without.sim.lateItems)} late · ${money(without.totalCost)} all-in</div></div>
    </div>
    <div class="dialog-actions"><button class="btn secondary" onclick="this.closest('dialog').close()">Close</button><button class="btn green" onclick="approveAction('${a.id}')">Approve option A</button></div></div>`;
  $$('dialog[open]').forEach((d) => d.close());
  dlg.showModal();
};
window.setBoard = (m) => { state.boardMode = m; render(); };

let scenarioTimer = null;
window.updateScenario = function (k, v) {
  state.scenario[k] = Number(v);
  const label = { demandPct: '#demandRange', absences: '#absenceRange', linehaulDelayMin: '#lateRange' }[k];
  const el = $(label); if (el) el.nextElementSibling.textContent = k === 'demandPct' ? `${v > 0 ? '+' : ''}${v}%` : k === 'absences' ? v : `${v} min`;
  clearTimeout(scenarioTimer);
  scenarioTimer = setTimeout(() => { const y = window.scrollY; render(); window.scrollTo({ top: y }); }, 120);
};
window.resetScenario = function () { state.scenario = { demandPct: 0, absences: 0, linehaulDelayMin: 0 }; render(); };
window.presetScenario = function (kind) {
  state.scenario = { demand: { demandPct: 15, absences: 0, linehaulDelayMin: 0 }, absence: { demandPct: 0, absences: 6, linehaulDelayMin: 0 }, late: { demandPct: 0, absences: 0, linehaulDelayMin: 90 }, combo: { demandPct: 10, absences: 4, linehaulDelayMin: 60 } }[kind];
  render();
};

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2800); }

/* ---------- guided demo ---------- */
const guidedSteps = [
  { view: 'overview', title: 'View tomorrow', copy: "Start with tomorrow's operating picture, not yesterday's report.", button: 'Why is demand changing?' },
  { view: 'forecast', title: 'Explain the forecast', copy: 'What is changing, when, why, and how accurate the forecast has been.', button: 'Translate to workload' },
  { view: 'workload', title: 'Translate to workload', copy: 'Turn volume and mix into function-level labour-hours by the hour.', button: 'Compare roster' },
  { view: 'workforce', title: 'Compare roster to required', copy: 'Where labour and demand diverge by hour, and who is where.', button: 'Recommend actions' },
  { view: 'actions', title: 'Recommend actions', copy: 'Ranked decisions with cost, service and confidence attached.', button: 'Simulate impact', special: 'simulate' },
  { view: 'actions', title: 'Simulate the top action', copy: 'Test the operating impact and the alternatives before approving.', button: 'Stress test' },
  { view: 'scenarios', title: 'Stress-test tomorrow', copy: 'The plan re-computes if demand, absences or linehaul move.', button: 'Approve recommendations', special: 'approve' },
  { view: 'actions', title: 'Approve, human in the loop', copy: 'Read-only pilot: approvals are logged and nothing is written back.', button: 'Track value' },
  { view: 'value', title: 'Track value', copy: 'Back-tested economics in the same accounting as the business case.', button: 'Trust the data' },
  { view: 'data', title: 'Trust the data', copy: 'Why the synthetic pilot data is a fair stand-in for a real TGE depot.', button: 'Scale the pattern' },
  { view: 'scale', title: 'Scale the pattern', copy: 'One validated site becomes a repeatable operating model.', button: 'Finish' },
];
function updateGuided() {
  const s = guidedSteps[state.guidedStep];
  $('#guidedStepNo').textContent = state.guidedStep + 1; $('#guidedTitle').textContent = s.title; $('#guidedCopy').textContent = s.copy; $('#guidedAction').textContent = s.button;
  setView(s.view);
}
$('#guidedBtn').addEventListener('click', () => { state.guidedStep = 0; $('#guidedStrip').classList.remove('hidden'); updateGuided(); });
$('#closeGuided').addEventListener('click', () => { state.guidedStep = -1; $('#guidedStrip').classList.add('hidden'); });
$('#guidedAction').addEventListener('click', () => {
  const s = guidedSteps[state.guidedStep];
  if (s.special === 'simulate') { state.guidedStep++; updateGuided(); openSim(baseModel().rec.actions[0].id); return; }
  if (s.special === 'approve') { baseModel().rec.actions.slice(0, 3).forEach((a) => { if (!state.approved.has(a.id)) { state.approved.add(a.id); state.audit.push({ t: nowStamp(), what: 'Approved', title: a.title }); } }); toast('Top 3 recommendations approved for planner review.'); }
  if (state.guidedStep < guidedSteps.length - 1) { state.guidedStep++; updateGuided(); }
  else { state.guidedStep = -1; $('#guidedStrip').classList.add('hidden'); toast('Guided demo complete.'); }
});
$('#resetBtn').addEventListener('click', () => {
  Object.assign(state, { guidedStep: -1, scenario: { demandPct: 0, absences: 0, linehaulDelayMin: 0 }, boardMode: 'rostered', audit: [] });
  state.approved.clear(); state.rejected.clear();
  $('#guidedStrip').classList.add('hidden'); setView('overview'); toast('Demo reset.');
});
$$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

/* ---------- boot ---------- */
$('#siteName').textContent = D.depot.name;
$('#siteSub').textContent = `${D.depot.pilot_role} · ${D.depot.headcount.permanent + D.depot.headcount.casual + D.depot.headcount.agency} rostered tomorrow`;
$('#eyebrow').textContent = `Operations planning · ${dayFmt(D.meta.planning_day, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })} · planning for ${tomorrowLabel}`;
render();
