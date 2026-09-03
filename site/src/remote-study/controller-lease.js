import { projectGrant } from "./contracts.js";
import {
  assertSafeInteger,
  assertToken,
  failContract,
} from "./values.js";

export const CONTROLLER_LEASE_MS = 15_000;
export const CONTROLLER_LEASE_RENEWAL_KINDS = Object.freeze([
  "application-control",
  "lease-renewal",
]);

const renewalKinds = new Set(CONTROLLER_LEASE_RENEWAL_KINDS);

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clockMilliseconds(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    failContract("invalid_clock", `${name} must be a non-negative finite clock value.`);
  }
  return Math.floor(value);
}

function addDuration(nowMs, durationMs) {
  return nowMs > Number.MAX_SAFE_INTEGER - durationMs
    ? Number.MAX_SAFE_INTEGER
    : nowMs + durationMs;
}

export class ControllerLease {
  constructor(options = {}) {
    const {
      now,
      wallNow = now ?? (() => Date.now()),
      monotonicNow = now ?? defaultMonotonicNow,
      leaseMs = CONTROLLER_LEASE_MS,
    } = options;
    if (typeof wallNow !== "function" || typeof monotonicNow !== "function") {
      failContract("invalid_configuration", "Lease wall and monotonic clocks must be functions.");
    }
    if (leaseMs !== CONTROLLER_LEASE_MS) {
      failContract("invalid_lease", "The remote-study controller lease is fixed at 15 seconds.");
    }
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.current = undefined;
    this.lastRevocation = undefined;
  }

  expireIfNeeded(
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    if (this.current
      && (wallMs >= this.current.expiresAtMs
        || monotonicMs >= this.current.expiresAtMonotonicMs)) {
      const expired = this.current;
      this.current = undefined;
      this.lastRevocation = Object.freeze({
        authorityGeneration: expired.authorityGeneration,
        principalId: expired.principalId,
        grantId: expired.grantId,
        reason: "lease_expired",
        revokedAtMs: wallMs,
      });
      return this.lastRevocation;
    }
    return undefined;
  }

  claim(
    grantValue,
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    this.expireIfNeeded(wallMs, monotonicMs);
    const grant = projectGrant(grantValue);
    if (grant.revoked || wallMs < grant.issuedAtMs || wallMs >= grant.expiresAtMs) {
      failContract("grant_expired", "The controller grant is revoked or expired.");
    }
    if (this.current
      && (this.current.authorityGeneration !== grant.authorityGeneration
        || this.current.principalId !== grant.principalId
        || this.current.grantId !== grant.grantId)) {
      failContract("controller_busy", "Another controller currently owns the lease.");
    }
    if (this.current) return this.snapshot(wallMs, monotonicMs);
    const grantRemainingMs = grant.expiresAtMs - wallMs;
    const grantExpiresAtMonotonicMs = addDuration(monotonicMs, grantRemainingMs);
    this.current = {
      ...grant,
      grantExpiresAtMs: grant.expiresAtMs,
      grantExpiresAtMonotonicMs,
      claimedAtMs: wallMs,
      renewedAtMs: wallMs,
      expiresAtMs: Math.min(grant.expiresAtMs, addDuration(wallMs, CONTROLLER_LEASE_MS)),
      expiresAtMonotonicMs: Math.min(
        grantExpiresAtMonotonicMs,
        addDuration(monotonicMs, CONTROLLER_LEASE_MS),
      ),
    };
    return this.snapshot(wallMs, monotonicMs);
  }

  renew(
    { authorityGeneration, principalId, grantId, frameKind },
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    this.expireIfNeeded(wallMs, monotonicMs);
    assertSafeInteger(authorityGeneration, "authorityGeneration", { minimum: 1 });
    assertToken(principalId, "principalId", { minimum: 8, maximum: 96 });
    assertToken(grantId, "grantId", { minimum: 8, maximum: 96 });
    if (!renewalKinds.has(frameKind)) {
      return Object.freeze({ renewed: false, error: "non_semantic_frame" });
    }
    if (!this.current
      || this.current.authorityGeneration !== authorityGeneration
      || this.current.principalId !== principalId
      || this.current.grantId !== grantId) {
      return Object.freeze({ renewed: false, error: "lease_not_owned" });
    }
    this.current.renewedAtMs = wallMs;
    this.current.expiresAtMs = Math.min(
      this.current.grantExpiresAtMs,
      addDuration(wallMs, CONTROLLER_LEASE_MS),
    );
    this.current.expiresAtMonotonicMs = Math.min(
      this.current.grantExpiresAtMonotonicMs,
      addDuration(monotonicMs, CONTROLLER_LEASE_MS),
    );
    return Object.freeze({ renewed: true, expiresAtMs: this.current.expiresAtMs });
  }

  revoke(
    { authorityGeneration, principalId, grantId, reason = "local_stop" } = {},
    wallNowMs = this.wallNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    if (!this.current) return false;
    if (authorityGeneration !== undefined) {
      assertSafeInteger(authorityGeneration, "authorityGeneration", { minimum: 1 });
      if (authorityGeneration !== this.current.authorityGeneration) return false;
    }
    if (principalId !== undefined && principalId !== this.current.principalId) return false;
    if (grantId !== undefined && grantId !== this.current.grantId) return false;
    assertToken(reason, "reason", { minimum: 1, maximum: 64 });
    const revoked = this.current;
    this.current = undefined;
    this.lastRevocation = Object.freeze({
      authorityGeneration: revoked.authorityGeneration,
      principalId: revoked.principalId,
      grantId: revoked.grantId,
      reason,
      revokedAtMs: wallMs,
    });
    return true;
  }

  snapshot(
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    this.expireIfNeeded(wallMs, monotonicMs);
    if (!this.current) {
      return Object.freeze({ active: false, leaseMs: CONTROLLER_LEASE_MS, lastRevocation: this.lastRevocation });
    }
    return Object.freeze({
      active: true,
      leaseMs: CONTROLLER_LEASE_MS,
      authorityGeneration: this.current.authorityGeneration,
      principalId: this.current.principalId,
      principalLabel: this.current.principalLabel,
      grantId: this.current.grantId,
      scopes: this.current.scopes,
      authenticationMethod: this.current.authenticationMethod,
      claimedAtMs: this.current.claimedAtMs,
      renewedAtMs: this.current.renewedAtMs,
      expiresAtMs: this.current.expiresAtMs,
      remainingMs: Math.max(0, Math.min(
        this.current.expiresAtMs - wallMs,
        this.current.expiresAtMonotonicMs - monotonicMs,
      )),
    });
  }
}
