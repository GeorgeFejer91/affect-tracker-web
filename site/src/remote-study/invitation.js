import {
  assertSafeInteger,
  assertToken,
  base64UrlToBytes,
  bytesFrom,
  bytesToBase64Url,
  failContract,
} from "./values.js";

export const QR_INVITATION_TTL_MS = 10 * 60 * 1000;
export const QR_INVITATION_SECRET_BYTES = 24;
export const QR_INVITATION_MAX_ACTIVE = 16;
export const QR_INVITATION_MAX_URL_CHARACTERS = 4096;
export const REMOTE_STUDY_CANONICAL_COMPANION_URL = "https://georgefejer91.github.io/affect-tracker-web/study-remote.html";

const QR_INVITATION_SECRET_CHARACTERS = 32;
const invalidInvitation = Object.freeze({ ok: false, error: "invitation_invalid" });
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function defaultMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clockMilliseconds(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    failContract("invalid_clock", `${name} must be a non-negative finite clock value.`);
  }
  return Math.floor(value);
}

function permitsCompanionProtocol(url) {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:"
    && loopbackHosts.has(url.hostname)
    && url.pathname.endsWith("/study-remote.html");
}

function secureRandomBytes(length) {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    failContract("secure_random_unavailable", "Secure random generation is unavailable.");
  }
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function randomExactly(randomBytes, length, name) {
  const value = bytesFrom(randomBytes(length), name);
  if (value.byteLength !== length) {
    failContract("invalid_random_source", `${name} must return exactly ${length} bytes.`);
  }
  return value;
}

function equalBytes(left, right) {
  const maximum = Math.max(left.byteLength, right.byteLength);
  let different = left.byteLength ^ right.byteLength;
  for (let index = 0; index < maximum; index += 1) {
    different |= (left[index % left.byteLength] ?? 0) ^ (right[index % right.byteLength] ?? 0);
  }
  return different === 0;
}

function parseInvitationSecret(value) {
  if (typeof value !== "string" || value.length !== QR_INVITATION_SECRET_CHARACTERS) {
    failContract("weak_invitation_secret", "The invitation secret must contain exactly 192 bits.");
  }
  const bytes = base64UrlToBytes(value, "secret");
  if (bytes.byteLength !== QR_INVITATION_SECRET_BYTES) {
    failContract("weak_invitation_secret", "The invitation secret must contain exactly 192 bits.");
  }
  return bytes;
}

function validateCompanionUrl(value) {
  if (typeof value !== "string" || value.length > QR_INVITATION_MAX_URL_CHARACTERS) {
    failContract("invalid_companion_url", "The companion URL is invalid or too long.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    failContract("invalid_companion_url", "The companion URL is invalid.");
  }
  if (!permitsCompanionProtocol(url) || url.username || url.password) {
    failContract("invalid_companion_url", "The companion URL must use credential-free HTTPS, except for the pinned loopback development page.");
  }
  if (url.searchParams.has("invite") || url.searchParams.has("secret")) {
    failContract("secret_in_query", "Invitation material must not appear in the URL query.");
  }
  return url;
}

export function createQrInvitation({
  companionUrl,
  randomBytes = secureRandomBytes,
  nowMs = Date.now(),
} = {}) {
  assertSafeInteger(nowMs, "nowMs");
  const url = validateCompanionUrl(companionUrl);
  const locator = `inv_${bytesToBase64Url(randomExactly(randomBytes, 12, "invitation locator"))}`;
  const secret = bytesToBase64Url(randomExactly(randomBytes, QR_INVITATION_SECRET_BYTES, "invitation secret"));
  url.hash = new URLSearchParams({ invite: locator, secret }).toString();
  return Object.freeze({
    locator,
    secret,
    expiresAtMs: nowMs + QR_INVITATION_TTL_MS,
    url: url.toString(),
  });
}

export function remoteStudyCompanionLocationPolicy(location) {
  let current;
  try {
    current = new URL(String(location?.href ?? ""));
  } catch {
    failContract("invalid_invitation", "The current companion URL is invalid.");
  }
  if (loopbackHosts.has(current.hostname)
    && ["http:", "https:"].includes(current.protocol)
    && current.pathname.endsWith("/study-remote.html")) {
    return Object.freeze({ expectedOrigin: current.origin, expectedPathname: current.pathname });
  }
  const canonical = new URL(REMOTE_STUDY_CANONICAL_COMPANION_URL);
  return Object.freeze({
    expectedOrigin: canonical.origin,
    expectedPathname: canonical.pathname,
  });
}

export function parseQrInvitationUrl(value, { expectedOrigin, expectedPathname } = {}) {
  if (typeof value !== "string" || value.length > QR_INVITATION_MAX_URL_CHARACTERS) {
    failContract("invalid_invitation", "The invitation URL is invalid or too long.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    failContract("invalid_invitation", "The invitation URL is invalid.");
  }
  if (!permitsCompanionProtocol(url) || url.username || url.password) {
    failContract("invalid_invitation", "The invitation must use credential-free HTTPS, except for the pinned loopback development page.");
  }
  if (typeof expectedOrigin !== "string" || url.origin !== expectedOrigin) {
    failContract("wrong_origin", "The invitation origin does not match the companion origin.");
  }
  if (typeof expectedPathname === "string" && url.pathname !== expectedPathname) {
    failContract("wrong_path", "The invitation path does not match the companion path.");
  }
  if (url.searchParams.has("invite") || url.searchParams.has("secret")) {
    failContract("secret_in_query", "Invitation material must not appear in the URL query.");
  }
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const keys = [...fragment.keys()];
  if (keys.length !== 2
    || keys.filter((key) => key === "invite").length !== 1
    || keys.filter((key) => key === "secret").length !== 1) {
    failContract("invalid_invitation", "The invitation fragment has unexpected fields.");
  }
  const locator = fragment.get("invite");
  const secret = fragment.get("secret");
  assertToken(locator, "invite", { minimum: 8, maximum: 96 });
  parseInvitationSecret(secret);
  return Object.freeze({ locator, secret });
}

export function readAndClearQrInvitation({ location, history, expectedOrigin, expectedPathname } = {}) {
  const href = String(location?.href ?? "");
  if (href.length > QR_INVITATION_MAX_URL_CHARACTERS) {
    failContract("invalid_invitation", "The current companion URL is too long.");
  }
  let current;
  try {
    current = new URL(href);
  } catch {
    failContract("invalid_invitation", "The current companion URL is invalid.");
  }
  current.hash = "";
  if (typeof history?.replaceState !== "function") {
    failContract("history_unavailable", "Browser history replacement is unavailable.");
  }
  history.replaceState(history.state ?? null, "", current.toString());
  return parseQrInvitationUrl(href, { expectedOrigin, expectedPathname });
}

export class OneTimeInvitationStore {
  constructor(options = {}) {
    const {
      randomBytes = secureRandomBytes,
      now,
      wallNow = now ?? (() => Date.now()),
      monotonicNow = now ?? defaultMonotonicNow,
      maximumActive = QR_INVITATION_MAX_ACTIVE,
    } = options;
    if (typeof randomBytes !== "function"
      || typeof wallNow !== "function"
      || typeof monotonicNow !== "function") {
      failContract("invalid_configuration", "Invitation dependencies must be functions.");
    }
    assertSafeInteger(maximumActive, "maximumActive", { minimum: 1, maximum: 256 });
    this.randomBytes = randomBytes;
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.maximumActive = maximumActive;
    this.records = new Map();
  }

  purge(wallNowMs = this.wallNow(), monotonicNowMs = this.monotonicNow()) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    for (const [locator, record] of this.records) {
      if (record.consumedAtMs !== null
        || wallMs >= record.expiresAtMs
        || monotonicMs >= record.expiresAtMonotonicMs) {
        record.secretBytes.fill(0);
        this.records.delete(locator);
      }
    }
  }

  issue(
    companionUrl,
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    this.purge(wallMs, monotonicMs);
    if (this.records.size >= this.maximumActive) {
      failContract("invitation_capacity", "The active invitation limit has been reached.");
    }
    const invitation = createQrInvitation({ companionUrl, randomBytes: this.randomBytes, nowMs: wallMs });
    const secretBytes = base64UrlToBytes(invitation.secret, "secret");
    this.records.set(invitation.locator, {
      secretBytes,
      expiresAtMs: invitation.expiresAtMs,
      expiresAtMonotonicMs: monotonicMs + QR_INVITATION_TTL_MS,
      consumedAtMs: null,
    });
    return invitation;
  }

  consume(
    value,
    wallNowMs = this.wallNow(),
    monotonicNowMs = this.monotonicNow(),
  ) {
    const wallMs = clockMilliseconds(wallNowMs, "wallNowMs");
    const monotonicMs = clockMilliseconds(monotonicNowMs, "monotonicNowMs");
    const locator = value?.locator;
    const secret = value?.secret;
    let presented;
    try {
      assertToken(locator, "locator", { minimum: 8, maximum: 96 });
      presented = parseInvitationSecret(secret);
    } catch {
      return invalidInvitation;
    }
    const record = this.records.get(locator);
    if (!record) {
      presented.fill(0);
      return invalidInvitation;
    }
    if (record.consumedAtMs !== null) {
      presented.fill(0);
      return invalidInvitation;
    }
    if (wallMs >= record.expiresAtMs || monotonicMs >= record.expiresAtMonotonicMs) {
      presented.fill(0);
      record.secretBytes.fill(0);
      this.records.delete(locator);
      return invalidInvitation;
    }
    const matches = equalBytes(record.secretBytes, presented);
    presented.fill(0);
    if (!matches) {
      return invalidInvitation;
    }
    record.consumedAtMs = wallMs;
    record.secretBytes.fill(0);
    return Object.freeze({ ok: true, locator, consumedAtMs: wallMs });
  }

  revoke(locator) {
    const record = this.records.get(locator);
    record?.secretBytes.fill(0);
    return this.records.delete(locator);
  }

  revokeAll() {
    for (const record of this.records.values()) record.secretBytes.fill(0);
    this.records.clear();
  }

  status(wallNowMs = this.wallNow(), monotonicNowMs = this.monotonicNow()) {
    this.purge(wallNowMs, monotonicNowMs);
    return Object.freeze([...this.records].map(([locator, record]) => Object.freeze({
      locator,
      expiresAtMs: record.expiresAtMs,
      status: "active",
    })));
  }
}
