import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isSmartphoneTouchViewport,
  SMARTPHONE_LANDSCAPE_MAX_HEIGHT,
  SMARTPHONE_LAYOUT_MAX_WIDTH,
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

test("the phone layout uses safe areas, dynamic height, and a large non-scrolling swipe surface", async () => {
  const html = await readSiteFile("index.html");
  const css = await readSiteFile("styles.css");

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /class="panel-label-mobile">Touch Lab/);
  assert.match(html, /id="touch-preview-flubber"/);
  assert.match(html, /id="touch-playground-surface"[^>]*Draw or swipe here/);
  assert.match(css, /@media \(max-width: 600px\), \(max-height: 500px\) and \(pointer: coarse\)/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /height: clamp\(12rem, 32dvh, 18rem\)/);
  assert.match(css, /touch-action: none/);
  assert.match(css, /overscroll-behavior: contain/);
});

test("a first smartphone visit opens the touch lab without silently enabling tracking", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /mobileTouchIntroSeen: parsed\.mobileTouchIntroSeen === true/);
  assert.match(app, /isSmartphoneTouchViewport\(\{/);
  assert.match(app, /state\.touchPlaygroundPanelOpen = true;/);
  assert.match(app, /state\.mobileTouchIntroSeen = true;/);
  assert.doesNotMatch(app, /state\.inputSource = "touch-trace";[\s\S]{0,120}state\.mobileTouchIntroSeen = true/);
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
