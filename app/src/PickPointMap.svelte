<script lang="ts">
  /**
   * Tap-to-pick destination map.
   *
   * Used by Plan.svelte when the user chooses the "Map" tab for setting
   * the destination. Centers on the best-known position (current GPS fix
   * if we have one, otherwise a generic default), and on tap drops a
   * red pin and emits the (lon, lat) via onPick.
   */
  import { onDestroy, onMount } from "svelte";
  import L from "leaflet";
  import "leaflet/dist/leaflet.css";

  import type { LonLat } from "./lib/beacon";

  interface Props {
    initialCenter: LonLat | null;
    picked: LonLat | null;
    onPick: (p: LonLat) => void;
  }

  const { initialCenter, picked, onPick }: Props = $props();

  let mapEl: HTMLDivElement;
  let map: L.Map | null = null;
  let marker: L.CircleMarker | null = null;

  // Fallback if we have no other context (Times Square-ish).
  const FALLBACK: LonLat = [-73.9683, 40.7704];

  onMount(() => {
    const seed = picked ?? initialCenter ?? FALLBACK;
    map = L.map(mapEl, { zoomControl: true });
    map.setView([seed[1], seed[0]], 15);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    if (picked) drawMarker(picked);

    map.on("click", (e: L.LeafletMouseEvent) => {
      const lonLat: LonLat = [e.latlng.lng, e.latlng.lat];
      drawMarker(lonLat);
      onPick(lonLat);
    });
  });

  onDestroy(() => {
    map?.remove();
    map = null;
  });

  function drawMarker(p: LonLat): void {
    if (!map) return;
    const ll: L.LatLngTuple = [p[1], p[0]];
    if (!marker) {
      marker = L.circleMarker(ll, {
        radius: 9,
        color: "#fff",
        weight: 2,
        fillColor: "#c33",
        fillOpacity: 1,
      }).addTo(map);
    } else {
      marker.setLatLng(ll);
    }
  }

  // Keep marker in sync if `picked` is updated externally (e.g., reset).
  $effect(() => {
    if (!map) return;
    if (picked) {
      drawMarker(picked);
    } else if (marker) {
      marker.remove();
      marker = null;
    }
  });
</script>

<div class="picker-map" bind:this={mapEl}
     role="application" aria-label="Destination picker map. Tap to drop a pin."></div>

<style>
  .picker-map {
    width: 100%;
    height: 16rem;
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    overflow: hidden;
  }
</style>
