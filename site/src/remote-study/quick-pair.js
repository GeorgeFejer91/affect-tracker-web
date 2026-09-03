import {
  BRSPConnection,
  BRSP_STALE_MS,
} from "../../vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/brsp.js";
import { HardenedVdoNinjaTransport } from "./transport-guards.js";
import { REMOTE_STUDY_PHASES } from "./contracts.js";
import {
  assertBoundedJson,
  assertExactKeys,
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
export const REMOTE_STUDY_QUICK_PAIR_ACTIONS = Object.freeze([
  "arm",
  "start",
  "pause",
  "resume",
  "advance",
  "retry-block",
  "stop",
  "finalize",
  "abort",
  "calibrate-affect",
  "reset-affect",
]);

const runPhases = new Set(REMOTE_STUDY_PHASES);
const completionStatuses = new Set(["completed", "stoppedEarly", "aborted"]);

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function defaultTransportFactory(options) {
  return new HardenedVdoNinjaTransport(options);
}

function defaultConnectionFactory(options) {
  return new BRSPConnection(options);
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
    return Object.freeze({
      brspProofKey: await derive(REMOTE_STUDY_QR_KEY_LABELS.brspProof),
      privateVdoTransportKey: await derive(REMOTE_STUDY_QR_KEY_LABELS.privateVdoTransport),
    });
  } finally {
    salt.fill(0);
  }
}

export function validateRemoteStudyState(value) {
  assertPlainRecord(value, "remote study state");
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
  if (value.profile !== REMOTE_STUDY_STATE_PROFILE || value.version !== 1) {
    failContract("unsupported_remote_state", "The remote study state contract is unsupported.");
  }
  assertSafeInteger(value.authorityGeneration, "remote study state.authorityGeneration", { minimum: 1 });
  assertSafeInteger(value.revision, "remote study state.revision");
  assertToken(value.runId, "remote study state.runId", { minimum: 1, maximum: 96 });
  requireHash(value.protocolHash, "remote study state.protocolHash");
  if (!runPhases.has(value.phase)) failContract("invalid_phase", "The remote run phase is unsupported.");
  assertSafeInteger(value.lastEventSequence, "remote study state.lastEventSequence");
  assertSafeInteger(value.lastEventMonotonicMs, "remote study state.lastEventMonotonicMs");
  if (value.completionStatus !== null && !completionStatuses.has(value.completionStatus)) {
    failContract("invalid_completion_status", "The remote completion status is unsupported.");
  }
  const projected = {
    profile: REMOTE_STUDY_STATE_PROFILE,
    version: 1,
    authorityGeneration: value.authorityGeneration,
    revision: value.revision,
    runId: value.runId,
    protocolHash: value.protocolHash,
    phase: value.phase,
    currentSectionId: optionalToken(value.currentSectionId, "remote study state.currentSectionId"),
    currentTrialId: optionalToken(value.currentTrialId, "remote study state.currentTrialId"),
    currentBlockId: optionalToken(value.currentBlockId, "remote study state.currentBlockId"),
    mediaTimelineAnchor: projectOptionalJson(value.mediaTimelineAnchor, "remote study state.mediaTimelineAnchor"),
    stall: projectOptionalJson(value.stall, "remote study state.stall"),
    health: projectOptionalJson(value.health, "remote study state.health"),
    completionStatus: value.completionStatus,
    lastEventSequence: value.lastEventSequence,
    lastEventMonotonicMs: value.lastEventMonotonicMs,
  };
  assertBoundedJson(projected, {
    name: "remote study state",
    maximumDepth: 6,
    maximumNodes: 512,
    maximumAggregateStringLength: 8 * 1024,
  });
  return Object.freeze(projected);
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
      this.emitStatus(event.detail.ok
        ? "Desktop applied the command."
        : `Desktop rejected the command: ${event.detail.error}.`, !event.detail.ok);
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
    if (!REMOTE_STUDY_QUICK_PAIR_ACTIONS.includes(action)) {
      throw new Error("That study action is not remotely available.");
    }
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
