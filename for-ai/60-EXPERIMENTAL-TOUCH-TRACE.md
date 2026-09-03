# Experimental Touch/Trackpad mode

This file is the normative contract for the browser-only movement-feedback prototype. It quantifies how a two-dimensional pointer path is moving and maps those features into the affect display. It is **not** an emotion-recognition, diagnostic, or validated affect-inference system.

## Product behavior and privacy

- `inputSource` is either `manual` or `touch-trace` and is distinct from the manual continuous/step `inputMode`. It records the armed preference: `touch-trace` becomes effective only while the Touch/Trackpad accordion is open or an experiment lifecycle is active. Other idle top-level accordions restore manual/Polar ownership without clearing that preference.
- `touchFeedbackMode` is a separate browser-local preference: `gated` is the default live move-until-satisfied/hold behavior and `continuous` preserves the earlier direct-mapped response that later decays toward neutral. It is not part of portable settings.
- Touch mode is visibly labelled **Experimental Touch/Trackpad**. Angular/random direction-changing movement drives valence left (`x<0`), repeated circular movement drives it right (`x>0`), and speed drives arousal (`y`). These are participant control commands, not inferred emotions.
- The online UI exposes the fourth top-level **Touch/Trackpad Playground** accordion beside Settings, Experiment, Screen Calibration, Polar Stream, and Ground Control. It is visibly marked **Experimental** and contains the authoritative **Enable touch/trackpad tracking** switch, an embedded live practice trace, detected pointer type, shape/speed labels, confidence, a read-only live valence–arousal color map with a moving dot/numeric coordinates, and the separate floating-trace preference.
- Opening the playground collapses the other five accordions, and opening any alternative collapses the playground. The saved `inputSource` choice becomes live only while the Touch protocol is open or an experiment is active. While live it pauses, without disconnecting, any Polar Stream affect assignment; collapsing Touch outside an experiment suspends pointer drive and lets an assigned Polar metric resume.
- Touch and pen movement are handled using Pointer Events and primary-pointer capture on the playground surface or the active experiment layer. Other native controls remain excluded for touch/pen so normal scrolling and settings interaction stay usable. Only the primary pointer is analyzed; extra simultaneous pointers are ignored and logged.
- Mouse hover supplies one continuous browser-page cursor trajectory, including the OS-accelerated trajectory exposed for laptop touchpads; raw touchpad contacts are unavailable to ordinary webpages. Every mouse `pointermove` in the active page is analyzed even when its event target is a control. Mouse down/up remain ordinary UI events, are not analyzed as movement points, do not delimit the hover stroke, and are never prevented.
- Selecting touch mode disables Flubber dragging. Configured keyboard, mouse-button, and wheel direction inputs remain observable/logged but do not drive affect. The Settings direction pad continues to edit those bindings rather than acting as a movement control. Reset deliberately clears the touch analyzer, adaptive history, and accumulated target.
- Practice movement may update the display, but raw pointer coordinates are written only while an experiment is actively playing. The browser cannot observe other tabs, browser chrome, background pages, or other applications.
- Trace feedback and cursor hiding default off and are stored only in browser local storage. The input source is likewise browser-local and intentionally absent from portable settings version 1. Cursor hiding applies only while this source is active, covers the movement/Flubber/experiment surfaces, and leaves the settings panel cursor visible so participants can reverse it. Settings Appearance and the playground display options expose synchronized controls for this one preference.

## Acquisition and segmentation

For each accepted dispatched Pointer Event, use `getCoalescedEvents()` when available and fall back to the event itself. Never use predicted events. Mouse accepts movement phases anywhere in the active page; touch/pen accepts primary-pointer phases only on permitted tracking surfaces. Retain pointer/stroke identifiers, phase/type, `performance.now()` time, client and viewport-normalized positions, pressure, button state, coalesced index, and viewport dimensions.

Normalize distance by `D = hypot(viewportWidth, viewportHeight)`. Reject duplicate points, non-monotonic times, and intervals below 1 ms. A gap over 400 ms ends an ordinary continuous segment. Resize, orientation, cancellation, visibility, and fullscreen changes reset filters and segmentation so coordinate frames are never mixed.

Each touch/pen `pointerdown` always begins a new within-stroke geometry segment and resets both 1€ filters. If it occurs no more than 900 ms after the prior delivered point and at least one speed segment exists, preserve the two five-sample speed windows plus up to six qualified per-stroke direction summaries. A direction summary uses only one stroke's on-surface start/end unit vector after both path length and displacement reach `0.01D`. Adjacent summaries may be compared, but no segment is ever created across the off-surface jump. This lets lifted-finger micro-swipes accumulate the two segments required for full speed confidence and lets an up/down/up sequence become live angular evidence during the active third stroke. A longer inter-stroke gap, pointer cancellation, resize, visibility change, or fullscreen transition clears both continuity contexts. Mouse/touchpad hover retains ordinary continuous cursor segmentation and detects backtracking from within-path turns.

## Speed to arousal

Filter normalized x/y independently using a local 1€ filter with `minCutoff=1 Hz`, `beta=0.007`, and `derivativeCutoff=1 Hz`. Compute both unfiltered normalized segment speed and speed between the filtered positions. Maintain a five-sample median for each and use the larger robust estimate as `filteredSpeed`; this preserves the onset of a brief swipe that coordinate filtering would otherwise attenuate while retaining median rejection as the path continues. Use `speedFeature=log1p(filteredSpeed)` for adaptation. Speed confidence reaches 0.5 after one measured segment and 1.0 after two, including two close micro-strokes linked by the speed-only rule above.

### Literature-informed speed orientation

The evidence supports the **direction** of the command more strongly than any universal numerical boundary. Gao et al. (2012) found average, maximum, and minimum touchscreen movement speed discriminative of arousal in gameplay, but normalized features to the study database and warned about player/task effects. Hannan et al. (2017) found that participants often used speed to express intensity, while the direction and range varied by emotion and person. Wampfler et al. (2020, 2022) likewise used multifeature models rather than a single portable speed cutoff, and the in-the-wild study improved with personalization. Reviews by Kołakowska et al. (2020) and Yang & Qin (2021) reinforce the device/task/user dependency.

For a reproducible cold start, use the front-screen values reported by Wolf, Schleicher & Rohs (2014) only as physical HCI anchors. Their deliberate drags were roughly 216–251 px/s and quick swipes roughly 1069–1568 px/s on a 1280×742 tablet (diagonal approximately 1479 px). The implementation conservatively rounds these into:

```text
slow/lower-arousal command anchor = 0.15 viewport diagonals/second
neutral/hold command anchor        = expm1(mean(log1p(0.15), log1p(0.80)))
                                   = approximately 0.4387 diagonals/second
quick/higher-arousal command anchor = 0.80 viewport diagonals/second
```

These values initialize the adaptive mapping; they are not permanent bins. They also must not be called calm, normal, or high-arousal measurements. Direct touchscreen motion, browser cursor motion, and OS-accelerated touchpad motion are not metrically interchangeable. UI labels say lower/hold/higher-arousal **command** and show D/s so the participant sees the control interpretation without being told the system detected their emotion.

## Shape to valence: angular/random versus circular

The two intended participant commands are operationalized explicitly:

- **Angular/random:** change thumb direction unpredictably, commonly producing V/W-like dominant turns connected by naturally curved thumb-motion legs. The path need not be a mathematically sharp polyline.
- **Circular:** repeatedly circle the thumb in one direction. Translated, rotated, and thumb-distorted elliptical loops are accepted; a perfect geometric circle is not required.

The classifier uses only viewport-normalized, equal-distance points. Canvas fitting, CSS sizing, line caps, and all other rendering transforms are forbidden classifier inputs.

Resample geometry every `0.005D` and retain the latest 512 resampled segments (`2.56D`). This bounded horizon keeps several phone-scale direction changes in view. Structural turn activity, coherence, and sign changes use chords spanning four resampled segments (`0.02D`) on each side: `theta=atan2(cross(u,v),dot(u,v))`. Adjacent `0.005D` vectors are used only for explicit reversal evidence, so ordinary mouse micro-jitter cannot dominate the path-wide turn interpretation. Adjacent turns of at least 120 degrees produce linearly increasing reversal strength that reaches 1 at 180 degrees. Close touch/pen strokes use the same transform on their on-surface direction summaries. Then compute:

```text
turnActivity = clamp(sum(abs(theta)) / (pi/2), 0, 1)
turnCoherence = abs(sum(theta)) / max(sum(abs(theta)), epsilon)
withinStrokeReversal = 0.8 * peakReversal + 0.2 * reversalTurnFraction
directionReversal = max(withinStrokeReversal, crossStrokeReversal)

directionEntropy = Shannon entropy of the 8-bin equal-distance heading code / log(8)
dominant corners = turns >= 60 degrees between chords spanning 0.02D on each side,
                   with endpointChord/localPathLength <= 0.85,
                   greedily non-max-suppressed within 0.04D
cornerDensity = clamp(dominantCornerCount / 4, 0, 1)
cornerStrength = median(clamp((abs(cornerAngle)-60deg)/(180deg-60deg), 0, 1))

center points; compute the 2x2 covariance eigenvalues/eigenvectors
nonDegenerate = clamp((minorEigenvalue/majorEigenvalue) / 0.04, 0, 1)
whiten along the covariance axes (classifier only, never display)
radialVariation = standardDeviation(whitenedRadius) / mean(whitenedRadius)
radialRegularity = clamp(1 - radialVariation/0.8, 0, 1)
windingTurns = abs(sum(wrapped centroid-angle differences)) / (2*pi)
closure = clamp(1 - endpointDistance/pathLength, 0, 1)
closureCoverage = clamp((closure-0.1)/0.5, 0, 1)
windingCoverage = clamp(windingTurns, 0, 1) * closureCoverage
turnCoverage = clamp(sum(abs(theta))/pi, 0, 1)

rawCircleScore = clamp(turnCoherence * (1-directionReversal) * nonDegenerate
                       * (0.15*turnCoverage + 0.85*windingCoverage*radialRegularity), 0, 1)
circleScore = rawCircleScore * (1 - 0.7*cornerDensity)
directionalDisorder = directionEntropy * sqrt(1-turnCoherence)
cornerEvidence = corners exist
                 ? 0.55*cornerDensity + 0.25*cornerStrength + 0.20*directionEntropy
                 : 0
microReversalDisorder = adjacentSignFlipRate * clamp(2.5*directionReversal, 0, 1)
angularScore = clamp(max(0.9*directionReversal,
                         directionalDisorder,
                         cornerEvidence,
                         turnActivity*signFlipRate,
                         microReversalDisorder), 0, 1)
shapeFeature = clamp(circleScore - angularScore, -1, 1)
```

Ignore structural and adjacent turns under 5 degrees for their respective sign-flip rates. Roughness remains logged for backwards comparison but cannot turn generic local curvature into circle evidence. Covariance whitening makes loop topology tolerant of ellipses caused by thumb reach; it never alters the displayed trace or creates circle evidence alone. Closure gating prevents a short open bend's centroid-angle motion from masquerading as a completed loop. Ordinary within-stroke shape confidence is zero until at least eight resampled segments and `0.04D` distance are available. Cross-stroke reversal may qualify shape earlier. Straight paths remain near neutral; a short coherent bend is only mildly circular; a full or repeated ellipse has high closure/winding/coherence even with mouse-scale jitter; multi-direction V/W paths, smooth large-scale random meanders, hairpins, exact backtracking, and opposing micro-strokes are angular/negative.

## Adaptive participant range and feedback behavior

Both behaviors use 128-bin adaptive ranges: speed from `0` to `log1p(4 diagonals/s)` and shape from `-1` to `+1`. Compute p10/p90, smooth outward expansion with a 1.5 s time constant and inward contraction with a 45 s time constant, start from speed priors `log1p(0.15)..log1p(0.8)` and shape priors `-0.35..0.35`, and enforce minimum spans of 0.15 and 0.20 respectively.

Map each feature as `2*clamp((raw-lower)/(upper-lower),0,1)-1` and multiply by feature confidence. Inactivity is never labelled slow movement. Reset filters, histories, trace, gate state, and affect target at actual stimulus playback start so countdown practice is excluded.

### Gated move-and-hold (default)

A gate opens on the first accepted point and closes after 400 ms without a valid point. A later touch/pen micro-stroke beginning within the 900 ms continuity allowance may inherit the bounded speed window and on-surface direction summaries from preceding strokes; it never connects their geometry or measures lifted-finger distance. Incoming points refresh live confidence-weighted metrics immediately for feedback, including reversal evidence as soon as the current stroke has a qualifying direction. Representative observations used by the gate and logger remain limited to 20 Hz and bounded to the latest 32 per active gate. At close, use the median speed feature, median qualified shape feature, and maximum observed confidence for each dimension.

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

The embedded high-DPI movement map and separate optional floating overview both display the last four seconds of the unrestricted page-wide trajectory. On every frame, compute the recent path's x/y bounds and apply one uniform scale with centering and 8% padding. This dynamically fits the whole path into either canvas while preserving aspect ratio, segment angles, and relative distances. It performs no interpolation, filtering, non-uniform stretching, or curve smoothing; delivered straight segments use butt caps and miter joins so visible corners are not cosmetically rounded. Stroke boundaries remain disconnected. Neither visualization affects classifier coordinates.

Segment age controls opacity and rainbow hue; reduced-motion uses a static spatial rainbow with ordinary fading. Labels show slow/fast, angular/circular, and calibration confidence. The embedded playground shows the displayed coordinates on the four-anchor palette: left/right are angular/circular, bottom/top are slow/fast. A compact two-card guide shows the theoretical commands: irregular V/W-like direction changes versus repeated one-direction elliptical loops.

### Smartphone viewer

The web-only compact viewer activates for portrait widths through 600 CSS px and for coarse-pointer phone landscape viewports no taller than 500 CSS px. It uses seven ≥44 px top tabs and a viewport-relative content sheet with `viewport-fit=cover`, `100dvh`, safe-area offsets, contained settings scrolling, and no horizontal overflow. A clean touch-capable phone visit opens the Affect module's direct controller once and persists `mobileTouchIntroSeen`; opening Face reparents that same controller into the Face accordion, without changing input ownership or creating another controller. `inputSource` remains manual until the participant explicitly enables tracking in the separate Touch Lab. The smartphone-only Party perspective gesture is a separate local camera transform over the shared scene; its empty-space pan and pinch/range zoom never enter Touch/Trackpad classification, samples, settings, or network state.

The default Affect view divides the usable sheet equally: the upper pane reuses the canonical live animated Flubber path/color and shows current coordinates, while the lower pane is the manual direct valence/arousal palette. Face presents that same equal split with the optional synchronized face beside Flubber and a compact ≥44 px **Face** header selector for all six engines. That selector and the detailed selector in **Face options** write one browser-local `faceEngineMode` and update the existing renderer pair; they do not create another renderer, clock, coordinate, transition, or input authority. **Face options** retains visibility, transition, rate, centering, descriptions, and disclosures, and Back restores the live controller. Primary-pointer manipulation begins only inside the existing marker's 30 CSS-pixel radius (a visible 44 px target); off-marker presses are inert. A valid grab uses Pointer Events/capture, `touch-action:none`, exact current/target updates, and clamping until release. Keyboard arrows remain available. A Settings button swaps to the ordinary Affect settings surface, and a return action restores the controller. The desktop Settings palette keeps its click-anywhere behavior. The Touch Lab retains its movement-command guide, enable switch, pointer/gate status, canonical preview/mapping, fitted page-wide movement surface, live metrics, and collapsed secondary controls. This phone presentation adds no renderer or signal-processing fork and continues to use the same `touch-trace-v10` classifier, adaptive ranges, gate behavior, logging fields, and raw-pointer privacy limits as larger browsers.

During experiments the vertical order is video, Flubber, then trace. `computeExperimentLayout` must shrink elements as needed on narrow displays, allow the trace to reach 220 px wide, and never overlap the video and Flubber.

## Logging contract

Experiments use `ExperimentCsvWriter`, an append-only ~1,000-row chunk serializer. It must never route high-rate pointer rows through or inherit rollover from the 10,000-row normal logger. A warning appears for configured segments over 30 minutes. Failed or partial export retains chunks for retry.

Record types are:

- `pointer_raw`: every delivered/fallback/coalesced observed point during active playback.
- `touch_metric`: 20 Hz raw speed/shape features; legacy turn components; `circle_score`, `angular_score`, `winding_turns`, `radial_variation`, `direction_entropy`, and `dominant_corner_count`; adaptive bounds; normalized targets; confidence; `speed_continuity_active`; motion state; continuous `feedback_held` state; and gated live-control state.
- `sample`: 20 Hz displayed current and target coordinates.
- `event`: input/lifecycle, buffering, visibility, resize, fullscreen, abort, and completion markers.

All rows retain session/experiment/stimulus identifiers, ISO and monotonic time, `active_elapsed_ms`, stimulus time, source/mode, `touch_feedback_mode`, effective `cursor_hidden`, and animation/widget state. Gate-aware rows expose `gate_id`, `gate_open`, `gate_commit_sequence`, `gate_duration_ms`, total `gate_delta_x/y`, `gate_live_active`, `gate_live_rate_x/y`, accumulated `gate_live_delta_x/y`, `speed_calibration_samples`, and `shape_calibration_samples`; every close also emits one `event` row with action `gate-commit`. `active_elapsed_ms` advances only during playback. Buffering pauses metric/sample emission and active time. Finish closes any still-open gated window without changing its live-selected target, then captures the final metric/sample before completion; abort/fullscreen exit/player failure generates a marked partial CSV.

Algorithm identifier: `touch-trace-v10`. Changing formulas, defaults, columns, segmentation, or adaptive behavior requires tests, an algorithm-version decision, and an update to the provenance ledger.

Version 2 replaces version 1's filtered-position-only speed estimate, five-segment speed-confidence ramp, 450 ms target response, and immediate 600 ms inactivity decay with a dual-median burst-preserving estimate, two-segment ramp, 300 ms attack, 1.8-second result hold, and 3-second release. This project-specific change responds to observed playground usability: short rapid movements were underweighted and feedback returned to neutral before participants could reach or perceive the extremes. No external algorithm or source code was introduced by this version change.

Version 3 preserves the bounded speed evidence across touch/pen strokes beginning within 900 ms, while resetting filters and shape geometry and excluding lifted-finger displacement. It also logs the carry decision as `speed_continuity_active`. This project-specific revision responds to observed alternating micro-swipe usability and introduces no external algorithm or source code.

Version 4 adds the default gated occasional-swipe behavior while retaining version 3 as the selectable continuous behavior. A 400 ms movement window commits one persistent, dead-zoned, bounded delta per axis and contributes one representative sample to 20-gate/120-window adaptive calibration. The new CSV fields make feedback behavior, gates, deltas, and calibration counts reconstructable. This project-specific revision responds to the requirement that participants provide occasional intentional gestures rather than continuous swiping; it introduces no external algorithm or source code.

Version 5 changes the default gate from release-triggered nudges to live move-and-hold control. Confidence-weighted mapped evidence outside the existing dead zone becomes a bounded signed velocity integrated while input remains fresh. The participant can keep drawing until the displayed point reaches the intended position; closing freezes that exact target and never applies a release-time correction. Calibration remains one representative vote per completed gate. Live-active, rate, and accumulated-delta columns make the online movement reconstructable. This project-specific revision responds to direct usability clarification and introduces no external source or copied code.

Version 6 replaces the original `0.02 D/s` lower speed prior with a literature-informed `0.15 D/s` deliberate-movement anchor, retains the conservative `0.80 D/s` quick-movement anchor, exposes their approximately `0.4387 D/s` log-space midpoint, and shows lower/hold/higher-arousal command wording plus live D/s. Participant-adaptive p10/p90 calibration remains unchanged and progressively replaces the priors. The provenance ledger records the empirical direction evidence, physical benchmark, individual/task/device limitations, and the absence of universal diagnostic speed thresholds.

Version 7 corrects a shape-classification bias identified through direct playground use. Near-180-degree within-path reversals are explicit jagged evidence instead of potentially coherent round evidence, and close lifted-finger strokes retain bounded on-surface direction summaries so an up/down/up sequence becomes live jagged evidence without joining paths or measuring the finger-up gap. Strong roundness now requires at least a sustained accumulation of moderate turns; a short bend cannot saturate roundness after only 90 degrees. Experiment CSV adds `direction_reversal` so the new evidence is reconstructable. This project-specific usability revision introduces no external source or copied code.

Version 8 fixes the remaining phone-scale jagged-recognition failure observed in the playground. The equal-distance geometry horizon increases from 32 to 512 segments (`0.16D` to `2.56D`), so multiple widely spaced corners coexist in the live shape estimate instead of every long straight leg erasing the preceding turn. Storage remains bounded, the formulas and CSV columns are unchanged, and the regression fixture models a large alternating path across a 1,000 × 1,000 capture surface. This project-specific usability revision introduces no external source or copied code.

Version 9 operationalizes the study contrast as uncontrolled multi-direction thumb swipes versus repeated circular thumb motion. Circular evidence requires coherent accumulated winding around a non-degenerate center and tolerates elliptical thumb reach through classifier-only covariance whitening. Angular evidence combines multi-scale dominant corners, cyclic eight-direction entropy, turn-sign inconsistency, and reversal evidence. The embedded swipe trace is rendered in raw surface coordinates with butt caps and no adaptive fitting; the optional page-wide overview remains explicitly normalized. CSV adds all new component scores, and fixtures cover bowed V/W legs, anisotropic ellipses, raw trace projection, invariance, and prior paths. The research ledger records the equal-distance/corner/directional/thumb-reach sources; no external code was copied.

Version 10 corrects the inverse usability failure observed with desktop mouse/trackpad use: excluded control-target movements created artificial joins when the cursor re-entered an accepted area, ordinary cursor micro-jitter could dominate adjacent-vector turns, and the embedded canvas clipped page coordinates instead of acting as a miniature. While the source is visibly active, every mouse movement in the page now feeds one continuous hover trajectory, including movement over controls; mouse clicks retain their ordinary behavior and are not stroke phases. Shape turn/coherence features move to 0.02D chords, adjacent vectors remain only for explicit reversals, dominant corners rise from 35° to 60°, and winding becomes strong only after partial path closure. Both trace canvases use the same uniform aspect-preserving dynamic fit with unsmoothed butt/miter segments. Speed formulas and calibration anchors are unchanged; removing excluded-target gaps restores their live response. This independently designed correction responds to direct product feedback, adds no external source or copied code, and changes no portable, Tauri, Quest, Polar, or LSL contract.
