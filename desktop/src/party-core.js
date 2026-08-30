import { clamp } from "../../site/src/math.js";
import { decodePartySceneFrame } from "../../site/src/flubber-collaboration.js";
import { isNewerFlubberSequence } from "../../site/src/flubber-remote.js";

export const DESKTOP_PARTY_SCENE_STALE_MS = 2_000;
export const DESKTOP_PARTY_HOST_SIZE = 0.28;
export const DESKTOP_PARTY_GUEST_SIZE = 0.2;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedPosition(value, size) {
  const margin = clamp(finite(size, DESKTOP_PARTY_GUEST_SIZE) / 2, 0.04, 0.24);
  return {
    viewportX: clamp(finite(value?.viewportX, 0.5), margin, 1 - margin),
    viewportY: clamp(finite(value?.viewportY, 0.5), margin, 1 - margin),
  };
}

export function desktopPartyOrbitPosition(index, count, size = DESKTOP_PARTY_GUEST_SIZE) {
  const normalizedCount = Math.max(1, Math.floor(finite(count, 1)));
  const normalizedIndex = clamp(Math.floor(finite(index, 0)), 0, normalizedCount - 1);
  const angle = normalizedCount === 1
    ? 0
    : -Math.PI / 2 + normalizedIndex / normalizedCount * Math.PI * 2;
  return boundedPosition({
    viewportX: 0.5 + Math.cos(angle) * 0.32,
    viewportY: 0.5 + Math.sin(angle) * 0.32,
  }, size);
}

export class DesktopPartyPlacementStore {
  constructor() {
    this.anchors = new Map();
  }

  clear() {
    this.anchors.clear();
  }

  prune(streamIds) {
    const retained = new Set(streamIds);
    for (const streamId of this.anchors.keys()) {
      if (!retained.has(streamId)) this.anchors.delete(streamId);
    }
  }

  positionFor({ streamId, index, count, latest, size = DESKTOP_PARTY_GUEST_SIZE }) {
    const fallback = desktopPartyOrbitPosition(index, count, size);
    if (!Number.isFinite(latest?.viewportX) || !Number.isFinite(latest?.viewportY)) return fallback;
    let anchor = this.anchors.get(streamId);
    if (!anchor) {
      anchor = {
        senderX: clamp(latest.viewportX, 0, 1),
        senderY: clamp(latest.viewportY, 0, 1),
        localX: fallback.viewportX,
        localY: fallback.viewportY,
      };
      this.anchors.set(streamId, anchor);
    }
    return boundedPosition({
      viewportX: anchor.localX + clamp(latest.viewportX, 0, 1) - anchor.senderX,
      viewportY: anchor.localY + clamp(latest.viewportY, 0, 1) - anchor.senderY,
    }, size);
  }

  reanchor(streamId, localPosition, latest, size = DESKTOP_PARTY_GUEST_SIZE) {
    const local = boundedPosition(localPosition, size);
    this.anchors.set(streamId, {
      senderX: clamp(finite(latest?.viewportX, 0.5), 0, 1),
      senderY: clamp(finite(latest?.viewportY, 0.5), 0, 1),
      localX: local.viewportX,
      localY: local.viewportY,
    });
    return local;
  }
}

export function desktopPartyVisual(snapshot) {
  return {
    baseShape: snapshot?.baseShape ?? "circle",
    animationSpeed: clamp(finite(snapshot?.animationSpeed, 1), 0.25, 3),
    opacity: clamp(finite(snapshot?.overlayOpacity, 1), 0, 1),
    phase: finite(snapshot?.phase, 0),
    amplitudeScale: clamp(finite(snapshot?.amplitudeScale, 1), 0.25, 2),
    disorderScale: clamp(finite(snapshot?.disorderScale, 1), 0.25, 2),
    palette: snapshot?.palette ?? {},
  };
}

export function desktopPartyGuestLabel(value) {
  return String(value ?? "Remote FLUBBER")
    .replace(/\s*·\s*Live FLUBBER\s*$/iu, "")
    .trim()
    .slice(0, 64) || "Remote FLUBBER";
}

export function buildDesktopHostScene({ party, snapshot, placements }) {
  if (!party?.partyId || !party?.hostStreamId || !snapshot || !placements) return undefined;
  const liveGuests = (party.guests ?? []).filter((guest) => guest.latest
    && (guest.phase === "live" || guest.phase === "stale"));
  placements.prune(liveGuests.map((guest) => guest.streamId));
  const guests = liveGuests.map((guest, index) => {
    const size = DESKTOP_PARTY_GUEST_SIZE;
    return {
      streamId: guest.streamId,
      label: desktopPartyGuestLabel(guest.label),
      currentX: clamp(finite(guest.latest.currentX), -1, 1),
      currentY: clamp(finite(guest.latest.currentY), -1, 1),
      ...placements.positionFor({
        streamId: guest.streamId,
        index,
        count: liveGuests.length,
        latest: guest.latest,
        size,
      }),
      size,
      stale: guest.phase === "stale",
      host: false,
    };
  });
  return {
    partyId: party.partyId,
    visual: desktopPartyVisual(snapshot),
    participants: [
      {
        streamId: party.hostStreamId,
        label: String(party.hostName ?? "Desktop host").slice(0, 64) || "Desktop host",
        currentX: clamp(finite(snapshot.currentX), -1, 1),
        currentY: clamp(finite(snapshot.currentY), -1, 1),
        viewportX: 0.5,
        viewportY: 0.5,
        size: DESKTOP_PARTY_HOST_SIZE,
        stale: false,
        host: true,
      },
      ...guests,
    ],
  };
}

export function acceptDesktopPartyFrame({ data, uuid, localStreamId, previous, receivedAt }) {
  const frame = decodePartySceneFrame(data);
  const acceptedAt = finite(receivedAt, 0);
  if (!frame || !uuid || !localStreamId
    || !frame.participants.some((participant) => participant.streamId === localStreamId)) {
    return undefined;
  }
  if (previous?.peerUuid && previous.peerUuid !== uuid
    && acceptedAt - previous.receivedAt < DESKTOP_PARTY_SCENE_STALE_MS) return undefined;
  if (previous?.peerUuid === uuid
    && previous.partyId === frame.partyId
    && !isNewerFlubberSequence(frame.sequence, previous.sequence)) return undefined;
  return { ...frame, peerUuid: uuid, receivedAt: acceptedAt };
}
