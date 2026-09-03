import { StudyDraftStore } from "./draft-store.js";
import { createInstructionAffectComparison } from "./affect-comparison.js";
import {
  PORTABLE_BLOCK_TYPES,
  PORTABLE_QUESTION_TYPES,
  cloneStudy,
  createBlock,
  createDefaultStudy,
  createQuestionnaireItem,
  declaredCompatibility,
  portableBlockTypeLabel,
  portableQuestionTypeLabel,
  studyIdentifier,
} from "./schema.js";
import { loadStudyCore } from "./core-adapter.js";
import {
  branchSourceCandidates,
  canAddCompletionBlock,
  canRemoveCompletionBlock,
  createDefaultRunCondition,
  instructionPreviewCandidates,
  isTerminalCompletionBlock,
  orderPolicyLabel,
  preferredInstructionPreview,
  questionnaireItemBranchIssues,
  runConditionLiteralIssue,
  selectionAfterSwap,
  setRunConditionExpectedValue,
  studyHasCompletionBlock,
  swapItems,
} from "./flow-model.js";
import { installPartialRunRecoveryUi } from "./partial-recovery-ui.js";
import { launchParticipantRun } from "./participant-ui.js";

const root = document.querySelector("#study-app");
const surface = root.dataset.studySurface === "desktop" ? "desktop" : "pages";
const STEP_DEFINITIONS = Object.freeze([
  ["details", "Study details"],
  ["assets", "Asset library"],
  ["sequence", "Sequence"],
  ["questionnaires", "Questionnaires"],
  ["ordering", "Randomization"],
  ["validation", "Compatibility"],
  ["preview", "Preview and publish"],
  ...(surface === "desktop" ? [["remote", "Remote Control"]] : []),
]);
const assetBindings = new Map();

let core;
let draftStore;
let study;
let draftRevision = 0;
let activeStep = "details";
let selectedBlock = { section: 0, trial: 0, block: 0 };
let selectedQuestionnaire = 0;
let selectedItem = 0;
let selectedPreviewInstructionId;
let saveTimer;
let lastValidation;
let comparison;
let comparisonFrameId;
let comparisonStartedAt;
let remoteControlUi;
let partialRecoveryUi;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function download(name, content, type = "application/json;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function announce(message) {
  const region = document.querySelector("#study-live-region");
  if (!region) return;
  region.textContent = "";
  requestAnimationFrame(() => { region.textContent = message; });
}

function loadInitialStudy() {
  const drafts = [...draftStore.listDrafts()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (drafts.length) {
    draftRevision = drafts[0].revision;
    return cloneStudy(drafts[0].studyDefinition);
  }
  return createDefaultStudy();
}

function saveNow() {
  clearTimeout(saveTimer);
  try {
    // Draft-store revisions are optimistic generations and protocol revision
    // candidates. Keeping the contract field aligned prevents a published
    // record from claiming a different revision than its immutable payload.
    study.revision = draftRevision + 1;
    delete study.protocolHash;
    const saved = draftStore.saveDraft({
      studyId: study.studyId,
      studyDefinition: study,
      expectedRevision: draftRevision,
    });
    draftRevision = saved.revision;
    updateSaveStatus(`Draft saved locally · revision ${draftRevision}`);
  } catch (error) {
    updateSaveStatus(`Draft not saved: ${error?.message ?? error}`, true);
  }
}

function scheduleSave() {
  updateSaveStatus("Saving draft…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 450);
}

function updateSaveStatus(message, error = false) {
  const output = document.querySelector("#study-save-status");
  if (!output) return;
  output.textContent = message;
  output.dataset.error = String(error);
}

function renderShell() {
  const authorityLabel = core.implementation === "native-rust"
    ? "native Rust authority ready"
    : core.implementation === "wasm"
      ? "shared Rust/WASM core loaded"
      : "designer precheck only";
  root.innerHTML = `
    <div class="study-shell">
      <header class="study-header">
        <div>
          <h1>Affect Tracker Study Studio</h1>
          <p>${surface === "desktop" ? "Desktop authority" : "GitHub Pages browser authority"} · ${authorityLabel}</p>
        </div>
        <div class="study-header-actions">
          <input id="study-import-file" type="file" accept="application/json,.json" hidden>
          <button id="study-import" type="button">Import JSON</button>
          <button id="study-export" type="button">Export draft</button>
          <a class="study-button" href="${surface === "desktop" ? "index.html" : "index.html"}">Back to tracker</a>
        </div>
      </header>
      <div class="study-recovery-mount" data-study-recovery-mount aria-live="polite"></div>
      <div class="study-layout">
        <nav class="study-nav" aria-label="Study designer steps">
          <ol>${STEP_DEFINITIONS.map(([id, label], index) => `
            <li><button type="button" data-step="${id}"${id === activeStep ? ' aria-current="step"' : ""}>${index + 1}. ${label}</button></li>`).join("")}</ol>
        </nav>
        <main id="study-main" class="study-main"></main>
      </div>
      <p id="study-live-region" class="study-live-region" aria-live="polite"></p>
    </div>`;

  root.querySelector("#study-import").addEventListener("click", () => root.querySelector("#study-import-file").click());
  root.querySelector("#study-import-file").addEventListener("change", importStudy);
  root.querySelector("#study-export").addEventListener("click", () => {
    download(`${study.studyId}-draft.json`, `${JSON.stringify(study, null, 2)}\n`);
    announce("Study draft exported.");
  });
  for (const button of root.querySelectorAll("[data-step]")) {
    button.addEventListener("click", () => {
      activeStep = button.dataset.step;
      renderShell();
      renderStep();
    });
  }
  refreshStudyRecoveryNotice();
}

export function refreshStudyRecoveryNotice() {
  const mount = root.querySelector("[data-study-recovery-mount]");
  root.dispatchEvent(new CustomEvent("study:recovery-refresh", { detail: { mount } }));
  return mount;
}

function renderStep() {
  stopComparison();
  const renderers = {
    details: renderDetails,
    assets: renderAssets,
    sequence: renderSequence,
    questionnaires: renderQuestionnaires,
    ordering: renderOrdering,
    validation: renderValidation,
    preview: renderPreview,
    remote: renderRemoteControl,
  };
  renderers[activeStep]();
}

async function renderRemoteControl() {
  const host = document.querySelector("#study-main");
  if (surface !== "desktop") {
    host.innerHTML = '<section class="study-step"><h2>Remote Control</h2><p>Remote Control is available only from the desktop Study Studio.</p></section>';
    return;
  }
  host.innerHTML = '<section class="study-step"><h2>Remote Control</h2><p class="study-status" aria-busy="true">Loading the desktop-only controller target…</p></section>';
  try {
    const controllerUi = await ensureRemoteControlUi();
    if (activeStep !== "remote") return;
    controllerUi.mount(host);
  } catch (error) {
    host.innerHTML = `<section class="study-step"><h2>Remote Control</h2><p class="study-status" data-error="true">${escapeHtml(error?.message ?? error)}</p></section>`;
  }
}

async function ensureRemoteControlUi() {
  if (surface !== "desktop") return undefined;
  if (remoteControlUi) return remoteControlUi;
  const [{ invoke }, { createDesktopQuickPairUi }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("../remote-study/desktop-quick-pair-ui.js"),
  ]);
  remoteControlUi = createDesktopQuickPairUi({ invoke, authorityBridge: core, announce });
  return remoteControlUi;
}

function stepFrame(title, description, content) {
  document.querySelector("#study-main").innerHTML = `
    <section class="study-step">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(description)}</p>
      ${content}
      <div class="study-run-toolbar">
        <output id="study-save-status" class="study-status">Draft revision ${draftRevision}</output>
        <div class="study-actions">
          <button id="study-save-now" type="button">Save draft now</button>
          ${activeStep !== "preview" ? '<button id="study-next" type="button" data-variant="primary">Continue</button>' : ""}
        </div>
      </div>
    </section>`;
  document.querySelector("#study-save-now").addEventListener("click", saveNow);
  document.querySelector("#study-next")?.addEventListener("click", () => {
    const current = STEP_DEFINITIONS.findIndex(([id]) => id === activeStep);
    activeStep = STEP_DEFINITIONS[Math.min(current + 1, STEP_DEFINITIONS.length - 1)][0];
    renderShell();
    renderStep();
  });
}

function renderDetails() {
  const visual = study.pinnedSettings.visual;
  const acquisition = study.pinnedSettings.acquisition;
  stepFrame("Study details", "Name the study and pin the acquisition and visual settings used by every run.", `
    <form id="study-details-form" class="study-form-grid">
      <label class="study-field"><span>Study title</span><input name="title" required maxlength="160" value="${escapeHtml(study.title)}"></label>
      <label class="study-field"><span>Study ID</span><input name="studyId" required maxlength="96" value="${escapeHtml(study.studyId)}" readonly><span class="study-help">Stable after the first draft is created.</span></label>
      <label class="study-field study-wide"><span>Description</span><textarea name="description" maxlength="4000">${escapeHtml(study.description)}</textarea></label>
      <label class="study-field"><span>Sample rate</span><select name="sampleRateHz">${[10, 20, 25, 50, 100].map((rate) => option(String(rate), `${rate} Hz`, String(acquisition.sampleRateHz))).join("")}</select></label>
      <label class="study-field"><span>Affect reset</span><select name="resetPolicy">${option("neutralAtRunStart", "Reset to neutral at run start", acquisition.resetPolicy)}${option("requireCalibration", "Require pre-run calibration", acquisition.resetPolicy)}</select></label>
      <label class="study-field"><span>Flubber shape</span><select name="baseShape">${["circle", "heart", "triangle", "square"].map((shape) => option(shape, shape[0].toUpperCase() + shape.slice(1), visual.baseShape)).join("")}</select></label>
      <label class="study-field"><span>Widget scale</span><input name="widgetScale" type="number" min="0.25" max="2" step="0.05" value="${visual.widgetScale}"></label>
    </form>`);
  const form = document.querySelector("#study-details-form");
  form.addEventListener("input", () => {
    const values = new FormData(form);
    study.title = String(values.get("title"));
    study.description = String(values.get("description"));
    study.pinnedSettings.acquisition.sampleRateHz = Number(values.get("sampleRateHz"));
    study.pinnedSettings.acquisition.resetPolicy = String(values.get("resetPolicy"));
    study.pinnedSettings.visual.baseShape = String(values.get("baseShape"));
    study.pinnedSettings.visual.widgetScale = Number(values.get("widgetScale"));
    scheduleSave();
  });
}

async function mediaMetadata(file) {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise((resolve, reject) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", () => reject(new Error("The selected video metadata could not be read.")), { once: true });
    });
    return { durationMs: Math.round(video.duration * 1000) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addMediaFile(file) {
  if (!file) return;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const assetId = `asset-${sha256.slice(0, 16)}`;
  const metadata = await mediaMetadata(file);
  const descriptor = {
    assetId,
    sha256,
    byteLength: file.size,
    mimeType: file.type || "application/octet-stream",
    container: file.name.split(".").at(-1)?.toLowerCase() || "unknown",
    durationMs: metadata.durationMs,
    // Browsers do not expose a portable, dependable audio-track probe. Keep
    // this deliberately incomplete until the researcher confirms it below.
    hasAudio: null,
    projection: "flat",
    stereoLayout: "mono",
    requiredCapabilities: ["contentAddressedMedia"],
  };
  const existing = study.media.findIndex(({ assetId: current }) => current === assetId);
  if (existing >= 0) study.media[existing] = descriptor;
  else study.media.push(descriptor);
  assetBindings.set(assetId, file);
  scheduleSave();
  renderAssets();
  announce(`${file.name} was hashed and bound as ${assetId}.`);
}

function renderAssets() {
  stepFrame("Asset library", "Select local media, verify it by SHA-256, and reference only its opaque asset ID in the protocol.", `
    <div class="study-inline-actions">
      <input id="study-media-file" type="file" accept="video/*" hidden>
      <button id="study-add-media" type="button" data-variant="primary">Select and hash video</button>
    </div>
    <p class="study-help">${surface === "desktop" ? "The desktop vault import will copy verified media into app-owned storage." : "Pages keeps the selected File only for this tab. Select it again after a reload; native paths are never stored."} Confirm audio presence and the projection/stereo layout before validation; browsers cannot reliably infer every media track layout.</p>
    <div class="study-table-wrap"><table class="study-table">
      <thead><tr><th>Asset ID</th><th>Type</th><th>Duration</th><th>Audio track</th><th>Projection</th><th>Stereo</th><th>SHA-256</th><th>Binding</th><th></th></tr></thead>
      <tbody>${study.media.length ? study.media.map((asset, index) => `<tr>
        <td>${escapeHtml(asset.assetId)}</td><td>${escapeHtml(asset.mimeType)}</td><td>${(asset.durationMs / 1000).toFixed(1)} s</td>
        <td><select data-asset-audio="${index}" aria-label="Audio presence for ${escapeHtml(asset.assetId)}">${option("", "Confirm…", asset.hasAudio === null ? "" : String(asset.hasAudio))}${option("true", "Present", String(asset.hasAudio))}${option("false", "None", String(asset.hasAudio))}</select></td>
        <td><select data-asset-projection="${index}" aria-label="Projection for ${escapeHtml(asset.assetId)}">${option("flat", "Flat", asset.projection)}${option("equirectangular180", "180°", asset.projection)}${option("equirectangular360", "360°", asset.projection)}</select></td>
        <td><select data-asset-stereo="${index}" aria-label="Stereo layout for ${escapeHtml(asset.assetId)}">${option("mono", "Mono", asset.stereoLayout)}${option("sideBySideLeftRight", "Side-by-side L/R", asset.stereoLayout)}${option("topBottom", "Top/bottom", asset.stereoLayout)}</select></td>
        <td><code>${escapeHtml(asset.sha256.slice(0, 16))}…</code></td>
        <td>${assetBindings.has(asset.assetId) ? "Selected now" : "Select before run"}</td>
        <td><button type="button" data-remove-asset="${index}" data-variant="danger">Remove</button></td>
      </tr>`).join("") : '<tr><td colspan="9">No media assets yet.</td></tr>'}</tbody>
    </table></div>`);
  document.querySelector("#study-add-media").addEventListener("click", () => document.querySelector("#study-media-file").click());
  document.querySelector("#study-media-file").addEventListener("change", async (event) => {
    try { await addMediaFile(event.target.files?.[0]); } catch (error) { announce(error?.message ?? String(error)); }
  });
  for (const button of document.querySelectorAll("[data-remove-asset]")) {
    button.addEventListener("click", () => {
      const [removed] = study.media.splice(Number(button.dataset.removeAsset), 1);
      if (removed) assetBindings.delete(removed.assetId);
      scheduleSave();
      renderAssets();
    });
  }
  for (const select of document.querySelectorAll("[data-asset-audio]")) select.addEventListener("change", () => {
    study.media[Number(select.dataset.assetAudio)].hasAudio = select.value === "" ? null : select.value === "true";
    scheduleSave();
  });
  for (const select of document.querySelectorAll("[data-asset-projection]")) select.addEventListener("change", () => {
    study.media[Number(select.dataset.assetProjection)].projection = select.value;
    scheduleSave();
  });
  for (const select of document.querySelectorAll("[data-asset-stereo]")) select.addEventListener("change", () => {
    study.media[Number(select.dataset.assetStereo)].stereoLayout = select.value;
    scheduleSave();
  });
}

function blockSummary(block) {
  if (block.type === "instruction") return `${block.presentation === "faceFlubberComparison" ? "Face + Flubber · " : ""}${block.content}`;
  if (block.type === "video") return `${block.purpose} · ${block.source?.assetId ?? block.source?.videoId ?? "unbound"}`;
  if (block.type === "questionnaire") return block.questionnaireId;
  return block.content;
}

function trialHasCompletion(trial) {
  return trial.blocks.some(({ type }) => type === "completion");
}

function sectionHasCompletion(section) {
  return section.trials.some(trialHasCompletion);
}

function completionSectionHelp(section, sectionIndex) {
  let hasMisplaced = false;
  for (const [trialIndex, trial] of section.trials.entries()) {
    for (const [blockIndex, block] of trial.blocks.entries()) {
      if (block.type === "completion"
        && !isTerminalCompletionBlock(study, sectionIndex, trialIndex, blockIndex)) hasMisplaced = true;
    }
  }
  return hasMisplaced
    ? "This section contains a misplaced Completion. Select its trial and remove that block."
    : "The required completion group stays terminal.";
}

function selectedBlockValue() {
  return study.sections[selectedBlock.section]?.trials[selectedBlock.trial]?.blocks[selectedBlock.block];
}

function flowIdentifier(prefix) {
  return studyIdentifier(prefix).slice(0, 96);
}

function branchSourceKey(source) {
  return `${source.block.blockId}\u001f${source.item.itemId}`;
}

function branchSourceFor(condition, sources) {
  return sources.find(({ block, item }) => (
    block.blockId === condition?.questionnaireBlockId && item.itemId === condition?.itemId
  ));
}

function branchValueEditor(condition, source) {
  const { item } = source;
  if (item.type === "acknowledgement") {
    return '<div class="study-field"><span>Expected answer</span><strong>Acknowledged</strong><span class="study-help">A required acknowledgement can only commit this value.</span></div>';
  }
  if (["singleChoice", "multipleChoice"].includes(item.type)) {
    const selected = condition.operator === "contains" ? condition.optionId : condition.value?.optionId;
    return `<label class="study-field"><span>${item.type === "multipleChoice" ? "Answer must include" : "Expected answer"}</span><select data-branch-value>${item.options.map(({ optionId, label }) => option(optionId, label, selected)).join("")}</select></label>`;
  }
  if (item.type === "likert") {
    const values = Array.from({ length: item.max - item.min + 1 }, (_, index) => item.min + index);
    return `<label class="study-field"><span>Expected scale value</span><select data-branch-value>${values.map((value) => option(String(value), String(value), String(condition.value?.value))).join("")}</select></label>`;
  }
  if (["vas", "numeric"].includes(item.type)) {
    return `<label class="study-field"><span>Expected value</span><input data-branch-value type="number" required min="${item.min}" max="${item.max}" step="${item.step}" value="${condition.value?.value}"><span class="study-help">Use a value on this question's configured step.</span></label>`;
  }
  return `<fieldset class="study-field study-branch-affect"><legend>Expected 2D affect response</legend><label><span>Valence</span><input data-branch-value data-branch-component="valence" type="number" required min="-1" max="1" step="${item.step}" value="${condition.value?.valence}"></label><label><span>Arousal</span><input data-branch-value data-branch-component="arousal" type="number" required min="-1" max="1" step="${item.step}" value="${condition.value?.arousal}"></label></fieldset>`;
}

function branchEditor(sectionIndex, trial) {
  if (trialHasCompletion(trial)) {
    return '<section class="study-section-box study-flow-condition"><h3>Run condition</h3><p>A trial containing Completion cannot have a branch condition. Remove the Completion first if it is misplaced.</p></section>';
  }
  const sources = branchSourceCandidates(study, sectionIndex);
  if (!trial.runIf) {
    return `<section class="study-section-box study-flow-condition"><h3>Run condition</h3><p>This trial always runs. A branch may use one required answer committed in an earlier fixed section.</p><button id="study-add-branch" type="button"${sources.length ? "" : " disabled"}>Add answer condition</button>${sources.length ? "" : '<p class="study-help">Add a required questionnaire answer to an earlier fixed section first. Acknowledgement, choice, Likert, VAS, numeric, and 2D affect questions are supported.</p>'}</section>`;
  }
  const source = branchSourceFor(trial.runIf, sources);
  if (!source) return `<section class="study-section-box study-flow-condition"><h3>Run condition</h3><p data-severity="error">The branch source is no longer eligible. Remove or replace this condition.</p><button id="study-remove-branch" type="button" data-variant="danger">Remove condition</button></section>`;
  const literalIssue = runConditionLiteralIssue(trial.runIf, source.item);
  if (literalIssue) {
    return `<section class="study-section-box study-flow-condition"><h3>Run condition</h3><p data-severity="error">${escapeHtml(literalIssue)} The stored condition has not been changed.</p><div class="study-inline-actions"><button id="study-repair-branch" type="button">Reset expected answer</button><button id="study-remove-branch" type="button" data-variant="danger">Remove condition</button></div></section>`;
  }
  return `<section class="study-section-box study-flow-condition"><h3>Run condition</h3><div class="study-form-grid"><label class="study-field"><span>Earlier required answer</span><select id="study-branch-source">${sources.map((entry) => option(branchSourceKey(entry), `${entry.section.title} › ${entry.trial.label} › ${entry.block.blockId} · ${entry.item.prompt}`, branchSourceKey(source))).join("")}</select></label>${branchValueEditor(trial.runIf, source)}</div><p class="study-help">If the answer matches, this complete trial group runs. The authority evaluates the condition once and records the observed answer and decision.</p><button id="study-remove-branch" type="button" data-variant="danger">Remove condition</button></section>`;
}

function bindBranchEditor(sectionIndex, trial) {
  if (trialHasCompletion(trial)) return;
  const sources = branchSourceCandidates(study, sectionIndex);
  document.querySelector("#study-add-branch")?.addEventListener("click", () => {
    trial.runIf = createDefaultRunCondition(sources[0]);
    scheduleSave();
    renderSequence();
  });
  document.querySelector("#study-remove-branch")?.addEventListener("click", () => {
    delete trial.runIf;
    scheduleSave();
    renderSequence();
  });
  document.querySelector("#study-repair-branch")?.addEventListener("click", () => {
    const source = branchSourceFor(trial.runIf, sources);
    if (!source) return;
    trial.runIf = createDefaultRunCondition(source);
    scheduleSave();
    renderSequence();
  });
  document.querySelector("#study-branch-source")?.addEventListener("change", (event) => {
    const source = sources.find((entry) => branchSourceKey(entry) === event.target.value);
    trial.runIf = createDefaultRunCondition(source);
    scheduleSave();
    renderSequence();
  });
  for (const field of document.querySelectorAll("[data-branch-value]")) field.addEventListener("change", () => {
    if (!field.checkValidity()) {
      field.reportValidity();
      return;
    }
    const source = branchSourceFor(trial.runIf, sources);
    setRunConditionExpectedValue(trial.runIf, source.item, field.dataset.branchComponent, field.value);
    scheduleSave();
  });
}

function renderSequence() {
  selectedBlock.section = Math.min(selectedBlock.section, study.sections.length - 1);
  const section = study.sections[selectedBlock.section];
  selectedBlock.trial = Math.min(selectedBlock.trial, section.trials.length - 1);
  const trial = section.trials[selectedBlock.trial];
  const block = selectedBlockValue() ?? trial.blocks[0];
  selectedBlock.block = Math.max(0, trial.blocks.indexOf(block));
  const completionExists = studyHasCompletionBlock(study);
  const completionCanBeAdded = canAddCompletionBlock(study, selectedBlock.section, selectedBlock.trial);
  const addableBlockTypes = PORTABLE_BLOCK_TYPES.filter((type) => type !== "completion" || completionCanBeAdded);
  const completionHelp = trialHasCompletion(trial)
    ? "A Completion already ends this trial. Remove it if it is misplaced; the valid required terminal Completion stays locked."
    : completionExists
      ? "Completion is already present and is omitted here. Only one terminal Completion is valid."
      : completionCanBeAdded
        ? "Completion is available here because this is the final trial of the final fixed section."
        : "Completion becomes available only in the final trial of the final fixed section.";
  stepFrame("Experiment flow", "Build fixed trial sequences, then randomize or counterbalance the trial groups at section level.", `
    <div class="study-flow-layout">
      <nav class="study-flow-tree" aria-label="Experiment flow">
        ${study.sections.map((entry, sectionIndex) => `<section><div class="study-flow-section-heading"><span><h3>${escapeHtml(entry.title)}</h3><span class="study-badge">${escapeHtml(orderPolicyLabel(entry.orderPolicy.type))}</span></span><span class="study-flow-move"><button type="button" data-move-section="${sectionIndex}" data-direction="-1" aria-label="Move section up"${sectionIndex === 0 || sectionHasCompletion(entry) ? " disabled" : ""}>Up</button><button type="button" data-move-section="${sectionIndex}" data-direction="1" aria-label="Move section down"${sectionIndex === study.sections.length - 1 || sectionHasCompletion(entry) || sectionHasCompletion(study.sections[sectionIndex + 1]) ? " disabled" : ""}>Down</button>${study.sections.length > 1 && !sectionHasCompletion(entry) ? `<button type="button" data-remove-section="${sectionIndex}" data-variant="danger">Remove section</button>` : ""}</span></div><ol>${entry.trials.map((candidate, trialIndex) => `<li><button type="button" data-select-trial="${sectionIndex}:${trialIndex}"${sectionIndex === selectedBlock.section && trialIndex === selectedBlock.trial ? ' aria-current="true"' : ""}><strong>${escapeHtml(candidate.label)}</strong><span>${candidate.blocks.length} ordered block${candidate.blocks.length === 1 ? "" : "s"}${candidate.runIf ? " · conditional" : ""}</span></button><span class="study-flow-move"><button type="button" data-move-trial="${sectionIndex}:${trialIndex}" data-direction="-1" aria-label="Move trial group up"${trialIndex === 0 || trialHasCompletion(candidate) ? " disabled" : ""}>Up</button><button type="button" data-move-trial="${sectionIndex}:${trialIndex}" data-direction="1" aria-label="Move trial group down"${trialIndex === entry.trials.length - 1 || trialHasCompletion(candidate) || trialHasCompletion(entry.trials[trialIndex + 1]) ? " disabled" : ""}>Down</button>${entry.trials.length > 1 && !trialHasCompletion(candidate) ? `<button type="button" data-remove-trial="${sectionIndex}:${trialIndex}" data-variant="danger">Remove</button>` : ""}</span></li>`).join("")}</ol>${sectionHasCompletion(entry) ? `<p class="study-help">${completionSectionHelp(entry, sectionIndex)}</p>` : `<button type="button" data-add-trial="${sectionIndex}">Add trial group</button>`}</section>`).join("")}
        <button id="study-add-section" type="button">Add section</button>
      </nav>
      <div class="study-flow-editor">
    <div class="study-form-grid">
      <label class="study-field"><span>Section title</span><input id="study-section-title" value="${escapeHtml(section.title)}"></label>
      <label class="study-field"><span>Trial-group order</span><select id="study-section-order"${sectionHasCompletion(section) ? " disabled" : ""}>${option("fixed", "Fixed", section.orderPolicy.type)}${option("seededShuffle", "Seeded shuffle", section.orderPolicy.type)}${option("williamsBalancedLatinSquare", "Williams counterbalance", section.orderPolicy.type)}</select></label>
      <label class="study-field"><span>Trial label</span><input id="study-trial-label" value="${escapeHtml(trial.label)}"></label>
      <label class="study-field"><span>Trial ID</span><input value="${escapeHtml(trial.trialId)}" readonly></label>
    </div>
    <p class="study-help">A trial is a fixed group: for example, stimulus → affect response → questionnaire. Randomization moves the complete group and never separates its blocks.</p>
    <ol class="study-list">${trial.blocks.map((entry, index) => `<li class="study-list-item"${index === selectedBlock.block ? ' aria-current="true"' : ""}>
      <div><h3>${index + 1}. ${escapeHtml(portableBlockTypeLabel(entry.type))}</h3><p>${escapeHtml(blockSummary(entry))}</p><span class="study-meta">${escapeHtml(entry.blockId)}</span></div>
      <div class="study-inline-actions">
        <button type="button" data-select-block="${index}">Edit</button>
        <button type="button" data-move-block="${index}" data-direction="-1" aria-label="Move block up"${index === 0 || entry.type === "completion" ? " disabled" : ""}>Up</button>
        <button type="button" data-move-block="${index}" data-direction="1" aria-label="Move block down"${index === trial.blocks.length - 1 || entry.type === "completion" || trial.blocks[index + 1]?.type === "completion" ? " disabled" : ""}>Down</button>
        ${entry.type === "completion"
    ? canRemoveCompletionBlock(study, selectedBlock.section, selectedBlock.trial, index)
      ? `<button type="button" data-remove-block="${index}" data-variant="danger">Remove misplaced completion</button>`
      : '<button type="button" disabled title="A required terminal Completion cannot be removed.">Required terminal</button>'
    : `<button type="button" data-remove-block="${index}" data-variant="danger">Remove</button>`}
      </div>
    </li>`).join("")}</ol>
    <div class="study-inline-actions">
      <label class="study-field"><span>Block type</span><select id="study-new-block-type"${trialHasCompletion(trial) ? " disabled" : ""}>${addableBlockTypes.map((type) => option(type, portableBlockTypeLabel(type), "instruction")).join("")}</select><span class="study-help">${completionHelp}</span></label>
      <button id="study-add-block" type="button" data-variant="primary"${trialHasCompletion(trial) ? ' disabled title="The completion block must remain terminal."' : ""}>Add block</button>
    </div>
    ${branchEditor(selectedBlock.section, trial)}
    ${block ? blockEditor(block) : ""}
      </div>
    </div>`);

  document.querySelector("#study-section-title").addEventListener("input", (event) => { section.title = event.target.value; scheduleSave(); });
  document.querySelector("#study-section-order").addEventListener("change", (event) => { section.orderPolicy = { type: event.target.value }; scheduleSave(); renderSequence(); });
  document.querySelector("#study-trial-label").addEventListener("input", (event) => { trial.label = event.target.value; scheduleSave(); });
  for (const button of document.querySelectorAll("[data-select-trial]")) button.addEventListener("click", () => {
    const [sectionIndex, trialIndex] = button.dataset.selectTrial.split(":").map(Number);
    selectedBlock = { section: sectionIndex, trial: trialIndex, block: 0 };
    renderSequence();
  });
  for (const button of document.querySelectorAll("[data-move-section]")) button.addEventListener("click", () => {
    const from = Number(button.dataset.moveSection);
    const to = from + Number(button.dataset.direction);
    swapItems(study.sections, from, to);
    selectedBlock.section = selectionAfterSwap(selectedBlock.section, from, to);
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-remove-section]")) button.addEventListener("click", () => {
    const index = Number(button.dataset.removeSection);
    study.sections.splice(index, 1);
    if (selectedBlock.section > index) selectedBlock.section -= 1;
    else if (selectedBlock.section === index) selectedBlock = {
      section: Math.min(index, study.sections.length - 1), trial: 0, block: 0,
    };
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-move-trial]")) button.addEventListener("click", () => {
    const [sectionIndex, trialIndex] = button.dataset.moveTrial.split(":").map(Number);
    const trials = study.sections[sectionIndex].trials;
    const targetIndex = trialIndex + Number(button.dataset.direction);
    swapItems(trials, trialIndex, targetIndex);
    if (selectedBlock.section === sectionIndex) {
      selectedBlock.trial = selectionAfterSwap(selectedBlock.trial, trialIndex, targetIndex);
    }
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-remove-trial]")) button.addEventListener("click", () => {
    const [sectionIndex, trialIndex] = button.dataset.removeTrial.split(":").map(Number);
    const trials = study.sections[sectionIndex].trials;
    trials.splice(trialIndex, 1);
    if (selectedBlock.section === sectionIndex) {
      if (selectedBlock.trial > trialIndex) selectedBlock.trial -= 1;
      else if (selectedBlock.trial === trialIndex) selectedBlock = {
        section: sectionIndex, trial: Math.min(trialIndex, trials.length - 1), block: 0,
      };
    }
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-add-trial]")) button.addEventListener("click", () => {
    const sectionIndex = Number(button.dataset.addTrial);
    const target = study.sections[sectionIndex];
    const trialIndex = target.trials.length + 1;
    target.trials.push({
      trialId: flowIdentifier(`trial-${trialIndex}`),
      label: `Trial group ${trialIndex}`,
      blocks: [createBlock("instruction", flowIdentifier("instruction"))],
    });
    selectedBlock = { section: sectionIndex, trial: target.trials.length - 1, block: 0 };
    scheduleSave(); renderSequence();
  });
  document.querySelector("#study-add-section").addEventListener("click", () => {
    const index = study.sections.length + 1;
    const completionIndex = study.sections.findIndex(sectionHasCompletion);
    const insertionIndex = completionIndex < 0 ? study.sections.length : completionIndex;
    study.sections.splice(insertionIndex, 0, {
      sectionId: flowIdentifier(`section-${index}`),
      title: `Section ${index}`,
      orderPolicy: { type: "fixed" },
      trials: [{ trialId: flowIdentifier("trial-1"), label: "Trial group 1", blocks: [createBlock("instruction", flowIdentifier("instruction"))] }],
    });
    selectedBlock = { section: insertionIndex, trial: 0, block: 0 };
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-select-block]")) button.addEventListener("click", () => {
    selectedBlock.block = Number(button.dataset.selectBlock); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-move-block]")) button.addEventListener("click", () => {
    const from = Number(button.dataset.moveBlock); const to = from + Number(button.dataset.direction);
    swapItems(trial.blocks, from, to);
    selectedBlock.block = selectionAfterSwap(selectedBlock.block, from, to);
    scheduleSave(); renderSequence();
  });
  for (const button of document.querySelectorAll("[data-remove-block]")) button.addEventListener("click", () => {
    trial.blocks.splice(Number(button.dataset.removeBlock), 1);
    selectedBlock.block = Math.max(0, Math.min(selectedBlock.block, trial.blocks.length - 1));
    scheduleSave(); renderSequence();
  });
  document.querySelector("#study-add-block").addEventListener("click", () => {
    const type = document.querySelector("#study-new-block-type").value;
    if (type === "completion" && !canAddCompletionBlock(study, selectedBlock.section, selectedBlock.trial)) {
      announce("Completion can only be added once, at the end of the final trial in the final fixed section.");
      renderSequence();
      return;
    }
    const created = createBlock(type, flowIdentifier(`${type}-${trial.blocks.length + 1}`), {
      questionnaireId: study.questionnaires[0]?.questionnaireId,
      assetId: study.media[0]?.assetId,
    });
    trial.blocks.push(created); selectedBlock.block = trial.blocks.length - 1; scheduleSave(); renderSequence();
  });
  bindBranchEditor(selectedBlock.section, trial);
  bindBlockEditor(block);
}

function blockEditor(block) {
  const common = `<label class="study-field"><span>Block ID</span><input value="${escapeHtml(block.blockId)}" readonly><span class="study-help">Stable reference used by results and branch conditions.</span></label>`;
  if (["instruction", "break", "completion"].includes(block.type)) return `<section class="study-section-box"><h3>Edit ${block.type}</h3><div class="study-form-grid">${common}
    <label class="study-field study-wide"><span>Participant-facing text</span><textarea data-block-field="content">${escapeHtml(block.content)}</textarea></label>
    ${block.type === "instruction" ? `<label class="study-field"><span>Instruction presentation</span><select data-block-field="presentation">${option("standard", "Text instructions", block.presentation)}${option("faceFlubberComparison", "Synchronized Face + Flubber comparison", block.presentation)}</select><span class="study-help">Both visuals receive one current X/Y/phase snapshot. This does not create a stimulus or collect data.</span></label>` : ""}
    ${block.type === "break" ? `<label class="study-field"><span>Minimum duration (ms)</span><input type="number" min="0" step="100" data-block-field="minimumDurationMs" value="${block.minimumDurationMs ?? 0}"></label>` : ""}
  </div></section>`;
  if (block.type === "questionnaire") return `<section class="study-section-box"><h3>Edit questionnaire block</h3><div class="study-form-grid">${common}<label class="study-field"><span>Questionnaire</span><select data-block-field="questionnaireId">${study.questionnaires.map((item) => option(item.questionnaireId, item.title, block.questionnaireId)).join("")}</select></label></div></section>`;
  const sourceKind = block.source?.kind === "youtube" ? "youtube" : "contentAsset";
  const selectedAsset = study.media.find(({ assetId }) => assetId === block.source?.assetId) ?? study.media[0];
  const clip = sourceKind === "contentAsset" ? block.source?.clip : undefined;
  const sourceFields = sourceKind === "contentAsset"
    ? `<label class="study-field"><span>Verified media asset</span><select data-block-field="assetId">${study.media.map((asset) => option(asset.assetId, asset.assetId, selectedAsset?.assetId)).join("")}</select><span class="study-help">${selectedAsset ? `Duration: ${selectedAsset.durationMs} ms.` : "Add and verify an asset in the Asset library first."}</span></label>
      <label class="study-field"><span>Clip start (ms, optional)</span><input type="number" min="0" max="${selectedAsset?.durationMs ?? 0}" step="1" data-block-field="clipStartMs" value="${clip?.startMs ?? ""}" placeholder="0"></label>
      <label class="study-field"><span>Clip end (ms, optional)</span><input type="number" min="1" max="${selectedAsset?.durationMs ?? 0}" step="1" data-block-field="clipEndMs" value="${clip?.endMs ?? ""}" placeholder="${selectedAsset?.durationMs ?? "Asset duration"}"><span class="study-help">Leave both clip fields blank to use the whole asset.</span></label>`
    : `<label class="study-field"><span>YouTube video ID</span><input data-block-field="youtubeVideoId" minlength="6" maxlength="32" value="${escapeHtml(block.source?.videoId ?? "")}" placeholder="pY6vrOpnM64"></label>
      <label class="study-field"><span>Start (ms)</span><input type="number" min="0" step="1" data-block-field="youtubeStartMs" value="${block.source?.startMs ?? 0}"></label>
      <label class="study-field"><span>End (ms)</span><input type="number" min="1" step="1" data-block-field="youtubeEndMs" value="${block.source?.endMs ?? 60000}"></label>
      <p class="study-help study-wide" data-severity="warning"><strong>Pages 2D only.</strong> YouTube blocks are rejected by desktop and WebXR preflight and cannot receive the universal parity badge.</p>`;
  return `<section class="study-section-box"><h3>Edit video block</h3><div class="study-form-grid">${common}
    <label class="study-field"><span>Purpose</span><select data-block-field="purpose">${["introduction", "practice", "stimulus"].map((purpose) => option(purpose, purpose, block.purpose)).join("")}</select></label>
    <label class="study-field"><span>Video source</span><select data-block-field="sourceKind">${option("contentAsset", "Verified content asset", sourceKind)}${option("youtube", "YouTube · Pages 2D only", sourceKind)}</select></label>
    ${sourceFields}
    <label class="study-field"><span>Collect affect</span><select data-block-field="collectAffect">${option("true", "Yes", String(block.collectAffect))}${option("false", "No", String(block.collectAffect))}</select></label>
  </div></section>`;
}

function bindBlockEditor(block) {
  for (const field of document.querySelectorAll("[data-block-field]")) field.addEventListener("input", () => {
    const key = field.dataset.blockField;
    if (key === "sourceKind") {
      block.source = field.value === "youtube"
        ? { kind: "youtube", videoId: "", startMs: 0, endMs: 60000 }
        : { kind: "contentAsset", assetId: study.media[0]?.assetId ?? "select-an-asset" };
      scheduleSave();
      renderSequence();
      return;
    }
    if (key === "assetId") {
      block.source = { kind: "contentAsset", assetId: field.value };
      scheduleSave();
      renderSequence();
      return;
    }
    if (key === "clipStartMs" || key === "clipEndMs") {
      const startField = document.querySelector('[data-block-field="clipStartMs"]');
      const endField = document.querySelector('[data-block-field="clipEndMs"]');
      const asset = study.media.find(({ assetId }) => assetId === block.source.assetId);
      const startText = startField.value.trim();
      const endText = endField.value.trim();
      const source = { kind: "contentAsset", assetId: block.source.assetId };
      if (startText !== "" || endText !== "") {
        source.clip = {
          startMs: Number(startText === "" ? 0 : startText),
          endMs: Number(endText === "" ? asset?.durationMs ?? 0 : endText),
        };
      }
      block.source = source;
    }
    else if (key === "youtubeVideoId") block.source = { ...block.source, kind: "youtube", videoId: field.value.trim() };
    else if (key === "youtubeStartMs") block.source = { ...block.source, kind: "youtube", startMs: Number(field.value) };
    else if (key === "youtubeEndMs") block.source = { ...block.source, kind: "youtube", endMs: Number(field.value) };
    else if (key === "collectAffect") block.collectAffect = field.value === "true";
    else if (key === "minimumDurationMs") block[key] = Number(field.value);
    else block[key] = field.value;
    scheduleSave();
  });
}

function selectedQuestionnaireValue() {
  return study.questionnaires[selectedQuestionnaire];
}

function renderQuestionnaires() {
  const questionnaire = selectedQuestionnaireValue();
  const item = questionnaire?.items[selectedItem];
  stepFrame("Questionnaire editor", "Build portable response forms that work with a mouse, keyboard, touch controller, or WebXR controller.", `
    <p class="study-help">Questions run from top to bottom. Reorder them here; place the complete questionnaire before or after other blocks in Sequence. Universal v1 does not randomize questions inside a questionnaire.</p>
    <div class="study-inline-actions">
      <label class="study-field"><span>Questionnaire</span><select id="study-questionnaire-select">${study.questionnaires.map((entry, index) => option(String(index), entry.title, String(selectedQuestionnaire))).join("")}</select></label>
      <button id="study-add-questionnaire" type="button">Add questionnaire</button>
    </div>
    ${questionnaire ? `<div class="study-form-grid study-section-box">
      <label class="study-field"><span>Title</span><input id="study-questionnaire-title" value="${escapeHtml(questionnaire.title)}"></label>
      <label class="study-field"><span>Questionnaire ID</span><input id="study-questionnaire-id" value="${escapeHtml(questionnaire.questionnaireId)}" readonly><span class="study-help">Stable after creation.</span></label>
      <label class="study-field study-wide"><span>Description</span><textarea id="study-questionnaire-description">${escapeHtml(questionnaire.description)}</textarea></label>
    </div>
    <ol class="study-list">${questionnaire.items.map((entry, index) => `<li class="study-list-item"><div><h3>${escapeHtml(entry.prompt)}</h3><p>${escapeHtml(portableQuestionTypeLabel(entry.type))} · ${escapeHtml(entry.itemId)}</p></div><div class="study-inline-actions"><button type="button" data-select-item="${index}">Edit</button><button type="button" data-move-item="${index}" data-direction="-1" aria-label="Move question up"${index === 0 ? " disabled" : ""}>Up</button><button type="button" data-move-item="${index}" data-direction="1" aria-label="Move question down"${index === questionnaire.items.length - 1 ? " disabled" : ""}>Down</button><button type="button" data-remove-item="${index}" data-variant="danger">Remove</button></div></li>`).join("")}</ol>
    <div class="study-inline-actions"><label class="study-field"><span>Question type</span><select id="study-new-item-type">${PORTABLE_QUESTION_TYPES.map((type) => option(type, portableQuestionTypeLabel(type), "acknowledgement")).join("")}</select></label><button id="study-add-item" type="button" data-variant="primary">Add question</button></div>
    ${item ? questionnaireItemEditor(item) : ""}` : "<p>Add a questionnaire to continue.</p>"}`);

  document.querySelector("#study-questionnaire-select")?.addEventListener("change", (event) => { selectedQuestionnaire = Number(event.target.value); selectedItem = 0; renderQuestionnaires(); });
  document.querySelector("#study-add-questionnaire").addEventListener("click", () => {
    const index = study.questionnaires.length + 1;
    study.questionnaires.push({ questionnaireId: `questionnaire-${index}`, title: `Questionnaire ${index}`, description: "", items: [] });
    selectedQuestionnaire = study.questionnaires.length - 1; selectedItem = 0; scheduleSave(); renderQuestionnaires();
  });
  if (!questionnaire) return;
  for (const [id, key] of [["#study-questionnaire-title", "title"], ["#study-questionnaire-description", "description"]]) {
    document.querySelector(id).addEventListener("input", (event) => { questionnaire[key] = event.target.value; scheduleSave(); });
  }
  for (const button of document.querySelectorAll("[data-select-item]")) button.addEventListener("click", () => { selectedItem = Number(button.dataset.selectItem); renderQuestionnaires(); });
  for (const button of document.querySelectorAll("[data-move-item]")) button.addEventListener("click", () => {
    const from = Number(button.dataset.moveItem); const to = from + Number(button.dataset.direction);
    swapItems(questionnaire.items, from, to);
    selectedItem = selectionAfterSwap(selectedItem, from, to);
    scheduleSave(); renderQuestionnaires();
  });
  for (const button of document.querySelectorAll("[data-remove-item]")) button.addEventListener("click", () => { questionnaire.items.splice(Number(button.dataset.removeItem), 1); selectedItem = Math.max(0, Math.min(selectedItem, questionnaire.items.length - 1)); scheduleSave(); renderQuestionnaires(); });
  document.querySelector("#study-add-item").addEventListener("click", () => {
    const type = document.querySelector("#study-new-item-type").value;
    questionnaire.items.push(createQuestionnaireItem(type, flowIdentifier(`${type}-${questionnaire.items.length + 1}`)));
    selectedItem = questionnaire.items.length - 1; scheduleSave(); renderQuestionnaires();
  });
  bindQuestionnaireItemEditor(questionnaire, item);
}

function questionnaireItemEditor(item) {
  const ranges = ["likert", "vas", "numeric"].includes(item.type) ? `
    <label class="study-field"><span>Minimum</span><input type="number" data-item-field="min" value="${item.min}"></label>
    <label class="study-field"><span>Maximum</span><input type="number" data-item-field="max" value="${item.max}"></label>` : "";
  const step = ["vas", "numeric", "affect2d"].includes(item.type) ? `<label class="study-field"><span>Step</span><input type="number" min="0.001" step="0.001" data-item-field="step" value="${item.step}"></label>` : "";
  const choices = ["singleChoice", "multipleChoice"].includes(item.type) ? `<label class="study-field study-wide"><span>Choices</span><textarea id="study-item-options">${escapeHtml(item.options.map(({ optionId, label }) => `${optionId} | ${label}`).join("\n"))}</textarea><span class="study-help">One choice per line: stable-option-id | Participant label</span></label>` : "";
  const endpointLabels = ["likert", "vas"].includes(item.type) ? `<label class="study-field"><span>Minimum label</span><input data-item-field="minLabel" value="${escapeHtml(item.minLabel)}"></label><label class="study-field"><span>Maximum label</span><input data-item-field="maxLabel" value="${escapeHtml(item.maxLabel)}"></label>` : "";
  const multipleBounds = item.type === "multipleChoice" ? `<label class="study-field"><span>Minimum selections</span><input type="number" min="0" data-item-field="minSelections" value="${item.minSelections}"></label><label class="study-field"><span>Maximum selections</span><input type="number" min="1" data-item-field="maxSelections" value="${item.maxSelections}"></label>` : "";
  const unit = item.type === "numeric" ? `<label class="study-field"><span>Unit (optional)</span><input data-item-field="unit" value="${escapeHtml(item.unit ?? "")}"></label>` : "";
  return `<section class="study-section-box"><h3>Edit question</h3><div class="study-form-grid">
    <label class="study-field"><span>Item ID</span><input value="${escapeHtml(item.itemId)}" readonly><span class="study-help">Stable after creation.</span></label>
    <label class="study-field"><span>Required</span><select data-item-field="required">${option("true", "Required", String(item.required))}${option("false", "Optional", String(item.required))}</select></label>
    <label class="study-field study-wide"><span>Prompt</span><textarea data-item-field="prompt">${escapeHtml(item.prompt)}</textarea></label>
    ${ranges}${step}${endpointLabels}${multipleBounds}${unit}${choices}
    <p id="study-item-branch-status" class="study-status study-wide" data-severity="error" aria-live="polite" hidden></p>
  </div></section>`;
}

function updateQuestionnaireBranchStatus(questionnaire, item) {
  const output = document.querySelector("#study-item-branch-status");
  if (!output || !questionnaire || !item) return;
  const issues = questionnaireItemBranchIssues(study, questionnaire.questionnaireId, item);
  output.hidden = issues.length === 0;
  output.textContent = issues.length
    ? `${issues.length} branch condition${issues.length === 1 ? "" : "s"} no longer matches this answer. The stored condition has not changed; open Sequence to reset or remove it.`
    : "";
}

function bindQuestionnaireItemEditor(questionnaire, item) {
  if (!item) return;
  for (const field of document.querySelectorAll("[data-item-field]")) field.addEventListener("input", () => {
    const key = field.dataset.itemField;
    if (key === "required") item[key] = field.value === "true";
    else if (["min", "max", "step", "minSelections", "maxSelections"].includes(key)) item[key] = Number(field.value);
    else if (key === "unit" && !field.value) delete item.unit;
    else item[key] = field.value;
    scheduleSave();
    updateQuestionnaireBranchStatus(questionnaire, item);
  });
  document.querySelector("#study-item-options")?.addEventListener("input", (event) => {
    item.options = event.target.value.split(/\r?\n/).map((line) => {
      const [optionId, ...label] = line.split("|");
      return { optionId: optionId.trim(), label: label.join("|").trim() };
    }).filter(({ optionId, label }) => optionId && label);
    scheduleSave();
    updateQuestionnaireBranchStatus(questionnaire, item);
  });
  updateQuestionnaireBranchStatus(questionnaire, item);
}

function renderOrdering() {
  stepFrame("Randomization and counterbalancing", "Choose one deterministic order policy for each section. Every run records the exact realized order.", `
    <div class="study-table-wrap"><table class="study-table"><thead><tr><th>Section</th><th>Trial groups</th><th>Order policy</th><th>Run-time input</th></tr></thead><tbody>
      ${study.sections.map((section, index) => `<tr><td>${escapeHtml(section.title)}</td><td>${section.trials.length}</td><td><select data-order-section="${index}" aria-label="Order policy for ${escapeHtml(section.title)}"${sectionHasCompletion(section) ? " disabled" : ""}>${option("fixed", "Fixed", section.orderPolicy.type)}${option("seededShuffle", "Deterministic seeded shuffle", section.orderPolicy.type)}${option("williamsBalancedLatinSquare", "Williams balanced Latin square", section.orderPolicy.type)}</select></td><td>${sectionHasCompletion(section) ? "Required terminal group" : section.orderPolicy.type === "williamsBalancedLatinSquare" ? "Researcher selects the condition at run start" : section.orderPolicy.type === "seededShuffle" ? "Generated or supplied 128-bit seed" : "None"}</td></tr>`).join("")}
    </tbody></table></div>
    <section class="study-section-box"><h3>What moves</h3><p>The selected policy reorders complete trial groups only. Blocks and questionnaire questions stay in the order shown inside their group, so a stimulus and its follow-up questionnaire remain paired.</p></section>
    <section class="study-section-box"><h3>Reproducibility record</h3><p>The authority stores the algorithm version, 128-bit seed, manual Williams condition, matrix hash, and exact trial order. Odd-sized Williams designs use reversed companion rows.</p><p class="study-help">There is no hidden cross-participant “evenly present” counter. Without a central backend, balance is assigned explicitly with the Williams condition at run start.</p></section>`);
  for (const select of document.querySelectorAll("[data-order-section]")) select.addEventListener("change", () => {
    study.sections[Number(select.dataset.orderSection)].orderPolicy = { type: select.value };
    scheduleSave(); renderOrdering();
  });
}

async function renderValidation() {
  stepFrame("Compatibility and validation", "The shared core rejects malformed or unsupported studies before media starts.", `<p id="study-validation-progress">Validating with ${core.implementation}…</p>`);
  lastValidation = await core.validate(study);
  const compatibility = declaredCompatibility(study);
  const issues = lastValidation.errors ?? [];
  const content = `
    <p><span class="study-badge">${compatibility.badge}</span></p>
    <div class="study-table-wrap"><table class="study-table"><thead><tr><th>Surface</th><th>Declared support</th></tr></thead><tbody>
      <tr><td>Tauri desktop</td><td>${compatibility.desktop ? "Compatible" : "Unsupported browser-only media"}</td></tr>
      <tr><td>GitHub Pages 2D</td><td>${compatibility.pages2d ? "Compatible" : "Unsupported"}</td></tr>
      <tr><td>WebXR</td><td>${compatibility.webXr ? "Compatible" : "Unsupported browser-only media"}</td></tr>
    </tbody></table></div>
    <ul class="study-validation">${issues.length ? issues.map((issue) => `<li data-severity="error"><strong>${escapeHtml(issue.path ?? issue.code ?? "Study")}</strong>: ${escapeHtml(issue.message ?? issue)}</li>`).join("") : '<li data-severity="ok">No contract errors found.</li>'}</ul>
    ${core.implementation !== "wasm" ? `<p data-severity="warning">The WASM package is unavailable, so this is a browser structural precheck. Publishing and participant runs require the shared Rust/WASM core.</p>` : ""}`;
  document.querySelector("#study-validation-progress").outerHTML = content;
}

function stopComparison() {
  if (comparisonFrameId) cancelAnimationFrame(comparisonFrameId);
  comparisonFrameId = undefined;
  comparison = undefined;
}

function startComparison(block) {
  if (block?.presentation !== "faceFlubberComparison") return;
  const host = document.querySelector("#study-comparison-host");
  comparison = createInstructionAffectComparison(host, { seed: study.studyId });
  comparisonStartedAt = performance.now();
  const render = (now) => {
    const elapsed = (now - comparisonStartedAt) / 1000;
    comparison.render({
      currentX: Math.sin(elapsed * 0.42) * 0.7,
      currentY: Math.sin(elapsed * 0.31 + 0.8) * 0.7,
      phase: elapsed * Math.PI * 2,
      sequence: Math.floor(elapsed * 60),
      palette: study.pinnedSettings.visual.palette,
      baseShape: study.pinnedSettings.visual.baseShape,
      amplitudeScale: study.pinnedSettings.visual.pulseAmplitudeMultiplier,
      disorderScale: study.pinnedSettings.visual.disorderMultiplier,
      overlayOpacity: study.pinnedSettings.visual.opacity,
    });
    comparisonFrameId = requestAnimationFrame(render);
  };
  comparisonFrameId = requestAnimationFrame(render);
}

function renderPreview() {
  stopComparison();
  const instructions = instructionPreviewCandidates(study);
  const preview = preferredInstructionPreview(instructions, selectedPreviewInstructionId);
  const block = preview?.block;
  selectedPreviewInstructionId = block?.blockId;
  const compatibility = declaredCompatibility(study);
  stepFrame("Preview, publish, and run", "Inspect the participant instruction presentation, publish an immutable revision, or export the portable JSON.", `
    ${instructions.length > 1 ? `<label class="study-field study-preview-picker"><span>Instruction to preview</span><select id="study-preview-instruction">${instructions.map((entry) => option(entry.block.blockId, `${entry.section.title} › ${entry.trial.label} › ${entry.block.blockId}${entry.block.presentation === "faceFlubberComparison" ? " · Face + Flubber" : ""}`, block?.blockId)).join("")}</select></label>` : ""}
    <div class="study-preview-stage"><article class="study-instruction"><h3>Instruction preview</h3><p>${escapeHtml(block?.content ?? "No instruction block has been added.")}</p><div id="study-comparison-host"></div>${block?.presentation === "faceFlubberComparison" ? '<p class="study-help">The Face is an abstract coordinate display, not emotion recognition or diagnosis.</p>' : ""}</article></div>
    <section class="study-section-box"><h3>Publication</h3><p>${escapeHtml(compatibility.badge)} · ${core.implementation === "wasm" ? "shared authority ready" : "WASM authority missing"}</p><div class="study-inline-actions"><button id="study-publish" type="button" data-variant="primary">Validate and publish revision</button><button id="study-export-published" type="button" disabled>Export published JSON</button><button id="study-run" type="button"${core.canRun ? "" : " disabled"}>Prepare participant run</button></div><p id="study-publish-status" class="study-status"></p></section>`);
  document.querySelector("#study-preview-instruction")?.addEventListener("change", (event) => {
    selectedPreviewInstructionId = event.target.value;
    renderPreview();
  });
  startComparison(block);
  let publication;
  document.querySelector("#study-publish").addEventListener("click", async () => {
    const status = document.querySelector("#study-publish-status");
    try {
      saveNow();
      const validation = await core.validate(study);
      if (!validation.valid) throw new Error(`The study has ${validation.errors?.length ?? 1} validation error(s).`);
      publication = await draftStore.publishDraft(study.studyId, { expectedRevision: draftRevision });
      status.textContent = `Published immutable revision ${publication.revision} · ${publication.protocolHash}`;
      document.querySelector("#study-export-published").disabled = false;
      announce("Study revision published.");
    } catch (error) {
      status.textContent = error?.message ?? String(error);
      announce(status.textContent);
    }
  });
  document.querySelector("#study-export-published").addEventListener("click", () => {
    if (!publication) return;
    download(`${study.studyId}-r${publication.revision}.json`, `${JSON.stringify(publication.studyDefinition, null, 2)}\n`);
  });
  document.querySelector("#study-run").addEventListener("click", async () => {
    const status = document.querySelector("#study-publish-status");
    try {
      saveNow();
      const validation = await core.validate(study);
      if (!validation.valid) throw new Error(`The study has ${validation.errors?.length ?? 1} validation error(s).`);
      const publishedStudy = publication?.studyDefinition ?? await core.publish(study);
      stopComparison();
      const participantRemoteControl = surface === "desktop"
        ? await ensureRemoteControlUi()
        : undefined;
      await launchParticipantRun({
        core,
        study: publishedStudy,
        assetBindings,
        surface,
        remoteControlUi: participantRemoteControl,
        onClose: refreshStudyRecoveryNotice,
      });
      refreshStudyRecoveryNotice();
      status.textContent = "Participant run opened with the shared study authority.";
      announce("Participant run opened.");
    } catch (error) {
      status.textContent = error?.message ?? String(error);
      announce(status.textContent);
    }
  });
}

async function importStudy(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error("Study JSON must not exceed 2 MB.");
    const parsed = JSON.parse(await file.text());
    const validation = await core.validate(parsed);
    if (!validation.valid) throw new Error(`The imported study has ${validation.errors?.length ?? 1} validation error(s).`);
    study = cloneStudy(parsed);
    if (draftStore.getDraft(study.studyId)) study.studyId = studyIdentifier(study.title);
    draftRevision = 0;
    activeStep = "details";
    saveNow();
    renderShell();
    renderStep();
    announce("Study JSON imported as a local draft.");
  } catch (error) {
    announce(error?.message ?? String(error));
  }
}

async function initialize() {
  core = await loadStudyCore();
  draftStore = new StudyDraftStore({ canonicalHash: (definition) => core.hash(definition) });
  study = loadInitialStudy();
  partialRecoveryUi = installPartialRunRecoveryUi({ root, announce });
  renderShell();
  renderStep();
  if (draftRevision === 0) saveNow();
}

globalThis.addEventListener("pagehide", (event) => {
  void remoteControlUi?.stop("pagehide");
  if (!event.persisted) void partialRecoveryUi?.close();
});

initialize().catch((error) => {
  root.innerHTML = `<main class="study-loading"><h1>Study Studio could not start</h1><p>${escapeHtml(error?.message ?? error)}</p></main>`;
});
