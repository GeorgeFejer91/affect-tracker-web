import { createInstructionAffectComparison } from "./affect-comparison.js";
import {
  BrowserStudySession,
  createRunConfiguration,
  findStudyBlock,
  questionnaireForBlock,
} from "./participant-runner.js";
import {
  applyEvidenceWriteSafetyFence,
  DEFAULT_EVIDENCE_WRITE_DEADLINE_MS,
  EvidenceWriteWatchdog,
} from "./evidence-write-watchdog.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function referencedAssetIds(study) {
  const ids = new Set();
  for (const section of study.sections ?? []) for (const trial of section.trials ?? []) {
    for (const block of trial.blocks ?? []) {
      if (block.type === "video" && block.source?.kind === "contentAsset") ids.add(block.source.assetId);
    }
  }
  return [...ids];
}

function requiredCounterbalanceRows(study) {
  const rowCounts = (study.sections ?? [])
    .filter((section) => section.orderPolicy?.type === "williamsBalancedLatinSquare")
    .map((section) => section.trials.length % 2 === 0 ? section.trials.length : section.trials.length * 2);
  return rowCounts.length ? Math.min(...rowCounts) : undefined;
}

const externalTransitionKinds = Object.freeze({
  arm: "prepared",
  start: "render-block",
  pause: "pause-media",
  resume: "resume-media",
  advance: "render-block",
  retryBlock: "render-block",
  stop: "await-finalization",
  finalize: "terminal",
  abort: "terminal",
});

export function externalParticipantTransition(detail) {
  if (detail?.error) return undefined;
  const actionType = detail?.action?.command?.type;
  const state = detail?.outcome?.state;
  if (!externalTransitionKinds[actionType]
    || !state
    || !Number.isSafeInteger(state.revision)
    || typeof state.phase !== "string") {
    return undefined;
  }
  const kind = ["completed", "aborted"].includes(state.phase)
    ? "terminal"
    : state.phase === "awaitingFinalization"
      ? "await-finalization"
      : externalTransitionKinds[actionType];
  return Object.freeze({
    actionType,
    kind,
    phase: state.phase,
    revision: state.revision,
  });
}

export function externalParticipantSafetyTransition(detail) {
  const transition = externalParticipantTransition(detail);
  if (!transition) return undefined;
  if (transition.actionType === "pause") {
    return Object.freeze({ kind: "pause-media", revision: transition.revision });
  }
  if (["advance", "retryBlock", "stop", "finalize", "abort"].includes(transition.actionType)) {
    return Object.freeze({ kind: "retire-block", revision: transition.revision });
  }
  return undefined;
}

export function createRemoteMirrorFailureRevocation(remoteControlUi) {
  let revocation;
  return () => {
    if (!revocation) {
      revocation = Promise.resolve(remoteControlUi?.stop?.("browser_mirror_failure"));
    }
    return revocation;
  };
}

export async function requestRemoteMediaResume({ video, youtubePlayer } = {}) {
  if (video?.paused) {
    try {
      await video.play();
      return Object.freeze({
        media: "video",
        started: true,
        message: "Protocol and local media resumed by the remote researcher.",
      });
    } catch (error) {
      return Object.freeze({
        media: "video",
        started: false,
        error,
        message: "The protocol resumed, but browser policy kept the video paused. Press Play locally before collecting further stimulus data.",
      });
    }
  }
  if (youtubePlayer?.playVideo) {
    youtubePlayer.playVideo();
    return Object.freeze({
      media: "youtube",
      started: undefined,
      message: "The protocol resumed; waiting for the media player to confirm playback.",
    });
  }
  return Object.freeze({
    media: "none",
    started: true,
    message: "Protocol resumed by the remote researcher.",
  });
}

export async function revokeRemoteControl(remoteControlUi, reason = "local_revoke") {
  if (typeof remoteControlUi?.stop !== "function") return false;
  await remoteControlUi.stop(reason);
  return true;
}

export function fenceDisallowedMediaPlayback({ phase, reportsSuppressed = false, pause } = {}) {
  const allowed = phase === "running" && !reportsSuppressed;
  if (!allowed) pause?.();
  return !allowed;
}

export function mediaAdaptersAllowed({ adapterEpoch, currentAdapterEpoch, phase, reportsSuppressed = false } = {}) {
  return adapterEpoch === currentAdapterEpoch && phase === "running" && !reportsSuppressed;
}

export async function confirmMediaPlaybackAfterReport({ report, isAllowed, fence } = {}) {
  try {
    await report();
  } catch (error) {
    fence?.(error);
    return false;
  }
  if (isAllowed?.()) return true;
  fence?.();
  return false;
}

export async function dispatchPauseWithSafetyFence({ fence, dispatch } = {}) {
  if (typeof fence !== "function" || typeof dispatch !== "function") {
    throw new TypeError("Pause safety requires fence and dispatch functions.");
  }
  fence();
  return dispatch();
}

export function scheduleSingleFlight(holder, run, onError = () => {}) {
  if (!holder || typeof holder !== "object" || typeof run !== "function" || typeof onError !== "function") {
    throw new TypeError("Single-flight scheduling requires a holder, run function, and error handler.");
  }
  if (holder.current) return false;
  let operation;
  try {
    operation = Promise.resolve(run());
  } catch (error) {
    operation = Promise.reject(error);
  }
  holder.current = operation;
  void operation
    .catch(onError)
    .finally(() => {
      if (holder.current === operation) holder.current = undefined;
    });
  return true;
}

export function participantPausePresentation(phase) {
  const paused = phase === "paused";
  return Object.freeze({ reportsSuppressed: paused, buttonLabel: paused ? "Resume" : "Pause" });
}

export function evidencePersistenceFailureDisposition(pendingCommand) {
  const accepted = Boolean(pendingCommand && typeof pendingCommand.type === "string");
  return Object.freeze({
    acceptedOutcomeStaged: accepted,
    allowExactRetry: accepted && ["reportMediaTimeline", "recordAffectSample"].includes(pendingCommand.type),
    allowPartialRetention: accepted,
    restoreOrdinaryControls: !accepted,
  });
}

export function answerMarkup(item) {
  const required = item.required ? " required" : "";
  const rangeDisabled = item.required ? "" : " disabled";
  const optionalRangeToggle = item.required
    ? ""
    : '<label class="study-choice"><input type="checkbox" data-answer-enable> Provide a response</label>';
  const name = `answer-${item.itemId}`;
  const prompt = `<legend>${escapeHtml(item.prompt)}${item.required ? " *" : ""}</legend>`;
  if (item.type === "acknowledgement") {
    return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="${item.type}">${prompt}<label class="study-choice"><input type="checkbox" name="${name}"${required}> I acknowledge this statement</label></fieldset>`;
  }
  if (["singleChoice", "multipleChoice"].includes(item.type)) {
    const inputType = item.type === "singleChoice" ? "radio" : "checkbox";
    return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="${item.type}"${item.minSelections === undefined ? "" : ` data-min-selections="${item.minSelections}" data-max-selections="${item.maxSelections}"`}>${prompt}${item.options.map((entry) => `<label class="study-choice"><input type="${inputType}" name="${name}" value="${escapeHtml(entry.optionId)}"${required && inputType === "radio" ? " required" : ""}> ${escapeHtml(entry.label)}</label>`).join("")}</fieldset>`;
  }
  if (item.type === "likert") {
    const values = Array.from({ length: item.max - item.min + 1 }, (_, index) => item.min + index);
    return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="${item.type}">${prompt}<div class="study-scale-labels"><span>${escapeHtml(item.minLabel)}</span><span>${escapeHtml(item.maxLabel)}</span></div><div class="study-likert">${values.map((value) => `<label><input type="radio" name="${name}" value="${value}"${required}> <span>${value}</span></label>`).join("")}</div></fieldset>`;
  }
  if (item.type === "vas") {
    return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="${item.type}" data-optional-range="${String(!item.required)}">${prompt}${optionalRangeToggle}<div class="study-scale-labels"><span>${escapeHtml(item.minLabel)}</span><output>${item.required ? item.min : "No response"}</output><span>${escapeHtml(item.maxLabel)}</span></div><input type="range" name="${name}" min="${item.min}" max="${item.max}" step="${item.step}" value="${item.min}"${rangeDisabled}></fieldset>`;
  }
  if (item.type === "numeric") {
    return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="${item.type}">${prompt}<input type="number" name="${name}" min="${item.min}" max="${item.max}" step="${item.step}"${required}><span class="study-help">${escapeHtml(item.unit ?? "")}</span></fieldset>`;
  }
  return `<fieldset data-question-item="${escapeHtml(item.itemId)}" data-question-type="affect2d" data-optional-range="${String(!item.required)}">${prompt}${optionalRangeToggle}<label class="study-field"><span>Valence</span><input type="range" name="${name}-valence" min="-1" max="1" step="${item.step}" value="0"${rangeDisabled}><output>${item.required ? "0.00" : "No response"}</output></label><label class="study-field"><span>Arousal</span><input type="range" name="${name}-arousal" min="-1" max="1" step="${item.step}" value="0"${rangeDisabled}><output>${item.required ? "0.00" : "No response"}</output></label></fieldset>`;
}

export function collectAnswers(form, questionnaire) {
  const answers = [];
  for (const item of questionnaire.items) {
    const name = `answer-${item.itemId}`;
    if (item.type === "acknowledgement") {
      const input = form.elements.namedItem(name);
      if (input.checked || item.required) answers.push({ type: item.type, itemId: item.itemId, acknowledged: input.checked });
    } else if (item.type === "singleChoice") {
      const selected = form.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
      if (selected) answers.push({ type: item.type, itemId: item.itemId, optionId: selected.value });
    } else if (item.type === "multipleChoice") {
      const optionIds = [...form.querySelectorAll(`input[name="${CSS.escape(name)}"]:checked`)].map(({ value }) => value);
      if (optionIds.length || item.required) answers.push({ type: item.type, itemId: item.itemId, optionIds });
    } else if (item.type === "likert") {
      const selected = form.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
      if (selected) answers.push({ type: item.type, itemId: item.itemId, value: Number(selected.value) });
    } else if (["vas", "numeric"].includes(item.type)) {
      const input = form.elements.namedItem(name);
      if (!input.disabled && input.value !== "") answers.push({ type: item.type, itemId: item.itemId, value: Number(input.value) });
    } else if (item.type === "affect2d") {
      const valence = form.elements.namedItem(`${name}-valence`);
      const arousal = form.elements.namedItem(`${name}-arousal`);
      if (!valence.disabled && !arousal.disabled) {
        answers.push({
          type: item.type,
          itemId: item.itemId,
          valence: Number(valence.value),
          arousal: Number(arousal.value),
        });
      }
    }
  }
  return answers;
}

export function multipleChoiceSelectionError(item, selectedCount) {
  if (item.type !== "multipleChoice") return undefined;
  if (!Number.isSafeInteger(selectedCount) || selectedCount < 0) {
    throw new TypeError("selectedCount must be a non-negative integer.");
  }
  if (!item.required && selectedCount === 0) return undefined;
  if (selectedCount < item.minSelections || selectedCount > item.maxSelections) {
    return `Select between ${item.minSelections} and ${item.maxSelections} choices.`;
  }
  return undefined;
}

let youtubeApiPromise;
function loadYouTubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise((resolve, reject) => {
    const previous = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(globalThis.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("The YouTube player API could not be loaded."));
    document.head.append(script);
  });
  return youtubeApiPromise;
}

class ParticipantRunView {
  constructor({
    core,
    study,
    assetBindings,
    surface,
    remoteControlUi,
    onClose,
    host = document.body,
    evidenceWriteDeadlineMs = DEFAULT_EVIDENCE_WRITE_DEADLINE_MS,
    setTimeoutFn,
    clearTimeoutFn,
  }) {
    this.core = core;
    this.study = study;
    this.assetBindings = assetBindings;
    this.surface = surface;
    this.remoteControlUi = remoteControlUi;
    this.onClose = onClose;
    this.host = host;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "study-participant-dialog";
    this.session = undefined;
    this.comparison = undefined;
    this.animationFrame = undefined;
    this.mediaTimer = undefined;
    this.sampleTimer = undefined;
    this.mediaReportFlight = { current: undefined };
    this.sampleFlight = { current: undefined };
    this.objectUrl = undefined;
    this.youtubePlayer = undefined;
    this.affect = { x: 0, y: 0 };
    this.adapterEpoch = 0;
    this.remoteMediaReportsSuppressed = false;
    this.suppressNextVideoPauseReport = false;
    this.suppressNextYouTubePauseReport = false;
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe = undefined;
    this.externalOutcomeTail = Promise.resolve();
    this.lastExternalRevision = -1;
    this.lastExternalSafetyRevision = -1;
    this.pendingExternalSafety = undefined;
    this.pendingExternalControls = undefined;
    this.terminalFinalization = undefined;
    this.resultRendered = false;
    this.externalMirrorFailed = false;
    this.unacceptedEvidenceFailure = false;
    this.revokeRemoteForMirrorFailure = createRemoteMirrorFailureRevocation(remoteControlUi);
    this.evidenceWriteWatchdog = new EvidenceWriteWatchdog({
      deadlineMs: evidenceWriteDeadlineMs,
      ...(setTimeoutFn ? { setTimeoutFn } : {}),
      ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
      onDeadline: (detail) => this.handleEvidenceWriteDeadline(detail),
      onQuiescent: (detail) => this.handleEvidenceWriteQuiescent(detail),
    });
    this.visibilityListener = () => {
      if (document.visibilityState !== "visible"
        && this.evidenceWriteWatchdog.snapshot().activeCount > 0) {
        this.evidenceWriteWatchdog.alarmNow("document-hidden");
      }
    };
    this.closed = false;
  }

  async open() {
    this.host.append(this.dialog);
    document.addEventListener("visibilitychange", this.visibilityListener);
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!this.session) {
        void this.close();
        return;
      }
      let phase = "created";
      try {
        phase = this.session.state().phase;
      } catch {
        // Initialization still owns the modal.
      }
      const pending = this.session.pendingJournalCommand?.();
      this.setStatus(
        pending
          ? `The accepted ${pending.type} outcome is not committed. Use its exact Retry control where offered, or End and retain partial evidence.`
          : ["created", "prepared", "armed"].includes(phase)
          ? "The run is prepared. Use Abort prepared run so its record is finalized explicitly."
          : "The run is still active. Use Stop run so its record is finalized explicitly.",
        true,
      );
    });
    const missing = referencedAssetIds(this.study).filter((assetId) => !this.assetBindings.has(assetId));
    const hasShuffle = (this.study.sections ?? []).some(({ orderPolicy }) => orderPolicy.type === "seededShuffle");
    const counterbalanceRows = requiredCounterbalanceRows(this.study);
    this.dialog.innerHTML = `<form id="participant-preflight" class="study-participant-preflight">
      <h2>Prepare participant run</h2>
      <p>Review local readiness before the immutable protocol starts. No media or response data leaves this device.</p>
      ${missing.length ? `<p data-severity="error">Select these content assets in the Asset library first: ${missing.map(escapeHtml).join(", ")}.</p>` : ""}
      <label class="study-field"><span>Participant code (optional)</span><input name="participantCode" maxlength="128" autocomplete="off"><span class="study-help">Use a pseudonymous code, not a participant name.</span></label>
      ${hasShuffle ? `<label class="study-field"><span>128-bit run seed</span><input name="randomSeed" required pattern="[0-9a-f]{32}" value="${createRunConfiguration(this.study, { platform: this.surface === "desktop" ? "desktop" : "pages2d" }).randomSeed}"></label>` : ""}
      ${counterbalanceRows ? `<label class="study-field"><span>Counterbalance group</span><input name="counterbalanceGroup" required type="number" min="1" max="${counterbalanceRows}" value="1"><span class="study-help">Choose one of ${counterbalanceRows} Williams rows.</span></label>` : ""}
      ${this.study.pinnedSettings.acquisition.resetPolicy === "requireCalibration" ? `<fieldset><legend>Pre-run affect calibration</legend><label class="study-field"><span>Valence</span><input name="calibrationValence" type="range" min="-1" max="1" step="0.01" value="0"></label><label class="study-field"><span>Arousal</span><input name="calibrationArousal" type="range" min="-1" max="1" step="0.01" value="0"></label></fieldset>` : ""}
      <div class="study-inline-actions"><button type="button" data-close>Cancel</button><button type="submit" data-variant="primary"${missing.length ? " disabled" : ""}>${this.surface === "desktop" ? "Prepare run" : "Prepare and start"}</button></div>
      <p class="study-status" aria-live="polite"></p>
    </form>`;
    this.dialog.querySelector("[data-close]").addEventListener("click", () => this.close());
    this.dialog.querySelector("#participant-preflight").addEventListener("submit", (event) => this.start(event));
    this.dialog.showModal();
  }

  async start(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector(".study-status");
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    status.textContent = "Validating protocol and opening the local run journal…";
    try {
      const published = this.study.protocolHash ? this.study : await this.core.publish(this.study);
      const values = new FormData(form);
      const configuration = createRunConfiguration(published, {
        platform: this.surface === "desktop" ? "desktop" : "pages2d",
        participantCode: String(values.get("participantCode") ?? "").trim() || undefined,
        randomSeed: values.get("randomSeed") || undefined,
        counterbalanceGroup: values.get("counterbalanceGroup") || undefined,
      });
      this.study = published;
      this.session = new BrowserStudySession({
        core: this.core,
        study: published,
        configuration,
        assetBindings: this.assetBindings,
      });
      this.subscribeToExternalOutcomes();
      const calibrationPoint = published.pinnedSettings.acquisition.resetPolicy === "requireCalibration"
        ? { valence: Number(values.get("calibrationValence")), arousal: Number(values.get("calibrationArousal")) }
        : undefined;
      await this.session.initialize({
        calibrationPoint,
        ...(this.surface === "desktop" ? { autoStart: false } : {}),
      });
      if (this.surface === "desktop") await this.renderPrepared();
      else await this.renderCurrentBlock();
    } catch (error) {
      const failedSession = this.session;
      this.session = undefined;
      this.externalOutcomeUnsubscribe?.();
      this.externalOutcomeUnsubscribe = undefined;
      this.externalAcceptedUnsubscribe?.();
      this.externalAcceptedUnsubscribe = undefined;
      if (failedSession?.authority) {
        await failedSession.abort("initialization-failed").catch(() => failedSession.close());
      }
      status.textContent = error?.message ?? String(error);
      submit.disabled = false;
    }
  }

  subscribeToExternalOutcomes() {
    this.externalAcceptedUnsubscribe?.();
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe?.();
    this.externalOutcomeUnsubscribe = undefined;
    if (this.surface !== "desktop" || typeof this.session?.subscribeExternalOutcomes !== "function") return;
    if (typeof this.session.subscribeExternalAcceptedOutcomes === "function") {
      this.externalAcceptedUnsubscribe = this.session.subscribeExternalAcceptedOutcomes((value) => {
        const safety = externalParticipantSafetyTransition(value?.detail ?? value);
        if (!safety || safety.revision <= this.lastExternalSafetyRevision) return;
        this.lastExternalSafetyRevision = safety.revision;
        this.pendingExternalSafety = safety;
        this.applyExternalSafetyFence(safety);
      });
    }
    this.externalOutcomeUnsubscribe = this.session.subscribeExternalOutcomes((value) => {
      const detail = value?.detail ?? value;
      if (detail?.error) {
        this.externalMirrorFailed = true;
        this.externalOutcomeTail = this.externalOutcomeTail
          .then(() => this.handleExternalMirrorFailure(detail))
          .catch((error) => this.setStatus(error?.message ?? String(error), true));
        return;
      }
      const transition = externalParticipantTransition(detail);
      if (!transition || transition.revision <= this.lastExternalRevision) return;
      this.lastExternalRevision = transition.revision;
      this.externalOutcomeTail = this.externalOutcomeTail
        .then(async () => {
          await this.applyExternalTransition(transition, detail);
          this.restorePendingExternalControls();
          if (this.pendingExternalSafety?.revision <= transition.revision) {
            this.pendingExternalSafety = undefined;
          } else if (this.pendingExternalSafety) {
            this.applyExternalSafetyFence(this.pendingExternalSafety, false);
          }
        })
        .catch((error) => this.setStatus(error?.message ?? String(error), true));
    });
  }

  applyExternalSafetyFence(safety, announce = true) {
    const retireBlock = safety.kind === "retire-block";
    this.remoteMediaReportsSuppressed = true;
    if (retireBlock) {
      this.adapterEpoch += 1;
      if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
      this.comparison = undefined;
    }
    this.stopSampling();
    clearInterval(this.mediaTimer);
    this.mediaTimer = undefined;
    const video = this.dialog.querySelector("video");
    if (video && !video.paused) {
      this.suppressNextVideoPauseReport = true;
      video.pause();
    }
    if (this.youtubePlayer?.pauseVideo) {
      this.suppressNextYouTubePauseReport = true;
      this.youtubePlayer.pauseVideo();
    }
    if (retireBlock) {
      this.youtubePlayer?.destroy?.();
      this.youtubePlayer = undefined;
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
    this.disableControlsForPendingExternalOutcome();
    if (announce) {
      this.setStatus("Remote action accepted. The participant surface is safely fenced while its evidence record commits.");
    }
  }

  runEvidenceWrite(operation) {
    return this.evidenceWriteWatchdog.run(operation);
  }

  disableOrdinaryStopForEvidenceFence() {
    const stop = this.dialog.querySelector("#participant-stop");
    if (!stop) return;
    if (!this.pendingExternalControls) this.pendingExternalControls = new Map();
    if (!this.pendingExternalControls.has(stop)) {
      this.pendingExternalControls.set(stop, stop.disabled);
    }
    stop.disabled = true;
  }

  handleEvidenceWriteDeadline({ deadlineMs }) {
    if (this.closed) return;
    this.remoteMediaReportsSuppressed = true;
    const video = this.dialog.querySelector("video");
    applyEvidenceWriteSafetyFence({
      pauseLocalVideo: () => {
        if (video && !video.paused) {
          this.suppressNextVideoPauseReport = true;
          video.pause();
        }
      },
      pauseEmbeddedVideo: () => {
        if (this.youtubePlayer?.pauseVideo) {
          this.suppressNextYouTubePauseReport = true;
          this.youtubePlayer.pauseVideo();
        }
      },
      stopSampling: () => this.stopSampling(),
      stopTimeline: () => {
        clearInterval(this.mediaTimer);
        this.mediaTimer = undefined;
      },
      disableControls: () => {
        this.disableControlsForPendingExternalOutcome();
        this.disableOrdinaryStopForEvidenceFence();
      },
    });
    const resume = this.dialog.querySelector("#participant-resume-evidence");
    if (resume) {
      resume.hidden = false;
      resume.disabled = true;
    }
    void this.revokeRemoteForMirrorFailure().catch(() => {});
    this.setStatus(
      `A research evidence write has not settled within ${deadlineMs} ms. Playback, sampling, and controls are fenced; the write is still active and was not cancelled.`,
      true,
    );
  }

  handleEvidenceWriteQuiescent({ rejected }) {
    if (this.closed || !this.evidenceWriteWatchdog.snapshot().latched || rejected) return;
    if (this.session?.pendingJournalCommand?.()) return;
    const resume = this.dialog.querySelector("#participant-resume-evidence");
    if (resume) {
      resume.hidden = false;
      resume.disabled = false;
    }
    this.setStatus(
      "The delayed evidence write has settled. Media remains paused and controls remain fenced; choose Resume after evidence delay explicitly.",
      true,
    );
  }

  resumeAfterEvidenceDelay() {
    const button = this.dialog.querySelector("#participant-resume-evidence");
    const acknowledged = this.evidenceWriteWatchdog.acknowledge()
      || this.unacceptedEvidenceFailure;
    if (!acknowledged) {
      this.setStatus("The delayed evidence write is not yet safely settled.", true);
      return;
    }
    this.unacceptedEvidenceFailure = false;
    this.restorePendingExternalControls();
    this.remoteMediaReportsSuppressed = false;
    if (button) button.hidden = true;
    this.setStatus("Evidence writing recovered. Playback remains physically paused; press Play when ready.");
  }

  handleEvidencePersistenceFailure(error) {
    this.applyExternalSafetyFence(
      { kind: "pause-media", revision: this.session?.state?.().revision ?? -1 },
      false,
    );
    void this.revokeRemoteForMirrorFailure().catch(() => {
      // Local evidence controls remain fenced even if transport teardown also
      // reports an error; the desktop retains its separate local revoke path.
    });
    const retry = this.dialog.querySelector("#participant-retry-evidence");
    const endPartial = this.dialog.querySelector("#participant-end-partial");
    const pending = this.session?.pendingJournalCommand?.();
    const disposition = evidencePersistenceFailureDisposition(pending);
    if (retry) {
      retry.hidden = !disposition.allowExactRetry;
      retry.disabled = false;
    }
    if (endPartial) {
      endPartial.hidden = !disposition.allowPartialRetention;
      endPartial.disabled = false;
    }
    if (disposition.acceptedOutcomeStaged) {
      this.disableOrdinaryStopForEvidenceFence();
      if (["pause", "resume"].includes(pending.type)) {
        const pause = this.dialog.querySelector("#participant-pause");
        if (pause) pause.disabled = false;
      }
    } else if (disposition.restoreOrdinaryControls) {
      // The operation rejected before an accepted authority outcome was staged.
      // There is no exact outcome to replay or abandon, so restore explicit
      // researcher control while keeping physical media paused.
      this.evidenceWriteWatchdog.clearAfterCommittedRetry();
      this.unacceptedEvidenceFailure = true;
      this.restorePendingExternalControls();
      const resume = this.dialog.querySelector("#participant-resume-evidence");
      if (resume) {
        resume.hidden = false;
        resume.disabled = false;
      }
    }
    const retryGuidance = disposition.allowExactRetry
      ? " Use Retry evidence write to commit the exact accepted record. If persistence cannot recover, use End and retain partial evidence; ordinary Stop cannot safely finalize this browser record."
      : disposition.acceptedOutcomeStaged
        ? ` The accepted ${pending.type} outcome remains staged. Retry it with its labelled local control where available, or use End and retain partial evidence; ordinary Stop cannot safely finalize this browser record.`
        : " No authority outcome was staged, so there is no record to replay or abandon. Media remains paused; choose Resume after evidence delay to retry normal operation, or use ordinary Stop.";
    this.setStatus(
      `Playback and sampling were fenced because a study evidence write failed: ${error?.message ?? String(error)}.${retryGuidance}`,
      true,
    );
  }

  presentPendingEvidenceFailure(error) {
    if (!this.session?.pendingJournalCommand?.()) return false;
    this.handleEvidencePersistenceFailure(error);
    return true;
  }

  async retryMediaEvidenceWrite() {
    const button = this.dialog.querySelector("#participant-retry-evidence");
    if (button) button.disabled = true;
    try {
      const command = this.session.pendingJournalCommand?.();
      if (!["reportMediaTimeline", "recordAffectSample"].includes(command?.type)) {
        throw new Error("No accepted media or sample record is awaiting retry.");
      }
      await this.session.retryPendingJournalOutcome();
      this.evidenceWriteWatchdog.clearAfterCommittedRetry();
      this.restorePendingExternalControls();
      this.remoteMediaReportsSuppressed = false;
      if (button) button.hidden = true;
      const endPartial = this.dialog.querySelector("#participant-end-partial");
      const resume = this.dialog.querySelector("#participant-resume-evidence");
      if (endPartial) endPartial.hidden = true;
      if (resume) resume.hidden = true;
      this.setStatus("The exact accepted evidence record is committed. Playback remains physically paused; press Play when ready.");
    } catch (error) {
      if (button) button.disabled = false;
      this.handleEvidencePersistenceFailure(error);
    }
  }

  async endAndRetainPartialEvidence() {
    const pending = this.session?.pendingJournalCommand?.();
    if (!pending) {
      this.setStatus("No accepted study action is staged for partial retention.", true);
      return;
    }
    if (!confirm(
      `End this run without committing the staged ${pending.type} outcome? Previously committed evidence will remain recoverable, but this accepted outcome marks a data-loss boundary.`,
    )) return;

    this.applyExternalSafetyFence(
      { kind: "pause-media", revision: this.session.state().revision },
      false,
    );
    const button = this.dialog.querySelector("#participant-end-partial");
    if (button) button.disabled = true;
    this.setStatus("Revoking remote control and retaining the browser journal as partial evidence…", true);
    try {
      await this.stopRemoteControl("evidence_write_unrecoverable");
      const retained = await this.session.abandonPendingJournalOutcome({
        reasonCode: "browser-evidence-write-unrecoverable",
      });
      this.renderRetainedPartialEvidence(retained);
    } catch (error) {
      if (button) button.disabled = false;
      this.setStatus(error?.message ?? String(error), true);
    }
  }

  renderRetainedPartialEvidence(retained) {
    if (this.resultRendered) return;
    this.resultRendered = true;
    this.externalAcceptedUnsubscribe?.();
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe?.();
    this.externalOutcomeUnsubscribe = undefined;
    this.clearBlockAdapters();
    const nativeMessage = retained.nativeAuthorityTerminated
      ? "The native Rust authority was ended with a fresh terminal action and remains authoritative. Its browser mirror was not finalized."
      : "The browser authority was closed without replaying or fabricating the missing outcome.";
    const teardownWarning = retained.teardownWarning
      ? `<p class="study-status" data-error="true">The run lock was released, but a storage adapter reported this close warning: ${escapeHtml(retained.teardownWarning)}</p>`
      : "";
    this.dialog.innerHTML = `<section class="study-result"><h2>Run retained as partial evidence</h2><p>${nativeMessage} Previously committed events remain available from Stored run evidence after this dialog closes.</p>${teardownWarning}<dl><dt>Run</dt><dd>${escapeHtml(retained.runId)}</dd><dt>Evidence status</dt><dd>Partial</dd><dt>Data-loss boundary</dt><dd>${escapeHtml(retained.stagedAction.commandType)} · ${escapeHtml(retained.stagedAction.actionId)}</dd><dt>Reason</dt><dd>${escapeHtml(retained.dataLossReason)}</dd></dl><div class="study-inline-actions"><button type="button" id="result-close">Close and show stored evidence</button></div></section>`;
    this.dialog.querySelector("#result-close").addEventListener("click", () => this.close());
  }

  disableControlsForPendingExternalOutcome() {
    if (!this.pendingExternalControls) this.pendingExternalControls = new Map();
    const controls = [
      ...[
      "#participant-next",
      "#participant-pause",
      "#participant-local-start",
      "#participant-prepared-abort",
      "#participant-finalize",
      ].map((selector) => this.dialog.querySelector(selector)),
      ...this.dialog.querySelectorAll(
        "#participant-content input, #participant-content select, #participant-content textarea, #participant-content button",
      ),
    ];
    for (const control of controls) {
      if (!control) continue;
      if (!this.pendingExternalControls.has(control)) {
        this.pendingExternalControls.set(control, control.disabled);
      }
      control.disabled = true;
    }
  }

  restorePendingExternalControls() {
    for (const [control, disabled] of this.pendingExternalControls ?? []) {
      if (control.isConnected) control.disabled = disabled;
    }
    this.pendingExternalControls = undefined;
  }

  async handleExternalMirrorFailure(detail) {
    this.remoteMediaReportsSuppressed = true;
    this.adapterEpoch += 1;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
    this.comparison = undefined;
    this.stopSampling();
    clearInterval(this.mediaTimer);
    this.mediaTimer = undefined;
    const video = this.dialog.querySelector("video");
    if (video && !video.paused) {
      this.suppressNextVideoPauseReport = true;
      video.pause();
    }
    if (this.youtubePlayer?.pauseVideo) {
      this.suppressNextYouTubePauseReport = true;
      this.youtubePlayer.pauseVideo();
    }
    for (const selector of ["#participant-next", "#participant-pause", "#participant-local-start"]) {
      const control = this.dialog.querySelector(selector);
      if (control) control.disabled = true;
    }
    await this.revokeRemoteForMirrorFailure();
    const state = detail?.outcome?.state;
    if (["completed", "aborted"].includes(state?.phase)) {
      await this.renderNativeOnlyResult(state);
      return;
    }
    this.setStatus(
      "The native action was applied, but the browser mirror journal could not commit it. Media and sampling are paused. Use the local Stop/Abort/Finalize control; the native Rust record remains authoritative.",
      true,
    );
  }

  async renderPrepared() {
    this.clearBlockAdapters();
    const state = this.session.state();
    this.dialog.innerHTML = `<section class="study-participant-preflight">
      <h2>Run prepared</h2>
      <p>The protocol, settings, and local record are ready. Pair a controller now, or arm and start from this desktop.</p>
      <dl><dt>Run</dt><dd>${escapeHtml(state.runId)}</dd><dt>Phase</dt><dd id="participant-prepared-phase">${escapeHtml(state.phase)}</dd></dl>
      <div id="participant-prepared-remote"></div>
      <div class="study-inline-actions"><button type="button" id="participant-local-start" data-variant="primary">Arm and start locally</button><button type="button" id="participant-prepared-abort" data-variant="danger">Abort prepared run</button><button type="button" id="participant-end-partial" data-variant="danger" hidden>End and retain partial evidence</button></div>
      <p id="participant-status" class="study-status" aria-live="polite"></p>
    </section>`;
    const remoteHost = this.dialog.querySelector("#participant-prepared-remote");
    if (this.remoteControlUi?.mount) this.remoteControlUi.mount(remoteHost);
    else remoteHost.innerHTML = "<p>Remote Control is unavailable. Use the local start control.</p>";
    this.dialog.querySelector("#participant-local-start").addEventListener("click", () => this.armAndStartLocally());
    this.dialog.querySelector("#participant-prepared-abort").addEventListener("click", () => this.abortPreparedRun());
    this.dialog.querySelector("#participant-end-partial").addEventListener("click", () => this.endAndRetainPartialEvidence());
    this.syncPreparedState();
  }

  syncPreparedState() {
    const state = this.session?.state?.();
    if (!state) return;
    const phase = this.dialog.querySelector("#participant-prepared-phase");
    if (phase) phase.textContent = state.phase;
    const start = this.dialog.querySelector("#participant-local-start");
    if (start) {
      start.disabled = !["prepared", "armed"].includes(state.phase);
      start.textContent = state.phase === "armed" ? "Start locally" : "Arm and start locally";
    }
  }

  async armAndStartLocally() {
    const button = this.dialog.querySelector("#participant-local-start");
    if (button) button.disabled = true;
    try {
      if (this.session.state().phase === "prepared") await this.session.dispatch({ type: "arm" });
      if (this.session.state().phase === "armed") await this.session.dispatch({ type: "start" });
      if (this.session.state().phase === "running") await this.renderCurrentBlock();
      else this.syncPreparedState();
    } catch (error) {
      this.syncPreparedState();
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async abortPreparedRun() {
    if (!confirm("Abort this prepared run and finalize its local record?")) return;
    const button = this.dialog.querySelector("#participant-prepared-abort");
    if (button) button.disabled = true;
    try {
      const result = await this.session.abort("researcher-abort-before-start");
      await this.stopRemoteControl("run_aborted");
      this.renderResult(result, "Run aborted");
    } catch (error) {
      if (this.externalMirrorFailed) {
        try {
          const outcome = await this.session.stopNativeAfterMirrorFailure("local-abort-after-mirror-failure");
          await this.renderNativeOnlyResult(outcome.state);
          return;
        } catch (nativeError) {
          error = nativeError;
        }
      }
      if (button) button.disabled = false;
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async applyExternalTransition(transition, detail = {}) {
    if (!this.session || this.resultRendered) return;
    if (transition.kind === "terminal") {
      await this.finalizeExternalTerminal(detail.result);
      return;
    }
    if (transition.kind === "prepared") {
      this.syncPreparedState();
      this.setStatus("The remote researcher armed this run.");
      return;
    }
    if (transition.kind === "pause-media") {
      this.pauseForExternalControl();
      return;
    }
    if (transition.kind === "resume-media") {
      await this.resumeForExternalControl();
      return;
    }
    if (transition.kind === "await-finalization"
      || this.session.state().phase === "awaitingFinalization") {
      this.renderFinalizeScreen("The protocol reached its finalization point. Review the status, then finalize the local result.");
      return;
    }
    if (transition.kind === "render-block") await this.renderCurrentBlock();
  }

  pauseForExternalControl() {
    this.fencePausedMediaAdapters("Paused by the remote researcher.");
  }

  fencePausedMediaAdapters(message, error = false) {
    this.remoteMediaReportsSuppressed = true;
    this.stopSampling();
    clearInterval(this.mediaTimer);
    this.mediaTimer = undefined;
    const video = this.dialog.querySelector("video");
    if (video && !video.paused) {
      this.suppressNextVideoPauseReport = true;
      video.pause();
    }
    if (this.youtubePlayer?.pauseVideo) {
      this.suppressNextYouTubePauseReport = true;
      this.youtubePlayer.pauseVideo();
    }
    const button = this.dialog.querySelector("#participant-pause");
    if (button) button.textContent = "Resume";
    const phase = this.dialog.querySelector("#participant-phase");
    if (phase) phase.textContent = this.session.state().phase;
    this.setStatus(message, error);
  }

  async resumeForExternalControl() {
    this.remoteMediaReportsSuppressed = false;
    const button = this.dialog.querySelector("#participant-pause");
    if (button) button.textContent = "Pause";
    const phase = this.dialog.querySelector("#participant-phase");
    if (phase) phase.textContent = this.session.state().phase;
    const video = this.dialog.querySelector("video");
    const resumed = await requestRemoteMediaResume({ video, youtubePlayer: this.youtubePlayer });
    this.setStatus(resumed.message, resumed.started === false);
  }

  renderFinalizeScreen(message = "The run is ready to finalize.") {
    this.clearBlockAdapters();
    const state = this.session.state();
    this.dialog.innerHTML = `<section class="study-result">
      <h2>Finalize run</h2>
      <p>${escapeHtml(message)}</p>
      <dl><dt>Run</dt><dd>${escapeHtml(state.runId)}</dd><dt>Phase</dt><dd>${escapeHtml(state.phase)}</dd></dl>
      <div class="study-inline-actions"><button type="button" id="participant-finalize" data-variant="primary">Finalize result locally</button><button type="button" id="participant-end-partial" data-variant="danger" hidden>End and retain partial evidence</button></div>
      <p id="participant-status" class="study-status" aria-live="polite"></p>
    </section>`;
    this.dialog.querySelector("#participant-finalize").addEventListener("click", () => this.finish());
    this.dialog.querySelector("#participant-end-partial").addEventListener("click", () => this.endAndRetainPartialEvidence());
  }

  async finalizeExternalTerminal(committedResult) {
    if (this.terminalFinalization) return this.terminalFinalization;
    this.clearBlockAdapters();
    this.setStatus("Finalizing the browser mirror of the native result.");
    const pending = (async () => {
      const state = this.session.state();
      const result = committedResult ?? await this.session.finalizeJournal();
      await this.stopRemoteControl("run_terminal");
      const heading = state.phase === "aborted"
        ? "Run aborted"
        : state.completionStatus === "stoppedEarly" ? "Run stopped early" : "Run complete";
      this.renderResult(result, heading);
      return result;
    })();
    this.terminalFinalization = pending;
    try {
      return await pending;
    } catch (error) {
      this.terminalFinalization = undefined;
      this.renderFinalizeScreen("The native run ended, but the local mirror could not be finalized. Retry finalization without starting another run.");
      throw error;
    }
  }

  async stopRemoteControl(reason) {
    try {
      await revokeRemoteControl(this.remoteControlUi, reason);
    } catch {
      // Result finalization and local teardown remain authoritative.
    }
  }

  async revokeRemoteControlLocally() {
    const button = this.dialog.querySelector("#participant-revoke-remote");
    if (button) button.disabled = true;
    try {
      await revokeRemoteControl(this.remoteControlUi, "local_revoke");
      this.setStatus("Remote Control was revoked. The experiment continues under local desktop control.");
    } catch (error) {
      if (button) button.disabled = false;
      this.setStatus(error?.message ?? String(error), true);
    }
  }

  shell() {
    const state = this.session.state();
    const revokeControl = this.surface === "desktop" && this.remoteControlUi
      ? '<button type="button" id="participant-revoke-remote">Revoke Remote Control</button>'
      : "";
    this.dialog.innerHTML = `<div class="study-participant-shell">
      <header><div><strong>${escapeHtml(this.study.title)}</strong><span id="participant-location">${escapeHtml(state.currentSectionId ?? "")}</span></div><div class="study-inline-actions"><span class="study-badge" id="participant-phase">${escapeHtml(state.phase)}</span>${revokeControl}<button type="button" id="participant-stop" data-variant="danger">Stop run</button></div></header>
      <main id="participant-content" tabindex="-1"></main>
      <footer><p id="participant-status" class="study-status" aria-live="polite"></p><div class="study-inline-actions"><button type="button" id="participant-retry-evidence" hidden>Retry evidence write</button><button type="button" id="participant-resume-evidence" hidden>Resume after evidence delay</button><button type="button" id="participant-end-partial" data-variant="danger" hidden>End and retain partial evidence</button><button type="button" id="participant-pause">Pause</button><button type="button" id="participant-next" data-variant="primary">Continue</button></div></footer>
    </div>`;
    this.dialog.querySelector("#participant-stop").addEventListener("click", () => this.stop());
    this.dialog.querySelector("#participant-revoke-remote")?.addEventListener("click", () => this.revokeRemoteControlLocally());
    this.dialog.querySelector("#participant-retry-evidence").addEventListener("click", () => this.retryMediaEvidenceWrite());
    this.dialog.querySelector("#participant-resume-evidence").addEventListener("click", () => this.resumeAfterEvidenceDelay());
    this.dialog.querySelector("#participant-end-partial").addEventListener("click", () => this.endAndRetainPartialEvidence());
    this.dialog.querySelector("#participant-pause").addEventListener("click", () => this.togglePause());
    this.dialog.querySelector("#participant-next").addEventListener("click", () => this.next());
  }

  clearBlockAdapters() {
    this.adapterEpoch += 1;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    clearInterval(this.mediaTimer);
    clearInterval(this.sampleTimer);
    this.animationFrame = undefined;
    this.mediaTimer = undefined;
    this.sampleTimer = undefined;
    this.comparison = undefined;
    if (this.youtubePlayer?.destroy) this.youtubePlayer.destroy();
    this.youtubePlayer = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    this.remoteMediaReportsSuppressed = false;
    this.suppressNextVideoPauseReport = false;
    this.suppressNextYouTubePauseReport = false;
  }

  setStatus(message, error = false) {
    const output = this.dialog.querySelector("#participant-status");
    if (output) {
      output.textContent = message;
      output.dataset.error = String(error);
    }
  }

  renderAffectControls(container, onInput = () => {}) {
    const controls = document.createElement("div");
    controls.className = "study-affect-controls";
    controls.innerHTML = `<label class="study-field"><span>Valence</span><input data-affect="x" type="range" min="-1" max="1" step="0.01" value="${this.affect.x}"><output>${this.affect.x.toFixed(2)}</output></label><label class="study-field"><span>Arousal</span><input data-affect="y" type="range" min="-1" max="1" step="0.01" value="${this.affect.y}"><output>${this.affect.y.toFixed(2)}</output></label>`;
    controls.addEventListener("input", (event) => {
      const axis = event.target.dataset.affect;
      if (!axis) return;
      this.affect[axis] = Number(event.target.value);
      event.target.nextElementSibling.value = this.affect[axis].toFixed(2);
      onInput();
    });
    container.append(controls);
    return controls;
  }

  async renderCurrentBlock() {
    this.clearBlockAdapters();
    this.shell();
    const state = this.session.state();
    const block = findStudyBlock(this.study, state.currentBlockId);
    const content = this.dialog.querySelector("#participant-content");
    const next = this.dialog.querySelector("#participant-next");
    const pause = this.dialog.querySelector("#participant-pause");
    if (!block) {
      if (state.phase === "awaitingFinalization") return this.finish();
      throw new Error("The authority did not identify a current block.");
    }
    this.dialog.querySelector("#participant-location").textContent = `${state.currentSectionId} · ${state.currentTrialId} · ${block.blockId}`;
    const pausePresentation = participantPausePresentation(state.phase);
    this.remoteMediaReportsSuppressed = pausePresentation.reportsSuppressed;
    next.disabled = false;
    pause.hidden = block.type !== "video";
    pause.textContent = pausePresentation.buttonLabel;
    if (block.type === "instruction") this.renderInstruction(content, block);
    else if (block.type === "questionnaire") this.renderQuestionnaire(content, block, next);
    else if (block.type === "video") await this.renderVideo(content, block, next);
    else if (block.type === "break") this.renderBreak(content, block, next);
    else this.renderCompletion(content, block, next);
    content.focus();
  }

  renderInstruction(content, block) {
    content.innerHTML = `<article class="study-participant-panel"><p class="study-block-label">Instruction</p><h2>${escapeHtml(block.content)}</h2>${block.presentation === "faceFlubberComparison" ? '<div id="participant-comparison"></div><p class="study-help">Both abstract displays use exactly the same current valence, arousal, and animation phase. They do not recognize or diagnose emotion.</p>' : ""}</article>`;
    if (block.presentation !== "faceFlubberComparison") return;
    const host = content.querySelector("#participant-comparison");
    this.comparison = createInstructionAffectComparison(host, { seed: `${this.study.studyId}-${block.blockId}` });
    this.renderAffectControls(host);
    const adapterEpoch = this.adapterEpoch;
    const began = performance.now();
    let sequence = 0;
    const animate = (now) => {
      if (adapterEpoch !== this.adapterEpoch) return;
      const phase = ((now - began) / 1000) * Math.PI * 2;
      this.comparison.render({
        currentX: this.affect.x,
        currentY: this.affect.y,
        phase,
        sequence: sequence++,
        palette: this.study.pinnedSettings.visual.palette,
        baseShape: this.study.pinnedSettings.visual.baseShape,
        amplitudeScale: this.study.pinnedSettings.visual.pulseAmplitudeMultiplier,
        disorderScale: this.study.pinnedSettings.visual.disorderMultiplier,
        overlayOpacity: this.study.pinnedSettings.visual.opacity,
      });
      this.animationFrame = requestAnimationFrame(animate);
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  renderQuestionnaire(content, block, next) {
    const questionnaire = questionnaireForBlock(this.study, block);
    if (!questionnaire) throw new Error(`Questionnaire ${block.questionnaireId} is unavailable.`);
    content.innerHTML = `<form id="participant-questionnaire" class="study-questionnaire"><p class="study-block-label">Questionnaire</p><h2>${escapeHtml(questionnaire.title)}</h2>${questionnaire.description ? `<p>${escapeHtml(questionnaire.description)}</p>` : ""}${questionnaire.items.map(answerMarkup).join("")}<button type="submit" data-variant="primary">Commit answers</button></form>`;
    next.disabled = true;
    const form = content.querySelector("#participant-questionnaire");
    for (const toggle of form.querySelectorAll("[data-answer-enable]")) toggle.addEventListener("change", () => {
      const fieldset = toggle.closest("fieldset");
      for (const range of fieldset.querySelectorAll('input[type="range"]')) {
        range.disabled = !toggle.checked;
        const output = range.closest("label, fieldset")?.querySelector("output");
        if (output) output.value = toggle.checked ? Number(range.value).toFixed(2) : "No response";
      }
    });
    for (const range of form.querySelectorAll('input[type="range"]')) range.addEventListener("input", () => {
      const output = range.closest("label, fieldset")?.querySelector("output");
      if (output) output.value = Number(range.value).toFixed(2);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        for (const fieldset of form.querySelectorAll('[data-question-type="multipleChoice"]')) {
          const selected = fieldset.querySelectorAll('input[type="checkbox"]:checked').length;
          const item = questionnaire.items.find(({ itemId }) => itemId === fieldset.dataset.questionItem);
          const message = multipleChoiceSelectionError(item, selected);
          if (message) throw new Error(message);
        }
        await this.session.submitQuestionnaire(questionnaire.questionnaireId, collectAnswers(form, questionnaire));
        form.querySelectorAll("input, button").forEach((element) => { element.disabled = true; });
        next.disabled = false;
        next.focus();
        this.setStatus("Answers committed to the local journal.");
      } catch (error) {
        if (!this.presentPendingEvidenceFailure(error)) {
          this.setStatus(error?.message ?? String(error), true);
        }
      }
    });
  }

  async renderVideo(content, block, next) {
    content.innerHTML = `<section class="study-video-block"><p class="study-block-label">${escapeHtml(block.purpose)} video</p><h2>Media block</h2><div id="participant-media"></div><div id="participant-affect-controls"></div><p class="study-help">Affect samples are recorded only while verified playback is active.</p></section>`;
    next.disabled = true;
    const mediaHost = content.querySelector("#participant-media");
    if (block.collectAffect) this.renderAffectControls(content.querySelector("#participant-affect-controls"));
    if (block.source.kind === "youtube") await this.renderYouTube(mediaHost, block, next);
    else await this.renderLocalVideo(mediaHost, block, next);
  }

  startSampling() {
    if (this.sampleTimer) return;
    const adapterEpoch = this.adapterEpoch;
    const period = 1000 / this.study.pinnedSettings.acquisition.sampleRateHz;
    this.sampleTimer = setInterval(() => {
      if (!mediaAdaptersAllowed({
        adapterEpoch,
        currentAdapterEpoch: this.adapterEpoch,
        phase: this.session.state().phase,
        reportsSuppressed: this.remoteMediaReportsSuppressed,
      })) {
        this.stopSampling();
        return;
      }
      scheduleSingleFlight(
        this.sampleFlight,
        () => this.runEvidenceWrite(() => this.session.recordAffect({
          currentValence: this.affect.x,
          currentArousal: this.affect.y,
        })),
        (error) => this.handleEvidencePersistenceFailure(error),
      );
    }, period);
  }

  stopSampling() {
    clearInterval(this.sampleTimer);
    this.sampleTimer = undefined;
  }

  async renderLocalVideo(mediaHost, block, next) {
    const adapterEpoch = this.adapterEpoch;
    const asset = this.study.media.find(({ assetId }) => assetId === block.source.assetId);
    const file = this.assetBindings.get(block.source.assetId);
    if (!asset || !file) throw new Error(`Select and verify asset ${block.source.assetId} before this run.`);
    this.objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = this.objectUrl;
    mediaHost.append(video);
    const clip = block.source.clip ?? asset.defaultClip ?? { startMs: 0, endMs: asset.durationMs };
    const position = () => Math.max(0, video.currentTime * 1000 - clip.startMs);
    video.addEventListener("loadedmetadata", () => {
      if (adapterEpoch === this.adapterEpoch) video.currentTime = clip.startMs / 1000;
    }, { once: true });
    video.addEventListener("play", async () => {
      if (adapterEpoch !== this.adapterEpoch) return;
      const fenced = fenceDisallowedMediaPlayback({
        phase: this.session.state().phase,
        reportsSuppressed: this.remoteMediaReportsSuppressed,
        pause: () => {
          this.suppressNextVideoPauseReport = true;
          video.pause();
        },
      });
      if (fenced) {
        this.stopSampling();
        clearInterval(this.mediaTimer);
        this.mediaTimer = undefined;
        this.setStatus("Playback remains paused until the study authority resumes the run.", true);
        return;
      }
      const confirmed = await confirmMediaPlaybackAfterReport({
        report: () => this.runEvidenceWrite(
          () => this.session.reportMedia(position(), true, video.playbackRate),
        ),
        isAllowed: () => adapterEpoch === this.adapterEpoch
          && this.session.state().phase === "running"
          && !this.remoteMediaReportsSuppressed
          && !video.paused,
        fence: (error) => {
          this.suppressNextVideoPauseReport = true;
          video.pause();
          this.stopSampling();
          clearInterval(this.mediaTimer);
          this.mediaTimer = undefined;
          if (error) this.handleEvidencePersistenceFailure(error);
          else if (!this.evidenceWriteWatchdog.snapshot().latched) {
            this.setStatus("Playback remains paused until the study authority resumes the run.", true);
          }
        },
      });
      if (!confirmed) return;
      if (block.collectAffect) this.startSampling();
      this.mediaTimer = setInterval(() => {
        if (!mediaAdaptersAllowed({
          adapterEpoch,
          currentAdapterEpoch: this.adapterEpoch,
          phase: this.session.state().phase,
          reportsSuppressed: this.remoteMediaReportsSuppressed,
        })) {
          this.suppressNextVideoPauseReport = true;
          video.pause();
          this.stopSampling();
          clearInterval(this.mediaTimer);
          this.mediaTimer = undefined;
          return;
        }
        if (video.currentTime * 1000 >= clip.endMs) {
          video.pause();
          next.disabled = false;
          this.setStatus("Media segment complete.");
        } else {
          scheduleSingleFlight(
            this.mediaReportFlight,
            () => this.runEvidenceWrite(
              () => this.session.reportMedia(position(), true, video.playbackRate),
            ),
            (error) => this.handleEvidencePersistenceFailure(error),
          );
        }
      }, 1000);
    });
    video.addEventListener("pause", () => {
      if (adapterEpoch !== this.adapterEpoch) return;
      clearInterval(this.mediaTimer);
      this.mediaTimer = undefined;
      this.stopSampling();
      const suppressReport = this.remoteMediaReportsSuppressed || this.suppressNextVideoPauseReport;
      this.suppressNextVideoPauseReport = false;
      if (!suppressReport) {
        void this.runEvidenceWrite(
          () => this.session.reportMedia(position(), false, video.playbackRate),
        )
          .catch((error) => this.handleEvidencePersistenceFailure(error));
      }
    });
    video.addEventListener("ended", () => {
      if (adapterEpoch !== this.adapterEpoch) return;
      next.disabled = false;
      this.setStatus("Media complete.");
    });
  }

  async renderYouTube(mediaHost, block, next) {
    const adapterEpoch = this.adapterEpoch;
    const YT = await loadYouTubeApi();
    if (adapterEpoch !== this.adapterEpoch) return;
    const mount = document.createElement("div");
    mount.id = `study-youtube-${Date.now()}`;
    mediaHost.append(mount);
    const startSeconds = block.source.startMs / 1000;
    const endSeconds = block.source.endMs / 1000;
    this.youtubePlayer = new YT.Player(mount, {
      videoId: block.source.videoId,
      playerVars: { start: startSeconds, end: endSeconds, playsinline: 1, rel: 0 },
      events: {
        onStateChange: async (event) => {
          if (adapterEpoch !== this.adapterEpoch) return;
          const relativeMs = Math.max(0, (event.target.getCurrentTime() - startSeconds) * 1000);
          if (event.data === YT.PlayerState.PLAYING) {
            const fenced = fenceDisallowedMediaPlayback({
              phase: this.session.state().phase,
              reportsSuppressed: this.remoteMediaReportsSuppressed,
              pause: () => {
                this.suppressNextYouTubePauseReport = true;
                event.target.pauseVideo();
              },
            });
            if (fenced) {
              this.stopSampling();
              clearInterval(this.mediaTimer);
              this.mediaTimer = undefined;
              this.setStatus("Playback remains paused until the study authority resumes the run.", true);
              return;
            }
            const confirmed = await confirmMediaPlaybackAfterReport({
              report: () => this.runEvidenceWrite(
                () => this.session.reportMedia(
                  relativeMs,
                  true,
                  event.target.getPlaybackRate(),
                ),
              ),
              isAllowed: () => mediaAdaptersAllowed({
                adapterEpoch,
                currentAdapterEpoch: this.adapterEpoch,
                phase: this.session.state().phase,
                reportsSuppressed: this.remoteMediaReportsSuppressed,
              }) && event.target.getPlayerState() === YT.PlayerState.PLAYING,
              fence: (error) => {
                this.suppressNextYouTubePauseReport = true;
                event.target.pauseVideo();
                if (error) this.handleEvidencePersistenceFailure(error);
              },
            });
            if (!confirmed) return;
            if (block.collectAffect) this.startSampling();
            clearInterval(this.mediaTimer);
            this.mediaTimer = setInterval(() => {
              if (!mediaAdaptersAllowed({
                adapterEpoch,
                currentAdapterEpoch: this.adapterEpoch,
                phase: this.session.state().phase,
                reportsSuppressed: this.remoteMediaReportsSuppressed,
              })) {
                this.suppressNextYouTubePauseReport = true;
                event.target.pauseVideo();
                this.stopSampling();
                clearInterval(this.mediaTimer);
                this.mediaTimer = undefined;
                return;
              }
              scheduleSingleFlight(
                this.mediaReportFlight,
                () => this.runEvidenceWrite(
                  () => this.session.reportMedia(
                    Math.max(0, (event.target.getCurrentTime() - startSeconds) * 1000),
                    true,
                    event.target.getPlaybackRate(),
                  ),
                ),
                (error) => this.handleEvidencePersistenceFailure(error),
              );
            }, 1000);
          } else if ([YT.PlayerState.PAUSED, YT.PlayerState.BUFFERING, YT.PlayerState.ENDED].includes(event.data)) {
            this.stopSampling();
            clearInterval(this.mediaTimer);
            this.mediaTimer = undefined;
            const suppressReport = this.remoteMediaReportsSuppressed
              || (event.data === YT.PlayerState.PAUSED && this.suppressNextYouTubePauseReport);
            if (event.data === YT.PlayerState.PAUSED) this.suppressNextYouTubePauseReport = false;
            if (!suppressReport) {
              void this.runEvidenceWrite(
                () => this.session.reportMedia(relativeMs, false, event.target.getPlaybackRate()),
              )
                .catch((error) => this.handleEvidencePersistenceFailure(error));
            }
            if (event.data === YT.PlayerState.ENDED) {
              next.disabled = false;
              this.setStatus("Media complete.");
            }
          }
        },
        onError: (event) => this.setStatus(`YouTube playback failed with code ${event.data}.`, true),
      },
    });
  }

  renderBreak(content, block, next) {
    content.innerHTML = `<article class="study-participant-panel"><p class="study-block-label">Break</p><h2>${escapeHtml(block.content)}</h2></article>`;
    if (block.minimumDurationMs > 0) {
      next.disabled = true;
      this.setStatus(`Continue becomes available after ${Math.ceil(block.minimumDurationMs / 1000)} seconds.`);
      setTimeout(() => { if (next.isConnected) next.disabled = false; }, block.minimumDurationMs);
    }
  }

  renderCompletion(content, block, next) {
    content.innerHTML = `<article class="study-participant-panel"><p class="study-block-label">Completion</p><h2>${escapeHtml(block.content)}</h2></article>`;
    next.textContent = "Finish and save";
  }

  async next() {
    const button = this.dialog.querySelector("#participant-next");
    button.disabled = true;
    try {
      await this.session.advance();
      if (this.session.state().phase === "awaitingFinalization") await this.finish();
      else await this.renderCurrentBlock();
    } catch (error) {
      button.disabled = false;
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async togglePause() {
    const button = this.dialog.querySelector("#participant-pause");
    const pendingCommand = this.session.pendingJournalCommand?.();
    if (["pause", "resume"].includes(pendingCommand?.type)) {
      button.disabled = true;
      try {
        await this.session.retryPendingJournalOutcome();
        if (this.session.state().phase === "paused") {
          this.fencePausedMediaAdapters("The accepted pause is now committed to the browser journal. Press Resume when ready.");
        } else {
          await this.resumeForExternalControl();
        }
      } catch (error) {
        button.disabled = false;
        if (!this.presentPendingEvidenceFailure(error)) {
          this.setStatus(error?.message ?? String(error), true);
        }
        return;
      }
      button.disabled = false;
      return;
    }

    const state = this.session.state();
    try {
      if (state.phase === "running") {
        // Fence the physical stimulus synchronously with the local pause
        // intent. Native acceptance and browser-journal persistence happen
        // asynchronously and must never leave media exposure running between
        // those two boundaries.
        await dispatchPauseWithSafetyFence({
          fence: () => this.applyExternalSafetyFence(
            { kind: "pause-media", revision: state.revision },
            false,
          ),
          dispatch: () => this.session.dispatch({ type: "pause", reasonCode: "local-pause" }),
        });
        this.restorePendingExternalControls();
        this.fencePausedMediaAdapters("Paused locally.");
      } else if (state.phase === "paused") {
        await this.session.dispatch({ type: "resume" });
        await this.resumeForExternalControl();
      }
      this.dialog.querySelector("#participant-phase").textContent = this.session.state().phase;
    } catch (error) {
      const acceptedPhase = this.session.state().phase;
      const pending = this.session.pendingJournalCommand?.();
      if (acceptedPhase === "paused" && pending?.type === "pause") {
        this.restorePendingExternalControls();
        this.fencePausedMediaAdapters(
          "The native pause was applied, but its browser journal commit was interrupted. Playback remains fenced; use Retry pause record before resuming.",
          true,
        );
        button.textContent = "Retry pause record";
        this.handleEvidencePersistenceFailure(error);
        return;
      }
      this.restorePendingExternalControls();
      if (acceptedPhase === "running" && pending?.type === "resume") {
        this.remoteMediaReportsSuppressed = true;
        button.textContent = "Retry resume record";
      } else if (acceptedPhase === "running" && state.phase === "running") {
        this.remoteMediaReportsSuppressed = true;
        button.textContent = "Retry pause";
      }
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async stop() {
    if (this.session.pendingJournalCommand?.()) {
      this.handleEvidencePersistenceFailure(new Error(
        "An accepted evidence action is still uncommitted. Ordinary Stop cannot produce a complete browser result.",
      ));
      return;
    }
    if (!confirm("Stop this run early and finalize the partial result?")) return;
    this.clearBlockAdapters();
    try {
      const result = await this.session.stop();
      await this.stopRemoteControl("run_stopped");
      this.renderResult(result, "Run stopped early");
    } catch (error) {
      if (this.externalMirrorFailed) {
        try {
          const outcome = await this.session.stopNativeAfterMirrorFailure("local-stop-after-mirror-failure");
          await this.renderNativeOnlyResult(outcome.state);
          return;
        } catch (nativeError) {
          error = nativeError;
        }
      }
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async finish() {
    this.clearBlockAdapters();
    try {
      const result = await this.session.finalize();
      await this.stopRemoteControl("run_terminal");
      const heading = result.manifest.completionStatus === "stoppedEarly" ? "Run stopped early" : "Run complete";
      this.renderResult(result, heading);
    } catch (error) {
      if (this.externalMirrorFailed) {
        try {
          const outcome = await this.session.stopNativeAfterMirrorFailure("local-finalize-after-mirror-failure");
          await this.renderNativeOnlyResult(outcome.state);
          return;
        } catch (nativeError) {
          error = nativeError;
        }
      }
      if (!this.presentPendingEvidenceFailure(error)) {
        this.setStatus(error?.message ?? String(error), true);
      }
    }
  }

  async renderNativeOnlyResult(state = this.session.state()) {
    if (this.resultRendered) return;
    this.resultRendered = true;
    this.externalAcceptedUnsubscribe?.();
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe?.();
    this.externalOutcomeUnsubscribe = undefined;
    this.clearBlockAdapters();
    await this.stopRemoteControl("native_only_terminal");
    const heading = state.phase === "aborted"
      ? "Run aborted"
      : state.completionStatus === "stoppedEarly" ? "Run stopped early" : "Run ended";
    this.dialog.innerHTML = `<section class="study-result"><h2>${escapeHtml(heading)}</h2><p>The native Rust recorder is authoritative and has finalized its desktop files. The browser evidence mirror was interrupted, so a complete browser CSV and result manifest are unavailable; its partial journal may remain available from Stored run evidence after this dialog closes.</p><dl><dt>Run</dt><dd>${escapeHtml(state.runId)}</dd><dt>Native phase</dt><dd>${escapeHtml(state.phase)}</dd></dl><div class="study-inline-actions"><button type="button" id="result-close">Close</button></div></section>`;
    this.dialog.querySelector("#result-close").addEventListener("click", () => this.close());
  }

  renderResult(result, heading) {
    if (this.resultRendered) return;
    this.resultRendered = true;
    this.externalAcceptedUnsubscribe?.();
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe?.();
    this.externalOutcomeUnsubscribe = undefined;
    const evidenceMessage = this.surface === "desktop"
      ? "The native Rust record is authoritative. This synchronized browser mirror is finalized; download both mirror files and retain them together."
      : "The authoritative browser event journal is finalized. Download both files and retain them together.";
    this.dialog.innerHTML = `<section class="study-result"><h2>${escapeHtml(heading)}</h2><p>${evidenceMessage}</p><dl><dt>Run</dt><dd>${escapeHtml(result.manifest.runId)}</dd><dt>Events</dt><dd>${result.manifest.eventCount}</dd><dt>CSV SHA-256</dt><dd><code>${result.manifest.csvSha256}</code></dd></dl><div class="study-inline-actions"><button type="button" id="result-csv" data-variant="primary">Download CSV</button><button type="button" id="result-manifest">Download manifest</button><button type="button" id="result-close">Close</button></div></section>`;
    this.dialog.querySelector("#result-csv").addEventListener("click", () => download(`${result.manifest.runId}.csv`, result.csv, "text/csv;charset=utf-8"));
    this.dialog.querySelector("#result-manifest").addEventListener("click", () => download(`${result.manifest.runId}.manifest.json`, `${JSON.stringify(result.manifest, null, 2)}\n`, "application/json;charset=utf-8"));
    this.dialog.querySelector("#result-close").addEventListener("click", () => this.close());
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.externalAcceptedUnsubscribe?.();
    this.externalAcceptedUnsubscribe = undefined;
    this.externalOutcomeUnsubscribe?.();
    this.externalOutcomeUnsubscribe = undefined;
    document.removeEventListener("visibilitychange", this.visibilityListener);
    this.clearBlockAdapters();
    await this.stopRemoteControl("participant_close");
    await this.session?.close?.();
    if (this.dialog.open) this.dialog.close();
    this.dialog.remove();
    await this.onClose?.();
  }
}

export async function launchParticipantRun(options) {
  const view = new ParticipantRunView(options);
  await view.open();
  return view;
}
