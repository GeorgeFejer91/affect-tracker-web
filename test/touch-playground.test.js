import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readSiteFile = (name) => readFile(new URL(`../site/${name}`, import.meta.url), "utf8");

test("the online interface exposes a third experimental touch playground", async () => {
  const html = await readSiteFile("index.html");
  const settingsIndex = html.indexOf('id="control-panel"');
  const experimentIndex = html.indexOf('id="experiment-panel"');
  const playgroundIndex = html.indexOf('id="touch-playground-panel"');

  assert.ok(settingsIndex >= 0);
  assert.ok(experimentIndex > settingsIndex);
  assert.ok(playgroundIndex > experimentIndex);
  assert.match(html, /Touch\/Trackpad Playground/);
  assert.match(html, /class="experimental-badge">Experimental</);
  assert.match(html, /id="touch-tracking-toggle"[^>]*role="switch"/);
  assert.match(html, /Enable touch\/trackpad tracking/);
  assert.match(html, /id="touch-playground-canvas"/);
  assert.doesNotMatch(html, /name="input-source"/);
});

test("the playground remains a private practice surface with explicit experiment logging limits", async () => {
  const html = await readSiteFile("index.html");
  const app = await readSiteFile("src/app.js");

  assert.match(html, /Practice movement is not stored/);
  assert.match(html, /Raw pointer coordinates are recorded only while an experiment is actively playing/);
  assert.match(app, /closest\?\.\("#touch-playground-surface"\)\) return false/);
  assert.match(app, /!experiment\.writer \|\| experiment\.phase !== "running" \|\| !experiment\.playbackActive/);
});

test("opening any top-level accordion collapses both alternatives", async () => {
  const app = await readSiteFile("src/app.js");

  assert.match(app, /if \(state\.panelOpen\) \{[\s\S]*state\.experimentPanelOpen = false;[\s\S]*state\.touchPlaygroundPanelOpen = false;/);
  assert.match(app, /if \(state\.experimentPanelOpen\) \{[\s\S]*state\.panelOpen = false;[\s\S]*state\.touchPlaygroundPanelOpen = false;/);
  assert.match(app, /if \(state\.touchPlaygroundPanelOpen\) \{[\s\S]*state\.panelOpen = false;[\s\S]*state\.experimentPanelOpen = false;/);
});
