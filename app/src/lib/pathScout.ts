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

/** Inference engines the native plugin can run the same model through. */
export type PathScoutEngine = "coreml" | "onnx";

export interface EngineAvailability {
  coreml: boolean;
  onnx: boolean;
}

export interface PathScoutPlugin {
  isAvailable(): Promise<{
    available: boolean;
    modelPath: string;
    engines?: EngineAvailability;
  }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  scan(opts?: { preview?: boolean; engine?: PathScoutEngine }): Promise<ScanResult>;
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
  /**
   * Debug-only: base64 JPEG (no data: prefix) of the camera frame with the
   * segmentation masks overlaid. Present only when scan was called with
   * `{ preview: true }`.
   */
  previewJpeg?: string;
  /** Which engine actually ran this scan ("coreml" | "onnx"). */
  engine?: PathScoutEngine;
  /** Wall-clock inference time in milliseconds, for the CoreML/ONNX A/B. */
  latencyMs?: number;
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

/**
 * Which engines the native side has bundled. Used to enable/disable the
 * CoreML vs ONNX toggle so we never request an engine that didn't ship.
 * Returns both-false when the plugin is absent (web / Android today).
 */
export async function availableEngines(): Promise<EngineAvailability> {
  try {
    const r = await Native.isAvailable();
    return r.engines ?? { coreml: !!r.available, onnx: false };
  } catch {
    return { coreml: false, onnx: false };
  }
}

export async function startCamera(): Promise<void> {
  await Native.start();
}

export async function stopCamera(): Promise<void> {
  try { await Native.stop(); } catch { /* ok */ }
}

export async function scan(
  opts?: { preview?: boolean; engine?: PathScoutEngine },
): Promise<ScanResult | null> {
  try {
    return await Native.scan(opts);
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
  const flatMax = opts.flatMaxBetaDeg ?? 35;
  const vertMin = opts.verticalMinBetaDeg ?? 50;
  const dwell = opts.dwellMs ?? 200;

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
    // Fire on *reaching* a terminal band, not on an adjacent flat<->vertical
    // pair. A natural, slow lift dwells in the "between" band (30-60 deg) long
    // enough to commit it, so a strict flat->vertical check would miss the
    // lift entirely and only a fast flick would ever trigger. Treating
    // "between" as a neutral pass-through fixes that: any move into "vertical"
    // is a lift, any move into "flat" is a lower. Re-entry while already
    // active is harmless -- onPathScoutLift/Lower guard on pathScoutActive.
    if (pendingPosture === "vertical" && prev !== "vertical") opts.onLift();
    else if (pendingPosture === "flat" && prev !== "flat") opts.onLower();
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
