# Experimental Polar Stream browser module

## Scope and support boundary

The fourth top-level **Polar Stream — Experimental** accordion is an opt-in,
browser-only adapter for a Polar H10. It connects directly from the page through
Web Bluetooth, starts the H10 PMD ECG stream at 130 Hz, subscribes to the
standard heart-rate/RR characteristic when available, and reads battery level
when available. Connecting the sensor alone must never change affect.

The accordion is the fourth top-level control surface. Its connector is a
compact logo/status/battery/action module rather than a second settings panel.
Derived signals appear as independent metric modules with direct **X ·
Valence** and **Y · Arousal** buttons. Detailed source/range/reversal controls
and the bounded waveform remain disclosure sections so the common connect and
assign path is short.

The supported path is a secure context (`https:` or localhost) in a desktop
Chrome, Edge, or Chromium build that exposes a working Web Bluetooth chooser.
Every connection begins with a direct user gesture and browser-owned device
selection; the application must not auto-connect or scan silently. Firefox,
Safari, insecure HTTP, and browsers without `navigator.bluetooth.requestDevice`
show a disabled Connect control with an actionable explanation.

Stock Meta Quest Browser is explicitly unsupported for H10 pairing because it
does not provide a usable Web Bluetooth device chooser, even on versions where
feature detection can appear positive. The main page must identify the Quest
user agent and fail closed. A sideloaded Chromium APK may expose ordinary 2D
Web Bluetooth on some Quest builds, but it is not a qualified study path and is
not integrated into the repository's separate immersive `webxr.html` flow.

## Data flow and bounded state

`site/src/polar-stream.js` owns browser capability detection, the Bluetooth GATT
lifecycle, Polar PMD control/data framing, signed 24-bit ECG decoding, standard
heart-rate/RR decoding, and bounded rolling metric state. `site/src/app.js` owns
the accordion, connection status, waveform rendering, axis assignments,
preference persistence, affect-target arbitration, and logging context.

Raw ECG is held only in memory. The processor and waveform each retain at most
650 samples (five seconds at 130 Hz); the RR window retains at most 300 positive
intervals. Disconnect or refresh drops the waveform. No raw 130 Hz ECG frame or
RR series is written to local storage or CSV. Browser-local axis assignments are
stored in the existing preferences record and intentionally remain outside
portable settings version 1, Tauri, LSL, the native Quest APK, and WebXR.

## Exposed metrics

The UI exposes these live experimental choices:

- a causal, provisional **Excite-O-Meter score** from RR and rolling 10-beat
  RMSSD, mapped through their session-to-date standard-normal percentiles;
- a provisional **activation composite** combining 65% within-session
  heart-rate elevation and 35% within-session lnRMSSD reduction through a
  logistic curve;
- heart rate in bpm and latest RR interval in ms from the H10 standard
  heart-rate characteristic;
- rolling RMSSD, lnRMSSD, and sample SDNN over at most 300 RR values; and
- local ECG power (mean squared amplitude), RMS amplitude, and peak-to-peak
  amplitude over the bounded five-second raw ECG window.

For valid RR intervals `r`, the browser's provisional Excite-O-Meter module
uses:

```text
score = 1 - [Phi(z_population(r)) + Phi(z_population(RMSSD_10))] / 2
```

It begins only after a 10-interval RMSSD window and ten paired baseline values,
so the earliest result is the nineteenth valid RR interval. Unlike the source
method's retrospective completed-session standardization, already displayed
browser values cannot be revised; the session-to-date result is therefore
explicitly provisional.

The activation module uses:

```text
activation = logistic[0.65 * z_sample(HR) - 0.35 * z_sample(lnRMSSD)]
```

It begins after twenty paired heart-rate/rolling-lnRMSSD observations. Constant
baselines yield `0.5` rather than dividing by zero. This is a deliberately
lightweight live browser adaptation, not the source application's research
pipeline or a validated arousal estimator.

For recent ECG samples `x_i`, local power is `sum(x_i^2) / N`; ECG RMS is its
square root. “Power” here is time-domain mean squared signal amplitude in
`µV²`, not frequency-band power, cardiac work, or a physiological energy
estimate. No baseline is removed.

All RR-derived metrics are uncorrected. The module rejects only
non-finite/non-positive RR values; it does not perform beat classification,
ectopic-beat correction, signal-quality scoring, baseline removal, or
research-grade artifact cleaning. Movement, contact quality, and missed beats
can therefore dominate these values. The UI and documentation must not
describe any metric as an emotion detector, medical diagnosis, or validated
study endpoint.

## Affect assignment and precedence

Valence and arousal each default to **Manual / unassigned**. An assignment has a
metric, finite low bound, greater finite high bound, and optional reverse flag.
Pressing a module's X or Y button assigns that metric with its displayed default
range; pressing the active button again returns that axis to Manual. A metric
may drive both axes only through two explicit assignments. The fine-tuning
disclosure and its source selects are an equivalent path to the same mapping
state.
For an observed metric `m`, the normal mapping is:

```text
u = clamp(2 × (m - low) / (high - low) - 1, -1, 1)
axis = reverse ? -u : u
```

Only the explicitly assigned axis is sensor-driven. The other axis retains the
ordinary step, continuous, wheel, keyboard, button, and 2D-grid behavior.
Assigned axes revert to manual availability while disconnected or before the
first finite metric arrives. Selecting an exact coordinate in the Settings 2D
grid deliberately clears both Polar axis assignments to Manual before applying
the point, so a live metric cannot overwrite the selection. Reset changes only
currently manual axes.

The active Experimental Touch/Trackpad protocol has precedence over all Polar
assignments. The saved Touch source becomes active while its accordion is open
or an experiment is running; during that time it pauses Polar affect drive
without disconnecting the H10. Collapsing Touch outside an experiment suspends
pointer drive and reapplies the most recent finite assigned Polar metrics.
Turning Touch off returns the saved source to manual. All four top-level
accordions are mutually exclusive protocol surfaces; opening or closing them
never erases a Polar assignment or disconnects the H10.

Experiment countdown/preload starts at the required neutral state. Polar drive
is suspended while an experiment is not actively playing, including buffering,
and resumes from the latest metric during playback; the last target is held
during a pause. The connection itself remains open unless the user disconnects,
the strap leaves range, or the page closes.

## Logging and privacy

Normal 20 Hz and experiment sample/event rows include whether the H10 is
connected, whether Polar currently drives any axis, and for each axis the
assigned metric, observed value, normalized value, bounds, and reverse flag.
When at least one axis is actively driven, `input_source` is `polar-stream`;
Touch/Trackpad retains precedence as `touch-trace`. Connection and mapping
changes produce semantic event rows. This context makes displayed affect
reconstructable without persisting high-rate physiology.

All Bluetooth data stays in the current tab. The module adds no server, upload,
telemetry, CDN, account, or background connection. Browser/OS Bluetooth
permission state remains under browser control. Researchers must obtain
appropriate participant consent for physiological acquisition.

## Source and validation status

The PMD UUIDs, ECG start/stop commands, signed 24-bit framing, module visual
identity, and two experimental composite definitions are adapted from the
MIT-licensed Polar Stream repository pinned in
`site/assets/POLAR-STREAM-NOTICE.md`. The Excite-O-Meter paper/source supplies
the retrospective score concept; the browser's causal session-to-date baseline
is an explicitly provisional adaptation. Polar's official BLE SDK is a protocol
and device-compatibility reference; it is not shipped as a dependency. H10 HRV
validation literature supports the sensor for appropriate resting RR work but
does not validate this browser implementation, its uncorrected rolling metrics,
the five-second amplitude features, either composite, or any metric-to-affect
mapping.

Release qualification requires unit fixtures for byte decoding, bounds,
mapping/clamping/reversal, and capability detection; a real desktop Chromium
UI smoke test; and physical H10 acceptance for chooser, start/stop,
disconnect/reconnect, waveform, heart-rate/RR availability, mapping ownership,
and CSV context. Until physical-H10 acceptance is recorded, this remains an
experimental implementation rather than a validated acquisition tool.
