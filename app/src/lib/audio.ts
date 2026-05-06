/**
 * Spatial audio guidance engine.
 *
 *     [ToneBuffer] -> [Source] -> [Panner] -> [DistGain] -> [Gate] -> [Master] -> dest
 *                                    ^           ^           ^
 *                                    |           |           |
 *                              lateral cue    distance     on/off-axis
 *                                          attenuation    envelope
 *
 * Two panner implementations are runtime-swappable for A/B testing:
 *
 *   - "stereo" (default): StereoPannerNode. Hard left/right pan via
 *     constant-power pan law. Audible on phone speakers and headphones,
 *     no inter-aural cues so front/back are disambiguated only by the
 *     alignment-driven gate gain (loud = facing it, quiet = behind).
 *
 *   - "hrtf": PannerNode with panningModel = "HRTF". Full 3D binaural
 *     spatialization via head-related transfer function; positions the
 *     beacon in space and rotates the listener with the user's heading.
 *     Subtle on phone speakers (inter-aural delay needs >~12 cm spacing
 *     to register), more present on headphones. Front/back disambiguated
 *     by HRTF spectral cues.
 *
 * Distance attenuation is always done by the dedicated DistGain stage so
 * the two modes are otherwise apples-to-apples.
 *
 * All numeric updates are smoothed with `setTargetAtTime` over ~150 ms so
 * frequent location/heading ticks don't pop or zip.
 *
 * Two modes:
 *   - "continuous" (default): always-on tone, gain modulated by alignment.
 *   - "rhythmic"  : tone gated into pulses; period shrinks as you face
 *                   directly at the beacon, and within ~14 deg of on-axis
 *                   the gate stays fully open (continuous tone) so the
 *                   user has an unambiguous "you're facing it" cue.
 */

import type { LonLat } from "./beacon";
import { bearingDeg } from "./beacon";

const SMOOTH_TC = 0.15;          // seconds, AudioParam setTargetAtTime time const

// Distance attenuation. Gentler than the previous HRTF panner's inverse
// model so a beacon 50-100 m away is still clearly audible.
const REF_DIST_M = 20;
const DIST_ROLLOFF = 0.3;
const DIST_GAIN_FLOOR = 0.4;

// At >= this alignment (cos of off-axis angle) the rhythmic gate stops
// pulsing and holds open: the user gets a continuous tone meaning "you
// are facing the beacon". 0.97 ~= within 14 deg of dead-on.
const ALIGN_CONTINUOUS_THRESHOLD = 0.97;

export type AudioMode = "continuous" | "rhythmic";
export type PanMode = "stereo" | "hrtf";

export interface AudioEngineOptions {
  mode?: AudioMode;
  panMode?: PanMode;
  masterGain?: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private panner: StereoPannerNode | PannerNode | null = null;
  private distanceGain: GainNode | null = null;
  private gate: GainNode | null = null;        // alignment / rhythm gate
  private toneSrc: AudioBufferSourceNode | null = null;
  private toneBuf: AudioBuffer | null = null;
  private pingBuf: AudioBuffer | null = null;
  private finalBuf: AudioBuffer | null = null;

  private mode: AudioMode;
  private panMode: PanMode;
  private gateMasterGain = 1;
  private rhythmTimer: number | null = null;
  private alignment = 0;       // 0 = pointing wrong way, 1 = on-axis
  private lastPos: LonLat | null = null;
  private lastBeacon: LonLat | null = null;
  private lastHeading = 0;
  private running = false;

  constructor(opts: AudioEngineOptions = {}) {
    this.mode = opts.mode ?? "continuous";
    this.panMode = opts.panMode ?? "stereo";
    this.gateMasterGain = opts.masterGain ?? 0.85;
  }

  /** Lazy-initialize the AudioContext. MUST be called from a user gesture. */
  async init(): Promise<void> {
    if (this.ctx) return;
    const Ctor: typeof AudioContext =
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext ?? window.AudioContext;
    this.ctx = new Ctor();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // Node graph: source -> stereo pan -> distance gain -> gate -> master -> dest
    this.master = this.ctx.createGain();
    this.master.gain.value = this.gateMasterGain;
    this.master.connect(this.ctx.destination);

    this.gate = this.ctx.createGain();
    this.gate.gain.value = 0;        // start silent until start()
    this.gate.connect(this.master);

    this.distanceGain = this.ctx.createGain();
    this.distanceGain.gain.value = 1;
    this.distanceGain.connect(this.gate);

    this.panner = this.createPanner(this.panMode);
    this.panner.connect(this.distanceGain);

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
    if (!this.ctx || !this.panner || !this.distanceGain) return;

    this.lastPos = userPos;
    this.lastBeacon = beaconPos;
    this.lastHeading = headingDeg;

    const t = this.ctx.currentTime;

    // Off-axis angle in radians: 0 = beacon dead ahead, +pi/2 = beacon
    // directly to the user's right, -pi/2 = directly to the left, +/-pi
    // = directly behind.
    const beaconBearing = bearingDeg(userPos, beaconPos);
    const off = ((beaconBearing - headingDeg + 540) % 360) - 180;
    const offRad = (off * Math.PI) / 180;

    const lat0 = (userPos[1] * Math.PI) / 180;
    const eastM =
      ((beaconPos[0] - userPos[0]) * Math.PI / 180) * 6_378_137 * Math.cos(lat0);
    const northM = ((beaconPos[1] - userPos[1]) * Math.PI / 180) * 6_378_137;

    if (this.panner instanceof StereoPannerNode) {
      // Stereo pan: sin(off) maps front/back to 0 and the sides to +/-1.
      // Front and back collide on the pan axis but the alignment-driven
      // gate gain (cos(off), below) disambiguates them by volume.
      setSmooth(this.panner.pan, Math.sin(offRad), t);
    } else {
      // HRTF: place beacon in 3D listener space, rotate listener with
      // user's heading. Distance attenuation is handled by distanceGain
      // (the panner has rolloffFactor = 0).
      const hrtf = this.panner;
      setSmooth(hrtf.positionX, eastM, t);
      setSmooth(hrtf.positionY, 0, t);
      setSmooth(hrtf.positionZ, -northM, t);

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
        const legacy = lis as unknown as {
          setPosition: (x: number, y: number, z: number) => void;
          setOrientation: (
            fx: number, fy: number, fz: number,
            ux: number, uy: number, uz: number,
          ) => void;
        };
        legacy.setPosition(0, 0, 0);
        legacy.setOrientation(fx, 0, fz, 0, 1, 0);
      }
    }

    // Distance attenuation: gentle inverse curve so a 50-100 m beacon
    // stays clearly audible; floors out past ~300 m.
    const distM = Math.hypot(eastM, northM);
    const dg = Math.max(
      DIST_GAIN_FLOOR,
      REF_DIST_M / (REF_DIST_M + DIST_ROLLOFF * Math.max(0, distM - REF_DIST_M)),
    );
    setSmooth(this.distanceGain.gain, dg, t);

    // Alignment in [0, 1]: 1 = facing the beacon, 0 = facing exactly
    // away. Drives the gate (continuous mode volume, rhythmic mode
    // pulse rate).
    this.alignment = Math.max(0, Math.cos(offRad));
    this.applyAlignment(this.alignment);
  }

  /** Switch between continuous and rhythmic guidance. */
  setMode(mode: AudioMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.stopRhythmScheduler();
    this.applyAlignment(this.alignment);
  }

  /** Switch between stereo and HRTF panning. Hot-swaps the panner node. */
  setPanMode(mode: PanMode): void {
    if (this.panMode === mode) return;
    this.panMode = mode;
    if (!this.ctx || !this.distanceGain) return;

    if (this.toneSrc) {
      try { this.toneSrc.disconnect(); } catch { /* not connected */ }
    }
    if (this.panner) {
      try { this.panner.disconnect(); } catch { /* not connected */ }
    }
    this.panner = this.createPanner(mode);
    this.panner.connect(this.distanceGain);
    if (this.toneSrc && this.running) {
      this.toneSrc.connect(this.panner);
    }
    if (this.lastPos && this.lastBeacon) {
      this.setUserPose(this.lastPos, this.lastBeacon, this.lastHeading);
    }
  }

  private createPanner(mode: PanMode): StereoPannerNode | PannerNode {
    if (!this.ctx) throw new Error("AudioContext not initialised");
    if (mode === "hrtf") {
      const p = this.ctx.createPanner();
      p.panningModel = "HRTF";
      p.distanceModel = "inverse";
      p.refDistance = 1;
      p.rolloffFactor = 0;     // distance handled by distanceGain stage
      p.maxDistance = 10_000;
      return p;
    }
    const p = this.ctx.createStereoPanner();
    p.pan.value = 0;
    return p;
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
    } else if (a >= ALIGN_CONTINUOUS_THRESHOLD) {
      // Inside the on-axis cone: drop the pulses and hold the gate open
      // so the user hears an unbroken tone -- the "you're facing it" cue.
      this.stopRhythmScheduler();
      this.gate.gain.cancelScheduledValues(t);
      setSmooth(this.gate.gain, 1, t, SMOOTH_TC);
    } else {
      // Off-axis: pulse rate scales with alignment. Make sure a scheduler
      // is running.
      this.ensureRhythmScheduler();
    }
  }

  private ensureRhythmScheduler(): void {
    if (this.rhythmTimer != null || !this.ctx || !this.gate) return;
    const tick = () => {
      if (!this.ctx || !this.gate || !this.running || this.mode !== "rhythmic") {
        return;
      }
      // If we've slipped into the on-axis cone since the last tick, hand
      // off to applyAlignment which will hold the gate open.
      if (this.alignment >= ALIGN_CONTINUOUS_THRESHOLD) {
        this.rhythmTimer = null;
        this.applyAlignment(this.alignment);
        return;
      }
      // Period: 1000 ms at off-axis -> 180 ms just below the continuous
      // threshold. Curve is non-linear so the speed-up accelerates as
      // the user gets close to dead-on.
      const a = this.alignment;
      const period = 1.0 - 0.82 * Math.pow(a, 0.6);
      // Pulse width grows with alignment so the duty cycle visibly
      // climbs toward "always on" before flipping fully continuous.
      const pulse = 0.06 + 0.18 * a;
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
  // at 3 Hz. The detuning gives a subtle, non-headache-inducing chorus; the
  // tremolo provides a slow rhythmic anchor that makes "is the audio
  // moving across my head?" easy to detect.
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
