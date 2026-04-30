# Beacon Placement Algorithm

Place the minimum number of beacons along a route polyline (e.g. one returned
from OpenStreetMap) so that the straight chord between any two consecutive
beacons never deviates from the actual route by more than a configurable
angle, with an optional hard cap on chord length to bound physical drift.

A perfectly straight road keeps the same bearing the entire way, so only the
two endpoints get beacons. A curvy road forces the bearing to rotate quickly,
so beacons get planted more often -- in effect we rebuild the curve out of
short straight chords.

## Algorithm

The route is treated as a polyline. We resample it at a fixed step
(default `20 ft`) so the input is represented as evenly spaced reference
points.

1. Plant a beacon at the start. Call it the **anchor**.
2. Take the bearing from the anchor to the next sample -- that's the
   "intended" direction for the chord leaving this beacon.
3. Walk forward through the samples one at a time. For each one, check:
   - has the bearing (anchor -> sample) rotated by more than `--angle`
     from the intended direction?
   - **or** (if `--max-chord` is set) has the chord (anchor -> sample)
     grown longer than the cap?
4. As soon as either condition trips, plant a new beacon at the
   **previous** sample (the last one that was still within tolerance) and
   make it the new anchor.
5. Repeat until the end of the route, then plant a final beacon on the
   destination.

Single forward pass, no backtracking. Each resampled point is examined a
constant number of times across the whole run, so the algorithm is **O(n)**
total in the number of samples (not per beacon planted) and uses O(k)
extra memory for the k beacons it plants.

## Quick start

```bash
pip install -r requirements.txt

python beacon_placement.py                                              # synthetic demo
python beacon_placement.py --angle 5 --step 15                          # tighter
python beacon_placement.py --start=-73.985,40.748 --end=-73.965,40.760  # real OSM (drive)
python beacon_placement.py --profile pedestrian \
        --start=-73.973,40.770 --end=-73.965,40.785                     # walk through Central Park
python beacon_placement.py --profile bicycle  --max-chord 300 \
        --start=-73.973,40.770 --end=-73.965,40.785                     # bike, drift bounded to ~21 ft

python examples.py                                                      # 9-route gallery (synthetic curves)
```

Note the `=` between the flag and a negative longitude -- without it
argparse mistakes `-73.985,...` for another option.

Routing backends (all consume the same OpenStreetMap data):

| profile       | backend                                                          | reaches                                |
| ------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `auto`        | public [OSRM](https://project-osrm.org/) (`router.project-osrm.org`) | drivable roads only                |
| `pedestrian`  | public [Valhalla](https://github.com/valhalla/valhalla) (`valhalla1.openstreetmap.de`) | footways, paths, trails (e.g. Central Park) |
| `bicycle`     | same Valhalla server                                             | cycleways + roads safe for cycling     |

Routed polylines are fed straight into the same `place_beacons()` routine.
No API keys, no extra dependencies (Valhalla's encoded polyline is decoded
in-process).

## Parameters

| flag                | meaning                                                                  | default |
| ------------------- | ------------------------------------------------------------------------ | ------- |
| `--angle`           | max angular drift of any chord (degrees)                                 | `8`     |
| `--step`            | route resampling step (feet)                                             | `20`    |
| `--max-chord`       | optional cap on chord length (feet); splits long straights so the chord cannot drift more than `max_chord * tan(angle)` from the route | none    |
| `--autotune-drift`  | pick `(angle, max-chord, min-spacing)` automatically to keep worst drift ≤ given feet while minimizing beacons / maximizing spacing | --   |
| `--min-spacing`     | pin a hard floor on beacon spacing in feet; if omitted, `--autotune-drift` sweeps it and picks the largest value that still meets the drift budget | none |
| `--pareto`          | print the full `(drift, beacons)` Pareto frontier and exit (no plot)     | off     |
| `--profile`         | `auto` \| `pedestrian` \| `bicycle`                                      | `auto`  |
| `--start`           | route start `lon,lat` for live OSM-routed run                            | --      |
| `--end`             | route end `lon,lat` for live OSM-routed run                              | --      |

Lower `--angle` or smaller `--step` means tighter tracking and more beacons.

### Picking parameters

The angle rule alone bounds chord drift only relative to chord length:

```
worst-case perpendicular drift  ≈  chord_length · tan(angle)
```

So a 4° threshold sounds conservative but allows ~245 ft of drift on a
3,500 ft chord through a long straight. Use `--max-chord` whenever you need
a hard ceiling on physical drift -- e.g. for a "no beacon farther than 25 ft
from the route at 8°" guarantee, set `--max-chord = 25 / tan(8°) ≈ 178`.

Measured on a real Central Park bicycle route:

| settings                          | beacons | longest chord | worst drift |
| --------------------------------- | ------: | ------------: | ----------: |
| `--angle 4` (no cap)              | 58      | 3,797 ft      | 276 ft      |
| `--angle 4 --max-chord 300`       | 74      | 300 ft        | **21 ft**   |
| `--angle 8 --max-chord 300`       | 52      | 300 ft        | 22 ft       |
| `--angle 8 --max-chord 150`       | 79      | 140 ft        | **10 ft**   |

## Autotune

Picking `(angle, max-chord, min-spacing)` by hand is error-prone -- the right
values depend on the route's curvature. `--autotune-drift FT` does a Pareto
sweep over all three knobs and returns the setting with the **fewest
beacons** (equivalently, the **largest min-spacing**) whose worst-case
drift is ≤ the given budget:

```bash
python beacon_placement.py --autotune-drift 25 \
    --profile bicycle --start=-73.973,40.770 --end=-73.965,40.785
# Autotune target   : drift ≤ 25 ft
#   chosen angle    : 4 deg
#   chosen max_chord: 800 ft
#   chosen spacing  : 150 ft (auto)
#   measured drift  : 24.8 ft (OK)
# Beacons planted   : 30
```

If you pass `--min-spacing FT` explicitly, that floor is **pinned** and the
autotune searches only `(angle, max-chord)`. If it can't satisfy both
constraints at once on a curvy route the result is flagged
`BUDGET NOT MET` -- raise `--autotune-drift`, drop `--min-spacing`, or run
`--pareto` to see all options.

`--pareto` prints the full `(drift, beacons, angle, max_chord, min_spacing)`
trade-off table so you can pick a point manually.

## Audio waypoint navigation (Soundscape recipe)

For spatial-audio nav (e.g. the
[Soundscape Community](https://github.com/Soundscape-community) iOS app,
which guides blind users with panning sound), there are two competing
constraints:

* the chord between consecutive beacons must stay inside the **walkable
  corridor**, otherwise the user is being audibly steered off the path;
* beacons shouldn't transition faster than the user can re-acquire
  direction -- the spatial-audio resolution floor is around 20 m and most
  audio-nav UX research recommends one transition every 30 sec or more
  at walking pace.

You only need to set the drift budget. Just pass:

```
--autotune-drift  =  corridor_width_in_feet / 2     # keeps chord inside corridor
```

The autotune **automatically picks the largest min-spacing** the route can
support at that drift level -- so beacon transitions are as infrequent as
the curvature allows.

Examples:

```bash
# 10 ft footpath -- drift budget 5 ft; min-spacing chosen automatically
python beacon_placement.py --autotune-drift 5 \
    --profile pedestrian --start=-73.973,40.770 --end=-73.965,40.785

# 6 ft sidewalk -- drift budget 3 ft
python beacon_placement.py --autotune-drift 3 \
    --profile pedestrian --start=... --end=...

# 15 ft promenade -- drift budget 7.5 ft
python beacon_placement.py --autotune-drift 7.5 \
    --profile pedestrian --start=... --end=...
```

The output will report the chosen min-spacing -- e.g. on a curvy footpath
with a tight 5 ft drift budget, the autotune may report `min_spacing =
none (auto)` because any forced merging exceeds the drift budget. On a
straighter route or with a larger drift budget you'll see `min_spacing =
150 ft (auto)`, dropping beacon count substantially.

If you do want to **pin** the min-spacing (e.g. you want to guarantee at
least one transition per 20 m for UX consistency, even at the cost of
some drift), pass `--min-spacing 65` explicitly. If both budgets can't be
met simultaneously the result is flagged `BUDGET NOT MET` with a hint.

## Examples gallery

Run `python examples.py` for a 3x3 grid showing the algorithm on nine
canonical curve types -- straight, gentle arc, hairpin, S-curve,
sinusoidal, spiral, chicane, mixed road, and a noisy random walk -- so
you can see how beacon density tracks curvature directly. Pass
`--angle` / `--step` to sweep the same grid at different settings, and
`--save gallery.png` to write a copy to disk.

## Public API

```python
from beacon_placement import (place_beacons, fetch_route,
                              autotune, pareto_frontier, enforce_min_spacing)

coords  = fetch_route((-73.973, 40.770), (-73.965, 40.785),
                      profile="pedestrian")            # OSM footpath geometry

# Manual:
result  = place_beacons(coords, angle_threshold_deg=8,
                        step_ft=20, max_chord_ft=300)

# Autotune to a drift budget; min-spacing chosen automatically:
tune    = autotune(coords, max_drift_ft=5, step_ft=20)
result  = tune.result
print(tune.angle_deg, tune.max_chord_ft, tune.min_spacing_ft,
      tune.drift_ft, tune.beacons)

# Or pin min-spacing explicitly (autotune searches angle/max_chord only):
tune    = autotune(coords, max_drift_ft=5, step_ft=20, min_spacing_ft=65)

beacons = result.beacons   # list of (lon, lat) tuples
```
