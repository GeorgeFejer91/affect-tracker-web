import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FACE_ENGINE_MODE,
  FACE_ENGINE_MODES,
  createFaceEngineRenderer,
  faceEngineDefinition,
  normalizeFaceEngineMode,
  resolveFaceEffectiveMode,
} from "../site/src/face-engines.js";

const node = () => ({
  hidden: false,
  style: {},
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, value); },
});

function fixture() {
  const nodes = { model: node(), photo: node(), vector: node() };
  const root = {
    dataset: {},
    querySelector(selector) {
      if (selector === "canvas[data-face-model]") return nodes.model;
      if (selector === "canvas[data-face-photo]") return nodes.photo;
      if (selector === "[data-face-3d-fallback]") return nodes.vector;
      return null;
    },
  };
  const calls = { model: [], photo: [], vector: [], profiles: [] };
  let modelMode = "model";
  let photoMode = "photo";
  let profile = "affec-empirical";
  const vectorRenderer = (...args) => { calls.vector.push(args); return { vector: true }; };
  const photoRenderer = (...args) => {
    calls.photo.push(args);
    return photoMode === "photo"
      ? { mode: "photo" }
      : { mode: "fallback", result: vectorRenderer(...args) };
  };
  Object.defineProperties(photoRenderer, {
    mode: { get: () => photoMode },
    lastError: { get: () => null },
  });
  photoRenderer.resize = () => {};
  photoRenderer.destroy = () => {};
  const modelRenderer = (...args) => {
    calls.model.push(args);
    return modelMode === "model"
      ? { mode: "model", profile }
      : { mode: "fallback", result: photoRenderer(...args) };
  };
  Object.defineProperties(modelRenderer, {
    mode: { get: () => modelMode },
    profile: { get: () => profile },
    lastError: { get: () => null },
  });
  modelRenderer.setProfile = (value) => { profile = value; calls.profiles.push(value); };
  modelRenderer.resize = () => {};
  modelRenderer.destroy = () => {};
  return {
    root,
    nodes,
    calls,
    vectorRenderer,
    photoRenderer,
    modelRenderer,
    setModelMode(value) { modelMode = value; },
    setPhotoMode(value) { photoMode = value; },
  };
}

test("catalog exposes exactly five testable offline face solutions", () => {
  assert.equal(DEFAULT_FACE_ENGINE_MODE, "affec-empirical");
  assert.deepEqual(FACE_ENGINE_MODES.map(({ id }) => id), [
    "affec-empirical",
    "mediapipe-atlas",
    "facs-continuous",
    "matrix-anchors",
    "photo-atlas",
  ]);
  assert.equal(normalizeFaceEngineMode("not-a-mode"), DEFAULT_FACE_ENGINE_MODE);
  assert.equal(faceEngineDefinition("matrix-anchors").kind, "model");
  assert.equal(faceEngineDefinition("photo-atlas").kind, "photo");
});

test("effective-mode resolution follows model to photo to vector fallbacks", () => {
  assert.equal(resolveFaceEffectiveMode({ mode: "model" }), "model");
  assert.equal(resolveFaceEffectiveMode({ mode: "photo" }), "photo");
  assert.equal(resolveFaceEffectiveMode({ mode: "fallback", result: { mode: "photo" } }), "photo");
  assert.equal(resolveFaceEffectiveMode({ mode: "fallback", result: { vector: true } }), "vector");
});

test("selector hot-switches all model profiles without duplicating render state", () => {
  const f = fixture();
  const renderer = createFaceEngineRenderer(f.root, {
    mode: "affec-empirical",
    vectorRenderer: f.vectorRenderer,
    photoRenderer: f.photoRenderer,
    modelRenderer: f.modelRenderer,
  });
  const snapshot = { currentX: 0.34, currentY: -0.28, phase: 7, sequence: 42 };
  const first = renderer(snapshot, false, "#abc");
  assert.equal(first.mode, "affec-empirical");
  assert.equal(first.effectiveMode, "model");
  assert.deepEqual(f.calls.model[0], [snapshot, false, "#abc"]);
  assert.equal(f.nodes.model.hidden, false);
  assert.equal(f.nodes.photo.hidden, true);
  assert.equal(f.nodes.vector.hidden, true);

  for (const [mode, profile] of [
    ["mediapipe-atlas", "mediapipe-atlas"],
    ["facs-continuous", "facs-continuous"],
    ["matrix-anchors", "matrix-anchors"],
  ]) {
    assert.equal(renderer.setMode(mode), mode);
    const result = renderer(snapshot, true, "#def");
    assert.equal(result.mode, mode);
    assert.equal(result.profile, profile);
    assert.equal(result.effectiveMode, "model");
  }
  assert.deepEqual(f.calls.profiles, [
    "mediapipe-atlas",
    "facs-continuous",
    "matrix-anchors",
  ]);
});

test("photo selection bypasses the model and vector remains the final fallback", () => {
  const f = fixture();
  const renderer = createFaceEngineRenderer(f.root, {
    vectorRenderer: f.vectorRenderer,
    photoRenderer: f.photoRenderer,
    modelRenderer: f.modelRenderer,
  });
  const snapshot = { currentX: -0.2, currentY: 0.6 };
  renderer.setMode("photo-atlas");
  const photo = renderer(snapshot);
  assert.equal(photo.effectiveMode, "photo");
  assert.equal(f.calls.model.length, 0);
  assert.equal(f.calls.photo.length, 1);
  assert.equal(f.nodes.model.hidden, true);
  assert.equal(f.nodes.photo.hidden, false);
  assert.equal(f.nodes.vector.hidden, true);

  f.setPhotoMode("fallback");
  const vector = renderer(snapshot);
  assert.equal(vector.effectiveMode, "vector");
  assert.equal(f.calls.vector.length, 1);
  assert.equal(f.nodes.model.hidden, true);
  assert.equal(f.nodes.photo.hidden, true);
  assert.equal(f.nodes.vector.hidden, false);
});
