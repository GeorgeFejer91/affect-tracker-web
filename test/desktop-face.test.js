import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FACE_AFFECT_ANCHORS,
  buildFaceGeometry,
  interpolateFaceExpression,
} from "../site/src/face.js";

const approximately = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

test("face interpolation reproduces all nine authored VA anchors", () => {
  const coordinates = [-1, 0, 1];
  for (let row = 0; row < coordinates.length; row += 1) {
    for (let column = 0; column < coordinates.length; column += 1) {
      const rendered = interpolateFaceExpression(coordinates[column], coordinates[row]);
      for (const [key, expected] of Object.entries(FACE_AFFECT_ANCHORS[row][column])) {
        approximately(rendered[key], expected);
      }
    }
  }
});

test("neutral face is symmetric with a straight closed mouth", () => {
  const geometry = buildFaceGeometry({ x: 0, y: 0, phase: Math.PI / 2 });
  assert.equal(geometry.expression.mouthCurve, 0);
  assert.equal(geometry.expression.mouthOpen, 0);
  assert.match(geometry.leftBrowPath, /^M -0\.55/);
  assert.match(geometry.rightBrowPath, /^M 0\.18/);
  assert.equal(geometry.mouthPath, "M -0.42 0.36 Q 0 0.36 0.42 0.36 Q 0 0.36 -0.42 0.36 Z");
});

test("piecewise bilinear interpolation is continuous at both neutral axes", () => {
  const epsilon = 1e-7;
  for (const [left, right] of [
    [interpolateFaceExpression(-epsilon, 0.4), interpolateFaceExpression(epsilon, 0.4)],
    [interpolateFaceExpression(0.4, -epsilon), interpolateFaceExpression(0.4, epsilon)],
  ]) {
    for (const key of Object.keys(left)) approximately(left[key], right[key], 1e-6);
  }

  const midpoint = interpolateFaceExpression(-0.5, -0.5);
  for (const key of Object.keys(midpoint)) {
    const expected = (
      FACE_AFFECT_ANCHORS[0][0][key]
      + FACE_AFFECT_ANCHORS[0][1][key]
      + FACE_AFFECT_ANCHORS[1][0][key]
      + FACE_AFFECT_ANCHORS[1][1][key]
    ) / 4;
    approximately(midpoint[key], expected);
  }
});

test("face controls follow canonical valence and arousal orderings", () => {
  const negative = interpolateFaceExpression(-1, 0);
  const neutral = interpolateFaceExpression(0, 0);
  const positive = interpolateFaceExpression(1, 0);
  assert.ok(negative.mouthCurve < neutral.mouthCurve);
  assert.ok(neutral.mouthCurve < positive.mouthCurve);

  const low = interpolateFaceExpression(0, -1);
  const high = interpolateFaceExpression(0, 1);
  assert.ok(low.eyeOpen < high.eyeOpen);
  assert.ok(low.mouthOpen < high.mouthOpen);
});

test("face mapping clamps finite coordinates and falls back safely for non-finite input", () => {
  assert.deepEqual(interpolateFaceExpression(2, -2), FACE_AFFECT_ANCHORS[0][2]);
  assert.deepEqual(interpolateFaceExpression(Number.NaN, Number.POSITIVE_INFINITY), FACE_AFFECT_ANCHORS[1][1]);
  const geometry = buildFaceGeometry({ x: Number.NaN, y: Number.NEGATIVE_INFINITY, phase: Number.NaN });
  assert.equal(geometry.x, 0);
  assert.equal(geometry.y, 0);
  assert.doesNotMatch(`${geometry.leftBrowPath} ${geometry.rightBrowPath} ${geometry.mouthPath}`, /NaN|Infinity/);
});

test("shared phase animates the face while reduced motion remains phase independent", () => {
  const start = buildFaceGeometry({ x: 0.4, y: 0.8, phase: 0 });
  const peak = buildFaceGeometry({ x: 0.4, y: 0.8, phase: Math.PI / 2 });
  const cycle = buildFaceGeometry({ x: 0.4, y: 0.8, phase: Math.PI * 2 });
  assert.notEqual(start.headScale, peak.headScale);
  approximately(start.headScale, cycle.headScale);

  const reducedStart = buildFaceGeometry({ x: 0.4, y: 0.8, phase: 0, reducedMotion: true });
  const reducedPeak = buildFaceGeometry({ x: 0.4, y: 0.8, phase: Math.PI / 2, reducedMotion: true });
  assert.deepEqual(reducedStart, reducedPeak);
});

test("desktop pairs face left and Flubber right from one current-state snapshot", () => {
  const html = readFileSync(new URL("../desktop/index.html", import.meta.url), "utf8");
  const renderSource = readFileSync(new URL("../desktop/src/render.js", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../desktop/src/settings.js", import.meta.url), "utf8");
  assert.ok(html.indexOf('class="face-preview"') < html.indexOf('class="flubber-preview"'));
  assert.ok(html.indexOf('class="face-3d-canvas"') < html.indexOf('class="flubber-preview"'));
  assert.match(html, /class="face-3d-fallback" data-face-3d-fallback hidden/);
  assert.match(renderSource, /from "\.\.\/\.\.\/site\/src\/face-3d\.js"/);
  assert.match(renderSource, /renderFlubber\(snapshot, reducedMotion\)/);
  assert.match(renderSource, /renderFace\(snapshot, reducedMotion, flubber\.color\)/);
  assert.doesNotMatch(renderSource, /targetX|targetY/);
  assert.match(settingsSource, /const renderedSnapshot = Object\.freeze\(/);
  assert.match(settingsSource, /renderAffectPair\(renderedSnapshot, reducedMotion\.matches\)/);
  assert.match(html, /not emotion recognition, diagnosis/);
});

test("GitHub Pages keeps the affect face on the main stage and its enable control in the accordion", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../site/src/app.js", import.meta.url), "utf8");
  const protocols = readFileSync(new URL("../site/src/accordion-protocols.js", import.meta.url), "utf8");
  assert.match(html, /id="face-flubber-panel"[^>]*data-module-protocol="face"/);
  assert.match(html, /Synchronized Face \+ Flubber/);
  assert.ok(html.indexOf('id="main-affect-face"') < html.indexOf('id="affect-widget"'));
  assert.match(html, /id="main-affect-face-canvas"/);
  assert.match(html, /id="main-affect-face-fallback"[^>]*data-face-3d-fallback/);
  assert.match(html, /id="mobile-main-affect-face"/);
  assert.match(html, /id="main-face-enabled" type="checkbox" checked/);
  assert.match(html, /id="main-face-center-button"/);
  assert.doesNotMatch(html, /id="web-synchronized-affect-preview"/);
  assert.match(html, /not emotion recognition, diagnosis/);
  assert.match(protocols, /faceFlubberPanelOpen/);
  assert.match(protocols, /domainModule: "face-3d\.js"/);
  assert.match(appSource, /const affectFrame = Object\.freeze\(/);
  assert.match(appSource, /renderSynchronizedAffectPreview\(affectFrame, rendered\)/);
  assert.match(appSource, /\[elements\.mainAffectFace, renderMainAffectFace\]/);
  assert.match(appSource, /\[elements\.mobileMainAffectFace, renderMobileAffectFace\]/);
  assert.match(appSource, /renderer\(snapshot, reducedMotionQuery\.matches, flubber\.color\)/);
  assert.match(appSource, /const desiredX = flubberPosition\.x - distance/);
  assert.doesNotMatch(appSource, /rightCandidate/);
  assert.match(appSource, /if \(state\.mainFaceEnabled\) centerMainAffectPair\(\)/);
  assert.match(appSource, /mainFaceEnabled: state\.mainFaceEnabled/);
  const portableSettingsSlice = appSource.slice(
    appSource.indexOf("function settingsFromState"),
    appSource.indexOf("function recordEvent"),
  );
  assert.doesNotMatch(portableSettingsSlice, /mainFaceEnabled/);
  assert.doesNotMatch(appSource.slice(
    appSource.indexOf("function renderSynchronizedAffectPreview"),
    appSource.indexOf("function updateCoordinateDisplay"),
  ), /targetX|targetY/);
});
