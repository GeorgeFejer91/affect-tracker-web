import { clamp } from "./math.js";

export const FLUBBER_REMOTE_ROOM = "affect_tracker_flubber_v1";
export const FLUBBER_REMOTE_STREAM_PREFIX = "aft_flubber_";
export const FLUBBER_REMOTE_CHANNEL = "flubberxyv1";
export const FLUBBER_REMOTE_WIRE_BYTES = 12;
export const FLUBBER_REMOTE_MAX_HZ = 60;
export const FLUBBER_REMOTE_HEARTBEAT_MS = 100;
export const FLUBBER_REMOTE_STALE_MS = 2_000;
export const FLUBBER_REMOTE_RECOVERY_FRAMES = 3;
export const FLUBBER_REMOTE_DISCOVERY_SETTLE_MS = 300;
export const FLUBBER_REMOTE_FORCE_TURN_PARAM = "remote-force-turn";

const MIN_SEND_INTERVAL_MS = 1_000 / FLUBBER_REMOTE_MAX_HZ;
// Chrome animation frames can arrive a fraction before the ideal 60 Hz
// deadline. A strict previous-send comparison then rejects that frame and
// waits for the following one, collapsing a healthy sender toward 30 Hz. Keep
// a small bounded scheduling debt while advancing the ideal deadline at 60 Hz;
// long-run throughput remains capped and rapid callers cannot burst freely.
const CHANGE_SEND_EARLY_TOLERANCE_MS = 5;
const MIN_CHANGED_SEND_SEPARATION_MS = MIN_SEND_INTERVAL_MS - CHANGE_SEND_EARLY_TOLERANCE_MS;
const DIAGNOSTIC_GAP_WINDOW = 128;
const DIAGNOSTIC_LATE_GAP_MS = 500;
const SDK_OPTIONS = Object.freeze({
  password: false,
  salt: "affect-tracker-web-v1",
});

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function normalizeError(error) {
  return error?.message ?? String(error ?? "Unknown remote transport error");
}

export function flubberRemoteForceTurnEnabled(locationObject = globalThis.location) {
  try {
    return new URL(locationObject?.href ?? "https://invalid.local/")
      .searchParams.get(FLUBBER_REMOTE_FORCE_TURN_PARAM) === "1";
  } catch {
    return false;
  }
}

export function flubberRemoteSdkOptions({ forceTurn = flubberRemoteForceTurnEnabled() } = {}) {
  return {
    ...SDK_OPTIONS,
    forceTURN: Boolean(forceTurn),
  };
}

function defaultSdkFactory(forceTurn) {
  if (typeof globalThis.VDONinjaSDK !== "function") {
    throw new Error("The bundled VDO.Ninja transport could not be loaded.");
  }
  return new globalThis.VDONinjaSDK(flubberRemoteSdkOptions({ forceTurn }));
}

function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  if (bytes.every((value) => value === 0)) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

export function generateFlubberSourceId(randomBytes = defaultRandomBytes) {
  const suffix = Array.from(randomBytes(4), (value) => value.toString(16).padStart(2, "0")).join("");
  return `${FLUBBER_REMOTE_STREAM_PREFIX}${suffix}`;
}

export function formatFlubberSourceLabel(streamId) {
  const suffix = String(streamId ?? "").startsWith(FLUBBER_REMOTE_STREAM_PREFIX)
    ? String(streamId).slice(FLUBBER_REMOTE_STREAM_PREFIX.length)
    : String(streamId ?? "");
  const compact = suffix.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(-8).padStart(8, "0");
  return `Source ${compact.slice(0, 4)} ${compact.slice(4)}`;
}

export function isFlubberSource(streamId) {
  return typeof streamId === "string" && streamId.startsWith(FLUBBER_REMOTE_STREAM_PREFIX);
}

export function encodeFlubberFrame(sequence, currentX, currentY) {
  const x = Number(currentX);
  const y = Number(currentY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("Flubber coordinates must be finite numbers.");
  }
  const bytes = new ArrayBuffer(FLUBBER_REMOTE_WIRE_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, Number(sequence) >>> 0, true);
  view.setFloat32(4, clamp(x), true);
  view.setFloat32(8, clamp(y), true);
  return bytes;
}

function frameBytes(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return undefined;
}

export function decodeFlubberFrame(value) {
  const bytes = frameBytes(value);
  if (!bytes || bytes.byteLength !== FLUBBER_REMOTE_WIRE_BYTES) return undefined;
  const view = new DataView(bytes);
  const currentX = view.getFloat32(4, true);
  const currentY = view.getFloat32(8, true);
  if (!Number.isFinite(currentX) || !Number.isFinite(currentY)) return undefined;
  return {
    sequence: view.getUint32(0, true),
    currentX: clamp(currentX),
    currentY: clamp(currentY),
  };
}

export function isNewerFlubberSequence(sequence, previousSequence) {
  if (previousSequence === undefined || previousSequence === null) return true;
  const distance = ((Number(sequence) >>> 0) - (Number(previousSequence) >>> 0)) >>> 0;
  return distance > 0 && distance < 0x80000000;
}

function sourceItem(value) {
  if (typeof value === "string") return { streamId: value, uuid: "" };
  return {
    streamId: value?.streamID ?? value?.streamId ?? "",
    uuid: value?.UUID ?? value?.uuid ?? "",
  };
}

function qualitySummary(quality) {
  if (!quality) return { route: "unknown", rttMs: undefined };
  return {
    route: quality.relayed === true ? "relay" : quality.relayed === false ? "direct" : "unknown",
    rttMs: Number.isFinite(quality.rttMs) ? Math.round(quality.rttMs) : undefined,
  };
}

function roundedPercentile(values, proportion) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * proportion) - 1));
  return Math.round(sorted[index]);
}

class FlubberRemoteBase extends EventTarget {
  constructor(options = {}) {
    super();
    const {
      sdkFactory,
      forceTurn = flubberRemoteForceTurnEnabled(),
      now = () => globalThis.performance.now(),
      setIntervalFn = (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
      clearIntervalFn = (id) => globalThis.clearInterval(id),
      setTimeoutFn = (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clearTimeoutFn = (id) => globalThis.clearTimeout(id),
    } = options;
    this.forceTurn = Boolean(forceTurn);
    this.sdkFactory = sdkFactory ?? (() => defaultSdkFactory(this.forceTurn));
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.sdk = undefined;
    this.listeners = [];
    this.intervalIds = new Set();
    this.timeoutIds = new Set();
  }

  listen(type, handler) {
    this.sdk.addEventListener(type, handler);
    this.listeners.push([type, handler]);
  }

  interval(callback, milliseconds) {
    const id = this.setIntervalFn(callback, milliseconds);
    this.intervalIds.add(id);
    return id;
  }

  timeout(callback, milliseconds) {
    const id = this.setTimeoutFn(() => {
      this.timeoutIds.delete(id);
      callback();
    }, milliseconds);
    this.timeoutIds.add(id);
    return id;
  }

  clearTimeout(id) {
    if (id === undefined) return;
    this.clearTimeoutFn(id);
    this.timeoutIds.delete(id);
  }

  clearTimers() {
    for (const id of this.intervalIds) this.clearIntervalFn(id);
    for (const id of this.timeoutIds) this.clearTimeoutFn(id);
    this.intervalIds.clear();
    this.timeoutIds.clear();
  }

  removeListeners() {
    if (!this.sdk) return;
    for (const [type, handler] of this.listeners) this.sdk.removeEventListener(type, handler);
    this.listeners = [];
  }

  async disconnectSdk() {
    this.clearTimers();
    this.removeListeners();
    const sdk = this.sdk;
    this.sdk = undefined;
    if (!sdk) return;
    try {
      await sdk.disconnect?.();
    } catch {
      // Page teardown and already-closed signaling connections are best effort.
    }
  }
}

export class FlubberBroadcaster extends FlubberRemoteBase {
  constructor(options = {}) {
    super(options);
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.phase = "idle";
    this.streamId = "";
    this.channels = new Map();
    this.openingPeers = new Set();
    this.backpressuredPeers = new Set();
    this.latest = undefined;
    this.lastSent = undefined;
    this.lastSentAt = -Infinity;
    this.lastChangedSentAt = -Infinity;
    this.nextChangedSendAt = -Infinity;
    this.sequence = 0;
    this.droppedBackpressure = 0;
    this.quality = new Map();
    this.heartbeatTimer = undefined;
  }

  snapshot() {
    const qualities = Array.from(this.quality.values());
    const relayed = qualities.filter((item) => item.route === "relay").length;
    const direct = qualities.filter((item) => item.route === "direct").length;
    const rtts = qualities.map((item) => item.rttMs).filter(Number.isFinite);
    return {
      phase: this.phase,
      streamId: this.streamId,
      sourceLabel: this.streamId ? formatFlubberSourceLabel(this.streamId) : "",
      listenerCount: this.channels.size,
      directListeners: direct,
      relayedListeners: relayed,
      rttMs: rtts.length ? Math.max(...rtts) : undefined,
      droppedBackpressure: this.droppedBackpressure,
      sequence: this.sequence,
      lastSendAgeMs: Number.isFinite(this.lastSentAt) ? Math.max(0, this.now() - this.lastSentAt) : undefined,
      forceTurnRequested: this.forceTurn,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  async start() {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.phase = "connecting";
    this.streamId = generateFlubberSourceId(this.randomBytes);
    this.emitState();
    let stage = "loading the bundled VDO.Ninja SDK";
    try {
      this.sdk = this.sdkFactory();
      stage = "registering transport events";
      this.listen("dataChannelOpen", (event) => { void this.openRealtimeChannel(event.detail?.uuid); });
      this.listen("dataChannelClose", (event) => this.removePeer(event.detail?.uuid));
      this.listen("userLeft", (event) => this.removePeer(event.detail?.UUID ?? event.detail?.uuid));
      this.listen("connectionFailed", (event) => this.emitState({
        message: `A listener connection failed: ${event.detail?.reason ?? "unknown reason"}`,
      }));
      this.listen("error", (event) => this.emitState({ message: normalizeError(event.detail?.error ?? event.detail) }));
      stage = "connecting to signaling";
      await this.sdk.connect();
      stage = "joining the public discovery room";
      await this.sdk.joinRoom({ room: FLUBBER_REMOTE_ROOM, password: false });
      stage = "announcing the data-only source";
      await this.sdk.announce({
        streamID: this.streamId,
        label: formatFlubberSourceLabel(this.streamId),
      });
      this.phase = "broadcasting";
      this.scheduleHeartbeat();
      this.interval(() => { void this.refreshQuality(); }, 2_000);
      this.emitState({ message: "Broadcast is available to VR and remote browsers." });
      return this.snapshot();
    } catch (error) {
      const stagedError = new Error(`Remote broadcast failed while ${stage}: ${normalizeError(error)}`, { cause: error });
      this.phase = "error";
      this.emitState({ message: stagedError.message, error: true });
      await this.disconnectSdk();
      throw stagedError;
    }
  }

  offer(currentX, currentY, offeredAt = this.now()) {
    const x = Number(currentX);
    const y = Number(currentY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.latest = { currentX: clamp(x), currentY: clamp(y) };
    const changed = !this.lastSent
      || this.latest.currentX !== this.lastSent.currentX
      || this.latest.currentY !== this.lastSent.currentY;
    if (changed && this.changedSendReady(offeredAt)) return this.flush(false, offeredAt);
    return false;
  }

  changedSendReady(offeredAt) {
    if (offeredAt - this.lastChangedSentAt < MIN_CHANGED_SEND_SEPARATION_MS) return false;
    return !Number.isFinite(this.nextChangedSendAt)
      || offeredAt + CHANGE_SEND_EARLY_TOLERANCE_MS >= this.nextChangedSendAt;
  }

  recordChangedSend(sentAt) {
    this.lastChangedSentAt = sentAt;
    if (!Number.isFinite(this.nextChangedSendAt)
      || sentAt > this.nextChangedSendAt + MIN_SEND_INTERVAL_MS) {
      this.nextChangedSendAt = sentAt + MIN_SEND_INTERVAL_MS;
      return;
    }
    this.nextChangedSendAt += MIN_SEND_INTERVAL_MS;
  }

  flush(force = false, sentAt = this.now(), onlyUuid) {
    if (this.phase !== "broadcasting" || !this.latest || this.channels.size === 0) return false;
    const changed = !this.lastSent
      || this.latest.currentX !== this.lastSent.currentX
      || this.latest.currentY !== this.lastSent.currentY;
    if (!force && (!changed || !this.changedSendReady(sentAt))) return false;
    const nextSequence = (this.sequence + 1) >>> 0;
    const frame = encodeFlubberFrame(nextSequence, this.latest.currentX, this.latest.currentY);
    let sent = false;
    const channels = onlyUuid
      ? [[onlyUuid, this.channels.get(onlyUuid)]]
      : this.channels.entries();
    for (const [uuid, channel] of channels) {
      if (!channel) continue;
      if (channel.readyState !== "open") continue;
      if (Number(channel.bufferedAmount) > 0) {
        this.droppedBackpressure += 1;
        this.backpressuredPeers.add(uuid);
        continue;
      }
      try {
        channel.send(frame);
        this.backpressuredPeers.delete(uuid);
        sent = true;
      } catch {
        // The close event owns peer removal; retain the newest state for another channel.
      }
    }
    if (sent) {
      this.sequence = nextSequence;
      this.lastSent = { ...this.latest };
      this.lastSentAt = sentAt;
      if (changed) this.recordChangedSend(sentAt);
      this.scheduleHeartbeat();
    }
    return sent;
  }

  heartbeat(sentAt = this.now()) {
    if (sentAt - this.lastSentAt < FLUBBER_REMOTE_HEARTBEAT_MS) return false;
    return this.flush(true, sentAt);
  }

  scheduleHeartbeat() {
    if (this.phase !== "broadcasting") return;
    this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.timeout(() => {
      this.heartbeatTimer = undefined;
      if (!this.heartbeat()) this.scheduleHeartbeat();
    }, FLUBBER_REMOTE_HEARTBEAT_MS);
  }

  async openRealtimeChannel(uuid) {
    if (!uuid || this.channels.has(uuid) || this.openingPeers.has(uuid) || !this.sdk) return;
    this.openingPeers.add(uuid);
    try {
      const channel = await this.sdk.openChannel(uuid, FLUBBER_REMOTE_CHANNEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 0;
      this.channels.set(uuid, channel);
      const remove = () => this.removePeer(uuid);
      channel.addEventListener?.("close", remove, { once: true });
      channel.addEventListener?.("bufferedamountlow", () => {
        if (this.backpressuredPeers.delete(uuid)) this.flush(true, this.now(), uuid);
      });
      this.emitState({ message: "A remote listener is receiving Flubber coordinates." });
      this.flush(true);
      void this.refreshQuality();
    } catch (error) {
      this.emitState({ message: `Could not open the realtime channel: ${normalizeError(error)}`, error: true });
    } finally {
      this.openingPeers.delete(uuid);
    }
  }

  removePeer(uuid) {
    if (!uuid) return;
    const changed = this.channels.delete(uuid) || this.quality.delete(uuid);
    this.openingPeers.delete(uuid);
    this.backpressuredPeers.delete(uuid);
    if (changed) this.emitState();
  }

  async refreshQuality() {
    if (!this.sdk?.getPeerQuality) return;
    await Promise.all(Array.from(this.channels.keys(), async (uuid) => {
      try {
        this.quality.set(uuid, qualitySummary(await this.sdk.getPeerQuality(uuid)));
      } catch {
        this.quality.delete(uuid);
      }
    }));
    if (this.phase === "broadcasting") this.emitState();
  }

  async stop() {
    const disconnectPending = Boolean(this.sdk);
    this.phase = disconnectPending ? "stopping" : "idle";
    this.clearTimers();
    this.heartbeatTimer = undefined;
    for (const channel of Array.from(this.channels.values())) {
      try {
        channel.close?.();
      } catch {
        // Signaling teardown below remains the final best-effort cleanup path.
      }
    }
    const disconnecting = this.disconnectSdk();
    this.streamId = "";
    this.channels.clear();
    this.openingPeers.clear();
    this.backpressuredPeers.clear();
    this.quality.clear();
    this.latest = undefined;
    this.lastSent = undefined;
    this.lastSentAt = -Infinity;
    this.lastChangedSentAt = -Infinity;
    this.nextChangedSendAt = -Infinity;
    this.sequence = 0;
    this.droppedBackpressure = 0;
    this.emitState(disconnectPending ? { message: "Stopping remote broadcast…" } : {});
    await disconnecting;
    if (this.phase === "stopping") {
      this.phase = "idle";
      this.emitState();
    }
  }
}

export class FlubberReceiver extends FlubberRemoteBase {
  constructor(options = {}) {
    super(options);
    this.phase = "idle";
    this.sources = new Map();
    this.selectedStreamId = "";
    this.selectedUuid = "";
    this.channel = undefined;
    this.latest = undefined;
    this.lastSequence = undefined;
    this.quality = { route: "unknown", rttMs: undefined };
    this.discoveryTimer = undefined;
    this.staleTimer = undefined;
    this.disconnectNotified = false;
    this.tearingDown = false;
    this.resetDiagnostics();
  }

  resetDiagnostics() {
    this.recoveryFrameCount = 0;
    this.receivedFrames = 0;
    this.packetGaps = [];
    this.lastGapMs = undefined;
    this.maxGapMs = undefined;
    this.lateGapCount = 0;
    this.staleTransitions = 0;
    this.recoveryTransitions = 0;
  }

  recordPacketGap(gapMs) {
    this.receivedFrames += 1;
    if (!Number.isFinite(gapMs)) return;
    const normalized = Math.max(0, gapMs);
    this.lastGapMs = normalized;
    this.maxGapMs = Math.max(this.maxGapMs ?? 0, normalized);
    if (normalized >= DIAGNOSTIC_LATE_GAP_MS) this.lateGapCount += 1;
    this.packetGaps.push(normalized);
    if (this.packetGaps.length > DIAGNOSTIC_GAP_WINDOW) this.packetGaps.shift();
  }

  snapshot(now = this.now()) {
    const packetAgeMs = this.latest ? Math.max(0, now - this.latest.receivedAt) : undefined;
    const stale = Boolean(this.selectedStreamId && this.latest && packetAgeMs >= FLUBBER_REMOTE_STALE_MS);
    return {
      enabled: this.phase !== "idle",
      phase: stale ? "stale" : this.phase,
      sources: Array.from(this.sources.values()).sort((left, right) => left.label.localeCompare(right.label)),
      selectedStreamId: this.selectedStreamId,
      sourceLabel: this.selectedStreamId ? formatFlubberSourceLabel(this.selectedStreamId) : "",
      latest: this.latest ? {
        sequence: this.latest.sequence,
        currentX: this.latest.currentX,
        currentY: this.latest.currentY,
        receivedAt: this.latest.receivedAt,
      } : undefined,
      packetAgeMs,
      route: this.quality.route,
      rttMs: this.quality.rttMs,
      diagnostics: {
        receivedFrames: this.receivedFrames,
        lastGapMs: Number.isFinite(this.lastGapMs) ? Math.round(this.lastGapMs) : undefined,
        p95GapMs: roundedPercentile(this.packetGaps, 0.95),
        maxGapMs: Number.isFinite(this.maxGapMs) ? Math.round(this.maxGapMs) : undefined,
        lateGapCount: this.lateGapCount,
        staleTransitions: this.staleTransitions,
        recoveryTransitions: this.recoveryTransitions,
      },
      forceTurnRequested: this.forceTurn,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  addSource(item) {
    const { streamId, uuid } = sourceItem(item);
    if (!isFlubberSource(streamId)) return;
    const existing = this.sources.get(streamId);
    if (existing) {
      if (uuid && uuid !== existing.uuid) {
        existing.uuid = uuid;
        if (streamId === this.selectedStreamId) this.selectedUuid = uuid;
        this.emitState();
      }
      return;
    }
    this.sources.set(streamId, {
      streamId,
      uuid,
      label: formatFlubberSourceLabel(streamId),
    });
    if (!this.selectedStreamId) this.scheduleAutoSelection();
    this.emitState();
  }

  addListing(detail) {
    if (Array.isArray(detail?.list)) {
      for (const item of detail.list) this.addSource(item);
    } else {
      this.addSource(detail);
    }
  }

  removeSource(identifier) {
    if (!identifier) return;
    for (const [streamId, source] of this.sources) {
      if (source.uuid !== identifier && streamId !== identifier) continue;
      this.sources.delete(streamId);
      if (streamId === this.selectedStreamId) this.markDisconnected("The selected source left the room.");
    }
    if (!this.selectedStreamId) this.scheduleAutoSelection();
    this.emitState();
  }

  scheduleAutoSelection() {
    if (this.discoveryTimer || this.selectedStreamId) return;
    this.discoveryTimer = this.timeout(() => {
      this.discoveryTimer = undefined;
      if (this.selectedStreamId) return;
      if (this.sources.size === 1) {
        const [source] = this.sources.values();
        void this.selectSource(source.streamId);
      } else {
        this.phase = this.sources.size > 1 ? "selecting" : "discovering";
        this.emitState();
      }
    }, FLUBBER_REMOTE_DISCOVERY_SETTLE_MS);
  }

  async startDiscovery() {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.tearingDown = false;
    this.phase = "discovering";
    this.emitState({ message: "Looking for public Affect Tracker broadcasts…" });
    try {
      this.sdk = this.sdkFactory();
      this.listen("listing", (event) => this.addListing(event.detail));
      this.listen("videoaddedtoroom", (event) => this.addSource(event.detail));
      this.listen("userLeft", (event) => this.removeSource(
        event.detail?.UUID ?? event.detail?.uuid ?? event.detail?.streamID ?? event.detail?.streamId,
      ));
      this.listen("channelOpen", (event) => this.acceptChannel(event.detail));
      this.listen("dataChannelClose", (event) => {
        if (!this.selectedUuid || event.detail?.uuid === this.selectedUuid) {
          this.markDisconnected("The realtime connection closed.");
        }
      });
      this.listen("connectionFailed", (event) => {
        if (!this.selectedStreamId || event.detail?.streamID === this.selectedStreamId) {
          this.markDisconnected(`Connection failed: ${event.detail?.reason ?? "unknown reason"}`);
        }
      });
      this.listen("error", (event) => this.emitState({ message: normalizeError(event.detail?.error ?? event.detail), error: true }));
      await this.sdk.connect();
      await this.sdk.joinRoom({ room: FLUBBER_REMOTE_ROOM, password: false });
      this.interval(() => { void this.refreshQuality(); }, 2_000);
      this.scheduleAutoSelection();
      this.emitState();
      return this.snapshot();
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: normalizeError(error), error: true });
      await this.disconnectSdk();
      throw error;
    }
  }

  async selectSource(streamId) {
    if (!this.sdk || !isFlubberSource(streamId)) return this.snapshot();
    const previous = this.selectedStreamId;
    if (previous === streamId && (this.phase === "connecting" || this.phase === "live" || this.phase === "stale")) {
      return this.snapshot();
    }
    if (previous) {
      try {
        await this.sdk.stopViewing?.(previous);
      } catch {
        // The next explicit selection remains authoritative even if the old peer already left.
      }
    }
    const source = this.sources.get(streamId);
    this.selectedStreamId = streamId;
    this.selectedUuid = source?.uuid ?? "";
    this.channel = undefined;
    this.latest = undefined;
    this.lastSequence = undefined;
    this.clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    this.disconnectNotified = false;
    this.quality = { route: "unknown", rttMs: undefined };
    this.resetDiagnostics();
    this.phase = "connecting";
    this.emitState({
      transition: previous ? "switched" : "selected",
      message: `Connecting to ${formatFlubberSourceLabel(streamId)}…`,
    });
    try {
      await this.sdk.view(streamId, {
        audio: false,
        video: false,
        downloads: false,
        allowresources: false,
        label: "Affect Tracker Quest receiver",
      });
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: normalizeError(error), error: true });
    }
    return this.snapshot();
  }

  acceptChannel(detail) {
    if (!detail || detail.label !== `x-${FLUBBER_REMOTE_CHANNEL}`) return;
    if (!this.selectedStreamId) return;
    if (detail.streamID && detail.streamID !== this.selectedStreamId) return;
    if (this.selectedUuid && detail.uuid && detail.uuid !== this.selectedUuid) return;
    const acceptedStreamId = this.selectedStreamId;
    this.selectedUuid = detail.uuid ?? this.selectedUuid;
    this.channel = detail.channel;
    const acceptedChannel = this.channel;
    acceptedChannel.binaryType = "arraybuffer";
    acceptedChannel.addEventListener("message", (event) => {
      if (this.channel === acceptedChannel && this.selectedStreamId === acceptedStreamId) {
        this.acceptFrame(event.data);
      }
    });
    acceptedChannel.addEventListener("close", () => {
      if (this.channel === acceptedChannel && this.selectedStreamId === acceptedStreamId) {
        this.markDisconnected("The realtime channel closed.");
      }
    }, { once: true });
    this.emitState({ message: "Realtime channel open; waiting for coordinates…" });
    void this.refreshQuality();
  }

  acceptFrame(value, receivedAt = this.now()) {
    const frame = decodeFlubberFrame(value);
    if (!frame || !isNewerFlubberSequence(frame.sequence, this.lastSequence)) return false;
    const previousReceivedAt = this.latest?.receivedAt;
    const packetGapMs = Number.isFinite(previousReceivedAt) ? Math.max(0, receivedAt - previousReceivedAt) : undefined;
    const gapTimedOut = Number.isFinite(packetGapMs) && packetGapMs >= FLUBBER_REMOTE_STALE_MS;
    if (gapTimedOut && this.phase === "live") {
      this.markStale(`No coordinate update arrived for ${FLUBBER_REMOTE_STALE_MS / 1_000} seconds; holding the last position.`);
    }
    const wasStale = this.phase === "stale";
    const first = this.phase !== "live" && !wasStale;
    this.disconnectNotified = false;
    this.lastSequence = frame.sequence;
    this.latest = { ...frame, receivedAt };
    this.recordPacketGap(packetGapMs);
    if (wasStale) {
      this.recoveryFrameCount = !gapTimedOut && Number.isFinite(packetGapMs)
        ? this.recoveryFrameCount + 1
        : 1;
    } else {
      this.recoveryFrameCount = 0;
    }
    const recovered = wasStale && this.recoveryFrameCount >= FLUBBER_REMOTE_RECOVERY_FRAMES;
    this.phase = wasStale && !recovered ? "stale" : "live";
    this.clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    if (this.phase === "live") {
      this.staleTimer = this.timeout(() => {
        this.staleTimer = undefined;
        this.checkStale();
      }, FLUBBER_REMOTE_STALE_MS);
    }
    this.dispatchEvent(detailEvent("frame", this.snapshot(receivedAt)));
    if (first || recovered) {
      if (recovered) {
        this.recoveryTransitions += 1;
        this.recoveryFrameCount = 0;
      }
      this.emitState({
        transition: recovered ? "recovered" : "live",
        message: recovered
          ? `Incoming Flubber coordinates recovered after ${FLUBBER_REMOTE_RECOVERY_FRAMES} consecutive frames.`
          : "Incoming Flubber coordinates are live.",
      });
    }
    return true;
  }

  checkStale(now = this.now()) {
    if (this.phase !== "live" || !this.latest) return false;
    if (now - this.latest.receivedAt < FLUBBER_REMOTE_STALE_MS) return false;
    this.markStale(`No coordinate update arrived for ${FLUBBER_REMOTE_STALE_MS / 1_000} seconds; holding the last position.`);
    return true;
  }

  markStale(message) {
    if (!this.selectedStreamId || this.tearingDown) return;
    const changed = this.phase !== "stale";
    this.phase = "stale";
    this.recoveryFrameCount = 0;
    if (changed) {
      this.staleTransitions += 1;
      this.emitState({ transition: "stale", message });
    }
  }

  markDisconnected(message) {
    if (!this.selectedStreamId || this.tearingDown) return;
    if (!this.disconnectNotified) {
      this.disconnectNotified = true;
      this.emitState({ transition: "disconnected", message });
    }
    this.markStale(message);
  }

  async refreshQuality() {
    if (!this.sdk?.getPeerQuality || !this.selectedUuid) return;
    try {
      this.quality = qualitySummary(await this.sdk.getPeerQuality(this.selectedUuid));
      if (this.phase === "live" || this.phase === "stale") this.emitState();
    } catch {
      this.quality = { route: "unknown", rttMs: undefined };
    }
  }

  async stop() {
    this.tearingDown = true;
    const previous = this.selectedStreamId;
    if (this.sdk && previous) {
      try {
        await this.sdk.stopViewing?.(previous);
      } catch {
        // Continue with complete signaling teardown.
      }
    }
    await this.disconnectSdk();
    this.phase = "idle";
    this.sources.clear();
    this.selectedStreamId = "";
    this.selectedUuid = "";
    this.channel = undefined;
    this.latest = undefined;
    this.lastSequence = undefined;
    this.quality = { route: "unknown", rttMs: undefined };
    this.discoveryTimer = undefined;
    this.staleTimer = undefined;
    this.disconnectNotified = false;
    this.tearingDown = false;
    this.resetDiagnostics();
    this.emitState({ transition: previous ? "disconnected" : undefined });
  }
}

export function createFlubberBroadcaster(options) {
  return new FlubberBroadcaster(options);
}

export function createFlubberReceiver(options) {
  return new FlubberReceiver(options);
}
