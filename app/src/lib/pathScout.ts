/**
 * Path Scout: on-device YOLO-seg curb / sidewalk segmentation that fires
 * when the user lifts the phone from flat to vertical (i.e. "look around").
 *
 * Two pieces:
 *   1. A thin wrapper around the iOS `PathScout` Capacitor plugin
 *      (see app/ios/App/App/PathScout.swift) that owns the camera + Core
 *      ML inference + open-path analysis and returns a single guidance
 *      sentence ready to be spoken.
 *   2. A posture detector that watches DeviceOrientationEvent.beta and
 *      fires `onLift` when beta transitions from "flat" (|beta| < ~30°)
 *      to "vertical" (beta > ~60°), and `onLower` on the reverse. The
 *      hysteresis bands + dwell time stop a wobble at the boundary from
 *      retriggering inference every 50 ms.
 *
 * Web / Android safety: the plugin call resolves to `available: false`
 * on anything that isn't iOS-with-the-model-bundled, so callers can
 * unconditionally hide the UI when `isAvailable()` returns false.
 */
import { registerPlugin } from "@capacitor/core";

export interface PathScoutPlugin {
  isAvailable(): Promise<{ available: boolean; modelPath: string }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  scan(): Promise<ScanResult>;
}

export interface ScanResult {
  /** Ready-to-speak sentence combining curb + path direction guidance. */
  guidance: string;
  /** "left" | "center" | "right" | "unknown" */
  direction: string;
  /** "strong" | "weak" | "none" */
  intensity: string;
  /** 0..1, fraction of frame that is sidewalk. */
  sidewalkArea: number;
  /** 0..1, fraction of frame that is road. */
  roadArea: number;
  /** Curb edge directly in front of the user. */
  curbDownAhead: boolean;
  curbUpAhead: boolean;
  /** Rough feet to the nearest curb edge (null if not in front). */
  curbDownDistFt: number | null;
  curbUpDistFt: number | null;
  /** Curb visible at all (not just in the front fan). */
  curbDownPresent: boolean;
  curbUpPresent: boolean;
}

// The Capacitor proxy works fine even when the native side is absent;
// every method call will reject, which we catch in `safeIsAvailable`.
const Native = registerPlugin<PathScoutPlugin>("PathScout");

export async function safeIsAvailable(): Promise<boolean> {
  try {
    const r = await Native.isAvailable();
    return !!r.available;
  } catch {
    return false;
  }
}

export async function startCamera(): Promise<void> {
  await Native.start();
}

export async function stopCamera(): Promise<void> {
  try { await Native.stop(); } catch { /* ok */ }
}

export async function scan(): Promise<ScanResult | null> {
  try {
    return await Native.scan();
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Posture detector: flat <-> vertical transition watcher                     //
// --------------------------------------------------------------------------- //

export interface PostureWatcherOptions {
  /** Fired when the user lifts the phone from flat to vertical. */
  onLift: () => void;
  /** Fired when the phone returns to flat. */
  onLower: () => void;
  /** Optional: angles (in degrees). Defaults are tuned for held-portrait. */
  flatMaxBetaDeg?: number;     // |beta| below this == flat (default 30)
  verticalMinBetaDeg?: number; // beta above this == vertical (default 60)
  dwellMs?: number;            // must hold the new state this long (default 250)
}

export interface PostureWatcher {
  stop: () => void;
}

type Posture = "flat" | "vertical" | "between";

/**
 * Returns a watcher that calls `onLift` exactly once each time the
 * phone goes from a sustained flat orientation to a sustained vertical
 * one, and `onLower` for the reverse. Caller is responsible for awaiting
 * `requestOrientationPermission()` first on iOS.
 */
export function watchPosture(opts: PostureWatcherOptions): PostureWatcher {
  const flatMax = opts.flatMaxBetaDeg ?? 30;
  const vertMin = opts.verticalMinBetaDeg ?? 60;
  const dwell = opts.dwellMs ?? 250;

  let lastReported: Posture = "between";
  let pendingPosture: Posture = "between";
  let pendingSince = 0;

  const onOrient = (e: DeviceOrientationEvent) => {
    const beta = e.beta;
    if (beta == null || Number.isNaN(beta)) return;

    let current: Posture;
    if (Math.abs(beta) < flatMax) current = "flat";
    else if (beta > vertMin) current = "vertical";
    else current = "between";

    const now = Date.now();
    if (current !== pendingPosture) {
      pendingPosture = current;
      pendingSince = now;
      return;
    }
    // Same as before -- only commit after dwell.
    if (now - pendingSince < dwell) return;
    if (pendingPosture === lastReported) return;

    const prev = lastReported;
    lastReported = pendingPosture;
    if (prev === "flat" && pendingPosture === "vertical") opts.onLift();
    else if (prev === "vertical" && pendingPosture === "flat") opts.onLower();
    // flat→between or between→vertical etc. are not user-meaningful.
  };

  window.addEventListener("deviceorientation", onOrient);
  window.addEventListener(
    "deviceorientationabsolute" as keyof WindowEventMap,
    onOrient as EventListener,
  );

  return {
    stop: () => {
      window.removeEventListener("deviceorientation", onOrient);
      window.removeEventListener(
        "deviceorientationabsolute" as keyof WindowEventMap,
        onOrient as EventListener,
      );
    },
  };
}
