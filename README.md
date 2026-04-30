# Beacon Placement Algorithm

Place the minimum number of beacons along a route polyline (e.g. one returned
from OpenStreetMap) so that the straight chord between any two consecutive
beacons never deviates from the actual route by more than a configurable
angle.

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
3. Walk forward through the samples one at a time. For each one, take the
   bearing from the anchor to that sample and compare it to the intended
   direction.
4. As soon as that bearing has rotated by more than the angle threshold,
   plant a new beacon at the **previous** sample (the last one that was
   still within tolerance) and make it the new anchor.
5. Repeat until the end of the route, then plant a final beacon on the
   destination.

Single forward pass, no backtracking, O(n) per beacon planted.

## Quick start

```bash
pip install -r requirements.txt

python beacon_placement.py                                              # synthetic demo
python beacon_placement.py --angle 5 --step 15                          # tighter
python beacon_placement.py --start=-73.985,40.748 --end=-73.965,40.760  # real OSM
```

Note the `=` between the flag and a negative longitude -- without it
argparse mistakes `-73.985,...` for another option.

Supplying `--start` and `--end` calls the public
[OSRM](https://project-osrm.org/) router, which is built directly on
OpenStreetMap road geometry, and feeds the returned polyline straight into
the same placement routine -- no extra dependencies required.

## Parameters

| flag      | meaning                                          | default |
| --------- | ------------------------------------------------ | ------- |
| `--angle` | max angular drift of any chord (degrees)         | `8`     |
| `--step`  | route resampling step (feet)                     | `20`    |
| `--start` | route start `lon,lat` for live OSM-routed run    | --      |
| `--end`   | route end `lon,lat` for live OSM-routed run      | --      |

Lower `--angle` or smaller `--step` means tighter tracking and more beacons.

## Public API

```python
from beacon_placement import place_beacons, osrm_route

coords  = osrm_route((-73.985, 40.748), (-73.965, 40.760))
result  = place_beacons(coords, angle_threshold_deg=8, step_ft=20)
beacons = result.beacons   # list of (lon, lat) tuples
```
