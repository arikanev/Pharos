# Beacon-placement reproduction harness

Reproduces the Pharos app's **exact** in-app beacon placement for an external
set of start/end routes, so the automated placements can be compared against a
human O&M beacon placer.

## What it does

For each route in `routes.json`, it runs the same pipeline as
`app/src/Plan.svelte:plan()`:

1. `fetchRoute(start, end, "pedestrian")` — OSM pedestrian routing
   (OSRM-foot, with Valhalla pedestrian as fallback), from `app/src/lib/routing.ts`.
2. `autotune(route.coords, driftFt = 5, { stepFt = 20 })` — the app's default
   "Maximum drift" (5 ft) and resample step (20 ft), from `app/src/lib/beacon.ts`.
3. Emits `tune.result.beacons` — the placed beacon `[lon, lat]` list.

It imports the app's **actual** TypeScript modules (no reimplementation), so the
output is identical to what the app produces in-app.

## Requirements

Network egress to the two OSM routing hosts the app uses:

```
routing.openstreetmap.de      (OSRM foot, primary)
valhalla1.openstreetmap.de    (Valhalla pedestrian, fallback)
```

If these are not in the environment's network allowlist, every route fails with
`All routing backends for profile "pedestrian" failed` (the egress proxy returns
`x-deny-reason: host_not_allowed`).

## Run

```bash
node tools/run_beacons.mts            # route + place beacons; writes outputs
node tools/run_beacons.mts --self-test  # synthetic curve sanity check, no network
```

Node 22.18+ strips TS types automatically; on 22.6–22.17 add
`--experimental-strip-types`.

## Outputs (written to `tools/`)

| file                  | contents                                                   |
| --------------------- | ---------------------------------------------------------- |
| `beacons_output.json` | full structured result per route (incl. drift, params)     |
| `beacons_output.csv`  | flat rows `route,beacon_index,lat,lon,is_endpoint`         |
| `beacons_output.txt`  | human-readable per-route beacon list + summary             |

Beacons are reported as **lat, lon** in the `.csv`/`.txt` to match the source
sheet's column order; the `.json` keeps the app-internal `[lon, lat]` order.

## Note on geometry source

The app routes from start→end, so beacons land on OSRM's pedestrian polyline,
which can differ slightly from an actual recorded GPX track. To place beacons on
the *exact* recorded tracks instead, replace each route's `coords` with the GPX
track points and call `autotune(coords, 5, { stepFt: 20 })` directly (same algorithm,
no routing needed).
