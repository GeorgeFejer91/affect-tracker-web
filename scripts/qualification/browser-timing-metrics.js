export const BROWSER_WORKER_DIAGNOSTIC_SCHEMA = "affect-research-browser-worker-diagnostic";
export const BROWSER_WORKER_DIAGNOSTIC_VERSION = 1;

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function rounded(value, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

function sampleIsValid(sample, frequencyHz, stimulusId, stimulusEpoch) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false;
  return Number.isSafeInteger(sample.sequence)
    && sample.sequence >= 1
    && sample.stimulusId === stimulusId
    && sample.stimulusEpoch === stimulusEpoch
    && sample.samplingFrequencyHz === frequencyHz
    && Number.isFinite(sample.scheduledMonotonicMs)
    && Number.isFinite(sample.observedMonotonicMs)
    && Number.isFinite(sample.latenessMs)
    && sample.observedMonotonicMs + 0.001 >= sample.scheduledMonotonicMs
    && Math.abs(sample.latenessMs - Math.max(0, sample.observedMonotonicMs - sample.scheduledMonotonicMs)) <= 0.001
    && Number.isFinite(sample.currentValence)
    && Number.isFinite(sample.currentArousal)
    && Number.isFinite(sample.anchorAgeMs);
}

function gapIsValid(gap, frequencyHz, stimulusId, stimulusEpoch) {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) return false;
  const periodMs = 1_000 / frequencyHz;
  return gap.stimulusId === stimulusId
    && gap.stimulusEpoch === stimulusEpoch
    && gap.samplingFrequencyHz === frequencyHz
    && Number.isSafeInteger(gap.missedSlots)
    && gap.missedSlots >= 1
    && Number.isFinite(gap.firstMissedMonotonicMs)
    && Number.isFinite(gap.observedMonotonicMs)
    && Number.isFinite(gap.durationMs)
    && Math.abs(gap.durationMs - gap.missedSlots * periodMs) <= 0.001;
}

export class BrowserWorkerTimingAccumulator {
  constructor({ frequencyHz, sessionToken, stimulusId = "qualification-synthetic", stimulusEpoch = 1 }) {
    this.frequencyHz = positiveInteger(frequencyHz, "frequencyHz", 240);
    if (typeof sessionToken !== "string" || sessionToken.length < 1 || sessionToken.length > 256) {
      throw new TypeError("sessionToken must contain 1–256 characters.");
    }
    this.sessionToken = sessionToken;
    this.stimulusId = stimulusId;
    this.stimulusEpoch = positiveInteger(stimulusEpoch, "stimulusEpoch");
    this.sampleCount = 0;
    this.gapEventCount = 0;
    this.missedSlotCount = 0;
    this.sequenceErrorCount = 0;
    this.corruptRecordCount = 0;
    this.unexpectedMessageCount = 0;
    this.expectedSequence = 1;
    this.firstScheduledMonotonicMs = null;
    this.lastScheduledMonotonicMs = null;
    this.firstObservedMonotonicMs = null;
    this.lastObservedMonotonicMs = null;
    this.earliestAccountedDeadlineMs = null;
    this.latenessValues = [];
    this.maximumLatenessMs = null;
    this.stateLatencyValues = [];
    this.stateUpdateCount = 0;
    this.matchedStateUpdateCount = 0;
    this.pendingStateUpdate = null;
  }

  noteStateUpdate({ currentValence, anchorMonotonicMs }) {
    finiteNumber(currentValence, "currentValence");
    finiteNumber(anchorMonotonicMs, "anchorMonotonicMs");
    this.stateUpdateCount += 1;
    this.pendingStateUpdate = Object.freeze({ currentValence, anchorMonotonicMs });
  }

  acceptMessage(message) {
    if (!message || typeof message !== "object" || message.sessionToken !== this.sessionToken) {
      this.unexpectedMessageCount += 1;
      return false;
    }
    if (message.type === "sample") return this.#acceptSample(message.sample);
    if (message.type === "gap") return this.#acceptGap(message.event);
    this.unexpectedMessageCount += 1;
    return false;
  }

  #acceptSample(sample) {
    if (!sampleIsValid(sample, this.frequencyHz, this.stimulusId, this.stimulusEpoch)) {
      this.corruptRecordCount += 1;
      return false;
    }
    if (sample.sequence !== this.expectedSequence) this.sequenceErrorCount += 1;
    this.expectedSequence = sample.sequence + 1;
    if (this.lastScheduledMonotonicMs !== null
      && sample.scheduledMonotonicMs <= this.lastScheduledMonotonicMs) {
      this.corruptRecordCount += 1;
      return false;
    }
    this.sampleCount += 1;
    this.firstScheduledMonotonicMs ??= sample.scheduledMonotonicMs;
    this.lastScheduledMonotonicMs = sample.scheduledMonotonicMs;
    this.firstObservedMonotonicMs ??= sample.observedMonotonicMs;
    this.lastObservedMonotonicMs = sample.observedMonotonicMs;
    this.earliestAccountedDeadlineMs = this.earliestAccountedDeadlineMs === null
      ? sample.scheduledMonotonicMs
      : Math.min(this.earliestAccountedDeadlineMs, sample.scheduledMonotonicMs);
    this.latenessValues.push(sample.latenessMs);
    this.maximumLatenessMs = this.maximumLatenessMs === null
      ? sample.latenessMs
      : Math.max(this.maximumLatenessMs, sample.latenessMs);
    if (this.pendingStateUpdate
      && Math.abs(sample.currentValence - this.pendingStateUpdate.currentValence) <= Number.EPSILON) {
      this.stateLatencyValues.push(Math.max(0, sample.observedMonotonicMs - this.pendingStateUpdate.anchorMonotonicMs));
      this.matchedStateUpdateCount += 1;
      this.pendingStateUpdate = null;
    }
    return true;
  }

  #acceptGap(gap) {
    if (!gapIsValid(gap, this.frequencyHz, this.stimulusId, this.stimulusEpoch)) {
      this.corruptRecordCount += 1;
      return false;
    }
    this.gapEventCount += 1;
    this.missedSlotCount += gap.missedSlots;
    this.earliestAccountedDeadlineMs = this.earliestAccountedDeadlineMs === null
      ? gap.firstMissedMonotonicMs
      : Math.min(this.earliestAccountedDeadlineMs, gap.firstMissedMonotonicMs);
    return true;
  }

  receipt({ candidateCommit, hardwareRecord, startedAt, finalizedAt, requestedDurationSeconds, actualDurationMs, environment }) {
    if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) throw new TypeError("candidateCommit must be a lowercase 40-character Git SHA.");
    if (typeof hardwareRecord !== "string" || hardwareRecord.trim().length < 1 || hardwareRecord.length > 240) {
      throw new TypeError("hardwareRecord must contain 1–240 characters.");
    }
    const requestedSeconds = finiteNumber(requestedDurationSeconds, "requestedDurationSeconds");
    if (requestedSeconds <= 0 || requestedSeconds > 1_800) throw new RangeError("requestedDurationSeconds must be in (0, 1800].");
    const actualMs = finiteNumber(actualDurationMs, "actualDurationMs");
    if (actualMs <= 0) throw new RangeError("actualDurationMs must be positive.");
    const periodMs = 1_000 / this.frequencyHz;
    const observedSpanMs = this.sampleCount > 1
      ? this.lastObservedMonotonicMs - this.firstObservedMonotonicMs
      : 0;
    const meanRateHz = observedSpanMs > 0 ? (this.sampleCount - 1) * 1_000 / observedSpanMs : null;
    const spanExpectedSlotCount = this.earliestAccountedDeadlineMs !== null && this.lastScheduledMonotonicMs !== null
      ? Math.round((this.lastScheduledMonotonicMs - this.earliestAccountedDeadlineMs) / periodMs) + 1
      : 0;
    const requestedWindowSlotCount = Math.floor(
      Math.min(actualMs, requestedSeconds * 1_000) * this.frequencyHz / 1_000 + 1e-9,
    );
    const expectedSlotCount = Math.max(spanExpectedSlotCount, requestedWindowSlotCount);
    const accountedSlotCount = this.sampleCount + this.missedSlotCount;
    const unaccountedSlotCount = Math.max(0, expectedSlotCount - accountedSlotCount);
    const overAccountedSlotCount = Math.max(0, accountedSlotCount - expectedSlotCount);
    const p95LatenessMs = percentile(this.latenessValues, 0.95);
    const p95StateLatencyMs = percentile(this.stateLatencyValues, 0.95);
    const thresholds = {
      thirtyMinuteWindow: requestedSeconds === 1_800 && actualMs >= 1_800_000,
      frequency130Hz: this.frequencyHz === 130,
      meanRate129To131Hz: meanRateHz !== null && meanRateHz >= 129 && meanRateHz <= 131,
      p95LatenessAtMostTwoPeriods: p95LatenessMs !== null && p95LatenessMs <= 2 * periodMs,
      controllerStateToSampleAtMostThreePeriods: p95StateLatencyMs !== null && p95StateLatencyMs <= 3 * periodMs,
      everyControllerStateUpdateObserved: this.stateUpdateCount > 0
        && this.matchedStateUpdateCount === this.stateUpdateCount,
      visibleForEntireRun: environment?.visibilityLossCount === 0
        && environment?.hiddenDurationMs === 0,
      noSilentOrCorruptEvidence: this.sequenceErrorCount === 0
        && this.corruptRecordCount === 0
        && this.unexpectedMessageCount === 0
        && unaccountedSlotCount === 0
        && overAccountedSlotCount === 0,
    };
    return Object.freeze({
      schema: BROWSER_WORKER_DIAGNOSTIC_SCHEMA,
      version: BROWSER_WORKER_DIAGNOSTIC_VERSION,
      qualificationScope: "sampling-worker-only; does not qualify the full app, physical input, persistence, media, LSL, or research readiness",
      candidateCommit,
      candidateCommitProvenance: "operator-supplied-unverified",
      hardwareRecord: hardwareRecord.trim(),
      startedAt,
      finalizedAt,
      environment: structuredClone(environment),
      configuration: {
        requestedDurationSeconds: requestedSeconds,
        actualDurationMs: rounded(actualMs),
        samplingFrequencyHz: this.frequencyHz,
        periodMs: rounded(periodMs),
      },
      evidence: {
        sampleCount: this.sampleCount,
        gapEventCount: this.gapEventCount,
        missedSlotCount: this.missedSlotCount,
        sequenceErrorCount: this.sequenceErrorCount,
        corruptRecordCount: this.corruptRecordCount,
        unexpectedMessageCount: this.unexpectedMessageCount,
        expectedSlotCount,
        spanExpectedSlotCount,
        requestedWindowSlotCount,
        accountedSlotCount,
        unaccountedSlotCount,
        overAccountedSlotCount,
        controllerStateUpdateCount: this.stateUpdateCount,
        matchedControllerStateUpdateCount: this.matchedStateUpdateCount,
        unmatchedControllerStateUpdateCount: this.stateUpdateCount - this.matchedStateUpdateCount,
      },
      metrics: {
        observedSampleSpanMs: rounded(observedSpanMs),
        meanSteadyStateRateHz: rounded(meanRateHz),
        p95SchedulerLatenessMs: rounded(p95LatenessMs),
        maximumSchedulerLatenessMs: rounded(this.maximumLatenessMs),
        p95ControllerStateToSampleMs: rounded(p95StateLatencyMs),
      },
      thresholds,
      workerThresholdsPassed: Object.values(thresholds).every(Boolean),
    });
  }
}
