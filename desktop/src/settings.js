import { nativeApi } from "./native.js";
import { createFlubberRenderer } from "./render.js";
import { affectPaletteColor } from "../../site/src/math.js";
import {
  ADVANCED_BINDING_LABELS,
  BINDING_LABELS,
  describeBinding,
  mouseButtonName,
  opacityToTransparencyPercent,
  portableSettingsJson,
  transparencyPercentToOpacity,
  wheelDirection,
} from "../../site/src/portable-settings.js";

const elements = {
  form: document.querySelector("#settings-form"),
  bindingGrid: document.querySelector("#binding-grid"),
  advancedBindingGrid: document.querySelector("#advanced-binding-grid"),
  valence: document.querySelector("#valence-output"),
  arousal: document.querySelector("#arousal-output"),
  lslStatus: document.querySelector("#lsl-status"),
  dirtyStatus: document.querySelector("#dirty-status"),
  live: document.querySelector("#live-region"),
  pause: document.querySelector("#pause-button"),
  overlayVisible: document.querySelector("#overlay-visible-button"),
  overlayEdit: document.querySelector("#overlay-edit-button"),
  featureMap: document.querySelector("#feature-space-map"),
  featureCanvas: document.querySelector("#feature-space-canvas"),
  featurePoint: document.querySelector("#feature-space-point"),
  transparency: document.querySelector("#overlay-transparency"),
  transparencyOutput: document.querySelector("#overlay-transparency-output"),
  importFile: document.querySelector("#settings-import-file"),
  importButton: document.querySelector("#settings-import-button"),
  exportButton: document.querySelector("#settings-export-button"),
};

const renderFlubber = createFlubberRenderer(document.querySelector(".flubber-preview"));
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let settings;
let latestSnapshot;
let captureInput;
let featurePointerId;

function finishCapture(value) {
  if (!captureInput) return;
  const conflict = [...document.querySelectorAll("[data-binding]")]
    .find((input) => input !== captureInput && input.dataset.bindingValue?.toLowerCase() === value.toLowerCase());
  if (conflict) {
    const label = BINDING_LABELS[conflict.dataset.binding] ?? ADVANCED_BINDING_LABELS[conflict.dataset.binding];
    captureInput.value = captureInput.dataset.bindingValue ? describeBinding(captureInput.dataset.bindingValue) : "";
    captureInput.classList.remove("is-capturing");
    captureInput = undefined;
    announce(`That input is already assigned to ${label}.`);
    return;
  }
  captureInput.dataset.bindingValue = value;
  captureInput.value = describeBinding(value);
  captureInput.classList.remove("is-capturing");
  captureInput.dispatchEvent(new Event("input", { bubbles: true }));
  const clearButton = captureInput.closest(".advanced-binding-field")?.querySelector("button");
  if (clearButton) clearButton.disabled = false;
  announce(`${captureInput.closest("label").firstChild.textContent.trim()} assigned to ${describeBinding(value)}.`);
  captureInput = undefined;
}

function beginCapture(input) {
  if (captureInput && captureInput !== input) {
    captureInput.value = describeBinding(captureInput.dataset.bindingValue);
    captureInput.classList.remove("is-capturing");
  }
  captureInput = input;
  input.value = "Press, click, or scroll…";
  input.classList.add("is-capturing");
  announce("Waiting for a keyboard, mouse-button, or wheel input.");
}

function readPalette() {
  return Object.fromEntries(["up", "down", "left", "right"].map((name) => [name, document.querySelector(`#palette-${name}`).value]));
}

function updateFeatureSpace(snapshot, palette = snapshot.palette) {
  for (const [name, color] of Object.entries(palette)) elements.featureMap.style.setProperty(`--palette-${name}`, color);
  const paletteKey = JSON.stringify(palette);
  if (elements.featureCanvas.dataset.palette !== paletteKey) {
    const context = elements.featureCanvas.getContext("2d");
    const image = context.createImageData(elements.featureCanvas.width, elements.featureCanvas.height);
    for (let py = 0; py < elements.featureCanvas.height; py += 1) {
      for (let px = 0; px < elements.featureCanvas.width; px += 1) {
        const color = affectPaletteColor(px / (elements.featureCanvas.width - 1) * 2 - 1, 1 - py / (elements.featureCanvas.height - 1) * 2, palette);
        const [red, green, blue] = color.match(/\d+/g).map(Number);
        const offset = (py * elements.featureCanvas.width + px) * 4;
        image.data.set([red, green, blue, 255], offset);
      }
    }
    context.putImageData(image, 0, 0);
    elements.featureCanvas.dataset.palette = paletteKey;
  }
  elements.featurePoint.style.left = `${(snapshot.currentX + 1) * 50}%`;
  elements.featurePoint.style.top = `${(1 - snapshot.currentY) * 50}%`;
  elements.featureMap.setAttribute("aria-valuetext", `Valence ${formatCoordinate(snapshot.targetX)}, arousal ${formatCoordinate(snapshot.targetY)}`);
}

function chooseFeatureCoordinate(event) {
  const bounds = elements.featureMap.getBoundingClientRect();
  const x = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1));
  const y = Math.max(-1, Math.min(1, 1 - ((event.clientY - bounds.top) / bounds.height) * 2));
  invokeWithFeedback(() => nativeApi.setAffectTarget(x, y));
}

function announce(message) {
  elements.live.textContent = "";
  requestAnimationFrame(() => { elements.live.textContent = message; });
}

function formatCoordinate(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  if (settings && elements.dirtyStatus.textContent === "Settings loaded") {
    settings.visual.animationSpeed = snapshot.animationSpeed;
    settings.visual.amplitudeScale = snapshot.amplitudeScale;
    settings.visual.disorderScale = snapshot.disorderScale;
    settings.visual.baseShape = snapshot.baseShape;
    settings.overlay.opacity = snapshot.overlayOpacity;
    settings.overlay.size = snapshot.overlaySize;
    document.querySelector("#animation-speed").value = snapshot.animationSpeed;
    document.querySelector("#amplitude-scale").value = snapshot.amplitudeScale;
    document.querySelector("#disorder-scale").value = snapshot.disorderScale;
    document.querySelector("#base-shape").value = snapshot.baseShape;
    document.querySelector("#overlay-size").value = snapshot.overlaySize;
    elements.transparency.value = opacityToTransparencyPercent(snapshot.overlayOpacity);
    elements.transparencyOutput.value = `${elements.transparency.value}%`;
  }
  const palette = settings ? readPalette() : snapshot.palette;
  const overlayOpacity = settings ? transparencyPercentToOpacity(elements.transparency.value) : snapshot.overlayOpacity;
  const visualPreview = settings ? {
    amplitudeScale: Number(document.querySelector("#amplitude-scale").value),
    disorderScale: Number(document.querySelector("#disorder-scale").value),
    baseShape: document.querySelector("#base-shape").value,
  } : {};
  renderFlubber({ ...snapshot, ...visualPreview, palette, overlayOpacity }, reducedMotion.matches);
  updateFeatureSpace(snapshot, palette);
  elements.valence.textContent = formatCoordinate(snapshot.currentX);
  elements.arousal.textContent = formatCoordinate(snapshot.currentY);
  elements.pause.textContent = snapshot.animationActive ? "Pause motion" : "Resume motion";
  elements.overlayVisible.textContent = snapshot.overlayVisible ? "Hide overlay" : "Show overlay";
  elements.overlayEdit.textContent = snapshot.overlayEditing ? "Lock overlay (click-through)" : "Enable overlay dragging";
  elements.lslStatus.textContent = snapshot.lslMessage;
  elements.lslStatus.classList.toggle("is-ok", snapshot.lslState === "running");
  elements.lslStatus.classList.toggle("is-error", snapshot.lslState === "error");
}

function createBindingInputs(bindings) {
  elements.bindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(BINDING_LABELS)) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.dataset.binding = action;
    input.dataset.bindingGroup = "core";
    input.dataset.bindingValue = bindings[action] ?? "";
    input.value = describeBinding(input.dataset.bindingValue);
    input.readOnly = true;
    input.autocomplete = "off";
    input.addEventListener("click", () => beginCapture(input));
    wrapper.append(input);
    elements.bindingGrid.append(wrapper);
  }

  elements.advancedBindingGrid.replaceChildren();
  for (const [action, label] of Object.entries(ADVANCED_BINDING_LABELS)) {
    const row = document.createElement("div");
    row.className = "advanced-binding-field";
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.dataset.binding = action;
    input.dataset.bindingGroup = "advanced";
    input.dataset.bindingValue = settings?.advancedBindings?.[action] ?? "";
    input.value = input.dataset.bindingValue ? describeBinding(input.dataset.bindingValue) : "";
    input.placeholder = "Unassigned";
    input.readOnly = true;
    input.autocomplete = "off";
    input.addEventListener("click", () => beginCapture(input));
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.disabled = !input.dataset.bindingValue;
    clear.addEventListener("click", () => {
      input.dataset.bindingValue = "";
      input.value = "";
      clear.disabled = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      announce(`${label} assignment cleared.`);
    });
    wrapper.append(input);
    row.append(wrapper, clear);
    elements.advancedBindingGrid.append(row);
  }
}

function fillForm(value) {
  settings = structuredClone(value);
  document.querySelector("#input-mode").value = value.inputMode;
  document.querySelector("#step-size").value = value.stepSize;
  document.querySelector("#continuous-speed").value = value.continuousSpeed;
  document.querySelector("#response").value = value.response;
  document.querySelector("#animation-speed").value = value.visual.animationSpeed;
  document.querySelector("#amplitude-scale").value = value.visual.amplitudeScale;
  document.querySelector("#disorder-scale").value = value.visual.disorderScale;
  document.querySelector("#base-shape").value = value.visual.baseShape;
  document.querySelector("#overlay-size").value = value.overlay.size;
  elements.transparency.value = opacityToTransparencyPercent(value.overlay.opacity);
  elements.transparencyOutput.value = `${elements.transparency.value}%`;
  document.querySelector("#lsl-stream-name").value = value.lsl.streamName;
  document.querySelector("#lsl-stream-type").value = value.lsl.streamType;
  document.querySelector("#lsl-marker-name").value = value.lsl.markerName;
  document.querySelector("#lsl-sample-rate").value = value.lsl.sampleRate;
  document.querySelector("#lsl-source-id").value = value.lsl.sourceId;
  for (const [name, color] of Object.entries(value.palette)) document.querySelector(`#palette-${name}`).value = color;
  createBindingInputs(value.bindings);
  elements.dirtyStatus.textContent = "Settings loaded";
}

function readForm(currentSettings = settings) {
  const bindings = {};
  const advancedBindings = {};
  for (const input of document.querySelectorAll("[data-binding]")) {
    if (input.dataset.bindingGroup === "advanced") {
      if (input.dataset.bindingValue) advancedBindings[input.dataset.binding] = input.dataset.bindingValue;
    } else {
      bindings[input.dataset.binding] = input.dataset.bindingValue;
    }
  }
  return {
    ...currentSettings,
    inputMode: document.querySelector("#input-mode").value,
    stepSize: Number(document.querySelector("#step-size").value),
    continuousSpeed: Number(document.querySelector("#continuous-speed").value),
    response: Number(document.querySelector("#response").value),
    bindings,
    advancedBindings,
    visual: {
      animationSpeed: Number(document.querySelector("#animation-speed").value),
      amplitudeScale: Number(document.querySelector("#amplitude-scale").value),
      disorderScale: Number(document.querySelector("#disorder-scale").value),
      baseShape: document.querySelector("#base-shape").value,
    },
    palette: readPalette(),
    overlay: {
      ...currentSettings.overlay,
      size: Number(document.querySelector("#overlay-size").value),
      opacity: transparencyPercentToOpacity(elements.transparency.value),
    },
    lsl: {
      streamName: document.querySelector("#lsl-stream-name").value.trim(),
      streamType: document.querySelector("#lsl-stream-type").value.trim(),
      markerName: document.querySelector("#lsl-marker-name").value.trim(),
      sampleRate: Number(document.querySelector("#lsl-sample-rate").value),
      sourceId: document.querySelector("#lsl-source-id").value.trim(),
    },
  };
}

async function saveForm() {
  const currentSettings = await nativeApi.getSettings();
  return nativeApi.saveSettings(readForm(currentSettings));
}

function downloadSettings(value) {
  const blob = new Blob([portableSettingsJson(value)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "affect-tracker-settings-v1.json";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importSettingsFile(file) {
  if (!file) return;
  if (file.size > 256 * 1024) throw new Error("Settings JSON must be smaller than 256 KB.");
  const parsed = JSON.parse(await file.text());
  const saved = await nativeApi.saveSettings(parsed);
  fillForm(saved);
  if (latestSnapshot) renderSnapshot(latestSnapshot);
  announce("Settings JSON imported, validated, and applied.");
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
  elements.transparency.addEventListener("input", () => {
    elements.transparencyOutput.value = `${elements.transparency.value}%`;
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  });
  for (const input of document.querySelectorAll("input[type='color']")) {
    input.addEventListener("input", () => {
      if (latestSnapshot) renderSnapshot(latestSnapshot);
    });
  }
  for (const input of [document.querySelector("#amplitude-scale"), document.querySelector("#disorder-scale")]) {
    input.addEventListener("input", () => {
      if (latestSnapshot && input.checkValidity()) renderSnapshot(latestSnapshot);
    });
  }
  document.querySelector("#base-shape").addEventListener("change", () => {
    if (latestSnapshot) renderSnapshot(latestSnapshot);
  });
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saved = await invokeWithFeedback(saveForm, "Settings saved and applied.");
    fillForm(saved);
  });

  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => invokeWithFeedback(() => nativeApi.nudgeAction(button.dataset.action)));
  }
  document.querySelector("#reset-button").addEventListener("click", () => invokeWithFeedback(nativeApi.reset, "Returned to neutral."));
  elements.pause.addEventListener("click", () => invokeWithFeedback(nativeApi.togglePause));
  elements.overlayVisible.addEventListener("click", () => invokeWithFeedback(() => nativeApi.setOverlayVisible(!latestSnapshot.overlayVisible)));
  elements.overlayEdit.addEventListener("click", () => invokeWithFeedback(() => nativeApi.setOverlayEditing(!latestSnapshot.overlayEditing)));
  elements.exportButton.addEventListener("click", async () => {
    const saved = await invokeWithFeedback(saveForm, "Settings saved and exported.");
    fillForm(saved);
    downloadSettings(saved);
  });
  elements.importButton.addEventListener("click", () => elements.importFile.click());
  elements.importFile.addEventListener("change", async () => {
    try {
      await importSettingsFile(elements.importFile.files?.[0]);
    } catch (error) {
      announce(error?.message ?? String(error));
      elements.dirtyStatus.textContent = error?.message ?? String(error);
    } finally {
      elements.importFile.value = "";
    }
  });
  elements.featureMap.addEventListener("pointerdown", (event) => {
    featurePointerId = event.pointerId;
    elements.featureMap.setPointerCapture(event.pointerId);
    chooseFeatureCoordinate(event);
  });
  elements.featureMap.addEventListener("pointermove", (event) => {
    if (event.pointerId === featurePointerId) chooseFeatureCoordinate(event);
  });
  const finishFeatureSelection = (event) => {
    if (event.pointerId === featurePointerId) featurePointerId = undefined;
  };
  elements.featureMap.addEventListener("pointerup", finishFeatureSelection);
  elements.featureMap.addEventListener("pointercancel", finishFeatureSelection);
  elements.featureMap.addEventListener("keydown", (event) => {
    const direction = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[event.key];
    if (!direction) return;
    event.preventDefault();
    invokeWithFeedback(() => nativeApi.setAffectTarget(latestSnapshot.targetX + direction[0], latestSnapshot.targetY + direction[1]));
  });
}

document.addEventListener("keydown", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishCapture(`key:${event.code}`);
}, true);

document.addEventListener("mousedown", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishCapture(`mouse:${mouseButtonName(event.button)}`);
}, true);

document.addEventListener("wheel", (event) => {
  if (!captureInput) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  finishCapture(`wheel:${wheelDirection(event.deltaX, event.deltaY)}`);
}, { capture: true, passive: false });

document.addEventListener("contextmenu", (event) => {
  if (captureInput) event.preventDefault();
}, true);

initialize().catch((error) => {
  elements.dirtyStatus.textContent = `Startup failed: ${error?.message ?? error}`;
});
