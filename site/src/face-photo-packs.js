export const FACE_PHOTO_PACK_CATALOG_SCHEMA = "affect-tracker-photo-atlas-catalog";
export const FACE_PHOTO_PACK_CATALOG_VERSION = 1;
export const DEFAULT_FACE_PHOTO_PACK_ID = "photo-reference-v3";
export const FACE_PHOTO_PACK_PUBLIC_DISCLOSURE = "Synthetic portrait presets are creator-chosen styling references. They are non-exhaustive and do not establish gender identity, sex, pronouns, race, ethnicity, ancestry, or validated affect.";

export const FACE_PHOTO_PACK_CATALOG_URL = new URL(
  "../assets/affect-face/photo-atlas-packs-v1.json",
  import.meta.url,
).href;

const SYNTHETIC_PACK_ID_PATTERN = /^photo-synthetic-([0-9]{2})$/;
const PACK_ID_PATTERN = /^(?:photo-reference-v3|photo-synthetic-[0-9]{2})$/;
const MULTI_ANCHOR_PREVIEW_PACK_ID = "photo-synthetic-08";
const LOCAL_PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PRESENTATION_STYLE_LABELS = Object.freeze({
  reference: "Reference styling",
  "masculine-coded": "Masculine-coded styling",
  "feminine-coded": "Feminine-coded styling",
  "androgynous-styling": "Androgynous styling",
});
const COMPACT_PRESENTATION_STYLE_LABELS = Object.freeze({
  reference: "Reference",
  "masculine-coded": "Masculine-coded",
  "feminine-coded": "Feminine-coded",
  "androgynous-styling": "Androgynous",
});

const freezePack = (pack) => Object.freeze({ ...pack });

const BUILTIN_REFERENCE_PACK = freezePack({
  id: DEFAULT_FACE_PHOTO_PACK_ID,
  label: "Original portrait",
  presentationStyle: "reference",
  atlas: "affect-face-atlas-v3.webp",
  metadata: "affect-face-atlas-v3.json",
  qa: "affect-face-atlas-v3-qa.json",
  available: true,
  gridSize: 21,
  tileSize: 160,
  quality: 82,
  atlasSha256: "02cca9d9cf9b4d5e3107147b4ed273404700ede445d05da66698e537ceb2ef62",
  atlasBytes: 3_633_384,
});

export const BUILTIN_FACE_PHOTO_PACK_CATALOG = Object.freeze({
  schema: FACE_PHOTO_PACK_CATALOG_SCHEMA,
  version: FACE_PHOTO_PACK_CATALOG_VERSION,
  defaultPackId: DEFAULT_FACE_PHOTO_PACK_ID,
  evidenceBoundary: FACE_PHOTO_PACK_PUBLIC_DISCLOSURE,
  packs: Object.freeze([BUILTIN_REFERENCE_PACK]),
});

const cleanText = (value, fallback, maximumLength = 120) => {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned ? cleaned.slice(0, maximumLength) : fallback;
};

function normalizePack(value) {
  if (!value || typeof value !== "object" || value.available !== true) return null;
  const id = cleanText(value.id, "", 80);
  const atlas = cleanText(value.atlas, "", 160);
  const atlasSegments = atlas.split("/");
  const safeAtlasPath = atlas.endsWith(".webp")
    && atlasSegments.length <= 4
    && atlasSegments.every((segment) => LOCAL_PATH_SEGMENT_PATTERN.test(segment));
  const expectedAtlas = id === DEFAULT_FACE_PHOTO_PACK_ID
    ? "affect-face-atlas-v3.webp"
    : `packs/${id}/atlas-v1.webp`;
  if (!PACK_ID_PATTERN.test(id) || !safeAtlasPath || atlas !== expectedAtlas) return null;
  const gridSize = Number(value.gridSize);
  const tileSize = Number(value.tileSize);
  const quality = Number(value.quality);
  const atlasBytes = Number(value.atlasBytes);
  const atlasSha256 = cleanText(value.atlasSha256, "", 64).toLowerCase();
  const presentationStyleIsConsistent = id === DEFAULT_FACE_PHOTO_PACK_ID
    ? value.presentationStyle === "reference"
    : value.presentationStyle !== "reference";
  if (
    gridSize !== 21
    || !(Number.isInteger(tileSize) && tileSize > 0)
    || !(Number.isInteger(quality) && quality >= 1 && quality <= 100)
    || !(Number.isInteger(atlasBytes) && atlasBytes > 0)
    || !SHA256_PATTERN.test(atlasSha256)
    || !presentationStyleIsConsistent
    || !Object.prototype.hasOwnProperty.call(
      PRESENTATION_STYLE_LABELS,
      value.presentationStyle,
    )
  ) return null;

  return freezePack({
    ...value,
    id,
    label: cleanText(value.label, "Synthetic portrait", 80),
    presentationStyle: value.presentationStyle,
    atlas,
    available: true,
    gridSize,
    tileSize,
    quality,
    atlasSha256,
    atlasBytes,
  });
}

/**
 * Validate the small runtime projection of the offline-verified pack catalog.
 * Unavailable or malformed placeholders are omitted and therefore can never
 * become selectable or trigger an asset request.
 */
export function normalizeFacePhotoPackCatalog(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("The photo-atlas catalog must be an object.");
  }
  if (
    value.schema !== FACE_PHOTO_PACK_CATALOG_SCHEMA
    || value.version !== FACE_PHOTO_PACK_CATALOG_VERSION
  ) {
    throw new TypeError("The photo-atlas catalog schema is unsupported.");
  }

  const packs = [];
  const ids = new Set();
  for (const candidate of Array.isArray(value.packs) ? value.packs : []) {
    const pack = normalizePack(candidate);
    if (!pack || ids.has(pack.id)) continue;
    ids.add(pack.id);
    packs.push(pack);
  }
  const requestedDefault = cleanText(value.defaultPackId, DEFAULT_FACE_PHOTO_PACK_ID, 80);
  if (requestedDefault !== DEFAULT_FACE_PHOTO_PACK_ID || !ids.has(requestedDefault)) {
    throw new TypeError("The photo-atlas catalog has no available default pack.");
  }

  return Object.freeze({
    schema: FACE_PHOTO_PACK_CATALOG_SCHEMA,
    version: FACE_PHOTO_PACK_CATALOG_VERSION,
    defaultPackId: requestedDefault,
    evidenceBoundary: cleanText(
      value.evidenceBoundary,
      BUILTIN_FACE_PHOTO_PACK_CATALOG.evidenceBoundary,
      500,
    ),
    packs: Object.freeze(packs),
  });
}

export async function loadFacePhotoPackCatalog(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return BUILTIN_FACE_PHOTO_PACK_CATALOG;
  try {
    const response = await fetchImpl(options.url ?? FACE_PHOTO_PACK_CATALOG_URL, {
      cache: "no-store",
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
    return normalizeFacePhotoPackCatalog(await response.json());
  } catch (error) {
    options.onError?.(error);
    return BUILTIN_FACE_PHOTO_PACK_CATALOG;
  }
}

export function facePhotoPackDefinition(value, catalog = BUILTIN_FACE_PHOTO_PACK_CATALOG) {
  const normalizedCatalog = catalog?.packs ? catalog : BUILTIN_FACE_PHOTO_PACK_CATALOG;
  const requested = typeof value === "string" ? value : "";
  return normalizedCatalog.packs.find((pack) => pack.id === requested)
    ?? normalizedCatalog.packs.find((pack) => pack.id === normalizedCatalog.defaultPackId)
    ?? BUILTIN_REFERENCE_PACK;
}

export function normalizeFacePhotoPackId(value, catalog = BUILTIN_FACE_PHOTO_PACK_CATALOG) {
  return facePhotoPackDefinition(value, catalog).id;
}

export function facePhotoPackPublicLabel(pack, catalog = BUILTIN_FACE_PHOTO_PACK_CATALOG) {
  const definition = facePhotoPackDefinition(pack?.id ?? pack, catalog);
  if (definition.id === MULTI_ANCHOR_PREVIEW_PACK_ID) {
    return "Synthetic preset 09 · 25-anchor preview";
  }
  const style = PRESENTATION_STYLE_LABELS[definition.presentationStyle]
    ?? PRESENTATION_STYLE_LABELS.reference;
  const syntheticNumber = SYNTHETIC_PACK_ID_PATTERN.exec(definition.id)?.[1];
  const neutralLabel = definition.id === DEFAULT_FACE_PHOTO_PACK_ID
    ? "Original portrait"
    : `Synthetic preset ${String(Number(syntheticNumber) + 1).padStart(2, "0")}`;
  return `${neutralLabel} · ${style}`;
}

/** Keep the distinguishing preset number visible in narrow native selects. */
export function facePhotoPackCompactLabel(pack, catalog = BUILTIN_FACE_PHOTO_PACK_CATALOG) {
  const definition = facePhotoPackDefinition(pack?.id ?? pack, catalog);
  if (definition.id === MULTI_ANCHOR_PREVIEW_PACK_ID) {
    return "09 · 25 anchors";
  }
  const style = COMPACT_PRESENTATION_STYLE_LABELS[definition.presentationStyle]
    ?? COMPACT_PRESENTATION_STYLE_LABELS.reference;
  const syntheticNumber = SYNTHETIC_PACK_ID_PATTERN.exec(definition.id)?.[1];
  const neutralLabel = definition.id === DEFAULT_FACE_PHOTO_PACK_ID
    ? "Original"
    : String(Number(syntheticNumber) + 1).padStart(2, "0");
  return `${neutralLabel} · ${style}`;
}

export function resolveFacePhotoPackAtlasUrl(
  value,
  catalog = BUILTIN_FACE_PHOTO_PACK_CATALOG,
) {
  const pack = facePhotoPackDefinition(value, catalog);
  const url = new URL(`../assets/affect-face/${pack.atlas}`, import.meta.url);
  url.searchParams.set("v", pack.atlasSha256.slice(0, 12));
  return url.href;
}
