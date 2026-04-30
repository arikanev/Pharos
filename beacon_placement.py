#!/usr/bin/env python3
"""Minimal-beacon placement on a route polyline.

Run as a script for a self-contained matplotlib demo:

    python beacon_placement.py                                            # synthetic
    python beacon_placement.py --angle 5 --step 15                        # tighter
    python beacon_placement.py --start=-73.985,40.748 --end=-73.965,40.760  # real OSM

The algorithm is a greedy forward walk; see README.md for a description.
"""

from __future__ import annotations

import argparse
import json
import math
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import List, Sequence, Tuple

import matplotlib.pyplot as plt
import numpy as np

LonLat = Tuple[float, float]
EARTH_RADIUS_FT = 20_902_231.0  # mean Earth radius


# --------------------------------------------------------------------------- #
# Geo helpers
# --------------------------------------------------------------------------- #

def haversine_ft(p: LonLat, q: LonLat) -> float:
    """Great-circle distance between two (lon, lat) points, in feet."""
    lon1, lat1 = math.radians(p[0]), math.radians(p[1])
    lon2, lat2 = math.radians(q[0]), math.radians(q[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * EARTH_RADIUS_FT * math.asin(math.sqrt(a))


def bearing_deg(p: LonLat, q: LonLat) -> float:
    """Initial bearing from p to q, degrees clockwise from north."""
    lon1, lat1 = math.radians(p[0]), math.radians(p[1])
    lon2, lat2 = math.radians(q[0]), math.radians(q[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = (math.cos(lat1) * math.sin(lat2)
         - math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def angle_diff_deg(a: float, b: float) -> float:
    """Smallest unsigned difference between two bearings, in degrees."""
    return abs((a - b + 540.0) % 360.0 - 180.0)


# --------------------------------------------------------------------------- #
# Resampling
# --------------------------------------------------------------------------- #

def resample_polyline(coords: Sequence[LonLat], step_ft: float) -> List[LonLat]:
    """Resample a (lon, lat) polyline at fixed `step_ft` intervals along it."""
    if len(coords) < 2:
        return [tuple(c) for c in coords]
    out: List[LonLat] = [tuple(coords[0])]
    leftover = 0.0  # distance into current segment already counted
    for a, b in zip(coords[:-1], coords[1:]):
        seg = haversine_ft(a, b)
        if seg == 0.0:
            continue
        d = step_ft - leftover
        while d <= seg:
            t = d / seg
            out.append((a[0] + t * (b[0] - a[0]),
                        a[1] + t * (b[1] - a[1])))
            d += step_ft
        leftover = seg - (d - step_ft)
    if out[-1] != tuple(coords[-1]):
        out.append(tuple(coords[-1]))
    return out


# --------------------------------------------------------------------------- #
# Beacon placement
# --------------------------------------------------------------------------- #

@dataclass
class BeaconResult:
    beacons: List[LonLat]   # final beacon coordinates
    samples: List[LonLat]   # the resampled polyline used internally
    indices: List[int]      # index of each beacon inside `samples`


def place_beacons(coords: Sequence[LonLat],
                  angle_threshold_deg: float = 8.0,
                  step_ft: float = 20.0) -> BeaconResult:
    """Greedy forward walk -- plant a beacon whenever the chord drifts too far.

    From the current anchor we record the bearing to the next sample as the
    intended chord direction.  We then advance one sample at a time; as soon
    as the bearing (anchor -> current sample) has rotated by more than the
    threshold, we plant a beacon at the previous sample and continue from
    there.  A straight section yields just two beacons (start and end);
    curves force more frequent placements.
    """
    samples = resample_polyline(coords, step_ft)
    if len(samples) < 2:
        return BeaconResult(list(samples), list(samples),
                            list(range(len(samples))))

    beacons = [samples[0]]
    indices = [0]
    anchor = 0
    while anchor < len(samples) - 1:
        ref = bearing_deg(samples[anchor], samples[anchor + 1])
        next_anchor = len(samples) - 1  # default: jump to the end
        for i in range(anchor + 2, len(samples)):
            cur = bearing_deg(samples[anchor], samples[i])
            if angle_diff_deg(cur, ref) > angle_threshold_deg:
                next_anchor = i - 1
                break
        beacons.append(samples[next_anchor])
        indices.append(next_anchor)
        anchor = next_anchor
    return BeaconResult(beacons, samples, indices)


# --------------------------------------------------------------------------- #
# Demo data
# --------------------------------------------------------------------------- #

def synthetic_route() -> List[LonLat]:
    """Demo polyline: flat start, S-curve middle, wiggly tail."""
    base_lon, base_lat = -73.9857, 40.7484
    t = np.linspace(0.0, 1.0, 250)
    lon = base_lon + 0.012 * t
    lat = base_lat + np.where(
        t < 0.25,
        0.0,
        np.where(
            t < 0.65,
            0.0010 * np.sin(2 * math.pi * (t - 0.25) / 0.40),
            0.0010 * np.sin(2 * math.pi * (t - 0.25) / 0.40)
            + 0.0006 * np.sin(8 * math.pi * (t - 0.65) / 0.35),
        ),
    )
    return list(zip(lon.tolist(), lat.tolist()))


def _ssl_context() -> ssl.SSLContext:
    """Build an SSL context, preferring certifi's bundle if installed.

    The python.org macOS installers ship without trusted CAs wired into the
    OpenSSL build, so a plain HTTPS call fails with CERTIFICATE_VERIFY_FAILED
    until either certifi is used or the bundled
    `Install Certificates.command` has been run once.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def osrm_route(start: LonLat, end: LonLat) -> List[LonLat]:
    """Fetch an OSM-backed driving route polyline from the public OSRM router."""
    url = ("https://router.project-osrm.org/route/v1/driving/"
           f"{start[0]},{start[1]};{end[0]},{end[1]}"
           "?overview=full&geometries=geojson")
    try:
        with urllib.request.urlopen(url, timeout=30,
                                    context=_ssl_context()) as resp:
            data = json.load(resp)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" in str(e):
            raise SystemExit(
                "SSL certificate verify failed.\n"
                "Fix with either:\n"
                "  pip install certifi\n"
                "or, on macOS python.org installers, run once:\n"
                "  /Applications/Python\\ 3.11/Install\\ Certificates.command"
            ) from e
        raise
    coords = data["routes"][0]["geometry"]["coordinates"]
    return [(c[0], c[1]) for c in coords]


# --------------------------------------------------------------------------- #
# Plot
# --------------------------------------------------------------------------- #

def plot_result(result: BeaconResult,
                raw_coords: Sequence[LonLat],
                angle_threshold_deg: float,
                step_ft: float,
                title_extra: str = "") -> None:
    fig, ax = plt.subplots(figsize=(11, 6))
    rx, ry = zip(*raw_coords)
    sx, sy = zip(*result.samples)
    bx, by = zip(*result.beacons)

    ax.plot(rx, ry, color="#888", linewidth=2.5, label="route", zorder=1)
    ax.plot(sx, sy, marker="o", linestyle="none", markersize=2.0,
            color="#bbb", label=f"resampled ({step_ft:g} ft)", zorder=2)
    ax.plot(bx, by, color="#d62728", linewidth=1.6,
            label="beacon chord path", zorder=3)
    ax.plot(bx, by, marker="o", linestyle="none", markersize=8.0,
            color="#d62728",
            label=f"beacons (n={len(result.beacons)})", zorder=4)

    ax.set_aspect("equal", adjustable="datalim")
    ax.grid(True, linestyle=":", alpha=0.4)
    ax.set_xlabel("longitude")
    ax.set_ylabel("latitude")
    title = (f"Beacon placement  |  angle \u2264 {angle_threshold_deg:g}\u00b0"
             f"  |  step = {step_ft:g} ft")
    if title_extra:
        title += f"  |  {title_extra}"
    ax.set_title(title)
    ax.legend(loc="best", framealpha=0.9)
    fig.tight_layout()
    plt.show()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _parse_lonlat(s: str) -> LonLat:
    a, b = s.split(",")
    return float(a), float(b)


def main() -> None:
    p = argparse.ArgumentParser(description="Beacon placement demo.")
    p.add_argument("--angle", type=float, default=8.0,
                   help="angle threshold in degrees (default 8)")
    p.add_argument("--step", type=float, default=20.0,
                   help="resample step in feet (default 20)")
    p.add_argument("--start", metavar="LON,LAT",
                   help="route start coordinate (use with --end to fetch OSM)")
    p.add_argument("--end", metavar="LON,LAT",
                   help="route end coordinate (use with --start to fetch OSM)")
    args = p.parse_args()

    if bool(args.start) ^ bool(args.end):
        p.error("--start and --end must be supplied together")

    if args.start and args.end:
        coords = osrm_route(_parse_lonlat(args.start),
                            _parse_lonlat(args.end))
        title_extra = "OSM (OSRM) route"
    else:
        coords = synthetic_route()
        title_extra = "synthetic route"

    result = place_beacons(coords, args.angle, args.step)
    total_ft = sum(haversine_ft(a, b)
                   for a, b in zip(coords[:-1], coords[1:]))
    print(f"Route length      : {total_ft:,.0f} ft")
    print(f"Resampled points  : {len(result.samples)}")
    print(f"Beacons planted   : {len(result.beacons)}")

    plot_result(result, coords, args.angle, args.step, title_extra)


if __name__ == "__main__":
    main()
