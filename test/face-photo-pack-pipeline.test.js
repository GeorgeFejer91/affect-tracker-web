import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.join(root, "site", "assets", "affect-face");
const catalogPath = path.join(assetRoot, "photo-atlas-packs-v1.json");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (relative) => readFileSync(path.join(root, relative));
const json = (relative) => JSON.parse(bytes(relative).toString("utf8"));

const catalog = json("site/assets/affect-face/photo-atlas-packs-v1.json");
const expectedIds = [
  "photo-reference-v3",
  "photo-synthetic-01",
  "photo-synthetic-02",
  "photo-synthetic-03",
  "photo-synthetic-04",
  "photo-synthetic-05",
  "photo-synthetic-06",
  "photo-synthetic-07",
];

const internalMetadata = {
  "photo-synthetic-01": ["masculine-coded", ["west-african", "african-diaspora"], "deep"],
  "photo-synthetic-02": ["feminine-coded", ["east-asian"], "light-to-medium"],
  "photo-synthetic-03": ["androgynous-styling", ["south-asian"], "medium-to-deep"],
  "photo-synthetic-04": ["feminine-coded", ["west-asian", "north-african"], "medium-olive"],
  "photo-synthetic-05": ["masculine-coded", ["latin-american"], "medium-tan"],
  "photo-synthetic-06": ["androgynous-styling", ["indigenous-americas"], "medium-brown"],
  "photo-synthetic-07": ["masculine-coded", ["pacific-islander", "polynesian"], "deep-warm"],
};

test("Photoatlas catalog is closed-world, centered, neutral in public, and fully activatable", () => {
  assert.equal(catalog.schema, "affect-tracker-photo-atlas-catalog");
  assert.equal(catalog.version, 1);
  assert.equal(catalog.defaultPackId, "photo-reference-v3");
  assert.deepEqual(catalog.packs.map(({ id }) => id), expectedIds);
  assert.match(catalog.evidenceBoundary, /not a demographic taxonomy/);
  assert.match(catalog.evidenceBoundary, /do not state or infer sex, gender identity/);
  assert.match(catalog.evidenceBoundary, /not independently validated affect observations/);

  const paths = new Set();
  for (const [index, pack] of catalog.packs.entries()) {
    const expectedLabel = index === 0 ? "Original portrait" : `Synthetic preset ${String(index + 1).padStart(2, "0")}`;
    assert.equal(pack.label, expectedLabel);
    assert.doesNotMatch(pack.id, /afric|asian|latin|indigenous|islander|polynesian|ethni|ancestr|race/i);
    assert.doesNotMatch(pack.label, /afric|asian|latin|indigenous|islander|polynesian|ethni|ancestr|race/i);
    assert.equal(pack.available, true, `${pack.id} must pass QA before it is published`);
    assert.equal(pack.gridSize, 21);
    assert.equal(pack.tileSize, 160);
    assert.equal(pack.quality, index === 0 ? 82 : 88);
    assert.match(pack.atlasSha256, /^[0-9a-f]{64}$/);
    assert.equal(Number.isInteger(pack.atlasBytes), true);
    assert.ok(pack.atlasBytes > 0);
    assert.equal(pack.provenance.identityType, "synthetic-fictional");
    assert.equal(pack.provenance.sourceOwnership, "project-owned");
    assert.equal(pack.provenance.demographicLabelType, "creator-prompt-inspiration-only");
    assert.match(pack.provenance.demographicLabelScope, /not a claim or inference/);
    assert.match(pack.provenance.affectValidation, /neither .* independently validated affect observations/);
    for (const relative of [pack.atlas, pack.metadata, pack.qa]) {
      assert.equal(path.posix.isAbsolute(relative), false);
      assert.doesNotMatch(relative, /(?:^|\/)\.\.(?:\/|$)|\\|:|\?|#/);
      assert.equal(paths.has(relative), false, `${relative} must belong to only one pack`);
      paths.add(relative);
    }
  }
});

test("legacy v3 atlas and reproducibility tools remain byte-for-byte unchanged", () => {
  const locked = new Map([
    ["site/assets/affect-face/affect-face-atlas-v1.webp", "22041af6617163830c1ec2274bd9157f31feade83601a1640680b8663c8a9590"],
    ["site/assets/affect-face/affect-face-atlas-v3.webp", "02cca9d9cf9b4d5e3107147b4ed273404700ede445d05da66698e537ceb2ef62"],
    ["site/assets/affect-face/affect-face-atlas-v3.json", "c834ace775119565f5ef01941ea0fa9209c2358682545192835a63a9ec7b9395"],
    ["site/assets/affect-face/affect-face-atlas-v3-qa.json", "75fcdb965c631462b19c3b479116fa29b1b9467a226f91e7bec6511a6ce49f50"],
    ["scripts/build-dense-photo-atlas.py", "2479ed7bbe557a64c1bc48cf7fce4dc1cde705474d488d49663d9a777dd0f38c"],
    ["scripts/verify-dense-photo-atlas.py", "40a1f7f23b88aad7ffed8aa2a62406d38e6ec521d8acf96a243ce22500e9dee5"],
  ]);
  for (const [relative, expected] of locked) {
    assert.equal(digest(bytes(relative)), expected, `${relative} changed unexpectedly`);
  }
});

test("each synthetic pack binds its source, atlas, metadata, QA, and internal prompt provenance", () => {
  for (const pack of catalog.packs.slice(1)) {
    const directory = path.posix.dirname(pack.atlas);
    const metadata = json(`site/assets/affect-face/${pack.metadata}`);
    const qa = json(`site/assets/affect-face/${pack.qa}`);
    const sourceRelative = `site/assets/affect-face/${directory}/anchors-v1.png`;
    const atlasRelative = `site/assets/affect-face/${pack.atlas}`;
    const metadataRelative = `site/assets/affect-face/${pack.metadata}`;
    const [style, inspirations, auditDescriptor] = internalMetadata[pack.id];

    assert.deepEqual(
      [pack.presentationStyle, pack.regionalDesignInspirations, pack.skinToneAudit.descriptor],
      [style, inspirations, auditDescriptor],
    );
    assert.equal(pack.skinToneAudit.status, "unvalidated");
    assert.equal(metadata.schema, "affect-tracker-photo-atlas-pack");
    assert.equal(metadata.version, 1);
    assert.equal(metadata.id, pack.id);
    assert.equal(metadata.label, pack.label);
    assert.equal(metadata.presentationStyle, style);
    assert.deepEqual(metadata.regionalDesignInspirations, inspirations);
    assert.deepEqual(metadata.skinToneAudit, pack.skinToneAudit);
    assert.equal(metadata.source, "anchors-v1.png");
    assert.equal(metadata.sourceSha256, digest(bytes(sourceRelative)));
    assert.equal(metadata.output, "atlas-v1.webp");
    assert.equal(metadata.outputSha256, digest(bytes(atlasRelative)));
    assert.equal(pack.atlasSha256, metadata.outputSha256);
    assert.equal(pack.atlasBytes, statSync(path.join(root, atlasRelative)).size);
    assert.equal(metadata.sourceGridSize, 3);
    assert.equal(metadata.gridSize, 21);
    assert.equal(metadata.nodeCount, 441);
    assert.equal(metadata.tileSize, 160);
    assert.equal(metadata.quality, pack.quality);
    assert.equal(metadata.sourcePreprocessing.inputMode, "RGB");
    assert.equal(
      metadata.sourcePreprocessing.method,
      "cell-border-connected-rgb-black-matte-soft-alpha-v2",
    );
    assert.equal(metadata.sourcePreprocessing.backgroundConnectivity, 8);
    assert.equal(metadata.sourcePreprocessing.blackPoint, 8);
    assert.equal(metadata.sourcePreprocessing.opaquePoint, 24);
    assert.equal(metadata.sourcePreprocessing.edgeRgbPolicy, "preserve-source-straight-rgb");
    assert.equal(metadata.sourcePreprocessing.blackMatteDecontamination, false);
    assert.ok(
      metadata.sourcePreprocessing.softPixelMaximumRgb < metadata.sourcePreprocessing.opaquePoint,
    );
    assert.match(metadata.sourcePreprocessing.limitation, /requires contact-sheet review/);
    assert.equal(metadata.provenance.identityType, "synthetic-fictional");
    assert.equal(metadata.provenance.demographicLabelType, "creator-prompt-inspiration-only");
    assert.match(metadata.provenance.demographicLabelScope, /not a claim or inference/);
    assert.match(metadata.provenance.affectValidation, /neither .* independently validated affect observations/);

    assert.equal(qa.schema, "affect-tracker-photo-atlas-pack-engineering-qa");
    assert.equal(qa.version, 1);
    assert.equal(qa.passed, true);
    assert.match(qa.evidenceBoundary, /do not establish perceived or validated affect/);
    assert.equal(qa.pack.id, pack.id);
    assert.equal(qa.asset.sourceSha256, metadata.sourceSha256);
    assert.equal(qa.asset.preparedSourceSha256, metadata.preparedSourceSha256);
    assert.equal(qa.asset.atlasSha256, metadata.outputSha256);
    assert.equal(qa.asset.metadataSha256, digest(bytes(metadataRelative)));
    assert.equal(qa.asset.gridSize, 21);
    assert.equal(qa.asset.tileSize, 160);
    assert.equal(qa.asset.detectedCellCount, 441);
    assert.ok(Object.values(qa.checks).every(Boolean));
    assert.ok(Object.values(qa.coreChecks).every(Boolean));
    assert.equal(qa.metrics.observedFoldCount, 0);
    assert.equal(qa.metrics.anchorPreservation.maximumAlphaError, 0);
    assert.equal(qa.asset.packCommonSha256, digest(bytes("scripts/photo_atlas_pack_common.py")));
  }
});

test("pack tooling is offline, deterministic, and delegates without mutating v3", () => {
  const common = bytes("scripts/photo_atlas_pack_common.py").toString("utf8");
  const builder = bytes("scripts/build-photo-atlas-pack.py").toString("utf8");
  const verifier = bytes("scripts/verify-photo-atlas-pack.py").toString("utf8");
  const catalogVerifier = bytes("scripts/verify-photo-atlas-catalog.py").toString("utf8");

  assert.match(common, /cell-border-connected-rgb-black-matte-soft-alpha-v2/);
  assert.match(common, /connectedComponents\(candidates, connectivity=8\)/);
  assert.match(common, /Creator-selected appearance-prompt inspiration only/);
  assert.match(builder, /builder\.build_dense_atlas/);
  assert.match(builder, /TemporaryDirectory/);
  assert.match(builder, /Refusing to overwrite/);
  assert.match(verifier, /core_verifier\.verify/);
  assert.match(verifier, /preparedSourceHashMatchesMetadata/);
  assert.match(catalogVerifier, /closed-world catalog/);
  for (const source of [common, builder, verifier, catalogVerifier]) {
    assert.doesNotMatch(source, /requests\.|urllib\.|https?:\/\//);
    assert.doesNotMatch(source, /getUserMedia|camera/i);
  }
  assert.equal(path.basename(catalogPath), "photo-atlas-packs-v1.json");
});
