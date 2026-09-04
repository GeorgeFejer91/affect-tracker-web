import test from "node:test";
import assert from "node:assert/strict";

import {
  ResearchStorageCapabilityError,
  probeBrowserStorage,
} from "../site/src/research/storage-capability.js";
import { estimateResearchStorageUse } from "../site/src/research/app.js";
import { createDefaultResearchSettings } from "../site/src/research/contracts.js";

test("browser storage preflight reports quota headroom and persistence explicitly", async () => {
  let persistCalls = 0;
  const result = await probeBrowserStorage({
    storageManager: {
      async estimate() { return { usage: 1_000, quota: 10_000 }; },
      async persisted() { return false; },
      async persist() { persistCalls += 1; return true; },
    },
    requestPersistence: true,
    requiredBytes: 8_000,
  });
  assert.deepEqual(result, {
    usageBytes: 1_000,
    quotaBytes: 10_000,
    availableBytes: 9_000,
    requiredBytes: 8_000,
    sufficient: true,
    persisted: true,
    persistenceRequested: true,
  });
  assert.equal(persistCalls, 1);
});

test("browser storage preflight fails closed for missing, malformed, and insufficient capacity", async () => {
  await assert.rejects(
    probeBrowserStorage({ storageManager: null }),
    (error) => error instanceof ResearchStorageCapabilityError && error.code === "storage-api-unavailable",
  );
  await assert.rejects(
    probeBrowserStorage({ storageManager: { async estimate() { return { usage: 20, quota: 10 }; } } }),
    (error) => error.code === "invalid-storage-estimate",
  );
  const insufficient = await probeBrowserStorage({
    storageManager: { async estimate() { return { usage: 9_500, quota: 10_000 }; } },
    requiredBytes: 501,
  });
  assert.equal(insufficient.sufficient, false);
  assert.equal(insufficient.availableBytes, 500);
  assert.equal(insufficient.persisted, false);
});

test("storage estimation covers every resolved participant slot and selected tabular projection", () => {
  const settings = structuredClone(createDefaultResearchSettings());
  settings.output.csv = true;
  settings.output.tsv = true;
  settings.stimuli.items = [{
    stimulusId: "video-1",
    title: "Video",
    source: {
      kind: "workspaceFile",
      relativePath: "stimuli/video.mp4",
      mimeType: "video/mp4",
      sha256: "a".repeat(64),
      byteLength: 1,
      durationMs: 1_000,
    },
  }];
  const plan = {
    assignments: [
      { slots: [{ stimulusId: "video-1" }] },
      { slots: [{ stimulusId: "video-1" }] },
    ],
  };
  const estimate = estimateResearchStorageUse(settings, plan);
  assert.equal(estimate.sampleRows, 260);
  assert.equal(estimate.requiredBytes, Math.ceil((260 * 1_024 + 260 * 512 * 2 + 2 * 64 * 1_024) * 1.25));
  assert.equal(estimate.estimationVersion, "conservative-v1");
  assert.equal(Object.isFrozen(estimate), true);
});
