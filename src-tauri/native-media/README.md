# Affect Research native media runtime

The Windows research application is designed to use a bundled **libVLC 3.0.23**
engine for qualified local-stimulus playback. `libVLC` is the descriptive name
of an upstream dependency; the application and installer remain branded
**Affect Research** and do not use the VLC cone, application name, or other
VideoLAN product marks.

No native runtime is downloaded by the application. A missing, modified, or
wrong-architecture runtime must leave the native-media capability unavailable,
and a qualified native run must fail closed. The HTML/WebView player may remain
available only when the operator explicitly chooses the
`unqualifiedWebview` playback mode.

## Pinned upstream inputs

The machine-readable pin is
[`libvlc-runtime-v1.json`](./libvlc-runtime-v1.json). It records the official
VideoLAN 3.0.23 Windows x64 archive and source archive with their official
SHA-256 digests. Keep the source archive available beside any redistribution
workflow, and retain every upstream `COPYING*` notice copied by the staging
script. A release owner must review the exact upstream license obligations;
this file is an engineering control, not legal advice.

## Deterministic staging

Download the pinned ZIP yourself from the URL in the pin, then run:

```powershell
pwsh -File src-tauri/native-media/stage-libvlc-runtime.ps1 `
  -ArchivePath C:\path\to\vlc-3.0.23-win64.zip
```

The script never uses an installed VLC application, `%PATH%`, the registry, or
a runtime network request. It rejects archive traversal, verifies the archive
digest, copies only `libvlc.dll`, `libvlccore.dll`, the plugin tree, and
upstream `COPYING*` notices, and writes `runtime-files.sha256` over every staged
file. It refuses to replace an existing staged tree.

Verify an existing stage without changing it:

```powershell
pwsh -File src-tauri/native-media/stage-libvlc-runtime.ps1 `
  -VerifyOnly `
  -DestinationPath src-tauri/native-media/runtime/libvlc-3.0.23/win-x64
```

Release/package builds must set `AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME=1`.
The Rust build hook then rejects an absent, incomplete, extra-file, symlinked,
or hash-mismatched runtime before Tauri packaging. Ordinary contract/unit builds
leave this variable unset so the unavailable/fail-closed path remains testable.

Staging and compilation are not playback qualification. A candidate still
requires installed Windows tests for visible output, supported formats,
pause/resume/end/error transitions, shutdown/recovery, audio routing, display
scaling, accessibility, and the full 30-minute timing gate.

## Current safe integration boundary

The checked-in `0.4.0-alpha.1` contract can verify and package the pinned
runtime, report its status without exposing paths, and reject qualified Start
when the native player actor is unavailable. It deliberately does not yet load
the DLLs or create a Windows render target: that narrow dynamic-library,
libVLC, and child-window boundary requires an explicitly approved, audited
`unsafe` implementation. Until it lands, `nativeLibvlc` remains the default
and fails closed. The operator can deliberately select `unqualifiedWebview`
for development-only playback; those attempts are labeled unqualified in the
native receipt, status, recovery journal, and first semantic event.

WebView media errors in that fallback are reported through a bounded command
that stops the native sampler and durably checkpoints the recovery journal.
They cannot be handled only as a visual error message.
