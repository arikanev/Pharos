/**
 * Accessibility helpers: speech synthesis, haptics, wake lock, and a shared
 * polite-live-region writable store.
 *
 * Why this exists:
 *   - Users won't be looking at the screen. Every state change must surface
 *     via audio (SpeechSynthesis) and ideally haptics too.
 *   - VoiceOver/TalkBack also read aria-live regions, so we mirror what we
 *     speak into a Svelte store that the App component renders into a
 *     visually-hidden live region. That gives screen-reader users a
 *     verifiable trail and avoids double-speech: SpeechSynthesis is for the
 *     hands-free walker; aria-live is for the sighted/SR-reading reviewer.
 */

import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { writable, type Writable } from "svelte/store";

export const liveAnnouncement: Writable<string> = writable("");

let lastSpoken = "";
let lastSpokenAt = 0;

export interface SpeakOptions {
  /** Drop the message if it's the same as the last one within `dedupeMs`. */
  dedupeMs?: number;
  /** Cancel any in-progress utterance first. */
  interrupt?: boolean;
  /** Skip the SpeechSynthesis call but still update the aria-live region. */
  silent?: boolean;
}

export function announce(message: string, opts: SpeakOptions = {}): void {
  const dedupeMs = opts.dedupeMs ?? 2000;
  const now = Date.now();
  if (message === lastSpoken && now - lastSpokenAt < dedupeMs) return;
  lastSpoken = message;
  lastSpokenAt = now;

  // Update the aria-live region (screen readers pick this up).
  liveAnnouncement.set("");
  // Force the store to fire even if the next set is to the same value.
  queueMicrotask(() => liveAnnouncement.set(message));

  if (opts.silent) return;
  if (typeof speechSynthesis === "undefined") return;
  try {
    if (opts.interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(message);
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
    speechSynthesis.speak(u);
  } catch {
    // SpeechSynthesis isn't critical -- aria-live carries the message too.
  }
}

export async function tickHaptic(): Promise<void> {
  try { await Haptics.impact({ style: ImpactStyle.Light }); } catch { /* web fallback below */ }
  fallbackVibrate(40);
}

export async function arrivalHaptic(): Promise<void> {
  try { await Haptics.impact({ style: ImpactStyle.Medium }); } catch { /* */ }
  fallbackVibrate([60, 40, 60]);
}

export async function crossingHaptic(): Promise<void> {
  // Two heavy taps, then a short pause: distinctly different from the
  // single "you've arrived at a beacon" medium impact.
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy });
    await new Promise((r) => setTimeout(r, 120));
    await Haptics.impact({ style: ImpactStyle.Heavy });
  } catch { /* */ }
  fallbackVibrate([100, 80, 100]);
}

export async function finalHaptic(): Promise<void> {
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch { /* */ }
  fallbackVibrate([100, 60, 100, 60, 200]);
}

function fallbackVibrate(pattern: number | number[]): void {
  const n = (navigator as unknown as { vibrate?: (p: number | number[]) => boolean }).vibrate;
  if (typeof n === "function") n(pattern);
}

// --------------------------------------------------------------------------- //
// Wake lock (keep screen on so OS doesn't suspend timers / audio context)
// --------------------------------------------------------------------------- //

let wakeLock: WakeLockSentinel | null = null;

export async function acquireWakeLock(): Promise<void> {
  if (wakeLock) return;
  const wl = (navigator as unknown as { wakeLock?: WakeLock }).wakeLock;
  if (!wl) return;
  try {
    wakeLock = await wl.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    /* user denied or unsupported; not fatal */
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch { /* */ }
  wakeLock = null;
}

// Re-acquire wake lock when the page comes back to the foreground
// (browsers drop it on visibilitychange -> hidden).
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !wakeLock) {
      void acquireWakeLock();
    }
  });
}
