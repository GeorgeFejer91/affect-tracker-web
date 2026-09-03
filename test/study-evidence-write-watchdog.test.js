import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEvidenceWriteSafetyFence,
  EvidenceWriteWatchdog,
} from "../site/src/study/evidence-write-watchdog.js";
import { scheduleSingleFlight } from "../site/src/study/participant-ui.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledTimers() {
  const timers = new Set();
  return {
    setTimeoutFn(callback) {
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timers.delete(timer);
    },
    fireAll() {
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.callback();
      }
    },
    size() {
      return timers.size;
    },
  };
}

test("a hanging evidence write fences presentation without cancellation or a second queued action", async () => {
  const timers = controlledTimers();
  const write = deferred();
  const holder = { current: undefined };
  const calls = {
    writes: 0,
    localPauses: 0,
    embeddedPauses: 0,
    samplingStops: 0,
    timelineStops: 0,
    controlFences: 0,
  };
  let quiescent;
  const watchdog = new EvidenceWriteWatchdog({
    deadlineMs: 25,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeadline: () => applyEvidenceWriteSafetyFence({
      pauseLocalVideo: () => { calls.localPauses += 1; },
      pauseEmbeddedVideo: () => { calls.embeddedPauses += 1; },
      stopSampling: () => { calls.samplingStops += 1; },
      stopTimeline: () => { calls.timelineStops += 1; },
      disableControls: () => { calls.controlFences += 1; },
    }),
    onQuiescent: (detail) => { quiescent = detail; },
  });
  const run = () => watchdog.run(() => {
    calls.writes += 1;
    return write.promise;
  });

  assert.equal(scheduleSingleFlight(holder, run), true);
  assert.equal(calls.writes, 1);
  timers.fireAll();
  assert.deepEqual(calls, {
    writes: 1,
    localPauses: 1,
    embeddedPauses: 1,
    samplingStops: 1,
    timelineStops: 1,
    controlFences: 1,
  });
  for (let tick = 0; tick < 100; tick += 1) {
    assert.equal(scheduleSingleFlight(holder, run), false);
  }
  assert.equal(calls.writes, 1, "the unresolved transaction must remain the only evidence action");
  assert.equal(watchdog.snapshot().latched, true);
  assert.equal(watchdog.acknowledge(), false, "an unresolved write cannot be acknowledged");

  write.resolve("committed");
  assert.equal(await holder.current, "committed");
  await Promise.resolve();
  assert.deepEqual(quiescent, {
    deadlineMs: 25,
    status: "fulfilled",
    rejected: false,
  });
  assert.equal(watchdog.snapshot().latched, true, "late settlement must not auto-resume");
  assert.equal(watchdog.acknowledge(), true);
  assert.equal(watchdog.snapshot().latched, false);
  assert.equal(timers.size(), 0);
});

test("a late evidence rejection remains fenced until the exact accepted outcome is retried", async () => {
  const timers = controlledTimers();
  const write = deferred();
  let quiescent;
  const watchdog = new EvidenceWriteWatchdog({
    deadlineMs: 10,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onQuiescent: (detail) => { quiescent = detail; },
  });
  const pending = watchdog.run(() => write.promise);
  timers.fireAll();
  write.reject(new Error("quota exhausted"));
  await assert.rejects(pending, /quota exhausted/);

  assert.equal(quiescent.rejected, true);
  assert.equal(watchdog.acknowledge(), false);
  assert.equal(watchdog.clearAfterCommittedRetry(), true);
  assert.equal(watchdog.snapshot().latched, false);
});

test("visibility backstop alarms an active write before a throttled wall timer", async () => {
  const timers = controlledTimers();
  const write = deferred();
  let deadlineDetail;
  const watchdog = new EvidenceWriteWatchdog({
    deadlineMs: 2_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeadline: (detail) => { deadlineDetail = detail; },
  });
  const pending = watchdog.run(() => write.promise);

  assert.equal(watchdog.alarmNow("document-hidden"), true);
  assert.equal(watchdog.alarmNow("duplicate"), false);
  assert.equal(deadlineDetail.reason, "document-hidden");
  assert.equal(watchdog.snapshot().latched, true);
  write.resolve();
  await pending;
  assert.equal(watchdog.snapshot().latched, true, "visibility alarm also requires explicit resume");
});
