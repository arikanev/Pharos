/**
 * Reproduces the Pharos app's in-app beacon placement EXACTLY, for the 15
 * start/end routes in tools/routes.json.
 *
 * Pipeline mirrors app/src/Plan.svelte:plan():
 *   1. route   = fetchRoute(start, end, "pedestrian")   // OSRM-foot -> Valhalla fallback
 *   2. tune    = autotune(route.coords, driftFt=5, { stepFt: 20 })
 *   3. beacons = tune.result.beacons                     // [lon, lat] tuples
 *
 * It imports the app's ACTUAL modules (app/src/lib/beacon.ts + routing.ts),
 * so the placed beacons are byte-identical to what the app produces.
 *
 * Requires network egress to the OSM routing backends:
 *   routing.openstreetmap.de   (OSRM foot, primary)
 *   valhalla1.openstreetmap.de (Valhalla pedestrian, fallback)
 *
 * Usage:
 *   node tools/run_beacons.mts              # route + place beacons, writes outputs
 *   node tools/run_beacons.mts --self-test  # synthetic curve, no network
 *
 * (Node 22.18+ strips TS types automatically. On 22.6-22.17 add
 *  --experimental-strip-types.)
 *
 * Outputs (written next to this script, in tools/):
 *   beacons_output.json  full structured result per route
 *   beacons_output.csv   flat rows: route,beacon_index,lat,lon,is_endpoint
 *   beacons_output.txt   human-readable per-route beacon list + summary
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  autotune,
  polylineLengthFt,
  type LonLat,
} from "../app/src/lib/beacon.ts";
import { fetchRoute } from "../app/src/lib/routing.ts";

const DRIFT_FT = 5; // Plan.svelte default ("Maximum drift" slider)
const STEP_FT = 20; // Plan.svelte default
const here = dirname(fileURLToPath(import.meta.url));

interface Route {
  name: string;
  start: LonLat;
  end: LonLat;
}

interface Out {
  name: string;
  start: LonLat;
  end: LonLat;
  backend: string | null;
  routeLenFt: number | null;
  beaconCount: number;
  driftFt: number | null;
  angleDeg: number | null;
  maxChordFt: number | null;
  minSpacingFt: number | null;
  beacons: LonLat[]; // [lon, lat]
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Re-attempt fetchRoute on transient public-server failures. Routing is
 *  deterministic, so retries return identical geometry; this only adds
 *  resilience to 429/timeout, it does not alter the algorithm or output. */
async function routeWithRetry(r: Route, attempts = 3) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchRoute(r.start, r.end, "pedestrian");
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

async function runReal(routes: Route[]): Promise<Out[]> {
  const results: Out[] = [];
  for (const r of routes) {
    try {
      const route = await routeWithRetry(r);
      const tune = autotune(route.coords, DRIFT_FT, { stepFt: STEP_FT });
      results.push({
        name: r.name,
        start: r.start,
        end: r.end,
        backend: route.backend,
        routeLenFt: polylineLengthFt(route.coords),
        beaconCount: tune.beaconCount,
        driftFt: tune.driftFt,
        angleDeg: tune.angleDeg,
        maxChordFt: tune.maxChordFt,
        minSpacingFt: tune.minSpacingFt,
        beacons: tune.result.beacons.map((b) => [b[0], b[1]] as LonLat),
      });
      process.stderr.write(
        `  ok  ${r.name}: ${tune.beaconCount} beacons, ` +
          `drift ${tune.driftFt.toFixed(1)}ft (${route.backend})\n`,
      );
    } catch (err) {
      results.push({
        name: r.name,
        start: r.start,
        end: r.end,
        backend: null,
        routeLenFt: null,
        beaconCount: 0,
        driftFt: null,
        angleDeg: null,
        maxChordFt: null,
        minSpacingFt: null,
        beacons: [],
        error: (err as Error).message,
      });
      process.stderr.write(`  ERR ${r.name}: ${(err as Error).message}\n`);
    }
    await sleep(300); // be polite to the public OSM servers
  }
  return results;
}

function toCsv(rows: Out[]): string {
  const lines = ["route,beacon_index,lat,lon,is_endpoint"];
  for (const o of rows) {
    o.beacons.forEach((b, i) => {
      const endpoint = i === 0 || i === o.beacons.length - 1 ? "1" : "0";
      // b is [lon, lat]; emit lat,lon to match the source sheet's column order.
      lines.push(`"${o.name}",${i},${b[1]},${b[0]},${endpoint}`);
    });
  }
  return lines.join("\n") + "\n";
}

function toTxt(rows: Out[]): string {
  const out: string[] = [];
  out.push("Pharos in-app beacon placement (pedestrian route -> autotune, 5ft drift, 20ft step)");
  out.push("Beacons listed as lat, lon (same order as the source sheet).");
  out.push("=".repeat(78));
  for (const o of rows) {
    out.push("");
    out.push(`### ${o.name}`);
    if (o.error) {
      out.push(`  ERROR: ${o.error}`);
      continue;
    }
    out.push(
      `  route ${Math.round(o.routeLenFt ?? 0)} ft via ${o.backend} | ` +
        `${o.beaconCount} beacons | worst drift ${o.driftFt?.toFixed(1)} ft | ` +
        `angle ${o.angleDeg}°, cap ${o.maxChordFt ?? "none"}, ` +
        `min-spacing ${o.minSpacingFt ?? "none"}`,
    );
    o.beacons.forEach((b, i) => {
      out.push(`  ${String(i + 1).padStart(2)}. ${b[1].toFixed(6)}, ${b[0].toFixed(6)}`);
    });
  }
  out.push("");
  out.push("=".repeat(78));
  const ok = rows.filter((r) => !r.error);
  const total = ok.reduce((s, r) => s + r.beaconCount, 0);
  out.push(
    `Summary: ${ok.length}/${rows.length} routed; ${total} beacons total; ` +
      `mean ${(total / Math.max(ok.length, 1)).toFixed(1)} per route.`,
  );
  return out.join("\n") + "\n";
}

function selfTest() {
  const coords: LonLat[] = [];
  for (let i = 0; i <= 100; i++) {
    coords.push([
      -73.97 + i * 0.0001,
      40.77 + 0.0008 * Math.sin((i / 100) * Math.PI * 2),
    ]);
  }
  const tune = autotune(coords, DRIFT_FT, { stepFt: STEP_FT });
  process.stderr.write(
    `self-test S-curve: len=${polylineLengthFt(coords).toFixed(0)}ft -> ` +
      `${tune.beaconCount} beacons, drift=${tune.driftFt.toFixed(2)}ft, ` +
      `angle=${tune.angleDeg}, cap=${tune.maxChordFt}, minSpacing=${tune.minSpacingFt}\n`,
  );
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const routes: Route[] = JSON.parse(
    await readFile(join(here, "routes.json"), "utf8"),
  );
  process.stderr.write(
    `Routing + placing beacons for ${routes.length} routes ` +
      `(drift=${DRIFT_FT}ft, step=${STEP_FT}ft)...\n`,
  );
  const results = await runReal(routes);

  await writeFile(
    join(here, "beacons_output.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  await writeFile(join(here, "beacons_output.csv"), toCsv(results));
  const txt = toTxt(results);
  await writeFile(join(here, "beacons_output.txt"), txt);

  process.stderr.write("\nWrote beacons_output.{json,csv,txt} to tools/\n\n");
  process.stdout.write(txt);
}

await main();
