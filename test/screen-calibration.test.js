import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BIS_2025_MOST_TRADED_CURRENCY_CODES,
  COIN_CATALOG_VERIFIED_ON,
  COIN_REFERENCE_CATALOG,
  COUNTRY_CATALOG,
  CURRENCY_CATALOG,
  coinReferenceById,
  validateCoinReferenceCatalog,
} from "../site/screen-calibration/coin-reference-catalog.js";
import {
  calibrationRecordContext,
  calibrationSquareAfterPointerCancellation,
  createCalibrationSquareFromDrag,
  createDisplaySignature,
  createScreenCalibration,
  createScreenCalibrationV1,
  displaySignaturesMatch,
  parseScreenCalibration,
  resizeCalibrationSquareFromCorner,
  screenCalibrationStatus,
  translateCalibrationSquare,
  translateCalibrationSquareFromEdge,
} from "../site/screen-calibration/screen-calibration.js";

const display = createDisplaySignature({ screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1.25, orientation: "landscape-primary" });
const bounds = { width: 800, height: 600 };

test("country-aware circulating coin catalog is sourced, shared, and exposes the exact BIS top ten", () => {
  assert.equal(COIN_CATALOG_VERIFIED_ON, "2026-08-26");
  assert.equal(validateCoinReferenceCatalog(), true);
  assert.deepEqual(BIS_2025_MOST_TRADED_CURRENCY_CODES, ["USD", "EUR", "JPY", "GBP", "CNY", "CHF", "AUD", "CAD", "HKD", "SGD"]);
  assert.ok(CURRENCY_CATALOG.length >= 37);
  assert.ok(COUNTRY_CATALOG.length >= 61);
  assert.ok(COIN_REFERENCE_CATALOG.length >= 217);
  assert.equal(coinReferenceById("eur-1").diameterMm, 23.25);
  assert.equal(coinReferenceById("cny-1").diameterMm, 22.25);
  assert.ok(COIN_REFERENCE_CATALOG.every(({ shape, sourceUrl, verifiedOn }) => shape && sourceUrl.startsWith("https://") && verifiedOn === COIN_CATALOG_VERIFIED_ON));
  assert.equal(coinReferenceById("eur-20c").shape, "spanish-flower");
  assert.equal(coinReferenceById("gbp-1").diameterMm, 23.43);
  assert.equal(coinReferenceById("cad-1").shape, "hendecagonal");
  assert.equal(coinReferenceById("hkd-2").diameterMm, 28);
  assert.equal(coinReferenceById("aud-50c").shape, "dodecagonal");
  const germany = COUNTRY_CATALOG.find(({ code }) => code === "DE");
  const france = COUNTRY_CATALOG.find(({ code }) => code === "FR");
  assert.equal(germany.currencyCode, "EUR");
  assert.equal(france.currencyCode, "EUR");
  assert.equal(CURRENCY_CATALOG.filter(({ code }) => code === "EUR").length, 1);
});

test("diagonal drags create a perfect square in every direction", () => {
  assert.deepEqual(createCalibrationSquareFromDrag({ x: 100, y: 100 }, { x: 150, y: 130 }, bounds), { x: 100, y: 100, side: 50 });
  assert.deepEqual(createCalibrationSquareFromDrag({ x: 100, y: 100 }, { x: 50, y: 70 }, bounds), { x: 50, y: 50, side: 50 });
  assert.deepEqual(createCalibrationSquareFromDrag({ x: 100, y: 100 }, { x: 150, y: 70 }, bounds), { x: 100, y: 50, side: 50 });
  assert.deepEqual(createCalibrationSquareFromDrag({ x: 100, y: 100 }, { x: 50, y: 130 }, bounds), { x: 50, y: 100, side: 50 });
});

test("square translation stays inside the viewport and edge handles move one axis only", () => {
  assert.deepEqual(translateCalibrationSquare({ x: 20, y: 30, side: 100 }, -50, 700, bounds), { x: 0, y: 500, side: 100 });
  assert.deepEqual(translateCalibrationSquareFromEdge({ x: 20, y: 30, side: 100 }, "top", 25, bounds), { x: 20, y: 55, side: 100 });
  assert.deepEqual(translateCalibrationSquareFromEdge({ x: 20, y: 30, side: 100 }, "right", 40, bounds), { x: 60, y: 30, side: 100 });
});

test("corner handles resize a perfect square with the opposite corner fixed", () => {
  assert.deepEqual(resizeCalibrationSquareFromCorner({ x: 100, y: 100, side: 100 }, "nw", { x: 70, y: 80 }, bounds), { x: 70, y: 70, side: 130 });
  assert.deepEqual(resizeCalibrationSquareFromCorner({ x: 100, y: 100, side: 100 }, "se", { x: 260, y: 230 }, bounds), { x: 100, y: 100, side: 160 });
  const clamped = resizeCalibrationSquareFromCorner({ x: 700, y: 500, side: 80 }, "se", { x: 1000, y: 1000 }, bounds);
  assert.deepEqual(clamped, { x: 700, y: 500, side: 100 });
});

test("pointer cancellation discards an initial drawing and restores adjustment geometry", () => {
  const original = { x: 10, y: 20, side: 90 };
  assert.equal(calibrationSquareAfterPointerCancellation("draw", original), undefined);
  assert.deepEqual(calibrationSquareAfterPointerCancellation("corner", original), original);
  assert.throws(() => calibrationSquareAfterPointerCancellation("unknown", original), /unknown pointer operation/i);
});

test("v2 calibration persists only confirmed geometry and rejects tampering", () => {
  const calibration = createScreenCalibration({ coinId: "eur-1", countryCode: "DE", squareSideCssPx: 93, viewportWidthCssPx: 1920, viewportHeightCssPx: 1080, displaySignature: display, calibratedAt: "2026-08-26T12:00:00.000Z" });
  assert.equal(calibration.protocol, "drawn-square-v2");
  assert.equal(calibration.mmPerCssPixel, 0.25);
  assert.equal(calibration.fullscreenViewport.widthMm, 480);
  assert.equal(calibration.fullscreenViewport.heightMm, 270);
  assert.equal("pointerTrajectory" in calibration, false);
  assert.deepEqual(parseScreenCalibration(JSON.stringify(calibration)), calibration);
  const altered = JSON.parse(JSON.stringify(calibration));
  altered.squareSideCssPx = 94;
  assert.throws(() => parseScreenCalibration(altered), /does not match/i);
  const alteredSource = JSON.parse(JSON.stringify(calibration));
  alteredSource.coin.sourceUrl = "https://example.com/not-official";
  assert.throws(() => parseScreenCalibration(alteredSource), /does not match/i);
});

test("v1 two-match records remain readable and v2 replaces repeatability with country context", () => {
  const legacy = createScreenCalibrationV1({ coinId: "usd-quarter", measurementsCssPx: [96, 97], viewportWidthCssPx: 1920, viewportHeightCssPx: 1080, displaySignature: display, calibratedAt: "2026-08-25T12:00:00.000Z" });
  const parsed = parseScreenCalibration(JSON.stringify(legacy));
  assert.equal(parsed.version, 1);
  assert.ok(parsed.repeatabilityPercent > 0);
  const v1Context = calibrationRecordContext(screenCalibrationStatus(parsed, display));
  assert.equal(v1Context.screenCalibrationProtocol, "two-match-v1");
  assert.equal(v1Context.screenCalibrationCountryCode, "");
  const historicalPath = JSON.parse(JSON.stringify(createScreenCalibrationV1({ coinId: "nok-20", measurementsCssPx: [104, 105], viewportWidthCssPx: 1920, viewportHeightCssPx: 1080, displaySignature: display })));
  historicalPath.coin.sourceUrl = "https://www.norges-bank.no/en/topics/notes-and-coins/legal-tender-notes-coins/20-krone-coin/20-design/";
  assert.equal(parseScreenCalibration(historicalPath).version, 1);
  historicalPath.coin.sourceUrl = "https://example.com/tampered";
  assert.throws(() => parseScreenCalibration(historicalPath), /does not match/i);

  const current = createScreenCalibration({ coinId: "gbp-10p", countryCode: "GB", squareSideCssPx: 98, viewportWidthCssPx: 1600, viewportHeightCssPx: 900, displaySignature: display });
  const v2Context = calibrationRecordContext(screenCalibrationStatus(current, display));
  assert.equal(v2Context.screenCalibrationProtocol, "drawn-square-v2");
  assert.equal(v2Context.screenCalibrationVersion, 2);
  assert.equal(v2Context.screenCalibrationCountryCode, "GB");
  assert.equal(v2Context.screenCalibrationCountryName, "United Kingdom");
  assert.equal(v2Context.screenCalibrationRepeatabilityPercent, "");
});

test("display scaling and orientation changes invalidate records and withhold physical values", () => {
  const calibration = createScreenCalibration({ coinId: "usd-25c", countryCode: "US", squareSideCssPx: 97, viewportWidthCssPx: 1920, viewportHeightCssPx: 1080, displaySignature: display });
  assert.equal(screenCalibrationStatus(calibration, display).state, "valid");
  const rotated = createDisplaySignature({ screenWidth: 1080, screenHeight: 1920, devicePixelRatio: 1.25, orientation: "portrait-primary" });
  assert.equal(displaySignaturesMatch(display, rotated), false);
  const stale = calibrationRecordContext(screenCalibrationStatus(calibration, rotated));
  assert.equal(stale.screenCalibrationStatus, "stale");
  assert.equal(stale.screenMmPerCssPixel, "");
  assert.equal(screenCalibrationStatus(undefined, display).state, "missing");
});

test("the sixth Screen Calibration module owns the complete coin protocol and Experiment only consumes its context", async () => {
  const [html, app, controller, css, logger, icon] = await Promise.all([
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../site/screen-calibration/controller.js", import.meta.url), "utf8"),
    readFile(new URL("../site/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../site/src/logger.js", import.meta.url), "utf8"),
    readFile(new URL("../site/screen-calibration/assets/module-icon.svg", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="screen-calibration-panel"[^>]*data-module-protocol="calibration"/);
  assert.match(html, /src="\.\/screen-calibration\/assets\/module-icon\.svg"/);
  assert.match(html, /Experiment includes that physical-size context in every CSV row/);
  assert.doesNotMatch(html, /id="screen-calibration-coin"/);
  assert.doesNotMatch(html, /type="range"[^>]*screen-calibration/);
  assert.match(html, />Calibrate screen</);
  assert.match(html, /BIS 2025 ten most-traded currencies/);
  assert.match(html, /id="screen-calibration-directory"/);
  assert.match(html, /id="screen-calibration-country-select"/);
  assert.match(html, /id="screen-calibration-layer"[^>]*aria-labelledby=/);
  assert.match(html, /The entire lower half is the measuring surface/);
  assert.match(html, /id="screen-calibration-canvas"[^>]*aria-label="Lower-half screen-edge measuring surface"/);
  assert.match(html, /data-edge="top"/);
  assert.match(html, /data-corner="nw"/);
  assert.match(html, />Use this measurement</);
  assert.match(html, />Redraw</);
  assert.match(html, />Choose another coin</);
  assert.match(app, /createScreenCalibrationController/);
  assert.match(app, /screenCalibration\.recordContext\(\)/);
  assert.doesNotMatch(app, /function (?:renderScreenCalibrationStatus|createCountryFlagSvg|beginCalibrationPointer)/);
  assert.match(controller, /layer\.requestFullscreen\(\)/);
  assert.match(controller, /setPointerCapture\(event\.pointerId\)/);
  assert.match(controller, /createCountryFlagSvg/);
  assert.match(controller, /createCurrencySvg/);
  assert.match(controller, /elements\.directory\.hidden = true/);
  assert.match(controller, /elements\.layer\.dataset\.calibrationStep = step/);
  assert.match(controller, /left, right, or bottom screen rim/);
  assert.match(controller, /maximum outer span/);
  assert.match(controller, /pointercancel/);
  assert.match(css, /touch-action: none/);
  assert.match(css, /\.screen-calibration-layer \[hidden\] \{ display: none !important; \}/);
  assert.match(css, /grid-template-rows: minmax\(0, 1fr\) 50dvh/);
  assert.match(css, /\.screen-calibration-canvas \{[\s\S]{0,180}height: 50dvh;[\s\S]{0,120}border-radius: 0/);
  assert.match(icon, /<svg[^>]*viewBox="0 0 64 64"/);
  for (const field of ["screen_calibration_protocol", "screen_calibration_version", "screen_calibration_country_code", "screen_calibration_country_name", "screen_calibration_repeatability_percent"]) assert.match(logger, new RegExp(`"${field}"`));
});
