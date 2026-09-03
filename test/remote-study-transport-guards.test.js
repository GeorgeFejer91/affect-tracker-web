import test from "node:test";
import assert from "node:assert/strict";

import {
  HardenedVdoNinjaTransport,
  InboundCommandAdmissionTransport,
  REMOTE_STUDY_DISCOVERY_MAX_LISTING_ITEMS,
  REMOTE_STUDY_DISCOVERY_MAX_SOURCES,
  REMOTE_STUDY_INBOUND_CONTROL_MAX_COUNT,
  REMOTE_STUDY_PREAUTH_MAX_PEERS,
} from "../site/src/remote-study/transport-guards.js";

function transport(role) {
  return new HardenedVdoNinjaTransport({
    role,
    room: "brsp_guard_test_room",
    sharedSecret: "0123456789abcdef0123456789abcdef",
  });
}

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

class RawInboundTransport extends EventTarget {
  constructor() {
    super();
    this.closedPeers = [];
  }

  sendControl() { return true; }

  closePeer(peerKey) { this.closedPeers.push(peerKey); }

  async stop() {}
}

test("non-command control floods are bounded before the BRSP receive chain", () => {
  const raw = new RawInboundTransport();
  const guarded = new InboundCommandAdmissionTransport(raw);
  let forwarded = 0;
  let violations = 0;
  guarded.addEventListener("controlmessage", () => { forwarded += 1; });
  guarded.addEventListener("securityviolation", () => { violations += 1; });
  const data = JSON.stringify({
    protocol: "brsp",
    version: 1,
    type: "snapshot-request",
    sessionId: "session_01",
    senderId: "controller_01",
    senderEpoch: 1,
    sequence: 1,
    body: {},
  });
  for (let index = 0; index <= REMOTE_STUDY_INBOUND_CONTROL_MAX_COUNT; index += 1) {
    raw.dispatchEvent(detailEvent("controlmessage", {
      peerKey: "peer_controller_01",
      data,
    }));
  }

  assert.equal(forwarded, REMOTE_STUDY_INBOUND_CONTROL_MAX_COUNT);
  assert.equal(violations, 1);
  assert.deepEqual(raw.closedPeers, ["peer_controller_01"]);
  assert.equal(guarded.admissionSnapshot().rejected, true);
});

test("hostile discovery listings are rejected before source-map insertion", () => {
  const guarded = transport("controller");
  const violations = [];
  guarded.addEventListener("securityviolation", (event) => violations.push(event.detail));
  guarded.addListing({
    list: Array.from({ length: REMOTE_STUDY_DISCOVERY_MAX_LISTING_ITEMS + 1 }, (_, index) => ({
      streamID: `brsp_target_hostile_${index}`,
      UUID: `peer_${index}`,
      label: "Hostile listing entry",
    })),
  });

  assert.equal(guarded.sources.size, 0);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "preauth_metadata_rejected");
});

test("discovery source-map growth and source byte lengths are strictly bounded", () => {
  const guarded = transport("controller");
  let violations = 0;
  guarded.addEventListener("securityviolation", () => { violations += 1; });
  for (let index = 0; index < REMOTE_STUDY_DISCOVERY_MAX_SOURCES; index += 1) {
    guarded.addSource({
      streamID: `brsp_target_source_${index}`,
      UUID: `peer_${index}`,
      label: "Affect Tracker",
    }, { deferSelection: true });
  }
  assert.equal(guarded.sources.size, REMOTE_STUDY_DISCOVERY_MAX_SOURCES);

  guarded.addSource({
    streamID: "brsp_target_one_too_many",
    UUID: "peer_overflow",
    label: "Affect Tracker",
  }, { deferSelection: true });
  assert.ok(guarded.sources.size <= REMOTE_STUDY_DISCOVERY_MAX_SOURCES);
  assert.equal(violations, 1);

  const oversized = transport("controller");
  let oversizedViolations = 0;
  oversized.addEventListener("securityviolation", () => { oversizedViolations += 1; });
  oversized.addSource({
    streamID: `brsp_target_${"x".repeat(200)}`,
    UUID: "peer_valid",
    label: "Affect Tracker",
  });
  assert.equal(oversized.sources.size, 0);
  assert.equal(oversizedViolations, 1);
});

test("pre-authentication peer records never exceed the fixed cap and overflow channels close", () => {
  const guarded = transport("controller");
  for (let index = 0; index < REMOTE_STUDY_PREAUTH_MAX_PEERS; index += 1) {
    assert.ok(guarded.peerRecord(`peer_${index}`));
    assert.ok(guarded.peers.size <= REMOTE_STUDY_PREAUTH_MAX_PEERS);
  }
  let channelClosed = 0;
  let violations = 0;
  guarded.addEventListener("securityviolation", () => { violations += 1; });
  guarded.acceptControllerChannel({
    uuid: "peer_overflow",
    label: "x-brsp_control_v1",
    channel: { close() { channelClosed += 1; } },
  });

  assert.equal(channelClosed, 1);
  assert.equal(violations, 1);
  assert.ok(guarded.peers.size <= REMOTE_STUDY_PREAUTH_MAX_PEERS);
  assert.equal(guarded.peers.has("peer_overflow"), false);
});

test("a hung SDK quality read cannot create overlapping or repeated polls", async () => {
  let qualityCalls = 0;
  const guarded = new HardenedVdoNinjaTransport({
    role: "target",
    room: "brsp_quality_guard_room",
    sharedSecret: "0123456789abcdef0123456789abcdef",
    qualityTimeoutMs: 5,
  });
  guarded.sdk = {
    getPeerQuality() {
      qualityCalls += 1;
      return new Promise(() => {});
    },
  };
  guarded.lifecycleGeneration = 1;
  guarded.peerRecord("peer_quality_01");

  const first = guarded.refreshQuality();
  assert.equal(await guarded.refreshQuality(), false);
  assert.equal(qualityCalls, 1);
  assert.equal(await first, false);
  assert.equal(guarded.qualityPollingDisabled, true);
  assert.equal(await guarded.refreshQuality(), false);
  assert.equal(qualityCalls, 1);
});
