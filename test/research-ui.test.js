import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ATTEMPT_DISPOSITIONS,
  INPUT_PRESET_OPTIONS,
  MAPPING_FIELDS,
  RESEARCH_MODES,
  RESEARCH_UI_EVENTS,
  SETUP_SECTIONS,
  nextOpenSetupSection,
  normalizeResearchMode,
  normalizeAttemptDisposition,
  normalizeSetupSection,
  renderResearchUiMarkup,
} from "../site/src/research/app.js";
import {
  DEFAULT_COLORS,
  formatCoordinate,
  normalizePreviewState,
} from "../site/src/research/preview.js";
import {
  affectPaletteColor,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
} from "../site/src/math.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const expectedSections = [
  ["workspace", "Workspace & Libraries"],
  ["experiment", "Experiment"],
  ["stimuli", "Stimuli & Counterbalancer"],
  ["input", "Controller / Input Device"],
  ["visual", "Visual Feedback"],
  ["advanced", "Advanced"],
  ["review", "Review & Start"],
];

test("the active instrument exposes exactly Setup and Run modes", () => {
  assert.deepEqual(RESEARCH_MODES, ["setup", "run"]);
  const markup = renderResearchUiMarkup("browser");
  assert.equal((markup.match(/data-mode-panel=/gu) ?? []).length, 2);
  assert.match(markup, /data-mode-panel="setup"[^>]*aria-label="Setting Up the Experiment"/u);
  assert.match(markup, /data-mode-panel="run"[^>]*aria-label="Running the Experiment"/u);
  assert.equal(normalizeResearchMode("run"), "run");
  assert.equal(normalizeResearchMode("unknown"), "setup");
});

test("Setup has the exact seven ordered single-open accordion contracts", () => {
  assert.deepEqual(SETUP_SECTIONS.map(({ id, label }) => [id, label]), expectedSections);
  const markup = renderResearchUiMarkup();
  assert.equal((markup.match(/class="setup-accordion"/gu) ?? []).length, 7);
  let cursor = -1;
  for (const [id, label] of expectedSections) {
    const next = markup.indexOf(`data-setup-section="${id}"`);
    assert.ok(next > cursor, `${label} must retain protocol order`);
    assert.match(markup, new RegExp(`aria-controls="setup-panel-${id}"`, "u"));
    assert.match(markup, new RegExp(`aria-labelledby="setup-trigger-${id}"`, "u"));
    cursor = next;
  }
  assert.equal((markup.match(/aria-expanded="true"/gu) ?? []).length, 1);
  assert.equal(normalizeSetupSection("visual"), "visual");
  assert.equal(normalizeSetupSection("nope"), "workspace");
  assert.equal(nextOpenSetupSection("workspace", "experiment"), "experiment");
  assert.equal(nextOpenSetupSection("experiment", "nope"), "workspace");
});

test("Workspace, experiment, and counterbalancing decisions are present without legacy rating choices", () => {
  const markup = renderResearchUiMarkup();
  for (const directory of ["stimuli/", "settings/", "outputs/", "recovery/"]) assert.match(markup, new RegExp(directory, "u"));
  for (const id of ["workspace-choose", "workspace-rescan", "video-import", "video-folder-import", "settings-load", "settings-save"]) {
    assert.match(markup, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(markup, /Folders are scanned recursively/u);
  assert.match(markup, /Partial ratings are always journaled locally/u);
  assert.match(markup, /id="sampling-frequency"[^>]*min="1"[^>]*max="240"[^>]*value="130"/u);
  assert.match(markup, /Continuous rating is always enabled/u);
  assert.doesNotMatch(markup, /id="(?:continuous-rating|single-summary-rating)"/u);
  for (const mode of ["fixed", "jitter", "continue"]) assert.match(markup, new RegExp(`name="transitionMode" value="${mode}"`, "u"));
  assert.match(markup, /single column containing every video is the ordinary one-hat design/u);
  assert.match(markup, /Williams counterbalancing/u);
  assert.match(markup, /Cyclic rotation/u);
  assert.match(markup, /balanced-v1/u);
  assert.match(markup, /Export assignment-plan\.csv/u);
  assert.doesNotMatch(markup, /all-permutation[^<]*(?:option|button)/iu);
});

test("all nine input presets, custom capture, conflict guidance, and live test are exposed", () => {
  assert.deepEqual(INPUT_PRESET_OPTIONS.map(({ label }) => label), [
    "Arrow keys",
    "WASD",
    "IJKL",
    "Numeric keypad",
    "Pointer / trackpad grid",
    "Mouse buttons and wheel",
    "Gamepad D-pad",
    "Gamepad left stick",
    "Gamepad right stick",
  ]);
  const markup = renderResearchUiMarkup();
  for (const { id, label } of INPUT_PRESET_OPTIONS) {
    assert.match(markup, new RegExp(`<option value="${id}">${label.replace("/", "\\/")}</option>`, "u"));
  }
  assert.match(markup, /id="input-step-size"[^>]*value="0\.1"/u);
  assert.match(markup, /Digital controls change state once per physical edge/u);
  assert.match(markup, /operating-system key repeat is ignored/u);
  assert.match(markup, /captured action cannot be assigned twice/u);
  assert.match(markup, /id="binding-capture-dialog"/u);
  assert.match(markup, /id="input-test"/u);
});

test("visual feedback has independent Grid and Flubber controls and one color owner", () => {
  const markup = renderResearchUiMarkup();
  for (const id of [
    "visual-grid-visible", "visual-flubber-visible", "visual-size", "visual-transparency",
    "visual-hide-feedback", "visual-lock-position", "visual-position-x", "visual-position-y",
    "flubber-outline-visible", "flubber-outline-thickness", "flubber-halo-visible",
    "grid-line-thickness", "grid-outline-visible", "grid-outline-thickness", "grid-cursor-size",
  ]) assert.match(markup, new RegExp(`id="${id}"`, "u"));
  assert.match(markup, /id="visual-size" type="number"/u);
  assert.equal((markup.match(/id="color-halo"/gu) ?? []).length, 1);
  assert.equal((markup.match(/id="color-halo-hex"/gu) ?? []).length, 1);
  assert.doesNotMatch(markup, /id="flubber-halo-color"/u);
  for (const anchor of ["up", "down", "left", "right", "idle", "outline", "halo", "cursor"]) {
    assert.match(markup, new RegExp(`id="color-${anchor}"`, "u"));
    assert.match(markup, new RegExp(`id="color-${anchor}-hex"`, "u"));
    assert.match(markup, new RegExp(`data-color-reset="${anchor}"`, "u"));
  }
  assert.match(markup, /id="main-gradient-canvas"/u);
  assert.equal((markup.match(/data-color-anchor=/gu) ?? []).length, 4);
  assert.match(markup, /Acquisition continues while Grid and Flubber are hidden/u);
  assert.match(markup, /sole control for disabling drag/u);
});

test("Advanced contains the exact LSL fields and six mapping disclosures", () => {
  const markup = renderResearchUiMarkup();
  for (const id of ["lsl-enabled", "lsl-state-stream", "lsl-stream-type", "lsl-marker-stream", "lsl-source-id"]) {
    assert.match(markup, new RegExp(`id="${id}"`, "u"));
  }
  assert.deepEqual(MAPPING_FIELDS.map(({ label, allowedMin, allowedMax, min, max, driver, reverse }) => ({
    label, allowedMin, allowedMax, min, max, driver, reverse,
  })), [
    { label: "Oscillation Frequency", allowedMin: 0, allowedMax: 10, min: 0.5, max: 2.5, driver: "y-axis", reverse: false },
    { label: "Edge Smoothness", allowedMin: 0, allowedMax: 1, min: 0, max: 1, driver: "x-axis", reverse: false },
    { label: "Projection Amplitude", allowedMin: 0, allowedMax: 1, min: 0.2, max: 0.4, driver: "y-axis", reverse: false },
    { label: "Pulse Synchrony", allowedMin: 0, allowedMax: 1, min: 0.2, max: 1, driver: "x-axis", reverse: false },
    { label: "Wave-size Variation", allowedMin: 0, allowedMax: 1, min: 0, max: 0.8, driver: "x-axis", reverse: true },
    { label: "Saturation", allowedMin: 0, allowedMax: 1, min: 0, max: 1, driver: "radius", reverse: false },
  ]);
  assert.equal((markup.match(/class="inner-disclosure mapping-disclosure"/gu) ?? []).length, 6);
  for (const driver of ["x-axis", "y-axis", "angle", "radius"]) assert.match(markup, new RegExp(`<option value="${driver}"`, "u"));
});

test("Review and Start carries privacy, participant-state, format, and fail-closed controls", () => {
  const markup = renderResearchUiMarkup();
  assert.match(markup, /Available|States are reconstructed/u);
  assert.match(markup, /locks, recovery journals, and manifests/u);
  for (const id of ["participant-first-name", "participant-last-name", "participant-age", "participant-gender", "participant-handedness", "participant-code"]) {
    assert.match(markup, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(markup, /id="participant-count"[^>]*max="100000"/u);
  assert.match(markup, /id="participant-window-previous"/u);
  assert.match(markup, /id="participant-window-next"/u);
  assert.deepEqual(ATTEMPT_DISPOSITIONS, ["resume-compatible", "new-attempt"]);
  for (const disposition of ATTEMPT_DISPOSITIONS) assert.match(markup, new RegExp(`name="attemptDisposition" value="${disposition}"`, "u"));
  assert.match(markup, /id="participant-rerun-confirm"/u);
  assert.match(markup, /Resume compatible partial/u);
  assert.match(markup, /Start a new attempt/u);
  assert.equal(normalizeAttemptDisposition("partial", "resume-compatible"), "resume-compatible");
  assert.equal(normalizeAttemptDisposition("partial", "new-attempt"), "new-attempt");
  assert.equal(normalizeAttemptDisposition("complete", "resume-compatible"), "new-attempt");
  assert.equal(normalizeAttemptDisposition("available", "resume-compatible"), "new-attempt");
  for (const option of ["Woman", "Man", "Non-binary", "Self-described", "Prefer not to say", "Left", "Right", "Ambidextrous"]) {
    assert.match(markup, new RegExp(`>${option}<`, "u"));
  }
  assert.match(markup, /Raw names[^<]*removed before Start/u);
  assert.match(markup, /id="output-csv"[^>]*checked/u);
  assert.match(markup, /id="output-tsv"/u);
  assert.match(markup, /id="start-experiment"[^>]*disabled/u);
  for (const id of ["settings-hash", "review-plan-hash", "storage-estimate", "timing-capability", "native-playback-mode", "native-media-capability", "lsl-capability"]) {
    assert.match(markup, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(markup, /Native libVLC player · qualification required/u);
  assert.match(markup, /WebView video · unqualified testing only/u);
});

test("Run is a sparse stimulus, adjacent feedback, status, pause, and controlled-stop surface", () => {
  const markup = renderResearchUiMarkup();
  const run = markup.slice(markup.indexOf('<section class="run-mode"'), markup.indexOf("</main>"));
  assert.ok(run.indexOf('class="stimulus-stage"') < run.indexOf('class="run-feedback-stage"'));
  for (const id of ["run-video", "run-pause", "run-stop-early", "run-stimulus-status", "run-timing-status", "run-write-status", "run-lsl-status", "run-transition", "run-continue"]) {
    assert.match(run, new RegExp(`id="${id}"`, "u"));
  }
  for (const setupOnly of ["experiment-id", "participant-count", "input-preset", "visual-size", "lsl-enabled", "start-experiment"]) {
    assert.doesNotMatch(run, new RegExp(`id="${setupOnly}"`, "u"));
  }
  assert.match(run, /Configured adjacent visual feedback/u);
  assert.match(run, /preflighted complete video/u);
  assert.match(run, /Sampling is stopped and the rating is neutral/u);
  assert.match(markup, /controlled stop finalizes an explicitly partial result and cannot be resumed/u);
});

test("assignment plan export uses the canonical source-identity serializer", async () => {
  const source = await read("site/src/research/app.js");
  assert.match(source, /import \{ assignmentPlanToCsv \} from "\.\/tabular\.js"/u);
  assert.match(source, /csv = await assignmentPlanToCsv\(plan\)/u);
  assert.doesNotMatch(source, /const cells = \["participant_id", "position", "pool_id"/u);
});

test("the UI bridge names are explicit and stable", () => {
  assert.deepEqual(RESEARCH_UI_EVENTS, {
    selectWorkspaceRequest: "affect-research:select-workspace",
    rescanWorkspaceRequest: "affect-research:rescan-workspace",
    importVideosRequest: "affect-research:import-videos-request",
    loadSettingsRequest: "affect-research:load-settings-request",
    saveSettingsRequest: "affect-research:save-settings-request",
    exportPlanRequest: "affect-research:export-plan-request",
    planReady: "affect-research:plan-ready",
    inputTestState: "affect-research:input-test-state",
    inputEdge: "affect-research:input-edge",
    inputBindingChanged: "affect-research:input-binding-changed",
    inputTestReset: "affect-research:input-test-reset",
    inputCaptureRequest: "affect-research:input-capture-request",
    inputCaptureCancel: "affect-research:input-capture-cancel",
    startRequest: "affect-research:start-request",
    pauseRequest: "affect-research:pause-request",
    stopEarlyRequest: "affect-research:stop-early-request",
    continueRequest: "affect-research:continue-request",
    settingsLoaded: "affect-research:settings-loaded",
    capabilityStatus: "affect-research:capability-status",
    workspaceReady: "affect-research:workspace-ready",
    stimuliCatalogued: "affect-research:stimuli-catalogued",
    participantStates: "affect-research:participant-states",
    runStarted: "affect-research:run-started",
    runStatus: "affect-research:run-status",
    runComplete: "affect-research:run-complete",
  });
});

test("Start emits an explicit attempt disposition without raw participant names", async () => {
  const source = await read("site/src/research/app.js");
  assert.match(source, /attemptDisposition,/u);
  assert.match(source, /rerunConfirmed,/u);
  assert.match(source, /setInputValue\("participant-first-name", ""\)/u);
  assert.match(source, /setInputValue\("participant-last-name", ""\)/u);
  const detailBlock = source.slice(source.indexOf("const detail = {"), source.indexOf("const event = new CustomEvent", source.indexOf("const detail = {")));
  assert.doesNotMatch(detailBlock, /firstName|lastName/u);
});

test("pending native finalization has an explicit acquisition-free Setup dispatch", async () => {
  const source = await read("site/src/research/app.js");
  assert.match(source, /__finalizationPending/u);
  assert.match(source, /__finalizationBinding/u);
  assert.match(source, /function selectedPendingFinalization\(\)[\s\S]*binding\.settingsSha256 !== settingsHash[\s\S]*binding\.assignmentPlanSha256 !== plan\.planHashSha256/u);
  assert.match(source, /Finalize pending \$\{pendingFinalization\.completionStatus\} attempt/u);
  const requestStart = source.slice(
    source.indexOf("function requestStart()"),
    source.indexOf("root.addEventListener(\"click\"", source.indexOf("function requestStart()")),
  );
  const recoveryBranch = requestStart.slice(0, requestStart.indexOf("const fieldsValid"));
  assert.match(recoveryBranch, /recoveryFinalizationOnly: true/u);
  assert.match(recoveryBranch, /pendingFinalizationAttemptNumber: pendingFinalization\.attemptNumber/u);
  assert.match(recoveryBranch, /pendingFinalizationCompletionStatus: pendingFinalization\.completionStatus/u);
  assert.match(recoveryBranch, /participantId: selectedParticipant/u);
  assert.match(recoveryBranch, /settingsSha256: settingsHash/u);
  assert.doesNotMatch(recoveryBranch, /deriveParticipantRecord|inputTestReceiptId|verifiedStimulusIds|storageReady|timingWorkerReady/u);
});

test("manifest readiness is fail-closed and the adapter exposes authoritative neutral reset", async () => {
  const source = await read("site/src/research/app.js");
  assert.match(source, /manifestReady: false/u);
  assert.match(source, /capabilities\.manifestReady \? "pass" : "block"/u);
  assert.match(source, /manifestReady: capabilities\.manifestReady/u);
  assert.match(source, /resetAffect\(reason = "safe-boundary"\)/u);
  assert.match(source, /inputController\.resetNeutral\(reason\)/u);
  assert.match(source, /representative WebView frames attested \(unqualified playback\)/u);
  assert.match(source, /installed-hardware qualification pending/u);
  assert.equal((source.match(/new CustomEvent\(RESEARCH_UI_EVENTS\.workspaceReady/gu) ?? []).length, 2, "selection and permission renewal both request a manifest rescan");
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
    assert.match(source, new RegExp(`runFeedbackStage\\?\\.addEventListener\\("${event}", handleRunPointer\\)`, "u"));
  }
});

test("preview normalization is bounded, deterministic, and uses Research defaults", () => {
  assert.deepEqual(DEFAULT_COLORS, {
    up: "#f2c94c", down: "#2f80ed", left: "#eb5757", right: "#27ae60",
    idle: "#9ca3af", outline: "#f8fafc", halo: "#93c5fd", cursor: "#ffffff",
  });
  const state = normalizePreviewState({
    x: 4,
    y: -4,
    sizePercent: 999,
    transparencyPercent: -2,
    position: { x: -1, y: 2 },
    flubber: { outlineThickness: 99 },
    grid: { lineThickness: 0, outlineThickness: 99, cursorSize: 0 },
    colors: { halo: "invalid" },
  });
  assert.equal(state.x, 1);
  assert.equal(state.y, -1);
  assert.equal(state.sizePercent, 100);
  assert.equal(state.transparencyPercent, 0);
  assert.deepEqual(state.position, { x: 0, y: 1 });
  assert.equal(state.flubber.outlineThickness, 20);
  assert.equal(state.grid.lineThickness, 0.25);
  assert.equal(state.grid.outlineThickness, 20);
  assert.equal(state.grid.cursorSize, 2);
  assert.equal(state.colors.halo, DEFAULT_COLORS.halo);
  assert.equal(formatCoordinate(0), "+0.000");
  assert.equal(formatCoordinate(-2), "-1.000");
});

test("all six Flubber mapping outputs materially control the renderer", () => {
  const profiles = createProfiles(64, 8);
  const offsets = createProjectionOffsets("research-renderer-contract", 8);
  const render = (overrides = {}) => buildFlubberPath({
    profiles,
    offsets,
    x: 0.6,
    y: 0.4,
    phase: 1.25,
    palette: DEFAULT_COLORS,
    projectionAmplitude: 0.3,
    edgeSmoothness: 0.5,
    pulseSynchrony: 0.6,
    amplitudeVariation: 0.4,
    colorSaturation: 0.5,
    ...overrides,
  });
  const baseline = render();
  assert.notEqual(render({ projectionAmplitude: 0.8 }).path, baseline.path);
  assert.notEqual(render({ edgeSmoothness: 0 }).path, baseline.path);
  assert.notEqual(render({ pulseSynchrony: 1 }).path, baseline.path);
  assert.notEqual(render({ amplitudeVariation: 0 }).path, baseline.path);
  assert.notEqual(render({ colorSaturation: 1 }).color, baseline.color);
  assert.notEqual(render({ phase: 1.75 }).path, baseline.path);
  assert.equal(affectPaletteColor(1, 0, DEFAULT_COLORS, 0), "rgb(183 183 183)");
});

test("programmatic binding, color, and overlay changes invalidate the frozen protocol", async () => {
  const source = await read("site/src/research/app.js");
  assert.match(source, /onPositionChange\(position\)[\s\S]*?refreshProjection\(\);\s*schedulePlanRefresh\(\);/u);
  assert.match(source, /function resetBindingsToPreset\(\)[\s\S]*?resetInputTest\(\);[\s\S]*?renderBindings\(\);\s*schedulePlanRefresh\(\);/u);
  assert.match(source, /inputBinding = structuredClone\(result\.binding\);\s*resetInputTest\(\{ notify: false \}\);[\s\S]*?renderBindings\(\);\s*schedulePlanRefresh\(\);/u);
  assert.match(source, /function applyResearchSettings\(settings\)[\s\S]*?inputBinding = structuredClone\(normalized\.input\);\s*resetInputTest\(\);/u);
  assert.match(source, /if \(target\.dataset\.colorReset\)[\s\S]*?refreshProjection\(\);\s*schedulePlanRefresh\(\);/u);
  assert.match(source, /function schedulePlanRefresh\(\)[\s\S]*?settingsSnapshot = null;[\s\S]*?plan = null;[\s\S]*?capabilities\.manifestReady = false;/u);
});

test("the active entrypoints load only the shared Research instrument", async () => {
  const [siteIndex, desktopIndex] = await Promise.all([read("site/index.html"), read("desktop/index.html")]);
  assert.match(siteIndex, /id="research-app" data-research-surface="browser"/u);
  assert.match(siteIndex, /src="\.\/src\/research\/runtime-bridge\.js"/u);
  assert.match(siteIndex, /href="\.\/research\.css"/u);
  assert.match(desktopIndex, /id="research-app" data-research-surface="tauri"/u);
  assert.match(desktopIndex, /src="\.\.\/site\/src\/research\/native-bridge\.js"/u);
  assert.match(desktopIndex, /href="\.\.\/site\/research\.css"/u);
  for (const html of [siteIndex, desktopIndex]) {
    assert.equal((html.match(/<script/gu) ?? []).length, 1);
    assert.doesNotMatch(html, /(?:webxr|party|ground-control|polar|face-|touch-playground|vdo\.ninja)/iu);
  }
});

test("the Research stylesheet passes the compact Uncodixfy guardrails", async () => {
  const css = await read("site/research.css");
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\s*\(/iu);
  assert.doesNotMatch(css, /backdrop-filter|box-shadow|text-transform|letter-spacing/iu);
  assert.doesNotMatch(css, /\.(?:hero|eyebrow|glass|pill|dashboard-card)\b/iu);
  for (const match of css.matchAll(/border-radius:\s*([\d.]+)px/gu)) {
    assert.ok(Number(match[1]) <= 8, `border radius ${match[1]}px exceeds the compact UI limit`);
  }
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /@media \(max-width: 759px\)/u);
  assert.match(css, /grid-template-columns: minmax\(34rem, 1\.25fr\) minmax\(23rem, 0\.75fr\)/u);
});

test("Setup remains scrollable on desktop and the mobile header owns intrinsic height", async () => {
  const css = await read("site/research.css");
  assert.match(css, /\.research-shell\s*>\s*main\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\);[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/u);
  assert.match(css, /\.setup-mode\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\);[\s\S]*?height:\s*100%;/u);
  assert.match(css, /\.setup-layout\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?height:\s*100%;/u);
  assert.match(css, /\.setup-pane\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?max-height:\s*100%;[\s\S]*?overflow-y:\s*auto;/u);
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*?\.research-shell\s*\{[\s\S]*?grid-template-rows:\s*auto auto;[\s\S]*?min-height:\s*100dvh;/u);
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*?\.research-shell\s*>\s*main\s*\{[\s\S]*?display:\s*block;[\s\S]*?overflow:\s*visible;/u);
});

test("custom research controls expose one coherent accessible interaction model", async () => {
  const [markup, source, preview, css] = await Promise.all([
    Promise.resolve(renderResearchUiMarkup("browser")),
    read("site/src/research/app.js"),
    read("site/src/research/preview.js"),
    read("site/research.css"),
  ]);
  assert.match(markup, /id="video-drop-zone"[^>]*role="group"/u);
  assert.doesNotMatch(markup, /id="video-drop-zone"[^>]*(?:tabindex|role="button")/u);
  assert.doesNotMatch(markup, /role="application"/u);
  assert.match(markup, /id="participant-grid"[^>]*role="radiogroup"/u);
  assert.match(source, /button\.setAttribute\("role", "radio"\);[\s\S]*?button\.setAttribute\("aria-checked"/u);
  assert.doesNotMatch(source, /button\.setAttribute\("aria-selected"/u);
  assert.match(markup, /data-color-reset="halo" aria-label="Reset Halo color"/u);
  assert.match(markup, /aria-label="Oscillation Frequency minimum \(Hz\)"/u);
  assert.match(markup, /id="run-video"[^>]*aria-label="Protocol-controlled current stimulus video"/u);
  assert.match(source, /syncControlValidation[\s\S]*?aria-invalid[\s\S]*?aria-errormessage/u);
  assert.match(source, /queueMicrotask\(\(\) => proceed\.focus\(\)\)/u);
  assert.doesNotMatch(preview, /addEventListener\("keydown"/u);
  assert.match(css, /@media \(forced-colors: active\)/u);
});
