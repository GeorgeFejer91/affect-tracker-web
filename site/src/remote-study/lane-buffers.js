import { normalizeRemoteStudyScopes } from "./contracts.js";
import { bytesFrom, failContract } from "./values.js";

const encoder = new TextEncoder();

export const REMOTE_STUDY_LANE_POLICIES = Object.freeze({
  control: Object.freeze({
    delivery: "reliable-ordered",
    maximumMessageBytes: 16 * 1024,
    maximumQueuedBytes: 256 * 1024,
    maximumQueuedMessages: 64,
  }),
  state: Object.freeze({
    delivery: "replaceable-newest-only",
    maximumMessageBytes: 8 * 1024,
    maximumQueuedBytes: 8 * 1024,
    maximumQueuedMessages: 1,
  }),
  record: Object.freeze({
    delivery: "reliable-ordered",
    maximumMessageBytes: 16 * 1024,
    maximumQueuedBytes: 128 * 1024,
    maximumQueuedMessages: 32,
  }),
  export: Object.freeze({
    delivery: "reliable-ordered-bulk",
    maximumMessageBytes: 64 * 1024,
    maximumQueuedBytes: 512 * 1024,
    maximumQueuedMessages: 8,
  }),
});

export const REMOTE_STUDY_LANE_REQUIRED_SCOPES = Object.freeze({
  control: "study.control",
  state: "study.observe",
  record: "data.read",
  export: "data.export",
});

function frameBytes(value, lane) {
  const policy = REMOTE_STUDY_LANE_POLICIES[lane];
  if (typeof value === "string" && value.length > policy.maximumMessageBytes) {
    failContract("lane_message_size", `${lane} frame exceeds its message-size bound.`);
  }
  if (typeof value !== "string"
    && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    && value.byteLength > policy.maximumMessageBytes) {
    failContract("lane_message_size", `${lane} frame exceeds its message-size bound.`);
  }
  const bytes = typeof value === "string" ? encoder.encode(value) : bytesFrom(value, `${lane} frame`);
  if (bytes.byteLength === 0 || bytes.byteLength > policy.maximumMessageBytes) {
    failContract("lane_message_size", `${lane} frame exceeds its message-size bound.`);
  }
  return bytes;
}

function makeFifoState() {
  return { queue: [], queuedBytes: 0, rejected: 0 };
}

export function assertRemoteStudyLaneScope(lane, scopes) {
  const required = REMOTE_STUDY_LANE_REQUIRED_SCOPES[lane];
  if (!required) return true;
  const normalized = normalizeRemoteStudyScopes(scopes);
  if (!normalized.includes(required)) failContract("scope_denied", `${lane} requires ${required}.`);
  return true;
}

export class RemoteStudyLaneBuffers {
  constructor() {
    this.control = makeFifoState();
    this.record = makeFifoState();
    this.export = makeFifoState();
    this.state = { pending: undefined, replaced: 0 };
  }

  offer(lane, value) {
    if (!Object.prototype.hasOwnProperty.call(REMOTE_STUDY_LANE_POLICIES, lane)) {
      failContract("unknown_lane", "The remote-study lane is unsupported.");
    }
    const bytes = frameBytes(value, lane);
    if (lane === "state") {
      if (this.state.pending) this.state.replaced += 1;
      this.state.pending = bytes;
      return Object.freeze({ accepted: true, replaced: this.state.replaced });
    }
    const target = this[lane];
    const policy = REMOTE_STUDY_LANE_POLICIES[lane];
    if (target.queue.length >= policy.maximumQueuedMessages
      || target.queuedBytes + bytes.byteLength > policy.maximumQueuedBytes) {
      target.rejected += 1;
      return Object.freeze({ accepted: false, error: "lane_backpressure" });
    }
    target.queue.push(bytes);
    target.queuedBytes += bytes.byteLength;
    return Object.freeze({ accepted: true, queuedBytes: target.queuedBytes });
  }

  take(lane) {
    if (lane === "state") {
      const pending = this.state.pending;
      this.state.pending = undefined;
      return pending ? new Uint8Array(pending) : undefined;
    }
    if (!new Set(["control", "record", "export"]).has(lane)) {
      failContract("unknown_lane", "The remote-study lane is unsupported.");
    }
    const target = this[lane];
    const value = target.queue.shift();
    if (!value) return undefined;
    target.queuedBytes -= value.byteLength;
    return new Uint8Array(value);
  }

  clear() {
    this.control = makeFifoState();
    this.record = makeFifoState();
    this.export = makeFifoState();
    this.state = { pending: undefined, replaced: 0 };
  }

  snapshot() {
    return Object.freeze({
      control: Object.freeze({
        queuedMessages: this.control.queue.length,
        queuedBytes: this.control.queuedBytes,
        rejected: this.control.rejected,
      }),
      state: Object.freeze({
        queuedMessages: this.state.pending ? 1 : 0,
        queuedBytes: this.state.pending?.byteLength ?? 0,
        replaced: this.state.replaced,
      }),
      record: Object.freeze({
        queuedMessages: this.record.queue.length,
        queuedBytes: this.record.queuedBytes,
        rejected: this.record.rejected,
      }),
      export: Object.freeze({
        queuedMessages: this.export.queue.length,
        queuedBytes: this.export.queuedBytes,
        rejected: this.export.rejected,
      }),
    });
  }
}
