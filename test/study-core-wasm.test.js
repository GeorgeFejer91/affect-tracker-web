import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import initStudyCore, {
  WasmStudyAuthorityV1,
  protocolHashJsonV1,
  publishStudyJsonV1,
  validateResultManifestJsonV1,
} from "../site/vendor/study-core/affect_tracker_study_core.js";
import { normalizeProtocolHashResult } from "../site/src/study/core-adapter.js";
import {
  cloneStudy,
  createDefaultStudy,
  createQuestionnaireItem,
} from "../site/src/study/schema.js";
import {
  branchSourceCandidates,
  createDefaultRunCondition,
} from "../site/src/study/flow-model.js";

const fixtureUrl = (name) => new URL(`../crates/study-core/fixtures/${name}`, import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(fixtureUrl(name), "utf8"));

await initStudyCore({
  module_or_path: await readFile(new URL(
    "../site/vendor/study-core/affect_tracker_study_core_bg.wasm",
    import.meta.url,
  )),
});

test("browser adapter treats the WASM protocol hash as a digest, not JSON", () => {
  const digest = "7a".repeat(32);
  assert.equal(normalizeProtocolHashResult(digest), digest);
  assert.throws(() => normalizeProtocolHashResult(JSON.stringify(digest)), TypeError);
  assert.throws(() => normalizeProtocolHashResult("7not-json"), TypeError);
});

test("vendored WASM publishes the exact native protocol hash", async () => {
  const [study, golden] = await Promise.all([
    readJson("study-v1.json"),
    readJson("golden-vectors-v1.json"),
  ]);

  assert.equal(protocolHashJsonV1(JSON.stringify(study)), golden.protocolHash);
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(study)));
  assert.equal(published.protocolHash, golden.protocolHash);
});

test("the browser designer starts from a publishable three-section flow", () => {
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(
    createDefaultStudy({ studyId: "default-study-contract" }),
  )));
  assert.match(published.protocolHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    published.sections.map(({ sectionId }) => sectionId),
    ["onboarding", "main", "finish"],
  );
});

test("every branch literal emitted by Study Studio is accepted by the shared core", () => {
  const study = createDefaultStudy({ studyId: "branch-literal-contract" });
  for (const type of ["singleChoice", "multipleChoice", "likert", "vas", "numeric", "affect2d"]) {
    study.questionnaires[0].items.push(createQuestionnaireItem(type, `branch-${type.toLowerCase()}`));
  }
  const candidates = branchSourceCandidates(study, 1);
  assert.equal(candidates.length, 7);

  for (const candidate of candidates) {
    const candidateStudy = cloneStudy(study);
    candidateStudy.sections[1].trials[0].runIf = createDefaultRunCondition(candidate);
    const published = JSON.parse(publishStudyJsonV1(JSON.stringify(candidateStudy)));
    assert.match(published.protocolHash, /^[0-9a-f]{64}$/);
    assert.equal(
      published.sections[1].trials[0].runIf.itemId,
      candidate.item.itemId,
    );
  }
});

test("vendored WASM applies the native action contract with one-based events", async () => {
  const [study, configuration, action] = await Promise.all([
    readJson("study-v1.json"),
    readJson("run-configuration-v1.json"),
    readJson("study-action-v1.json"),
  ]);
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(study)));
  const authority = new WasmStudyAuthorityV1(
    JSON.stringify(published),
    JSON.stringify(configuration),
    7n,
  );

  try {
    const initial = JSON.parse(authority.stateJson());
    assert.equal(initial.phase, "created");
    assert.equal(initial.revision, 0);
    assert.equal(initial.lastEventSequence, 0);

    const outcome = JSON.parse(authority.applyJson(JSON.stringify(action)));
    assert.equal(outcome.state.phase, "prepared");
    assert.equal(outcome.state.revision, 1);
    assert.equal(outcome.events[0].sequence, 1);
    assert.equal(outcome.events[0].payload.type, "prepared");
  } finally {
    authority.free();
  }
});

test("vendored WASM strictly validates browser result manifests", async () => {
  const [study, configuration, golden] = await Promise.all([
    readJson("study-v1.json"),
    readJson("run-configuration-v1.json"),
    readJson("golden-vectors-v1.json"),
  ]);
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(study)));
  const manifest = {
    schema: "affect-tracker-result-manifest",
    version: 1,
    resultId: "result-fixture-001",
    runId: configuration.runId,
    studyId: published.studyId,
    protocolHash: published.protocolHash,
    settingsSha256: published.pinnedSettings.portableSettingsSha256,
    build: { platform: "desktop", appVersion: "1.0.0", buildCommit: "test-build" },
    assetVerification: [{
      assetId: "clip-a",
      expectedSha256: published.media[0].sha256,
      expectedByteLength: published.media[0].byteLength,
      verified: true,
      observedSha256: published.media[0].sha256,
      observedByteLength: published.media[0].byteLength,
    }],
    randomSeed: configuration.randomSeed,
    counterbalanceGroup: configuration.counterbalanceGroup,
    resolvedOrder: golden.resolvedOrder,
    completionStatus: "completed",
    eventCount: 29,
    csvSha256: "c".repeat(64),
    finalizedWallTimeUtc: "2026-09-03T12:30:00Z",
  };

  assert.deepEqual(
    JSON.parse(validateResultManifestJsonV1(JSON.stringify(manifest))),
    manifest,
  );
  assert.throws(() => validateResultManifestJsonV1(JSON.stringify({
    ...manifest,
    nativePath: "C:/forbidden.csv",
  })));
});
