import { coinReferenceById, countryByCode, currencyByCode } from "./coin-reference-catalog.js";

export const SCREEN_CALIBRATION_SCHEMA = "affect-tracker-screen-calibration";
export const SCREEN_CALIBRATION_VERSION = 2;
export const SCREEN_CALIBRATION_PROTOCOL = "drawn-square-v2";
export const SCREEN_CALIBRATION_STORAGE_KEY = "affect-tracker-web/screen-calibration-v1";
export const SCREEN_CALIBRATION_REPEATABILITY_LIMIT_PERCENT = 3;
export const SCREEN_CALIBRATION_MINIMUM_SQUARE_CSS_PX = 24;

const finitePositive = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label} must be a positive finite number.`);
  return number;
};
const finite = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite.`);
  return number;
};
const rounded = (value, digits = 6) => Number(Number(value).toFixed(digits));
const bounded = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function createDisplaySignature({ screenWidth, screenHeight, devicePixelRatio, orientation = "unknown" }) {
  return Object.freeze({
    screenWidth: Math.round(finitePositive(screenWidth, "Screen width")),
    screenHeight: Math.round(finitePositive(screenHeight, "Screen height")),
    devicePixelRatio: rounded(finitePositive(devicePixelRatio, "Device pixel ratio"), 4),
    orientation: String(orientation || "unknown"),
  });
}

export function currentDisplaySignature(view = globalThis) {
  const screenObject = view.screen;
  return createDisplaySignature({
    screenWidth: screenObject?.width,
    screenHeight: screenObject?.height,
    devicePixelRatio: view.devicePixelRatio ?? 1,
    orientation: screenObject?.orientation?.type ?? `${screenObject?.width >= screenObject?.height ? "landscape" : "portrait"}`,
  });
}

export function displaySignaturesMatch(left, right) {
  return Boolean(left && right
    && left.screenWidth === right.screenWidth
    && left.screenHeight === right.screenHeight
    && Math.abs(left.devicePixelRatio - right.devicePixelRatio) < 0.0001
    && left.orientation === right.orientation);
}

function normalizeBounds(bounds) {
  return { width: finitePositive(bounds?.width, "Viewport width"), height: finitePositive(bounds?.height, "Viewport height") };
}

function normalizeSquare(square) {
  return { x: finite(square?.x, "Square x"), y: finite(square?.y, "Square y"), side: finitePositive(square?.side, "Square side") };
}

export function createCalibrationSquareFromDrag(start, pointer, bounds, minimumSide = SCREEN_CALIBRATION_MINIMUM_SQUARE_CSS_PX) {
  const viewport = normalizeBounds(bounds);
  const anchor = { x: bounded(finite(start?.x, "Start x"), 0, viewport.width), y: bounded(finite(start?.y, "Start y"), 0, viewport.height) };
  const current = { x: bounded(finite(pointer?.x, "Pointer x"), 0, viewport.width), y: bounded(finite(pointer?.y, "Pointer y"), 0, viewport.height) };
  const xDirection = current.x >= anchor.x ? 1 : -1;
  const yDirection = current.y >= anchor.y ? 1 : -1;
  const maximum = Math.min(xDirection > 0 ? viewport.width - anchor.x : anchor.x, yDirection > 0 ? viewport.height - anchor.y : anchor.y);
  if (maximum <= 0) return undefined;
  const side = Math.min(maximum, Math.max(Math.min(minimumSide, maximum), Math.abs(current.x - anchor.x), Math.abs(current.y - anchor.y)));
  return Object.freeze({ x: rounded(xDirection > 0 ? anchor.x : anchor.x - side, 3), y: rounded(yDirection > 0 ? anchor.y : anchor.y - side, 3), side: rounded(side, 3) });
}

export function translateCalibrationSquare(square, deltaX, deltaY, bounds) {
  const normalized = normalizeSquare(square);
  const viewport = normalizeBounds(bounds);
  const side = Math.min(normalized.side, viewport.width, viewport.height);
  return Object.freeze({
    x: rounded(bounded(normalized.x + finite(deltaX, "Horizontal movement"), 0, viewport.width - side), 3),
    y: rounded(bounded(normalized.y + finite(deltaY, "Vertical movement"), 0, viewport.height - side), 3),
    side: rounded(side, 3),
  });
}

export function translateCalibrationSquareFromEdge(square, edge, delta, bounds) {
  if (edge === "top" || edge === "bottom") return translateCalibrationSquare(square, 0, delta, bounds);
  if (edge === "left" || edge === "right") return translateCalibrationSquare(square, delta, 0, bounds);
  throw new TypeError("Unknown square edge.");
}

export function calibrationSquareAfterPointerCancellation(kind, originalSquare) {
  if (kind === "draw") return undefined;
  if (!["move", "edge", "corner"].includes(kind)) throw new TypeError("Unknown pointer operation.");
  return Object.freeze(normalizeSquare(originalSquare));
}

export function resizeCalibrationSquareFromCorner(square, corner, pointer, bounds, minimumSide = SCREEN_CALIBRATION_MINIMUM_SQUARE_CSS_PX) {
  const original = normalizeSquare(square);
  const viewport = normalizeBounds(bounds);
  const point = { x: bounded(finite(pointer?.x, "Pointer x"), 0, viewport.width), y: bounded(finite(pointer?.y, "Pointer y"), 0, viewport.height) };
  const oppositeByCorner = {
    nw: [original.x + original.side, original.y + original.side, -1, -1],
    ne: [original.x, original.y + original.side, 1, -1],
    se: [original.x, original.y, 1, 1],
    sw: [original.x + original.side, original.y, -1, 1],
  };
  const definition = oppositeByCorner[corner];
  if (!definition) throw new TypeError("Unknown square corner.");
  const [oppositeX, oppositeY, xDirection, yDirection] = definition;
  const maximum = Math.min(xDirection > 0 ? viewport.width - oppositeX : oppositeX, yDirection > 0 ? viewport.height - oppositeY : oppositeY);
  const desired = Math.max(Math.abs(point.x - oppositeX), Math.abs(point.y - oppositeY));
  const side = bounded(desired, Math.min(minimumSide, maximum), maximum);
  return Object.freeze({ x: rounded(xDirection > 0 ? oppositeX : oppositeX - side, 3), y: rounded(yDirection > 0 ? oppositeY : oppositeY - side, 3), side: rounded(side, 3) });
}

export function calibrationStatistics(measurementsCssPx, diameterMm) {
  if (!Array.isArray(measurementsCssPx) || measurementsCssPx.length !== 2) throw new TypeError("Exactly two calibration measurements are required.");
  const measurements = measurementsCssPx.map((value) => finitePositive(value, "Square size"));
  const diameter = finitePositive(diameterMm, "Coin diameter");
  const meanCssPx = (measurements[0] + measurements[1]) / 2;
  const rangeCssPx = Math.abs(measurements[0] - measurements[1]);
  return Object.freeze({ measurementCount: 2, meanCssPx: rounded(meanCssPx, 4), rangeCssPx: rounded(rangeCssPx, 4), repeatabilityPercent: rounded((rangeCssPx / meanCssPx) * 100, 3), mmPerCssPixel: rounded(diameter / meanCssPx, 8) });
}

function fullscreenViewport(width, height, mmPerCssPixel) {
  const viewportWidth = finitePositive(width, "Viewport width");
  const viewportHeight = finitePositive(height, "Viewport height");
  return Object.freeze({ widthCssPx: rounded(viewportWidth, 2), heightCssPx: rounded(viewportHeight, 2), widthMm: rounded(viewportWidth * mmPerCssPixel, 2), heightMm: rounded(viewportHeight * mmPerCssPixel, 2) });
}

function canonicalCoin(coin) {
  return Object.freeze({ id: coin.id, currencyCode: coin.currency, currencyName: coin.currencyName, currencySymbol: coin.currencySymbol, denomination: coin.denomination, label: coin.label, diameterMm: coin.diameterMm, authority: coin.authority, sourceUrl: coin.sourceUrl, verifiedOn: coin.verifiedOn });
}

export function createScreenCalibration({ coinId, countryCode, squareSideCssPx, viewportWidthCssPx, viewportHeightCssPx, displaySignature, calibratedAt = new Date().toISOString() }) {
  const coin = coinReferenceById(coinId);
  const country = countryByCode(countryCode);
  if (!coin || !country || country.currencyCode !== coin.currency) throw new TypeError("Choose a supported country and reference coin.");
  const side = rounded(finitePositive(squareSideCssPx, "Square side"), 4);
  if (side < SCREEN_CALIBRATION_MINIMUM_SQUARE_CSS_PX) throw new RangeError("The drawn square is too small.");
  const mmPerCssPixel = rounded(coin.diameterMm / side, 8);
  const currency = currencyByCode(coin.currency);
  return Object.freeze({
    schema: SCREEN_CALIBRATION_SCHEMA,
    version: SCREEN_CALIBRATION_VERSION,
    protocol: SCREEN_CALIBRATION_PROTOCOL,
    calibratedAt: new Date(calibratedAt).toISOString(),
    country: Object.freeze({ code: country.code, name: country.name }),
    currency: Object.freeze({ code: currency.code, name: currency.name, symbol: currency.symbol }),
    coin: canonicalCoin(coin),
    squareSideCssPx: side,
    mmPerCssPixel,
    fullscreenViewport: fullscreenViewport(viewportWidthCssPx, viewportHeightCssPx, mmPerCssPixel),
    displaySignature: createDisplaySignature(displaySignature),
  });
}

export function createScreenCalibrationV1({ coinId, measurementsCssPx, viewportWidthCssPx, viewportHeightCssPx, displaySignature, calibratedAt = new Date().toISOString() }) {
  const coin = coinReferenceById(coinId);
  if (!coin) throw new TypeError("Choose a supported reference coin.");
  const statistics = calibrationStatistics(measurementsCssPx, coin.diameterMm);
  if (statistics.repeatabilityPercent > SCREEN_CALIBRATION_REPEATABILITY_LIMIT_PERCENT) throw new RangeError(`The two matches differ by ${statistics.repeatabilityPercent.toFixed(1)}%.`);
  return Object.freeze({ schema: SCREEN_CALIBRATION_SCHEMA, version: 1, calibratedAt: new Date(calibratedAt).toISOString(), coin: Object.freeze({ id: coin.id, region: coin.region, currency: coin.currency, denomination: coin.denomination, diameterMm: coin.diameterMm, authority: coin.authority, sourceUrl: coin.sourceUrl }), measurementsCssPx: Object.freeze(measurementsCssPx.map((value) => rounded(finitePositive(value, "Square size"), 4))), meanCssPx: statistics.meanCssPx, repeatabilityPercent: statistics.repeatabilityPercent, mmPerCssPixel: statistics.mmPerCssPixel, fullscreenViewport: fullscreenViewport(viewportWidthCssPx, viewportHeightCssPx, statistics.mmPerCssPixel), displaySignature: createDisplaySignature(displaySignature) });
}

function exactObject(candidate, rebuilt, numeric = false) {
  return Object.keys(rebuilt).every((key) => numeric ? Number(candidate?.[key]) === rebuilt[key] : candidate?.[key] === rebuilt[key]);
}

function parseV1(candidate) {
  const rebuilt = createScreenCalibrationV1({ coinId: candidate.coin?.id, measurementsCssPx: candidate.measurementsCssPx, viewportWidthCssPx: candidate.fullscreenViewport?.widthCssPx, viewportHeightCssPx: candidate.fullscreenViewport?.heightCssPx, displaySignature: candidate.displaySignature, calibratedAt: candidate.calibratedAt });
  const stableCoinKeys = ["id", "currency", "denomination", "diameterMm", "authority"];
  let sourceMatches = false;
  try {
    const candidateSource = new URL(candidate.coin?.sourceUrl);
    const canonicalSource = new URL(rebuilt.coin.sourceUrl);
    sourceMatches = candidateSource.protocol === "https:" && candidateSource.hostname === canonicalSource.hostname;
  } catch { sourceMatches = false; }
  const matches = stableCoinKeys.every((key) => candidate.coin?.[key] === rebuilt.coin[key])
    && sourceMatches
    && candidate.calibratedAt === rebuilt.calibratedAt
    && Number(candidate.meanCssPx) === rebuilt.meanCssPx
    && Number(candidate.repeatabilityPercent) === rebuilt.repeatabilityPercent
    && Number(candidate.mmPerCssPixel) === rebuilt.mmPerCssPixel
    && exactObject(candidate.fullscreenViewport, rebuilt.fullscreenViewport, true)
    && exactObject(candidate.displaySignature, rebuilt.displaySignature);
  if (!matches) throw new TypeError("Screen calibration record does not match its measurements and reference coin.");
  return rebuilt;
}

function parseV2(candidate) {
  const rebuilt = createScreenCalibration({ coinId: candidate.coin?.id, countryCode: candidate.country?.code, squareSideCssPx: candidate.squareSideCssPx, viewportWidthCssPx: candidate.fullscreenViewport?.widthCssPx, viewportHeightCssPx: candidate.fullscreenViewport?.heightCssPx, displaySignature: candidate.displaySignature, calibratedAt: candidate.calibratedAt });
  const matches = candidate.protocol === rebuilt.protocol
    && candidate.calibratedAt === rebuilt.calibratedAt
    && exactObject(candidate.country, rebuilt.country)
    && exactObject(candidate.currency, rebuilt.currency)
    && exactObject(candidate.coin, rebuilt.coin)
    && Number(candidate.squareSideCssPx) === rebuilt.squareSideCssPx
    && Number(candidate.mmPerCssPixel) === rebuilt.mmPerCssPixel
    && exactObject(candidate.fullscreenViewport, rebuilt.fullscreenViewport, true)
    && exactObject(candidate.displaySignature, rebuilt.displaySignature);
  if (!matches) throw new TypeError("Screen calibration record does not match its geometry and reference coin.");
  return rebuilt;
}

export function parseScreenCalibration(value) {
  const candidate = typeof value === "string" ? JSON.parse(value) : value;
  if (candidate?.schema !== SCREEN_CALIBRATION_SCHEMA) throw new TypeError("Unsupported screen calibration format.");
  if (candidate.version === 1) return parseV1(candidate);
  if (candidate.version === SCREEN_CALIBRATION_VERSION) return parseV2(candidate);
  throw new TypeError("Unsupported screen calibration format.");
}

export function screenCalibrationStatus(calibration, displaySignature) {
  if (!calibration) return Object.freeze({ state: "missing", message: "Not calibrated" });
  let parsed;
  try { parsed = parseScreenCalibration(calibration); } catch { return Object.freeze({ state: "invalid", message: "Saved calibration is invalid" }); }
  if (!displaySignaturesMatch(parsed.displaySignature, displaySignature)) return Object.freeze({ state: "stale", message: "Display changed — recalibrate", calibration: parsed });
  return Object.freeze({ state: "valid", message: "Calibrated", calibration: parsed });
}

export function calibrationRecordContext(status) {
  const calibration = status?.state === "valid" ? status.calibration : undefined;
  const v2 = calibration?.version === 2;
  return {
    screenCalibrationStatus: status?.state ?? "missing",
    screenCalibrationProtocol: calibration?.protocol ?? (calibration ? "two-match-v1" : ""),
    screenCalibrationVersion: calibration?.version ?? "",
    screenCalibrationCountryCode: v2 ? calibration.country.code : "",
    screenCalibrationCountryName: v2 ? calibration.country.name : "",
    screenCalibrationCoinId: calibration?.coin.id ?? "",
    screenCalibrationCurrency: v2 ? calibration.currency.code : (calibration?.coin.currency ?? ""),
    screenCalibrationDenomination: calibration?.coin.denomination ?? "",
    screenCalibrationDiameterMm: calibration?.coin.diameterMm ?? "",
    screenCalibrationCssPixels: v2 ? calibration.squareSideCssPx : (calibration?.meanCssPx ?? ""),
    screenMmPerCssPixel: calibration?.mmPerCssPixel ?? "",
    calibratedViewportWidthMm: calibration?.fullscreenViewport.widthMm ?? "",
    calibratedViewportHeightMm: calibration?.fullscreenViewport.heightMm ?? "",
    screenCalibrationRepeatabilityPercent: v2 ? "" : (calibration?.repeatabilityPercent ?? ""),
    screenCalibrationTimestamp: calibration?.calibratedAt ?? "",
  };
}
