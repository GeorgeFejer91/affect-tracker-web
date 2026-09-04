const encoder = new TextEncoder();

function canonicalValue(value, path, seen, omitRootKeys, root) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain a non-finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a value that JSON cannot represent.`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a circular reference.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((member, index) => canonicalValue(
        member,
        `${path}[${index}]`,
        seen,
        omitRootKeys,
        false,
      ));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} must contain only plain JSON objects.`);
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (root && omitRootKeys.has(key)) continue;
      output[key] = canonicalValue(value[key], `${path}.${key}`, seen, omitRootKeys, false);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value, { omitRootKeys = [] } = {}) {
  if (!Array.isArray(omitRootKeys) || omitRootKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("omitRootKeys must be an array of strings.");
  }
  return JSON.stringify(canonicalValue(value, "$", new Set(), new Set(omitRootKeys), true));
}

export async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 requires the Web Crypto API.");
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 input must be text or Uint8Array bytes.");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalBytes(value, options) {
  return encoder.encode(canonicalJson(value, options));
}

export function canonicalSha256(value, options) {
  return sha256Hex(canonicalBytes(value, options));
}
