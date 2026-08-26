import { clamp } from "./math.js";
import { createFlubberBroadcaster, createFlubberReceiver } from "./flubber-remote.js?v=collaboration-1";

export const UNIVERSE_ROOM = "affect_tracker_universe_v1";
export const UNIVERSE_STREAM_PREFIX = "aft_universe_";
export const UNIVERSE_CHANNEL = "flubberuniversev1";
export const UNIVERSE_LABEL_SUFFIX = "Universe FLUBBER";
export const PARTY_MAX_GUESTS = 8;

const IDLE_PHASES = new Set(["idle", "error"]);

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail, enumerable: true });
  return event;
}

function activePhase(phase) {
  return !IDLE_PHASES.has(phase ?? "idle");
}

export function oneWayGroundRole({
  jsonBroadcastPhase,
  liveBroadcastPhase,
  jsonReceivePhase,
  liveReceivePhase,
} = {}) {
  const sending = activePhase(jsonBroadcastPhase) || activePhase(liveBroadcastPhase);
  const receiving = activePhase(jsonReceivePhase) || activePhase(liveReceivePhase);
  if (sending && receiving) return "conflict";
  if (sending) return "send";
  if (receiving) return "receive";
  return "idle";
}

export function combineUniverseCoordinates(local, remote) {
  const localX = clamp(Number(local?.currentX) || 0);
  const localY = clamp(Number(local?.currentY) || 0);
  if (!Number.isFinite(remote?.currentX) || !Number.isFinite(remote?.currentY)) {
    return { currentX: localX, currentY: localY };
  }
  return {
    currentX: clamp(localX + clamp(remote.currentX)),
    currentY: clamp(localY + clamp(remote.currentY)),
  };
}

export function partyFlubberPlacement({
  index = 0,
  count = 1,
  widgetX,
  widgetY,
  widgetSize,
  viewportWidth,
  viewportHeight,
} = {}) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  const safeIndex = Math.min(safeCount - 1, Math.max(0, Math.floor(Number(index) || 0)));
  const mainSize = Math.max(1, Number(widgetSize) || 180);
  const width = Math.max(1, Number(viewportWidth) || 1);
  const height = Math.max(1, Number(viewportHeight) || 1);
  const centerX = Number.isFinite(widgetX) ? widgetX : width / 2;
  const centerY = Number.isFinite(widgetY) ? widgetY : height / 2;
  const size = Math.max(72, Math.min(132, mainSize * 0.56));
  const radius = Math.max(mainSize * 0.78, size * 1.15);
  const angle = safeCount === 1 ? 0 : (Math.PI * 2 * safeIndex) / safeCount;
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  return {
    size,
    angle,
    x: clamp(centerX + directionX * radius, size / 2 + 8, width - size / 2 - 8),
    y: clamp(centerY + directionY * radius, size / 2 + 8, height - size / 2 - 8),
    budX: centerX + directionX * mainSize * 0.42,
    budY: centerY + directionY * mainSize * 0.42,
  };
}

const UNIVERSE_PROTOCOL = Object.freeze({
  room: UNIVERSE_ROOM,
  streamPrefix: UNIVERSE_STREAM_PREFIX,
  channelName: UNIVERSE_CHANNEL,
  labelSuffix: UNIVERSE_LABEL_SUFFIX,
});

export class UniverseLink extends EventTarget {
  constructor({
    broadcasterFactory = createFlubberBroadcaster,
    receiverFactory = createFlubberReceiver,
  } = {}) {
    super();
    this.broadcaster = broadcasterFactory(UNIVERSE_PROTOCOL);
    this.receiver = receiverFactory({
      ...UNIVERSE_PROTOCOL,
      autoSelect: false,
      receiverLabel: "Affect Tracker Universe partner",
      excludeSource: (streamId) => streamId === this.broadcaster.snapshot().streamId,
    });
    this.started = false;
    this.forward = () => this.dispatchEvent(detailEvent("statechange", this.snapshot()));
    this.forwardFrame = () => {
      this.dispatchEvent(detailEvent("frame", this.snapshot()));
    };
    this.broadcaster.addEventListener("statechange", this.forward);
    this.receiver.addEventListener("statechange", this.forward);
    this.receiver.addEventListener("frame", this.forwardFrame);
  }

  snapshot() {
    const sending = this.broadcaster.snapshot();
    const receiving = this.receiver.snapshot();
    const receivingCoordinates = (receiving.phase === "live" || receiving.phase === "stale") && receiving.latest;
    const reciprocal = Boolean(receivingCoordinates && sending.listenerCount > 0);
    let phase = "idle";
    if (sending.phase === "error" || receiving.phase === "error") phase = "error";
    else if (reciprocal && receiving.phase === "stale") phase = "stale";
    else if (reciprocal) phase = "live";
    else if (receivingCoordinates) phase = "awaiting-reciprocal";
    else if (receiving.phase === "connecting") phase = "connecting";
    else if (this.started) phase = "discovering";
    return {
      phase,
      enabled: this.started,
      reciprocal,
      sending,
      receiving,
      sources: receiving.sources ?? [],
      sourceLabel: receiving.sourceLabel ?? "",
      latest: receiving.latest,
      message: phase === "live"
        ? `Synchronized with ${receiving.sourceLabel}. Both local controls share one Flubber.`
        : phase === "awaiting-reciprocal"
          ? `Receiving ${receiving.sourceLabel}; waiting for that browser to choose your Universe signal.`
          : phase === "stale"
            ? `Universe signal lost; holding the last shared position.`
            : this.started ? "Announced to the Universe room. Choose a partner and ask them to choose you." : "Universe link off",
    };
  }

  async start({ sourceName }) {
    if (this.started) return this.snapshot();
    this.started = true;
    try {
      await this.broadcaster.start({ sourceName });
      await this.receiver.startDiscovery();
      this.forward();
      return this.snapshot();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async selectSource(streamId) {
    if (!this.started) return this.snapshot();
    await this.receiver.selectSource(streamId);
    return this.snapshot();
  }

  offer(currentX, currentY) {
    return this.broadcaster.offer(currentX, currentY);
  }

  async stop() {
    this.started = false;
    await Promise.all([this.receiver.stop(), this.broadcaster.stop()]);
    this.forward();
  }
}

export class FlubberParty extends EventTarget {
  constructor({
    discoveryFactory = createFlubberReceiver,
    receiverFactory = createFlubberReceiver,
    maxGuests = PARTY_MAX_GUESTS,
  } = {}) {
    super();
    this.receiverFactory = receiverFactory;
    this.maxGuests = Math.max(1, Math.floor(maxGuests));
    this.discovery = discoveryFactory({ autoSelect: false, receiverLabel: "Affect Tracker party radar" });
    this.guests = new Map();
    this.discovery.addEventListener("statechange", () => this.emitState());
  }

  snapshot() {
    return {
      phase: this.discovery.snapshot().phase,
      enabled: activePhase(this.discovery.snapshot().phase) || this.guests.size > 0,
      sources: this.discovery.snapshot().sources ?? [],
      guests: Array.from(this.guests, ([streamId, guest]) => ({
        streamId,
        label: guest.label,
        ...guest.receiver.snapshot(),
      })),
      maxGuests: this.maxGuests,
    };
  }

  emitState() {
    this.dispatchEvent(detailEvent("statechange", this.snapshot()));
  }

  async startDiscovery() {
    await this.discovery.startDiscovery();
    this.emitState();
    return this.snapshot();
  }

  async invite(streamId) {
    if (this.guests.has(streamId)) return this.snapshot();
    if (this.guests.size >= this.maxGuests) {
      throw new Error(`A FLUBBER party is limited to ${this.maxGuests} invited signals per browser.`);
    }
    const source = this.discovery.snapshot().sources.find((item) => item.streamId === streamId);
    if (!source) throw new Error("That FLUBBER signal is no longer visible on radar.");
    const receiver = this.receiverFactory({ autoSelect: false, receiverLabel: "Affect Tracker party guest" });
    const guest = { label: source.label, receiver };
    this.guests.set(streamId, guest);
    const forward = () => this.emitState();
    const forwardFrame = () => {
      this.dispatchEvent(detailEvent("frame", this.snapshot()));
    };
    guest.forward = forward;
    guest.forwardFrame = forwardFrame;
    receiver.addEventListener("statechange", forward);
    receiver.addEventListener("frame", forwardFrame);
    try {
      await receiver.startDiscovery();
      await receiver.selectSource(streamId);
      this.emitState();
      return this.snapshot();
    } catch (error) {
      await this.remove(streamId);
      throw error;
    }
  }

  async remove(streamId) {
    const guest = this.guests.get(streamId);
    if (!guest) return this.snapshot();
    this.guests.delete(streamId);
    guest.receiver.removeEventListener("statechange", guest.forward);
    guest.receiver.removeEventListener("frame", guest.forwardFrame);
    await guest.receiver.stop();
    this.emitState();
    return this.snapshot();
  }

  async stop() {
    const guests = Array.from(this.guests.values());
    this.guests.clear();
    for (const guest of guests) {
      guest.receiver.removeEventListener("statechange", guest.forward);
      guest.receiver.removeEventListener("frame", guest.forwardFrame);
    }
    await Promise.all([this.discovery.stop(), ...guests.map((guest) => guest.receiver.stop())]);
    this.emitState();
  }
}

export function createUniverseLink(options) {
  return new UniverseLink(options);
}

export function createFlubberParty(options) {
  return new FlubberParty(options);
}
