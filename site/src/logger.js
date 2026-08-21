import { RingBuffer } from "./ring-buffer.js";

export const CSV_FIELDS = [
  "session_id",
  "sequence",
  "elapsed_ms",
  "iso_time",
  "record_type",
  "source",
  "action",
  "control",
  "value",
  "experiment_id",
  "stimulus_id",
  "stimulus_time_seconds",
  "current_x",
  "current_y",
  "target_x",
  "target_y",
  "input_mode",
  "animation_active",
  "widget_x",
  "widget_y",
  "input_source",
  "algorithm_version",
  "active_elapsed_ms",
  "playback_active",
  "pointer_time_ms",
  "pointer_id",
  "pointer_type",
  "pointer_phase",
  "stroke_id",
  "coalesced_index",
  "client_x",
  "client_y",
  "normalized_x",
  "normalized_y",
  "pressure",
  "buttons",
  "viewport_width",
  "viewport_height",
  "raw_speed",
  "filtered_speed",
  "speed_feature",
  "shape_feature",
  "turn_activity",
  "turn_coherence",
  "sign_flip_rate",
  "roughness",
  "speed_lower",
  "speed_upper",
  "shape_lower",
  "shape_upper",
  "mapped_x",
  "mapped_y",
  "speed_confidence",
  "shape_confidence",
  "motion_active",
  "trace_feedback_visible",
];

function defaultSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function recordsToCsv(records) {
  const rows = [CSV_FIELDS.join(",")];
  for (const record of records) {
    rows.push(CSV_FIELDS.map((field) => escapeCsv(record[field])).join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function createRecord({ sessionId, sequence, startedAt, now, wallClock, context, recordType, details, state }) {
  const timestamp = now();
  const recordContext = context();
  return {
    session_id: sessionId,
    sequence,
    elapsed_ms: Math.round((timestamp - startedAt) * 1000) / 1000,
    iso_time: wallClock().toISOString(),
    record_type: recordType,
    source: details.source ?? "system",
    action: details.action ?? "",
    control: details.control ?? "",
    value: details.value ?? "",
    experiment_id: recordContext.experimentId ?? "",
    stimulus_id: recordContext.stimulusId ?? "",
    stimulus_time_seconds: recordContext.stimulusTimeSeconds ?? "",
    current_x: state.currentX,
    current_y: state.currentY,
    target_x: state.targetX,
    target_y: state.targetY,
    input_mode: state.inputMode,
    animation_active: state.animationActive,
    widget_x: Math.round(state.widgetX * 1000) / 1000,
    widget_y: Math.round(state.widgetY * 1000) / 1000,
    input_source: state.inputSource ?? "manual",
    algorithm_version: details.algorithmVersion ?? recordContext.algorithmVersion ?? "",
    active_elapsed_ms: recordContext.activeElapsedMs ?? "",
    playback_active: recordContext.playbackActive ?? "",
    pointer_time_ms: details.pointerTimeMs ?? "",
    pointer_id: details.pointerId ?? "",
    pointer_type: details.pointerType ?? "",
    pointer_phase: details.pointerPhase ?? "",
    stroke_id: details.strokeId ?? "",
    coalesced_index: details.coalescedIndex ?? "",
    client_x: details.clientX ?? "",
    client_y: details.clientY ?? "",
    normalized_x: details.normalizedX ?? "",
    normalized_y: details.normalizedY ?? "",
    pressure: details.pressure ?? "",
    buttons: details.buttons ?? "",
    viewport_width: details.viewportWidth ?? "",
    viewport_height: details.viewportHeight ?? "",
    raw_speed: details.rawSpeed ?? "",
    filtered_speed: details.filteredSpeed ?? "",
    speed_feature: details.speedFeature ?? "",
    shape_feature: details.shapeFeature ?? "",
    turn_activity: details.turnActivity ?? "",
    turn_coherence: details.turnCoherence ?? "",
    sign_flip_rate: details.signFlipRate ?? "",
    roughness: details.roughness ?? "",
    speed_lower: details.speedLower ?? "",
    speed_upper: details.speedUpper ?? "",
    shape_lower: details.shapeLower ?? "",
    shape_upper: details.shapeUpper ?? "",
    mapped_x: details.mappedX ?? "",
    mapped_y: details.mappedY ?? "",
    speed_confidence: details.speedConfidence ?? "",
    shape_confidence: details.shapeConfidence ?? "",
    motion_active: details.motionActive ?? "",
    trace_feedback_visible: details.traceFeedbackVisible ?? "",
  };
}

function csvRow(record) {
  return `${CSV_FIELDS.map((field) => escapeCsv(record[field])).join(",")}\r\n`;
}

export class AffectLogger {
  constructor({ capacity = 10_000, now = () => performance.now(), wallClock = () => new Date(), sessionId = defaultSessionId, context = () => ({}) } = {}) {
    this.buffer = new RingBuffer(capacity);
    this.now = now;
    this.wallClock = wallClock;
    this.sessionIdFactory = sessionId;
    this.context = context;
    this.resetSession();
  }

  resetSession({ capacity } = {}) {
    if (capacity !== undefined && capacity !== this.buffer.capacity) this.buffer = new RingBuffer(capacity);
    else this.buffer.clear();
    this.sessionId = this.sessionIdFactory();
    this.sequence = 0;
    this.startedAt = this.now();
    this.eventCount = 0;
    this.sampleCount = 0;
  }

  record(recordType, details, state) {
    const record = createRecord({
      sessionId: this.sessionId,
      sequence: this.sequence,
      startedAt: this.startedAt,
      now: this.now,
      wallClock: this.wallClock,
      context: this.context,
      recordType,
      details,
      state,
    });
    this.sequence += 1;
    if (recordType === "sample") this.sampleCount += 1;
    else this.eventCount += 1;
    this.buffer.push(record);
    return record;
  }

  exportCsv() {
    return recordsToCsv(this.buffer.toArray());
  }
}

export class ExperimentCsvWriter {
  constructor({
    chunkSize = 1_000,
    now = () => performance.now(),
    wallClock = () => new Date(),
    sessionId = defaultSessionId,
    context = () => ({}),
  } = {}) {
    this.chunkSize = chunkSize;
    this.now = now;
    this.wallClock = wallClock;
    this.sessionIdFactory = sessionId;
    this.context = context;
    this.resetSession();
  }

  resetSession() {
    this.sessionId = this.sessionIdFactory();
    this.sequence = 0;
    this.startedAt = this.now();
    this.eventCount = 0;
    this.sampleCount = 0;
    this.pointerCount = 0;
    this.metricCount = 0;
    this.chunks = [];
    this.pendingRows = [];
    this.estimatedBytes = CSV_FIELDS.join(",").length + 4;
  }

  get length() {
    return this.sequence;
  }

  record(recordType, details, state) {
    const record = createRecord({
      sessionId: this.sessionId,
      sequence: this.sequence,
      startedAt: this.startedAt,
      now: this.now,
      wallClock: this.wallClock,
      context: this.context,
      recordType,
      details,
      state,
    });
    this.sequence += 1;
    if (recordType === "sample") this.sampleCount += 1;
    else if (recordType === "pointer_raw") this.pointerCount += 1;
    else if (recordType === "touch_metric") this.metricCount += 1;
    else this.eventCount += 1;
    const row = csvRow(record);
    this.pendingRows.push(row);
    this.estimatedBytes += row.length;
    if (this.pendingRows.length >= this.chunkSize) this.flush();
    return record;
  }

  flush() {
    if (this.pendingRows.length === 0) return;
    this.chunks.push(this.pendingRows.join(""));
    this.pendingRows = [];
  }

  exportParts() {
    this.flush();
    return [`\uFEFF${CSV_FIELDS.join(",")}\r\n`, ...this.chunks];
  }

  exportCsv() {
    return this.exportParts().join("");
  }
}
