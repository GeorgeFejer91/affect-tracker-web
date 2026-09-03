import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMMAND_DEDUPE_MAX_ENTRIES,
  COMMON_PASSWORD_BLOCKLIST,
  CONTROLLER_LEASE_MS,
  CommandDedupeCache,
  ControllerLease,
  OPAQUE_KEY_LABELS,
  OPAQUE_LIBRARY_PINS,
  OpaqueClientLogin,
  OneTimeInvitationStore,
  QR_INVITATION_SECRET_BYTES,
  QR_INVITATION_TTL_MS,
  REMOTE_STUDY_LANE_POLICIES,
  RemoteStudyLaneBuffers,
  base64UrlToBytes,
  bytesToBase64Url,
  createQrInvitation,
  createRemoteStudyRateLimiters,
  createStudyCommand,
  normalizePasswordText,
  parseQrInvitationUrl,
  readAndClearQrInvitation,
  remoteStudyCompanionLocationPolicy,
} from "../site/src/remote-study/index.js";

function deterministicRandom() {
  let call = 0;
  return (length) => Uint8Array.from({ length }, (_, index) => (index + 1 + call++) & 0xff);
}

function command(commandId = "command_0001", overrides = {}) {
  return createStudyCommand({
    authorityGeneration: 1,
    principalId: "principal_01",
    commandId,
    expectedRevision: 3,
    runId: "run_01",
    precondition: { phase: "armed", blockId: "block_01" },
    scope: "study.control",
    action: "start",
    payload: {},
    ...overrides,
  });
}

function grant(overrides = {}) {
  return {
    grantId: "grant_0001",
    authorityGeneration: 1,
    principalId: "principal_01",
    principalLabel: "Research tablet",
    authenticationMethod: "qr-invitation",
    scopes: ["study.observe", "study.control"],
    issuedAtMs: 0,
    expiresAtMs: 120_000,
    revoked: false,
    ...overrides,
  };
}

test("QR invitations keep at least 192 secret bits in the fragment and enforce origin", () => {
  const invitation = createQrInvitation({
    companionUrl: "https://example.test/affect/remote?mode=controller",
    randomBytes: deterministicRandom(),
    nowMs: 1_000,
  });
  const url = new URL(invitation.url);
  assert.equal(url.searchParams.has("secret"), false);
  assert.equal(url.hash.includes("secret="), true);
  assert.equal(base64UrlToBytes(invitation.secret).byteLength, QR_INVITATION_SECRET_BYTES);
  assert.equal(invitation.expiresAtMs, 1_000 + QR_INVITATION_TTL_MS);
  assert.deepEqual(parseQrInvitationUrl(invitation.url, { expectedOrigin: "https://example.test" }), {
    locator: invitation.locator,
    secret: invitation.secret,
  });
  assert.throws(
    () => parseQrInvitationUrl(invitation.url, { expectedOrigin: "https://attacker.test" }),
    { code: "wrong_origin" },
  );
  assert.throws(
    () => parseQrInvitationUrl(invitation.url, {
      expectedOrigin: "https://example.test",
      expectedPathname: "/another-controller.html",
    }),
    { code: "wrong_path" },
  );
  const overlongSecretUrl = new URL(invitation.url);
  overlongSecretUrl.hash = new URLSearchParams({
    invite: invitation.locator,
    secret: bytesToBase64Url(new Uint8Array(QR_INVITATION_SECRET_BYTES + 1).fill(1)),
  }).toString();
  assert.throws(
    () => parseQrInvitationUrl(overlongSecretUrl.toString(), { expectedOrigin: "https://example.test" }),
    { code: "weak_invitation_secret" },
  );
  assert.throws(() => createQrInvitation({
    companionUrl: "https://example.test/remote?secret=leak",
    randomBytes: deterministicRandom(),
  }), { code: "secret_in_query" });
});

test("the public controller pins its production origin and path with only a loopback development exception", () => {
  assert.deepEqual(remoteStudyCompanionLocationPolicy({
    href: "https://attacker.test/copied/study-remote.html#secret",
  }), {
    expectedOrigin: "https://georgefejer91.github.io",
    expectedPathname: "/affect-tracker-web/study-remote.html",
  });
  assert.deepEqual(remoteStudyCompanionLocationPolicy({
    href: "http://127.0.0.1:8000/study-remote.html#secret",
  }), {
    expectedOrigin: "http://127.0.0.1:8000",
    expectedPathname: "/study-remote.html",
  });
  assert.deepEqual(remoteStudyCompanionLocationPolicy({
    href: "http://localhost:9000/nested/study-remote.html",
  }), {
    expectedOrigin: "http://localhost:9000",
    expectedPathname: "/nested/study-remote.html",
  });
});

test("QR creation and parsing narrowly permit the pinned HTTP loopback development page", () => {
  const invitation = createQrInvitation({
    companionUrl: "http://127.0.0.1:8000/nested/study-remote.html?mode=controller",
    randomBytes: deterministicRandom(),
    nowMs: 1_000,
  });
  assert.deepEqual(parseQrInvitationUrl(invitation.url, {
    expectedOrigin: "http://127.0.0.1:8000",
    expectedPathname: "/nested/study-remote.html",
  }), {
    locator: invitation.locator,
    secret: invitation.secret,
  });
  assert.throws(() => createQrInvitation({
    companionUrl: "http://example.test/study-remote.html",
    randomBytes: deterministicRandom(),
  }), { code: "invalid_companion_url" });
  assert.throws(() => createQrInvitation({
    companionUrl: "http://localhost:8000/controller.html",
    randomBytes: deterministicRandom(),
  }), { code: "invalid_companion_url" });
});

test("the companion clears the URL fragment immediately and keeps parsed material in memory", () => {
  const invitation = createQrInvitation({
    companionUrl: "https://example.test/remote",
    randomBytes: deterministicRandom(),
    nowMs: 0,
  });
  const calls = [];
  const history = {
    state: { route: "remote" },
    replaceState(...args) { calls.push(args); },
  };
  const parsed = readAndClearQrInvitation({
    location: { href: invitation.url },
    history,
    expectedOrigin: "https://example.test",
  });
  assert.equal(parsed.secret, invitation.secret);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0][2]).hash, "");
  assert.equal(calls[0][2].includes(invitation.secret), false);
});

test("the companion clears its bearer fragment before lazily loading the same-realm VDO transport", async () => {
  const [html, controllerApp] = await Promise.all([
    readFile("site/study-remote.html", "utf8"),
    readFile("site/src/remote-study/controller-app.js", "utf8"),
  ]);
  assert.doesNotMatch(html, /<script[^>]+vdoninja-sdk/iu);
  assert.match(html, /loaded only after Connect, in the same browser realm/iu);
  const clearIndex = controllerApp.indexOf("invitation = readAndClearQrInvitation");
  const loadIndex = controllerApp.indexOf("await loadPinnedVdoSdk()");
  assert.ok(clearIndex >= 0);
  assert.ok(loadIndex > clearIndex, "invitation capture and replaceState must run before VDO is loaded");
});

test("QR invitation registry expires at ten minutes and consumes a secret once", () => {
  let now = 10_000;
  const store = new OneTimeInvitationStore({
    randomBytes: deterministicRandom(),
    now: () => now,
  });
  const first = store.issue("https://example.test/remote");
  assert.deepEqual(store.consume({ locator: first.locator, secret: "A".repeat(32) }), {
    ok: false,
    error: "invitation_invalid",
  });
  assert.equal(store.consume(first).ok, true);
  assert.equal(store.consume(first).ok, false);

  const second = store.issue("https://example.test/remote");
  const retainedRecord = store.records.get(second.locator);
  now = second.expiresAtMs;
  assert.equal(store.consume(second).ok, false);
  assert.ok(retainedRecord.secretBytes.every((byte) => byte === 0));
  assert.equal(store.status().length, 0);
  assert.deepEqual(store.consume({ locator: "!", secret: "not-base64" }), {
    ok: false,
    error: "invitation_invalid",
  });
  assert.deepEqual(store.consume(null), {
    ok: false,
    error: "invitation_invalid",
  });
});

test("QR invitation expiry survives wall-clock rollback and large forward wall jumps", () => {
  let wallNowMs = 100_000;
  let monotonicNowMs = 5_000;
  const store = new OneTimeInvitationStore({
    randomBytes: deterministicRandom(),
    wallNow: () => wallNowMs,
    monotonicNow: () => monotonicNowMs,
  });

  const rollbackInvitation = store.issue("https://example.test/remote");
  wallNowMs = 10_000;
  monotonicNowMs += QR_INVITATION_TTL_MS;
  assert.deepEqual(store.consume(rollbackInvitation), {
    ok: false,
    error: "invitation_invalid",
  });

  wallNowMs = 200_000;
  monotonicNowMs = 20_000;
  const forwardJumpInvitation = store.issue("https://example.test/remote");
  wallNowMs += QR_INVITATION_TTL_MS;
  assert.deepEqual(store.consume(forwardJumpInvitation), {
    ok: false,
    error: "invitation_invalid",
  });
});

test("password text strips only BOM and one terminal newline, then NFC-normalizes", () => {
  const input = "\uFEFFCafe\u0301 secure laboratory passphrase\r\n";
  assert.equal(normalizePasswordText(input), "Caf\u00e9 secure laboratory passphrase");
  assert.equal(
    normalizePasswordText("preserve  two spaces and newline\n\n"),
    "preserve  two spaces and newline\n",
  );
  assert.ok(COMMON_PASSWORD_BLOCKLIST.includes("correcthorsebatterystaple"));
  assert.throws(() => normalizePasswordText("correcthorsebatterystaple"), {
    code: "common_password",
  });
  assert.throws(() => normalizePasswordText("too short"), { code: "invalid_length" });
  assert.throws(() => normalizePasswordText("x".repeat(129)), { code: "invalid_length" });
});

test("public-beacon and proof throttles are independent bounded windows", () => {
  let now = 0;
  const limiters = createRemoteStudyRateLimiters({ now: () => now, maximumKeys: 2 });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(limiters.proof.consume("requester_01").allowed, true);
  }
  const denied = limiters.proof.consume("requester_01");
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "rate_limited");
  assert.equal(limiters.beacon.consume("requester_01").allowed, true);
  now = 5 * 60_000;
  assert.equal(limiters.proof.consume("requester_01").allowed, true);
});

test("one controller owns a 15-second semantic lease and Ping cannot renew it", () => {
  let now = 0;
  const lease = new ControllerLease({ now: () => now });
  assert.equal(CONTROLLER_LEASE_MS, 15_000);
  assert.equal(lease.claim(grant()).active, true);
  assert.throws(() => lease.claim(grant({
    grantId: "grant_0002",
    principalId: "principal_02",
    principalLabel: "Other browser",
  })), { code: "controller_busy" });

  now = 10_000;
  assert.equal(lease.claim(grant()).expiresAtMs, 15_000);
  assert.deepEqual(lease.renew({
    authorityGeneration: 1,
    principalId: "principal_01",
    grantId: "grant_0001",
    frameKind: "transport-ping",
  }), { renewed: false, error: "non_semantic_frame" });
  now = 15_000;
  assert.equal(lease.snapshot().active, false);
  assert.equal(lease.snapshot().lastRevocation.reason, "lease_expired");

  now = 20_000;
  lease.claim(grant({ issuedAtMs: 20_000 }));
  now = 30_000;
  assert.equal(lease.renew({
    authorityGeneration: 1,
    principalId: "principal_01",
    grantId: "grant_0001",
    frameKind: "application-control",
  }).expiresAtMs, 45_000);
});

test("controller lease expiry survives wall-clock rollback and large forward wall jumps", () => {
  let wallNowMs = 100_000;
  let monotonicNowMs = 5_000;
  const lease = new ControllerLease({
    wallNow: () => wallNowMs,
    monotonicNow: () => monotonicNowMs,
  });
  lease.claim(grant({
    issuedAtMs: wallNowMs,
    expiresAtMs: wallNowMs + 120_000,
  }));

  wallNowMs = 10_000;
  monotonicNowMs += CONTROLLER_LEASE_MS;
  assert.equal(lease.snapshot().active, false);
  assert.equal(lease.snapshot().lastRevocation.reason, "lease_expired");

  wallNowMs = 200_000;
  monotonicNowMs = 30_000;
  lease.claim(grant({
    issuedAtMs: wallNowMs,
    expiresAtMs: wallNowMs + 120_000,
  }));
  wallNowMs += CONTROLLER_LEASE_MS;
  assert.equal(lease.snapshot().active, false);
  assert.equal(lease.snapshot().lastRevocation.reason, "lease_expired");
});

test("dedupe is namespaced by generation/principal and rejects changed bodies", async () => {
  let now = 0;
  const cache = new CommandDedupeCache({ now: () => now, maximumEntries: 4 });
  assert.equal(COMMAND_DEDUPE_MAX_ENTRIES, 512);
  let applications = 0;
  const first = await cache.execute(command(), async () => {
    applications += 1;
    return { ok: true, revision: 4, result: { started: true } };
  });
  const duplicate = await cache.execute(command(), () => {
    applications += 1;
    return { ok: true, revision: 99 };
  });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.outcome, first.outcome);
  assert.equal(applications, 1);
  await assert.rejects(
    () => cache.execute(command("command_0001", { expectedRevision: 4 }), () => ({})),
    { code: "command_id_conflict" },
  );

  await cache.execute(command("command_0001", {
    authorityGeneration: 2,
  }), () => {
    applications += 1;
    return { ok: true, revision: 1 };
  });
  await cache.execute(command("command_0001", {
    principalId: "principal_02",
  }), () => {
    applications += 1;
    return { ok: true, revision: 1 };
  });
  assert.equal(applications, 3);
  assert.throws(() => cache.clearAuthorityGeneration("generation_01"), {
    code: "invalid_integer",
  });
});

test("concurrent identical retries share one in-flight application", async () => {
  const cache = new CommandDedupeCache();
  let resolveApply;
  let applications = 0;
  const pending = new Promise((resolve) => { resolveApply = resolve; });
  const first = cache.execute(command(), async () => {
    applications += 1;
    return pending;
  });
  await Promise.resolve();
  const second = cache.execute(command(), () => {
    applications += 1;
    return { ok: false };
  });
  resolveApply({ ok: true, revision: 4 });
  const [left, right] = await Promise.all([first, second]);
  assert.equal(applications, 1);
  assert.equal(left.duplicate, false);
  assert.equal(right.duplicate, true);
  assert.deepEqual(left.outcome, right.outcome);
});

test("state is newest-only while record/export saturation cannot consume control capacity", () => {
  const lanes = new RemoteStudyLaneBuffers();
  lanes.offer("state", "old");
  lanes.offer("state", "new");
  assert.equal(new TextDecoder().decode(lanes.take("state")), "new");
  assert.equal(lanes.snapshot().state.replaced, 1);

  const exportChunk = new Uint8Array(REMOTE_STUDY_LANE_POLICIES.export.maximumMessageBytes);
  for (let index = 0; index < REMOTE_STUDY_LANE_POLICIES.export.maximumQueuedMessages; index += 1) {
    assert.equal(lanes.offer("export", exportChunk).accepted, true);
  }
  assert.equal(lanes.offer("export", exportChunk).accepted, false);
  assert.equal(lanes.offer("control", "stop-now").accepted, true);
  assert.equal(new TextDecoder().decode(lanes.take("control")), "stop-now");
});

test("OPAQUE seam delegates PAKE and derives distinct labelled keys without password HMAC", async () => {
  assert.deepEqual(OPAQUE_LIBRARY_PINS, {
    rust: "opaque-ke@4.0.1",
    browser: "@serenity-kit/opaque@1.1.0",
  });
  const calls = [];
  const login = new OpaqueClientLogin({
    opaqueAdapter: {
      async startLogin(input) {
        calls.push(["start", input]);
        return { state: { opaque: true }, request: Uint8Array.of(1, 2, 3) };
      },
      async finishLogin(input) {
        calls.push(["finish", input]);
        return { sessionKey: new Uint8Array(32).fill(7), clientFinish: Uint8Array.of(4, 5) };
      },
    },
    keyDeriver: {
      async deriveKey({ label }) {
        calls.push(["derive", label]);
        return new Uint8Array(32).fill(label === OPAQUE_KEY_LABELS.brspProof ? 1 : 2);
      },
    },
  });
  const context = {
    stationId: "station_01",
    authorityGeneration: 1,
    clientIdentity: "principal_01",
    serverIdentity: "desktop_01",
    clientNonce: bytesToBase64Url(new Uint8Array(16).fill(1)),
    serverNonce: bytesToBase64Url(new Uint8Array(16).fill(2)),
    requestedScopes: ["study.observe", "study.control"],
  };
  const started = await login.start({
    passwordText: "Cafe\u0301 secure laboratory passphrase\n",
    context,
  });
  assert.deepEqual([...started.request], [1, 2, 3]);
  assert.equal(calls[0][1].password, "Caf\u00e9 secure laboratory passphrase");
  const completed = await login.finish(Uint8Array.of(9, 8, 7));
  assert.equal(completed.brspProofKey[0], 1);
  assert.equal(completed.privateTransportKey[0], 2);
  assert.deepEqual(calls.filter(([kind]) => kind === "derive").map(([, label]) => label), [
    OPAQUE_KEY_LABELS.brspProof,
    OPAQUE_KEY_LABELS.privateTransport,
  ]);
  assert.equal(login.phase, "complete");
});

test("OPAQUE finish failures discard state and reject malformed derived keys", async () => {
  const login = new OpaqueClientLogin({
    opaqueAdapter: {
      async startLogin() {
        return { state: { opaque: true }, request: Uint8Array.of(1) };
      },
      async finishLogin() {
        return { sessionKey: new Uint8Array(32).fill(3) };
      },
    },
    keyDeriver: {
      async deriveKey() { return new Uint8Array(31).fill(1); },
    },
  });
  await login.start({
    passwordText: "a sufficiently long lab password",
    context: {
      stationId: "station_01",
      authorityGeneration: 1,
      clientIdentity: "principal_01",
      serverIdentity: "desktop_01",
      clientNonce: bytesToBase64Url(new Uint8Array(16).fill(1)),
      serverNonce: bytesToBase64Url(new Uint8Array(16).fill(2)),
      requestedScopes: ["study.observe"],
    },
  });
  await assert.rejects(() => login.finish(Uint8Array.of(9)), { code: "invalid_opaque_bytes" });
  assert.equal(login.phase, "failed");
  assert.equal(login.context, undefined);
  await assert.rejects(() => login.finish(Uint8Array.of(9)), { code: "opaque_state" });
});
