import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AFFEC_EMPIRICAL_CENTROIDS,
  AFFEC_EMPIRICAL_METADATA,
  AFFEC_PHOTO_MAPPING_METADATA,
  AFFEC_PHOTO_PROTOTYPE_COORDINATES,
  buildAffecEmpiricalWeights,
  mapAffecPhotoAtlasCoordinates,
} from "../site/src/face-affec.js";
import {
  MEDIAPIPE_ATLAS_METADATA,
  MEDIAPIPE_ATLAS_SIGNALS,
  buildMediapipeAtlasWeights,
} from "../site/src/face-mediapipe-calibration.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("AFFEC empirical source covers all 5,807 perceived-rating trials", () => {
  assert.equal(AFFEC_EMPIRICAL_CENTROIDS.length, 6);
  assert.equal(
    AFFEC_EMPIRICAL_CENTROIDS.reduce((sum, entry) => sum + entry.count, 0),
    5807,
  );
  assert.equal(AFFEC_EMPIRICAL_METADATA.validTrialCount, 5807);
  assert.deepEqual(AFFEC_EMPIRICAL_METADATA.ratingFields, ["p_emotion_v", "p_emotion_a"]);
  assert.match(AFFEC_EMPIRICAL_METADATA.record, /zenodo\.org\/records\/14794876/);
  assert.equal(AFFEC_EMPIRICAL_METADATA.archiveBytes, 5645457);
  assert.equal(AFFEC_EMPIRICAL_METADATA.archiveMd5, "7157e9bedacf58f42692688fb20b57b1");
  for (const entry of AFFEC_EMPIRICAL_CENTROIDS) {
    assert.ok(entry.meanValence >= 1 && entry.meanValence <= 9);
    assert.ok(entry.meanArousal >= 1 && entry.meanArousal <= 9);
    assert.ok(entry.sdValence > 0 && entry.sdArousal > 0);
  }
});

test("AFFEC evidence artifact reproduces the aggregate and excludes authored face bindings", () => {
  const evidenceBytes = readFileSync(
    new URL("../site/assets/affect-face/affec-perceived-va-evidence-v1.json", import.meta.url),
  );
  const evidence = JSON.parse(evidenceBytes);
  assert.equal(evidence.schema, "affect-tracker-affec-perceived-va-evidence");
  assert.equal(evidence.evidenceClass, "dataset-derived-aggregate");
  assert.equal(evidence.id, AFFEC_EMPIRICAL_METADATA.id);
  assert.equal(evidence.source.record, AFFEC_EMPIRICAL_METADATA.record);
  assert.equal(evidence.source.archive.bytes, AFFEC_EMPIRICAL_METADATA.archiveBytes);
  assert.equal(evidence.source.archive.md5, AFFEC_EMPIRICAL_METADATA.archiveMd5);
  assert.equal(evidence.source.archive.sha256, AFFEC_EMPIRICAL_METADATA.archiveSha256);
  assert.equal(digest(evidenceBytes), AFFEC_EMPIRICAL_METADATA.evidenceSha256);
  assert.equal(evidence.aggregation.behaviorTableCount, 273);
  assert.equal(evidence.aggregation.validObservationCount, 5807);
  assert.deepEqual(evidence.anchors.map((anchor) => ({
    emotion: anchor.sourceCategory,
    count: anchor.n,
    meanValence: anchor.sourceMean.valence,
    sdValence: anchor.sourceSampleSd.valence,
    meanArousal: anchor.sourceMean.arousal,
    sdArousal: anchor.sourceSampleSd.arousal,
  })), AFFEC_EMPIRICAL_CENTROIDS);
  assert.equal("correspondences" in evidence, false);
  assert.equal("transfer" in evidence, false);
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /\"stim_file\"|\"participantId\"|\"user\"|sub-[a-z0-9]+/i);
  assert.match(evidence.aggregation.privacy, /demographics.*excluded/i);
  assert.deepEqual(evidence.claimScope.supports, ["aggregate-perceived-category-location"]);
  assert.ok(evidence.claimScope.doesNotSupport.includes("portrait-expression-validity"));

  const generatorBytes = readFileSync(
    new URL("../scripts/build-affec-perceived-va-calibration.py", import.meta.url),
  );
  const generator = generatorBytes.toString("utf8");
  assert.equal(evidence.derivation.scriptSha256, digest(generatorBytes));
  assert.match(generator, /SOURCE_ARCHIVE_SHA256/);
  assert.match(generator, /statistics\.stdev/);
  assert.match(generator, /participant identifiers, trial rows, stimulus paths, or demographics/i);
});

test("AFFEC Photoatlas binding is separately classified as project-authored", () => {
  const bindingBytes = readFileSync(
    new URL("../site/assets/affect-face/affec-photoatlas-authoring-binding-v1.json", import.meta.url),
  );
  const binding = JSON.parse(bindingBytes);
  assert.equal(binding.schema, "affect-tracker-affec-photoatlas-authoring-binding");
  assert.equal(binding.id, AFFEC_PHOTO_MAPPING_METADATA.id);
  assert.equal(binding.classification, "project-authored-transfer");
  assert.equal(binding.evidenceRef.id, AFFEC_EMPIRICAL_METADATA.id);
  assert.equal(binding.evidenceRef.sha256, AFFEC_EMPIRICAL_METADATA.evidenceSha256);
  assert.equal(digest(bindingBytes), AFFEC_PHOTO_MAPPING_METADATA.bindingSha256);
  assert.equal(binding.input.authority, "affectFrame.currentX/currentY");
  assert.equal(binding.input.mutatesAuthority, false);
  assert.deepEqual(binding.correspondences.map((entry) => ({
    emotion: entry.evidenceAnchorId.replace("affec-perceived-", "").replace("-v0.1", ""),
    atlasX: entry.atlasX,
    atlasY: entry.atlasY,
  })), AFFEC_PHOTO_PROTOTYPE_COORDINATES);
  assert.equal(binding.transfer.minimumNormalizedSpread, AFFEC_PHOTO_MAPPING_METADATA.minimumNormalizedSpread);
  assert.equal(binding.transfer.prototypeWeightPower, AFFEC_PHOTO_MAPPING_METADATA.prototypeWeightPower);
  assert.equal(binding.transfer.maximumBlend, AFFEC_PHOTO_MAPPING_METADATA.maximumEmpiricalBlend);
  assert.equal(binding.claimScope.status, "empirically-guided");
  assert.ok(binding.claimScope.notValidated.includes("441 derived cells"));
});

test("AFFEC Photoatlas mapping is neutral-exact, bounded, continuous, and orientation-preserving", () => {
  assert.deepEqual(mapAffecPhotoAtlasCoordinates({ currentX: 0, currentY: 0 }), {
    currentX: 0,
    currentY: 0,
    atlasX: 0,
    atlasY: 0,
    empiricalBlend: 0,
    maximumKernel: 0,
  });

  const happy = AFFEC_EMPIRICAL_CENTROIDS.find(({ emotion }) => emotion === "happy");
  const happyPoint = {
    currentX: (happy.meanValence - 5) / 4,
    currentY: (happy.meanArousal - 5) / 4,
  };
  const mappedHappy = mapAffecPhotoAtlasCoordinates(happyPoint);
  assert.ok(Math.hypot(1 - mappedHappy.atlasX, 1 - mappedHappy.atlasY)
    < Math.hypot(1 - happyPoint.currentX, 1 - happyPoint.currentY));
  assert.ok(mappedHappy.empiricalBlend > 0.4);
  assert.ok(mapAffecPhotoAtlasCoordinates({ currentX: 1, currentY: -1 }).empiricalBlend < 0.01);

  const size = 101;
  const step = 2 / (size - 1);
  const field = Array.from({ length: size }, (_, row) => (
    Array.from({ length: size }, (_, column) => mapAffecPhotoAtlasCoordinates({
      currentX: -1 + column * step,
      currentY: -1 + row * step,
    }))
  ));
  for (const row of field) {
    for (const point of row) {
      assert.ok(point.atlasX >= -1 && point.atlasX <= 1);
      assert.ok(point.atlasY >= -1 && point.atlasY <= 1);
      assert.ok(point.empiricalBlend >= 0 && point.empiricalBlend <= 0.72);
    }
  }
  for (let row = 1; row < size - 1; row += 1) {
    for (let column = 1; column < size - 1; column += 1) {
      const xBefore = field[row][column - 1];
      const xAfter = field[row][column + 1];
      const yBefore = field[row - 1][column];
      const yAfter = field[row + 1][column];
      const dxX = (xAfter.atlasX - xBefore.atlasX) / (2 * step);
      const dxY = (xAfter.atlasY - xBefore.atlasY) / (2 * step);
      const dyX = (yAfter.atlasX - yBefore.atlasX) / (2 * step);
      const dyY = (yAfter.atlasY - yBefore.atlasY) / (2 * step);
      assert.ok(dxX * dyY - dxY * dyX > 0, `fold at ${column},${row}`);
    }
  }
});

test("AFFEC interpolation is exact-neutral, continuous, bounded, and affect-sensitive", () => {
  assert.deepEqual(buildAffecEmpiricalWeights({ currentX: 0, currentY: 0 }), {});
  const positiveHigh = buildAffecEmpiricalWeights({ currentX: 1, currentY: 1 });
  const negativeHigh = buildAffecEmpiricalWeights({ currentX: -1, currentY: 1 });
  const negativeLow = buildAffecEmpiricalWeights({ currentX: -1, currentY: -1 });
  const positiveLow = buildAffecEmpiricalWeights({ currentX: 1, currentY: -1 });
  assert.ok(positiveHigh.Happy > 0.9);
  assert.ok(positiveHigh.Eyes_Opened_Max_Left > positiveLow.Eyes_Opened_Max_Left);
  assert.ok(positiveLow.Eyes_Closed_Max > positiveHigh.Eyes_Closed_Max);
  assert.ok(negativeHigh.Angry + negativeHigh.Scared > negativeLow.Angry + negativeLow.Scared);
  assert.ok(negativeLow.Sad > 0.6);
  assert.notDeepEqual(
    buildAffecEmpiricalWeights({ currentX: 0.2, currentY: 0.4 }),
    buildAffecEmpiricalWeights({ currentX: 0.201, currentY: 0.399 }),
  );
  for (const weights of [positiveHigh, negativeHigh, negativeLow, positiveLow]) {
    for (const value of Object.values(weights)) assert.ok(value >= 0 && value <= 1);
  }
});

test("MediaPipe calibration is a local 3x3 coefficient matrix with exact neutral", () => {
  assert.equal(MEDIAPIPE_ATLAS_SIGNALS.length, 3);
  assert.ok(MEDIAPIPE_ATLAS_SIGNALS.every((row) => row.length === 3));
  assert.equal(MEDIAPIPE_ATLAS_METADATA.sourceCellCount, 9);
  assert.equal(MEDIAPIPE_ATLAS_METADATA.sourceBlendshapeCount, 52);
  const neutral = buildMediapipeAtlasWeights({ currentX: 0, currentY: 0 });
  assert.ok(Object.values(neutral).every((value) => value === 0));
  const highPositive = buildMediapipeAtlasWeights({ currentX: 1, currentY: 1 });
  const highNegative = buildMediapipeAtlasWeights({ currentX: -1, currentY: 1 });
  const lowPositive = buildMediapipeAtlasWeights({ currentX: 1, currentY: -1 });
  assert.ok(highPositive.Happy > 0.9);
  assert.equal(highPositive.Scared, 0);
  assert.ok(highNegative.Angry > 0.6);
  assert.ok(lowPositive.Eyes_Closed_Max > 0.25);
  assert.notDeepEqual(
    buildMediapipeAtlasWeights({ currentX: 0.4, currentY: 0.4 }),
    buildMediapipeAtlasWeights({ currentX: 0.41, currentY: 0.4 }),
  );
});

test("calibration modules contain no runtime camera, model load, or participant data", () => {
  for (const file of ["face-affec.js", "face-mediapipe-calibration.js"]) {
    const source = readFileSync(new URL(`../site/src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /getUserMedia|mediaDevices|FaceLandmarker\.create|\.task["']/);
    assert.doesNotMatch(source, /sub-[a-z0-9]+|stim_file|user\trun/);
  }
});
