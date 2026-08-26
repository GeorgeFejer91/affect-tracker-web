import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SETTINGS_BEACON_DISCOVERY_SETTLE_MS,
  SETTINGS_BEACON_MAX_BYTES,
  SETTINGS_BEACON_PROTOCOL,
  SETTINGS_BEACON_ROOM,
  SettingsBeaconBroadcaster,
  SettingsBeaconReceiver,
  createSettingsBeaconRequest,
  createSettingsBeaconSnapshot,
  formatSettingsBeaconSourceLabel,
  isSettingsBeaconRequest,
  parseSettingsBeaconSnapshot,
  settingsBeaconSdkOptions,
} from "../site/src/settings-beacon.js";
import { cloneDefaultSettings, normalizePortableSettings } from "../site/src/portable-settings.js";

function eventWith(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      let next;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.timer.at) next = { id, timer };
      }
      if (!next) break;
      this.time = next.timer.at;
      this.timers.delete(next.id);
      next.timer.callback();
    }
    this.time = target;
  }

  options() {
    return {
      setTimeoutFn: this.setTimeout,
      clearTimeoutFn: this.clearTimeout,
    };
  }
}

class MockSdk extends EventTarget {
  constructor() {
    super();
    this.calls = [];
    this.sent = [];
    this.sendResult = true;
  }

  emit(type, detail) {
    this.dispatchEvent(eventWith(type, detail));
  }

  async connect() {
    this.calls.push(["connect"]);
  }

  async joinRoom(options) {
    this.calls.push(["joinRoom", options]);
  }

  async announce(options) {
    this.calls.push(["announce", options]);
  }

  async view(streamId, options) {
    this.calls.push(["view", streamId, options]);
  }

  async stopViewing(streamId) {
    this.calls.push(["stopViewing", streamId]);
  }

  sendData(data, target) {
    this.sent.push({ data: structuredClone(data), target: structuredClone(target) });
    return this.sendResult;
  }

  async disconnect() {
    this.calls.push(["disconnect"]);
  }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("settings beacon snapshot is the complete normalized portable JSON, never Flubber X/Y", () => {
  const settings = cloneDefaultSettings();
  settings.inputMode = "step";
  settings.stepSize = 0.25;
  settings.response = 12;
  settings.visual = { animationSpeed: 1.8, amplitudeScale: 0.7, disorderScale: 1.4, baseShape: "heart" };
  settings.palette = { up: "#112233", down: "#445566", left: "#778899", right: "#aabbcc" };
  settings.overlay = { x: 53, y: -22, size: 410, opacity: 0.42, visible: false };
  settings.advancedBindings.increaseSize = "mouse:Button4";

  const payload = createSettingsBeaconSnapshot(settings, { sourceId: "aft_settings_1234abcd" });
  const parsed = parseSettingsBeaconSnapshot(payload);
  assert.deepEqual(parsed.settings, normalizePortableSettings(settings));
  assert.equal(parsed.protocol, SETTINGS_BEACON_PROTOCOL);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal("currentX" in payload, false);
  assert.equal("currentY" in payload, false);
  assert.equal(JSON.stringify(payload).includes("flubberxyv1"), false);
});

test("settings snapshot validation is exact, bounded, versioned, and schema-valid", () => {
  const payload = createSettingsBeaconSnapshot(cloneDefaultSettings(), { sourceId: "aft_settings_1234abcd" });
  assert.throws(() => parseSettingsBeaconSnapshot({ ...payload, surprise: true }), /fields/);
  assert.throws(() => parseSettingsBeaconSnapshot({ ...payload, protocol: "other" }), /protocol/);
  assert.throws(() => parseSettingsBeaconSnapshot({ ...payload, sourceId: "aft_flubber_1234abcd" }), /source ID/);
  assert.throws(() => parseSettingsBeaconSnapshot({ ...payload, schemaVersion: 2 }), /version 1/);
  assert.throws(
    () => parseSettingsBeaconSnapshot({ ...payload, settings: { ...payload.settings, response: Number.NaN } }),
    /Smoothing response/,
  );
  assert.throws(
    () => parseSettingsBeaconSnapshot({ ...payload, settings: "x".repeat(SETTINGS_BEACON_MAX_BYTES) }),
    /exceeds/,
  );
});

test("settings requests have one strict protocol envelope", () => {
  const request = createSettingsBeaconRequest("0123456789abcdef");
  assert.equal(isSettingsBeaconRequest(request), true);
  assert.equal(isSettingsBeaconRequest({ ...request, extra: true }), false);
  assert.equal(isSettingsBeaconRequest({ ...request, requestId: "short" }), false);
  assert.throws(() => createSettingsBeaconRequest("not-valid"), /request ID/);
});

test("broadcaster is inert until start and advertises one immutable reliable snapshot", async () => {
  const sdk = new MockSdk();
  const settings = cloneDefaultSettings();
  const broadcaster = new SettingsBeaconBroadcaster({
    sdkFactory: () => sdk,
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => [0xab, 0xcd, 0x12, 0x34][index] ?? 0),
  });
  assert.equal(sdk.calls.length, 0);

  await broadcaster.start(settings);
  assert.deepEqual(settingsBeaconSdkOptions(), { password: false, salt: "affect-tracker-web-v1" });
  assert.deepEqual(sdk.calls.slice(0, 3), [
    ["connect"],
    ["joinRoom", { room: SETTINGS_BEACON_ROOM, password: false }],
    ["announce", {
      streamID: "aft_settings_abcd1234",
      label: "Settings Source ABCD 1234",
      meta: { protocol: SETTINGS_BEACON_PROTOCOL, schemaVersion: 1 },
    }],
  ]);
  assert.equal(broadcaster.snapshot().sourceLabel, "Settings Source ABCD 1234");

  sdk.emit("dataChannelOpen", { uuid: "listener-1", type: "publisher" });
  assert.equal(sdk.sent.length, 1);
  assert.deepEqual(sdk.sent[0].target, {
    uuid: "listener-1",
    preference: "any",
    allowFallback: false,
  });
  const firstPayload = sdk.sent[0].data;
  settings.visual.baseShape = "square";
  sdk.emit("dataReceived", {
    uuid: "listener-1",
    data: createSettingsBeaconRequest("fedcba9876543210"),
  });
  assert.equal(sdk.sent.length, 2);
  assert.deepEqual(sdk.sent[1].data, firstPayload, "a running beacon must retain its start-time snapshot");
  assert.equal(sdk.sent[1].data.settings.visual.baseShape, "circle");
  assert.equal(broadcaster.snapshot().listenerCount, 1);
  assert.equal(broadcaster.snapshot().deliveryCount, 2);

  await broadcaster.stop();
  assert.equal(broadcaster.snapshot().phase, "idle");
  assert.equal(sdk.calls.at(-1)[0], "disconnect");
});

test("one discovered source auto-selects and a matching validated snapshot becomes previewable", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new SettingsBeaconReceiver({
    ...clock.options(),
    sdkFactory: () => sdk,
    randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
  });
  assert.equal(sdk.calls.length, 0);
  await receiver.startDiscovery();
  sdk.emit("listing", { streamID: "aft_settings_00112233", UUID: "publisher-1" });
  clock.advance(SETTINGS_BEACON_DISCOVERY_SETTLE_MS);
  await settle();
  assert.equal(receiver.snapshot().phase, "connecting");
  assert.equal(receiver.snapshot().selectedStreamId, "aft_settings_00112233");
  assert.deepEqual(sdk.calls.find((call) => call[0] === "view"), [
    "view",
    "aft_settings_00112233",
    {
      audio: false,
      video: false,
      downloads: false,
      allowresources: false,
      label: "Affect Tracker settings receiver",
    },
  ]);

  sdk.emit("dataChannelOpen", {
    uuid: "publisher-1",
    type: "viewer",
    streamID: "aft_settings_00112233",
  });
  assert.equal(sdk.sent.length, 1);
  assert.equal(isSettingsBeaconRequest(sdk.sent[0].data), true);
  assert.equal(sdk.sent[0].target.allowFallback, false);

  const payload = createSettingsBeaconSnapshot(cloneDefaultSettings(), {
    sourceId: "aft_settings_00112233",
  });
  assert.equal(receiver.acceptSnapshot({
    uuid: "publisher-1",
    streamID: "aft_settings_00112233",
    data: payload,
  }), true);
  assert.equal(receiver.snapshot().phase, "received");
  assert.deepEqual(receiver.snapshot().received.settings, cloneDefaultSettings());

  await receiver.stop();
  assert.equal(receiver.snapshot().phase, "idle");
  assert.equal(sdk.calls.at(-1)[0], "disconnect");
});

test("multiple sources require selection and snapshots cannot spoof the selected source", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new SettingsBeaconReceiver({ ...clock.options(), sdkFactory: () => sdk });
  await receiver.startDiscovery();
  sdk.emit("listing", { list: [
    { streamID: "aft_settings_11112222", UUID: "one" },
    { streamID: "aft_settings_33334444", UUID: "two" },
    { streamID: "aft_flubber_55556666", UUID: "coordinates" },
  ] });
  clock.advance(SETTINGS_BEACON_DISCOVERY_SETTLE_MS);
  assert.equal(receiver.snapshot().phase, "selecting");
  assert.equal(receiver.snapshot().sources.length, 2);

  await receiver.selectSource("aft_settings_33334444");
  const spoofed = createSettingsBeaconSnapshot(cloneDefaultSettings(), {
    sourceId: "aft_settings_11112222",
  });
  assert.equal(receiver.acceptSnapshot({ uuid: "two", data: spoofed }), false);
  assert.equal(receiver.snapshot().received, undefined);

  const selected = createSettingsBeaconSnapshot(cloneDefaultSettings(), {
    sourceId: "aft_settings_33334444",
  });
  assert.equal(receiver.acceptSnapshot({ uuid: "two", data: selected }), true);
  assert.equal(formatSettingsBeaconSourceLabel(receiver.snapshot().selectedStreamId), "Settings Source 3333 4444");
  receiver.removeSource("two");
  assert.equal(receiver.snapshot().phase, "received");
  assert.deepEqual(receiver.snapshot().received.settings, cloneDefaultSettings(), "a validated static preview survives source departure");
  await receiver.stop();
});

test("static page exposes explicit settings-only controls with preview-before-apply and no automatic start", async () => {
  const [page, app, module] = await Promise.all([
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../site/src/settings-beacon.js", import.meta.url), "utf8"),
  ]);
  assert.match(page, />Broadcast settings JSON</);
  assert.match(page, />Find settings beacons</);
  assert.match(page, />Apply received settings</);
  assert.match(page, /id="settings-beacon-preview"[^>]*hidden/);
  assert.match(page, /every field produced by Export settings JSON/);
  assert.match(page, /reliable, ordered, and sends no continuous signal or X\/Y coordinates/);
  assert.match(app, /settingsBeaconBroadcaster\.start\(settingsFromState\(\)\)/);
  assert.match(app, /applyPortableSettings\(received\.settings, true\)/);
  assert.doesNotMatch(module, /currentX|currentY|flubberxyv1|openChannel\(/);
  assert.doesNotMatch(module, /allowFallback:\s*true/);
  assert.equal((app.match(/settingsBeaconBroadcaster\.start\(/g) ?? []).length, 1);
  assert.equal((app.match(/settingsBeaconReceiver\.startDiscovery\(/g) ?? []).length, 1);
  assert.match(page, /src="\.\/vendor\/vdoninja\/1\.5\.5\/vdoninja-sdk\.min\.js"/);
  assert.match(page, /src="\.\/src\/app\.js\?v=settings-beacon-1"/);
  assert.doesNotMatch(page, /https?:\/\/[^"']*vdoninja[^"']*\.js/i);
});
