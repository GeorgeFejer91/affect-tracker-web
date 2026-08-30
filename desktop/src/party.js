import { clamp } from "../../site/src/math.js";
import { createFlubberRenderer } from "./render.js";
import { createFlubberParty } from "../../site/src/flubber-collaboration.js";
import {
  createFlubberBroadcaster,
  normalizeFlubberSourceName,
} from "../../site/src/flubber-remote.js";
import {
  acceptDesktopPartyFrame,
  buildDesktopHostScene,
  DESKTOP_PARTY_SCENE_STALE_MS,
  DesktopPartyPlacementStore,
} from "./party-core.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function participantSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-1.62 -1.62 3.24 3.24");
  svg.setAttribute("aria-hidden", "true");
  for (const className of ["shape-halo", "shape-base", "shape-outline"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", className);
    svg.append(path);
  }
  return svg;
}

function safeMessage(error) {
  return error?.message ?? String(error ?? "Unknown Party error");
}

export function createDesktopPartyController({ announce }) {
  const elements = {
    name: document.querySelector("#desktop-party-name"),
    host: document.querySelector("#desktop-party-host-button"),
    broadcast: document.querySelector("#desktop-party-broadcast-button"),
    stop: document.querySelector("#desktop-party-stop-button"),
    badge: document.querySelector("#desktop-party-badge"),
    status: document.querySelector("#desktop-party-status"),
    sources: document.querySelector("#desktop-party-sources"),
    roster: document.querySelector("#desktop-party-roster"),
    stage: document.querySelector("#desktop-party-stage"),
  };
  if (Object.values(elements).some((element) => !element)) throw new Error("The desktop Party controls are incomplete.");

  const party = createFlubberParty();
  const broadcaster = createFlubberBroadcaster();
  const placements = new DesktopPartyPlacementStore();
  const views = new Map();
  let mode = "idle";
  let latestSnapshot;
  let currentScene;
  let incomingScene;
  let busy = false;
  let staleTimer;
  let broadcastPlacement = { viewportX: 0.5, viewportY: 0.5 };
  let drag;
  let errorMessage = "";
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  function setStatus(message, { error = false } = {}) {
    elements.status.textContent = message;
    elements.badge.classList.toggle("is-error", error);
    if (error) elements.badge.textContent = "Error";
  }

  function recordError(error) {
    errorMessage = safeMessage(error);
    announce(errorMessage);
  }

  function setParticipantPosition(view, position, size) {
    view.root.style.setProperty("--party-x", String(position.viewportX));
    view.root.style.setProperty("--party-y", String(position.viewportY));
    view.root.style.setProperty("--party-size", String(size));
  }

  function participantCanDrag(participant) {
    if (mode === "host") return !participant.host;
    return mode === "broadcast" && participant.streamId === broadcaster.snapshot().streamId;
  }

  function participantById(streamId) {
    return currentScene?.participants.find((participant) => participant.streamId === streamId);
  }

  function beginParticipantDrag(event, streamId) {
    const participant = participantById(streamId);
    if (!participant || !participantCanDrag(participant)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
    drag = { pointerId: event.pointerId, streamId };
    moveParticipantDrag(event, streamId);
  }

  function applyDraggedPosition(streamId, position) {
    const participant = participantById(streamId);
    const view = views.get(streamId);
    if (!participant || !view) return;
    const margin = clamp(Number(participant.size) / 2, 0.04, 0.24);
    const bounded = {
      viewportX: clamp(position.viewportX, margin, 1 - margin),
      viewportY: clamp(position.viewportY, margin, 1 - margin),
    };
    participant.viewportX = bounded.viewportX;
    participant.viewportY = bounded.viewportY;
    setParticipantPosition(view, bounded, participant.size);
    if (mode === "host") {
      const guest = party.snapshot().guests.find((item) => item.streamId === streamId);
      placements.reanchor(streamId, bounded, guest?.latest, participant.size);
      publishHostScene();
    } else if (mode === "broadcast" && streamId === broadcaster.snapshot().streamId) {
      broadcastPlacement = bounded;
      broadcaster.offerViewportPosition(bounded.viewportX, bounded.viewportY);
    }
  }

  function moveParticipantDrag(event, streamId = drag?.streamId) {
    if (!drag || event.pointerId !== drag.pointerId || streamId !== drag.streamId) return;
    const bounds = elements.stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    applyDraggedPosition(streamId, {
      viewportX: (event.clientX - bounds.left) / bounds.width,
      viewportY: (event.clientY - bounds.top) / bounds.height,
    });
  }

  function finishParticipantDrag(event, streamId) {
    if (!drag || event.pointerId !== drag.pointerId || streamId !== drag.streamId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove("is-dragging");
    drag = undefined;
    announce("Party participant position updated for every connected screen.");
  }

  function moveParticipantWithKeyboard(event, streamId) {
    const delta = {
      ArrowLeft: [-0.02, 0],
      ArrowRight: [0.02, 0],
      ArrowUp: [0, -0.02],
      ArrowDown: [0, 0.02],
    }[event.key];
    const participant = participantById(streamId);
    if (!delta || !participant || !participantCanDrag(participant)) return;
    event.preventDefault();
    applyDraggedPosition(streamId, {
      viewportX: participant.viewportX + delta[0],
      viewportY: participant.viewportY + delta[1],
    });
  }

  function createParticipantView(streamId) {
    const root = document.createElement("div");
    root.className = "desktop-party-participant";
    root.dataset.streamId = streamId;
    root.setAttribute("role", "group");
    const svg = participantSvg();
    const label = document.createElement("span");
    label.className = "desktop-party-participant-label";
    root.append(svg, label);
    const view = { root, label, render: createFlubberRenderer(root) };
    root.addEventListener("pointerdown", (event) => beginParticipantDrag(event, streamId));
    root.addEventListener("pointermove", (event) => moveParticipantDrag(event, streamId));
    root.addEventListener("pointerup", (event) => finishParticipantDrag(event, streamId));
    root.addEventListener("pointercancel", (event) => finishParticipantDrag(event, streamId));
    root.addEventListener("keydown", (event) => moveParticipantWithKeyboard(event, streamId));
    elements.stage.append(root);
    views.set(streamId, view);
    return view;
  }

  function clearScene() {
    currentScene = undefined;
    for (const view of views.values()) view.root.remove();
    views.clear();
    elements.stage.hidden = true;
  }

  function renderScene(scene) {
    currentScene = scene;
    if (!scene?.participants?.length) {
      clearScene();
      return;
    }
    const retained = new Set(scene.participants.map((participant) => participant.streamId));
    for (const [streamId, view] of views) {
      if (retained.has(streamId)) continue;
      view.root.remove();
      views.delete(streamId);
    }
    for (const [index, participant] of scene.participants.entries()) {
      const view = views.get(participant.streamId) ?? createParticipantView(participant.streamId);
      view.root.style.zIndex = participant.host ? "2" : "1";
      view.root.classList.toggle("is-stale", participant.stale);
      view.root.classList.toggle("is-draggable", participantCanDrag(participant));
      view.root.tabIndex = participantCanDrag(participant) ? 0 : -1;
      view.label.textContent = participant.label;
      view.root.setAttribute(
        "aria-label",
        `${participant.host ? "Party host" : "Party participant"} ${participant.label}. Valence ${participant.currentX.toFixed(2)}, arousal ${participant.currentY.toFixed(2)}${participant.stale ? ", signal stale and holding" : ""}${participantCanDrag(participant) ? ". Drag or use arrow keys to reposition." : ""}`,
      );
      setParticipantPosition(view, participant, participant.size);
      view.render({
        sessionId: participant.streamId,
        currentX: participant.currentX,
        currentY: participant.currentY,
        phase: scene.visual.phase + index * 0.47,
        palette: scene.visual.palette,
        amplitudeScale: scene.visual.amplitudeScale,
        disorderScale: scene.visual.disorderScale,
        baseShape: scene.visual.baseShape,
        overlayOpacity: scene.visual.opacity,
      }, reducedMotion.matches);
    }
    elements.stage.hidden = false;
  }

  function publishHostScene() {
    if (mode !== "host" || !latestSnapshot) return;
    const partySnapshot = party.snapshot();
    const scene = buildDesktopHostScene({ party: partySnapshot, snapshot: latestSnapshot, placements });
    if (!scene || scene.participants.length < 2) {
      clearScene();
      return;
    }
    renderScene(scene);
    party.broadcastScene({
      visual: scene.visual,
      host: scene.participants[0],
      guests: scene.participants.slice(1),
    });
  }

  function renderSources(partySnapshot) {
    elements.sources.replaceChildren();
    if (mode !== "host") return;
    const invited = new Set(partySnapshot.guests.map((guest) => guest.streamId));
    for (const source of partySnapshot.sources.filter((item) => !invited.has(item.streamId))) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Invite ${source.label}`;
      button.disabled = busy || partySnapshot.guests.length >= partySnapshot.maxGuests;
      button.addEventListener("click", async () => {
        busy = true;
        errorMessage = "";
        updateUi();
        try {
          await party.invite(source.streamId);
          announce(`${source.label} invited to the desktop Party.`);
        } catch (error) {
          recordError(error);
        } finally {
          busy = false;
          updateUi();
        }
      });
      elements.sources.append(button);
    }
  }

  function renderRoster(partySnapshot, broadcasterSnapshot) {
    elements.roster.replaceChildren();
    const rows = [];
    if (mode === "host") {
      rows.push(`${partySnapshot.hostName || "Desktop"} — host`);
      for (const guest of partySnapshot.guests) {
        rows.push(`${guest.label} — ${guest.phase}${guest.route ? ` · ${guest.route}` : ""}`);
      }
    } else if (mode === "broadcast") {
      if (incomingScene) rows.push(...incomingScene.participants.map((participant) => `${participant.label} — ${participant.host ? "host" : participant.stale ? "stale" : "live"}`));
      else rows.push(`${broadcasterSnapshot.sourceLabel || "Desktop FLUBBER"} — waiting for a Party invitation`);
    }
    for (const text of rows) {
      const item = document.createElement("li");
      item.textContent = text;
      elements.roster.append(item);
    }
  }

  function updateUi() {
    const partySnapshot = party.snapshot();
    const broadcasterSnapshot = broadcaster.snapshot();
    const active = mode !== "idle";
    elements.name.disabled = active || busy;
    elements.host.disabled = active || busy;
    elements.broadcast.disabled = active || busy;
    elements.stop.disabled = !active || busy;
    elements.badge.classList.remove("is-ok", "is-error");
    if (mode === "host") {
      const liveCount = partySnapshot.guests.filter((guest) => guest.latest).length;
      elements.badge.textContent = liveCount ? `${liveCount + 1} participants` : "Radar active";
      elements.badge.classList.add("is-ok");
      setStatus(liveCount
        ? `Desktop Party live with ${liveCount} invited FLUBBER${liveCount === 1 ? "" : "s"}. Every connected screen receives the same scene.`
        : "Party radar is active. Start a Live FLUBBER broadcast in the smartphone browser, then invite it below.");
    } else if (mode === "broadcast") {
      elements.badge.textContent = incomingScene ? "Party scene live" : "Broadcasting";
      elements.badge.classList.add("is-ok");
      setStatus(incomingScene
        ? `Shared Party scene live with ${incomingScene.participants.length} participants.`
        : `Desktop FLUBBER is public as ${broadcasterSnapshot.sourceLabel || "a new source"}. Invite it from the smartphone Party host.`);
    } else {
      elements.badge.textContent = "Idle";
      setStatus("No remote connection is created on app launch.");
    }
    if (errorMessage) {
      elements.badge.classList.remove("is-ok");
      setStatus(errorMessage, { error: true });
    }
    renderSources(partySnapshot);
    renderRoster(partySnapshot, broadcasterSnapshot);
  }

  function expireIncomingScene() {
    if (mode !== "broadcast" || !incomingScene
      || performance.now() - incomingScene.receivedAt < DESKTOP_PARTY_SCENE_STALE_MS) return;
    incomingScene = undefined;
    clearScene();
    updateUi();
    announce("The shared FLUBBER Party scene ended; the desktop Flubber remains available for invitation.");
  }

  function requireName() {
    const name = normalizeFlubberSourceName(elements.name.value);
    if (name) return name;
    elements.name.focus();
    throw new Error("Enter a public signal name before starting a Party connection.");
  }

  async function startHost() {
    busy = true;
    errorMessage = "";
    updateUi();
    try {
      const name = requireName();
      mode = "host";
      await party.startDiscovery({ hostName: name });
      announce("Desktop Party radar started. No camera or microphone was requested.");
    } catch (error) {
      mode = "idle";
      recordError(error);
    } finally {
      busy = false;
      updateUi();
    }
  }

  async function startBroadcast() {
    busy = true;
    errorMessage = "";
    updateUi();
    try {
      const name = requireName();
      mode = "broadcast";
      incomingScene = undefined;
      broadcastPlacement = { viewportX: 0.5, viewportY: 0.5 };
      await broadcaster.start({ sourceName: name });
      if (latestSnapshot) broadcaster.offerState(
        latestSnapshot.currentX,
        latestSnapshot.currentY,
        broadcastPlacement.viewportX,
        broadcastPlacement.viewportY,
      );
      staleTimer = window.setInterval(expireIncomingScene, 250);
      announce("Desktop FLUBBER broadcast started. No camera or microphone was requested.");
    } catch (error) {
      mode = "idle";
      recordError(error);
    } finally {
      busy = false;
      updateUi();
    }
  }

  async function stop() {
    if (staleTimer) window.clearInterval(staleTimer);
    staleTimer = undefined;
    mode = "idle";
    errorMessage = "";
    incomingScene = undefined;
    placements.clear();
    clearScene();
    updateUi();
    await Promise.allSettled([party.stop(), broadcaster.stop()]);
    updateUi();
  }

  function updateSnapshot(snapshot) {
    latestSnapshot = snapshot;
    if (mode === "host") publishHostScene();
    if (mode === "broadcast") {
      broadcaster.offerState(
        snapshot.currentX,
        snapshot.currentY,
        broadcastPlacement.viewportX,
        broadcastPlacement.viewportY,
      );
    }
  }

  party.addEventListener("statechange", (event) => {
    if (event.detail?.phase === "error") errorMessage = "The desktop Party radar encountered a transport error.";
    publishHostScene();
    updateUi();
  });
  party.addEventListener("frame", () => {
    publishHostScene();
    updateUi();
  });
  broadcaster.addEventListener("statechange", (event) => {
    if (event.detail?.error || event.detail?.phase === "error") {
      errorMessage = event.detail?.message || "The desktop FLUBBER broadcast encountered a transport error.";
    }
    updateUi();
  });
  broadcaster.addEventListener("message", (event) => {
    const accepted = acceptDesktopPartyFrame({
      data: event.detail?.data,
      uuid: event.detail?.uuid,
      localStreamId: broadcaster.snapshot().streamId,
      previous: incomingScene,
      receivedAt: performance.now(),
    });
    if (!accepted) return;
    incomingScene = accepted;
    renderScene(incomingScene);
    updateUi();
  });

  elements.host.addEventListener("click", () => { void startHost(); });
  elements.broadcast.addEventListener("click", () => { void startBroadcast(); });
  elements.stop.addEventListener("click", () => {
    void stop().then(() => announce("Desktop Party networking stopped."));
  });
  window.addEventListener("pagehide", () => { void stop(); });
  updateUi();

  return Object.freeze({ updateSnapshot, stop });
}
