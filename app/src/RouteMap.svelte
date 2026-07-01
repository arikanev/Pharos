<script lang="ts">
  /**
   * Live debug/visualization map for the navigation flow.
   *
   * Shows:
   *   - the OSRM/Valhalla pedestrian polyline (blue)
   *   - every beacon (numbered circle; the next-target beacon is filled
   *     in green so you can see what the audio engine is steering toward)
   *   - the user's current GPS fix (red dot + accuracy radius circle)
   *
   * It exists primarily to debug "why hasn't beacon 1 arrived yet?" -- you
   * can usually see at a glance that the start of the polyline is on the
   * sidewalk 30+ ft from the building centroid, and/or that the GPS fix
   * has a ±20m accuracy ring drowning the 15 ft arrival radius.
   *
   * No native dependency: pure Leaflet over OSM tiles. Works in PWA and
   * Capacitor iOS/Android WKWebView/WebView.
   */
  import { onDestroy, onMount } from "svelte";
  import L from "leaflet";
  import "leaflet/dist/leaflet.css";

  import type { LonLat } from "./lib/beacon";
  import type { CrossingWaypoint } from "./lib/crossings";
  import {
    mergeSurfaceSpans,
    summarizeSurface,
    type SurfaceClass,
    type SurfaceSegment,
  } from "./lib/surface";

  interface Props {
    routeCoords: readonly LonLat[];
    beacons: readonly LonLat[];
    nextBeaconIdx: number;
    userPos: LonLat | null;
    accuracyM: number | null;
    arrivalRadiusFt: number;
    crossings?: readonly CrossingWaypoint[];
    surface?: readonly SurfaceSegment[];
  }

  const {
    routeCoords,
    beacons,
    nextBeaconIdx,
    userPos,
    accuracyM,
    arrivalRadiusFt,
    crossings = [],
    surface = [],
  }: Props = $props();

  // Surface palette: paved = the usual route blue, unpaved = warm brown,
  // unknown = grey dashed (OSM has no surface tag here — missing data, not a
  // claim either way). Kept distinct from the crossings green/amber/red.
  const SURFACE_COLORS: Record<SurfaceClass, string> = {
    paved: "#246",
    unpaved: "#b4530a",
    unknown: "#999",
  };

  // Derived once per surface change: contiguous same-class spans for drawing,
  // and a summary for the legend.
  const surfaceSpans = $derived(mergeSurfaceSpans(surface));
  const surfaceSummary = $derived(summarizeSurface(surface));
  const hasSurface = $derived(surface.length > 0);

  const FT_PER_M = 3.28084;

  let mapEl: HTMLDivElement;
  let map: L.Map | null = null;
  let routeLine: L.Polyline | null = null;
  let surfaceLayer: L.LayerGroup | null = null;
  let beaconLayer: L.LayerGroup | null = null;
  let crossingLayer: L.LayerGroup | null = null;
  let userMarker: L.CircleMarker | null = null;
  let userAccuracy: L.Circle | null = null;
  let arrivalRing: L.Circle | null = null;
  let didFitBounds = false;

  onMount(() => {
    map = L.map(mapEl, {
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    routeLine = L.polyline(
      routeCoords.map(([lng, lat]) => [lat, lng] as L.LatLngTuple),
      { color: "#246", weight: 4, opacity: 0.85 },
    ).addTo(map);

    surfaceLayer = L.layerGroup().addTo(map);
    beaconLayer = L.layerGroup().addTo(map);
    crossingLayer = L.layerGroup().addTo(map);
    redrawSurface();
    redrawBeacons();
    redrawCrossings();

    // Initial fit: route bounds.
    if (routeLine.getBounds().isValid()) {
      map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
      didFitBounds = true;
    }
  });

  onDestroy(() => {
    map?.remove();
    map = null;
  });

  function redrawSurface(): void {
    if (!surfaceLayer || !routeLine) return;
    surfaceLayer.clearLayers();

    // No surface data: leave the plain blue route line as-is.
    if (!hasSurface) {
      routeLine.setStyle({ opacity: 0.85 });
      return;
    }

    // Surface data present: the colored spans cover the whole route, so hide
    // the base line (kept only for fitBounds) and draw a polyline per span.
    routeLine.setStyle({ opacity: 0 });
    for (const span of surfaceSpans) {
      const pts = routeCoords
        .slice(span.fromIdx, span.toIdx + 1)
        .map(([lng, lat]) => [lat, lng] as L.LatLngTuple);
      if (pts.length < 2) continue;
      const color = SURFACE_COLORS[span.surface];
      L.polyline(pts, {
        color,
        weight: 5,
        opacity: 0.9,
        dashArray: span.surface === "unknown" ? "5 6" : undefined,
      })
        .bindTooltip(
          `${span.surface}${span.rawValue ? ` (${span.rawValue})` : ""} · ${Math.round(span.lengthFt)} ft`,
          { direction: "top", offset: [0, -4], className: "surface-label" },
        )
        .addTo(surfaceLayer!);
    }
  }

  function redrawBeacons(): void {
    if (!beaconLayer || !map) return;
    beaconLayer.clearLayers();
    beacons.forEach(([lng, lat], i) => {
      const isNext = i === nextBeaconIdx;
      const isPast = i < nextBeaconIdx;
      const fill = isNext ? "#1a6" : isPast ? "#bbb" : "#fff";
      const stroke = isNext ? "#0a4" : isPast ? "#888" : "#246";
      const m = L.circleMarker([lat, lng], {
        radius: isNext ? 9 : 6,
        color: stroke,
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
      }).bindTooltip(`${i + 1}`, {
        permanent: true,
        direction: "top",
        offset: [0, -6],
        className: "beacon-label",
      });
      m.addTo(beaconLayer!);
    });

    // Also render the arrival-radius ring around the next target beacon
    // so the GPS-accuracy-vs-radius mismatch is visible.
    if (arrivalRing) {
      arrivalRing.remove();
      arrivalRing = null;
    }
    const next = beacons[nextBeaconIdx];
    if (next) {
      const [lng, lat] = next;
      arrivalRing = L.circle([lat, lng], {
        radius: arrivalRadiusFt / FT_PER_M, // metres
        color: "#1a6",
        weight: 1,
        opacity: 0.6,
        fillOpacity: 0.08,
        dashArray: "4 4",
      });
      if (map) arrivalRing.addTo(map);
    }
  }

  function redrawCrossings(): void {
    if (!crossingLayer) return;
    crossingLayer.clearLayers();
    crossings.forEach((c) => {
      const [lng, lat] = c.pos;
      // Use orange/red palette for crossings so they stand out from
      // beacons (blue/green) and the user dot (red+white outline).
      const fill =
        c.kind === "signals" ? "#1a6" : // green: traffic-signalled
        c.kind === "marked"  ? "#d80" : // amber: marked but no signal
        c.kind === "unmarked" ? "#c33" : // red: unmarked, dangerous
        "#888";                          // grey: unknown
      const tooltip = describeCrossing(c);
      L.circleMarker([lat, lng], {
        radius: 6,
        color: "#fff",
        weight: 2,
        fillColor: fill,
        fillOpacity: 1,
      })
        .bindTooltip(tooltip, {
          direction: "top",
          offset: [0, -6],
          className: "crossing-label",
        })
        .addTo(crossingLayer!);
    });
  }

  function describeCrossing(c: CrossingWaypoint): string {
    const parts: string[] = [];
    if (c.kind === "signals") parts.push("signal");
    else if (c.kind === "marked") parts.push("marked");
    else if (c.kind === "unmarked") parts.push("unmarked");
    else parts.push("crossing");
    if (c.tactile === true) parts.push("tactile");
    if (c.audibleSignal === true) parts.push("audible");
    if (c.refugeIsland) parts.push("island");
    return parts.join(" / ");
  }

  function updateUser(): void {
    if (!map) return;
    if (!userPos) {
      userMarker?.remove();
      userAccuracy?.remove();
      userMarker = null;
      userAccuracy = null;
      return;
    }
    const [lng, lat] = userPos;
    if (!userMarker) {
      userMarker = L.circleMarker([lat, lng], {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: "#c33",
        fillOpacity: 1,
      }).addTo(map);
    } else {
      userMarker.setLatLng([lat, lng]);
    }

    if (accuracyM != null && Number.isFinite(accuracyM) && accuracyM > 0) {
      if (!userAccuracy) {
        userAccuracy = L.circle([lat, lng], {
          radius: accuracyM,
          color: "#c33",
          weight: 1,
          opacity: 0.4,
          fillOpacity: 0.08,
        }).addTo(map);
      } else {
        userAccuracy.setLatLng([lat, lng]);
        userAccuracy.setRadius(accuracyM);
      }
    } else if (userAccuracy) {
      userAccuracy.remove();
      userAccuracy = null;
    }

    // First time we get a fix, expand bounds to include the user so
    // they're not staring at a route on the other side of the screen.
    if (!didFitBounds && routeLine) {
      const b = routeLine.getBounds().extend([lat, lng]);
      map.fitBounds(b, { padding: [24, 24] });
      didFitBounds = true;
    }
  }

  $effect(() => {
    void nextBeaconIdx; // dependency
    void beacons;
    redrawBeacons();
  });

  $effect(() => {
    void crossings;
    redrawCrossings();
  });

  $effect(() => {
    void surface;
    redrawSurface();
  });

  $effect(() => {
    void userPos;
    void accuracyM;
    updateUser();
  });
</script>

<div class="map" bind:this={mapEl} role="img" aria-label="Route map (visual only)"></div>

{#if hasSurface}
  <div class="surface-legend" aria-hidden="true">
    <span class="swatch paved"></span> Paved
    <span class="swatch unpaved"></span> Unpaved
    <span class="swatch unknown"></span> Unknown
    <span class="legend-stat">
      {#if surfaceSummary.pavedFt + surfaceSummary.unpavedFt === 0}
        surface unknown
      {:else}
        {Math.round(surfaceSummary.unpavedFraction * 100)}% unpaved
      {/if}
    </span>
  </div>
{/if}

<style>
  .map {
    width: 100%;
    height: 16rem;
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    overflow: hidden;
  }
  /* Leaflet beacon labels: small bold black-on-white pills. */
  :global(.beacon-label) {
    background: #fff;
    color: #111;
    border: 1px solid #888;
    border-radius: 0.25rem;
    padding: 0 0.25rem;
    font-size: 0.7rem;
    font-weight: 700;
    box-shadow: none;
  }
  :global(.beacon-label::before) {
    display: none;
  }
  :global(.crossing-label) {
    background: #fffbe6;
    color: #5a3a00;
    border: 1px solid #d80;
    border-radius: 0.25rem;
    padding: 0 0.3rem;
    font-size: 0.7rem;
    font-weight: 600;
    box-shadow: none;
  }
  :global(.crossing-label::before) {
    display: none;
  }
  :global(.surface-label) {
    background: #fff;
    color: #111;
    border: 1px solid #888;
    border-radius: 0.25rem;
    padding: 0 0.3rem;
    font-size: 0.7rem;
    font-weight: 600;
    box-shadow: none;
  }
  :global(.surface-label::before) {
    display: none;
  }

  .surface-legend {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    margin-top: 0.4rem;
    font-size: 0.75rem;
    color: #333;
  }
  .surface-legend .swatch {
    display: inline-block;
    width: 0.9rem;
    height: 0.25rem;
    border-radius: 1px;
  }
  .surface-legend .swatch.paved {
    background: #246;
  }
  .surface-legend .swatch.unpaved {
    background: #b4530a;
  }
  .surface-legend .swatch.unknown {
    background: repeating-linear-gradient(
      90deg,
      #999 0,
      #999 4px,
      transparent 4px,
      transparent 8px
    );
  }
  .surface-legend .legend-stat {
    margin-left: auto;
    font-weight: 600;
  }
</style>
