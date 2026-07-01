# Pharos — Field & Build Test Plan

Pharos is a **spatial-audio pedestrian navigation app for blind / low-vision users**. It plants
audio "beacons" along an OpenStreetMap pedestrian route and pans synthetic tones toward the next
beacon based on the user's heading, with iOS-only **PathScout** camera curb/sidewalk detection on
top. The app is a Capacitor build (Svelte web UI + native iOS/Android).

> ⚠️ There is essentially **no automated test coverage** beyond a single beacon-algorithm parity
> test (`app/test/parity.test.ts`). Field testing is the real safety net — this document is the
> source of truth for what "tested" means.

## Before you start

- **Build target:** open `app/ios/App/App.xcworkspace` (the **workspace**, not the `.xcodeproj` —
  it uses CocoaPods) and deploy to a **physical iPhone**. The simulator has no GPS, compass, or
  camera, so most of this plan can't run there.
- **PathScout is iOS-only** and needs the bundled CoreML model (`PathScout.mlpackage`). The
  OpenPath toggle is greyed out when the model isn't present — that's expected, not a bug.
- **Crossings come from OpenStreetMap** via Overpass. Coverage is uneven; verify a test area has
  crossing data before blaming the app for missing warnings.
- Walk with a sighted buddy for safety when testing blindfolded / audio-only flows.

---

## Part 1 — Where to test (NYC locations)

Pick one route in each environment. Each one breaks a *different* part of the stack (GPS, compass,
beacon density, audio, camera), so coverage across all six is the goal.

| # | Environment | Specific NYC spots | What it stresses |
|---|-------------|--------------------|------------------|
| 1 | **Open sky / wide path** (baseline) | Central Park Great Lawn or Sheep Meadow loop; Hudson River Park promenade | Best-case GPS; sparse beacons + long straights; audio panning over distance. Prove it works here first. |
| 2 | **Winding narrow footpaths** | Central Park Ramble; Bridle Path | Dense beacon clustering on tight S-curves; whether close beacons stay audibly distinct; PathScout on narrow brush-lined paths |
| 3 | **Urban canyon grid** | Financial District (Wall / Broad St); Midtown 6th Ave between towers | GPS multipath (±30–50 ft); compass whip near steel; snap-to-route vs raw; heading-fusion fallback |
| 4 | **Cluttered commercial sidewalk + noise** | Times Square; Herald Square; Broadway commercial blocks | PathScout curb/obstacle detection in clutter; audio clarity vs ~80 dB traffic; dense curbs |
| 5 | **Crossing-dense avenue** | A signalized Manhattan avenue route (e.g. up 8th Ave / Amsterdam) | Crossing warnings: type, tactile paving, audible signal, ~8 s lead time. **Check Overpass coverage first.** |
| 6 | **Elevation / steel / GPS-denied** (edge cases) | Brooklyn Bridge walkway, High Line; a subway mezzanine | Known limits: 2D algorithm vs stairs/grade; compass dead near steel; audio mutes when GPS accuracy >40 m indoors — should degrade gracefully, not crash |

---

## Part 2 — What to test (deliverable goals)

Each goal has a clear pass bar so "done" is unambiguous. File a note (location, device, pass/fail,
notes) for each.

### 0. Build & smoke
Deploy `app/ios/App/App.xcworkspace` to a physical iPhone and complete one full
**Plan → Navigate → "You have arrived"** cycle.
**Pass:** route plans, beacons render on the map, audio plays, final-arrival announcement fires.

### 1. Planning & routing
Plan 10 routes across all three start/destination modes (**Search**, **Coords**, **Map-pin**).
**Pass:** ≥9/10 plan successfully; summary shows beacon count + distance + crossing count; invalid
input shows a clear error (not a hang); OSRM→Valhalla fallback still returns a route when OSRM is
blocked.

### 2. Beacon placement quality
On a straight, a curving, and a winding route, confirm beacon density scales with curvature and the
**Maximum drift** slider visibly changes it.
**Pass:** in-app beacon counts roughly match the Python reference for the same route
(`python central_park_demo.py`); lower drift → more beacons.

### 3. Navigation logic
While walking, verify: beacon **arrival/advancement**, **off-route warning** (drift >50 ft for 3+
GPS fixes → "off route", then "back on route" on return), **backtrack snap-back**, and **final
arrival** chord.
**Pass:** each event fires within spec distance/time; no repeated-announcement chattering on dense
beacon clusters.

### 4. Spatial audio
A/B every toggle on ≥2 hardware types (phone speaker, headphones, open-ear/bone-conduction if
available): **Continuous/Rhythmic**, **Tone/Sonar/Tick**, **Stereo/HRTF**.
**Pass:** tone pans to match your physical heading; distance attenuation is audible; document the
best combo per hardware type.

### 5. Sensor fusion
**Pass:** heading-source label switches to `gps-course` when walking (>1 m/s) and `compass` when
standing still; audio gain ducks when GPS accuracy >40 m and returns to full <10 m (compare urban
canyon vs open sky).

### 6. PathScout / OpenPath (iOS only)
Lift phone from flat to vertical → "scanning" haptic + announcement. Point at a real curb.
**Pass:** detects a **curb-down** within ~2 scans in daylight; CoreML vs ONNX latency A/B logged;
debug preview overlay shows colored segmentation; degrades gracefully at night and when camera
permission is denied.

### 7. Crossings
Walk a crossing-dense route.
**Pass:** crossings on the map match reality; warnings fire ~8 s before each crossing with the
correct type/attributes; low false-positive rate. (Confirm Overpass has data for the area first.)

### 8. Permissions & resilience
Deny **each** permission one at a time — **Location**, **Motion**, **Camera**.
**Pass:** every denial shows a clear message with a working Retry, never a crash. Also: force-quit
mid-trip → the trip rehydrates on relaunch; screen stays awake (wake lock) during navigation.

### 9. Accessibility
Full **VoiceOver** pass of Plan + Navigate; keyboard navigation; haptic patterns.
**Pass:** every control is labeled and reachable; all spoken announcements also appear in the
aria-live region; arrival vs crossing haptics feel distinct.

---

## Reporting

For each goal/location, log: **date · device model · iOS version · location · pass/fail · notes**.
Prioritize anything that crashes, hangs, or silently produces wrong guidance (a blind user can't
see that the audio is wrong) — those are the highest-severity bugs.
