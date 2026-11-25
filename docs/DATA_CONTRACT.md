# Pilot data contract: synthetic files → TGE source systems

The pilot ingests a **read-only, governed feed**, not broad system access (Technical Review, slide 18). Each synthetic file in `data/pilot/` has the grain and fields the real extract must provide, so week 1 of the pilot is a file swap, not a rebuild.

| Synthetic file | Grain | Stands in for (TGE source) | Key fields | Refresh |
|---|---|---|---|---|
| `daily_volume_history.csv` | site × day | MyTeamGE shipment headers + scan-in events (WMS / track & trace) | `date`, `total`, items by stream (`b2b_cartons`, `ecom_parcels`, `pallets_oversize`, `special_handling`), `holiday`, `event`, `avg_linehaul_delay_min` | Daily (D−1) |
| `daily_volume_history.csv` → `preadvised_bulk_pct`, `manifest_signal` | site × day | EDI consignments created before pickup; *Book pickup* bookings | Manifested / booked items vs normal | Daily by 18:00 (T−18 h demand lock) |
| `daily_labour_history.csv` | site × day | Rostering + time & attendance + payroll wage codes + agency invoices | `planned_hours`, `paid_hours`, `overtime_hours`, `agency_hours`, `absences`, `labour_cost_aud`, `rework_cases`, `ontime_dispatch_pct` | Daily (D−1); payroll weekly |
| `roster_tomorrow.csv` | person × shift | Rostering system export (pseudonymised IDs) | `id`, `home_function`, `contract`, `shift_start`, `shift_end`, `planned_ot_hours`, `skills`, `licences` | Daily by 12:00 |
| `linehaul_inbound_tomorrow.csv` | trailer | Linehaul plan + track & trace ETAs | `trailer`, `origin`, `distance_km`, `sched_arrival`, `items`, `pallets` | Daily + intraday ETA updates |
| `linehaul_outbound_tomorrow.csv` | trailer | Linehaul departure schedule | `trailer`, `destination`, `departure` | Weekly |
| `pickup_returns_tomorrow.csv` | site × hour | P&D run plans + pickup bookings | `hour`, `items` | Daily |
| `labour_standards.csv` | function × task | Engineered standards / time-and-motion | `function`, `task`, `driver`, `rate` | Calibrated in weeks 1–2 |
| `pilot_bundle.json` → `site_coefficients` | function × 3-hour window | Derived: scan throughput ÷ rostered hours ÷ standard | coefficient | Weekly |
| `forecast_backtest.csv`, `forecast_horizon.csv`, `value_replay.csv` | site × day | *Outputs* (model), not inputs | P10/P50/P90, planner forecast, replay costs | Daily |

## Contract fields to lock (per Technical Review)

- **Site, route/lane, mode and service level** on every shipment and trailer record
- **Event time, planned time and actual time** on scans and linehaul events
- **Function / role / skill group mapping** for every rostered person (pseudonymised; no names needed)
- **Cost levers:** overtime, agency and idle time by wage code; agency invoice lines

## Data readiness checks

- 6–12 months of history preferred; 8–12 weeks minimum for the pilot
- Daily refresh for the pilot; intraday optional
- Event completeness and duplicate handling (the generator's realism checks become data-quality checks)
- Known exceptions and blackout periods labelled (e.g. system outages, site closures)

## Privacy

Rosters use pseudonymous IDs (`SWD-P001`). No names, addresses or personal contact details are required. PII is minimised at extract time, and every extract, model run, recommendation and approval is logged.
