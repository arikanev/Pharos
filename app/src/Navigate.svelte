<script lang="ts">
  import { onDestroy } from "svelte";

  import {
    bearingDeg,
    haversineFt,
    type LonLat,
  } from "./lib/beacon";
  import { AudioEngine, type AudioMode } from "./lib/audio";
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
    finalHaptic,
    releaseWakeLock,
  } from "./lib/a11y";
  import { loadCurrentTrip, type Trip } from "./lib/storage";

  interface Props {
    onExit: () => void;
  }

  let { onExit }: Props = $props();

  // Distance threshold to count a beacon as "arrived". 15 ft is a hair below
  // typical civilian GPS HDOP, so the trigger lands once the user is within
  // the noise floor of being there.
  const ARRIVAL_RADIUS_FT = 15;

  let trip = $state<Trip | null>(null);
  let beaconIdx = $state(0);
  let totalBeacons = $state(0);
  let distanceFt = $state<number | null>(null);
  let bearingDiff = $state<number | null>(null);
  let position = $state<PositionFix | null>(null);
  let heading = $state<HeadingFix | null>(null);
  let mode = $state<AudioMode>("continuous");
  let running = $state(false);
  let error = $state<string | null>(null);
  let arrived = $state(false);

  let engine: AudioEngine | null = null;
  let unsubPos: (() => void) | null = null;
  let unsubHeading: (() => void) | null = null;
  let stopSensors: (() => Promise<void>) | null = null;

  void loadCurrentTrip().then((t) => {
    trip = t;
    if (t) totalBeacons = t.tune.result.beacons.length;
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

  async function start(): Promise<void> {
    if (running || !trip) return;
    error = null;
    try {
      // 1. Permissions (must be from this user-gesture handler).
      await requestOrientationPermission();

      // 2. Audio context (also requires user gesture).
      engine = new AudioEngine({ mode });
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
      announce(
        `Navigation started. ${totalBeacons - 1} beacons ahead. ` +
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

    {#if !running && !arrived}
      <button type="button" class="primary big" onclick={start}>
        Start navigation
      </button>
      <p class="muted small">
        Press Start to begin GPS tracking and audio guidance.
        You'll hear a tone that gets centred in your ears as you face the next beacon.
      </p>
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
  .small { font-size: 0.85rem; }
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
