import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  authorizeDesktopPlaybackMode,
  mediaFailureReport,
  nativeInputBindingSupported,
  nativeInputPresetAvailability,
  nativeInputRegionRequest,
  participantStateDetail,
  probeAndAttestNativeVideo,
} from "../site/src/research/native-bridge.js";

test("Tauri exposes only implemented native input presets and bounded client regions", () => {
  const capability = {
    nativeAuthorityReady: true,
    supportedPresets: ["arrowKeys", "wasd", "ijkl", "numpad", "mouseButtonsWheel", "custom"],
  };
  const availability = nativeInputPresetAvailability(capability);
  assert.equal(availability["arrow-keys"], true);
  assert.equal(availability["pointer-grid"], false);
  assert.equal(availability["gamepad-dpad"], false);
  assert.equal(nativeInputBindingSupported({
    preset: "custom", kind: "digital",
    directions: { up: { kind: "gamepadButton", button: 0 } },
  }, capability), false);
  assert.deepEqual(nativeInputRegionRequest({
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 }),
  }, "runFeedback", 7, { innerWidth: 800, innerHeight: 600 }), {
    purpose: "runFeedback", layoutEpoch: 7, left: 10, top: 20, width: 100, height: 200,
    viewportWidth: 800, viewportHeight: 600,
  });
});

test("desktop playback defaults qualified and requires an explicit unqualified fallback", () => {
  const unavailable = {
    qualifiedStartAvailable: false,
    playerActorReady: false,
    reasonCode: "runtime-not-staged",
  };
  assert.throws(() => authorizeDesktopPlaybackMode(undefined, unavailable), /Qualified native playback is unavailable/u);
  assert.equal(authorizeDesktopPlaybackMode("unqualifiedWebview", unavailable), "unqualifiedWebview");
  assert.equal(authorizeDesktopPlaybackMode("nativeLibvlc", {
    qualifiedStartAvailable: true,
    playerActorReady: true,
  }), "nativeLibvlc");
  assert.throws(() => authorizeDesktopPlaybackMode("ambientVlc", unavailable), /Unknown Windows playback mode/u);
});

test("native participant projection distinguishes terminal and recoverable partials", () => {
  const detail = participantStateDetail([
    { participantId: "P001", state: "Partial", recoverable: true },
    { participantId: "P002", state: "Partial", recoverable: false },
  ]);
  assert.deepEqual(detail, {
    P001: "partial",
    P002: "partial",
    __recoverable: { P001: true, P002: false },
  });
});

test("WebView media errors become bounded path-free native interruption reports", () => {
  assert.deepEqual(mediaFailureReport({
    mediaErrorCode: 3,
    stimulusId: "video-a",
    stimulusPosition: 2,
    mediaTimeMs: 125.5,
  }), {
    reason: "decode",
    stimulusId: "video-a",
    stimulusPosition: 2,
    mediaTimeMs: 125.5,
  });
  assert.equal("path" in mediaFailureReport({
    mediaErrorCode: 4,
    stimulusId: "video-a",
    stimulusPosition: 1,
    mediaTimeMs: 0,
  }), false);
});

class ProbeVideo extends EventTarget {
  constructor() {
    super();
    this.duration = 12.5;
    this.videoWidth = 1_920;
    this.videoHeight = 1_080;
    this.currentTime = 0;
    this.paused = true;
    this.frameCallback = null;
  }

  load() {
    if (!this.src) return;
    queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }

  async play() {
    this.paused = false;
    this.currentTime = 0.08;
    queueMicrotask(() => this.frameCallback?.());
  }

  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  requestVideoFrameCallback(callback) { this.frameCallback = callback; return 1; }
}

test("native decode attestation requires real metadata, muted playback, and a decoded frame", async () => {
  const calls = [];
  const verified = {
    workspaceFileId: "file-opaque-1",
    displayName: "Complete Video.mp4",
    sha256: "a".repeat(64),
    byteLength: 4_096,
    mimeType: "video/mp4",
    durationMs: 12_500,
    decodeStatus: "verified",
    source: {
      kind: "workspaceFile",
      relativePath: "stimuli/.workspace/file-opaque-1",
      mimeType: "video/mp4",
      sha256: "a".repeat(64),
      byteLength: 4_096,
      durationMs: 12_500,
    },
  };
  let clock = 100;
  const result = await probeAndAttestNativeVideo({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    summary: { ...verified, durationMs: null, decodeStatus: "unverified", source: null },
    videoFactory: () => new ProbeVideo(),
    performanceNow: () => { clock += 100; return clock; },
    async invoke(command, payload) {
      calls.push([command, structuredClone(payload)]);
      if (command === "research_workspace_media_url") {
        return {
          mediaGrantId: "grant-opaque-1",
          workspaceFileId: "file-opaque-1",
          mediaUrl: "http://research-media.localhost/grant-opaque-1",
          byteLength: 4_096,
          mimeType: "video/mp4",
          durationMs: null,
          decodeStatus: "unverified",
        };
      }
      if (command === "research_attest_workspace_decode") return verified;
      throw new Error(`Unexpected command ${command}`);
    },
  });
  assert.deepEqual(result, verified);
  assert.deepEqual(calls.map(([command]) => command), [
    "research_workspace_media_url",
    "research_attest_workspace_decode",
  ]);
  const attestation = calls[1][1].attestation;
  assert.equal(attestation.observedDurationMs, 12_500);
  assert.equal(attestation.videoWidth, 1_920);
  assert.equal(attestation.videoHeight, 1_080);
  assert.ok(attestation.mutedPlaybackMs >= 50);
  assert.equal("path" in attestation, false);
  assert.equal("relativePath" in attestation, false);
});

test("desktop entrypoint activates only the path-free Research native bridge", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../desktop/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/research/native-bridge.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /src="\.\.\/site\/src\/research\/native-bridge\.js"/u);
  assert.doesNotMatch(html, /runtime-bridge\.js|app\.js/u);
  for (const command of [
    "research_choose_workspace",
    "research_rescan_stimuli",
    "research_import_stimuli",
    "research_native_media_capability",
    "research_input_capability",
    "research_input_set_region",
    "research_input_begin_test",
    "research_input_begin_capture",
    "research_input_status",
    "research_storage_readiness",
    "research_start_run",
    "research_resume_run",
    "research_run_status",
    "research_finish_run",
    "research_report_media_failure",
  ]) assert.match(source, new RegExp(`"${command}"`, "u"));
  assert.match(source, /selectionEnabled/u);
  assert.match(source, /playbackMode/u);
  assert.doesNotMatch(source, /research_update_affect_state|research_gamepad_button/u);
  assert.doesNotMatch(source, /invoke\([^\n]+(?:filePath|rootPath|outputPath)/u);
});
