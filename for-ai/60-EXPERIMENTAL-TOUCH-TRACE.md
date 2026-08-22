# Experimental Touch/Trackpad mode

This file is the normative contract for the browser-only movement-feedback prototype. It quantifies how a two-dimensional pointer path is moving and maps those features into the affect display. It is **not** an emotion-recognition, diagnostic, or validated affect-inference system.

## Product behavior and privacy

- `inputSource` is either `manual` or `touch-trace` and is distinct from the manual continuous/step `inputMode`.
- `touchFeedbackMode` is a separate browser-local preference: `gated` is the default live move-until-satisfied/hold behavior and `continuous` preserves the earlier direct-mapped response that later decays toward neutral. It is not part of portable settings.
- Touch mode is visibly labelled **Experimental Touch/Trackpad**. Shape drives valence (`x`); speed drives arousal (`y`).
- The online UI exposes a third top-level **Touch/Trackpad Playground** accordion beside Settings and Experiment. It is visibly marked **Experimental** and contains the authoritative **Enable touch/trackpad tracking** switch, an embedded live practice trace, detected pointer type, shape/speed labels, confidence, a read-only live valence–arousal color map with a moving dot/numeric coordinates, and the separate floating-trace preference.
- Opening the playground collapses the other two accordions, and opening either of them collapses the playground. Movement over the playground trace surface is analyzable; other controls remain excluded.
- Touch and pen movement are handled using Pointer Events and primary-pointer capture. Mouse hover supplies browser cursor movement, including the OS-accelerated trajectory exposed for laptop touchpads; raw touchpad contacts are unavailable to ordinary webpages.
- Outside experiments, native controls/settings are excluded. During a fullscreen experiment the entire experiment layer is the capture surface. Only the primary pointer is analyzed; extra simultaneous pointers are ignored and logged.
- Selecting touch mode disables Flubber dragging. Keyboard, mouse-button, wheel, and on-screen direction controls remain observable/logged but do not drive affect. Reset deliberately clears the touch analyzer, adaptive history, and accumulated target.
- Practice movement may update the display, but raw pointer coordinates are written only while an experiment is actively playing. The browser cannot observe other tabs, browser chrome, background pages, or other applications.
- Trace feedback and cursor hiding default off and are stored only in browser local storage. The input source is likewise browser-local and intentionally absent from portable settings version 1. Cursor hiding applies only while this source is active, covers the movement/Flubber/experiment surfaces, and leaves the settings panel cursor visible so participants can reverse it.

## Acquisition and segmentation

For each dispatched Pointer Event, use `getCoalescedEvents()` when available and fall back to the event itself. Never use predicted events. Retain pointer/stroke identifiers, phase/type, `performance.now()` time, client and viewport-normalized positions, pressure, button state, coalesced index, and viewport dimensions.

Normalize distance by `D = hypot(viewportWidth, viewportHeight)`. Reject duplicate points, non-monotonic times, and intervals below 1 ms. A gap over 400 ms ends an ordinary continuous segment. Resize, orientation, cancellation, visibility, and fullscreen changes reset filters and segmentation so coordinate frames are never mixed.

Each touch/pen `pointerdown` always begins a new shape segment and resets both 1€ filters. If it occurs no more than 900 ms after the prior delivered point and at least one speed segment exists, preserve only the two five-sample speed windows. This lets repeated lifted-finger micro-swipes accumulate the two segments required for full speed confidence. Never calculate speed across the off-surface jump, and never connect separate strokes for shape analysis. A longer inter-stroke gap, pointer cancellation, resize, visibility change, or fullscreen transition clears the carried speed evidence. Mouse/touchpad hover does not use this special stroke bridge; it retains ordinary continuous cursor segmentation.

## Speed to arousal

Filter normalized x/y independently using a local 1€ filter with `minCutoff=1 Hz`, `beta=0.007`, and `derivativeCutoff=1 Hz`. Compute both unfiltered normalized segment speed and speed between the filtered positions. Maintain a five-sample median for each and use the larger robust estimate as `filteredSpeed`; this preserves the onset of a brief swipe that coordinate filtering would otherwise attenuate while retaining median rejection as the path continues. Use `speedFeature=log1p(filteredSpeed)` for adaptation. Speed confidence reaches 0.5 after one measured segment and 1.0 after two, including two close micro-strokes linked by the speed-only rule above.

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

## Adaptive participant range and feedback behavior

Both behaviors use 128-bin adaptive ranges: speed from `0` to `log1p(4 diagonals/s)` and shape from `-1` to `+1`. Compute p10/p90, smooth outward expansion with a 1.5 s time constant and inward contraction with a 45 s time constant, start from speed priors `log1p(0.02)..log1p(0.8)` and shape priors `-0.35..0.35`, and enforce minimum spans of 0.15 and 0.20 respectively.

Map each feature as `2*clamp((raw-lower)/(upper-lower),0,1)-1` and multiply by feature confidence. Inactivity is never labelled slow movement. Reset filters, histories, trace, gate state, and affect target at actual stimulus playback start so countdown practice is excluded.

### Gated move-and-hold (default)

A gate opens on the first accepted point and closes after 400 ms without a valid point. A later touch/pen micro-stroke beginning within the 900 ms speed-continuity allowance may inherit only the bounded speed window from the preceding stroke/gate; it never connects geometry or measures lifted-finger distance. Incoming points refresh live confidence-weighted metrics immediately for feedback. Representative observations used by the gate and logger remain limited to 20 Hz and bounded to the latest 32 per active gate. At close, use the median speed feature, median qualified shape feature, and maximum observed confidence for each dimension.

Each completed gate contributes at most one representative value to each adaptive range, preventing long gestures from receiving more calibration weight than short gestures. Gated ranges retain 120 completed windows and blend from priors over the first 20 qualified gate samples. Map the representative against the pre-update bounds, then add it once for future calibration.

Convert each confidence-weighted mapped axis into a signed target velocity while a point has arrived within the last 80 ms:

```text
if abs(mapped) <= 0.12: rate = 0
otherwise:
  strength = (abs(mapped) - 0.12) / (1 - 0.12)
  rate = sign(mapped) * (0.04 + 0.36 * strength) units/second
  target = clamp(target + rate * dt, -1, 1)
```

This makes the 2D point move steadily for as long as the participant draws, so one sustained interaction can reach an extreme. A gate's accumulated live delta is the actual clamped target change. The rendered Flubber and grid dot follow this bounded gated target directly, avoiding a second smoothing lag after input stops. Touch/pen pointer-up disables live integration immediately; mouse/touchpad cursor motion uses the 80 ms freshness allowance because browsers expose no raw touchpad contact lifecycle. Closing the gate never adds a residual nudge: the exact position visible when the participant stops remains fixed indefinitely. No automatic neutral decay runs in gated mode. A later gate adjusts the held position, and Reset returns the analyzer and target to neutral. Changing feedback behavior resets calibration but seeds the newly selected behavior from the current target.

### Continuous live response

Maintain the earlier 1,200-feature/60-second range and blend from priors over 100 qualified observations. Recompute bounds every 500 ms. Move the touch target toward the current mapped result with a 300 ms exponential attack. Motion becomes inactive after 400 ms without a valid point, but retain the last mapped result as the desired target until 1.8 seconds after the last point. Then decay toward neutral with a 3-second time constant.

## Trace and experiment layout

The optional high-DPI canvas displays the last four seconds. Fit the unrestricted path into its rectangle with uniform scale, preserved aspect ratio, centering, and 8% padding. Segment age controls opacity and rainbow hue; reduced-motion uses a static spatial rainbow with ordinary fading. Labels show slow/fast, jagged/round, and calibration confidence. The embedded playground also shows the current displayed coordinates on a cached four-anchor palette canvas: left/right are jagged/round, bottom/top are slow/fast, and the dot always represents the smoothed Flubber state rather than an unsmoothed raw feature.

During experiments the vertical order is video, Flubber, then trace. `computeExperimentLayout` must shrink elements as needed on narrow displays, allow the trace to reach 220 px wide, and never overlap the video and Flubber.

## Logging contract

Experiments use `ExperimentCsvWriter`, an append-only ~1,000-row chunk serializer. It must never route high-rate pointer rows through or inherit rollover from the 10,000-row normal logger. A warning appears for configured segments over 30 minutes. Failed or partial export retains chunks for retry.

Record types are:

- `pointer_raw`: every delivered/fallback/coalesced observed point during active playback.
- `touch_metric`: 20 Hz raw speed/shape features, component metrics, adaptive bounds, normalized targets, confidence, `speed_continuity_active`, motion state, continuous `feedback_held` state, and gated live-control state.
- `sample`: 20 Hz displayed current and target coordinates.
- `event`: input/lifecycle, buffering, visibility, resize, fullscreen, abort, and completion markers.

All rows retain session/experiment/stimulus identifiers, ISO and monotonic time, `active_elapsed_ms`, stimulus time, source/mode, `touch_feedback_mode`, effective `cursor_hidden`, and animation/widget state. Gate-aware rows expose `gate_id`, `gate_open`, `gate_commit_sequence`, `gate_duration_ms`, total `gate_delta_x/y`, `gate_live_active`, `gate_live_rate_x/y`, accumulated `gate_live_delta_x/y`, `speed_calibration_samples`, and `shape_calibration_samples`; every close also emits one `event` row with action `gate-commit`. `active_elapsed_ms` advances only during playback. Buffering pauses metric/sample emission and active time. Finish closes any still-open gated window without changing its live-selected target, then captures the final metric/sample before completion; abort/fullscreen exit/player failure generates a marked partial CSV.

Algorithm identifier: `touch-trace-v5`. Changing formulas, defaults, columns, segmentation, or adaptive behavior requires tests, an algorithm-version decision, and an update to the provenance ledger.

Version 2 replaces version 1's filtered-position-only speed estimate, five-segment speed-confidence ramp, 450 ms target response, and immediate 600 ms inactivity decay with a dual-median burst-preserving estimate, two-segment ramp, 300 ms attack, 1.8-second result hold, and 3-second release. This project-specific change responds to observed playground usability: short rapid movements were underweighted and feedback returned to neutral before participants could reach or perceive the extremes. No external algorithm or source code was introduced by this version change.

Version 3 preserves the bounded speed evidence across touch/pen strokes beginning within 900 ms, while resetting filters and shape geometry and excluding lifted-finger displacement. It also logs the carry decision as `speed_continuity_active`. This project-specific revision responds to observed alternating micro-swipe usability and introduces no external algorithm or source code.

Version 4 adds the default gated occasional-swipe behavior while retaining version 3 as the selectable continuous behavior. A 400 ms movement window commits one persistent, dead-zoned, bounded delta per axis and contributes one representative sample to 20-gate/120-window adaptive calibration. The new CSV fields make feedback behavior, gates, deltas, and calibration counts reconstructable. This project-specific revision responds to the requirement that participants provide occasional intentional gestures rather than continuous swiping; it introduces no external algorithm or source code.

Version 5 changes the default gate from release-triggered nudges to live move-and-hold control. Confidence-weighted mapped evidence outside the existing dead zone becomes a bounded signed velocity integrated while input remains fresh. The participant can keep drawing until the displayed point reaches the intended position; closing freezes that exact target and never applies a release-time correction. Calibration remains one representative vote per completed gate. Live-active, rate, and accumulated-delta columns make the online movement reconstructable. This project-specific revision responds to direct usability clarification and introduces no external source or copied code.
