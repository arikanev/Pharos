<script lang="ts">
  import { Geolocation } from "@capacitor/geolocation";

  import { autotune, polylineLengthFt, type LonLat } from "./lib/beacon";
  import { fetchRoute, geocode, type GeocodeResult } from "./lib/routing";
  import { fetchCrossings } from "./lib/crossings";
  import { fetchSurfaces, summarizeSurface } from "./lib/surface";
  import { saveCurrentTrip, type Trip } from "./lib/storage";
  import { announce } from "./lib/a11y";
  import PickPointMap from "./PickPointMap.svelte";

  type StartMode = "search" | "coords" | "current";
  type EndMode = "search" | "coords" | "map";

  interface CurrentLoc {
    pos: LonLat;
    accuracyM: number;
  }

  interface Props {
    onPlanned: (trip: Trip) => void;
  }

  let { onPlanned }: Props = $props();

  let startMode = $state<StartMode>("search");
  let endMode = $state<EndMode>("search");

  let startQuery = $state("");
  let endQuery = $state("");
  let startCoordsText = $state("");
  let endCoordsText = $state("");

  let startResults = $state<GeocodeResult[]>([]);
  let endResults = $state<GeocodeResult[]>([]);
  let startSel = $state<GeocodeResult | null>(null);
  let endSel = $state<GeocodeResult | null>(null);

  let currentLoc = $state<CurrentLoc | null>(null);
  let endMapPos = $state<LonLat | null>(null);

  let driftFt = $state(5);
  let stepFt = $state(20);

  let busy = $state(false);
  let locBusy = $state(false);
  let error = $state<string | null>(null);
  let summary = $state<string | null>(null);

  function parseCoords(s: string): LonLat | null {
    const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    // Accept both lon,lat and lat,lon by sniffing magnitude.
    if (Math.abs(a) <= 90 && Math.abs(b) > 90) return [b, a];
    return [a, b];
  }

  function resolveStart(): { pos: LonLat; label?: string } | null {
    if (startMode === "coords") {
      const p = parseCoords(startCoordsText);
      return p ? { pos: p, label: startCoordsText } : null;
    }
    if (startMode === "current") {
      return currentLoc
        ? {
            pos: currentLoc.pos,
            label: `Current location (\u00b1${Math.round(currentLoc.accuracyM)} m)`,
          }
        : null;
    }
    return startSel ? { pos: startSel.position, label: startSel.display } : null;
  }

  function resolveEnd(): { pos: LonLat; label?: string } | null {
    if (endMode === "coords") {
      const p = parseCoords(endCoordsText);
      return p ? { pos: p, label: endCoordsText } : null;
    }
    if (endMode === "map") {
      return endMapPos
        ? {
            pos: endMapPos,
            label: `Map: ${endMapPos[1].toFixed(5)}, ${endMapPos[0].toFixed(5)}`,
          }
        : null;
    }
    return endSel ? { pos: endSel.position, label: endSel.display } : null;
  }

  async function useCurrentLocation() {
    locBusy = true;
    error = null;
    try {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted") {
        const r = await Geolocation.requestPermissions();
        if (r.location !== "granted") {
          throw new Error("Location permission denied");
        }
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 0,
      });
      currentLoc = {
        pos: [pos.coords.longitude, pos.coords.latitude],
        accuracyM: pos.coords.accuracy ?? Number.NaN,
      };
      announce(
        `Current location acquired, accuracy ${
          Number.isFinite(currentLoc.accuracyM)
            ? Math.round(currentLoc.accuracyM) + " metres"
            : "unknown"
        }.`,
      );
    } catch (e) {
      error = `Could not get location: ${(e as Error).message}`;
    } finally {
      locBusy = false;
    }
  }

  async function searchStart() {
    if (!startQuery.trim()) return;
    busy = true;
    error = null;
    try {
      startResults = await geocode(startQuery);
      if (!startResults.length) error = "No results for start";
    } catch (e) {
      error = `Geocode failed: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function searchEnd() {
    if (!endQuery.trim()) return;
    busy = true;
    error = null;
    try {
      endResults = await geocode(endQuery);
      if (!endResults.length) error = "No results for end";
    } catch (e) {
      error = `Geocode failed: ${(e as Error).message}`;
    } finally {
      busy = false;
    }
  }

  async function plan() {
    const s = resolveStart();
    const e = resolveEnd();
    if (!s || !e) {
      error = "Pick a start and an end first.";
      return;
    }
    busy = true;
    error = null;
    summary = null;
    announce("Planning route.", { interrupt: true });
    try {
      const route = await fetchRoute(s.pos, e.pos, "pedestrian");
      // Run beacon placement and the OSM Overpass queries in parallel; the
      // crossing and surface fetches are best-effort and never block routing.
      const [tune, crossings, surface] = await Promise.all([
        Promise.resolve(autotune(route.coords, driftFt, { stepFt })),
        fetchCrossings(route.coords).catch(() => []),
        fetchSurfaces(route.coords).catch(() => []),
      ]);
      const lengthFt = polylineLengthFt(route.coords);
      const trip: Trip = {
        savedAt: Date.now(),
        start: s.pos,
        end: e.pos,
        startLabel: s.label,
        endLabel: e.label,
        driftBudgetFt: driftFt,
        route,
        tune,
        crossings,
        surface,
      };
      await saveCurrentTrip(trip);
      const crossingSummary =
        crossings.length === 1
          ? "1 street crossing"
          : `${crossings.length} street crossings`;
      const surf = summarizeSurface(surface);
      const surfaceSummary =
        surf.pavedFt + surf.unpavedFt === 0
          ? "Surface unknown"
          : `${Math.round(surf.unpavedFraction * 100)}% unpaved`;
      summary = `${tune.beaconCount} beacons over ${Math.round(lengthFt).toLocaleString()} ft. Worst drift ${tune.driftFt.toFixed(1)} ft. ${crossingSummary}. ${surfaceSummary}.`;
      // Don't speak the summary here -- Navigate.svelte:start() will
      // announce "Navigation started. X beacons and Y crossings ahead..."
      // immediately after this returns, and using `interrupt: true` here
      // would cancel that. The summary is still visible on-screen and in
      // the aria-live region for screen readers.
      onPlanned(trip);
    } catch (err) {
      error = `Routing failed: ${(err as Error).message}`;
      announce(`Routing failed: ${(err as Error).message}`, { interrupt: true });
    } finally {
      busy = false;
    }
  }
</script>

<section class="screen" aria-labelledby="plan-title">
  <h1 id="plan-title">Plan a trip</h1>
  <p class="muted">Enter where you're starting and where you're going.</p>

  <fieldset>
    <legend>Start</legend>
    <div class="tabs" role="tablist" aria-label="Start input mode">
      <button type="button" role="tab" aria-selected={startMode === "search"}
              onclick={() => (startMode = "search")}>Search</button>
      <button type="button" role="tab" aria-selected={startMode === "coords"}
              onclick={() => (startMode = "coords")}>Coords</button>
      <button type="button" role="tab" aria-selected={startMode === "current"}
              onclick={() => (startMode = "current")}>Current</button>
    </div>
    {#if startMode === "search"}
      <label for="start-q">Address or place</label>
      <input id="start-q" type="search" bind:value={startQuery}
             aria-describedby="start-help"
             onkeydown={(e) => e.key === "Enter" && searchStart()} />
      <button type="button" onclick={searchStart} disabled={busy}>Find start</button>
      <p id="start-help" class="muted small">Powered by OpenStreetMap Nominatim.</p>
      {#if startResults.length}
        <ul class="results" role="listbox" aria-label="Start search results">
          {#each startResults as r (r.display)}
            <li>
              <button type="button"
                      class:selected={startSel === r}
                      aria-pressed={startSel === r}
                      onclick={() => (startSel = r)}>{r.display}</button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if startMode === "coords"}
      <label for="start-c">Start coordinates (lon,lat or lat,lon)</label>
      <input id="start-c" type="text" inputmode="decimal" placeholder="-73.97, 40.77"
             bind:value={startCoordsText} />
    {:else}
      <button type="button" onclick={useCurrentLocation} disabled={locBusy}>
        {locBusy ? "Getting GPS fix..." : currentLoc ? "Refresh current location" : "Use current location"}
      </button>
      {#if currentLoc}
        <p class="ok small">
          {currentLoc.pos[1].toFixed(5)}, {currentLoc.pos[0].toFixed(5)}
          {#if Number.isFinite(currentLoc.accuracyM)}
            (&plusmn;{Math.round(currentLoc.accuracyM)} m)
          {/if}
        </p>
      {:else}
        <p class="muted small">
          Grabs a one-shot GPS fix. iOS / Android will prompt for location
          permission the first time.
        </p>
      {/if}
    {/if}
  </fieldset>

  <fieldset>
    <legend>Destination</legend>
    <div class="tabs" role="tablist" aria-label="End input mode">
      <button type="button" role="tab" aria-selected={endMode === "search"}
              onclick={() => (endMode = "search")}>Search</button>
      <button type="button" role="tab" aria-selected={endMode === "coords"}
              onclick={() => (endMode = "coords")}>Coords</button>
      <button type="button" role="tab" aria-selected={endMode === "map"}
              onclick={() => (endMode = "map")}>Map</button>
    </div>
    {#if endMode === "search"}
      <label for="end-q">Address or place</label>
      <input id="end-q" type="search" bind:value={endQuery}
             onkeydown={(e) => e.key === "Enter" && searchEnd()} />
      <button type="button" onclick={searchEnd} disabled={busy}>Find destination</button>
      {#if endResults.length}
        <ul class="results" role="listbox" aria-label="Destination search results">
          {#each endResults as r (r.display)}
            <li>
              <button type="button"
                      class:selected={endSel === r}
                      aria-pressed={endSel === r}
                      onclick={() => (endSel = r)}>{r.display}</button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if endMode === "coords"}
      <label for="end-c">Destination coordinates (lon,lat or lat,lon)</label>
      <input id="end-c" type="text" inputmode="decimal" placeholder="-73.96, 40.78"
             bind:value={endCoordsText} />
    {:else}
      <p class="muted small">Tap the map to drop a destination pin.</p>
      <PickPointMap
        initialCenter={endMapPos ?? currentLoc?.pos ?? null}
        picked={endMapPos}
        onPick={(p) => (endMapPos = p)}
      />
      {#if endMapPos}
        <p class="ok small">
          Destination: {endMapPos[1].toFixed(5)}, {endMapPos[0].toFixed(5)}
        </p>
      {/if}
    {/if}
  </fieldset>

  <fieldset>
    <legend>Tuning</legend>
    <label for="drift-slider">
      Maximum drift: <strong>{driftFt} ft</strong>
    </label>
    <input id="drift-slider" type="range" min="1" max="25" step="1"
           bind:value={driftFt}
           aria-valuemin="1" aria-valuemax="25" aria-valuenow={driftFt}
           aria-valuetext="{driftFt} feet" />
    <p class="muted small">
      Lower drift = more beacons placed closer together. 5 ft is a good
      default; 1 ft hugs the path tightly but adds ~2x the beacons.
    </p>
  </fieldset>

  <button type="button" class="primary" onclick={plan} disabled={busy}
          aria-describedby="plan-status">
    {busy ? "Planning..." : "Plan route"}
  </button>

  <p id="plan-status" class="status" aria-live="polite">
    {#if error}<span class="error">{error}</span>
    {:else if summary}<span class="ok">{summary}</span>
    {/if}
  </p>
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
    max-width: 38rem;
    margin: 0 auto;
  }
  h1 { font-size: 1.5rem; margin: 0; }
  .muted { color: #777; }
  .small { font-size: 0.85rem; }
  fieldset {
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  legend { font-weight: 600; padding: 0 0.25rem; }
  label { font-weight: 500; }
  input[type="search"], input[type="text"] {
    padding: 0.65rem;
    font-size: 1rem;
    border: 1px solid #888;
    border-radius: 0.35rem;
    min-height: 2.75rem;
  }
  input[type="range"] { width: 100%; }
  button {
    min-height: 2.75rem;
    padding: 0.6rem 1rem;
    font-size: 1rem;
    border: 1px solid #444;
    background: #fff;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  button[disabled] { opacity: 0.5; cursor: not-allowed; }
  button.primary {
    background: #1a6;
    color: #fff;
    border-color: #1a6;
    font-weight: 600;
    min-height: 4rem;
    font-size: 1.15rem;
  }
  button.selected, [aria-selected="true"] {
    background: #ddeeff;
    border-color: #246;
  }
  .tabs { display: flex; gap: 0.5rem; }
  .tabs button { flex: 1; }
  .results {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 16rem;
    overflow-y: auto;
  }
  .results button {
    text-align: left;
    width: 100%;
    white-space: normal;
  }
  .status { min-height: 1.5rem; margin: 0; }
  .error { color: #c33; }
  .ok    { color: #1a6; }
</style>
