/**
 * Parity test against the Python reference impl in `beacon_placement.py`.
 *
 * For each `central_park_<slug>.geojson` written by `central_park_demo.py`
 * (most recent run), we read out:
 *   - the raw OSM route polyline (feature[0])
 *   - the autotune parameters that produced this file (top-level properties)
 *   - the beacons the Python autotune chose (feature[1] = chord path)
 *
 * We then run the TypeScript autotune with the same parameters and assert
 * that:
 *   - the TS port chooses identical (angle, cap, min_spacing) tune
 *   - the TS port produces an identical beacon polyline (lon/lat exact)
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  autotune,
  chordDriftFt,
  type LonLat,
  placeBeacons,
} from "../src/lib/beacon";

const REPO_ROOT = join(__dirname, "..", "..");

interface Feature {
  type: "Feature";
  geometry:
    | { type: "LineString"; coordinates: number[][] }
    | { type: "Point"; coordinates: number[] };
  properties: Record<string, unknown>;
}

interface Collection {
  type: "FeatureCollection";
  properties: Record<string, unknown>;
  features: Feature[];
}

function readCollection(path: string): Collection {
  return JSON.parse(readFileSync(path, "utf8")) as Collection;
}

function findGeoJsonFixtures(): string[] {
  return readdirSync(REPO_ROOT)
    .filter(
      (f) =>
        f.startsWith("central_park_") &&
        f.endsWith(".geojson") &&
        f !== "central_park_all.geojson",
    )
    .sort();
}

describe("TS port matches Python reference (central_park_*.geojson)", () => {
  const fixtures = findGeoJsonFixtures();

  if (fixtures.length === 0) {
    it("has at least one fixture file", () => {
      throw new Error(
        "No central_park_*.geojson files found; run python3 central_park_demo.py --export-geojson first.",
      );
    });
    return;
  }

  for (const filename of fixtures) {
    it(`${filename}`, () => {
      const fc = readCollection(join(REPO_ROOT, filename));

      const routeFeat = fc.features[0];
      const chordFeat = fc.features[1];
      if (
        routeFeat.geometry.type !== "LineString" ||
        chordFeat.geometry.type !== "LineString"
      ) {
        throw new Error(`unexpected geometry types in ${filename}`);
      }
      const coords: LonLat[] = routeFeat.geometry.coordinates.map(
        (c) => [c[0], c[1]] as LonLat,
      );
      const expectedBeacons: LonLat[] = chordFeat.geometry.coordinates.map(
        (c) => [c[0], c[1]] as LonLat,
      );

      const driftBudgetFt = fc.properties.drift_budget_ft as number;
      const stepFt = fc.properties.step_ft as number;
      const expectedAngle = fc.properties.angle_deg as number;
      const expectedCap = fc.properties.max_chord_ft as number | null;
      const expectedMs = fc.properties.min_spacing_ft as number | null;

      const tune = autotune(coords, driftBudgetFt, { stepFt });

      expect(tune.angleDeg).toBe(expectedAngle);
      expect(tune.maxChordFt).toBe(expectedCap);
      expect(tune.minSpacingFt).toBe(expectedMs);
      expect(tune.beaconCount).toBe(expectedBeacons.length);

      // Beacon coordinates should match to floating-point precision; the only
      // operations are linear interpolation and a couple of trig calls, both
      // of which are bit-identical between Python's `math` and JS's `Math` on
      // IEEE-754 inputs in practice.
      for (let i = 0; i < expectedBeacons.length; i++) {
        const got = tune.result.beacons[i];
        const want = expectedBeacons[i];
        expect(got[0]).toBeCloseTo(want[0], 9);
        expect(got[1]).toBeCloseTo(want[1], 9);
      }

      // Cross-check the drift the TS port reports lines up with the file.
      const drift = chordDriftFt(tune.result.samples, tune.result.indices);
      expect(drift).toBeCloseTo(fc.properties.drift_ft as number, 1);
    });
  }
});

describe("placeBeacons sanity", () => {
  it("returns endpoints when given a 2-point straight line", () => {
    const r = placeBeacons(
      [
        [-73.985, 40.748],
        [-73.965, 40.76],
      ],
      8,
      20,
    );
    expect(r.beacons[0]).toEqual([-73.985, 40.748]);
    expect(r.beacons[r.beacons.length - 1][0]).toBeCloseTo(-73.965, 6);
    expect(r.beacons[r.beacons.length - 1][1]).toBeCloseTo(40.76, 6);
  });
});
