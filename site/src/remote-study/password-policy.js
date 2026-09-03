import {
  assertSafeInteger,
  assertToken,
  failContract,
} from "./values.js";

export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 128;

export const COMMON_PASSWORD_BLOCKLIST = Object.freeze([
  "123456789012345",
  "adminadminadminadmin",
  "changemechangeme",
  "correcthorsebatterystaple",
  "iloveyouiloveyou",
  "letmeinletmeinletmein",
  "passwordpassword",
  "qwertyuiopasdfgh",
  "thisisnotasecurepassword",
]);

const embeddedBlocklist = new Set(COMMON_PASSWORD_BLOCKLIST);

export const REMOTE_STUDY_RATE_LIMITS = Object.freeze({
  beacon: Object.freeze({ limit: 30, windowMs: 60_000 }),
  proof: Object.freeze({ limit: 5, windowMs: 5 * 60_000 }),
});

export class PasswordPolicyError extends Error {
  constructor(code) {
    super("The password file does not meet the remote-control password policy.");
    this.name = "PasswordPolicyError";
    this.code = code;
  }
}

export function normalizePasswordText(value, { blocklist = embeddedBlocklist } = {}) {
  if (typeof value !== "string") throw new PasswordPolicyError("invalid_text");
  let normalized = value.startsWith("\uFEFF") ? value.slice(1) : value;
  if (normalized.endsWith("\r\n")) normalized = normalized.slice(0, -2);
  else if (normalized.endsWith("\n") || normalized.endsWith("\r")) normalized = normalized.slice(0, -1);
  normalized = normalized.normalize("NFC");

  const length = Array.from(normalized).length;
  if (length < PASSWORD_MIN_CODE_POINTS || length > PASSWORD_MAX_CODE_POINTS) {
    throw new PasswordPolicyError("invalid_length");
  }
  const blocked = blocklist instanceof Set ? blocklist : new Set(blocklist ?? []);
  if (blocked.has(normalized.toLowerCase())) throw new PasswordPolicyError("common_password");
  return normalized;
}

export class SlidingWindowRateLimiter {
  constructor({ limit, windowMs, maximumKeys = 256, now = () => Date.now() }) {
    assertSafeInteger(limit, "limit", { minimum: 1, maximum: 10_000 });
    assertSafeInteger(windowMs, "windowMs", { minimum: 1, maximum: 24 * 60 * 60 * 1000 });
    assertSafeInteger(maximumKeys, "maximumKeys", { minimum: 1, maximum: 100_000 });
    if (typeof now !== "function") failContract("invalid_configuration", "now must be a function.");
    this.limit = limit;
    this.windowMs = windowMs;
    this.maximumKeys = maximumKeys;
    this.now = now;
    this.attempts = new Map();
  }

  purge(nowMs = this.now()) {
    assertSafeInteger(nowMs, "nowMs");
    const cutoff = nowMs - this.windowMs;
    for (const [key, timestamps] of this.attempts) {
      const retained = timestamps.filter((timestamp) => timestamp > cutoff);
      if (retained.length) this.attempts.set(key, retained);
      else this.attempts.delete(key);
    }
  }

  consume(key, nowMs = this.now()) {
    assertSafeInteger(nowMs, "nowMs");
    assertToken(key, "rate-limit key", { minimum: 1, maximum: 128 });
    this.purge(nowMs);
    let timestamps = this.attempts.get(key);
    if (!timestamps) {
      if (this.attempts.size >= this.maximumKeys) {
        return Object.freeze({ allowed: false, retryAfterMs: this.windowMs, reason: "capacity" });
      }
      timestamps = [];
      this.attempts.set(key, timestamps);
    }
    if (timestamps.length >= this.limit) {
      return Object.freeze({
        allowed: false,
        retryAfterMs: Math.max(1, timestamps[0] + this.windowMs - nowMs),
        reason: "rate_limited",
      });
    }
    timestamps.push(nowMs);
    return Object.freeze({
      allowed: true,
      remaining: this.limit - timestamps.length,
      retryAfterMs: 0,
    });
  }

  reset(key) {
    if (key === undefined) this.attempts.clear();
    else this.attempts.delete(key);
  }
}

export function createRemoteStudyRateLimiters(options = {}) {
  const now = options.now ?? (() => Date.now());
  const maximumKeys = options.maximumKeys ?? 256;
  return Object.freeze({
    beacon: new SlidingWindowRateLimiter({
      ...REMOTE_STUDY_RATE_LIMITS.beacon,
      maximumKeys,
      now,
    }),
    proof: new SlidingWindowRateLimiter({
      ...REMOTE_STUDY_RATE_LIMITS.proof,
      maximumKeys,
      now,
    }),
  });
}

