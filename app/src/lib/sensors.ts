/**
 * GPS + heading fusion for live navigation.
 *
 * Position: Capacitor Geolocation (native CoreLocation / FusedLocationProvider
 * on device, browser Geolocation as PWA fallback). High-accuracy mode is on,
 * which routes through the GNSS chip rather than network/wifi.
 *
 * Heading: blends two sources because neither is reliable on its own:
 *   - DeviceOrientation (compass) -- works while standing still, but on iOS
 *     it requires explicit permission and on Android the magnetometer is
 *     often miscalibrated indoors / near steel.
 *   - GPS course-over-ground -- robust and absolute, but only meaningful
 *     when the user is actually walking (speed > ~1 m/s).
 *
 * Policy: prefer GPS course when speed >= MOVING_SPEED_MPS, otherwise the
 * latest compass heading, otherwise the last known fused heading.
 */

import { Geolocation, type Position } from "@capacitor/geolocation";
import { writable, type Readable } from "svelte/store";

import type { LonLat } from "./beacon";

const MOVING_SPEED_MPS = 1.0;

export interface PositionFix {
  position: LonLat;
  accuracyM: number;
  speedMps: number | null;
  courseDeg: number | null;
  timestamp: number;
}

export interface HeadingFix {
  headingDeg: number;
  source: "gps-course" | "compass" | "last";
  timestamp: number;
}

interface SensorStores {
  position: Readable<PositionFix | null>;
  heading: Readable<HeadingFix | null>;
  errors: Readable<string | null>;
}

interface SensorHandle extends SensorStores {
  stop: () => Promise<void>;
}

export async function requestOrientationPermission(): Promise<boolean> {
  // iOS 13+ requires an explicit permission prompt from a user gesture.
  const D = (window as unknown as {
    DeviceOrientationEvent?: typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
  }).DeviceOrientationEvent;
  if (!D) return false;
  if (typeof D.requestPermission === "function") {
    try {
      const result = await D.requestPermission();
      return result === "granted";
    } catch {
      return false;
    }
  }
  return true; // Android / desktop: no permission gate
}

/**
 * Begin watching GPS + heading. Caller MUST first await
 * `requestOrientationPermission()` from a user-gesture handler if they want
 * compass data on iOS.
 */
export async function startSensors(): Promise<SensorHandle> {
  const positionStore = writable<PositionFix | null>(null);
  const headingStore = writable<HeadingFix | null>(null);
  const errorsStore = writable<string | null>(null);

  let lastCompassDeg: number | null = null;
  let lastFix: PositionFix | null = null;

  const recomputeHeading = () => {
    const now = Date.now();
    if (lastFix && lastFix.speedMps != null
        && lastFix.speedMps >= MOVING_SPEED_MPS
        && lastFix.courseDeg != null) {
      headingStore.set({
        headingDeg: lastFix.courseDeg,
        source: "gps-course",
        timestamp: now,
      });
      return;
    }
    if (lastCompassDeg != null) {
      headingStore.set({
        headingDeg: lastCompassDeg,
        source: "compass",
        timestamp: now,
      });
    }
  };

  // ---- DeviceOrientation listener ---------------------------------------- //
  const orientationListener = (e: DeviceOrientationEvent) => {
    // Prefer iOS's `webkitCompassHeading` (degrees clockwise from true north).
    const ios = (e as unknown as { webkitCompassHeading?: number })
      .webkitCompassHeading;
    let h: number | null = null;
    if (typeof ios === "number" && !Number.isNaN(ios)) {
      h = ios;
    } else if (typeof e.alpha === "number" && !Number.isNaN(e.alpha)) {
      // Android's `alpha` is degrees counter-clockwise from north in the
      // device frame -- invert and normalize.
      h = (360 - e.alpha) % 360;
    }
    if (h != null) {
      lastCompassDeg = h;
      recomputeHeading();
    }
  };
  window.addEventListener(
    "deviceorientationabsolute" as keyof WindowEventMap,
    orientationListener as EventListener,
  );
  window.addEventListener("deviceorientation", orientationListener);

  // ---- Capacitor Geolocation watcher ------------------------------------- //
  let watchId: string | null = null;
  try {
    const perm = await Geolocation.checkPermissions();
    if (perm.location !== "granted") {
      const r = await Geolocation.requestPermissions();
      if (r.location !== "granted") {
        errorsStore.set("Location permission denied");
      }
    }
    watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
      (pos: Position | null, err) => {
        if (err) {
          errorsStore.set(err.message ?? String(err));
          return;
        }
        if (!pos) return;
        const fix: PositionFix = {
          position: [pos.coords.longitude, pos.coords.latitude],
          accuracyM: pos.coords.accuracy ?? Number.POSITIVE_INFINITY,
          speedMps: pos.coords.speed,
          courseDeg: pos.coords.heading,
          timestamp: pos.timestamp,
        };
        lastFix = fix;
        positionStore.set(fix);
        recomputeHeading();
      },
    );
  } catch (e) {
    errorsStore.set(`Geolocation start failed: ${(e as Error).message}`);
  }

  const stop = async () => {
    window.removeEventListener(
      "deviceorientationabsolute" as keyof WindowEventMap,
      orientationListener as EventListener,
    );
    window.removeEventListener("deviceorientation", orientationListener);
    if (watchId != null) {
      try { await Geolocation.clearWatch({ id: watchId }); } catch { /* ok */ }
      watchId = null;
    }
  };

  return {
    position: { subscribe: positionStore.subscribe },
    heading: { subscribe: headingStore.subscribe },
    errors: { subscribe: errorsStore.subscribe },
    stop,
  };
}
