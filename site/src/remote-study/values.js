const encoder = new TextEncoder();

export const REMOTE_STUDY_UNSAFE_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
]);

const unsafeKeys = new Set(REMOTE_STUDY_UNSAFE_KEYS);
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export class RemoteStudyContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RemoteStudyContractError";
    this.code = code;
  }
}

export function failContract(code, message) {
  throw new RemoteStudyContractError(code, message);
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainRecord(value, name = "value") {
  if (!isPlainRecord(value)) {
    failContract("invalid_object", `${name} must be a plain object.`);
  }
  return value;
}

export function assertExactKeys(value, expected, name = "value") {
  assertPlainRecord(value, name);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    failContract("unexpected_fields", `${name} must not contain symbol fields.`);
  }
  const actual = ownKeys.sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    failContract("unexpected_fields", `${name} must contain exactly: ${wanted.join(", ")}.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      failContract("invalid_object", `${name}.${key} must be an enumerable data property.`);
    }
  }
  return value;
}

export function assertToken(value, name, { minimum = 1, maximum = 64 } = {}) {
  if (typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || !tokenPattern.test(value)) {
    failContract("invalid_token", `${name} must be a ${minimum}-${maximum} character protocol token.`);
  }
  return value;
}

export function assertBoundedText(value, name, { minimum = 0, maximum = 256 } = {}) {
  if (typeof value !== "string") failContract("invalid_text", `${name} must be text.`);
  const length = Array.from(value).length;
  if (length < minimum || length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    failContract("invalid_text", `${name} must contain ${minimum}-${maximum} display-safe characters.`);
  }
  return value;
}

export function assertSafeInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failContract("invalid_integer", `${name} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function assertFiniteRange(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    failContract("invalid_number", `${name} must be finite and between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function utf8ByteLength(value) {
  return encoder.encode(String(value)).byteLength;
}

function assertDensePlainArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    failContract("invalid_array", `${name} must be an ordinary array.`);
  }
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      failContract("invalid_array", `${name} must not be sparse.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      failContract("invalid_array", `${name} must contain only data properties.`);
    }
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      failContract("invalid_array", `${name} must not contain extra properties.`);
    }
  }
}

export function assertBoundedJson(value, options = {}) {
  const {
    name = "value",
    maximumDepth = 8,
    maximumArrayLength = 256,
    maximumObjectFields = 128,
    maximumFieldLength = 96,
    maximumStringLength = 4096,
    maximumNodes = 4096,
    maximumAggregateStringLength = 64 * 1024,
  } = options;

  let visitedNodes = 0;
  let aggregateStringLength = 0;

  const visit = (current, depth, path) => {
    visitedNodes += 1;
    if (visitedNodes > maximumNodes) {
      failContract("json_too_large", `${name} exceeds the value-count limit.`);
    }
    if (depth > maximumDepth) failContract("json_too_deep", `${name} exceeds the nesting limit.`);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) failContract("invalid_number", `${path} must be finite.`);
      return;
    }
    if (typeof current === "string") {
      const stringLength = Array.from(current).length;
      aggregateStringLength += stringLength;
      if (stringLength > maximumStringLength) {
        failContract("string_too_long", `${path} exceeds the string limit.`);
      }
      if (aggregateStringLength > maximumAggregateStringLength) {
        failContract("json_too_large", `${name} exceeds the aggregate text limit.`);
      }
      return;
    }
    if (Array.isArray(current)) {
      assertDensePlainArray(current, path);
      if (current.length > maximumArrayLength) {
        failContract("array_too_large", `${path} exceeds the array limit.`);
      }
      current.forEach((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      return;
    }
    assertPlainRecord(current, path);
    const keys = Reflect.ownKeys(current);
    if (keys.some((key) => typeof key !== "string")) {
      failContract("invalid_object", `${path} must not contain symbol properties.`);
    }
    if (keys.length > maximumObjectFields) {
      failContract("object_too_large", `${path} exceeds the field limit.`);
    }
    for (const key of keys) {
      if (!key || key.length > maximumFieldLength || unsafeKeys.has(key)) {
        failContract("unsafe_field", `${path} contains an invalid field name.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) {
        failContract("invalid_object", `${path}.${key} must be a data property.`);
      }
      visit(descriptor.value, depth + 1, `${path}.${key}`);
    }
  };

  visit(value, 0, name);
  return value;
}

function canonicalEncode(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalEncode(value[key])}`
  )).join(",")}}`;
}

export function canonicalStringify(value, options) {
  assertBoundedJson(value, options);
  return canonicalEncode(value);
}

export function cloneBoundedJson(value, options) {
  return JSON.parse(canonicalStringify(value, options));
}

export function bytesFrom(value, name = "value") {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  failContract("invalid_bytes", `${name} must be an ArrayBuffer or byte view.`);
}

export function bytesToBase64Url(value) {
  const bytes = bytesFrom(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value, name = "value") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    failContract("invalid_base64url", `${name} must be unpadded base64url text.`);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    failContract("invalid_base64url", `${name} must be valid base64url text.`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) {
    failContract("invalid_base64url", `${name} is not canonically encoded.`);
  }
  return bytes;
}
