# Pharos

Audio beacon navigation for blind and low-vision walkers, built on top of
the beacon-placement algorithm in
[`beacon_placement.py`](beacon_placement.py) (ported to TypeScript in
[`app/src/lib/beacon.ts`](app/src/lib/beacon.ts), parity-tested against the
Python reference).

Single Svelte + TypeScript codebase that ships as:

- **Progressive Web App** — instant `npm run dev`, no app store
- **iOS app** — Capacitor wraps the same web build, gets native
  CoreLocation + Haptics
- **Android app** — same build, native FusedLocationProvider + Haptics

Live navigation runs **fully offline** after the trip is fetched and cached
to IndexedDB.

## Quick start (PWA)

All `npm` commands run from the [`app/`](app/) directory:

```bash
cd app
npm install
npm run dev          # http://localhost:5173
npm run test         # parity tests against Python reference
npm run build        # production bundle in dist/
npm run preview      # serve dist/ on the network
```

Open the dev URL on your phone over the same Wi-Fi (it binds to all
interfaces). Geolocation needs HTTPS in real browsers; for prototyping use
a tunnel (`cloudflared`, `ngrok`) or `vite preview --host` behind a
reverse proxy with TLS.

## Architecture (1 paragraph)

A user gesture on the **Plan** screen geocodes start/end (Nominatim),
fetches a pedestrian polyline (FOSSGIS OSRM-foot, Valhalla fallback),
runs the autotune to pick `(angle, max_chord, min_spacing)` for the chosen
drift budget, and saves the resulting beacons to IndexedDB. The
**Navigate** screen then opens an `AudioContext`, requests compass +
location permissions, watches GPS, and on every fix updates a Web Audio
`PannerNode` (panningModel `"HRTF"`) so the looping tone localizes toward
the next beacon. When the user is within 15 ft of a beacon a chime plays
and the engine advances. All numeric audio updates are smoothed with
`setTargetAtTime` so frequent ticks don't pop.

## Native builds

### Android

Already scaffolded into [`app/android/`](app/android/) by `npx cap add android`
during initial setup.

```bash
cd app
npm run build
npx cap sync android
npx cap open android      # opens Android Studio
```

In Android Studio, hit **Run** with a connected device or emulator. The
location, vibration, and wake-lock permissions are declared in
[`app/android/app/src/main/AndroidManifest.xml`](app/android/app/src/main/AndroidManifest.xml).

### iOS

You need Xcode + CocoaPods first:

```bash
brew install cocoapods   # one-time
cd app
npx cap add ios          # scaffolds app/ios/ (only run once)
npm run build
npx cap sync ios
npx cap open ios         # opens Xcode
```

Add the following keys to `app/ios/App/App/Info.plist` (Capacitor will
inject boilerplate but you must add the user-facing usage strings):

```xml
<key>NSLocationWhenInUseUsageDescription</key>
<string>Pharos uses your location to guide you along your route.</string>
<key>NSMotionUsageDescription</key>
<string>Pharos uses the compass to pan audio toward the next beacon.</string>
<key>NSCameraUsageDescription</key>
<string>Pharos uses the camera only while Path Scout is on, to detect sidewalks and curbs in front of you.</string>
```

Build for a device (Simulator does not produce real GPS or compass data).

### Path Scout (optional, iOS only)

A separate on-device YOLO11-seg model labels road / sidewalk / curb up
/ curb down from the rear camera. When enabled on the Navigate screen,
lifting the phone from flat to vertical (~90°) triggers a single-shot
scan every ~3 seconds and announces an open-path / curb sentence
("Path is clear, continue straight." / "Curb down 6 feet ahead, step
down cautiously." etc.) via the same `announce()` pipeline.

The same model can run through one of two interchangeable engines,
picked at runtime with the **Engine** toggle on the Navigate screen:

- **Core ML** (`PathScout.mlpackage` -> `.mlmodelc`) via Vision.
- **ONNX** (`PathScout.onnx`) via native ONNX Runtime (`onnxruntime-objc`,
  CPU provider). This is the portable runtime we also hand to Android.

Both feed the *identical* post-processing, so only the inference call
and the reported `latencyMs` differ -- use it to A/B latency and the
"how native is native" question. Each scan returns `engine` + `latencyMs`,
surfaced in the Engine legend and the debug preview card.

One-time setup:

```bash
# 1. From the repo root, convert your trained model. Default emits BOTH
#    PathScout.mlpackage (Core ML) and PathScout.onnx; use --format to
#    limit it (coreml | onnx | both).
python3 -m venv .pathscout-venv
.pathscout-venv/bin/pip install --upgrade ultralytics coremltools onnx
.pathscout-venv/bin/python convert_to_coreml.py /path/to/best.pt
# -> writes ./PathScout.mlpackage and ./PathScout.onnx

# 2. Add the ONNX Runtime pod, then install:
#    (Podfile already lists `pod 'onnxruntime-objc'`)
(cd app/ios/App && pod install)

# 3. Open Xcode (npx cap open ios) and drag BOTH PathScout.mlpackage and
#    PathScout.onnx into the App target. Make sure "Target Membership:
#    App" is checked for each. Xcode compiles the mlpackage into
#    PathScout.mlmodelc and copies PathScout.onnx as a bundled resource.
#    (PathScout.onnx is already wired into app/ios/App/App.xcodeproj.)

# 4. Build + run on a real device (the simulator doesn't have a back camera).
```

The toggle is hidden in the UI until `PathScout.isAvailable()` returns
true, so it stays inert on PWA / Android / iOS-without-the-model. The
Engine buttons enable only for the engines actually bundled.
Implementation: [`app/ios/App/App/PathScoutPlugin.swift`](app/ios/App/App/PathScoutPlugin.swift)
+ [`app/src/lib/pathScout.ts`](app/src/lib/pathScout.ts).

### Path Scout on Android (follow-up)

`PathScout.onnx` is cross-platform and is the only artifact that ports
as-is. Android support is not built yet; it needs a native pipeline
reimplemented in Kotlin (no Swift transpiles):

- CameraX/Camera2 headless frame capture (the `AVCaptureSession` analog).
- `onnxruntime-android` (AAR) loading the same `PathScout.onnx`.
- A Kotlin port of the YOLO-seg post-processing in
  [`PathScoutPlugin.swift`](app/ios/App/App/PathScoutPlugin.swift)
  (decode -> NMS -> mask union -> 3x7 open-path grid -> guidance). The
  math is identical; it's a translation, not a redesign.
- A Capacitor plugin registered in `MainActivity` returning the same
  result dict, so `app/src/lib/pathScout.ts` and the UI work unchanged.

## Project map

```
beacon_placement.py       Python reference algorithm (see ALGORITHM.md)
app/
  src/
    main.ts               bootstrap
    App.svelte            2-screen router + global aria-live region
    Plan.svelte           Plan-a-trip UI
    Navigate.svelte       Live navigation UI
    lib/
      beacon.ts           TS port of beacon_placement.py
      routing.ts          OSRM-foot + Valhalla fallback chain client
      audio.ts            HRTF panner + continuous/rhythmic modes
      sensors.ts          GPS watch + compass/course heading fusion
      a11y.ts             speech, haptics, wake lock, live announcements
      storage.ts          IndexedDB current-trip cache
    assets/
      README.md           notes on synthesized audio + how to swap in
                          Soundscape's original WAVs
  test/
    parity.test.ts        asserts TS == Python on every central_park_*.geojson
```

## Tuning the beacons

The Plan screen exposes a **drift slider** (1–25 ft, default 5). Lower
drift puts more beacons closer together so the chord path hugs the OSM
polyline more tightly. 5 ft sits just inside typical civilian-GPS noise
and is a good default; 1 ft roughly doubles the beacon count.

The autotune internally Pareto-optimizes over `(angle, max_chord,
min_spacing)`; tie-breakers prefer fewer beacons (less audio cognitive
load) and larger min-spacing (fewer "are we there yet?" transitions). See
[`ALGORITHM.md`](ALGORITHM.md) for the full algorithm description.

## Known limitations / out of scope

- No accounts or saved routes (single-trip MVP).
- No POI / obstacle callouts (Soundscape's bigger feature set).
- Routing uses public FOSSGIS OSRM endpoints — fine for prototyping but
  no SLA. Swap `lib/routing.ts` for a paid provider for production.
- iOS DeviceOrientation permission must be requested from a user gesture
  inside `Navigate.svelte`'s **Start** handler — already wired up.
- Synthesized beacon tones, not Soundscape's audio assets. To use the
  originals, see [`app/src/assets/README.md`](app/src/assets/README.md).
