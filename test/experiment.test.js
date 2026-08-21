import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import {
  computeExperimentLayout,
  DEMO_START_SECONDS,
  DEMO_VIDEO_ID,
  DEMO_VIDEO_URL,
  DEFAULT_EXPERIMENT_CONFIG,
  experimentBufferCapacity,
  experimentFilename,
  normalizeExperimentConfig,
  youtubeVideoId,
} from "../site/src/experiment.js";

function widgetBounds(layout, size) {
  return {
    left: layout.widget.x - size / 2,
    right: layout.widget.x + size / 2,
    top: layout.widget.y - size / 2,
    bottom: layout.widget.y + size / 2,
  };
}

test("experiment video is centered, 16:9, and separated from the flubber", () => {
  for (const [width, height, size] of [[1920, 1080, 180], [1366, 768, 240], [390, 844, 120]]) {
    const layout = computeExperimentLayout(width, height, size);
    const video = layout.videoRect;
    const widget = widgetBounds(layout, size);
    assert.ok(Math.abs(video.left + video.width / 2 - width / 2) < 1e-9);
    assert.ok(Math.abs(video.top + video.height / 2 - height / 2) < 1e-9);
    assert.ok(Math.abs(video.width / video.height - 16 / 9) < 1e-9);
    const separated = widget.left >= video.left + video.width
      || widget.right <= video.left
      || widget.top >= video.top + video.height
      || widget.bottom <= video.top;
    assert.equal(separated, true);
  }
});

test("the repository stimulus represents the video segment beginning at 90 seconds", () => {
  assert.equal(DEMO_VIDEO_ID, "pY6vrOpnM64");
  assert.equal(DEMO_START_SECONDS, 90);
  assert.equal(DEMO_VIDEO_URL, "./assets/dictator-3-study.mp4");
  assert.equal(DEFAULT_EXPERIMENT_CONFIG.source, "local");
});

test("the preloaded Pages video remains below 99 MB and is optimized for streaming", () => {
  const path = new URL("../site/assets/dictator-3-study.mp4", import.meta.url);
  assert.ok(statSync(path).size < 99_000_000);
  const prefix = readFileSync(path).subarray(0, 1024 * 1024).toString("latin1");
  assert.ok(prefix.includes("ftyp"));
  assert.ok(prefix.includes("moov"));
});

test("YouTube experiment configuration accepts common URLs and validates time bounds", () => {
  assert.equal(youtubeVideoId("https://youtu.be/pY6vrOpnM64?t=90"), "pY6vrOpnM64");
  assert.equal(youtubeVideoId("https://www.youtube.com/embed/pY6vrOpnM64"), "pY6vrOpnM64");
  assert.deepEqual(normalizeExperimentConfig({
    source: "youtube",
    youtubeUrl: "https://www.youtube.com/watch?v=pY6vrOpnM64",
    startSeconds: 90,
    endSeconds: 120,
  }), {
    source: "youtube",
    youtubeUrl: "https://www.youtube.com/watch?v=pY6vrOpnM64",
    videoId: "pY6vrOpnM64",
    startSeconds: 90,
    endSeconds: 120,
  });
  assert.throws(() => normalizeExperimentConfig({ source: "youtube", youtubeUrl: "bad", startSeconds: 90, endSeconds: 80 }), /valid YouTube/);
  assert.throws(() => normalizeExperimentConfig({ source: "youtube", youtubeUrl: "pY6vrOpnM64", startSeconds: 90, endSeconds: 80 }), /greater/);
  assert.throws(() => normalizeExperimentConfig({ source: "youtube", youtubeUrl: "pY6vrOpnM64", startSeconds: 0, endSeconds: 20_000 }), /four hours/);
  assert.equal(experimentBufferCapacity(60), 10_000);
  assert.ok(experimentBufferCapacity(3600) > 100_000);
});

test("experiment CSV filenames are stable and filesystem-safe", () => {
  assert.equal(
    experimentFilename("session-1", new Date("2026-08-21T12:34:56.000Z")),
    "affect-tracker-experiment-session-1-2026-08-21T12-34-56Z.csv",
  );
});
