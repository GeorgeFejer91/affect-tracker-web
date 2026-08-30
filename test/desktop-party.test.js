import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  acceptDesktopPartyFrame,
  buildDesktopHostScene,
  desktopPartyOrbitPosition,
  DesktopPartyPlacementStore,
} from "../desktop/src/party-core.js";
import { encodePartySceneFrame } from "../site/src/flubber-collaboration.js";

function approximately(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

function encodedScene({ partyId = "party_test", sequence = 1, localStreamId = "aft_flubber_phone_12345678" } = {}) {
  return encodePartySceneFrame({
    partyId,
    sequence,
    visual: {
      baseShape: "heart",
      animationSpeed: 1.4,
      amplitudeScale: 1.2,
      disorderScale: 0.8,
      opacity: 0.75,
      phase: 0.4,
      palette: { up: "#ffd166", down: "#5c7cfa", left: "#ff5b68", right: "#5dffb0" },
    },
    participants: [
      {
        streamId: `${partyId}_host`,
        label: "Desktop host",
        currentX: 0.2,
        currentY: -0.1,
        viewportX: 0.5,
        viewportY: 0.5,
        size: 0.28,
        host: true,
      },
      {
        streamId: localStreamId,
        label: "Phone",
        currentX: -0.4,
        currentY: 0.6,
        viewportX: 0.7,
        viewportY: 0.3,
        size: 0.2,
        host: false,
      },
    ],
  });
}

test("desktop Party orbit positions stay inside participant-safe bounds", () => {
  for (let count = 1; count <= 8; count += 1) {
    for (let index = 0; index < count; index += 1) {
      const position = desktopPartyOrbitPosition(index, count, 0.2);
      assert.ok(position.viewportX >= 0.1 && position.viewportX <= 0.9);
      assert.ok(position.viewportY >= 0.1 && position.viewportY <= 0.9);
    }
  }
});

test("desktop Party guest movement is relative and can be reanchored by the host", () => {
  const placements = new DesktopPartyPlacementStore();
  const first = placements.positionFor({
    streamId: "guest-a",
    index: 0,
    count: 2,
    latest: { viewportX: 0.2, viewportY: 0.3 },
  });
  approximately(first.viewportX, 0.5);
  approximately(first.viewportY, 0.18);

  const moved = placements.positionFor({
    streamId: "guest-a",
    index: 0,
    count: 2,
    latest: { viewportX: 0.3, viewportY: 0.4 },
  });
  approximately(moved.viewportX, 0.6);
  approximately(moved.viewportY, 0.28);

  placements.reanchor(
    "guest-a",
    { viewportX: 0.8, viewportY: 0.7 },
    { viewportX: 0.3, viewportY: 0.4 },
  );
  const afterHostDrag = placements.positionFor({
    streamId: "guest-a",
    index: 0,
    count: 2,
    latest: { viewportX: 0.4, viewportY: 0.5 },
  });
  approximately(afterHostDrag.viewportX, 0.9);
  approximately(afterHostDrag.viewportY, 0.8);
});

test("desktop host builds the one authoritative scene rendered locally and returned to guests", () => {
  const scene = buildDesktopHostScene({
    party: {
      partyId: "party_desktop",
      hostStreamId: "party_desktop_host",
      hostName: "Lab desktop",
      guests: [{
        streamId: "aft_flubber_phone_12345678",
        label: "Study phone · Live FLUBBER",
        phase: "live",
        latest: { currentX: -0.25, currentY: 0.75, viewportX: 0.4, viewportY: 0.6 },
      }],
    },
    snapshot: {
      currentX: 0.5,
      currentY: -0.5,
      phase: 1.2,
      baseShape: "square",
      animationSpeed: 1.5,
      amplitudeScale: 1.3,
      disorderScale: 0.7,
      overlayOpacity: 0.8,
      palette: { up: "#111111", down: "#222222", left: "#333333", right: "#444444" },
    },
    placements: new DesktopPartyPlacementStore(),
  });

  assert.equal(scene.partyId, "party_desktop");
  assert.equal(scene.visual.baseShape, "square");
  assert.equal(scene.visual.animationSpeed, 1.5);
  assert.equal(scene.visual.opacity, 0.8);
  assert.deepEqual(scene.participants.map(({ streamId, label, host }) => ({ streamId, label, host })), [
    { streamId: "party_desktop_host", label: "Lab desktop", host: true },
    { streamId: "aft_flubber_phone_12345678", label: "Study phone", host: false },
  ]);
  assert.equal(scene.participants[0].currentX, 0.5);
  assert.equal(scene.participants[1].currentY, 0.75);
});

test("desktop guest accepts only its own ordered Party scene and supports stale-peer recovery", () => {
  const localStreamId = "aft_flubber_phone_12345678";
  const first = acceptDesktopPartyFrame({
    data: encodedScene({ sequence: 0xffff_ffff, localStreamId }),
    uuid: "peer-a",
    localStreamId,
    receivedAt: 100,
  });
  assert.equal(first.sequence, 0xffff_ffff);

  assert.equal(acceptDesktopPartyFrame({
    data: encodedScene({ localStreamId }),
    localStreamId,
    receivedAt: 100,
  }), undefined, "a Party scene without an identified peer must be rejected");

  assert.equal(acceptDesktopPartyFrame({
    data: encodedScene({ sequence: 0xffff_ffff, localStreamId }),
    uuid: "peer-a",
    localStreamId,
    previous: first,
    receivedAt: 200,
  }), undefined, "duplicate sequence must be rejected");

  const wrapped = acceptDesktopPartyFrame({
    data: encodedScene({ sequence: 0, localStreamId }),
    uuid: "peer-a",
    localStreamId,
    previous: first,
    receivedAt: 300,
  });
  assert.equal(wrapped.sequence, 0, "uint32 wrap-around must remain ordered");

  assert.equal(acceptDesktopPartyFrame({
    data: encodedScene({ sequence: 1, localStreamId }),
    uuid: "peer-b",
    localStreamId,
    previous: wrapped,
    receivedAt: 1_000,
  }), undefined, "a second peer cannot hijack a live Party scene");

  const recovered = acceptDesktopPartyFrame({
    data: encodedScene({ partyId: "party_reconnected", sequence: 1, localStreamId }),
    uuid: "peer-b",
    localStreamId,
    previous: wrapped,
    receivedAt: 2_301,
  });
  assert.equal(recovered.partyId, "party_reconnected");
  assert.equal(recovered.peerUuid, "peer-b");

  assert.equal(acceptDesktopPartyFrame({
    data: encodedScene({ localStreamId: "aft_flubber_someone_else" }),
    uuid: "peer-c",
    localStreamId,
    receivedAt: 5_000,
  }), undefined, "a scene not containing this broadcaster must be rejected");
});

test("desktop Party is explicit, data-only, narrowly networked, and ships the pinned SDK", () => {
  const html = readFileSync(new URL("../desktop/index.html", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../desktop/src/party.js", import.meta.url), "utf8");
  const viteConfig = readFileSync(new URL("../desktop/vite.config.js", import.meta.url), "utf8");
  const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

  assert.match(html, /id="desktop-party-host-button"/);
  assert.match(html, /id="desktop-party-broadcast-button"/);
  assert.match(html, /No camera, microphone, physiology, typed text, research record, or pointer trajectory is sent\./);
  assert.match(html, /src="\.\/vdoninja\/1\.5\.5\/vdoninja-sdk\.min\.js"/);
  assert.match(controller, /elements\.host\.addEventListener\("click"/);
  assert.match(controller, /elements\.broadcast\.addEventListener\("click"/);
  assert.match(viteConfig, /publicDir: resolve\(desktopRoot, "\.\.\/site\/vendor"\)/);
  assert.equal(
    tauriConfig.app.security.csp,
    "default-src 'self'; connect-src ipc: http://ipc.localhost wss://wss.vdo.ninja https://turnservers.vdo.ninja; img-src 'self' data:; style-src 'self'; script-src 'self'",
  );
  assert.equal(existsSync(new URL("../site/vendor/vdoninja/1.5.5/vdoninja-sdk.min.js", import.meta.url)), true);
});
