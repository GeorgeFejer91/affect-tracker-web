import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  affectCoordinateToClientPoint,
  clientPointToAffectCoordinate,
  isSmartphoneTouchViewport,
  MOBILE_COORDINATE_GRAB_RADIUS_PX,
  MOBILE_PARTY_ZOOM_MAX,
  MOBILE_PARTY_ZOOM_MIN,
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

test("the phone layout uses safe areas and a split Flubber/direct-coordinate controller", async () => {
  const html = await readSiteFile("index.html");
  const css = await readSiteFile("styles.css");

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="mobile-direct-controller"/);
  assert.match(html, /id="mobile-direct-flubber"/);
  assert.match(html, /id="mobile-direct-flubber"[\s\S]*role="img"[\s\S]*tabindex="0"/);
  assert.match(html, /Drag Flubber to move it on connected screens/);
  assert.match(html, /id="mobile-coordinate-space"[^>]*role="slider"/);
  assert.match(html, /Drag the existing point to a new position\. Touching elsewhere does not move it\./);
  assert.match(css, /@media \(max-width: 600px\), \(max-height: 500px\) and \(pointer: coarse\)/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.mobile-coordinate-space \{[\s\S]*touch-action: none/);
  assert.match(css, /\.mobile-direct-flubber \{[\s\S]*position: absolute[\s\S]*touch-action: none/);
  assert.match(css, /touch-action: none/);
  assert.match(css, /overscroll-behavior: contain/);
});

test("the upper phone Flubber is an independently grabbed normalized viewport control", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /mobileDirectFlubber\.addEventListener\("pointerdown"/);
  assert.match(app, /mobileDirectFlubber\.setPointerCapture\(event\.pointerId\)/);
  assert.match(app, /event\.pointerId !== mobileFlubberPointerId/);
  assert.match(app, /normalizeFlubberViewportPosition\(\{/);
  assert.match(app, /setWidgetFromNormalizedPosition\(normalized\)/);
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

test("the phone coordinate marker must be grabbed before it can move", async () => {
  const bounds = { left: 10, top: 20, width: 300, height: 400 };
  const marker = affectCoordinateToClientPoint({ x: 0.25, y: -0.5, bounds });
  assert.deepEqual(marker, { x: 197.5, y: 320 });
  assert.equal(MOBILE_COORDINATE_GRAB_RADIUS_PX, 30);
  assert.equal(startsOnCoordinateMarker({ clientX: 200, clientY: 318, x: 0.25, y: -0.5, bounds }), true);
  assert.equal(startsOnCoordinateMarker({ clientX: 100, clientY: 100, x: 0.25, y: -0.5, bounds }), false);
  assert.deepEqual(clientPointToAffectCoordinate({ clientX: 310, clientY: 20, bounds }), { x: 1, y: 1 });
  assert.deepEqual(clientPointToAffectCoordinate({ clientX: -100, clientY: 900, bounds }), { x: -1, y: -1 });

  const app = await readSiteFile("src/app.js");
  assert.match(app, /startsOnCoordinateMarker\(\{[\s\S]*Touching elsewhere does not move it\.[\s\S]*return;/);
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
