import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmMediaPlaybackAfterReport,
  createRemoteMirrorFailureRevocation,
  dispatchPauseWithSafetyFence,
  evidencePersistenceFailureDisposition,
  externalParticipantSafetyTransition,
  externalParticipantTransition,
  fenceDisallowedMediaPlayback,
  mediaAdaptersAllowed,
  participantPausePresentation,
  requestRemoteMediaResume,
  revokeRemoteControl,
  scheduleSingleFlight,
} from "../site/src/study/participant-ui.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function detail(actionType, phase, revision = 7) {
  return {
    action: { command: { type: actionType } },
    outcome: { state: { phase, revision } },
  };
}

test("external participant outcomes map to one explicit UI/adapter transition", () => {
  const cases = [
    ["arm", "armed", "prepared"],
    ["start", "running", "render-block"],
    ["pause", "paused", "pause-media"],
    ["resume", "running", "resume-media"],
    ["advance", "running", "render-block"],
    ["retryBlock", "running", "render-block"],
    ["retryBlock", "paused", "render-block"],
    ["advance", "awaitingFinalization", "await-finalization"],
    ["stop", "completed", "terminal"],
    ["finalize", "completed", "terminal"],
    ["abort", "aborted", "terminal"],
  ];
  for (const [actionType, phase, kind] of cases) {
    assert.deepEqual(externalParticipantTransition(detail(actionType, phase)), {
      actionType,
      kind,
      phase,
      revision: 7,
    });
  }
});

test("external participant transition projection ignores malformed and ineligible outcomes", () => {
  assert.equal(externalParticipantTransition(undefined), undefined);
  assert.equal(externalParticipantTransition(detail("recordAffectSample", "running")), undefined);
  assert.equal(externalParticipantTransition({
    action: { command: { type: "start" } },
    outcome: { state: { phase: "running", revision: 1.5 } },
  }), undefined);
  assert.equal(externalParticipantTransition({
    ...detail("pause", "paused"),
    error: new Error("mirror commit failed"),
  }), undefined, "an uncommitted mirror outcome must not be projected as a committed UI transition");
});

test("only accepted transitions that can expose stale participant content request a pre-commit safety fence", () => {
  assert.deepEqual(externalParticipantSafetyTransition(detail("pause", "paused", 8)), {
    kind: "pause-media",
    revision: 8,
  });
  for (const [action, phase] of [
    ["advance", "running"],
    ["retryBlock", "running"],
    ["stop", "completed"],
    ["finalize", "completed"],
    ["abort", "aborted"],
  ]) {
    assert.deepEqual(externalParticipantSafetyTransition(detail(action, phase, 9)), {
      kind: "retire-block",
      revision: 9,
    });
  }
  assert.equal(externalParticipantSafetyTransition(detail("resume", "running")), undefined);
  assert.equal(externalParticipantSafetyTransition(detail("start", "running")), undefined);
});

test("the first browser-mirror failure revokes remote control exactly once", async () => {
  const reasons = [];
  const revoke = createRemoteMirrorFailureRevocation({
    async stop(reason) {
      reasons.push(reason);
    },
  });

  await Promise.all([revoke(), revoke(), revoke()]);
  assert.deepEqual(reasons, ["browser_mirror_failure"]);
});

test("remote resume preserves a blocked desktop-video warning and does not invent playback", async () => {
  let playAttempts = 0;
  const blocked = new Error("play() requires a local gesture");
  const result = await requestRemoteMediaResume({
    video: {
      paused: true,
      async play() {
        playAttempts += 1;
        throw blocked;
      },
    },
  });

  assert.equal(playAttempts, 1);
  assert.equal(result.started, false);
  assert.equal(result.error, blocked);
  assert.match(result.message, /video paused/i);
  assert.match(result.message, /Press Play locally/);
});

test("local remote revocation touches only the controller boundary", async () => {
  const nativeState = { runId: "run-one", phase: "running", revision: 8 };
  const calls = [];
  assert.equal(await revokeRemoteControl({
    async stop(reason) {
      calls.push(reason);
    },
  }), true);
  assert.deepEqual(calls, ["local_revoke"]);
  assert.deepEqual(nativeState, { runId: "run-one", phase: "running", revision: 8 });
});

test("paused video and YouTube play signals are re-fenced before reporting or sampling", () => {
  for (const reportsSuppressed of [false, true]) {
    let pauses = 0;
    let playingReports = 0;
    let samples = 0;
    let timers = 0;
    const fenced = fenceDisallowedMediaPlayback({
      phase: "paused",
      reportsSuppressed,
      pause: () => { pauses += 1; },
    });
    if (!fenced) {
      playingReports += 1;
      samples += 1;
      timers += 1;
    }
    assert.equal(fenced, true);
    assert.equal(pauses, 1);
    assert.equal(playingReports, 0);
    assert.equal(samples, 0);
    assert.equal(timers, 0);
  }
  assert.equal(fenceDisallowedMediaPlayback({ phase: "running", pause: () => assert.fail() }), false);
  assert.deepEqual(participantPausePresentation("paused"), {
    reportsSuppressed: true,
    buttonLabel: "Resume",
  });
  assert.equal(mediaAdaptersAllowed({
    adapterEpoch: 4,
    currentAdapterEpoch: 4,
    phase: "running",
  }), true);
  assert.equal(mediaAdaptersAllowed({
    adapterEpoch: 4,
    currentAdapterEpoch: 4,
    phase: "paused",
  }), false);
  assert.equal(mediaAdaptersAllowed({
    adapterEpoch: 4,
    currentAdapterEpoch: 4,
    phase: "running",
    reportsSuppressed: true,
  }), false);
});

test("a pause committed while a playing report persists cannot restart media adapters", async () => {
  const reportGate = deferred();
  let phase = "running";
  let reportsSuppressed = false;
  let fences = 0;
  let adaptersStarted = 0;
  const confirmation = confirmMediaPlaybackAfterReport({
    report: () => reportGate.promise,
    isAllowed: () => phase === "running" && !reportsSuppressed,
    fence: () => { fences += 1; },
  });

  phase = "paused";
  reportsSuppressed = true;
  reportGate.resolve();
  if (await confirmation) adaptersStarted += 1;

  assert.equal(adaptersStarted, 0);
  assert.equal(fences, 1);
});

test("a rejected initial playing report fences media instead of escaping the event handler", async () => {
  const failure = new Error("injected journal failure");
  let fences = 0;
  let observed;
  const confirmed = await confirmMediaPlaybackAfterReport({
    report: async () => { throw failure; },
    isAllowed: () => true,
    fence: (error) => {
      fences += 1;
      observed = error;
    },
  });

  assert.equal(confirmed, false);
  assert.equal(fences, 1);
  assert.equal(observed, failure);
});

test("local pause intent fences physical adapters before its durable dispatch settles", async () => {
  const commitGate = deferred();
  const order = [];
  const pending = dispatchPauseWithSafetyFence({
    fence: () => order.push("media-fenced"),
    dispatch: async () => {
      order.push("dispatch-started");
      await commitGate.promise;
      order.push("dispatch-committed");
      return "paused";
    },
  });

  assert.deepEqual(order, ["media-fenced", "dispatch-started"]);
  commitGate.resolve();
  assert.equal(await pending, "paused");
  assert.deepEqual(order, ["media-fenced", "dispatch-started", "dispatch-committed"]);
});

test("20 Hz sampling is single-flight and drops occupied ticks without replay", async () => {
  const holder = { current: undefined };
  const firstGate = deferred();
  let calls = 0;
  const run = () => {
    calls += 1;
    return calls === 1 ? firstGate.promise : Promise.resolve();
  };

  assert.equal(scheduleSingleFlight(holder, run), true);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(scheduleSingleFlight(holder, run), false);
  }
  assert.equal(calls, 1);
  const first = holder.current;
  firstGate.resolve();
  await first;
  await Promise.resolve();
  assert.equal(holder.current, undefined);

  assert.equal(scheduleSingleFlight(holder, run), true);
  assert.equal(calls, 2, "only a future timer tick may create the next sample");
  await holder.current;
});

test("a rejected timed write without authority acceptance restores ordinary researcher choices", () => {
  assert.deepEqual(evidencePersistenceFailureDisposition(undefined), {
    acceptedOutcomeStaged: false,
    allowExactRetry: false,
    allowPartialRetention: false,
    restoreOrdinaryControls: true,
  });
  assert.deepEqual(evidencePersistenceFailureDisposition({ type: "recordAffectSample" }), {
    acceptedOutcomeStaged: true,
    allowExactRetry: true,
    allowPartialRetention: true,
    restoreOrdinaryControls: false,
  });
});
