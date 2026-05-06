# Audio assets

The MVP **synthesizes beacon tones at runtime** in
[`src/lib/audio.ts`](../lib/audio.ts) rather than shipping binary `.wav`
files. This keeps the bundle small (~zero KB of audio), avoids licensing
attribution surface area, and lets the tones be parametrically tuned
(frequency, envelope, harmonics) without re-encoding files.

The synthesized sounds are designed to mimic the perceptual shape of
Microsoft Soundscape's "Classic" beacon family:

| Sound       | Synthesis                                                      |
|-------------|----------------------------------------------------------------|
| Tone loop   | Two detuned sine partials at 440 Hz with a slow tremolo (~3 Hz). |
| Off-axis    | Same tone, low-passed at 600 Hz to give a "muffled" character.   |
| Arrival     | Major third (E5 + G#5) with a 250 ms exponential decay.          |
| Final       | Major chord (C5/E5/G5) with a 600 ms decay.                      |

## Swapping in Soundscape's original audio assets

If you'd prefer the original Soundscape sounds (and their slightly more
natural HRTF-friendly spectral content), they live MIT-licensed in the
[Soundscape Community iOS repo](https://github.com/Soundscape-community/Soundscape-iOS).
The relevant files are typically under
`apps/ios/GuideDogs/Code/App/Audio/Beacons/Classic/`:

- `Classic_OnAxis.wav`
- `Classic_OffAxis.wav`
- `Beacon_Found.wav` (arrival ping)

To use them, drop the files in this folder and replace the
`makeToneBuffer()` / `makePingBuffer()` calls in
[`audio.ts`](../lib/audio.ts) with `await loadAsset("./assets/Classic_OnAxis.wav")`
helpers (a one-liner in Vite: `import url from "./Classic_OnAxis.wav"`,
then `fetch(url) -> arrayBuffer -> AudioContext.decodeAudioData`).
