import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AFFEC_EMPIRICAL_CENTROIDS,
  AFFEC_EMPIRICAL_METADATA,
  buildAffecEmpiricalWeights,
} from "../site/src/face-affec.js";
import {
  MEDIAPIPE_ATLAS_METADATA,
  MEDIAPIPE_ATLAS_SIGNALS,
  buildMediapipeAtlasWeights,
} from "../site/src/face-mediapipe-calibration.js";

test("AFFEC empirical source covers all 5,807 perceived-rating trials", () => {
  assert.equal(AFFEC_EMPIRICAL_CENTROIDS.length, 6);
  assert.equal(
    AFFEC_EMPIRICAL_CENTROIDS.reduce((sum, entry) => sum + entry.count, 0),
    5807,
  );
  assert.equal(AFFEC_EMPIRICAL_METADATA.validTrialCount, 5807);
  assert.deepEqual(AFFEC_EMPIRICAL_METADATA.ratingFields, ["p_emotion_v", "p_emotion_a"]);
  assert.match(AFFEC_EMPIRICAL_METADATA.record, /zenodo\.org\/records\/14794876/);
  for (const entry of AFFEC_EMPIRICAL_CENTROIDS) {
    assert.ok(entry.meanValence >= 1 && entry.meanValence <= 9);
    assert.ok(entry.meanArousal >= 1 && entry.meanArousal <= 9);
    assert.ok(entry.sdValence > 0 && entry.sdArousal > 0);
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
