import {
  assertIdentifier,
  StudyStorageConflictError,
  StudyStorageStateError,
  StudyStorageValidationError,
} from "./storage-common.js";

export const RUN_OWNERSHIP_LOCK_PREFIX = "affect-tracker-study-run-v1:";

export function runOwnershipLockName(runId) {
  return `${RUN_OWNERSHIP_LOCK_PREFIX}${assertIdentifier(runId, "runId")}`;
}

function assertCallback(callback) {
  if (typeof callback !== "function") {
    throw new StudyStorageValidationError("A run-lock callback is required.");
  }
  return callback;
}

export class WebLockRunOwnership {
  constructor({ locks = globalThis.navigator?.locks } = {}) {
    this.locks = locks;
  }

  get supported() {
    return typeof this.locks?.request === "function";
  }

  async acquire(runId) {
    this.#requireSupport();
    const name = runOwnershipLockName(runId);
    let settleGrant;
    let rejectGrant;
    let releaseLock;
    let grantSettled = false;
    const granted = new Promise((resolve, reject) => {
      settleGrant = (value) => {
        if (grantSettled) return;
        grantSettled = true;
        resolve(value);
      };
      rejectGrant = (error) => {
        if (grantSettled) return;
        grantSettled = true;
        reject(error);
      };
    });
    const released = new Promise((resolve) => { releaseLock = resolve; });
    const request = Promise.resolve().then(() => this.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settleGrant(false);
          return;
        }
        settleGrant(true);
        await released;
      },
    ));
    request.then(
      () => settleGrant(false),
      (error) => rejectGrant(error),
    );

    if (!await granted) {
      await request;
      throw new StudyStorageConflictError(
        `Run ${runId} is already active in another page.`,
      );
    }

    let releasePromise;
    return Object.freeze({
      runId,
      name,
      release() {
        if (!releasePromise) {
          releaseLock();
          releasePromise = request.then(() => undefined);
        }
        return releasePromise;
      },
    });
  }

  async withLockIfAvailable(runId, callback) {
    this.#requireSupport();
    const operation = assertCallback(callback);
    let acquired = false;
    let value;
    await this.locks.request(
      runOwnershipLockName(runId),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return;
        acquired = true;
        value = await operation();
      },
    );
    return Object.freeze({ acquired, value });
  }

  async isAvailable(runId) {
    if (!this.supported) return undefined;
    return (await this.withLockIfAvailable(runId, () => undefined)).acquired;
  }

  #requireSupport() {
    if (!this.supported) {
      throw new StudyStorageStateError(
        "Web Locks is unavailable; this browser cannot safely own or discard a study run across pages.",
      );
    }
  }
}
