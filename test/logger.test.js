import test from "node:test";
import assert from "node:assert/strict";
import { AffectLogger, escapeCsv, recordsToCsv } from "../site/src/logger.js";
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
