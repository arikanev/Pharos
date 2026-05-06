#!/usr/bin/env python3
"""Run autotuned beacon placement on ten distinct Central Park footpaths.

Each route is fetched via the `pedestrian` profile (OSRM-foot on FOSSGIS,
falling back to Valhalla), so we get real OSM footpath geometry rather than
the road graph. The autotune picks `(angle, max_chord, min_spacing)` so
worst perpendicular drift stays under `DRIFT_BUDGET_FT` while minimizing
beacons.

Outputs:
    central_park_<slug>.png      -- one high-DPI PNG per route, zoomable
    central_park_gallery.png     -- combined grid of all routes
plus a Markdown summary printed to stdout, with Google Maps walking-
directions URLs for each route.
"""

from __future__ import annotations

import argparse
import json
import time
from typing import List, Tuple

import matplotlib.pyplot as plt

from beacon_placement import (LonLat, autotune, fetch_route, haversine_ft,
                              to_geojson)


DRIFT_BUDGET_FT = 5.0
STEP_FT = 20.0


# (name, slug, start (lon, lat), end (lon, lat))
ROUTES: List[Tuple[str, str, LonLat, LonLat]] = [
    ("The Mall (south to Bethesda Terrace)",
     "01_mall",                  (-73.9722, 40.7705), (-73.9711, 40.7745)),
    ("Bethesda Terrace to Bow Bridge (west side of Lake)",
     "02_bow_bridge",            (-73.9712, 40.7747), (-73.9758, 40.7765)),
    ("The Ramble winding paths",
     "03_ramble",                (-73.9710, 40.7770), (-73.9690, 40.7790)),
    ("Reservoir east side (south gate to north gate)",
     "04_reservoir_east",        (-73.9645, 40.7825), (-73.9620, 40.7900)),
    ("Sheep Meadow to Strawberry Fields",
     "05_sheep_to_strawberry",   (-73.9740, 40.7720), (-73.9762, 40.7757)),
    ("Wollman Rink to Carousel",
     "06_wollman_to_carousel",   (-73.9742, 40.7686), (-73.9740, 40.7716)),
    ("Belvedere Castle to Cleopatra's Needle",
     "07_castle_to_obelisk",     (-73.9692, 40.7794), (-73.9656, 40.7795)),
    ("Conservatory Garden to North Meadow",
     "08_conservatory_to_north", (-73.9530, 40.7935), (-73.9598, 40.7910)),
    ("Bridle Path west of Reservoir",
     "09_bridle_path_west",      (-73.9700, 40.7825), (-73.9700, 40.7900)),
    ("Great Lawn perimeter (SE to NW)",
     "10_great_lawn",            (-73.9655, 40.7800), (-73.9710, 40.7820)),
]


def fetch_with_retry(start: LonLat, end: LonLat, tries: int = 2) -> List[LonLat]:
    """Try `fetch_route` a couple of times.

    `fetch_route` already walks an OSRM->Valhalla fallback chain with a 10s
    per-backend timeout, so a single call fails fast (well under a minute)
    on a dead public endpoint. This wrapper just smooths over transient
    rate-limits or 5xx responses with a short backoff.
    """
    last_err: Exception | None = None
    for i in range(tries):
        try:
            return fetch_route(start, end, profile="pedestrian")
        except Exception as e:
            last_err = e
            if i + 1 < tries:
                time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"routing failed after {tries} tries: {last_err}")


def gmaps_walking_url(start: LonLat, end: LonLat) -> str:
    return (f"https://www.google.com/maps/dir/?api=1"
            f"&origin={start[1]:.6f},{start[0]:.6f}"
            f"&destination={end[1]:.6f},{end[0]:.6f}"
            f"&travelmode=walking")


def render_panel(ax, name, coords, tune, length_ft, start, end,
                 drift_budget_ft: float = DRIFT_BUDGET_FT) -> None:
    rx, ry = zip(*coords)
    bx, by = zip(*tune.result.beacons)
    ax.plot(rx, ry, color="#888", linewidth=2, zorder=1, label="OSM route")
    ax.plot(bx, by, color="#d62728", linewidth=1.4, zorder=2,
            label="chord path")
    ax.plot(bx, by, "o", color="#d62728", markersize=5, zorder=3,
            label=f"{tune.beacons} beacons")
    ax.plot([start[0], end[0]], [start[1], end[1]], "o",
            color="#1f77b4", markersize=10, zorder=4, label="start/end")
    ax.set_aspect("equal", adjustable="datalim")
    ax.grid(True, linestyle=":", alpha=0.4)
    cap = "none" if tune.max_chord_ft is None else f"{tune.max_chord_ft:.0f}"
    ms = "none" if tune.min_spacing_ft is None else f"{tune.min_spacing_ft:.0f}"
    ok = "OK" if tune.drift_ft <= drift_budget_ft else "OVER"
    sub = (f"angle={tune.angle_deg:g}\u00b0  cap={cap}  ms={ms}  "
           f"drift={tune.drift_ft:.1f} ft ({ok})")
    ax.set_title(
        f"{name}\n{length_ft:,.0f} ft  \u00b7  {tune.beacons} beacons\n{sub}",
        fontsize=10,
    )
    ax.legend(loc="best", fontsize=7, framealpha=0.85)


def main(argv: List[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=("Autotune beacon placement on 10 Central Park "
                     "footpaths and (optionally) export GeoJSON."),
    )
    parser.add_argument("--drift", type=float, default=DRIFT_BUDGET_FT,
                        help=f"Max worst-case perpendicular drift in feet "
                             f"(default: {DRIFT_BUDGET_FT:g}).")
    parser.add_argument("--export-geojson", action="store_true",
                        help="Write central_park_<slug>.geojson per route, "
                             "plus a combined central_park_all.geojson.")
    args = parser.parse_args(argv)
    drift_budget_ft = args.drift

    print(f"Autotuning {len(ROUTES)} Central Park footpaths to drift "
          f"\u2264 {drift_budget_ft:g} ft, step = {STEP_FT:g} ft"
          + (" (also exporting GeoJSON)" if args.export_geojson else "")
          + "\n")
    header = (f"{'#':>2}  {'route':<48}  {'len_ft':>8}  {'beacons':>8}  "
              f"{'drift':>6}  {'angle':>5}  {'cap':>5}  {'ms':>5}")
    print(header)
    print("-" * len(header))

    rows = []
    for idx, (name, slug, start, end) in enumerate(ROUTES, 1):
        t_route = time.time()
        try:
            t0 = time.time()
            coords = fetch_with_retry(start, end)
            t_fetch = time.time() - t0
        except Exception as e:
            print(f"{idx:>2}  {name:<48}  ROUTING FAILED: {e}", flush=True)
            continue

        t0 = time.time()
        tune = autotune(coords, max_drift_ft=drift_budget_ft, step_ft=STEP_FT)
        t_tune = time.time() - t0
        length_ft = sum(haversine_ft(a, b)
                        for a, b in zip(coords[:-1], coords[1:]))
        cap_s = "none" if tune.max_chord_ft is None else f"{tune.max_chord_ft:.0f}"
        ms_s = "none" if tune.min_spacing_ft is None else f"{tune.min_spacing_ft:.0f}"
        print(f"{idx:>2}  {name:<48}  {length_ft:>8,.0f}  {tune.beacons:>8}  "
              f"{tune.drift_ft:>6.1f}  {tune.angle_deg:>5g}  "
              f"{cap_s:>5}  {ms_s:>5}    "
              f"[fetch {t_fetch:4.1f}s, tune {t_tune:4.1f}s, "
              f"total {time.time()-t_route:4.1f}s]", flush=True)

        fig, ax = plt.subplots(figsize=(10, 8))
        render_panel(ax, name, coords, tune, length_ft, start, end,
                     drift_budget_ft=drift_budget_ft)
        fig.tight_layout()
        png_path = f"central_park_{slug}.png"
        fig.savefig(png_path, dpi=160)
        plt.close(fig)

        geojson_path = None
        if args.export_geojson:
            fc = to_geojson(
                tune.result, coords,
                name=name, profile="pedestrian", drift_ft=tune.drift_ft,
                extra_properties={
                    "slug": slug,
                    "angle_deg": tune.angle_deg,
                    "max_chord_ft": tune.max_chord_ft,
                    "min_spacing_ft": tune.min_spacing_ft,
                    "drift_budget_ft": drift_budget_ft,
                    "step_ft": STEP_FT,
                },
            )
            geojson_path = f"central_park_{slug}.geojson"
            with open(geojson_path, "w") as f:
                json.dump(fc, f)

        rows.append({
            "idx": idx, "name": name, "slug": slug,
            "coords": coords, "tune": tune, "length_ft": length_ft,
            "start": start, "end": end, "png": png_path,
            "geojson": geojson_path,
        })

    if not rows:
        print("\nNo routes succeeded; nothing to render.")
        return

    cols = 3
    nrows = (len(rows) + cols - 1) // cols
    fig, axes = plt.subplots(nrows, cols, figsize=(cols * 6.0, nrows * 5.0))
    axes = axes.flatten()
    for ax, r in zip(axes, rows):
        render_panel(ax, r["name"], r["coords"], r["tune"], r["length_ft"],
                     r["start"], r["end"], drift_budget_ft=drift_budget_ft)
    for ax in axes[len(rows):]:
        ax.set_visible(False)
    fig.suptitle(
        f"Central Park footpaths  \u00b7  autotune drift \u2264 "
        f"{drift_budget_ft:g} ft  \u00b7  OSM pedestrian",
        fontsize=14,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig("central_park_gallery.png", dpi=130)
    plt.close(fig)

    print("\nSaved: central_park_gallery.png + "
          f"{len(rows)} per-route PNGs (central_park_<slug>.png)")

    if args.export_geojson:
        combined = {
            "type": "FeatureCollection",
            "properties": {
                "description": ("Central Park footpaths, autotuned beacon "
                                "placement"),
                "drift_budget_ft": drift_budget_ft,
                "step_ft": STEP_FT,
                "route_count": len(rows),
            },
            "features": [],
        }
        for r in rows:
            fc = to_geojson(
                r["tune"].result, r["coords"],
                name=r["name"], profile="pedestrian",
                drift_ft=r["tune"].drift_ft,
                extra_properties={"slug": r["slug"], "route_index": r["idx"]},
            )
            for feat in fc["features"]:
                feat["properties"]["route"] = r["name"]
                feat["properties"]["route_slug"] = r["slug"]
                combined["features"].append(feat)
        with open("central_park_all.geojson", "w") as f:
            json.dump(combined, f)
        print(f"Saved: central_park_all.geojson + "
              f"{len(rows)} per-route GeoJSON files "
              f"(central_park_<slug>.geojson)")
    print()
    print("--- Markdown summary ---\n")
    print("| # | Route | Length | Beacons | Drift | Tuning | Map |")
    print("|---|---|---:|---:|---:|---|---|")
    for r in rows:
        t = r["tune"]
        cap = "none" if t.max_chord_ft is None else f"{t.max_chord_ft:.0f}"
        ms = "none" if t.min_spacing_ft is None else f"{t.min_spacing_ft:.0f}"
        url = gmaps_walking_url(r["start"], r["end"])
        print(f"| {r['idx']} | {r['name']} | {r['length_ft']:,.0f} ft | "
              f"{t.beacons} | {t.drift_ft:.1f} ft | "
              f"`angle={t.angle_deg:g}, cap={cap}, ms={ms}` | "
              f"[walk]({url}) |")


if __name__ == "__main__":
    main()
