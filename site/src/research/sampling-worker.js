const MIN_FREQUENCY_HZ = 1;
const MAX_FREQUENCY_HZ = 240;

function assertFrequency(value) {
  if (!Number.isInteger(value) || value < MIN_FREQUENCY_HZ || value > MAX_FREQUENCY_HZ) {
    throw new RangeError(`samplingFrequencyHz must be an integer from ${MIN_FREQUENCY_HZ} through ${MAX_FREQUENCY_HZ}.`);
  }
  return value;
}

function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

function assertCoordinate(value, label) {
  const finite = assertFinite(value, label);
  if (finite < -1 || finite > 1) throw new RangeError(`${label} must be between -1 and 1.`);
  return finite;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function assertSessionToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new TypeError("sessionToken must contain 1–256 characters.");
  }
  return value;
}

function cloneState(state, observedMonotonicMs) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Authoritative state must be an object.");
  }
  const currentValence = assertCoordinate(state.currentValence, "currentValence");
  const currentArousal = assertCoordinate(state.currentArousal, "currentArousal");
  const targetValence = assertCoordinate(state.targetValence, "targetValence");
  const targetArousal = assertCoordinate(state.targetArousal, "targetArousal");
  const anchorMonotonicMs = state.anchorMonotonicMs === undefined
    ? observedMonotonicMs
    : assertFinite(state.anchorMonotonicMs, "anchorMonotonicMs");
  const angleDegrees = currentValence === 0 && currentArousal === 0
    ? 0
    : (Math.atan2(currentArousal, currentValence) * 180 / Math.PI + 360) % 360;
  return Object.freeze({
    currentValence,
    currentArousal,
    targetValence,
    targetArousal,
    radius: Math.min(1, Math.hypot(currentValence, currentArousal)),
    angleDegrees,
    animationActive: Boolean(state.animationActive),
    inputActive: Boolean(state.inputActive),
    stimulusTimeMs: state.stimulusTimeMs === null || state.stimulusTimeMs === undefined
      ? null
      : Math.max(0, assertFinite(state.stimulusTimeMs, "stimulusTimeMs")),
    mappingValues: state.mappingValues && typeof state.mappingValues === "object"
      ? Object.freeze({ ...state.mappingValues })
      : Object.freeze({}),
    anchorMonotonicMs,
  });
}

export class ResearchSamplingClock {
  constructor({
    samplingFrequencyHz,
    now = () => performance.now(),
    clockOffsetMs = 0,
    wallNow = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
    onSample = () => {},
    onGap = () => {},
  }) {
    this.samplingFrequencyHz = assertFrequency(samplingFrequencyHz);
    this.periodMs = 1000 / this.samplingFrequencyHz;
    this.now = now;
    this.clockOffsetMs = assertFinite(clockOffsetMs, "clockOffsetMs");
    this.wallNow = wallNow;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onSample = onSample;
    this.onGap = onGap;
    this.timer = null;
    this.active = false;
    this.stopped = false;
    this.deadline = null;
    this.sequence = 1;
    this.state = cloneState({
      currentValence: 0,
      currentArousal: 0,
      targetValence: 0,
      targetArousal: 0,
      animationActive: false,
      inputActive: false,
      stimulusTimeMs: null,
      mappingValues: {},
    }, this.#mappedNow());
    this.stimulus = null;
  }

  updateState(state) {
    if (this.stopped) return;
    this.state = cloneState(state, this.#mappedNow());
  }

  startStimulus({ stimulusIndex, stimulusId, stimulusEpoch }) {
    if (this.stopped) throw new Error("Sampling clock has stopped.");
    if (this.stimulus !== null) throw new Error("A sampling stimulus is already selected.");
    if (!Number.isSafeInteger(stimulusIndex) || stimulusIndex < 0) {
      throw new RangeError("stimulusIndex must be a non-negative integer.");
    }
    if (typeof stimulusId !== "string" || stimulusId.length < 1 || stimulusId.length > 256) {
      throw new TypeError("stimulusId must contain 1–256 characters.");
    }
    this.stimulus = Object.freeze({
      stimulusIndex,
      stimulusId,
      stimulusEpoch: assertNonNegativeInteger(stimulusEpoch, "stimulusEpoch"),
    });
    this.active = true;
    this.deadline = this.now() + this.periodMs;
    this.#schedule();
  }

  stopStimulus() {
    this.active = false;
    this.stimulus = null;
    this.deadline = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.updateState({
      currentValence: 0,
      currentArousal: 0,
      targetValence: 0,
      targetArousal: 0,
      animationActive: false,
      inputActive: false,
      stimulusTimeMs: null,
      mappingValues: {},
      anchorMonotonicMs: this.#mappedNow(),
    });
  }

  pause() {
    if (!this.active || this.stopped || !this.stimulus) return false;
    this.active = false;
    this.deadline = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    return true;
  }

  resume() {
    if (this.active || this.stopped || !this.stimulus) return false;
    this.active = true;
    this.deadline = this.now() + this.periodMs;
    this.#schedule();
    return true;
  }

  stop() {
    this.stopStimulus();
    this.stopped = true;
  }

  tick() {
    this.timer = null;
    if (!this.active || this.stopped || this.deadline === null || !this.stimulus) return;
    const observedLocalMonotonicMs = this.now();
    if (observedLocalMonotonicMs + 0.001 < this.deadline) {
      this.#schedule();
      return;
    }

    const lateByMs = Math.max(0, observedLocalMonotonicMs - this.deadline);
    const missedSlots = Math.floor(lateByMs / this.periodMs);
    if (missedSlots > 0) {
      const firstMissedMonotonicMs = this.#mappedTime(this.deadline);
      this.onGap(Object.freeze({
        type: "timing-gap",
        stimulusIndex: this.stimulus.stimulusIndex,
        stimulusId: this.stimulus.stimulusId,
        firstMissedMonotonicMs,
        stimulusEpoch: this.stimulus.stimulusEpoch,
        observedMonotonicMs: this.#mappedTime(observedLocalMonotonicMs),
        missedSlots,
        durationMs: missedSlots * this.periodMs,
        samplingFrequencyHz: this.samplingFrequencyHz,
      }));
      this.deadline += missedSlots * this.periodMs;
    }

    const scheduledLocalMonotonicMs = this.deadline;
    const scheduledMonotonicMs = this.#mappedTime(scheduledLocalMonotonicMs);
    const observedMonotonicMs = this.#mappedTime(observedLocalMonotonicMs);
    const state = this.state;
    this.onSample(Object.freeze({
      sequence: this.sequence,
      stimulusIndex: this.stimulus.stimulusIndex,
      stimulusId: this.stimulus.stimulusId,
      stimulusEpoch: this.stimulus.stimulusEpoch,
      stimulusTimeMs: state.stimulusTimeMs,
      wallTimeUtc: new Date(this.wallNow()).toISOString(),
      scheduledMonotonicMs,
      observedMonotonicMs,
      latenessMs: Math.max(0, observedLocalMonotonicMs - scheduledLocalMonotonicMs),
      anchorAgeMs: Math.max(0, observedMonotonicMs - state.anchorMonotonicMs),
      samplingFrequencyHz: this.samplingFrequencyHz,
      currentValence: state.currentValence,
      currentArousal: state.currentArousal,
      targetValence: state.targetValence,
      targetArousal: state.targetArousal,
      radius: state.radius,
      angleDegrees: state.angleDegrees,
      animationActive: state.animationActive,
      inputActive: state.inputActive,
      mappingValues: state.mappingValues,
    }));
    this.sequence += 1;
    this.deadline += this.periodMs;
    this.#schedule();
  }

  #schedule() {
    if (!this.active || this.stopped || this.timer !== null || this.deadline === null) return;
    const delay = Math.max(0, this.deadline - this.now());
    this.timer = this.setTimer(() => this.tick(), delay);
  }

  #mappedNow() {
    return this.#mappedTime(this.now());
  }

  #mappedTime(localMonotonicMs) {
    return assertFinite(localMonotonicMs, "localMonotonicMs") + this.clockOffsetMs;
  }
}

export function installWorkerProtocol(scope, {
  timeOriginMs = globalThis.performance?.timeOrigin ?? 0,
  now = () => globalThis.performance?.now?.() ?? 0,
  wallNow = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let clock = null;
  let sessionToken = null;
  const assertStimulusEpoch = (request) => {
    const epoch = assertNonNegativeInteger(request.stimulusEpoch, "stimulusEpoch");
    if (!clock?.stimulus || clock.stimulus.stimulusEpoch !== epoch) {
      throw new Error("Sampling worker stimulus epoch changed.");
    }
  };
  const acknowledge = (request, extra = {}) => {
    const commandId = assertNonNegativeInteger(request.commandId, "commandId");
    scope.postMessage({
      type: "ack",
      commandType: request.type,
      commandId,
      sessionToken,
      ...extra,
    });
  };
  scope.addEventListener("message", ({ data }) => {
    try {
      switch (data?.type) {
        case "configure":
          clock?.stop();
          sessionToken = assertSessionToken(data.sessionToken);
          const controllerTimeOriginMs = assertFinite(data.controllerTimeOriginMs, "controllerTimeOriginMs");
          const clockOffsetMs = assertFinite(timeOriginMs, "timeOriginMs") - controllerTimeOriginMs;
          clock = new ResearchSamplingClock({
            samplingFrequencyHz: data.samplingFrequencyHz,
            now,
            clockOffsetMs,
            wallNow,
            setTimer,
            clearTimer,
            onSample: (sample) => scope.postMessage({ type: "sample", sessionToken, sample }),
            onGap: (event) => scope.postMessage({ type: "gap", sessionToken, event }),
          });
          scope.postMessage({
            type: "ready",
            sessionToken,
            samplingFrequencyHz: clock.samplingFrequencyHz,
            clockDomain: "controller-performance-v1",
            controllerTimeOriginMs,
            workerTimeOriginMs: timeOriginMs,
            clockOffsetMs,
          });
          break;
        case "state":
          if (!clock) throw new Error("Configure the sampling worker first.");
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          clock.updateState(data.state);
          break;
        case "stimulus-start":
          if (!clock) throw new Error("Configure the sampling worker first.");
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          clock.startStimulus(data);
          acknowledge(data, {
            stimulusEpoch: data.stimulusEpoch,
            stimulusIndex: data.stimulusIndex,
            stimulusId: data.stimulusId,
          });
          break;
        case "stimulus-stop":
          if (!clock) throw new Error("Configure the sampling worker first.");
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          assertStimulusEpoch(data);
          clock?.stopStimulus();
          acknowledge(data, { stimulusEpoch: data.stimulusEpoch });
          break;
        case "pause":
          if (!clock) throw new Error("Configure the sampling worker first.");
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          assertStimulusEpoch(data);
          clock?.pause();
          acknowledge(data, { stimulusEpoch: data.stimulusEpoch });
          break;
        case "resume":
          if (!clock) throw new Error("Configure the sampling worker first.");
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          assertStimulusEpoch(data);
          clock?.resume();
          acknowledge(data, { stimulusEpoch: data.stimulusEpoch });
          break;
        case "stop":
          if (data.sessionToken !== sessionToken) throw new Error("Sampling worker session token changed.");
          clock?.stop();
          clock = null;
          acknowledge(data);
          sessionToken = null;
          break;
        default:
          throw new Error("Sampling worker received an unsupported command.");
      }
    } catch (error) {
      scope.postMessage({
        type: "error",
        code: "sampling-worker",
        commandId: Number.isSafeInteger(data?.commandId) ? data.commandId : null,
        sessionToken: typeof data?.sessionToken === "string" ? data.sessionToken : sessionToken,
        message: error instanceof Error ? error.message : "Sampling worker failed.",
      });
    }
  });
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  installWorkerProtocol(globalThis);
}
