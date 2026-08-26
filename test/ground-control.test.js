import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GROUND_CONTROL_MAX_BYTES,
  GROUND_CONTROL_SETTINGS_CHANNEL,
  GROUND_CONTROL_SETTINGS_ROOM,
  SettingsSnapshotBroadcaster,
  SettingsSnapshotReceiver,
  decodeSettingsSnapshot,
  encodeSettingsSnapshot,
  generateSettingsSourceId,
  groundControlFilename,
  normalizeGroundControlName,
  shouldDismissGroundRadar,
  sourceNameFromLabel,
} from "../site/src/ground-control.js";
import { cloneDefaultSettings } from "../site/src/portable-settings.js";

function eventWith(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

class MockChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.sent = [];
  }

  send(value) { this.sent.push(value); }
  close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  message(value) { this.dispatchEvent(eventWith("message", undefined)); this.dispatchEvent(Object.assign(new Event("message"), { data: value })); }
}

class MockSdk extends EventTarget {
  constructor() {
    super();
    this.calls = [];
    this.channels = new Map();
  }

  emit(type, detail) { this.dispatchEvent(eventWith(type, detail)); }
  async connect() { this.calls.push(["connect"]); }
  async joinRoom(options) { this.calls.push(["joinRoom", options]); }
  async announce(options) { this.calls.push(["announce", options]); }
  async view(streamId, options) { this.calls.push(["view", streamId, options]); }
  async stopViewing(streamId) { this.calls.push(["stopViewing", streamId]); }
  async openChannel(uuid, label, options) {
    this.calls.push(["openChannel", uuid, label, options]);
    const channel = new MockChannel();
    this.channels.set(uuid, channel);
    return channel;
  }
  async disconnect() { this.calls.push(["disconnect"]); }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Ground Control names are public-display safe and determine the JSON filename", () => {
  assert.equal(normalizeGroundControlName("  Aurora\nLab  "), "Aurora Lab");
  assert.equal(groundControlFilename("Aurora Lab / Session 4"), "aurora-lab-session-4.json");
  assert.throws(() => normalizeGroundControlName("\n\t"), /Enter a name/);
  assert.throws(() => normalizeGroundControlName("x".repeat(65)), /64 characters/);
});

test("every Ground Control radar closes only after its selected connection succeeds", () => {
  assert.equal(shouldDismissGroundRadar({ mode: "live", phase: "connecting" }), false);
  assert.equal(shouldDismissGroundRadar({ mode: "live", phase: "live" }), true);
  assert.equal(shouldDismissGroundRadar({ mode: "json", phase: "ready" }), true);
  assert.equal(shouldDismissGroundRadar({ mode: "universe", phase: "awaiting-reciprocal" }), false);
  assert.equal(shouldDismissGroundRadar({ mode: "universe", phase: "live" }), true);
  assert.equal(shouldDismissGroundRadar({ mode: "party", phase: "connecting" }), false);
  assert.equal(shouldDismissGroundRadar({ mode: "party", phase: "live" }), true);
  assert.equal(shouldDismissGroundRadar({ mode: "json", phase: "live" }), false);
});

test("settings discovery IDs expose the public name while retaining a random suffix", () => {
  const streamId = generateSettingsSourceId(() => new Uint8Array([1, 2, 3, 4, 5, 6]), "Mission Aurora");
  assert.equal(streamId, "aft_settings_Mission_Aurora_010203040506");
  assert.equal(sourceNameFromLabel("", streamId), "Mission Aurora");
});

test("settings snapshots are bounded, versioned, and validated through the portable schema", () => {
  const settings = cloneDefaultSettings();
  settings.visual.baseShape = "heart";
  const payload = encodeSettingsSnapshot({
    name: "Mission Aurora",
    settings,
    createdAt: "2026-08-26T10:00:00.000Z",
  });
  assert.ok(new TextEncoder().encode(payload).byteLength < GROUND_CONTROL_MAX_BYTES);
  const decoded = decodeSettingsSnapshot(payload);
  assert.equal(decoded.name, "Mission Aurora");
  assert.equal(decoded.settings.visual.baseShape, "heart");
  assert.equal(decodeSettingsSnapshot(JSON.stringify({ version: 1, settings })), undefined);
  assert.equal(decodeSettingsSnapshot(new Uint8Array(GROUND_CONTROL_MAX_BYTES + 1)), undefined);

  const invalid = JSON.parse(payload);
  invalid.settings.overlay.opacity = 2;
  assert.equal(decodeSettingsSnapshot(JSON.stringify(invalid)), undefined);
});

test("the JSON beacon is explicit, reliable, immutable, and sends one validated snapshot", async () => {
  const sdk = new MockSdk();
  const settings = cloneDefaultSettings();
  const broadcaster = new SettingsSnapshotBroadcaster({
    sdkFactory: () => sdk,
    randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6]),
  });
  assert.equal(sdk.calls.length, 0);
  await broadcaster.start({ name: "Mission Aurora", settings });
  settings.visual.baseShape = "square";
  assert.deepEqual(sdk.calls.slice(0, 3), [
    ["connect"],
    ["joinRoom", { room: GROUND_CONTROL_SETTINGS_ROOM, password: false }],
    ["announce", { streamID: "aft_settings_Mission_Aurora_010203040506", label: "Mission Aurora · JSON settings" }],
  ]);

  sdk.emit("dataChannelOpen", { uuid: "listener-1" });
  await settle();
  const channel = sdk.channels.get("listener-1");
  assert.deepEqual(sdk.calls.find((call) => call[0] === "openChannel"), [
    "openChannel", "listener-1", GROUND_CONTROL_SETTINGS_CHANNEL, { ordered: true },
  ]);
  assert.equal(channel.sent.length, 1);
  assert.equal(decodeSettingsSnapshot(channel.sent[0]).settings.visual.baseShape, "circle");
  assert.equal(broadcaster.snapshot().listenerCount, 1);
  await broadcaster.stop();
  assert.equal(channel.readyState, "closed");
});

test("the JSON radar discovers named sources and waits for explicit selection before receipt", async () => {
  const sdk = new MockSdk();
  const receiver = new SettingsSnapshotReceiver({ sdkFactory: () => sdk });
  assert.equal(sdk.calls.length, 0);
  await receiver.startDiscovery();
  sdk.emit("listing", { list: [
    { streamID: "aft_settings_a1", UUID: "peer-a", label: "Aurora · JSON settings" },
    { streamID: "unrelated", UUID: "peer-x", label: "Ignore me" },
  ] });
  assert.deepEqual(receiver.snapshot().sources.map(({ name }) => name), ["Aurora"]);
  assert.equal(sdk.calls.some((call) => call[0] === "view"), false);

  await receiver.selectSource("aft_settings_a1");
  assert.equal(sdk.calls.find((call) => call[0] === "view")[1], "aft_settings_a1");
  const channel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${GROUND_CONTROL_SETTINGS_CHANNEL}`,
    streamID: "aft_settings_a1",
    uuid: "peer-a",
    channel,
  });
  let received;
  receiver.addEventListener("snapshot", (event) => { received = event.detail.received; });
  const payload = encodeSettingsSnapshot({
    name: "Aurora",
    settings: cloneDefaultSettings(),
    createdAt: "2026-08-26T10:00:00.000Z",
  });
  channel.dispatchEvent(Object.assign(new Event("message"), { data: payload }));
  assert.equal(received.name, "Aurora");
  assert.equal(receiver.snapshot().phase, "ready");
  await receiver.stop();
});

test("Ground Control exposes the requested hierarchy, animated SVG states, and public privacy boundary", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../site/styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../site/src/app.js", import.meta.url), "utf8");
  assert.match(html, /id="ground-control-panel"[^>]*data-module-protocol="ground"/);
  assert.match(html, /Enter name[\s\S]*>Download JSON<[\s\S]*>Load JSON<[\s\S]*>Broadcast JSON<[\s\S]*>Scan JSON<[\s\S]*>Broadcast Live FLUBBER<[\s\S]*>Scan Live FLUBBER<[\s\S]*>Synch with Universe<[\s\S]*>Invite a FLUBBER</);
  assert.match(html, /id="ground-control-panel"[\s\S]*id="ground-json-received"[\s\S]*id="ground-json-apply-button"[\s\S]*id="ground-party-stop-button"/);
  assert.match(html, /id="ground-radar-dialog"[\s\S]*id="ground-radar-sources"/);
  assert.match(html, /Up to eight selected public guests/);
  assert.match(html, /Snapshot vs stream:[\s\S]*public VDO\.Ninja discovery room[\s\S]*STUN\/TURN/);
  assert.match(css, /@keyframes signal-wave/);
  assert.match(css, /@keyframes radar-sweep/);
  assert.match(css, /@keyframes universe-orbit/);
  assert.match(css, /@keyframes party-pulse/);
  assert.match(css, /\.party-birth-vector-surface[\s\S]*party-cellular-gradient/);
  assert.match(css, /\.party-birth-vector-outline/);
  assert.match(css, /\.party-guest-flubber[\s\S]*pointer-events: auto/);
  assert.match(css, /\.party-guest-flubber\.is-dragging/);
  assert.match(css, /prefers-reduced-motion[\s\S]*animation: none !important/);
  assert.match(app, /settingsSnapshotBroadcaster\.start\(\{ name, settings: settingsFromState\(\) \}\)/);
  assert.match(app, /pendingSettingsSnapshot[\s\S]*groundJsonApplyButton\.addEventListener/);
  assert.match(app, /function dismissGroundRadarAfterSuccess\(message\)[\s\S]*groundRadarDialog\.close\(\)[\s\S]*Radar closed/);
  assert.match(app, /showReceivedSettings\(detail\)[\s\S]*shouldDismissGroundRadar\(\{ mode: groundRadarMode, phase: "ready" \}\)/);
  assert.match(app, /pendingGuest[\s\S]*shouldDismissGroundRadar\(\{ mode: "party", phase: pendingGuest\.phase \}\)[\s\S]*startPartyBirthAnimation\(pendingGuest, detail\)[\s\S]*dismissGroundRadarAfterSuccess/);
  assert.match(app, /function renderPartyBirthVector\(mainRendered\)[\s\S]*partyBudVectorGeometry[\s\S]*geometry\.surfacePath/);
  assert.match(app, /function beginPartyGuestDrag\(event, view\)[\s\S]*setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /function movePartyGuestDrag\(event, view\)[\s\S]*movePartyGuest\(view,/);
  assert.match(app, /function movePartyGuestWithKeyboard\(event, view\)[\s\S]*ArrowLeft[\s\S]*ArrowDown/);
  assert.match(app, /Drag independently or use arrow keys to move this Flubber on screen/);
  assert.match(app, /incomingOwnsAxes[\s\S]*state\.targetX = incoming\.latest\.currentX;[\s\S]*state\.currentY = incoming\.latest\.currentY;/);
  assert.match(app, /oneWayGroundRole[\s\S]*Stop sending before receiving from this browser/);
  assert.match(app, /combineUniverseCoordinates\(universeLocalCurrent, universe\.latest\)/);
  assert.match(app, /renderPartyFlubbers\(\)/);
  assert.doesNotMatch(app, /startGroundRadar\("(?:json|live)"\);\s*\/\/.*page load/);
});
