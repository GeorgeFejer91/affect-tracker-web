# Experimental Touch/Trackpad mode

This file is the normative contract for the browser-only movement-feedback prototype. It quantifies how a two-dimensional pointer path is moving and maps those features into the affect display. It is **not** an emotion-recognition, diagnostic, or validated affect-inference system.

## Product behavior and privacy

- `inputSource` is either `manual` or `touch-trace` and is distinct from the manual continuous/step `inputMode`.
- Touch mode is visibly labelled **Experimental Touch/Trackpad**. Shape drives valence (`x`); speed drives arousal (`y`).
- Touch and pen movement are handled using Pointer Events and primary-pointer capture. Mouse hover supplies browser cursor movement, including the OS-accelerated trajectory exposed for laptop touchpads; raw touchpad contacts are unavailable to ordinary webpages.
- Outside experiments, native controls/settings are excluded. During a fullscreen experiment the entire experiment layer is the capture surface. Only the primary pointer is analyzed; extra simultaneous pointers are ignored and logged.
- Selecting touch mode disables Flubber dragging. Keyboard, mouse-button, wheel, and on-screen controls remain observable/logged but do not drive affect.
- Practice movement may update the display, but raw pointer coordinates are written only while an experiment is actively playing. The browser cannot observe other tabs, browser chrome, background pages, or other applications.
- Trace feedback defaults off and is stored only in browser local storage. The input source is likewise browser-local and intentionally absent from portable settings version 1.

## Acquisition and segmentation

For each dispatched Pointer Event, use `getCoalescedEvents()` when available and fall back to the event itself. Never use predicted events. Retain pointer/stroke identifiers, phase/type, `performance.now()` time, client and viewport-normalized positions, pressure, button state, coalesced index, and viewport dimensions.

Normalize distance by `D = hypot(viewportWidth, viewportHeight)`. Reject duplicate points, non-monotonic times, and intervals below 1 ms. A gap over 400 ms ends the segment. Resize, orientation, cancellation, visibility, and fullscreen changes reset filters and segmentation so coordinate frames are never mixed.

## Speed to arousal

Filter normalized x/y independently using a local 1€ filter with `minCutoff=1 Hz`, `beta=0.007`, and `derivativeCutoff=1 Hz`. Let filtered segment speed be `hypot(dx,dy)/dtSeconds`, reject isolated spikes with a five-sample median, and use `speedFeature=log1p(speed)` for adaptation.

## Shape to valence

Resample geometry every `0.005D` and retain the latest 32 resampled segments. For consecutive unit vectors use `theta=atan2(cross(u,v),dot(u,v))`, then compute:

```text
turnActivity = clamp(sum(abs(theta)) / (pi/2), 0, 1)
turnCoherence = abs(sum(theta)) / max(sum(abs(theta)), epsilon)
roundness = turnActivity * turnCoherence
jaggedness = turnActivity * (0.65 * signFlipRate + 0.35 * roughness)
shapeFeature = clamp(roundness - jaggedness, -1, 1)
```

Ignore turns under 5 degrees for sign flips. Roughness is the median normalized deviation from a local five-turn median, with turn concentration preventing a single abrupt corner from masquerading as a smooth curve. Shape confidence is zero until at least eight resampled segments and `0.04D` accumulated distance are available. Straight paths are near neutral, coherent arcs/circles are round/positive, and alternating zigzags are jagged/negative.

## Adaptive participant range

Maintain 1,200-sample/60-second rolling histograms with 128 bins: speed from `0` to `log1p(4 diagonals/s)` and shape from `-1` to `+1`. Recompute p10/p90 every 500 ms. Smooth outward expansion with a 1.5 s time constant and inward contraction with a 45 s time constant. Start from speed priors `log1p(0.02)..log1p(0.8)` and shape priors `-0.35..0.35`; blend in participant data during the first 100 qualified samples. Enforce minimum spans of 0.15 and 0.20 respectively.

Map each feature as `2*clamp((raw-lower)/(upper-lower),0,1)-1`, multiply by feature confidence, and move the touch target with a 450 ms exponential response. After 400 ms without valid motion, close the segment and decay both targets to neutral with a 600 ms time constant. Inactivity is never labelled slow movement. Reset filters, histories, trace, and affect target at actual stimulus playback start so countdown practice is excluded.

## Trace and experiment layout

The optional high-DPI canvas displays the last four seconds. Fit the unrestricted path into its rectangle with uniform scale, preserved aspect ratio, centering, and 8% padding. Segment age controls opacity and rainbow hue; reduced-motion uses a static spatial rainbow with ordinary fading. Labels show slow/fast, jagged/round, and calibration confidence.

During experiments the vertical order is video, Flubber, then trace. `computeExperimentLayout` must shrink elements as needed on narrow displays, allow the trace to reach 220 px wide, and never overlap the video and Flubber.

## Logging contract

Experiments use `ExperimentCsvWriter`, an append-only ~1,000-row chunk serializer. It must never route high-rate pointer rows through or inherit rollover from the 10,000-row normal logger. A warning appears for configured segments over 30 minutes. Failed or partial export retains chunks for retry.

Record types are:

- `pointer_raw`: every delivered/fallback/coalesced observed point during active playback.
- `touch_metric`: 20 Hz raw speed/shape features, component metrics, adaptive bounds, normalized targets, confidence, and motion state.
- `sample`: 20 Hz displayed current and target coordinates.
- `event`: input/lifecycle, buffering, visibility, resize, fullscreen, abort, and completion markers.

All rows retain session/experiment/stimulus identifiers, ISO and monotonic time, `active_elapsed_ms`, stimulus time, source/mode, and animation/widget state. `active_elapsed_ms` advances only during playback. Buffering pauses metric/sample emission and active time. Finish captures a final metric/sample before completion; abort/fullscreen exit/player failure generates a marked partial CSV.

Algorithm identifier: `touch-trace-v1`. Changing formulas, defaults, columns, segmentation, or adaptive behavior requires tests, an algorithm-version decision, and an update to the provenance ledger.
