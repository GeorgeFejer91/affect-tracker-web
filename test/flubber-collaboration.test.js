import test from "node:test";
import assert from "node:assert/strict";
import {
  combineUniverseCoordinates,
  decodePartySceneFrame,
  encodePartySceneFrame,
  FlubberParty,
  morphPartyBirthContours,
  oneWayGroundRole,
  partyBudVectorGeometry,
  partyFlubberPlacement,
  PARTY_MAX_GUESTS,
  PARTY_SCENE_PROTOCOL,
  UNIVERSE_CHANNEL,
  UNIVERSE_ROOM,
  UNIVERSE_STREAM_PREFIX,
  UniverseLink,
} from "../site/src/flubber-collaboration.js";

function eventWith(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

class FakeBroadcaster extends EventTarget {
  constructor(options) {
    super();
    this.options = options;
    this.state = { phase: "idle", streamId: "", listenerCount: 0 };
    this.offers = [];
  }
  snapshot() { return { ...this.state }; }
  async start({ sourceName }) {
    this.state = { phase: "broadcasting", streamId: `${UNIVERSE_STREAM_PREFIX}self_12345678`, sourceName, listenerCount: 0 };
    this.dispatchEvent(eventWith("statechange", this.snapshot()));
    return this.snapshot();
  }
  offer(x, y) { this.offers.push([x, y]); return true; }
  async stop() { this.state = { phase: "idle", streamId: "", listenerCount: 0 }; }
}

class FakeReceiver extends EventTarget {
  constructor(options, sources = []) {
    super();
    this.options = options;
    this.sentData = [];
    this.state = { phase: "idle", sources, selectedStreamId: "", sourceLabel: "", latest: undefined };
  }
  snapshot() { return { ...this.state, sources: [...this.state.sources] }; }
  async startDiscovery() { this.state.phase = "discovering"; this.dispatchEvent(eventWith("statechange", this.snapshot())); }
  async selectSource(streamId) {
    const source = this.state.sources.find((item) => item.streamId === streamId);
    this.state = { ...this.state, phase: "connecting", selectedStreamId: streamId, sourceLabel: source?.label ?? streamId };
    this.dispatchEvent(eventWith("statechange", this.snapshot()));
  }
  async stop() { this.state = { phase: "idle", sources: [], selectedStreamId: "", sourceLabel: "", latest: undefined }; }
  sendData(value) { this.sentData.push(value); return true; }
}

test("ordinary Ground Control transport is an exclusive sender-or-receiver gate", () => {
  assert.equal(oneWayGroundRole(), "idle");
  assert.equal(oneWayGroundRole({ liveBroadcastPhase: "broadcasting" }), "send");
  assert.equal(oneWayGroundRole({ jsonReceivePhase: "discovering" }), "receive");
  assert.equal(oneWayGroundRole({ liveBroadcastPhase: "broadcasting", liveReceivePhase: "live" }), "conflict");
});

test("Universe co-control gives both inputs full-scale saturated influence", () => {
  assert.deepEqual(
    combineUniverseCoordinates({ currentX: 1, currentY: -1 }, { currentX: -1, currentY: 1 }),
    { currentX: 0, currentY: 0 },
  );
  assert.deepEqual(
    combineUniverseCoordinates({ currentX: 0.5, currentY: 0.25 }, undefined),
    { currentX: 0.5, currentY: 0.25 },
  );
  assert.deepEqual(
    combineUniverseCoordinates({ currentX: 1, currentY: -1 }, { currentX: 0, currentY: 0 }),
    { currentX: 1, currentY: -1 },
  );
  assert.deepEqual(
    combineUniverseCoordinates({ currentX: 0.75, currentY: -0.8 }, { currentX: 0.6, currentY: -0.5 }),
    { currentX: 1, currentY: -1 },
  );
  assert.deepEqual(
    combineUniverseCoordinates({ currentX: 0.25, currentY: -0.4 }, { currentX: 0.5, currentY: 0.1 }),
    combineUniverseCoordinates({ currentX: 0.5, currentY: 0.1 }, { currentX: 0.25, currentY: -0.4 }),
  );
});

test("Universe uses an isolated room/channel and requires reciprocal selection", async () => {
  let broadcaster;
  let receiver;
  const link = new UniverseLink({
    broadcasterFactory: (options) => (broadcaster = new FakeBroadcaster(options)),
    receiverFactory: (options) => (receiver = new FakeReceiver(options, [
      { streamId: `${UNIVERSE_STREAM_PREFIX}partner_87654321`, label: "Partner · Universe FLUBBER" },
    ])),
  });
  await link.start({ sourceName: "Local" });
  assert.equal(broadcaster.options.room, UNIVERSE_ROOM);
  assert.equal(broadcaster.options.channelName, UNIVERSE_CHANNEL);
  assert.equal(receiver.options.autoSelect, false);
  assert.equal(receiver.options.excludeSource(`${UNIVERSE_STREAM_PREFIX}self_12345678`), true);
  await link.selectSource(`${UNIVERSE_STREAM_PREFIX}partner_87654321`);
  receiver.state.phase = "live";
  receiver.state.latest = { currentX: 0.2, currentY: -0.4 };
  assert.equal(link.snapshot().phase, "awaiting-reciprocal");
  broadcaster.state.listenerCount = 1;
  assert.equal(link.snapshot().phase, "live");
  link.offer(0.4, 0.6);
  assert.deepEqual(broadcaster.offers, [[0.4, 0.6]]);
});

test("party guest placement starts as a bud on the centered Flubber and separates into the bounded orbit", () => {
  const placement = partyFlubberPlacement({
    index: 0,
    count: 1,
    widgetX: 500,
    widgetY: 400,
    widgetSize: 180,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.ok(Math.abs(placement.size - 100.8) < 1e-9);
  assert.ok(Math.abs(placement.budX - 575.6) < 1e-9);
  assert.equal(placement.budY, 400);
  assert.ok(placement.x > placement.budX);
  assert.equal(placement.y, 400);
  const bounded = partyFlubberPlacement({
    index: 0,
    count: 1,
    widgetX: 990,
    widgetY: 790,
    widgetSize: 180,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.ok(bounded.x <= 1000 - bounded.size / 2 - 8);
  assert.ok(bounded.y <= 800 - bounded.size / 2 - 8);
});

test("party birth is a sinusoidal cellular SVG field that pinches from one contour into two", () => {
  const options = {
    originX: 240,
    originY: 280,
    centerX: 500,
    centerY: 400,
    finalX: 670,
    finalY: 400,
    mainRadius: 90,
    guestRadius: 50,
  };
  const parent = partyBudVectorGeometry({ ...options, progress: 0 });
  const growth = partyBudVectorGeometry({ ...options, progress: 0.58 });
  const pinch = partyBudVectorGeometry({ ...options, progress: 0.84 });
  const separatedEarly = partyBudVectorGeometry({ ...options, progress: 0.90 });
  const separated = partyBudVectorGeometry({ ...options, progress: 1 });
  assert.equal(parent.contourCount, 1);
  assert.equal(growth.contourCount, 1);
  assert.equal(growth.attached, true);
  assert.equal(pinch.contourCount, 1);
  assert.equal(separatedEarly.contourCount, 2);
  assert.equal(separated.contourCount, 2);
  assert.equal(separated.attached, false);
  assert.match(growth.surfacePath, /^M [\d.-]+ [\d.-]+ L /);
  assert.doesNotMatch(growth.surfacePath, /NaN|Infinity/);
  assert.equal((separated.surfacePath.match(/\bM /g) ?? []).length, 2);
  assert.ok(growth.guest.radius > parent.guest.radius);
  assert.ok(separated.guest.x > growth.guest.x);
});

test("separated cellular contours continuously morph onto both canonical Flubber paths", () => {
  const geometry = partyBudVectorGeometry({
    progress: 0.87,
    originX: 240,
    originY: 280,
    centerX: 500,
    centerY: 400,
    finalX: 670,
    finalY: 400,
    mainRadius: 90,
    guestRadius: 50,
  });
  const canonical = "M1,0L0,1L-1,0L0,-1Z";
  const start = morphPartyBirthContours({
    contours: geometry.contours,
    mainPath: canonical,
    guestPath: canonical,
    mainCenter: { x: 500, y: 400 },
    guestCenter: { x: 670, y: 400 },
    mainSize: 180,
    guestSize: 100,
    progress: 0,
  });
  const finish = morphPartyBirthContours({
    contours: geometry.contours,
    mainPath: canonical,
    guestPath: canonical,
    mainCenter: { x: 500, y: 400 },
    guestCenter: { x: 670, y: 400 },
    mainSize: 180,
    guestSize: 100,
    progress: 1,
  });
  assert.equal(start.contours.length, 2);
  assert.equal(finish.contours.length, 2);
  assert.doesNotMatch(start.path + finish.path, /NaN|Infinity/);
  assert.match(finish.path, /^M 555\.56 400\.00/);
  assert.match(finish.path, /M 700\.86 400\.00/);
  assert.notEqual(start.path, finish.path);
});

test("a FLUBBER party invites explicit sources and enforces its browser bound", async () => {
  const sources = Array.from({ length: PARTY_MAX_GUESTS + 1 }, (_, index) => ({
    streamId: `aft_flubber_guest_${index}`,
    label: `Guest ${index} · Live FLUBBER`,
  }));
  const receivers = [];
  const party = new FlubberParty({
    discoveryFactory: (options) => new FakeReceiver(options, sources),
    receiverFactory: (options) => {
      const receiver = new FakeReceiver(options, sources);
      receivers.push(receiver);
      return receiver;
    },
  });
  await party.startDiscovery();
  await party.invite(sources[0].streamId);
  await party.invite(sources[0].streamId);
  assert.equal(party.snapshot().guests.length, 1);
  await party.remove(sources[0].streamId);
  for (const source of sources.slice(0, PARTY_MAX_GUESTS)) await party.invite(source.streamId);
  assert.equal(party.snapshot().guests.length, PARTY_MAX_GUESTS);
  await assert.rejects(() => party.invite(sources.at(-1).streamId), /limited to 8/);
  await party.remove(sources[0].streamId);
  assert.equal(party.snapshot().guests.length, PARTY_MAX_GUESTS - 1);
  await party.stop();
  assert.equal(party.snapshot().guests.length, 0);
  assert.equal(receivers.every((receiver) => receiver.snapshot().phase === "idle"), true);
});

test("party scenes are bounded, validated, and identify exactly one host", () => {
  const encoded = encodePartySceneFrame({
    partyId: "party_1234",
    sequence: 7,
    participants: [
      { streamId: "party_1234_host", label: "Host", currentX: 0.25, currentY: -0.5, viewportX: 0.5, viewportY: 0.5, size: 0.2, host: true },
      { streamId: "aft_flubber_guest", label: "Guest", currentX: 4, currentY: -4, viewportX: 2, viewportY: -2, size: 0.01 },
    ],
  });
  assert.equal(JSON.parse(encoded).protocol, PARTY_SCENE_PROTOCOL);
  assert.deepEqual(decodePartySceneFrame(encoded), {
    partyId: "party_1234",
    sequence: 7,
    visual: {
      baseShape: "circle",
      animationSpeed: 1,
      amplitudeScale: 1,
      disorderScale: 1,
      opacity: 1,
      phase: 0,
      palette: { up: "#ffd166", down: "#5c7cfa", left: "#ff5b68", right: "#5dffb0" },
    },
    participants: [
      { streamId: "party_1234_host", label: "Host", currentX: 0.25, currentY: -0.5, viewportX: 0.5, viewportY: 0.5, size: 0.2, stale: false, host: true },
      { streamId: "aft_flubber_guest", label: "Guest", currentX: 1, currentY: -1, viewportX: 1, viewportY: 0, size: 0.04, stale: false, host: false },
    ],
  });
  assert.equal(decodePartySceneFrame("{}"), undefined);
  assert.throws(() => encodePartySceneFrame({
    partyId: "party_1234",
    participants: [
      { streamId: "one", label: "One", currentX: 0, currentY: 0, viewportX: 0.5, viewportY: 0.5, size: 0.2 },
    ],
  }), /exactly one host/);
});

test("a party relays the complete shared scene back to every invited broadcaster", async () => {
  const sources = [
    { streamId: "aft_flubber_one", label: "One · Live FLUBBER" },
    { streamId: "aft_flubber_two", label: "Two · Live FLUBBER" },
  ];
  const receivers = [];
  const party = new FlubberParty({
    randomBytes: () => new Uint8Array(8).fill(1),
    discoveryFactory: (options) => new FakeReceiver(options, sources),
    receiverFactory: (options) => {
      const receiver = new FakeReceiver(options, sources);
      receivers.push(receiver);
      return receiver;
    },
  });
  await party.startDiscovery({ hostName: "Host" });
  await party.invite(sources[0].streamId);
  await party.invite(sources[1].streamId);
  assert.equal(party.broadcastScene({
    host: { currentX: 0.1, currentY: 0.2, viewportX: 0.5, viewportY: 0.5, size: 0.2 },
    visual: { baseShape: "heart", opacity: 0.8, phase: 1.25, palette: { right: "#123456" } },
    guests: [
      { streamId: sources[0].streamId, label: "One", currentX: -0.4, currentY: 0.6, viewportX: 0.25, viewportY: 0.5, size: 0.12 },
      { streamId: sources[1].streamId, label: "Two", currentX: 0.7, currentY: -0.3, viewportX: 0.75, viewportY: 0.5, size: 0.12 },
    ],
  }, 100), true);
  assert.equal(receivers.every((receiver) => receiver.sentData.length === 1), true);
  assert.equal(receivers[0].sentData[0], receivers[1].sentData[0], "every invited broadcaster receives the identical aggregate scene");
  const scene = decodePartySceneFrame(receivers[0].sentData[0]);
  assert.equal(scene.participants.length, 3);
  assert.equal(scene.visual.baseShape, "heart");
  assert.equal(scene.visual.opacity, 0.8);
  assert.equal(scene.visual.phase, 1.25);
  assert.equal(scene.visual.palette.right, "#123456");
  assert.equal(scene.participants[0].label, "Host");
  assert.deepEqual(scene.participants.slice(1).map((participant) => participant.streamId), sources.map((source) => source.streamId));
  assert.equal(party.broadcastScene({
    host: { currentX: 0.1, currentY: 0.2, viewportX: 0.5, viewportY: 0.5, size: 0.2 },
    visual: scene.visual,
    guests: scene.participants.slice(1),
  }, 200), false, "unchanged scenes wait for their bounded heartbeat");
  assert.equal(party.broadcastScene({
    host: { currentX: 0.1, currentY: 0.2, viewportX: 0.5, viewportY: 0.5, size: 0.2 },
    visual: scene.visual,
    guests: scene.participants.slice(1),
  }, 351), true, "unchanged scenes repeat on the bounded heartbeat");
});
