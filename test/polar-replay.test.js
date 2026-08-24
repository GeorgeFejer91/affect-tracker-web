import assert from "node:assert/strict";
import test from "node:test";

import {
  POLAR_REPLAY_SAMPLE_RATE_HZ,
  PolarH10ReplaySession,
  polarReplayEnabled,
  syntheticEcgMicrovolts,
} from "../site/src/polar-replay.js";

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.intervals = new Map();
  }

  now = () => this.time;

  setInterval = (callback, intervalMs) => {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.set(id, { callback, intervalMs, nextAt: this.time + intervalMs });
    return id;
  };

  clearInterval = (id) => {
    this.intervals.delete(id);
  };

  advance(durationMs) {
    const endAt = this.time + durationMs;
    while (true) {
      let nextAt = Number.POSITIVE_INFINITY;
      for (const interval of this.intervals.values()) nextAt = Math.min(nextAt, interval.nextAt);
      if (nextAt > endAt) break;
      this.time = nextAt;
      for (const [id, interval] of [...this.intervals]) {
        if (interval.nextAt !== nextAt || !this.intervals.has(id)) continue;
        interval.nextAt += interval.intervalMs;
        interval.callback();
      }
    }
    this.time = endAt;
  }
}

test("synthetic ECG replay is deterministic, finite, and contains a visible QRS peak", () => {
  const baseline = syntheticEcgMicrovolts(0.30, 1);
  const peak = syntheticEcgMicrovolts(0.405, 1);
  assert.equal(syntheticEcgMicrovolts(0.405, 1), peak);
  assert.ok(Number.isFinite(baseline));
  assert.ok(Number.isFinite(peak));
  assert.ok(peak - baseline > 800);
});

test("synthetic Polar session follows the real event contract at a self-correcting 130 Hz", async () => {
  const clock = new FakeClock();
  const events = [];
  const session = new PolarH10ReplaySession({
    timer: clock,
    now: clock.now,
    tickMs: 20,
  });

  await session.connect((event) => events.push(event));
  clock.advance(1_000);

  const connection = events.find((event) => event.kind === "connection" && event.connected);
  const ecgEvents = events.filter((event) => event.kind === "ecg");
  const totalSamples = ecgEvents.reduce((sum, event) => sum + event.microvolts.length, 0);
  const latestMetrics = events.filter((event) => event.kind === "metrics").at(-1)?.snapshot;
  const latestHealth = ecgEvents.at(-1)?.streamHealth;

  assert.equal(connection.mock, true);
  assert.equal(connection.streamHealth.observedSampleRateHz, POLAR_REPLAY_SAMPLE_RATE_HZ);
  assert.equal(totalSamples, POLAR_REPLAY_SAMPLE_RATE_HZ);
  assert.equal(latestHealth.sampleCount, POLAR_REPLAY_SAMPLE_RATE_HZ);
  assert.equal(latestHealth.observedSampleRateHz, POLAR_REPLAY_SAMPLE_RATE_HZ);
  assert.equal(latestHealth.maximumGapMs, 20);
  assert.ok(Number.isFinite(latestMetrics.values.heart_rate));
  assert.ok(Number.isFinite(latestMetrics.values.ecg_rms));
  assert.ok(Number.isFinite(latestMetrics.values.ecg_peak_to_peak));
  assert.ok(ecgEvents.every((event) => event.microvolts.every(Number.isFinite)));
  assert.deepEqual(session.diagnosticSnapshot(), {
    mock: true,
    secureContext: true,
    apiAvailable: true,
    adapterAvailability: "not-used",
    userActivationAtRequest: true,
    chooser: "not used",
    stage: "live",
    gattAttempt: 0,
    gattAttemptsTotal: 0,
    pmdResponse: "synthetic fixture",
    firstEcgFrame: true,
    lastErrorCode: "",
    lastErrorMessage: "",
  });

  const eventCountBeforeStop = events.length;
  await session.disconnect();
  clock.advance(1_000);
  assert.equal(events.length, eventCountBeforeStop + 2);
  assert.equal(events.at(-2).connected, false);
  assert.equal(events.at(-1).snapshot.stage, "idle");
});

test("synthetic Polar replay requires the explicit non-persistent query flag", () => {
  assert.equal(polarReplayEnabled({ href: "https://example.test/?mock-polar=1" }), true);
  assert.equal(polarReplayEnabled({ href: "https://example.test/?mock-polar=0" }), false);
  assert.equal(polarReplayEnabled({ href: "https://example.test/" }), false);
  assert.equal(polarReplayEnabled({ href: "not a url" }), false);
});
