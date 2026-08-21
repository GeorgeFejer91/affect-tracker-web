import { nativeApi } from "./native.js";
import { createFlubberRenderer } from "./render.js";

const bindingLabels = {
  increaseValence: "Increase valence",
  decreaseValence: "Decrease valence",
  increaseArousal: "Increase arousal",
  decreaseArousal: "Decrease arousal",
  reset: "Reset to neutral",
  togglePause: "Pause or resume",
  showSettings: "Show settings",
  toggleOverlayEditing: "Enable or disable overlay dragging",
};

const elements = {
  form: document.querySelector("#settings-form"),
  bindingGrid: document.querySelector("#binding-grid"),
  valence: document.querySelector("#valence-output"),
  arousal: document.querySelector("#arousal-output"),
  lslStatus: document.querySelector("#lsl-status"),
  dirtyStatus: document.querySelector("#dirty-status"),
  live: document.querySelector("#live-region"),
  pause: document.querySelector("#pause-button"),
  overlayVisible: document.querySelector("#overlay-visible-button"),
  overlayEdit: document.querySelector("#overlay-edit-button"),
  lslToggle: document.querySelector("#lsl-toggle-button"),
};

const renderFlubber = createFlubberRenderer(document.querySelector(".flubber-preview"));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let settings;
let latestSnapshot;

function announce(message) {
  elements.live.textContent = "";
  requestAnimationFrame(() => { elements.live.textContent = message; });
}

function formatCoordinate(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  renderFlubber(snapshot, reducedMotion.matches);
  elements.valence.textContent = formatCoordinate(snapshot.currentX);
  elements.arousal.textContent = formatCoordinate(snapshot.currentY);
  elements.pause.textContent = snapshot.animationActive ? "Pause motion" : "Resume motion";
  elements.overlayVisible.textContent = snapshot.overlayVisible ? "Hide overlay" : "Show overlay";
  elements.overlayEdit.textContent = snapshot.overlayEditing ? "Lock overlay (click-through)" : "Enable overlay dragging";
  elements.lslStatus.textContent = snapshot.lslMessage;
  elements.lslStatus.classList.toggle("is-ok", snapshot.lslState === "running");
  elements.lslStatus.classList.toggle("is-error", snapshot.lslState === "error");
  elements.lslToggle.textContent = snapshot.lslState === "running" ? "Stop LSL" : "Start LSL";
}

function createBindingInputs(bindings) {
  elements.bindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(bindingLabels)) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.dataset.binding = action;
    input.value = bindings[action] ?? "";
    input.maxLength = 80;
    input.autocomplete = "off";
    wrapper.append(input);
    elements.bindingGrid.append(wrapper);
  }
}

function fillForm(value) {
  settings = structuredClone(value);
  document.querySelector("#input-mode").value = value.inputMode;
  document.querySelector("#step-size").value = value.stepSize;
  document.querySelector("#continuous-speed").value = value.continuousSpeed;
  document.querySelector("#response").value = value.response;
  document.querySelector("#overlay-size").value = value.overlay.size;
  document.querySelector("#overlay-opacity").value = value.overlay.opacity;
  document.querySelector("#lsl-stream-name").value = value.lsl.streamName;
  document.querySelector("#lsl-stream-type").value = value.lsl.streamType;
  document.querySelector("#lsl-marker-name").value = value.lsl.markerName;
  document.querySelector("#lsl-sample-rate").value = value.lsl.sampleRate;
  document.querySelector("#lsl-source-id").value = value.lsl.sourceId;
  document.querySelector("#lsl-start-enabled").checked = value.lsl.startEnabled;
  createBindingInputs(value.bindings);
  elements.dirtyStatus.textContent = "Settings loaded";
}

function readForm() {
  const bindings = {};
  for (const input of document.querySelectorAll("[data-binding]")) bindings[input.dataset.binding] = input.value.trim();
  return {
    ...settings,
    inputMode: document.querySelector("#input-mode").value,
    stepSize: Number(document.querySelector("#step-size").value),
    continuousSpeed: Number(document.querySelector("#continuous-speed").value),
    response: Number(document.querySelector("#response").value),
    bindings,
    overlay: {
      ...settings.overlay,
      size: Number(document.querySelector("#overlay-size").value),
      opacity: Number(document.querySelector("#overlay-opacity").value),
    },
    lsl: {
      streamName: document.querySelector("#lsl-stream-name").value.trim(),
      streamType: document.querySelector("#lsl-stream-type").value.trim(),
      markerName: document.querySelector("#lsl-marker-name").value.trim(),
      sampleRate: Number(document.querySelector("#lsl-sample-rate").value),
      sourceId: document.querySelector("#lsl-source-id").value.trim(),
      startEnabled: document.querySelector("#lsl-start-enabled").checked,
    },
  };
}

async function invokeWithFeedback(operation, successMessage) {
  try {
    const result = await operation();
    if (result?.currentX !== undefined) renderSnapshot(result);
    if (successMessage) announce(successMessage);
    return result;
  } catch (error) {
    const message = error?.message ?? String(error);
    announce(message);
    elements.dirtyStatus.textContent = message;
    throw error;
  }
}

async function initialize() {
  fillForm(await nativeApi.getSettings());
  renderSnapshot(await nativeApi.getSnapshot());
  await nativeApi.onSnapshot(renderSnapshot);

  elements.form.addEventListener("input", () => { elements.dirtyStatus.textContent = "Unsaved changes"; });
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saved = await invokeWithFeedback(() => nativeApi.saveSettings(readForm()), "Settings saved and applied.");
    fillForm(saved);
  });

  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => invokeWithFeedback(() => nativeApi.nudgeAction(button.dataset.action)));
  }
  document.querySelector("#reset-button").addEventListener("click", () => invokeWithFeedback(nativeApi.reset, "Returned to neutral."));
  elements.pause.addEventListener("click", () => invokeWithFeedback(nativeApi.togglePause));
  elements.overlayVisible.addEventListener("click", () => invokeWithFeedback(() => nativeApi.setOverlayVisible(!latestSnapshot.overlayVisible)));
  elements.overlayEdit.addEventListener("click", () => invokeWithFeedback(() => nativeApi.setOverlayEditing(!latestSnapshot.overlayEditing)));
  elements.lslToggle.addEventListener("click", () => invokeWithFeedback(() => nativeApi.setLslEnabled(latestSnapshot.lslState !== "running")));
}

initialize().catch((error) => {
  elements.dirtyStatus.textContent = `Startup failed: ${error?.message ?? error}`;
});
