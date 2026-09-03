import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  affectCoordinateToClientPoint,
  clientPointToAffectCoordinate,
  isSmartphoneTouchViewport,
  layoutMobileAffectPreviews,
  MOBILE_COORDINATE_GRAB_RADIUS_PX,
  MOBILE_PARTY_ZOOM_MAX,
  MOBILE_PARTY_ZOOM_MIN,
  MOBILE_PREVIEW_MIN_SIZE_PX,
  normalizeMobileAffectPreviewPosition,
  normalizeMobilePartyCamera,
  projectMobilePartyPoint,
  SMARTPHONE_LANDSCAPE_MAX_HEIGHT,
  SMARTPHONE_LAYOUT_MAX_WIDTH,
  startsOnCoordinateMarker,
  unprojectMobilePartyPoint,
} from "../site/src/mobile.js";

const readSiteFile = (name) => readFile(new URL(`../site/${name}`, import.meta.url), "utf8");

test("smartphone touch detection requires a narrow touch-capable viewport", () => {
  assert.equal(SMARTPHONE_LAYOUT_MAX_WIDTH, 600);
  assert.equal(SMARTPHONE_LANDSCAPE_MAX_HEIGHT, 500);
  assert.equal(isSmartphoneTouchViewport({ width: 390, height: 844, coarsePointer: true }), true);
  assert.equal(isSmartphoneTouchViewport({ width: 430, height: 932, maxTouchPoints: 5 }), true);
  assert.equal(isSmartphoneTouchViewport({ width: 390, height: 844 }), false);
  assert.equal(isSmartphoneTouchViewport({ width: 844, height: 390, coarsePointer: true }), true);
  assert.equal(isSmartphoneTouchViewport({ width: 768, height: 1_024, coarsePointer: true }), false);
  assert.equal(isSmartphoneTouchViewport({ width: Number.NaN, maxTouchPoints: 5 }), false);
});

test("the active responsive mode is recomputed on resize and orientation changes", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /let smartphoneLayoutActive = shouldUseSmartphoneLayout\(\)/);
  assert.match(app, /function updateSmartphoneLayout\(\)[\s\S]*classList\.toggle\("is-smartphone-layout"/);
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{\s*updateSmartphoneLayout\(\)/);
  assert.match(app, /screen\.orientation\?\.addEventListener\?\.\("change", \(\) => \{\s*updateSmartphoneLayout\(\)/);
});

test("the phone 21 by 21 transition advances canonical affect state before the shared frame", async () => {
  const app = await readSiteFile("src/app.js");
  const matrixBranch = app.slice(
    app.indexOf("} else if (matrixTransitionSelected()) {", app.indexOf("function animationFrame")),
    app.indexOf("const affectFrame = Object.freeze", app.indexOf("function animationFrame")),
  );

  assert.match(app, /from "\.\/affect-matrix\.js\?v=matrix21-1"/);
  assert.match(app, /function startMatrixTraversalToCoordinates\(x, y\)/);
  assert.match(app, /chooseAffectCoordinate\(coordinate\.x, coordinate\.y\)/);
  assert.match(matrixBranch, /advanceAffectMatrixTraversal\(affectMatrixTraversal, deltaSeconds\)/);
  assert.match(matrixBranch, /applyMatrixTraversalCoordinates\(\)/);
  assert.match(app, /renderSynchronizedAffectPreview\(affectFrame, rendered\)/);
  assert.match(app, /root\.dataset\.affectMatrixColumn/);
  assert.match(app, /Current cell \$\{affectMatrixTraversal\.currentCell\.column \+ 1\}[\s\S]*steps remaining/);
  assert.match(app, /face and Flubber will step there together/);
  const savedPreferences = app.slice(
    app.indexOf("function savePreferences"),
    app.indexOf("function settingsFromState"),
  );
  assert.doesNotMatch(savedPreferences, /affectTransitionMode|matrixStatesPerSecond/);
});

test("the phone layout uses safe areas and a split Flubber/direct-coordinate controller", async () => {
  const html = await readSiteFile("index.html");
  const css = await readSiteFile("styles.css");

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="mobile-direct-controller"/);
  assert.equal(html.match(/id="mobile-direct-controller"/g)?.length, 1);
  assert.match(html, /id="mobile-controller-home-anchor"[\s\S]*id="mobile-direct-controller"/);
  assert.match(html, /id="mobile-face-controller-anchor"[\s\S]*id="mobile-close-face-options"/);
  assert.match(html, /id="mobile-direct-flubber"/);
  assert.match(html, /id="mobile-direct-flubber"[\s\S]*role="img"[\s\S]*tabindex="0"/);
  assert.match(html, /Drag Flubber to move it on connected screens/);
  assert.match(html, /id="mobile-coordinate-space"[^>]*role="slider"/);
  assert.match(html, /id="mobile-coordinate-target"/);
  assert.match(html, /Drag the existing point to a new position\. Touching elsewhere does not move it\./);
  assert.match(html, /<option value="matrix-anchors">21 × 21 matrix-anchor 3D<\/option>/);
  assert.match(html, /<option value="matrix">21 × 21 step matrix<\/option>/);
  assert.match(html, /id="main-matrix-rate"[^>]*min="0\.5"[^>]*max="20"/);
  assert.match(html, /id="main-matrix-stop"/);
  assert.match(html, /id="main-matrix-neutral"/);
  assert.match(css, /@media \(max-width: 600px\), \(max-height: 500px\) and \(pointer: coarse\)/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /grid-template-columns: repeat\(7, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.panel-toggle \{[\s\S]*min-width: 2\.75rem;[\s\S]*min-height: 3rem;/);
  assert.match(css, /\.mobile-coordinate-space \{[\s\S]*touch-action: none/);
  assert.match(css, /\.mobile-coordinate-space\.is-matrix-transition::before[\s\S]*calc\(5% - 0\.5px\)/);
  assert.match(css, /\.mobile-direct-flubber \{[\s\S]*position: absolute[\s\S]*touch-action: none/);
  assert.match(css, /touch-action: none/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(css, /@media \(max-height: 500px\) and \(min-aspect-ratio: 4 \/ 3\)/);
  assert.match(css, /@media \(min-width: 601px\) and \(max-height: 500px\)[\s\S]*body\.is-smartphone-layout \.panel-stack \.panel-content/);
  assert.match(css, /body\.is-smartphone-layout \.mobile-flubber-pane \{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(css, /\.face-engine-field select,[\s\S]*#main-face-center-button \{[\s\S]*min-height: 2\.75rem/);
  assert.match(css, /#face-flubber-panel\.has-mobile-direct-controller:not\(\.is-mobile-settings-open\)[\s\S]*\.face-flubber-module/);
  assert.match(css, /#face-flubber-panel\.has-mobile-direct-controller\.is-mobile-settings-open #mobile-close-face-options/);
});

test("phone face and Flubber previews stay square, ordered, and contained", () => {
  const supportedPreviewAreas = [
    { name: "360 by 800 portrait", width: 318, height: 270 },
    { name: "390 by 844 portrait", width: 349, height: 302 },
    { name: "844 by 390 landscape", width: 812, height: 104 },
    { name: "932 by 430 landscape", width: 900, height: 124 },
  ];

  for (const area of supportedPreviewAreas) {
    for (const viewportX of [0, 0.5, 1]) {
      for (const viewportY of [0, 0.5, 1]) {
        const layout = layoutMobileAffectPreviews({
          width: area.width,
          height: area.height,
          viewportX,
          viewportY,
          faceVisible: true,
        });
        assert.ok(layout, area.name);
        assert.ok(layout.face.size >= MOBILE_PREVIEW_MIN_SIZE_PX, area.name);
        assert.equal(layout.face.size, layout.flubber.size, area.name);
        assert.equal(layout.face.y, layout.flubber.y, area.name);
        assert.ok(layout.face.x < layout.flubber.x, area.name);
        assert.ok(
          layout.face.x + layout.face.size / 2 + layout.gap
            <= layout.flubber.x - layout.flubber.size / 2 + 1e-9,
          area.name,
        );
        for (const preview of [layout.face, layout.flubber]) {
          assert.ok(preview.x - preview.size / 2 >= -1e-9, area.name);
          assert.ok(preview.x + preview.size / 2 <= area.width + 1e-9, area.name);
          assert.ok(preview.y - preview.size / 2 >= -1e-9, area.name);
          assert.ok(preview.y + preview.size / 2 <= area.height + 1e-9, area.name);
        }
      }
    }
  }

  const left = layoutMobileAffectPreviews({ width: 320, height: 200, viewportX: 0, faceVisible: false });
  const right = layoutMobileAffectPreviews({ width: 320, height: 200, viewportX: 1, faceVisible: false });
  assert.equal(left.flubber.x - left.flubber.size / 2, 0);
  assert.equal(right.flubber.x + right.flubber.size / 2, 320);
  assert.equal(layoutMobileAffectPreviews({ width: 0, height: 200 }), undefined);
});

test("phone preview layout translates the pair proportionally and round-trips its normalized position", () => {
  const previewAreas = [
    { width: 318, height: 270 },
    { width: 349, height: 302 },
    { width: 812, height: 104 },
    { width: 900, height: 124 },
  ];
  const positions = [0, 0.25, 0.5, 0.75, 1];

  for (const area of previewAreas) {
    for (const faceVisible of [false, true]) {
      let previousX = -Infinity;
      for (const viewportX of positions) {
        for (const viewportY of positions) {
          const layout = layoutMobileAffectPreviews({
            ...area,
            viewportX,
            viewportY,
            faceVisible,
          });
          const normalized = normalizeMobileAffectPreviewPosition({
            ...area,
            flubberX: layout.flubber.x,
            flubberY: layout.flubber.y,
            faceVisible,
          });
          assert.ok(Math.abs(normalized.viewportX - viewportX) < 1e-12);
          assert.ok(Math.abs(normalized.viewportY - viewportY) < 1e-12);
          if (viewportY === 0) {
            assert.ok(layout.flubber.x >= previousX);
            previousX = layout.flubber.x;
          }
        }
      }
    }

    const pairedLeft = layoutMobileAffectPreviews({ ...area, viewportX: 0, faceVisible: true });
    const pairedRight = layoutMobileAffectPreviews({ ...area, viewportX: 1, faceVisible: true });
    assert.ok(Math.abs(pairedLeft.face.x - pairedLeft.face.size / 2) < 1e-9);
    assert.ok(Math.abs(pairedRight.flubber.x + pairedRight.flubber.size / 2 - area.width) < 1e-9);
    assert.ok(Math.abs(
      (pairedRight.face.x - pairedLeft.face.x)
        - (pairedRight.flubber.x - pairedLeft.flubber.x),
    ) < 1e-9);
  }

  assert.deepEqual(normalizeMobileAffectPreviewPosition({
    width: 320,
    height: 200,
    flubberX: -1_000,
    flubberY: 1_000,
  }), { viewportX: 0, viewportY: 1 });
  assert.deepEqual(normalizeMobileAffectPreviewPosition({
    width: 68,
    height: 30,
    flubberX: 1_000,
    flubberY: -1_000,
    faceVisible: true,
    fallbackViewportX: 0.25,
    fallbackViewportY: 0.75,
  }), { viewportX: 0.25, viewportY: 0.75 });
});

test("the phone Face tab hosts the one live controller before showing options", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /function placeMobileDirectController\(\)[\s\S]*smartphoneLayoutActive && state\.faceFlubberPanelOpen/);
  assert.match(app, /targetAnchor\.after\(elements\.mobileDirectController\)/);
  assert.match(app, /faceHostsController \? "Face options" : "Settings"/);
  assert.match(app, /mobileDirectController\.closest\("\.control-panel"\)/);
  assert.match(app, /mobileCloseFaceOptions\.addEventListener\("click"[\s\S]*remove\("is-mobile-settings-open"\)/);
  assert.doesNotMatch(app, /mobileDirectController\.cloneNode|cloneNode\([^)]*mobileDirectController/);
});

test("the upper phone Flubber is an independently grabbed normalized viewport control", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /mobileControllerPanel[\s\S]*is-collapsed[\s\S]*is-mobile-settings-open[\s\S]*root\.hidden \|\| mobilePreviewCovered/);
  assert.match(app, /mobileDirectFlubber\.addEventListener\("pointerdown"/);
  assert.match(app, /mobileDirectFlubber\.setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /event\.pointerId !== mobileFlubberPointerId/);
  assert.match(app, /normalizeFlubberViewportPosition\(\{/);
  assert.match(app, /normalizeMobileAffectPreviewPosition\(\{/);
  assert.match(app, /setWidgetFromNormalizedPosition\(normalized\)/);
  assert.match(app, /mainAffectFaceShouldShow\(\)[\s\S]*!smartphoneLayoutActive[\s\S]*!sharedPartyParticipant/);
  assert.match(app, /mobileDirectFlubber\.addEventListener\("keydown"/);
  assert.match(app, /offerState\([\s\S]*viewportPosition\.viewportX,[\s\S]*viewportPosition\.viewportY/);
});

test("a first smartphone visit opens the direct Affect controller without enabling tracking", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /mobileTouchIntroSeen: parsed\.mobileTouchIntroSeen === true/);
  assert.match(app, /isSmartphoneTouchViewport\(\{/);
  assert.match(app, /state\.panelOpen = true;/);
  assert.match(app, /state\.touchPlaygroundPanelOpen = false;/);
  assert.match(app, /state\.mobileTouchIntroSeen = true;/);
  assert.doesNotMatch(app, /state\.inputSource = "touch-trace";[\s\S]{0,120}state\.mobileTouchIntroSeen = true/);
});

test("smooth phone input requires marker grab while matrix input accepts any target cell", async () => {
  const bounds = { left: 10, top: 20, width: 300, height: 400 };
  const marker = affectCoordinateToClientPoint({ x: 0.25, y: -0.5, bounds });
  assert.deepEqual(marker, { x: 197.5, y: 320 });
  assert.equal(MOBILE_COORDINATE_GRAB_RADIUS_PX, 30);
  assert.equal(startsOnCoordinateMarker({ clientX: 200, clientY: 318, x: 0.25, y: -0.5, bounds }), true);
  assert.equal(startsOnCoordinateMarker({ clientX: 100, clientY: 100, x: 0.25, y: -0.5, bounds }), false);
  assert.deepEqual(clientPointToAffectCoordinate({ clientX: 310, clientY: 20, bounds }), { x: 1, y: 1 });
  assert.deepEqual(clientPointToAffectCoordinate({ clientX: -100, clientY: 900, bounds }), { x: -1, y: -1 });

  const app = await readSiteFile("src/app.js");
  assert.match(app, /!matrixTransitionSelected\(\) && !startsOnCoordinateMarker\(\{[\s\S]*Touching elsewhere does not move it\.[\s\S]*return;/);
  assert.match(app, /mobileCoordinateSpace\.setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /event\.pointerId !== mobileCoordinatePointerId/);
});

test("phone pointer capture uses primary Pointer Events with a Safari-compatible fallback", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /event\.isPrimary === false/);
  assert.match(app, /getCoalescedEvents\?\.\(\)/);
  assert.match(app, /coalesced\?\.length \? coalesced : \[event\]/);
  assert.match(app, /setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /pointermove"[\s\S]*capture: true, passive: false/);
  assert.match(app, /event\.pointerType !== "mouse" && event\.cancelable/);
});

test("smartphone party perspective zooms out, pans, and round-trips scene coordinates", async () => {
  assert.equal(MOBILE_PARTY_ZOOM_MIN, 0.5);
  assert.equal(MOBILE_PARTY_ZOOM_MAX, 1.6);
  const camera = normalizeMobilePartyCamera({ zoom: 0.5, panX: 0.1, panY: -0.08 });
  const projected = projectMobilePartyPoint({ viewportX: 0.9, viewportY: 0.2, camera });
  assert.ok(Math.abs(projected.viewportX - 0.8) < 1e-12);
  assert.ok(Math.abs(projected.viewportY - 0.27) < 1e-12);
  const restored = unprojectMobilePartyPoint({ ...projected, camera });
  assert.ok(Math.abs(restored.viewportX - 0.9) < 1e-12);
  assert.ok(Math.abs(restored.viewportY - 0.2) < 1e-12);

  const html = await readSiteFile("index.html");
  const css = await readSiteFile("styles.css");
  const app = await readSiteFile("src/app.js");
  assert.match(html, /id="party-camera-zoom"[^>]*min="0\.5"[^>]*max="1\.6"/);
  assert.match(html, /Pinch to zoom and swipe empty space to pan/);
  assert.match(css, /body\.is-smartphone-layout\.is-party-scene-active \.party-camera-surface \{ pointer-events: auto/);
  assert.match(app, /partyCameraPointerDistance\(\)[\s\S]*MOBILE_PARTY_ZOOM_MIN[\s\S]*MOBILE_PARTY_ZOOM_MAX/);
  assert.match(app, /partyCameraSurface\.addEventListener\("pointerdown"/);
  assert.match(app, /partyCameraReset\.addEventListener\("click"/);
  assert.match(app, /partyDisplayPosition = sharedPartyParticipant/);
  assert.match(app, /incomingPartyWidgetDragAnchor\.stateX \+ point\.x/);
});
