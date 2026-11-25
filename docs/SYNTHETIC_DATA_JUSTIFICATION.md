# Why the synthetic pilot data is a fair stand-in for a real TGE depot

**Pilot depot:** Sydney West Depot (synthetic) · **Planning day:** Wednesday 25 Nov 2026 · **Planning for:** Thursday 26 Nov 2026, the day before Black Friday
**Generator:** `data/generator/generate_pilot_data.py` + `build_status_quo_roster.js` · seed `20261126` · fully deterministic
**Evidence:** every number below is regenerated into [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md) on each run, and shown live on the **Data realism** page of the app.

> **Bottom line.** The data is not a set of hand-drawn curves. It comes from a causal model of a medium-sized Australian B2B / e-commerce depot:
>
> - It runs on the real NSW calendar and real retail events.
> - Inbound freight arrives on interstate linehaul lanes with real road distances.
> - Tomorrow's roster is built the way depots roster today.
> - Overtime, agency use, idle time, late freight and rework fall out of that plan rather than being typed in.
>
> All 24 realism checks pass: 18 against published or industry reference ranges and 6 against the AIONOS × TGE business-case depot. The forecast beats today's method, but not suspiciously (4.3% vs 9.1% weekday MAPE). What the data cannot prove is listed honestly in §8.

---

## 1. What the data has to be realistic about

The product makes one claim: *predict tomorrow's freight, translate it into labour by function and hour, and change a staffing decision before cost and service are locked in.* For a demo of that claim to be credible, the synthetic data must reproduce the five things the decision depends on:

| # | What drives the decision | Why it matters for workforce planning | How the generator reproduces it |
|---|---|---|---|
| 1 | **Volume level & volatility** | Sizing the day | Seasonal, weekday, event, holiday and growth effects multiplied together, plus two kinds of noise: noise visible in advance (manifests / bookings) and noise that isn't |
| 2 | **Shape of the day** | Who is needed *when* | Overnight interstate linehaul arrivals (morning wave) and afternoon pickup returns (evening wave), with real lanes and transit times |
| 3 | **Freight mix** | Pallets, parcels and DG take different labour | Four streams (B2B cartons, e-commerce parcels, pallets/oversize, special handling) whose shares move with season and events |
| 4 | **How the roster is built today** | The baseline the product must beat | A planner heuristic: same-weekday 4-week average × blanket peak buffer, shaped to a *typical* day, standard shift templates, contract mix, cross-skilling |
| 5 | **What goes wrong on the day** | The value pool | Absences, linehaul delays and mis-shaped coverage produce overtime, same-day agency, idle time, late freight and rework |

## 2. The pilot depot and why it was chosen

The decks ask for **one medium-sized site, 6–8 weeks, read-only first**. Sydney West is modelled to match the business case's representative depot:

| Attribute | Synthetic Sydney West | Business-case depot | Source of the choice |
|---|---|---|---|
| Average paid hours / operating day | 231 h | 246.7 h (40 FTE × 1,850 h ÷ 300) | Business case slide 5 |
| Loaded regular hour | A$48 | A$48 | Business case slide 3 |
| Overtime share / premium | 8.2% / +50% | 10% / +50% | Business case slide 3 |
| Agency share / premium | 12.9% / +25% | 12% / +25% | Business case slide 3 |
| Exception rework cases / year | 871 @ A$45 | 1,000 @ A$45 | Business case slide 3 |
| Operating days / year | 303 | 300 | Business case slide 3 |
| Functions | Inbound · Sortation · Dock/Yard · Linehaul · Last mile | Same five (product deck) | Predictive Workforce deck slide 11 |
| Location / profile | Western Sydney industrial belt (M4/M7); conveyor-assisted manual sort; 10 inbound / 12 outbound doors; 46 P&D runs | "Medium-sized site" | Predictive Workforce deck slide 13 |

Why this archetype is a good first proof:

- **Two daily waves** (overnight linehaul → P&D runs; afternoon pickups → outbound linehaul) exercise every decision the product makes: re-allocation, re-timing, agency timing and overtime.
- **Mixed freight** tests the workload translator, not just a parcel count.
- **Black Friday → Christmas exposure** makes value visible inside a 6–8 week window.
- **Multi-lane linehaul** (MEL, BNE, ADL, CBR, regional NSW) creates realistic arrival-delay risk.

The depot name, location band and figures are **synthetic**. They are not TGE actuals and no TGE system was accessed.

## 3. How the data is generated (a causal chain, not curve drawing)

```
calendar (real NSW holidays, real Black Friday / Cyber Monday dates, EOFY, Christmas shutdown)
   × weekday profile × annual seasonality × growth trend × new-customer onboarding
   × customer manifests & booked bulk pickups  ← visible the evening before (EDI / MyTeamGE bookings)
   × unexplained AR(1) noise, storm days        ← not visible in advance
 = daily volume by stream (Jul 2024 → Nov 2026, 732 operating days)
        │
        ├─► status-quo planner: same-weekday 4-week avg × blanket buffer ÷ flat productivity standard
        │        └─► realised day: absences (binomial), same-day agency call-ins, overtime cap,
        │            backlog, idle, rework  →  daily labour history (paid h, OT, agency, cost, on-time)
        │
        ├─► forecast model: log-linear regression (weekday, Fourier seasonality, holidays,
        │   events, manifests/bookings, trend), rolling-origin back-test vs the planner
        │
        └─► tomorrow: linehaul trailers (lane, distance, transit, ETA, items), pickup profile,
            mix → roster built by the status-quo method → engine (js/engine.js) plans the day
```

Three design rules keep it honest:

1. **Outcomes are consequences, never inputs.** Overtime, agency, idle time, late freight and rework are not typed in. They result from the planner's plan meeting the day's real volume and absences. The value tracker therefore measures a *mechanism*, not an assumption.
2. **Same days, same absences, same freight.** The back-test replays the forecast-led plan on exactly the days the status-quo plan ran, using common random numbers. Only the *decision* differs.
3. **Leave irreducible noise in.** About 3–4% of daily variance is invisible in advance, so the model cannot be perfect. P10–P90 intervals cover 80.7% of actuals, close to the nominal 80%.

## 4. Calibration: every parameter, its anchor and how the pilot replaces it

| Parameter | Value used | Real-world anchor | Confidence | Replaced in the pilot by |
|---|---|---|---|---|
| Weekday shape | Mon 1.06 · Tue 1.00 · Wed 0.99 · Thu 1.01 · Fri 0.94 · Sat 0.19 · Sun closed | B2B shippers dispatch early in the week; weekend web orders land on Monday; limited Saturday processing | Medium | 6–12 months of scan-in counts |
| Seasonality | Jan 0.86 · Jun 1.03 · Nov 1.11 · Dec 1.16 (2025 weekdays) | B2B Christmas/New Year shutdowns; EOFY stock moves; Black Friday → Christmas parcel peak | Medium | Same |
| Retail events | Pre-BF Thu +6%, BF +5%, Cyber Monday +21%, Cyber week +8–22%; mid-Nov sale +3–7% | Real 2024/25/26 dates; volume lands at depots *after* order days | Medium | Event calendar + history |
| NSW public holidays | 21 holidays on gazetted dates incl. Easter 2025/26, King's Birthday, Labour Day | NSW gazette | High | Same |
| Post-holiday catch-up | +12% on the first operating day after a closure | Freight backs up over closures | Medium | History |
| Growth | +5.5% p.a., plus a new national account from 12 Oct 2026 (+4.5% ramp) | E-commerce and B2B growth; account wins are typical step changes | Low–medium | Customer pipeline |
| Visible day-specific volume | σ ≈ 5.5% (manifests / bookings, observed with ~1.8% error) | EDI consignments are created before pickup; bulk pickups are booked | Medium | MyTeamGE shipment headers + pickup bookings |
| Unexplained noise | σ ≈ 3.2%, AR(1) φ = 0.35; storm days −9% / +6% next day | Persistent but fading shocks; summer storms | Medium | Model residuals |
| Linehaul lanes | SYD–MEL 880 km / 10 h · SYD–BNE 920 km / 11 h · SYD–ADL 1,375 km / 16.5 h · CBR · Newcastle · Wollongong · hub transfer | Road distances; regulated heavy-vehicle speeds and breaks | High | Track & trace ETAs |
| Freight mix | B2B 55% · e-com 38% · pallets 3.4% · special 1.2% tomorrow (typical day: pallets 4.6%) | B2B-heavy depot; parcel-heavier before Black Friday | Medium | Item mix from shipment lines |
| Labour standards | Unload 330 · sort 182 · exceptions 31 · forklift 14 pallets · yard 2.5 trailers · DG 45 · linehaul load 287 · run staging 249 per labour-hour; 12% PFD allowance | Manual / conveyor-assisted depot time standards | Medium | Weeks 1–2: time-and-motion + scan timestamps |
| Driver self-load | 55% of P&D run loading done by contractor drivers | Common P&D model | Low–medium | Site walkthrough |
| Site coefficients | 0.78–1.13 by function × window | Night-start ramp-up, peak flow efficiency, late-shift fatigue | Low (illustrative) | Measured from scans vs rostered hours |
| Rates | A$48 loaded hour; OT +50%; agency +25%; casual +10%; rework A$45/case; late item A$1.10 | Business case; super 12% (from 1 Jul 2025) and NSW payroll tax 5.45% inside the loaded rate | Business-case aligned | TGE Finance wage codes and agency invoices |
| Absence | 4.0% base, +1.2 pts Mondays and post-holiday, +0.6 pts Dec/Jan → 4.4% realised | Australian absence surveys (~9–11 days per employee per year) | Medium | Time & attendance |
| Planner behaviour | Same-weekday 4-week average; +8% peak buffer (+12% Black Friday week); flat 57 items/h standard; typical-day shape (45% overnight) | How spreadsheet-based depot planning typically works | Medium | Observed rosters vs volumes |
| Roster | 63 people (22 permanent, 18 casual, 23 agency); 8 h / 6 h / 4 h templates; staggered meal breaks; 50 of 63 cross-skilled; forklift-licensed staff can work Dock/Yard | Built by the planner heuristic above, not hand-picked | Medium | Rostering system export |

## 5. Evidence: realism checks (all pass)

The full table, with each reference range and its basis, is in [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md). Highlights:

| Check | Synthetic | Reference |
|---|---|---|
| Early-December peak vs September weekday | 1.34× | 1.20–1.45× |
| Cyber Monday vs September weekday | 1.52× | 1.40–1.90× |
| January shutdown trough | 0.86× | 0.80–0.92× |
| Today's method forecast error (weekday MAPE) | 9.1% | 6–12% |
| TGE Flow forecast error (weekday MAPE) | 4.3% | 3–6% |
| Unplanned absence | 4.4% | 3.5–5.5% |
| Overtime / agency share of paid hours | 8.2% / 12.9% | 6–12% / 10–18% |
| Items per paid hour | 51.5 | 50–75 |
| Labour cost per item | A$1.02 | A$0.65–1.10 |
| On-time dispatch (status quo) | 98.6% | 95–99% |

## 6. Consistency with the business case, and an honest reconciliation

The value tracker uses the business case's **premium-only accounting**: paid hours at A$48, overtime and agency at their premiums only, rework at A$45 per case, so no wage is counted twice. The full-year back-test (29 Nov 2025 – 25 Nov 2026, 300 operating days) gives:

| Lever | Synthetic pilot, 100% adoption | Business case |
|---|---|---|
| Paid roster hours (3,143 h) | A$150,325 | A$53,280 |
| Overtime premium (2,732 h) | A$65,575 | A$53,280 |
| Agency premium (1,413 h) | A$16,955 | A$31,968 |
| Exception rework (119 cases) | A$5,367 | A$9,000 |
| **Total per depot-year** | **A$238,200** (6.5% of cost) | **A$147,528** (3.8%) |

How to read this:

- The synthetic figure is **technical potential**: every recommendation adopted, every day. The business case equals **~62% realisation** of it, a prudent early-pilot assumption. The pilot's job is to measure the real realisation rate.
- The mix differs. The synthetic depot finds more in **paid roster hours**, because today's method mis-sizes holiday and peak weeks (planner MAPE 9.1%). It finds less in **agency premium**, because only the blanket agency layer is modelled, not agency rate negotiation. Both are testable hypotheses for weeks 3–5.
- Service improves as well: back-test backlog falls from 12,376 to 2,081 items/year and on-time rises from 98.59% to 98.88%. The savings are **not** bought by cutting service.

## 7. Safeguards against "too good to be true"

- **The baseline is competent.** Today's method is not a straw man. It uses a 4-week same-weekday average, a peak buffer and standard shifts, and it achieves 98.6% on time.
- **The model is beatable.** Weekday MAPE of 4.3% leaves visible error. Intervals are calibrated (80.7% coverage) rather than narrow.
- **Recommendations are constrained.** Skills, staggered breaks, 3-hour minimum engagement for delayed agency starts, only casual/agency start times re-timed (permanent rosters untouched), and a 12% overtime cap.
- **Uncertainty is shown.** Every action carries a confidence from the forecast band. The plan's headroom ("holds to P57 demand") is shown even when it is unflattering.
- **Deterministic and inspectable.** One seed, one command, byte-for-byte reproducible. Every CSV is in `data/pilot/`.

## 8. What synthetic data cannot prove (and how the pilot will)

| Limitation | Why it matters | Pilot test |
|---|---|---|
| Labour standards and site coefficients are assumed | They convert items into hours; a 10% error moves every recommendation | Weeks 1–2: time-and-motion sample + scan-vs-roster regression |
| Cross-skill matrix is generated | Re-allocation value depends on who can actually do what | Import the real skills/licence matrix; recompute |
| EA / agency notice terms are simplified | Re-timing and delayed starts must be lawful and contractually allowed | Validate with HR / IR before the live-advisory phase |
| Manager adoption is assumed at 100% | Realised value = potential × adoption | Measure the accept/reject rate and reason codes in weeks 6–8 |
| No hourly history | Intraday shape is modelled, not observed | Hourly scan-in profiles from WMS / track & trace |
| Value is a back-test insight | The business case requires payroll and invoice evidence | Match approved actions to payroll hours and agency invoices (T+12 h cost proof) |

## 9. Swapping in TGE data

Each synthetic file has the same grain and fields as the pilot data contract ([`DATA_CONTRACT.md`](DATA_CONTRACT.md)). In week 1 the extracts replace `data/pilot/*.csv`, the forecast and roster are rebuilt, and the engine (`js/engine.js`) and UI run unchanged. The realism checks become data-quality checks on the real feed.
