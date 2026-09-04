import test from "node:test";
import assert from "node:assert/strict";

import {
  FLUBBER_MAPPING_SPECS,
  affectCoordinates,
  createDefaultFlubberMappings,
  evaluateFlubberMapping,
  evaluateFlubberMappings,
  normalizedDriver,
  validateFlubberMapping,
} from "../site/src/research/mappings.js";
import {
  compactUtcTimestamp,
  createSessionStem,
  deriveParticipantRecord,
  participantCode,
  participantIds,
} from "../site/src/research/identity.js";

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);

test("affect coordinates normalize neutral, axes, corners, radius, and angle deterministically", () => {
  assert.deepEqual(affectCoordinates(0, 0), { x: 0, y: 0, radius: 0, angleDegrees: 0 });
  assert.equal(affectCoordinates(1, 0).angleDegrees, 0);
  assert.equal(affectCoordinates(0, 1).angleDegrees, 90);
  assert.equal(affectCoordinates(-1, 0).angleDegrees, 180);
  assert.equal(affectCoordinates(0, -1).angleDegrees, 270);
  assert.deepEqual(affectCoordinates(1, 1), { x: 1, y: 1, radius: 1, angleDegrees: 45 });
  assert.deepEqual(affectCoordinates(2, -2), { x: 1, y: -1, radius: 1, angleDegrees: 315 });
  assert.throws(() => affectCoordinates("1", 0), /Valence must be finite/);
});

test("the six mapping defaults match the Research charter", () => {
  const defaults = createDefaultFlubberMappings();
  assert.deepEqual(Object.keys(defaults), Object.keys(FLUBBER_MAPPING_SPECS));
  assert.deepEqual(defaults.oscillationFrequency, { min: 0.5, max: 2.5, drivenBy: "y-axis", reverse: false });
  assert.deepEqual(defaults.edgeSmoothness, { min: 0, max: 1, drivenBy: "x-axis", reverse: false });
  assert.deepEqual(defaults.projectionAmplitude, { min: 0.2, max: 0.4, drivenBy: "y-axis", reverse: false });
  assert.deepEqual(defaults.pulseSynchrony, { min: 0.2, max: 1, drivenBy: "x-axis", reverse: false });
  assert.deepEqual(defaults.waveSizeVariation, { min: 0, max: 0.8, drivenBy: "x-axis", reverse: true });
  assert.deepEqual(defaults.saturation, { min: 0, max: 1, drivenBy: "radius", reverse: false });
});

test("mapping math applies normalized drivers, reverse, and min=max exactly", () => {
  const defaults = createDefaultFlubberMappings();
  const neutral = evaluateFlubberMappings(defaults, { x: 0, y: 0 });
  assert.equal(neutral.oscillationFrequency, 1.5);
  assert.equal(neutral.edgeSmoothness, 0.5);
  closeTo(neutral.projectionAmplitude, 0.3);
  closeTo(neutral.pulseSynchrony, 0.6);
  closeTo(neutral.waveSizeVariation, 0.4);
  assert.equal(neutral.saturation, 0);

  assert.equal(evaluateFlubberMapping("waveSizeVariation", defaults.waveSizeVariation, { x: 1, y: 0 }), 0);
  assert.equal(evaluateFlubberMapping("waveSizeVariation", defaults.waveSizeVariation, { x: -1, y: 0 }), 0.8);
  assert.equal(normalizedDriver("angle", { x: 0, y: -1 }), 0.75);
  assert.equal(evaluateFlubberMapping("saturation", {
    min: 0.42,
    max: 0.42,
    drivenBy: "angle",
    reverse: true,
  }, { x: -1, y: -1 }), 0.42);
});

test("mapping validation is closed-world and enforces each declared range", () => {
  const mapping = { min: 0, max: 1, drivenBy: "radius", reverse: false };
  assert.deepEqual(validateFlubberMapping("saturation", mapping), mapping);
  assert.throws(() => validateFlubberMapping("saturation", { ...mapping, extra: true }), /unknown field extra/);
  assert.throws(() => validateFlubberMapping("saturation", { ...mapping, min: -0.01 }), /within 0–1/);
  assert.throws(() => validateFlubberMapping("saturation", { ...mapping, min: 0.8, max: 0.2 }), /must not exceed/);
});

test("participant IDs use sufficient zero padding", () => {
  assert.deepEqual(participantIds(3), ["P001", "P002", "P003"]);
  const thousand = participantIds(1_000);
  assert.equal(thousand[0], "P0001");
  assert.equal(thousand.at(-1), "P1000");
});

test("participant code uses Unicode graphemes and derived records erase raw names", () => {
  assert.equal(participantCode("George", "Fejer"), "EF");
  assert.equal(participantCode("Jose\u0301", "Öztürk"), "ÉÖ");
  assert.equal(participantCode("Groß", "Huber"), "SH", "uppercase expansion still yields one grapheme");
  const record = deriveParticipantRecord({
    firstName: "Erika",
    lastName: "Fischer",
    age: 27,
    gender: "W",
    handedness: "R",
  });
  assert.deepEqual(record, { participantCode: "AF", age: 27, gender: "W", handedness: "R" });
  assert.equal("firstName" in record, false);
  assert.equal("lastName" in record, false);
  assert.throws(() => participantCode("A/", "B"), /filename-reserved/);
});

test("session stem follows the canonical coded-demographics filename format", () => {
  assert.equal(compactUtcTimestamp("2026-09-03T14:30:12.482Z"), "20260903T143012482Z");
  assert.equal(createSessionStem({
    participantId: "P001",
    participantCode: "EF",
    age: 27,
    gender: "W",
    handedness: "R",
    startedAt: "2026-09-03T14:30:12.482Z",
    attemptNumber: 1,
  }), "P001_EF_A27_GW_HR_20260903T143012482Z_R01");
  assert.match(createSessionStem({
    participantId: "P1000",
    participantCode: "李王",
    age: 120,
    gender: "X",
    handedness: "A",
    startedAt: new Date("2026-09-03T14:30:12.482Z"),
    attemptNumber: 101,
  }), /_R101$/u);
});
