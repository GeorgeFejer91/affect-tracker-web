import { normalizeRemoteStudyScopes } from "./contracts.js";
import { normalizePasswordText } from "./password-policy.js";
import {
  assertExactKeys,
  assertSafeInteger,
  assertToken,
  bytesFrom,
  base64UrlToBytes,
  canonicalStringify,
  failContract,
} from "./values.js";

export const OPAQUE_REMOTE_STUDY_PROFILE = "affect-tracker-opaque-rfc9807-v1";
export const OPAQUE_MAX_MESSAGE_BYTES = 16 * 1024;
export const OPAQUE_MIN_SESSION_KEY_BYTES = 32;
export const OPAQUE_LIBRARY_PINS = Object.freeze({
  rust: "opaque-ke@4.0.1",
  browser: "@serenity-kit/opaque@1.1.0",
});
export const OPAQUE_KEY_LABELS = Object.freeze({
  brspProof: "affect-tracker/brsp-proof/v1",
  privateTransport: "affect-tracker/private-vdo-transport/v1",
});

const contextEncoder = new TextEncoder();

function assertOpaqueNonce(value, name) {
  if (typeof value !== "string" || value.length < 22 || value.length > 86) {
    failContract("weak_nonce", `${name} must contain 128-512 random bits.`);
  }
  const bytes = base64UrlToBytes(value, name);
  if (bytes.byteLength < 16 || bytes.byteLength > 64) {
    failContract("weak_nonce", `${name} must contain 128-512 random bits.`);
  }
  return bytes;
}

function assertByteLength(value, name, { minimum = 1, maximum = OPAQUE_MAX_MESSAGE_BYTES } = {}) {
  const bytes = bytesFrom(value, name);
  if (bytes.byteLength < minimum || bytes.byteLength > maximum) {
    failContract("invalid_opaque_bytes", `${name} has an invalid byte length.`);
  }
  return bytes;
}

export function createOpaqueLoginContext(value) {
  assertExactKeys(value, [
    "stationId",
    "authorityGeneration",
    "clientIdentity",
    "serverIdentity",
    "clientNonce",
    "serverNonce",
    "requestedScopes",
  ], "OPAQUE context");
  assertToken(value.stationId, "stationId", { minimum: 8, maximum: 64 });
  assertSafeInteger(value.authorityGeneration, "authorityGeneration", { minimum: 1 });
  assertToken(value.clientIdentity, "clientIdentity", { minimum: 8, maximum: 96 });
  assertToken(value.serverIdentity, "serverIdentity", { minimum: 8, maximum: 96 });
  assertOpaqueNonce(value.clientNonce, "clientNonce");
  assertOpaqueNonce(value.serverNonce, "serverNonce");
  const requestedScopes = normalizeRemoteStudyScopes(value.requestedScopes);
  const context = {
    profile: OPAQUE_REMOTE_STUDY_PROFILE,
    version: 1,
    stationId: value.stationId,
    authorityGeneration: value.authorityGeneration,
    clientIdentity: value.clientIdentity,
    serverIdentity: value.serverIdentity,
    clientNonce: value.clientNonce,
    serverNonce: value.serverNonce,
    requestedScopes,
  };
  return contextEncoder.encode(canonicalStringify(context));
}

export function assertOpaqueClientAdapter(adapter) {
  if (!adapter || typeof adapter.startLogin !== "function" || typeof adapter.finishLogin !== "function") {
    failContract(
      "opaque_adapter_unavailable",
      "The OPAQUE adapter must provide startLogin and finishLogin operations.",
    );
  }
  return adapter;
}

export function assertSessionKeyDeriver(adapter) {
  if (!adapter || typeof adapter.deriveKey !== "function") {
    failContract("key_deriver_unavailable", "The key adapter must provide deriveKey.");
  }
  return adapter;
}

export class OpaqueClientLogin {
  constructor({ opaqueAdapter, keyDeriver }) {
    this.opaqueAdapter = assertOpaqueClientAdapter(opaqueAdapter);
    this.keyDeriver = assertSessionKeyDeriver(keyDeriver);
    this.phase = "idle";
    this.clientState = undefined;
    this.context = undefined;
  }

  async start({ passwordText, context }) {
    if (this.phase !== "idle") failContract("opaque_state", "OPAQUE login has already started.");
    const normalizedPassword = normalizePasswordText(passwordText);
    const contextBytes = createOpaqueLoginContext(context);
    const result = await this.opaqueAdapter.startLogin({
      password: normalizedPassword,
      context: contextBytes,
      profile: OPAQUE_REMOTE_STUDY_PROFILE,
    });
    if (!result || !("state" in result)) {
      failContract("opaque_adapter_result", "OPAQUE start did not return client state.");
    }
    const request = assertByteLength(result.request, "OPAQUE credential request");
    this.clientState = result.state;
    this.context = contextBytes;
    this.phase = "awaiting-response";
    return Object.freeze({ profile: OPAQUE_REMOTE_STUDY_PROFILE, request });
  }

  async finish(response) {
    if (this.phase !== "awaiting-response") {
      failContract("opaque_state", "OPAQUE login is not waiting for a server response.");
    }
    const state = this.clientState;
    const context = this.context;
    this.clientState = undefined;
    this.phase = "finishing";
    let sessionKey;
    let brspProofKey;
    let privateTransportKey;
    try {
      const responseBytes = assertByteLength(response, "OPAQUE credential response");
      const result = await this.opaqueAdapter.finishLogin({
        state,
        response: responseBytes,
        context,
        profile: OPAQUE_REMOTE_STUDY_PROFILE,
      });
      sessionKey = assertByteLength(result?.sessionKey, "OPAQUE session key", {
        minimum: OPAQUE_MIN_SESSION_KEY_BYTES,
        maximum: 256,
      });
      const clientFinish = result?.clientFinish === undefined
        ? undefined
        : assertByteLength(result.clientFinish, "OPAQUE client finish");
      brspProofKey = assertByteLength(await this.keyDeriver.deriveKey({
        sessionKey,
        label: OPAQUE_KEY_LABELS.brspProof,
        context,
        length: 32,
      }), "BRSP proof key", { minimum: 32, maximum: 32 });
      privateTransportKey = assertByteLength(await this.keyDeriver.deriveKey({
        sessionKey,
        label: OPAQUE_KEY_LABELS.privateTransport,
        context,
        length: 32,
      }), "private transport key", { minimum: 32, maximum: 32 });
      if (brspProofKey.every((byte, index) => byte === privateTransportKey[index])) {
        failContract("key_separation_failed", "OPAQUE-derived purpose keys must be distinct.");
      }
      this.phase = "complete";
      return Object.freeze({ brspProofKey, privateTransportKey, clientFinish });
    } catch (error) {
      brspProofKey?.fill(0);
      privateTransportKey?.fill(0);
      this.phase = "failed";
      throw error;
    } finally {
      sessionKey?.fill(0);
      this.context = undefined;
    }
  }

  clear() {
    this.clientState = undefined;
    this.context = undefined;
    if (this.phase !== "complete") this.phase = "cleared";
  }
}

export const UNIFORM_AUTHENTICATION_FAILURE = Object.freeze({
  ok: false,
  error: "authentication_failed",
});
