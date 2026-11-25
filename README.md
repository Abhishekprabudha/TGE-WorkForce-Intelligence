# TGE Flow: predictive operations & workforce decision agent

**Predict tomorrow's freight → translate it into labour by function and hour → compare with the roster → recommend, simulate and approve decisions → measure value → scale.**

This is the pilot build of the depot workforce product described in the AIONOS × TGE decks (*Predictive Workforce Management*, *Technical Review*, *Depot Cost Savings Business Case*). It runs end to end on **synthetic data for one pilot depot, Sydney West**, planning **Thursday 26 Nov 2026**, the day before Black Friday.

Nothing on screen is hard-coded. Every number comes from the data generator and the planning engine.

## Run it

No build step and no dependencies. Open `index.html` in a browser, or:

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

Click **Start guided demo** for the 11-step client walkthrough.

## What's inside

| View | What it does |
|---|---|
| Tomorrow's depot | Forecast for tomorrow (P10–P90), on-time as rostered vs with actions, plan headroom, top decision, T−18 h → T+12 h decision timeline |
| Demand forecast | 12-day forecast with Black Friday / Cyber Monday, driver decomposition, 300-day back-test vs today's method, source signals |
| Workload | Hourly required FTE by function, site productivity coefficient heatmap, engineered standards, inbound linehaul schedule |
| Workforce plan | Roster vs required by hour, exception windows, and a **shift board** (as rostered / approved / full plan) |
| Action queue | Ranked recommendations (re-allocate, re-time, delay agency starts, release OT, add labour) with value, service and confidence; simulate alternatives; approve or reject with reason codes; audit trail; live readout of the approved plan |
| Scenarios | Demand, absences and linehaul delay sliders; the engine re-plans and re-recommends live |
| Value tracker | Full-year back-test in the business case's premium-only accounting, cost-per-item waterfall, reconciliation to A$147.5k, KPI contract |
| Data realism | 24 realism checks (18 real-world, 6 business-case), seasonality, the "not suspiciously easy" evidence |
| Scale pattern | 1 → 5 → 50 → 80 eligible sites at the measured realisation rate; 6–8 week pilot plan |

## Architecture

```
data/generator/generate_pilot_data.py   seeded causal generator (Python + numpy)
data/generator/build_status_quo_roster.js   builds tomorrow's roster the way depots do today
        │  writes
        ▼
data/pilot/*.csv, pilot_bundle.json   pilot data set (same schema as the data contract)
data/pilot-data.js                     bundle loaded by the app (works from file://)
        │
        ▼
js/engine.js     planning engine: workload → skill-constrained allocation → queue/cut-off
                 simulation → cost → greedy, explainable recommendations → scenarios
app.js           UI (vanilla JS + SVG); styles.css
tests/           engine tests (node --test)
docs/            synthetic-data justification, data contract, auto-generated validation report
```

The engine separates **prediction** (forecast) from **prescription** (actions), as in the deck's model stack. The decision rule: minimise labour cost + overtime + backlog risk, subject to SLA cut-offs, skills, breaks and labour rules. It is read-only: approvals are logged and nothing is written back.

## Synthetic data, and why it's credible

See **[docs/SYNTHETIC_DATA_JUSTIFICATION.md](docs/SYNTHETIC_DATA_JUSTIFICATION.md)**. In short:

- **Real calendar and network.** It uses real NSW public holidays and real Black Friday / Cyber Monday dates, plus interstate lanes with real road distances (MEL 880 km, BNE 920 km, ADL 1,375 km).
- **A realistic baseline.** Today's planning method is modelled: same-weekday 4-week average, blanket peak buffer, typical-day shape. Overtime, agency, idle time, late freight and rework *follow from* that plan; they are not typed in.
- **Calibrated to the business case.** A$48 loaded hour, overtime +50%, agency +25%, ~10% / ~12% shares, about 1,000 rework cases a year, 300 operating days.
- **Checks pass, and the result isn't suspiciously easy.** All 24 realism checks pass ([docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md)). The model's weekday MAPE is 4.3% against 9.1% for today's method, with 80.7% P10–P90 coverage.
- **Value reconciles to the deck.** Full-year back-test potential is A$238k per depot-year; the business case's A$147.5k equals ~62% realisation of that.

To swap in TGE extracts, see **[docs/DATA_CONTRACT.md](docs/DATA_CONTRACT.md)**.

## Regenerate data and run tests

```bash
python3 data/generator/generate_pilot_data.py   # Python 3.10+ with numpy, Node 18+
node --test tests/engine.test.js
```

The generator is deterministic (seed `20261126`); re-running reproduces identical files.

## Deploy

It's a static site. Deploy with GitHub Pages (Settings → Pages → deploy from branch, root), Netlify or Vercel, with no build command.

## Principles

- Read-only pilot: no write-back, and every change is human-approved
- Every recommendation shows **why / action / cost / service / confidence**
- A recommendation is an insight until it's matched to payroll and agency invoices
- Scale only to depots that match the archetype, never to all 650+ locations
