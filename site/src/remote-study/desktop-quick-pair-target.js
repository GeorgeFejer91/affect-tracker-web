// Desktop-only target module. Keep this out of the public controller import graph.
import {
  BRSPConnection,
  BRSP_STALE_MS,
  randomToken,
} from "../../vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/brsp.js";
import { ControllerLease } from "./controller-lease.js";
import { OneTimeInvitationStore } from "./invitation.js";
import {
  AdmissionControlledBRSPConnection,
  HardenedVdoNinjaTransport,
  InboundCommandAdmissionTransport,
} from "./transport-guards.js";
import { REMOTE_STUDY_PHASES, createStudyCommand } from "./contracts.js";
import {
  assertBoundedJson,
  assertExactKeys,
  assertFiniteRange,
  assertPlainRecord,
  assertSafeInteger,
  assertToken,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalStringify,
  cloneBoundedJson,
  failContract,
} from "./values.js";

export const REMOTE_STUDY_STATE_PROFILE = "affect-tracker-remote-study-state";
export const REMOTE_STUDY_COMPANION_URL = "https://GeorgeFejer91.github.io/affect-tracker-web/study-remote.html";
export const REMOTE_STUDY_HEARTBEAT_MS = 250;
export const REMOTE_STUDY_LEASE_RENEWAL_MS = 5_000;
export const REMOTE_STUDY_QR_KEY_LABELS = Object.freeze({
  brspProof: "affect-tracker/brsp-proof/qr-v1",
  privateVdoTransport: "affect-tracker/private-vdo-transport/qr-v1",
});
export const REMOTE_STUDY_GRANTED_SCOPES = Object.freeze(["study.observe", "study.control"]);
export const REMOTE_STUDY_CAPABILITIES = Object.freeze([
  "command-ack",
  "latest-state",
  "state-snapshot",
]);

const runPhases = new Set(REMOTE_STUDY_PHASES);
const nativeActionTypes = Object.freeze({
  arm: "arm",
  start: "start",
  pause: "pause",
  resume: "resume",
  advance: "advance",
  "retry-block": "retryBlock",
  stop: "stop",
  finalize: "finalize",
  abort: "abort",
  "calibrate-affect": "setAffectCalibration",
  "reset-affect": "resetAffect",
});

export const REMOTE_STUDY_QUICK_PAIR_ACTIONS = Object.freeze(Object.keys(nativeActionTypes));

const publicNativeErrors = new Set([
  "active_study_run",
  "invalid_generation",
  "invalid_transition",
  "no_active_study_run",
  "revision_conflict",
  "stale_generation",
  "study_action_invalid",
]);

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function defaultTransportFactory(options) {
  return new HardenedVdoNinjaTransport(options);
}

function defaultConnectionFactory(options) {
  return new AdmissionControlledBRSPConnection(options);
}

function displayErrorCode(error, fallback = "command_failed") {
  return typeof error?.code === "string" && publicNativeErrors.has(error.code)
    ? error.code
    : fallback;
}

function invitationRunBinding(state) {
  return Object.freeze({
    authorityGeneration: state.authorityGeneration,
    runId: state.runId,
    protocolHash: state.protocolHash,
  });
}

function matchesInvitationRun(binding, state) {
  return Boolean(binding && state)
    && binding.authorityGeneration === state.authorityGeneration
    && binding.runId === state.runId
    && binding.protocolHash === state.protocolHash;
}

function optionalToken(value, name) {
  if (value === undefined || value === null) return null;
  return assertToken(value, name, { minimum: 1, maximum: 96 });
}

function requireHash(value, name) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    failContract("invalid_hash", `${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function projectOptionalJson(value, name) {
  if (value === undefined || value === null) return null;
  assertBoundedJson(value, { name, maximumDepth: 5, maximumNodes: 256 });
  return cloneBoundedJson(value, { name, maximumDepth: 5, maximumNodes: 256 });
}

export function privateSessionIdFromInvitation(locator) {
  assertToken(locator, "invite", { minimum: 8, maximum: 96 });
  const value = locator.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 96);
  return assertToken(value, "private session locator", { minimum: 8, maximum: 96 });
}

export function validateQuickPairInvitation(value) {
  assertExactKeys(value, ["locator", "secret"], "invitation");
  assertToken(value.locator, "invitation.locator", { minimum: 8, maximum: 96 });
  const secretBytes = base64UrlToBytes(value.secret, "invitation.secret");
  if (secretBytes.byteLength !== 24) {
    failContract("weak_invitation_secret", "The QR invitation must contain exactly 192 secret bits.");
  }
  secretBytes.fill(0);
  return Object.freeze({ locator: value.locator, secret: value.secret });
}

export async function deriveQuickPairKeys(value, { crypto = globalThis.crypto } = {}) {
  const invitation = validateQuickPairInvitation(value);
  if (!crypto?.subtle) failContract("webcrypto_unavailable", "WebCrypto HKDF is unavailable.");
  const encoder = new TextEncoder();
  const secretBytes = base64UrlToBytes(invitation.secret, "invitation.secret");
  const salt = encoder.encode(`${REMOTE_STUDY_STATE_PROFILE}/v1/${invitation.locator}`);
  let keyMaterial;
  try {
    keyMaterial = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveBits"]);
  } finally {
    secretBytes.fill(0);
  }
  const derive = async (label) => {
    const info = encoder.encode(label);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    }, keyMaterial, 256));
    try {
      return bytesToBase64Url(bits);
    } finally {
      bits.fill(0);
      info.fill(0);
    }
  };
  try {
    const brspProofKey = await derive(REMOTE_STUDY_QR_KEY_LABELS.brspProof);
    const privateVdoTransportKey = await derive(REMOTE_STUDY_QR_KEY_LABELS.privateVdoTransport);
    return Object.freeze({ brspProofKey, privateVdoTransportKey });
  } finally {
    salt.fill(0);
  }
}

export function projectNativeStudyRunState(value) {
  assertPlainRecord(value, "native run state");
  if (value.schema !== "affect-tracker-run-state" || value.version !== 1) {
    failContract("unsupported_native_state", "The native run state contract is unsupported.");
  }
  assertSafeInteger(value.authorityGeneration, "native run state.authorityGeneration", { minimum: 1 });
  assertSafeInteger(value.revision, "native run state.revision");
  assertToken(value.runId, "native run state.runId", { minimum: 1, maximum: 96 });
  requireHash(value.protocolHash, "native run state.protocolHash");
  if (!runPhases.has(value.phase)) failContract("invalid_phase", "The native run phase is unsupported.");
  assertSafeInteger(value.lastEventSequence, "native run state.lastEventSequence");
  assertSafeInteger(value.lastEventMonotonicMs, "native run state.lastEventMonotonicMs");

  const projected = {
    profile: REMOTE_STUDY_STATE_PROFILE,
    version: 1,
    authorityGeneration: value.authorityGeneration,
    revision: value.revision,
    runId: value.runId,
    protocolHash: value.protocolHash,
    phase: value.phase,
    currentSectionId: optionalToken(value.currentSectionId, "native run state.currentSectionId"),
    currentTrialId: optionalToken(value.currentTrialId, "native run state.currentTrialId"),
    currentBlockId: optionalToken(value.currentBlockId, "native run state.currentBlockId"),
    mediaTimelineAnchor: projectOptionalJson(value.mediaTimelineAnchor, "native run state.mediaTimelineAnchor"),
    stall: projectOptionalJson(value.stall, "native run state.stall"),
    health: projectOptionalJson(value.health, "native run state.health"),
    completionStatus: value.completionStatus ?? null,
    lastEventSequence: value.lastEventSequence,
    lastEventMonotonicMs: value.lastEventMonotonicMs,
  };
  if (projected.completionStatus !== null
    && !new Set(["completed", "stoppedEarly", "aborted"]).has(projected.completionStatus)) {
    failContract("invalid_completion_status", "The native completion status is unsupported.");
  }
  assertBoundedJson(projected, {
    name: "remote study state",
    maximumDepth: 6,
    maximumNodes: 512,
    maximumAggregateStringLength: 8 * 1024,
  });
  return Object.freeze(projected);
}

export function validateRemoteStudyState(value) {
  assertExactKeys(value, [
    "profile",
    "version",
    "authorityGeneration",
    "revision",
    "runId",
    "protocolHash",
    "phase",
    "currentSectionId",
    "currentTrialId",
    "currentBlockId",
    "mediaTimelineAnchor",
    "stall",
    "health",
    "completionStatus",
    "lastEventSequence",
    "lastEventMonotonicMs",
  ], "remote study state");
  return projectNativeStudyRunState({
    schema: "affect-tracker-run-state",
    ...value,
  });
}

function validateCommandRequest(command, principalId) {
  if (!REMOTE_STUDY_QUICK_PAIR_ACTIONS.includes(command.action)) {
    failContract("unsupported_command", "That study action is not available in the QR quick-pair slice.");
  }
  assertExactKeys(command.args, ["authorityGeneration", "runId", "precondition", "payload"], "command args");
  return createStudyCommand({
    authorityGeneration: command.args.authorityGeneration,
    principalId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    runId: command.args.runId,
    precondition: command.args.precondition,
    scope: command.scope,
    action: command.action,
    payload: command.args.payload,
  });
}

export function toNativeStudyAction(command, state, { monotonicNow, wallNow }) {
  const type = nativeActionTypes[command.action];
  if (!type) failContract("unsupported_command", "That action has no native study mapping.");
  const payload = command.payload;
  let nativeCommand = { type };
  if (["pause", "retry-block", "stop", "abort"].includes(command.action)) {
    nativeCommand = { type, reasonCode: payload.reasonCode };
  } else if (command.action === "calibrate-affect") {
    assertFiniteRange(payload.x, "payload.x", -1, 1);
    assertFiniteRange(payload.y, "payload.y", -1, 1);
    nativeCommand = { type, point: { valence: payload.x, arousal: payload.y } };
  }
  const monotonicMs = Math.max(
    state.lastEventMonotonicMs,
    Math.floor(monotonicNow()),
  );
  return Object.freeze({
    schema: "affect-tracker-study-action",
    version: 1,
    actionId: command.commandId,
    runId: command.runId,
    authorityGeneration: command.authorityGeneration,
    expectedRevision: command.expectedRevision,
    precondition: {
      expectedPhase: command.precondition.phase,
      ...(command.precondition.blockId === null ? {} : { expectedBlockId: command.precondition.blockId }),
    },
    clock: {
      monotonicMs,
      wallTimeUtc: wallNow().toISOString(),
    },
    command: nativeCommand,
  });
}

function preconditionError(command, state) {
  if (command.authorityGeneration !== state.authorityGeneration) return "stale_generation";
  if (command.runId !== state.runId) return "run_mismatch";
  if (command.expectedRevision !== state.revision) return "revision_conflict";
  if (command.precondition.phase !== state.phase
    || command.precondition.blockId !== state.currentBlockId) return "precondition_failed";
  return null;
}

async function closeConnectionOrTransport(connection, transport, { suppressErrors = false } = {}) {
  try {
    if (connection) await connection.close();
    else await transport?.stop?.();
  } catch (error) {
    if (!suppressErrors) throw error;
  }
}

function remoteStateDisposition(current, next) {
  if (!current) return "accept";
  if (current.authorityGeneration !== next.authorityGeneration || current.runId !== next.runId) {
    return "reject-authority";
  }
  if (next.revision < current.revision) return "ignore-stale";
  if (next.revision === current.revision) {
    return canonicalStringify(current) === canonicalStringify(next)
      ? "ignore-duplicate"
      : "reject-conflict";
  }
  return "accept";
}

export class DesktopStudyQuickPairTarget extends EventTarget {
  constructor({
    invoke,
    companionUrl = REMOTE_STUDY_COMPANION_URL,
    transportFactory = defaultTransportFactory,
    connectionFactory = defaultConnectionFactory,
    invitationStore,
    now = () => Date.now(),
    monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
    wallNow = () => new Date(),
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
    setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  } = {}) {
    super();
    if (typeof invoke !== "function") throw new TypeError("A typed Tauri invoke adapter is required.");
    if (typeof transportFactory !== "function" || typeof connectionFactory !== "function") {
      throw new TypeError("Remote transport and connection factories must be functions.");
    }
    this.invoke = invoke;
    this.companionUrl = companionUrl;
    this.transportFactory = transportFactory;
    this.connectionFactory = connectionFactory;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.invitationStore = invitationStore ?? new OneTimeInvitationStore({
      wallNow: now,
      monotonicNow,
    });
    this.wallNow = wallNow;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.lease = new ControllerLease({ wallNow: now, monotonicNow });
    this.phase = "disabled";
    this.nativeState = undefined;
    this.remoteState = undefined;
    this.invitation = undefined;
    this.invitationBinding = undefined;
    this.invitationConsumed = false;
    this.transport = undefined;
    this.connection = undefined;
    this.heartbeatTimer = undefined;
    this.expiryTimer = undefined;
    this.refreshInFlight = undefined;
    this.route = "unknown";
    this.rttMs = undefined;
    this.lastApplied = undefined;
    this.lifecycleEpoch = 0;
  }

  isCurrentLifecycle(epoch) {
    return this.lifecycleEpoch === epoch;
  }

  leaseOwnershipError(principalId, state, requiredScope) {
    const nowMs = this.now();
    const lease = this.lease.snapshot(nowMs);
    if (!lease.active) {
      if (lease.lastRevocation?.reason === "lease_expired") return "lease_expired";
      if (lease.lastRevocation?.reason === "authority_generation_changed") return "stale_generation";
      return "lease_not_owned";
    }
    if (lease.principalId !== principalId) return "lease_not_owned";
    if (lease.authorityGeneration !== state?.authorityGeneration) {
      this.lease.revoke({
        authorityGeneration: lease.authorityGeneration,
        principalId: lease.principalId,
        grantId: lease.grantId,
        reason: "authority_generation_changed",
      }, nowMs);
      return "stale_generation";
    }
    if (!lease.scopes.includes(requiredScope)) return "scope_denied";
    return null;
  }

  commandSessionError(lifecycleEpoch, connection) {
    if (!this.isCurrentLifecycle(lifecycleEpoch) || this.connection !== connection) {
      return "controller_session_replaced";
    }
    if (this.phase !== "ready" || connection?.phase !== "ready") {
      return "controller_disconnected";
    }
    return null;
  }

  snapshot() {
    const connection = this.connection?.snapshot?.();
    return Object.freeze({
      phase: this.phase,
      authenticationMethod: "qr-invitation",
      scopes: [...REMOTE_STUDY_GRANTED_SCOPES],
      invitationUrl: this.invitation?.url,
      invitationExpiresAtMs: this.invitation?.expiresAtMs,
      invitationConsumed: this.invitationConsumed,
      route: this.route,
      rttMs: this.rttMs,
      brspPhase: connection?.phase ?? "idle",
      controllerId: connection?.remotePeerId ?? null,
      lease: this.lease.snapshot(),
      state: this.remoteState ?? null,
      lastApplied: this.lastApplied ?? null,
    });
  }

  emitStatus(message, error = false) {
    this.dispatchEvent(detailEvent("statuschange", { ...this.snapshot(), message, error }));
  }

  async enable() {
    if (this.phase !== "disabled" && this.phase !== "error") return this.snapshot();
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.phase = "enabling";
    this.emitStatus("Checking for an active native study run.");
    let transport;
    let connection;
    try {
      const nativeState = await this.invoke("get_study_run_state");
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return this.snapshot();
      const remoteState = projectNativeStudyRunState(nativeState);
      this.nativeState = nativeState;
      this.remoteState = remoteState;
      this.invitationBinding = invitationRunBinding(remoteState);
      this.invitation = this.invitationStore.issue(
        this.companionUrl,
        this.now(),
        this.monotonicNow(),
      );
      this.invitationConsumed = false;
      const sessionId = privateSessionIdFromInvitation(this.invitation.locator);
      const keys = await deriveQuickPairKeys({
        locator: this.invitation.locator,
        secret: this.invitation.secret,
      });
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return this.snapshot();
      const nativeTransport = this.transportFactory({
        role: "target",
        room: sessionId,
        sharedSecret: keys.privateVdoTransportKey,
        label: "Affect Tracker desktop study",
      });
      transport = new InboundCommandAdmissionTransport(nativeTransport);
      connection = this.connectionFactory({
        transport,
        role: "target",
        sessionId,
        sharedSecret: keys.brspProofKey,
        capabilities: REMOTE_STUDY_CAPABILITIES,
        grantedScopes: REMOTE_STUDY_GRANTED_SCOPES,
        getState: () => (this.invitationConsumed ? this.remoteState : undefined),
        applyCommand: (command) => this.applyRemoteCommand(command, {
          lifecycleEpoch,
          connection,
        }),
        now: this.monotonicNow,
      });
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
        return this.snapshot();
      }
      this.transport = transport;
      this.connection = connection;
      this.bindConnection(lifecycleEpoch);
      this.bindTransport(lifecycleEpoch);
      this.heartbeatTimer = this.setIntervalFn?.(() => {
        if (this.isCurrentLifecycle(lifecycleEpoch)) void this.tick();
      }, REMOTE_STUDY_HEARTBEAT_MS);
      const expiryDelay = Math.max(0, this.invitation.expiresAtMs - this.now());
      this.expiryTimer = this.setTimeoutFn?.(() => {
        if (this.isCurrentLifecycle(lifecycleEpoch) && !this.invitationConsumed) {
          void this.tick();
        }
      }, expiryDelay);
      this.phase = "connecting";
      this.emitStatus("Remote Control enabled; opening the private data-only route.");
      await transport.start();
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
      }
      return this.snapshot();
    } catch (error) {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
        return this.snapshot();
      }
      await this.stop("enable_failed");
      this.phase = "error";
      this.emitStatus(error?.message ?? "Remote Control could not start.", true);
      throw error;
    }
  }

  async acceptReadyController(event, lifecycleEpoch, connection) {
    try {
      await this.refreshNativeState({ publish: false });
      if (!this.isCurrentLifecycle(lifecycleEpoch) || this.connection !== connection) return;
      if (!matchesInvitationRun(this.invitationBinding, this.remoteState)) {
        this.emitStatus("The native run changed after this QR invitation was issued.", true);
        await this.stop("invitation_run_changed");
        return;
      }
      const consumed = this.invitationStore.consume(
        this.invitation,
        this.now(),
        this.monotonicNow(),
      );
      if (!consumed.ok) {
        this.emitStatus("The QR invitation expired or was already used.", true);
        await this.stop("invitation_invalid");
        return;
      }
      this.invitationConsumed = true;
      this.invitation = Object.freeze({
        locator: this.invitation.locator,
        expiresAtMs: this.invitation.expiresAtMs,
      });
      if (this.expiryTimer !== undefined) this.clearTimeoutFn?.(this.expiryTimer);
      this.expiryTimer = undefined;
      const principalId = event.detail.remotePeerId;
      const grantNowMs = this.now();
      this.lease.claim({
        grantId: `grant_${randomToken(12)}`,
        authorityGeneration: this.remoteState.authorityGeneration,
        principalId,
        principalLabel: "Remote browser",
        authenticationMethod: "qr-invitation",
        scopes: REMOTE_STUDY_GRANTED_SCOPES,
        issuedAtMs: grantNowMs,
        expiresAtMs: grantNowMs + (8 * 60 * 60 * 1000),
        revoked: false,
      }, grantNowMs, this.monotonicNow());
      this.phase = "ready";
      connection.publishSnapshot?.(this.remoteState, { revision: this.remoteState.revision });
      connection.publishState?.(this.remoteState, { revision: this.remoteState.revision });
      this.emitStatus("QR proof accepted. One remote browser now has observe/control scope.");
    } catch (error) {
      if (!this.isCurrentLifecycle(lifecycleEpoch) || this.connection !== connection) return;
      this.emitStatus(error?.message ?? "The controller grant could not be established.", true);
      await this.stop("controller_grant_failed");
    }
  }

  bindConnection(lifecycleEpoch = this.lifecycleEpoch) {
    const connection = this.connection;
    connection.addEventListener("ready", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      void this.acceptReadyController(event, lifecycleEpoch, connection);
    });
    this.connection.addEventListener("phasechange", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      if (event.detail.phase === "error" || event.detail.phase === "disconnected") {
        this.phase = "disconnected";
        this.emitStatus(event.detail.message, event.detail.phase === "error");
      }
    });
    this.connection.addEventListener("command", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.lastApplied = {
        action: event.detail.command.action,
        ok: event.detail.outcome.ok,
        revision: event.detail.outcome.revision,
        error: event.detail.outcome.error,
      };
      this.emitStatus(event.detail.outcome.ok ? "Remote study command applied." : "Remote study command rejected.", !event.detail.outcome.ok);
    });
    this.connection.addEventListener("protocolerror", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.emitStatus(event.detail.message, true);
    });
  }

  bindTransport(lifecycleEpoch = this.lifecycleEpoch) {
    this.transport.addEventListener("securityviolation", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.emitStatus(event.detail.reason, true);
      void this.stop(event.detail.code ?? "transport_security_violation");
    });
    this.transport.addEventListener("status", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.emitStatus(event.detail.message, event.detail.error === true);
    });
    this.transport.addEventListener("quality", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.route = event.detail.route ?? "unknown";
      this.rttMs = event.detail.rttMs;
      this.emitStatus("Transport route diagnostics updated.");
    });
  }

  async refreshNativeState({ publish = true } = {}) {
    if (this.refreshInFlight) {
      if (publish) this.refreshInFlight.publishRequested = true;
      return this.refreshInFlight.promise;
    }
    if (!this.connection) return this.remoteState;
    const lifecycleEpoch = this.lifecycleEpoch;
    const connection = this.connection;
    const refresh = {
      lifecycleEpoch,
      connection,
      publishRequested: publish,
      promise: undefined,
    };
    refresh.promise = (async () => {
      const nativeState = await this.invoke("get_study_run_state");
      if (!this.isCurrentLifecycle(lifecycleEpoch) || this.connection !== connection) {
        return this.remoteState;
      }
      const remoteState = projectNativeStudyRunState(nativeState);
      const nowMs = this.now();
      const lease = this.lease.snapshot(nowMs);
      const currentState = this.remoteState;
      if (this.invitationBinding && !matchesInvitationRun(this.invitationBinding, remoteState)) {
        await this.stop("invitation_run_changed");
        return this.remoteState;
      }
      if (lease.active && (lease.authorityGeneration !== remoteState.authorityGeneration
        || (currentState && currentState.runId !== remoteState.runId))) {
        this.lease.revoke({
          authorityGeneration: lease.authorityGeneration,
          principalId: lease.principalId,
          grantId: lease.grantId,
          reason: "authority_generation_changed",
        }, nowMs);
        await this.stop("authority_generation_changed");
        return this.remoteState;
      }
      if (this.invitationConsumed && !lease.active) {
        await this.stop(lease.lastRevocation?.reason ?? "lease_not_owned");
        return this.remoteState;
      }
      if (currentState
        && currentState.authorityGeneration === remoteState.authorityGeneration
        && currentState.runId === remoteState.runId
        && remoteState.revision < currentState.revision) {
        return currentState;
      }
      this.nativeState = nativeState;
      this.remoteState = remoteState;
      if (refresh.publishRequested && connection.phase === "ready") {
        connection.publishState(this.remoteState, { revision: this.remoteState.revision });
      }
      return this.remoteState;
    })().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh.promise;
  }

  async tick() {
    if (this.phase === "disabled" || this.phase === "stopping") return;
    if (this.invitation && !this.invitationConsumed
      && !this.invitationStore.status(this.now(), this.monotonicNow())
        .some(({ locator }) => locator === this.invitation.locator)) {
      await this.stop("invitation_expired");
      return;
    }
    if (this.invitationConsumed && !this.lease.snapshot().active) {
      await this.stop("lease_expired");
      return;
    }
    if (this.connection?.phase === "ready") await this.refreshNativeState();
  }

  async applyRemoteCommand(command, session = {}) {
    let state = this.remoteState;
    const lifecycleEpoch = session.lifecycleEpoch ?? this.lifecycleEpoch;
    const connection = session.connection ?? this.connection;
    try {
      const sessionError = this.commandSessionError(lifecycleEpoch, connection);
      if (sessionError) return { ok: false, revision: state?.revision ?? 0, error: sessionError };
      const principalId = connection?.snapshot().remotePeerId;
      if (!principalId) return { ok: false, revision: state?.revision ?? 0, error: "controller_not_authenticated" };
      if (command.scope !== "study.control"
        && !(command.scope === "study.observe" && command.action === "renew-lease")) {
        return { ok: false, revision: state?.revision ?? 0, error: "scope_denied" };
      }
      const requiredScope = command.scope;
      const localLeaseError = this.leaseOwnershipError(principalId, state, requiredScope);
      if (localLeaseError) {
        return { ok: false, revision: state?.revision ?? 0, error: localLeaseError };
      }
      state = await this.refreshNativeState({ publish: false });
      const freshLeaseError = this.leaseOwnershipError(principalId, state, requiredScope);
      if (freshLeaseError) {
        return { ok: false, revision: state?.revision ?? 0, error: freshLeaseError };
      }
      const refreshedSessionError = this.commandSessionError(lifecycleEpoch, connection);
      if (refreshedSessionError) {
        return { ok: false, revision: state?.revision ?? 0, error: refreshedSessionError };
      }
      if (command.scope === "study.observe" && command.action === "renew-lease") {
        assertExactKeys(command.args, ["authorityGeneration", "runId"], "lease renewal");
        if (command.expectedRevision !== state.revision) {
          return { ok: false, revision: state.revision, error: "revision_conflict" };
        }
        if (command.args.authorityGeneration !== state.authorityGeneration || command.args.runId !== state.runId) {
          return { ok: false, revision: state.revision, error: "stale_generation" };
        }
        const lease = this.lease.snapshot();
        const renewed = this.lease.renew({
          authorityGeneration: lease.authorityGeneration,
          principalId,
          grantId: lease.grantId,
          frameKind: "lease-renewal",
        }, this.now());
        return renewed.renewed
          ? { ok: true, revision: state.revision, result: { renewed: true } }
          : { ok: false, revision: state.revision, error: renewed.error };
      }
      const typed = validateCommandRequest(command, principalId);
      const rejected = preconditionError(typed, state);
      if (rejected) return { ok: false, revision: state.revision, error: rejected };
      const nativeAction = toNativeStudyAction(typed, state, {
        monotonicNow: this.monotonicNow,
        wallNow: this.wallNow,
      });
      const outcome = await this.invoke("apply_study_action", { action: nativeAction });
      const appliedRemoteState = projectNativeStudyRunState(outcome.state);
      const appliedDisposition = remoteStateDisposition(this.remoteState, appliedRemoteState);
      if (this.isCurrentLifecycle(lifecycleEpoch) && this.connection === connection) {
        if (appliedDisposition === "accept") {
          this.nativeState = outcome.state;
          this.remoteState = appliedRemoteState;
        }
      }
      const renewalNowMs = this.now();
      const lease = this.lease.snapshot(renewalNowMs);
      if (!this.commandSessionError(lifecycleEpoch, connection)
        && lease.active
        && lease.authorityGeneration === appliedRemoteState.authorityGeneration
        && this.remoteState?.authorityGeneration === appliedRemoteState.authorityGeneration
        && this.remoteState?.runId === appliedRemoteState.runId
        && lease.principalId === principalId) {
        this.lease.renew({
          authorityGeneration: lease.authorityGeneration,
          principalId,
          grantId: lease.grantId,
          frameKind: "application-control",
        }, renewalNowMs);
      }
      return {
        ok: true,
        revision: appliedRemoteState.revision,
        result: { state: appliedRemoteState },
      };
    } catch (error) {
      return {
        ok: false,
        revision: state?.revision ?? 0,
        result: null,
        error: displayErrorCode(error),
      };
    }
  }

  async stop(reason = "local_stop") {
    if (this.phase === "disabled" || this.phase === "stopping") return this.snapshot();
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.phase = "stopping";
    if (this.heartbeatTimer !== undefined) this.clearIntervalFn?.(this.heartbeatTimer);
    if (this.expiryTimer !== undefined) this.clearTimeoutFn?.(this.expiryTimer);
    this.heartbeatTimer = undefined;
    this.expiryTimer = undefined;
    const connection = this.connection;
    const transport = this.transport;
    this.connection = undefined;
    this.transport = undefined;
    this.refreshInFlight = undefined;
    this.invitationStore.revokeAll();
    this.lease.revoke({ reason }, this.now());
    this.invitation = undefined;
    this.invitationBinding = undefined;
    this.invitationConsumed = false;
    try {
      await closeConnectionOrTransport(connection, transport);
    } finally {
      if (this.isCurrentLifecycle(lifecycleEpoch)) {
        this.phase = "disabled";
        this.route = "unknown";
        this.rttMs = undefined;
        this.emitStatus("Remote Control stopped. The invitation and controller grant were revoked.");
      }
    }
    return this.snapshot();
  }
}

export class RemoteStudyQuickPairController extends EventTarget {
  constructor({
    invitation,
    transportFactory = defaultTransportFactory,
    connectionFactory = defaultConnectionFactory,
    monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
  } = {}) {
    super();
    this.invitation = validateQuickPairInvitation(invitation);
    this.transportFactory = transportFactory;
    this.connectionFactory = connectionFactory;
    this.monotonicNow = monotonicNow;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.phase = "idle";
    this.transport = undefined;
    this.connection = undefined;
    this.state = undefined;
    this.lastApplied = undefined;
    this.route = "unknown";
    this.rttMs = undefined;
    this.renewalTimer = undefined;
    this.freshnessTimer = undefined;
    this.lifecycleEpoch = 0;
  }

  isCurrentLifecycle(epoch) {
    return this.lifecycleEpoch === epoch;
  }

  snapshot() {
    const connection = this.connection?.snapshot?.();
    return Object.freeze({
      phase: this.phase,
      brspPhase: connection?.phase ?? "idle",
      acceptedScopes: connection?.acceptedScopes ?? [],
      route: this.route,
      rttMs: this.rttMs,
      stale: this.connection?.isStateStale(this.monotonicNow(), BRSP_STALE_MS) ?? false,
      stateAgeMs: connection?.stateAgeMs,
      state: this.state ?? null,
      lastApplied: this.lastApplied ?? null,
      pendingCommands: connection?.pendingCommands ?? 0,
    });
  }

  emitStatus(message, error = false) {
    this.dispatchEvent(detailEvent("statuschange", { ...this.snapshot(), message, error }));
  }

  async connect() {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.phase = "connecting";
    const invitation = this.invitation;
    let transport;
    let connection;
    try {
      const sessionId = privateSessionIdFromInvitation(invitation.locator);
      const keys = await deriveQuickPairKeys(invitation);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return this.snapshot();
      transport = this.transportFactory({
        role: "controller",
        room: sessionId,
        sharedSecret: keys.privateVdoTransportKey,
        label: "Affect Tracker study controller",
      });
      connection = this.connectionFactory({
        transport,
        role: "controller",
        sessionId,
        sharedSecret: keys.brspProofKey,
        capabilities: REMOTE_STUDY_CAPABILITIES,
        requestedScopes: REMOTE_STUDY_GRANTED_SCOPES,
        now: this.monotonicNow,
      });
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
        return this.snapshot();
      }
      this.transport = transport;
      this.connection = connection;
      this.invitation = undefined;
      this.bindConnection(lifecycleEpoch);
      this.bindTransport(lifecycleEpoch);
      this.emitStatus("Connecting to the desktop's private data-only route.");
      await transport.start();
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
      }
      return this.snapshot();
    } catch (error) {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) {
        await closeConnectionOrTransport(connection, transport, { suppressErrors: true });
        return this.snapshot();
      }
      await this.stop("connect_failed");
      this.phase = "error";
      this.emitStatus(error?.message ?? "The controller could not connect.", true);
      throw error;
    }
  }

  bindConnection(lifecycleEpoch = this.lifecycleEpoch) {
    const acceptState = (detail) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      const state = validateRemoteStudyState(detail.state);
      const disposition = remoteStateDisposition(this.state, state);
      if (disposition.startsWith("ignore-")) return;
      if (disposition.startsWith("reject-")) {
        this.state = undefined;
        this.emitStatus("The desktop sent a conflicting run identity or state revision.", true);
        void this.stop("state_continuity_violation").catch(() => {});
        return;
      }
      this.state = state;
      this.phase = "ready";
      this.dispatchEvent(detailEvent("statechange", this.snapshot()));
    };
    this.connection.addEventListener("ready", () => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.phase = "ready";
      this.renewalTimer = this.setIntervalFn?.(() => {
        if (this.isCurrentLifecycle(lifecycleEpoch)) this.renewLease();
      }, REMOTE_STUDY_LEASE_RENEWAL_MS);
      this.freshnessTimer = this.setIntervalFn?.(() => {
        if (this.isCurrentLifecycle(lifecycleEpoch)) {
          this.dispatchEvent(detailEvent("freshnesschange", this.snapshot()));
        }
      }, REMOTE_STUDY_HEARTBEAT_MS);
      this.emitStatus("QR proof accepted. Waiting for the native run snapshot.");
    });
    this.connection.addEventListener("snapshot", (event) => acceptState(event.detail));
    this.connection.addEventListener("state", (event) => acceptState(event.detail));
    this.connection.addEventListener("commandapplied", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.lastApplied = {
        commandId: event.detail.commandId,
        ok: event.detail.ok,
        revision: event.detail.revision,
        error: event.detail.error,
        action: event.detail.pending?.action ?? null,
      };
      this.emitStatus(event.detail.ok ? "Desktop applied the command." : `Desktop rejected the command: ${event.detail.error}.`, !event.detail.ok);
      this.dispatchEvent(detailEvent("commandapplied", this.snapshot()));
    });
    this.connection.addEventListener("peerclose", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.phase = "disconnected";
      this.state = undefined;
      if (this.renewalTimer !== undefined) this.clearIntervalFn?.(this.renewalTimer);
      if (this.freshnessTimer !== undefined) this.clearIntervalFn?.(this.freshnessTimer);
      this.renewalTimer = undefined;
      this.freshnessTimer = undefined;
      this.emitStatus(event.detail.reason ?? "The desktop connection closed.", true);
    });
    this.connection.addEventListener("protocolerror", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.phase = "error";
      this.emitStatus(event.detail.message, true);
    });
  }

  bindTransport(lifecycleEpoch = this.lifecycleEpoch) {
    this.transport.addEventListener("securityviolation", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.emitStatus(event.detail.reason, true);
      void this.stop(event.detail.code ?? "transport_security_violation");
    });
    this.transport.addEventListener("status", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.emitStatus(event.detail.message, event.detail.error === true);
    });
    this.transport.addEventListener("quality", (event) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return;
      this.route = event.detail.route ?? "unknown";
      this.rttMs = event.detail.rttMs;
      this.emitStatus("Transport route diagnostics updated.");
    });
  }

  renewLease() {
    if (!this.connection || this.connection.phase !== "ready" || !this.state) return false;
    if (this.connection.snapshot().pendingCommands > 0) return false;
    try {
      this.connection.sendCommand("study.observe", "renew-lease", {
        authorityGeneration: this.state.authorityGeneration,
        runId: this.state.runId,
      }, { expectedRevision: this.state.revision });
      return true;
    } catch {
      return false;
    }
  }

  sendStudyAction(action, payload = {}, options = {}) {
    if (!this.connection || this.connection.phase !== "ready" || !this.state) {
      throw new Error("Wait for an authenticated native run state before sending a command.");
    }
    if (this.snapshot().stale) throw new Error("The native run state is stale; wait for a fresh snapshot.");
    if (!REMOTE_STUDY_QUICK_PAIR_ACTIONS.includes(action)) throw new Error("That study action is not remotely available.");
    const precondition = options.precondition ?? {
      phase: this.state.phase,
      blockId: this.state.currentBlockId,
    };
    return this.connection.sendCommand("study.control", action, {
      authorityGeneration: options.authorityGeneration ?? this.state.authorityGeneration,
      runId: options.runId ?? this.state.runId,
      precondition,
      payload,
    }, { expectedRevision: options.expectedRevision ?? this.state.revision });
  }

  async stop(reason = "controller_stop") {
    if (this.phase === "idle" || this.phase === "stopping") return this.snapshot();
    const lifecycleEpoch = ++this.lifecycleEpoch;
    this.phase = "stopping";
    if (this.renewalTimer !== undefined) this.clearIntervalFn?.(this.renewalTimer);
    if (this.freshnessTimer !== undefined) this.clearIntervalFn?.(this.freshnessTimer);
    this.renewalTimer = undefined;
    this.freshnessTimer = undefined;
    const connection = this.connection;
    const transport = this.transport;
    this.connection = undefined;
    this.transport = undefined;
    this.invitation = undefined;
    try {
      await closeConnectionOrTransport(connection, transport);
    } finally {
      if (this.isCurrentLifecycle(lifecycleEpoch)) {
        this.phase = "idle";
        this.state = undefined;
        this.route = "unknown";
        this.rttMs = undefined;
        this.emitStatus(`Controller stopped (${reason}).`);
      }
    }
    return this.snapshot();
  }
}
