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
    const now = this.now();
    const context = this.context();
    const record = {
      session_id: this.sessionId,
      sequence: this.sequence,
      elapsed_ms: Math.round((now - this.startedAt) * 1000) / 1000,
      iso_time: this.wallClock().toISOString(),
      record_type: recordType,
      source: details.source ?? "system",
      action: details.action ?? "",
      control: details.control ?? "",
      value: details.value ?? "",
      experiment_id: context.experimentId ?? "",
      stimulus_id: context.stimulusId ?? "",
      stimulus_time_seconds: context.stimulusTimeSeconds ?? "",
      current_x: state.currentX,
      current_y: state.currentY,
      target_x: state.targetX,
      target_y: state.targetY,
      input_mode: state.inputMode,
      animation_active: state.animationActive,
      widget_x: Math.round(state.widgetX * 1000) / 1000,
      widget_y: Math.round(state.widgetY * 1000) / 1000,
    };
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
