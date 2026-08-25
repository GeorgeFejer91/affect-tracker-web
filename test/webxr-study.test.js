import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import {
  advanceWebXrAffect,
  advanceWebXrAffectWithPolar,
  applyWebXrRemoteCoordinates,
  controllerAxes,
  controllerFacingModelMatrix,
  createEquirectSphereVertices,
  matrixWithoutTranslation,
  modelMatrix,
  multiplyMatrices,
  normalizeStickAxis,
  normalizeWebhookUrl,
  readQuestControllerState,
  WEBXR_CSV_COLUMNS,
  webXrCsv,
} from "../site/src/webxr-study-core.js";
import {
  stimulusDurationSeconds,
  WEBXR_STIMULI,
  webXrStimulusById,
} from "../site/src/webxr-stimuli.js";

const page = readFileSync(new URL("../site/webxr.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../site/webxr.css", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../site/src/webxr-study.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const launcher = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerLauncherActivity.kt",
    import.meta.url,
  ),
  "utf8",
);

test("WebXR thumbstick normalization applies a bounded radial-free dead zone", () => {
  assert.equal(normalizeStickAxis(0.1), 0);
  assert.equal(normalizeStickAxis(-1), -1);
  assert.equal(normalizeStickAxis(1), 1);
  assert.ok(normalizeStickAxis(0.5) > 0 && normalizeStickAxis(0.5) < 0.5);
  assert.deepEqual(controllerAxes({ axes: [0.9, 0.9, 0.5, -0.75] }), {
    x: normalizeStickAxis(0.5),
    y: normalizeStickAxis(0.75),
  });
});

test("WebXR controller state uses the right stick and left X/Y buttons", () => {
  const state = readQuestControllerState([
    { handedness: "left", gamepad: { axes: [0, 0, 0, 0], buttons: [{}, {}, {}, {}, { pressed: true }, { pressed: false }] } },
    { handedness: "right", gamepad: { axes: [0, 0, 0.8, -0.6], buttons: [] } },
  ]);
  assert.equal(state.hand, "right");
  assert.ok(state.x > 0.7);
  assert.ok(state.y > 0.5);
  assert.equal(state.reset, true);
  assert.equal(state.pause, false);
});

test("WebXR affect state advances, smooths, and clamps in the canonical range", () => {
  const next = advanceWebXrAffect(
    { currentX: 0, currentY: 0, targetX: 0.99, targetY: -0.99 },
    { x: 1, y: -1 },
    0.05,
  );
  assert.equal(next.targetX, 1);
  assert.equal(next.targetY, -1);
  assert.ok(next.currentX > 0 && next.currentX < 1);
  assert.ok(next.currentY < 0 && next.currentY > -1);
});

test("WebXR Polar targets override only their assigned Flubber axis", () => {
  const next = advanceWebXrAffectWithPolar(
    { currentX: 0, currentY: 0, targetX: 0, targetY: 0 },
    { x: -1, y: 1 },
    0.05,
    { x: 0.75 },
    { speed: 1, response: 100 },
  );
  assert.equal(next.targetX, 0.75);
  assert.equal(next.targetY, 0.05);
  assert.ok(next.currentX > next.currentY);

  const clamped = advanceWebXrAffectWithPolar(
    { currentX: 0, currentY: 0, targetX: 0, targetY: 0 },
    { x: 1, y: -1 },
    0.05,
    { x: 8, y: -8 },
  );
  assert.equal(clamped.targetX, 1);
  assert.equal(clamped.targetY, -1);
});

test("WebXR remote coordinates own both axes, bypass smoothing, hold while stale, and release only when disabled", () => {
  const local = { currentX: -0.8, currentY: 0.8, targetX: -0.7, targetY: 0.7 };
  const latest = { sequence: 12, currentX: 0.375, currentY: -0.625 };
  const expected = { currentX: 0.375, currentY: -0.625, targetX: 0.375, targetY: -0.625 };
  assert.deepEqual(applyWebXrRemoteCoordinates(local, { enabled: true, phase: "live", latest }), expected);
  assert.deepEqual(applyWebXrRemoteCoordinates(local, { enabled: true, phase: "stale", latest }), expected);
  assert.equal(applyWebXrRemoteCoordinates(local, { enabled: false, phase: "idle", latest }), undefined);
});

test("WebXR webhook is optional and HTTPS-only", () => {
  assert.equal(normalizeWebhookUrl(""), "");
  assert.equal(normalizeWebhookUrl("https://example.org/hook#private"), "https://example.org/hook");
  assert.throws(() => normalizeWebhookUrl("http://example.org/hook"), /HTTPS/);
  assert.throws(() => normalizeWebhookUrl("not a url"), /complete HTTPS/);
});

test("WebXR CSV has fixed reconstructable columns and escapes details", () => {
  const csv = webXrCsv([{ session_id: "one", record_type: "event", detail: "comma, quote \" and newline\n" }]);
  assert.equal(csv.split("\r\n")[0], WEBXR_CSV_COLUMNS.join(","));
  assert.match(csv, /"comma, quote "" and newline\n"/);
  assert.ok(csv.endsWith("\r\n"));
  for (const column of ["polar_connected", "polar_valence_metric", "polar_valence_normalized", "polar_arousal_metric", "polar_arousal_normalized"]) {
    assert.ok(WEBXR_CSV_COLUMNS.includes(column));
  }
  for (const column of ["remote_enabled", "remote_source", "remote_signal_state", "remote_sequence", "remote_packet_age_ms"]) {
    assert.ok(WEBXR_CSV_COLUMNS.includes(column));
  }
  assert.doesNotMatch(WEBXR_CSV_COLUMNS.join(","), /raw_ecg|ecg_samples|rr_series/);
});

test("WebXR matrix helpers preserve model transforms through identity", () => {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const model = modelMatrix(2, 3, -4, 5, 6);
  assert.deepEqual(Array.from(multiplyMatrices(identity, model)), Array.from(model));
});

test("WebXR controller rig places Flubber above the controller and survives degenerate poses", () => {
  const model = controllerFacingModelMatrix(
    { x: 1, y: 1.2, z: -1 },
    { x: 1, y: 1.6, z: 0 },
    0.62,
    0.7,
  );
  assert.ok(Array.from(model).every(Number.isFinite));
  assert.equal(Number(model[12].toFixed(6)), 1);
  assert.equal(Number(model[13].toFixed(6)), 1.36);
  assert.equal(Number(model[14].toFixed(6)), -1);
  const degenerate = controllerFacingModelMatrix(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    0.62,
    0.7,
  );
  assert.ok(Array.from(degenerate).every(Number.isFinite));
});

test("WebXR equirectangular sphere is finite, complete, and centered on the viewer", () => {
  const sphere = createEquirectSphereVertices(8, 16);
  assert.equal(sphere.length, 8 * 16 * 6 * 5);
  assert.ok(Array.from(sphere).every(Number.isFinite));
  const positions = [];
  for (let index = 0; index < sphere.length; index += 5) {
    positions.push({ x: sphere[index], y: sphere[index + 1], z: sphere[index + 2], u: sphere[index + 3], v: sphere[index + 4] });
  }
  assert.ok(positions.some((point) => Math.abs(point.x) < 1e-6 && Math.abs(point.y) < 1e-6 && point.z < -0.99 && Math.abs(point.u - 0.5) < 1e-6));
  assert.ok(positions.every((point) => point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1));

  const translated = modelMatrix(2, 3, -4, 1, 1);
  const rotationOnly = matrixWithoutTranslation(translated);
  assert.deepEqual(Array.from(rotationOnly.slice(12, 15)), [0, 0, 0]);
});

test("WebXR stimulus catalog contains the flat study and eight exact CEAP excerpts", () => {
  assert.equal(WEBXR_STIMULI.length, 9);
  assert.equal(new Set(WEBXR_STIMULI.map((stimulus) => stimulus.id)).size, WEBXR_STIMULI.length);
  assert.equal(webXrStimulusById("missing").id, "great-dictator");
  assert.equal(webXrStimulusById("great-dictator").warning, "");
  const ceap = WEBXR_STIMULI.filter((stimulus) => stimulus.collection === "CEAP-360VR");
  assert.equal(ceap.length, 8);
  assert.deepEqual(ceap.map((stimulus) => stimulus.sourceStartSeconds), [0, 10, 65, 3, 0, 0, 127, 41]);
  assert.deepEqual(ceap.map((stimulus) => stimulus.frameCount), [1501, 1801, 1795, 1803, 1801, 1801, 1801, 1801]);
  assert.ok(ceap.every((stimulus) => stimulus.projection === "equirectangular-360" && stimulus.audio === false));
  assert.ok(ceap.every((stimulus) => stimulusDurationSeconds(stimulus) > 59 && stimulusDurationSeconds(stimulus) < 61));
});

test("every catalog media object is repository-hosted and below GitHub's file limit", () => {
  for (const stimulus of WEBXR_STIMULI) {
    assert.match(stimulus.src, /^\.\/assets\//);
    const file = new URL(`../site/${stimulus.src.slice(2)}`, import.meta.url);
    const size = statSync(file).size;
    assert.ok(size > 0, `${stimulus.id} must not be empty`);
    assert.ok(size < 99_000_000, `${stimulus.id} must stay below the repository safety cap`);
  }
});

test("experimental page is local-first and wires the selectable WebXR study library", () => {
  assert.match(page, /id="stimulus-select"/);
  assert.match(page, /preload="metadata"/);
  assert.doesNotMatch(page, /id="study-video"[^>]*\ssrc=/s);
  assert.match(page, /Optional HTTPS webhook/);
  assert.match(page, /id="controller-follow-enabled"/);
  assert.match(page, /id="controller-follow-hand"/);
  assert.match(page, /id="flubber-size"/);
  assert.match(page, /id="presentation-mode"/);
  assert.match(page, /id="webxr-polar-panel"/);
  assert.match(page, /id="webxr-polar-connect"/);
  assert.match(page, /id="webxr-polar-x"/);
  assert.match(page, /id="webxr-polar-y"/);
  assert.match(page, /Connect before entering immersive mode/);
  assert.match(page, /id="webxr-remote-panel"/);
  assert.match(page, /id="webxr-remote-status"[^>]*aria-live="polite"/);
  assert.match(page, /id="webxr-remote-use"[^>]*>Use incoming signal</);
  assert.match(page, /id="webxr-remote-sources"[^>]*role="group"/);
  assert.match(page, /src="\.\/vendor\/vdoninja\/1\.5\.5\/vdoninja-sdk\.min\.js"/);
  assert.match(styles, /\.polar-xr-connector button\[hidden\][\s\S]*display: none/);
  assert.match(page, /src="\.\/src\/webxr-study\.js\?v=remote-5"/);
  assert.doesNotMatch(page, /https:\/\/(?!example\.org)/);
  assert.match(runtime, /navigator\.xr\.requestSession\(sessionMode/);
  assert.match(runtime, /"immersive-ar"/);
  assert.match(runtime, /new XRWebGLLayer/);
  assert.match(runtime, /alpha: passthrough/);
  assert.match(runtime, /makeXRCompatible/);
  assert.match(runtime, /experimental-webgl/);
  assert.match(runtime, /readQuestControllerState/);
  assert.match(runtime, /createPolarH10BrowserSession\(\{ allowQuestExperiment: true \}\)/);
  assert.match(runtime, /advanceWebXrAffectWithPolar/);
  assert.match(runtime, /applyWebXrRemoteCoordinates/);
  assert.match(runtime, /REMOTE • SIGNAL LOST — HOLDING/);
  assert.match(runtime, /Wait for the incoming Flubber signal to become live before entering immersive mode/);
  assert.match(runtime, /incoming Flubber signal was lost before immersive mode started/);
  assert.match(runtime, /POLAR STREAM • LIVE/);
  assert.match(runtime, /frame\.getPose\(source\.gripSpace, state\.referenceSpace\)/);
  assert.match(runtime, /controllerFacingModelMatrix/);
  assert.match(runtime, /equirectangular-360/);
  assert.match(runtime, /createEquirectSphereVertices/);
  assert.match(runtime, /type: "text\/csv;charset=utf-8"/);
  assert.match(runtime, /method: "POST"/);
});

test("web and APK launchers expose the hosted experimental WebXR page", () => {
  assert.match(index, /href="\.\/webxr\.html"/);
  assert.match(launcher, /WEBXR_STUDY_URL = "https:\/\/GeorgeFejer91\.github\.io\/affect-tracker-web\/webxr\.html"/);
  assert.match(launcher, /Intent\(Intent\.ACTION_VIEW, Uri\.parse\(WEBXR_STUDY_URL\)\)/);
  assert.match(launcher, /addCategory\(Intent\.CATEGORY_BROWSABLE\)/);
  assert.match(launcher, /Text\("Open WebXR study"\)/);
  assert.ok(
    launcher.indexOf('Text("Open WebXR study")') <
      launcher.indexOf("Modifier.weight(1f).verticalScroll"),
    "the WebXR action must appear above the scrollable native-session content",
  );
});
