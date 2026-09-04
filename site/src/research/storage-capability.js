const BYTE_LIMIT = Number.MAX_SAFE_INTEGER;

export class ResearchStorageCapabilityError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ResearchStorageCapabilityError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ResearchStorageCapabilityError(code, message, options);
}

function byteCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > BYTE_LIMIT) {
    fail("invalid-storage-estimate", `${label} must be a non-negative safe byte count.`);
  }
  return value;
}

export async function probeBrowserStorage({
  storageManager = globalThis.navigator?.storage,
  requestPersistence = false,
  requiredBytes = 0,
} = {}) {
  requiredBytes = byteCount(requiredBytes, "requiredBytes");
  if (!storageManager || typeof storageManager.estimate !== "function") {
    fail("storage-api-unavailable", "This browser cannot estimate durable Research journal storage.");
  }

  let estimate;
  try {
    estimate = await storageManager.estimate();
  } catch (error) {
    fail("storage-estimate-failed", "Browser storage estimation failed.", { cause: error });
  }
  const usageBytes = byteCount(Math.floor(estimate?.usage ?? Number.NaN), "storage usage");
  const quotaBytes = byteCount(Math.floor(estimate?.quota ?? Number.NaN), "storage quota");
  if (usageBytes > quotaBytes) {
    fail("invalid-storage-estimate", "Browser storage usage exceeds its reported quota.");
  }

  let persisted = false;
  if (typeof storageManager.persisted === "function") {
    try {
      persisted = await storageManager.persisted() === true;
    } catch (error) {
      fail("storage-persistence-check-failed", "Browser storage persistence could not be checked.", { cause: error });
    }
  }
  let persistenceRequested = false;
  if (requestPersistence && !persisted && typeof storageManager.persist === "function") {
    persistenceRequested = true;
    try {
      persisted = await storageManager.persist() === true;
    } catch (error) {
      fail("storage-persistence-request-failed", "Browser storage persistence could not be requested.", { cause: error });
    }
  }

  const availableBytes = quotaBytes - usageBytes;
  return Object.freeze({
    usageBytes,
    quotaBytes,
    availableBytes,
    requiredBytes,
    sufficient: availableBytes >= requiredBytes,
    persisted,
    persistenceRequested,
  });
}

