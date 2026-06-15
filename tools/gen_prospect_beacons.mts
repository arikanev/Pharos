/**
 * Generates 15 RANDOM short pedestrian start-stops on Prospect Park's interior
 * walking-path network and runs each through the Pharos app's real pipeline
 * (fetchRoute "pedestrian" -> autotune 5 ft drift / 20 ft step), emitting the
 * two files per trip the lab asked for:
 *
 *   tools/prospect/trip_NN_startstop.json    the start/stop locations (app input)
 *   tools/prospect/trip_NN_app_output.json   the app's routed path + placed beacons
 *
 * ...plus convenience aggregates that mirror tools/run_beacons.mts:
 *
 *   prospect_routes.json           all 15 start-stops (drop-in routes.json shape)
 *   prospect_beacons_output.json   full structured result per trip
 *   prospect_beacons_output.csv    flat rows: route,beacon_index,lat,lon,is_endpoint
 *   prospect_beacons_output.txt    human-readable per-trip list + summary
 *
 * It imports the app's ACTUAL modules (app/src/lib/beacon.ts + routing.ts), so
 * the placed beacons are byte-identical to what the app produces in-app.
 *
 * Selection is SEEDED (--seed, default below) so re-running reproduces the
 * identical 15 trips; OSRM routing is deterministic, so the reported start/stop
 * (snapped to the nearest path) re-route to the same geometry.
 *
 * Requires network egress to the OSM routing backends used by routing.ts:
 *   routing.openstreetmap.de   (OSRM foot, primary)
 *   valhalla1.openstreetmap.de (Valhalla pedestrian, fallback)
 *
 * Usage:
 *   node --experimental-strip-types tools/gen_prospect_beacons.mts
 *   node --experimental-strip-types tools/gen_prospect_beacons.mts --seed 123
 *
 * (Node 22.18+ strips TS types automatically; on 22.6-22.17 the flag is needed.)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  autotune,
  haversineFt,
  polylineLengthFt,
  EARTH_RADIUS_FT,
  type LonLat,
  type TuneResult,
} from "../app/src/lib/beacon.ts";
import { fetchRoute, type RouteResult } from "../app/src/lib/routing.ts";

// --- Tunables --------------------------------------------------------------- //
const N_TRIPS = 15;
const DRIFT_FT = 5; // Plan.svelte default ("Maximum drift")
const STEP_FT = 20; // Plan.svelte default resample step

// Prospect Park interior bbox: kept inside the perimeter streets (Prospect Park
// West / Flatbush / Ocean / Parkside) so random points snap to internal walking
// paths, not the surrounding sidewalks. North edge stays below Grand Army Plaza.
const BBOX = {
  minLon: -73.975,
  maxLon: -73.9655,
  minLat: 40.6565,
  maxLat: 40.6695,
};

// "Short" trips: straight-line target distance, matching the existing dataset.
const DIST_MIN_FT = 100;
const DIST_MAX_FT = 380;

// Acceptance guards.
const SNAP_TOL_FT = 175; // random pick must sit within this of an actual path
const ROUTE_MIN_FT = 70; // reject degenerate routes
const ROUTE_MAX_FT = 900; // keep it "short"
const DETOUR_FACTOR = 3.0; // reject routedLen > 3*straight + slack (T2-style detour)
const DETOUR_SLACK_FT = 120;
const BBOX_MARGIN_DEG = 0.0015; // routed polyline must stay ~within the park (~0.1 mi)
const MAX_ATTEMPTS = 1000;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "prospect");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Seeded RNG (mulberry32) ------------------------------------------------ //
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedArg = process.argv.indexOf("--seed");
const SEED = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 20260615;
const rnd = mulberry32(SEED);
const rndRange = (lo: number, hi: number) => lo + (hi - lo) * rnd();

// --- Geo: forward (destination) point --------------------------------------- //
function destPoint(start: LonLat, brngDeg: number, distFt: number): LonLat {
  const d = distFt / EARTH_RADIUS_FT;
  const th = (brngDeg * Math.PI) / 180;
  const phi1 = (start[1] * Math.PI) / 180;
  const lam1 = (start[0] * Math.PI) / 180;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(th);
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(th) * Math.sin(d) * Math.cos(phi1);
  const x = Math.cos(d) - Math.sin(phi1) * sinPhi2;
  const lam2 = lam1 + Math.atan2(y, x);
  return [(lam2 * 180) / Math.PI, (phi2 * 180) / Math.PI];
}

const inBbox = (p: LonLat, m = 0) =>
  p[0] >= BBOX.minLon - m &&
  p[0] <= BBOX.maxLon + m &&
  p[1] >= BBOX.minLat - m &&
  p[1] <= BBOX.maxLat + m;

// Retry only transient server/network errors; a genuine "no route" (OSRM
// returns code != Ok) is not retried -- we just resample new points.
function isTransient(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  return /HTTP (5\d\d|429)/.test(m) || /abort|timeout|fetch failed|ECONN/i.test(m);
}

async function tryRoute(s: LonLat, e: LonLat): Promise<RouteResult | null> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchRoute(s, e, "pedestrian");
    } catch (err) {
      if (isTransient(err) && i < 2) {
        await sleep(800 * 2 ** i);
        continue;
      }
      return null; // no route (or persistent failure) -> reject this candidate
    }
  }
  return null;
}

interface Trip {
  name: string;
  start: LonLat; // snapped to nearest path (== route.coords[0])
  end: LonLat; //   snapped to nearest path (== route.coords[last])
  route: RouteResult;
  routeLenFt: number;
  straightFt: number;
  tune: TuneResult;
}

async function generate(): Promise<Trip[]> {
  const trips: Trip[] = [];
  let attempts = 0;
  process.stderr.write(
    `Generating ${N_TRIPS} interior Prospect Park trips ` +
      `(seed=${SEED}, ${DIST_MIN_FT}-${DIST_MAX_FT} ft straight-line, ` +
      `drift=${DRIFT_FT}ft, step=${STEP_FT}ft)...\n`,
  );
  while (trips.length < N_TRIPS && attempts < MAX_ATTEMPTS) {
    attempts++;
    const rawStart: LonLat = [
      rndRange(BBOX.minLon, BBOX.maxLon),
      rndRange(BBOX.minLat, BBOX.maxLat),
    ];
    const rawEnd = destPoint(rawStart, rndRange(0, 360), rndRange(DIST_MIN_FT, DIST_MAX_FT));
    if (!inBbox(rawEnd)) continue; // keep both ends in-park (no network cost)

    const route = await tryRoute(rawStart, rawEnd);
    await sleep(300); // be polite to the public OSM servers
    if (!route || route.coords.length < 2) continue;

    // The random pick must sit near an actual path (interior path density).
    const snapS = haversineFt(rawStart, route.coords[0]);
    const snapE = haversineFt(rawEnd, route.coords[route.coords.length - 1]);
    if (snapS > SNAP_TOL_FT || snapE > SNAP_TOL_FT) continue;

    // Report the snapped on-path endpoints as the official start/stop: they are
    // real walkable locations and re-route to identical geometry.
    const start = route.coords[0];
    const end = route.coords[route.coords.length - 1];
    const routeLenFt = polylineLengthFt(route.coords);
    const straightFt = haversineFt(start, end);
    if (routeLenFt < ROUTE_MIN_FT || routeLenFt > ROUTE_MAX_FT) continue;
    if (routeLenFt > DETOUR_FACTOR * straightFt + DETOUR_SLACK_FT) continue; // detour artifact
    if (!route.coords.every((c) => inBbox(c, BBOX_MARGIN_DEG))) continue; // stays in the park

    const tune = autotune(route.coords, DRIFT_FT, { stepFt: STEP_FT });
    const name = `Prospect Park Trip ${String(trips.length + 1).padStart(2, "0")}`;
    trips.push({ name, start, end, route, routeLenFt, straightFt, tune });
    process.stderr.write(
      `  ok  ${name}: ${Math.round(routeLenFt)} ft route, ` +
        `${tune.beaconCount} beacons, drift ${tune.driftFt.toFixed(1)} ft ` +
        `(${route.backend}; snap ${snapS.toFixed(0)}/${snapE.toFixed(0)} ft; attempt ${attempts})\n`,
    );
  }
  if (trips.length < N_TRIPS) {
    process.stderr.write(
      `WARNING: only ${trips.length}/${N_TRIPS} trips after ${attempts} attempts ` +
        `(loosen SNAP_TOL_FT / widen BBOX / raise MAX_ATTEMPTS).\n`,
    );
  } else {
    process.stderr.write(`Collected ${N_TRIPS} trips in ${attempts} attempts.\n`);
  }
  return trips;
}

// --- Output shapes ---------------------------------------------------------- //
function startStop(t: Trip) {
  // Same schema as tools/routes.json: coordinates are [lon, lat].
  return { name: t.name, start: t.start, end: t.end };
}

function appOutput(t: Trip) {
  return {
    name: t.name,
    backend: t.route.backend,
    routeLenFt: t.routeLenFt,
    straightLineFt: t.straightFt,
    osrmDistanceFt: t.route.distanceFt,
    beaconCount: t.tune.beaconCount,
    driftFt: t.tune.driftFt,
    angleDeg: t.tune.angleDeg,
    maxChordFt: t.tune.maxChordFt,
    minSpacingFt: t.tune.minSpacingFt,
    beacons: t.tune.result.beacons.map((b) => [b[0], b[1]] as LonLat), // [lon, lat]
    routeCoords: t.route.coords.map((c) => [c[0], c[1]] as LonLat), // routed polyline [lon, lat]
  };
}

function toCsv(trips: Trip[]): string {
  const lines = ["route,beacon_index,lat,lon,is_endpoint"];
  for (const t of trips) {
    const bs = t.tune.result.beacons;
    bs.forEach((b, i) => {
      const endpoint = i === 0 || i === bs.length - 1 ? "1" : "0";
      // b is [lon, lat]; emit lat,lon to match the source sheet's column order.
      lines.push(`"${t.name}",${i},${b[1]},${b[0]},${endpoint}`);
    });
  }
  return lines.join("\n") + "\n";
}

function toTxt(trips: Trip[]): string {
  const out: string[] = [];
  out.push("Pharos in-app beacon placement -- 15 random interior Prospect Park trips");
  out.push(
    `(pedestrian route -> autotune, ${DRIFT_FT} ft drift, ${STEP_FT} ft step; seed ${SEED})`,
  );
  out.push("Start/stop and beacons listed as lat, lon (same order as the source sheet).");
  out.push("=".repeat(78));
  for (const t of trips) {
    const b = t.tune;
    out.push("");
    out.push(`### ${t.name}`);
    out.push(
      `  start ${t.start[1].toFixed(6)}, ${t.start[0].toFixed(6)}  ->  ` +
        `end ${t.end[1].toFixed(6)}, ${t.end[0].toFixed(6)}  ` +
        `(straight ${Math.round(t.straightFt)} ft)`,
    );
    out.push(
      `  route ${Math.round(t.routeLenFt)} ft via ${t.route.backend} | ` +
        `${b.beaconCount} beacons | worst drift ${b.driftFt.toFixed(1)} ft | ` +
        `angle ${b.angleDeg}°, cap ${b.maxChordFt ?? "none"}, ` +
        `min-spacing ${b.minSpacingFt ?? "none"}`,
    );
    b.result.beacons.forEach((bc, i) => {
      out.push(`  ${String(i + 1).padStart(2)}. ${bc[1].toFixed(6)}, ${bc[0].toFixed(6)}`);
    });
  }
  out.push("");
  out.push("=".repeat(78));
  const total = trips.reduce((s, t) => s + t.tune.beaconCount, 0);
  out.push(
    `Summary: ${trips.length} trips; ${total} beacons total; ` +
      `mean ${(total / Math.max(trips.length, 1)).toFixed(1)} per trip.`,
  );
  return out.join("\n") + "\n";
}

async function main() {
  const trips = await generate();
  await mkdir(outDir, { recursive: true });

  // Per-trip: the two files the lab asked for.
  for (let i = 0; i < trips.length; i++) {
    const nn = String(i + 1).padStart(2, "0");
    await writeFile(
      join(outDir, `trip_${nn}_startstop.json`),
      JSON.stringify(startStop(trips[i]), null, 2) + "\n",
    );
    await writeFile(
      join(outDir, `trip_${nn}_app_output.json`),
      JSON.stringify(appOutput(trips[i]), null, 2) + "\n",
    );
  }

  // Aggregates (mirror tools/run_beacons.mts so they're directly comparable).
  await writeFile(
    join(outDir, "prospect_routes.json"),
    JSON.stringify(trips.map(startStop), null, 2) + "\n",
  );
  await writeFile(
    join(outDir, "prospect_beacons_output.json"),
    JSON.stringify(trips.map(appOutput), null, 2) + "\n",
  );
  await writeFile(join(outDir, "prospect_beacons_output.csv"), toCsv(trips));
  const txt = toTxt(trips);
  await writeFile(join(outDir, "prospect_beacons_output.txt"), txt);

  process.stderr.write(
    `\nWrote ${trips.length * 2} per-trip files + 4 aggregates to tools/prospect/\n\n`,
  );
  process.stdout.write(txt);
}

await main();
