const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

export class StudyStorageError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class StudyStorageValidationError extends StudyStorageError {
  constructor(message, options) {
    super(message, "STUDY_STORAGE_VALIDATION", options);
  }
}

export class StudyStorageConflictError extends StudyStorageError {
  constructor(message, options) {
    super(message, "STUDY_STORAGE_CONFLICT", options);
  }
}

export class StudyStorageStateError extends StudyStorageError {
  constructor(message, options) {
    super(message, "STUDY_STORAGE_STATE", options);
  }
}

export class StudyStorageQuotaError extends StudyStorageError {
  constructor(message, options) {
    super(message, "STUDY_STORAGE_QUOTA", options);
  }
}

export function assertIdentifier(value, label = "identifier") {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new StudyStorageValidationError(
      `${label} must be 1–128 ASCII letters, digits, dots, underscores, colons, or hyphens.`,
    );
  }
  return value;
}

export function assertSha256(value, label = "SHA-256") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new StudyStorageValidationError(`${label} must be a lowercase 64-character SHA-256 digest.`);
  }
  return value;
}

export function assertSafeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new StudyStorageValidationError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function jsonByteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return encoder.encode(text).byteLength;
}

export function cloneJson(value, {
  label = "value",
  maxBytes = Number.POSITIVE_INFINITY,
  maxDepth = 64,
  maxNodes = 100_000,
} = {}) {
  let nodes = 0;
  const active = new WeakSet();

  function visit(current, path, depth) {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new StudyStorageValidationError(`${label} contains too many JSON values.`);
    }
    if (depth > maxDepth) {
      throw new StudyStorageValidationError(`${label} exceeds the maximum JSON depth of ${maxDepth}.`);
    }
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new StudyStorageValidationError(`${path} must be a finite JSON number.`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new StudyStorageValidationError(`${path} must contain JSON data only.`);
    }
    if (active.has(current)) {
      throw new StudyStorageValidationError(`${label} must not contain a cyclic reference.`);
    }
    active.add(current);

    if (Array.isArray(current)) {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        const index = typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
        if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
          throw new StudyStorageValidationError(`${path} contains a non-JSON array property.`);
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new StudyStorageValidationError(`${path} must not contain sparse arrays.`);
        }
        visit(descriptor.value, `${path}[${index}]`, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new StudyStorageValidationError(`${path} must be a plain JSON object.`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
          throw new StudyStorageValidationError(`${path} contains a forbidden property name.`);
        }
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new StudyStorageValidationError(`${path}.${key} must be an enumerable data property.`);
        }
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    }
    active.delete(current);
  }

  visit(value, label, 0);
  const serialized = JSON.stringify(value);
  const size = jsonByteLength(serialized);
  if (size > maxBytes) {
    throw new StudyStorageValidationError(`${label} is ${size} bytes; the limit is ${maxBytes} bytes.`);
  }
  return JSON.parse(serialized);
}

export function freezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

export function immutableJson(value, options) {
  return freezeJson(cloneJson(value, options));
}

export function isoTimestamp(value, label = "timestamp") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new StudyStorageValidationError(`${label} must be a valid date.`);
  }
  return date.toISOString();
}

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError"
    || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
    || error?.code === 22
    || error instanceof StudyStorageQuotaError;
}

export function asStorageError(error, operation) {
  if (error instanceof StudyStorageError) return error;
  if (isQuotaError(error)) {
    return new StudyStorageQuotaError(`${operation} exceeded the browser's local storage quota.`, { cause: error });
  }
  return error;
}
