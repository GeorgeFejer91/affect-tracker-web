import {
  readAndClearQrInvitation,
  remoteStudyCompanionLocationPolicy,
} from "./invitation.js";
import { RemoteStudyQuickPairController } from "./quick-pair.js";
import { formatRemoteRoute } from "./controller-view.js";

const pinnedVdoSdkUrl = new URL("../../vendor/vdoninja/1.5.5/vdoninja-sdk.min.js", import.meta.url);
let vdoSdkPromise;

function loadPinnedVdoSdk() {
  if (typeof globalThis.VDONinjaSDK === "function") return Promise.resolve();
  if (vdoSdkPromise) return vdoSdkPromise;
  vdoSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = pinnedVdoSdkUrl.href;
    script.async = true;
    script.addEventListener("load", () => {
      if (typeof globalThis.VDONinjaSDK === "function") resolve();
      else reject(new Error("The pinned VDO.Ninja transport did not initialize."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("The pinned VDO.Ninja transport could not be loaded.")), { once: true });
    document.head.append(script);
  });
  return vdoSdkPromise;
}

const elements = {
  invitation: document.querySelector("#remote-invitation-message"),
  connect: document.querySelector("#remote-connect"),
  disconnect: document.querySelector("#remote-disconnect"),
  status: document.querySelector("#remote-status"),
  authentication: document.querySelector("#remote-authentication"),
  scopes: document.querySelector("#remote-scopes"),
  brspPhase: document.querySelector("#remote-brsp-phase"),
  route: document.querySelector("#remote-route"),
  freshness: document.querySelector("#remote-freshness"),
  run: document.querySelector("#remote-run"),
  phase: document.querySelector("#remote-run-phase"),
  block: document.querySelector("#remote-block"),
  revision: document.querySelector("#remote-revision"),
  health: document.querySelector("#remote-health"),
  lastCommand: document.querySelector("#remote-last-command"),
  commands: [...document.querySelectorAll("[data-study-action]")],
};

let invitation;
let invitationError;
try {
  const locationPolicy = remoteStudyCompanionLocationPolicy(globalThis.location);
  invitation = readAndClearQrInvitation({
    location: globalThis.location,
    history: globalThis.history,
    ...locationPolicy,
  });
} catch (error) {
  invitationError = error;
}

let controller;
let lastMessage = "Not connected.";
let pageActive = true;
let connectAttempt = 0;

const allowedPhase = Object.freeze({
  arm: new Set(["prepared"]),
  start: new Set(["armed"]),
  pause: new Set(["running"]),
  resume: new Set(["paused"]),
  advance: new Set(["running"]),
  "retry-block": new Set(["running", "paused"]),
  stop: new Set(["running", "paused"]),
  finalize: new Set(["awaitingFinalization"]),
  abort: new Set(["created", "prepared", "armed", "running", "paused", "awaitingFinalization"]),
});

function titleCase(value) {
  return String(value ?? "unavailable")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (character) => character.toUpperCase());
}

function healthText(health) {
  if (!health) return "Unavailable";
  return ["storage", "input", "lsl"]
    .map((name) => `${name}: ${health[name]?.status ?? "unknown"}`)
    .join(" · ");
}

function render(message = lastMessage, error = false) {
  lastMessage = message;
  const snapshot = controller?.snapshot();
  const state = snapshot?.state;
  const connected = snapshot?.phase === "ready";
  const connecting = snapshot?.phase === "connecting";
  const pending = (snapshot?.pendingCommands ?? 0) > 0;
  elements.connect.disabled = !invitation || connecting || connected;
  elements.disconnect.disabled = !controller || snapshot.phase === "idle";
  elements.status.textContent = message;
  elements.status.dataset.error = String(error);
  elements.authentication.textContent = connected ? "QR invitation · proof accepted" : "QR invitation · not connected";
  elements.scopes.textContent = snapshot?.acceptedScopes?.length ? snapshot.acceptedScopes.join(", ") : "None";
  elements.brspPhase.textContent = titleCase(snapshot?.brspPhase ?? "idle");
  elements.route.textContent = formatRemoteRoute(snapshot);
  elements.freshness.textContent = !state
    ? "No state received"
    : snapshot.stale
      ? "Stale · holding the last returned state"
      : `Live${Number.isFinite(snapshot.stateAgeMs) ? ` · ${Math.round(snapshot.stateAgeMs)} ms old` : ""}`;
  elements.run.textContent = state?.runId ?? "Unavailable";
  elements.phase.textContent = state ? titleCase(state.phase) : "Unavailable";
  elements.block.textContent = state?.currentBlockId ?? "None";
  elements.revision.textContent = state ? `${state.revision} · authority ${state.authorityGeneration}` : "Unavailable";
  elements.health.textContent = healthText(state?.health);
  elements.lastCommand.textContent = snapshot?.lastApplied
    ? `${snapshot.lastApplied.action ?? "Command"}: ${snapshot.lastApplied.ok ? "applied" : snapshot.lastApplied.error}`
    : "None";
  for (const button of elements.commands) {
    const action = button.dataset.studyAction;
    button.disabled = !connected || !state || snapshot.stale || pending || !allowedPhase[action]?.has(state.phase);
  }
}

if (invitation) {
  elements.invitation.textContent = "A one-time invitation was loaded and removed from the browser address. Press Connect to begin networking.";
  elements.connect.disabled = false;
} else {
  elements.invitation.textContent = invitationError?.code === "history_unavailable"
    ? "The browser could not remove the invitation from history. Connection is disabled."
    : "Open this page by scanning the one-time QR invitation shown by Affect Tracker Desktop.";
}

elements.connect.addEventListener("click", async () => {
  if (!invitation || controller) return;
  const attempt = ++connectAttempt;
  const oneTimeInvitation = invitation;
  invitation = undefined;
  render("Loading the pinned transport…");
  try {
    await loadPinnedVdoSdk();
    if (!pageActive || attempt !== connectAttempt) return;
    controller = new RemoteStudyQuickPairController({ invitation: oneTimeInvitation });
    controller.addEventListener("statuschange", (event) => render(event.detail.message, event.detail.error));
    controller.addEventListener("statechange", () => render("Native desktop state received."));
    controller.addEventListener("freshnesschange", () => render());
    controller.addEventListener("commandapplied", () => render());
    render("Connecting…");
    await controller.connect();
  } catch (error) {
    if (!pageActive || attempt !== connectAttempt) return;
    const failed = controller;
    controller = undefined;
    await failed?.stop("connect_failed");
    render(`${error?.message ?? "Connection failed."} Scan a new desktop invitation to retry.`, true);
  }
});

elements.disconnect.addEventListener("click", async () => {
  const closing = controller;
  controller = undefined;
  await closing?.stop();
  invitation = undefined;
  render("Controller disconnected. Scan a new desktop invitation to reconnect.");
});

for (const button of elements.commands) {
  button.addEventListener("click", () => {
    const action = button.dataset.studyAction;
    const payload = ["pause", "retry-block", "stop", "abort"].includes(action)
      ? { reasonCode: "remote-researcher" }
      : {};
    try {
      controller.sendStudyAction(action, payload);
      render(`${button.textContent.trim()} requested. Waiting for the desktop acknowledgement.`);
    } catch (error) {
      render(error?.message ?? "The command could not be sent.", true);
    }
  });
}

globalThis.addEventListener("pagehide", () => {
  pageActive = false;
  connectAttempt += 1;
  void controller?.stop("pagehide");
}, { once: true });

render();
