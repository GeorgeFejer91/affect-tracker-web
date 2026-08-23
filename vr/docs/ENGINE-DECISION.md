# Quest media and native-runtime decision

Status: accepted for the v1 hardware-qualification build (2026-08-22).

## Decision

Use a hybrid, single-process Android architecture:

- Media3 ExoPlayer selects the active Quest platform decoder and sends decoded video directly to a Meta Spatial SDK `VideoSurfacePanelRegistration` surface.
- Kotlin owns Spatial SDK entities, SAF, lifecycle, controller input, and the allocation-bounded Flubber renderer.
- A small Rust `arm64-v8a` JNI library owns only LSL protocol/outlet work. One bounded Kotlin worker thread calls it; it is a library in the APK process, not a service process.

Do not bundle FFmpeg for v1 video playback. Media3's published FFmpeg extension is an optional audio decoder, is manually built, and does not replace the platform video decoder. A general software FFmpeg video pipeline would add codecs and native surface plumbing, enlarge the application, and consume CPU/thermal budget that direct hardware decoding avoids.

## LSL qualification boundary

`labstream = 0.1.0` is pinned because it is pure Rust, MIT-licensed, small, and already matches the desktop adapter API. Host cross-compilation is necessary but not sufficient: the exact APK must still be resolved and recorded by independent LabRecorder and pylsl consumers from each target Quest over a same-LAN multicast-capable access point.

The crate is pre-1.0 and comparatively young. If protocol interoperability, timestamp behavior, discovery, recovery, or soak tests fail, replace only the JNI implementation with a pinned official `liblsl` Android AAR built from the canonical C++ project. Preserve `NativeLslBridge`, the eight ordered Float32 channels, the irregular string marker stream, and the bounded worker contract so the rest of the app does not change.

## Rejected alternatives

- A Rust game engine: duplicates Spatial SDK/Android lifecycle and does not improve MediaCodec hardware decode.
- FFmpeg software video decode: wider codec reach on paper but worse size, integration complexity, CPU use, and thermal risk. It may be reconsidered only for a required codec that Quest hardware/Media3 cannot prepare.
- A WebView Flubber: duplicates a browser runtime, prevents a truly native transparent panel, and weakens allocation/frame-time control.
- Separate Android processes: add IPC and lifecycle failure modes without a v1 isolation requirement.

## Evidence and measurement

The architecture minimizes avoidable work, but no language-level speed claim is accepted without Quest measurements. The release gate remains Quest 2 p95 Flubber CPU time below 2 ms, no sustained frame-budget regression against video-only playback, correct LSL timestamps/discovery, and a 30-minute thermal/memory/outlet soak.

Primary references:

- [Meta Spatial SDK samples](https://github.com/meta-quest/Meta-Spatial-SDK-Samples)
- [Media3 supported formats](https://developer.android.com/media/media3/exoplayer/supported-formats)
- [Android media formats and platform codecs](https://developer.android.com/media/platform/supported-formats)
- [Media3 FFmpeg audio decoder](https://github.com/androidx/media/tree/release/libraries/decoder_ffmpeg)
- [`labstream` source](https://github.com/rednayan/labstream-rs)
- [Official `liblsl` source](https://github.com/sccn/liblsl)
- [Official Android `liblsl` build guidance](https://labstreaminglayer.readthedocs.io/dev/build_android.html)
