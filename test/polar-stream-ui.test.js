import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const readSiteFile = (name) => readFile(new URL(`../site/${name}`, import.meta.url), "utf8");

test("the fourth Polar Stream widget is explicit, branded, and opt-in", async () => {
  const html = await readSiteFile("index.html");
  const css = await readSiteFile("styles.css");
  const settingsIndex = html.indexOf('id="control-panel"');
  const experimentIndex = html.indexOf('id="experiment-panel"');
  const touchIndex = html.indexOf('id="touch-playground-panel"');
  const polarIndex = html.indexOf('id="polar-stream-panel"');

  assert.ok(settingsIndex >= 0);
  assert.ok(experimentIndex > settingsIndex);
  assert.ok(touchIndex > experimentIndex);
  assert.ok(polarIndex > touchIndex);
  assert.match(html, /polar-stream-logo\.svg/);
  assert.match(html, /aria-label="Polar Stream — Experimental"/);
  assert.match(html, /id="polar-connect-button"[^>]*>Connect</);
  assert.match(html, /id="polar-connect-module"|class="polar-connect-module"[\s\S]{0,900}id="polar-ecg-port"[\s\S]{0,200}hidden/);
  assert.ok(html.indexOf('id="polar-ecg-port"') < html.indexOf("Browser connection details"));
  assert.match(html, /id="polar-connection-diagnostics"/);
  for (const field of ["api", "adapter", "activation", "chooser", "stage", "gatt", "pmd", "error"]) {
    assert.match(html, new RegExp(`data-polar-diagnostic="${field}"`));
  }
  assert.match(html, /id="polar-stream-panel"[\s\S]*Signal modules/);
  assert.match(html, /data-polar-axis="valence"/);
  assert.match(html, /data-polar-axis="arousal"/);
  assert.match(html, /Raw ECG[^<]*latest five seconds|waveform keeps only the latest five seconds/i);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
});

test("Polar assignments stay browser-local and defer to touch tracking", async () => {
  const app = await readSiteFile("src/app.js");
  const webxr = await readSiteFile("src/webxr-study.js");
  const portable = await readSiteFile("src/portable-settings.js");

  assert.match(app, /from "\.\/polar-stream\.js\?v=remote-12"/);
  assert.match(webxr, /from "\.\/polar-stream\.js\?v=remote-12"/);
  assert.match(app, /polarMappings: normalizePolarMappings\(parsed\.polarMappings\)/);
  assert.match(app, /polarMappings: state\.polarMappings/);
  assert.match(app, /function polarAxisDriven[\s\S]{0,180}!touchTrackingActive\(\)[\s\S]{0,80}state\.polarConnected/);
  assert.match(app, /touchTrackingActive\(\)[\s\S]{0,80}Paused by Touch\/Trackpad/);
  assert.match(app, /polarSession\.connect\(handlePolarEvent\)/);
  assert.match(app, /event\.kind === "diagnostic"[\s\S]{0,100}renderPolarDiagnostics/);
  assert.match(app, /setup \$\{snapshot\.streamSetupAttempt\}\/\$\{snapshot\.streamSetupAttemptsTotal/);
  assert.match(app, /function clearPolarLiveReadout[\s\S]{0,300}state\.polarMetrics = \{\}/);
  assert.match(app, /polarConnectButton[\s\S]{0,300}clearPolarLiveReadout\(\)/);
  assert.match(app, /polarEcgWindow\.length > 650/);
  assert.match(app, /polarEcgPort\.hidden = false/);
  assert.match(app, /data\.polarQuickAxis|dataset\.polarQuickAxis/);
  assert.match(app, /X · Valence/);
  assert.match(app, /Y · Arousal/);
  assert.doesNotMatch(portable, /polarMappings|polarStream/i);
});

test("all four top-level panels collapse their alternatives", async () => {
  const app = await readSiteFile("src/app.js");
  const protocols = await readSiteFile("src/accordion-protocols.js");

  for (const id of ["settings", "experiment", "touch", "polar"]) {
    assert.match(app, new RegExp(`toggleTopLevelProtocol\\("${id}"\\)`));
    assert.match(protocols, new RegExp(`\\b${id}: Object\\.freeze`));
  }
  assert.match(protocols, /ACCORDION_PROTOCOL_IDS\.map/);
  assert.match(protocols, /protocolId === openProtocolId/);
  assert.match(app, /Object\.assign\(state, toggleAccordionProtocol\(state, protocolId\)\);[\s\S]{0,120}updateInputSourceControls\(\);[\s\S]{0,80}applyPolarMappings\(\);/);
});

test("CSV logs mapping context without introducing raw ECG fields", async () => {
  const logger = await readSiteFile("src/logger.js");

  assert.match(logger, /"polar_connected"/);
  assert.match(logger, /"polar_drive_active"/);
  assert.match(logger, /"polar_valence_metric"/);
  assert.match(logger, /"polar_arousal_normalized"/);
  assert.doesNotMatch(logger, /raw_ecg|ecg_samples|rr_series/);
});
