/**
 * HRTF-spatialized audio guidance engine.
 *
 * Architecture mirrors Soundscape's BeaconAudioEngine, swapping
 * AVAudio3DMixing for Web Audio API's PannerNode (panningModel = "HRTF").
 *
 *     [ToneBuffer] -> [Source] -> [Panner HRTF] -> [Gate] -> [Master] -> dest
 *                                       ^             ^
 *                                       |             |
 *                                  beacon pos    on/off-axis envelope
 *
 *   AudioListener.position = (0,0,0)   (user's local origin)
 *   AudioListener.forward  = heading-derived unit vector
 *   PannerNode.position    = (east_m, 0, -north_m)  beacon offset in metres
 *
 * All numeric updates are smoothed with `setTargetAtTime` over ~150 ms so
 * frequent location/heading ticks don't pop or zip.
 *
 * Two modes:
 *   - "continuous" (default): always-on tone, gain modulated by alignment.
 *   - "rhythmic"  : same tone gated on/off; period shrinks as you face
 *                   directly at the beacon.
 */

import type { LonLat } from "./beacon";
import { bearingDeg } from "./beacon";

const SMOOTH_TC = 0.15;          // seconds, AudioParam setTargetAtTime time const

// Conservative perceptual range (metres) for HRTF distance attenuation. We
// don't want the source to vanish when the user is 200 m from the beacon.
const REF_DISTANCE_M = 5;
const ROLLOFF_FACTOR = 0.6;

export type AudioMode = "continuous" | "rhythmic";

export interface AudioEngineOptions {
  mode?: AudioMode;
  masterGain?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private panner: PannerNode | null = null;
  private gate: GainNode | null = null;        // alignment / rhythm gate
  private toneSrc: AudioBufferSourceNode | null = null;
  private toneBuf: AudioBuffer | null = null;
  private pingBuf: AudioBuffer | null = null;
  private finalBuf: AudioBuffer | null = null;

  private mode: AudioMode;
  private gateMasterGain = 1;
  private rhythmTimer: number | null = null;
  private alignment = 0;       // 0 = pointing wrong way, 1 = on-axis
  private running = false;

  constructor(opts: AudioEngineOptions = {}) {
    this.mode = opts.mode ?? "continuous";
    this.gateMasterGain = opts.masterGain ?? 0.6;
  }

  /** Lazy-initialize the AudioContext. MUST be called from a user gesture. */
  async init(): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext ?? window.AudioContext;
    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // Node graph
    this.master = this.ctx.createGain();
    this.master.gain.value = this.gateMasterGain;
    this.master.connect(this.ctx.destination);

    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;        // start silent until start()
    this.gate.connect(this.master);

    this.panner = this.ctx.createPanner();
    this.panner.panningModel = "HRTF";
    this.panner.distanceModel = "inverse";
    this.panner.refDistance = REF_DISTANCE_M;
    this.panner.rolloffFactor = ROLLOFF_FACTOR;
    this.panner.maxDistance = 10_000;
    this.panner.connect(this.gate);

    // Synthesize buffers up front (cheap, all <1s).
    const sr = this.ctx.sampleRate;
    this.toneBuf = makeToneBuffer(this.ctx, sr);
    this.pingBuf = makePingBuffer(this.ctx, sr, [659.25, 830.61], 0.25);   // E5 + G#5
    this.finalBuf = makePingBuffer(this.ctx, sr, [523.25, 659.25, 783.99], 0.6); // C5 E5 G5
  }

  /** Begin guidance audio. Call after init() + setBeacon() + setUserPose(). */
  start(): void {
    if (!this.ctx || !this.gate || !this.toneBuf || this.running) return;
    this.toneSrc = this.ctx.createBufferSource();
    this.toneSrc.buffer = this.toneBuf;
    this.toneSrc.loop = true;
    if (!this.panner) return;
    this.toneSrc.connect(this.panner);
    this.toneSrc.start();
    this.running = true;
    this.applyAlignment(this.alignment);
  }

  /** Update the user's GPS position and compass heading (deg from north). */
  setUserPose(userPos: LonLat, beaconPos: LonLat, headingDeg: number): void {
    if (!this.ctx || !this.panner) return;

    // Convert beacon offset to local east/north metres.
    const lat0 = (userPos[1] * Math.PI) / 180;
    const eastM =
      ((beaconPos[0] - userPos[0]) * Math.PI / 180) *
      6_378_137 *
      Math.cos(lat0);
    const northM =
      ((beaconPos[1] - userPos[1]) * Math.PI / 180) * 6_378_137;

    const t = this.ctx.currentTime;
    setSmooth(this.panner.positionX, eastM, t);
    setSmooth(this.panner.positionY, 0, t);
    setSmooth(this.panner.positionZ, -northM, t);

    // Listener stays at origin; orientation tracks heading.
    const headingRad = (headingDeg * Math.PI) / 180;
    const fx = Math.sin(headingRad);
    const fz = -Math.cos(headingRad);
    const lis = this.ctx.listener;
    if ("forwardX" in lis) {
      setSmooth(lis.positionX, 0, t);
      setSmooth(lis.positionY, 0, t);
      setSmooth(lis.positionZ, 0, t);
      setSmooth(lis.forwardX, fx, t);
      setSmooth(lis.forwardY, 0, t);
      setSmooth(lis.forwardZ, fz, t);
      setSmooth(lis.upX, 0, t);
      setSmooth(lis.upY, 1, t);
      setSmooth(lis.upZ, 0, t);
    } else {
      // Legacy Safari fallback.
      const legacy = lis as unknown as {
        setPosition: (x: number, y: number, z: number) => void;
        setOrientation: (
          fx: number,
          fy: number,
          fz: number,
          ux: number,
          uy: number,
          uz: number,
        ) => void;
      };
      legacy.setPosition(0, 0, 0);
      legacy.setOrientation(fx, 0, fz, 0, 1, 0);
    }

    // Compute alignment: how directly the user faces the beacon. The HRTF
    // panner already gives binaural cues, but blindfolded testing showed
    // amplitude modulation by alignment is the strongest "you're facing
    // it" signal for non-trained listeners. cos(off) maps 0deg -> +1,
    // 180deg -> -1; clamp to [0, 1] and bias floor to 0.25 so the source
    // never disappears.
    const beaconBearing = bearingDeg(userPos, beaconPos);
    const off = ((beaconBearing - headingDeg + 540) % 360) - 180;
    const dot = Math.cos((off * Math.PI) / 180);
    this.alignment = Math.max(0, dot);
    this.applyAlignment(this.alignment);
  }

  /** Switch between continuous and rhythmic guidance. */
  setMode(mode: AudioMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.stopRhythmScheduler();
    this.applyAlignment(this.alignment);
  }

  /** Play the per-beacon arrival chime. */
  playArrival(): void {
    this.playOneShot(this.pingBuf);
  }

  /** Play the final-destination chord. */
  playFinal(): void {
    this.playOneShot(this.finalBuf);
  }

  /** Stop all sound and disconnect; safe to call repeatedly. */
  async stop(): Promise<void> {
    this.stopRhythmScheduler();
    if (this.toneSrc) {
      try { this.toneSrc.stop(); } catch { /* already stopped */ }
      this.toneSrc.disconnect();
      this.toneSrc = null;
    }
    if (this.gate && this.ctx) {
      const t = this.ctx.currentTime;
      this.gate.gain.cancelScheduledValues(t);
      this.gate.gain.setValueAtTime(0, t);
    }
    this.running = false;
    if (this.ctx) {
      try { await this.ctx.suspend(); } catch { /* ok */ }
    }
  }

  // ----------------------------------------------------------------------- //

  private applyAlignment(a: number): void {
    if (!this.gate || !this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    if (this.mode === "continuous") {
      this.stopRhythmScheduler();
      // Map alignment 0 -> floor (0.25), 1 -> 1. Linear is fine perceptually
      // because we're driving the *envelope*, not the spectral content.
      const target = 0.25 + 0.75 * a;
      setSmooth(this.gate.gain, target, t, SMOOTH_TC);
    } else {
      // Rhythmic: full amplitude when gated open, but the period (and pulse
      // shape) shrinks as alignment grows. Ensure a scheduler is running.
      this.ensureRhythmScheduler();
    }
  }

  private ensureRhythmScheduler(): void {
    if (this.rhythmTimer != null || !this.ctx || !this.gate) return;
    const tick = () => {
      if (!this.ctx || !this.gate || !this.running || this.mode !== "rhythmic") {
        return;
      }
      // Period: 1200 ms at off-axis -> 320 ms when fully aligned.
      const period = 1.2 - 0.88 * this.alignment;
      // Pulse width: 60 ms (sharp blip) off-axis -> 150 ms (sustained) on-axis.
      const pulse = 0.06 + 0.09 * this.alignment;
      const t0 = this.ctx.currentTime + 0.01;
      const g = this.gate.gain;
      g.cancelScheduledValues(t0);
      g.setValueAtTime(0, t0);
      g.linearRampToValueAtTime(1, t0 + 0.015);
      g.setValueAtTime(1, t0 + pulse);
      g.exponentialRampToValueAtTime(0.0001, t0 + pulse + 0.05);
      this.rhythmTimer = window.setTimeout(tick, period * 1000);
    };
    tick();
  }

  private stopRhythmScheduler(): void {
    if (this.rhythmTimer != null) {
      window.clearTimeout(this.rhythmTimer);
      this.rhythmTimer = null;
    }
  }

  private playOneShot(buf: AudioBuffer | null): void {
    if (!this.ctx || !this.master || !buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    src.start();
  }
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function setSmooth(
  param: AudioParam,
  value: number,
  now: number,
  tc: number = SMOOTH_TC,
): void {
  // setTargetAtTime never overshoots and clamps audio glitches; we use it
  // for *every* numeric update so frequent ticks (~4 Hz GPS / ~30 Hz heading)
  // don't produce zipper noise on parameter changes.
  param.setTargetAtTime(value, now, tc);
}

function makeToneBuffer(_ctx: AudioContext, sr: number): AudioBuffer {
  // 2-second loop: two detuned partials (440 Hz + 442 Hz) plus a slow tremolo
  // at 3 Hz. The detuning gives a subtle, non-headache-inducing chorus that
  // localizes well in HRTF; the tremolo provides a slow rhythmic anchor that
  // makes "is the audio moving across my head?" easy to detect.
  const dur = 2.0;
  const n = Math.floor(dur * sr);
  const buf = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr });
  const data = buf.getChannelData(0);
  const f1 = 2 * Math.PI * 440;
  const f2 = 2 * Math.PI * 442;
  const fT = 2 * Math.PI * 3;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tremolo = 0.7 + 0.3 * Math.sin(fT * t);
    const sample =
      0.5 * Math.sin(f1 * t) + 0.5 * Math.sin(f2 * t);
    data[i] = 0.4 * tremolo * sample;
  }
  return buf;
}

function makePingBuffer(
  _ctx: AudioContext,
  sr: number,
  freqs: number[],
  decaySec: number,
): AudioBuffer {
  const n = Math.floor(decaySec * sr);
  const buf = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr });
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Fast attack (~5ms), exponential decay over `decaySec`.
    const env = (1 - Math.exp(-t / 0.005)) * Math.exp(-t / (decaySec / 4));
    let sample = 0;
    for (const f of freqs) sample += Math.sin(2 * Math.PI * f * t);
    data[i] = (0.5 / freqs.length) * env * sample;
  }
  return buf;
}
