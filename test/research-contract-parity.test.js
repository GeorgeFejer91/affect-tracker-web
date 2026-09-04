import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  canonicalJson,
  canonicalSha256,
} from "../site/src/research/canonical.js";
import {
  validateResearchEventV1,
  validateResearchRunManifestV2,
  validateResearchSampleV1,
  validateResearchSettingsV1,
  validateResolvedAssignmentPlanV1,
} from "../site/src/research/contracts.js";
import { resolveAssignmentPlan } from "../site/src/research/counterbalancer.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/research-contract-parity-v1.json", import.meta.url),
  "utf8",
));

function mutateFixture(base, mutations) {
  const value = structuredClone(base);
  for (const mutation of mutations) {
    let target = value;
    for (const segment of mutation.path.slice(0, -1)) target = target[segment];
    const key = mutation.path.at(-1);
    if (mutation.operation === "remove") delete target[key];
    else if (mutation.repeatedText) {
      const { prefix = "", unit, count, suffix = "" } = mutation.repeatedText;
      target[key] = `${prefix}${unit.repeat(count)}${suffix}`;
    } else target[key] = structuredClone(mutation.value);
  }
  return value;
}

const validators = Object.freeze({
  settings: (value) => validateResearchSettingsV1(value),
  plan: (value) => validateResolvedAssignmentPlanV1(value),
  sample: (value) => validateResearchSampleV1(value),
  event: (value) => validateResearchEventV1(value),
  manifest: (value) => validateResearchRunManifestV2(value),
});

test("shared JS/Rust fixture fixes canonical JSON and SHA-256 bytes", async () => {
  assert.equal(fixture.schema, "affect-research-cross-runtime-fixture");
  assert.equal(fixture.version, 1);
  assert.equal(canonicalJson(fixture.canonical.value), fixture.canonical.json);
  assert.equal(await canonicalSha256(fixture.canonical.value), fixture.canonical.sha256);
  assert.equal(canonicalJson(fixture.canonicalNumbers.value), fixture.canonicalNumbers.json);
  assert.equal(
    await canonicalSha256(fixture.canonicalNumbers.value),
    fixture.canonicalNumbers.sha256,
  );
});

test("shared JS/Rust fixture round-trips every active persistence contract", async () => {
  const settings = validateResearchSettingsV1(structuredClone(fixture.valid.settings.value));
  assert.deepEqual(settings, fixture.valid.settings.value);
  assert.equal(await canonicalSha256(settings), fixture.valid.settings.canonicalSha256);

  const generatedPlan = await resolveAssignmentPlan(settings);
  assert.deepEqual(generatedPlan, fixture.valid.plan.value);
  const plan = await validateResolvedAssignmentPlanV1(structuredClone(fixture.valid.plan.value));
  assert.deepEqual(plan, fixture.valid.plan.value);
  assert.equal(await canonicalSha256(plan), fixture.valid.plan.canonicalSha256);

  for (const [contract, validator] of [
    ["sample", validateResearchSampleV1],
    ["event", validateResearchEventV1],
    ["manifest", validateResearchRunManifestV2],
  ]) {
    const normalized = validator(structuredClone(fixture.valid[contract].value));
    assert.deepEqual(normalized, fixture.valid[contract].value, `${contract} fixture is canonical`);
    assert.equal(
      await canonicalSha256(normalized),
      fixture.valid[contract].canonicalSha256,
      `${contract} canonical SHA-256 is byte-stable`,
    );
  }
});

test("shared JS/Rust fixture fixes the YouTube canonicalization boundary", () => {
  const settingsValue = structuredClone(fixture.valid.settings.value);
  settingsValue.stimuli.items[0].source = {
    kind: "youtube",
    url: fixture.youtubeUrl.noncanonical,
    videoId: fixture.youtubeUrl.videoId,
    observedTitle: null,
    observedDurationMs: null,
  };
  const settings = validateResearchSettingsV1(settingsValue);
  assert.equal(settings.stimuli.items[0].source.url, fixture.youtubeUrl.normalized);

  const sampleValue = structuredClone(fixture.valid.sample.value);
  sampleValue.stimulusIdentity = {
    kind: "youtube",
    stimulusId: sampleValue.stimulusIdentity.stimulusId,
    sha256: null,
    byteLength: null,
    durationMs: sampleValue.stimulusIdentity.durationMs,
    url: fixture.youtubeUrl.canonical,
    videoId: fixture.youtubeUrl.videoId,
  };
  const sample = validateResearchSampleV1(sampleValue);
  assert.equal(sample.stimulusIdentity.url, fixture.youtubeUrl.canonical);
});

test("shared JS/Rust fixture fixes ECMAScript text trimming and control rejection", async () => {
  const settingsValue = structuredClone(fixture.valid.settings.value);
  settingsValue.experiment.title = fixture.textNormalization.input;
  const settings = validateResearchSettingsV1(settingsValue);
  assert.equal(settings.experiment.title, fixture.textNormalization.normalized);
  assert.equal(
    await canonicalSha256(settings),
    fixture.textNormalization.settingsCanonicalSha256,
  );
});

test("shared JS/Rust malformed and unknown-field corpus fails closed", async (context) => {
  for (const invalid of fixture.invalid) {
    await context.test(invalid.id, async () => {
      const input = mutateFixture(fixture.valid[invalid.contract].value, invalid.mutations);
      await assert.rejects(async () => validators[invalid.contract](input));
    });
  }
});
