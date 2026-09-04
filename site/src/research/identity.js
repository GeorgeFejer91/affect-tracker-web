export const PARTICIPANT_STATES = Object.freeze(["available", "active", "partial", "complete"]);
export const GENDER_CODES = Object.freeze(["W", "M", "N", "S", "X"]);
export const HANDEDNESS_CODES = Object.freeze(["L", "R", "A"]);

const PARTICIPANT_ID = /^P\d{3,6}$/u;
const RESERVED_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/u;

function cloneFrozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(cloneFrozen);
    Object.freeze(value);
  }
  return value;
}

function graphemes(value) {
  const normalized = String(value ?? "").trim().normalize("NFC");
  if (!normalized) throw new TypeError("First and last name are required.");
  if (normalized.length > 200 || /[\u0000-\u001f]/u.test(normalized)) {
    throw new TypeError("Name input is invalid or too long.");
  }
  if (typeof Intl?.Segmenter === "function") {
    return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(normalized)]
      .map(({ segment }) => segment);
  }
  return Array.from(normalized);
}

function oneUppercaseGrapheme(value) {
  return graphemes(value.toLocaleUpperCase("und"))[0];
}

export function participantIds(total) {
  if (!Number.isSafeInteger(total) || total < 1 || total > 100_000) {
    throw new RangeError("Participant count must be an integer from 1 through 100000.");
  }
  const width = Math.max(3, String(total).length);
  return Object.freeze(Array.from({ length: total }, (_, index) => `P${String(index + 1).padStart(width, "0")}`));
}

export function participantCode(firstName, lastName) {
  const first = graphemes(firstName);
  const last = graphemes(lastName);
  const code = `${oneUppercaseGrapheme(first.at(-1))}${oneUppercaseGrapheme(last[0])}`.normalize("NFC");
  if (RESERVED_FILENAME.test(code)) {
    throw new TypeError("The derived participant code contains a filename-reserved character.");
  }
  return code;
}

export function deriveParticipantRecord({ firstName, lastName, age, gender, handedness } = {}) {
  if (!Number.isSafeInteger(age) || age < 1 || age > 120) {
    throw new RangeError("Age must be an integer from 1 through 120.");
  }
  if (!GENDER_CODES.includes(gender)) throw new TypeError("Gender must use W, M, N, S, or X.");
  if (!HANDEDNESS_CODES.includes(handedness)) throw new TypeError("Handedness must use L, R, or A.");
  return cloneFrozen({
    participantCode: participantCode(firstName, lastName),
    age,
    gender,
    handedness,
  });
}

export function validateDerivedParticipantRecord({ participantCode: code, age, gender, handedness } = {}) {
  if (typeof code !== "string" || code !== code.trim().normalize("NFC")
    || code !== code.toLocaleUpperCase("und")) {
    throw new TypeError("Participant code must be normalized uppercase text.");
  }
  const codeGraphemes = graphemes(code);
  if (codeGraphemes.length !== 2 || RESERVED_FILENAME.test(code) || code.includes("_")) {
    throw new TypeError("Participant code must contain exactly two safe graphemes.");
  }
  if (!Number.isSafeInteger(age) || age < 1 || age > 120) {
    throw new RangeError("Age must be an integer from 1 through 120.");
  }
  if (!GENDER_CODES.includes(gender)) throw new TypeError("Gender must use W, M, N, S, or X.");
  if (!HANDEDNESS_CODES.includes(handedness)) throw new TypeError("Handedness must use L, R, or A.");
  return cloneFrozen({ participantCode: code, age, gender, handedness });
}

export function compactUtcTimestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Session timestamp must be a valid date.");
  return date.toISOString().replace(/[-:]/gu, "").replace(".", "");
}

export function createSessionStem({
  participantId,
  participantCode: code,
  age,
  gender,
  handedness,
  startedAt,
  attemptNumber,
} = {}) {
  if (!PARTICIPANT_ID.test(participantId ?? "")
    || Number(participantId.slice(1)) < 1 || Number(participantId.slice(1)) > 100_000) {
    throw new TypeError("Participant ID is invalid.");
  }
  const codeGraphemes = graphemes(code);
  if (codeGraphemes.length !== 2 || RESERVED_FILENAME.test(code) || code.includes("_")) {
    throw new TypeError("Participant code must contain exactly two safe graphemes.");
  }
  if (!Number.isSafeInteger(age) || age < 1 || age > 120) throw new RangeError("Age is invalid.");
  if (!GENDER_CODES.includes(gender)) throw new TypeError("Gender code is invalid.");
  if (!HANDEDNESS_CODES.includes(handedness)) throw new TypeError("Handedness code is invalid.");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 999_999) {
    throw new RangeError("Attempt number is invalid.");
  }
  const attempt = String(attemptNumber).padStart(2, "0");
  return `${participantId}_${code}_A${age}_G${gender}_H${handedness}_${compactUtcTimestamp(startedAt)}_R${attempt}`;
}
