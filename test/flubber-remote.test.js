import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  FLUBBER_REMOTE_CHANNEL,
  FLUBBER_REMOTE_POSITION_CHANNEL,
  FLUBBER_REMOTE_POSITION_WIRE_BYTES,
  FLUBBER_REMOTE_HEARTBEAT_MS,
  FLUBBER_REMOTE_RECOVERY_FRAMES,
  FLUBBER_REMOTE_ROOM,
  FLUBBER_REMOTE_STALE_MS,
  FLUBBER_REMOTE_WIRE_BYTES,
  FlubberBroadcaster,
  FlubberReceiver,
  decodeFlubberFrame,
  decodeFlubberPositionFrame,
  denormalizeFlubberViewportPosition,
  encodeFlubberFrame,
  encodeFlubberPositionFrame,
  formatFlubberSourceLabel,
  flubberRemoteForceTurnEnabled,
  flubberRemoteSdkOptions,
  generateFlubberSourceId,
  isNewerFlubberSequence,
  normalizeFlubberViewportPosition,
  relativeFlubberViewportPosition,
} from "../site/src/flubber-remote.js";

function eventWith(type, properties = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => this.add(callback, delay, 0);

  clearTimeout = (id) => this.timers.delete(id);

  setInterval = (callback, delay) => this.add(callback, delay, delay);

  clearInterval = (id) => this.timers.delete(id);

  add(callback, delay, interval) {
    const id = this.nextId++;
    this.timers.set(id, { callback, at: this.time + delay, interval });
    return id;
  }

  advance(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      let selected;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!selected || timer.at < selected.timer.at || timer.at === selected.timer.at && id < selected.id) {
          selected = { id, timer };
        }
      }
      if (!selected) break;
      this.time = selected.timer.at;
      if (selected.timer.interval) selected.timer.at += selected.timer.interval;
      else this.timers.delete(selected.id);
      selected.timer.callback();
    }
    this.time = target;
  }

  options(sdkFactory) {
    return {
      sdkFactory,
      now: this.now,
      setTimeoutFn: this.setTimeout,
      clearTimeoutFn: this.clearTimeout,
      setIntervalFn: this.setInterval,
      clearIntervalFn: this.clearInterval,
    };
  }
}

class MockChannel extends EventTarget {
  constructor() {
    super();
    this.readyState = "open";
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value.slice(0));
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }

  message(value) {
    this.dispatchEvent(eventWith("message", { data: value }));
  }
}

class MockSdk extends EventTarget {
  constructor() {
    super();
    this.calls = [];
    this.channels = new Map();
  }

  emit(type, detail) {
    this.dispatchEvent(eventWith(type, { detail }));
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

  async openChannel(uuid, label, options) {
    this.calls.push(["openChannel", uuid, label, options]);
    const channel = new MockChannel();
    if (!this.channels.has(uuid)) this.channels.set(uuid, channel);
    this.channels.set(`${uuid}:${label}`, channel);
    return channel;
  }

  async getPeerQuality() {
    return { relayed: false, rttMs: 18.6 };
  }

  async disconnect() {
    this.calls.push(["disconnect"]);
  }
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("Flubber wire frames are exactly 12-byte little-endian finite clamped coordinates", () => {
  const frame = encodeFlubberFrame(0x78563412, 3, -4);
  assert.equal(frame.byteLength, FLUBBER_REMOTE_WIRE_BYTES);
  assert.deepEqual(Array.from(new Uint8Array(frame).slice(0, 4)), [0x12, 0x34, 0x56, 0x78]);
  assert.deepEqual(decodeFlubberFrame(frame), {
    sequence: 0x78563412,
    currentX: 1,
    currentY: -1,
  });
  assert.equal(decodeFlubberFrame(new ArrayBuffer(11)), undefined);
  assert.throws(() => encodeFlubberFrame(1, Number.NaN, 0), /finite/);

  const invalid = new ArrayBuffer(12);
  const view = new DataView(invalid);
  view.setUint32(0, 1, true);
  view.setFloat32(4, Number.POSITIVE_INFINITY, true);
  view.setFloat32(8, 0, true);
  assert.equal(decodeFlubberFrame(invalid), undefined);
});

test("normalized viewport frames stay compact and map relative movement across different screens", () => {
  const frame = encodeFlubberPositionFrame(7, 1.4, -0.2);
  assert.equal(frame.byteLength, FLUBBER_REMOTE_POSITION_WIRE_BYTES);
  assert.deepEqual(decodeFlubberPositionFrame(frame), {
    sequence: 7,
    viewportX: 1,
    viewportY: 0,
  });
  assert.equal(decodeFlubberFrame(frame), undefined, "older receivers ignore the typed placement packet");
  assert.equal(decodeFlubberPositionFrame(new ArrayBuffer(8)), undefined);
  assert.throws(() => encodeFlubberPositionFrame(1, Number.NaN, 0.5), /finite/);

  const phone = normalizeFlubberViewportPosition({
    x: 210,
    y: 422,
    size: 120,
    viewportWidth: 420,
    viewportHeight: 844,
  });
  assert.deepEqual(phone, { viewportX: 0.5, viewportY: 0.5 });
  const moved = relativeFlubberViewportPosition({
    sender: { viewportX: 0.75, viewportY: 0.25 },
    senderAnchor: phone,
    localAnchor: { viewportX: 0.2, viewportY: 0.8 },
  });
  assert.ok(Math.abs(moved.viewportX - 0.45) < 1e-12);
  assert.ok(Math.abs(moved.viewportY - 0.55) < 1e-12);
  const desktop = denormalizeFlubberViewportPosition({
    ...moved,
    size: 200,
    viewportWidth: 1200,
    viewportHeight: 800,
  });
  assert.ok(Math.abs(desktop.x - 550) < 1e-9);
  assert.ok(Math.abs(desktop.y - 430) < 1e-9);
});

test("Flubber sequence ordering rejects duplicates and older values across uint32 wraparound", () => {
  assert.equal(isNewerFlubberSequence(2, undefined), true);
  assert.equal(isNewerFlubberSequence(2, 2), false);
  assert.equal(isNewerFlubberSequence(1, 2), false);
  assert.equal(isNewerFlubberSequence(0, 0xffffffff), true);
  assert.equal(isNewerFlubberSequence(0xffffffff, 0), false);
  assert.equal(isNewerFlubberSequence(0x80000000, 0), false);
});

test("forced TURN qualification is explicit, page-load-only, and passed to the official SDK", () => {
  assert.equal(flubberRemoteForceTurnEnabled({ href: "https://example.test/?remote-force-turn=1" }), true);
  assert.equal(flubberRemoteForceTurnEnabled({ href: "https://example.test/?remote-force-turn=0" }), false);
  assert.equal(flubberRemoteForceTurnEnabled({ href: "not a url" }), false);
  assert.deepEqual(flubberRemoteSdkOptions({ forceTurn: true }), {
    password: false,
    salt: "affect-tracker-web-v1",
    forceTURN: true,
  });
  assert.equal(new FlubberBroadcaster({ forceTurn: true, sdkFactory: () => new MockSdk() }).snapshot().forceTurnRequested, true);
  assert.equal(new FlubberReceiver({ forceTurn: true, sdkFactory: () => new MockSdk() }).snapshot().forceTurnRequested, true);
});

test("broadcaster is explicit, data-only, partial-reliability fan-out with immediate first state", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({
    ...clock.options(() => sdk),
    randomBytes: () => Uint8Array.from([0xab, 0xcd, 0x12, 0x34]),
  });
  assert.equal(sdk.calls.length, 0, "construction must not make a network connection");

  await broadcaster.start();
  assert.equal(broadcaster.snapshot().sourceLabel, "Source ABCD 1234");
  assert.deepEqual(sdk.calls.slice(0, 3), [
    ["connect"],
    ["joinRoom", { room: FLUBBER_REMOTE_ROOM, password: false }],
    ["announce", { streamID: "aft_flubber_abcd1234", label: "Source ABCD 1234" }],
  ]);

  broadcaster.offer(0.25, -0.5);
  broadcaster.offerViewportPosition(0.4, 0.7);
  sdk.emit("dataChannelOpen", { uuid: "listener-1" });
  await settle();
  const channel = sdk.channels.get("listener-1");
  assert.deepEqual(sdk.calls.find((call) => call[0] === "openChannel"), [
    "openChannel",
    "listener-1",
    FLUBBER_REMOTE_CHANNEL,
    { ordered: false, maxRetransmits: 0 },
  ]);
  assert.equal(channel.sent.length, 2, "a listener receives the latest affect and placement immediately");
  assert.deepEqual(decodeFlubberFrame(channel.sent[0]), {
    sequence: 1,
    currentX: 0.25,
    currentY: -0.5,
  });
  assert.equal(broadcaster.snapshot().listenerCount, 1);
  assert.equal(sdk.calls.filter((call) => call[0] === "openChannel").length, 1,
    "affect and placement share the one proven custom channel");
  assert.deepEqual(decodeFlubberPositionFrame(channel.sent[1]), {
    sequence: 1,
    viewportX: decodeFlubberPositionFrame(channel.sent[1]).viewportX,
    viewportY: decodeFlubberPositionFrame(channel.sent[1]).viewportY,
  });
  assert.ok(Math.abs(decodeFlubberPositionFrame(channel.sent[1]).viewportX - 0.4) < 1e-6);
  assert.ok(Math.abs(decodeFlubberPositionFrame(channel.sent[1]).viewportY - 0.7) < 1e-6);

  sdk.emit("dataChannelOpen", { uuid: "listener-2" });
  await settle();
  assert.equal(sdk.channels.get("listener-2").sent.length, 2);
  assert.equal(broadcaster.snapshot().listenerCount, 2);

  await broadcaster.stop();
  assert.equal(broadcaster.snapshot().phase, "idle");
  assert.equal(sdk.calls.at(-1)[0], "disconnect");
});

test("the proven live channel carries bounded reciprocal party-scene messages", async () => {
  const broadcasterClock = new FakeClock();
  const broadcasterSdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({
    ...broadcasterClock.options(() => broadcasterSdk),
    randomBytes: () => new Uint8Array(4),
  });
  let incoming;
  broadcaster.addEventListener("message", (event) => { incoming = event.detail; });
  await broadcaster.start();
  broadcasterSdk.emit("dataChannelOpen", { uuid: "party-host" });
  await settle();
  broadcasterSdk.channels.get("party-host").message("party-scene-json");
  assert.deepEqual(incoming, { uuid: "party-host", data: "party-scene-json" });

  const receiverClock = new FakeClock();
  const receiverSdk = new MockSdk();
  const receiver = new FlubberReceiver({ ...receiverClock.options(() => receiverSdk), autoSelect: false });
  await receiver.startDiscovery();
  receiverSdk.emit("listing", { streamID: "aft_flubber_guest_12345678", UUID: "guest", label: "Guest · Live FLUBBER" });
  await receiver.selectSource("aft_flubber_guest_12345678");
  const channel = new MockChannel();
  receiverSdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_guest_12345678",
    uuid: "guest",
    channel,
  });
  assert.equal(receiver.sendData("shared-party-scene"), true);
  assert.deepEqual(channel.sent, ["shared-party-scene"]);
  channel.bufferedAmount = 1;
  assert.equal(receiver.sendData("newer-scene"), false, "party scene fan-out keeps only the latest state under pressure");
});

test("one state offer keeps affect and placement adjacent when the shared channel buffer rises", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");
  channel.send = function sendAndRaiseBuffer(value) {
    this.sent.push(value.slice(0));
    this.bufferedAmount += value.byteLength;
  };

  assert.equal(broadcaster.offerState(-0.25, 0.5, 0.3, 0.8), true);
  assert.equal(channel.sent.length, 2, "the placement packet follows its affect packet in the same state batch");
  assert.ok(decodeFlubberFrame(channel.sent[0]));
  assert.ok(decodeFlubberPositionFrame(channel.sent[1]));
  assert.equal(sdk.calls.filter((call) => call[0] === "openChannel").length, 1);

  await broadcaster.stop();
});

test("protocol options isolate a named room, source prefix, channel, label, and manual receiver selection", async () => {
  const room = "test_universe_room";
  const streamPrefix = "test_universe_";
  const channelName = "testuniversev1";
  const labelSuffix = "Universe FLUBBER";
  const broadcasterClock = new FakeClock();
  const broadcasterSdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({
    ...broadcasterClock.options(() => broadcasterSdk),
    randomBytes: () => new Uint8Array([1, 2, 3, 4]),
    room,
    streamPrefix,
    channelName,
    labelSuffix,
  });
  await broadcaster.start({ sourceName: "Aurora" });
  assert.deepEqual(broadcasterSdk.calls.slice(0, 3), [
    ["connect"],
    ["joinRoom", { room, password: false }],
    ["announce", { streamID: "test_universe_Aurora_01020304", label: "Aurora · Universe FLUBBER" }],
  ]);
  broadcasterSdk.emit("dataChannelOpen", { uuid: "peer-u" });
  await settle();
  assert.deepEqual(broadcasterSdk.calls.find((call) => call[0] === "openChannel"), [
    "openChannel", "peer-u", channelName, { ordered: false, maxRetransmits: 0 },
  ]);
  assert.equal(broadcasterSdk.calls.filter((call) => call[0] === "openChannel").length, 1,
    "custom Universe protocols do not inherit ordinary viewport placement");
  await broadcaster.stop();

  const receiverClock = new FakeClock();
  const receiverSdk = new MockSdk();
  const receiver = new FlubberReceiver({
    ...receiverClock.options(() => receiverSdk),
    room,
    streamPrefix,
    channelName,
    labelSuffix,
    receiverLabel: "Universe receiver",
    autoSelect: false,
    excludeSource: (streamId) => streamId.includes("self"),
  });
  await receiver.startDiscovery();
  receiverSdk.emit("listing", { list: [
    { streamID: "test_universe_self_11111111", UUID: "self", label: "Self · Universe FLUBBER" },
    { streamID: "test_universe_Partner_22222222", UUID: "partner", label: "Partner · Universe FLUBBER" },
  ] });
  receiverClock.advance(500);
  assert.deepEqual(receiver.snapshot().sources.map((source) => source.label), ["Partner · Universe FLUBBER"]);
  assert.equal(receiverSdk.calls.some((call) => call[0] === "view"), false);
  await receiver.selectSource("test_universe_Partner_22222222");
  assert.deepEqual(receiverSdk.calls.find((call) => call[0] === "view"), [
    "view", "test_universe_Partner_22222222", {
      audio: false,
      video: false,
      downloads: false,
      allowresources: false,
      label: "Universe receiver",
    },
  ]);
  await receiver.stop();
});

test("broadcaster caps changed sends at 60 Hz, heartbeats at 100 ms, and keeps only latest state under backpressure", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");

  broadcaster.offer(0.1, 0.1);
  assert.equal(channel.sent.length, 1);
  clock.advance(5);
  broadcaster.offer(0.2, 0.2);
  assert.equal(channel.sent.length, 1, "an update inside the 60 Hz interval is coalesced");
  clock.advance(12);
  broadcaster.offer(0.3, 0.3);
  assert.equal(channel.sent.length, 2);

  channel.bufferedAmount = 1;
  clock.advance(17);
  broadcaster.offer(0.8, -0.8);
  assert.equal(channel.sent.length, 2);
  assert.equal(broadcaster.snapshot().droppedBackpressure, 1);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(channel.sent.length, 3);
  assert.deepEqual(decodeFlubberFrame(channel.sent.at(-1)), {
    sequence: 3,
    currentX: decodeFlubberFrame(channel.sent.at(-1)).currentX,
    currentY: decodeFlubberFrame(channel.sent.at(-1)).currentY,
  });
  assert.ok(Math.abs(decodeFlubberFrame(channel.sent.at(-1)).currentX - 0.8) < 1e-6);
  assert.ok(Math.abs(decodeFlubberFrame(channel.sent.at(-1)).currentY + 0.8) < 1e-6);
  channel.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(channel.sent.length, 3, "a low-buffer event without a dropped update must not recurse");

  clock.advance(FLUBBER_REMOTE_HEARTBEAT_MS);
  assert.equal(channel.sent.length, 4, "unchanged coordinates still receive a heartbeat");
  await broadcaster.stop();
});

test("viewport placement has its own typed 60 Hz state and a non-authoritative heartbeat", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  broadcaster.offerViewportPosition(0.2, 0.8);
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");
  assert.equal(channel.sent.length, 1);

  clock.advance(5);
  broadcaster.offerViewportPosition(0.3, 0.7);
  assert.equal(channel.sent.length, 1);
  clock.advance(12);
  broadcaster.offerViewportPosition(0.4, 0.6);
  assert.equal(channel.sent.length, 2);
  channel.bufferedAmount = 1;
  clock.advance(17);
  broadcaster.offerViewportPosition(0.9, 0.1);
  assert.equal(channel.sent.length, 2);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event("bufferedamountlow"));
  assert.equal(channel.sent.length, 3);
  const latest = decodeFlubberPositionFrame(channel.sent.at(-1));
  assert.ok(Math.abs(latest.viewportX - 0.9) < 1e-6);
  assert.ok(Math.abs(latest.viewportY - 0.1) < 1e-6);
  clock.advance(FLUBBER_REMOTE_HEARTBEAT_MS * 2);
  assert.equal(channel.sent.length, 5, "the final placement is repeated on the shared 100 ms heartbeat");
  await broadcaster.stop();
});

test("broadcaster keeps near-60 Hz animation frames without accumulating an extra-frame delay", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");

  broadcaster.offer(0, 0);
  for (let frame = 1; frame <= 120; frame += 1) {
    clock.advance(16.5);
    broadcaster.offer(frame / 120, -frame / 120);
  }
  assert.ok(channel.sent.length >= 118, `expected near-frame cadence, received ${channel.sent.length} packets`);

  await broadcaster.stop();
});

test("broadcaster scheduling tolerance retains the long-run 60 Hz cap", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");

  broadcaster.offer(0, 0);
  for (let step = 1; step <= 2_500; step += 1) {
    clock.advance(4);
    broadcaster.offer((step % 200) / 100 - 1, -((step % 200) / 100 - 1));
  }
  assert.ok(channel.sent.length <= 602, `60 Hz cap exceeded with ${channel.sent.length} packets in 10 seconds`);

  await broadcaster.stop();
});

test("broadcaster stop quiesces heartbeats before a delayed SDK disconnect completes", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  let releaseDisconnect;
  sdk.disconnect = async () => {
    sdk.calls.push(["disconnect"]);
    await new Promise((resolve) => { releaseDisconnect = resolve; });
  };
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");
  broadcaster.offer(0.2, -0.2);
  broadcaster.offerViewportPosition(0.7, 0.3);
  const sentBeforeStop = channel.sent.length;

  const stopping = broadcaster.stop();
  assert.equal(broadcaster.snapshot().phase, "stopping");
  assert.equal(broadcaster.snapshot().streamId, "");
  assert.equal(channel.readyState, "closed", "the data channel must close before signaling teardown completes");
  clock.advance(FLUBBER_REMOTE_HEARTBEAT_MS * 5);
  assert.equal(channel.sent.length, sentBeforeStop, "no heartbeat may escape while signaling teardown is pending");

  releaseDisconnect();
  await stopping;
  assert.equal(broadcaster.snapshot().phase, "idle");
});

test("heartbeat scheduling does not add duplicate packets while changed frames are active", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const broadcaster = new FlubberBroadcaster({ ...clock.options(() => sdk), randomBytes: () => new Uint8Array(4) });
  await broadcaster.start();
  sdk.emit("dataChannelOpen", { uuid: "listener" });
  await settle();
  const channel = sdk.channels.get("listener");
  broadcaster.offer(0, 0);
  clock.advance(95);
  broadcaster.offer(0.5, 0.5);
  const sendsBeforeHeartbeatTick = channel.sent.length;
  clock.advance(5);
  assert.equal(channel.sent.length, sendsBeforeHeartbeatTick);
  clock.advance(95);
  assert.equal(channel.sent.length, sendsBeforeHeartbeatTick + 1, "an unchanged heartbeat resumes 100 ms after the last changed send");
  await broadcaster.stop();
});

test("receiver discovers one source without typing and exposes multiple sources for explicit selection", async () => {
  const oneClock = new FakeClock();
  const oneSdk = new MockSdk();
  const one = new FlubberReceiver(oneClock.options(() => oneSdk));
  await one.startDiscovery();
  oneSdk.emit("listing", { streamID: "aft_flubber_11112222", UUID: "peer-one" });
  oneClock.advance(300);
  await settle();
  assert.equal(one.snapshot().phase, "connecting");
  assert.deepEqual(oneSdk.calls.find((call) => call[0] === "view"), [
    "view",
    "aft_flubber_11112222",
    { audio: false, video: false, downloads: false, allowresources: false, label: "Affect Tracker Quest receiver" },
  ]);
  await one.stop();

  const manyClock = new FakeClock();
  const manySdk = new MockSdk();
  const many = new FlubberReceiver(manyClock.options(() => manySdk));
  await many.startDiscovery();
  manySdk.emit("listing", { list: [
    { streamID: "aft_flubber_Aurora_Lab_aaaabbbb", UUID: "peer-a" },
    { streamID: "unrelated_stream", UUID: "other" },
    { streamID: "aft_flubber_ccccdddd", UUID: "peer-c" },
  ] });
  manyClock.advance(300);
  assert.equal(many.snapshot().phase, "selecting");
  assert.deepEqual(many.snapshot().sources.map((source) => source.label), ["Aurora Lab · Live FLUBBER", "Source CCCC DDDD"]);
  assert.equal(manySdk.calls.some((call) => call[0] === "view"), false);
  await many.selectSource("aft_flubber_ccccdddd");
  assert.equal(many.snapshot().sourceLabel, "Source CCCC DDDD");
  await many.selectSource("aft_flubber_Aurora_Lab_aaaabbbb");
  assert.deepEqual(manySdk.calls.filter((call) => call[0] === "stopViewing").at(-1), ["stopViewing", "aft_flubber_ccccdddd"]);
  await many.stop();

  const shrinkingClock = new FakeClock();
  const shrinkingSdk = new MockSdk();
  const shrinking = new FlubberReceiver(shrinkingClock.options(() => shrinkingSdk));
  await shrinking.startDiscovery();
  shrinkingSdk.emit("listing", { list: [
    { streamID: "aft_flubber_11111111", UUID: "leaving" },
    { streamID: "aft_flubber_22222222", UUID: "remaining" },
  ] });
  shrinkingClock.advance(300);
  assert.equal(shrinking.snapshot().phase, "selecting");
  shrinkingSdk.emit("userLeft", { UUID: "leaving" });
  shrinkingClock.advance(300);
  await settle();
  assert.equal(shrinking.snapshot().selectedStreamId, "aft_flubber_22222222");
  await shrinking.stop();
});

test("receiver tolerates scheduler gaps, holds stale coordinates at two seconds, and requires stable recovery", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new FlubberReceiver(clock.options(() => sdk));
  const transitions = [];
  receiver.addEventListener("statechange", (event) => {
    if (event.detail.transition) transitions.push(event.detail.transition);
  });
  await receiver.startDiscovery();
  sdk.emit("listing", { streamID: "aft_flubber_deadbeef", UUID: "peer" });
  clock.advance(300);
  await settle();
  const channel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_deadbeef",
    uuid: "peer",
    channel,
  });

  channel.message(encodeFlubberFrame(10, 0.4, -0.6));
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(receiver.acceptFrame(encodeFlubberFrame(10, 0.9, 0.9)), false);
  assert.equal(receiver.acceptFrame(encodeFlubberFrame(9, 0.9, 0.9)), false);
  assert.equal(receiver.acceptFrame(new ArrayBuffer(4)), false);
  clock.advance(FLUBBER_REMOTE_STALE_MS - 1);
  assert.equal(receiver.snapshot().phase, "live");
  clock.advance(1);
  const stale = receiver.snapshot();
  assert.equal(stale.phase, "stale");
  assert.equal(stale.latest.currentX, decodeFlubberFrame(encodeFlubberFrame(10, 0.4, -0.6)).currentX);
  assert.equal(stale.latest.currentY, decodeFlubberFrame(encodeFlubberFrame(10, 0.4, -0.6)).currentY);

  channel.message(encodeFlubberFrame(11, -0.2, 0.7));
  assert.equal(receiver.snapshot().phase, "stale", "one returning frame must not flap the status back to live");
  channel.message(encodeFlubberFrame(12, -0.1, 0.6));
  assert.equal(receiver.snapshot().phase, "stale");
  channel.message(encodeFlubberFrame(13, -0.2, 0.7));
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(FLUBBER_REMOTE_RECOVERY_FRAMES, 3);
  assert.deepEqual(receiver.snapshot().diagnostics, {
    receivedFrames: 4,
    lastGapMs: 0,
    p95GapMs: FLUBBER_REMOTE_STALE_MS,
    maxGapMs: FLUBBER_REMOTE_STALE_MS,
    lateGapCount: 1,
    staleTransitions: 1,
    recoveryTransitions: 1,
  });
  assert.deepEqual(transitions.filter((value) => ["live", "stale", "recovered"].includes(value)), ["live", "stale", "recovered"]);
  await receiver.stop();
  assert.equal(transitions.at(-1), "disconnected");
});

test("receiver merges optional normalized placement without changing coordinate liveness", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new FlubberReceiver(clock.options(() => sdk));
  await receiver.startDiscovery();
  sdk.emit("listing", { streamID: "aft_flubber_feedface", UUID: "peer" });
  clock.advance(300);
  await settle();
  const coordinateChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_feedface",
    uuid: "peer",
    channel: coordinateChannel,
  });
  coordinateChannel.message(encodeFlubberPositionFrame(4, 0.25, 0.8));
  assert.equal(receiver.snapshot().phase, "connecting", "placement alone cannot establish affect liveness");
  coordinateChannel.message(encodeFlubberFrame(9, -0.3, 0.6));
  const live = receiver.snapshot();
  assert.equal(live.phase, "live");
  assert.equal(live.latest.positionSequence, 4);
  assert.ok(Math.abs(live.latest.viewportX - 0.25) < 1e-6);
  assert.ok(Math.abs(live.latest.viewportY - 0.8) < 1e-6);
  coordinateChannel.message(encodeFlubberPositionFrame(4, 1, 1));
  assert.ok(Math.abs(receiver.snapshot().latest.viewportX - 0.25) < 1e-6);
  const legacyPositionChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_POSITION_CHANNEL}`,
    streamID: "aft_flubber_feedface",
    uuid: "peer",
    channel: legacyPositionChannel,
  });
  legacyPositionChannel.message(encodeFlubberFrame(5, 0.4, 0.6));
  assert.equal(receiver.snapshot().latest.positionSequence, 5, "the previous two-channel sender remains compatible");
  assert.ok(Math.abs(receiver.snapshot().latest.viewportX - 0.4) < 1e-6);
  clock.advance(FLUBBER_REMOTE_STALE_MS);
  assert.equal(receiver.snapshot().phase, "stale", "placement packets do not mask a stale affect stream");
  await receiver.stop();
});

test("receiver gives transient channel closure the full stale grace without HUD flapping", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new FlubberReceiver(clock.options(() => sdk));
  const transitions = [];
  receiver.addEventListener("statechange", (event) => {
    if (event.detail.transition) transitions.push(event.detail.transition);
  });
  await receiver.startDiscovery();
  sdk.emit("listing", { streamID: "aft_flubber_0badcafe", UUID: "repairing-peer" });
  clock.advance(300);
  await settle();
  const originalChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_0badcafe",
    uuid: "repairing-peer",
    channel: originalChannel,
  });
  originalChannel.message(encodeFlubberFrame(1, 0.1, -0.2));
  originalChannel.close();
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(receiver.snapshot().diagnostics.staleTransitions, 0);
  assert.deepEqual(transitions.filter((value) => ["live", "disconnected", "stale"].includes(value)), ["live", "disconnected"]);

  clock.advance(FLUBBER_REMOTE_STALE_MS - 1);
  assert.equal(receiver.snapshot().phase, "live");
  const repairedChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_0badcafe",
    uuid: "repairing-peer",
    channel: repairedChannel,
  });
  repairedChannel.message(encodeFlubberFrame(2, 0.2, -0.1));
  assert.equal(receiver.snapshot().phase, "live");
  clock.advance(FLUBBER_REMOTE_STALE_MS - 1);
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(receiver.snapshot().diagnostics.staleTransitions, 0);
  await receiver.stop();
});

test("receiver holds a departed selected source and can retry discovery after a signaling failure", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new FlubberReceiver(clock.options(() => sdk));
  const departureTransitions = [];
  receiver.addEventListener("statechange", (event) => {
    if (event.detail.transition) departureTransitions.push(event.detail.transition);
  });
  await receiver.startDiscovery();
  sdk.emit("listing", { streamID: "aft_flubber_12345678", UUID: "departing-peer" });
  clock.advance(300);
  await settle();
  const channel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_12345678",
    uuid: "departing-peer",
    channel,
  });
  channel.message(encodeFlubberFrame(1, 0.1, 0.2));
  sdk.emit("userLeft", { UUID: "departing-peer" });
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(receiver.snapshot().sources.length, 0);
  assert.equal(departureTransitions.at(-1), "disconnected");
  clock.advance(FLUBBER_REMOTE_STALE_MS - 1);
  assert.equal(receiver.snapshot().phase, "live");
  clock.advance(1);
  assert.equal(receiver.snapshot().phase, "stale");
  assert.deepEqual(departureTransitions.slice(-2), ["disconnected", "stale"]);
  assert.equal(sdk.calls.filter((call) => call[0] === "view").length, 1, "departure must not auto-switch");
  await receiver.stop();

  const failed = new MockSdk();
  failed.connect = async function connect() {
    this.calls.push(["connect"]);
    throw new Error("signaling unavailable");
  };
  const recovered = new MockSdk();
  const sdks = [failed, recovered];
  const retry = new FlubberReceiver(clock.options(() => sdks.shift()));
  await assert.rejects(retry.startDiscovery(), /signaling unavailable/);
  assert.equal(retry.snapshot().phase, "error");
  await retry.startDiscovery();
  assert.equal(retry.snapshot().phase, "discovering");
  assert.equal(recovered.calls[0][0], "connect");
  await retry.stop();
});

test("late packets and close events from a switched source cannot affect the new source", async () => {
  const clock = new FakeClock();
  const sdk = new MockSdk();
  const receiver = new FlubberReceiver(clock.options(() => sdk));
  await receiver.startDiscovery();
  sdk.emit("listing", { list: [
    { streamID: "aft_flubber_aaaaaaaa", UUID: "peer-a" },
    { streamID: "aft_flubber_bbbbbbbb", UUID: "peer-b" },
  ] });
  clock.advance(300);
  await receiver.selectSource("aft_flubber_aaaaaaaa");
  const oldChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_aaaaaaaa",
    uuid: "peer-a",
    channel: oldChannel,
  });
  oldChannel.message(encodeFlubberFrame(20, -0.8, -0.8));
  oldChannel.close();
  assert.equal(receiver.snapshot().phase, "live", "the closed source retains its repair grace until an explicit switch");

  await receiver.selectSource("aft_flubber_bbbbbbbb");
  assert.deepEqual(
    receiver.snapshot().sources.map((source) => source.streamId),
    ["aft_flubber_bbbbbbbb"],
    "an explicitly abandoned disconnected source must not remain as a ghost choice",
  );
  const newChannel = new MockChannel();
  sdk.emit("channelOpen", {
    label: `x-${FLUBBER_REMOTE_CHANNEL}`,
    streamID: "aft_flubber_bbbbbbbb",
    uuid: "peer-b",
    channel: newChannel,
  });
  newChannel.message(encodeFlubberFrame(1, 0.6, 0.7));
  oldChannel.message(encodeFlubberFrame(21, -1, -1));
  oldChannel.dispatchEvent(new Event("close"));
  assert.equal(receiver.snapshot().phase, "live");
  assert.equal(receiver.snapshot().latest.sequence, 1);
  assert.ok(Math.abs(receiver.snapshot().latest.currentX - 0.6) < 1e-6);
  assert.ok(Math.abs(receiver.snapshot().latest.currentY - 0.7) < 1e-6);
  await receiver.stop();
});

test("source labels retain anonymous fallback and named discovery IDs keep a random suffix", () => {
  assert.equal(formatFlubberSourceLabel("aft_flubber_ab12cd34"), "Source AB12 CD34");
  assert.equal(
    generateFlubberSourceId(() => new Uint8Array([0xab, 0x12, 0xcd, 0x34]), "Aurora Lab"),
    "aft_flubber_Aurora_Lab_ab12cd34",
  );
});

test("vendored VDO.Ninja 1.5.5 SDK, source, and MPL license match recorded hashes", () => {
  const files = new Map([
    ["vdoninja-sdk.min.js", "390ea6c8b1a4e57bf7fa18ff2b394f25cc79e637130f97e4a29ca958a90fac77"],
    ["vdoninja-sdk.js", "8097d5420d7ed2426623d7ff08f6abd45f03f89e6540a6cc4b86bcdc057d841e"],
    ["LICENSE-MPL-2.0.txt", "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04"],
  ]);
  for (const [name, expected] of files) {
    const bytes = readFileSync(new URL(`../site/vendor/vdoninja/1.5.5/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
});

test("remote pages load only the local SDK and feature code makes no microphone or audio request", () => {
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const webxr = readFileSync(new URL("../site/webxr.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../site/src/app.js", import.meta.url), "utf8");
  const receiver = readFileSync(new URL("../site/src/webxr-study.js", import.meta.url), "utf8");
  const transport = readFileSync(new URL("../site/src/flubber-remote.js", import.meta.url), "utf8");
  for (const page of [index, webxr]) {
    assert.match(page, /src="\.\/vendor\/vdoninja\/1\.5\.5\/vdoninja-sdk\.min\.js"/);
    assert.doesNotMatch(page, /<script[^>]+https?:\/\//);
  }
  assert.match(index, />Broadcast Live FLUBBER</);
  assert.match(index, /id="flubber-remote-foreground-button"[^>]*hidden>Restore low-latency foreground mode</);
  assert.match(webxr, />Use incoming signal</);
  assert.match(index, /src="\.\/src\/app\.js\?v=face-engines-1-main-2-screen-calibration-module-4-mobile-party-camera-1-collaboration-9-retro-2-phone-preview-1-face-tab-1"/);
  assert.match(webxr, /src="\.\/src\/webxr-study\.js\?v=collaboration-4-portable-study-2"/);
  assert.match(app, /from "\.\/flubber-remote\.js\?v=collaboration-4"/);
  assert.match(receiver, /from "\.\/flubber-remote\.js\?v=collaboration-4"/);
  assert.match(transport, /FLUBBER_REMOTE_FORCE_TURN_PARAM = "remote-force-turn"/);
  assert.match(transport, /forceTURN: Boolean\(forceTurn\)/);
  assert.match(app, /flubberBroadcaster\.offerState\([\s\S]*state\.currentX,[\s\S]*state\.currentY,[\s\S]*viewportPosition\.viewportX,[\s\S]*viewportPosition\.viewportY/);
  assert.doesNotMatch(app, /flubberBroadcaster\.offer\(state\.currentX, state\.currentY, timestamp\)/);
  assert.match(webxr, /id="webxr-remote-quality"/);
  assert.match(webxr, /id="webxr-remote-mode"/);
  assert.doesNotMatch(`${app}\n${receiver}\n${transport}`, /getUserMedia|mediaDevices|audio:\s*true/);
  assert.match(transport, /audio: false,\s*video: false/);
  assert.match(receiver, /pendingRemoteEvents/);
  assert.match(receiver, /record\("event", remoteEvent\.event/);
  assert.match(receiver, /setAttribute\("aria-pressed"/);
  assert.match(receiver, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(app, /broadcastOwnsPictureInPicture/);
  assert.match(app, /acquireBroadcastLatencyMode/);
  assert.match(app, /remote-foreground-lost/);
  assert.match(app, /remote-foreground-restored/);
  assert.match(app, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(receiver, /visible-blurred/);
});
