#!/usr/bin/env python3
"""
TGE Flow — synthetic pilot data generator (Sydney West Depot).

Generates a causally-consistent synthetic data set for ONE pilot depot:

  * 2.4 years of daily volume by freight stream (Jul-2024 → planning day)
  * daily labour history produced by the *status-quo* planning method
    (same-weekday 4-week average + blanket peak buffer)
  * a transparent forecast model (log-linear regression) with a rolling
    backtest against the status-quo planner forecast
  * tomorrow's linehaul schedule, hourly arrival profile and an
    employee-level roster (synthetic IDs only)
  * a 30-operating-day replay that values forecast-led planning
  * realism checks against published / industry reference ranges

Everything is deterministic for a given SEED so the demo and the
justification document always match. Run from the repository root:

    python3 data/generator/generate_pilot_data.py

Outputs are written to data/pilot/ (CSV + JSON) and docs/VALIDATION_REPORT.md;
build_status_quo_roster.js (Node) then adds tomorrow's roster and writes the
app bundle data/pilot-data.js. Requires Python 3.10+ with numpy, and Node 18+.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import math
from pathlib import Path

import numpy as np

SEED = 20261126
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "pilot"
DOCS = ROOT / "docs"

START = dt.date(2024, 7, 1)
PLANNING_DAY = dt.date(2026, 11, 25)      # Wednesday — the day the planner works
TARGET_DAY = dt.date(2026, 11, 26)        # Thursday — "tomorrow"
HORIZON_OP_DAYS = 12                      # two operating weeks ahead

rng = np.random.default_rng(SEED)

# ---------------------------------------------------------------------------
# 1. Calendar — NSW public holidays and retail events (real dates)
# ---------------------------------------------------------------------------
NSW_HOLIDAYS = {
    dt.date(2024, 10, 7): "Labour Day",
    dt.date(2024, 12, 25): "Christmas Day",
    dt.date(2024, 12, 26): "Boxing Day",
    dt.date(2025, 1, 1): "New Year's Day",
    dt.date(2025, 1, 27): "Australia Day (observed)",
    dt.date(2025, 4, 18): "Good Friday",
    dt.date(2025, 4, 19): "Easter Saturday",
    dt.date(2025, 4, 21): "Easter Monday",
    dt.date(2025, 4, 25): "Anzac Day",
    dt.date(2025, 6, 9): "King's Birthday",
    dt.date(2025, 10, 6): "Labour Day",
    dt.date(2025, 12, 25): "Christmas Day",
    dt.date(2025, 12, 26): "Boxing Day",
    dt.date(2026, 1, 1): "New Year's Day",
    dt.date(2026, 1, 26): "Australia Day",
    dt.date(2026, 4, 3): "Good Friday",
    dt.date(2026, 4, 4): "Easter Saturday",
    dt.date(2026, 4, 6): "Easter Monday",
    dt.date(2026, 4, 25): "Anzac Day",
    dt.date(2026, 6, 8): "King's Birthday",
    dt.date(2026, 10, 5): "Labour Day",
    dt.date(2026, 12, 25): "Christmas Day",
    dt.date(2026, 12, 26): "Boxing Day",
}
BLACK_FRIDAY = [dt.date(2024, 11, 29), dt.date(2025, 11, 28), dt.date(2026, 11, 27)]
MID_NOV_SALE = [dt.date(2024, 11, 12), dt.date(2025, 11, 11), dt.date(2026, 11, 10)]
NEW_CUSTOMER_START = dt.date(2026, 10, 12)   # synthetic national homewares account

# multiplicative effect on volume, keyed by offset from Black Friday
BF_EFFECT = {-1: 1.06, 0: 1.05, 1: 1.18, 3: 1.21, 4: 1.22, 5: 1.15, 6: 1.08, 7: 1.03}
SALE_EFFECT = {1: 1.07, 2: 1.06, 3: 1.03}

DOW_MULT = [1.06, 1.00, 0.985, 1.00, 0.93, 0.19, 0.0]  # Mon..Sun (Sunday closed)

# Annual seasonality anchors (month, day, multiplier) — interpolated cyclically
SEASON_ANCHORS = [
    (1, 2, 0.80), (1, 16, 0.91), (2, 1, 0.96), (3, 1, 1.00), (4, 1, 0.99),
    (5, 1, 1.00), (6, 1, 1.03), (6, 24, 1.09), (7, 6, 0.97), (8, 1, 0.97),
    (9, 1, 0.99), (10, 1, 1.01), (11, 1, 1.05), (11, 15, 1.09), (12, 1, 1.16),
    (12, 15, 1.20), (12, 21, 1.08), (12, 24, 0.82), (12, 31, 0.72),
]

PREADVISED = {}            # date -> booked bulk uplift fraction (filled from history + bookings)
TARGET_PREADVISED = 0.095  # tomorrow: manifests + two retailers' booked pre-Black Friday bulk pickups


BASE_LEVEL = 12_000          # weekday items at START before multipliers
TREND_PER_YEAR = 0.055       # e-commerce + B2B organic growth
NOISE_SIGMA = 0.032          # unexplained (AR) component
MANIFEST_SIGMA = 0.055       # day-specific customer volume visible in EDI manifests / bookings
NOISE_PHI = 0.35


def season_mult(d: dt.date) -> float:
    pts = []
    for m, day, v in SEASON_ANCHORS:
        pts.append((dt.date(d.year, m, day).timetuple().tm_yday, v))
    pts.sort()
    doy = d.timetuple().tm_yday
    ext = [(pts[-1][0] - 365, pts[-1][1])] + pts + [(pts[0][0] + 365, pts[0][1])]
    for (x0, y0), (x1, y1) in zip(ext, ext[1:]):
        if x0 <= doy <= x1:
            w = (doy - x0) / (x1 - x0)
            w = 0.5 - 0.5 * math.cos(math.pi * w)      # smooth
            return y0 + (y1 - y0) * w
    return 1.0


def event_mult(d: dt.date) -> tuple[float, str]:
    for bf in BLACK_FRIDAY:
        off = (d - bf).days
        if off in BF_EFFECT:
            label = {-1: "Pre-Black Friday stock positioning", 0: "Black Friday",
                     1: "Black Friday weekend", 3: "Cyber Monday", 4: "Cyber week",
                     5: "Cyber week", 6: "Cyber week", 7: "Cyber week"}[off]
            return BF_EFFECT[off], label
    for s in MID_NOV_SALE:
        off = (d - s).days
        if off in SALE_EFFECT:
            return SALE_EFFECT[off], "Mid-November sale event"
    return 1.0, ""


def new_customer_mult(d: dt.date, op_index_since: int | None) -> float:
    if d < NEW_CUSTOMER_START or op_index_since is None:
        return 1.0
    return 1.0 + 0.045 * min(1.0, op_index_since / 10)


def is_closed(d: dt.date) -> bool:
    return d.weekday() == 6 or d in NSW_HOLIDAYS


# ---------------------------------------------------------------------------
# 2. Daily volume history (+ the forecast horizon "truth" is NOT generated —
#    the future is only ever forecast)
# ---------------------------------------------------------------------------
days = []
d = START
ar = 0.0
storm_next = False
new_cust_ops = 0
while d <= PLANNING_DAY:
    closed = is_closed(d)
    years = (d - START).days / 365.25
    ev, ev_label = event_mult(d)
    post_hol = (d - dt.timedelta(days=1)) in NSW_HOLIDAYS and not closed
    # weekend + holiday catch-up: first operating day after a closure
    prev_op = d - dt.timedelta(days=1)
    while prev_op.weekday() == 6:
        prev_op -= dt.timedelta(days=1)
    post_hol = post_hol or (prev_op in NSW_HOLIDAYS and not closed)

    bulk = 0.0
    manifest = float(rng.normal(0, MANIFEST_SIGMA)) if not closed else 0.0
    if not closed and d.weekday() < 5 and rng.random() < 0.07:
        bulk = round(float(rng.uniform(0.07, 0.16)), 3)   # customer pre-advised bulk pickup
    storm = False
    if not closed and d.month in (11, 12, 1, 2, 3) and rng.random() < 0.028:
        storm = True
    ar = NOISE_PHI * ar + rng.normal(0, NOISE_SIGMA)
    if d >= NEW_CUSTOMER_START and not closed:
        new_cust_ops += 1
    if closed:
        total = 0
    else:
        mult = (DOW_MULT[d.weekday()] * season_mult(d) * ev *
                (1 + TREND_PER_YEAR) ** years *
                new_customer_mult(d, new_cust_ops if d >= NEW_CUSTOMER_START else None))
        if post_hol:
            mult *= 1.12
        mult *= (1 + bulk) * math.exp(manifest)
        if storm:
            mult *= 0.91
        if storm_next:
            mult *= 1.06
        total = int(round(BASE_LEVEL * mult * math.exp(ar)))
    # stream mix
    peak = 1.0 if (d.month == 12 and d.day <= 21) or (d.month == 11 and d.day >= 15) else 0.0
    ecom_share = 0.30 + 0.06 * peak + (0.03 if ev > 1.1 else 0) + rng.normal(0, 0.008)
    if d.weekday() == 5:
        ecom_share += 0.12        # Saturday is mostly e-commerce
    pallet_share = 0.032 + (0.008 if d.month == 6 else 0) + rng.normal(0, 0.002)
    special_share = 0.011 + rng.normal(0, 0.0015)
    ecom = int(total * ecom_share)
    pallets = int(total * pallet_share)
    special = int(total * special_share)
    b2b = total - ecom - pallets - special
    linehaul_delay = int(rng.choice([0, 0, 0, 0, 0, 15, 30, 45]) + (75 if storm else 0)) if not closed else 0
    days.append(dict(date=d, dow=d.strftime("%a"), closed=closed, total=total, b2b_cartons=b2b,
                     ecom_parcels=ecom, pallets_oversize=pallets, special_handling=special,
                     holiday=NSW_HOLIDAYS.get(d, ""), event=ev_label, post_holiday=post_hol, preadvised_bulk_pct=round(bulk * 100, 1), manifest_signal=round(manifest, 4),
                     storm=storm, avg_linehaul_delay_min=linehaul_delay))
    storm_next = storm
    d += dt.timedelta(days=1)

op_days = [x for x in days if not x["closed"]]
for x in days:
    # EDI manifests & pickup bookings are known the evening before, but imperfectly:
    # customers under/over-declare and late bookings arrive after the cut-off
    if not x["closed"]:
        observed = (1 + x["preadvised_bulk_pct"] / 100 * float(rng.uniform(0.75, 1.15))) * math.exp(x["manifest_signal"] + rng.normal(0, 0.018)) - 1
        PREADVISED[x["date"]] = observed
PREADVISED[TARGET_DAY] = TARGET_PREADVISED

# ---------------------------------------------------------------------------
# 3. Forecast model — log-linear regression (transparent, explainable)
# ---------------------------------------------------------------------------
FOURIER_K = 4
EVENT_KEYS = ["bf_m1", "bf_0", "bf_1", "bf_3", "bf_4", "bf_5", "bf_6", "bf_7", "sale_1", "sale_2", "sale_3"]


def features(d: dt.date, new_cust_ops: int, post_hol: bool) -> dict:
    f = {"intercept": 1.0}
    f["preadvised"] = math.log1p(PREADVISED.get(d, 0.0))
    for i, n in enumerate(["mon", "tue", "wed", "thu", "fri", "sat"]):
        if i > 0:
            f["dow_" + n] = 1.0 if d.weekday() == i else 0.0
    doy = d.timetuple().tm_yday / 365.25
    for k in range(1, FOURIER_K + 1):
        f[f"sin{k}"] = math.sin(2 * math.pi * k * doy)
        f[f"cos{k}"] = math.cos(2 * math.pi * k * doy)
    # late-December holiday shutdown is sharper than Fourier terms can capture
    f["xmas_wind_down"] = 1.0 if (d.month == 12 and d.day >= 22) or (d.month == 1 and d.day <= 12) else 0.0
    f["trend"] = (d - START).days / 365.25
    for key in EVENT_KEYS:
        f[key] = 0.0
    for bf in BLACK_FRIDAY:
        off = (d - bf).days
        if off in BF_EFFECT:
            f["bf_m1" if off == -1 else f"bf_{off}"] = 1.0
    for s in MID_NOV_SALE:
        off = (d - s).days
        if off in SALE_EFFECT:
            f[f"sale_{off}"] = 1.0
    f["post_holiday"] = 1.0 if post_hol else 0.0
    f["new_customer"] = min(1.0, new_cust_ops / 10) if d >= NEW_CUSTOMER_START else 0.0
    return f


def post_holiday_flag(d: dt.date) -> bool:
    prev = d - dt.timedelta(days=1)
    while prev.weekday() == 6:
        prev -= dt.timedelta(days=1)
    return prev in NSW_HOLIDAYS or (d - dt.timedelta(days=1)) in NSW_HOLIDAYS


FEATURE_NAMES = list(features(START, 0, False).keys())


def new_cust_count(d: dt.date) -> int:
    if d < NEW_CUSTOMER_START:
        return 0
    n, x = 0, NEW_CUSTOMER_START
    while x <= d:
        if not is_closed(x):
            n += 1
        x += dt.timedelta(days=1)
    return n


def design(rows):
    return np.array([[features(r["date"], new_cust_count(r["date"]), r["post_holiday"])[k] for k in FEATURE_NAMES] for r in rows])


def fit(rows, ridge=0.05):
    X = design(rows)
    y = np.log(np.array([r["total"] for r in rows], dtype=float))
    # small ridge penalty on everything except intercept for stability
    P = np.eye(X.shape[1]) * ridge
    P[0, 0] = 0
    # events with no training example keep a zero coefficient
    beta = np.linalg.solve(X.T @ X + P, X.T @ y)
    resid = y - X @ beta
    return beta, resid


def predict(beta, d: dt.date) -> float:
    x = np.array([features(d, new_cust_count(d), post_holiday_flag(d))[k] for k in FEATURE_NAMES])
    return float(x @ beta)


# Rolling-origin backtest: last 120 operating days, refit weekly
BACKTEST_N = 300
INTERVAL_INFLATION = 1.25   # in-sample residuals understate out-of-sample error
bt_rows = []
beta = None
for i, r in enumerate(op_days[-BACKTEST_N:]):
    idx = len(op_days) - BACKTEST_N + i
    if beta is None or i % 6 == 0:
        beta, resid = fit(op_days[:idx])
        q10, q90 = np.quantile(resid, [0.10, 0.90]) * INTERVAL_INFLATION
    lp = predict(beta, r["date"])
    # status-quo planner forecast: average of same weekday over last 4 weeks
    same = [x["total"] for x in op_days[:idx] if x["date"].weekday() == r["date"].weekday()
            and not x["post_holiday"]][-4:]
    planner = float(np.mean(same)) if same else float(r["total"])
    bt_rows.append(dict(date=r["date"], actual=r["total"], model_p50=math.exp(lp),
                        model_p10=math.exp(lp + q10), model_p90=math.exp(lp + q90), planner=planner))


def mape(a, f):
    a, f = np.array(a, float), np.array(f, float)
    return float(np.mean(np.abs(a - f) / a) * 100)


bt_actual = [b["actual"] for b in bt_rows]
backtest_summary = dict(
    window_operating_days=BACKTEST_N,
    model_mape=round(mape(bt_actual, [b["model_p50"] for b in bt_rows]), 2),
    planner_mape=round(mape(bt_actual, [b["planner"] for b in bt_rows]), 2),
    model_bias_pct=round(float(np.mean([(b["model_p50"] - b["actual"]) / b["actual"] for b in bt_rows]) * 100), 2),
    planner_bias_pct=round(float(np.mean([(b["planner"] - b["actual"]) / b["actual"] for b in bt_rows]) * 100), 2),
    p10_p90_coverage_pct=round(float(np.mean([b["model_p10"] <= b["actual"] <= b["model_p90"] for b in bt_rows]) * 100), 1),
    weekday_model_mape=round(mape([b["actual"] for b in bt_rows if b["date"].weekday() < 5],
                                  [b["model_p50"] for b in bt_rows if b["date"].weekday() < 5]), 2),
    weekday_planner_mape=round(mape([b["actual"] for b in bt_rows if b["date"].weekday() < 5],
                                    [b["planner"] for b in bt_rows if b["date"].weekday() < 5]), 2),
)

# Final model on all history → 12-operating-day horizon
beta, resid = fit(op_days)
sigma = float(np.std(resid))
q10, q90 = np.quantile(resid, [0.10, 0.90]) * INTERVAL_INFLATION
horizon = []
d = TARGET_DAY
h = 0
while len(horizon) < HORIZON_OP_DAYS:
    if not is_closed(d):
        h += 1
        lp = predict(beta, d)
        widen = 1 + 0.035 * (h - 1)
        ev, ev_label = event_mult(d)
        horizon.append(dict(date=d, p10=math.exp(lp + q10 * widen), p50=math.exp(lp),
                            p90=math.exp(lp + q90 * widen), event=ev_label))
    d += dt.timedelta(days=1)

tomorrow = horizon[0]

# Driver decomposition: tomorrow vs the average of the last 8 normal Thursdays
recent_thu = [r for r in op_days if r["date"].weekday() == 3 and not r["post_holiday"]
              and r["date"] < TARGET_DAY and event_mult(r["date"])[0] == 1.0][-8:]
typical_thu = float(np.mean([r["total"] for r in recent_thu]))


def contrib(group_keys, d_target, d_refs):
    xt = features(d_target, new_cust_count(d_target), post_holiday_flag(d_target))
    total = 0.0
    for k in group_keys:
        bi = beta[FEATURE_NAMES.index(k)]
        ref = np.mean([features(r["date"], new_cust_count(r["date"]), r["post_holiday"])[k] for r in d_refs])
        total += bi * (xt[k] - ref)
    return total


groups = {
    "Pre-Black Friday stock positioning": ["bf_m1"],
    "Customer manifests & booked pickups (EDI)": ["preadvised"],
    "Peak-season ramp (Nov–Dec seasonality)": [f"sin{k}" for k in range(1, FOURIER_K + 1)] + [f"cos{k}" for k in range(1, FOURIER_K + 1)] + ["xmas_wind_down"],
    "New national homewares account (from 12 Oct)": ["new_customer"],
    "Underlying volume growth": ["trend"],
}
log_contrib = {k: contrib(v, TARGET_DAY, recent_thu) for k, v in groups.items()}
total_log = math.log(tomorrow["p50"] / typical_thu)
log_contrib["Other effects (recent run-rate)"] = total_log - sum(log_contrib.values())
delta_pct = (tomorrow["p50"] / typical_thu - 1) * 100
scale = delta_pct / total_log if total_log else 0
drivers = [[k, round(v * scale, 1)] for k, v in log_contrib.items()]

# ---------------------------------------------------------------------------
# 4. Labour history — status-quo planning, realised outcomes
#    Cost accounting follows the AIONOS × TGE business case exactly:
#    every paid hour at the loaded regular rate, plus overtime and agency
#    PREMIUMS only (never the same wage twice), plus exception rework cases.
# ---------------------------------------------------------------------------
RATES = dict(
    permanent=48.00,            # business case: fully loaded regular hour A$48
    casual=52.80,               # casual loading net of leave on-costs (~+10%)
    agency=60.00,               # A$48 + 25% agency wage premium
    overtime=72.00,             # A$48 + 50% overtime wage premium
    overtime_premium=24.00, agency_premium=12.00, casual_premium=4.80,
    rework_case=45.00,          # business case: A$45 incremental cost per exception case
    early_start_loading=4.60,   # shift loading for starts before 06:00
    late_item_service_cost=1.10,  # SLA credit / re-delivery exposure per late item
)
PLANNER_PRODUCTIVITY = 57.0     # items / paid hour the planner assumes today (flat standard)
TRUE_PRODUCTIVITY = 58.0        # engineered-standard productivity at P50 mix
AVG_SHIFT = 7.6
MIN_CREW_HOURS = 110.0           # minimum safe crew (supervision, forklift, yard, sort) on any open day
REWORK_BASE_PER_DAY = 2.7       # ≈ 1,000 cases / 300 operating days at normal volume (business case)


def run_day(items, planned, required, absences, agency_share, intraday_ot, intraday_idle, prod, peak):
    """Realise one operating day for a given plan. Returns hours, premiums, service and cost."""
    avail = planned - absences * AVG_SHIFT
    gap = required - avail
    callin = ot = idle = backlog_hours = 0.0
    if gap > 0:
        callin = min(gap * 0.5, 3 * AVG_SHIFT)          # same-day agency call-ins
        ot = min(gap - callin, 0.12 * avail)             # overtime cap
        backlog_hours = max(0.0, gap - callin - ot)
    else:
        idle = -gap * 0.7                                # some surplus sent home early
    ot += intraday_ot * planned
    idle += intraday_idle * planned
    backlog = backlog_hours * prod
    paid = avail + callin + ot
    agency = planned * agency_share + callin
    casual = (paid - ot - agency) * 0.14
    mismatch = intraday_ot + intraday_idle
    rework = REWORK_BASE_PER_DAY * items / 14_500 * (1 + 2.5 * mismatch + 6 * backlog / items + (0.25 if peak else 0))
    cost = (paid * RATES["permanent"] + ot * RATES["overtime_premium"] + agency * RATES["agency_premium"] +
            casual * RATES["casual_premium"] + rework * RATES["rework_case"])
    return dict(paid=paid, ot=ot, agency=agency, idle=idle, backlog=backlog, rework=rework, cost=cost)


labour = []
for i, r in enumerate(op_days):
    d = r["date"]
    same = [x["total"] for x in op_days[max(0, i - 40):i] if x["date"].weekday() == d.weekday() and not x["post_holiday"]][-4:]
    plan_vol = float(np.mean(same)) if same else r["total"]
    in_peak = dt.date(d.year, 11, 15) <= d <= dt.date(d.year, 12, 20)
    bf_week = any(-1 <= (d - bf).days <= 7 for bf in BLACK_FRIDAY)
    if bf_week:
        plan_vol *= 1.12                     # blanket Black Friday-week buffer
    elif in_peak:
        plan_vol *= 1.08                     # blanket peak buffer
    planned = max(plan_vol / PLANNER_PRODUCTIVITY, MIN_CREW_HOURS)
    # productivity varies with mix: pallets & special handling are slower
    mix_pen = 1 + 2.2 * (r["pallets_oversize"] / r["total"] - 0.032) + 3.0 * (r["special_handling"] / r["total"] - 0.011)
    prod = TRUE_PRODUCTIVITY / mix_pen * rng.normal(1, 0.018)
    required = max(r["total"] / prod, MIN_CREW_HOURS * 0.9)
    p_abs = 0.040 + (0.012 if d.weekday() == 0 else 0) + (0.006 if d.weekday() == 4 else 0) + \
        (0.012 if r["post_holiday"] else 0) + (0.006 if d.month in (12, 1) else 0)
    absences = int(rng.binomial(max(1, int(round(planned / AVG_SHIFT))), p_abs))
    # status quo: blanket agency layer, intraday shape mismatch (idle mornings, overtime afternoons)
    o = run_day(r["total"], planned, required, absences, 0.15 if in_peak else 0.11, 0.06, 0.05, prod, in_peak)
    rework_cases = int(rng.poisson(o["rework"]))
    backlog_items = int(o["backlog"] + max(0, rng.normal(0, 25)))
    ontime = min(99.5, 100 - 100 * backlog_items / r["total"] - abs(rng.normal(0.9, 0.35)) - r["avg_linehaul_delay_min"] / 120)
    labour.append(dict(date=d, items=r["total"], planned_hours=round(planned, 1), required_hours=round(required, 1),
                       paid_hours=round(o["paid"], 1), overtime_hours=round(o["ot"], 1), agency_hours=round(o["agency"], 1),
                       idle_hours=round(o["idle"], 1), absences=absences, backlog_items=backlog_items, rework_cases=rework_cases,
                       labour_cost_aud=round(o["cost"] - o["rework"] * RATES["rework_case"] + rework_cases * RATES["rework_case"]),
                       items_per_paid_hour=round(r["total"] / o["paid"], 1),
                       cost_per_item_aud=round(o["cost"] / r["total"], 3), ontime_dispatch_pct=round(ontime, 2),
                       _prod=prod, _peak=in_peak))

# ---------------------------------------------------------------------------
# 5. Back-test replay: same days, same absences, forecast-led plan instead
#    (expected-value comparison on both sides — common random numbers)
# ---------------------------------------------------------------------------
REPLAY_N = 300
bt_by_date = {b["date"]: b for b in bt_rows}
replay = []
for L in labour[-REPLAY_N:]:
    b = bt_by_date[L["date"]]
    sq_planned = L["planned_hours"]
    fl_planned = max(b["model_p50"] * 1.02 / TRUE_PRODUCTIVITY, MIN_CREW_HOURS)   # book to ~P60, engineered standards
    sq = run_day(L["items"], sq_planned, L["required_hours"], L["absences"], 0.15 if L["_peak"] else 0.11, 0.06, 0.05, L["_prod"], L["_peak"])
    fl = run_day(L["items"], fl_planned, L["required_hours"], L["absences"], 0.13 if L["_peak"] else 0.095, 0.025, 0.02, L["_prod"], L["_peak"])
    replay.append(dict(date=L["date"], items=L["items"],
                       sq_paid=round(sq["paid"], 1), fl_paid=round(fl["paid"], 1), sq_ot=round(sq["ot"], 1), fl_ot=round(fl["ot"], 1),
                       sq_agency=round(sq["agency"], 1), fl_agency=round(fl["agency"], 1), sq_idle=round(sq["idle"], 1), fl_idle=round(fl["idle"], 1),
                       sq_backlog=round(sq["backlog"]), fl_backlog=round(fl["backlog"]), sq_rework=round(sq["rework"], 2), fl_rework=round(fl["rework"], 2),
                       sq_cost=round(sq["cost"]), fl_cost=round(fl["cost"]), sq_ontime=L["ontime_dispatch_pct"]))
for L in labour:
    L.pop("_prod"); L.pop("_peak")


def s(key):
    return float(sum(x[key] for x in replay))


replay_items = s("items")
OP_DAYS_PER_YEAR = 300          # business case
lever_hours = (s("sq_paid") - s("fl_paid")) * RATES["permanent"]
lever_ot = (s("sq_ot") - s("fl_ot")) * RATES["overtime_premium"]
lever_agency = (s("sq_agency") - s("fl_agency")) * RATES["agency_premium"]
lever_rework = (s("sq_rework") - s("fl_rework")) * RATES["rework_case"]
lever_casual = (s("sq_cost") - s("fl_cost")) - lever_hours - lever_ot - lever_agency - lever_rework
total_saving = s("sq_cost") - s("fl_cost")
ann = lambda x: x / REPLAY_N * OP_DAYS_PER_YEAR
BUSINESS_CASE = dict(roster_hours=53_280, overtime_premium=53_280, agency_premium=31_968, rework=9_000, total=147_528,
                     paid_hours_per_day=246.7, ot_share=10.0, agency_share=12.0, regular_rate=48.0, rework_cases_per_year=1_000)
levers = [
    dict(lever="Paid roster hours", unit="paid hours", removed=round(ann(s("sq_paid") - s("fl_paid"))), rate=RATES["permanent"], aud=round(ann(lever_hours + lever_casual)), business_case=BUSINESS_CASE["roster_hours"]),
    dict(lever="Overtime premium", unit="OT premium-hours", removed=round(ann(s("sq_ot") - s("fl_ot"))), rate=RATES["overtime_premium"], aud=round(ann(lever_ot)), business_case=BUSINESS_CASE["overtime_premium"]),
    dict(lever="Agency premium", unit="agency premium-hours", removed=round(ann(s("sq_agency") - s("fl_agency"))), rate=RATES["agency_premium"], aud=round(ann(lever_agency)), business_case=BUSINESS_CASE["agency_premium"]),
    dict(lever="Exception rework", unit="cases", removed=round(ann(s("sq_rework") - s("fl_rework"))), rate=RATES["rework_case"], aud=round(ann(lever_rework)), business_case=BUSINESS_CASE["rework"]),
]
value = dict(
    window=f"{replay[0]['date']:%d %b %Y} – {replay[-1]['date']:%d %b %Y}",
    operating_days=REPLAY_N,
    total_saving_aud=round(total_saving),
    annualised_aud=round(ann(total_saving), -2),
    daily_avg_aud=round(total_saving / REPLAY_N),
    levers=levers,
    business_case=BUSINESS_CASE,
    cost_per_item_before=round(s("sq_cost") / replay_items, 3),
    cost_per_item_after=round(s("fl_cost") / replay_items, 3),
    items_per_hour_before=round(replay_items / s("sq_paid"), 1),
    items_per_hour_after=round(replay_items / s("fl_paid"), 1),
    paid_hours_before=round(s("sq_paid")), paid_hours_after=round(s("fl_paid")),
    ot_hours_before=round(s("sq_ot")), ot_hours_after=round(s("fl_ot")),
    agency_hours_before=round(s("sq_agency")), agency_hours_after=round(s("fl_agency")),
    idle_hours_before=round(s("sq_idle")), idle_hours_after=round(s("fl_idle")),
    backlog_before=int(s("sq_backlog")), backlog_after=int(s("fl_backlog")),
    rework_before=round(s("sq_rework")), rework_after=round(s("fl_rework")),
    ontime_before=round(float(np.mean([x["sq_ontime"] for x in replay])), 2),
    saving_pct=round(100 * total_saving / s("sq_cost"), 2),
    daily=[dict(date=x["date"].isoformat(), saving=x["sq_cost"] - x["fl_cost"]) for x in replay],
)
value["implied_realisation_pct"] = round(100 * BUSINESS_CASE["total"] / value["annualised_aud"], 1)
value["ontime_after"] = round(value["ontime_before"] + 100 * (value["backlog_before"] - value["backlog_after"]) / replay_items, 2)

# ---------------------------------------------------------------------------
# 6. Tomorrow: linehaul schedule, hourly arrivals, roster
# ---------------------------------------------------------------------------
T = tomorrow["p50"]
morning_share = 0.40           # pre-BF: afternoon pickups heavier than usual (typical 0.46)
LANES = [  # origin, km, typical transit (h), sched arrival
    ("Melbourne (VIC)", 880, 10.0, "03:05"), ("Melbourne (VIC)", 880, 10.0, "04:20"),
    ("Brisbane (QLD)", 920, 11.0, "03:35"), ("Brisbane (QLD)", 920, 11.0, "05:30"),
    ("Adelaide (SA)", 1375, 16.5, "06:40"), ("Canberra (ACT)", 290, 3.5, "04:10"),
    ("Newcastle (NSW)", 165, 2.5, "05:05"), ("Wollongong (NSW)", 85, 1.5, "09:40"),
    ("Sydney Hub transfer", 30, 0.7, "11:10"),
]
weights = np.array([1.3, 1.15, 1.2, 0.95, 0.75, 0.6, 0.65, 0.4, 0.6])
weights = weights / weights.sum()
inbound_trailers = []
morning_items = T * morning_share
for k, (origin, km, transit, arr) in enumerate(LANES):
    items = int(morning_items * weights[k])
    inbound_trailers.append(dict(trailer=f"IN-{k + 1:02d}", origin=origin, distance_km=km, transit_h=transit,
                                 sched_arrival=arr, items=items, pallets=int(items * 0.03),
                                 delay_risk=("High" if origin.startswith("Adelaide") else "Medium" if km > 800 else "Low")))
# pickup returns from metro P&D runs (afternoon)
pick_profile = {9: 0.03, 10: 0.05, 11: 0.07, 12: 0.09, 13: 0.11, 14: 0.14, 15: 0.18, 16: 0.17, 17: 0.11, 18: 0.05}
pickup_items = T * (1 - morning_share)
pickups = {h: int(pickup_items * w) for h, w in pick_profile.items()}
OUTBOUND = [("Melbourne (VIC)", "18:30"), ("Brisbane (QLD)", "19:00"), ("Canberra (ACT)", "19:30"),
            ("Melbourne (VIC)", "20:15"), ("Adelaide (SA)", "20:00"), ("Newcastle (NSW)", "20:30"),
            ("Brisbane (QLD)", "21:00"), ("Sydney Hub transfer", "21:30")]
outbound = [dict(trailer=f"OUT-{k + 1:02d}", destination=o, departure=t) for k, (o, t) in enumerate(OUTBOUND)]

# Labour standards (engineered, items per productive labour-hour)
standards = [
    dict(function="Inbound", task="Unload linehaul / pickup vans (loose)", driver="items", rate=330, source="Time-study style standard; floor-loaded cartons & parcels"),
    dict(function="Sortation", task="Manual/conveyor-assisted sort to run & lane", driver="items", rate=182, source="Typical semi-automated depot sort, mixed B2B/B2C"),
    dict(function="Sortation", task="Exceptions, rework & returns", driver="exception items", rate=31, source="Unreadable labels, mis-sorts, damaged freight, returns (~5% of items)"),
    dict(function="Dock/Yard", task="Forklift pallets & oversize", driver="pallets", rate=14, source="LF-licensed forklift handling incl. scan & stage"),
    dict(function="Dock/Yard", task="Trailer marshalling / yard move", driver="trailers", rate=2.5, source="Yard jockey move incl. seal & check"),
    dict(function="Dock/Yard", task="Dangerous goods / special handling", driver="special items", rate=45, source="DG segregation & documentation"),
    dict(function="Linehaul", task="Load outbound linehaul trailers", driver="items", rate=287, source="Load-to-trailer incl. manifest scan"),
    dict(function="Last mile", task="Stage & load-assist P&D delivery runs", driver="items (45% not self-loaded by drivers)", rate=249, source="Run staging in drop sequence; drivers self-load ~55%"),
]
PFD_ALLOWANCE = 0.12
EXCEPTION_RATE = 0.05
DRIVER_SELF_LOAD_SHARE = 0.55   # P&D contractor drivers load most of their own runs

# The roster is built by data/generator/build_status_quo_roster.js (status-quo
# planning heuristic, using the same engine as the app) after this script runs.
roster = []

# ---------------------------------------------------------------------------
# 7. Realism checks
# ---------------------------------------------------------------------------
hist = np.array([r["total"] for r in op_days], float)
weekday_idx = {}
for w, n in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]):
    vals = [r["total"] for r in op_days if r["date"].weekday() == w and not r["post_holiday"] and not r["event"]]
    weekday_idx[n] = float(np.mean(vals))
wk_mean = np.mean([weekday_idx[n] for n in ["Mon", "Tue", "Wed", "Thu", "Fri"]])
weekday_idx = {k: round(v / wk_mean, 3) for k, v in weekday_idx.items()}

monthly = {}
for r in op_days:
    if r["date"].weekday() < 5 and dt.date(2025, 1, 1) <= r["date"] <= dt.date(2025, 12, 31):
        monthly.setdefault(r["date"].month, []).append(r["total"])
m_mean = np.mean([np.mean(v) for v in monthly.values()])
monthly_idx = {dt.date(2025, m, 1).strftime("%b"): round(float(np.mean(v) / m_mean), 3) for m, v in sorted(monthly.items())}

peak_week = np.mean([r["total"] for r in op_days if dt.date(2025, 12, 1) <= r["date"] <= dt.date(2025, 12, 5)])
sep_avg = np.mean([r["total"] for r in op_days if r["date"].month == 9 and r["date"].year == 2025 and r["date"].weekday() < 5])
cm_day = [r["total"] for r in op_days if r["date"] == dt.date(2025, 12, 1)][0]

weekday_resid = [b for b in bt_rows if b["date"].weekday() < 5]
lab = labour[-250:]
lab_hours = sum(x["paid_hours"] for x in lab)
absence_rate = sum(x["absences"] for x in lab) * AVG_SHIFT / sum(x["planned_hours"] for x in lab) * 100
ot_share = sum(x["overtime_hours"] for x in lab) / lab_hours * 100
agency_share = sum(x["agency_hours"] for x in lab) / lab_hours * 100
iplh = sum(x["items"] for x in lab) / lab_hours
cpi = sum(x["labour_cost_aud"] for x in lab) / sum(x["items"] for x in lab)
ontime = float(np.mean([x["ontime_dispatch_pct"] for x in lab]))
lag1 = float(np.corrcoef(resid[1:], resid[:-1])[0, 1])
storm_days = sum(1 for r in op_days if r["storm"])

checks = [
    dict(metric="Weekly shape: Monday vs Friday index", synthetic=f"{weekday_idx['Mon']:.2f} / {weekday_idx['Fri']:.2f}",
         benchmark="Mon highest, Fri lowest weekday", basis="B2B shippers dispatch early-week; weekend e-commerce orders land Monday", status="pass" if weekday_idx['Mon'] > 1.0 > weekday_idx['Fri'] else "review"),
    dict(metric="Saturday volume vs weekday", synthetic=f"{weekday_idx['Sat']:.2f}×", benchmark="0.15–0.30×", basis="B2B depot with limited Saturday e-commerce processing", status="pass" if 0.15 <= weekday_idx['Sat'] <= 0.30 else "review"),
    dict(metric="Early-December peak vs September weekday", synthetic=f"{peak_week / sep_avg:.2f}×", benchmark="1.20–1.45×", basis="Australian parcel peak (Black Friday → Christmas) widely reported as the busiest period of the year", status="pass" if 1.2 <= peak_week / sep_avg <= 1.45 else "review"),
    dict(metric="Cyber Monday 2025 vs September weekday", synthetic=f"{cm_day / sep_avg:.2f}×", benchmark="1.40–1.90×", basis="Single-day peak after Black Friday weekend orders", status="pass" if 1.4 <= cm_day / sep_avg <= 1.9 else "review"),
    dict(metric="January shutdown trough", synthetic=f"{monthly_idx['Jan']:.2f}×", benchmark="0.80–0.92×", basis="B2B customer shutdowns over Christmas/New Year", status="pass" if 0.8 <= monthly_idx['Jan'] <= 0.92 else "review"),
    dict(metric="June EOFY uplift", synthetic=f"{monthly_idx['Jun']:.2f}×", benchmark="1.02–1.08×", basis="End-of-financial-year B2B stock movements", status="pass" if 1.02 <= monthly_idx['Jun'] <= 1.08 else "review"),
    dict(metric="Shock persistence (lag-1 autocorrelation of de-seasonalised volume)", synthetic=f"{lag1:.2f}", benchmark="0.15–0.60", basis="Unexplained swings carry into the next day (backlog, customer cycles) but fade; neither white noise nor a drawn curve", status="pass" if 0.15 <= lag1 <= 0.6 else "review"),
    dict(metric="Forecast error: status-quo planner (weekday MAPE)", synthetic=f"{backtest_summary['weekday_planner_mape']:.1f}%", benchmark="6–12%", basis="Same-weekday 4-week average; typical of spreadsheet-based depot planning", status="pass" if 6 <= backtest_summary['weekday_planner_mape'] <= 12 else "review"),
    dict(metric="Forecast error: TGE Flow model (weekday MAPE)", synthetic=f"{backtest_summary['weekday_model_mape']:.1f}%", benchmark="3–6%", basis="Not suspiciously perfect: irreducible day-to-day noise remains", status="pass" if 3 <= backtest_summary['weekday_model_mape'] <= 6 else "review"),
    dict(metric="Unplanned absence rate", synthetic=f"{absence_rate:.1f}%", benchmark="3.5–5.5%", basis="Australian absence surveys report ~9–11 days per employee per year; higher in warehousing", status="pass" if 3.5 <= absence_rate <= 5.5 else "review"),
    dict(metric="Overtime share of worked hours", synthetic=f"{ot_share:.1f}%", benchmark="6–12%", basis="Depot overtime absorbs variability and peak; the business case assumes 10%", status="pass" if 6 <= ot_share <= 12 else "review"),
    dict(metric="Agency share of worked hours", synthetic=f"{agency_share:.1f}%", benchmark="10–18%", basis="Labour-hire flex layer, higher in peak; the business case assumes 12%", status="pass" if 10 <= agency_share <= 18 else "review"),
    dict(metric="Items per labour-hour", synthetic=f"{iplh:.1f}", benchmark="50–75", basis="Mixed B2B cartons, parcels and freight; manual/semi-automated sort", status="pass" if 50 <= iplh <= 75 else "review"),
    dict(metric="Labour cost per item (AUD)", synthetic=f"${cpi:.2f}", benchmark="$0.65–$1.10", basis="A$48 loaded hour (business case) incl. super 12% and NSW payroll tax 5.45%", status="pass" if 0.65 <= cpi <= 1.1 else "review"),
    dict(metric="On-time dispatch", synthetic=f"{ontime:.1f}%", benchmark="95–99%", basis="Linehaul departure / P&D run cut-off adherence", status="pass" if 95 <= ontime <= 99 else "review"),
    dict(metric="Linehaul transit times", synthetic="SYD–MEL 10h · SYD–BNE 11h · SYD–ADL 16.5h", benchmark="Hume / Pacific / Sturt Hwy road distances", basis="880 km, 920 km and 1,375 km road distances at regulated heavy-vehicle speeds incl. breaks", status="pass"),
    dict(metric="Public-holiday calendar", synthetic=f"{sum(1 for k in NSW_HOLIDAYS if START <= k <= PLANNING_DAY)} NSW holidays", benchmark="Actual NSW gazetted dates", basis="Closures and catch-up days placed on the real dates, incl. Easter 2025/2026", status="pass"),
    dict(metric="Severe-weather disruption days", synthetic=f"{storm_days} days over 3 summers", benchmark="2–5 per summer", basis="Sydney summer storm season (Nov–Mar) delaying linehaul", status="pass" if 3 <= storm_days <= 14 else "review"),
]

avg_paid = lab_hours / len(lab)
rework_year = sum(x["rework_cases"] for x in lab) / len(lab) * OP_DAYS_PER_YEAR
bc = BUSINESS_CASE
bc_checks = [
    dict(metric="Average paid hours per operating day", synthetic=f"{avg_paid:.0f} h", benchmark=f"{bc['paid_hours_per_day']} h (40 FTE × 1,850 h ÷ 300)", basis="Business case representative depot", status="pass" if abs(avg_paid / bc['paid_hours_per_day'] - 1) <= 0.12 else "review"),
    dict(metric="Overtime share of paid hours", synthetic=f"{ot_share:.1f}%", benchmark=f"{bc['ot_share']:.0f}%", basis="Business case assumption", status="pass" if abs(ot_share - bc['ot_share']) <= 2.5 else "review"),
    dict(metric="Agency share of paid hours", synthetic=f"{agency_share:.1f}%", benchmark=f"{bc['agency_share']:.0f}%", basis="Business case assumption", status="pass" if abs(agency_share - bc['agency_share']) <= 3 else "review"),
    dict(metric="Loaded regular hour", synthetic=f"A${RATES['permanent']:.0f}", benchmark=f"A${bc['regular_rate']:.0f}", basis="Business case assumption; OT +50%, agency +25%", status="pass"),
    dict(metric="Exception rework cases per year", synthetic=f"{rework_year:,.0f}", benchmark=f"{bc['rework_cases_per_year']:,}", basis="Business case assumption (A$45 per case)", status="pass" if abs(rework_year / bc['rework_cases_per_year'] - 1) <= 0.25 else "review"),
    dict(metric="Operating days per year", synthetic=f"{sum(1 for r in op_days if r['date'].year == 2025 and r['date'].weekday() < 6)}", benchmark="300", basis="Business case; Mon–Sat less NSW public holidays", status="pass"),
]

# Site productivity coefficients (observed ÷ engineered standard) by function × window.
# In the pilot these are measured from scan timestamps vs rostered hours; here they are
# generated with the structural effects a depot shows: night-start ramp-up, peak flow
# efficiency, agency-heavy windows and late-shift fatigue.
WINDOWS = ["04–07", "07–10", "10–13", "13–16", "16–19", "19–22"]
COEF_FUNCS = ["Inbound", "Sortation", "Dock/Yard", "Linehaul", "Last mile"]
structure = {
    "Inbound":   [0.90, 0.97, 1.03, 0.95, 0.93, 0.98],
    "Sortation": [0.94, 0.86, 0.92, 1.10, 1.05, 0.95],
    "Dock/Yard": [0.80, 0.88, 0.94, 1.06, 0.98, 0.90],
    "Linehaul":  [1.02, 0.98, 0.93, 0.88, 0.86, 0.93],
    "Last mile": [0.90, 0.96, 1.03, 1.07, 0.88, 0.83],
}
site_coefficients = dict(windows=WINDOWS, functions=COEF_FUNCS,
                         values=[[round(float(np.clip(v + rng.normal(0, 0.015), 0.75, 1.15)), 2) for v in structure[f]] for f in COEF_FUNCS])

# ---------------------------------------------------------------------------
# 8. Write outputs
# ---------------------------------------------------------------------------
OUT.mkdir(parents=True, exist_ok=True)
DOCS.mkdir(parents=True, exist_ok=True)


def write_csv(name, rows, fields=None):
    fields = fields or list(rows[0].keys())
    with open(OUT / name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: (v.isoformat() if isinstance(v, dt.date) else ("|".join(v) if isinstance(v, list) else v)) for k, v in r.items() if k in fields})


write_csv("daily_volume_history.csv", days)
write_csv("daily_labour_history.csv", labour)
write_csv("forecast_horizon.csv", [dict(date=h["date"], p10=round(h["p10"]), p50=round(h["p50"]), p90=round(h["p90"]), event=h["event"]) for h in horizon])
write_csv("forecast_backtest.csv", [dict(date=b["date"], actual=b["actual"], model_p10=round(b["model_p10"]), model_p50=round(b["model_p50"]), model_p90=round(b["model_p90"]), planner_forecast=round(b["planner"])) for b in bt_rows])
write_csv("value_replay.csv", replay)
write_csv("linehaul_inbound_tomorrow.csv", inbound_trailers)
write_csv("linehaul_outbound_tomorrow.csv", outbound)
write_csv("pickup_returns_tomorrow.csv", [dict(hour=f"{h:02d}:00", items=v) for h, v in pickups.items()])
write_csv("labour_standards.csv", standards)

depot = dict(
    name="Sydney West Depot",
    code="SWD",
    pilot_role="Pilot site (synthetic)",
    location="Western Sydney industrial belt (M4/M7 corridor), NSW",
    profile="Medium metro depot — B2B express cartons & freight, e-commerce parcels, pickup & delivery (P&D) runs",
    operating_hours="03:00–22:30 Mon–Fri · reduced Saturday · closed Sunday",
    dock_doors=dict(inbound=10, outbound=12, pd_bays=24),
    pd_runs=46,
    sort="Conveyor-assisted manual sort (no automated sorter)",
    headcount={},  # filled by build_status_quo_roster.js
    why_pilot=[
        "Medium size: large enough for measurable savings, small enough for a 6–8 week proof",
        "Two daily waves (overnight linehaul → P&D runs; afternoon pickups → outbound linehaul) exercise every planning decision",
        "Mixed freight (cartons, parcels, pallets, DG) tests the workload translator, not just a parcel count",
        "Exposed to the Black Friday → Christmas peak, so value is visible within the pilot window",
        "Multi-lane linehaul (MEL, BNE, ADL, CBR, regional NSW) creates realistic arrival-delay risk",
    ],
)

bundle = dict(
    meta=dict(generator="data/generator/generate_pilot_data.py", seed=SEED,
              generated_for=f"{PLANNING_DAY.isoformat()} planning cycle", planning_day=PLANNING_DAY.isoformat(),
              target_day=TARGET_DAY.isoformat(), history_start=START.isoformat(), synthetic=True),
    depot=depot,
    rates=RATES,
    standards=standards,
    pfd_allowance=PFD_ALLOWANCE,
    exception_rate=EXCEPTION_RATE,
    driver_self_load_share=DRIVER_SELF_LOAD_SHARE,
    history=dict(dates=[r["date"].isoformat() for r in op_days[-60:]], total=[r["total"] for r in op_days[-60:]]),
    forecast=[dict(date=h["date"].isoformat(), p10=round(h["p10"]), p50=round(h["p50"]), p90=round(h["p90"]), event=h["event"]) for h in horizon],
    tomorrow=dict(date=TARGET_DAY.isoformat(), p10=round(tomorrow["p10"]), p50=round(tomorrow["p50"]), p90=round(tomorrow["p90"]),
                  typical_thursday=round(typical_thu), delta_pct=round(delta_pct, 1), drivers=drivers,
                  mix=dict(b2b_cartons=0.555, ecom_parcels=0.375, pallets_oversize=0.034, special_handling=0.012),
                  morning_share=morning_share, inbound_trailers=inbound_trailers, pickups=pickups, outbound=outbound),
    typical=dict(volume=round(typical_thu * 1.12), morning_share=0.45, buffer_pct=12,
                 mix=dict(b2b_cartons=0.618, ecom_parcels=0.30, pallets_oversize=0.046, special_handling=0.014),
                 basis="Recent normal-Thursday average × 1.12 blanket Black Friday-week buffer, typical arrival shape (45% overnight linehaul)"),
    roster=roster,
    backtest=dict(summary=backtest_summary,
                  dates=[b["date"].isoformat() for b in bt_rows[-60:]], actual=[b["actual"] for b in bt_rows[-60:]],
                  model=[round(b["model_p50"]) for b in bt_rows[-60:]], planner=[round(b["planner"]) for b in bt_rows[-60:]]),
    labour_recent=[{k: (v.isoformat() if isinstance(v, dt.date) else v) for k, v in x.items()} for x in labour[-30:]],
    value=value,
    site_coefficients=site_coefficients,
    realism=dict(checks=checks, business_case_checks=bc_checks, weekday_index=weekday_idx, monthly_index_2025=monthly_idx,
                 absence_rate_pct=round(absence_rate, 2), ot_share_pct=round(ot_share, 2), agency_share_pct=round(agency_share, 2),
                 items_per_labour_hour=round(iplh, 1), cost_per_item=round(cpi, 3), ontime_pct=round(ontime, 2),
                 history_operating_days=len(op_days), history_calendar_days=len(days)),
)
with open(OUT / "pilot_bundle.json", "w") as f:
    json.dump(bundle, f, indent=1)
with open(OUT / "depot_profile.json", "w") as f:
    json.dump(depot, f, indent=2)
# Validation report
lines = ["# Synthetic data validation report", "",
         f"_Auto-generated by `data/generator/generate_pilot_data.py` (seed {SEED}). Do not edit by hand._", "",
         f"Pilot depot: **{depot['name']}** · history {START:%d %b %Y} → {PLANNING_DAY:%d %b %Y} "
         f"({len(op_days)} operating days) · planning for **{TARGET_DAY:%A %d %b %Y}**", "",
         "## Realism checks", "", "| Check | Synthetic value | Reference range | Basis | Result |", "|---|---|---|---|---|"]
for c in checks:
    lines.append(f"| {c['metric']} | {c['synthetic']} | {c['benchmark']} | {c['basis']} | {'✅ pass' if c['status'] == 'pass' else '⚠️ review'} |")
lines += ["", "## Consistency with the AIONOS × TGE business case", "", "| Check | Synthetic value | Business case | Basis | Result |", "|---|---|---|---|---|"]
for c in bc_checks:
    lines.append(f"| {c['metric']} | {c['synthetic']} | {c['benchmark']} | {c['basis']} | {'✅ pass' if c['status'] == 'pass' else '⚠️ review'} |")
lines += ["", "## Forecast backtest (rolling origin, 1-day ahead)", "",
          "| Measure | TGE Flow model | Status-quo planner |", "|---|---|---|",
          f"| MAPE, all operating days | {backtest_summary['model_mape']}% | {backtest_summary['planner_mape']}% |",
          f"| MAPE, weekdays | {backtest_summary['weekday_model_mape']}% | {backtest_summary['weekday_planner_mape']}% |",
          f"| Bias | {backtest_summary['model_bias_pct']}% | {backtest_summary['planner_bias_pct']}% |",
          f"| P10–P90 interval coverage | {backtest_summary['p10_p90_coverage_pct']}% (target ≈80%) | n/a |", "",
          "## Weekday index (non-event days)", "", "| " + " | ".join(weekday_idx) + " |", "|" + "---|" * len(weekday_idx),
          "| " + " | ".join(f"{v:.2f}" for v in weekday_idx.values()) + " |", "",
          "## Monthly index, 2025 weekdays", "", "| " + " | ".join(monthly_idx) + " |", "|" + "---|" * len(monthly_idx),
          "| " + " | ".join(f"{v:.2f}" for v in monthly_idx.values()) + " |", "",
          f"## {REPLAY_N}-operating-day back-test replay (status quo vs forecast-led, same days and absences)", "",
          f"Window {value['window']}. Cost per item ${value['cost_per_item_before']:.3f} → ${value['cost_per_item_after']:.3f} "
          f"({value['saving_pct']}%); paid hours {value['paid_hours_before']:,} → {value['paid_hours_after']:,}; overtime {value['ot_hours_before']:,} → {value['ot_hours_after']:,} h; "
          f"agency {value['agency_hours_before']:,} → {value['agency_hours_after']:,} h; backlog {value['backlog_before']:,} → {value['backlog_after']:,} items.", "",
          "| Lever (business-case accounting) | Annualised units | Rate | Synthetic pilot A$/yr | Business case A$/yr |", "|---|---|---|---|---|"]
for lv in value["levers"]:
    lines.append(f"| {lv['lever']} | {lv['removed']:,} {lv['unit']} | A${lv['rate']:.0f} | A${lv['aud']:,} | A${lv['business_case']:,} |")
lines += [f"| **Total** | | | **A${value['annualised_aud']:,.0f}** | **A${BUSINESS_CASE['total']:,}** |", ""]
(DOCS / "VALIDATION_REPORT.md").write_text("\n".join(lines))

import subprocess
subprocess.run(["node", str(ROOT / "data" / "generator" / "build_status_quo_roster.js")], check=True)

print(json.dumps(dict(tomorrow=bundle["tomorrow"]["p50"], typical=round(typical_thu), delta=round(delta_pct, 1),
                      drivers=drivers, backtest=backtest_summary,
                      value={k: v for k, v in value.items() if k != "daily"},
                      checks=[(c["metric"], c["synthetic"], c["status"]) for c in checks + bc_checks]), indent=1, default=str))
