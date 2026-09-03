import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";

import {
  BRSPConnection,
  makeEnvelope,
} from "../site/vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/brsp.js";
import {
  DesktopStudyQuickPairTarget,
  deriveQuickPairKeys as deriveTargetKeys,
  projectNativeStudyRunState,
} from "../site/src/remote-study/desktop-quick-pair-target.js";
import {
  OneTimeInvitationStore,
  createQrInvitation,
  parseQrInvitationUrl,
} from "../site/src/remote-study/invitation.js";
import {
  RemoteStudyQuickPairController,
  deriveQuickPairKeys,
} from "../site/src/remote-study/quick-pair.js";
import { createQrMatrix } from "../site/src/remote-study/qr-code.js";
import { formatRemoteRoute } from "../site/src/remote-study/controller-view.js";
import {
  copyInvitationLink,
  grantedRemoteScopeText,
  selectInvitationText,
} from "../site/src/remote-study/desktop-quick-pair-ui.js";
import {
  AdmissionControlledBRSPConnection,
  REMOTE_STUDY_INBOUND_COMMAND_MAX_COUNT,
} from "../site/src/remote-study/transport-guards.js";

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

test("desktop remote UI distinguishes offered scopes from an active grant", () => {
  assert.equal(grantedRemoteScopeText({
    scopes: ["study.observe", "study.control"],
    lease: { active: false },
  }), "None");
  assert.equal(grantedRemoteScopeText({
    scopes: ["study.observe", "study.control"],
    lease: { active: true, scopes: ["study.observe"] },
  }), "study.observe");
});

test("rejected clipboard access resolves and selects the mounted invitation field", async () => {
  let focused = 0;
  let selected = 0;
  const field = {
    focus() { focused += 1; },
    select() { selected += 1; },
  };
  const host = {
    querySelector(selector) {
      return selector === "#study-remote-invitation-url" ? field : null;
    },
  };
  assert.equal(await copyInvitationLink({
    invitationUrl: "https://example.test/study-remote.html#invite=secret",
    clipboard: { writeText: async () => { throw new Error("denied"); } },
    host,
  }), "selected");
  assert.equal(focused, 1);
  assert.equal(selected, 1);
  assert.equal(selectInvitationText(undefined), false);
});

class MemoryTransport extends EventTarget {
  constructor(name, peerKey = "quick-pair-test-link") {
    super();
    this.name = name;
    this.peerKey = peerKey;
    this.partner = undefined;
    this.phase = "idle";
    this.open = false;
    this.starts = 0;
    this.stops = 0;
    this.duplicateNextControl = false;
    this.sentControls = [];
  }

  connect(partner) {
    this.partner = partner;
  }

  async start() {
    this.starts += 1;
    this.phase = "started";
    this.openPairWhenReady();
  }

  openPairWhenReady() {
    if (this.phase !== "started" || this.partner?.phase !== "started" || this.open) return;
    this.open = true;
    this.partner.open = true;
    queueMicrotask(() => {
      this.dispatchEvent(detailEvent("peeropen", { peerKey: this.peerKey }));
      this.partner.dispatchEvent(detailEvent("peeropen", { peerKey: this.peerKey }));
    });
  }

  sendControl(peerKey, data) {
    if (!this.open || peerKey !== this.peerKey || !this.partner?.open) return false;
    this.sentControls.push(data);
    const receiver = this.partner;
    const deliveries = this.duplicateNextControl ? 2 : 1;
    this.duplicateNextControl = false;
    for (let index = 0; index < deliveries; index += 1) {
      queueMicrotask(() => receiver.dispatchEvent(detailEvent("controlmessage", { peerKey, data })));
    }
    return true;
  }

  sendState(peerKey, data) {
    if (!this.open || peerKey !== this.peerKey || !this.partner?.open) return false;
    const receiver = this.partner;
    queueMicrotask(() => receiver.dispatchEvent(detailEvent("statemessage", { peerKey, data })));
    return true;
  }

  closePeer(peerKey) {
    if (peerKey !== this.peerKey) return;
    this.open = false;
    if (this.partner) this.partner.open = false;
  }

  async stop() {
    this.stops += 1;
    this.phase = "closed";
    this.closePeer(this.peerKey);
  }
}

function memoryPair() {
  const target = new MemoryTransport("target");
  const controller = new MemoryTransport("controller");
  target.connect(controller);
  controller.connect(target);
  return { target, controller };
}

function nativeState() {
  return {
    schema: "affect-tracker-run-state",
    version: 1,
    authorityGeneration: 7,
    revision: 4,
    runId: "run-quick-pair-1",
    protocolHash: "a".repeat(64),
    phase: "armed",
    currentSectionId: "main",
    currentTrialId: "trial-1",
    currentBlockId: "stimulus-1",
    resolvedOrder: [],
    mediaTimelineAnchor: null,
    stall: null,
    health: {
      storage: { status: "ready" },
      input: { status: "ready" },
      lsl: { status: "ready" },
    },
    appliedSettingsSha256: "b".repeat(64),
    affectCalibration: null,
    completedQuestionnaireBlocks: [],
    completionStatus: null,
    lastEventSequence: 4,
    lastEventMonotonicMs: 400,
    participantPath: "C:/private/participant.csv",
    participantCode: "not-for-controller",
  };
}

function fixedTimers() {
  let next = 1;
  const active = new Set();
  return {
    set(fn, milliseconds) {
      assert.equal(typeof fn, "function");
      assert.ok(milliseconds >= 0);
      const id = next++;
      active.add(id);
      return id;
    },
    clear(id) {
      active.delete(id);
    },
    active,
  };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deterministicInvitation() {
  return {
    locator: "inv_AAECAwQFBgcICQoL",
    secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class StubConnection extends EventTarget {
  constructor({ transport, principalId = "controller_security_1", phase = "ready" } = {}) {
    super();
    this.transport = transport;
    this.principalId = principalId;
    this.phase = phase;
    this.published = [];
    this.closeCalls = 0;
    this.sentCommands = [];
  }

  snapshot() {
    return {
      phase: this.phase,
      remotePeerId: this.principalId,
      acceptedScopes: ["study.observe", "study.control"],
      pendingCommands: 0,
    };
  }

  publishState(state, options) {
    this.published.push({ state: structuredClone(state), options: structuredClone(options) });
  }

  isStateStale() {
    return false;
  }

  sendCommand(...args) {
    this.sentCommands.push(args);
    return "cmd_stub_controller_1";
  }

  async close() {
    this.closeCalls += 1;
    this.phase = "closed";
    await this.transport?.stop?.();
  }
}

class DeferredStartTransport extends EventTarget {
  constructor(startGate = deferred()) {
    super();
    this.startGate = startGate;
    this.phase = "idle";
    this.starts = 0;
    this.stops = 0;
  }

  async start() {
    this.starts += 1;
    this.phase = "starting";
    await this.startGate.promise;
    this.phase = "started";
  }

  async stop() {
    this.stops += 1;
    this.phase = "closed";
  }
}

function startCommand(state, overrides = {}) {
  return {
    commandId: overrides.commandId ?? "cmd_security_start_1",
    scope: "study.control",
    action: overrides.action ?? "start",
    expectedRevision: overrides.expectedRevision ?? state.revision,
    args: {
      authorityGeneration: overrides.authorityGeneration ?? state.authorityGeneration,
      runId: overrides.runId ?? state.runId,
      precondition: overrides.precondition ?? {
        phase: state.phase,
        blockId: state.currentBlockId,
      },
      payload: overrides.payload ?? {},
    },
  };
}

function authorizeTarget(target, {
  state = nativeState(),
  nowMs = 1_000,
  principalId = "controller_security_1",
  connection = new StubConnection({ principalId }),
} = {}) {
  target.nativeState = structuredClone(state);
  target.remoteState = projectNativeStudyRunState(state);
  target.connection = connection;
  target.phase = "ready";
  target.invitationConsumed = true;
  target.lease.claim({
    grantId: "grant_security_1",
    authorityGeneration: state.authorityGeneration,
    principalId,
    principalLabel: "Security test controller",
    authenticationMethod: "qr-invitation",
    scopes: ["study.observe", "study.control"],
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + (8 * 60 * 60 * 1_000),
    revoked: false,
  }, nowMs);
  return connection;
}

test("the vendored BRSP runtime matches the pinned upstream LF receipts", async () => {
  const base = "../site/vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/";
  const receipts = {
    "brsp.js": "7f28058297388a128e3acfc146248b627921d4629b8f3a575d80d3f6ff0b6911",
    "vdo-ninja-transport.js": "79ca3077c05d4eb1a1a07fd9d652a60f93901d9d6a85aa2659ef6ed798a6c003",
  };
  const notice = await readFile(new URL(`${base}NOTICE.md`, import.meta.url), "utf8");
  for (const [name, expected] of Object.entries(receipts)) {
    const source = await readFile(new URL(`${base}${name}`, import.meta.url), "utf8");
    const normalized = source.replaceAll("\r\n", "\n");
    assert.equal(createHash("sha256").update(normalized).digest("hex"), expected);
    assert.match(notice, new RegExp(`${name.replace(".", "\\.")}: ${expected}`));
  }
});

test("QR key derivation is deterministic, context-bound, and separates BRSP from VDO", async () => {
  const invitation = deterministicInvitation();
  const left = await deriveQuickPairKeys(invitation, { crypto: webcrypto });
  const right = await deriveQuickPairKeys(invitation, { crypto: webcrypto });
  const desktop = await deriveTargetKeys(invitation, { crypto: webcrypto });

  assert.deepEqual(left, right);
  assert.deepEqual(left, desktop, "the desktop and public controller derive interoperable labelled keys");
  assert.notEqual(left.brspProofKey, left.privateVdoTransportKey);
  assert.equal(Buffer.from(left.brspProofKey, "base64url").byteLength, 32);
  assert.equal(Buffer.from(left.privateVdoTransportKey, "base64url").byteLength, 32);

  const anotherLocator = await deriveQuickPairKeys({ ...invitation, locator: "inv_AAECAwQFBgcICQoM" }, { crypto: webcrypto });
  assert.notDeepEqual(left, anotherLocator, "the private session locator is part of the derivation context");
});

test("constructing the QR target and controller is network-inert", () => {
  let transportConstructions = 0;
  const transportFactory = () => {
    transportConstructions += 1;
    return new MemoryTransport("unused");
  };
  const target = new DesktopStudyQuickPairTarget({
    invoke: async () => nativeState(),
    transportFactory,
  });
  const controller = new RemoteStudyQuickPairController({
    invitation: deterministicInvitation(),
    transportFactory,
  });
  assert.equal(transportConstructions, 0);
  assert.equal(target.snapshot().phase, "disabled");
  assert.equal(controller.snapshot().phase, "idle");
});

test("the disconnected controller route renders without a transport snapshot", () => {
  assert.equal(formatRemoteRoute(undefined), "Unknown");
  assert.equal(formatRemoteRoute({ route: "turnRelay", rttMs: 47 }), "Turn Relay · 47 ms RTT");
});

test("the desktop target refuses to construct a route without an active native run", async () => {
  let transportConstructions = 0;
  const target = new DesktopStudyQuickPairTarget({
    invoke: async () => {
      const error = new Error("No active study run.");
      error.code = "no_active_study_run";
      throw error;
    },
    transportFactory: () => {
      transportConstructions += 1;
      return new MemoryTransport("must-not-exist");
    },
  });
  await assert.rejects(target.enable(), /No active study run/);
  assert.equal(transportConstructions, 0);
  assert.equal(target.snapshot().phase, "error");
});

test("the local QR encoder keeps the production invitation in its verified Version 7 envelope", () => {
  const invitation = createQrInvitation({
    companionUrl: "https://GeorgeFejer91.github.io/affect-tracker-web/study-remote.html",
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    nowMs: 1_000,
  });
  const matrix = createQrMatrix(invitation.url);
  assert.equal(matrix.length, 45);
  assert.equal(matrix.every((row) => row.length === 45), true);
  assert.equal(
    createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
    "2a98c8a70ea83f0c543f8eb90b1eafcfbd0b7b4a145617bb4fc44b347835672b",
  );
});

test("BRSP quick pair maps typed controls once, drains cached retries, rejects stale commands, and tears down", async () => {
  const pair = memoryPair();
  const targetTimers = fixedTimers();
  const controllerTimers = fixedTimers();
  const transportOptions = {};
  const connectionOptions = {};
  let state = nativeState();
  const nativeActions = [];
  const invokeCalls = [];
  const invoke = async (commandName, args) => {
    invokeCalls.push(commandName);
    if (commandName === "get_study_run_state") return structuredClone(state);
    assert.equal(commandName, "apply_study_action");
    nativeActions.push(structuredClone(args.action));
    state = {
      ...state,
      phase: args.action.command.type === "start" ? "running" : state.phase,
      revision: state.revision + 1,
      lastEventSequence: state.lastEventSequence + 1,
      lastEventMonotonicMs: args.action.clock.monotonicMs,
    };
    return { state: structuredClone(state), events: [] };
  };
  const invitationStore = new OneTimeInvitationStore({
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
    now: () => 1_000,
  });
  const target = new DesktopStudyQuickPairTarget({
    invoke,
    companionUrl: "https://example.test/study-remote.html",
    invitationStore,
    now: () => 1_000,
    monotonicNow: () => 1_000,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
    transportFactory: (options) => {
      Object.assign(transportOptions, { target: options });
      return pair.target;
    },
    connectionFactory: (options) => {
      Object.assign(connectionOptions, { target: options });
      return new AdmissionControlledBRSPConnection(options);
    },
    setIntervalFn: targetTimers.set,
    clearIntervalFn: targetTimers.clear,
    setTimeoutFn: targetTimers.set,
    clearTimeoutFn: targetTimers.clear,
  });

  await target.enable();
  const invitationUrl = target.snapshot().invitationUrl;
  const invitation = parseQrInvitationUrl(invitationUrl, { expectedOrigin: "https://example.test" });
  const controller = new RemoteStudyQuickPairController({
    invitation,
    monotonicNow: () => 1_000,
    transportFactory: (options) => {
      Object.assign(transportOptions, { controller: options });
      return pair.controller;
    },
    connectionFactory: (options) => {
      Object.assign(connectionOptions, { controller: options });
      return new BRSPConnection(options);
    },
    setIntervalFn: controllerTimers.set,
    clearIntervalFn: controllerTimers.clear,
  });
  await controller.connect();
  await waitFor(() => controller.snapshot().state?.revision === 4, "initial native state was not synchronized");

  assert.equal(target.snapshot().invitationConsumed, true);
  assert.deepEqual(new Set(controller.snapshot().acceptedScopes), new Set(["study.observe", "study.control"]));
  assert.equal(transportOptions.target.room, transportOptions.controller.room);
  assert.equal(transportOptions.target.sharedSecret, transportOptions.controller.sharedSecret);
  assert.equal(connectionOptions.target.sharedSecret, connectionOptions.controller.sharedSecret);
  assert.notEqual(transportOptions.target.sharedSecret, connectionOptions.target.sharedSecret);
  assert.equal("participantPath" in controller.snapshot().state, false);
  assert.equal("participantCode" in controller.snapshot().state, false);

  const staleRevisionId = controller.sendStudyAction("start", {}, { expectedRevision: 3 });
  await waitFor(() => controller.snapshot().lastApplied?.commandId === staleRevisionId, "revision rejection was not acknowledged");
  assert.equal(controller.snapshot().lastApplied.error, "revision_conflict");
  assert.equal(nativeActions.length, 0);

  const wrongPreconditionId = controller.sendStudyAction("start", {}, {
    precondition: { phase: "running", blockId: "stimulus-1" },
  });
  await waitFor(() => controller.snapshot().lastApplied?.commandId === wrongPreconditionId, "precondition rejection was not acknowledged");
  assert.equal(controller.snapshot().lastApplied.error, "precondition_failed");
  assert.equal(nativeActions.length, 0);

  const denied = await target.applyRemoteCommand({
    commandId: "cmd_scope_denied",
    scope: "data.export",
    action: "request-record-export",
    expectedRevision: 4,
    args: {},
  });
  assert.deepEqual(denied, { ok: false, revision: 4, error: "scope_denied" });

  pair.controller.duplicateNextControl = true;
  const startId = controller.sendStudyAction("start");
  await waitFor(() => controller.snapshot().lastApplied?.commandId === startId, "start acknowledgement was not received");
  await waitFor(() => controller.snapshot().state?.revision === 5, "updated native state was not published");
  assert.equal(nativeActions.length, 1, "a duplicated wire command must not duplicate the native action");
  assert.equal(nativeActions[0].command.type, "start");
  assert.equal(nativeActions[0].expectedRevision, 4);
  assert.equal(nativeActions[0].precondition.expectedPhase, "armed");
  assert.equal(nativeActions[0].precondition.expectedBlockId, "stimulus-1");
  assert.equal(controller.snapshot().state.phase, "running");

  const originalWireCommand = pair.controller.sentControls
    .map((encoded) => JSON.parse(encoded))
    .find((envelope) => envelope.type === "command" && envelope.body.commandId === startId);
  assert.ok(originalWireCommand);
  let cachedAcknowledgements = 0;
  controller.connection.addEventListener("commandapplied", (event) => {
    if (event.detail.commandId === startId) cachedAcknowledgements += 1;
  });
  const cachedRetryCount = REMOTE_STUDY_INBOUND_COMMAND_MAX_COUNT + 2;
  for (let index = 0; index < cachedRetryCount; index += 1) {
    controller.connection.sendControlEnvelope(makeEnvelope({
      type: "command",
      sessionId: controller.connection.sessionId,
      senderId: controller.connection.peerId,
      senderEpoch: controller.connection.epoch,
      sequence: controller.connection.nextControlSequence(),
      body: structuredClone(originalWireCommand.body),
    }));
  }
  await waitFor(
    () => cachedAcknowledgements === cachedRetryCount,
    "cached command retries were not all acknowledged",
  );
  assert.equal(nativeActions.length, 1, "cached retries must not repeat native mutation");
  assert.deepEqual(connectionOptions.target.transport.admissionSnapshot(), {
    controlCount: 0,
    controlBytes: 0,
    commandCount: 0,
    commandBytes: 0,
    rejected: false,
  });
  assert.equal(target.snapshot().phase, "ready");

  await target.stop("test_complete");
  await controller.stop("test_complete");
  assert.equal(pair.target.stops, 1);
  assert.equal(pair.controller.stops, 1);
  assert.equal(targetTimers.active.size, 0);
  assert.equal(controllerTimers.active.size, 0);
  assert.ok(invokeCalls.includes("get_study_run_state"));
  assert.ok(invokeCalls.includes("apply_study_action"));
});

test("authenticated command admission is bounded before a gated native apply queue", async () => {
  const pair = memoryPair();
  const targetTimers = fixedTimers();
  const controllerTimers = fixedTimers();
  const applyGate = deferred();
  let state = nativeState();
  let applyCalls = 0;
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      if (name === "get_study_run_state") return structuredClone(state);
      assert.equal(name, "apply_study_action");
      applyCalls += 1;
      return applyGate.promise;
    },
    companionUrl: "https://example.test/study-remote.html",
    invitationStore: new OneTimeInvitationStore({
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index),
      now: () => 1_000,
    }),
    now: () => 1_000,
    monotonicNow: () => 1_000,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
    transportFactory: () => pair.target,
    connectionFactory: (options) => new AdmissionControlledBRSPConnection(options),
    setIntervalFn: targetTimers.set,
    clearIntervalFn: targetTimers.clear,
    setTimeoutFn: targetTimers.set,
    clearTimeoutFn: targetTimers.clear,
  });
  await target.enable();
  const invitation = parseQrInvitationUrl(target.snapshot().invitationUrl, {
    expectedOrigin: "https://example.test",
  });
  const controller = new RemoteStudyQuickPairController({
    invitation,
    monotonicNow: () => 1_000,
    transportFactory: () => pair.controller,
    connectionFactory: (options) => new BRSPConnection(options),
    setIntervalFn: controllerTimers.set,
    clearIntervalFn: controllerTimers.clear,
  });
  await controller.connect();
  await waitFor(() => controller.snapshot().state?.revision === state.revision, "initial state was not synchronized");

  controller.sendStudyAction("start");
  await waitFor(() => applyCalls === 1, "the first native action did not reach its gate");
  for (let index = 0; index < REMOTE_STUDY_INBOUND_COMMAND_MAX_COUNT; index += 1) {
    controller.sendStudyAction("start");
  }
  await waitFor(() => target.snapshot().phase === "disabled", "command overflow did not revoke the target route");
  assert.equal(target.snapshot().lease.active, false);
  assert.equal(applyCalls, 1);

  state = { ...state, phase: "running", revision: 5, lastEventSequence: 5 };
  applyGate.resolve({ state: structuredClone(state), events: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(applyCalls, 1, "queued overflow commands must never reach native mutation");
  await controller.stop("test_complete");
});

test("a throttled expiry timer cannot authorize a mutation after the receiver-local lease deadline", async () => {
  let nowMs = 1_000;
  const invokeCalls = [];
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      invokeCalls.push(name);
      return nativeState();
    },
    now: () => nowMs,
  });
  const state = nativeState();
  authorizeTarget(target, { state, nowMs });

  nowMs = 16_000;
  const outcome = await target.applyRemoteCommand(startCommand(state));

  assert.deepEqual(outcome, { ok: false, revision: 4, error: "lease_expired" });
  assert.deepEqual(invokeCalls, [], "expiry must be checked at acceptance without waiting for a timer callback");
  assert.equal(target.snapshot().lease.active, false);
});

test("an authenticated principal cannot use a lease claimed by a different controller", async () => {
  const invokeCalls = [];
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      invokeCalls.push(name);
      return nativeState();
    },
    now: () => 1_000,
  });
  const state = nativeState();
  const connection = authorizeTarget(target, { state });
  connection.principalId = "controller_security_2";

  const outcome = await target.applyRemoteCommand(startCommand(state));

  assert.deepEqual(outcome, { ok: false, revision: 4, error: "lease_not_owned" });
  assert.deepEqual(invokeCalls, []);
});

test("a replacement native authority generation rejects a command before native mutation", async () => {
  const invokeCalls = [];
  const replacement = {
    ...nativeState(),
    authorityGeneration: 8,
    revision: 0,
    runId: "run-quick-pair-2",
    phase: "prepared",
  };
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      invokeCalls.push(name);
      if (name === "get_study_run_state") return structuredClone(replacement);
      throw new Error("native mutation must not be invoked");
    },
    now: () => 1_000,
  });
  const state = nativeState();
  authorizeTarget(target, { state });

  const outcome = await target.applyRemoteCommand(startCommand(state));

  assert.deepEqual(outcome, { ok: false, revision: 4, error: "stale_generation" });
  assert.deepEqual(invokeCalls, ["get_study_run_state"]);
  assert.equal(target.snapshot().phase, "disabled");
  assert.equal(target.snapshot().state.authorityGeneration, 7, "replacement state must not cross the old grant");
});

test("a passive refresh revokes an old-generation controller without publishing replacement state", async () => {
  const replacement = {
    ...nativeState(),
    authorityGeneration: 8,
    revision: 0,
    runId: "run-quick-pair-2",
    phase: "prepared",
  };
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      assert.equal(name, "get_study_run_state");
      return structuredClone(replacement);
    },
    now: () => 1_000,
  });
  const connection = authorizeTarget(target);

  const refreshed = await target.refreshNativeState();

  assert.equal(refreshed.authorityGeneration, 7);
  assert.equal(target.snapshot().state.authorityGeneration, 7);
  assert.equal(connection.published.length, 0);
  assert.equal(connection.closeCalls, 1);
  assert.equal(target.snapshot().lease.lastRevocation.reason, "authority_generation_changed");
  assert.equal(target.snapshot().phase, "disabled");
});

test("a delayed native poll cannot regress or publish state after a newer applied revision", async () => {
  const pollGate = deferred();
  const initial = nativeState();
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      assert.equal(name, "get_study_run_state");
      return pollGate.promise;
    },
    now: () => 1_000,
  });
  const connection = authorizeTarget(target, { state: initial });
  const polling = target.refreshNativeState();
  const applied = {
    ...initial,
    revision: 5,
    phase: "running",
    lastEventSequence: 5,
    lastEventMonotonicMs: 500,
  };
  target.nativeState = structuredClone(applied);
  target.remoteState = projectNativeStudyRunState(applied);

  pollGate.resolve(initial);
  const result = await polling;

  assert.equal(result.revision, 5);
  assert.equal(result.phase, "running");
  assert.equal(target.snapshot().state.revision, 5);
  assert.equal(connection.published.length, 0);
});

test("a late applied acknowledgement cannot overwrite a newer concurrent native refresh", async () => {
  const applyGate = deferred();
  const initial = nativeState();
  const applied = {
    ...initial,
    revision: 5,
    phase: "running",
    lastEventSequence: 5,
    lastEventMonotonicMs: 500,
  };
  const newer = {
    ...applied,
    revision: 6,
    phase: "paused",
    lastEventSequence: 6,
    lastEventMonotonicMs: 600,
  };
  let getCalls = 0;
  let applyCalls = 0;
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      if (name === "get_study_run_state") {
        getCalls += 1;
        return structuredClone(getCalls === 1 ? initial : newer);
      }
      assert.equal(name, "apply_study_action");
      applyCalls += 1;
      return applyGate.promise;
    },
    now: () => 1_000,
    monotonicNow: () => 500,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  const connection = authorizeTarget(target, { state: initial });

  const applying = target.applyRemoteCommand(startCommand(initial, {
    commandId: "cmd_late_applied_1",
  }));
  await waitFor(() => applyCalls === 1, "native action was not awaiting in flight");
  const refreshed = await target.refreshNativeState();
  assert.equal(refreshed.revision, 6);
  applyGate.resolve({ state: applied, events: [] });
  const outcome = await applying;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.revision, 5, "the accepted action keeps its own acknowledgement revision");
  assert.equal(outcome.result.state.revision, 5);
  assert.equal(target.snapshot().state.revision, 6);
  assert.equal(target.snapshot().state.phase, "paused");
  assert.equal(getCalls, 2);
  assert.equal(applyCalls, 1);
  assert.deepEqual(connection.published.map(({ state }) => state.revision), [6]);
});

test("pagehide Stop fences a pending initial native-state read before any transport construction", async () => {
  const initialState = deferred();
  let transportConstructions = 0;
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      assert.equal(name, "get_study_run_state");
      return initialState.promise;
    },
    transportFactory: () => {
      transportConstructions += 1;
      return new DeferredStartTransport();
    },
  });

  const enabling = target.enable();
  assert.equal(target.snapshot().phase, "enabling");
  await target.stop("pagehide");
  initialState.resolve(nativeState());
  await enabling;

  assert.equal(transportConstructions, 0);
  assert.equal(target.snapshot().phase, "disabled");
  assert.equal(target.snapshot().invitationUrl, undefined);
  assert.equal(target.transport, undefined);
});

test("a QR invitation remains bound to its original run before proof acceptance", async () => {
  const startGate = deferred();
  const transport = new DeferredStartTransport(startGate);
  let connection;
  let state = nativeState();
  const issuedFor = structuredClone(state);
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      assert.equal(name, "get_study_run_state");
      return structuredClone(state);
    },
    transportFactory: () => transport,
    connectionFactory: ({ transport: selectedTransport }) => {
      connection = new StubConnection({ transport: selectedTransport, phase: "connecting" });
      return connection;
    },
  });

  const enabling = target.enable();
  await waitFor(() => connection !== undefined, "the pre-auth connection was not constructed");
  state = {
    ...state,
    authorityGeneration: state.authorityGeneration + 1,
    runId: "run-replaced-before-proof",
    protocolHash: "c".repeat(64),
    revision: 0,
  };
  const refreshed = await target.refreshNativeState();

  assert.equal(refreshed.authorityGeneration, issuedFor.authorityGeneration);
  assert.equal(target.snapshot().state.runId, issuedFor.runId);
  assert.equal(target.snapshot().phase, "disabled");
  assert.equal(connection.published.length, 0);
  startGate.resolve();
  await enabling;
  assert.equal(target.snapshot().phase, "disabled");
});

test("a command joins a slow poll and evaluates the fresh revision and phase", async () => {
  const pollGate = deferred();
  let getCalls = 0;
  let applyCalls = 0;
  const oldState = nativeState();
  const freshState = {
    ...oldState,
    revision: 5,
    phase: "running",
    lastEventSequence: 5,
    lastEventMonotonicMs: 500,
  };
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      if (name === "get_study_run_state") {
        getCalls += 1;
        return pollGate.promise;
      }
      assert.equal(name, "apply_study_action");
      applyCalls += 1;
      return {
        state: {
          ...freshState,
          revision: 6,
          lastEventSequence: 6,
          lastEventMonotonicMs: 600,
        },
        events: [],
      };
    },
    now: () => 1_000,
    monotonicNow: () => 600,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  const connection = authorizeTarget(target, { state: oldState });

  const polling = target.refreshNativeState();
  const applying = target.applyRemoteCommand(startCommand(freshState, {
    action: "advance",
    commandId: "cmd_fresh_poll_1",
  }));
  await Promise.resolve();
  assert.equal(applyCalls, 0, "the command must not evaluate cached state while the poll is in flight");
  pollGate.resolve(freshState);
  const [polled, outcome] = await Promise.all([polling, applying]);

  assert.equal(polled.revision, 5);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.revision, 6);
  assert.equal(getCalls, 1, "poll and command must share one native read");
  assert.equal(applyCalls, 1);
  assert.equal(connection.published.length, 1, "coalesced publish intent must emit one fresh state");
  assert.equal(connection.published[0].state.revision, 5);
});

test("an old deferred refresh cannot assign or publish after Stop and re-enable", async () => {
  const oldRefreshGate = deferred();
  const startedGate = deferred();
  startedGate.resolve();
  const newTransport = new DeferredStartTransport(startedGate);
  let newConnection;
  let getCalls = 0;
  const replacement = {
    ...nativeState(),
    authorityGeneration: 9,
    revision: 0,
    runId: "run-new-session-9",
    phase: "prepared",
  };
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      assert.equal(name, "get_study_run_state");
      getCalls += 1;
      return getCalls === 1 ? oldRefreshGate.promise : structuredClone(replacement);
    },
    transportFactory: () => newTransport,
    connectionFactory: ({ transport }) => {
      newConnection = new StubConnection({ transport, phase: "connecting" });
      return newConnection;
    },
  });
  const oldConnection = authorizeTarget(target);

  const oldRefresh = target.refreshNativeState();
  await target.stop("pagehide");
  await target.enable();
  assert.equal(target.snapshot().state.authorityGeneration, 9);

  oldRefreshGate.resolve({
    ...nativeState(),
    authorityGeneration: 8,
    runId: "run-stale-session-8",
  });
  const oldResult = await oldRefresh;

  assert.equal(oldResult.authorityGeneration, 9);
  assert.equal(target.snapshot().state.authorityGeneration, 9);
  assert.equal(oldConnection.published.length, 0);
  assert.equal(newConnection.published.length, 0);
  assert.equal(getCalls, 2);
  await target.stop("test_complete");
});

test("native success remains successful when its accepted lease is revoked while apply is pending", async () => {
  const applyGate = deferred();
  let nowMs = 1_000;
  let applyCalls = 0;
  const state = nativeState();
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      if (name === "get_study_run_state") return structuredClone(state);
      assert.equal(name, "apply_study_action");
      applyCalls += 1;
      return applyGate.promise;
    },
    now: () => nowMs,
    monotonicNow: () => 500,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  authorizeTarget(target, { state, nowMs });

  const applying = target.applyRemoteCommand(startCommand(state));
  await waitFor(() => applyCalls === 1, "native apply was not reached");
  nowMs = 16_000;
  assert.equal(target.lease.revoke({ reason: "local_stop" }, nowMs), true);
  applyGate.resolve({
    state: {
      ...state,
      revision: 5,
      phase: "running",
      lastEventSequence: 5,
      lastEventMonotonicMs: 500,
    },
    events: [],
  });
  const outcome = await applying;

  assert.equal(applyCalls, 1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.revision, 5);
  assert.equal(outcome.result.state.phase, "running");
});

test("peer loss permits only an already-in-flight native action and fences queued semantic work", async () => {
  const firstApplyGate = deferred();
  let nowMs = 1_000;
  let getCalls = 0;
  let applyCalls = 0;
  const state = nativeState();
  const target = new DesktopStudyQuickPairTarget({
    invoke: async (name) => {
      if (name === "get_study_run_state") {
        getCalls += 1;
        return structuredClone(state);
      }
      assert.equal(name, "apply_study_action");
      applyCalls += 1;
      if (applyCalls > 1) throw new Error("queued post-disconnect mutation reached native code");
      return firstApplyGate.promise;
    },
    now: () => nowMs,
    monotonicNow: () => 500,
    wallNow: () => new Date("2026-09-03T10:00:00.000Z"),
  });
  const connection = authorizeTarget(target, { state, nowMs });
  const session = { lifecycleEpoch: target.lifecycleEpoch, connection };

  const first = target.applyRemoteCommand(startCommand(state, {
    commandId: "cmd_inflight_1",
  }), session);
  await waitFor(() => applyCalls === 1, "first native action was not in flight");
  connection.phase = "disconnected";
  target.phase = "disconnected";
  nowMs = 16_000;
  const queued = first.then(() => target.applyRemoteCommand(startCommand(state, {
    action: "advance",
    commandId: "cmd_queued_after_disconnect_1",
  }), session));
  firstApplyGate.resolve({
    state: {
      ...state,
      revision: 5,
      phase: "running",
      lastEventSequence: 5,
      lastEventMonotonicMs: 500,
    },
    events: [],
  });
  const [firstOutcome, queuedOutcome] = await Promise.all([first, queued]);

  assert.equal(firstOutcome.ok, true);
  assert.equal(firstOutcome.revision, 5);
  assert.deepEqual(queuedOutcome, { ok: false, revision: 5, error: "controller_disconnected" });
  assert.equal(applyCalls, 1);
  assert.equal(getCalls, 1, "queued work must fail before even a native state read");
  assert.equal(target.snapshot().lease.active, false, "completion must not renew a disconnected lease");
});

test("controller Stop fences a pending transport start and closes any late completion", async () => {
  const startGate = deferred();
  const transport = new DeferredStartTransport(startGate);
  let connection;
  const controller = new RemoteStudyQuickPairController({
    invitation: deterministicInvitation(),
    transportFactory: () => transport,
    connectionFactory: ({ transport: selectedTransport }) => {
      connection = new StubConnection({ transport: selectedTransport, phase: "connecting" });
      return connection;
    },
  });

  const connecting = controller.connect();
  await waitFor(() => transport.starts === 1, "controller transport start was not reached");
  await controller.stop("pagehide");
  assert.equal(controller.snapshot().phase, "idle");
  startGate.resolve();
  await connecting;

  assert.equal(controller.snapshot().phase, "idle");
  assert.equal(controller.connection, undefined);
  assert.equal(transport.phase, "closed");
  assert.ok(connection.closeCalls >= 2, "late start completion must be closed again after the lifecycle fence");
});

test("controller peer loss immediately clears state and disables the ready wrapper", async () => {
  const startedGate = deferred();
  startedGate.resolve();
  const timers = fixedTimers();
  const transport = new DeferredStartTransport(startedGate);
  let connection;
  const controller = new RemoteStudyQuickPairController({
    invitation: deterministicInvitation(),
    transportFactory: () => transport,
    connectionFactory: ({ transport: selectedTransport }) => {
      connection = new StubConnection({ transport: selectedTransport, phase: "connecting" });
      return connection;
    },
    setIntervalFn: timers.set,
    clearIntervalFn: timers.clear,
  });
  await controller.connect();
  connection.phase = "ready";
  connection.dispatchEvent(detailEvent("ready", {}));
  connection.dispatchEvent(detailEvent("snapshot", {
    state: projectNativeStudyRunState(nativeState()),
  }));
  assert.equal(controller.snapshot().phase, "ready");
  assert.ok(controller.snapshot().state);

  connection.phase = "disconnected";
  connection.dispatchEvent(detailEvent("peerclose", { reason: "test peer loss" }));

  assert.equal(controller.snapshot().phase, "disconnected");
  assert.equal(controller.snapshot().state, null);
  assert.equal(timers.active.size, 0);
  assert.throws(() => controller.sendStudyAction("start"), /Wait for an authenticated native run state/);
  await controller.stop("test_complete");
});

test("controller cross-lane state remains monotonic and rejects authority replacement", async () => {
  const startedGate = deferred();
  startedGate.resolve();
  const transport = new DeferredStartTransport(startedGate);
  let connection;
  const controller = new RemoteStudyQuickPairController({
    invitation: deterministicInvitation(),
    transportFactory: () => transport,
    connectionFactory: ({ transport: selectedTransport }) => {
      connection = new StubConnection({ transport: selectedTransport, phase: "connecting" });
      return connection;
    },
  });
  await controller.connect();
  connection.phase = "ready";
  connection.dispatchEvent(detailEvent("ready", {}));
  const revisionFive = projectNativeStudyRunState({
    ...nativeState(),
    revision: 5,
    phase: "running",
    lastEventSequence: 5,
    lastEventMonotonicMs: 500,
  });
  const revisionSix = projectNativeStudyRunState({
    ...nativeState(),
    revision: 6,
    phase: "paused",
    lastEventSequence: 6,
    lastEventMonotonicMs: 600,
  });
  connection.dispatchEvent(detailEvent("snapshot", { state: revisionFive }));
  connection.dispatchEvent(detailEvent("state", { state: revisionSix }));
  connection.dispatchEvent(detailEvent("snapshot", { state: revisionFive }));
  assert.equal(controller.snapshot().state.revision, 6);
  assert.equal(controller.snapshot().state.phase, "paused");

  const replacement = projectNativeStudyRunState({
    ...nativeState(),
    authorityGeneration: 8,
    revision: 0,
    runId: "run-replacement-8",
    phase: "prepared",
    lastEventSequence: 0,
    lastEventMonotonicMs: 0,
  });
  connection.dispatchEvent(detailEvent("state", { state: replacement }));
  assert.equal(controller.snapshot().state, null);
  await waitFor(() => controller.snapshot().phase === "idle", "authority replacement did not disconnect the controller");
  assert.ok(connection.closeCalls >= 1);
  assert.equal(transport.phase, "closed");
});

test("the public controller modules contain no desktop bridge command names", async () => {
  const publicFiles = [
    "site/src/remote-study/controller-app.js",
    "site/src/remote-study/quick-pair.js",
    "site/src/remote-study/invitation.js",
    "site/study-remote.html",
  ];
  const contents = await Promise.all(publicFiles.map((path) => readFile(path, "utf8")));
  for (const content of contents) {
    assert.doesNotMatch(content, /get_study_run_state|apply_study_action|@tauri-apps|src-tauri/u);
  }
  const bundled = await build({
    entryPoints: ["site/src/remote-study/controller-app.js"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const publicBundle = bundled.outputFiles.map(({ text }) => text).join("\n");
  assert.doesNotMatch(publicBundle, /get_study_run_state|apply_study_action|@tauri-apps|src-tauri/u);
});
