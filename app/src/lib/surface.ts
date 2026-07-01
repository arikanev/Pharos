/**
 * OSM-sourced paved/unpaved surface labels for the planned route.
 *
 * Routers (OSRM, Valhalla) return only the polyline; they don't surface the
 * `surface=*` tag of the ways they traversed. So — exactly like crossings.ts —
 * after planning we run a separate Overpass query for the footpath ways near
 * the route, match each route segment to the nearest one, and read its
 * `surface` tag. The result is a per-segment paved / unpaved / unknown label
 * that the UI can use to (a) warn about unpaved stretches or (b) drive a
 * user-selectable surface filter when ranking alternative routes.
 *
 * This is "tier 1": map data only. The ~2/3 of footways with no `surface`
 * tag come back `unknown` — backfilling those from aerial imagery is tier 2.
 *
 * Caveats:
 *   - Public Overpass instances are rate-limited; cache by trip, never poll.
 *   - `unknown` means "OSM has no surface tag here", NOT "no path". Treat it
 *     as missing data, not as paved or unpaved.
 *   - A route segment is matched to the single nearest footpath way. Where a
 *     path of a different surface runs parallel within the match buffer the
 *     label can be wrong; this is an inherent map-matching limitation.
 */

import { type LonLat } from "./beacon";
import {
  cumulativePolylineLengthsFt,
  projectPointOntoPolylineFt,
} from "./crossings";

export type SurfaceClass = "paved" | "unpaved" | "unknown";

export interface SurfaceSegment {
  /** Route-coord index at the start / end of this segment. */
  fromIdx: number;
  toIdx: number;
  /** Cumulative distance from route start to each endpoint. */
  startFt: number;
  endFt: number;
  lengthFt: number;
  surface: SurfaceClass;
  /** Raw OSM `surface` value of the matched way, or null when unmatched. */
  rawValue: string | null;
  /** Perpendicular distance from the segment midpoint to the matched way (debug). */
  offRouteFt: number;
}

export interface SurfaceSummary {
  totalFt: number;
  pavedFt: number;
  unpavedFt: number;
  unknownFt: number;
  /** Unpaved share of the *classified* length (paved + unpaved); 0 when nothing classified. */
  unpavedFraction: number;
  /** Share of total length with no surface data. */
  unknownFraction: number;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_TIMEOUT_MS = 8000;
// Looser than crossings' 6 m: the route is derived from these same ways, but
// OSRM/Valhalla geometry is simplified/snapped, so the route centerline can
// drift several metres off the OSM way it followed. 8 m reliably re-associates
// the segment with its underlying way without usually grabbing a parallel path.
const DEFAULT_MATCH_BUFFER_M = 8;
const DEG_PAD_PER_M = 1 / 111_320; // bbox padding in degrees per metre

// `surface` is classified by value membership — there is no boolean tag.
// Values per the OSM wiki (Key:surface) + taginfo's common distribution.
// Anything not listed (incl. the rare/typo long tail) falls through to unknown.
const PAVED_VALUES = new Set<string>([
  "paved",
  "asphalt",
  "concrete",
  "concrete:plates",
  "concrete:lanes",
  "paving_stones",
  "sett",
  "cobblestone",
  "unhewn_cobblestone",
  "chipseal",
  "metal",
  "wood",
]);
const UNPAVED_VALUES = new Set<string>([
  "unpaved",
  "compacted",
  "fine_gravel",
  "gravel",
  "pebblestone",
  "rock",
  "ground",
  "dirt",
  "earth",
  "grass",
  "grass_paver",
  "mud",
  "sand",
  "woodchips",
  "snow",
  "ice",
]);

/** Map a raw OSM `surface` value to paved / unpaved / unknown. */
export function classifySurfaceValue(value: string | undefined): SurfaceClass {
  if (value == null) return "unknown";
  const v = value.trim().toLowerCase();
  if (PAVED_VALUES.has(v)) return "paved";
  if (UNPAVED_VALUES.has(v)) return "unpaved";
  return "unknown";
}

export interface FetchSurfacesOptions {
  overpassUrl?: string;
  timeoutMs?: number;
  /** Max perpendicular distance from a route segment to a way to count as a match (metres). */
  matchBufferM?: number;
}

/**
 * Query Overpass for footpath ways near `routeCoords` and label every route
 * segment paved / unpaved / unknown by matching it to the nearest way.
 *
 * Errors (network, timeout, parse) are swallowed and return []; surface
 * labelling is best-effort and must never block route planning.
 */
export async function fetchSurfaces(
  routeCoords: readonly LonLat[],
  opts: FetchSurfacesOptions = {},
): Promise<SurfaceSegment[]> {
  if (routeCoords.length < 2) return [];

  const url = opts.overpassUrl ?? DEFAULT_OVERPASS_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const matchBufferM = opts.matchBufferM ?? DEFAULT_MATCH_BUFFER_M;

  const bbox = boundingBox(routeCoords, matchBufferM * 2);
  const query = buildQuery(bbox);

  let elements: OverpassElement[];
  try {
    const res = await fetchWithTimeout(url, query, timeoutMs);
    if (!res.ok) {
      console.warn(
        `[surface] Overpass returned HTTP ${res.status} ${res.statusText}`,
        { url, bbox },
      );
      return [];
    }
    const data = (await res.json()) as OverpassResponse;
    elements = data.elements ?? [];
    console.info(
      `[surface] Overpass returned ${elements.length} raw elements`,
      { url, bbox, routeCoordCount: routeCoords.length },
    );
  } catch (e) {
    console.warn(
      `[surface] Overpass request failed: ${(e as Error).message}`,
      { url, bbox, error: e },
    );
    return [];
  }

  // Build the candidate ways once: geometry, its cumulative lengths (for
  // projection), a bbox for cheap rejection, and the surface classification.
  const candidates: Candidate[] = [];
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const coords: LonLat[] = el.geometry.map((g) => [g.lon, g.lat] as LonLat);
    const rawValue = el.tags?.["surface"] ?? null;
    candidates.push({
      coords,
      cumulative: cumulativePolylineLengthsFt(coords),
      bbox: boundingBox(coords, 0),
      surface: classifySurfaceValue(rawValue ?? undefined),
      rawValue,
    });
  }

  const matchBufferFt = matchBufferM * 3.28084;
  const padDeg = matchBufferM * DEG_PAD_PER_M;
  const cumulative = cumulativePolylineLengthsFt(routeCoords);
  const segments: SurfaceSegment[] = [];

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const a = routeCoords[i];
    const b = routeCoords[i + 1];
    const mid: LonLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    let bestOff = Infinity;
    let bestSurface: SurfaceClass = "unknown";
    let bestRaw: string | null = null;

    for (const c of candidates) {
      // Cheap bbox reject before the per-vertex projection.
      if (
        mid[0] < c.bbox.west - padDeg ||
        mid[0] > c.bbox.east + padDeg ||
        mid[1] < c.bbox.south - padDeg ||
        mid[1] > c.bbox.north + padDeg
      ) {
        continue;
      }
      const proj = projectPointOntoPolylineFt(mid, c.coords, c.cumulative);
      if (proj.offRouteFt < bestOff) {
        bestOff = proj.offRouteFt;
        bestSurface = c.surface;
        bestRaw = c.rawValue;
      }
    }

    const matched = bestOff <= matchBufferFt;
    segments.push({
      fromIdx: i,
      toIdx: i + 1,
      startFt: cumulative[i],
      endFt: cumulative[i + 1],
      lengthFt: cumulative[i + 1] - cumulative[i],
      surface: matched ? bestSurface : "unknown",
      rawValue: matched ? bestRaw : null,
      offRouteFt: matched ? bestOff : Infinity,
    });
  }

  const summary = summarizeSurface(segments);
  console.info(
    `[surface] Labelled ${segments.length} segments: ` +
      `${Math.round(summary.pavedFt)} ft paved, ` +
      `${Math.round(summary.unpavedFt)} ft unpaved, ` +
      `${Math.round(summary.unknownFt)} ft unknown.`,
  );
  return segments;
}

/** Aggregate per-segment labels into paved/unpaved/unknown totals and fractions. */
export function summarizeSurface(
  segments: readonly SurfaceSegment[],
): SurfaceSummary {
  let pavedFt = 0;
  let unpavedFt = 0;
  let unknownFt = 0;
  for (const s of segments) {
    if (s.surface === "paved") pavedFt += s.lengthFt;
    else if (s.surface === "unpaved") unpavedFt += s.lengthFt;
    else unknownFt += s.lengthFt;
  }
  const totalFt = pavedFt + unpavedFt + unknownFt;
  const classifiedFt = pavedFt + unpavedFt;
  return {
    totalFt,
    pavedFt,
    unpavedFt,
    unknownFt,
    unpavedFraction: classifiedFt > 0 ? unpavedFt / classifiedFt : 0,
    unknownFraction: totalFt > 0 ? unknownFt / totalFt : 0,
  };
}

/**
 * Collapse consecutive same-class segments into contiguous spans. Useful for
 * "X ft of unpaved path ahead"-style warnings instead of per-segment chatter.
 */
export function mergeSurfaceSpans(
  segments: readonly SurfaceSegment[],
): SurfaceSegment[] {
  const spans: SurfaceSegment[] = [];
  for (const s of segments) {
    const last = spans[spans.length - 1];
    if (last && last.surface === s.surface) {
      last.toIdx = s.toIdx;
      last.endFt = s.endFt;
      last.lengthFt = last.endFt - last.startFt;
      last.offRouteFt = Math.min(last.offRouteFt, s.offRouteFt);
      // Keep the first non-null raw value as representative of the span.
      if (last.rawValue == null) last.rawValue = s.rawValue;
    } else {
      spans.push({ ...s });
    }
  }
  return spans;
}

// --------------------------------------------------------------------------- //
// Internals
// --------------------------------------------------------------------------- //

interface Candidate {
  coords: LonLat[];
  cumulative: number[];
  bbox: BBox;
  surface: SurfaceClass;
  rawValue: string | null;
}

interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

function boundingBox(coords: readonly LonLat[], padM: number): BBox {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const [lon, lat] of coords) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  const padDeg = padM * DEG_PAD_PER_M;
  return {
    south: south - padDeg,
    west: west - padDeg,
    north: north + padDeg,
    east: east + padDeg,
  };
}

function buildQuery(bbox: BBox): string {
  // Overpass uses (south, west, north, east) tuple order. We pull the
  // pedestrian-relevant `highway` ways; surface lives on the way, so we ask
  // for full geometry (`out body geom`) to map-match each route segment.
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return [
    "[out:json][timeout:25];",
    "(",
    `  way["highway"="footway"]${b};`,
    `  way["highway"="path"]${b};`,
    `  way["highway"="pedestrian"]${b};`,
    `  way["highway"="steps"]${b};`,
    `  way["highway"="cycleway"]${b};`,
    `  way["highway"="track"]${b};`,
    `  way["highway"="living_street"]${b};`,
    ");",
    "out body geom;",
  ].join("\n");
}

async function fetchWithTimeout(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
