/**
 * OSM-sourced street-crossing waypoints for the planned route.
 *
 * Routers (OSRM, Valhalla) only return the polyline; they don't surface
 * `highway=crossing` metadata. So after planning, we run a separate
 * Overpass API query for crossings near the route, project each onto the
 * polyline, and produce a sorted list of `CrossingWaypoint`s consumable
 * by the navigation engine for safety announcements.
 *
 * Caveats:
 *   - Public Overpass instances are rate-limited (~10k slots/day, ~2
 *     concurrent). Cache results by trip; never poll continuously.
 *   - OSM coverage for `tactile_paving` and `audible_signal` is sparse;
 *     we only surface those tags when explicitly tagged. `null` means
 *     "unknown", not "absent".
 *   - We dedupe by spatial proximity because a single real crossing is
 *     often modelled twice (a node + a way). 8 m radius is empirical.
 */

import { EARTH_RADIUS_FT, haversineFt, type LonLat } from "./beacon";

export type CrossingKind = "marked" | "unmarked" | "signals" | "unknown";

export interface CrossingWaypoint {
  pos: LonLat;
  /** Cumulative distance from route start to the closest point on the polyline. */
  distanceAlongRouteFt: number;
  /** Perpendicular distance from the OSM feature to the route polyline (debug). */
  offRouteFt: number;
  kind: CrossingKind;
  /** true / false when explicitly tagged; null when the tag is missing. */
  tactile: boolean | null;
  audibleSignal: boolean | null;
  refugeIsland: boolean;
  rawTags: Record<string, string>;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const FT_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_FT; // ~365,221 ft/deg latitude
const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_TIMEOUT_MS = 8000;
// Match buffer was 15 m, which kept "ghost" perpendicular crossings at
// corners where the route turns but doesn't actually cross. 6 m only
// admits crossings the route physically walks through (or close enough
// to be the same crosswalk in OSM with slight geometry drift). Stops
// the user being warned about a leg of an intersection they're not
// going to cross while they're mid-road on the leg they are crossing.
const DEFAULT_MATCH_BUFFER_M = 6;
const DEFAULT_DEDUPE_RADIUS_FT = 26; // ~8 m
const DEG_PAD_PER_M = 1 / 111_320;   // bbox padding in degrees per metre

export interface FetchCrossingsOptions {
  overpassUrl?: string;
  timeoutMs?: number;
  /** Discard crossings farther than this from the polyline (metres). */
  matchBufferM?: number;
  /** Discard crossings within this radius of an already-kept one (feet). */
  dedupeRadiusFt?: number;
}

/**
 * Query Overpass for crossings near `routeCoords` and project them onto
 * the polyline. Returns waypoints sorted by `distanceAlongRouteFt`.
 *
 * Errors (network, timeout, parse) are swallowed and returns []; safety
 * features should never block route planning.
 */
export async function fetchCrossings(
  routeCoords: readonly LonLat[],
  opts: FetchCrossingsOptions = {},
): Promise<CrossingWaypoint[]> {
  if (routeCoords.length < 2) return [];

  const url = opts.overpassUrl ?? DEFAULT_OVERPASS_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const matchBufferM = opts.matchBufferM ?? DEFAULT_MATCH_BUFFER_M;
  const dedupeRadiusFt = opts.dedupeRadiusFt ?? DEFAULT_DEDUPE_RADIUS_FT;

  const bbox = boundingBox(routeCoords, matchBufferM * 2);
  const query = buildQuery(bbox);

  let elements: OverpassElement[];
  try {
    const res = await fetchWithTimeout(url, query, timeoutMs);
    if (!res.ok) {
      // Log enough context to diagnose silent failures (rate limit, 504,
      // ATS rejection, etc.). Without this the call site can't tell
      // "real zero" from "network problem".
      console.warn(
        `[crossings] Overpass returned HTTP ${res.status} ${res.statusText}`,
        { url, bbox },
      );
      return [];
    }
    const data = (await res.json()) as OverpassResponse;
    elements = data.elements ?? [];
    console.info(
      `[crossings] Overpass returned ${elements.length} raw elements`,
      { url, bbox, routeCoordCount: routeCoords.length },
    );
  } catch (e) {
    console.warn(
      `[crossings] Overpass request failed: ${(e as Error).message}`,
      { url, bbox, error: e },
    );
    return [];
  }

  const matchBufferFt = matchBufferM * 3.28084;
  const cumulative = cumulativePolylineLengthsFt(routeCoords);
  const seen: CrossingWaypoint[] = [];

  for (const el of elements) {
    const pos = elementCenter(el);
    if (!pos) continue;
    const proj = projectPointOntoPolylineFt(pos, routeCoords, cumulative);
    if (proj.offRouteFt > matchBufferFt) continue;

    const tags = el.tags ?? {};
    const cw: CrossingWaypoint = {
      pos: proj.foot,                  // snap to the route, not the OSM point
      distanceAlongRouteFt: proj.distanceAlongRouteFt,
      offRouteFt: proj.offRouteFt,
      kind: parseKind(tags),
      tactile: parseBoolTag(tags["tactile_paving"]),
      audibleSignal:
        parseBoolTag(tags["audible_signal"]) ??
        parseBoolTag(tags["traffic_signals:sound"]),
      refugeIsland: parseBoolTag(tags["crossing:island"]) === true,
      rawTags: tags,
    };

    // Spatial dedupe: same real-world crossing may appear as both a node
    // and a way in OSM. Keep the first match per ~8 m cluster.
    const dup = seen.find(
      (s) =>
        Math.abs(s.distanceAlongRouteFt - cw.distanceAlongRouteFt) <
        dedupeRadiusFt,
    );
    if (dup) {
      // Merge: prefer the more informative tag set.
      if (dup.kind === "unknown" && cw.kind !== "unknown") dup.kind = cw.kind;
      if (dup.tactile == null && cw.tactile != null) dup.tactile = cw.tactile;
      if (dup.audibleSignal == null && cw.audibleSignal != null) {
        dup.audibleSignal = cw.audibleSignal;
      }
      if (cw.refugeIsland) dup.refugeIsland = true;
      continue;
    }

    seen.push(cw);
  }

  seen.sort((a, b) => a.distanceAlongRouteFt - b.distanceAlongRouteFt);
  console.info(
    `[crossings] Kept ${seen.length} crossings after off-route filter` +
    ` (${matchBufferM} m) and dedupe (${dedupeRadiusFt} ft).`,
  );
  return seen;
}

// --------------------------------------------------------------------------- //
// Geometry helpers
// --------------------------------------------------------------------------- //

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

export function cumulativePolylineLengthsFt(
  coords: readonly LonLat[],
): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1] + haversineFt(coords[i - 1], coords[i]);
  }
  return out;
}

interface ProjectionResult {
  foot: LonLat;
  distanceAlongRouteFt: number;
  offRouteFt: number;
  segmentIdx: number;
}

/**
 * Project a point onto a polyline using a local equirectangular
 * approximation (accurate to <1% over distances of a few km, plenty for
 * pedestrian-scale routes).
 */
export function projectPointOntoPolylineFt(
  point: LonLat,
  coords: readonly LonLat[],
  cumulative: readonly number[],
): ProjectionResult {
  let bestOff = Infinity;
  let bestAlong = 0;
  let bestFoot: LonLat = coords[0];
  let bestSeg = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = cumulative[i + 1] - cumulative[i];
    if (segLen === 0) continue;

    // Local equirectangular feet, origin at `a`.
    const lat0 = (a[1] * Math.PI) / 180;
    const cos0 = Math.cos(lat0);
    const ftPerDegLon = FT_PER_DEG * cos0;

    const bx = (b[0] - a[0]) * ftPerDegLon;
    const by = (b[1] - a[1]) * FT_PER_DEG;
    const px = (point[0] - a[0]) * ftPerDegLon;
    const py = (point[1] - a[1]) * FT_PER_DEG;

    const segLenSq = bx * bx + by * by;
    let t = segLenSq > 0 ? (px * bx + py * by) / segLenSq : 0;
    t = Math.max(0, Math.min(1, t));

    const fx = bx * t;
    const fy = by * t;
    const off = Math.hypot(px - fx, py - fy);

    if (off < bestOff) {
      bestOff = off;
      bestAlong = cumulative[i] + segLen * t;
      bestFoot = [a[0] + fx / ftPerDegLon, a[1] + fy / FT_PER_DEG];
      bestSeg = i;
    }
  }

  return {
    foot: bestFoot,
    distanceAlongRouteFt: bestAlong,
    offRouteFt: bestOff,
    segmentIdx: bestSeg,
  };
}

function elementCenter(el: OverpassElement): LonLat | null {
  if (el.type === "node" && el.lat != null && el.lon != null) {
    return [el.lon, el.lat];
  }
  if (el.type === "way") {
    if (el.geometry && el.geometry.length) {
      // Use the midpoint of the way (footway=crossing usually has 2-3 nodes).
      const mid = el.geometry[Math.floor(el.geometry.length / 2)];
      return [mid.lon, mid.lat];
    }
    if (el.center) return [el.center.lon, el.center.lat];
  }
  return null;
}

function parseKind(tags: Record<string, string>): CrossingKind {
  // OSM has used both `crossing=*` and `crossing_ref=*` historically.
  const c = tags["crossing"] ?? tags["crossing_ref"];
  if (c == null) return "unknown";
  if (
    c === "traffic_signals" ||
    c === "signals" ||
    tags["crossing:signals"] === "yes" ||
    tags["crossing:traffic_signals"] === "yes"
  ) {
    return "signals";
  }
  if (
    c === "marked" ||
    c === "zebra" ||
    c === "uncontrolled" ||
    c === "pelican" ||
    c === "toucan" ||
    c === "puffin"
  ) {
    return "marked";
  }
  if (c === "unmarked" || c === "informal") return "unmarked";
  return "unknown";
}

function parseBoolTag(v: string | undefined): boolean | null {
  if (v == null) return null;
  if (v === "yes" || v === "true" || v === "1") return true;
  if (v === "no" || v === "false" || v === "0") return false;
  return null;
}

function buildQuery(bbox: BBox): string {
  // Note: Overpass uses (south, west, north, east) tuple order.
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  return [
    "[out:json][timeout:25];",
    "(",
    `  node["highway"="crossing"]${b};`,
    `  way["footway"="crossing"]${b};`,
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
