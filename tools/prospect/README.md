# Prospect Park — 15 random trips + app beacon outputs

15 randomly selected short pedestrian start-stops on **Prospect Park's interior
walking-path network**, each run through the Pharos app's exact in-app pipeline
(`fetchRoute("pedestrian")` → `autotune`, 5 ft drift / 20 ft step). Produced by
[`tools/gen_prospect_beacons.mts`](../gen_prospect_beacons.mts).

## Two files per trip

| file | contents |
| ---- | -------- |
| `trip_NN_startstop.json` | the start/stop locations — `{ name, start, end }`, coordinates `[lon, lat]` (same schema as `tools/routes.json`) |
| `trip_NN_app_output.json` | the app's outputs — routed polyline (`routeCoords`) + placed `beacons` (both `[lon, lat]`), plus backend, route length, beacon count, worst drift, and the autotuned angle / chord-cap / min-spacing |

`start`/`end` are snapped to the nearest park path, so they are real walkable
locations and re-route to identical geometry. `beacons[0] == start` and
`beacons[last] == end`.

## Aggregates (convenience, mirror `tools/beacons_output.*`)

| file | contents |
| ---- | -------- |
| `prospect_routes.json` | all 15 start-stops (drop-in `routes.json`) |
| `prospect_beacons_output.json` | full structured result per trip |
| `prospect_beacons_output.csv` | flat rows `route,beacon_index,lat,lon,is_endpoint` |
| `prospect_beacons_output.txt` | human-readable per-trip list + summary |

CSV/TXT report **lat, lon**; JSON keeps the app-internal **[lon, lat]**.

## Reproducibility

Selection is seeded (`--seed`, default `20260615`), so re-running reproduces the
identical 15 trips. Routing is deterministic. To regenerate:

```bash
node --experimental-strip-types tools/gen_prospect_beacons.mts
```

All 15 routed via the OSRM-foot backend; worst drift across every trip is
≤ 5 ft (the autotune target), mean 7.6 beacons per trip.
