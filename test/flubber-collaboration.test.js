import test from "node:test";
import assert from "node:assert/strict";
import {
  combineUniverseCoordinates,
  FlubberParty,
  oneWayGroundRole,
  partyBudVectorGeometry,
  partyFlubberPlacement,
  PARTY_MAX_GUESTS,
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
