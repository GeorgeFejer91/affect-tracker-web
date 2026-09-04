import { canonicalSha256, sha256Hex } from "./canonical.js";
import {
  BALANCED_ALGORITHM_VERSION,
  RESOLVED_ASSIGNMENT_PLAN_SCHEMA,
  validateResearchSettingsV1,
  validateResolvedAssignmentPlanV1,
} from "./contracts.js";
import { participantIds } from "./identity.js";

const MAX_CONDITIONS = 256;
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function checkedSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_CONDITIONS) {
    throw new RangeError(`Condition count must be an integer from 1 through ${MAX_CONDITIONS}.`);
  }
  return size;
}

/**
 * Return zero-based Williams balanced Latin-square rows. Odd designs append
 * one reversed companion for every row to balance directed first-order carryover.
 */
export function williamsRows(size) {
  const count = checkedSize(size);
  const base = Array.from({ length: count }, (_, position) => {
    if (position === 0) return 0;
    if (position % 2 === 1) return Math.ceil(position / 2);
    return count - position / 2;
  });
  const rows = Array.from({ length: count }, (_, offset) => (
    base.map((value) => (value + offset) % count)
  ));
  if (count % 2 === 1) rows.push(...rows.map((row) => [...row].reverse()));
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/** Return zero-based cyclic rotations in protocol column order. */
export function cyclicRows(size) {
  const count = checkedSize(size);
  return Object.freeze(Array.from({ length: count }, (_, offset) => Object.freeze(
    Array.from({ length: count }, (_, position) => (position + offset) % count),
  )));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

/**
 * Analyze whether the participant-by-slot matrix can expose every selected
 * stimulus. `uncoveredStimulusIds` uses stable stimulus-ID order so a blocked
 * configuration always presents the same concrete diagnostic.
 */
export function analyzeAssignmentCoverage(value) {
  const settings = validateResearchSettingsV1(value);
  const participantCount = settings.experiment.participantCount;
  const reports = settings.stimuli.pools.map((pool) => {
    const requiredStimuli = pool.stimulusIds.length;
    const capacitySlots = participantCount * pool.videosPerParticipant;
    const uncoveredCount = Math.max(0, requiredStimuli - capacitySlots);
    const uniqueWithinParticipant = pool.videosPerParticipant <= requiredStimuli;
    const minimumParticipantCount = Math.ceil(requiredStimuli / pool.videosPerParticipant);
    const minimumVideosPerParticipant = Math.ceil(requiredStimuli / participantCount);
    const uncoveredStimulusIds = uncoveredCount
      ? pool.stimulusIds.slice().sort().slice(capacitySlots)
      : [];
    const blockingReasons = [];
    if (!uniqueWithinParticipant) blockingReasons.push("videos-per-participant-exceeds-pool");
    if (uncoveredCount) blockingReasons.push("insufficient-cohort-slots");
    return {
      poolId: pool.poolId,
      label: pool.label,
      requiredStimuli,
      videosPerParticipant: pool.videosPerParticipant,
      participantCount,
      capacitySlots,
      uncoveredCount,
      uncoveredStimulusIds,
      blockingReasons,
      adjustment: {
        minimumParticipantCount,
        additionalParticipants: Math.max(0, minimumParticipantCount - participantCount),
        minimumVideosPerParticipant,
        additionalVideosPerParticipant: Math.max(0, minimumVideosPerParticipant - pool.videosPerParticipant),
        maximumVideosPerParticipant: requiredStimuli,
        videosPerParticipantReduction: Math.max(0, pool.videosPerParticipant - requiredStimuli),
      },
    };
  });
  const globalReasons = [];
  if (!settings.stimuli.items.length) globalReasons.push("no-stimuli-selected");
  if (!settings.stimuli.pools.length) globalReasons.push("no-condition-pools");
  const minimumParticipantCount = reports.length
    ? Math.max(...reports.map(({ adjustment }) => adjustment.minimumParticipantCount))
    : participantCount;
  return freezeDeep({
    valid: globalReasons.length === 0 && reports.every(({ blockingReasons }) => !blockingReasons.length),
    participantCount,
    minimumParticipantCount,
    additionalParticipants: Math.max(0, minimumParticipantCount - participantCount),
    totalVideosPerParticipant: settings.stimuli.pools.reduce((sum, pool) => sum + pool.videosPerParticipant, 0),
    globalReasons,
    pools: reports,
  });
}

export class ResearchCapacityError extends Error {
  constructor(coverage) {
    const pool = coverage.pools.find(({ blockingReasons }) => blockingReasons.length);
    const detail = pool
      ? `${pool.label}: ${pool.blockingReasons.join(", ")}`
      : coverage.globalReasons.join(", ");
    super(`The Research assignment plan is not feasible${detail ? ` (${detail})` : ""}.`);
    this.name = "ResearchCapacityError";
    this.coverage = coverage;
  }
}

async function tieBreakKey(seed, participantId, poolId, position, stimulusId) {
  return sha256Hex([
    "affect-research:balanced-v1",
    seed,
    participantId,
    poolId,
    String(position),
    stimulusId,
  ].join("\0"));
}

async function chooseStimulus({
  candidates,
  used,
  totalExposure,
  positionExposure,
  seed,
  participantId,
  poolId,
  position,
}) {
  let available = candidates.filter((stimulusId) => !used.has(stimulusId));
  if (!available.length) throw new Error(`Pool ${poolId} has no unique candidate for ${participantId}.`);
  const lowestTotal = Math.min(...available.map((stimulusId) => totalExposure.get(stimulusId)));
  available = available.filter((stimulusId) => totalExposure.get(stimulusId) === lowestTotal);
  const lowestPosition = Math.min(...available.map((stimulusId) => positionExposure.get(stimulusId)[position - 1]));
  available = available.filter((stimulusId) => positionExposure.get(stimulusId)[position - 1] === lowestPosition);
  if (available.length === 1) return available[0];
  const ranked = await Promise.all(available.map(async (stimulusId) => ({
    stimulusId,
    key: await tieBreakKey(seed, participantId, poolId, position, stimulusId),
  })));
  ranked.sort((left, right) => lexical(left.key, right.key) || lexical(left.stimulusId, right.stimulusId));
  return ranked[0].stimulusId;
}

function conditionRows(method, size) {
  return method === "williams" ? williamsRows(size) : cyclicRows(size);
}

/**
 * Resolve and hash the complete participant schedule. The algorithm has no
 * ambient randomness: identical canonical settings yield byte-identical plans.
 */
export async function resolveAssignmentPlan(value) {
  const settings = validateResearchSettingsV1(value);
  const coverage = analyzeAssignmentCoverage(settings);
  if (!coverage.valid) throw new ResearchCapacityError(coverage);

  const settingsSha256 = await canonicalSha256(settings);
  const participants = [...participantIds(settings.experiment.participantCount)];
  const pools = settings.stimuli.pools;
  const totalSlots = pools.reduce((sum, pool) => sum + pool.videosPerParticipant, 0);
  const rows = conditionRows(settings.stimuli.conditionOrder, pools.length);
  const totalExposure = new Map(settings.stimuli.items.map(({ stimulusId }) => [stimulusId, 0]));
  const positionExposure = new Map(settings.stimuli.items.map(({ stimulusId }) => [
    stimulusId,
    Array(totalSlots).fill(0),
  ]));

  const assignments = [];
  for (let participantIndex = 0; participantIndex < participants.length; participantIndex += 1) {
    const participantId = participants[participantIndex];
    const poolOrder = rows[participantIndex % rows.length].map((index) => pools[index]);
    const used = new Set();
    const perPoolPosition = new Map(pools.map(({ poolId }) => [poolId, 0]));
    const slots = [];
    for (const pool of poolOrder) {
      for (let poolOffset = 0; poolOffset < pool.videosPerParticipant; poolOffset += 1) {
        const position = slots.length + 1;
        const stimulusId = await chooseStimulus({
          candidates: pool.stimulusIds,
          used,
          totalExposure,
          positionExposure,
          seed: settings.stimuli.seed,
          participantId,
          poolId: pool.poolId,
          position,
        });
        used.add(stimulusId);
        totalExposure.set(stimulusId, totalExposure.get(stimulusId) + 1);
        positionExposure.get(stimulusId)[position - 1] += 1;
        const poolPosition = perPoolPosition.get(pool.poolId) + 1;
        perPoolPosition.set(pool.poolId, poolPosition);
        slots.push({ position, poolId: pool.poolId, poolPosition, stimulusId });
      }
    }
    assignments.push({
      participantId,
      conditionOrder: poolOrder.map(({ poolId }) => poolId),
      slots,
    });
  }

  for (const pool of pools) {
    const counts = pool.stimulusIds.map((stimulusId) => totalExposure.get(stimulusId));
    if (Math.max(...counts) - Math.min(...counts) > 1) {
      throw new Error(`balanced-v1 invariant failed for pool ${pool.poolId}.`);
    }
  }

  const exposureCounts = settings.stimuli.items.map(({ stimulusId }) => ({
    stimulusId,
    total: totalExposure.get(stimulusId),
    positionCounts: [...positionExposure.get(stimulusId)],
  }));
  const unhashed = {
    schema: RESOLVED_ASSIGNMENT_PLAN_SCHEMA,
    version: 1,
    algorithmVersion: BALANCED_ALGORITHM_VERSION,
    seed: settings.stimuli.seed,
    conditionOrder: settings.stimuli.conditionOrder,
    settingsSha256,
    participantIds: participants,
    stimuli: settings.stimuli.items.map((item) => structuredClone(item)),
    pools: pools.map((pool) => structuredClone(pool)),
    assignments,
    exposureCounts,
  };
  const plan = {
    ...unhashed,
    planHashSha256: await canonicalSha256(unhashed),
  };
  return validateResolvedAssignmentPlanV1(plan);
}

export const resolveAssignmentPlanV1 = resolveAssignmentPlan;
