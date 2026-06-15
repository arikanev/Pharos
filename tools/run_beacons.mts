/**
 * Reproduces the Pharos app's in-app beacon placement EXACTLY.
 *
 * Pipeline mirrors Plan.svelte:plan():
 *   1. route  = fetchRoute(start, end, "pedestrian")   // OSRM-foot -> Valhalla fallback
 *   2. tune   = autotune(route.coords, driftFt=5, { stepFt: 20 })
 *   3. beacons = tune.result.beacons                    // [lon, lat] tuples
 *
 * Imports the app's actual modules so output is byte-identical to the app.
 *
 * Usage:
 *   node tools/run_beacons.mts            # real routing (needs network egress)
 *   node tools/run_beacons.mts --self-test  # synthetic curve, no network
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { autotune, polylineLengthFt, type LonLat } from "../app/src/lib/beacon.ts";
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
  backend?: string;
  routeLenFt?: number;
  beaconCount: number;
  driftFt: number;
  angleDeg: number;
  maxChordFt: number | null;
  minSpacingFt: number | null;
  beacons: LonLat[]; // [lon, lat]
  error?: string;
}

async function runReal(routes: Route[]): Promise<Out[]> {
  const results: Out[] = [];
  for (const r of routes) {
    try {
      const route = await fetchRoute(r.start, r.end, "pedestrian");
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
      process.stderr.write(`  ok  ${r.name}: ${tune.beaconCount} beacons (${route.backend})\n`);
    } catch (err) {
      results.push({
        name: r.name,
        start: r.start,
        end: r.end,
        beaconCount: 0,
        driftFt: NaN,
        angleDeg: NaN,
        maxChordFt: null,
        minSpacingFt: null,
        beacons: [],
        error: (err as Error).message,
      });
      process.stderr.write(`  ERR ${r.name}: ${(err as Error).message}\n`);
    }
  }
  return results;
}

function selfTest() {
  // Synthetic S-curve to prove the algorithm harness works without network.
  const coords: LonLat[] = [];
  for (let i = 0; i <= 100; i++) {
    const lon = -73.97 + i * 0.0001;
    const lat = 40.77 + 0.0008 * Math.sin((i / 100) * Math.PI * 2);
    coords.push([lon, lat]);
  }
  const tune = autotune(coords, DRIFT_FT, { stepFt: STEP_FT });
  process.stderr.write(
    `self-test S-curve: len=${polylineLengthFt(coords).toFixed(0)}ft -> ` +
      `${tune.beaconCount} beacons, drift=${tune.driftFt.toFixed(2)}ft, ` +
      `angle=${tune.angleDeg}, cap=${tune.maxChordFt}, minSpacing=${tune.minSpacingFt}\n`,
  );
  process.stderr.write(`first 3 beacons: ${JSON.stringify(tune.result.beacons.slice(0, 3))}\n`);
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const routes: Route[] = JSON.parse(
    await readFile(join(here, "routes.json"), "utf8"),
  );
  process.stderr.write(`Routing + placing beacons for ${routes.length} routes...\n`);
  const results = await runReal(routes);
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}

await main();
