#!/usr/bin/env python3
"""Baseline comparison: chord-anchor autotune vs Douglas-Peucker vs fixed-spacing.

Runs three beacon-placement methods on the same ten Central Park footpath
routes used by `central_park_demo.py`, then prints two Markdown tables:

  1. Per-route comparison at a fixed drift budget (default 10 ft):
     beacons, worst drift, longest chord, worst inter-chord bearing change.

  2. Aggregate scaling table: mean / max beacon count across the ten routes
     for each (method, drift budget) pair.

The baselines are implemented here (kept out of `beacon_placement.py` so the
runtime library stays scoped to our method only):

  * `fixed_spacing`: trivially places one beacon every `spacing_ft` along
    the polyline. The reference "naive" baseline.
  * `douglas_peucker`: classical 1973 polyline simplifier; bounds
    perpendicular distance from removed vertices to the simplified line.
    Implemented here against the same local-equirectangular distance metric
    that our `chord_drift_ft` uses, so both methods are measured with the
    same yardstick.

Run with no arguments to reproduce the tables in the methods paper:

    python baselines.py
    python baselines.py --budget 5         # alternate primary drift budget
    python baselines.py --budgets 5,10,25  # alternate scaling-table budgets
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import List, Sequence, Tuple

from beacon_placement import (
    LonLat,
    _DEG_TO_FT,
    angle_diff_deg,
    autotune,
    bearing_deg,
    chord_drift_ft,
    haversine_ft,
    resample_polyline,
)


HERE = Path(__file__).resolve().parent


# --------------------------------------------------------------------------- #
# Baselines
# --------------------------------------------------------------------------- #

def fixed_spacing(coords: Sequence[LonLat], spacing_ft: float) -> List[LonLat]:
    """Place a beacon every `spacing_ft` along the polyline. Endpoints kept."""
    return resample_polyline(coords, spacing_ft)


def douglas_peucker(coords: Sequence[LonLat], eps_ft: float) -> List[LonLat]:
    """Douglas & Peucker (1973) polyline simplification.

    Recursively drops every vertex closer than `eps_ft` to the chord of
    its surrounding kept vertices. Distance is measured with the same
    local equirectangular projection used by `chord_drift_ft`, so the
    metric is directly comparable across methods.
    """
    if len(coords) < 3:
        return list(coords)
    a, b = coords[0], coords[-1]
    lat0 = math.radians((a[1] + b[1]) / 2.0)
    sx = _DEG_TO_FT * math.cos(lat0)
    sy = _DEG_TO_FT
    bx, by = (b[0] - a[0]) * sx, (b[1] - a[1]) * sy
    L = math.hypot(bx, by) or 1.0
    worst_i, worst_d = -1, 0.0
    for i in range(1, len(coords) - 1):
        p = coords[i]
        px, py = (p[0] - a[0]) * sx, (p[1] - a[1]) * sy
        d = abs(px * by - py * bx) / L
        if d > worst_d:
            worst_i, worst_d = i, d
    if worst_d <= eps_ft or worst_i < 0:
        return [a, b]
    left = douglas_peucker(coords[: worst_i + 1], eps_ft)
    right = douglas_peucker(coords[worst_i:], eps_ft)
    return left[:-1] + right


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #

def longest_chord_ft(beacons: Sequence[LonLat]) -> float:
    return max(
        (haversine_ft(beacons[i], beacons[i + 1]) for i in range(len(beacons) - 1)),
        default=0.0,
    )


def max_bearing_change_deg(beacons: Sequence[LonLat]) -> float:
    """Worst absolute bearing change between two consecutive chords (degrees)."""
    if len(beacons) < 3:
        return 0.0
    worst = 0.0
    for i in range(1, len(beacons) - 1):
        b1 = bearing_deg(beacons[i - 1], beacons[i])
        b2 = bearing_deg(beacons[i], beacons[i + 1])
        d = angle_diff_deg(b1, b2)
        if d > worst:
            worst = d
    return worst


def worst_drift_against_polyline(
    beacons: Sequence[LonLat],
    samples: Sequence[LonLat],
) -> float:
    """Snap each beacon to the nearest sample, then re-use `chord_drift_ft`.

    Lets every method report drift on the **same** sampled polyline
    regardless of whether the method's beacon set is a subset of those
    samples (chord-anchor) or arbitrary (DP / fixed-spacing).
    """
    if len(beacons) < 2 or len(samples) < 2:
        return 0.0
    indices: List[int] = []
    last = -1
    for b in beacons:
        best_i, best_d = -1, float("inf")
        start = last + 1 if last >= 0 else 0
        for j in range(start, len(samples)):
            d = haversine_ft(b, samples[j])
            if d < best_d:
                best_d, best_i = d, j
        if best_i < 0:
            best_i = len(samples) - 1
        if best_i <= last:
            best_i = min(last + 1, len(samples) - 1)
        indices.append(best_i)
        last = best_i
    if indices[-1] != len(samples) - 1:
        indices[-1] = len(samples) - 1
    if indices[0] != 0:
        indices[0] = 0
    return chord_drift_ft(samples, indices)


# --------------------------------------------------------------------------- #
# Route loading
# --------------------------------------------------------------------------- #

def load_route(geojson_path: Path) -> Tuple[str, List[LonLat]]:
    """Return (slug, route polyline) from a Central Park geojson."""
    g = json.loads(geojson_path.read_text())
    coords: List[LonLat] = []
    for f in g.get("features", []):
        if f.get("properties", {}).get("role") == "route":
            coords = [tuple(c) for c in f["geometry"]["coordinates"]]
            break
    if not coords:
        raise ValueError(f"no role=route feature in {geojson_path.name}")
    slug = geojson_path.stem.replace("central_park_", "")
    return slug, coords


def all_routes(root: Path) -> List[Tuple[str, List[LonLat]]]:
    paths = sorted(root.glob("central_park_*.geojson"))
    paths = [p for p in paths if p.stem != "central_park_all"]
    return [load_route(p) for p in paths]


# --------------------------------------------------------------------------- #
# Comparison runners
# --------------------------------------------------------------------------- #

@dataclass
class Row:
    method: str
    beacons: int
    worst_drift_ft: float
    longest_chord_ft: float
    max_bearing_change_deg: float


def run_methods(
    coords: Sequence[LonLat],
    step_ft: float,
    drift_budget_ft: float,
    fixed_spacings_ft: Sequence[float],
) -> List[Row]:
    samples = resample_polyline(coords, step_ft)

    # 1. Our method
    tune = autotune(coords, max_drift_ft=drift_budget_ft, step_ft=step_ft)
    ours = tune.result.beacons
    rows: List[Row] = [
        Row(
            method=f"Ours (autotune, budget {drift_budget_ft:g} ft)",
            beacons=len(ours),
            worst_drift_ft=tune.drift_ft,
            longest_chord_ft=longest_chord_ft(ours),
            max_bearing_change_deg=max_bearing_change_deg(ours),
        )
    ]

    # 2. Douglas-Peucker at epsilon = budget (same nominal drift target)
    dp = douglas_peucker(coords, drift_budget_ft)
    rows.append(Row(
        method=f"Douglas-Peucker (eps {drift_budget_ft:g} ft)",
        beacons=len(dp),
        worst_drift_ft=worst_drift_against_polyline(dp, samples),
        longest_chord_ft=longest_chord_ft(dp),
        max_bearing_change_deg=max_bearing_change_deg(dp),
    ))

    # 3. Fixed-spacing baselines
    for s_ft in fixed_spacings_ft:
        fs = fixed_spacing(coords, s_ft)
        rows.append(Row(
            method=f"Fixed-spacing ({s_ft:g} ft, ~{s_ft / 3.28084:.0f} m)",
            beacons=len(fs),
            worst_drift_ft=worst_drift_against_polyline(fs, samples),
            longest_chord_ft=longest_chord_ft(fs),
            max_bearing_change_deg=max_bearing_change_deg(fs),
        ))
    return rows


# --------------------------------------------------------------------------- #
# Printing
# --------------------------------------------------------------------------- #

def md_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |"]
    out.append("| " + " | ".join("---" for _ in headers) + " |")
    for r in rows:
        out.append("| " + " | ".join(r) + " |")
    return "\n".join(out)


def fmt_int(n: int) -> str:
    return f"{n:,}"


def fmt_ft(x: float) -> str:
    return f"{x:.1f} ft"


def fmt_deg(x: float) -> str:
    return f"{x:.1f}°"


def print_per_route_table(
    routes: Sequence[Tuple[str, List[LonLat]]],
    drift_budget_ft: float,
    step_ft: float,
    fixed_spacings_ft: Sequence[float],
) -> None:
    methods: List[str] = []
    by_route: List[Tuple[str, float, List[Row]]] = []
    for slug, coords in routes:
        length_ft = sum(
            haversine_ft(coords[i], coords[i + 1]) for i in range(len(coords) - 1)
        )
        rows = run_methods(coords, step_ft, drift_budget_ft, fixed_spacings_ft)
        if not methods:
            methods = [r.method for r in rows]
        by_route.append((slug, length_ft, rows))

    headers = ["route", "len (ft)"] + [
        f"{m}\n(N / drift / longest / max bend)" for m in methods
    ]
    table_rows: List[List[str]] = []
    for slug, length_ft, rows in by_route:
        cells = [slug, f"{length_ft:,.0f}"]
        for r in rows:
            cells.append(
                f"{fmt_int(r.beacons)} / "
                f"{fmt_ft(r.worst_drift_ft)} / "
                f"{fmt_ft(r.longest_chord_ft)} / "
                f"{fmt_deg(r.max_bearing_change_deg)}"
            )
        table_rows.append(cells)

    print(f"### Per-route comparison at drift budget = {drift_budget_ft:g} ft")
    print()
    print(md_table(headers, table_rows))
    print()

    # Aggregate at this budget
    print(f"### Aggregate at drift budget = {drift_budget_ft:g} ft (n={len(routes)})")
    print()
    agg_headers = [
        "method", "mean beacons", "max beacons",
        "mean worst drift", "max worst drift",
        "mean max bend", "max max bend",
    ]
    agg_rows: List[List[str]] = []
    for m_idx, method in enumerate(methods):
        ns = [rows[m_idx].beacons for _, _, rows in by_route]
        ds = [rows[m_idx].worst_drift_ft for _, _, rows in by_route]
        bs = [rows[m_idx].max_bearing_change_deg for _, _, rows in by_route]
        agg_rows.append([
            method,
            f"{statistics.mean(ns):.1f}",
            fmt_int(max(ns)),
            fmt_ft(statistics.mean(ds)),
            fmt_ft(max(ds)),
            fmt_deg(statistics.mean(bs)),
            fmt_deg(max(bs)),
        ])
    print(md_table(agg_headers, agg_rows))
    print()


def print_scaling_table(
    routes: Sequence[Tuple[str, List[LonLat]]],
    budgets_ft: Sequence[float],
    step_ft: float,
) -> None:
    """For each (method, budget) report mean+max beacons & worst-drift achieved.

    Fixed-spacing rows are independent of the budget but are reported once
    so the absolute scale is visible alongside the budget-scaling rows.
    """
    print(f"### Scaling: drift budget vs beacons (n={len(routes)} routes)")
    print()
    headers = [
        "method (per budget)",
        "mean beacons", "max beacons",
        "mean worst drift", "max worst drift",
    ]
    rows: List[List[str]] = []
    for b in budgets_ft:
        for label, gen in (
            (f"Ours, budget {b:g} ft",
             lambda c, b=b: autotune(c, max_drift_ft=b, step_ft=step_ft).result.beacons),
            (f"DP, eps = {b:g} ft",
             lambda c, b=b: douglas_peucker(c, b)),
        ):
            ns: List[int] = []
            ds: List[float] = []
            for _, coords in routes:
                samples = resample_polyline(coords, step_ft)
                beacons = gen(coords)
                ns.append(len(beacons))
                ds.append(worst_drift_against_polyline(beacons, samples))
            rows.append([
                label,
                f"{statistics.mean(ns):.1f}",
                fmt_int(max(ns)),
                fmt_ft(statistics.mean(ds)),
                fmt_ft(max(ds)),
            ])
    # Fixed spacings (budget-independent reference rows)
    for s_ft in (98.4, 164.0):  # 30 m, 50 m
        ns: List[int] = []
        ds: List[float] = []
        for _, coords in routes:
            samples = resample_polyline(coords, step_ft)
            beacons = fixed_spacing(coords, s_ft)
            ns.append(len(beacons))
            ds.append(worst_drift_against_polyline(beacons, samples))
        rows.append([
            f"Fixed-spacing {s_ft:g} ft (~{s_ft / 3.28084:.0f} m)",
            f"{statistics.mean(ns):.1f}",
            fmt_int(max(ns)),
            fmt_ft(statistics.mean(ds)),
            fmt_ft(max(ds)),
        ])
    print(md_table(headers, rows))
    print()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--budget", type=float, default=10.0,
                   help="Primary drift budget (ft) for the per-route table (default 10).")
    p.add_argument("--budgets", type=str, default="5,10,25",
                   help="Comma-separated drift budgets (ft) for the scaling table (default 5,10,25).")
    p.add_argument("--step", type=float, default=20.0,
                   help="Polyline resampling step (ft) shared by all methods (default 20).")
    p.add_argument("--fixed-spacings", type=str, default="98.4,164.0",
                   help="Comma-separated fixed-spacing values (ft) for the baseline (default 98.4=30m, 164=50m).")
    p.add_argument("--root", type=Path, default=HERE,
                   help="Directory holding central_park_*.geojson fixtures.")
    args = p.parse_args()

    budgets = [float(x) for x in args.budgets.split(",") if x.strip()]
    fixed = [float(x) for x in args.fixed_spacings.split(",") if x.strip()]

    routes = all_routes(args.root)
    if not routes:
        raise SystemExit(f"no central_park_*.geojson found in {args.root}")

    print(f"# Baseline comparison ({len(routes)} routes from {args.root.name})")
    print()
    print_per_route_table(routes, args.budget, args.step, fixed)
    print_scaling_table(routes, budgets, args.step)


if __name__ == "__main__":
    main()
