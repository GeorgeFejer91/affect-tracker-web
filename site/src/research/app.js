import { canonicalJson, canonicalSha256 } from "./canonical.js";
import {
  INPUT_PRESET_IDS,
  INPUT_PRESETS,
  PARTICIPANT_STATUS_LABELS,
  createDefaultResearchSettings,
  createInputBindingPreset,
  importPortableSettingsV1,
  validateInputBindingV1,
  validateResearchSettingsV1,
  validateStimulusV1,
} from "./contracts.js";
import {
  analyzeAssignmentCoverage,
  resolveAssignmentPlanV1,
} from "./counterbalancer.js";
import {
  deriveParticipantRecord,
  participantCode,
  participantIds as createParticipantIds,
} from "./identity.js";
import {
  FLUBBER_MAPPING_SPECS,
  evaluateFlubberMappings,
} from "./mappings.js";
import { ResearchInputController, withCustomDigitalAction } from "./input-controller.js";
import { createResearchPreview, drawAffectField } from "./preview.js";
import { assignmentPlanToCsv } from "./tabular.js";
import {
  BrowserResearchWorkspace,
  isSupportedVideoName,
  normalizeWorkspaceRelativePath,
  parseStrictJson,
  parseExperimentalYouTubeUrl,
  probeVideoFile,
  sha256Blob,
} from "./workspace.js";
import {
  YOUTUBE_PREFLIGHT_MAX_AGE_MS,
  YouTubeIframePlayerAdapter,
  isFreshYouTubePreflight,
} from "./youtube-player.js";

const DEFAULT_SETTINGS = createDefaultResearchSettings();
const DEFAULT_COLORS = DEFAULT_SETTINGS.visual.colors;

export const UI_PRESET_IDS = Object.freeze({
  arrowKeys: "arrow-keys",
  wasd: "wasd",
  ijkl: "ijkl",
  numpad: "numpad",
  pointerGrid: "pointer-grid",
  mouseButtonsWheel: "mouse-wheel",
  gamepadDpad: "gamepad-dpad",
  gamepadLeftStick: "gamepad-left-stick",
  gamepadRightStick: "gamepad-right-stick",
});

const CONTRACT_PRESET_IDS = Object.freeze(Object.fromEntries(
  Object.entries(UI_PRESET_IDS).map(([contractId, uiId]) => [uiId, contractId]),
));

export const SETUP_SECTIONS = Object.freeze([
  Object.freeze({ id: "workspace", label: "Workspace & Libraries" }),
  Object.freeze({ id: "experiment", label: "Experiment" }),
  Object.freeze({ id: "stimuli", label: "Stimuli & Counterbalancer" }),
  Object.freeze({ id: "input", label: "Controller / Input Device" }),
  Object.freeze({ id: "visual", label: "Visual Feedback" }),
  Object.freeze({ id: "advanced", label: "Advanced" }),
  Object.freeze({ id: "review", label: "Review & Start" }),
]);

export const RESEARCH_MODES = Object.freeze(["setup", "run"]);
export const ATTEMPT_DISPOSITIONS = Object.freeze(["resume-compatible", "new-attempt"]);

export const RESEARCH_UI_EVENTS = Object.freeze({
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

export const INPUT_PRESET_OPTIONS = Object.freeze(INPUT_PRESET_IDS.map((contractId) => Object.freeze({
  id: UI_PRESET_IDS[contractId],
  contractId,
  label: INPUT_PRESETS[contractId].label,
  digital: INPUT_PRESETS[contractId].kind === "digital",
})));

export const MAPPING_FIELDS = Object.freeze(Object.entries(FLUBBER_MAPPING_SPECS).map(([contractId, spec]) => Object.freeze({
  contractId,
  id: contractId.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
  label: spec.label,
  unit: spec.unit,
  allowedMin: spec.allowedMin,
  allowedMax: spec.allowedMax,
  min: spec.defaultMin,
  max: spec.defaultMax,
  driver: spec.defaultDriver,
  reverse: spec.defaultReverse,
})));

const COLOR_FIELDS = Object.freeze([
  Object.freeze({ id: "up", label: "High arousal anchor", value: DEFAULT_COLORS.up }),
  Object.freeze({ id: "down", label: "Low arousal anchor", value: DEFAULT_COLORS.down }),
  Object.freeze({ id: "left", label: "Negative valence anchor", value: DEFAULT_COLORS.left }),
  Object.freeze({ id: "right", label: "Positive valence anchor", value: DEFAULT_COLORS.right }),
  Object.freeze({ id: "idle", label: "Idle color", value: DEFAULT_COLORS.idle }),
  Object.freeze({ id: "outline", label: "Outline color", value: DEFAULT_COLORS.outline }),
  Object.freeze({ id: "halo", label: "Halo color", value: DEFAULT_COLORS.halo }),
  Object.freeze({ id: "cursor", label: "Cursor color", value: DEFAULT_COLORS.cursor }),
]);

function describeInputToken(token) {
  if (token.kind === "keyboard") return token.code;
  if (token.kind === "wheel") return `Wheel ${token.direction}`;
  if (token.kind === "mouseButton") return `Mouse button ${token.button}`;
  if (token.kind === "gamepadButton") return `Gamepad button ${token.button}`;
  if (token.kind === "pointerAxis") return `Pointer ${token.axis.toUpperCase()}${token.invert ? " reversed" : ""}`;
  if (token.kind === "gamepadAxis") return `Gamepad axis ${token.index}${token.invert ? " reversed" : ""}`;
  return "Unassigned";
}

const SECTION_SUMMARIES = Object.freeze({
  workspace: "Choose a workspace root",
  experiment: "Continuous rating · 130 Hz",
  stimuli: "One hat or stratified pools",
  input: "Arrow keys · step 0.1",
  visual: "Grid and Flubber",
  advanced: "Outbound LSL and mappings",
  review: "Resolve blocking checks",
});

export function normalizeSetupSection(sectionId) {
  return SETUP_SECTIONS.some(({ id }) => id === sectionId) ? sectionId : SETUP_SECTIONS[0].id;
}

export function nextOpenSetupSection(currentSectionId, requestedSectionId) {
  const requested = normalizeSetupSection(requestedSectionId);
  return requested === currentSectionId ? currentSectionId : requested;
}

export function normalizeResearchMode(mode) {
  return RESEARCH_MODES.includes(mode) ? mode : "setup";
}

export function estimateResearchStorageUse(settings, resolvedPlan) {
  if (!settings || !resolvedPlan) return null;
  const durations = new Map(settings.stimuli.items.map(({ stimulusId, source }) => [
    stimulusId,
    source.durationMs ?? source.observedDurationMs ?? 0,
  ]));
  const sampleRows = resolvedPlan.assignments.reduce((sum, assignment) => sum + assignment.slots.reduce(
    (slotSum, slot) => slotSum + Math.ceil(
      (Math.max(0, durations.get(slot.stimulusId) ?? 0) / 1_000)
      * settings.experiment.samplingFrequencyHz,
    ),
    0,
  ), 0);
  const formatCount = Number(settings.output.csv) + Number(settings.output.tsv);
  // Reserve for the authoritative IndexedDB journal as well as the selected
  // tabular exports. The multiplier is deliberately conservative: it covers
  // structured-clone/index overhead, canonical records, timing events, frozen
  // settings/manifests, and a 25% write/finalization margin.
  const journalBytes = sampleRows * 1_024;
  const tabularBytes = sampleRows * 512 * formatCount;
  const attemptOverheadBytes = resolvedPlan.assignments.length * 64 * 1_024;
  const subtotalBytes = journalBytes + tabularBytes + attemptOverheadBytes;
  const requiredBytes = Math.ceil(subtotalBytes * 1.25);
  if (!Number.isSafeInteger(sampleRows) || !Number.isSafeInteger(requiredBytes)) {
    throw new RangeError("The resolved experiment exceeds the safe storage-estimation range.");
  }
  return Object.freeze({ sampleRows, requiredBytes, estimationVersion: "conservative-v1" });
}

export function normalizeAttemptDisposition(participantState, requestedDisposition) {
  return participantState === "partial" && requestedDisposition === "resume-compatible"
    ? "resume-compatible"
    : "new-attempt";
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function previewMarkup(label) {
  return `
    <div class="research-preview-stage" role="img" aria-label="${escapeAttribute(label)}">
      <div
        class="preview-overlay"
        data-preview-overlay
        data-locked="false"
        aria-hidden="true"
      >
        <canvas class="preview-grid-canvas" data-preview-grid-canvas aria-hidden="true"></canvas>
        <svg data-preview-grid viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <line data-preview-grid-line class="preview-grid-lines" x1="25" y1="0" x2="25" y2="100"></line>
          <line data-preview-grid-line class="preview-grid-lines" x1="50" y1="0" x2="50" y2="100"></line>
          <line data-preview-grid-line class="preview-grid-lines" x1="75" y1="0" x2="75" y2="100"></line>
          <line data-preview-grid-line class="preview-grid-lines" x1="0" y1="25" x2="100" y2="25"></line>
          <line data-preview-grid-line class="preview-grid-lines" x1="0" y1="50" x2="100" y2="50"></line>
          <line data-preview-grid-line class="preview-grid-lines" x1="0" y1="75" x2="100" y2="75"></line>
          <rect data-preview-grid-outline class="preview-grid-outline" x="0.5" y="0.5" width="99" height="99" fill="none"></rect>
          <circle data-preview-grid-cursor class="preview-grid-cursor" cx="50" cy="50" r="4"></circle>
        </svg>
        <svg data-preview-flubber class="preview-flubber" viewBox="-1.62 -1.62 3.24 3.24" aria-hidden="true" focusable="false">
          <path data-preview-flubber-halo class="preview-flubber-halo"></path>
          <path data-preview-flubber-base class="preview-flubber-base"></path>
          <path data-preview-flubber-outline class="preview-flubber-outline"></path>
        </svg>
      </div>
    </div>`;
}

function workspaceSection() {
  return `
    <p class="section-lead">Choose one parent folder. Affect Research creates or validates the four owned libraries beneath it; no other folder becomes writable research state.</p>
    <div class="field-grid">
      <div class="field-block is-wide">
        <span class="field-label">Parent workspace</span>
        <output id="workspace-root" class="field-output" data-state="warning">No workspace selected</output>
      </div>
    </div>
    <div class="section-actions">
      <button id="workspace-choose" type="button" class="primary-action">Select workspace</button>
      <button id="workspace-renew" type="button" hidden>Renew folder access</button>
      <button id="workspace-rescan" type="button" disabled>Rescan</button>
    </div>
    <ul class="directory-list" aria-label="Workspace folders">
      <li>stimuli/</li>
      <li>settings/</li>
      <li>outputs/</li>
      <li>recovery/</li>
    </ul>
    <div id="video-drop-zone" class="drop-zone" role="group" aria-describedby="video-drop-help" aria-label="Complete video import and drop area">
      <p>Drop complete video files or a folder here</p>
      <div class="button-row"><button id="video-import" type="button" disabled>Import videos</button><button id="video-folder-import" type="button" disabled>Import folder</button></div>
      <p id="video-drop-help" class="field-help">Folders are scanned recursively. Affect Research does not create clips or change start and end times.</p>
    </div>
    <div class="section-actions">
      <button id="settings-load" type="button">Load settings.json</button>
      <button id="settings-save" type="button" disabled>Save settings.json</button>
    </div>
    <div class="field-block">
      <span class="field-label">Interrupted-run recovery</span>
      <output class="field-output" data-state="ready">Partial ratings are always journaled locally</output>
      <p class="field-help">Recovery resumes only at a safe stimulus boundary; a partly viewed video restarts from the beginning.</p>
    </div>
    <p id="workspace-status" class="status-text" role="status" aria-live="polite">Select a workspace before importing or saving.</p>
    <div class="table-scroll" aria-label="Stimulus library">
      <table>
        <thead><tr><th>Video</th><th>Source</th><th>Verification</th><th>Pool</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody id="stimulus-library-table"><tr><td colspan="5" class="empty-state">No complete videos have been imported.</td></tr></tbody>
      </table>
    </div>`;
}

function experimentSection() {
  return `
    <p class="section-lead">Define one continuous-rating protocol. These values determine participant IDs, timing, settings filename, and output paths.</p>
    <div class="field-grid">
      <label class="field"><span>Experiment ID</span><input id="experiment-id" name="experimentId" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value="video-affect-v1" autocomplete="off"></label>
      <label class="field"><span>Experiment title</span><input id="experiment-title" name="experimentTitle" required maxlength="120" value="Video Affect Study" autocomplete="off"></label>
      <label class="field"><span>Total participant count</span><input id="participant-count" name="participantCount" type="number" min="1" max="100000" step="1" value="24" required></label>
      <label class="field"><span>Sampling frequency</span><div class="range-field"><input id="sampling-frequency" name="samplingFrequency" type="number" min="1" max="240" step="1" value="130" required><output for="sampling-frequency">130 Hz</output></div></label>
      <div class="field-block is-wide">
        <span class="field-label">Rating method</span>
        <output class="field-output" data-state="ready">Continuous rating is always enabled</output>
        <p class="field-help">Samples are collected only while a complete video is actively playing. There is no summary-rating mode.</p>
      </div>
      <fieldset class="radio-group is-wide" id="transition-mode-group">
        <legend>Between-video behavior</legend>
        <label class="radio-field"><input type="radio" name="transitionMode" value="fixed" checked><span>Fixed duration</span></label>
        <label class="radio-field"><input type="radio" name="transitionMode" value="jitter"><span>Deterministic jitter selected from entered durations</span></label>
        <label class="radio-field"><input type="radio" name="transitionMode" value="continue"><span>Participant-controlled <strong>Continue when ready</strong></span></label>
      </fieldset>
      <label class="field" id="fixed-duration-field"><span>Fixed duration (seconds)</span><input id="fixed-duration" type="number" min="0" max="600" step="0.1" value="5" required></label>
      <label class="field" id="jitter-durations-field" hidden><span>Jitter durations (seconds)</span><input id="jitter-durations" value="3, 5, 7" inputmode="decimal" aria-describedby="jitter-help" required><span id="jitter-help" class="field-help">Comma-separated finite durations. Selection is derived from the recorded plan seed.</span></label>
    </div>`;
}

function stimuliSection() {
  return `
    <p class="section-lead">Place each complete video in exactly one condition column. A single column containing every video is the ordinary one-hat design; multiple columns create stratified pools.</p>
    <div class="section-actions">
      <button id="stimulus-add-workspace" type="button" disabled>Add workspace video</button>
      <button id="stimulus-add-repository" type="button">Add repository asset</button>
      <button id="stimulus-add-youtube" type="button">Add Experimental YouTube</button>
    </div>
    <p id="youtube-boundary" class="capability-note">YouTube is unverified and noncanonical, has no byte hash, fails offline, and is excluded from research qualification. Windows Tauri rejects it until its player boundary is qualified.</p>
    <section id="youtube-preflight-panel" class="youtube-preflight-panel" aria-labelledby="youtube-preflight-title" hidden>
      <div class="youtube-preflight-heading"><h3 id="youtube-preflight-title">Experimental YouTube player preflight</h3><p>Online browser check only · excluded from qualification</p></div>
      <div id="youtube-preflight-player" class="youtube-player-host" aria-label="YouTube player preflight"></div>
      <p id="youtube-preflight-status" class="status-text" role="status" aria-live="polite">Choose Preflight beside a YouTube stimulus.</p>
    </section>
    <div class="condition-toolbar">
      <div>
        <h3>Condition columns</h3>
        <p id="pool-mode-summary" class="field-help">One condition column · one hat</p>
      </div>
      <button id="condition-add" type="button">Add condition column</button>
    </div>
    <div id="condition-pools" class="condition-pools" aria-label="Condition video pools"></div>
    <div id="coverage-message" class="coverage-message" role="status" aria-live="polite">Add at least one complete video and resolve participant capacity.</div>
    <details class="inner-disclosure" open>
      <summary>Ordering and automatic allocation</summary>
      <div class="disclosure-content">
        <div class="field-grid three-columns">
          <label class="field"><span>Condition-order algorithm</span><select id="condition-order"><option value="williams">Williams counterbalancing</option><option value="cyclic">Cyclic rotation</option></select></label>
          <label class="field"><span>Allocation seed</span><input id="allocation-seed" value="${DEFAULT_SETTINGS.stimuli.seed}" minlength="32" maxlength="32" pattern="[a-f0-9]{32}" autocomplete="off"></label>
          <div class="field-block"><span class="field-label">Allocation algorithm</span><output class="field-output">balanced-v1</output></div>
        </div>
        <p class="field-help">Each slot selects lowest total exposure, then lowest exposure at that position, then the deterministic seeded-hash tie-break. Factorial all-permutation schedules are not used.</p>
      </div>
    </details>
    <details class="inner-disclosure" open>
      <summary>Resolved participant preview</summary>
      <div class="disclosure-content">
        <div class="plan-toolbar">
          <div><span class="field-label">Plan hash</span><output id="plan-hash" class="hash-value">Pending valid allocation</output></div>
          <div class="button-row"><button id="plan-window-previous" type="button" disabled>Previous participants</button><button id="plan-window-next" type="button" disabled>Next participants</button><button id="assignment-plan-export" type="button" disabled>Export assignment-plan.csv</button></div>
        </div>
        <div class="table-scroll">
          <table><thead><tr><th>Participant</th><th>Condition order</th><th>Assigned complete videos</th></tr></thead><tbody id="assignment-preview"><tr><td colspan="3" class="empty-state">The resolved schedule appears after the pool design passes capacity checks.</td></tr></tbody></table>
        </div>
        <p id="plan-window-status" class="field-help">Showing 0 of 0 participants.</p>
      </div>
    </details>`;
}

function inputSection() {
  const options = `${INPUT_PRESET_OPTIONS.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}<option value="custom" hidden>Custom binding</option>`;
  const directions = [
    ["up", "Increase arousal"],
    ["down", "Decrease arousal"],
    ["left", "Decrease valence"],
    ["right", "Increase valence"],
  ].map(([id, label]) => `
    <button class="binding-button" type="button" data-binding-direction="${id}" aria-haspopup="dialog">
      <span>${label}</span><output data-binding-value="${id}">${describeInputToken(DEFAULT_SETTINGS.input.directions[id])}</output>
    </button>`).join("");
  return `
    <p class="section-lead">Select a complete preset or capture conflict-free custom actions. Digital controls change state once per physical edge; operating-system key repeat is ignored.</p>
    <div class="field-grid">
      <label class="field"><span>Input Device</span><select id="input-preset">${options}</select></label>
      <label class="field"><span>Step Size</span><input id="input-step-size" type="number" min="0.001" max="1" step="0.001" value="0.1" required><output id="input-step-applicability" class="field-help">Applies to digital edge-triggered presses.</output></label>
    </div>
    <details class="inner-disclosure" open>
      <summary>Custom bindings</summary>
      <div class="disclosure-content">
        <p class="field-help">Select a direction, then perform the keyboard, mouse, wheel, or gamepad action. A captured action cannot be assigned twice.</p>
        <div id="binding-grid" class="binding-grid">${directions}</div>
        <button id="binding-reset" type="button" class="section-actions">Restore selected preset</button>
      </div>
    </details>
    <details class="inner-disclosure" open>
      <summary>Live input test</summary>
      <div class="disclosure-content">
        <div id="input-test" class="input-test" role="group" aria-label="Live input test">
          <div class="input-test-grid" tabindex="0" role="group" aria-label="Input test surface; focus here and use the configured input device" aria-describedby="input-test-status"><span class="input-test-cursor" aria-hidden="true"></span></div>
          <div>
            <p><strong>Input receipt</strong></p>
            <p id="input-test-status" class="status-text" role="status" aria-live="polite">Focus this test and use the selected device.</p>
            <p>Valence <span id="input-test-x">+0.000</span> · Arousal <span id="input-test-y">+0.000</span></p>
            <button id="input-test-reset" type="button">Reset test to neutral</button>
          </div>
        </div>
      </div>
    </details>`;
}

function colorRows() {
  return COLOR_FIELDS.map(({ id, label, value }) => `
    <div class="color-row" data-color-row="${id}">
      <label for="color-${id}">${label}</label>
      <input id="color-${id}" type="color" value="${value}" aria-label="${label} color wheel">
      <input id="color-${id}-hex" value="${value}" minlength="7" maxlength="7" pattern="#[0-9A-Fa-f]{6}" required spellcheck="false" aria-label="${label} hexadecimal value">
      <button type="button" data-color-reset="${id}" aria-label="Reset ${escapeAttribute(label)}">Reset</button>
    </div>`).join("");
}

function visualSection() {
  return `
    <p class="section-lead">Configure the in-application feedback shared by Setup and Run. The preview can be dragged while unlocked; Run always freezes its normalized position.</p>
    <div class="field-grid">
      <label class="check-field"><input id="visual-grid-visible" type="checkbox" checked><span><strong>Grid</strong><br><span class="field-help">Show the valence–arousal field.</span></span></label>
      <label class="check-field"><input id="visual-flubber-visible" type="checkbox" checked><span><strong>Flubber</strong><br><span class="field-help">Show the procedural affect form.</span></span></label>
      <label class="field"><span>Size (% of stage)</span><div class="range-field"><input id="visual-size" type="number" min="5" max="100" step="1" value="${DEFAULT_SETTINGS.visual.sizePercent}" required><output for="visual-size">${DEFAULT_SETTINGS.visual.sizePercent}%</output></div></label>
      <label class="field"><span>Transparency</span><div class="range-field"><input id="visual-transparency" type="range" min="0" max="100" step="1" value="${DEFAULT_SETTINGS.visual.transparency * 100}"><output for="visual-transparency">${DEFAULT_SETTINGS.visual.transparency * 100}%</output></div></label>
      <label class="check-field"><input id="visual-hide-feedback" type="checkbox"><span><strong>Hide Visual Feedback</strong><br><span class="field-help">Acquisition continues while Grid and Flubber are hidden.</span></span></label>
      <label class="check-field"><input id="visual-lock-position" type="checkbox"><span><strong>Lock position</strong><br><span class="field-help">The sole control for disabling drag. Forced on during Run.</span></span></label>
      <label class="field"><span>Normalized horizontal position</span><input id="visual-position-x" type="number" min="0" max="1" step="0.01" value="${DEFAULT_SETTINGS.visual.overlayPosition.x}" required></label>
      <label class="field"><span>Normalized vertical position</span><input id="visual-position-y" type="number" min="0" max="1" step="0.01" value="${DEFAULT_SETTINGS.visual.overlayPosition.y}" required></label>
    </div>
    <details class="inner-disclosure" open>
      <summary>Flubber</summary>
      <div class="disclosure-content field-grid">
        <label class="check-field"><input id="flubber-outline-visible" type="checkbox" checked><span>Show Outline</span></label>
        <label class="field"><span>Outline Thickness</span><div class="range-field"><input id="flubber-outline-thickness" type="range" min="0" max="20" step="0.25" value="${DEFAULT_SETTINGS.visual.flubber.outlineThickness}"><output for="flubber-outline-thickness">${DEFAULT_SETTINGS.visual.flubber.outlineThickness.toFixed(2)}</output></div></label>
        <label class="check-field"><input id="flubber-halo-visible" type="checkbox" checked><span>Show Halo</span></label>
      </div>
    </details>
    <details class="inner-disclosure">
      <summary>Grid</summary>
      <div class="disclosure-content field-grid">
        <label class="field"><span>Grid Line Thickness</span><div class="range-field"><input id="grid-line-thickness" type="range" min="0.25" max="20" step="0.25" value="${DEFAULT_SETTINGS.visual.grid.lineThickness}"><output for="grid-line-thickness">${DEFAULT_SETTINGS.visual.grid.lineThickness.toFixed(2)}</output></div></label>
        <label class="check-field"><input id="grid-outline-visible" type="checkbox" checked><span>Show Outline</span></label>
        <label class="field"><span>Outline Thickness</span><div class="range-field"><input id="grid-outline-thickness" type="range" min="0" max="20" step="0.25" value="${DEFAULT_SETTINGS.visual.grid.outlineThickness}"><output for="grid-outline-thickness">${DEFAULT_SETTINGS.visual.grid.outlineThickness.toFixed(2)}</output></div></label>
        <label class="field"><span>Cursor Size</span><div class="range-field"><input id="grid-cursor-size" type="range" min="2" max="100" step="1" value="${DEFAULT_SETTINGS.visual.grid.cursorSize}"><output for="grid-cursor-size">${DEFAULT_SETTINGS.visual.grid.cursorSize.toFixed(1)}</output></div></label>
      </div>
    </details>
    <details class="inner-disclosure">
      <summary>Color & Gradient</summary>
      <div class="disclosure-content">
        <p class="field-help">The four directional anchors define the valence–arousal field. This section is the sole owner of Halo Color.</p>
        <figure class="gradient-editor" aria-labelledby="main-gradient-caption">
          <figcaption id="main-gradient-caption">Main Gradient · valence–arousal anchors</figcaption>
          <div class="gradient-map">
            <canvas id="main-gradient-canvas" width="144" height="144" role="img" aria-label="Current valence–arousal color field"></canvas>
            <button type="button" class="gradient-anchor anchor-up" data-color-anchor="up">High arousal</button>
            <button type="button" class="gradient-anchor anchor-down" data-color-anchor="down">Low arousal</button>
            <button type="button" class="gradient-anchor anchor-left" data-color-anchor="left">Negative valence</button>
            <button type="button" class="gradient-anchor anchor-right" data-color-anchor="right">Positive valence</button>
          </div>
        </figure>
        <div class="color-list">${colorRows()}</div>
      </div>
    </details>`;
}

function mappingDisclosure(mapping) {
  const step = mapping.allowedMax > 1 ? 0.1 : 0.01;
  const escapedLabel = escapeAttribute(mapping.label);
  const unitSuffix = mapping.unit ? ` (${escapeAttribute(mapping.unit)})` : "";
  return `
    <details class="inner-disclosure mapping-disclosure" data-mapping="${mapping.id}">
      <summary>${mapping.label}</summary>
      <div class="disclosure-content mapping-grid">
        <label class="field"><span>Min${mapping.unit ? ` (${mapping.unit})` : ""}</span><input id="mapping-${mapping.id}-min" data-mapping-min aria-label="${escapedLabel} minimum${unitSuffix}" type="number" min="${mapping.allowedMin}" max="${mapping.allowedMax}" step="${step}" value="${mapping.min}" required></label>
        <label class="field"><span>Max${mapping.unit ? ` (${mapping.unit})` : ""}</span><input id="mapping-${mapping.id}-max" data-mapping-max aria-label="${escapedLabel} maximum${unitSuffix}" type="number" min="${mapping.allowedMin}" max="${mapping.allowedMax}" step="${step}" value="${mapping.max}" required></label>
        <label class="field"><span>Driven By</span><select id="mapping-${mapping.id}-driver" data-mapping-driver aria-label="${escapedLabel} driven by"><option value="x-axis"${mapping.driver === "x-axis" ? " selected" : ""}>x-axis</option><option value="y-axis"${mapping.driver === "y-axis" ? " selected" : ""}>y-axis</option><option value="angle"${mapping.driver === "angle" ? " selected" : ""}>angle</option><option value="radius"${mapping.driver === "radius" ? " selected" : ""}>radius</option></select></label>
        <label class="check-field"><input id="mapping-${mapping.id}-reverse" data-mapping-reverse aria-label="Reverse ${escapedLabel}" type="checkbox"${mapping.reverse ? " checked" : ""}><span>Reverse</span></label>
        <div class="mapping-output"><span>Live preview <span data-mapping-output>0.000${mapping.unit ? ` ${mapping.unit}` : ""}</span></span><span class="mapping-meter" aria-hidden="true"><span data-mapping-meter></span></span></div>
        <p class="field-help is-wide">Allowed output ${mapping.allowedMin}–${mapping.allowedMax}${mapping.unit ? ` ${mapping.unit}` : ""}.</p>
      </div>
    </details>`;
}

function advancedSection() {
  return `
    <p class="section-lead">Advanced settings remain part of the same frozen protocol. LSL is outbound and Windows-only; every Flubber mapping derives from one coordinate snapshot.</p>
    <details class="inner-disclosure" open>
      <summary>LSL</summary>
      <div class="disclosure-content">
        <label class="check-field"><input id="lsl-enabled" type="checkbox"><span><strong>Enable LSL</strong><br><span class="field-help">Publishes the regular eight-channel state stream and irregular semantic marker stream in Windows Tauri.</span></span></label>
        <div class="field-grid spaced-field-grid">
          <label class="field"><span>State Stream</span><input id="lsl-state-stream" value="AffectResearch" maxlength="128"></label>
          <label class="field"><span>Stream Type</span><input id="lsl-stream-type" value="Affect" maxlength="128"></label>
          <label class="field"><span>Marker Stream</span><input id="lsl-marker-stream" value="AffectResearchMarkers" maxlength="128"></label>
          <label class="field"><span>Source ID</span><input id="lsl-source-id" value="affect-research" maxlength="128"></label>
        </div>
        <p id="lsl-capability" class="capability-note" role="status">Browser mode preserves these values but cannot start while LSL is enabled.</p>
      </div>
    </details>
    <div aria-labelledby="mapping-title">
      <h3 id="mapping-title" class="mapping-title">Flubber–Affect Mapping</h3>
      <p class="field-help">x-axis and y-axis normalize from [−1, 1], radius from [0, 1], and angle from [0°, 360°). Neutral angle is zero. Reverse changes t to 1−t before interpolation.</p>
      ${MAPPING_FIELDS.map(mappingDisclosure).join("")}
    </div>`;
}

function reviewSection() {
  return `
    <p class="section-lead">Start is fail-closed. Review the resolved plan, privacy-safe participant identity, local outputs, input receipt, media verification, timing capability, and platform-specific LSL state.</p>
    <ul id="preflight-list" class="preflight-list" aria-label="Experiment preflight checks"></ul>
    <details class="inner-disclosure" open>
      <summary>Resolved schedule and output</summary>
      <div class="disclosure-content field-grid">
        <div class="field-block is-wide"><span class="field-label">Output location</span><output id="review-output-path" class="field-output path-value">outputs/&lt;experiment-id&gt;/&lt;participant-id&gt;/&lt;session-stem&gt;/</output></div>
        <div class="field-block"><span class="field-label">Settings hash</span><output id="settings-hash" class="field-output hash-value">Pending validated settings</output></div>
        <div class="field-block"><span class="field-label">Assignment plan hash</span><output id="review-plan-hash" class="field-output hash-value">Pending valid allocation</output></div>
        <div class="field-block"><span class="field-label">Estimated storage</span><output id="storage-estimate" class="field-output">Pending verified videos</output></div>
        <div class="field-block"><span class="field-label">Sampling capability</span><output id="timing-capability" class="field-output">Dedicated scheduler not yet verified</output></div>
        <label class="field is-wide tauri-only"><span>Windows playback qualification</span><select id="native-playback-mode"><option value="nativeLibvlc" selected>Native libVLC player · qualification required</option><option value="unqualifiedWebview">WebView video · unqualified testing only</option></select><output id="native-media-capability" class="field-help">Native runtime capability has not been checked.</output></label>
      </div>
    </details>
    <details class="inner-disclosure" open>
      <summary>Participant chooser</summary>
      <div class="disclosure-content">
        <p class="field-help">States are reconstructed from workspace locks, recovery journals, and manifests. They are not editable flags.</p>
        <div class="participant-toolbar"><button id="participant-window-previous" type="button" disabled>Previous participants</button><output id="participant-window-status">Showing 1–24 of 24</output><button id="participant-window-next" type="button" disabled>Next participants</button></div>
        <div id="participant-grid" class="participant-grid" role="radiogroup" aria-label="Participant state chooser"></div>
        <fieldset id="attempt-disposition" class="check-group attempt-disposition" hidden>
          <legend>Attempt handling</legend>
          <label id="attempt-resume-option" class="radio-field"><input type="radio" name="attemptDisposition" value="resume-compatible" aria-describedby="attempt-disposition-note"><span><strong>Resume compatible partial</strong><br><span class="field-help">Verify the frozen settings and plan hashes, then restart at the last safe stimulus boundary.</span></span></label>
          <label id="attempt-new-option" class="radio-field"><input type="radio" name="attemptDisposition" value="new-attempt" aria-describedby="attempt-disposition-note"><span><strong>Start a new attempt</strong><br><span class="field-help">Keep all earlier evidence and allocate the next create-new attempt number.</span></span></label>
          <p id="attempt-disposition-note" class="field-help" role="status">Choose how to handle the selected participant's existing evidence.</p>
          <label id="participant-rerun-confirm-field" class="check-field" hidden><input id="participant-rerun-confirm" type="checkbox" aria-describedby="participant-rerun-warning"><span>I confirm this completed participant should receive a new attempt.</span></label>
        </fieldset>
        <p id="participant-rerun-warning" class="coverage-message" hidden role="status"></p>
        <p id="participant-active-warning" class="coverage-message" hidden role="status">This participant has an active lock. Finish or recover that active attempt before starting here.</p>
      </div>
    </details>
    <details class="inner-disclosure" open>
      <summary>Transient participant details</summary>
      <div class="disclosure-content">
        <p class="field-help">Names are used only to derive an uppercase two-grapheme code. Raw names and any self-description are removed before Start and never enter files, logs, markers, or recovery state.</p>
        <div class="field-grid spaced-field-grid">
          <label class="field"><span>First name</span><input id="participant-first-name" required autocomplete="off" maxlength="120"></label>
          <label class="field"><span>Last name</span><input id="participant-last-name" required autocomplete="off" maxlength="120"></label>
          <label class="field"><span>Age</span><input id="participant-age" type="number" min="1" max="120" step="1" required></label>
          <label class="field"><span>Gender</span><select id="participant-gender" required><option value="">Select…</option><option value="W">Woman</option><option value="M">Man</option><option value="N">Non-binary</option><option value="S">Self-described</option><option value="X">Prefer not to say</option></select></label>
          <label class="field is-wide"><span>Handedness</span><select id="participant-handedness" required><option value="">Select…</option><option value="L">Left</option><option value="R">Right</option><option value="A">Ambidextrous</option></select></label>
          <div class="field-block is-wide"><span class="field-label">Derived participant code</span><output id="participant-code" class="field-output">Enter first and last name</output></div>
        </div>
      </div>
    </details>
    <fieldset id="output-format-group" class="check-group spaced-check-group" aria-describedby="output-format-help output-format-error">
      <legend>Rating output formats</legend>
      <label class="check-field"><input id="output-csv" type="checkbox" checked><span>CSV</span></label>
      <label class="check-field"><input id="output-tsv" type="checkbox"><span>TSV</span></label>
      <p id="output-format-help" class="field-help">Both formats serialize the same canonical records with identical columns, order, values, and row count. At least one is required.</p>
      <p id="output-format-error" class="field-error" hidden>Select CSV, TSV, or both.</p>
    </fieldset>
    <div class="start-bar">
      <p id="start-status" role="status" aria-live="polite">Resolve all blocking preflight items.</p>
      <button id="start-experiment" type="button" class="primary-action" disabled>Start experiment / session</button>
    </div>`;
}

const SECTION_CONTENT = Object.freeze({
  workspace: workspaceSection,
  experiment: experimentSection,
  stimuli: stimuliSection,
  input: inputSection,
  visual: visualSection,
  advanced: advancedSection,
  review: reviewSection,
});

function accordionMarkup(section, index) {
  const expanded = index === 0;
  return `
    <section class="setup-accordion" data-setup-section="${section.id}">
      <h2 class="setup-accordion-heading">
        <button
          class="setup-accordion-trigger"
          type="button"
          id="setup-trigger-${section.id}"
          aria-expanded="${expanded}"
          aria-controls="setup-panel-${section.id}"
          data-open-section="${section.id}"
        >
          <span class="section-number">${index + 1}</span>
          <span class="section-title">${section.label}</span>
          <span class="section-summary" data-section-summary="${section.id}">${SECTION_SUMMARIES[section.id]}</span>
          <span class="section-chevron" aria-hidden="true">${expanded ? "−" : "+"}</span>
        </button>
      </h2>
      <div
        class="setup-accordion-panel"
        id="setup-panel-${section.id}"
        role="region"
        aria-labelledby="setup-trigger-${section.id}"
        ${expanded ? "" : "hidden"}
      >${SECTION_CONTENT[section.id]()}</div>
    </section>`;
}

export function renderResearchUiMarkup(surface = "browser") {
  const platformLabel = surface === "tauri" ? "Windows desktop adapter" : "Desktop Chrome / Edge adapter";
  return `
    <div class="research-shell" data-research-mode="setup">
      <header class="app-bar">
        <div class="product-block"><h1>Affect Research</h1><p class="build-label">0.4.0-alpha.1</p></div>
        <nav class="mode-navigation" aria-label="Application mode">
          <button type="button" data-mode-button="setup" aria-current="page">Setting Up the Experiment</button>
          <button type="button" data-mode-button="run" disabled>Running the Experiment</button>
        </nav>
        <p class="surface-status">${platformLabel}</p>
      </header>
      <main>
        <section class="setup-mode" data-mode-panel="setup" aria-label="Setting Up the Experiment">
          <div class="setup-layout">
            <form id="research-settings-form" class="setup-pane" novalidate>
              <div class="setup-intro"><p>Seven decisions lead to one frozen session.</p><output id="setup-progress" class="setup-progress">0 of 7 ready</output></div>
              ${SETUP_SECTIONS.map(accordionMarkup).join("")}
            </form>
            <aside class="preview-pane" aria-labelledby="preview-title">
              <header class="preview-header">
                <div><h2 id="preview-title">Live feedback preview</h2><p>Presentation only. Sampling uses the run scheduler.</p></div>
                <div class="preview-coordinates"><span>Valence</span><span data-preview-x>+0.000</span><span>Arousal</span><span data-preview-y>+0.000</span></div>
              </header>
              ${previewMarkup("Live Grid and Flubber settings preview")}
              <footer class="preview-footer">
                <div class="preview-metric"><span>Position</span><span data-preview-position>0.50, 0.50</span></div>
                <div class="preview-metric"><span>Input test</span><span id="preview-input-source">Arrow keys</span></div>
                <div class="preview-metric"><span>Sampling</span><span id="preview-sampling-rate">130 Hz</span></div>
              </footer>
            </aside>
          </div>
        </section>
        <section class="run-mode" data-mode-panel="run" aria-label="Running the Experiment" hidden>
          <header class="run-header">
            <div class="run-identity"><strong id="run-participant">Participant —</strong><p id="run-session">Session not started</p></div>
            <div class="run-actions"><button id="run-pause" type="button" aria-pressed="false">Pause</button><button id="run-stop-early" type="button" class="danger-action">Stop Early</button></div>
          </header>
          <div class="run-stage">
            <section class="stimulus-stage" aria-label="Current complete stimulus">
              <video id="run-video" preload="metadata" playsinline aria-label="Protocol-controlled current stimulus video"></video>
              <p id="run-stimulus-placeholder" class="stimulus-placeholder">The verified complete video appears here after the run authority starts the attempt.</p>
              <div id="run-youtube-player" class="youtube-player-host run-youtube-player" aria-label="Experimental YouTube stimulus player" hidden></div>
            </section>
            <aside class="run-feedback-stage" aria-label="Configured adjacent visual feedback">
              ${previewMarkup("Run Grid and Flubber feedback")}
              <p id="run-feedback-placeholder" class="run-feedback-placeholder" hidden>Visual feedback is hidden by the protocol. Sampling continues.</p>
            </aside>
          </div>
          <footer class="run-footer">
            <div class="run-status-strip" aria-label="Session status">
              <p>Stimulus <span id="run-stimulus-status">Waiting</span></p><span class="status-separator" aria-hidden="true">|</span>
              <p>Timing <span id="run-timing-status">Stopped</span></p><span class="status-separator" aria-hidden="true">|</span>
              <p>Write / recovery <span id="run-write-status">Journal pending</span></p><span class="status-separator" aria-hidden="true">|</span>
              <p>LSL <span id="run-lsl-status">Off</span></p>
            </div>
            <p>Valence <span data-preview-x>+0.000</span> · Arousal <span data-preview-y>+0.000</span></p>
          </footer>
          <section id="run-transition" class="run-transition" hidden aria-live="polite">
            <h2>Between videos</h2>
            <p id="run-transition-message">Sampling is stopped and the rating is neutral.</p>
            <button id="run-continue" type="button" class="primary-action" hidden>Continue when ready</button>
          </section>
        </section>
      </main>
    </div>
    <input id="settings-file-input" type="file" accept="application/json,.json" hidden>
    <input id="video-file-input" type="file" accept="video/*" multiple hidden>
    <input id="video-folder-input" type="file" accept="video/*" webkitdirectory directory multiple hidden>
    <dialog id="binding-capture-dialog" aria-labelledby="binding-capture-title">
      <div class="dialog-content"><h2 id="binding-capture-title">Capture custom binding</h2><p id="binding-capture-instruction">Perform one keyboard, mouse, wheel, or gamepad action.</p><div id="binding-capture-receipt" class="capture-receipt" role="status" aria-live="polite">Waiting for an input edge…</div></div>
      <div class="dialog-actions"><button id="binding-capture-cancel" type="button">Cancel</button></div>
    </dialog>
    <dialog id="stimulus-dialog" aria-labelledby="stimulus-dialog-title">
      <div class="dialog-content"><h2 id="stimulus-dialog-title">Add stimulus</h2><div class="field-grid"><label class="field"><span>Source</span><select id="stimulus-source"><option value="workspace">Workspace file</option><option value="repository">Repository asset</option><option value="youtube">Experimental YouTube URL</option></select></label><label class="field"><span>Display title</span><input id="stimulus-title" maxlength="120"></label><label class="field is-wide"><span id="stimulus-location-label">Workspace catalogue item</span><input id="stimulus-location" maxlength="2048" autocomplete="off"></label><label class="field"><span>Condition column</span><select id="stimulus-condition"></select></label></div><p id="stimulus-dialog-help" class="field-help">Complete-file duration, byte identity, and decode verification are required before Start.</p></div>
      <div class="dialog-actions"><button id="stimulus-dialog-cancel" type="button">Cancel</button><button id="stimulus-dialog-add" type="button" class="primary-action">Add complete video</button></div>
    </dialog>
    <dialog id="stop-early-dialog" aria-labelledby="stop-early-title">
      <div class="dialog-content"><h2 id="stop-early-title">Stop this attempt early?</h2><p>A controlled stop finalizes an explicitly partial result and cannot be resumed. Accepted samples and events are retained. Only an interrupted, recoverable attempt restarts its current video from the beginning.</p></div>
      <div class="dialog-actions"><button id="stop-early-cancel" type="button">Keep running</button><button id="stop-early-confirm" type="button" class="danger-action">Finalize partial result</button></div>
    </dialog>
    <dialog id="completion-dialog" aria-labelledby="completion-title">
      <div class="dialog-content"><h2 id="completion-title">Attempt receipt</h2><ul id="completion-receipt" class="receipt-list"></ul></div>
      <div class="dialog-actions"><button id="completion-return" type="button" class="primary-action">Return to Setup</button></div>
    </dialog>
    <dialog id="import-report-dialog" aria-labelledby="import-report-title">
      <div class="dialog-content"><h2 id="import-report-title">Legacy import report</h2><p>Every mapped, defaulted, and discarded field is listed. Storage was not migrated.</p><div class="table-scroll"><table><thead><tr><th>Status</th><th>Source</th><th>Research target</th><th>Decision</th></tr></thead><tbody id="import-report-body"></tbody></table></div></div>
      <div class="dialog-actions"><button id="import-report-close" type="button" class="primary-action">Close report</button></div>
    </dialog>
    <div id="research-announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>`;
}

function boot() {
  const mount = document.querySelector("#research-app");
  if (!(mount instanceof HTMLElement)) return;
  const surface = mount.dataset.researchSurface === "tauri" ? "tauri" : "browser";
  mount.innerHTML = renderResearchUiMarkup(surface);
  mount.setAttribute("aria-busy", "false");
  initializeResearchUi(mount, { surface });
}

export function initializeResearchUi(root, { surface = "browser" } = {}) {
  const shell = root.querySelector(".research-shell");
  if (!(shell instanceof HTMLElement)) throw new Error("Research shell is missing");
  const controller = createUiController(root, { surface });
  root.researchUi = controller;
  return controller;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}

// Interaction and projection code is kept below the declarative instrument so
// importing this module for contract tests never requires a DOM.
function createUiController(root, { surface }) {
  return createInteractionController(root, { surface });
}

function createInteractionController(root, { surface }) {
  // Implemented in the following section of this module.
  return bindResearchInteractions(root, { surface });
}

function bindResearchInteractions(root, { surface }) {
  const shell = root.querySelector(".research-shell");
  const announcer = root.querySelector("#research-announcer");
  let openSection = "workspace";
  let mode = "setup";
  let selectedParticipant = "P001";
  let inputPoint = { x: 0, y: 0 };
  let inputBinding = structuredClone(DEFAULT_SETTINGS.input);
  let inputController = null;
  let gamepadCaptureFrame = null;
  let inputTestPassed = false;
  let nativeInputReceiptId = null;
  let nativeCaptureDirection = null;
  let nativeInputLastSequence = 0;
  let lastInputActive = false;
  let outputFormatsTouched = false;
  let participantWindowStart = 0;
  let participantTileWindowStart = 0;
  let dispositionContextKey = "";
  let workspace = null;
  let plan = null;
  let planError = null;
  let planRefresh = 0;
  let settingsSnapshot = null;
  let settingsHash = null;
  let gradientFingerprint = "";
  let youtubePreflightAdapter = null;
  let storageReadiness = null;
  let nativeMediaCapability = null;
  const capabilities = {
    directoryPermission: false,
    indexedDbReady: false,
    timingWorkerReady: false,
    lslReady: false,
    manifestReady: false,
    storageReady: false,
    repositoryAssetsReady: surface === "browser",
    nativePlaybackReady: surface === "browser",
    nativeInputReady: surface === "browser",
    nativeInputPresetReady: surface === "browser",
  };

  function resetInputTest({ notify = true } = {}) {
    inputTestPassed = false;
    nativeInputReceiptId = null;
    if (surface === "tauri" && notify) {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputBindingChanged, {
        bubbles: true,
        detail: Object.freeze({ binding: structuredClone(inputBinding) }),
      }));
    }
  }
  let manifestReadinessMessage = "Output manifests have not been scanned.";
  const pools = [{ id: "condition-1", label: "Condition 1", videosPerParticipant: 1 }];
  const stimuli = [];
  const participantStates = new Map();
  const participantRecoverability = new Map();
  const touchedValidationControls = new WeakSet();

  const setupPreview = createResearchPreview(root.querySelector(".preview-pane"), {
    onPositionChange(position) {
      setInputValue("visual-position-x", position.x.toFixed(2));
      setInputValue("visual-position-y", position.y.toFixed(2));
      refreshProjection();
      schedulePlanRefresh();
    },
  });
  const runPreview = createResearchPreview(root.querySelector(".run-feedback-stage"), {
    initialState: { lockPosition: true },
  });

  function query(selector) {
    return root.querySelector(selector);
  }

  function value(id, fallback = "") {
    const element = query(`#${id}`);
    return element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? element.value
      : fallback;
  }

  function numberValue(id, fallback = 0) {
    const parsed = Number(value(id));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function checked(id) {
    const element = query(`#${id}`);
    return element instanceof HTMLInputElement && element.checked;
  }

  function setInputValue(id, nextValue) {
    const element = query(`#${id}`);
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      element.value = String(nextValue);
    }
  }

  function setChecked(id, nextValue) {
    const element = query(`#${id}`);
    if (element instanceof HTMLInputElement) element.checked = Boolean(nextValue);
  }

  function isValidationControl(element) {
    return element instanceof HTMLInputElement
      || element instanceof HTMLSelectElement
      || element instanceof HTMLTextAreaElement;
  }

  function validationMessage(control) {
    if (control.validity.valueMissing) return "This field is required.";
    if (control.validity.rangeUnderflow) return `Enter a value of at least ${control.min}.`;
    if (control.validity.rangeOverflow) return `Enter a value no greater than ${control.max}.`;
    if (control.validity.stepMismatch) return `Enter a value using increments of ${control.step}.`;
    if (control.validity.patternMismatch) return "Enter a value in the required format.";
    if (control.validity.tooLong) return `Use no more than ${control.maxLength} characters.`;
    if (control.validity.tooShort) return `Use at least ${control.minLength} characters.`;
    if (control.validity.badInput || control.validity.typeMismatch) return "Enter a valid value.";
    return control.validationMessage || "Correct this field before starting.";
  }

  function setErrorReference(control, errorId, enabled) {
    const ids = new Set((control.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean));
    if (enabled) ids.add(errorId);
    else ids.delete(errorId);
    if (ids.size > 0) control.setAttribute("aria-describedby", [...ids].join(" "));
    else control.removeAttribute("aria-describedby");
  }

  function syncControlValidation(control, { force = false } = {}) {
    if (!isValidationControl(control) || !control.id || !control.willValidate || control.disabled) return true;
    const inactive = control.closest("#fixed-duration-field[hidden], #jitter-durations-field[hidden]") !== null;
    const invalid = !inactive && !control.checkValidity();
    const errorId = `${control.id}-error`;
    let error = query(`#${errorId}`);
    if (!invalid) {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-errormessage");
      setErrorReference(control, errorId, false);
      if (error instanceof HTMLElement) error.hidden = true;
      return true;
    }
    if (!force && !touchedValidationControls.has(control)) return false;
    if (!(error instanceof HTMLElement)) {
      error = document.createElement("span");
      error.id = errorId;
      error.className = "field-error";
      (control.closest(".field") ?? control.parentElement)?.append(error);
    }
    error.textContent = validationMessage(control);
    error.hidden = false;
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-errormessage", errorId);
    setErrorReference(control, errorId, true);
    return false;
  }

  function syncOutputFormatValidation({ force = false } = {}) {
    const valid = checked("output-csv") || checked("output-tsv");
    const group = query("#output-format-group");
    const error = query("#output-format-error");
    if (group instanceof HTMLElement) {
      if (valid) group.removeAttribute("aria-invalid");
      else if (force || outputFormatsTouched) group.setAttribute("aria-invalid", "true");
    }
    if (error instanceof HTMLElement) error.hidden = valid || (!force && !outputFormatsTouched);
    return valid;
  }

  function syncFieldValidation({ force = false } = {}) {
    let valid = true;
    root.querySelectorAll("input, select, textarea").forEach((control) => {
      if (!syncControlValidation(control, { force })) valid = false;
    });
    return syncOutputFormatValidation({ force }) && valid;
  }

  function announce(message) {
    if (announcer instanceof HTMLElement) announcer.textContent = String(message);
  }

  function setMode(nextMode) {
    mode = normalizeResearchMode(nextMode);
    shell.dataset.researchMode = mode;
    root.querySelectorAll("[data-mode-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-mode-panel") !== mode;
    });
    root.querySelectorAll("[data-mode-button]").forEach((button) => {
      const active = button.getAttribute("data-mode-button") === mode;
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    announce(mode === "run" ? "Running the Experiment mode" : "Setting Up the Experiment mode");
  }

  function openSetupSection(sectionId, { focus = false } = {}) {
    openSection = nextOpenSetupSection(openSection, sectionId);
    root.querySelectorAll("[data-setup-section]").forEach((section) => {
      const isOpen = section.getAttribute("data-setup-section") === openSection;
      const trigger = section.querySelector(".setup-accordion-trigger");
      const panel = section.querySelector(".setup-accordion-panel");
      if (trigger instanceof HTMLButtonElement) {
        trigger.setAttribute("aria-expanded", String(isOpen));
        const chevron = trigger.querySelector(".section-chevron");
        if (chevron) chevron.textContent = isOpen ? "−" : "+";
        if (isOpen && focus) trigger.focus();
      }
      if (panel instanceof HTMLElement) panel.hidden = !isOpen;
    });
    if (surface === "tauri" && openSection === "input") {
      queueMicrotask(() => root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputBindingChanged, {
        bubbles: true,
        detail: Object.freeze({ binding: structuredClone(inputBinding) }),
      })));
    }
  }

  function colorValues() {
    return Object.fromEntries(COLOR_FIELDS.map(({ id, value: fallback }) => {
      const current = value(`color-${id}-hex`, fallback).trim().toLowerCase();
      return [id, /^#[0-9a-f]{6}$/.test(current) ? current : fallback];
    }));
  }

  function driverValue(driver, x, y) {
    if (driver === "x-axis") return (x + 1) / 2;
    if (driver === "y-axis") return (y + 1) / 2;
    if (driver === "radius") return Math.min(1, Math.hypot(x, y));
    if (Math.abs(x) < 0.000001 && Math.abs(y) < 0.000001) return 0;
    const angle = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    return angle / 360;
  }

  function mappingValues(x, y) {
    const mappings = Object.fromEntries(MAPPING_FIELDS.map((spec) => {
      const disclosure = query(`[data-mapping="${spec.id}"]`);
      if (!(disclosure instanceof HTMLElement)) return [spec.contractId, {
        min: spec.min,
        max: spec.max,
        drivenBy: spec.driver,
        reverse: spec.reverse,
      }];
      const minimum = Number(disclosure.querySelector("[data-mapping-min]")?.value);
      const maximum = Number(disclosure.querySelector("[data-mapping-max]")?.value);
      const driver = disclosure.querySelector("[data-mapping-driver]")?.value ?? spec.driver;
      const reverse = disclosure.querySelector("[data-mapping-reverse]")?.checked === true;
      return [spec.contractId, { min: minimum, max: maximum, drivenBy: driver, reverse }];
    }));
    let values;
    try {
      values = evaluateFlubberMappings(mappings, { x, y });
    } catch {
      values = evaluateFlubberMappings(DEFAULT_SETTINGS.advanced.mappings, { x, y });
    }
    for (const spec of MAPPING_FIELDS) {
      const disclosure = query(`[data-mapping="${spec.id}"]`);
      if (!(disclosure instanceof HTMLElement)) continue;
      const mapping = mappings[spec.contractId];
      const raw = driverValue(mapping.drivenBy, x, y);
      const t = mapping.reverse ? 1 - raw : raw;
      const result = values[spec.contractId];
      const output = disclosure.querySelector("[data-mapping-output]");
      const meter = disclosure.querySelector("[data-mapping-meter]");
      if (output) output.textContent = `${result.toFixed(3)}${spec.unit ? ` ${spec.unit}` : ""}`;
      if (meter instanceof HTMLElement) meter.style.setProperty("--mapping-progress", `${Math.max(0, Math.min(100, t * 100))}%`);
    }
    return values;
  }

  function previewState({ locked = false } = {}) {
    const mappings = mappingValues(inputPoint.x, inputPoint.y);
    return {
      x: inputPoint.x,
      y: inputPoint.y,
      gridVisible: checked("visual-grid-visible"),
      flubberVisible: checked("visual-flubber-visible"),
      hideFeedback: checked("visual-hide-feedback"),
      sizePercent: numberValue("visual-size", 42),
      transparencyPercent: numberValue("visual-transparency", 0),
      position: { x: numberValue("visual-position-x", 0.5), y: numberValue("visual-position-y", 0.5) },
      lockPosition: locked || checked("visual-lock-position"),
      colors: colorValues(),
      flubber: {
        showOutline: checked("flubber-outline-visible"),
        outlineThickness: numberValue("flubber-outline-thickness", 2),
        showHalo: checked("flubber-halo-visible"),
      },
      grid: {
        lineThickness: numberValue("grid-line-thickness", 1),
        showOutline: checked("grid-outline-visible"),
        outlineThickness: numberValue("grid-outline-thickness", 1.5),
        cursorSize: numberValue("grid-cursor-size", 4),
      },
      frequency: mappings.oscillationFrequency,
      edgeSmoothness: mappings.edgeSmoothness,
      amplitude: mappings.projectionAmplitude,
      pulseSynchrony: mappings.pulseSynchrony,
      waveVariation: mappings.waveSizeVariation,
      saturation: mappings.saturation,
    };
  }

  function refreshRangeOutputs() {
    const fields = [
      ["sampling-frequency", (v) => `${Math.round(v)} Hz`],
      ["visual-size", (v) => `${Math.round(v)}%`],
      ["visual-transparency", (v) => `${Math.round(v)}%`],
      ["flubber-outline-thickness", (v) => v.toFixed(2)],
      ["grid-line-thickness", (v) => v.toFixed(2)],
      ["grid-outline-thickness", (v) => v.toFixed(2)],
      ["grid-cursor-size", (v) => v.toFixed(1)],
    ];
    for (const [id, format] of fields) {
      const input = query(`#${id}`);
      const output = input?.parentElement?.querySelector("output");
      if (output) output.textContent = format(numberValue(id));
    }
    const sampling = query("#preview-sampling-rate");
    if (sampling) sampling.textContent = `${Math.round(numberValue("sampling-frequency", 130))} Hz`;
  }

  function refreshProjection() {
    refreshRangeOutputs();
    const projected = previewState();
    const nextGradientFingerprint = [projected.colors.up, projected.colors.down, projected.colors.left, projected.colors.right].join(":");
    if (nextGradientFingerprint !== gradientFingerprint) {
      gradientFingerprint = nextGradientFingerprint;
      const canvas = query("#main-gradient-canvas");
      if (canvas instanceof HTMLCanvasElement) drawAffectField(canvas, projected.colors);
    }
    setupPreview.update(projected);
    runPreview.update(previewState({ locked: true }));
    renderExperimentConditionalFields();
    renderInputPreset();
    renderReview();
  }

  function renderExperimentConditionalFields() {
    const selected = query('input[name="transitionMode"]:checked')?.value ?? "fixed";
    const fixed = query("#fixed-duration-field");
    const jitter = query("#jitter-durations-field");
    if (fixed instanceof HTMLElement) fixed.hidden = selected !== "fixed";
    if (jitter instanceof HTMLElement) jitter.hidden = selected !== "jitter";
  }

  function selectedPreset() {
    if (value("input-preset") === "custom") {
      return { id: "custom", contractId: "custom", label: "Custom binding", digital: true };
    }
    return INPUT_PRESET_OPTIONS.find(({ id }) => id === value("input-preset")) ?? INPUT_PRESET_OPTIONS[0];
  }

  function renderBindings() {
    const directionTokens = inputBinding.kind === "digital"
      ? inputBinding.directions
      : {
        up: inputBinding.axes.y,
        down: inputBinding.axes.y,
        left: inputBinding.axes.x,
        right: inputBinding.axes.x,
      };
    root.querySelectorAll("[data-binding-value]").forEach((output) => {
      const direction = output.getAttribute("data-binding-value");
      const suffix = inputBinding.kind === "digital" ? "" : direction === "up" || direction === "right" ? " +" : " −";
      output.textContent = `${describeInputToken(directionTokens[direction])}${suffix}`;
    });
    root.querySelectorAll("[data-binding-direction]").forEach((button) => {
      if (button instanceof HTMLButtonElement) button.disabled = inputBinding.kind !== "digital";
    });
  }

  function renderInputPreset() {
    const preset = selectedPreset();
    const step = query("#input-step-size");
    const applicability = query("#input-step-applicability");
    if (step instanceof HTMLInputElement) step.disabled = !preset.digital;
    if (applicability) applicability.textContent = preset.digital
      ? "Applies to digital edge-triggered presses."
      : "N/A for this continuous / absolute input.";
    const previewInput = query("#preview-input-source");
    if (previewInput) previewInput.textContent = preset.label;
    const summary = query('[data-section-summary="input"]');
    if (summary) summary.textContent = preset.digital ? `${preset.label} · step ${numberValue("input-step-size", 0.1)}` : `${preset.label} · Step Size N/A`;
  }

  function resetBindingsToPreset() {
    const selected = selectedPreset();
    if (selected.contractId === "custom") return;
    inputBinding = structuredClone(createInputBindingPreset(
      selected.contractId,
      selected.digital ? Math.max(0.001, Math.min(1, numberValue("input-step-size", 0.1))) : 0.1,
    ));
    resetInputTest();
    inputController?.setBinding(inputBinding);
    renderBindings();
    schedulePlanRefresh();
    announce(`${selectedPreset().label} bindings restored.`);
  }

  function participantIds() {
    const total = Math.max(1, Math.min(100000, Math.trunc(numberValue("participant-count", 1))));
    return [...createParticipantIds(total)];
  }

  function selectedParticipantState() {
    return participantStates.get(selectedParticipant) ?? "available";
  }

  function selectedAttemptDisposition() {
    const requested = query('input[name="attemptDisposition"]:checked')?.value;
    return normalizeAttemptDisposition(selectedParticipantState(), requested);
  }

  function renderAttemptDisposition() {
    const state = selectedParticipantState();
    const recoverable = participantRecoverability.get(selectedParticipant) === true;
    const contextKey = `${selectedParticipant}:${state}:${recoverable}`;
    const fieldset = query("#attempt-disposition");
    const resumeOption = query("#attempt-resume-option");
    const resume = query('input[name="attemptDisposition"][value="resume-compatible"]');
    const startNew = query('input[name="attemptDisposition"][value="new-attempt"]');
    const note = query("#attempt-disposition-note");
    const warning = query("#participant-rerun-warning");
    const activeWarning = query("#participant-active-warning");
    const confirmationField = query("#participant-rerun-confirm-field");
    const confirmation = query("#participant-rerun-confirm");
    if (!(fieldset instanceof HTMLFieldSetElement)
      || !(resume instanceof HTMLInputElement)
      || !(startNew instanceof HTMLInputElement)
      || !(confirmation instanceof HTMLInputElement)) return;

    if (contextKey !== dispositionContextKey) {
      resume.checked = state === "partial" && recoverable;
      startNew.checked = state !== "partial" || !recoverable;
      confirmation.checked = false;
      dispositionContextKey = contextKey;
    }

    fieldset.hidden = state !== "partial" && state !== "complete";
    resume.disabled = state !== "partial" || !recoverable;
    if (resumeOption instanceof HTMLElement) resumeOption.hidden = state !== "partial" || !recoverable;
    if (state === "complete") startNew.checked = true;
    if (confirmationField instanceof HTMLElement) confirmationField.hidden = state !== "complete";
    confirmation.disabled = state !== "complete";
    if (activeWarning instanceof HTMLElement) activeWarning.hidden = state !== "active";

    const disposition = selectedAttemptDisposition();
    if (note) {
      note.textContent = state === "partial" && recoverable && disposition === "resume-compatible"
        ? "Compatibility is checked against the current settings and assignment-plan hashes at Start. Recovery resumes only at a safe boundary."
        : state === "partial"
          ? recoverable
            ? "The recoverable partial remains intact; this choice creates a separate attempt with the next number."
            : "This controlled partial is finalized and cannot resume; Start creates a separately numbered attempt."
          : "Completed evidence remains immutable; only a separately numbered new attempt is allowed.";
    }
    if (warning instanceof HTMLElement) {
      warning.hidden = !(state === "complete" || (state === "partial" && disposition === "new-attempt"));
      warning.textContent = state === "complete"
        ? "This participant is Complete. Confirm the deliberate rerun below; the earlier run is never overwritten."
        : recoverable
          ? "Starting a new attempt leaves the recoverable partial untouched and uses the next attempt number."
          : "The controlled partial remains immutable; a new attempt uses the next attempt number.";
    }
  }

  function renderParticipantGrid() {
    const grid = query("#participant-grid");
    if (!(grid instanceof HTMLElement)) return;
    const ids = participantIds();
    if (!ids.includes(selectedParticipant)) {
      selectedParticipant = ids[0];
      participantTileWindowStart = 0;
    }
    const maximumStart = Math.floor((ids.length - 1) / 60) * 60;
    const start = Math.max(0, Math.min(maximumStart, participantTileWindowStart));
    participantTileWindowStart = start;
    const visible = ids.slice(start, start + 60);
    grid.replaceChildren(...visible.map((id) => {
      const state = participantStates.get(id) ?? "available";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "participant-tile";
      button.dataset.participantId = id;
      button.dataset.participantState = state;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(id === selectedParticipant));
      button.tabIndex = id === selectedParticipant ? 0 : -1;
      const strong = document.createElement("strong");
      strong.textContent = id;
      const status = document.createElement("span");
      status.className = "participant-state";
      status.textContent = PARTICIPANT_STATUS_LABELS[state];
      button.append(strong, status);
      return button;
    }));
    renderAttemptDisposition();
    const previous = query("#participant-window-previous");
    const next = query("#participant-window-next");
    const status = query("#participant-window-status");
    if (previous instanceof HTMLButtonElement) previous.disabled = start === 0;
    if (next instanceof HTMLButtonElement) next.disabled = start + visible.length >= ids.length;
    if (status) status.textContent = `Showing ${start + 1}–${start + visible.length} of ${ids.length}`;
  }

  function deriveNameCode() {
    const first = value("participant-first-name").trim();
    const last = value("participant-last-name").trim();
    if (!first || !last) return "";
    try {
      return participantCode(first, last);
    } catch {
      return "";
    }
  }

  function renderNameCode() {
    const output = query("#participant-code");
    if (!output) return;
    const code = deriveNameCode();
    output.textContent = code || "Enter first and last name";
    output.dataset.state = code ? "ready" : "warning";
  }

  function betweenVideosFromUi() {
    const selected = query('input[name="transitionMode"]:checked')?.value ?? "fixed";
    if (selected === "continue") return { mode: "continueWhenReady" };
    if (selected === "jitter") {
      const entries = value("jitter-durations")
        .split(",")
        .map((entry) => entry.trim());
      if (!entries.length || entries.some((entry) => entry === "" || !Number.isFinite(Number(entry)))) {
        throw new TypeError("Jitter durations must be a comma-separated list of finite seconds.");
      }
      const durationsMs = entries.map((seconds) => Math.round(Number(seconds) * 1_000));
      return { mode: "jitter", durationsMs };
    }
    if (value("fixed-duration").trim() === "") throw new TypeError("Fixed between-video duration is required.");
    return { mode: "fixed", durationMs: Math.round(Number(value("fixed-duration")) * 1_000) };
  }

  function mappingsFromUi() {
    return Object.fromEntries(MAPPING_FIELDS.map((spec) => {
      const disclosure = query(`[data-mapping="${spec.id}"]`);
      return [spec.contractId, {
        min: Number(disclosure?.querySelector("[data-mapping-min]")?.value),
        max: Number(disclosure?.querySelector("[data-mapping-max]")?.value),
        drivenBy: disclosure?.querySelector("[data-mapping-driver]")?.value ?? spec.driver,
        reverse: disclosure?.querySelector("[data-mapping-reverse]")?.checked === true,
      }];
    }));
  }

  function synchronizedInputBinding() {
    if (inputBinding.kind !== "digital") return inputBinding;
    const stepSize = numberValue("input-step-size", 0.1);
    if (stepSize !== inputBinding.stepSize) {
      inputBinding = structuredClone(validateInputBindingV1({ ...inputBinding, stepSize }));
      inputController?.setBinding(inputBinding);
    }
    return inputBinding;
  }

  function researchSettingsFromUi() {
    const contractItems = stimuli.map((stimulus) => {
      if (!stimulus.contractSource) throw new TypeError(`${stimulus.title} has not passed source verification.`);
      return {
        stimulusId: stimulus.id,
        title: stimulus.title,
        source: structuredClone(stimulus.contractSource),
      };
    });
    const contractPools = stimuli.length === 0 ? [] : pools.map((pool) => ({
      poolId: pool.id,
      label: pool.label,
      videosPerParticipant: pool.videosPerParticipant,
      stimulusIds: stimuli.filter(({ poolId }) => poolId === pool.id).map(({ id }) => id),
    }));
    return validateResearchSettingsV1({
      schema: DEFAULT_SETTINGS.schema,
      version: DEFAULT_SETTINGS.version,
      experiment: {
        id: value("experiment-id"),
        title: value("experiment-title"),
        participantCount: numberValue("participant-count"),
        samplingFrequencyHz: numberValue("sampling-frequency"),
        betweenVideos: betweenVideosFromUi(),
      },
      stimuli: {
        allocationAlgorithm: "balanced-v1",
        conditionOrder: value("condition-order"),
        seed: value("allocation-seed").trim().toLowerCase(),
        items: contractItems,
        pools: contractPools,
      },
      input: structuredClone(synchronizedInputBinding()),
      visual: {
        gridEnabled: checked("visual-grid-visible"),
        flubberEnabled: checked("visual-flubber-visible"),
        sizePercent: numberValue("visual-size"),
        transparency: numberValue("visual-transparency") / 100,
        hideFeedback: checked("visual-hide-feedback"),
        overlayPosition: {
          x: numberValue("visual-position-x"),
          y: numberValue("visual-position-y"),
        },
        lockPosition: checked("visual-lock-position"),
        flubber: {
          showOutline: checked("flubber-outline-visible"),
          outlineThickness: numberValue("flubber-outline-thickness"),
          showHalo: checked("flubber-halo-visible"),
        },
        grid: {
          lineThickness: numberValue("grid-line-thickness"),
          showOutline: checked("grid-outline-visible"),
          outlineThickness: numberValue("grid-outline-thickness"),
          cursorSize: numberValue("grid-cursor-size"),
        },
        colors: colorValues(),
      },
      advanced: {
        lsl: {
          enabled: checked("lsl-enabled"),
          stateStream: value("lsl-state-stream"),
          streamType: value("lsl-stream-type"),
          markerStream: value("lsl-marker-stream"),
          sourceId: value("lsl-source-id"),
        },
        mappings: mappingsFromUi(),
      },
      output: { csv: checked("output-csv"), tsv: checked("output-tsv") },
    });
  }

  function applyResearchSettings(settings) {
    const normalized = validateResearchSettingsV1(settings);
    setInputValue("experiment-id", normalized.experiment.id);
    setInputValue("experiment-title", normalized.experiment.title);
    setInputValue("participant-count", normalized.experiment.participantCount);
    setInputValue("sampling-frequency", normalized.experiment.samplingFrequencyHz);
    const transitionMode = normalized.experiment.betweenVideos.mode === "continueWhenReady"
      ? "continue"
      : normalized.experiment.betweenVideos.mode;
    const transition = query(`input[name="transitionMode"][value="${transitionMode}"]`);
    if (transition instanceof HTMLInputElement) transition.checked = true;
    if (normalized.experiment.betweenVideos.mode === "fixed") {
      setInputValue("fixed-duration", normalized.experiment.betweenVideos.durationMs / 1_000);
    } else if (normalized.experiment.betweenVideos.mode === "jitter") {
      setInputValue("jitter-durations", normalized.experiment.betweenVideos.durationsMs.map((duration) => duration / 1_000).join(", "));
    }
    setInputValue("condition-order", normalized.stimuli.conditionOrder);
    setInputValue("allocation-seed", normalized.stimuli.seed);
    pools.splice(0, pools.length, ...(normalized.stimuli.pools.length
      ? normalized.stimuli.pools.map((pool) => ({
        id: pool.poolId,
        label: pool.label,
        videosPerParticipant: pool.videosPerParticipant,
      }))
      : [{ id: "condition-1", label: "Condition 1", videosPerParticipant: 1 }]));
    const poolByStimulus = new Map(normalized.stimuli.pools.flatMap((pool) => pool.stimulusIds.map((id) => [id, pool.poolId])));
    stimuli.splice(0, stimuli.length, ...normalized.stimuli.items.map((item) => ({
      id: item.stimulusId,
      title: item.title,
      source: item.source.kind === "workspaceFile" ? "workspace" : item.source.kind === "repositoryAsset" ? "repository" : "youtube",
      location: item.source.relativePath ?? item.source.url,
      poolId: poolByStimulus.get(item.stimulusId),
      verification: item.source.kind === "youtube" ? "unverified" : "pending",
      contractSource: structuredClone(item.source),
      youtubePreflight: null,
    })));
    inputBinding = structuredClone(normalized.input);
    resetInputTest();
    setInputValue("input-preset", UI_PRESET_IDS[inputBinding.preset] ?? "custom");
    if (inputBinding.kind === "digital") setInputValue("input-step-size", inputBinding.stepSize);
    inputController?.setBinding(inputBinding);
    setChecked("visual-grid-visible", normalized.visual.gridEnabled);
    setChecked("visual-flubber-visible", normalized.visual.flubberEnabled);
    setInputValue("visual-size", normalized.visual.sizePercent);
    setInputValue("visual-transparency", normalized.visual.transparency * 100);
    setChecked("visual-hide-feedback", normalized.visual.hideFeedback);
    setChecked("visual-lock-position", normalized.visual.lockPosition);
    setInputValue("visual-position-x", normalized.visual.overlayPosition.x);
    setInputValue("visual-position-y", normalized.visual.overlayPosition.y);
    setChecked("flubber-outline-visible", normalized.visual.flubber.showOutline);
    setInputValue("flubber-outline-thickness", normalized.visual.flubber.outlineThickness);
    setChecked("flubber-halo-visible", normalized.visual.flubber.showHalo);
    setInputValue("grid-line-thickness", normalized.visual.grid.lineThickness);
    setChecked("grid-outline-visible", normalized.visual.grid.showOutline);
    setInputValue("grid-outline-thickness", normalized.visual.grid.outlineThickness);
    setInputValue("grid-cursor-size", normalized.visual.grid.cursorSize);
    for (const [id, color] of Object.entries(normalized.visual.colors)) {
      setInputValue(`color-${id}`, color);
      setInputValue(`color-${id}-hex`, color);
    }
    setChecked("lsl-enabled", normalized.advanced.lsl.enabled);
    setInputValue("lsl-state-stream", normalized.advanced.lsl.stateStream);
    setInputValue("lsl-stream-type", normalized.advanced.lsl.streamType);
    setInputValue("lsl-marker-stream", normalized.advanced.lsl.markerStream);
    setInputValue("lsl-source-id", normalized.advanced.lsl.sourceId);
    for (const spec of MAPPING_FIELDS) {
      const disclosure = query(`[data-mapping="${spec.id}"]`);
      const mapping = normalized.advanced.mappings[spec.contractId];
      if (!(disclosure instanceof HTMLElement)) continue;
      disclosure.querySelector("[data-mapping-min]").value = String(mapping.min);
      disclosure.querySelector("[data-mapping-max]").value = String(mapping.max);
      disclosure.querySelector("[data-mapping-driver]").value = mapping.drivenBy;
      disclosure.querySelector("[data-mapping-reverse]").checked = mapping.reverse;
    }
    setChecked("output-csv", normalized.output.csv);
    setChecked("output-tsv", normalized.output.tsv);
    selectedParticipant = createParticipantIds(normalized.experiment.participantCount)[0];
    participantWindowStart = 0;
    participantTileWindowStart = 0;
    settingsSnapshot = normalized;
    settingsHash = null;
    plan = null;
    renderPools();
    renderBindings();
    refreshProjection();
    schedulePlanRefresh();
    for (const stimulus of stimuli.filter(({ source }) => source === "repository")) {
      void verifyRepositoryStimulus(stimulus);
    }
  }

  function preflightItems() {
    const experimentValid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value("experiment-id"))
      && value("experiment-title").trim().length > 0
      && Number.isInteger(numberValue("participant-count"))
      && numberValue("participant-count") >= 1;
    const sampleRate = numberValue("sampling-frequency");
    const samplingValid = Number.isInteger(sampleRate) && sampleRate >= 1 && sampleRate <= 240;
    let participantRecord = null;
    try {
      participantRecord = deriveParticipantRecord({
        firstName: value("participant-first-name"),
        lastName: value("participant-last-name"),
        age: numberValue("participant-age"),
        gender: value("participant-gender"),
        handedness: value("participant-handedness"),
      });
    } catch {
      participantRecord = null;
    }
    const participantState = selectedParticipantState();
    const attemptDisposition = selectedAttemptDisposition();
    const rerunConfirmed = participantState === "partial" && attemptDisposition === "new-attempt"
      ? true
      : participantState === "complete" && checked("participant-rerun-confirm");
    const attemptStateValid = participantState !== "active"
      && (participantState !== "complete" || rerunConfirmed);
    const participantValid = Boolean(selectedParticipant && participantRecord && attemptStateValid);
    const outputValid = checked("output-csv") || checked("output-tsv");
    const lslValid = !checked("lsl-enabled") || (surface === "tauri" && capabilities.lslReady);
    const workspaceReady = capabilities.directoryPermission;
    const storageEstimate = estimateResearchStorageUse(settingsSnapshot, plan);
    const storageReady = Boolean(storageEstimate
      && capabilities.storageReady
      && storageReadiness?.sufficient === true
      && storageReadiness?.writeReady !== false
      && storageReadiness.requiredBytes === storageEstimate.requiredBytes);
    const localStimuliReady = stimuli.length > 0 && stimuli
      .filter(({ source }) => source !== "youtube")
      .every((stimulus) => stimulus.verification === "verified");
    const youtubeStimuli = stimuli.filter(({ source }) => source === "youtube");
    const hasRepository = stimuli.some(({ source }) => source === "repository");
    const hasYouTube = youtubeStimuli.length > 0;
    const youtubeReady = surface === "browser" && youtubeStimuli.every((stimulus) => (
      isFreshYouTubePreflight(stimulus.youtubePreflight, stimulus.contractSource, {
        maximumAgeMs: YOUTUBE_PREFLIGHT_MAX_AGE_MS,
      })
    ));
    const repositoryReady = !hasRepository || capabilities.repositoryAssetsReady;
    const stimuliReady = localStimuliReady && repositoryReady && (!hasYouTube || youtubeReady);
    const playbackMode = value("native-playback-mode", "nativeLibvlc");
    const playbackReady = surface !== "tauri"
      || playbackMode === "unqualifiedWebview"
      || capabilities.nativePlaybackReady;
    const poolCapacity = analyzeLocalCapacity();
    let bindingValid = false;
    try {
      validateInputBindingV1(synchronizedInputBinding());
      bindingValid = true;
    } catch {
      bindingValid = false;
    }
    return [
      { id: "workspace", result: workspaceReady ? "pass" : "block", label: "Workspace", message: workspaceReady ? "Owned libraries ready" : "Select and authorize one parent workspace" },
      { id: "experiment", result: experimentValid && samplingValid ? "pass" : "block", label: "Protocol", message: experimentValid && samplingValid ? `Continuous rating at ${sampleRate} Hz` : "Complete identity, participant count, and a 1–240 Hz integer rate" },
      {
        id: "stimuli",
        result: stimuliReady && poolCapacity.valid ? "pass" : "block",
        label: "Stimuli",
        message: stimuliReady && poolCapacity.valid
          ? hasYouTube
            ? `${stimuli.length} complete video${stimuli.length === 1 ? "" : "s"} covered; local files byte-verified and YouTube player-preflighted (unverified, noncanonical, qualification excluded)`
            : `${stimuli.length} complete video${stimuli.length === 1 ? "" : "s"} covered and byte-verified`
          : hasYouTube && surface === "tauri"
            ? "Experimental YouTube is browser-only and remains blocked in Windows Tauri"
            : hasRepository && !repositoryReady
              ? "Repository demo assets are not packaged in this Windows internal alpha; import the file into the workspace"
            : hasYouTube && !youtubeReady
              ? "Run a fresh visible-player preflight for every experimental YouTube stimulus"
              : poolCapacity.message,
      },
      { id: "plan", result: plan && settingsHash ? "pass" : "block", label: "Resolved plan", message: plan ? `balanced-v1 ${plan.planHashSha256}` : (planError ?? "Resolve a valid deterministic assignment plan") },
      {
        id: "input",
        result: bindingValid && inputTestPassed && capabilities.nativeInputReady && capabilities.nativeInputPresetReady ? "pass" : "block",
        label: "Input",
        message: !bindingValid
          ? "Resolve binding conflicts"
          : !capabilities.nativeInputReady
            ? "The native input authority is unavailable"
            : !capabilities.nativeInputPresetReady
              ? `${selectedPreset().label} has no safe native Tauri backend`
              : inputTestPassed
                ? `${selectedPreset().label} binding and ${surface === "tauri" ? "fresh native" : "live"} input test passed`
                : surface === "tauri"
                  ? `Exercise every direction in a fresh ${selectedPreset().label} native input test`
                  : `Perform a live ${selectedPreset().label} input test`,
      },
      { id: "output", result: outputValid ? "pass" : "block", label: "Output", message: outputValid ? [checked("output-csv") && "CSV", checked("output-tsv") && "TSV"].filter(Boolean).join(" + ") : "Select CSV, TSV, or both" },
      {
        id: "participant",
        result: participantValid ? "pass" : "block",
        label: "Participant",
        message: participantValid
          ? `${selectedParticipant} · privacy-safe code ${participantRecord.participantCode} · ${attemptDisposition === "resume-compatible" ? "resume compatible partial" : "new attempt"}`
          : participantState === "active"
            ? "The selected participant is Active and locked"
            : participantState === "complete" && !rerunConfirmed
              ? "Confirm the deliberate new attempt for this Complete participant"
              : "Choose a participant and complete required transient details",
      },
      {
        id: "recovery",
        result: (surface === "tauri" || capabilities.indexedDbReady) && capabilities.manifestReady ? "pass" : "block",
        label: "Recovery & manifests",
        message: !(surface === "tauri" || capabilities.indexedDbReady)
          ? "The authoritative recovery journal is unavailable"
          : capabilities.manifestReady
            ? `${surface === "tauri" ? "Native" : "IndexedDB"} recovery journal and output manifests are readable`
            : manifestReadinessMessage,
      },
      {
        id: "storage",
        result: storageReady ? "pass" : "block",
        label: "Storage",
        message: storageReady
          ? `${(storageEstimate.requiredBytes / (1024 * 1024)).toFixed(1)} MiB required; ${(storageReadiness.availableBytes / (1024 * 1024)).toFixed(1)} MiB available${storageReadiness.persisted === false ? " (browser persistence not granted)" : ""}`
          : storageEstimate
            ? "Output and recovery capacity has not passed a current write/quota probe"
            : "Resolve the assignment plan before checking storage capacity",
      },
      { id: "timing", result: capabilities.timingWorkerReady ? "pass" : "block", label: "Timing", message: capabilities.timingWorkerReady ? `${surface === "tauri" ? "Native" : "Worker"} scheduler readiness proved` : "Timing authority has not reported ready" },
      ...(surface === "tauri" ? [{
        id: "playback",
        result: playbackReady ? (playbackMode === "unqualifiedWebview" ? "warning" : "pass") : "block",
        label: "Playback",
        message: playbackMode === "unqualifiedWebview"
          ? "Explicit unqualified WebView fallback selected; this attempt cannot qualify the Windows media path"
          : capabilities.nativePlaybackReady
            ? `Pinned native player ${nativeMediaCapability?.pinnedRuntimeVersion ?? "runtime"} is ready`
            : `Qualified native player unavailable (${nativeMediaCapability?.reasonCode ?? "capability not reported"})`,
      }] : []),
      { id: "lsl", result: lslValid ? "pass" : "block", label: "LSL", message: lslValid ? (checked("lsl-enabled") ? "Windows outbound streams ready" : "Disabled") : surface === "browser" ? "Browser builds cannot start with LSL enabled" : "Windows LSL outlet readiness has not passed" },
    ];
  }

  function renderPreflight() {
    const list = query("#preflight-list");
    if (!(list instanceof HTMLElement)) return;
    const items = preflightItems();
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement("li");
      row.dataset.result = item.result;
      const result = document.createElement("span");
      result.className = "preflight-result";
      result.textContent = item.result === "pass" ? "Pass" : item.result === "warning" ? "Review" : "Blocking";
      const message = document.createElement("span");
      message.textContent = `${item.label}: ${item.message}`;
      row.append(result, message);
      return row;
    }));
    const blocking = items.filter(({ result }) => result === "block");
    const start = query("#start-experiment");
    const status = query("#start-status");
    if (start instanceof HTMLButtonElement) start.disabled = blocking.length > 0;
    if (status) status.textContent = blocking.length === 0
      ? "All blocking checks pass. Start will freeze this attempt."
      : `${blocking.length} blocking preflight item${blocking.length === 1 ? "" : "s"} remain.`;
    const readySections = new Set(items.filter(({ result }) => result !== "block").map(({ id }) => id));
    const progress = query("#setup-progress");
    if (progress) progress.textContent = `${Math.min(7, readySections.size)} of 7 ready`;
  }

  function analyzeLocalCapacity() {
    if (stimuli.length === 0) return { valid: false, message: "Add at least one complete video" };
    if (settingsSnapshot) {
      const coverage = analyzeAssignmentCoverage(settingsSnapshot);
      if (coverage.valid) return { valid: true, message: `Capacity covers all ${stimuli.length} selected videos.` };
      const failures = coverage.pools
        .filter(({ blockingReasons }) => blockingReasons.length > 0)
        .map((pool) => {
          if (pool.blockingReasons.includes("videos-per-participant-exceeds-pool")) {
            return `${pool.label} contains ${pool.requiredStimuli} unique video${pool.requiredStimuli === 1 ? "" : "s"}; reduce Videos / participant to ${pool.adjustment.maximumVideosPerParticipant}.`;
          }
          const uncovered = pool.uncoveredStimulusIds
            .map((id) => stimuli.find((stimulus) => stimulus.id === id)?.title ?? id)
            .join(", ");
          return `${pool.label} cannot cover ${uncovered}. Increase total participants to ${pool.adjustment.minimumParticipantCount} (+${pool.adjustment.additionalParticipants}) or Videos / participant to ${pool.adjustment.minimumVideosPerParticipant} (+${pool.adjustment.additionalVideosPerParticipant}).`;
        });
      if (failures.length > 0) return { valid: false, message: failures.join(" ") };
    }
    const participants = Math.max(0, Math.trunc(numberValue("participant-count")));
    const uncovered = [];
    for (const pool of pools) {
      const videos = stimuli.filter(({ poolId }) => pool.id === poolId);
      const slots = participants * Math.max(0, Math.trunc(pool.videosPerParticipant));
      if (slots < videos.length) {
        const requiredParticipants = pool.videosPerParticipant > 0 ? Math.ceil(videos.length / pool.videosPerParticipant) : Infinity;
        uncovered.push({ pool, videos, requiredParticipants });
      }
    }
    if (uncovered.length === 0) return { valid: true, message: `Capacity covers all ${stimuli.length} selected videos.` };
    return {
      valid: false,
      message: uncovered.map(({ pool, videos, requiredParticipants }) => {
        const adjustment = Number.isFinite(requiredParticipants)
          ? `increase total participants to at least ${requiredParticipants}`
          : `increase videos per participant in ${pool.label} to at least 1`;
        return `${pool.label} leaves ${videos.map(({ title }) => title).join(", ")} uncovered; ${adjustment}.`;
      }).join(" "),
    };
  }

  function renderCoverage() {
    const result = analyzeLocalCapacity();
    const message = query("#coverage-message");
    if (message instanceof HTMLElement) {
      message.dataset.state = result.valid ? "ready" : "warning";
      message.textContent = result.message;
    }
  }

  function renderReview() {
    renderNameCode();
    renderParticipantGrid();
    renderCoverage();
    renderPreflight();
    const experimentId = value("experiment-id", "<experiment-id>") || "<experiment-id>";
    const path = query("#review-output-path");
    if (path) path.textContent = `outputs/${experimentId}/${selectedParticipant}/<session-stem>/`;
    const hash = query("#settings-hash");
    if (hash) hash.textContent = settingsHash ?? planError ?? "Pending validated settings";
    const storage = query("#storage-estimate");
    if (storage) {
      const estimate = estimateResearchStorageUse(settingsSnapshot, plan);
      if (!estimate) {
        storage.textContent = "Pending verified videos";
      } else {
        const capacity = storageReadiness?.requiredBytes === estimate.requiredBytes
          ? ` · ${(storageReadiness.availableBytes / (1024 * 1024)).toFixed(1)} MiB available${storageReadiness.persisted === false ? " · best-effort browser persistence" : ""}`
          : " · write/quota probe pending";
        storage.textContent = `${(estimate.requiredBytes / (1024 * 1024)).toFixed(1)} MiB estimated for ${estimate.sampleRows.toLocaleString()} rating rows${capacity}`;
      }
    }
    const timing = query("#timing-capability");
    if (timing) timing.textContent = capabilities.timingWorkerReady
      ? `${surface === "tauri" ? "Native" : "Dedicated worker"} timing authority ready`
      : "Timing authority not ready";
    const lsl = query("#lsl-capability");
    if (lsl) lsl.textContent = surface === "tauri"
      ? "Windows Tauri will verify the outbound regular and marker outlets during preflight."
      : "Browser mode preserves these values but cannot start while LSL is enabled.";
  }

  function renderPools() {
    const container = query("#condition-pools");
    const conditionSelect = query("#stimulus-condition");
    if (!(container instanceof HTMLElement)) return;
    container.replaceChildren(...pools.map((pool, index) => {
      const section = document.createElement("section");
      section.className = "condition-pool";
      section.dataset.poolId = pool.id;
      section.innerHTML = `
        <div class="condition-pool-header">
          <label class="field"><span>Column name</span><input data-pool-label maxlength="64" value="${escapeAttribute(pool.label)}"></label>
          <label class="field"><span>Videos / participant</span><input data-pool-count type="number" min="1" max="1000" step="1" value="${pool.videosPerParticipant}"></label>
          <button data-pool-remove type="button" aria-label="Remove ${escapeAttribute(pool.label)}" ${pools.length === 1 ? "disabled" : ""}>Remove</button>
        </div>
        <ul class="condition-video-list"></ul>`;
      const list = section.querySelector(".condition-video-list");
      const assigned = stimuli.filter(({ poolId }) => poolId === pool.id);
      if (assigned.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty-state";
        empty.textContent = "No videos assigned.";
        list.append(empty);
      } else {
        for (const stimulus of assigned) {
          const row = document.createElement("li");
          const text = document.createElement("span");
          text.textContent = stimulus.title;
          const source = document.createElement("span");
          source.className = "stimulus-source";
          source.textContent = stimulus.source === "youtube" ? "Experimental YouTube" : stimulus.source === "repository" ? "Repository" : "Workspace";
          row.append(text, source);
          list.append(row);
        }
      }
      if (index === 0) section.querySelector("[data-pool-label]")?.setAttribute("aria-describedby", "pool-mode-summary");
      return section;
    }));
    if (conditionSelect instanceof HTMLSelectElement) {
      const prior = conditionSelect.value;
      conditionSelect.replaceChildren(...pools.map((pool) => new Option(pool.label, pool.id)));
      conditionSelect.value = pools.some(({ id }) => id === prior) ? prior : pools[0].id;
    }
    const summary = query("#pool-mode-summary");
    if (summary) summary.textContent = pools.length === 1
      ? "One condition column · one hat. Every selected video is drawn from this pool."
      : `${pools.length} condition columns · stratified pools.`;
    renderStimulusLibrary();
    renderCoverage();
  }

  function renderStimulusLibrary() {
    const table = query("#stimulus-library-table");
    if (!(table instanceof HTMLElement)) return;
    if (stimuli.length === 0) {
      table.innerHTML = '<tr><td colspan="5" class="empty-state">No complete videos have been imported.</td></tr>';
      return;
    }
    table.replaceChildren(...stimuli.map((stimulus) => {
      const row = document.createElement("tr");
      const title = document.createElement("td");
      title.textContent = stimulus.title;
      const source = document.createElement("td");
      source.textContent = stimulus.source === "youtube" ? "Experimental YouTube" : stimulus.source === "repository" ? "Repository asset" : "Workspace file";
      const verification = document.createElement("td");
      const youtubeFresh = stimulus.source === "youtube" && isFreshYouTubePreflight(
        stimulus.youtubePreflight,
        stimulus.contractSource,
        { maximumAgeMs: YOUTUBE_PREFLIGHT_MAX_AGE_MS },
      );
      verification.textContent = stimulus.source === "youtube"
        ? stimulus.verification === "failed"
          ? `Player preflight failed: ${stimulus.error}`
          : youtubeFresh
            ? `Player operational · ${stimulus.contractSource.observedTitle} · ${(stimulus.contractSource.observedDurationMs / 1_000).toFixed(1)} s · unverified / noncanonical`
            : "Fresh visible-player preflight required · unverified / noncanonical"
        : stimulus.verification === "verified" ? "Hash, duration, decode verified"
          : stimulus.verification === "failed" ? `Failed: ${stimulus.error}` : "Verification pending";
      const poolCell = document.createElement("td");
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Condition column for ${stimulus.title}`);
      select.dataset.stimulusPool = stimulus.id;
      for (const pool of pools) select.add(new Option(pool.label, pool.id, false, pool.id === stimulus.poolId));
      poolCell.append(select);
      const actionCell = document.createElement("td");
      actionCell.className = "stimulus-actions";
      if (stimulus.source === "youtube") {
        const preflight = document.createElement("button");
        preflight.type = "button";
        preflight.dataset.youtubePreflight = stimulus.id;
        preflight.textContent = youtubeFresh ? "Preflight again" : "Preflight";
        preflight.setAttribute("aria-label", `Run visible YouTube player preflight for ${stimulus.title}`);
        actionCell.append(preflight);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.stimulusRemove = stimulus.id;
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${stimulus.title}`);
      actionCell.append(remove);
      row.append(title, source, verification, poolCell, actionCell);
      return row;
    }));
  }

  function addStimulus({ title, source, location, file = null }) {
    const normalizedTitle = String(title || file?.name || "Untitled video").trim().slice(0, 120);
    const duplicate = stimuli.some((stimulus) => stimulus.source === source && stimulus.location === location);
    if (duplicate) {
      announce(`${normalizedTitle} is already in the stimulus library.`);
      return null;
    }
    const baseId = normalizedTitle.toLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 80) || "video";
    let id = baseId;
    let suffix = 2;
    while (stimuli.some((stimulus) => stimulus.id === id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const stimulus = {
      id,
      title: normalizedTitle,
      source,
      location: String(location ?? file?.webkitRelativePath ?? file?.name ?? ""),
      file,
      poolId: pools[0].id,
      verification: source === "youtube" ? "unverified" : file ? "pending" : "pending",
      contractSource: null,
      youtubePreflight: null,
    };
    if (source === "youtube") {
      try {
        const parsed = parseExperimentalYouTubeUrl(stimulus.location);
        stimulus.location = parsed.url;
        stimulus.contractSource = {
          kind: "youtube",
          url: parsed.url,
          videoId: parsed.videoId,
          observedTitle: normalizedTitle,
          observedDurationMs: null,
        };
      } catch (error) {
        stimulus.verification = "failed";
        stimulus.error = error instanceof Error ? error.message : String(error);
      }
    }
    stimuli.push(stimulus);
    renderPools();
    schedulePlanRefresh();
    announce(`${normalizedTitle} added to ${pools[0].label}.`);
    return stimulus;
  }

  async function verifyLocalFile(stimulus, { relativePath = stimulus.location } = {}) {
    if (!(stimulus.file instanceof Blob)) return;
    try {
      const probe = await probeVideoFile(stimulus.file);
      const digest = await sha256Blob(stimulus.file);
      const expected = stimulus.contractSource;
      if (expected && expected.kind !== "youtube"
        && (expected.sha256 !== digest
          || expected.byteLength !== stimulus.file.size
          || Math.abs(expected.durationMs - Math.round(probe.durationSeconds * 1_000)) > Math.max(250, expected.durationMs * 0.005))) {
        throw new Error("The current file does not match the hash, size, or duration frozen in settings.");
      }
      stimulus.durationSeconds = probe.durationSeconds;
      stimulus.byteLength = stimulus.file.size;
      stimulus.sha256 = digest;
      stimulus.verification = probe.decodeVerified ? "verified" : "failed";
      stimulus.contractSource = {
        kind: stimulus.source === "repository" ? "repositoryAsset" : "workspaceFile",
        relativePath,
        mimeType: stimulus.file.type || "application/octet-stream",
        sha256: digest,
        byteLength: stimulus.file.size,
        durationMs: Math.round(probe.durationSeconds * 1_000),
      };
    } catch (error) {
      stimulus.verification = "failed";
      stimulus.error = error instanceof Error ? error.message : String(error);
    }
    renderPools();
    schedulePlanRefresh();
  }

  async function verifyRepositoryStimulus(stimulus) {
    try {
      const relativePath = normalizeWorkspaceRelativePath(stimulus.location, "repository asset path");
      stimulus.location = relativePath;
      const response = await fetch(new URL(relativePath, document.baseURI), { cache: "no-store" });
      if (!response.ok) throw new Error(`Repository asset returned HTTP ${response.status}.`);
      stimulus.file = await response.blob();
      await verifyLocalFile(stimulus, { relativePath });
    } catch (error) {
      stimulus.verification = "failed";
      stimulus.error = error instanceof Error ? error.message : String(error);
      renderPools();
      schedulePlanRefresh();
    }
  }

  async function preflightYouTubeStimulus(stimulus) {
    if (!stimulus || stimulus.source !== "youtube") return;
    const panel = query("#youtube-preflight-panel");
    const host = query("#youtube-preflight-player");
    const status = query("#youtube-preflight-status");
    if (surface !== "browser") {
      announce("Experimental YouTube remains blocked in Windows Tauri until its CSP and referrer boundary is qualified.");
      return;
    }
    if (!(host instanceof HTMLElement)) throw new Error("The YouTube preflight player is unavailable.");
    if (panel instanceof HTMLElement) panel.hidden = false;
    if (status) {
      status.dataset.state = "pending";
      status.textContent = `Loading the official YouTube player for ${stimulus.title}…`;
    }
    stimulus.youtubePreflight = null;
    stimulus.verification = "unverified";
    renderStimulusLibrary();
    schedulePlanRefresh();
    try {
      youtubePreflightAdapter?.destroy();
      host.replaceChildren();
      youtubePreflightAdapter = new YouTubeIframePlayerAdapter(host, { origin: window.location.origin });
      const result = await youtubePreflightAdapter.preflight({
        videoId: stimulus.contractSource.videoId,
        url: stimulus.contractSource.url,
      });
      stimulus.contractSource = {
        kind: "youtube",
        url: result.url,
        videoId: result.videoId,
        observedTitle: result.observedTitle,
        observedDurationMs: result.observedDurationMs,
      };
      stimulus.youtubePreflight = result;
      stimulus.verification = "youtube-operational";
      delete stimulus.error;
      if (status) {
        status.dataset.state = "ready";
        status.textContent = `${result.observedTitle} · ${(result.observedDurationMs / 1_000).toFixed(1)} s · player operational. This URL remains unverified, noncanonical, and excluded from qualification.`;
      }
      announce(`${stimulus.title} passed the fresh browser player preflight and remains excluded from qualification.`);
    } catch (error) {
      stimulus.youtubePreflight = null;
      stimulus.verification = "failed";
      stimulus.error = error instanceof Error ? error.message : String(error);
      if (status) {
        status.dataset.state = "error";
        status.textContent = stimulus.error;
      }
      announce(`YouTube preflight failed: ${stimulus.error}`);
    }
    renderPools();
    schedulePlanRefresh();
  }

  function schedulePlanRefresh() {
    planRefresh += 1;
    const generation = planRefresh;
    settingsSnapshot = null;
    settingsHash = null;
    plan = null;
    planError = "Revalidating the current protocol…";
    capabilities.manifestReady = false;
    manifestReadinessMessage = "Output manifests are being rescanned against the current protocol.";
    renderPlanPreview();
    renderReview();
    queueMicrotask(async () => {
      if (generation !== planRefresh) return;
      try {
        const settings = researchSettingsFromUi();
        const sha256 = await canonicalSha256(settings);
        const coverage = analyzeAssignmentCoverage(settings);
        const resolved = coverage.valid ? await resolveAssignmentPlanV1(settings) : null;
        if (generation !== planRefresh) return;
        settingsSnapshot = settings;
        settingsHash = sha256;
        plan = resolved;
        planError = coverage.valid ? null : "The participant-by-slot matrix does not cover every selected video.";
        if (resolved) {
          root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.planReady, {
            bubbles: true,
            detail: Object.freeze({ settings, settingsSha256: sha256, plan: resolved }),
          }));
        }
      } catch (error) {
        if (generation !== planRefresh) return;
        settingsSnapshot = null;
        settingsHash = null;
        plan = null;
        planError = error instanceof Error ? error.message : String(error);
      }
      renderPlanPreview();
      renderReview();
    });
  }

  function renderPlanPreview() {
    const table = query("#assignment-preview");
    const hash = query("#plan-hash");
    const reviewHash = query("#review-plan-hash");
    const status = query("#plan-window-status");
    const previous = query("#plan-window-previous");
    const next = query("#plan-window-next");
    const exportButton = query("#assignment-plan-export");
    if (!(table instanceof HTMLElement)) return;
    if (!plan) {
      table.innerHTML = '<tr><td colspan="3" class="empty-state">The resolved schedule appears after the pool design passes capacity checks.</td></tr>';
      if (hash) hash.textContent = planError ?? "Pending valid allocation";
      if (reviewHash) reviewHash.textContent = planError ?? "Pending valid allocation";
      if (status) status.textContent = "Showing 0 of 0 participants.";
      if (previous instanceof HTMLButtonElement) previous.disabled = true;
      if (next instanceof HTMLButtonElement) next.disabled = true;
      if (exportButton instanceof HTMLButtonElement) exportButton.disabled = true;
      return;
    }
    const maximumStart = Math.floor((plan.assignments.length - 1) / 40) * 40;
    const start = Math.max(0, Math.min(maximumStart, participantWindowStart));
    participantWindowStart = start;
    const visible = plan.assignments.slice(start, start + 40);
    table.replaceChildren(...visible.map((assignment) => {
      const row = document.createElement("tr");
      const participant = document.createElement("td");
      participant.textContent = assignment.participantId;
      const order = document.createElement("td");
      order.textContent = assignment.conditionOrder.map((poolId) => pools.find(({ id }) => id === poolId)?.label ?? poolId).join(" → ");
      const videos = document.createElement("td");
      videos.textContent = assignment.slots.map(({ stimulusId }) => stimuli.find((item) => item.id === stimulusId)?.title ?? stimulusId).join("; ");
      row.append(participant, order, videos);
      return row;
    }));
    if (hash) hash.textContent = plan.planHashSha256;
    if (reviewHash) reviewHash.textContent = plan.planHashSha256;
    if (status) status.textContent = `Showing ${start + 1}–${start + visible.length} of ${plan.assignments.length} participants.`;
    if (previous instanceof HTMLButtonElement) previous.disabled = start === 0;
    if (next instanceof HTMLButtonElement) next.disabled = start + visible.length >= plan.assignments.length;
    if (exportButton instanceof HTMLButtonElement) exportButton.disabled = false;
  }

  async function exportAssignmentPlan() {
    if (!plan || !settingsSnapshot) return;
    let csv;
    try {
      csv = await assignmentPlanToCsv(plan);
    } catch (error) {
      announce(`Assignment plan export failed: ${error.message}`);
      return;
    }
    if (surface === "tauri") {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.exportPlanRequest, {
        bubbles: true,
        detail: Object.freeze({
          experimentId: settingsSnapshot.experiment.id,
          filename: "assignment-plan.csv",
          csv,
          planHashSha256: plan.planHashSha256,
        }),
      }));
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "assignment-plan.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function selectWorkspace() {
    if (surface === "tauri") {
      const event = new CustomEvent(RESEARCH_UI_EVENTS.selectWorkspaceRequest, { bubbles: true, cancelable: true });
      root.dispatchEvent(event);
      if (!event.defaultPrevented) announce("The Windows workspace adapter is not connected yet.");
      return;
    }
    if (!window.isSecureContext || typeof window.showDirectoryPicker !== "function") {
      const status = query("#workspace-status");
      if (status) {
        status.dataset.state = "error";
        status.textContent = "A secure desktop Chrome or Edge context with File System Access is required.";
      }
      announce("Workspace selection is unavailable in this browser context.");
      return;
    }
    try {
      workspace = await BrowserResearchWorkspace.choose({ windowObject: window });
      capabilities.directoryPermission = true;
      const output = query("#workspace-root");
      if (output) {
        output.textContent = workspace.rootHandle.name;
        output.dataset.state = "ready";
      }
      const status = query("#workspace-status");
      if (status) {
        status.dataset.state = "ready";
        status.textContent = "Workspace authorized. stimuli/, settings/, outputs/, and recovery/ are ready.";
      }
      for (const id of ["workspace-rescan", "settings-save", "stimulus-add-workspace", "video-import", "video-folder-import"]) {
        const button = query(`#${id}`);
        if (button instanceof HTMLButtonElement) button.disabled = false;
      }
      capabilities.manifestReady = false;
      manifestReadinessMessage = "Output manifests are being scanned for the selected workspace.";
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.workspaceReady, {
        bubbles: true,
        detail: Object.freeze({ surface: "browser", label: workspace.rootHandle.name, directoryPermission: true }),
      }));
      announce(`Workspace ${workspace.rootHandle.name} selected.`);
      refreshProjection();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      announce(error instanceof Error ? error.message : String(error));
    }
  }

  async function renewWorkspacePermission() {
    if (surface === "tauri") {
      selectWorkspace();
      return;
    }
    if (!workspace) return;
    try {
      await workspace.renewPermission();
      capabilities.directoryPermission = true;
      query("#workspace-renew")?.setAttribute("hidden", "");
      capabilities.manifestReady = false;
      manifestReadinessMessage = "Output manifests are being scanned after permission renewal.";
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.workspaceReady, {
        bubbles: true,
        detail: Object.freeze({ surface: "browser", label: workspace.rootHandle.name, directoryPermission: true }),
      }));
      announce("Workspace permission renewed.");
      refreshProjection();
    } catch (error) {
      capabilities.directoryPermission = false;
      announce(error instanceof Error ? error.message : String(error));
      refreshProjection();
    }
  }

  async function requestWorkspaceRescan() {
    if (surface === "tauri") {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.rescanWorkspaceRequest, { bubbles: true }));
      return;
    }
    if (!workspace) return;
    const status = query("#workspace-status");
    try {
      if (status) status.textContent = "Scanning stimuli/ recursively…";
      const catalogue = await workspace.rescanVideos();
      const seenLocations = new Set();
      for (const entry of catalogue) {
        const location = `stimuli/${entry.relativePath}`;
        seenLocations.add(location);
        const file = await entry.fileHandle.getFile();
        let stimulus = stimuli.find(({ source, location: existingLocation }) => source === "workspace" && existingLocation === location);
        if (stimulus) stimulus.file = file;
        else stimulus = addStimulus({ title: entry.name, source: "workspace", location, file });
        if (stimulus) await verifyLocalFile(stimulus, { relativePath: location });
      }
      for (let index = stimuli.length - 1; index >= 0; index -= 1) {
        if (stimuli[index].source === "workspace" && !seenLocations.has(stimuli[index].location)) {
          stimuli.splice(index, 1);
        }
      }
      renderPools();
      schedulePlanRefresh();
      if (status) {
        status.dataset.state = "ready";
        status.textContent = `Rescan complete. ${catalogue.length} complete video file${catalogue.length === 1 ? "" : "s"} found.`;
      }
      announce("Workspace rescan complete.");
    } catch (error) {
      capabilities.directoryPermission = false;
      const renew = query("#workspace-renew");
      if (renew instanceof HTMLButtonElement) renew.hidden = false;
      if (status) {
        status.dataset.state = "error";
        status.textContent = error instanceof Error ? error.message : String(error);
      }
      refreshProjection();
    }
  }

  async function requestSettingsSave() {
    try {
      const settings = researchSettingsFromUi();
      const sha256 = await canonicalSha256(settings);
      if (surface === "tauri") {
        const event = new CustomEvent(RESEARCH_UI_EVENTS.saveSettingsRequest, {
          bubbles: true,
          cancelable: true,
          detail: Object.freeze({ settings, settingsSha256: sha256, canonicalJson: canonicalJson(settings) }),
        });
        root.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error("The Windows settings adapter is not connected.");
      } else {
        if (!workspace) throw new Error("Select a workspace before saving settings.");
        await workspace.saveSettings(settings);
      }
      announce(`${settings.experiment.id}.settings.json saved with hash ${sha256}.`);
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error));
    }
  }

  function requestSettingsLoad() {
    if (surface === "tauri") {
      const event = new CustomEvent(RESEARCH_UI_EVENTS.loadSettingsRequest, { bubbles: true, cancelable: true });
      root.dispatchEvent(event);
      if (!event.defaultPrevented) announce("The Windows settings adapter is not connected.");
      return;
    }
    query("#settings-file-input")?.click();
  }

  function showImportReport(report) {
    const body = query("#import-report-body");
    if (!(body instanceof HTMLElement)) return;
    body.replaceChildren(...report.map((entry) => {
      const row = document.createElement("tr");
      for (const value of [entry.status, entry.sourcePath ?? "—", entry.targetPath ?? "—", entry.message]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
    const dialog = query("#import-report-dialog");
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  function loadSettingsPayload(payload, { report = null } = {}) {
    let settings;
    let importReport = report;
    if (payload?.schema === DEFAULT_SETTINGS.schema) {
      settings = validateResearchSettingsV1(payload);
    } else {
      const imported = importPortableSettingsV1(payload);
      settings = imported.settings;
      importReport = imported.report;
    }
    applyResearchSettings(settings);
    if (importReport?.length) showImportReport(importReport);
    announce(`Loaded ${settings.experiment.id}.settings.json. Local and repository videos require fresh verification.`);
  }

  function requestVideoImport({ directory = false } = {}) {
    if (surface === "tauri") {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.importVideosRequest, {
        bubbles: true,
        detail: Object.freeze({ recursiveDirectory: directory }),
      }));
      return;
    }
    query(directory ? "#video-folder-input" : "#video-file-input")?.click();
  }

  async function ingestBrowserFiles(fileList) {
    const files = [...(fileList ?? [])].filter((file) => isSupportedVideoName(file.name));
    if (!files.length) {
      announce("No supported complete-video files were selected.");
      return;
    }
    if (!workspace) {
      announce("Select a workspace before importing complete videos.");
      return;
    }
    try {
      const importedPaths = await workspace.importVideoFiles(files);
      for (let index = 0; index < files.length; index += 1) {
        const relativePath = `stimuli/${importedPaths[index]}`;
        const stimulus = addStimulus({
          title: files[index].name.replaceAll("\\", "/").split("/").at(-1),
          source: "workspace",
          location: relativePath,
          file: files[index],
        });
        if (stimulus) await verifyLocalFile(stimulus, { relativePath });
      }
      announce(`${files.length} complete video file${files.length === 1 ? "" : "s"} imported and verified.`);
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error));
    }
  }

  function openStimulusDialog(source) {
    const dialog = query("#stimulus-dialog");
    const sourceSelect = query("#stimulus-source");
    if (sourceSelect instanceof HTMLSelectElement) sourceSelect.value = source;
    updateStimulusDialogSource();
    if (dialog instanceof HTMLDialogElement) dialog.showModal();
  }

  function updateStimulusDialogSource() {
    const source = value("stimulus-source", "workspace");
    const label = query("#stimulus-location-label");
    const help = query("#stimulus-dialog-help");
    if (label) label.textContent = source === "youtube" ? "YouTube URL" : source === "repository" ? "Repository asset path" : "Workspace catalogue item";
    if (help) help.textContent = source === "youtube"
      ? "This source is explicitly unverified and noncanonical; no byte hash is claimed."
      : source === "repository"
        ? "Repository media is only for small demos beneath GitHub's regular-file limit. Hash, size, duration, and decode are verified before Start."
        : "Complete-file duration, byte identity, and decode verification are required before Start.";
  }

  function updateInputPoint(x, y, receipt, { fromInput = false, inputActive = false, source = null } = {}) {
    inputPoint = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    if (fromInput && surface !== "tauri") inputTestPassed = true;
    const grid = query(".input-test-grid");
    if (grid instanceof HTMLElement) {
      grid.style.setProperty("--input-left", `${((inputPoint.x + 1) / 2) * 100}%`);
      grid.style.setProperty("--input-top", `${((1 - inputPoint.y) / 2) * 100}%`);
    }
    const xOutput = query("#input-test-x");
    const yOutput = query("#input-test-y");
    if (xOutput) xOutput.textContent = `${inputPoint.x >= 0 ? "+" : ""}${inputPoint.x.toFixed(3)}`;
    if (yOutput) yOutput.textContent = `${inputPoint.y >= 0 ? "+" : ""}${inputPoint.y.toFixed(3)}`;
    const status = query("#input-test-status");
    if (status && receipt) {
      status.textContent = receipt;
      status.dataset.state = "ready";
    }
    root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputTestState, {
      bubbles: true,
      detail: Object.freeze({
        x: inputPoint.x,
        y: inputPoint.y,
        inputActive: Boolean(inputActive),
        source,
        passed: inputTestPassed,
      }),
    }));
    refreshProjection();
  }

  function applyNativeInputStatus(status) {
    if (surface !== "tauri" || !status) return;
    const observation = status.lastInput;
    if (mode === "setup" && Number.isInteger(observation?.sequence)
      && observation.sequence > nativeInputLastSequence) {
      nativeInputLastSequence = observation.sequence;
      if (observation.applyStep === true && inputBinding.kind === "digital") {
        const step = inputBinding.stepSize;
        const delta = {
          up: [0, step], down: [0, -step], left: [-step, 0], right: [step, 0],
        }[observation.direction] ?? [0, 0];
        updateInputPoint(
          inputPoint.x + delta[0],
          inputPoint.y + delta[1],
          `Native ${observation.direction} edge accepted.`,
          { inputActive: observation.inputActive, source: observation.detail },
        );
      }
    }
    nativeInputReceiptId = status.receipt?.receiptId ?? null;
    inputTestPassed = Boolean(nativeInputReceiptId);
    const output = query("#input-test-status");
    if (output && mode === "setup") {
      if (status.receipt) {
        output.textContent = `Native test passed for device epoch ${status.receipt.deviceEpoch}.`;
        output.dataset.state = "ready";
      } else if (Array.isArray(status.remainingDirections)) {
        output.textContent = status.remainingDirections.length
          ? `Native test: exercise ${status.remainingDirections.join(", ")}.`
          : "Run a fresh native input test.";
        output.dataset.state = "warning";
      }
    }
    renderReview();
  }

  function beginBindingCapture(direction) {
    const receipt = query("#binding-capture-receipt");
    if (surface === "tauri") {
      nativeCaptureDirection = direction;
      inputController.cancelCapture();
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputCaptureRequest, {
        bubbles: true,
        detail: Object.freeze({ direction, binding: structuredClone(inputBinding) }),
      }));
      return;
    }
    const complete = (result) => {
      if (!result.ok) {
        if (receipt) {
          receipt.textContent = result.error instanceof Error ? result.error.message : "That action cannot be assigned.";
          receipt.dataset.state = "error";
        }
        return;
      }
      inputBinding = structuredClone(result.binding);
      resetInputTest({ notify: false });
      inputController.setBinding(inputBinding);
      inputController.cancelCapture();
      if (gamepadCaptureFrame !== null) cancelAnimationFrame(gamepadCaptureFrame);
      gamepadCaptureFrame = null;
      setInputValue("input-preset", "custom");
      renderBindings();
      schedulePlanRefresh();
      if (receipt) {
        receipt.textContent = `${describeInputToken(result.action)} assigned to ${result.direction}.`;
        receipt.dataset.state = "ready";
      }
      setTimeout(() => {
        closeDialog("binding-capture-dialog");
        refreshProjection();
      }, 180);
    };
    inputController.beginCapture(direction, complete);
    const previous = new Map();
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      pad.buttons.forEach((button, index) => previous.set(`${pad.index}:${index}`, button.pressed));
    }
    const pollGamepadCapture = () => {
      gamepadCaptureFrame = null;
      if (inputController.captureDirection !== direction) return;
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue;
        for (let index = 0; index < pad.buttons.length; index += 1) {
          const key = `${pad.index}:${index}`;
          const pressed = pad.buttons[index].pressed;
          if (pressed && previous.get(key) === false) {
            previous.set(key, true);
            try {
              const binding = withCustomDigitalAction(inputBinding, direction, { kind: "gamepadButton", button: index });
              complete({ ok: true, direction, action: { kind: "gamepadButton", button: index }, binding });
            } catch (error) {
              complete({ ok: false, direction, action: { kind: "gamepadButton", button: index }, error });
              gamepadCaptureFrame = requestAnimationFrame(pollGamepadCapture);
            }
            return;
          }
          previous.set(key, pressed);
        }
      }
      gamepadCaptureFrame = requestAnimationFrame(pollGamepadCapture);
    };
    gamepadCaptureFrame = requestAnimationFrame(pollGamepadCapture);
  }

  function routeCaptureEvent(event) {
    if (event.type === "keydown") return inputController.handleKeyDown(event);
    if (event.type === "mousedown") return inputController.handleMouseDown(event);
    if (event.type === "wheel") return inputController.handleWheel(event);
    return false;
  }

  function cancelBindingCapture() {
    inputController.cancelCapture();
    if (gamepadCaptureFrame !== null) cancelAnimationFrame(gamepadCaptureFrame);
    gamepadCaptureFrame = null;
    if (surface === "tauri" && nativeCaptureDirection) {
      nativeCaptureDirection = null;
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputCaptureCancel, { bubbles: true }));
    }
  }

  function applyNativeCapture(result) {
    if (surface !== "tauri" || !result?.binding || !result?.action) return false;
    inputBinding = structuredClone(validateInputBindingV1(result.binding));
    resetInputTest({ notify: false });
    nativeCaptureDirection = null;
    inputController.setBinding(inputBinding);
    setInputValue("input-preset", "custom");
    renderBindings();
    schedulePlanRefresh();
    const receipt = query("#binding-capture-receipt");
    if (receipt) {
      receipt.textContent = `${describeInputToken(result.action)} assigned to ${result.direction} by native capture.`;
      receipt.dataset.state = "ready";
    }
    closeDialog("binding-capture-dialog");
    refreshProjection();
    return true;
  }

  function closeDialog(id) {
    const dialog = query(`#${id}`);
    if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
  }

  const inputTestGrid = query(".input-test-grid");
  inputController = new ResearchInputController({
    binding: inputBinding,
    onState(snapshot) {
      if (Math.abs(snapshot.x - inputPoint.x) < 0.0005
        && Math.abs(snapshot.y - inputPoint.y) < 0.0005
        && snapshot.inputActive === lastInputActive) return;
      lastInputActive = snapshot.inputActive;
      const fromInput = snapshot.inputActive === true;
      const receipt = snapshot.source
        ? `${snapshot.inputKind} input received from ${snapshot.source}.`
        : null;
      updateInputPoint(snapshot.x, snapshot.y, receipt, {
        fromInput,
        inputActive: snapshot.inputActive,
        source: snapshot.source,
      });
    },
    onInputEdge(edge) {
      if (edge.active) announce(`${edge.direction} input edge accepted; operating-system repeat is ignored.`);
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.inputEdge, {
        bubbles: true,
        detail: Object.freeze({ ...edge, x: inputController.state.x, y: inputController.state.y, mode }),
      }));
    },
  });
  if (inputTestGrid instanceof HTMLElement) inputController.attach(inputTestGrid);

  const runInputHandlers = {
    keydown(event) {
      if (surface !== "tauri" && mode === "run") inputController.handleKeyDown(event);
    },
    keyup(event) {
      if (surface !== "tauri" && mode === "run") inputController.handleKeyUp(event);
    },
    mousedown(event) {
      if (surface !== "tauri" && mode === "run" && event.target instanceof Element && event.target.closest(".run-stage")) {
        inputController.handleMouseDown(event);
      }
    },
    mouseup(event) {
      if (surface !== "tauri" && mode === "run") inputController.handleMouseUp(event);
    },
    wheel(event) {
      if (surface !== "tauri" && mode === "run" && event.target instanceof Element && event.target.closest(".run-stage")) {
        inputController.handleWheel(event);
      }
    },
  };
  for (const [type, handler] of Object.entries(runInputHandlers)) {
    window.addEventListener(type, handler, type === "wheel" ? { passive: false } : undefined);
  }
  const runFeedbackStage = query(".run-feedback-stage");
  const handleRunPointer = (event) => {
    if (surface === "tauri" || mode !== "run" || !(runFeedbackStage instanceof HTMLElement)) return;
    inputController.handlePointer(event, runFeedbackStage.getBoundingClientRect());
  };
  runFeedbackStage?.addEventListener("pointerdown", handleRunPointer);
  runFeedbackStage?.addEventListener("pointermove", handleRunPointer);
  runFeedbackStage?.addEventListener("pointerup", handleRunPointer);
  runFeedbackStage?.addEventListener("pointercancel", handleRunPointer);
  runFeedbackStage?.addEventListener("lostpointercapture", handleRunPointer);

  function requestStart() {
    const blocking = preflightItems().filter(({ result }) => result === "block");
    const fieldsValid = syncFieldValidation({ force: true });
    if (blocking.length > 0 || !fieldsValid) {
      const invalid = query('[aria-invalid="true"]');
      const sectionId = invalid?.closest("[data-setup-section]")?.getAttribute("data-setup-section") ?? "review";
      openSetupSection(sectionId);
      const focusTarget = isValidationControl(invalid)
        ? invalid
        : invalid?.querySelector?.("input, select, textarea, button");
      queueMicrotask(() => focusTarget?.focus());
      announce("Start blocked. Resolve the preflight list.");
      return;
    }
    const participant = deriveParticipantRecord({
      firstName: value("participant-first-name"),
      lastName: value("participant-last-name"),
      age: numberValue("participant-age"),
      gender: value("participant-gender"),
      handedness: value("participant-handedness"),
    });
    const participantState = selectedParticipantState();
    const attemptDisposition = selectedAttemptDisposition();
    const rerunConfirmed = participantState === "partial" && attemptDisposition === "new-attempt"
      ? true
      : participantState === "complete" && checked("participant-rerun-confirm");
    const settings = settingsSnapshot;
    const resolvedPlan = plan;
    const preflight = Object.freeze({
      inputTestPassed,
      nativeInputReceiptId: surface === "tauri" ? nativeInputReceiptId : null,
      verifiedStimulusIds: Object.freeze(stimuli.filter(({ verification }) => verification === "verified").map(({ id }) => id)),
      directoryPermission: capabilities.directoryPermission,
      indexedDbReady: capabilities.indexedDbReady,
      timingWorkerReady: capabilities.timingWorkerReady,
      lslReady: !settings.advanced.lsl.enabled || capabilities.lslReady,
      manifestReady: capabilities.manifestReady,
      storageReady: capabilities.storageReady
        && storageReadiness?.sufficient === true
        && storageReadiness?.writeReady !== false,
    });
    const detail = {
      participantId: selectedParticipant,
      participant,
      attemptDisposition,
      rerunConfirmed,
      settings,
      resolvedPlan,
      settingsSha256: settingsHash,
      preflight,
      outputFormats: { csv: checked("output-csv"), tsv: checked("output-tsv") },
      preview: Object.freeze(previewState({ locked: true })),
      ...(surface === "tauri" ? {
        playbackMode: value("native-playback-mode", "nativeLibvlc"),
        inputTestReceiptId: nativeInputReceiptId,
      } : {}),
    };
    youtubePreflightAdapter?.destroy();
    youtubePreflightAdapter = null;
    const youtubePanel = query("#youtube-preflight-panel");
    if (youtubePanel instanceof HTMLElement) youtubePanel.hidden = true;
    setInputValue("participant-first-name", "");
    setInputValue("participant-last-name", "");
    const event = new CustomEvent(RESEARCH_UI_EVENTS.startRequest, {
      bubbles: true,
      cancelable: true,
      detail: Object.freeze(detail),
    });
    root.dispatchEvent(event);
    if (!event.defaultPrevented) {
      announce("Start is waiting for the authoritative workspace and run adapter.");
      const status = query("#start-status");
      if (status) status.textContent = "Authoritative run adapter is not connected; no session was started.";
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!(target instanceof HTMLButtonElement)) return;
    if (target.dataset.modeButton && target.dataset.modeButton !== mode) {
      announce(mode === "run"
        ? "Complete the attempt or use Stop Early before returning to Setup."
        : "Running mode becomes available only after an attempt starts.");
    }
    if (target.dataset.openSection) openSetupSection(target.dataset.openSection);
    if (target.id === "workspace-choose") selectWorkspace();
    if (target.id === "video-import") requestVideoImport();
    if (target.id === "video-folder-import") requestVideoImport({ directory: true });
    if (target.id === "settings-load") requestSettingsLoad();
    if (target.id === "settings-save") requestSettingsSave();
    if (target.id === "workspace-renew") renewWorkspacePermission();
    if (target.id === "workspace-rescan") requestWorkspaceRescan();
    if (target.id === "stimulus-add-workspace") requestVideoImport();
    if (target.id === "stimulus-add-repository") openStimulusDialog("repository");
    if (target.id === "stimulus-add-youtube") openStimulusDialog("youtube");
    if (target.id === "condition-add") {
      const index = pools.length + 1;
      pools.push({ id: `condition-${index}-${Date.now()}`, label: `Condition ${index}`, videosPerParticipant: 1 });
      renderPools();
      schedulePlanRefresh();
    }
    if (target.matches("[data-pool-remove]")) {
      const section = target.closest("[data-pool-id]");
      const poolId = section?.getAttribute("data-pool-id");
      const index = pools.findIndex(({ id }) => id === poolId);
      if (index > -1 && pools.length > 1) {
        const [removed] = pools.splice(index, 1);
        for (const stimulus of stimuli) if (stimulus.poolId === removed.id) stimulus.poolId = pools[0].id;
        renderPools();
        schedulePlanRefresh();
      }
    }
    if (target.dataset.bindingDirection) {
      const direction = target.dataset.bindingDirection;
      const title = query("#binding-capture-title");
      const receipt = query("#binding-capture-receipt");
      if (title) title.textContent = `Capture ${target.querySelector("span")?.textContent ?? direction}`;
      if (receipt) {
        receipt.textContent = "Waiting for an input edge…";
        delete receipt.dataset.state;
      }
      query("#binding-capture-dialog")?.showModal();
      beginBindingCapture(direction);
    }
    if (target.id === "binding-reset") resetBindingsToPreset();
    if (target.id === "binding-capture-cancel") {
      cancelBindingCapture();
      closeDialog("binding-capture-dialog");
    }
    if (target.id === "input-test-reset") {
      resetInputTest();
      inputController.resetNeutral("input-test-reset");
      updateInputPoint(0, 0, "Input test reset to neutral.");
    }
    if (target.dataset.colorReset) {
      const definition = COLOR_FIELDS.find(({ id }) => id === target.dataset.colorReset);
      if (definition) {
        setInputValue(`color-${definition.id}`, definition.value);
        setInputValue(`color-${definition.id}-hex`, definition.value);
        refreshProjection();
        schedulePlanRefresh();
      }
    }
    if (target.dataset.colorAnchor) query(`#color-${target.dataset.colorAnchor}`)?.click();
    if (target.id === "stimulus-dialog-cancel") closeDialog("stimulus-dialog");
    if (target.id === "stimulus-dialog-add") {
      const source = value("stimulus-source", "workspace");
      const stimulus = addStimulus({ title: value("stimulus-title") || value("stimulus-location"), source, location: value("stimulus-location") });
      if (stimulus && pools.some(({ id }) => id === value("stimulus-condition"))) {
        stimulus.poolId = value("stimulus-condition");
        renderPools();
        schedulePlanRefresh();
      }
      if (stimulus?.source === "repository") verifyRepositoryStimulus(stimulus);
      if (stimulus?.verification !== "failed") closeDialog("stimulus-dialog");
    }
    if (target.dataset.youtubePreflight) {
      const stimulus = stimuli.find(({ id }) => id === target.dataset.youtubePreflight);
      if (stimulus) void preflightYouTubeStimulus(stimulus);
    }
    if (target.dataset.stimulusRemove) {
      const index = stimuli.findIndex(({ id }) => id === target.dataset.stimulusRemove);
      if (index >= 0) {
        const [removed] = stimuli.splice(index, 1);
        renderPools();
        schedulePlanRefresh();
        announce(`${removed.title} removed from the protocol.`);
      }
    }
    if (target.id === "plan-window-previous") {
      participantWindowStart = Math.max(0, participantWindowStart - 40);
      renderPlanPreview();
    }
    if (target.id === "plan-window-next") {
      participantWindowStart += 40;
      renderPlanPreview();
    }
    if (target.id === "participant-window-previous") {
      participantTileWindowStart = Math.max(0, participantTileWindowStart - 60);
      selectedParticipant = participantIds()[participantTileWindowStart];
      renderReview();
      queueMicrotask(() => query(`[data-participant-id="${selectedParticipant}"]`)?.focus());
    }
    if (target.id === "participant-window-next") {
      participantTileWindowStart += 60;
      const ids = participantIds();
      selectedParticipant = ids[Math.min(participantTileWindowStart, ids.length - 1)];
      renderReview();
      queueMicrotask(() => query(`[data-participant-id="${selectedParticipant}"]`)?.focus());
    }
    if (target.id === "assignment-plan-export") void exportAssignmentPlan();
    if (target.dataset.participantId) {
      selectedParticipant = target.dataset.participantId;
      renderReview();
      queueMicrotask(() => query(`[data-participant-id="${selectedParticipant}"]`)?.focus());
    }
    if (target.id === "start-experiment") requestStart();
    if (target.id === "run-pause") root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.pauseRequest, { bubbles: true }));
    if (target.id === "run-stop-early") query("#stop-early-dialog")?.showModal();
    if (target.id === "stop-early-cancel") closeDialog("stop-early-dialog");
    if (target.id === "stop-early-confirm") {
      closeDialog("stop-early-dialog");
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.stopEarlyRequest, { bubbles: true }));
    }
    if (target.id === "completion-return") {
      closeDialog("completion-dialog");
      setMode("setup");
      openSetupSection("review", { focus: true });
      resetInputTest();
    }
    if (target.id === "import-report-close") closeDialog("import-report-dialog");
    if (target.id === "run-continue") root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.continueRequest, { bubbles: true }));
  });

  root.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === "color") {
      setInputValue(`${target.id}-hex`, target.value.toLowerCase());
    } else if (target instanceof HTMLInputElement && target.id.endsWith("-hex")) {
      const colorInput = query(`#${target.id.slice(0, -4)}`);
      if (colorInput instanceof HTMLInputElement && /^#[0-9a-f]{6}$/i.test(target.value)) colorInput.value = target.value;
    }
    if (target instanceof HTMLInputElement && ["participant-first-name", "participant-last-name"].includes(target.id)) renderNameCode();
    if (target instanceof HTMLInputElement && target.id === "input-step-size" && inputBinding.kind === "digital") {
      try {
        inputBinding = structuredClone(validateInputBindingV1({ ...inputBinding, stepSize: Number(target.value) }));
        inputController.setBinding(inputBinding);
        resetInputTest();
      } catch {
        // Native HTML validation and the blocking preflight expose the invalid interim value.
      }
    }
    if (isValidationControl(target) && touchedValidationControls.has(target)) {
      syncControlValidation(target);
    }
    refreshProjection();
    schedulePlanRefresh();
  });

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && ["output-csv", "output-tsv"].includes(target.id)) {
      outputFormatsTouched = true;
      syncOutputFormatValidation();
    }
    if (target instanceof HTMLSelectElement && target.id === "input-preset") {
      resetBindingsToPreset();
      inputController.resetNeutral("preset-change");
    }
    if (target instanceof HTMLSelectElement && target.id === "stimulus-source") updateStimulusDialogSource();
    if (target instanceof HTMLSelectElement && target.dataset.stimulusPool) {
      const stimulus = stimuli.find(({ id }) => id === target.dataset.stimulusPool);
      if (stimulus) stimulus.poolId = target.value;
      renderPools();
    }
    if (target instanceof HTMLInputElement && target.matches("[data-pool-label]")) {
      const pool = pools.find(({ id }) => id === target.closest("[data-pool-id]")?.getAttribute("data-pool-id"));
      if (pool) pool.label = target.value.trim() || pool.label;
      renderPools();
    }
    if (target instanceof HTMLInputElement && target.matches("[data-pool-count]")) {
      const pool = pools.find(({ id }) => id === target.closest("[data-pool-id]")?.getAttribute("data-pool-id"));
      if (pool) pool.videosPerParticipant = Math.max(1, Math.trunc(Number(target.value) || 1));
      renderPools();
    }
    if (isValidationControl(target)) syncControlValidation(target);
    refreshProjection();
    schedulePlanRefresh();
  });

  root.addEventListener("focusout", (event) => {
    const control = event.target;
    if (!isValidationControl(control)) return;
    touchedValidationControls.add(control);
    syncControlValidation(control);
  });

  root.addEventListener("keydown", (event) => {
    if (inputController.captureDirection || nativeCaptureDirection) {
      if (event.key === "Escape") {
        cancelBindingCapture();
        closeDialog("binding-capture-dialog");
      } else if (surface !== "tauri") routeCaptureEvent(event);
      return;
    }
    const tile = event.target instanceof Element ? event.target.closest("[data-participant-id]") : null;
    if (tile instanceof HTMLButtonElement
      && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      const ids = participantIds();
      const current = ids.indexOf(tile.dataset.participantId);
      const columns = matchMedia("(max-width: 1050px)").matches ? 3 : 5;
      const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, PageUp: -60, PageDown: 60 };
      const requested = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : current + deltas[event.key];
      const nextIndex = Math.max(0, Math.min(ids.length - 1, requested));
      selectedParticipant = ids[nextIndex];
      participantTileWindowStart = Math.floor(nextIndex / 60) * 60;
      renderReview();
      queueMicrotask(() => query(`[data-participant-id="${selectedParticipant}"]`)?.focus());
      event.preventDefault();
    }
  });

  root.addEventListener("mousedown", (event) => {
    if (inputController.captureDirection && !event.target.closest("#binding-capture-cancel")) routeCaptureEvent(event);
  });
  root.addEventListener("wheel", (event) => {
    if (inputController.captureDirection) routeCaptureEvent(event);
  }, { passive: false });

  const dropZone = query("#video-drop-zone");
  for (const type of ["dragenter", "dragover"]) dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.dataset.dragActive = "true";
  });
  for (const type of ["dragleave", "drop"]) dropZone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.dataset.dragActive = "false";
  });
  async function filesFromDroppedEntries(dataTransfer) {
    const items = [...(dataTransfer?.items ?? [])];
    const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...(dataTransfer?.files ?? [])];
    const files = [];
    async function visit(entry, prefix = "") {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        const relativeName = `${prefix}${file.name}`;
        files.push(new File([file], relativeName, { type: file.type, lastModified: file.lastModified }));
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await visit(child, `${prefix}${entry.name}/`);
      } while (batch.length > 0);
    }
    for (const entry of entries) await visit(entry);
    return files;
  }
  dropZone?.addEventListener("drop", async (event) => {
    if (surface === "tauri") {
      announce("Use the Windows import control so the native workspace authority owns every selected path.");
      return;
    }
    try {
      await ingestBrowserFiles(await filesFromDroppedEntries(event.dataTransfer));
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error));
    }
  });
  query("#video-file-input")?.addEventListener("change", async (event) => {
    await ingestBrowserFiles(event.target.files);
    event.target.value = "";
  });

  query("#video-folder-input")?.addEventListener("change", async (event) => {
    await ingestBrowserFiles(event.target.files);
    event.target.value = "";
  });

  query("#settings-file-input")?.addEventListener("change", async (event) => {
    const [file] = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!file) return;
    try {
      const maximumBytes = 5 * 1024 * 1024;
      if (file.size < 1 || file.size > maximumBytes) {
        throw new RangeError(`Settings JSON must contain between 1 byte and ${maximumBytes} bytes.`);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      loadSettingsPayload(parseStrictJson(text, { maximumBytes }));
    } catch (error) {
      announce(`Settings import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  root.addEventListener(RESEARCH_UI_EVENTS.settingsLoaded, (event) => {
    try {
      loadSettingsPayload(event.detail?.settings ?? event.detail, { report: event.detail?.report ?? null });
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error));
    }
  });

  root.addEventListener(RESEARCH_UI_EVENTS.capabilityStatus, (event) => {
    for (const key of Object.keys(capabilities)) {
      if (typeof event.detail?.[key] === "boolean") capabilities[key] = event.detail[key];
    }
    if (event.detail?.storageReadiness && typeof event.detail.storageReadiness === "object") {
      storageReadiness = Object.freeze({ ...event.detail.storageReadiness });
    }
    if (event.detail?.nativeMediaCapability && typeof event.detail.nativeMediaCapability === "object") {
      nativeMediaCapability = Object.freeze({ ...event.detail.nativeMediaCapability });
      const output = query("#native-media-capability");
      if (output) {
        output.textContent = nativeMediaCapability.qualifiedStartAvailable
          ? `Pinned ${nativeMediaCapability.backend} ${nativeMediaCapability.pinnedRuntimeVersion} ready for qualified playback.`
          : `Unavailable: ${nativeMediaCapability.reasonCode}. The fallback is explicitly unqualified.`;
      }
    }
    if (typeof event.detail?.manifestError === "string" && event.detail.manifestError.trim()) {
      manifestReadinessMessage = `Output manifests are corrupt or unreadable: ${event.detail.manifestError.trim()}`;
    } else if (capabilities.manifestReady) {
      manifestReadinessMessage = "Output manifests are readable.";
    } else if (event.detail?.manifestReady === false) {
      manifestReadinessMessage = "Output manifests have not passed the readability scan.";
    }
    const renew = query("#workspace-renew");
    if (renew instanceof HTMLButtonElement) renew.hidden = capabilities.directoryPermission;
    refreshProjection();
  });

  root.addEventListener(RESEARCH_UI_EVENTS.stimuliCatalogued, (event) => {
    try {
      const entries = Array.isArray(event.detail?.items) ? event.detail.items : [];
      if (event.detail?.replace === true) {
        for (let index = stimuli.length - 1; index >= 0; index -= 1) {
          if (stimuli[index].source === "workspace") stimuli.splice(index, 1);
        }
      }
      for (const entry of entries) {
        const item = validateStimulusV1(entry.stimulus ?? entry);
        const existing = stimuli.find(({ id }) => id === item.stimulusId);
        const poolId = entry.poolId ?? existing?.poolId ?? pools[0].id;
        const next = {
          id: item.stimulusId,
          title: item.title,
          source: item.source.kind === "workspaceFile" ? "workspace" : item.source.kind === "repositoryAsset" ? "repository" : "youtube",
          location: item.source.relativePath ?? item.source.url,
          poolId,
          verification: item.source.kind === "youtube" ? "unverified" : entry.verified === false ? "pending" : "verified",
          contractSource: structuredClone(item.source),
          youtubePreflight: null,
        };
        if (existing) Object.assign(existing, next);
        else stimuli.push(next);
      }
      renderPools();
      schedulePlanRefresh();
    } catch (error) {
      announce(error instanceof Error ? error.message : String(error));
    }
  });

  root.addEventListener(RESEARCH_UI_EVENTS.runStarted, (event) => {
    const detail = event.detail ?? {};
    const runModeButton = query('[data-mode-button="run"]');
    if (runModeButton instanceof HTMLButtonElement) runModeButton.disabled = false;
    const participant = query("#run-participant");
    const session = query("#run-session");
    if (participant) participant.textContent = detail.participantId ?? selectedParticipant;
    if (session) session.textContent = detail.sessionStem ?? "Attempt active";
    runPreview.update(previewState({ locked: true }));
    setMode("run");
    query("#run-pause")?.focus();
  });

  root.addEventListener(RESEARCH_UI_EVENTS.runStatus, (event) => {
    const detail = event.detail ?? {};
    for (const [key, selector] of Object.entries({ stimulus: "#run-stimulus-status", timing: "#run-timing-status", write: "#run-write-status", lsl: "#run-lsl-status" })) {
      const output = query(selector);
      if (output && detail[key] !== undefined) output.textContent = String(detail[key]);
    }
    if (Number.isFinite(detail.x) && Number.isFinite(detail.y)) {
      inputPoint = { x: detail.x, y: detail.y };
      runPreview.update(previewState({ locked: true }));
    }
    const pause = query("#run-pause");
    if (pause instanceof HTMLButtonElement && typeof detail.paused === "boolean") {
      pause.textContent = detail.paused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", String(detail.paused));
    }
    const transition = query("#run-transition");
    if (transition instanceof HTMLElement && typeof detail.transitionActive === "boolean") {
      const transitionWasHidden = transition.hidden;
      transition.hidden = !detail.transitionActive;
      const message = query("#run-transition-message");
      if (message && detail.transitionMessage) message.textContent = String(detail.transitionMessage);
      const proceed = query("#run-continue");
      if (proceed instanceof HTMLButtonElement) {
        const proceedWasHidden = proceed.hidden;
        proceed.hidden = detail.transitionMode !== "continueWhenReady";
        if (!transition.hidden && !proceed.hidden && (transitionWasHidden || proceedWasHidden)) {
          queueMicrotask(() => proceed.focus());
        }
      }
    }
    const video = query("#run-video");
    if (video instanceof HTMLVideoElement && typeof detail.stimulus === "string" && detail.stimulus.trim()) {
      video.setAttribute("aria-label", `Protocol-controlled stimulus: ${detail.stimulus.trim()}`);
    }
    if (video instanceof HTMLVideoElement && typeof detail.videoUrl === "string" && detail.videoUrl) {
      if (video.src !== detail.videoUrl) video.src = detail.videoUrl;
      video.hidden = false;
      const placeholder = query("#run-stimulus-placeholder");
      if (placeholder instanceof HTMLElement) placeholder.hidden = true;
    }
  });

  root.addEventListener(RESEARCH_UI_EVENTS.runComplete, (event) => {
    const receipt = query("#completion-receipt");
    if (receipt instanceof HTMLElement) {
      const entries = Object.entries(event.detail ?? {});
      receipt.replaceChildren(...entries.map(([label, value]) => {
        const item = document.createElement("li");
        item.textContent = `${label}: ${value}`;
        return item;
      }));
    }
    query("#completion-dialog")?.showModal();
  });

  root.addEventListener(RESEARCH_UI_EVENTS.participantStates, (event) => {
    participantStates.clear();
    participantRecoverability.clear();
    for (const [id, state] of Object.entries(event.detail ?? {})) {
      if (["available", "active", "partial", "complete"].includes(state)) participantStates.set(id, state);
    }
    for (const [id, recoverable] of Object.entries(event.detail?.__recoverable ?? {})) {
      if (typeof recoverable === "boolean") participantRecoverability.set(id, recoverable);
    }
    renderReview();
  });

  root.addEventListener(RESEARCH_UI_EVENTS.workspaceReady, (event) => {
    root.dataset.nativeWorkspaceReady = "true";
    capabilities.directoryPermission = event.detail?.directoryPermission !== false;
    const output = query("#workspace-root");
    if (output) {
      output.textContent = event.detail?.label ?? (event.detail?.surface === "browser" ? "Browser workspace ready" : "Windows workspace ready");
      output.dataset.state = "ready";
    }
    for (const id of ["workspace-rescan", "settings-save", "stimulus-add-workspace", "video-import", "video-folder-import"]) {
      const button = query(`#${id}`);
      if (button instanceof HTMLButtonElement) button.disabled = false;
    }
    refreshProjection();
  });

  root.querySelectorAll("[data-open-section]").forEach((button) => button.addEventListener("keydown", (event) => {
    const index = SETUP_SECTIONS.findIndex(({ id }) => id === button.dataset.openSection);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const requested = event.key === "Home" ? 0 : event.key === "End" ? SETUP_SECTIONS.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + SETUP_SECTIONS.length) % SETUP_SECTIONS.length;
    openSetupSection(SETUP_SECTIONS[requested].id, { focus: true });
    event.preventDefault();
  }));

  renderPools();
  renderBindings();
  renderParticipantGrid();
  refreshProjection();
  schedulePlanRefresh();

  return Object.freeze({
    get mode() { return mode; },
    get openSection() { return openSection; },
    get workspace() { return workspace; },
    get settings() { return settingsSnapshot; },
    get plan() { return plan; },
    get storageEstimate() { return estimateResearchStorageUse(settingsSnapshot, plan); },
    get inputController() { return inputController; },
    get inputBinding() { return structuredClone(inputBinding); },
    get nativeInputReceiptId() { return nativeInputReceiptId; },
    getYouTubePreflight(stimulusId) {
      const record = stimuli.find(({ id }) => id === stimulusId)?.youtubePreflight;
      return record ? structuredClone(record) : null;
    },
    setMode,
    openSetupSection,
    getValidatedSetup() {
      return Object.freeze({
        settings: researchSettingsFromUi(),
        settingsSha256: settingsHash,
        resolvedPlan: plan,
      });
    },
    applySettings(settings, options) {
      loadSettingsPayload(settings, options);
    },
    setCapabilities(next) {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.capabilityStatus, { detail: next }));
    },
    setAffect(x, y, receipt = "Authoritative input received.") { updateInputPoint(x, y, receipt); },
    applyNativeInputStatus,
    applyNativeCapture,
    resetAffect(reason = "safe-boundary") {
      inputController.resetNeutral(reason);
      return Object.freeze({ x: inputController.state.x, y: inputController.state.y, inputActive: inputController.state.inputActive });
    },
    setParticipantStates(states) {
      root.dispatchEvent(new CustomEvent(RESEARCH_UI_EVENTS.participantStates, { detail: states }));
    },
    destroy() {
      youtubePreflightAdapter?.destroy();
      youtubePreflightAdapter = null;
      setupPreview.destroy();
      runPreview.destroy();
      inputController.detach();
      cancelBindingCapture();
      for (const [type, handler] of Object.entries(runInputHandlers)) window.removeEventListener(type, handler);
      runFeedbackStage?.removeEventListener("pointerdown", handleRunPointer);
      runFeedbackStage?.removeEventListener("pointermove", handleRunPointer);
      runFeedbackStage?.removeEventListener("pointerup", handleRunPointer);
      runFeedbackStage?.removeEventListener("pointercancel", handleRunPointer);
      runFeedbackStage?.removeEventListener("lostpointercapture", handleRunPointer);
    },
  });
}
