<script lang="ts">
  import { onDestroy } from "svelte";

  import {
    bearingDeg,
    haversineFt,
    type LonLat,
  } from "./lib/beacon";
  import { AudioEngine, type AudioMode, type PanMode } from "./lib/audio";
  import {
    requestOrientationPermission,
    startSensors,
    type HeadingFix,
    type PositionFix,
  } from "./lib/sensors";
  import {
    acquireWakeLock,
    announce,
    arrivalHaptic,
    crossingHaptic,
    finalHaptic,
    releaseWakeLock,
  } from "./lib/a11y";
  import {
    cumulativePolylineLengthsFt,
    projectPointOntoPolylineFt,
    type CrossingWaypoint,
  } from "./lib/crossings";
  import type { Trip } from "./lib/storage";
  import RouteMap from "./RouteMap.svelte";

  interface Props {
    trip: Trip | null;
    onExit: () => void;
  }

  let { trip, onExit }: Props = $props();

  // Distance threshold to count a beacon as "arrived". 15 ft is a hair below
  // typical civilian GPS HDOP, so the trigger lands once the user is within
  // the noise floor of being there.
  const ARRIVAL_RADIUS_FT = 15;

  // Crossing-warning tunables. The user gets `WARN_SEC` of heads-up at
  // their current walking speed, with a hard floor of MIN_WARN_FT so the
  // warning still fires when they're standing still or barely moving.
  // PASSED_FT lets a crossing be marked "passed" once we're a bit past
  // its projected point on the polyline (handles GPS jitter).
  const WARN_SEC = 8;
  const MIN_WARN_FT = 25;
  const PASSED_FT = 20;
  const DEFAULT_SPEED_MPS = 1.3;   // brisk walking
  const FT_PER_M = 3.28084;
  // While the user is actively traversing a crossing (their projection
  // onto the route is within this many feet past the crossing's snap
  // point), suppress *new* crossing warnings. Prevents the failure mode
  // where the second half of a refuge-island avenue, or a ghost
  // perpendicular crossing at the corner, fires while the user is
  // mid-road on the previous crossing. ~30 ft covers a typical NYC
  // crosswalk depth (lane × 2 + gutter buffer).
  const IN_CROSSING_FT = 30;

  // Off-route detection: if the user's projection onto the route polyline
  // is more than `OFF_ROUTE_FT` away for `OFF_ROUTE_FIXES` consecutive
  // GPS fixes, announce "you appear to be off route". Re-announce no
  // more than once per `OFF_ROUTE_REANNOUNCE_MS` so we don't nag.
  const OFF_ROUTE_FT = 50;
  const OFF_ROUTE_FIXES = 3;
  const OFF_ROUTE_REANNOUNCE_MS = 30_000;

  // Re-acquisition: if the user lingers within `BACKTRACK_RADIUS_FT` of a
  // beacon they've already passed for `BACKTRACK_FIXES` consecutive GPS
  // fixes, snap `beaconIdx` back so we re-target the next beacon AFTER
  // the one they returned to. This recovers from accidental
  // arrival-jitter advances and from genuine wrong-turn backtracks.
  const BACKTRACK_RADIUS_FT = 30;
  const BACKTRACK_FIXES = 3;

  let beaconIdx = $state(0);
  let distanceFt = $state<number | null>(null);
  let bearingDiff = $state<number | null>(null);
  let position = $state<PositionFix | null>(null);
  let heading = $state<HeadingFix | null>(null);
  let mode = $state<AudioMode>("continuous");
  let panMode = $state<PanMode>("stereo");
  let running = $state(false);
  let error = $state<string | null>(null);
  let arrived = $state(false);

  const totalBeacons = $derived(trip?.tune.result.beacons.length ?? 0);

  // Cumulative polyline distances in feet, indexed parallel to
  // `trip.route.coords`. Lets `projectPointOntoPolylineFt` answer
  // "how far along the route is the user right now?" in O(coords).
  const routeCumFt = $derived(
    trip ? cumulativePolylineLengthsFt(trip.route.coords) : [],
  );

  let engine: AudioEngine | null = null;
  let unsubPos: (() => void) | null = null;
  let unsubHeading: (() => void) | null = null;
  let stopSensors: (() => Promise<void>) | null = null;
  let autoStarted = $state(false);
  let crossingsAnnounced: Set<number> = new Set();
  let offRouteCount = 0;
  let lastOffRouteAnnounceAt = 0;
  let backtrackCandidate: { idx: number; count: number } | null = null;

  // Auto-start navigation as soon as a trip is available. The plan() flow
  // in Plan.svelte ran inside a user gesture, and Navigate mounts inside
  // that same call stack, so iOS WKWebView typically still has user
  // activation here. If the AudioContext or DeviceOrientation prompt
  // can't acquire a gesture, start() surfaces an error and the Retry
  // button below covers that case.
  $effect(() => {
    if (trip && !autoStarted && !running && !arrived) {
      autoStarted = true;
      void start();
    }
  });

  // Reset all per-trip "already warned" / debounce state whenever a fresh
  // trip comes in.
  $effect(() => {
    void trip;
    crossingsAnnounced = new Set();
    offRouteCount = 0;
    lastOffRouteAnnounceAt = 0;
    backtrackCandidate = null;
  });

  function nextBeacon(): LonLat | null {
    if (!trip) return null;
    const beacons = trip.tune.result.beacons;
    if (beaconIdx >= beacons.length) return null;
    return beacons[beaconIdx];
  }

  function update(pos: LonLat, headingDeg: number): void {
    if (!trip || !engine) return;
    const target = nextBeacon();
    if (!target) return;
    const d = haversineFt(pos, target);
    distanceFt = d;
    const targetBearing = bearingDeg(pos, target);
    let diff = targetBearing - headingDeg;
    diff = ((diff + 540) % 360) - 180;
    bearingDiff = diff;

    engine.setUserPose(pos, target, headingDeg);

    // Feed GPS accuracy into the audio engine so the spatial cue gets
    // attenuated when the fix is unreliable -- avoids "audio confidently
    // pointing at noise" when the user is indoors / urban canyon.
    if (position?.accuracyM != null) {
      engine.setGpsAccuracy(position.accuracyM);
    }

    // Project the user once onto the route polyline; the result feeds
    // crossing warnings, off-route detection, and backtrack snap-back.
    const proj = routeCumFt.length
      ? projectPointOntoPolylineFt(pos, trip.route.coords, routeCumFt)
      : null;

    checkCrossings(proj);
    checkOffRoute(proj);
    checkBacktrack(pos);

    if (d <= ARRIVAL_RADIUS_FT) {
      const isFinal = beaconIdx === totalBeacons - 1;
      if (isFinal) {
        arrived = true;
        engine.playFinal();
        void finalHaptic();
        announce("You have arrived at your destination.", { interrupt: true });
        void stop();
      } else {
        beaconIdx += 1;
        engine.playArrival();
        void arrivalHaptic();
        announce(`Beacon ${beaconIdx} of ${totalBeacons - 1}.`, { dedupeMs: 4000 });
      }
    }
  }

  function checkCrossings(
    proj: { distanceAlongRouteFt: number; offRouteFt: number } | null,
  ): void {
    if (!trip || !engine) return;
    const crossings = trip.crossings;
    if (!crossings || !crossings.length) return;
    if (!proj) return;

    const userAlongFt = proj.distanceAlongRouteFt;

    // If the user is currently traversing any crossing -- i.e. their
    // projection is within IN_CROSSING_FT past one of the snapped
    // crossing points -- swallow new warnings. They're in the middle
    // of a road; the last thing they need is "Crossing ahead in 30 feet"
    // for an adjacent crossing distracting them from the one they're in.
    for (const c of crossings) {
      const d = c.distanceAlongRouteFt - userAlongFt;
      if (d < 0 && d > -IN_CROSSING_FT) return;
    }

    // Warning distance scales with current walking speed so we give
    // ~8 seconds of heads-up regardless of pace, with a hard MIN floor
    // so we still fire when the user is barely moving / at a stop.
    const speedFps =
      Math.max(DEFAULT_SPEED_MPS, position?.speedMps ?? DEFAULT_SPEED_MPS) *
      FT_PER_M;
    const warnFt = Math.max(MIN_WARN_FT, speedFps * WARN_SEC);

    for (let i = 0; i < crossings.length; i++) {
      if (crossingsAnnounced.has(i)) continue;
      const c = crossings[i];
      const aheadFt = c.distanceAlongRouteFt - userAlongFt;
      if (aheadFt < -PASSED_FT) {
        // Already past it; mark seen so we don't yell about it later if
        // GPS bounces backwards.
        crossingsAnnounced.add(i);
        continue;
      }
      if (aheadFt < 0) continue;        // we're on top of it; nothing to warn about
      if (aheadFt > warnFt) break;      // remaining list is farther; sorted by along-route

      crossingsAnnounced.add(i);
      announceCrossing(c, aheadFt);
      engine.playCrossing();
      void crossingHaptic();
      break;                            // one warning per update tick
    }
  }

  function announceCrossing(c: CrossingWaypoint, aheadFt: number): void {
    const ft = Math.max(0, Math.round(aheadFt));
    const parts: string[] = [];
    parts.push(ft <= 5 ? "Crossing now" : `Crossing ahead in ${ft} feet`);
    if (c.kind === "signals") parts.push("traffic signal");
    else if (c.kind === "marked") parts.push("marked");
    else if (c.kind === "unmarked") parts.push("unmarked, exercise caution");
    if (c.audibleSignal === true) parts.push("with audible signal");
    if (c.refugeIsland) parts.push("with refuge island");
    if (c.tactile === true) parts.push("with tactile paving");
    else if (c.tactile === false) parts.push("no tactile paving");
    const msg = parts.join(", ") + ".";
    announce(msg, { interrupt: true, dedupeMs: 3000 });
  }

  // Off-route detection. We rely on the perpendicular distance from the
  // user to the route polyline -- if the user is genuinely on the
  // sidewalk that the polyline tracks, this stays small even at the
  // tail of the route. Counter-debounced so a single noisy fix doesn't
  // trigger an alert.
  function checkOffRoute(
    proj: { offRouteFt: number } | null,
  ): void {
    if (!proj) return;
    if (proj.offRouteFt > OFF_ROUTE_FT) {
      offRouteCount += 1;
      if (offRouteCount === OFF_ROUTE_FIXES) {
        const now = Date.now();
        if (now - lastOffRouteAnnounceAt > OFF_ROUTE_REANNOUNCE_MS) {
          lastOffRouteAnnounceAt = now;
          const ft = Math.round(proj.offRouteFt);
          announce(
            `You appear to be off route. ${ft} feet from the path.`,
            { interrupt: true, dedupeMs: 5000 },
          );
        }
      }
    } else {
      // Only announce "back on route" if we'd previously crossed the
      // off-route threshold; otherwise this fires on every reset.
      if (offRouteCount >= OFF_ROUTE_FIXES) {
        announce("Back on route.", { dedupeMs: 5000 });
      }
      offRouteCount = 0;
    }
  }

  // Find the closest *already-passed* beacon to the user. Used by the
  // backtrack-snap logic; returns null when there are no past beacons
  // (we haven't reached beacon 0 yet) or when the closest is still too
  // far to count as "the user is at it".
  function findNearestPastBeacon(
    pos: LonLat,
  ): { idx: number; distFt: number } | null {
    if (!trip || beaconIdx === 0) return null;
    const beacons = trip.tune.result.beacons;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < beaconIdx; i++) {
      const d = haversineFt(pos, beacons[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    return { idx: bestIdx, distFt: bestDist };
  }

  // Backtrack snap-back. If the user lingers near a past beacon for
  // several consecutive fixes, rewind beaconIdx so the audio engine
  // re-targets the beacon AFTER the one they returned to.
  function checkBacktrack(pos: LonLat): void {
    const nearest = findNearestPastBeacon(pos);
    if (!nearest || nearest.distFt > BACKTRACK_RADIUS_FT) {
      backtrackCandidate = null;
      return;
    }
    if (backtrackCandidate && backtrackCandidate.idx === nearest.idx) {
      backtrackCandidate.count += 1;
    } else {
      backtrackCandidate = { idx: nearest.idx, count: 1 };
    }
    if (backtrackCandidate.count >= BACKTRACK_FIXES) {
      snapToBeacon(pos, nearest.idx);
      backtrackCandidate = null;
    }
  }

  function snapToBeacon(pos: LonLat, pastIdx: number): void {
    if (!trip) return;
    const newBeaconIdx = pastIdx + 1;
    // No-op when the user is genuinely between current beacons; the
    // nearest-past-beacon is just the one immediately behind them.
    if (newBeaconIdx >= beaconIdx) return;

    beaconIdx = newBeaconIdx;

    // Re-arm crossing announcements that are now ahead of us again, so
    // the user gets warned about them on the second approach.
    if (routeCumFt.length && trip.crossings && trip.crossings.length) {
      const proj = projectPointOntoPolylineFt(
        pos, trip.route.coords, routeCumFt,
      );
      const userAlongFt = proj.distanceAlongRouteFt;
      const reArmed = new Set<number>();
      for (const i of crossingsAnnounced) {
        const c = trip.crossings[i];
        if (c.distanceAlongRouteFt <= userAlongFt + PASSED_FT) {
          // Crossing is at or behind us; keep it muted.
          reArmed.add(i);
        }
      }
      crossingsAnnounced = reArmed;
    }

    announce(
      `Returning to beacon ${pastIdx + 1} of ${totalBeacons - 1}.`,
      { interrupt: true, dedupeMs: 5000 },
    );
  }

  async function start(): Promise<void> {
    if (running || !trip) return;
    error = null;
    try {
      // 1. Permissions (must be from this user-gesture handler).
      await requestOrientationPermission();

      // 2. Audio context (also requires user gesture).
      engine = new AudioEngine({ mode, panMode });
      await engine.init();

      // 3. Sensors.
      const handle = await startSensors();
      stopSensors = handle.stop;

      unsubPos = handle.position.subscribe((p) => {
        if (!p) return;
        position = p;
        if (heading) update(p.position, heading.headingDeg);
      });
      unsubHeading = handle.heading.subscribe((h) => {
        if (!h) return;
        heading = h;
        if (position) update(position.position, h.headingDeg);
      });

      // 4. Audio loop.
      engine.start();

      // 5. Wake lock.
      await acquireWakeLock();

      running = true;
      // Fold the crossings count into the start announcement. Plan.svelte
      // also speaks a "Route ready... N street crossings..." summary, but
      // that one races with this announcement and gets cancelled by the
      // `interrupt: true` here on fast devices. Surfacing the count here
      // guarantees it's spoken even if the Plan summary got cut off.
      const beaconCount = Math.max(0, totalBeacons - 1);
      const crossingCount = trip.crossings?.length ?? 0;
      const beaconPhrase = beaconCount === 1 ? "1 beacon" : `${beaconCount} beacons`;
      const crossingPhrase =
        crossingCount === 0
          ? "no crossings"
          : crossingCount === 1
            ? "1 crossing"
            : `${crossingCount} crossings`;
      announce(
        `Navigation started. ${beaconPhrase} and ${crossingPhrase} ahead. ` +
          `Walk to bring the audio to the centre of your hearing.`,
        { interrupt: true },
      );
    } catch (e) {
      error = `Could not start: ${(e as Error).message}`;
      announce(error, { interrupt: true });
      await stop();
    }
  }

  async function stop(): Promise<void> {
    running = false;
    if (engine) {
      await engine.stop();
      engine = null;
    }
    if (unsubPos) { unsubPos(); unsubPos = null; }
    if (unsubHeading) { unsubHeading(); unsubHeading = null; }
    if (stopSensors) { await stopSensors(); stopSensors = null; }
    await releaseWakeLock();
  }

  function changeMode(m: AudioMode): void {
    mode = m;
    engine?.setMode(m);
    announce(m === "continuous" ? "Continuous tone." : "Rhythmic mode.", {
      dedupeMs: 500,
    });
  }

  function changePanMode(p: PanMode): void {
    panMode = p;
    engine?.setPanMode(p);
    announce(p === "stereo" ? "Stereo panning." : "HRTF spatial panning.", {
      dedupeMs: 500,
    });
  }

  onDestroy(() => { void stop(); });

  function fmtBearing(diff: number | null): string {
    if (diff == null) return "--";
    const abs = Math.abs(diff);
    if (abs < 10) return "straight ahead";
    if (diff > 0) return `${Math.round(abs)}° to your right`;
    return `${Math.round(abs)}° to your left`;
  }
</script>

<section class="screen" aria-labelledby="nav-title">
  <h1 id="nav-title">Navigate</h1>

  {#if !trip}
    <p>No trip planned.</p>
    <button type="button" onclick={onExit}>Back to plan</button>
  {:else}
    <p class="route">
      {trip.startLabel ?? "Start"} <span aria-hidden="true">→</span> {trip.endLabel ?? "End"}
    </p>

    <RouteMap
      routeCoords={trip.route.coords}
      beacons={trip.tune.result.beacons}
      nextBeaconIdx={beaconIdx}
      userPos={position?.position ?? null}
      accuracyM={position?.accuracyM ?? null}
      arrivalRadiusFt={ARRIVAL_RADIUS_FT}
      crossings={trip.crossings ?? []}
    />

    {#if !running && !arrived}
      {#if error}
        <p class="muted">Navigation could not start.</p>
        <button type="button" class="primary big" onclick={() => void start()}>
          Retry
        </button>
      {:else if autoStarted}
        <p class="muted">Navigation paused.</p>
        <button type="button" class="primary big" onclick={() => void start()}>
          Resume
        </button>
      {:else}
        <p class="muted">Starting navigation...</p>
      {/if}
    {:else if running}
      <div class="status-grid" role="group" aria-label="Navigation status">
        <div class="cell">
          <span class="label">Beacon</span>
          <span class="value">{beaconIdx} / {totalBeacons - 1}</span>
        </div>
        <div class="cell">
          <span class="label">Distance</span>
          <span class="value">
            {distanceFt == null ? "--" : `${Math.round(distanceFt)} ft`}
          </span>
        </div>
        <div class="cell wide">
          <span class="label">Direction</span>
          <span class="value">{fmtBearing(bearingDiff)}</span>
        </div>
        <div class="cell">
          <span class="label">GPS</span>
          <span class="value">
            {position == null
              ? "..."
              : `±${Math.round(position.accuracyM)} m`}
          </span>
        </div>
        <div class="cell">
          <span class="label">Heading</span>
          <span class="value">
            {heading == null
              ? "..."
              : `${Math.round(heading.headingDeg)}° (${heading.source})`}
          </span>
        </div>
      </div>

      <fieldset class="mode-switch">
        <legend>Audio mode</legend>
        <button type="button" class:selected={mode === "continuous"}
                aria-pressed={mode === "continuous"}
                onclick={() => changeMode("continuous")}>Continuous</button>
        <button type="button" class:selected={mode === "rhythmic"}
                aria-pressed={mode === "rhythmic"}
                onclick={() => changeMode("rhythmic")}>Rhythmic</button>
      </fieldset>

      <fieldset class="mode-switch">
        <legend>Spatial</legend>
        <button type="button" class:selected={panMode === "stereo"}
                aria-pressed={panMode === "stereo"}
                onclick={() => changePanMode("stereo")}>Stereo</button>
        <button type="button" class:selected={panMode === "hrtf"}
                aria-pressed={panMode === "hrtf"}
                onclick={() => changePanMode("hrtf")}>HRTF</button>
      </fieldset>

      <button type="button" class="danger big" onclick={stop}>Stop</button>
    {:else}
      <p class="ok big">Arrived.</p>
      <button type="button" onclick={onExit}>Back to plan</button>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
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
  .route { font-size: 1.05rem; }
  .muted { color: #777; }
  .ok { color: #1a6; font-weight: 700; }
  .big { font-size: 1.15rem; min-height: 4rem; }
  .error { color: #c33; }

  .status-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
  }
  .cell {
    display: flex;
    flex-direction: column;
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: #f8f8f8;
  }
  .cell.wide { grid-column: 1 / -1; }
  .cell .label { font-size: 0.8rem; color: #555; text-transform: uppercase; }
  .cell .value { font-size: 1.4rem; font-weight: 700; }

  .mode-switch {
    border: 1px solid #ccc;
    border-radius: 0.5rem;
    padding: 0.5rem;
    display: flex;
    gap: 0.5rem;
  }
  .mode-switch legend { padding: 0 0.25rem; font-weight: 600; }
  .mode-switch button { flex: 1; min-height: 3rem; }

  button {
    min-height: 2.75rem;
    padding: 0.6rem 1rem;
    font-size: 1rem;
    border: 1px solid #444;
    background: #fff;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  button.primary {
    background: #1a6; color: #fff; border-color: #1a6; font-weight: 700;
  }
  button.danger {
    background: #c33; color: #fff; border-color: #c33; font-weight: 700;
  }
  button.selected, [aria-pressed="true"] {
    background: #ddeeff; border-color: #246;
  }
</style>
