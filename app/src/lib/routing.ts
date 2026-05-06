/**
 * Pedestrian / bicycle / driving routing client.
 *
 * Mirrors `fetch_route()` and `PROFILES` in beacon_placement.py: walks an
 * ordered fallback chain so that one dead public server doesn't block the
 * whole pipeline.
 *
 * `routing.openstreetmap.de` (FOSSGIS-hosted OSRM) returns
 * `Access-Control-Allow-Origin: *` so we can call it directly from the
 * browser. If that ever changes, swap in a one-line serverless proxy
 * without touching this module's public interface.
 */

import type { LonLat } from "./beacon";

export type Profile = "auto" | "pedestrian" | "bicycle";

interface OsrmEndpoint {
  kind: "osrm";
  url: string;
}

interface ValhallaEndpoint {
  kind: "valhalla";
  url: string;
  costing: "pedestrian" | "bicycle" | "auto";
}

type Endpoint = OsrmEndpoint | ValhallaEndpoint;

const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const OSRM_BIKE = "https://routing.openstreetmap.de/routed-bike/route/v1/bike";
const OSRM_CAR = "https://router.project-osrm.org/route/v1/driving";
const VALHALLA = "https://valhalla1.openstreetmap.de/route";

const PROFILES: Record<Profile, Endpoint[]> = {
  auto: [{ kind: "osrm", url: OSRM_CAR }],
  pedestrian: [
    { kind: "osrm", url: OSRM_FOOT },
    { kind: "valhalla", url: VALHALLA, costing: "pedestrian" },
  ],
  bicycle: [
    { kind: "osrm", url: OSRM_BIKE },
    { kind: "valhalla", url: VALHALLA, costing: "bicycle" },
  ],
};

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RouteResult {
  coords: LonLat[];
  backend: string;
  distanceFt: number | null;
  durationSec: number | null;
}

class RoutingError extends Error {
  public readonly underlying?: unknown;
  constructor(message: string, underlying?: unknown) {
    super(message);
    this.name = "RoutingError";
    this.underlying = underlying;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOsrm(
  endpoint: OsrmEndpoint,
  start: LonLat,
  end: LonLat,
): Promise<RouteResult> {
  const url =
    `${endpoint.url}/${start[0]},${start[1]};${end[0]},${end[1]}` +
    `?overview=full&geometries=geojson`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    throw new RoutingError(`OSRM HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new RoutingError(`OSRM error: ${data.message ?? data.code}`);
  }
  const route = data.routes[0];
  const coords: LonLat[] = (route.geometry.coordinates as number[][]).map(
    (c) => [c[0], c[1]] as LonLat,
  );
  return {
    coords,
    backend: "osrm-foot/bike",
    distanceFt:
      typeof route.distance === "number" ? route.distance * 3.28084 : null,
    durationSec: typeof route.duration === "number" ? route.duration : null,
  };
}

// Polyline6 decoder for Valhalla's `shape` field (Google polyline at 1e-6).
function decodePolyline(s: string, precision = 6): LonLat[] {
  const factor = 10 ** precision;
  const coords: LonLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < s.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = s.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = s.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

async function fetchValhalla(
  endpoint: ValhallaEndpoint,
  start: LonLat,
  end: LonLat,
): Promise<RouteResult> {
  const body = JSON.stringify({
    locations: [
      { lon: start[0], lat: start[1] },
      { lon: end[0], lat: end[1] },
    ],
    costing: endpoint.costing,
  });
  const resp = await fetchWithTimeout(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) {
    throw new RoutingError(`Valhalla HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.trip?.legs?.length) {
    throw new RoutingError(`Valhalla error: ${JSON.stringify(data.error ?? data)}`);
  }
  const coords: LonLat[] = [];
  for (const leg of data.trip.legs) {
    const decoded = decodePolyline(leg.shape, 6);
    if (
      coords.length &&
      decoded.length &&
      coords[coords.length - 1][0] === decoded[0][0] &&
      coords[coords.length - 1][1] === decoded[0][1]
    ) {
      coords.push(...decoded.slice(1));
    } else {
      coords.push(...decoded);
    }
  }
  const summary = data.trip.summary;
  return {
    coords,
    backend: "valhalla",
    distanceFt: typeof summary?.length === "number" ? summary.length * 5280 : null,
    durationSec: typeof summary?.time === "number" ? summary.time : null,
  };
}

export async function fetchRoute(
  start: LonLat,
  end: LonLat,
  profile: Profile = "pedestrian",
): Promise<RouteResult> {
  const chain = PROFILES[profile];
  let lastErr: unknown;
  for (const endpoint of chain) {
    try {
      if (endpoint.kind === "osrm") {
        return await fetchOsrm(endpoint, start, end);
      }
      return await fetchValhalla(endpoint, start, end);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new RoutingError(
    `All routing backends for profile "${profile}" failed`,
    lastErr,
  );
}

// --------------------------------------------------------------------------- //
// Optional: Nominatim geocoder (OSM-hosted, ~1 rps fair use)
// --------------------------------------------------------------------------- //

export interface GeocodeResult {
  display: string;
  position: LonLat;
}

export async function geocode(query: string): Promise<GeocodeResult[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const resp = await fetchWithTimeout(url, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new RoutingError(`Nominatim HTTP ${resp.status}`);
  }
  const arr = (await resp.json()) as Array<{
    display_name: string;
    lon: string;
    lat: string;
  }>;
  return arr.map((r) => ({
    display: r.display_name,
    position: [parseFloat(r.lon), parseFloat(r.lat)] as LonLat,
  }));
}
