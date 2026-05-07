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

  interface Props {
    routeCoords: readonly LonLat[];
    beacons: readonly LonLat[];
    nextBeaconIdx: number;
    userPos: LonLat | null;
    accuracyM: number | null;
    arrivalRadiusFt: number;
    crossings?: readonly CrossingWaypoint[];
  }

  const {
    routeCoords,
    beacons,
    nextBeaconIdx,
    userPos,
    accuracyM,
    arrivalRadiusFt,
    crossings = [],
  }: Props = $props();

  const FT_PER_M = 3.28084;

  let mapEl: HTMLDivElement;
  let map: L.Map | null = null;
  let routeLine: L.Polyline | null = null;
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

    beaconLayer = L.layerGroup().addTo(map);
    crossingLayer = L.layerGroup().addTo(map);
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
    void userPos;
    void accuracyM;
    updateUser();
  });
</script>

<div class="map" bind:this={mapEl} role="img" aria-label="Route map (visual only)"></div>

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
</style>
