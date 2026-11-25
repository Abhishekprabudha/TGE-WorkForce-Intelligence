/*
 * TGE Flow — depot planning engine.
 *
 * Pure functions, no DOM. Turns the forecast + linehaul schedule + roster into:
 *   hourly workload by function → required FTE → skill-constrained floor
 *   allocation → gaps → queue/backlog simulation → cost → ranked,
 *   explainable recommendations.
 *
 * Two allocation modes model the decision being improved:
 *   'typical'  — status quo: the supervisor allocates the floor to the shape of
 *                a typical day (no forecast available)
 *   'forecast' — TGE Flow: the floor is allocated to tomorrow's forecast shape
 *
 * Runs in the browser (window.TGEEngine) and in Node (module.exports) so the
 * same logic is unit-tested in tests/engine.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TGEEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FUNCTIONS = ['Inbound', 'Sortation', 'Dock/Yard', 'Linehaul', 'Last mile'];
  const H0 = 3, H1 = 23;                          // planning horizon 03:00–23:00
  const HOURS = Array.from({ length: H1 - H0 }, (_, i) => H0 + i);
  const CUTOFFS = { lastMileRuns: 9, sortForLinehaul: 21, linehaulLoad: 22 };
  const RECOVERY_ITEMS_PER_HOUR = 58.5;           // next-day recovery productivity

  const zeros = () => HOURS.map(() => 0);
  const fnMap = (fn) => Object.fromEntries(FUNCTIONS.map((f) => [f, fn(f)]));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const hm = (s) => { const [h, m] = s.split(':').map(Number); return h + m / 60; };
  const fmt = (t) => { const h = Math.floor(t + 1e-9), m = Math.round((t - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const round1 = (x) => Math.round(x * 10) / 10;

  // standard normal CDF (Abramowitz–Stegun 26.2.17)
  function phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  /** spread `amount` uniformly over [a, b) into hourly slots */
  function spread(arr, a, b, amount) {
    if (amount <= 0) return;
    if (a < H0) { const len = b - a; a = H0; b = H0 + len; }   // freight landed before 03:00 waits for the first shift
    for (let i = 0; i < HOURS.length; i++) {
      const ov = Math.max(0, Math.min(HOURS[i] + 1, b) - Math.max(HOURS[i], a));
      if (ov > 0) arr[i] += amount * ov / (b - a);
    }
  }

  function rate(data, fn, task) {
    const r = data.standards.find((s) => s.function === fn && (task ? s.task.startsWith(task) : !s.task.startsWith('Exceptions')));
    return r ? r.rate : 1;
  }

  /* ------------------------------------------------------------------ */
  /* 1. Demand → hourly workload                                          */
  /* ------------------------------------------------------------------ */
  function buildWorkload(data, scenario = {}) {
    const t = data.tomorrow;
    const demand = 1 + (scenario.demandPct || 0) / 100;
    const delay = (scenario.linehaulDelayMin || 0) / 60;
    const mix = scenario.profile === 'typical' && data.typical.mix ? data.typical.mix : t.mix;
    const looseShare = 1 - mix.pallets_oversize;

    // 'typical' profile: what the status-quo planner designs for
    let trailerScale = 1, pickupScale = 1;
    if (scenario.profile === 'typical') {
      const ty = data.typical;
      trailerScale = ty.volume * ty.morning_share / sum(t.inbound_trailers.map((x) => x.items));
      pickupScale = ty.volume * (1 - ty.morning_share) / sum(Object.values(t.pickups));
    }

    const morningArr = zeros(), pickupArr = zeros(), trailerMoves = zeros();
    let weightedDelay = 0, morningItems = 0;
    t.inbound_trailers.forEach((tr) => {
      const d = delay * (tr.distance_km > 500 ? 1 : 0.3);
      const arr = hm(tr.sched_arrival) + d;
      const items = tr.items * demand * trailerScale;
      spread(morningArr, arr, arr + 1.5, items);
      spread(trailerMoves, arr, arr + 0.25, 1);
      if (arr < 8) { weightedDelay += d * items; morningItems += items; }
    });
    Object.entries(t.pickups).forEach(([h, items]) => spread(pickupArr, +h, +h + 1, items * demand * pickupScale));
    t.outbound.forEach((o) => spread(trailerMoves, hm(o.departure) - 0.5, hm(o.departure), 1));
    const avgDelay = morningItems ? weightedDelay / morningItems : 0;
    const arrivals = HOURS.map((_, i) => morningArr[i] + pickupArr[i]);
    const pickupItems = sum(pickupArr);

    const rInb = rate(data, 'Inbound'), rSort = rate(data, 'Sortation');
    const rPal = rate(data, 'Dock/Yard', 'Forklift'), rYard = rate(data, 'Dock/Yard', 'Trailer'), rDG = rate(data, 'Dock/Yard', 'Dangerous');
    const rLH = rate(data, 'Linehaul'), rLM = rate(data, 'Last mile');
    const rExc = rate(data, 'Sortation', 'Exceptions');
    const work = fnMap(zeros), items = fnMap(zeros);
    // sorting trails unloading: 55% in the same hour, 45% the next
    const sortIn = arrivals.map((a, i) => (0.55 * a + 0.45 * (arrivals[i - 1] || 0)) * looseShare);
    const exceptions = sum(arrivals) * data.exception_rate;
    arrivals.forEach((a, i) => {
      const loose = a * looseShare;
      items.Inbound[i] = loose; work.Inbound[i] = loose / rInb;
      items.Sortation[i] = sortIn[i]; work.Sortation[i] = sortIn[i] / rSort;
      items['Dock/Yard'][i] = a * mix.pallets_oversize;
      work['Dock/Yard'][i] = a * mix.pallets_oversize / rPal + trailerMoves[i] / rYard + a * mix.special_handling / rDG;
    });
    // Last mile: load P&D runs 05:00–09:00 (pushed later by late linehaul)
    const earlyMorning = sum(morningArr.slice(0, HOURS.indexOf(8)));
    // P&D drivers self-load ~55% of their runs; depot labour stages & load-assists the rest
    const runItems = (earlyMorning * 0.78 + pickupItems * 0.3) * (1 - data.driver_self_load_share);
    [[5, 0.2], [6, 0.35], [7, 0.3], [8, 0.15]].forEach(([h, w]) => spread(items['Last mile'], h + avgDelay * 0.8, h + 1 + avgDelay * 0.8, runItems * w));
    // Linehaul: interstate/hub share of the day's pickups loaded 16:00–22:00
    const lhItems = pickupItems * 0.65 + (sum(morningArr) - earlyMorning) * 0.5;
    [[16, 0.08], [17, 0.14], [18, 0.2], [19, 0.24], [20, 0.22], [21, 0.12]].forEach(([h, w]) => spread(items.Linehaul, h, h + 1, lhItems * w));
    HOURS.forEach((_, i) => { work['Last mile'][i] = items['Last mile'][i] / rLM; work.Linehaul[i] = items.Linehaul[i] / rLH; });
    // exceptions, rework & returns (unreadable labels, mis-sorts, damages) worked 06:00–20:00
    const exc = zeros(); spread(exc, 6, 20, exceptions / rExc);
    HOURS.forEach((_, i) => { work.Sortation[i] += exc[i]; });

    // site productivity coefficients (observed ÷ standard) by function × time window
    const sc = data.site_coefficients;
    if (sc) {
      const win = (h) => Math.min(sc.windows.length - 1, Math.max(0, Math.floor((h - 4) / 3)));
      FUNCTIONS.forEach((f) => { const row = sc.values[sc.functions.indexOf(f)]; if (row) HOURS.forEach((h, i) => { work[f][i] /= row[win(h)]; }); });
    }
    const pfd = data.pfd_allowance;
    const required = fnMap((f) => work[f].map((w) => w / (1 - pfd)));
    const reqTotal = HOURS.map((_, i) => FUNCTIONS.reduce((a, f) => a + required[f][i], 0));
    return { arrivals, morningArr, pickupArr, work, items, required, reqTotal, totalItems: sum(arrivals), avgDelay,
      rates: { Inbound: rInb, Sortation: rSort, 'Dock/Yard': rPal, Linehaul: rLH, 'Last mile': rLM } };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Roster → skill-constrained hourly floor allocation                */
  /* ------------------------------------------------------------------ */
  function breakSlot(id) {
    if (!id) return 1;
    let x = 0; for (const c of id) x = (x * 31 + c.charCodeAt(0)) >>> 0;
    return x % 3;
  }

  function presence(p, h) {
    let ov = Math.max(0, Math.min(h + 1, p.end) - Math.max(h, p.start));
    if (p.no_break) return Math.max(0, ov);   // 4-hour casual blocks have no meal break
    const brk = p.start + 4 + breakSlot(p.id) * 0.5;   // staggered 30-min unpaid meal break
    ov -= Math.max(0, Math.min(h + 1, brk + 0.5) - Math.max(h, brk));
    return Math.max(0, ov);
  }

  /**
   * Allocate the people present each hour across functions in proportion to
   * the `profile` requirement, honouring skills. Returns supply by function
   * and each person's dominant function per hour (for the shift board).
   */
  function allocate(roster, profile, dyn) {
    const supply = fnMap(zeros);
    const board = {};
    const q = fnMap(() => 0);              // backlog-aware targets when `dyn` (forecast mode)
    roster.forEach((p) => { board[p.id] = HOURS.map(() => null); });
    HOURS.forEach((h, i) => {
      const present = roster.map((p) => ({ p, cap: presence(p, h) })).filter((x) => x.cap > 0);
      const total = sum(present.map((x) => x.cap));
      const want = fnMap((f) => profile[f][i] + (dyn ? q[f] / (1 - dyn.pfd) : 0));
      const reqSum = FUNCTIONS.reduce((a, f) => a + want[f], 0);
      const alloc = new Map(present.map((x) => [x.p.id, {}]));
      const give = (x, f, amt) => { if (amt <= 1e-9) return; supply[f][i] += amt; x.cap -= amt; const a = alloc.get(x.p.id); a[f] = (a[f] || 0) + amt; };
      if (reqSum > 0.05 && dyn) {
        // forecast mode: fill true need, triaged by cut-off urgency when short
        const prio = h < CUTOFFS.lastMileRuns ? ['Last mile', 'Sortation', 'Dock/Yard', 'Inbound', 'Linehaul'] : ['Linehaul', 'Sortation', 'Dock/Yard', 'Inbound', 'Last mile'];
        const need = { ...want };
        present.forEach((x) => { const a = Math.min(x.cap, need[x.p.home]); give(x, x.p.home, a); need[x.p.home] -= a; });
        prio.forEach((f) => {
          present.filter((x) => x.cap > 1e-9 && x.p.skills.includes(f)).forEach((x) => { const a = Math.min(x.cap, need[f]); give(x, f, a); need[f] -= a; });
        });
      } else if (reqSum > 0.05) {
        // status quo: split the floor in the proportions of a typical day
        const target = fnMap((f) => total * want[f] / reqSum);
        present.forEach((x) => { const a = Math.min(x.cap, target[x.p.home]); give(x, x.p.home, a); target[x.p.home] -= a; });
        for (let round = 0; round < 3; round++) {
          [...FUNCTIONS].sort((a, b) => target[b] - target[a]).forEach((f) => {
            present.filter((x) => x.cap > 1e-9 && x.p.skills.includes(f)).forEach((x) => {
              const a = Math.min(x.cap, target[f]); give(x, f, a); target[f] -= a;
            });
          });
        }
      }
      present.forEach((x) => give(x, x.p.home, x.cap));     // leftover stays at home function
      if (dyn) FUNCTIONS.forEach((f) => { q[f] = Math.max(0, q[f] + dyn.work[f][i] - supply[f][i] * (1 - dyn.pfd)); });
      present.forEach((x) => {
        const a = alloc.get(x.p.id);
        board[x.p.id][i] = Object.keys(a).sort((u, v) => a[v] - a[u])[0] || x.p.home;
      });
    });
    return { supply, board };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Queue simulation → late freight & service                         */
  /* ------------------------------------------------------------------ */
  function simulate(wl, supply, pfd) {
    const queue = fnMap(zeros);
    FUNCTIONS.forEach((f) => {
      let q = 0;
      HOURS.forEach((h, i) => { q = Math.max(0, q + wl.work[f][i] - supply[f][i] * (1 - pfd)); queue[f][i] = q; });
    });
    const at = (f, hour) => queue[f][HOURS.indexOf(hour - 1)] || 0;   // queue at end of slot hour-1
    const lateRunItems = at('Last mile', CUTOFFS.lastMileRuns) * wl.rates['Last mile'];
    const missedSortItems = at('Sortation', CUTOFFS.sortForLinehaul) * wl.rates.Sortation;
    const missedLoadItems = at('Linehaul', CUTOFFS.linehaulLoad) * wl.rates.Linehaul;
    const lateItems = lateRunItems + missedSortItems + missedLoadItems;
    return {
      queue,
      lateRunItems: Math.round(lateRunItems),
      missedLinehaulItems: Math.round(missedSortItems + missedLoadItems),
      lateItems: Math.round(lateItems),
      peakSortQueueItems: Math.round(Math.max(...queue.Sortation) * wl.rates.Sortation),
      ontimePct: Math.max(0, 100 * (1 - lateItems / wl.totalItems)),
      recoveryOtHours: lateItems / RECOVERY_ITEMS_PER_HOUR,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Cost                                                              */
  /* ------------------------------------------------------------------ */
  function cost(data, roster) {
    const r = data.rates;
    let hours = 0, otHours = 0, agencyHours = 0, aud = 0;
    roster.forEach((p) => {
      const paid = Math.max(0, p.end - p.start - (p.no_break ? 0 : 0.5));
      const ot = p.planned_ot_hours || 0;
      const early = p.contract !== 'agency' && p.start < 6 ? r.early_start_loading * Math.min(paid - ot, 6 - p.start) : 0;
      aud += (paid - ot) * r[p.contract] + ot * r.overtime + early;
      hours += paid; otHours += ot;
      if (p.contract === 'agency') agencyHours += paid;
    });
    return { hours: round1(hours), otHours: round1(otHours), agencyHours: round1(agencyHours), aud: Math.round(aud) };
  }

  /* ------------------------------------------------------------------ */
  /* 5. Evaluate a plan                                                   */
  /* ------------------------------------------------------------------ */
  function cloneRoster(roster) { return roster.map((p) => ({ ...p, skills: [...p.skills] })); }

  // deterministic "who calls in sick" order for the absence scenario
  function absenceOrder(roster) {
    const h = (s) => { let x = 2166136261; for (const c of s) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
    return [...roster].sort((a, b) => h(a.id + 'abs') - h(b.id + 'abs')).map((p) => p.id);
  }

  function scenarioRoster(data, scenario = {}) {
    const roster = cloneRoster(data.roster);
    const n = scenario.absences || 0;
    if (!n) return roster;
    const out = new Set(absenceOrder(data.roster).slice(0, n));
    return roster.filter((p) => !out.has(p.id));
  }

  const typicalCache = new WeakMap();
  function typicalProfile(data) {
    if (!typicalCache.has(data)) typicalCache.set(data, buildWorkload(data, { profile: 'typical' }).required);
    return typicalCache.get(data);
  }

  function evaluate(data, roster, scenario = {}, mode = 'typical') {
    const wl = buildWorkload(data, scenario);
    const { supply, board } = mode === 'forecast'
      ? allocate(roster, wl.required, { work: wl.work, pfd: data.pfd_allowance })
      : allocate(roster, typicalProfile(data));
    const gap = fnMap((f) => supply[f].map((s, i) => s - wl.required[f][i]));
    const sim = simulate(wl, supply, data.pfd_allowance);
    const c = cost(data, roster);
    const supTotal = HOURS.map((_, i) => FUNCTIONS.reduce((a, f) => a + supply[f][i], 0));
    // next-day recovery overtime + service cost of late freight (SLA credits, re-delivery attempts)
    const recoveryCost = Math.round(sim.recoveryOtHours * data.rates.overtime + sim.lateItems * (data.rates.late_item_service_cost || 0));
    return { mode, wl, supply, board, gap, sim, cost: c, reqTotal: wl.reqTotal, supTotal,
      totalGap: supTotal.map((s, i) => s - wl.reqTotal[i]),
      requiredHours: round1(sum(wl.reqTotal)), rosterHours: round1(sum(supTotal)), recoveryCost, totalCost: c.aud + recoveryCost, roster };
  }

  function sigma(data) {
    const t = data.tomorrow;
    return (t.p90 - t.p10) / (2 * 1.2816 * t.p50);
  }

  /** probability the plan's capacity covers demand in a window (forecast uncertainty only) */
  function windowConfidence(data, ev, fn, from, to) {
    let sup = 0, req = 0;
    HOURS.forEach((h, i) => {
      if (h >= from && h < to) { sup += fn ? ev.supply[fn][i] : ev.supTotal[i]; req += fn ? ev.wl.required[fn][i] : ev.reqTotal[i]; }
    });
    if (req <= 0.05) return 0.97;
    return Math.min(0.97, Math.max(0.55, phi((sup / req - 1) / sigma(data))));
  }

  /** highest demand uplift the plan absorbs while staying ≥ 99.5% on time */
  function headroom(data, roster, scenario = {}, mode = 'forecast') {
    let lo = -15, hi = 40;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      const ev = evaluate(data, roster, { ...scenario, demandPct: (scenario.demandPct || 0) + mid }, mode);
      if (ev.sim.ontimePct >= 99.5) lo = mid; else hi = mid;
    }
    return { demandPct: round1(lo), percentile: Math.round(Math.min(99, Math.max(1, phi((lo / 100) / sigma(data)) * 100))) };
  }

  /* ------------------------------------------------------------------ */
  /* 6. Recommendation engine (greedy, explainable)                       */
  /* ------------------------------------------------------------------ */
  function windows(series, pred, minLen = 1) {
    const out = []; let s = null;
    series.forEach((v, i) => {
      if (pred(v)) { if (s === null) s = i; } else if (s !== null) { if (i - s >= minLen) out.push([s, i]); s = null; }
    });
    if (s !== null && series.length - s >= minLen) out.push([s, series.length]);
    return out;
  }

  /** summarise the floor moves between two allocations as (from → to, window, people) */
  function describeMoves(before, after) {
    const moves = [];
    HOURS.forEach((h, i) => {
      const gain = FUNCTIONS.map((f) => ({ f, d: after.supply[f][i] - before.supply[f][i] }));
      const plus = gain.filter((g) => g.d > 0.05).sort((a, b) => b.d - a.d);
      const minus = gain.filter((g) => g.d < -0.05).map((g) => ({ f: g.f, d: -g.d })).sort((a, b) => b.d - a.d);
      plus.forEach((p) => {
        for (const m of minus) {
          if (p.d <= 0.05) break;
          const amt = Math.min(p.d, m.d); if (amt <= 0.05) continue;
          moves.push({ h, from: m.f, to: p.f, n: amt }); p.d -= amt; m.d -= amt;
        }
      });
    });
    const groups = {};
    moves.forEach((m) => { const k = m.from + '>' + m.to; (groups[k] = groups[k] || []).push(m); });
    const out = [];
    Object.values(groups).forEach((ms) => {
      ms.sort((a, b) => a.h - b.h);
      let cur = null;
      ms.forEach((m) => {
        if (cur && m.h === cur.to) { cur.to = m.h + 1; cur.ns.push(m.n); }
        else { if (cur) out.push(cur); cur = { from: m.from, to_fn: m.to, start: m.h, to: m.h + 1, ns: [m.n] }; }
      });
      if (cur) out.push(cur);
    });
    return out.map((g) => ({ from: g.from, to: g.to_fn, start: g.start, end: g.to, people: Math.max(1, Math.round(Math.max(...g.ns))), fte_hours: round1(sum(g.ns)) }))
      .filter((g) => g.fte_hours >= 1.5).sort((a, b) => b.fte_hours - a.fte_hours);
  }

  /** apply roster operations (the concrete content of recommendations) */
  function applyOps(roster, ops) {
    let out = roster.map((p) => ({ ...p }));
    ops.forEach((op) => {
      if (op.kind === 'retime') out = out.map((p) => (op.people.includes(p.id) ? { ...p, start: op.to, end: op.to + op.len } : p));
      if (op.kind === 'delay') out = out.map((p) => (op.people.includes(p.id) ? { ...p, start: op.to } : p));
      if (op.kind === 'ot') out = out.map((p) => (p.id === op.id ? { ...p, end: p.end - op.hours, planned_ot_hours: 0 } : p));
      if (op.kind === 'add') op.people.forEach((q) => out.push({ ...q, skills: [...q.skills] }));
    });
    return out;
  }

  function recommend(data, scenario = {}) {
    const r = data.rates;
    const start = scenarioRoster(data, scenario);
    const base = evaluate(data, start, scenario, 'typical');
    const actions = [];
    let ops = [];
    let ev = evaluate(data, start, scenario, 'forecast');
    const cur = () => applyOps(start, ops);

    // (a) re-allocate the floor hour by hour to tomorrow's forecast shape
    const moves = describeMoves(base, ev);
    if (moves.length && (base.sim.lateItems - ev.sim.lateItems > 20 || base.sim.peakSortQueueItems - ev.sim.peakSortQueueItems > 150)) {
      const peak = Math.max(...HOURS.map((h, i) => sum(FUNCTIONS.map((f) => Math.max(0, ev.supply[f][i] - base.supply[f][i])))));
      const fromFns = [...new Set(moves.slice(0, 4).map((m) => m.from))].slice(0, 2);
      const toAll = [...new Set(moves.slice(0, 4).map((m) => m.to))];
      const toFns = (toAll.filter((f) => !fromFns.includes(f)).length ? toAll.filter((f) => !fromFns.includes(f)) : toAll).slice(0, 2);
      const lateAvoided = base.sim.lateItems - ev.sim.lateItems;
      actions.push({
        id: 'redeploy', type: 'Redeploy', priority: 'p1',
        title: `Re-allocate ${Math.round(peak)} cross-skilled staff from ${fromFns.join(' & ')} to ${toFns.join(', ')}`,
        desc: `The usual floor plan is built for a typical Thursday with ${Math.round(data.typical.mix.pallets_oversize * 100)}% pallets. Tomorrow's pre-Black Friday freight is parcel-heavy and arrives later in the day. Cross-skilled staff move where the work is, hour by hour. Nobody's hours change.`,
        why: `Afternoon pickups are ${Math.round(100 * sum(base.wl.pickupArr) / base.wl.totalItems)}% of tomorrow's freight, against ${Math.round(100 * (1 - data.typical.morning_share))}% on a typical day, and pallets are ${(data.tomorrow.mix.pallets_oversize * 100).toFixed(1)}% against ${(data.typical.mix.pallets_oversize * 100).toFixed(1)}%.`,
        moves: moves.slice(0, 5), saving: Math.round(base.recoveryCost - ev.recoveryCost),
        lateBefore: base.sim.lateItems, lateAfter: ev.sim.lateItems, queueBefore: base.sim.peakSortQueueItems, queueAfter: ev.sim.peakSortQueueItems,
        service: lateAvoided > 0 ? `${lateAvoided.toLocaleString()} late items avoided` : `Peak sort queue ${base.sim.peakSortQueueItems.toLocaleString()} → ${ev.sim.peakSortQueueItems.toLocaleString()}`,
        confidence: Math.round(windowConfidence(data, ev, null, 12, 21) * 100), window: [moves[0].start, moves[0].end], ops: [],
      });
    }

    // (b) re-time casual & agency shifts (same paid hours) out of surplus into deficit windows
    const retimeOps = []; const beforeRetime = ev;
    const MAX_RETIME = 10;                       // supervisors can only re-time so many people a day
    for (let pass = 0; pass < 4; pass++) {
      if (ev.sim.lateItems < 30) break;
      const used = sum(retimeOps.map((o) => o.people.length));
      if (used >= MAX_RETIME) break;
      let best = null;
      const roster = cur();
      const touched = new Set(retimeOps.flatMap((o) => o.people));
      const groups = {};
      roster.filter((p) => (p.contract === 'casual' || p.contract === 'agency') && !touched.has(p.id) && !p.added)
        .forEach((p) => { const k = p.start + '|' + (p.end - p.start); (groups[k] = groups[k] || []).push(p); });
      Object.values(groups).forEach((ps) => {
        const s0 = ps[0].start, len = ps[0].end - ps[0].start;
        for (let k = 1; k <= Math.min(ps.length, MAX_RETIME - used); k++) for (const d of [1, 2, 3, 4]) {
          if (s0 + d + len > 23) continue;
          const op = { kind: 'retime', people: ps.slice(0, k).map((p) => p.id), from: s0, to: s0 + d, len };
          const t = evaluate(data, applyOps(start, [...ops, op]), scenario, 'forecast');
          const gain = ev.sim.lateItems - t.sim.lateItems;
          if (gain > 60 * k && (!best || gain / k > best.gain / best.k * 1.05 || gain > best.gain * 1.3)) best = { op, gain, k, t };
        }
      });
      if (!best) break;
      retimeOps.push(best.op); ops.push(best.op); ev = best.t;
    }
    if (retimeOps.length) {
      const n = sum(retimeOps.map((o) => o.people.length));
      const detail = retimeOps.map((o) => `${o.people.length} × ${fmt(o.from)} → ${fmt(o.to)}`).join(' · ');
      actions.push({
        id: 'retime', type: 'Re-time', priority: 'p1',
        title: `Re-time ${n} casual & agency shift${n > 1 ? 's' : ''} into the peak (${detail})`,
        desc: `These shifts start while the floor still has more people than work. Starting them later keeps the same paid hours but lands them on tomorrow's busier windows. Only casual and labour-hire starts move; permanent rosters stay as published.`,
        why: `Casual and agency start times can be changed the day before, subject to EA and labour-hire notice terms.`,
        saving: Math.round(beforeRetime.recoveryCost - ev.recoveryCost), lateBefore: beforeRetime.sim.lateItems, lateAfter: ev.sim.lateItems,
        service: `${(beforeRetime.sim.lateItems - ev.sim.lateItems).toLocaleString()} late items avoided`,
        confidence: Math.round(windowConfidence(data, ev, null, Math.min(...retimeOps.map((o) => o.to)), Math.max(...retimeOps.map((o) => o.to + o.len))) * 100),
        window: [Math.min(...retimeOps.map((o) => o.to)), Math.max(...retimeOps.map((o) => o.to + o.len))], ops: retimeOps,
      });
    }

    // (c) delay agency starts where the first hours of the shift are surplus (fewer paid hours)
    const delayOps = []; const beforeDelay = ev;
    const retimed = new Set(retimeOps.flatMap((o) => o.people));
    const groups = {};
    cur().filter((p) => p.contract === 'agency' && !retimed.has(p.id)).forEach((p) => { (groups[p.start + '|' + p.end] = groups[p.start + '|' + p.end] || []).push(p); });
    Object.values(groups).sort((a, b) => a[0].start - b[0].start).forEach((ps) => {
      const s0 = ps[0].start, len = ps[0].end - s0;
      let best = null;
      for (let k = ps.length; k >= 1 && !best; k--) for (const d of [3, 2.5, 2, 1.5, 1]) {
        if (len - d < 3) continue;                       // keep a 3-hour minimum engagement
        const op = { kind: 'delay', people: ps.slice(0, k).map((p) => p.id), from: s0, to: s0 + d };
        const t = evaluate(data, applyOps(start, [...ops, op]), scenario, 'forecast');
        const i0 = HOURS.indexOf(Math.floor(s0)), i1 = Math.min(HOURS.length, i0 + Math.ceil(d) + 1);
        if (t.sim.lateItems <= ev.sim.lateItems + 5 && Math.min(...t.totalGap.slice(i0, i1)) >= 0.3) { best = { op, t }; break; }
      }
      if (best) { delayOps.push(best.op); ops.push(best.op); ev = best.t; }
    });
    if (delayOps.length) {
      const n = sum(delayOps.map((o) => o.people.length));
      const hrs = sum(delayOps.map((o) => o.people.length * (o.to - o.from)));
      const detail = delayOps.map((o) => `${o.people.length} × ${fmt(o.from)} → ${fmt(o.to)}`).join(' · ');
      actions.push({
        id: 'agency', type: 'Agency', priority: 'p2',
        title: `Delay ${n} agency start${n > 1 ? 's' : ''} (${detail})`,
        desc: `The early inbound wave doesn't need these labour-hire hands until later in their shift. Delaying the start (finish unchanged) removes ${round1(hrs)} paid idle hours, and every cut-off is still met.`,
        why: `Overnight linehaul lands from ${data.tomorrow.inbound_trailers.map((t) => t.sched_arrival).sort()[0]}. Tomorrow's overnight share is ${Math.round(100 * data.tomorrow.morning_share)}%, against ${Math.round(100 * data.typical.morning_share)}% on a typical day.`,
        saving: Math.round(hrs * r.agency), lateBefore: beforeDelay.sim.lateItems, lateAfter: ev.sim.lateItems,
        service: ev.sim.lateItems <= beforeDelay.sim.lateItems ? 'No projected cut-off impact' : `+${ev.sim.lateItems - beforeDelay.sim.lateItems} late items`,
        confidence: Math.round(windowConfidence(data, ev, null, Math.min(...delayOps.map((o) => o.from)), Math.max(...delayOps.map((o) => o.to)) + 1) * 100),
        window: [Math.min(...delayOps.map((o) => o.from)), Math.max(...delayOps.map((o) => o.to))], ops: delayOps,
      });
    }

    // (d) release planned overtime the plan no longer needs
    const otOps = []; const beforeOt = ev;
    cur().filter((p) => p.planned_ot_hours > 0).forEach((p) => {
      const op = { kind: 'ot', id: p.id, hours: p.planned_ot_hours };
      const t = evaluate(data, applyOps(start, [...ops, op]), scenario, 'forecast');
      if (t.sim.lateItems <= beforeOt.sim.lateItems + 10) { otOps.push(op); ops.push(op); ev = t; }
    });
    if (otOps.length) {
      const hrs = sum(otOps.map((o) => o.hours));
      actions.push({
        id: 'overtime', type: 'Overtime', priority: 'p3',
        title: `Release ${round1(hrs)} planned overtime hours on the late shift`,
        desc: `With the floor re-allocated, the late shift clears the outbound sort before the ${fmt(CUTOFFS.sortForLinehaul)} cut-off without the overtime extension.`,
        why: `The last outbound linehaul leaves at ${data.tomorrow.outbound[data.tomorrow.outbound.length - 1].departure}, and the sort queue is projected to be clear by then.`,
        saving: Math.round(hrs * r.overtime), lateBefore: beforeOt.sim.lateItems, lateAfter: ev.sim.lateItems,
        service: ev.sim.lateItems <= beforeOt.sim.lateItems ? 'No additional late freight' : `+${ev.sim.lateItems - beforeOt.sim.lateItems} late items`,
        confidence: Math.round(windowConfidence(data, ev, null, 19, 23) * 100), window: [20, 23], ops: otOps,
      });
    }

    // (e) residual shortfall → add labour where freight would otherwise be late
    const addOps = []; const beforeAdd = ev; let spend = 0;
    for (let pass = 0; pass < 4 && ev.sim.lateItems >= 60; pass++) {
      let best = null;
      const cands = HOURS.filter((h, i) => h <= 19 && (ev.totalGap[i] < 0.3 || (ev.totalGap[i + 1] ?? 1) < 0.3));
      cands.forEach((h0) => {
        const useOt = h0 >= 17;
        for (const n of [1, 2, 3, 4, 6]) {
          const people = Array.from({ length: n }, (_, k) => ({ id: `SWD-ADD${pass}${k}`, home: 'Sortation', contract: useOt ? 'permanent' : 'agency', shift: 'ADD', start: h0, end: Math.min(23, h0 + 4), no_break: true, planned_ot_hours: useOt ? 4 : 0, skills: [...FUNCTIONS], licences: [], added: true }));
          const op = { kind: 'add', people, ot: useOt, start: h0 };
          const t = evaluate(data, applyOps(start, [...ops, op]), scenario, 'forecast');
          const cost = n * 4 * (useOt ? r.overtime : r.agency);
          const benefit = ev.recoveryCost - t.recoveryCost - cost;
          if (ev.sim.lateItems - t.sim.lateItems > 40 && (!best || benefit > best.benefit)) best = { op, t, cost, benefit };
        }
      });
      if (!best || best.benefit < -150) break;
      const fnShort = FUNCTIONS.map((f) => ({ f, s: -sum(ev.gap[f].slice(HOURS.indexOf(best.op.start), HOURS.indexOf(best.op.start) + 4)) })).sort((x, y) => y.s - x.s)[0].f;
      best.op.fn = fnShort; best.op.people.forEach((p) => { p.home = fnShort; });
      addOps.push(best.op); ops.push(best.op); ev = best.t; spend += best.cost;
    }
    if (addOps.length) {
      const n = sum(addOps.map((o) => o.people.length));
      const detail = addOps.map((o) => `${o.people.length} × ${o.fn} from ${fmt(o.start)}`).join(' · ');
      const anyOt = addOps.some((o) => o.ot);
      actions.push({
        id: 'add', type: anyOt ? 'Overtime' : 'Agency', priority: 'p1',
        title: `${anyOt ? 'Add' : 'Book'} ${n} ${anyOt ? 'extra hands (agency / overtime)' : 'agency staff, 4h minimum,'} (${detail})`,
        desc: `Even after re-allocation and re-timing, the depot is still short in these windows. Adding labour now costs less than recovering late freight the next day.`,
        why: `Without it, ${beforeAdd.sim.lateItems.toLocaleString()} items miss a P&D run or linehaul cut-off.`,
        saving: Math.round(beforeAdd.recoveryCost - ev.recoveryCost - spend), spend: Math.round(spend),
        lateBefore: beforeAdd.sim.lateItems, lateAfter: ev.sim.lateItems,
        service: `${(beforeAdd.sim.lateItems - ev.sim.lateItems).toLocaleString()} late items avoided`,
        confidence: Math.round(windowConfidence(data, ev, null, Math.min(...addOps.map((o) => o.start)), Math.max(...addOps.map((o) => o.start)) + 4) * 100),
        window: [Math.min(...addOps.map((o) => o.start)), Math.max(...addOps.map((o) => o.start)) + 4], ops: addOps,
      });
    }

    const order = { p1: 0, p2: 1, p3: 2 };
    actions.sort((a, b) => order[a.priority] - order[b.priority] || (b.lateBefore - b.lateAfter) - (a.lateBefore - a.lateAfter) || b.saving - a.saving);
    actions.forEach((a, i) => { a.rank = i + 1; });
    return { base, after: ev, actions, ops };
  }

  /** Evaluate the plan with only the approved subset of recommendations applied */
  function planWith(data, scenario, rec, approvedIds) {
    const ids = new Set(approvedIds);
    const ops = rec.actions.filter((a) => ids.has(a.id)).flatMap((a) => a.ops);
    return evaluate(data, applyOps(scenarioRoster(data, scenario), ops), scenario, ids.has('redeploy') ? 'forecast' : 'typical');
  }

  return { FUNCTIONS, HOURS, CUTOFFS, buildWorkload, allocate, evaluate, recommend, planWith, applyOps, scenarioRoster, headroom, sigma, phi, fmt, hm, presence, typicalProfile };
});
