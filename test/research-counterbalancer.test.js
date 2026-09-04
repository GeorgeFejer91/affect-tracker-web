import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createDefaultResearchSettings,
  validateResolvedAssignmentPlanV1,
} from "../site/src/research/contracts.js";
import {
  ResearchCapacityError,
  analyzeAssignmentCoverage,
  cyclicRows,
  resolveAssignmentPlan,
  williamsRows,
} from "../site/src/research/counterbalancer.js";

function stimulus(id, durationMs = 30_000) {
  return {
    stimulusId: id,
    title: `Stimulus ${id}`,
    source: {
      kind: "workspaceFile",
      relativePath: `stimuli/${id}.mp4`,
      mimeType: "video/mp4",
      sha256: createHash("sha256").update(id).digest("hex"),
      byteLength: 1_000_000,
      durationMs,
    },
  };
}

function settingsFor(poolSizes, videosPerParticipant, participantCount = 6, method = "williams", seed = "00112233445566778899aabbccddeeff") {
  const settings = structuredClone(createDefaultResearchSettings());
  settings.experiment.participantCount = participantCount;
  settings.stimuli.conditionOrder = method;
  settings.stimuli.seed = seed;
  settings.stimuli.items = [];
  settings.stimuli.pools = poolSizes.map((size, poolIndex) => {
    const prefix = String.fromCharCode(97 + poolIndex);
    const ids = Array.from({ length: size }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
    settings.stimuli.items.push(...ids.map((id) => stimulus(id)));
    return {
      poolId: `pool-${prefix}`,
      label: `Condition ${prefix.toUpperCase()}`,
      videosPerParticipant: videosPerParticipant[poolIndex],
      stimulusIds: ids,
    };
  });
  return settings;
}

function assertPlanInvariants(plan) {
  const allIds = new Set(plan.stimuli.map(({ stimulusId }) => stimulusId));
  for (const assignment of plan.assignments) {
    const selected = assignment.slots.map(({ stimulusId }) => stimulusId);
    assert.equal(new Set(selected).size, selected.length, `${assignment.participantId} has no duplicates`);
    assert.ok(selected.every((id) => allIds.has(id)));
  }
  for (const pool of plan.pools) {
    const counts = plan.exposureCounts
      .filter(({ stimulusId }) => pool.stimulusIds.includes(stimulusId))
      .map(({ total }) => total);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${pool.poolId} exposure is balanced`);
  }
}

test("Williams and cyclic condition matrices are exact and deterministic", () => {
  assert.deepEqual(williamsRows(4), [
    [0, 1, 3, 2],
    [1, 2, 0, 3],
    [2, 3, 1, 0],
    [3, 0, 2, 1],
  ]);
  assert.deepEqual(williamsRows(3), [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
    [0, 2, 1],
    [1, 0, 2],
  ]);
  assert.deepEqual(cyclicRows(3), [[0, 1, 2], [1, 2, 0], [2, 0, 1]]);
  assert.throws(() => williamsRows(0), /1 through 256/);
});

test("one condition column is the one-hat workflow with complete balanced coverage", async () => {
  const input = settingsFor([6], [2], 3);
  const plan = await resolveAssignmentPlan(input);
  assert.equal(plan.pools.length, 1);
  assert.equal(plan.assignments.length, 3);
  assert.ok(plan.assignments.every(({ conditionOrder }) => conditionOrder.join() === "pool-a"));
  assert.deepEqual(plan.exposureCounts.map(({ total }) => total), [1, 1, 1, 1, 1, 1]);
  assertPlanInvariants(plan);
  assert.deepEqual(await resolveAssignmentPlan(structuredClone(input)), plan);
});

test("multiple condition columns are stratified and Williams/cyclic order independently", async () => {
  const williams = await resolveAssignmentPlan(settingsFor([4, 3, 2], [2, 1, 1], 6, "williams"));
  assert.deepEqual(williams.assignments.map(({ conditionOrder }) => conditionOrder), [
    ["pool-a", "pool-b", "pool-c"],
    ["pool-b", "pool-c", "pool-a"],
    ["pool-c", "pool-a", "pool-b"],
    ["pool-c", "pool-b", "pool-a"],
    ["pool-a", "pool-c", "pool-b"],
    ["pool-b", "pool-a", "pool-c"],
  ]);
  assertPlanInvariants(williams);

  const cyclic = await resolveAssignmentPlan(settingsFor([4, 3, 2], [2, 1, 1], 6, "cyclic"));
  assert.deepEqual(cyclic.assignments.slice(0, 4).map(({ conditionOrder }) => conditionOrder), [
    ["pool-a", "pool-b", "pool-c"],
    ["pool-b", "pool-c", "pool-a"],
    ["pool-c", "pool-a", "pool-b"],
    ["pool-a", "pool-b", "pool-c"],
  ]);
  assertPlanInvariants(cyclic);
});

test("balanced-v1 seed controls only deterministic hash tie-breaks", async () => {
  const first = await resolveAssignmentPlan(settingsFor([8], [3], 8, "williams", "00000000000000000000000000000000"));
  const repeat = await resolveAssignmentPlan(settingsFor([8], [3], 8, "williams", "00000000000000000000000000000000"));
  const other = await resolveAssignmentPlan(settingsFor([8], [3], 8, "williams", "ffffffffffffffffffffffffffffffff"));
  assert.deepEqual(repeat, first);
  assert.notEqual(other.planHashSha256, first.planHashSha256);
  assert.notDeepEqual(other.assignments, first.assignments);
  assertPlanInvariants(other);
});

test("balanced-v1 has a byte-stable cross-runtime golden fixture", async () => {
  const plan = await resolveAssignmentPlan(settingsFor([4], [2], 3));
  assert.equal(plan.settingsSha256, "4a73900c017ef2a049a9e18709c34b19d4b8a8d723ac4be4c5ef8bb299fb3f12");
  assert.equal(plan.planHashSha256, "c5672c056f8a4c11ab9ce9c795d9d642f3343e595b1fa501cffbed6145e18025");
  assert.deepEqual(plan.assignments.map(({ slots }) => slots.map(({ stimulusId }) => stimulusId)), [
    ["a-02", "a-04"],
    ["a-01", "a-03"],
    ["a-04", "a-01"],
  ]);
});

test("capacity diagnostics name uncovered items and both exact adjustment paths", async () => {
  const input = settingsFor([5], [2], 2);
  const coverage = analyzeAssignmentCoverage(input);
  assert.equal(coverage.valid, false);
  assert.deepEqual(coverage.pools[0].uncoveredStimulusIds, ["a-05"]);
  assert.equal(coverage.pools[0].adjustment.minimumParticipantCount, 3);
  assert.equal(coverage.pools[0].adjustment.additionalParticipants, 1);
  assert.equal(coverage.pools[0].adjustment.minimumVideosPerParticipant, 3);
  assert.equal(coverage.pools[0].adjustment.additionalVideosPerParticipant, 1);
  await assert.rejects(resolveAssignmentPlan(input), (error) => (
    error instanceof ResearchCapacityError && error.coverage.pools[0].uncoveredCount === 1
  ));

  const tooMany = settingsFor([2], [3], 2);
  const tooManyCoverage = analyzeAssignmentCoverage(tooMany);
  assert.deepEqual(tooManyCoverage.pools[0].blockingReasons, ["videos-per-participant-exceeds-pool"]);
  assert.equal(tooManyCoverage.pools[0].adjustment.videosPerParticipantReduction, 1);
});

test("feasible pool sizes preserve coverage, uniqueness, and <=1 exposure spread", async () => {
  for (const [videos, perParticipant, participants] of [
    [1, 1, 1],
    [3, 1, 3],
    [3, 2, 2],
    [5, 2, 4],
    [7, 3, 5],
    [8, 7, 9],
  ]) {
    const plan = await resolveAssignmentPlan(settingsFor([videos], [perParticipant], participants));
    assertPlanInvariants(plan);
    assert.ok(plan.exposureCounts.every(({ total }) => total >= 1), `${videos}/${perParticipant}/${participants} covers every item`);
  }
});

test("balanced-v1 generative matrix is deterministic across one-hat, stratified, Williams, cyclic, and rerun scales", async () => {
  let cases = 0;
  for (const method of ["williams", "cyclic"]) {
    for (let poolSize = 1; poolSize <= 9; poolSize += 1) {
      for (let perParticipant = 1; perParticipant <= poolSize; perParticipant += 1) {
        const minimumParticipants = Math.ceil(poolSize / perParticipant);
        for (const participantCount of [minimumParticipants, minimumParticipants + 1, minimumParticipants + 4]) {
          const seed = createHash("sha256")
            .update(`${method}/${poolSize}/${perParticipant}/${participantCount}`)
            .digest("hex")
            .slice(0, 32);
          const input = settingsFor([poolSize], [perParticipant], participantCount, method, seed);
          const first = await resolveAssignmentPlan(input);
          const repeated = await resolveAssignmentPlan(structuredClone(input));
          assert.deepEqual(repeated, first);
          assertPlanInvariants(first);
          assert.ok(first.exposureCounts.every(({ total }) => total >= 1));
          cases += 1;
        }
      }
    }

    for (const [poolSizes, counts, participants] of [
      [[2, 3], [1, 1], 4],
      [[5, 2], [2, 2], 4],
      [[3, 4, 5], [1, 2, 2], 6],
      [[8, 7, 3, 2], [3, 2, 1, 1], 8],
    ]) {
      const input = settingsFor(poolSizes, counts, participants, method);
      const first = await resolveAssignmentPlan(input);
      assert.deepEqual(await resolveAssignmentPlan(structuredClone(input)), first);
      assertPlanInvariants(first);
      cases += 1;
    }
  }
  assert.equal(cases, 278);
});

test("plan validator detects canonical hash tampering", async () => {
  const plan = await resolveAssignmentPlan(settingsFor([4], [2], 2));
  assert.deepEqual(await validateResolvedAssignmentPlanV1(structuredClone(plan)), plan);
  const changedHash = structuredClone(plan);
  changedHash.planHashSha256 = "0".repeat(64);
  await assert.rejects(validateResolvedAssignmentPlanV1(changedHash), /plan hash does not match/);
});
