#!/usr/bin/env python3
"""Minimal-beacon placement on a route polyline.

Run as a script for a self-contained matplotlib demo:

    python beacon_placement.py                                            # synthetic
    python beacon_placement.py --angle 5 --step 15                        # tighter
    python beacon_placement.py --start=-73.985,40.748 --end=-73.965,40.760  # real OSM

The algorithm is a greedy forward walk; see ALGORITHM.md for a description.
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
# Autotune (Pareto search over angle x max_chord)
# --------------------------------------------------------------------------- #

# 1 deg of latitude in feet (constant) and 1 deg of longitude at given latitude.
_DEG_TO_FT = math.pi / 180.0 * EARTH_RADIUS_FT


def chord_drift_ft(samples: Sequence[LonLat],
                   indices: Sequence[int]) -> float:
    """Worst perpendicular distance (ft) of any sample from its chord.

    Uses a local equirectangular projection per chord; accurate to <1% over
    chords below a few miles, which is fine for any walking route.
    """
    worst = 0.0
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
            if d > worst:
                worst = d
    return worst


@dataclass
class TuneResult:
    angle_deg: float
    max_chord_ft: float | None
    min_spacing_ft: float | None
    drift_ft: float
    beacons: int
    result: BeaconResult


_AUTOTUNE_ANGLES: Tuple[float, ...] = (1.0, 2.0, 3.0, 4.0, 6.0, 8.0,
                                       12.0, 16.0, 24.0)
_AUTOTUNE_CAPS: Tuple[float | None, ...] = (60.0, 90.0, 120.0, 150.0, 200.0,
                                            300.0, 500.0, 800.0, 1500.0, None)
_AUTOTUNE_MIN_SPACINGS: Tuple[float | None, ...] = (None, 30.0, 50.0, 65.0,
                                                    100.0, 150.0, 200.0,
                                                    300.0, 500.0)


def pareto_frontier(coords: Sequence[LonLat],
                    step_ft: float = 20.0,
                    angles: Sequence[float] = _AUTOTUNE_ANGLES,
                    max_chords: Sequence[float | None] = _AUTOTUNE_CAPS,
                    min_spacings: Sequence[float | None] = _AUTOTUNE_MIN_SPACINGS,
                    ) -> List[TuneResult]:
    """Sweep (angle, max_chord, min_spacing) and return Pareto-optimal points.

    For each (angle, max_chord) we run ``place_beacons`` once and then apply
    every candidate ``min_spacing`` as a post-process -- merging adjacent
    beacons increases chord lengths and therefore drift, so we re-measure
    after merging.  A point is on the frontier if no other point has both
    fewer beacons AND less drift.  Returned list is sorted by drift
    (ascending) and, equivalently, by beacon count (descending).
    """
    points: List[TuneResult] = []
    for ang in angles:
        for cap in max_chords:
            base = place_beacons(coords, ang, step_ft, max_chord_ft=cap)
            for ms in min_spacings:
                r = base if not ms else enforce_min_spacing(base, ms)
                d = chord_drift_ft(r.samples, r.indices)
                points.append(TuneResult(ang, cap, ms, d,
                                         len(r.beacons), r))
    points.sort(key=lambda p: (p.drift_ft, p.beacons))
    pareto: List[TuneResult] = []
    best_b = float("inf")
    for p in points:
        if p.beacons < best_b:
            pareto.append(p)
            best_b = p.beacons
    return pareto


def autotune(coords: Sequence[LonLat],
             max_drift_ft: float,
             step_ft: float = 20.0,
             min_spacing_ft: float | None = None,
             **kw) -> TuneResult:
    """Pick the Pareto-optimal setting that meets a worst-drift budget.

    If ``min_spacing_ft`` is given, that floor is fixed and the search
    runs over ``(angle, max_chord)`` only.  Otherwise the search also
    sweeps the min-spacing dimension and the chosen result reports the
    **largest** min-spacing that still kept drift inside the budget --
    i.e. the fewest beacons (and therefore fewest audio transitions) the
    route can support at that drift level.  If no setting meets the
    budget, returns the tightest one we tried.
    """
    if min_spacing_ft is not None:
        kw["min_spacings"] = (min_spacing_ft,)
    points = pareto_frontier(coords, step_ft, **kw)
    feasible = [p for p in points if p.drift_ft <= max_drift_ft]
    if feasible:
        # tie-breaker: larger min-spacing is friendlier for audio nav
        return min(feasible,
                   key=lambda p: (p.beacons, -(p.min_spacing_ft or 0.0)))
    return min(points, key=lambda p: p.drift_ft)


def enforce_min_spacing(result: BeaconResult,
                        min_spacing_ft: float) -> BeaconResult:
    """Drop intermediate beacons closer than ``min_spacing_ft`` to the
    previous kept beacon; endpoints are always retained.

    Useful for audio waypoint navigation, where two beacons closer than the
    spatial-audio resolution floor cause useless / disorienting transitions.
    """
    if min_spacing_ft <= 0 or len(result.beacons) <= 2:
        return result
    keep = [0]
    last = result.beacons[0]
    for i in range(1, len(result.beacons) - 1):
        if haversine_ft(last, result.beacons[i]) >= min_spacing_ft:
            keep.append(i)
            last = result.beacons[i]
    keep.append(len(result.beacons) - 1)
    return BeaconResult(
        beacons=[result.beacons[i] for i in keep],
        samples=result.samples,
        indices=[result.indices[i] for i in keep],
    )


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


def _http_json(req: "str | urllib.request.Request", timeout: float = 10) -> dict:
    """GET/POST JSON with shared SSL context and a clean SSL error hint.

    Default timeout is intentionally short (10s): the public OSM routing
    endpoints either respond in well under a second or are unreachable;
    waiting 30s+ on a stalled TCP connect is just wasted time when we have
    a fallback backend ready to try next.
    """
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


# OSRM endpoints. `driving` lives on the project-osrm demo; `foot`/`bike`
# live on the FOSSGIS-hosted `routing.openstreetmap.de` mirrors and -- unlike
# Valhalla's public demo -- have been reliably available, so we use them as
# the primary pedestrian/bicycle backend.
_OSRM_ENDPOINTS = {
    "driving": "https://router.project-osrm.org/route/v1/driving",
    "foot":    "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
    "bike":    "https://routing.openstreetmap.de/routed-bike/route/v1/bike",
}


def osrm_route(start: LonLat, end: LonLat,
               profile: str = "driving") -> List[LonLat]:
    """Fetch an OSM-backed route polyline from a public OSRM mirror.

    `profile` is one of `driving`, `foot`, `bike`. `foot` and `bike` traverse
    OSM `highway=footway`/`path`/`cycleway`, which the driving graph does not
    include.
    """
    if profile not in _OSRM_ENDPOINTS:
        raise ValueError(f"unknown OSRM profile {profile!r}; "
                         f"choose one of {sorted(_OSRM_ENDPOINTS)}")
    url = (f"{_OSRM_ENDPOINTS[profile]}/"
           f"{start[0]},{start[1]};{end[0]},{end[1]}"
           "?overview=full&geometries=geojson")
    data = _http_json(url)
    if data.get("code") != "Ok" or not data.get("routes"):
        raise SystemExit(f"OSRM error: {data.get('message', data)}")
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


# Profile -> ordered fallback chain of (backend, profile-arg) attempts.
# We try the most reliable backend first and fall back to alternatives if
# it errors or times out -- so a single dead public server doesn't block
# the whole pipeline.
PROFILES = {
    "auto":       [("osrm", "driving")],
    "pedestrian": [("osrm", "foot"), ("valhalla", "pedestrian")],
    "bicycle":    [("osrm", "bike"), ("valhalla", "bicycle")],
}


def fetch_route(start: LonLat, end: LonLat,
                profile: str = "auto") -> List[LonLat]:
    """Route from start to end using the chosen profile.

    Walks the backend fallback chain for the profile and returns the first
    successful result. Raises the last error if every backend fails.
    """
    if profile not in PROFILES:
        raise ValueError(f"unknown profile {profile!r}; "
                         f"choose one of {sorted(PROFILES)}")
    last_err: Exception | None = None
    for backend, arg in PROFILES[profile]:
        try:
            if backend == "osrm":
                return osrm_route(start, end, profile=arg)
            return valhalla_route(start, end, costing=arg)
        except (urllib.error.URLError, TimeoutError, SystemExit) as e:
            last_err = e
            continue
    raise SystemExit(
        f"All routing backends for profile {profile!r} failed; "
        f"last error: {last_err}"
    )


# --------------------------------------------------------------------------- #
# GeoJSON export
# --------------------------------------------------------------------------- #

def to_geojson(result: BeaconResult,
               raw_coords: Sequence[LonLat],
               *,
               name: str | None = None,
               profile: str | None = None,
               drift_ft: float | None = None,
               extra_properties: dict | None = None) -> dict:
    """Build a GeoJSON FeatureCollection of the route, chord path and beacons.

    The collection is renderable as-is on geojson.io / kepler.gl: the OSM
    route is a grey LineString, the beacon chord path is a red LineString,
    each beacon is a small red Point with its sequence index, and the start
    and end are larger green/blue Points. Properties use the [simplestyle][]
    spec so geojson.io picks up colors without any manual styling.

    [simplestyle]: https://github.com/mapbox/simplestyle-spec
    """
    route_length_ft = sum(haversine_ft(a, b)
                          for a, b in zip(raw_coords[:-1], raw_coords[1:]))
    chord_length_ft = sum(haversine_ft(a, b)
                          for a, b in zip(result.beacons[:-1],
                                          result.beacons[1:]))

    top_props: dict = {"feature_count": 2 + len(result.beacons)}
    if name is not None:
        top_props["name"] = name
    if profile is not None:
        top_props["profile"] = profile
    if drift_ft is not None:
        top_props["drift_ft"] = round(drift_ft, 2)
    if extra_properties:
        top_props.update(extra_properties)

    features: List[dict] = [
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [list(c) for c in raw_coords],
            },
            "properties": {
                "role": "route",
                "profile": profile,
                "length_ft": round(route_length_ft, 1),
                "stroke": "#888888",
                "stroke-width": 3,
                "stroke-opacity": 0.9,
            },
        },
        {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [list(b) for b in result.beacons],
            },
            "properties": {
                "role": "chord_path",
                "beacon_count": len(result.beacons),
                "length_ft": round(chord_length_ft, 1),
                "drift_ft": (None if drift_ft is None
                             else round(drift_ft, 2)),
                "stroke": "#d62728",
                "stroke-width": 2,
                "stroke-opacity": 0.95,
            },
        },
    ]

    n = len(result.beacons)
    for i, beacon in enumerate(result.beacons):
        if i == 0:
            role, color, size, symbol = "start", "#2ca02c", "large", "a"
        elif i == n - 1:
            role, color, size, symbol = "end", "#1f77b4", "large", "b"
        else:
            role, color, size, symbol = "beacon", "#d62728", "small", "circle"
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [beacon[0], beacon[1]],
            },
            "properties": {
                "role": role,
                "index": i,
                "sequence": f"{i}/{n - 1}",
                "marker-color": color,
                "marker-size": size,
                "marker-symbol": symbol,
            },
        })

    return {
        "type": "FeatureCollection",
        "properties": top_props,
        "features": features,
    }


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
    p.add_argument("--autotune-drift", type=float, default=None,
                   metavar="FT",
                   help="pick (angle, max_chord) automatically to keep "
                        "worst-case perpendicular drift below this many feet "
                        "while minimizing beacon count "
                        "(audio-nav recipe: drift = corridor_width / 2)")
    p.add_argument("--min-spacing", type=float, default=None, metavar="FT",
                   help="post-process: drop beacons closer than this many "
                        "feet to the previous kept beacon (endpoints always "
                        "kept; ~65 ft / 20 m for spatial-audio nav)")
    p.add_argument("--pareto", action="store_true",
                   help="print the Pareto frontier of (drift, beacons) for "
                        "the route and exit (no plot)")
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

    total_ft = sum(haversine_ft(a, b)
                   for a, b in zip(coords[:-1], coords[1:]))

    drift_budget = args.autotune_drift
    min_spacing = args.min_spacing

    pareto_kw: dict = {}
    if min_spacing is not None:
        pareto_kw["min_spacings"] = (min_spacing,)

    if args.pareto:
        points = pareto_frontier(coords, args.step, **pareto_kw)
        print(f"Route length      : {total_ft:,.0f} ft"
              + (f"  |  min_spacing pinned to {min_spacing:g} ft"
                 if min_spacing else "  |  min_spacing swept"))
        print(f"Pareto frontier (lower drift => more beacons):")
        print(f"  {'drift_ft':>9}  {'beacons':>8}  {'angle':>5}  "
              f"{'max_chord':>10}  {'min_spacing':>11}  {'avg_spacing':>11}")
        for tp in points:
            cap = "none" if tp.max_chord_ft is None else f"{tp.max_chord_ft:.0f}"
            ms = "none" if tp.min_spacing_ft is None else f"{tp.min_spacing_ft:.0f}"
            spacing = total_ft / max(tp.beacons - 1, 1)
            print(f"  {tp.drift_ft:>9.1f}  {tp.beacons:>8}  "
                  f"{tp.angle_deg:>5g}  {cap:>10}  {ms:>11}  "
                  f"{spacing:>11,.0f}")
        return

    if drift_budget is not None:
        chosen = autotune(coords, max_drift_ft=drift_budget,
                          step_ft=args.step,
                          min_spacing_ft=min_spacing)
        result = chosen.result
        cap_str = ("none" if chosen.max_chord_ft is None
                   else f"{chosen.max_chord_ft:.0f} ft")
        ms_str = ("none" if chosen.min_spacing_ft is None
                  else f"{chosen.min_spacing_ft:.0f} ft")
        met = chosen.drift_ft <= drift_budget
        ms_picked = "(pinned)" if min_spacing is not None else "(auto)"
        title_extra += (f" | autotune drift\u2264{drift_budget:g}ft "
                        f"(angle={chosen.angle_deg:g}, max_chord={cap_str}, "
                        f"min_spacing={ms_str})")
        print(f"Autotune target   : drift \u2264 {drift_budget:g} ft")
        print(f"  chosen angle    : {chosen.angle_deg:g}deg")
        print(f"  chosen max_chord: {cap_str}")
        print(f"  chosen spacing  : {ms_str} {ms_picked}")
        print(f"  measured drift  : {chosen.drift_ft:.1f} ft "
              f"({'OK' if met else 'BUDGET NOT MET'})")
        if not met:
            hint = ("  hint            : raise --autotune-drift "
                    "or run --pareto to see all options")
            print(hint)
    else:
        result = place_beacons(coords, args.angle, args.step,
                               max_chord_ft=args.max_chord)
        if min_spacing is not None:
            before = len(result.beacons)
            result = enforce_min_spacing(result, min_spacing)
            print(f"Min-spacing      : {min_spacing:g} ft "
                  f"({before} -> {len(result.beacons)} beacons)")

    print(f"Route length      : {total_ft:,.0f} ft")
    print(f"Resampled points  : {len(result.samples)}")
    print(f"Beacons planted   : {len(result.beacons)}")
    if len(result.beacons) >= 2:
        print(f"Avg beacon spacing: "
              f"{total_ft / (len(result.beacons) - 1):,.0f} ft")

    plot_result(result, coords, args.angle, args.step, title_extra)


if __name__ == "__main__":
    main()
