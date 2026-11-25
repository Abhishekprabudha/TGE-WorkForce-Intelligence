#!/usr/bin/env node
/*
 * Builds tomorrow's roster the way the depot plans today (the status quo):
 *   1. size the day on a typical Thursday (recent Thursday average × 1.08 peak buffer)
 *   2. shape it on a typical day's arrival profile (no forecast of tomorrow's shape)
 *   3. greedy shift cover from the depot's standard shift templates
 *   4. home functions, contract mix and cross-skilling as a planner would assign them
 *   5. pre-approved peak overtime on the late shift
 *
 * The result is written into data/pilot/pilot_bundle.json, data/pilot/roster_tomorrow.csv
 * and the app bundle data/pilot-data.js. Called by generate_pilot_data.py.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../../js/engine.js');

const ROOT = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(ROOT, 'data', 'pilot', 'pilot_bundle.json');
const data = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));

// deterministic PRNG (mulberry32)
let seed = data.meta.seed >>> 0;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// standard shift templates: 8h (8.5h span incl. 30-min meal), 6h and 4h part-time/casual blocks
const TEMPLATES = [];
for (let st = 3; st <= 14; st++) TEMPLATES.push({ start: st, span: 8.5, paid: 8 });
for (let st = 3; st <= 17; st++) TEMPLATES.push({ start: st, span: 6.5, paid: 6, partTime: true });
for (let st = 3; st <= 18; st++) TEMPLATES.push({ start: st, span: 4, paid: 4, partTime: true, noBreak: true });
const typical = E.buildWorkload(data, { profile: 'typical' });
const req = typical.required;
const reqTotal = typical.reqTotal;
const pres = (t, h) => (t.noBreak ? Math.max(0, Math.min(h + 1, t.start + t.span) - Math.max(h, t.start)) : E.presence({ start: t.start, end: t.start + t.span }, h));  // average break position

// 1–3. efficiency-weighted greedy cover, then close every remaining hourly gap on the typical day
const shifts = [];
const cover = E.HOURS.map(() => 0);
const addShift = (t) => {
  shifts.push({ start: t.start, end: t.start + t.span, partTime: !!t.partTime, noBreak: !!t.noBreak });
  E.HOURS.forEach((h, i) => { cover[i] += pres(t, h); });
};
const value = (t) => E.HOURS.reduce((a, h, i) => a + Math.min(pres(t, h), Math.max(0, reqTotal[i] - cover[i])), 0);
for (let guard = 0; guard < 120; guard++) {
  let best = null;
  TEMPLATES.forEach((t) => {
    const v = value(t);
    const eff = v / t.paid - (t.partTime ? 0.06 : 0);      // planners prefer full shifts
    if (v >= 1 && (!best || eff > best.eff)) best = { t, eff };
  });
  if (!best || best.eff < 0.55) break;
  addShift(best.t);
}
for (let guard = 0; guard < 60; guard++) {
  const def = E.HOURS.map((h, i) => reqTotal[i] - cover[i]);
  const worst = def.indexOf(Math.max(...def));
  if (def[worst] < 0.1) break;
  const h = E.HOURS[worst];
  const cands = TEMPLATES.filter((t) => pres(t, h) >= 0.5);
  cands.sort((a, b) => value(b) / b.paid - value(a) / a.paid);   // part-time blocks win on short spikes
  addShift(cands[0]);
}
const presS = (s, h) => pres({ start: s.start, span: s.end - s.start, noBreak: s.noBreak }, h);

// 4. home function: the function with the most uncovered typical work across the shift
const homeCover = Object.fromEntries(E.FUNCTIONS.map((f) => [f, E.HOURS.map(() => 0)]));
shifts.sort((a, b) => a.start - b.start);
shifts.forEach((s) => {
  let best = null;
  E.FUNCTIONS.forEach((f) => {
    let score = 0;
    E.HOURS.forEach((h, i) => { const p = presS(s, h); if (p > 0) score += Math.max(0, req[f][i] - homeCover[f][i]) * p; });
    if (!best || score > best.score) best = { f, score };
  });
  s.home = best.f;
  E.HOURS.forEach((h, i) => { homeCover[s.home][i] += presS(s, h); });
});

const RELATED = {
  Inbound: ['Sortation', 'Last mile', 'Dock/Yard'],
  Sortation: ['Inbound', 'Linehaul', 'Last mile'],
  'Dock/Yard': ['Inbound', 'Linehaul'],
  Linehaul: ['Sortation', 'Dock/Yard'],
  'Last mile': ['Sortation', 'Inbound'],
};

// contract mix: agency fills the most "peaky" templates (early inbound, afternoon), casuals mid-day
const counters = { permanent: 0, casual: 0, agency: 0 };
const prefix = { permanent: 'P', casual: 'C', agency: 'A' };
const roster = shifts.map((s, idx) => {
  let contract = 'permanent';
  const r = rand();
  if (s.partTime) contract = r < 0.55 ? 'casual' : 'agency';
  else if ((s.start === 4 || s.start === 5) && r < 0.35) contract = 'agency';
  else if (s.start >= 12 && r < 0.2) contract = 'agency';
  else if (r < 0.08) contract = 'casual';
  counters[contract]++;
  const id = `SWD-${prefix[contract]}${String(counters[contract]).padStart(3, '0')}`;
  let skills = [s.home];
  const rel = RELATED[s.home];
  if (contract === 'permanent') {
    if (rand() < 0.8) skills.push(rel[0]);
    if (rand() < 0.6) skills.push(rel[1]);
    if (rel[2] && rand() < 0.3) skills.push(rel[2]);
  } else if (contract === 'casual') {
    if (rand() < 0.6) skills.push(rel[0]);
    if (rand() < 0.25) skills.push(rel[1]);
  } else {
    // labour-hire general hands: about half are inducted for a second function
    if (rand() < 0.55) skills.push(s.home === 'Sortation' ? 'Inbound' : 'Sortation');
    skills = [...new Set(skills)];
  }
  const licences = [];
  if (s.home === 'Dock/Yard' || (contract === 'permanent' && rand() < 0.35) || (contract === 'casual' && rand() < 0.15)) licences.push('Forklift (LF)');
  if (licences.includes('Forklift (LF)') && !skills.includes('Dock/Yard')) skills.push('Dock/Yard');
  if (s.home === 'Dock/Yard' && rand() < 0.5) licences.push('DG awareness');
  return { id, home: s.home, contract, shift: `${String(s.start).padStart(2, '0')}:00`, start: s.start, end: s.end, no_break: s.noBreak || undefined,
    planned_ot_hours: 0, skills, licences, tenure_months: contract === 'agency' ? Math.floor(rand() * 10) : 2 + Math.floor(rand() * 94) };
});

// 5. peak overtime pre-approved by the planner on the late sort
const late = roster.filter((p) => p.contract === 'permanent' && p.start >= 11 && p.start <= 13 && p.end - p.start > 8).slice(0, 3);
late.forEach((p) => { p.planned_ot_hours = 2.5; p.end += 2.5; });

data.roster = roster;
data.depot.headcount = counters;
fs.writeFileSync(bundlePath, JSON.stringify(data, null, 1));

const csvRows = [['id', 'home_function', 'contract', 'shift_start', 'shift_end', 'planned_ot_hours', 'skills', 'licences', 'tenure_months']]
  .concat(roster.map((p) => [p.id, p.home, p.contract, E.fmt(p.start), E.fmt(p.end), p.planned_ot_hours, p.skills.join('|'), p.licences.join('|'), p.tenure_months]));
fs.writeFileSync(path.join(ROOT, 'data', 'pilot', 'roster_tomorrow.csv'), csvRows.map((r) => r.join(',')).join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'data', 'pilot-data.js'),
  '// Generated by data/generator — synthetic pilot data. Do not edit by hand.\nwindow.TGE_DATA = ' + JSON.stringify(data) + ';\n');

const paid = roster.reduce((a, p) => a + p.end - p.start - (p.no_break ? 0 : 0.5), 0);
console.log(`roster: ${roster.length} people (${JSON.stringify(counters)}), ${paid.toFixed(1)} paid hours, typical required ${E.HOURS.reduce((a, _, i) => a + reqTotal[i], 0).toFixed(1)} h`);
