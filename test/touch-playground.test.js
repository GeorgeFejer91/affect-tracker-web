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
  assert.match(html, /aria-label="Touch\/Trackpad Playground — Experimental"/);
  assert.match(html, /class="experimental-badge" aria-hidden="true"/);
  assert.match(html, /id="touch-tracking-toggle"[^>]*role="switch"/);
  assert.match(html, /Enable touch\/trackpad tracking/);
  assert.match(html, /id="touch-hide-cursor-toggle"/);
  assert.match(html, /Hide mouse cursor while tracking/);
  assert.match(html, /id="touch-playground-canvas"/);
  assert.match(html, /id="touch-preview-flubber"/);
  assert.match(html, /id="touch-preview-base-path"/);
  assert.match(html, /Page-wide mouse movement overview and touch or pen swipe surface/);
  assert.match(html, /class="touch-playground-options"/);
  assert.match(html, /id="touch-affect-space"/);
  assert.match(html, /id="touch-affect-point"/);
  assert.match(html, /id="touch-affect-valence-output"/);
  assert.match(html, /Fast[\s\S]*Slow[\s\S]*Angular[\s\S]*Circular/);
  assert.match(html, /Angular \/ random[\s\S]*Circular[\s\S]*Page-wide miniature · aspect-preserving fit/);
  assert.match(html, /normalized, uniformly fitted overview[\s\S]*never affects classification/i);
  assert.match(html, /name="touch-feedback-mode" value="gated" checked/);
  assert.match(html, /Gated move-and-hold/);
  assert.match(html, /cold-start anchors are 0\.15 viewport diagonals\/s/);
  assert.match(html, /0\.44 D\/s for the midpoint\/hold command/);
  assert.match(html, /control commands—not claims that a speed diagnoses calmness/);
  assert.match(html, /name="touch-feedback-mode" value="continuous"/);
  assert.match(html, /id="touch-gate-status"/);
  assert.match(html, /short touch\/pen strokes beginning within 900 ms share speed evidence/);
  assert.doesNotMatch(html, /name="input-source"/);
});

test("gated move-and-hold is a local preference with explicit live and commit logging", async () => {
  const app = await readSiteFile("src/app.js");
  const logger = await readSiteFile("src/logger.js");

  assert.match(app, /touchFeedbackMode: parsed\.touchFeedbackMode === TOUCH_FEEDBACK_CONTINUOUS/);
  assert.match(app, /touchFeedbackMode: state\.touchFeedbackMode/);
  assert.match(app, /"feedback-mode-change"/);
  assert.match(app, /"gate-commit"/);
  assert.match(app, /state\.currentX = state\.targetX/);
  assert.match(logger, /"touch_feedback_mode"/);
  assert.match(logger, /"gate_commit_sequence"/);
  assert.match(logger, /"gate_delta_x"/);
  assert.match(logger, /"gate_delta_y"/);
  assert.match(logger, /"gate_live_delta_y"/);
  assert.match(logger, /"speed_calibration_samples"/);
  assert.match(logger, /"shape_calibration_samples"/);
});

test("the playground hide-cursor preference is local, reversible, and logged", async () => {
  const app = await readSiteFile("src/app.js");
  const css = await readSiteFile("styles.css");
  const logger = await readSiteFile("src/logger.js");

  assert.match(app, /touchHideCursor: parsed\.touchHideCursor === true/);
  assert.match(app, /touchHideCursor: state\.touchHideCursor/);
  assert.match(app, /classList\.toggle\("is-touch-cursor-hidden", active && state\.touchHideCursor\)/);
  assert.match(app, /"cursor-visibility"/);
  assert.match(css, /is-touch-cursor-hidden \.touch-playground-surface \{ cursor: none !important; \}/);
  assert.match(css, /is-touch-cursor-hidden \.panel-stack \{ cursor: default; \}/);
  assert.match(logger, /"cursor_hidden"/);
});

test("the settings color map is a draggable live Flubber preview", async () => {
  const html = await readSiteFile("index.html");
  const app = await readSiteFile("src/app.js");

  assert.match(html, /id="web-feature-flubber-path"/);
  assert.match(html, /id="web-feature-valence-output"/);
  assert.match(html, /id="web-feature-arousal-output"/);
  assert.match(html, /Click, drag, or use the arrow keys to move the miniature Flubber/);
  assert.match(app, /featureFlubberPath\.setAttribute\("d", rendered\.path\)/);
  assert.match(app, /touchPreviewBasePath\.setAttribute\("d", rendered\.path\)/);
  assert.match(app, /featureSpace\.addEventListener\("pointermove"/);
});

test("the playground remains a private practice surface with explicit experiment logging limits", async () => {
  const html = await readSiteFile("index.html");
  const app = await readSiteFile("src/app.js");

  assert.match(html, /Practice movement is not stored/);
  assert.match(html, /Raw pointer coordinates are recorded only while an experiment is actively playing/);
  assert.match(app, /if \(event\.pointerType === "mouse"\) return phase === "move"/);
  assert.match(app, /closest\?\.\("#touch-playground-surface"\)\) return false/);
  assert.match(app, /!experiment\.writer \|\| experiment\.phase !== "running" \|\| !experiment\.playbackActive/);
});

test("opening any top-level accordion uses the shared exclusive protocol", async () => {
  const app = await readSiteFile("src/app.js");
  const protocols = await readSiteFile("src/accordion-protocols.js");

  assert.match(app, /Object\.assign\(state, toggleAccordionProtocol\(state, protocolId\)\)/);
  assert.match(protocols, /Object\.fromEntries\(ACCORDION_PROTOCOL_IDS\.map/);
  assert.match(protocols, /protocolId === openProtocolId/);
});
