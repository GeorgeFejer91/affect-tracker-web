import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BROWSER_WORKER_DIAGNOSTIC_SCHEMA,
  BROWSER_WORKER_DIAGNOSTIC_VERSION,
  BrowserWorkerTimingAccumulator,
  plannedStateUpdateCount,
  stateUpdateHasObservationWindow,
} from "../scripts/qualification/browser-timing-metrics.js";

const COMMIT = "a".repeat(40);
const SESSION_TOKEN = "qualification-session";

function sample({
  sequence,
  scheduledMonotonicMs,
  frequencyHz = 130,
  latenessMs = 1,
  currentValence = 0.25,
  anchorAgeMs = 1,
}) {
  return {
    sequence,
    stimulusId: "qualification-synthetic",
    stimulusEpoch: 1,
    samplingFrequencyHz: frequencyHz,
    scheduledMonotonicMs,
    observedMonotonicMs: scheduledMonotonicMs + latenessMs,
    latenessMs,
    currentValence,
    currentArousal: 0,
    anchorAgeMs,
  };
}

function receipt(accumulator, overrides = {}) {
  return accumulator.receipt({
    candidateCommit: COMMIT,
    hardwareRecord: "qualification-machine-01",
    startedAt: "2026-09-04T12:00:00.000Z",
    finalizedAt: "2026-09-04T12:30:00.000Z",
    requestedDurationSeconds: 1_800,
    actualDurationMs: 1_800_000,
    environment: { userAgent: "test-browser", visibilityLossCount: 0, hiddenDurationMs: 0 },
    ...overrides,
  });
}

test("browser timing accumulator accepts a complete 30-minute 130 Hz Worker trace", () => {
  const frequencyHz = 130;
  const periodMs = 1_000 / frequencyHz;
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz, sessionToken: SESSION_TOKEN });
  let currentValence = -0.25;
  let currentAnchorMonotonicMs = null;
  const count = 1_800 * frequencyHz;
  for (let index = 0; index < count; index += 1) {
    if (index % (2 * frequencyHz) === 0) {
      currentValence *= -1;
      currentAnchorMonotonicMs = (index + 1) * periodMs - 1;
      accumulator.noteStateUpdate({
        currentValence,
        anchorMonotonicMs: currentAnchorMonotonicMs,
      });
    }
    const observedMonotonicMs = (index + 1) * periodMs + 1;
    accumulator.acceptMessage({
      type: "sample",
      sessionToken: SESSION_TOKEN,
      sample: sample({
        sequence: index + 1,
        scheduledMonotonicMs: (index + 1) * periodMs,
        currentValence,
        anchorAgeMs: observedMonotonicMs - currentAnchorMonotonicMs,
      }),
    });
  }

  const result = receipt(accumulator);
  assert.equal(result.schema, BROWSER_WORKER_DIAGNOSTIC_SCHEMA);
  assert.equal(result.version, BROWSER_WORKER_DIAGNOSTIC_VERSION);
  assert.equal(result.candidateCommitProvenance, "operator-supplied-unverified");
  assert.equal(result.evidence.sampleCount, 234_000);
  assert.equal(result.evidence.expectedSlotCount, 234_000);
  assert.equal(result.evidence.accountedSlotCount, 234_000);
  assert.equal(result.metrics.meanSteadyStateRateHz, 130);
  assert.equal(result.metrics.p95SchedulerLatenessMs, 1);
  assert.equal(result.metrics.maximumSchedulerLatenessMs, 1);
  assert.equal(result.metrics.p95ControllerStateToSampleMs, 2);
  assert.equal(result.evidence.plannedControllerStateUpdateCount, 900);
  assert.equal(result.evidence.controllerStateUpdateCount, 900);
  assert.equal(result.evidence.matchedControllerStateUpdateCount, 900);
  assert.equal(result.workerThresholdsPassed, true);
  assert.ok(Object.values(result.thresholds).every(Boolean));
  assert.equal(receipt(accumulator, { actualDurationMs: 5_000 }).thresholds.thirtyMinuteWindow, false,
    "entering 1800 seconds cannot turn an early manual stop into a 30-minute receipt");
});

test("browser timing accumulator accounts every explicit missed slot without inventing samples", () => {
  const frequencyHz = 100;
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz, sessionToken: SESSION_TOKEN });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 1, scheduledMonotonicMs: 10, frequencyHz }),
  });
  accumulator.acceptMessage({
    type: "gap",
    sessionToken: SESSION_TOKEN,
    event: {
      stimulusId: "qualification-synthetic",
      stimulusEpoch: 1,
      samplingFrequencyHz: frequencyHz,
      firstMissedMonotonicMs: 20,
      observedMonotonicMs: 40,
      missedSlots: 2,
      durationMs: 20,
    },
  });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 2, scheduledMonotonicMs: 40, frequencyHz }),
  });

  const result = receipt(accumulator, { requestedDurationSeconds: 0.04, actualDurationMs: 40 });
  assert.equal(result.evidence.sampleCount, 2);
  assert.equal(result.evidence.gapEventCount, 1);
  assert.equal(result.evidence.missedSlotCount, 2);
  assert.equal(result.evidence.expectedSlotCount, 4);
  assert.equal(result.evidence.accountedSlotCount, 4);
  assert.equal(result.evidence.unaccountedSlotCount, 0);
  assert.equal(result.thresholds.noSilentOrCorruptEvidence, true);
  assert.equal(result.workerThresholdsPassed, false, "a short non-130 Hz diagnostic is not a qualification receipt");
});

test("browser timing accumulator exposes silent sequence loss and corrupt evidence", () => {
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz: 100, sessionToken: SESSION_TOKEN });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 1, scheduledMonotonicMs: 10, frequencyHz: 100 }),
  });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 3, scheduledMonotonicMs: 30, frequencyHz: 100 }),
  });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: "wrong-session",
    sample: sample({ sequence: 4, scheduledMonotonicMs: 40, frequencyHz: 100 }),
  });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 4, scheduledMonotonicMs: 40, frequencyHz: 100, latenessMs: -1 }),
  });

  const result = receipt(accumulator, { requestedDurationSeconds: 0.04, actualDurationMs: 40 });
  assert.equal(result.evidence.sequenceErrorCount, 1);
  assert.equal(result.evidence.unexpectedMessageCount, 1);
  assert.equal(result.evidence.corruptRecordCount, 1);
  assert.equal(result.evidence.unaccountedSlotCount, 2);
  assert.equal(result.thresholds.noSilentOrCorruptEvidence, false);
  assert.equal(result.workerThresholdsPassed, false);
});

test("browser timing receipt exposes trailing silence, unmatched state, and visibility loss", () => {
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz: 10, sessionToken: SESSION_TOKEN });
  accumulator.noteStateUpdate({ currentValence: 0.25, anchorMonotonicMs: 99 });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({ sequence: 1, scheduledMonotonicMs: 100, frequencyHz: 10, anchorAgeMs: 2 }),
  });
  accumulator.noteStateUpdate({ currentValence: -0.25, anchorMonotonicMs: 200 });

  const result = receipt(accumulator, {
    requestedDurationSeconds: 1,
    actualDurationMs: 1_000,
    environment: { userAgent: "test-browser", visibilityLossCount: 1, hiddenDurationMs: 100 },
  });
  assert.equal(result.evidence.requestedWindowSlotCount, 10);
  assert.equal(result.evidence.accountedSlotCount, 1);
  assert.equal(result.evidence.unaccountedSlotCount, 9);
  assert.equal(result.evidence.unmatchedControllerStateUpdateCount, 1);
  assert.equal(result.thresholds.everyControllerStateUpdateObserved, false);
  assert.equal(result.thresholds.visibleForEntireRun, false);
  assert.equal(result.thresholds.noSilentOrCorruptEvidence, false);
  assert.equal(result.workerThresholdsPassed, false);
});

test("browser timing receipt rejects an unbound commit or hardware record", () => {
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz: 130, sessionToken: SESSION_TOKEN });
  assert.throws(() => receipt(accumulator, { candidateCommit: "short" }), /40-character Git SHA/u);
  assert.throws(() => receipt(accumulator, { hardwareRecord: "" }), /hardwareRecord/u);
  assert.throws(() => receipt(accumulator, { actualDurationMs: 0 }), /actualDurationMs/u);
});

test("browser timing state probes retain a sampling window before automatic stop", () => {
  assert.equal(stateUpdateHasObservationWindow({
    elapsedMs: 8_000,
    requestedDurationSeconds: 10,
    frequencyHz: 130,
  }), true);
  assert.equal(stateUpdateHasObservationWindow({
    elapsedMs: 9_950,
    requestedDurationSeconds: 10,
    frequencyHz: 130,
  }), false);
  assert.equal(stateUpdateHasObservationWindow({
    elapsedMs: 2_000,
    requestedDurationSeconds: 5,
    frequencyHz: 1,
  }), false, "low-frequency probes retain four full sample periods");
  assert.equal(plannedStateUpdateCount({
    requestedDurationSeconds: 10,
    frequencyHz: 130,
  }), 5);
  assert.equal(plannedStateUpdateCount({
    requestedDurationSeconds: 1_800,
    frequencyHz: 130,
  }), 900);
  assert.equal(plannedStateUpdateCount({
    requestedDurationSeconds: 5,
    frequencyHz: 1,
  }), 1);
  assert.throws(() => stateUpdateHasObservationWindow({
    elapsedMs: -1,
    requestedDurationSeconds: 10,
    frequencyHz: 130,
  }), /elapsedMs/u);
});

test("browser timing receipt rejects a starved periodic state-probe schedule", () => {
  const frequencyHz = 130;
  const periodMs = 1_000 / frequencyHz;
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz, sessionToken: SESSION_TOKEN });
  accumulator.noteStateUpdate({ currentValence: 0.25, anchorMonotonicMs: periodMs - 1 });
  for (let index = 0; index < 10 * frequencyHz; index += 1) {
    accumulator.acceptMessage({
      type: "sample",
      sessionToken: SESSION_TOKEN,
      sample: sample({
        sequence: index + 1,
        scheduledMonotonicMs: (index + 1) * periodMs,
        anchorAgeMs: index === 0 ? 2 : 1,
      }),
    });
  }
  const result = receipt(accumulator, { requestedDurationSeconds: 10, actualDurationMs: 10_000 });
  assert.equal(result.evidence.plannedControllerStateUpdateCount, 5);
  assert.equal(result.evidence.controllerStateUpdateCount, 1);
  assert.equal(result.evidence.matchedControllerStateUpdateCount, 1);
  assert.equal(result.thresholds.everyControllerStateUpdateObserved, false);
});

test("browser timing state matching requires exact anchor provenance", () => {
  const accumulator = new BrowserWorkerTimingAccumulator({ frequencyHz: 130, sessionToken: SESSION_TOKEN });
  accumulator.noteStateUpdate({ currentValence: 0.25, anchorMonotonicMs: 100 });
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({
      sequence: 1,
      scheduledMonotonicMs: 200,
      currentValence: 0.25,
      anchorAgeMs: 151,
    }),
  });
  assert.equal(accumulator.matchedStateUpdateCount, 0, "a stale same-value sample must not match a newer probe");
  accumulator.acceptMessage({
    type: "sample",
    sessionToken: SESSION_TOKEN,
    sample: sample({
      sequence: 2,
      scheduledMonotonicMs: 210,
      currentValence: 0.25,
      anchorAgeMs: 111,
    }),
  });
  assert.equal(accumulator.matchedStateUpdateCount, 1);
});

test("browser timing diagnostic remains an explicit non-production Worker-only surface", async () => {
  const html = await readFile(new URL("../scripts/qualification/browser-timing.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../scripts/qualification/browser-timing.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(html, /does not qualify media, persistence, physical input, LSL, or the full application/u);
  assert.match(html, /operator-supplied label; it does not verify the served Worker against Git/u);
  assert.match(html, /id="duration-seconds"[^>]*max="1800"/u);
  assert.match(source, /new Worker\("\.\.\/\.\.\/site\/src\/research\/sampling-worker\.js"/u);
  assert.match(source, /messageerror/u);
  assert.match(source, /actualDurationMs:\s*performance\.now\(\) - startedMonotonicMs/u);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|indexedDB/u,
    "the diagnostic neither transmits nor stores qualification data automatically");
  assert.match(packageJson.scripts["qualification:browser:serve"], /--bind 127\.0\.0\.1/u,
    "the repository-root diagnostic server must never listen on the LAN");
});
