import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readSiteFile = (name) => readFile(new URL(`../site/${name}`, import.meta.url), "utf8");

test("web settings are split into compact task-focused sections", async () => {
  const html = await readSiteFile("index.html");

  for (const label of [
    "Input &amp; shortcuts",
    "Appearance &amp; cursor",
    "2D grid &amp; colors",
    "Data &amp; settings files",
    "Advanced &amp; integrations",
  ]) {
    assert.match(html, new RegExp(`<summary>${label}</summary>`));
  }
  assert.match(html, /Data &amp; settings files[\s\S]*id="settings-import-button"[\s\S]*id="settings-export-button"/);
  assert.match(html, /Appearance &amp; cursor[\s\S]*id="settings-hide-cursor-toggle"[^>]*data-touch-hide-cursor/);
});

test("the visible direction pad launches input capture instead of moving affect", async () => {
  const html = await readSiteFile("index.html");
  const app = await readSiteFile("src/app.js");

  assert.match(html, /data-direction="up" data-binding="increaseArousal"/);
  assert.match(html, /data-direction="down" data-binding="decreaseArousal"/);
  assert.match(html, /data-direction="left" data-binding="decreaseValence"/);
  assert.match(html, /data-direction="right" data-binding="increaseValence"/);
  assert.match(html, /id="binding-capture-dialog"/);
  assert.match(html, /Press a keyboard key, click a mouse button, or move the scroll wheel/);
  assert.match(app, /button\.addEventListener\("click", \(\) => beginBindingCapture\(button\.dataset\.binding, "bindings", button\)\)/);
  assert.match(app, /bindingUpdatesForCapture\(action, value\)/);
  assert.match(app, /bindingCaptureDialog\.showModal\(\)/);
  assert.doesNotMatch(app, /button\.addEventListener\("pointerdown", handleDirectionPointerDown\)/);
});

test("clicking or dragging the settings grid applies the exact displayed state", async () => {
  const html = await readSiteFile("index.html");
  const app = await readSiteFile("src/app.js");

  assert.match(html, /Click, drag, or use the arrow keys to move the miniature Flubber to an exact valence–arousal state/);
  assert.match(html, /Opening Settings pauses armed Touch\/Trackpad control/);
  assert.match(html, /returns both Polar axes to Manual/);
  assert.match(app, /function claimFeatureSpaceControl\(\)[\s\S]*defaultPolarMappings\(\)\[axis\][\s\S]*applyPolarMappings\(\)/);
  assert.match(app, /function chooseFeatureCoordinate\(event\)[\s\S]*state\.currentX = state\.targetX;[\s\S]*state\.currentY = state\.targetY;/);
  assert.match(app, /featureSpace\.addEventListener\("pointerdown"[\s\S]*claimFeatureSpaceControl\(\)[\s\S]*chooseFeatureCoordinate\(event\)/);
  assert.match(app, /featureSpace\.addEventListener\("pointermove"[\s\S]*chooseFeatureCoordinate\(event\)/);
  assert.doesNotMatch(app, /featureSpace\.addEventListener\("pointerdown", \(event\) => \{\s*if \(state\.inputSource !== "manual"\) return;/);
});
