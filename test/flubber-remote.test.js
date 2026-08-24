import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  FLUBBER_REMOTE_CHANNEL,
  FLUBBER_REMOTE_HEARTBEAT_MS,
  FLUBBER_REMOTE_RECOVERY_FRAMES,
  FLUBBER_REMOTE_ROOM,
  FLUBBER_REMOTE_STALE_MS,
  FLUBBER_REMOTE_WIRE_BYTES,
  FlubberBroadcaster,
  FlubberReceiver,
  decodeFlubberFrame,
  encodeFlubberFrame,
  formatFlubberSourceLabel,
  isNewerFlubberSequence,
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
    this.channels.set(uuid, channel);
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

test("Flubber sequence ordering rejects duplicates and older values across uint32 wraparound", () => {
  assert.equal(isNewerFlubberSequence(2, undefined), true);
  assert.equal(isNewerFlubberSequence(2, 2), false);
  assert.equal(isNewerFlubberSequence(1, 2), false);
  assert.equal(isNewerFlubberSequence(0, 0xffffffff), true);
  assert.equal(isNewerFlubberSequence(0xffffffff, 0), false);
  assert.equal(isNewerFlubberSequence(0x80000000, 0), false);
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
  sdk.emit("dataChannelOpen", { uuid: "listener-1" });
  await settle();
  const channel = sdk.channels.get("listener-1");
  assert.deepEqual(sdk.calls.find((call) => call[0] === "openChannel"), [
    "openChannel",
    "listener-1",
    FLUBBER_REMOTE_CHANNEL,
    { ordered: false, maxRetransmits: 0 },
  ]);
  assert.equal(channel.sent.length, 1, "a listener receives the latest pair immediately");
  assert.deepEqual(decodeFlubberFrame(channel.sent[0]), {
    sequence: 1,
    currentX: 0.25,
    currentY: -0.5,
  });
  assert.equal(broadcaster.snapshot().listenerCount, 1);

  sdk.emit("dataChannelOpen", { uuid: "listener-2" });
  await settle();
  assert.equal(sdk.channels.get("listener-2").sent.length, 1);
  assert.equal(broadcaster.snapshot().listenerCount, 2);

  await broadcaster.stop();
  assert.equal(broadcaster.snapshot().phase, "idle");
  assert.equal(sdk.calls.at(-1)[0], "disconnect");
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
    { streamID: "aft_flubber_aaaabbbb", UUID: "peer-a" },
    { streamID: "unrelated_stream", UUID: "other" },
    { streamID: "aft_flubber_ccccdddd", UUID: "peer-c" },
  ] });
  manyClock.advance(300);
  assert.equal(many.snapshot().phase, "selecting");
  assert.deepEqual(many.snapshot().sources.map((source) => source.label), ["Source AAAA BBBB", "Source CCCC DDDD"]);
  assert.equal(manySdk.calls.some((call) => call[0] === "view"), false);
  await many.selectSource("aft_flubber_ccccdddd");
  assert.equal(many.snapshot().sourceLabel, "Source CCCC DDDD");
  await many.selectSource("aft_flubber_aaaabbbb");
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
  assert.equal(receiver.snapshot().phase, "stale");
  assert.equal(receiver.snapshot().sources.length, 0);
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

  await receiver.selectSource("aft_flubber_bbbbbbbb");
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

test("source labels are display-only derivations of anonymous random stream IDs", () => {
  assert.equal(formatFlubberSourceLabel("aft_flubber_ab12cd34"), "Source AB12 CD34");
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
  assert.match(index, />Broadcast this to VR \/ remote interface</);
  assert.match(webxr, />Use incoming signal</);
  assert.match(index, /src="\.\/src\/app\.js\?v=remote-3"/);
  assert.match(webxr, /src="\.\/src\/webxr-study\.js\?v=remote-3"/);
  assert.match(app, /from "\.\/flubber-remote\.js\?v=remote-3"/);
  assert.match(receiver, /from "\.\/flubber-remote\.js\?v=remote-3"/);
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
  assert.match(app, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(receiver, /visible-blurred/);
});
