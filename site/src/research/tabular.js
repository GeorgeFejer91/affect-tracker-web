import {
  validateResearchSampleV1,
  validateResolvedAssignmentPlanV1,
} from "./contracts.js";

export const RESEARCH_SAMPLE_COLUMNS = Object.freeze([
  "schema",
  "version",
  "sequence",
  "runId",
  "participantId",
  "attemptNumber",
  "settingsSha256",
  "assignmentPlanSha256",
  "stimulusPosition",
  "stimulusKind",
  "stimulusId",
  "stimulusSha256",
  "stimulusByteLength",
  "stimulusDurationMs",
  "stimulusUrl",
  "stimulusVideoId",
  "wallTimeUtc",
  "monotonicTimeNs",
  "lslTimeSeconds",
  "sampleRateHz",
  "scheduledElapsedMs",
  "observedElapsedMs",
  "schedulerLatenessMs",
  "schedulerJitterMs",
  "stateAnchorAgeMs",
  "missedSlotsBefore",
  "mediaTimeMs",
  "currentValence",
  "currentArousal",
  "targetValence",
  "targetArousal",
  "radius",
  "angleDegrees",
  "oscillationFrequency",
  "edgeSmoothness",
  "projectionAmplitude",
  "pulseSynchrony",
  "waveSizeVariation",
  "saturation",
  "animationActive",
  "inputActive",
  "inputKind",
  "feedbackVisible",
]);

export const ASSIGNMENT_PLAN_COLUMNS = Object.freeze([
  "participantId",
  "conditionOrder",
  "position",
  "poolId",
  "poolPosition",
  "stimulusId",
  "stimulusTitle",
  "sourceKind",
  "sourceReference",
  "stimulusSha256",
  "stimulusByteLength",
  "stimulusDurationMs",
  "settingsSha256",
  "planHashSha256",
  "algorithmVersion",
  "seed",
]);

function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Tabular output cannot contain a non-finite number.");
    return String(Object.is(value, -0) ? 0 : value);
  }
  return String(value).normalize("NFC");
}

function escaped(value, delimiter) {
  const output = cell(value);
  return output.includes(delimiter) || /["\r\n]/u.test(output)
    ? `"${output.replaceAll('"', '""')}"`
    : output;
}

function serializeRows(columns, rows, delimiter) {
  return [columns, ...rows]
    .map((row) => row.map((value) => escaped(value, delimiter)).join(delimiter))
    .join("\r\n") + "\r\n";
}

function sampleRow(sample) {
  const identity = sample.stimulusIdentity;
  return [
    sample.schema,
    sample.version,
    sample.sequence,
    sample.runId,
    sample.participantId,
    sample.attemptNumber,
    sample.settingsSha256,
    sample.assignmentPlanSha256,
    sample.stimulusPosition,
    identity.kind,
    identity.stimulusId,
    identity.sha256,
    identity.byteLength,
    identity.durationMs,
    identity.url,
    identity.videoId,
    sample.wallTimeUtc,
    sample.monotonicTimeNs,
    sample.lslTimeSeconds,
    sample.sampleRateHz,
    sample.scheduledElapsedMs,
    sample.observedElapsedMs,
    sample.schedulerLatenessMs,
    sample.schedulerJitterMs,
    sample.stateAnchorAgeMs,
    sample.missedSlotsBefore,
    sample.mediaTimeMs,
    sample.currentValence,
    sample.currentArousal,
    sample.targetValence,
    sample.targetArousal,
    sample.radius,
    sample.angleDegrees,
    sample.oscillationFrequency,
    sample.edgeSmoothness,
    sample.projectionAmplitude,
    sample.pulseSynchrony,
    sample.waveSizeVariation,
    sample.saturation,
    sample.animationActive,
    sample.inputActive,
    sample.inputKind,
    sample.feedbackVisible,
  ];
}

function normalizedFormat(options) {
  const format = typeof options === "string" ? options : options?.format;
  if (format !== "csv" && format !== "tsv") throw new TypeError("Ratings format must be csv or tsv.");
  return format;
}

/**
 * Serialize canonical sample records. CSV and TSV use exactly the same row
 * projection, column order, value formatting, and CRLF record endings.
 */
export function serializeRatings(samples, options = { format: "csv" }) {
  const format = normalizedFormat(options);
  if (!Array.isArray(samples)) throw new TypeError("Ratings must be an array of ResearchSampleV1 records.");
  const normalized = samples.map(validateResearchSampleV1);
  if (normalized.length && normalized[0].sequence !== 1) {
    throw new TypeError("Rating sample sequence must start at one.");
  }
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.sequence !== previous.sequence + 1) throw new TypeError("Rating sample sequence must be contiguous and strictly increasing.");
    for (const field of ["runId", "participantId", "attemptNumber", "settingsSha256", "assignmentPlanSha256", "sampleRateHz"]) {
      if (current[field] !== previous[field]) throw new TypeError(`Rating sample field ${field} changed within one output file.`);
    }
    if (BigInt(current.monotonicTimeNs) < BigInt(previous.monotonicTimeNs)
      || current.scheduledElapsedMs <= previous.scheduledElapsedMs
      || current.observedElapsedMs < previous.observedElapsedMs) {
      throw new TypeError("Rating sample timing must remain monotonic in canonical journal order.");
    }
  }
  return serializeRows(RESEARCH_SAMPLE_COLUMNS, normalized.map(sampleRow), format === "csv" ? "," : "\t");
}

export function samplesToCsv(samples) {
  return serializeRatings(samples, { format: "csv" });
}

export function samplesToTsv(samples) {
  return serializeRatings(samples, { format: "tsv" });
}

/** Serialize the resolved schedule shown during Review & Start. */
export async function assignmentPlanToCsv(value) {
  const plan = await validateResolvedAssignmentPlanV1(value);
  const stimuli = new Map(plan.stimuli.map((stimulus) => [stimulus.stimulusId, stimulus]));
  const rows = plan.assignments.flatMap((assignment) => assignment.slots.map((slot) => {
    const stimulus = stimuli.get(slot.stimulusId);
    const source = stimulus.source;
    const reference = source.kind === "youtube" ? source.url : source.relativePath;
    return [
      assignment.participantId,
      assignment.conditionOrder.join("|"),
      slot.position,
      slot.poolId,
      slot.poolPosition,
      stimulus.stimulusId,
      stimulus.title,
      source.kind,
      reference,
      source.kind === "youtube" ? null : source.sha256,
      source.kind === "youtube" ? null : source.byteLength,
      source.kind === "youtube" ? source.observedDurationMs : source.durationMs,
      plan.settingsSha256,
      plan.planHashSha256,
      plan.algorithmVersion,
      plan.seed,
    ];
  }));
  return serializeRows(ASSIGNMENT_PLAN_COLUMNS, rows, ",");
}
