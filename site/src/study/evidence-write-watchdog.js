export const DEFAULT_EVIDENCE_WRITE_DEADLINE_MS = 2_000;

function validatedDeadline(value) {
  const deadlineMs = Number(value);
  if (!Number.isFinite(deadlineMs) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new RangeError("Evidence-write deadlineMs must be a positive safe integer.");
  }
  return deadlineMs;
}

function invokeSafely(callback, detail) {
  try {
    callback?.(detail);
  } catch (error) {
    globalThis.console?.error?.("Evidence-write watchdog callback failed.", error);
  }
}

/**
 * Observe durable evidence writes without racing or cancelling them.
 *
 * A deadline is an alarm only: the returned promise remains pending until the
 * original operation settles. This is important because releasing run
 * ownership while an IndexedDB transaction is still live would create a
 * recovery race.
 */
export class EvidenceWriteWatchdog {
  constructor({
    deadlineMs = DEFAULT_EVIDENCE_WRITE_DEADLINE_MS,
    setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeoutFn = (timer) => globalThis.clearTimeout(timer),
    onDeadline = () => {},
    onQuiescent = () => {},
  } = {}) {
    if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
      throw new TypeError("Evidence-write watchdog timers must be functions.");
    }
    if (typeof onDeadline !== "function" || typeof onQuiescent !== "function") {
      throw new TypeError("Evidence-write watchdog callbacks must be functions.");
    }
    this.deadlineMs = validatedDeadline(deadlineMs);
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onDeadline = onDeadline;
    this.onQuiescent = onQuiescent;
    this.activeCount = 0;
    this.latched = false;
    this.rejectedSinceDeadline = false;
  }

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("An evidence-write operation function is required.");
    }
    if (this.latched) {
      return Promise.reject(new Error(
        "Evidence writes are fenced after a deadline. Wait for the active write, then resume explicitly.",
      ));
    }

    this.activeCount += 1;
    let settled = false;
    const timer = this.setTimeoutFn(() => {
      if (settled) return;
      const firstDeadline = !this.latched;
      this.latched = true;
      if (firstDeadline) {
        invokeSafely(this.onDeadline, Object.freeze({
          deadlineMs: this.deadlineMs,
          activeCount: this.activeCount,
        }));
      }
    }, this.deadlineMs);

    let pending;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }

    const settle = (status) => {
      settled = true;
      this.clearTimeoutFn(timer);
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (this.latched && status === "rejected") this.rejectedSinceDeadline = true;
      if (this.latched && this.activeCount === 0) {
        invokeSafely(this.onQuiescent, Object.freeze({
          deadlineMs: this.deadlineMs,
          status,
          rejected: this.rejectedSinceDeadline,
        }));
      }
    };

    return pending.then(
      (value) => {
        settle("fulfilled");
        return value;
      },
      (error) => {
        settle("rejected");
        throw error;
      },
    );
  }

  alarmNow(reason = "deadline") {
    if (this.latched || this.activeCount === 0) return false;
    this.latched = true;
    invokeSafely(this.onDeadline, Object.freeze({
      deadlineMs: this.deadlineMs,
      activeCount: this.activeCount,
      reason,
    }));
    return true;
  }

  acknowledge() {
    if (!this.latched || this.activeCount !== 0 || this.rejectedSinceDeadline) return false;
    this.latched = false;
    this.rejectedSinceDeadline = false;
    return true;
  }

  clearAfterCommittedRetry() {
    if (this.activeCount !== 0) return false;
    this.latched = false;
    this.rejectedSinceDeadline = false;
    return true;
  }

  snapshot() {
    return Object.freeze({
      deadlineMs: this.deadlineMs,
      activeCount: this.activeCount,
      latched: this.latched,
      rejectedSinceDeadline: this.rejectedSinceDeadline,
    });
  }
}

export function applyEvidenceWriteSafetyFence({
  pauseLocalVideo = () => {},
  pauseEmbeddedVideo = () => {},
  stopSampling = () => {},
  stopTimeline = () => {},
  disableControls = () => {},
} = {}) {
  for (const callback of [
    pauseLocalVideo,
    pauseEmbeddedVideo,
    stopSampling,
    stopTimeline,
    disableControls,
  ]) {
    if (typeof callback !== "function") {
      throw new TypeError("Evidence-write safety-fence adapters must be functions.");
    }
  }
  pauseLocalVideo();
  pauseEmbeddedVideo();
  stopSampling();
  stopTimeline();
  disableControls();
}
