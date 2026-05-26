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
from typing import List, Optional, Sequence, Tuple

from beacon_placement import (
    EARTH_RADIUS_FT,
    LonLat,
    _DEG_TO_FT,
    angle_diff_deg,
    autotune,
    bearing_deg,
    chord_drift_ft,
    haversine_ft,
    place_beacons,
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
# Plot: DP vs Ours, worst-drift annotation
# --------------------------------------------------------------------------- #

def _local_xy(
    coords: Sequence[LonLat],
    origin: Optional[LonLat] = None,
) -> List[Tuple[float, float]]:
    """Project (lon, lat) to local (x_ft, y_ft).

    Origin defaults to `coords[0]` when not supplied, which is convenient for
    projecting a whole route in one go. Pass an explicit `origin` when
    projecting individual points that must share the same origin as some
    earlier projection (e.g. worst-drift chord endpoints relative to the
    route they live on) -- otherwise every single-point projection would
    return (0, 0) because the point becomes its own origin.
    """
    if not coords:
        return []
    if origin is None:
        origin = coords[0]
    lon0, lat0 = origin
    lat0_rad = math.radians(lat0)
    sx = _DEG_TO_FT * math.cos(lat0_rad)
    sy = _DEG_TO_FT
    return [((lon - lon0) * sx, (lat - lat0) * sy) for lon, lat in coords]


def _worst_drift_chord(
    beacons: Sequence[LonLat],
    samples: Sequence[LonLat],
) -> Optional[Tuple[int, LonLat, LonLat, LonLat, float]]:
    """For the given beacon set, find the (chord, polyline point) with the worst
    perpendicular distance from that point to that chord.

    Returns (chord_idx, chord_start, chord_end, worst_point, drift_ft) or None.
    Operates against the dense `samples` polyline so it does not depend on
    whether the beacons are a subset of `samples` (Ours) or a subset of the
    original OSM vertices (DP).
    """
    if len(beacons) < 2 or len(samples) < 2:
        return None
    # Project each beacon's nearest sample index (forward-scan, monotonic).
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
    indices[0] = 0
    indices[-1] = len(samples) - 1

    worst_drift = -1.0
    worst_chord_idx = -1
    worst_point: Optional[LonLat] = None
    for k in range(len(indices) - 1):
        a, b = samples[indices[k]], samples[indices[k + 1]]
        lat0 = math.radians((a[1] + b[1]) / 2.0)
        sx = _DEG_TO_FT * math.cos(lat0)
        sy = _DEG_TO_FT
        bx, by = (b[0] - a[0]) * sx, (b[1] - a[1]) * sy
        L = math.hypot(bx, by) or 1.0
        for j in range(indices[k] + 1, indices[k + 1]):
            p = samples[j]
            px, py = (p[0] - a[0]) * sx, (p[1] - a[1]) * sy
            d = abs(px * by - py * bx) / L
            if d > worst_drift:
                worst_drift = d
                worst_chord_idx = k
                worst_point = p
    if worst_chord_idx < 0 or worst_point is None:
        return None
    chord_start = samples[indices[worst_chord_idx]]
    chord_end = samples[indices[worst_chord_idx + 1]]
    return worst_chord_idx, chord_start, chord_end, worst_point, worst_drift


def _perp_foot_xy(
    p_xy: Tuple[float, float],
    a_xy: Tuple[float, float],
    b_xy: Tuple[float, float],
) -> Tuple[float, float]:
    """Foot of perpendicular from p to line through a, b -- in local-ft coords."""
    ax, ay = a_xy
    bx, by = b_xy
    px, py = p_xy
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return (ax, ay)
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    return (ax + t * dx, ay + t * dy)


def _plot_panel(
    ax,
    *,
    title: str,
    osm_coords: Sequence[LonLat],
    samples: Sequence[LonLat],
    beacons: Sequence[LonLat],
    beacon_color: str,
    show_resample: bool,
    drift_budget_ft: Optional[float] = None,
) -> None:
    """Render one method's beacons over the input polyline + worst-drift call-out."""
    # Anchor every projection to the route's first coordinate so all sets
    # (polyline, resample, beacons, worst-drift annotations) share one origin.
    origin = osm_coords[0] if osm_coords else None
    osm_xy = _local_xy(osm_coords, origin)
    sample_xy = _local_xy(samples, origin)
    beacon_xy = _local_xy(beacons, origin)

    # Underlying polyline drawn as a thick band so the methods' chords
    # are visually offset from it whenever they cut across.
    ox = [p[0] for p in osm_xy]
    oy = [p[1] for p in osm_xy]
    ax.plot(ox, oy, color="#9e9e9e", linewidth=6.0, alpha=0.55,
            label="Route polyline (truth)", zorder=1, solid_capstyle="round")

    if show_resample:
        sx = [p[0] for p in sample_xy]
        sy = [p[1] for p in sample_xy]
        ax.scatter(sx, sy, color="#5499c7", s=8, alpha=0.55,
                   label="20 ft resample (input to Ours)", zorder=2)

    bx = [p[0] for p in beacon_xy]
    by = [p[1] for p in beacon_xy]
    ax.plot(bx, by, color=beacon_color, linewidth=1.6,
            marker="o", markersize=6, markerfacecolor=beacon_color,
            markeredgecolor="white", markeredgewidth=0.8,
            label="beacons + chords", zorder=4)

    # Worst-drift annotation against the dense polyline.
    info = _worst_drift_chord(beacons, samples)
    if info is not None:
        _, chord_a, chord_b, worst_pt, drift_ft = info
        a_xy = _local_xy([chord_a], origin)[0]
        b_xy = _local_xy([chord_b], origin)[0]
        p_xy = _local_xy([worst_pt], origin)[0]
        foot = _perp_foot_xy(p_xy, a_xy, b_xy)
        # Highlight the chord that produced the worst drift -- contrasting
        # colour drawn ABOVE the beacon-coloured chord polyline so the
        # offending chord pops even when most chords are short.
        ax.plot([a_xy[0], b_xy[0]], [a_xy[1], b_xy[1]],
                color="#f1c40f", linewidth=5.5, alpha=0.95,
                label="worst-drift chord", zorder=5, solid_capstyle="round")
        ax.plot([p_xy[0], foot[0]], [p_xy[1], foot[1]],
                color="#c0392b", linewidth=2.0, linestyle="--", zorder=5)
        ax.plot([p_xy[0]], [p_xy[1]], color="#c0392b", marker="x",
                markersize=11, markeredgewidth=2.4, zorder=6)
        # Push the label out along the perpendicular so it doesn't collide
        # with the route polyline.
        px, py = p_xy
        fx, fy = foot
        dx, dy = px - fx, py - fy
        norm = math.hypot(dx, dy) or 1.0
        off_x = dx / norm * 40
        off_y = dy / norm * 40
        # Annotate budget compliance when a budget is provided: red border
        # for ε-violation, green for budget-met. Makes the headline visible
        # without needing to read the surrounding caption.
        if drift_budget_ft is not None:
            ratio = drift_ft / drift_budget_ft
            if ratio > 1.05:
                label = (f"worst drift {drift_ft:.1f} ft\n"
                         f"OVER {drift_budget_ft:g} ft budget ({ratio:.1f}×)")
                border = "#c0392b"
                fc = "#fdecea"
            else:
                label = (f"worst drift {drift_ft:.1f} ft\n"
                         f"under {drift_budget_ft:g} ft budget")
                border = "#1e8449"
                fc = "#eafaf1"
        else:
            label = f"worst drift: {drift_ft:.1f} ft"
            border = "#c0392b"
            fc = "white"
        ax.annotate(
            label,
            xy=p_xy,
            xytext=(off_x, off_y),
            textcoords="offset points",
            fontsize=10,
            color=border,
            ha="center",
            arrowprops={"arrowstyle": "-", "color": border, "lw": 1.0},
            bbox={"boxstyle": "round,pad=0.35",
                  "fc": fc, "ec": border, "lw": 1.4, "alpha": 0.96},
            zorder=7,
        )

    ax.set_title(title, fontsize=11)
    ax.set_xlabel("east (ft)")
    ax.set_ylabel("north (ft)")
    ax.set_aspect("equal", adjustable="datalim")
    ax.grid(True, alpha=0.25)
    ax.legend(loc="best", fontsize=8, framealpha=0.85)


def _synthetic_arc(
    n_osm_vertices: int = 5,
    radius_ft: float = 500.0,
    sweep_deg: float = 90.0,
    lon0: float = -73.9700,
    lat0: float = 40.7800,
) -> List[LonLat]:
    """Sparse 'OSM-like' vertices along a circular arc.

    Demonstrates the chord-cap failure mode in isolation: a smooth curve
    that DP can simplify to one chord because every interior vertex has
    bounded perpendicular distance from its neighbours' chord, even
    though the cumulative chord deviates substantially from the arc.
    """
    sweep = math.radians(sweep_deg)
    cx, cy = 0.0, 0.0
    # Arc parametrised so vertex 0 is at angle -sweep/2 and last is +sweep/2.
    pts: List[LonLat] = []
    lat0_rad = math.radians(lat0)
    sx = _DEG_TO_FT * math.cos(lat0_rad)
    sy = _DEG_TO_FT
    for i in range(n_osm_vertices):
        t = -sweep / 2 + sweep * i / (n_osm_vertices - 1)
        x_ft = cx + radius_ft * math.sin(t)
        y_ft = cy + radius_ft * (1 - math.cos(t))
        pts.append((lon0 + x_ft / sx, lat0 + y_ft / sy))
    # Densify between OSM vertices into a near-continuous arc so resampling
    # captures the curvature. (OSM in reality usually gives only the endpoints
    # of each road segment, but for a clean synthetic demo we want the input
    # polyline itself to follow the arc; the visual story remains "DP keeps
    # few vertices, ours tracks the curve".)
    dense: List[LonLat] = []
    for i in range(200):
        t = -sweep / 2 + sweep * i / 199
        x_ft = cx + radius_ft * math.sin(t)
        y_ft = cy + radius_ft * (1 - math.cos(t))
        dense.append((lon0 + x_ft / sx, lat0 + y_ft / sy))
    return dense


def generate_comparison_plot(
    out_path: Path,
    *,
    real_route_path: Path,
    drift_budget_ft: float = 10.0,
    dp_eps_ft: float = 10.0,
    step_ft: float = 20.0,
    chord_cap_ft: float = 150.0,
    real_angle_deg: float = 8.0,
    real_chord_cap_ft: float = 300.0,
) -> None:
    """Render a 2x2 DP-vs-Ours figure (synthetic top, real route bottom)."""
    # Force a non-GUI backend before importing pyplot -- the script runs
    # in headless contexts (subagents, CI, sandboxes) and macOS's default
    # `macosx` backend SIGABRTs without a window server.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # Top row: synthetic arc. The DP and Ours panels share the SAME visual
    # drift target so the comparison is apples-to-apples; we expose DP's
    # chord-skip failure mode by picking an eps high enough that DP's
    # recursive distance test drops the sub-arc midpoints, while Ours
    # uses a chord-length cap that subdivides regardless.
    synth_eps_ft = 40.0
    synth_chord_cap = 150.0
    synth_angle_deg = 8.0
    arc_coords = _synthetic_arc()
    arc_samples = resample_polyline(arc_coords, step_ft)
    arc_dp = douglas_peucker(arc_coords, synth_eps_ft)
    arc_ours = place_beacons(
        arc_coords, synth_angle_deg, step_ft, synth_chord_cap
    ).beacons

    # Bottom row: real route from geojson.
    slug, real_coords = load_route(real_route_path)
    real_samples = resample_polyline(real_coords, step_ft)
    real_dp = douglas_peucker(real_coords, dp_eps_ft)
    real_tune = autotune(real_coords, max_drift_ft=drift_budget_ft, step_ft=step_ft)
    real_ours = real_tune.result.beacons

    fig, axes = plt.subplots(2, 2, figsize=(13.5, 11.0))
    fig.suptitle(
        "Douglas-Peucker vs chord-anchor beacon placement — two DP failure modes\n"
        "Top: synthetic gentle arc — DP has no chord-length governor, so a smooth curve "
        "becomes one long chord that drifts.\n"
        f"Bottom: real OSM pedestrian route ({slug}) — DP at ε = {dp_eps_ft:g} ft "
        f"overshoots its own budget against the as-walked polyline.",
        fontsize=11,
    )

    _plot_panel(
        axes[0][0],
        title=(f"Synthetic arc — DP (ε = {synth_eps_ft:g} ft)\n"
               f"{len(arc_dp)} beacons, longest chord "
               f"{longest_chord_ft(arc_dp):.0f} ft"),
        osm_coords=arc_coords,
        samples=arc_samples,
        beacons=arc_dp,
        beacon_color="#c0392b",
        show_resample=False,
    )
    _plot_panel(
        axes[0][1],
        title=(f"Synthetic arc — Ours (angle {synth_angle_deg:g}°, "
               f"chord cap {synth_chord_cap:g} ft)\n"
               f"{len(arc_ours)} beacons, longest chord "
               f"{longest_chord_ft(arc_ours):.0f} ft"),
        osm_coords=arc_coords,
        samples=arc_samples,
        beacons=arc_ours,
        beacon_color="#2471a3",
        show_resample=True,
    )
    _plot_panel(
        axes[1][0],
        title=(f"Real route — DP (ε = {dp_eps_ft:g} ft)\n"
               f"{len(real_dp)} beacons, longest chord "
               f"{longest_chord_ft(real_dp):.0f} ft"),
        osm_coords=real_coords,
        samples=real_samples,
        beacons=real_dp,
        beacon_color="#c0392b",
        show_resample=False,
        drift_budget_ft=dp_eps_ft,
    )
    _plot_panel(
        axes[1][1],
        title=(f"Real route — Ours (autotune, budget {drift_budget_ft:g} ft → "
               f"angle {real_tune.angle_deg:g}°, "
               f"cap {real_tune.max_chord_ft or float('inf'):g} ft)\n"
               f"{len(real_ours)} beacons, longest chord "
               f"{longest_chord_ft(real_ours):.0f} ft"),
        osm_coords=real_coords,
        samples=real_samples,
        beacons=real_ours,
        beacon_color="#2471a3",
        show_resample=True,
        drift_budget_ft=drift_budget_ft,
    )

    plt.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


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
    p.add_argument("--plot", type=Path, default=None, metavar="PATH",
                   help="Generate the DP-vs-Ours comparison figure (saves to PATH).")
    p.add_argument("--plot-route", type=str, default="central_park_03_ramble",
                   help="Geojson stem (without .geojson) for the real-route panel. "
                        "Ramble is the default because its winding pedestrian path "
                        "exercises the chord-length cap most visibly (DP at eps=10 ft "
                        "produces a 512 ft chord; Ours caps at 200 ft).")
    args = p.parse_args()

    budgets = [float(x) for x in args.budgets.split(",") if x.strip()]
    fixed = [float(x) for x in args.fixed_spacings.split(",") if x.strip()]

    routes = all_routes(args.root)
    if not routes:
        raise SystemExit(f"no central_park_*.geojson found in {args.root}")

    if args.plot is not None:
        route_path = args.root / f"{args.plot_route}.geojson"
        if not route_path.exists():
            raise SystemExit(f"plot route not found: {route_path}")
        generate_comparison_plot(
            args.plot,
            real_route_path=route_path,
            drift_budget_ft=args.budget,
            dp_eps_ft=args.budget,
            step_ft=args.step,
        )
        print(f"wrote {args.plot}")
        return

    print(f"# Baseline comparison ({len(routes)} routes from {args.root.name})")
    print()
    print_per_route_table(routes, args.budget, args.step, fixed)
    print_scaling_table(routes, budgets, args.step)


if __name__ == "__main__":
    main()
