/**
 * Direct port of beacon_placement.py.
 *
 * Same names, same algorithms, same parameters; tested for byte-identical
 * output against the Python reference impl in app/test/parity.test.ts.
 *
 * Coordinates are everywhere [longitude, latitude] tuples in degrees.
 */

export type LonLat = readonly [number, number];

export const EARTH_RADIUS_FT = 20_902_231.0;
const DEG_TO_FT = (Math.PI / 180.0) * EARTH_RADIUS_FT;

// --------------------------------------------------------------------------- //
// Geo helpers
// --------------------------------------------------------------------------- //

export function haversineFt(p: LonLat, q: LonLat): number {
  const lon1 = (p[0] * Math.PI) / 180;
  const lat1 = (p[1] * Math.PI) / 180;
  const lon2 = (q[0] * Math.PI) / 180;
  const lat2 = (q[1] * Math.PI) / 180;
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.sqrt(a));
}

export function bearingDeg(p: LonLat, q: LonLat): number {
  const lon1 = (p[0] * Math.PI) / 180;
  const lat1 = (p[1] * Math.PI) / 180;
  const lon2 = (q[0] * Math.PI) / 180;
  const lat2 = (q[1] * Math.PI) / 180;
  const dlon = lon2 - lon1;
  const x = Math.sin(dlon) * Math.cos(lat2);
  const y =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export function angleDiffDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// --------------------------------------------------------------------------- //
// Resampling
// --------------------------------------------------------------------------- //

export function resamplePolyline(
  coords: readonly LonLat[],
  stepFt: number,
): LonLat[] {
  if (coords.length < 2) return coords.map((c) => [c[0], c[1]] as LonLat);
  const out: LonLat[] = [[coords[0][0], coords[0][1]]];
  let leftover = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const seg = haversineFt(a, b);
    if (seg === 0) continue;
    let d = stepFt - leftover;
    while (d <= seg) {
      const t = d / seg;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      d += stepFt;
    }
    leftover = seg - (d - stepFt);
  }
  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) {
    out.push([last[0], last[1]]);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Beacon placement (greedy forward walk)
// --------------------------------------------------------------------------- //

export interface BeaconResult {
  beacons: LonLat[];
  samples: LonLat[];
  indices: number[];
}

export function placeBeacons(
  coords: readonly LonLat[],
  angleThresholdDeg = 8.0,
  stepFt = 20.0,
  maxChordFt: number | null = null,
): BeaconResult {
  const samples = resamplePolyline(coords, stepFt);
  if (samples.length < 2) {
    return {
      beacons: samples.map((s) => [s[0], s[1]] as LonLat),
      samples,
      indices: samples.map((_, i) => i),
    };
  }

  const beacons: LonLat[] = [samples[0]];
  const indices: number[] = [0];
  let anchor = 0;
  while (anchor < samples.length - 1) {
    const ref = bearingDeg(samples[anchor], samples[anchor + 1]);
    let nextAnchor = samples.length - 1; // default: jump to the end
    for (let i = anchor + 2; i < samples.length; i++) {
      const cur = bearingDeg(samples[anchor], samples[i]);
      const angleOver = angleDiffDeg(cur, ref) > angleThresholdDeg;
      const chordOver =
        maxChordFt !== null &&
        haversineFt(samples[anchor], samples[i]) > maxChordFt;
      if (angleOver || chordOver) {
        nextAnchor = i - 1;
        break;
      }
    }
    beacons.push(samples[nextAnchor]);
    indices.push(nextAnchor);
    anchor = nextAnchor;
  }
  return { beacons, samples, indices };
}

// --------------------------------------------------------------------------- //
// Drift measurement
// --------------------------------------------------------------------------- //

export function chordDriftFt(
  samples: readonly LonLat[],
  indices: readonly number[],
): number {
  let worst = 0;
  for (let k = 0; k < indices.length - 1; k++) {
    const a = samples[indices[k]];
    const b = samples[indices[k + 1]];
    const lat0 = (((a[1] + b[1]) / 2) * Math.PI) / 180;
    const sx = DEG_TO_FT * Math.cos(lat0);
    const sy = DEG_TO_FT;
    const bx = (b[0] - a[0]) * sx;
    const by = (b[1] - a[1]) * sy;
    const L = Math.hypot(bx, by) || 1.0;
    for (let j = indices[k] + 1; j < indices[k + 1]; j++) {
      const p = samples[j];
      const px = (p[0] - a[0]) * sx;
      const py = (p[1] - a[1]) * sy;
      const d = Math.abs(px * by - py * bx) / L;
      if (d > worst) worst = d;
    }
  }
  return worst;
}

// --------------------------------------------------------------------------- //
// Min-spacing post-process
// --------------------------------------------------------------------------- //

export function enforceMinSpacing(
  result: BeaconResult,
  minSpacingFt: number,
): BeaconResult {
  if (minSpacingFt <= 0 || result.beacons.length <= 2) return result;
  const keep: number[] = [0];
  let last = result.beacons[0];
  for (let i = 1; i < result.beacons.length - 1; i++) {
    if (haversineFt(last, result.beacons[i]) >= minSpacingFt) {
      keep.push(i);
      last = result.beacons[i];
    }
  }
  keep.push(result.beacons.length - 1);
  return {
    beacons: keep.map((i) => result.beacons[i]),
    samples: result.samples,
    indices: keep.map((i) => result.indices[i]),
  };
}

// --------------------------------------------------------------------------- //
// Autotune (Pareto search over angle x max_chord x min_spacing)
// --------------------------------------------------------------------------- //

export interface TuneResult {
  angleDeg: number;
  maxChordFt: number | null;
  minSpacingFt: number | null;
  driftFt: number;
  beaconCount: number;
  result: BeaconResult;
}

export const AUTOTUNE_ANGLES: readonly number[] = [
  1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0, 24.0,
];
export const AUTOTUNE_CAPS: readonly (number | null)[] = [
  60.0, 90.0, 120.0, 150.0, 200.0, 300.0, 500.0, 800.0, 1500.0, null,
];
export const AUTOTUNE_MIN_SPACINGS: readonly (number | null)[] = [
  null, 30.0, 50.0, 65.0, 100.0, 150.0, 200.0, 300.0, 500.0,
];

export interface ParetoOptions {
  stepFt?: number;
  angles?: readonly number[];
  maxChords?: readonly (number | null)[];
  minSpacings?: readonly (number | null)[];
}

export function paretoFrontier(
  coords: readonly LonLat[],
  opts: ParetoOptions = {},
): TuneResult[] {
  const stepFt = opts.stepFt ?? 20.0;
  const angles = opts.angles ?? AUTOTUNE_ANGLES;
  const maxChords = opts.maxChords ?? AUTOTUNE_CAPS;
  const minSpacings = opts.minSpacings ?? AUTOTUNE_MIN_SPACINGS;

  const points: TuneResult[] = [];
  for (const ang of angles) {
    for (const cap of maxChords) {
      const base = placeBeacons(coords, ang, stepFt, cap);
      for (const ms of minSpacings) {
        const r = !ms ? base : enforceMinSpacing(base, ms);
        const d = chordDriftFt(r.samples, r.indices);
        points.push({
          angleDeg: ang,
          maxChordFt: cap,
          minSpacingFt: ms,
          driftFt: d,
          beaconCount: r.beacons.length,
          result: r,
        });
      }
    }
  }
  // Sort by drift ascending; tie-break by beacon count ascending.
  points.sort((a, b) => a.driftFt - b.driftFt || a.beaconCount - b.beaconCount);
  const pareto: TuneResult[] = [];
  let bestB = Infinity;
  for (const p of points) {
    if (p.beaconCount < bestB) {
      pareto.push(p);
      bestB = p.beaconCount;
    }
  }
  return pareto;
}

export interface AutotuneOptions extends ParetoOptions {
  minSpacingFt?: number | null;
}

export function autotune(
  coords: readonly LonLat[],
  maxDriftFt: number,
  opts: AutotuneOptions = {},
): TuneResult {
  const stepFt = opts.stepFt ?? 20.0;
  const paretoOpts: ParetoOptions = {
    stepFt,
    angles: opts.angles,
    maxChords: opts.maxChords,
    minSpacings: opts.minSpacings,
  };
  if (opts.minSpacingFt != null) {
    paretoOpts.minSpacings = [opts.minSpacingFt];
  }
  const points = paretoFrontier(coords, paretoOpts);
  const feasible = points.filter((p) => p.driftFt <= maxDriftFt);
  if (feasible.length > 0) {
    // Tie-breaker: fewer beacons, then larger min-spacing.
    feasible.sort((a, b) => {
      if (a.beaconCount !== b.beaconCount) {
        return a.beaconCount - b.beaconCount;
      }
      return -((a.minSpacingFt ?? 0) - (b.minSpacingFt ?? 0));
    });
    return feasible[0];
  }
  return points.reduce((best, p) => (p.driftFt < best.driftFt ? p : best));
}

// --------------------------------------------------------------------------- //
// Convenience
// --------------------------------------------------------------------------- //

export function polylineLengthFt(coords: readonly LonLat[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversineFt(coords[i], coords[i + 1]);
  }
  return total;
}
