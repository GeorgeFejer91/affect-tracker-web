function assertSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

export async function sha256PortableFile(file, crypto = globalThis.crypto) {
  if (!file || typeof file.arrayBuffer !== "function" || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new TypeError("Portable media must be a finite browser File or Blob.");
  }
  if (!crypto?.subtle?.digest) throw new Error("This browser cannot calculate SHA-256 file identities.");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function matchingPortableAssetIds(assets, file, observedSha256) {
  if (!Array.isArray(assets)) throw new TypeError("assets must be an array.");
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new TypeError("Portable media must expose a finite byte length.");
  }
  assertSha256(observedSha256, "observedSha256");
  return Object.freeze(assets
    .filter((asset) => {
      assertSha256(asset?.sha256, `asset ${asset?.assetId ?? "unknown"} sha256`);
      return asset.byteLength === file.size && asset.sha256 === observedSha256;
    })
    .map(({ assetId }) => assetId));
}
