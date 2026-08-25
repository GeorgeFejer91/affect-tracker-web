import { coinReferenceById } from "./coin-reference-catalog.js";

export const SCREEN_CALIBRATION_SCHEMA = "affect-tracker-screen-calibration";
export const SCREEN_CALIBRATION_VERSION = 1;
export const SCREEN_CALIBRATION_STORAGE_KEY = "affect-tracker-web/screen-calibration-v1";
export const SCREEN_CALIBRATION_REPEATABILITY_LIMIT_PERCENT = 3;

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label} must be a positive finite number.`);
  return number;
}

function rounded(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

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
  if (!left || !right) return false;
  return left.screenWidth === right.screenWidth
    && left.screenHeight === right.screenHeight
    && Math.abs(left.devicePixelRatio - right.devicePixelRatio) < 0.0001
    && left.orientation === right.orientation;
}

export function calibrationStatistics(measurementsCssPx, diameterMm) {
  if (!Array.isArray(measurementsCssPx) || measurementsCssPx.length !== 2) {
    throw new TypeError("Exactly two calibration measurements are required.");
  }
  const measurements = measurementsCssPx.map((value) => finitePositive(value, "Square size"));
  const diameter = finitePositive(diameterMm, "Coin diameter");
  const meanCssPx = measurements.reduce((sum, value) => sum + value, 0) / measurements.length;
  const rangeCssPx = Math.max(...measurements) - Math.min(...measurements);
  return Object.freeze({
    measurementCount: measurements.length,
    meanCssPx: rounded(meanCssPx, 4),
    rangeCssPx: rounded(rangeCssPx, 4),
    repeatabilityPercent: rounded((rangeCssPx / meanCssPx) * 100, 3),
    mmPerCssPixel: rounded(diameter / meanCssPx, 8),
  });
}

export function createScreenCalibration({
  coinId,
  measurementsCssPx,
  viewportWidthCssPx,
  viewportHeightCssPx,
  displaySignature,
  calibratedAt = new Date().toISOString(),
}) {
  const coin = coinReferenceById(coinId);
  if (!coin) throw new TypeError("Choose a supported reference coin.");
  const viewportWidth = finitePositive(viewportWidthCssPx, "Viewport width");
  const viewportHeight = finitePositive(viewportHeightCssPx, "Viewport height");
  const statistics = calibrationStatistics(measurementsCssPx, coin.diameterMm);
  if (statistics.repeatabilityPercent > SCREEN_CALIBRATION_REPEATABILITY_LIMIT_PERCENT) {
    throw new RangeError(`The two matches differ by ${statistics.repeatabilityPercent.toFixed(1)}%; repeat them within ${SCREEN_CALIBRATION_REPEATABILITY_LIMIT_PERCENT}%.`);
  }
  const signature = createDisplaySignature(displaySignature);
  return Object.freeze({
    schema: SCREEN_CALIBRATION_SCHEMA,
    version: SCREEN_CALIBRATION_VERSION,
    calibratedAt: new Date(calibratedAt).toISOString(),
    coin: Object.freeze({
      id: coin.id,
      region: coin.region,
      currency: coin.currency,
      denomination: coin.denomination,
      diameterMm: coin.diameterMm,
      authority: coin.authority,
      sourceUrl: coin.sourceUrl,
    }),
    measurementsCssPx: Object.freeze(measurementsCssPx.map((value) => rounded(finitePositive(value, "Square size"), 4))),
    meanCssPx: statistics.meanCssPx,
    repeatabilityPercent: statistics.repeatabilityPercent,
    mmPerCssPixel: statistics.mmPerCssPixel,
    fullscreenViewport: Object.freeze({
      widthCssPx: rounded(viewportWidth, 2),
      heightCssPx: rounded(viewportHeight, 2),
      widthMm: rounded(viewportWidth * statistics.mmPerCssPixel, 2),
      heightMm: rounded(viewportHeight * statistics.mmPerCssPixel, 2),
    }),
    displaySignature: signature,
  });
}

export function parseScreenCalibration(value) {
  const candidate = typeof value === "string" ? JSON.parse(value) : value;
  if (candidate?.schema !== SCREEN_CALIBRATION_SCHEMA || candidate?.version !== SCREEN_CALIBRATION_VERSION) {
    throw new TypeError("Unsupported screen calibration format.");
  }
  const rebuilt = createScreenCalibration({
    coinId: candidate.coin?.id,
    measurementsCssPx: candidate.measurementsCssPx,
    viewportWidthCssPx: candidate.fullscreenViewport?.widthCssPx,
    viewportHeightCssPx: candidate.fullscreenViewport?.heightCssPx,
    displaySignature: candidate.displaySignature,
    calibratedAt: candidate.calibratedAt,
  });
  const canonicalCoin = rebuilt.coin;
  const coinMatches = Object.keys(canonicalCoin).every((key) => candidate.coin?.[key] === canonicalCoin[key]);
  const measurementsMatch = Array.isArray(candidate.measurementsCssPx)
    && candidate.measurementsCssPx.length === rebuilt.measurementsCssPx.length
    && rebuilt.measurementsCssPx.every((measurement, index) => measurement === Number(candidate.measurementsCssPx[index]));
  const scalarMatches = candidate.calibratedAt === rebuilt.calibratedAt
    && Number(candidate.meanCssPx) === rebuilt.meanCssPx
    && Number(candidate.repeatabilityPercent) === rebuilt.repeatabilityPercent
    && Number(candidate.mmPerCssPixel) === rebuilt.mmPerCssPixel;
  const viewportMatches = Object.keys(rebuilt.fullscreenViewport)
    .every((key) => Number(candidate.fullscreenViewport?.[key]) === rebuilt.fullscreenViewport[key]);
  const signatureMatches = Object.keys(rebuilt.displaySignature)
    .every((key) => candidate.displaySignature?.[key] === rebuilt.displaySignature[key]);
  if (!coinMatches || !measurementsMatch || !scalarMatches || !viewportMatches || !signatureMatches) {
    throw new TypeError("Screen calibration record does not match its measurements and reference coin.");
  }
  return rebuilt;
}

export function screenCalibrationStatus(calibration, displaySignature) {
  if (!calibration) return Object.freeze({ state: "missing", message: "Not calibrated" });
  let parsed;
  try {
    parsed = parseScreenCalibration(calibration);
  } catch {
    return Object.freeze({ state: "invalid", message: "Saved calibration is invalid" });
  }
  if (!displaySignaturesMatch(parsed.displaySignature, displaySignature)) {
    return Object.freeze({ state: "stale", message: "Display changed — recalibrate", calibration: parsed });
  }
  return Object.freeze({ state: "valid", message: "Calibrated", calibration: parsed });
}

export function calibrationRecordContext(status) {
  const calibration = status?.state === "valid" ? status.calibration : undefined;
  return {
    screenCalibrationStatus: status?.state ?? "missing",
    screenCalibrationCoinId: calibration?.coin.id ?? "",
    screenCalibrationCurrency: calibration?.coin.currency ?? "",
    screenCalibrationDenomination: calibration?.coin.denomination ?? "",
    screenCalibrationDiameterMm: calibration?.coin.diameterMm ?? "",
    screenCalibrationCssPixels: calibration?.meanCssPx ?? "",
    screenMmPerCssPixel: calibration?.mmPerCssPixel ?? "",
    calibratedViewportWidthMm: calibration?.fullscreenViewport.widthMm ?? "",
    calibratedViewportHeightMm: calibration?.fullscreenViewport.heightMm ?? "",
    screenCalibrationRepeatabilityPercent: calibration?.repeatabilityPercent ?? "",
    screenCalibrationTimestamp: calibration?.calibratedAt ?? "",
  };
}
