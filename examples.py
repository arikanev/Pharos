#!/usr/bin/env python3
"""Gallery of curved routes showing how the beacon placer behaves.

Run:

    python examples.py                                    # default 8 deg / 20 ft
    python examples.py --angle 5 --step 15                # tighter manual settings
    python examples.py --autotune-drift 5                 # autotune each panel
    python examples.py --autotune-drift 3 --min-spacing 30
"""

from __future__ import annotations

import argparse
import math
from typing import Callable, List, Tuple

import matplotlib.pyplot as plt
import numpy as np

from beacon_placement import (LonLat, autotune, haversine_ft,
                              place_beacons)


# All routes are tiny offsets from this anchor so they render as a near-planar
# XY plot while still being valid (lon, lat) inputs to the algorithm.
BASE_LON, BASE_LAT = -73.9857, 40.7484
DEG = 0.001  # 0.001 deg ~= 365 ft at this latitude


def _from_xy(xs, ys) -> List[LonLat]:
    return [(BASE_LON + float(x), BASE_LAT + float(y))
            for x, y in zip(xs, ys)]


# --------------------------------------------------------------------------- #
# Route generators
# --------------------------------------------------------------------------- #

def straight() -> List[LonLat]:
    t = np.linspace(0, 1, 60)
    return _from_xy(8 * DEG * t, 4 * DEG * t)


def gentle_arc() -> List[LonLat]:
    a = np.linspace(0, math.pi / 4, 80)
    r = 10 * DEG
    return _from_xy(r * np.sin(a), r * (1 - np.cos(a)))


def hairpin() -> List[LonLat]:
    t1 = np.linspace(0, 4, 40)
    p1 = (DEG * t1, np.zeros_like(t1))
    a = np.linspace(-math.pi / 2, math.pi / 2, 80)
    r = 1.5 * DEG
    p2 = (4 * DEG + r * np.cos(a), 1.5 * DEG + r * np.sin(a))
    t3 = np.linspace(0, 4, 40)
    p3 = (4 * DEG - DEG * t3, 3 * DEG * np.ones_like(t3))
    xs = np.concatenate([p1[0], p2[0], p3[0]])
    ys = np.concatenate([p1[1], p2[1], p3[1]])
    return _from_xy(xs, ys)


def s_curve() -> List[LonLat]:
    t = np.linspace(0, 1, 120)
    return _from_xy(8 * DEG * t, 1.5 * DEG * np.sin(2 * math.pi * t))


def sinusoidal() -> List[LonLat]:
    t = np.linspace(0, 1, 200)
    return _from_xy(10 * DEG * t, DEG * np.sin(6 * math.pi * t))


def spiral() -> List[LonLat]:
    a = np.linspace(0.4, 4 * math.pi, 250)
    r = 0.15 * DEG * a
    return _from_xy(r * np.cos(a), r * np.sin(a))


def chicane() -> List[LonLat]:
    t = np.linspace(0, 1, 150)
    y = (1.2 * DEG * np.tanh(20 * (t - 0.4))
         - 1.2 * DEG * np.tanh(20 * (t - 0.6)))
    return _from_xy(8 * DEG * t, y)


def mixed_road() -> List[LonLat]:
    parts = []
    t = np.linspace(0, 3, 30)
    parts.append((DEG * t, np.zeros_like(t)))
    a = np.linspace(-math.pi / 2, 0, 40)
    r = 1.5 * DEG
    parts.append((3 * DEG + r * np.cos(a), 1.5 * DEG + r * np.sin(a)))
    t = np.linspace(0, 2, 25)
    parts.append((4.5 * DEG + 0 * t, 1.5 * DEG + DEG * t))
    a = np.linspace(0, math.pi / 2, 25)
    r = 0.5 * DEG
    parts.append((4.5 * DEG + r * np.sin(a), 3.5 * DEG + r * (1 - np.cos(a))))
    t = np.linspace(0, 3, 30)
    parts.append((5 * DEG + DEG * t, 4 * DEG + 0 * t))
    xs = np.concatenate([p[0] for p in parts])
    ys = np.concatenate([p[1] for p in parts])
    return _from_xy(xs, ys)


def wiggly() -> List[LonLat]:
    rng = np.random.default_rng(42)
    n = 200
    t = np.linspace(0, 1, n)
    x = 10 * DEG * t
    y = np.cumsum(rng.normal(0, 0.05, n)) * DEG
    y = y - y[0]
    return _from_xy(x, y)


EXAMPLES: List[Tuple[str, Callable[[], List[LonLat]]]] = [
    ("Straight",     straight),
    ("Gentle arc",   gentle_arc),
    ("Hairpin",      hairpin),
    ("S-curve",      s_curve),
    ("Sinusoidal",   sinusoidal),
    ("Spiral",       spiral),
    ("Chicane",      chicane),
    ("Mixed road",   mixed_road),
    ("Random wiggle", wiggly),
]


# --------------------------------------------------------------------------- #
# Gallery plot
# --------------------------------------------------------------------------- #

def gallery(angle_deg: float, step_ft: float,
            autotune_drift_ft: float | None = None,
            min_spacing_ft: float | None = None,
            save: str | None = None) -> None:
    cols = 3
    rows = (len(EXAMPLES) + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(cols * 5.0, rows * 4.2))
    axes = axes.flatten()

    for ax, (name, gen) in zip(axes, EXAMPLES):
        coords = gen()
        length_ft = sum(haversine_ft(a, b)
                        for a, b in zip(coords[:-1], coords[1:]))

        if autotune_drift_ft is not None:
            tune = autotune(coords, max_drift_ft=autotune_drift_ft,
                            step_ft=step_ft, min_spacing_ft=min_spacing_ft)
            result = tune.result
            cap = ("none" if tune.max_chord_ft is None
                   else f"{tune.max_chord_ft:.0f}")
            ms = ("none" if tune.min_spacing_ft is None
                  else f"{tune.min_spacing_ft:.0f}")
            ok = "OK" if tune.drift_ft <= autotune_drift_ft else "OVER"
            sub = (f"angle={tune.angle_deg:g}\u00b0 cap={cap} ms={ms}  "
                   f"drift={tune.drift_ft:.1f}ft ({ok})")
        else:
            result = place_beacons(coords, angle_deg, step_ft)
            sub = f"angle={angle_deg:g}\u00b0 step={step_ft:g}ft"

        rx, ry = zip(*coords)
        bx, by = zip(*result.beacons)

        ax.plot(rx, ry, color="#888", linewidth=2, zorder=1, label="route")
        ax.plot(bx, by, color="#d62728", linewidth=1.4, zorder=2,
                label="chord path")
        ax.plot(bx, by, "o", color="#d62728", markersize=6, zorder=3,
                label=f"{len(result.beacons)} beacons")

        ax.set_aspect("equal", adjustable="datalim")
        ax.grid(True, linestyle=":", alpha=0.4)
        ax.tick_params(labelsize=7)
        ax.set_title(
            f"{name}  \u00b7  {length_ft:,.0f} ft  \u00b7  "
            f"{len(result.beacons)} beacons\n{sub}",
            fontsize=9,
        )
        ax.legend(loc="best", fontsize=7, framealpha=0.85)

    for ax in axes[len(EXAMPLES):]:
        ax.set_visible(False)

    if autotune_drift_ft is not None:
        suptitle = (f"Autotune gallery  \u00b7  drift \u2264 "
                    f"{autotune_drift_ft:g} ft  \u00b7  step = {step_ft:g} ft")
        if min_spacing_ft is not None:
            suptitle += f"  \u00b7  min_spacing pinned = {min_spacing_ft:g} ft"
        else:
            suptitle += "  \u00b7  min_spacing auto-picked per panel"
    else:
        suptitle = (f"Beacon placement gallery  \u00b7  angle \u2264 "
                    f"{angle_deg:g}\u00b0  \u00b7  step = {step_ft:g} ft")
    fig.suptitle(suptitle, fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.96))

    if save:
        fig.savefig(save, dpi=120)
        print(f"saved {save}")
    plt.show()


def main() -> None:
    p = argparse.ArgumentParser(description="Beacon placement example gallery.")
    p.add_argument("--angle", type=float, default=8.0,
                   help="angle threshold in degrees (default 8); "
                        "ignored if --autotune-drift is set")
    p.add_argument("--step", type=float, default=20.0,
                   help="resample step in feet (default 20)")
    p.add_argument("--autotune-drift", type=float, default=None,
                   metavar="FT",
                   help="autotune each panel: pick (angle, max_chord, "
                        "min_spacing) so worst drift <= FT and beacon "
                        "count is minimized")
    p.add_argument("--min-spacing", type=float, default=None, metavar="FT",
                   help="pin min-spacing (otherwise autotune picks per panel)")
    p.add_argument("--save", metavar="PATH",
                   help="optional PNG path to write the gallery to")
    args = p.parse_args()
    gallery(args.angle, args.step,
            autotune_drift_ft=args.autotune_drift,
            min_spacing_ft=args.min_spacing,
            save=args.save)


if __name__ == "__main__":
    main()
