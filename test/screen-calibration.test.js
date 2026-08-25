import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COIN_CATALOG_VERIFIED_ON,
  COIN_REFERENCE_CATALOG,
  coinReferenceById,
  validateCoinReferenceCatalog,
} from "../site/src/coin-reference-catalog.js";
import {
  calibrationRecordContext,
  calibrationStatistics,
  createDisplaySignature,
  createScreenCalibration,
  displaySignaturesMatch,
  parseScreenCalibration,
  screenCalibrationStatus,
} from "../site/src/screen-calibration.js";

const display = createDisplaySignature({
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1.25,
  orientation: "landscape-primary",
});

test("coin reference catalog covers thirty currency regions with auditable official sources", () => {
  assert.equal(COIN_CATALOG_VERIFIED_ON, "2026-08-25");
  assert.equal(validateCoinReferenceCatalog(), true);
  assert.ok(COIN_REFERENCE_CATALOG.length >= 30);
  assert.equal(new Set(COIN_REFERENCE_CATALOG.map(({ currency }) => currency)).size, COIN_REFERENCE_CATALOG.length);
  assert.equal(coinReferenceById("eur-1").diameterMm, 23.25);
  assert.ok(COIN_REFERENCE_CATALOG.every(({ sourceUrl }) => sourceUrl.startsWith("https://")));
});

test("two close square matches derive a reproducible physical CSS-pixel scale", () => {
  const statistics = calibrationStatistics([92, 93], 23.25);
  assert.equal(statistics.meanCssPx, 92.5);
  assert.equal(statistics.repeatabilityPercent, 1.081);
  assert.equal(statistics.mmPerCssPixel, 0.25135135);

  const calibration = createScreenCalibration({
    coinId: "eur-1",
    measurementsCssPx: [92, 93],
    viewportWidthCssPx: 1920,
    viewportHeightCssPx: 1080,
    displaySignature: display,
    calibratedAt: "2026-08-25T12:00:00.000Z",
  });
  assert.equal(calibration.fullscreenViewport.widthMm, 482.59);
  assert.equal(calibration.fullscreenViewport.heightMm, 271.46);
  assert.deepEqual(parseScreenCalibration(JSON.stringify(calibration)), calibration);
});

test("inconsistent matches fail closed instead of silently averaging", () => {
  assert.throws(() => createScreenCalibration({
    coinId: "eur-1",
    measurementsCssPx: [80, 90],
    viewportWidthCssPx: 1920,
    viewportHeightCssPx: 1080,
    displaySignature: display,
  }), /differ by .*repeat/i);
  assert.throws(() => calibrationStatistics([80, 80, 80], 23.25), /exactly two/i);
});

test("saved calibration rejects tampered derived values and coin provenance", () => {
  const calibration = createScreenCalibration({
    coinId: "eur-1",
    measurementsCssPx: [92, 93],
    viewportWidthCssPx: 1920,
    viewportHeightCssPx: 1080,
    displaySignature: display,
  });
  const alteredViewport = JSON.parse(JSON.stringify(calibration));
  alteredViewport.fullscreenViewport.widthMm += 10;
  assert.throws(() => parseScreenCalibration(alteredViewport), /does not match/i);

  const alteredSource = JSON.parse(JSON.stringify(calibration));
  alteredSource.coin.sourceUrl = "https://example.com/not-the-official-source";
  assert.throws(() => parseScreenCalibration(alteredSource), /does not match/i);
});

test("display scaling and orientation changes invalidate a saved calibration", () => {
  const calibration = createScreenCalibration({
    coinId: "usd-quarter",
    measurementsCssPx: [96, 97],
    viewportWidthCssPx: 1920,
    viewportHeightCssPx: 1080,
    displaySignature: display,
  });
  assert.equal(screenCalibrationStatus(calibration, display).state, "valid");
  const rotated = createDisplaySignature({ screenWidth: 1080, screenHeight: 1920, devicePixelRatio: 1.25, orientation: "portrait-primary" });
  assert.equal(displaySignaturesMatch(display, rotated), false);
  assert.equal(screenCalibrationStatus(calibration, rotated).state, "stale");
  assert.equal(screenCalibrationStatus(undefined, display).state, "missing");
});

test("experiment record context exposes the valid calibration and withholds stale measurements", () => {
  const calibration = createScreenCalibration({
    coinId: "gbp-10p",
    measurementsCssPx: [94, 95],
    viewportWidthCssPx: 1600,
    viewportHeightCssPx: 900,
    displaySignature: display,
  });
  const valid = calibrationRecordContext(screenCalibrationStatus(calibration, display));
  assert.equal(valid.screenCalibrationStatus, "valid");
  assert.equal(valid.screenCalibrationCurrency, "GBP");
  assert.equal(valid.screenCalibrationDiameterMm, 24.5);
  assert.ok(valid.calibratedViewportWidthMm > 0);

  const stale = calibrationRecordContext({ state: "stale", calibration });
  assert.equal(stale.screenCalibrationStatus, "stale");
  assert.equal(stale.screenMmPerCssPixel, "");
});

test("experiment runner contains an accessible fullscreen two-match protocol", async () => {
  const [html, app, css, logger] = await Promise.all([
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../site/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../site/src/logger.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="screen-calibration-coin"/);
  assert.match(html, /id="screen-calibration-layer"[^>]*aria-labelledby=/);
  assert.match(html, /coin touches the midpoint of all four sides/i);
  assert.match(html, /Match 1 of 2/);
  assert.match(app, /screenCalibrationLayer\.requestFullscreen\(\)/);
  assert.match(app, /measurementsCssPx\.push/);
  assert.match(css, /\.screen-calibration-square[\s\S]*width: var\(--calibration-square-size/);
  assert.match(logger, /"screen_calibration_status"/);
  assert.match(logger, /"screen_mm_per_css_pixel"/);
  assert.match(logger, /"calibrated_viewport_width_mm"/);
});
