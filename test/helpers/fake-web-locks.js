import { WebLockRunOwnership } from "../../site/src/study/run-ownership.js";

export class FakeWebLocks {
  constructor() {
    this.held = new Map();
  }

  async request(name, options, callback) {
    if (typeof callback !== "function") throw new TypeError("A lock callback is required.");
    if (this.held.has(name)) {
      if (options?.ifAvailable) return callback(null);
      throw new Error(`Fake lock ${name} is already held.`);
    }
    const lock = Object.freeze({ name, mode: options?.mode ?? "exclusive" });
    this.held.set(name, lock);
    try {
      return await callback(lock);
    } finally {
      if (this.held.get(name) === lock) this.held.delete(name);
    }
  }
}

export function createTestRunOwnership(locks = new FakeWebLocks()) {
  return new WebLockRunOwnership({ locks });
}
