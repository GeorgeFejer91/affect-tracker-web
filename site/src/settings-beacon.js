import {
  normalizePortableSettings,
  SETTINGS_VERSION,
} from "./portable-settings.js?v=shape-1";

export const SETTINGS_BEACON_ROOM = "affect_tracker_settings_v1";
export const SETTINGS_BEACON_STREAM_PREFIX = "aft_settings_";
export const SETTINGS_BEACON_PROTOCOL = "affect-tracker-settings-beacon/v1";
export const SETTINGS_BEACON_DISCOVERY_SETTLE_MS = 300;
export const SETTINGS_BEACON_MAX_BYTES = 64 * 1024;

const SDK_OPTIONS = Object.freeze({
  password: false,
  salt: "affect-tracker-web-v1",
});
const SNAPSHOT_KEYS = Object.freeze([
  "protocol",
  "revision",
  "schemaVersion",
  "settings",
  "sourceId",
  "type",
]);
const REQUEST_KEYS = Object.freeze(["protocol", "requestId", "type"]);

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function errorMessage(error) {
  return error?.message ?? String(error ?? "Unknown settings beacon error");
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

function randomHex(length, randomBytes = defaultRandomBytes) {
  return Array.from(randomBytes(length), (value) => value.toString(16).padStart(2, "0")).join("");
}

function defaultSdkFactory() {
  if (typeof globalThis.VDONinjaSDK !== "function") {
    throw new Error("The bundled VDO.Ninja transport could not be loaded.");
  }
  return new globalThis.VDONinjaSDK({ ...SDK_OPTIONS });
}

function sourceItem(value) {
  if (typeof value === "string") return { streamId: value, uuid: "" };
  return {
    streamId: value?.streamID ?? value?.streamId ?? "",
    uuid: value?.UUID ?? value?.uuid ?? "",
  };
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export function settingsBeaconSdkOptions() {
  return { ...SDK_OPTIONS };
}

export function generateSettingsBeaconSourceId(randomBytes = defaultRandomBytes) {
  return `${SETTINGS_BEACON_STREAM_PREFIX}${randomHex(4, randomBytes)}`;
}

export function isSettingsBeaconSource(streamId) {
  return typeof streamId === "string" && streamId.startsWith(SETTINGS_BEACON_STREAM_PREFIX);
}

export function formatSettingsBeaconSourceLabel(streamId) {
  const suffix = isSettingsBeaconSource(streamId)
    ? streamId.slice(SETTINGS_BEACON_STREAM_PREFIX.length)
    : String(streamId ?? "");
  const compact = suffix.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(-8).padStart(8, "0");
  return `Settings Source ${compact.slice(0, 4)} ${compact.slice(4)}`;
}

export function settingsBeaconPayloadBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createSettingsBeaconSnapshot(settings, {
  sourceId,
  revision = 1,
} = {}) {
  if (!isSettingsBeaconSource(sourceId)) throw new Error("Settings beacon source ID is invalid.");
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 0xffffffff) {
    throw new Error("Settings beacon revision is invalid.");
  }
  const payload = {
    type: "settings-snapshot",
    protocol: SETTINGS_BEACON_PROTOCOL,
    sourceId,
    revision,
    schemaVersion: SETTINGS_VERSION,
    settings: normalizePortableSettings(settings),
  };
  if (settingsBeaconPayloadBytes(payload) > SETTINGS_BEACON_MAX_BYTES) {
    throw new Error(`Settings beacon payload must be at most ${SETTINGS_BEACON_MAX_BYTES} bytes.`);
  }
  return payload;
}

export function parseSettingsBeaconSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings beacon payload must be one object.");
  }
  if (settingsBeaconPayloadBytes(value) > SETTINGS_BEACON_MAX_BYTES) {
    throw new Error(`Settings beacon payload exceeds ${SETTINGS_BEACON_MAX_BYTES} bytes.`);
  }
  if (!hasExactKeys(value, SNAPSHOT_KEYS)) throw new Error("Settings beacon payload fields are invalid.");
  if (value.type !== "settings-snapshot" || value.protocol !== SETTINGS_BEACON_PROTOCOL) {
    throw new Error("Settings beacon protocol is not supported.");
  }
  if (!isSettingsBeaconSource(value.sourceId)) throw new Error("Settings beacon source ID is invalid.");
  if (value.schemaVersion !== SETTINGS_VERSION) {
    throw new Error(`Only settings version ${SETTINGS_VERSION} is supported.`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 0xffffffff) {
    throw new Error("Settings beacon revision is invalid.");
  }
  return {
    type: value.type,
    protocol: value.protocol,
    sourceId: value.sourceId,
    revision: value.revision,
    schemaVersion: value.schemaVersion,
    settings: normalizePortableSettings(value.settings),
  };
}

export function createSettingsBeaconRequest(requestId) {
  const normalized = String(requestId ?? "");
  if (!/^[a-f0-9]{16}$/i.test(normalized)) throw new Error("Settings beacon request ID is invalid.");
  return {
    type: "settings-request",
    protocol: SETTINGS_BEACON_PROTOCOL,
    requestId: normalized.toLowerCase(),
  };
}

export function isSettingsBeaconRequest(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && hasExactKeys(value, REQUEST_KEYS)
    && value.type === "settings-request"
    && value.protocol === SETTINGS_BEACON_PROTOCOL
    && /^[a-f0-9]{16}$/i.test(value.requestId),
  );
}

class SettingsBeaconBase extends EventTarget {
  constructor(options = {}) {
    super();
    this.sdkFactory = options.sdkFactory ?? defaultSdkFactory;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
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
    const sdk = this.sdk;
    if (sdk) {
      for (const [type, handler] of this.listeners) sdk.removeEventListener(type, handler);
    }
    this.listeners = [];
    this.sdk = undefined;
    if (!sdk) return;
    try {
      await sdk.disconnect?.();
    } catch {
      // A closing page or already-closed signaling connection is best effort.
    }
  }
}

export class SettingsBeaconBroadcaster extends SettingsBeaconBase {
  constructor(options = {}) {
    super(options);
    this.phase = "idle";
    this.streamId = "";
    this.payload = undefined;
    this.listenersByUuid = new Set();
    this.deliveryCount = 0;
  }

  snapshot() {
    return {
      phase: this.phase,
      streamId: this.streamId,
      sourceLabel: this.streamId ? formatSettingsBeaconSourceLabel(this.streamId) : "",
      listenerCount: this.listenersByUuid.size,
      deliveryCount: this.deliveryCount,
      payloadBytes: this.payload ? settingsBeaconPayloadBytes(this.payload) : 0,
      revision: this.payload?.revision,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  deliver(uuid) {
    if (!this.sdk || !this.payload || !uuid || !["connecting", "broadcasting"].includes(this.phase)) return false;
    const sent = this.sdk.sendData(this.payload, {
      uuid,
      preference: "any",
      allowFallback: false,
    });
    if (sent) {
      this.deliveryCount += 1;
      this.emitState({ message: "The captured settings snapshot was delivered reliably." });
    }
    return Boolean(sent);
  }

  async start(settings) {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.phase = "connecting";
    this.streamId = generateSettingsBeaconSourceId(this.randomBytes);
    this.payload = createSettingsBeaconSnapshot(settings, { sourceId: this.streamId });
    this.emitState({ message: "Connecting to the public settings discovery room…" });
    try {
      this.sdk = this.sdkFactory();
      this.listen("dataChannelOpen", (event) => {
        const uuid = event.detail?.uuid;
        if (!uuid) return;
        this.listenersByUuid.add(uuid);
        this.deliver(uuid);
        this.emitState();
      });
      this.listen("dataReceived", (event) => {
        if (isSettingsBeaconRequest(event.detail?.data)) this.deliver(event.detail?.uuid);
      });
      this.listen("dataChannelClose", (event) => this.removeListener(event.detail?.uuid));
      this.listen("userLeft", (event) => this.removeListener(event.detail?.UUID ?? event.detail?.uuid));
      this.listen("connectionFailed", (event) => {
        this.removeListener(event.detail?.uuid ?? event.detail?.UUID);
        this.emitState({ message: `A settings listener connection failed: ${event.detail?.reason ?? "unknown reason"}` });
      });
      this.listen("error", (event) => this.emitState({
        message: errorMessage(event.detail?.error ?? event.detail),
        error: true,
      }));
      await this.sdk.connect();
      await this.sdk.joinRoom({ room: SETTINGS_BEACON_ROOM, password: false });
      await this.sdk.announce({
        streamID: this.streamId,
        label: formatSettingsBeaconSourceLabel(this.streamId),
        meta: { protocol: SETTINGS_BEACON_PROTOCOL, schemaVersion: SETTINGS_VERSION },
      });
      this.phase = "broadcasting";
      this.emitState({ message: "The captured settings JSON is publicly available while this page stays open." });
      return this.snapshot();
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: errorMessage(error), error: true });
      await this.disconnectSdk();
      throw error;
    }
  }

  removeListener(uuid) {
    if (!uuid || !this.listenersByUuid.delete(uuid)) return;
    this.emitState();
  }

  async stop() {
    const stopping = Boolean(this.sdk);
    this.phase = stopping ? "stopping" : "idle";
    if (stopping) this.emitState({ message: "Stopping settings broadcast…" });
    const disconnecting = this.disconnectSdk();
    this.streamId = "";
    this.payload = undefined;
    this.listenersByUuid.clear();
    this.deliveryCount = 0;
    await disconnecting;
    this.phase = "idle";
    this.emitState();
  }
}

export class SettingsBeaconReceiver extends SettingsBeaconBase {
  constructor(options = {}) {
    super(options);
    this.phase = "idle";
    this.sources = new Map();
    this.selectedStreamId = "";
    this.selectedUuid = "";
    this.received = undefined;
    this.discoveryTimer = undefined;
  }

  snapshot() {
    return {
      phase: this.phase,
      sources: Array.from(this.sources.values()).sort((left, right) => left.label.localeCompare(right.label)),
      selectedStreamId: this.selectedStreamId,
      sourceLabel: this.selectedStreamId ? formatSettingsBeaconSourceLabel(this.selectedStreamId) : "",
      received: this.received ? {
        ...this.received,
        settings: structuredClone(this.received.settings),
      } : undefined,
    };
  }

  emitState(extra = {}) {
    this.dispatchEvent(detailEvent("statechange", { ...this.snapshot(), ...extra }));
  }

  addSource(value) {
    const { streamId, uuid } = sourceItem(value);
    if (!isSettingsBeaconSource(streamId)) return;
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
      label: formatSettingsBeaconSourceLabel(streamId),
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
      const selectedConnection = streamId === this.selectedStreamId && identifier === this.selectedUuid;
      if (streamId !== identifier && source.uuid !== identifier && !selectedConnection) continue;
      this.sources.delete(streamId);
      if (streamId === this.selectedStreamId) {
        if (this.received) {
          this.emitState({ message: "The source left; the already validated snapshot remains available to preview or apply." });
        } else {
          this.phase = "error";
          this.emitState({ message: "The selected settings source left before delivering a snapshot.", error: true });
        }
      }
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
    }, SETTINGS_BEACON_DISCOVERY_SETTLE_MS);
  }

  async startDiscovery() {
    if (this.phase !== "idle" && this.phase !== "error") return this.snapshot();
    await this.stop();
    this.phase = "discovering";
    this.emitState({ message: "Looking for live public settings beacons…" });
    try {
      this.sdk = this.sdkFactory();
      this.listen("listing", (event) => this.addListing(event.detail));
      this.listen("videoaddedtoroom", (event) => this.addSource(event.detail));
      this.listen("userLeft", (event) => this.removeSource(
        event.detail?.UUID ?? event.detail?.uuid ?? event.detail?.streamID ?? event.detail?.streamId,
      ));
      this.listen("dataChannelOpen", (event) => this.requestSnapshot(event.detail));
      this.listen("dataReceived", (event) => this.acceptSnapshot(event.detail));
      this.listen("dataChannelClose", (event) => {
        if (!this.selectedUuid || event.detail?.uuid === this.selectedUuid) {
          this.removeSource(event.detail?.uuid ?? event.detail?.streamID);
        }
      });
      this.listen("connectionFailed", (event) => {
        if (!this.selectedStreamId || event.detail?.streamID === this.selectedStreamId) {
          this.phase = "error";
          this.emitState({ message: `Settings connection failed: ${event.detail?.reason ?? "unknown reason"}`, error: true });
        }
      });
      this.listen("error", (event) => this.emitState({
        message: errorMessage(event.detail?.error ?? event.detail),
        error: true,
      }));
      await this.sdk.connect();
      await this.sdk.joinRoom({ room: SETTINGS_BEACON_ROOM, password: false });
      this.scheduleAutoSelection();
      this.emitState();
      return this.snapshot();
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: errorMessage(error), error: true });
      await this.disconnectSdk();
      throw error;
    }
  }

  async selectSource(streamId) {
    if (!this.sdk || !isSettingsBeaconSource(streamId)) return this.snapshot();
    if (this.selectedStreamId && this.selectedStreamId !== streamId) {
      try {
        await this.sdk.stopViewing?.(this.selectedStreamId);
      } catch {
        // The explicit new selection remains authoritative if the old peer already left.
      }
    }
    const source = this.sources.get(streamId);
    this.selectedStreamId = streamId;
    this.selectedUuid = source?.uuid ?? "";
    this.received = undefined;
    this.phase = "connecting";
    this.emitState({ message: `Requesting settings from ${formatSettingsBeaconSourceLabel(streamId)}…` });
    try {
      await this.sdk.view(streamId, {
        audio: false,
        video: false,
        downloads: false,
        allowresources: false,
        label: "Affect Tracker settings receiver",
      });
    } catch (error) {
      this.phase = "error";
      this.emitState({ message: errorMessage(error), error: true });
    }
    return this.snapshot();
  }

  requestSnapshot(detail) {
    if (!this.sdk || !this.selectedStreamId) return false;
    if (detail?.streamID && detail.streamID !== this.selectedStreamId) return false;
    if (this.selectedUuid && detail?.uuid && detail.uuid !== this.selectedUuid) return false;
    this.selectedUuid = detail?.uuid ?? this.selectedUuid;
    if (!this.selectedUuid) return false;
    const request = createSettingsBeaconRequest(randomHex(8, this.randomBytes));
    const sent = this.sdk.sendData(request, {
      uuid: this.selectedUuid,
      preference: "any",
      allowFallback: false,
    });
    this.emitState({ message: sent ? "Reliable settings channel open; waiting for the snapshot…" : "Waiting for the settings data channel…" });
    return Boolean(sent);
  }

  acceptSnapshot(detail) {
    if (!this.selectedStreamId || !detail) return false;
    if (this.selectedUuid && detail.uuid && detail.uuid !== this.selectedUuid) return false;
    if (detail.streamID && detail.streamID !== this.selectedStreamId) return false;
    try {
      const payload = parseSettingsBeaconSnapshot(detail.data);
      if (payload.sourceId !== this.selectedStreamId) throw new Error("Settings snapshot source does not match the selected beacon.");
      this.selectedUuid = detail.uuid ?? this.selectedUuid;
      this.received = {
        revision: payload.revision,
        schemaVersion: payload.schemaVersion,
        payloadBytes: settingsBeaconPayloadBytes(payload),
        settings: payload.settings,
      };
      this.phase = "received";
      const snapshot = this.snapshot();
      this.dispatchEvent(detailEvent("snapshot", snapshot));
      this.emitState({ message: "Settings received and validated. Review them before applying." });
      return true;
    } catch (error) {
      this.emitState({ message: `Rejected settings snapshot: ${errorMessage(error)}`, error: true });
      return false;
    }
  }

  async stop() {
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
    this.received = undefined;
    this.discoveryTimer = undefined;
    this.emitState();
  }
}

export function createSettingsBeaconBroadcaster(options) {
  return new SettingsBeaconBroadcaster(options);
}

export function createSettingsBeaconReceiver(options) {
  return new SettingsBeaconReceiver(options);
}
