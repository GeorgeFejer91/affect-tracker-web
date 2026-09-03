import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FACE_AFFECT_ANCHORS,
  buildFaceGeometry,
  interpolateFaceExpression,
} from "../site/src/face.js";
import {
  DEFAULT_FACE_ENGINE_MODE,
  FACE_ENGINE_MODES,
} from "../site/src/face-engines.js";

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

test("desktop exposes the complete six-mode face stack before the right-side Flubber", () => {
  const html = readFileSync(new URL("../desktop/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../desktop/styles.css", import.meta.url), "utf8");
  const preview = html.match(
    /<div id="synchronized-affect-preview"[\s\S]*?<\/div>\s*<p class="face-disclosure">/,
  )?.[0];
  assert.ok(preview, "the synchronized desktop preview should be present");

  assert.ok(preview.indexOf('class="face-preview"') < preview.indexOf('class="flubber-preview"'));
  assert.ok(preview.indexOf('data-face-model') < preview.indexOf('data-face-photo'));
  assert.ok(preview.indexOf('data-face-photo') < preview.indexOf('data-face-3d-fallback'));
  assert.ok(preview.indexOf('data-face-3d-fallback') < preview.indexOf('class="flubber-preview"'));
  assert.equal((preview.match(/data-face-model/g) ?? []).length, 1);
  assert.equal((preview.match(/data-face-photo/g) ?? []).length, 1);
  assert.equal((preview.match(/data-face-3d-fallback/g) ?? []).length, 1);
  assert.match(preview, /<canvas class="face-model-canvas" data-face-model/);
  assert.match(preview, /<canvas class="face-photo-canvas" data-face-photo/);
  assert.match(preview, /class="face-3d-fallback" data-face-3d-fallback hidden[\s\S]*?<svg/);
  assert.match(css, /\.face-preview \.face-model-canvas\s*\{\s*z-index:\s*3;/);
  assert.match(css, /\.face-preview \.face-photo-canvas\s*\{\s*z-index:\s*2;/);
  assert.match(css, /\.face-preview \.face-3d-fallback\s*\{\s*z-index:\s*1;/);
  assert.match(css, /\.face-preview \.face-3d-fallback\[hidden\]\s*\{\s*display:\s*none;/);

  const selector = html.match(/<select id="desktop-face-engine">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(selector, "the desktop face solution selector should be present");
  const options = [...selector.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map((match) => ({ id: match[1], label: match[2].trim() }));
  assert.deepEqual(
    options,
    FACE_ENGINE_MODES.map(({ id, label }) => ({ id, label })),
  );
  assert.equal(options.length, 6);
  assert.equal(options[0].id, DEFAULT_FACE_ENGINE_MODE);
  assert.match(html, /does not access a camera, recognize faces, diagnose emotion/);
});

test("desktop renders every face mode and Flubber from one frozen current-state snapshot", () => {
  const renderSource = readFileSync(new URL("../desktop/src/render.js", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../desktop/src/settings.js", import.meta.url), "utf8");
  const synchronizedRenderer = renderSource.slice(
    renderSource.indexOf("export function createSynchronizedAffectRenderer"),
  );

  assert.match(renderSource, /from "\.\.\/\.\.\/site\/src\/face-engines\.js"/);
  assert.match(renderSource, /createFaceEngineRenderer\(faceRoot/);
  assert.match(
    synchronizedRenderer,
    /const flubber = renderFlubber\(snapshot, reducedMotion\);\s*const face = renderFace\(snapshot, reducedMotion, flubber\.color\);/,
  );
  assert.match(synchronizedRenderer, /root\.dataset\.renderSequence = String\(snapshot\.sequence \?\? ""\)/);
  assert.match(
    synchronizedRenderer,
    /return Object\.freeze\(\{ face, flubber, sequence: snapshot\.sequence \}\)/,
  );
  assert.doesNotMatch(synchronizedRenderer, /targetX|targetY/);

  assert.match(
    settingsSource,
    /createSynchronizedAffectRenderer\(elements\.synchronizedPreview, \{\s*faceMode: localStorage\.getItem\(DESKTOP_FACE_MODE_KEY\),\s*\}\)/,
  );
  assert.match(
    settingsSource,
    /const renderedSnapshot = Object\.freeze\(\{ \.\.\.snapshot, \.\.\.visualPreview, palette, overlayOpacity \}\);\s*renderAffectPair\(renderedSnapshot, reducedMotion\.matches\);/,
  );
  assert.match(settingsSource, /const selected = renderAffectPair\.setFaceMode\(elements\.faceEngine\.value\)/);
  assert.match(settingsSource, /localStorage\.setItem\(DESKTOP_FACE_MODE_KEY, selected\)/);
  assert.match(settingsSource, /if \(latestSnapshot\) renderSnapshot\(latestSnapshot\)/);
});

test("desktop Photoatlas presets use the shared local catalog without changing affect state", () => {
  const html = readFileSync(new URL("../desktop/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../desktop/styles.css", import.meta.url), "utf8");
  const renderSource = readFileSync(new URL("../desktop/src/render.js", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../desktop/src/settings.js", import.meta.url), "utf8");

  assert.match(html, /id="desktop-face-photo-pack-field"[^>]*hidden>Portrait preset/);
  assert.match(html, /id="desktop-face-photo-pack"[^>]*aria-describedby="desktop-face-photo-pack-help"[^>]*disabled/);
  assert.match(html, /synthetic, creator-chosen, and non-exhaustive[\s\S]*gender identity[\s\S]*race, ethnicity, ancestry[\s\S]*validated affect/i);
  assert.match(html, /does not access a camera, recognize faces, diagnose emotion/);
  assert.doesNotMatch(html, />\s*(African|Asian|European|Latin|Middle Eastern|Indigenous|Pacific Islander)/i);
  assert.match(css, /\.face-solution-control\[hidden\][^\{]*\{\s*display:\s*none/);

  assert.match(settingsSource, /from "\.\.\/\.\.\/site\/src\/face-photo-packs\.js"/);
  assert.match(settingsSource, /const DESKTOP_FACE_PHOTO_PACK_KEY = "affect-tracker-desktop\/face-photo-pack-v1"/);
  assert.match(settingsSource, /facePhotoPackCatalog = await loadFacePhotoPackCatalog\(\)/);
  assert.match(settingsSource, /facePhotoPackCatalog\.packs\.map\(createFacePhotoPackOption\)/);
  assert.match(settingsSource, /facePhotoPackPublicLabel\(pack, facePhotoPackCatalog\)/);
  assert.match(settingsSource, /FACE_PHOTO_PACK_PUBLIC_DISCLOSURE/);
  assert.match(settingsSource, /import\.meta\.glob\([\s\S]*site\/assets\/affect-face\/\*\*\/\*\.webp[\s\S]*query: "\?url"/);
  assert.match(settingsSource, /BUNDLED_FACE_PHOTO_ATLAS_URLS\[assetPath\][\s\S]*resolveFacePhotoPackAtlasUrl/);
  assert.match(settingsSource, /elements\.facePhotoPackField\.hidden = !photoSelected/);
  assert.match(settingsSource, /elements\.facePhotoPack\.disabled = !photoSelected/);
  assert.match(settingsSource, /elements\.facePhotoPackHelp\.hidden = !photoSelected/);

  const selectionPath = settingsSource.slice(
    settingsSource.indexOf("function selectFacePhotoPack"),
    settingsSource.indexOf("async function initializeFacePhotoPackControl"),
  );
  assert.match(selectionPath, /facePhotoPackDefinition\(value, facePhotoPackCatalog\)/);
  assert.match(selectionPath, /resolveDesktopFacePhotoPackAtlasUrl\(pack\.id\)/);
  assert.match(selectionPath, /renderAffectPair\.setPhotoAtlasUrl\(atlasUrl\)/);
  assert.match(selectionPath, /localStorage\.setItem\(DESKTOP_FACE_PHOTO_PACK_KEY, pack\.id\)/);
  assert.match(selectionPath, /Only this local atlas will load/);
  assert.doesNotMatch(selectionPath, /currentX|currentY|targetX|targetY|phase/);

  assert.match(renderSource, /photoAtlasUrl: options\.photoAtlasUrl/);
  assert.match(renderSource, /render\.setPhotoAtlasUrl = \(value\) => renderFace\.setPhotoAtlasUrl\(value\)/);
  assert.match(settingsSource, /facePhotoPack\.addEventListener\("change"[\s\S]*selectFacePhotoPack\(elements\.facePhotoPack\.value\)/);
});

test("GitHub Pages keeps the desktop face on the main stage and the phone preview in one shared controller", () => {
  const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../site/src/app.js", import.meta.url), "utf8");
  const protocols = readFileSync(new URL("../site/src/accordion-protocols.js", import.meta.url), "utf8");
  assert.match(html, /id="face-flubber-panel"[^>]*data-module-protocol="face"/);
  assert.match(html, /Synchronized Face \+ Flubber/);
  assert.ok(html.indexOf('id="main-affect-face"') < html.indexOf('id="affect-widget"'));
  assert.match(html, /id="main-affect-face-model"[^>]*data-face-model/);
  assert.match(html, /id="main-affect-face-photo"[^>]*data-face-photo/);
  assert.equal((html.match(/data-face-model/g) ?? []).length, 2);
  assert.equal((html.match(/data-face-photo/g) ?? []).length, 2);
  assert.match(html, /id="main-affect-face-fallback"[^>]*data-face-3d-fallback/);
  assert.match(html, /id="mobile-main-affect-face"/);
  assert.equal((html.match(/id="mobile-direct-controller"/g) ?? []).length, 1);
  assert.match(html, /id="main-face-enabled" type="checkbox" checked/);
  assert.match(html, /id="main-face-engine"/);
  assert.match(html, /id="main-face-center-button"/);
  assert.doesNotMatch(html, /id="web-synchronized-affect-preview"/);
  assert.match(html, /does not access a camera, recognize faces, diagnose emotion/);
  assert.match(protocols, /faceFlubberPanelOpen/);
  assert.match(protocols, /domainModule: "face-engines\.js"/);
  assert.match(appSource, /const affectFrame = Object\.freeze\(/);
  assert.match(appSource, /createFaceEngineRenderer\(elements\.mainAffectFace/);
  assert.match(appSource, /createFaceEngineRenderer\(elements\.mobileMainAffectFace/);
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
