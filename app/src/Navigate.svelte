<script lang="ts">
  import { onDestroy } from "svelte";

  import {
    bearingDeg,
    haversineFt,
    type LonLat,
  } from "./lib/beacon";
  import {
    AudioEngine,
    type AudioMode,
    type BeaconSound,
    type PanMode,
  } from "./lib/audio";
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
  import {
    safeIsAvailable as pathScoutIsAvailable,
    scan as pathScoutScan,
    startCamera as pathScoutStartCamera,
    stopCamera as pathScoutStopCamera,
    watchPosture,
    type PostureWatcher,
  } from "./lib/pathScout";
  import type { Trip } from "./lib/storage";
  import RouteMap from "./RouteMap.svelte";

  interface Props {
    trip: Trip | null;
    onExit: () => void;
  }

  let { trip, onExit }: Props = $props();

  // Adaptive arrival radius. NYC urban-canyon GPS routinely reports ±15-25 m
  // accuracy, which is 50-80 ft -- *bigger* than any reasonable fixed
  // arrival radius. We size the radius to ~1.5x current GPS accuracy,
  // floored at MIN_ARRIVAL_FT (open-sky / good-fix case) and capped at
  // MAX_ARRIVAL_FT (an inhumane reading shouldn't make every beacon
  // 200 ft "arrival"). This same radius is used for backtrack detection
  // so "at this beacon" means the same thing in both directions.
  const MIN_ARRIVAL_FT = 15;
  const MAX_ARRIVAL_FT = 50;
  const ARRIVAL_ACCURACY_MULTIPLIER = 1.5;

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

  // Snap-to-route (map-matching) thresholds. When the toggle is on, we
  // blend the raw GPS reading toward its projection on the route as
  // accuracy degrades. Below SNAP_NO_SNAP_M the raw GPS is trusted as-is;
  // above SNAP_FULL_SNAP_M the user is fully on the polyline; in between
  // we linearly interpolate. We refuse to snap if the raw position is
  // farther than SNAP_MAX_OFFROUTE_FT from the polyline -- the user is
  // genuinely off-route and we shouldn't lie about their position.
  const SNAP_NO_SNAP_M = 8;
  const SNAP_FULL_SNAP_M = 25;
  const SNAP_MAX_OFFROUTE_FT = 75;

  // Re-acquisition: if the user lingers within the current arrival radius
  // of a beacon they've already passed for `BACKTRACK_FIXES` consecutive
  // GPS fixes, snap `beaconIdx` back so we re-target the next beacon
  // AFTER the one they returned to. This recovers from accidental
  // arrival-jitter advances and from genuine wrong-turn backtracks.
  // Backtrack uses the same adaptive radius as arrival so "at beacon"
  // means the same thing in both directions; the debounce here is what
  // prevents transient overlap from triggering a stale snap-back.
  const BACKTRACK_FIXES = 3;

  let beaconIdx = $state(0);
  let distanceFt = $state<number | null>(null);
  let bearingDiff = $state<number | null>(null);
  let position = $state<PositionFix | null>(null);
  let heading = $state<HeadingFix | null>(null);
  // The position we *actually* navigate from -- raw GPS in good conditions,
  // blended toward the route polyline as accuracy degrades (see
  // `effectiveUserPos`). Surfaced to RouteMap so the user dot reflects
  // what the engine believes, not what the GPS bounced to last frame.
  let userMapPos = $state<LonLat | null>(null);
  // Defaults chosen for blind-pedestrian UX: rhythmic separates distance
  // from alignment cleanly (pulse rate = alignment, pulse volume =
  // distance), and HRTF gives front/back disambiguation that StereoPanner
  // can't (StereoPanner collapses front and back to the same center pan,
  // disambiguated only by gate gain). Both can be toggled at runtime.
  let mode = $state<AudioMode>("rhythmic");
  let panMode = $state<PanMode>("hrtf");
  // Default to the original tone for backwards-compatible UX. Users with
  // open-ear hardware (e.g. Meta Ray-Bans) where ITD/ILD cues smear
  // typically get noticeably sharper center-axis discrimination from
  // "tick" or "sonar" -- the toggle below lets them A/B in the field.
  let beaconSound = $state<BeaconSound>("tone");
  // Snap-to-route is on by default: in NYC the urban-canyon GPS error
  // dominates user-experience problems (audio panning hops sideways,
  // arrivals fail to fire). Trusting the route polyline as a prior
  // dramatically stabilises both. Power users can flip to Raw if they
  // want to see what the raw GPS thinks.
  let snapToRoute = $state(true);
  let running = $state(false);
  let error = $state<string | null>(null);
  let arrived = $state(false);

  const totalBeacons = $derived(trip?.tune.result.beacons.length ?? 0);

  // Current arrival radius scales with the latest reported GPS accuracy
  // so the trigger always matches reality on the ground: tight in open
  // sky, generous in urban canyons. Used by both arrival detection and
  // backtrack snap-back for consistency, and surfaced to RouteMap so
  // the visual ring grows/shrinks with the actual trigger threshold.
  const arrivalRadiusFt = $derived.by(() => {
    const a = position?.accuracyM;
    if (a == null || !Number.isFinite(a) || a <= 0) return MIN_ARRIVAL_FT;
    const adaptive = a * FT_PER_M * ARRIVAL_ACCURACY_MULTIPLIER;
    return Math.max(MIN_ARRIVAL_FT, Math.min(MAX_ARRIVAL_FT, adaptive));
  });

  // Cumulative polyline distances in feet, indexed parallel to
  // `trip.route.coords`. Lets `projectPointOntoPolylineFt` answer
  // "how far along the route is the user right now?" in O(coords).
  const routeCumFt = $derived(
    trip ? cumulativePolylineLengthsFt(trip.route.coords) : [],
  );

  // Each beacon's distance along the route polyline. Computed once per
  // trip (the projection runs O(coords) per beacon). Used by
  // `findNearestPastBeacon` so backtrack snap-back picks the actually
  // most-recently-passed beacon -- haversine distance can pick an
  // earlier beacon when the route doubles back or curves tightly,
  // causing a spurious snap to an idx beyond the no-op guard.
  const beaconAlongFts = $derived.by(() => {
    if (!trip || !routeCumFt.length) return [];
    return trip.tune.result.beacons.map(
      (b) =>
        projectPointOntoPolylineFt(b, trip.route.coords, routeCumFt)
          .distanceAlongRouteFt,
    );
  });

  let engine: AudioEngine | null = null;
  let unsubPos: (() => void) | null = null;
  let unsubHeading: (() => void) | null = null;
  let stopSensors: (() => Promise<void>) | null = null;
  let autoStarted = $state(false);
  let crossingsAnnounced: Set<number> = new Set();
  let offRouteCount = 0;
  let lastOffRouteAnnounceAt = 0;
  let backtrackCandidate: { idx: number; count: number } | null = null;

  // Path Scout (iOS-only on-device segmentation). Default OFF: requires the
  // user to bundle the .mlpackage and opt in. When ON, we install a posture
  // watcher; lifting the phone from flat to vertical starts the camera and
  // runs one scan every PATH_SCOUT_INTERVAL_MS while held vertical. The
  // first scan is delayed to give the camera time to autofocus.
  let pathScoutAvailable = $state(false);
  let pathScoutEnabled = $state(false);
  let pathScoutActive = $state(false);  // currently scanning (phone vertical)
  let postureWatcher: PostureWatcher | null = null;
  let pathScoutLoopHandle: ReturnType<typeof setTimeout> | null = null;
  const PATH_SCOUT_FIRST_DELAY_MS = 700;
  const PATH_SCOUT_INTERVAL_MS = 3000;

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
    userMapPos = null;
  });

  // Lazy availability check (iOS + model bundled). Runs once on mount.
  $effect(() => {
    void pathScoutIsAvailable().then((ok) => {
      pathScoutAvailable = ok;
    });
  });

  // Install / tear down the posture watcher when the user toggles
  // path-scout on/off. The watcher itself is cheap (one event listener);
  // the camera is only started when the phone actually goes vertical.
  $effect(() => {
    if (!pathScoutEnabled) {
      teardownPathScout();
      return;
    }
    if (postureWatcher) return;
    postureWatcher = watchPosture({
      onLift: () => { void onPathScoutLift(); },
      onLower: () => { void onPathScoutLower(); },
    });
  });

  async function onPathScoutLift(): Promise<void> {
    if (pathScoutActive) return;
    pathScoutActive = true;
    try {
      await pathScoutStartCamera();
      // First scan after a short delay so autofocus has settled.
      pathScoutLoopHandle = setTimeout(() => void runPathScoutLoop(),
                                       PATH_SCOUT_FIRST_DELAY_MS);
    } catch (e) {
      announce(`Path scout could not start: ${(e as Error).message}`,
               { interrupt: true });
      pathScoutActive = false;
    }
  }

  async function onPathScoutLower(): Promise<void> {
    if (!pathScoutActive) return;
    pathScoutActive = false;
    if (pathScoutLoopHandle) {
      clearTimeout(pathScoutLoopHandle);
      pathScoutLoopHandle = null;
    }
    await pathScoutStopCamera();
  }

  async function runPathScoutLoop(): Promise<void> {
    if (!pathScoutActive) return;
    const result = await pathScoutScan();
    if (result && result.guidance) {
      // `interrupt: true` so a stale beacon announcement doesn't sit on
      // top of the safety-relevant scout sentence. dedupeMs is long
      // enough that successive "Path is clear, continue straight."
      // calls don't chatter.
      announce(result.guidance, { interrupt: true, dedupeMs: 2500 });
    }
    if (pathScoutActive) {
      pathScoutLoopHandle = setTimeout(() => void runPathScoutLoop(),
                                       PATH_SCOUT_INTERVAL_MS);
    }
  }

  function teardownPathScout(): void {
    if (postureWatcher) {
      postureWatcher.stop();
      postureWatcher = null;
    }
    if (pathScoutLoopHandle) {
      clearTimeout(pathScoutLoopHandle);
      pathScoutLoopHandle = null;
    }
    if (pathScoutActive) {
      pathScoutActive = false;
      void pathScoutStopCamera();
    }
  }

  function nextBeacon(): LonLat | null {
    if (!trip) return null;
    const beacons = trip.tune.result.beacons;
    if (beaconIdx >= beacons.length) return null;
    return beacons[beaconIdx];
  }

  // Map-matching blend: lerp the raw GPS reading toward its projection
  // on the route polyline as accuracy degrades. The route is a strong
  // prior in dense urban areas where GPS routinely drifts 50+ ft
  // sideways. We refuse to snap when the raw position is genuinely
  // far off the polyline -- the user really has wandered, and lying
  // about that would suppress legitimate off-route detection.
  function effectiveUserPos(
    raw: LonLat,
    footPos: LonLat,
    accuracyM: number | null,
    offRouteFt: number,
  ): LonLat {
    if (!snapToRoute) return raw;
    if (accuracyM == null || !Number.isFinite(accuracyM)) return raw;
    if (offRouteFt > SNAP_MAX_OFFROUTE_FT) return raw;
    if (accuracyM <= SNAP_NO_SNAP_M) return raw;
    const t = Math.min(
      1,
      (accuracyM - SNAP_NO_SNAP_M) / (SNAP_FULL_SNAP_M - SNAP_NO_SNAP_M),
    );
    return [
      raw[0] + (footPos[0] - raw[0]) * t,
      raw[1] + (footPos[1] - raw[1]) * t,
    ];
  }

  // `update()` runs on every position AND heading fix so the audio pose
  // and on-screen direction stay smooth at ~30 Hz. The debounced
  // navigation logic (crossing, off-route, backtrack, arrival) MUST only
  // run on real GPS fixes (~1-4 Hz) -- otherwise the per-update counters
  // tick at heading rate and the "3-fix" debounces collapse to ~100 ms,
  // causing rapid-fire snap-backs that interrupt their own TTS.
  function update(
    pos: LonLat,
    headingDeg: number,
    isPositionFix: boolean,
  ): void {
    if (!trip || !engine) return;
    const target = nextBeacon();
    if (!target) return;

    // Project the raw GPS reading onto the route polyline once. The
    // projection drives both the snap-to-route blend below AND the
    // raw-vs-route safety checks (crossings, off-route, backtrack)
    // further down -- those need the *raw* offset, not the snapped one,
    // or off-route detection would silently never fire under snap.
    const proj = routeCumFt.length
      ? projectPointOntoPolylineFt(pos, trip.route.coords, routeCumFt)
      : null;

    // Effective navigation position: raw GPS in good conditions, blended
    // toward the polyline as accuracy degrades. Drives audio pose,
    // distance/bearing display, arrival check, and the on-screen user
    // dot so what the user hears matches what the engine believes.
    const effPos = proj
      ? effectiveUserPos(pos, proj.foot, position?.accuracyM ?? null, proj.offRouteFt)
      : pos;
    userMapPos = effPos;

    const d = haversineFt(effPos, target);
    distanceFt = d;
    const targetBearing = bearingDeg(effPos, target);
    let diff = targetBearing - headingDeg;
    diff = ((diff + 540) % 360) - 180;
    bearingDiff = diff;

    engine.setUserPose(effPos, target, headingDeg);

    // Everything below this line depends on a NEW position; skip on
    // heading-only updates so the debounced safety logic isn't ticked
    // ~30x per second by the gyro/magnetometer stream.
    if (!isPositionFix) return;

    // Feed GPS accuracy into the audio engine so the spatial cue gets
    // attenuated when the fix is unreliable -- avoids "audio confidently
    // pointing at noise" when the user is indoors / urban canyon.
    if (position?.accuracyM != null) {
      engine.setGpsAccuracy(position.accuracyM);
    }

    checkCrossings(proj);
    checkOffRoute(proj);
    checkBacktrack(proj);

    if (d <= arrivalRadiusFt) {
      const isFinal = beaconIdx === totalBeacons - 1;
      if (isFinal) {
        arrived = true;
        engine.playFinal();
        void finalHaptic();
        announce("You have arrived at your destination.", { interrupt: true });
        void stop();
      } else {
        beaconIdx += 1;
        // Clear any in-flight backtrack candidate so a counter that was
        // accumulating against the just-passed beacon doesn't immediately
        // snap us back. Without this, a user who lingers in the overlap
        // zone between two beacons can hear "Beacon N" then "Returning
        // to beacon N" within a few seconds.
        backtrackCandidate = null;
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

  // Find the closest *already-passed* beacon to the user, measured by
  // distance along the route polyline (NOT haversine). Along-route
  // distance is monotonic along the path -- beacon i+1 is always
  // further along than beacon i regardless of how the polyline curves
  // or doubles back. Haversine isn't monotonic, so it can pick
  // beacon[N-2] as "nearest" when the user is genuinely between
  // beacon[N-1] and beacon[N], which then defeats the no-op guard in
  // `snapToBeacon` and causes spurious "Returning to beacon X"
  // announcements.
  function findNearestPastBeacon(
    userAlongFt: number,
  ): { idx: number; distFt: number } | null {
    if (!trip || beaconIdx === 0 || !beaconAlongFts.length) return null;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < beaconIdx; i++) {
      const d = Math.abs(userAlongFt - beaconAlongFts[i]);
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
  // re-targets the beacon AFTER the one they returned to. The radius
  // tracks the same adaptive arrival radius -- consistent definition
  // of "at this beacon" in both directions.
  function checkBacktrack(
    proj: { distanceAlongRouteFt: number } | null,
  ): void {
    if (!proj) return;
    const nearest = findNearestPastBeacon(proj.distanceAlongRouteFt);
    if (!nearest || nearest.distFt > arrivalRadiusFt) {
      backtrackCandidate = null;
      return;
    }
    if (backtrackCandidate && backtrackCandidate.idx === nearest.idx) {
      backtrackCandidate.count += 1;
    } else {
      backtrackCandidate = { idx: nearest.idx, count: 1 };
    }
    if (backtrackCandidate.count >= BACKTRACK_FIXES) {
      snapToBeacon(proj.distanceAlongRouteFt, nearest.idx);
      backtrackCandidate = null;
    }
  }

  function snapToBeacon(userAlongFt: number, pastIdx: number): void {
    if (!trip) return;
    const newBeaconIdx = pastIdx + 1;
    // No-op when the user is genuinely between current beacons; the
    // nearest-past-beacon is just the one immediately behind them.
    if (newBeaconIdx >= beaconIdx) return;

    beaconIdx = newBeaconIdx;

    // Re-arm crossing announcements that are now ahead of us again, so
    // the user gets warned about them on the second approach.
    if (trip.crossings && trip.crossings.length) {
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
      engine = new AudioEngine({ mode, panMode, beaconSound });
      await engine.init();

      // 3. Sensors.
      const handle = await startSensors();
      stopSensors = handle.stop;

      unsubPos = handle.position.subscribe((p) => {
        if (!p) return;
        position = p;
        if (heading) update(p.position, heading.headingDeg, true);
      });
      unsubHeading = handle.heading.subscribe((h) => {
        if (!h) return;
        heading = h;
        if (position) update(position.position, h.headingDeg, false);
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
    teardownPathScout();
    await releaseWakeLock();
  }

  function changePathScout(on: boolean): void {
    pathScoutEnabled = on;
    if (on) {
      announce(
        "Path scout enabled. Lift the phone vertical to scan ahead.",
        { dedupeMs: 1000 },
      );
    } else {
      announce("Path scout off.", { dedupeMs: 1000 });
    }
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

  function changeSnap(on: boolean): void {
    snapToRoute = on;
    announce(on ? "Snap to route enabled." : "Raw GPS.", { dedupeMs: 500 });
  }

  function changeBeaconSound(s: BeaconSound): void {
    beaconSound = s;
    engine?.setBeaconSound(s);
    const label = s === "sonar" ? "Sonar beacon." : s === "tick" ? "Tick beacon." : "Tone beacon.";
    announce(label, { dedupeMs: 500 });
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
      userPos={userMapPos ?? position?.position ?? null}
      accuracyM={position?.accuracyM ?? null}
      arrivalRadiusFt={arrivalRadiusFt}
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
        <legend>Beacon</legend>
        <button type="button" class:selected={beaconSound === "tone"}
                aria-pressed={beaconSound === "tone"}
                onclick={() => changeBeaconSound("tone")}>Tone</button>
        <button type="button" class:selected={beaconSound === "sonar"}
                aria-pressed={beaconSound === "sonar"}
                onclick={() => changeBeaconSound("sonar")}>Sonar</button>
        <button type="button" class:selected={beaconSound === "tick"}
                aria-pressed={beaconSound === "tick"}
                onclick={() => changeBeaconSound("tick")}>Tick</button>
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

      <fieldset class="mode-switch">
        <legend>GPS</legend>
        <button type="button" class:selected={!snapToRoute}
                aria-pressed={!snapToRoute}
                onclick={() => changeSnap(false)}>Raw</button>
        <button type="button" class:selected={snapToRoute}
                aria-pressed={snapToRoute}
                onclick={() => changeSnap(true)}>Snap to route</button>
      </fieldset>

      {#if pathScoutAvailable}
        <fieldset class="mode-switch">
          <legend>Path scout {pathScoutActive ? "(scanning)" : ""}</legend>
          <button type="button" class:selected={!pathScoutEnabled}
                  aria-pressed={!pathScoutEnabled}
                  onclick={() => changePathScout(false)}>Off</button>
          <button type="button" class:selected={pathScoutEnabled}
                  aria-pressed={pathScoutEnabled}
                  onclick={() => changePathScout(true)}>On</button>
        </fieldset>
      {/if}

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
