import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  actionForBinding,
  cloneDefaultSettings,
  normalizePortableSettings,
  opacityToTransparencyPercent,
  portableSettingsJson,
  transparencyPercentToOpacity,
} from "../site/src/portable-settings.js";

test("checked-in GitHub Pages settings use the portable desktop schema", async () => {
  const file = JSON.parse(await readFile(new URL("../site/settings.json", import.meta.url), "utf8"));
  assert.deepEqual(normalizePortableSettings(file), cloneDefaultSettings());
});

test("desktop settings JSON round-trips without visual-setting loss", () => {
  const desktop = cloneDefaultSettings();
  desktop.palette = { up: "#112233", down: "#445566", left: "#778899", right: "#aabbcc" };
  desktop.overlay = { x: 42, y: -7, size: 430, opacity: 0.37, visible: true };
  desktop.response = 12.5;
  const roundTrip = JSON.parse(portableSettingsJson(desktop));
  assert.deepEqual(roundTrip, normalizePortableSettings(desktop));
});

test("transparency control covers fully opaque through fully transparent", () => {
  assert.equal(transparencyPercentToOpacity(0), 1);
  assert.equal(transparencyPercentToOpacity(100), 0);
  assert.equal(opacityToTransparencyPercent(0.37), 63);
});

test("binding lookup is case-insensitive and duplicate assignments are rejected", () => {
  const settings = cloneDefaultSettings();
  assert.equal(actionForBinding(settings.bindings, "KEY:ARROWRIGHT"), "increaseValence");
  settings.bindings.increaseValence = settings.bindings.reset;
  assert.throws(() => normalizePortableSettings(settings), /unique/);
});

test("portable settings require an explicit overlay visibility boolean", () => {
  const settings = cloneDefaultSettings();
  settings.overlay.visible = "false";
  assert.throws(() => normalizePortableSettings(settings), /visibility/);
});
