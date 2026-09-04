import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BUILTIN_FACE_PHOTO_PACK_CATALOG,
  DEFAULT_FACE_PHOTO_PACK_ID,
  FACE_PHOTO_PACK_CATALOG_SCHEMA,
  FACE_PHOTO_PACK_CATALOG_URL,
  FACE_PHOTO_PACK_PUBLIC_DISCLOSURE,
  facePhotoPackCompactLabel,
  facePhotoPackDefinition,
  facePhotoPackPublicLabel,
  loadFacePhotoPackCatalog,
  normalizeFacePhotoPackCatalog,
  normalizeFacePhotoPackId,
  resolveFacePhotoPackAtlasUrl,
} from "../site/src/face-photo-packs.js";

const pack = (overrides = {}) => {
  const id = overrides.id ?? "photo-synthetic-01";
  return {
    id,
    label: "Synthetic preset 02",
    presentationStyle: "masculine-coded",
    atlas: `packs/${id}/atlas-v1.webp`,
    metadata: `packs/${id}/atlas-v1.json`,
    qa: `packs/${id}/atlas-v1-qa.json`,
    available: true,
    gridSize: 21,
    tileSize: 160,
    quality: 88,
    atlasSha256: "a".repeat(64),
    atlasBytes: 123,
    regionalDesignInspirations: ["internal-only-value"],
    ...overrides,
  };
};

const catalog = (packs) => ({
  schema: FACE_PHOTO_PACK_CATALOG_SCHEMA,
  version: 1,
  defaultPackId: DEFAULT_FACE_PHOTO_PACK_ID,
  evidenceBoundary: "Catalog evidence boundary.",
  packs: [BUILTIN_FACE_PHOTO_PACK_CATALOG.packs[0], ...packs],
});

test("photo pack catalog keeps the original atlas as its fail-closed default", () => {
  assert.equal(BUILTIN_FACE_PHOTO_PACK_CATALOG.defaultPackId, DEFAULT_FACE_PHOTO_PACK_ID);
  assert.equal(BUILTIN_FACE_PHOTO_PACK_CATALOG.packs.length, 1);
  assert.match(FACE_PHOTO_PACK_CATALOG_URL, /photo-atlas-packs-v1\.json$/);
  assert.match(
    resolveFacePhotoPackAtlasUrl(DEFAULT_FACE_PHOTO_PACK_ID),
    /affect-face-atlas-v3\.webp\?v=02cca9d9cf9b$/,
  );
});

test("only verified-available local 21 by 21 atlas entries become selectable", () => {
  const normalized = normalizeFacePhotoPackCatalog(catalog([
    pack(),
    pack({ id: "photo-synthetic-02", available: false }),
    pack({ id: "photo-synthetic-03", atlas: "https://example.com/face.webp" }),
    pack({ id: "photo-synthetic-04", gridSize: 11 }),
    pack({ id: "photo-synthetic-05", atlas: "../escape.webp" }),
    pack({ id: "photo-synthetic-06", atlas: "packs\\face.webp" }),
    pack({ id: "photo-synthetic-07", presentationStyle: "toString" }),
    pack({ id: "photo-synthetic-08", atlasSha256: "not-a-sha256" }),
    pack({ id: "photo-synthetic-09", quality: 0 }),
    pack({ id: "photo-synthetic-10", atlasBytes: 0 }),
    pack({ id: "photo-synthetic-11", atlas: "packs/photo-synthetic-01/atlas-v1.webp" }),
    pack({ id: "photo-custom-01" }),
  ]));

  assert.deepEqual(normalized.packs.map(({ id }) => id), [
    DEFAULT_FACE_PHOTO_PACK_ID,
    "photo-synthetic-01",
  ]);
  assert.equal(normalizeFacePhotoPackId("photo-synthetic-01", normalized), "photo-synthetic-01");
  assert.equal(normalizeFacePhotoPackId("photo-missing", normalized), DEFAULT_FACE_PHOTO_PACK_ID);
  assert.equal(facePhotoPackDefinition("photo-missing", normalized).id, DEFAULT_FACE_PHOTO_PACK_ID);
  assert.match(
    resolveFacePhotoPackAtlasUrl("photo-synthetic-01", normalized),
    /packs\/photo-synthetic-01\/atlas-v1\.webp\?v=aaaaaaaaaaaa$/,
  );
});

test("neutral preset numbers stay stable when an earlier pack is unavailable", () => {
  const normalized = normalizeFacePhotoPackCatalog(catalog([
    pack({ id: "photo-synthetic-01", available: false }),
    pack({ id: "photo-synthetic-02", label: "Internal labels are not rendered" }),
    pack({ id: "photo-synthetic-08", label: "Internal labels are not rendered" }),
  ]));

  assert.deepEqual(normalized.packs.map(({ id }) => id), [
    DEFAULT_FACE_PHOTO_PACK_ID,
    "photo-synthetic-02",
    "photo-synthetic-08",
  ]);
  assert.equal(
    facePhotoPackPublicLabel("photo-synthetic-02", normalized),
    "Synthetic preset 03 · Masculine-coded styling",
  );
  assert.equal(
    facePhotoPackCompactLabel("photo-synthetic-02", normalized),
    "03 · Masculine-coded",
  );
  assert.equal(
    facePhotoPackCompactLabel(DEFAULT_FACE_PHOTO_PACK_ID, normalized),
    "Original · Reference",
  );
  assert.equal(
    facePhotoPackPublicLabel("photo-synthetic-08", normalized),
    "Synthetic preset 09 · 25-anchor preview",
  );
  assert.equal(
    facePhotoPackCompactLabel("photo-synthetic-08", normalized),
    "09 · 25 anchors",
  );
});

test("checked-in catalog follows the runtime contract without exposing unavailable packs", () => {
  const rawCatalog = JSON.parse(readFileSync(
    new URL("../site/assets/affect-face/photo-atlas-packs-v1.json", import.meta.url),
    "utf8",
  ));
  const normalized = normalizeFacePhotoPackCatalog(rawCatalog);
  const availableIds = rawCatalog.packs
    .filter(({ available }) => available === true)
    .map(({ id }) => id);

  assert.deepEqual(normalized.packs.map(({ id }) => id), availableIds);
  assert.equal(normalized.defaultPackId, DEFAULT_FACE_PHOTO_PACK_ID);
  for (const availablePack of normalized.packs) {
    const url = new URL(resolveFacePhotoPackAtlasUrl(availablePack.id, normalized));
    assert.equal(url.protocol, "file:");
    assert.match(url.pathname, /\/site\/assets\/affect-face\//);
    assert.equal(url.searchParams.get("v"), availablePack.atlasSha256.slice(0, 12));
    assert.doesNotMatch(facePhotoPackPublicLabel(availablePack, normalized), /african|asian|latin|indigenous|islander|ethnic|ancestr|race/i);
  }
});

test("public labels expose neutral preset and styling language, never internal regional metadata", () => {
  const normalized = normalizeFacePhotoPackCatalog(catalog([
    pack({ label: "Internal regional wording must never render" }),
  ]));
  const label = facePhotoPackPublicLabel("photo-synthetic-01", normalized);

  assert.equal(label, "Synthetic preset 02 · Masculine-coded styling");
  assert.doesNotMatch(label, /internal-only|ethnic|ancestr|race/i);
  assert.match(FACE_PHOTO_PACK_PUBLIC_DISCLOSURE, /creator-chosen/);
  assert.match(FACE_PHOTO_PACK_PUBLIC_DISCLOSURE, /non-exhaustive/);
  assert.match(FACE_PHOTO_PACK_PUBLIC_DISCLOSURE, /gender identity/);
  assert.match(FACE_PHOTO_PACK_PUBLIC_DISCLOSURE, /race, ethnicity, ancestry/);
  assert.match(FACE_PHOTO_PACK_PUBLIC_DISCLOSURE, /validated affect/);
});

test("catalog loading uses one local request and falls back without exposing placeholders", async () => {
  const requested = [];
  const normalized = await loadFacePhotoPackCatalog({
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return { ok: true, json: async () => catalog([pack()]) };
    },
  });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].options.cache, "no-store");
  assert.equal(normalized.packs.length, 2);

  let error;
  const fallback = await loadFacePhotoPackCatalog({
    fetchImpl: async () => ({ ok: false, status: 404 }),
    onError: (value) => { error = value; },
  });
  assert.equal(fallback, BUILTIN_FACE_PHOTO_PACK_CATALOG);
  assert.match(error.message, /HTTP 404/);
});
