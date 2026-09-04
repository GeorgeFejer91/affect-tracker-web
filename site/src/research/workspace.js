import { canonicalJson } from "./canonical.js";
import {
  validateResearchEventV1,
  validateResearchRunManifestV2,
  validateResearchSettingsV1,
} from "./contracts.js";
import { RESEARCH_SAMPLE_COLUMNS } from "./tabular.js";

export const RESEARCH_STORAGE_NAMESPACE = "affect-research/v1";
export const RESEARCH_WORKSPACE_IDENTITY_FILE = "workspace.identity.json";
export const RESEARCH_WORKSPACE_DIRECTORIES = Object.freeze([
  "stimuli",
  "settings",
  "outputs",
  "recovery",
]);

export const VIDEO_FILE_EXTENSIONS = Object.freeze([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".ogv",
]);

const UNSAFE_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/u;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const WORKSPACE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_ENTRIES = 10_000;
const ATTEMPT_ARTIFACT_NAMES = Object.freeze([
  "settings.snapshot.json",
  "events.jsonl",
  "ratings.csv",
  "ratings.tsv",
]);

export class ResearchWorkspaceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ResearchWorkspaceError";
    this.code = code;
  }
}

export function parseStrictJson(text, { maximumBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof text !== "string") fail("settings-json", "Settings JSON must be UTF-8 text.");
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength < 1 || byteLength > maximumBytes) {
    fail("settings-size", `Settings JSON must contain between 1 byte and ${maximumBytes} bytes.`);
  }
  let index = 0;
  const whitespace = /[\u0009\u000a\u000d\u0020]/u;
  const skipWhitespace = () => {
    while (index < text.length && whitespace.test(text[index])) index += 1;
  };
  const syntax = (message) => fail("settings-json", `${message} at character ${index}.`);
  const parseStringToken = () => {
    if (text[index] !== '"') syntax("Expected a JSON string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          fail("settings-json", "Settings contains an invalid JSON string.", { cause: error });
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) syntax("Unterminated JSON escape");
        if (text[index] === "u") {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) syntax("Invalid JSON Unicode escape");
          index += 4;
        } else if (!/["\\/bfnrt]/u.test(text[index])) syntax("Invalid JSON escape");
      } else if (character.charCodeAt(0) <= 0x1f) syntax("Unescaped control character in JSON string");
      index += 1;
    }
    syntax("Unterminated JSON string");
  };
  const parseValue = () => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === "}") { index += 1; return; }
      while (index < text.length) {
        skipWhitespace();
        const key = parseStringToken();
        if (keys.has(key)) fail("duplicate-json-key", `Settings JSON contains duplicate object key ${JSON.stringify(key)}.`);
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") syntax("Expected ':' after JSON object key");
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") { index += 1; return; }
        if (text[index] !== ",") syntax("Expected ',' or '}' in JSON object");
        index += 1;
      }
      syntax("Unterminated JSON object");
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") { index += 1; return; }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") { index += 1; return; }
        if (text[index] !== ",") syntax("Expected ',' or ']' in JSON array");
        index += 1;
      }
      syntax("Unterminated JSON array");
    }
    if (character === '"') { parseStringToken(); return; }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) { index += literal.length; return; }
    }
    const remainder = text.slice(index);
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remainder)?.[0];
    if (!number) syntax("Expected a JSON value");
    index += number.length;
  };
  parseValue();
  skipWhitespace();
  if (index !== text.length) syntax("Unexpected content after JSON value");
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("settings-json", "Settings file is not valid JSON.", { cause: error });
  }
}

function fail(code, message, options) {
  throw new ResearchWorkspaceError(code, message, options);
}

export function assertSafeWorkspaceSegment(value, label = "path segment") {
  if (typeof value !== "string" || value.length < 1 || value.length > 240
    || value === "." || value === ".." || UNSAFE_SEGMENT.test(value)) {
    fail("unsafe-segment", `${label} contains an unsafe or unsupported path component.`);
  }
  return value;
}

export function normalizeWorkspaceRelativePath(value, label = "relative path") {
  if (typeof value !== "string") fail("unsafe-path", `${label} must be text.`);
  if (/^[\\/]/u.test(value)) fail("unsafe-path", `${label} must be relative.`);
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 32) {
    fail("unsafe-path", `${label} must contain between 1 and 32 segments.`);
  }
  for (const part of parts) {
    assertSafeWorkspaceSegment(part, label);
    let decoded = part;
    for (let pass = 0; pass < 3 && /%[0-9a-f]{2}/iu.test(decoded); pass += 1) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        fail("unsafe-path", `${label} contains invalid percent encoding.`);
      }
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")
        || UNSAFE_SEGMENT.test(decoded)) {
        fail("unsafe-path", `${label} contains an encoded unsafe path component.`);
      }
    }
  }
  return parts.join("/");
}

export function isSupportedVideoName(name) {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  return VIDEO_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function parseExperimentalYouTubeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("youtube-url", "YouTube source must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") fail("youtube-url", "YouTube source must use HTTPS.");

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  let videoId = "";
  if (hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(hostname)) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? "";
    else {
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) videoId = parts[1] ?? "";
    }
  } else {
    fail("youtube-url", "Only youtube.com, youtube-nocookie.com, or youtu.be URLs are accepted.");
  }

  if (!YOUTUBE_ID.test(videoId)) fail("youtube-url", "YouTube URL does not contain a valid video ID.");
  return Object.freeze({
    sourceKind: "youtube-experimental",
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    verification: "unverified-noncanonical",
    sha256: null,
  });
}

export async function sha256Blob(blob, cryptoObject = globalThis.crypto) {
  if (!(blob instanceof Blob) || blob.size < 1) fail("empty-file", "Video file is empty.");
  if (!cryptoObject?.subtle?.digest) fail("hash-unavailable", "SHA-256 is unavailable in this context.");
  const digest = await cryptoObject.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function probeVideoElement(video, { timeoutMs = 15_000 } = {}) {
  if (!video || typeof video.addEventListener !== "function") {
    fail("decode-unavailable", "Video decode preflight could not create a media element.");
  }
  const waitForEvent = (type, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new ResearchWorkspaceError("decode-timeout", message));
    }, timeoutMs);
    const loaded = (event) => { cleanup(); resolve(event); };
    const errored = () => {
      cleanup();
      reject(new ResearchWorkspaceError("decode-failed", "The browser could not decode the selected complete video."));
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(type, loaded);
      video.removeEventListener("error", errored);
    };
    video.addEventListener(type, loaded, { once: true });
    video.addEventListener("error", errored, { once: true });
  });
  const waitForDecodedFrame = (expectedPosition, durationSeconds) => new Promise((resolve, reject) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      reject(new ResearchWorkspaceError(
        "decode-unavailable",
        "Decoded-frame verification requires desktop Chrome or Edge video frame callbacks.",
      ));
      return;
    }
    let callbackId = null;
    let settled = false;
    const toleranceSeconds = Math.max(0.05, Math.min(0.5, durationSeconds * 0.02));
    const cleanup = () => {
      if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(callbackId);
      }
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new ResearchWorkspaceError(
        "decode-timeout",
        "A representative video frame was not decoded before the preflight deadline.",
      ));
    }, timeoutMs);
    const requestFrame = () => {
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        if (settled) return;
        const mediaTime = Number(metadata?.mediaTime);
        if (Number.isFinite(mediaTime) && Math.abs(mediaTime - expectedPosition) <= toleranceSeconds) {
          settled = true;
          cleanup();
          resolve(mediaTime);
          return;
        }
        requestFrame();
      });
    };
    requestFrame();
  });

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const metadata = waitForEvent(
    "loadedmetadata",
    "Video metadata did not become available before the preflight deadline.",
  );
  video.load?.();
  await metadata;
  const durationSeconds = Number(video.duration);
  const videoWidth = Number(video.videoWidth);
  const videoHeight = Number(video.videoHeight);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail("invalid-duration", "Video duration must be finite and positive.");
  }
  if (!Number.isInteger(videoWidth) || videoWidth <= 0
    || !Number.isInteger(videoHeight) || videoHeight <= 0) {
    fail("decode-failed", "Video metadata must include positive integer frame dimensions.");
  }
  const candidates = [
    Math.min(durationSeconds * 0.1, 0.25),
    durationSeconds * 0.5,
    Math.max(0, durationSeconds - Math.min(0.25, durationSeconds * 0.1)),
  ];
  const decodedPositionsSeconds = [];
  for (const position of candidates) {
    const bounded = Math.max(0, Math.min(durationSeconds, position));
    if (decodedPositionsSeconds.some((existing) => Math.abs(existing - bounded) < 0.001)) continue;
    const seeked = waitForEvent(
      "seeked",
      "A representative video position could not be decoded before the preflight deadline.",
    );
    video.currentTime = bounded;
    // Subscribe in the same task that initiated the seek, before yielding to
    // either the seek event or compositor, so the target frame cannot race us.
    const decodedFrame = waitForDecodedFrame(bounded, durationSeconds);
    await Promise.all([seeked, decodedFrame]);
    decodedPositionsSeconds.push(bounded);
  }
  if (decodedPositionsSeconds.length !== 3) {
    fail("decode-failed", "The complete video did not expose distinct near-start, midpoint, and near-end frames.");
  }
  return Object.freeze({
    durationSeconds,
    videoWidth,
    videoHeight,
    decodeVerified: true,
    decodedPositionsSeconds: Object.freeze(decodedPositionsSeconds),
  });
}

export async function probeVideoFile(file, {
  createObjectURL = globalThis.URL?.createObjectURL?.bind(globalThis.URL),
  revokeObjectURL = globalThis.URL?.revokeObjectURL?.bind(globalThis.URL),
  createVideo = () => globalThis.document?.createElement?.("video"),
  timeoutMs = 15_000,
} = {}) {
  if (!(file instanceof Blob) || file.size < 1) fail("empty-file", "Video file is empty.");
  if (!createObjectURL || !revokeObjectURL || !createVideo) {
    fail("decode-unavailable", "Video decode preflight is unavailable in this context.");
  }
  const video = createVideo();
  if (!video || typeof video.addEventListener !== "function") {
    fail("decode-unavailable", "Video decode preflight could not create a media element.");
  }

  const objectUrl = createObjectURL(file);
  try {
    video.src = objectUrl;
    return await probeVideoElement(video, { timeoutMs });
  } finally {
    video.pause?.();
    video.removeAttribute?.("src");
    video.load?.();
    revokeObjectURL(objectUrl);
  }
}

async function permissionState(handle, mode) {
  if (typeof handle?.queryPermission !== "function") return "granted";
  return handle.queryPermission({ mode });
}

async function ensurePermission(handle, mode, { request = false } = {}) {
  let state = await permissionState(handle, mode);
  if (state !== "granted" && request && typeof handle?.requestPermission === "function") {
    state = await handle.requestPermission({ mode });
  }
  if (state !== "granted") {
    fail("permission-required", `Workspace ${mode} permission requires a fresh user action.`);
  }
  return true;
}

async function getChildDirectory(parent, name, { create = false } = {}) {
  assertSafeWorkspaceSegment(name, "directory name");
  return parent.getDirectoryHandle(name, { create });
}

async function getNestedDirectory(parent, segments, { create = false } = {}) {
  let current = parent;
  for (const segment of segments) current = await getChildDirectory(current, segment, { create });
  return current;
}

async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name, { create: false });
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

async function writeNewFile(directory, name, body) {
  assertSafeWorkspaceSegment(name, "file name");
  if (await fileExists(directory, name)) {
    fail("already-exists", `${name} already exists; Research never overwrites attempt evidence.`);
  }
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(body);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort?.();
    } catch {
      // The write failure remains the authoritative error.
    }
    throw error;
  }
  return handle;
}

async function writeIdempotentAttemptFile(directory, name, body) {
  assertSafeWorkspaceSegment(name, "file name");
  if (typeof body !== "string") fail("artifacts", `${name} must be serialized UTF-8 text.`);
  if (!(await fileExists(directory, name))) return writeNewFile(directory, name, body);
  const handle = await directory.getFileHandle(name, { create: false });
  const existing = await handle.getFile();
  if (await existing.text() === body) return handle;
  fail("artifact-conflict", `${name} already exists with different bytes; Research never rewrites attempt evidence.`);
}

function newWorkspaceId(cryptoObject) {
  if (typeof cryptoObject?.randomUUID === "function") return cryptoObject.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  cryptoObject?.getRandomValues?.(bytes);
  if (bytes.every((byte) => byte === 0)) fail("workspace-identity", "Secure workspace identity generation is unavailable.");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function* walkVideos(directory, prefix = "", state = { entries: 0 }, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) {
    fail("scan-depth", `Stimulus discovery exceeds the supported ${MAX_SCAN_DEPTH}-directory depth.`);
  }
  for await (const [name, handle] of directory.entries()) {
    state.entries += 1;
    if (state.entries > MAX_SCAN_ENTRIES) {
      fail("scan-capacity", `Stimulus discovery exceeds the supported ${MAX_SCAN_ENTRIES.toLocaleString("en")}-entry workspace scan.`);
    }
    const safeName = assertSafeWorkspaceSegment(name, "workspace entry");
    const relativePath = prefix ? `${prefix}/${safeName}` : safeName;
    if (handle.kind === "directory") yield* walkVideos(handle, relativePath, state, depth + 1);
    else if (handle.kind === "file" && isSupportedVideoName(safeName)) {
      const file = await handle.getFile();
      yield Object.freeze({
        sourceKind: "workspace-file",
        relativePath,
        name: safeName,
        byteLength: file.size,
        lastModified: file.lastModified,
        mediaType: file.type || "application/octet-stream",
        fileHandle: handle,
      });
    }
  }
}

async function readBoundedJsonFile(handle, label, { maximumBytes = 4 * 1024 * 1024 } = {}) {
  const file = await handle.getFile();
  if (file.size < 1 || file.size > maximumBytes) {
    fail("invalid-json-file", `${label} must contain between 1 byte and ${maximumBytes} bytes.`);
  }
  try {
    return parseStrictJson(await file.text(), { maximumBytes });
  } catch (error) {
    fail(error?.code ?? "invalid-json-file", `${label} is not valid JSON under the strict parser.`, { cause: error });
  }
}

function parseDelimitedTable(text, delimiter, label) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) quoted = true;
    else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) fail("artifact-table", `${label} ends inside a quoted field.`);
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length < 1 || rows[0].join("\u0000") !== RESEARCH_SAMPLE_COLUMNS.join("\u0000")) {
    fail("artifact-table", `${label} does not use the canonical ResearchSampleV1 columns.`);
  }
  if (rows.some((candidate) => candidate.length !== RESEARCH_SAMPLE_COLUMNS.length)) {
    fail("artifact-table", `${label} contains a row with a noncanonical column count.`);
  }
  return rows;
}

function attestRatingRows(rows, manifest, label) {
  const column = Object.fromEntries(RESEARCH_SAMPLE_COLUMNS.map((name, index) => [name, index]));
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const position = Number(row[column.stimulusPosition]);
    const stimulus = manifest.stimuli[position - 1];
    if (row[column.sequence] !== String(index)
      || row[column.runId] !== manifest.runId
      || row[column.participantId] !== manifest.participantId
      || row[column.attemptNumber] !== String(manifest.attemptNumber)
      || row[column.settingsSha256] !== manifest.settingsSha256
      || row[column.assignmentPlanSha256] !== manifest.assignmentPlanSha256
      || row[column.sampleRateHz] !== String(manifest.timing.sampleRateHz)
      || !stimulus
      || row[column.stimulusId] !== stimulus.stimulusId
      || row[column.stimulusKind] !== stimulus.kind
      || row[column.stimulusSha256] !== (stimulus.sha256 ?? "")
      || row[column.stimulusByteLength] !== (stimulus.byteLength === null ? "" : String(stimulus.byteLength))
      || row[column.stimulusDurationMs] !== String(stimulus.durationMs)
      || row[column.stimulusUrl] !== (stimulus.url ?? "")
      || row[column.stimulusVideoId] !== (stimulus.videoId ?? "")) {
      fail("artifact-sample-binding", `${label} row ${index} is not canonically bound to this run and stimulus position.`);
    }
  }
}

async function attestManifestArtifacts(sessionDirectory, manifest) {
  const expectedNames = Object.freeze({
    settings: "settings.snapshot.json",
    events: "events.jsonl",
    csv: "ratings.csv",
    tsv: "ratings.tsv",
  });
  const tables = new Map();
  for (const output of manifest.outputs) {
    if (output.fileName !== expectedNames[output.kind]) {
      fail("artifact-name", `Manifest ${output.kind} output must be ${expectedNames[output.kind]}.`);
    }
    const handle = await sessionDirectory.getFileHandle(output.fileName, { create: false });
    const file = await handle.getFile();
    if (file.size !== output.byteLength) {
      fail("artifact-size", `${output.fileName} byte length does not match its manifest receipt.`);
    }
    if (await sha256Blob(file) !== output.sha256) {
      fail("artifact-hash", `${output.fileName} SHA-256 does not match its manifest receipt.`);
    }
    if (output.kind === "settings") {
      const settings = validateResearchSettingsV1(parseStrictJson(await file.text(), { maximumBytes: 5 * 1024 * 1024 }));
      const settingsHash = await sha256Blob(new Blob([canonicalJson(settings)]));
      if (settingsHash !== manifest.settingsSha256) {
        fail("artifact-settings-hash", "Frozen settings do not match the settings hash bound by the manifest.");
      }
    } else if (output.kind === "events") {
      const records = (await file.text()).split(/\r?\n/u).filter((line) => line.length > 0);
      if (records.length !== manifest.timing.eventCount) {
        fail("artifact-event-count", "events.jsonl record count does not match the manifest.");
      }
      let gapEventCount = 0;
      let missedSlotCount = 0;
      records.forEach((line, index) => {
        const event = validateResearchEventV1(parseStrictJson(line, { maximumBytes: 256 * 1024 }));
        if (event.sequence !== index + 1 || event.runId !== manifest.runId
          || event.settingsSha256 !== manifest.settingsSha256
          || event.assignmentPlanSha256 !== manifest.assignmentPlanSha256) {
          fail("artifact-event-binding", `events.jsonl record ${index + 1} is not bound to this run in canonical order.`);
        }
        if (event.type === "timingGap") {
          gapEventCount += 1;
          missedSlotCount += event.missedSlotCount;
        }
      });
      if (gapEventCount !== manifest.timing.gapEventCount
        || missedSlotCount !== manifest.timing.missedSlotCount) {
        fail("artifact-gap-count", "events.jsonl timing-gap totals do not match the manifest.");
      }
    } else {
      const rows = parseDelimitedTable(await file.text(), output.kind === "csv" ? "," : "\t", output.fileName);
      if (rows.length - 1 !== output.rowCount) {
        fail("artifact-row-count", `${output.fileName} row count does not match its manifest receipt.`);
      }
      attestRatingRows(rows, manifest, output.fileName);
      tables.set(output.kind, rows);
    }
  }
  if (tables.has("csv") && tables.has("tsv")) {
    const csv = tables.get("csv");
    const tsv = tables.get("tsv");
    if (csv.length !== tsv.length || csv.some((row, index) => row.join("\u0000") !== tsv[index].join("\u0000"))) {
      fail("artifact-table-parity", "CSV and TSV outputs are not semantic projections of the same canonical samples.");
    }
  }
}

export class BrowserResearchWorkspace {
  constructor(rootHandle, { cryptoObject = globalThis.crypto } = {}) {
    if (!rootHandle || rootHandle.kind !== "directory") {
      fail("invalid-root", "Research workspace requires a directory handle.");
    }
    this.rootHandle = rootHandle;
    this.cryptoObject = cryptoObject;
    this.directories = new Map();
    this.workspaceId = null;
  }

  static async choose({
    windowObject = globalThis.window,
    pickerOptions = { id: "affect-research-workspace", mode: "readwrite" },
  } = {}) {
    if (!windowObject?.isSecureContext) {
      fail("secure-context-required", "Workspace selection requires a secure browser context.");
    }
    if (typeof windowObject.showDirectoryPicker !== "function") {
      fail("unsupported-browser", "This browser does not provide the File System Access directory picker.");
    }
    const handle = await windowObject.showDirectoryPicker(pickerOptions);
    const workspace = new BrowserResearchWorkspace(handle);
    await workspace.initialize({ requestPermission: true });
    return workspace;
  }

  async initialize({ requestPermission = false } = {}) {
    await ensurePermission(this.rootHandle, "readwrite", { request: requestPermission });
    for (const name of RESEARCH_WORKSPACE_DIRECTORIES) {
      this.directories.set(name, await getChildDirectory(this.rootHandle, name, { create: true }));
    }
    this.workspaceId = await this.#loadOrCreateWorkspaceIdentity();
    return this;
  }

  async renewPermission() {
    return ensurePermission(this.rootHandle, "readwrite", { request: true });
  }

  async rescanVideos() {
    await ensurePermission(this.rootHandle, "read", { request: false });
    const stimuli = this.#directory("stimuli");
    const videos = [];
    for await (const video of walkVideos(stimuli)) videos.push(video);
    videos.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
    return Object.freeze(videos);
  }

  async openStimulusFile(relativePath) {
    await ensurePermission(this.rootHandle, "read", { request: false });
    const normalized = normalizeWorkspaceRelativePath(relativePath, "stimulus path");
    const parts = normalized.split("/");
    if (parts[0] === "stimuli") parts.shift();
    const fileName = parts.pop();
    if (!fileName || !isSupportedVideoName(fileName)) {
      fail("unsupported-video", "The selected workspace stimulus is not a supported complete-video file.");
    }
    const directory = await getNestedDirectory(this.#directory("stimuli"), parts, { create: false });
    const handle = await directory.getFileHandle(fileName, { create: false });
    return handle.getFile();
  }

  async listRunManifests(experimentId) {
    await ensurePermission(this.rootHandle, "read", { request: false });
    const safeExperimentId = assertSafeWorkspaceSegment(experimentId, "experiment ID");
    let experimentDirectory;
    try {
      experimentDirectory = await getChildDirectory(this.#directory("outputs"), safeExperimentId, { create: false });
    } catch (error) {
      if (error?.name === "NotFoundError") {
        return Object.freeze({ manifests: Object.freeze([]), issues: Object.freeze([]) });
      }
      throw error;
    }

    const manifests = [];
    const issues = [];
    for await (const [participantDirectoryName, participantDirectory] of experimentDirectory.entries()) {
      if (participantDirectory.kind !== "directory") continue;
      let safeParticipantDirectory;
      try {
        safeParticipantDirectory = assertSafeWorkspaceSegment(participantDirectoryName, "participant output directory");
      } catch (error) {
        issues.push(Object.freeze({ code: "invalid-participant-directory", message: error.message }));
        continue;
      }
      for await (const [sessionDirectoryName, sessionDirectory] of participantDirectory.entries()) {
        if (sessionDirectory.kind !== "directory") continue;
        let manifestHandle;
        try {
          assertSafeWorkspaceSegment(sessionDirectoryName, "session output directory");
          manifestHandle = await sessionDirectory.getFileHandle("manifest.json", { create: false });
          const manifest = validateResearchRunManifestV2(await readBoundedJsonFile(
            manifestHandle,
            `${safeParticipantDirectory}/${sessionDirectoryName}/manifest.json`,
          ));
          if (manifest.experimentId !== safeExperimentId
            || manifest.participantId !== safeParticipantDirectory
            || manifest.sessionStem !== sessionDirectoryName) {
            throw new TypeError("Manifest identity does not match its curated output directory.");
          }
          await attestManifestArtifacts(sessionDirectory, manifest);
          manifests.push(manifest);
        } catch (error) {
          if (error?.name === "NotFoundError") continue;
          issues.push(Object.freeze({
            code: error?.code ?? "invalid-manifest",
            participantId: safeParticipantDirectory,
            sessionStem: sessionDirectoryName,
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    }
    manifests.sort((left, right) => left.timing.startedAt.localeCompare(right.timing.startedAt));
    return Object.freeze({
      manifests: Object.freeze(manifests),
      issues: Object.freeze(issues),
    });
  }

  async importVideoFiles(files) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    const stimuli = this.#directory("stimuli");
    const imported = [];
    for (const file of Array.from(files ?? [])) {
      if (!(file instanceof Blob) || !isSupportedVideoName(file.name)) {
        fail("unsupported-video", "Every imported item must be a supported complete-video file.");
      }
      const suggested = file.webkitRelativePath || file.name;
      const relativePath = normalizeWorkspaceRelativePath(suggested, "import path");
      const parts = relativePath.split("/");
      const fileName = parts.pop();
      const directory = await getNestedDirectory(stimuli, parts, { create: true });
      await writeNewFile(directory, fileName, file);
      imported.push(relativePath);
    }
    return Object.freeze(imported);
  }

  async loadSettingsFile(file) {
    if (!(file instanceof Blob)) fail("settings-file", "Choose a settings.json file.");
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      fail("settings-size", "Settings file must contain between 1 byte and 5 MiB.");
    }
    let parsed;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      parsed = parseStrictJson(text);
    } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error;
      fail("settings-json", "Settings file is not valid JSON.", { cause: error });
    }
    return validateResearchSettingsV1(parsed);
  }

  async saveSettings(settings) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    const normalized = validateResearchSettingsV1(settings);
    const experimentId = assertSafeWorkspaceSegment(normalized.experiment.id, "experiment ID");
    const name = `${experimentId}.settings.json`;
    const directory = this.#directory("settings");
    const text = `${canonicalJson(normalized)}\n`;
    if (await fileExists(directory, name)) {
      const handle = await directory.getFileHandle(name, { create: false });
      const writable = await handle.createWritable({ keepExistingData: false });
      try {
        await writable.write(text);
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch?.(() => {});
        throw error;
      }
      return handle;
    }
    return writeNewFile(directory, name, text);
  }

  async probeOutputWriteReadiness() {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    const outputs = this.#directory("outputs");
    if (typeof outputs.removeEntry !== "function") {
      fail("output-write-probe", "The selected workspace cannot remove its temporary output write probe.");
    }
    const name = `.affect-research-write-probe-${newWorkspaceId(this.cryptoObject)}.tmp`;
    const body = `${RESEARCH_STORAGE_NAMESPACE}\n`;
    let created = false;
    try {
      const handle = await writeNewFile(outputs, name, body);
      created = true;
      const observed = await (await handle.getFile()).text();
      if (observed !== body) fail("output-write-probe", "The selected workspace changed the output write probe bytes.");
      return Object.freeze({ writeReady: true });
    } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error;
      fail("output-write-probe", "The selected workspace failed a create, write, sync, and read output probe.", { cause: error });
    } finally {
      if (created) {
        try {
          await outputs.removeEntry(name);
        } catch (error) {
          fail("output-write-probe-cleanup", "The selected workspace could not remove its temporary output write probe.", { cause: error });
        }
      }
    }
  }

  async createAttemptDirectory({ experimentId, participantId, sessionStem }) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    const segments = [experimentId, participantId, sessionStem]
      .map((value, index) => assertSafeWorkspaceSegment(value, ["experiment ID", "participant ID", "session stem"][index]));
    let current = this.#directory("outputs");
    current = await getChildDirectory(current, segments[0], { create: true });
    current = await getChildDirectory(current, segments[1], { create: true });
    try {
      await getChildDirectory(current, segments[2], { create: false });
      fail("attempt-exists", `Attempt directory ${segments[2]} already exists.`);
    } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error;
      if (error?.name !== "NotFoundError") throw error;
    }
    return getChildDirectory(current, segments[2], { create: true });
  }

  async openAttemptDirectory({ experimentId, participantId, sessionStem }) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    const segments = [experimentId, participantId, sessionStem]
      .map((value, index) => assertSafeWorkspaceSegment(value, ["experiment ID", "participant ID", "session stem"][index]));
    return getNestedDirectory(this.#directory("outputs"), segments, { create: false });
  }

  async writeAttemptArtifacts(directory, artifacts) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    if (!directory || directory.kind !== "directory") fail("attempt-directory", "Attempt directory is invalid.");
    if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
      fail("artifacts", "Attempt artifacts must be a name-to-content object.");
    }
    const written = [];
    for (const [name, body] of Object.entries(artifacts)) {
      await writeIdempotentAttemptFile(directory, name, body);
      written.push(name);
    }
    return Object.freeze(written);
  }

  async quarantineIncompleteAttemptArtifacts(directory) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    if (!directory || directory.kind !== "directory" || typeof directory.removeEntry !== "function") {
      fail("attempt-directory", "Incomplete attempt quarantine requires a removable curated attempt directory.");
    }
    if (await fileExists(directory, "manifest.json")) {
      fail("attempt-finalized", "An attempt with a manifest is immutable and cannot be quarantined for retry.");
    }
    const recovery = this.#directory("recovery");
    const quarantineId = newWorkspaceId(this.cryptoObject);
    const receipts = [];
    for (const artifactName of ATTEMPT_ARTIFACT_NAMES) {
      if (!(await fileExists(directory, artifactName))) continue;
      const source = await directory.getFileHandle(artifactName, { create: false });
      const file = await source.getFile();
      const quarantineName = `incomplete-${quarantineId}-${artifactName}`;
      const preserved = await writeNewFile(recovery, quarantineName, file);
      const preservedFile = await preserved.getFile();
      if (preservedFile.size !== file.size
        || (file.size > 0 && await sha256Blob(preservedFile) !== await sha256Blob(file))) {
        fail("quarantine-verification", `Could not verify the preserved ${artifactName} bytes.`);
      }
      await directory.removeEntry(artifactName);
      receipts.push(Object.freeze({ artifactName, quarantineName, byteLength: file.size }));
    }
    return Object.freeze(receipts);
  }

  async writeRecoveryJournal(name, body) {
    await ensurePermission(this.rootHandle, "readwrite", { request: false });
    return writeNewFile(this.#directory("recovery"), assertSafeWorkspaceSegment(name, "recovery file"), body);
  }

  async #loadOrCreateWorkspaceIdentity() {
    const settings = this.#directory("settings");
    try {
      const handle = await settings.getFileHandle(RESEARCH_WORKSPACE_IDENTITY_FILE, { create: false });
      const file = await handle.getFile();
      if (file.size < 1 || file.size > 16 * 1024) fail("workspace-identity", "Workspace identity file has an invalid size.");
      const identity = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()), {
        maximumBytes: 16 * 1024,
      });
      if (!identity || typeof identity !== "object" || Array.isArray(identity)
        || Object.keys(identity).sort().join(",") !== "schema,version,workspaceId"
        || identity.schema !== "affect-research-workspace-identity"
        || identity.version !== 1
        || !WORKSPACE_ID.test(identity.workspaceId)) {
        fail("workspace-identity", "Workspace identity file violates its strict v1 contract.");
      }
      return identity.workspaceId;
    } catch (error) {
      if (error instanceof ResearchWorkspaceError) throw error;
      if (error?.name !== "NotFoundError") {
        fail("workspace-identity", "Workspace identity file could not be read.", { cause: error });
      }
    }
    const workspaceId = newWorkspaceId(this.cryptoObject);
    await writeNewFile(settings, RESEARCH_WORKSPACE_IDENTITY_FILE, `${canonicalJson({
      schema: "affect-research-workspace-identity",
      version: 1,
      workspaceId,
    })}\n`);
    return workspaceId;
  }

  #directory(name) {
    const directory = this.directories.get(name);
    if (!directory) fail("not-initialized", "Initialize the workspace before using its libraries.");
    return directory;
  }
}
