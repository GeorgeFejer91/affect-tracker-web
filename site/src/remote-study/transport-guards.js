import {
  BRSPConnection,
  BRSP_CONTROL_MAX_BYTES,
  canonicalStringify,
} from "../../vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/brsp.js";
import {
  VdoNinjaTransport,
} from "../../vendor/brsp/1/e6a5eef86d4b3c7422ace08706df5deb82338808/vdo-ninja-transport.js";

export const REMOTE_STUDY_INBOUND_COMMAND_MAX_COUNT = 8;
export const REMOTE_STUDY_INBOUND_COMMAND_MAX_BYTES = 64 * 1024;
export const REMOTE_STUDY_INBOUND_CONTROL_MAX_COUNT = 16;
export const REMOTE_STUDY_INBOUND_CONTROL_MAX_BYTES = 128 * 1024;
export const REMOTE_STUDY_DISCOVERY_MAX_LISTING_ITEMS = 64;
export const REMOTE_STUDY_DISCOVERY_MAX_SOURCES = 16;
export const REMOTE_STUDY_PREAUTH_MAX_PEERS = 4;
export const REMOTE_STUDY_SOURCE_ID_MAX_BYTES = 96;
export const REMOTE_STUDY_PEER_KEY_MAX_BYTES = 96;
export const REMOTE_STUDY_SOURCE_LABEL_MAX_BYTES = 128;
export const REMOTE_STUDY_QUALITY_TIMEOUT_MS = 1_500;

const encoder = new TextEncoder();
const peerTokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const sourceTokenPattern = /^[A-Za-z0-9_]+$/u;

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function protocolBytes(value) {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Infinity;
}

function validUtf8String(value, maximumBytes, pattern) {
  return typeof value === "string"
    && value.length > 0
    && encoder.encode(value).byteLength <= maximumBytes
    && (!pattern || pattern.test(value));
}

function sourceCandidate(value) {
  if (typeof value === "string") return { streamId: value, peerKey: "", label: "" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return {
    streamId: value.streamID ?? value.streamId ?? "",
    peerKey: value.UUID ?? value.uuid ?? "",
    label: value.label ?? value.streamLabel ?? value.name ?? "",
  };
}

function validSource(item) {
  return validUtf8String(item?.streamId, REMOTE_STUDY_SOURCE_ID_MAX_BYTES, sourceTokenPattern)
    && (item.peerKey === ""
      || validUtf8String(item.peerKey, REMOTE_STUDY_PEER_KEY_MAX_BYTES, peerTokenPattern))
    && typeof item.label === "string"
    && encoder.encode(item.label).byteLength <= REMOTE_STUDY_SOURCE_LABEL_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(item.label);
}

function validPeerKey(value) {
  return validUtf8String(value, REMOTE_STUDY_PEER_KEY_MAX_BYTES, peerTokenPattern);
}

/**
 * Local hardening layer around the pinned upstream VDO.Ninja adapter. It keeps
 * pre-authentication SDK metadata bounded without modifying the pinned BRSP
 * receipt.
 */
export class HardenedVdoNinjaTransport extends VdoNinjaTransport {
  constructor(options = {}) {
    const {
      qualityTimeoutMs = REMOTE_STUDY_QUALITY_TIMEOUT_MS,
      ...transportOptions
    } = options;
    super(transportOptions);
    if (!Number.isSafeInteger(qualityTimeoutMs) || qualityTimeoutMs < 1 || qualityTimeoutMs > 5_000) {
      throw new TypeError("qualityTimeoutMs must be a 1-5000 millisecond safe integer.");
    }
    this.qualityTimeoutMs = qualityTimeoutMs;
    this.qualityRefreshInFlight = false;
    this.qualityPollingDisabled = false;
  }

  rejectPreAuthMetadata(reason, { peerKey, channel } = {}) {
    try { channel?.close?.(); } catch { /* Rejecting an untrusted channel is best effort. */ }
    if (peerKey) this.closePeer(peerKey);
    this.dispatchEvent(detailEvent("securityviolation", {
      code: "preauth_metadata_rejected",
      reason,
    }));
    void this.stop();
  }

  addListing(detail) {
    if (Array.isArray(detail?.list)) {
      if (detail.list.length > REMOTE_STUDY_DISCOVERY_MAX_LISTING_ITEMS) {
        this.rejectPreAuthMetadata("The discovery listing exceeded its fixed item limit.");
        return;
      }
      for (const item of detail.list) this.addSource(item, { deferSelection: true });
    } else {
      this.addSource(detail);
    }
    if (this.discoveryReady) void this.selectOnlyTarget().catch(() => {});
  }

  addSource(value, { deferSelection = false } = {}) {
    if (this.role !== "controller") return;
    const item = sourceCandidate(value);
    if (!validSource(item)) {
      this.rejectPreAuthMetadata("The discovery source contained invalid or oversized metadata.");
      return;
    }
    if (!item.streamId.startsWith("brsp_target_")) return;
    if (!this.sources.has(item.streamId)
      && this.sources.size >= REMOTE_STUDY_DISCOVERY_MAX_SOURCES) {
      this.rejectPreAuthMetadata("The discovery source map exceeded its fixed capacity.");
      return;
    }
    super.addSource(item, { deferSelection });
  }

  canAcceptPeer(peerKey) {
    if (!validPeerKey(peerKey)) return false;
    return this.peers.has(peerKey) || this.peers.size < REMOTE_STUDY_PREAUTH_MAX_PEERS;
  }

  peerRecord(peerKey) {
    if (!this.canAcceptPeer(peerKey)) {
      this.rejectPreAuthMetadata("The pre-authentication peer map rejected an invalid or excess peer.", { peerKey });
      return undefined;
    }
    return super.peerRecord(peerKey);
  }

  async openTargetChannels(peerKey) {
    if (!this.canAcceptPeer(peerKey)) {
      this.rejectPreAuthMetadata("The pre-authentication peer map exceeded its fixed capacity.", { peerKey });
      return this.snapshot();
    }
    return super.openTargetChannels(peerKey);
  }

  acceptControllerChannel(detail = {}) {
    const streamIdValid = detail.streamID === undefined
      || validUtf8String(detail.streamID, REMOTE_STUDY_SOURCE_ID_MAX_BYTES, sourceTokenPattern);
    const labelValid = typeof detail.label === "string"
      && encoder.encode(detail.label).byteLength <= REMOTE_STUDY_SOURCE_LABEL_MAX_BYTES;
    if (!streamIdValid || !labelValid || !this.canAcceptPeer(detail.uuid)) {
      this.rejectPreAuthMetadata("An incoming data channel carried invalid or excess peer metadata.", {
        peerKey: validPeerKey(detail.uuid) ? detail.uuid : undefined,
        channel: detail.channel,
      });
      return;
    }
    super.acceptControllerChannel(detail);
  }

  async refreshQuality() {
    if (this.qualityRefreshInFlight || this.qualityPollingDisabled
      || !this.sdk?.getPeerQuality || this.tearingDown) return false;
    const sdk = this.sdk;
    const generation = this.lifecycleGeneration;
    this.qualityRefreshInFlight = true;
    try {
      for (const peerKey of this.peers.keys()) {
        let timeoutId;
        const timeout = new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve({ timedOut: true }), this.qualityTimeoutMs);
        });
        const read = Promise.resolve()
          .then(() => sdk.getPeerQuality(peerKey))
          .then((quality) => ({ quality }), () => ({ failed: true }));
        const outcome = await Promise.race([read, timeout]);
        clearTimeout(timeoutId);
        if (!this.isCurrentSdk(sdk, generation) || !this.peers.has(peerKey)) return false;
        if (outcome.timedOut) {
          this.qualityPollingDisabled = true;
          if (this.qualityTimer !== undefined) clearInterval(this.qualityTimer);
          this.qualityTimer = undefined;
          this.emitStatus("Route diagnostics paused after the SDK quality read timed out.");
          return false;
        }
        if (outcome.failed) continue;
        const quality = outcome.quality;
        this.dispatchEvent(detailEvent("quality", {
          peerKey,
          route: quality?.relayed === true ? "relay" : quality?.relayed === false ? "direct" : "unknown",
          rttMs: Number.isFinite(quality?.rttMs) ? Math.round(quality.rttMs) : undefined,
        }));
      }
      return true;
    } finally {
      this.qualityRefreshInFlight = false;
    }
  }
}

/**
 * Target-only transport facade that reserves bounded command work before a raw
 * event reaches BRSP's receive/apply promise chains.
 */
export class InboundCommandAdmissionTransport extends EventTarget {
  constructor(transport) {
    super();
    if (!transport?.addEventListener) {
      throw new TypeError("A BRSP transport is required for inbound admission control.");
    }
    this.transport = transport;
    this.pendingControls = new Map();
    this.pendingControlBytes = 0;
    this.nextControlToken = 1;
    this.pendingCommands = new Map();
    this.pendingCommandBytes = 0;
    this.nextCommandToken = 1;
    this.rejected = false;
    this.listeners = [];
    for (const type of ["peeropen", "statemessage", "status", "quality", "securityviolation"]) {
      this.forward(type, (event) => this.dispatchEvent(detailEvent(type, event.detail)));
    }
    this.forward("peerclose", (event) => {
      this.clearAdmissions();
      this.dispatchEvent(detailEvent("peerclose", event.detail));
    });
    this.forward("controlmessage", (event) => this.admitControl(event.detail));
  }

  get phase() {
    return this.transport.phase;
  }

  forward(type, handler) {
    this.transport.addEventListener(type, handler);
    this.listeners.push([type, handler]);
  }

  admissionSnapshot() {
    return Object.freeze({
      controlCount: this.pendingControls.size,
      controlBytes: this.pendingControlBytes,
      commandCount: this.pendingCommands.size,
      commandBytes: this.pendingCommandBytes,
      rejected: this.rejected,
    });
  }

  admitControl(detail = {}) {
    if (this.rejected) return false;
    const bytes = protocolBytes(detail.data);
    if (bytes > BRSP_CONTROL_MAX_BYTES) {
      this.rejectControl(
        detail.peerKey,
        "An oversized control frame was rejected before BRSP decoding.",
        "inbound_control_overflow",
      );
      return false;
    }
    if (this.pendingControls.size >= REMOTE_STUDY_INBOUND_CONTROL_MAX_COUNT
      || this.pendingControlBytes + bytes > REMOTE_STUDY_INBOUND_CONTROL_MAX_BYTES) {
      this.rejectControl(
        detail.peerKey,
        "The inbound control-frame admission budget was exceeded.",
        "inbound_control_overflow",
      );
      return false;
    }
    const admissionToken = `control_${this.nextControlToken++}`;
    this.pendingControls.set(admissionToken, bytes);
    this.pendingControlBytes += bytes;
    this.dispatchEvent(detailEvent("controlmessage", { ...detail, admissionToken }));
    return true;
  }

  releaseControl(admissionToken) {
    const bytes = this.pendingControls.get(admissionToken);
    if (bytes === undefined) return false;
    this.pendingControls.delete(admissionToken);
    this.pendingControlBytes -= bytes;
    return true;
  }

  reserveCommand(command) {
    let bytes;
    try {
      bytes = encoder.encode(canonicalStringify(command)).byteLength;
    } catch {
      bytes = BRSP_CONTROL_MAX_BYTES;
    }
    if (this.pendingCommands.size >= REMOTE_STUDY_INBOUND_COMMAND_MAX_COUNT
      || this.pendingCommandBytes + bytes > REMOTE_STUDY_INBOUND_COMMAND_MAX_BYTES) {
      this.rejectControl(
        undefined,
        "The authenticated command admission budget was exceeded.",
        "inbound_command_overflow",
      );
      return undefined;
    }
    const token = `command_${this.nextCommandToken++}`;
    this.pendingCommands.set(token, bytes);
    this.pendingCommandBytes += bytes;
    return token;
  }

  releaseCommand(token) {
    const bytes = this.pendingCommands.get(token);
    if (bytes === undefined) return false;
    this.pendingCommands.delete(token);
    this.pendingCommandBytes -= bytes;
    return true;
  }

  clearAdmissions() {
    this.pendingControls.clear();
    this.pendingControlBytes = 0;
    this.pendingCommands.clear();
    this.pendingCommandBytes = 0;
  }

  rejectControl(peerKey, reason, code) {
    this.rejected = true;
    this.clearAdmissions();
    this.dispatchEvent(detailEvent("securityviolation", {
      code,
      reason,
    }));
    this.transport.closePeer?.(peerKey);
  }

  snapshot() {
    return this.transport.snapshot?.();
  }

  start() {
    return this.transport.start();
  }

  sendControl(peerKey, data) {
    return this.transport.sendControl?.(peerKey, data) ?? false;
  }

  sendState(peerKey, data) {
    return this.transport.sendState?.(peerKey, data) ?? false;
  }

  closePeer(peerKey) {
    this.clearAdmissions();
    return this.transport.closePeer?.(peerKey);
  }

  async stop() {
    this.rejected = true;
    this.clearAdmissions();
    return this.transport.stop();
  }
}

/**
 * BRSP connection paired with the target admission facade. Raw-frame tokens
 * are released after receiveControl, while uncached commands remain reserved
 * until their serialized apply/cached-ack path finishes.
 */
export class AdmissionControlledBRSPConnection extends BRSPConnection {
  constructor(options) {
    super(options);
    this.commandAdmissionTokens = new WeakMap();
  }

  async receiveControl(detail) {
    try {
      return await super.receiveControl(detail);
    } finally {
      this.transport.releaseControl?.(detail?.admissionToken);
    }
  }

  queueCommand(envelope) {
    if (this.commandResults.has(envelope?.body?.commandId)) {
      super.queueCommand(envelope);
      return;
    }
    const token = this.transport.reserveCommand?.(envelope?.body);
    if (!token) throw new TypeError("The authenticated command admission budget was exceeded.");
    this.commandAdmissionTokens.set(envelope, token);
    try {
      super.queueCommand(envelope);
    } catch (error) {
      this.commandAdmissionTokens.delete(envelope);
      this.transport.releaseCommand?.(token);
      throw error;
    }
  }

  async handleCommand(envelope) {
    const token = this.commandAdmissionTokens.get(envelope);
    try {
      return await super.handleCommand(envelope);
    } finally {
      if (token) {
        this.commandAdmissionTokens.delete(envelope);
        this.transport.releaseCommand?.(token);
      }
    }
  }
}
