import test from "node:test";
import assert from "node:assert/strict";
import { AffectLogger, escapeCsv, ExperimentCsvWriter, recordsToCsv } from "../site/src/logger.js";
import { RingBuffer } from "../site/src/ring-buffer.js";

const state = {
  currentX: 0.25,
  currentY: -0.5,
  targetX: 0.5,
  targetY: -0.75,
  inputMode: "continuous",
  animationActive: true,
  widgetX: 100,
  widgetY: 200,
};

test("ring buffer overwrites the oldest records and preserves chronology", () => {
  const buffer = new RingBuffer(3);
  for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
  assert.deepEqual(buffer.toArray(), [3, 4, 5]);
  assert.equal(buffer.length, 3);
});

test("logger sequence remains monotonic after rollover", () => {
  let now = 10;
  const logger = new AffectLogger({
    capacity: 2,
    now: () => now++,
    wallClock: () => new Date("2026-08-21T12:00:00.000Z"),
    sessionId: () => "fixed-session",
  });
  logger.record("event", { source: "test", action: "one" }, state);
  logger.record("sample", { source: "test", action: "two" }, state);
  logger.record("event", { source: "test", action: "three" }, state);
  assert.deepEqual(logger.buffer.toArray().map((record) => record.sequence), [1, 2]);
  assert.equal(logger.sequence, 3);
  assert.equal(logger.eventCount, 2);
  assert.equal(logger.sampleCount, 1);
});

test("reset creates a fresh session and clears counters", () => {
  let session = 0;
  const logger = new AffectLogger({
    now: () => 100,
    wallClock: () => new Date(0),
    sessionId: () => `session-${++session}`,
  });
  logger.record("event", { action: "before" }, state);
  logger.resetSession();
  assert.equal(logger.sessionId, "session-2");
  assert.equal(logger.sequence, 0);
  assert.equal(logger.buffer.length, 0);
  logger.resetSession({ capacity: 25_000 });
  assert.equal(logger.buffer.capacity, 25_000);
  assert.equal(logger.buffer.length, 0);
});

test("CSV output is UTF-8, chronological, and RFC escaped", () => {
  assert.equal(escapeCsv('a,"b"\nc'), '"a,""b""\nc"');
  const csv = recordsToCsv([
    { session_id: "s1", sequence: 0, action: "first" },
    { session_id: "s1", sequence: 1, action: "second,quoted" },
  ]);
  assert.ok(csv.startsWith("\uFEFFsession_id,"));
  assert.ok(csv.indexOf("first") < csv.indexOf('"second,quoted"'));
  assert.ok(csv.endsWith("\r\n"));
});

test("experiment context is attached to every timestamped record", () => {
  const logger = new AffectLogger({
    now: () => 250.125,
    wallClock: () => new Date("2026-08-21T12:00:00.123Z"),
    sessionId: () => "session-study",
    context: () => ({
      experimentId: "experiment-1",
      stimulusId: "video-1",
      stimulusTimeSeconds: 90.125,
    }),
  });
  const record = logger.record("sample", { action: "sample" }, state);
  assert.equal(record.elapsed_ms, 0);
  assert.equal(record.iso_time, "2026-08-21T12:00:00.123Z");
  assert.equal(record.experiment_id, "experiment-1");
  assert.equal(record.stimulus_id, "video-1");
  assert.equal(record.stimulus_time_seconds, 90.125);
  assert.equal(record.current_x, state.currentX);
  assert.equal(record.current_y, state.currentY);
});

test("experiment writer is append-only across CSV chunks", () => {
  let time = 10;
  const writer = new ExperimentCsvWriter({
    chunkSize: 2,
    now: () => time++,
    wallClock: () => new Date("2026-08-22T00:00:00Z"),
    sessionId: () => "experiment-session",
    context: () => ({ experimentId: "trial-1", activeElapsedMs: 50, playbackActive: true }),
  });
  for (let index = 0; index < 5; index += 1) {
    writer.record("pointer_raw", { source: "pointer", action: "move", clientX: index, pointerType: "touch" }, state);
  }
  const csv = writer.exportCsv();
  assert.equal(writer.length, 5);
  assert.equal(writer.pointerCount, 5);
  assert.equal(csv.split("\r\n").filter(Boolean).length, 6);
  assert.match(csv, /experiment-session/);
  assert.match(csv, /pointer_raw/);
  assert.match(csv, /touch/);
  assert.equal(writer.exportCsv(), csv, "retry export must be non-destructive");
});

test("experiment writer does not roll over beyond the normal session capacity", () => {
  let time = 0;
  const writer = new ExperimentCsvWriter({
    now: () => time++,
    wallClock: () => new Date(0),
    sessionId: () => "long-trial",
  });
  for (let index = 0; index < 10_250; index += 1) {
    writer.record("pointer_raw", { pointerTimeMs: index, clientX: index % 500 }, state);
  }
  assert.equal(writer.length, 10_250);
  assert.equal(writer.pointerCount, 10_250);
  const csv = writer.exportCsv();
  assert.match(csv, /,10249,/);
});

test("extended CSV distinguishes raw, metric, and displayed state", () => {
  const writer = new ExperimentCsvWriter({
    now: () => 1,
    wallClock: () => new Date("2026-08-22T00:00:00Z"),
    sessionId: () => "session",
  });
  const touchState = { ...state, inputSource: "touch-trace", touchFeedbackMode: "gated" };
  writer.record("pointer_raw", { pointerTimeMs: 1, normalizedX: 0.2, normalizedY: 0.3 }, touchState);
  writer.record("touch_metric", {
    shapeFeature: -0.4,
    speedFeature: 0.6,
    mappedX: -0.8,
    mappedY: 0.7,
    speedContinuityActive: true,
    feedbackHeld: true,
    gateId: 3,
    gateOpen: false,
    gateCommitSequence: 2,
    gateDurationMs: 640,
    gateDeltaX: -0.1,
    gateDeltaY: 0.2,
    speedCalibrationSamples: 2,
    shapeCalibrationSamples: 1,
  }, touchState);
  writer.record("sample", { source: "timer" }, touchState);
  const rows = writer.exportCsv().split("\r\n");
  assert.match(rows[1], /pointer_raw/);
  assert.match(rows[2], /touch_metric/);
  assert.match(rows[3], /sample/);
  assert.match(rows[1], /touch-trace/);
  assert.match(rows[0], /feedback_held/);
  assert.match(rows[0], /speed_continuity_active/);
  assert.match(rows[0], /cursor_hidden/);
  assert.match(rows[0], /touch_feedback_mode/);
  assert.match(rows[0], /gate_commit_sequence/);
  const fields = rows[0].replace(/^\uFEFF/, "").split(",");
  assert.equal(rows[2].split(",")[fields.indexOf("speed_continuity_active")], "true");
  assert.equal(rows[2].split(",")[fields.indexOf("touch_feedback_mode")], "gated");
  assert.equal(rows[2].split(",")[fields.indexOf("gate_commit_sequence")], "2");
  assert.equal(rows[2].split(",")[fields.indexOf("gate_delta_y")], "0.2");
});
