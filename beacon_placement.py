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
                  step_ft: float = 20.0,
                  max_chord_ft: float | None = None) -> BeaconResult:
    """Greedy forward walk -- plant a beacon whenever the chord drifts too far.

    From the current anchor we record the bearing to the next sample as the
    intended chord direction.  We then advance one sample at a time; we plant
    a beacon at the previous sample as soon as either:

      * the bearing (anchor -> current sample) has rotated by more than
        ``angle_threshold_deg`` from the intended direction, or
      * (if ``max_chord_ft`` is given) the straight-line distance from the
        anchor to the current sample has grown beyond that cap.

    The angle rule alone allows ``L * tan(theta)`` of perpendicular drift
    on a chord of length ``L`` -- e.g. a 3,500 ft chord at 4 deg can wander
    ~245 ft off the route.  The optional chord-length cap bounds that
    worst-case physical drift directly.
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
            angle_over = angle_diff_deg(cur, ref) > angle_threshold_deg
            chord_over = (max_chord_ft is not None
                          and haversine_ft(samples[anchor],
                                           samples[i]) > max_chord_ft)
            if angle_over or chord_over:
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


_SSL_HINT = (
    "SSL certificate verify failed.\n"
    "Fix with either:\n"
    "  pip install certifi\n"
    "or, on macOS python.org installers, run once:\n"
    "  /Applications/Python\\ 3.11/Install\\ Certificates.command"
)
_USER_AGENT = "beacon_placement.py/0.1 (+demo)"


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


def _http_json(req: "str | urllib.request.Request", timeout: float = 30) -> dict:
    """GET/POST JSON with shared SSL context and a clean SSL error hint."""
    if isinstance(req, str):
        req = urllib.request.Request(req)
    req.add_header("User-Agent", _USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=timeout,
                                    context=_ssl_context()) as resp:
            return json.load(resp)
    except urllib.error.URLError as e:
        if "CERTIFICATE_VERIFY_FAILED" in str(e):
            raise SystemExit(_SSL_HINT) from e
        raise


def _decode_polyline(s: str, precision: int = 6) -> List[LonLat]:
    """Decode a Google-style encoded polyline. Returns (lon, lat) pairs.

    OSRM/Google use precision=5; Valhalla uses precision=6.
    """
    coords: List[LonLat] = []
    factor = float(10 ** precision)
    index = lat = lng = 0
    n = len(s)
    while index < n:
        for which in range(2):
            result, shift = 1, 0
            while True:
                b = ord(s[index]) - 63 - 1
                index += 1
                result += b << shift
                if b < 0x1f:
                    break
                shift += 5
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        coords.append((lng / factor, lat / factor))
    return coords


def osrm_route(start: LonLat, end: LonLat) -> List[LonLat]:
    """Fetch an OSM-backed driving route polyline from the public OSRM router."""
    url = ("https://router.project-osrm.org/route/v1/driving/"
           f"{start[0]},{start[1]};{end[0]},{end[1]}"
           "?overview=full&geometries=geojson")
    data = _http_json(url)
    coords = data["routes"][0]["geometry"]["coordinates"]
    return [(c[0], c[1]) for c in coords]


def valhalla_route(start: LonLat, end: LonLat,
                   costing: str = "pedestrian") -> List[LonLat]:
    """Fetch an OSM-backed route from the public FOSSGIS Valhalla server.

    Supports `costing` values like `pedestrian`, `bicycle`, `auto`,
    `motor_scooter`, `truck`, etc. -- the full Valhalla profile list.
    Pedestrian/bicycle traverse OSM `highway=footway`/`path`/`cycleway`
    that the OSRM driving graph doesn't include.
    """
    body = json.dumps({
        "locations": [
            {"lon": start[0], "lat": start[1]},
            {"lon": end[0], "lat": end[1]},
        ],
        "costing": costing,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://valhalla1.openstreetmap.de/route",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    data = _http_json(req)
    if "trip" not in data or not data["trip"].get("legs"):
        raise SystemExit(
            f"Valhalla error: {data.get('error', data)}"
        )
    coords: List[LonLat] = []
    for leg in data["trip"]["legs"]:
        decoded = _decode_polyline(leg["shape"], precision=6)
        if coords and decoded and coords[-1] == decoded[0]:
            coords.extend(decoded[1:])
        else:
            coords.extend(decoded)
    return coords


# Profile -> (backend function, costing/profile string passed to it).
PROFILES = {
    "auto":       ("osrm",     "driving"),
    "pedestrian": ("valhalla", "pedestrian"),
    "bicycle":    ("valhalla", "bicycle"),
}


def fetch_route(start: LonLat, end: LonLat,
                profile: str = "auto") -> List[LonLat]:
    """Route from start to end using the chosen profile."""
    if profile not in PROFILES:
        raise ValueError(f"unknown profile {profile!r}; "
                         f"choose one of {sorted(PROFILES)}")
    backend, costing = PROFILES[profile]
    if backend == "osrm":
        return osrm_route(start, end)
    return valhalla_route(start, end, costing=costing)


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
    p.add_argument("--max-chord", type=float, default=None,
                   help="optional cap on chord length in feet "
                        "(splits long straights; default: no cap)")
    p.add_argument("--start", metavar="LON,LAT",
                   help="route start coordinate (use with --end to fetch OSM)")
    p.add_argument("--end", metavar="LON,LAT",
                   help="route end coordinate (use with --start to fetch OSM)")
    p.add_argument("--profile", choices=sorted(PROFILES), default="auto",
                   help="routing profile: auto (OSRM), "
                        "pedestrian/bicycle (Valhalla)")
    args = p.parse_args()

    if bool(args.start) ^ bool(args.end):
        p.error("--start and --end must be supplied together")

    if args.start and args.end:
        coords = fetch_route(_parse_lonlat(args.start),
                             _parse_lonlat(args.end),
                             profile=args.profile)
        backend = PROFILES[args.profile][0].upper()
        title_extra = f"OSM via {backend} ({args.profile})"
    else:
        coords = synthetic_route()
        title_extra = "synthetic route"

    result = place_beacons(coords, args.angle, args.step,
                           max_chord_ft=args.max_chord)
    total_ft = sum(haversine_ft(a, b)
                   for a, b in zip(coords[:-1], coords[1:]))
    print(f"Route length      : {total_ft:,.0f} ft")
    print(f"Resampled points  : {len(result.samples)}")
    print(f"Beacons planted   : {len(result.beacons)}")

    plot_result(result, coords, args.angle, args.step, title_extra)


if __name__ == "__main__":
    main()
