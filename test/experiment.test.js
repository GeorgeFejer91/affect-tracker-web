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

test("flubber is always centered directly below the experiment video", () => {
  for (const [width, height, size] of [[1920, 1080, 180], [1366, 768, 240], [390, 844, 120], [844, 390, 180]]) {
    const layout = computeExperimentLayout(width, height, size);
    const video = layout.videoRect;
    const widget = widgetBounds(layout, size);
    assert.ok(Math.abs(video.left + video.width / 2 - width / 2) < 1e-9);
    assert.ok(Math.abs(layout.widget.x - (video.left + video.width / 2)) < 1e-9);
    assert.ok(Math.abs(video.width / video.height - 16 / 9) < 1e-9);
    assert.ok(widget.top >= video.top + video.height + 8);
    assert.ok(widget.bottom <= height);
    assert.equal(layout.placement, "below");
  }
});

test("optional movement feedback stays below the flubber without video overlap", () => {
  const layout = computeExperimentLayout(390, 844, 180, 24, { width: 260, height: 160 });
  const videoBottom = layout.videoRect.top + layout.videoRect.height;
  const widgetTop = layout.widget.y - 90;
  const widgetBottom = layout.widget.y + 90;
  assert.ok(widgetTop >= videoBottom);
  assert.ok(layout.traceRect.top >= widgetBottom);
  assert.ok(layout.traceRect.top + layout.traceRect.height <= 844);
  assert.equal(layout.traceRect.left + layout.traceRect.width / 2, layout.widget.x);
});

test("short landscape viewports shrink the experiment widget before hiding the video", () => {
  const layout = computeExperimentLayout(844, 390, 180, 24, { width: 243, height: 151.5 });
  const widget = widgetBounds(layout, layout.widgetSize);
  assert.equal(layout.widgetSize, 80);
  assert.ok(layout.videoRect.width > 0);
  assert.ok(layout.videoRect.height > 0);
  assert.ok(widget.top >= layout.videoRect.top + layout.videoRect.height);
  assert.ok(layout.traceRect.top >= widget.bottom);
  assert.ok(layout.traceRect.top + layout.traceRect.height <= 390);
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
