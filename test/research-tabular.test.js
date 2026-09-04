import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  RESEARCH_SAMPLE_SCHEMA,
  createDefaultResearchSettings,
} from "../site/src/research/contracts.js";
import { resolveAssignmentPlan } from "../site/src/research/counterbalancer.js";
import {
  ASSIGNMENT_PLAN_COLUMNS,
  RESEARCH_SAMPLE_COLUMNS,
  assignmentPlanToCsv,
  samplesToCsv,
  samplesToTsv,
  serializeRatings,
} from "../site/src/research/tabular.js";

const settingsHash = "1".repeat(64);
const planHash = "2".repeat(64);

function youtubeSample(sequence, overrides = {}) {
  return {
    schema: RESEARCH_SAMPLE_SCHEMA,
    version: 1,
    sequence,
    runId: "run-001",
    participantId: "P001",
    attemptNumber: 1,
    settingsSha256: settingsHash,
    assignmentPlanSha256: planHash,
    stimulusPosition: 1,
    stimulusIdentity: {
      kind: "youtube",
      stimulusId: "youtube-01",
      sha256: null,
      byteLength: null,
      durationMs: 60_000,
      url: "https://www.youtube.com/watch?v=abcdefghi&list=a,b",
      videoId: "abcdefghi",
    },
    wallTimeUtc: sequence === 1 ? "2026-09-03T14:30:12.482Z" : "2026-09-03T14:30:12.490Z",
    monotonicTimeNs: String(100_000_000 + sequence),
    lslTimeSeconds: null,
    sampleRateHz: 130,
    scheduledElapsedMs: sequence * 100,
    observedElapsedMs: sequence * 100 + 0.25,
    schedulerLatenessMs: 0.25,
    schedulerJitterMs: -0.125,
    stateAnchorAgeMs: 1,
    missedSlotsBefore: 0,
    mediaTimeMs: sequence * 100,
    currentValence: 0,
    currentArousal: 0,
    targetValence: 0.1,
    targetArousal: -0.1,
    radius: 0,
    angleDegrees: 0,
    oscillationFrequency: 1.5,
    edgeSmoothness: 0.5,
    projectionAmplitude: 0.3,
    pulseSynchrony: 0.6,
    waveSizeVariation: 0.4,
    saturation: 0,
    animationActive: true,
    inputActive: false,
    inputKind: "digital",
    feedbackVisible: true,
    ...overrides,
  };
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'; index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      row.push(field); field = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; index += 1;
    } else field += character;
  }
  assert.equal(quoted, false);
  assert.equal(field, "");
  assert.deepEqual(row, []);
  return rows;
}

test("CSV and TSV are projections of identical canonical columns, values, order, and row counts", () => {
  const samples = [youtubeSample(1), youtubeSample(2, { lslTimeSeconds: 123.5, inputActive: true })];
  const csv = samplesToCsv(samples);
  const tsv = samplesToTsv(samples);
  const csvRows = parseDelimited(csv, ",");
  const tsvRows = parseDelimited(tsv, "\t");
  assert.deepEqual(csvRows, tsvRows);
  assert.deepEqual(csvRows[0], RESEARCH_SAMPLE_COLUMNS);
  assert.equal(csvRows.length, 3);
  assert.ok(csv.includes('"https://www.youtube.com/watch?v=abcdefghi&list=a,b"'));
  assert.equal(csvRows[1][RESEARCH_SAMPLE_COLUMNS.indexOf("stimulusSha256")], "");
  assert.equal(csvRows[2][RESEARCH_SAMPLE_COLUMNS.indexOf("lslTimeSeconds")], "123.5");
});

test("ratings serializer accepts either signature and rejects mixed or reordered run records", () => {
  assert.equal(serializeRatings([youtubeSample(1)], "csv"), samplesToCsv([youtubeSample(1)]));
  assert.equal(serializeRatings([], { format: "tsv" }), `${RESEARCH_SAMPLE_COLUMNS.join("\t")}\r\n`);
  assert.throws(() => serializeRatings([youtubeSample(2), youtubeSample(1)], "csv"), /start at one|strictly increasing/);
  assert.throws(() => serializeRatings([
    youtubeSample(1),
    youtubeSample(2, { assignmentPlanSha256: "3".repeat(64) }),
  ], "tsv"), /assignmentPlanSha256 changed/);
  assert.throws(() => serializeRatings([
    youtubeSample(1),
    youtubeSample(2, { monotonicTimeNs: "1" }),
  ], "csv"), /timing must remain monotonic/u);
  assert.throws(() => serializeRatings([youtubeSample(1)], { format: "xlsx" }), /csv or tsv/);
});

test("assignment-plan.csv binds the schedule to settings, plan, source identity, and algorithm", async () => {
  const settings = structuredClone(createDefaultResearchSettings());
  settings.experiment.participantCount = 1;
  settings.stimuli.items = ["one", "two"].map((id, index) => ({
    stimulusId: id,
    title: index ? "Joy, high arousal" : "Calm",
    source: {
      kind: "workspaceFile",
      relativePath: `stimuli/${id}.mp4`,
      mimeType: "video/mp4",
      sha256: createHash("sha256").update(id).digest("hex"),
      byteLength: 1_000 + index,
      durationMs: 5_000 + index,
    },
  }));
  settings.stimuli.pools = [{
    poolId: "one-hat",
    label: "All videos",
    videosPerParticipant: 2,
    stimulusIds: ["one", "two"],
  }];
  const plan = await resolveAssignmentPlan(settings);
  const csv = await assignmentPlanToCsv(plan);
  const rows = parseDelimited(csv, ",");
  assert.deepEqual(rows[0], ASSIGNMENT_PLAN_COLUMNS);
  assert.equal(rows.length, 3);
  assert.ok(rows.slice(1).every((row) => row[ASSIGNMENT_PLAN_COLUMNS.indexOf("settingsSha256")] === plan.settingsSha256));
  assert.ok(rows.slice(1).every((row) => row[ASSIGNMENT_PLAN_COLUMNS.indexOf("planHashSha256")] === plan.planHashSha256));
  assert.ok(csv.includes('"Joy, high arousal"'));
});
