import { flubberRemoteSdkOptions } from "./flubber-remote.js?v=ground-control-1";
import { normalizePortableSettings } from "./portable-settings.js?v=shape-1";

export const GROUND_CONTROL_SETTINGS_ROOM = "affect_tracker_settings_v1";
export const GROUND_CONTROL_SETTINGS_PREFIX = "aft_settings_";
export const GROUND_CONTROL_SETTINGS_CHANNEL = "affectsettingsv1";
export const GROUND_CONTROL_SETTINGS_PROTOCOL = "affect-tracker-portable-settings";
export const GROUND_CONTROL_SETTINGS_VERSION = 1;
export const GROUND_CONTROL_MAX_BYTES = 64 * 1024;
export const GROUND_CONTROL_DISCOVERY_SETTLE_MS = 300;

export function shouldDismissGroundRadar({ mode, phase } = {}) {
  return mode === "live" && phase === "live";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function normalizeError(error) {
  return error?.message ?? String(error ?? "Unknown Ground Control transport error");
}

function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  if (bytes.every((value) => value === 0)) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function defaultSdkFactory() {
  if (typeof globalThis.VDONinjaSDK !== "function") {
    throw new Error("The bundled VDO.Ninja transport could not be loaded.");
  }
  return new globalThis.VDONinjaSDK(flubberRemoteSdkOptions());
}

function frameBytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function sourceItem(value) {
  if (typeof value === "string") return { streamId: value, uuid: "", label: "" };
  return {
    streamId: value?.streamID ?? value?.streamId ?? "",
    uuid: value?.UUID ?? value?.uuid ?? "",
    label: value?.label ?? value?.streamLabel ?? value?.name ?? "",
  };
}

export function normalizeGroundControlName(value) {
  if (typeof value !== "string") throw new TypeError("Enter a name for these settings.");
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Enter a name for these settings.");
  if (name.length > 64) throw new Error("The Ground Control name must be 64 characters or fewer.");
  return name;
}

export function groundControlFilename(value) {
  const name = normalizeGroundControlName(value);
  const slug = name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `${slug || "flubber-settings"}.json`;
}

function publicSignalNameToken(value, maxLength = 36) {
  try {
    return normalizeGroundControlName(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, maxLength);
  } catch {
    return "";
  }
}

function sourceNameFromId(streamId) {
  const suffix = String(streamId ?? "").slice(GROUND_CONTROL_SETTINGS_PREFIX.length);
  const token = suffix.replace(/_[a-f0-9]{12}$/i, "");
  return token && token !== suffix ? token.replace(/_/g, " ") : "";
}

export function generateSettingsSourceId(randomBytes = defaultRandomBytes, name = "") {
  const suffix = Array.from(randomBytes(6), (value) => value.toString(16).padStart(2, "0")).join("");
  const nameToken = publicSignalNameToken(name);
  return `${GROUND_CONTROL_SETTINGS_PREFIX}${nameToken ? `${nameToken}_` : ""}${suffix}`;
}

export function isSettingsSource(streamId) {
  return typeof streamId === "string" && streamId.startsWith(GROUND_CONTROL_SETTINGS_PREFIX);
}

export function settingsSourceLabel(name) {
  return `${normalizeGroundControlName(name)} · JSON settings`;
}

export function sourceNameFromLabel(label, streamId = "") {
  const raw = String(label ?? "").replace(/\s*·\s*JSON settings\s*$/i, "");
  try {
    return normalizeGroundControlName(raw);
  } catch {
    const listedName = sourceNameFromId(streamId);
    if (listedName) return listedName;
    const suffix = String(streamId).slice(GROUND_CONTROL_SETTINGS_PREFIX.length).toUpperCase().slice(-8);
    return `Settings ${suffix || "signal"}`;
  }
}

export function encodeSettingsSnapshot({ name, settings, createdAt = new Date().toISOString() }) {
  const envelope = {
    protocol: GROUND_CONTROL_SETTINGS_PROTOCOL,
    version: GROUND_CONTROL_SETTINGS_VERSION,
    name: normalizeGroundControlName(name),
    createdAt: String(createdAt),
    settings: normalizePortableSettings(settings),
  };
  if (!Number.isFinite(Date.parse(envelope.createdAt))) throw new Error("The settings snapshot timestamp is invalid.");
  const payload = JSON.stringify(envelope);
  const bytes = encoder.encode(payload);
  if (bytes.byteLength > GROUND_CONTROL_MAX_BYTES) {
    throw new Error(`The settings snapshot exceeds ${GROUND_CONTROL_MAX_BYTES / 1024} KB.`);
  }
  return payload;
}

export function decodeSettingsSnapshot(value) {
  const bytes = frameBytes(value);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > GROUND_CONTROL_MAX_BYTES) return undefined;
  try {
    const envelope = JSON.parse(decoder.decode(bytes));
    if (envelope?.protocol !== GROUND_CONTROL_SETTINGS_PROTOCOL
      || envelope?.version !== GROUND_CONTROL_SETTINGS_VERSION) return undefined;
    const name = normalizeGroundControlName(envelope.name);
    if (!Number.isFinite(Date.parse(envelope.createdAt))) return undefined;
    return {
      protocol: GROUND_CONTROL_SETTINGS_PROTOCOL,
      version: GROUND_CONTROL_SETTINGS_VERSION,
      name,
      createdAt: envelope.createdAt,
      settings: normalizePortableSettings(envelope.settings),
    };
  } catch {
    return undefined;
  }
}

class GroundControlTransport extends EventTarget {
  constructor(options = {}) {
    super();
    this.sdkFactory = options.sdkFactory ?? defaultSdkFactory;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.sdk = undefined;
    this.listeners = [];
    this.timeoutIds = new Set();
  }

  listen(type, handler) {
    this.sdk.addEventListener(type, handler);
    this.listeners.push([type, handler]);
  }

  timeout(callback, milliseconds) {
    const id = this.setTimeoutFn(() => {
      this.timeoutIds.delete(id);
      callback();
    }, milliseconds);
    this.timeoutIds.add(id);
    return id;
  }

  clearTimers() {
    for (const id of this.timeoutIds) this.clearTimeoutFn(id);
    this.timeoutIds.clear();
  }

  async disconnectSdk() {
    this.clearTimers();
    if (this.sdk) {
      for (const [type, handler] of this.listeners) this.sdk.removeEventListener(type, handler);
    }
    this.listeners = [];
    const sdk = this.sdk;
    this.sdk = undefined;
    try {
      await sdk?.disconnect?.();
    } catch {
      // Page teardown and already-closed signaling sessions are best effort.
    }
  }
}

export class SettingsSnapshotBroadcaster extends GroundControlTransport {
  constructor(options = {}) {
    super(options);
    this.phase = "idle";
    this.streamId = "";
    this.name = "";
    this.payload = "";
    this.channels = new Map();
    this.openingPeers = new Set();
  }

  snapshot() {
    return {
      phase: this.phase,
      streamId: this.streamId,
      name: this.name,
      sourceLabel: this.name ? settingsSourceLabel(this.name) : "",
      listenerCount: this.channels.size,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  async start({ name, settings }) {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.name = normalizeGroundControlName(name);
    this.payload = encodeSettingsSnapshot({ name: this.name, settings });
    this.streamId = generateSettingsSourceId(this.randomBytes, this.name);
    this.phase = "connecting";
    this.emitState({ message: "Opening the public JSON settings beacon…" });
    try {
      this.sdk = this.sdkFactory();
      this.listen("dataChannelOpen", (event) => { void this.openSnapshotChannel(event.detail?.uuid); });
      this.listen("dataChannelClose", (event) => this.removePeer(event.detail?.uuid));
      this.listen("userLeft", (event) => this.removePeer(event.detail?.UUID ?? event.detail?.uuid));
      this.listen("error", (event) => this.emitState({ message: normalizeError(event.detail?.error ?? event.detail), error: true }));
      await this.sdk.connect();
      await this.sdk.joinRoom({ room: GROUND_CONTROL_SETTINGS_ROOM, password: false });
      await this.sdk.announce({ streamID: this.streamId, label: settingsSourceLabel(this.name) });
      this.phase = "broadcasting";
      this.emitState({ message: `${settingsSourceLabel(this.name)} is public and ready.` });
      return this.snapshot();
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: normalizeError(error), error: true });
      await this.disconnectSdk();
      throw error;
    }
  }

  async openSnapshotChannel(uuid) {
    if (!uuid || !this.sdk || this.channels.has(uuid) || this.openingPeers.has(uuid)) return;
    this.openingPeers.add(uuid);
    try {
      const channel = await this.sdk.openChannel(uuid, GROUND_CONTROL_SETTINGS_CHANNEL, { ordered: true });
      this.channels.set(uuid, channel);
      channel.addEventListener?.("close", () => this.removePeer(uuid), { once: true });
      let sent = false;
      const sendSnapshot = () => {
        if (sent || channel.readyState !== "open" || !this.payload) return;
        sent = true;
        channel.send(this.payload);
      };
      channel.addEventListener?.("open", sendSnapshot, { once: true });
      sendSnapshot();
      this.emitState({ message: "A listener received the frozen JSON settings snapshot." });
    } catch (error) {
      this.emitState({ message: `Could not send the settings snapshot: ${normalizeError(error)}`, error: true });
    } finally {
      this.openingPeers.delete(uuid);
    }
  }

  removePeer(uuid) {
    if (!uuid) return;
    const changed = this.channels.delete(uuid);
    this.openingPeers.delete(uuid);
    if (changed) this.emitState();
  }

  async stop() {
    const disconnectPending = Boolean(this.sdk);
    this.phase = disconnectPending ? "stopping" : "idle";
    for (const channel of this.channels.values()) {
      try { channel.close?.(); } catch { /* signaling teardown remains authoritative */ }
    }
    const disconnecting = this.disconnectSdk();
    this.streamId = "";
    this.name = "";
    this.payload = "";
    this.channels.clear();
    this.openingPeers.clear();
    this.emitState(disconnectPending ? { message: "Stopping the JSON settings beacon…" } : {});
    await disconnecting;
    if (this.phase === "stopping") {
      this.phase = "idle";
      this.emitState();
    }
  }
}

export class SettingsSnapshotReceiver extends GroundControlTransport {
  constructor(options = {}) {
    super(options);
    this.phase = "idle";
    this.sources = new Map();
    this.selectedStreamId = "";
    this.selectedUuid = "";
    this.channel = undefined;
    this.received = undefined;
  }

  snapshot() {
    return {
      phase: this.phase,
      sources: Array.from(this.sources.values()).sort((left, right) => left.name.localeCompare(right.name)),
      selectedStreamId: this.selectedStreamId,
      sourceName: this.sources.get(this.selectedStreamId)?.name ?? "",
      received: this.received,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  addSource(value) {
    const { streamId, uuid, label } = sourceItem(value);
    if (!isSettingsSource(streamId)) return;
    const source = {
      streamId,
      uuid,
      name: sourceNameFromLabel(label, streamId),
      label: label || settingsSourceLabel(sourceNameFromLabel(label, streamId)),
    };
    this.sources.set(streamId, source);
    if (streamId === this.selectedStreamId && uuid) this.selectedUuid = uuid;
    this.emitState();
  }

  addListing(detail) {
    if (Array.isArray(detail?.list)) {
      for (const item of detail.list) this.addSource(item);
    } else this.addSource(detail);
  }

  removeSource(identifier) {
    if (!identifier) return;
    for (const [streamId, source] of this.sources) {
      if (identifier !== streamId && identifier !== source.uuid) continue;
      this.sources.delete(streamId);
      if (streamId === this.selectedStreamId) {
        this.phase = "discovering";
        this.selectedStreamId = "";
        this.selectedUuid = "";
        this.channel = undefined;
        this.received = undefined;
        this.emitState({ message: "The selected JSON settings beacon left the radar." });
      }
    }
    this.emitState();
  }

  async startDiscovery() {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.phase = "discovering";
    this.emitState({ message: "Scanning for public JSON settings beacons…" });
    try {
      this.sdk = this.sdkFactory();
      this.listen("listing", (event) => this.addListing(event.detail));
      this.listen("videoaddedtoroom", (event) => this.addSource(event.detail));
      this.listen("userLeft", (event) => this.removeSource(
        event.detail?.UUID ?? event.detail?.uuid ?? event.detail?.streamID ?? event.detail?.streamId,
      ));
      this.listen("channelOpen", (event) => this.acceptChannel(event.detail));
      this.listen("error", (event) => this.emitState({ message: normalizeError(event.detail?.error ?? event.detail), error: true }));
      await this.sdk.connect();
      await this.sdk.joinRoom({ room: GROUND_CONTROL_SETTINGS_ROOM, password: false });
      this.timeout(() => {
        if (this.phase === "discovering") this.emitState({
          message: this.sources.size ? `${this.sources.size} JSON settings beacon${this.sources.size === 1 ? "" : "s"} available.` : "No JSON settings beacons found yet.",
        });
      }, GROUND_CONTROL_DISCOVERY_SETTLE_MS);
      return this.snapshot();
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: normalizeError(error), error: true });
      await this.disconnectSdk();
      throw error;
    }
  }

  async selectSource(streamId) {
    if (!this.sdk || !isSettingsSource(streamId) || !this.sources.has(streamId)) return this.snapshot();
    if (this.selectedStreamId) {
      try { await this.sdk.stopViewing?.(this.selectedStreamId); } catch { /* explicit replacement wins */ }
    }
    const source = this.sources.get(streamId);
    this.selectedStreamId = streamId;
    this.selectedUuid = source.uuid;
    this.channel = undefined;
    this.received = undefined;
    this.phase = "connecting";
    this.emitState({ message: `Requesting ${source.name}…` });
    try {
      await this.sdk.view(streamId, {
        audio: false,
        video: false,
        downloads: false,
        allowresources: false,
        label: "Affect Tracker Ground Control settings receiver",
      });
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: normalizeError(error), error: true });
    }
    return this.snapshot();
  }

  acceptChannel(detail) {
    if (!detail || detail.label !== `x-${GROUND_CONTROL_SETTINGS_CHANNEL}` || !this.selectedStreamId) return;
    if (detail.streamID && detail.streamID !== this.selectedStreamId) return;
    if (this.selectedUuid && detail.uuid && detail.uuid !== this.selectedUuid) return;
    this.channel = detail.channel;
    const acceptedChannel = this.channel;
    acceptedChannel.addEventListener("message", (event) => {
      if (this.channel !== acceptedChannel) return;
      const received = decodeSettingsSnapshot(event.data);
      if (!received) {
        this.emitState({ message: "The received settings snapshot was invalid or too large.", error: true });
        return;
      }
      this.received = received;
      this.phase = "ready";
      this.dispatchEvent(detailEvent("snapshot", this.snapshot()));
      this.emitState({ message: `${received.name} is validated and ready to apply.` });
    }, { once: true });
    this.emitState({ message: "Reliable settings channel open; waiting for the snapshot…" });
  }

  async stop() {
    if (this.sdk && this.selectedStreamId) {
      try { await this.sdk.stopViewing?.(this.selectedStreamId); } catch { /* continue teardown */ }
    }
    await this.disconnectSdk();
    this.phase = "idle";
    this.sources.clear();
    this.selectedStreamId = "";
    this.selectedUuid = "";
    this.channel = undefined;
    this.received = undefined;
    this.emitState();
  }
}

export function createSettingsSnapshotBroadcaster(options) {
  return new SettingsSnapshotBroadcaster(options);
}

export function createSettingsSnapshotReceiver(options) {
  return new SettingsSnapshotReceiver(options);
}
