import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { interpolateFaceExpression } from "../site/src/face.js";
import {
  FACE_3D_MESH_COUNTS,
  buildFace3dModel,
  computeFace3dWeights,
  createFace3dRenderer,
  normalizeFace3dFrame,
  projectFace3dModel,
  resolveFace3dPalette,
} from "../site/src/face-3d.js";

const approximately = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

const everyFinite = (values) => [...values].every(Number.isFinite);

test("3D face weights are a bounded view of the canonical expression map", () => {
  const neutral = computeFace3dWeights({ currentX: 0, currentY: 0 });
  assert.deepEqual(neutral, {
    smile: 0,
    frown: 0,
    jawOpen: 0,
    eyeWide: 0,
    eyeSquint: 0,
    browUp: 0,
    browDown: 0,
    innerBrowUp: 0,
  });

  const coordinate = { currentX: -0.45, currentY: 0.7 };
  const expression = interpolateFaceExpression(coordinate.currentX, coordinate.currentY);
  const weights = computeFace3dWeights(coordinate);
  approximately(weights.frown, Math.max(0, -expression.mouthCurve));
  approximately(weights.jawOpen, expression.mouthOpen);
  approximately(weights.innerBrowUp, expression.innerBrowLift);
  for (const value of Object.values(weights)) assert.ok(value >= 0 && value <= 1);
});

test("3D frame normalization clamps current state and safely defaults non-finite input", () => {
  assert.deepEqual(
    normalizeFace3dFrame(
      { currentX: 8, currentY: -4, phase: Math.PI, targetX: -1, targetY: 1 },
      true,
      "#123456",
    ),
    {
      currentX: 1,
      currentY: -1,
      phase: Math.PI,
      reducedMotion: true,
      presentationColor: "#123456",
    },
  );
  assert.deepEqual(
    normalizeFace3dFrame({ currentX: Number.NaN, currentY: Infinity, phase: -Infinity }),
    {
      currentX: 0,
      currentY: 0,
      phase: 0,
      reducedMotion: false,
      presentationColor: "#d8b095",
    },
  );
});

test("procedural head mesh is deterministic, finite, and structurally closed", () => {
  const first = buildFace3dModel({ currentX: 0.35, currentY: -0.6, phase: 1.25 });
  const second = buildFace3dModel({ currentX: 0.35, currentY: -0.6, phase: 1.25 });
  assert.equal(first.vertices.length, FACE_3D_MESH_COUNTS.vertices * 3);
  assert.equal(first.triangles.length, FACE_3D_MESH_COUNTS.triangles);
  assert.ok(FACE_3D_MESH_COUNTS.vertices > 300);
  assert.ok(FACE_3D_MESH_COUNTS.triangles > 600);
  assert.ok(everyFinite(first.vertices));
  assert.deepEqual([...first.vertices], [...second.vertices]);
  assert.deepEqual(first.triangles, second.triangles);
  for (const triangle of first.triangles) {
    assert.equal(triangle.length, 3);
    assert.equal(new Set(triangle).size, 3);
    for (const index of triangle) {
      assert.ok(Number.isInteger(index));
      assert.ok(index >= 0 && index < FACE_3D_MESH_COUNTS.vertices);
    }
  }
});

test("neutral projected facial landmarks remain bilaterally balanced", () => {
  const model = buildFace3dModel({ currentX: 0, currentY: 0, phase: 0 });
  const scene = projectFace3dModel(model, { width: 480, height: 360 });
  const [leftEye, rightEye] = scene.features.eyes;
  approximately(
    leftEye.iris.centre.x + rightEye.iris.centre.x,
    scene.viewport.width,
    1e-8,
  );
  approximately(leftEye.iris.centre.y, rightEye.iris.centre.y, 1e-8);
  approximately(
    scene.features.mouth.left.x + scene.features.mouth.right.x,
    scene.viewport.width,
    1e-8,
  );
  approximately(scene.features.mouth.left.y, scene.features.mouth.right.y, 1e-8);
});

test("shared phase animates only restrained articulation and reduced motion removes phase dependence", () => {
  const frame = { currentX: 0.6, currentY: 0.9 };
  const start = buildFace3dModel({ ...frame, phase: 0 });
  const peak = buildFace3dModel({ ...frame, phase: Math.PI / 2 });
  const cycle = buildFace3dModel({ ...frame, phase: Math.PI * 2 });
  assert.equal(start.headScale, 1);
  assert.equal(peak.headScale, 1);
  assert.notEqual(start.animatedJawOpen, peak.animatedJawOpen);
  approximately(start.headScale, cycle.headScale);
  approximately(start.animatedJawOpen, cycle.animatedJawOpen);

  const reducedStart = buildFace3dModel({ ...frame, phase: 0 }, true);
  const reducedPeak = buildFace3dModel({ ...frame, phase: Math.PI / 2 }, true);
  assert.equal(reducedStart.headScale, reducedPeak.headScale);
  assert.equal(reducedStart.animatedJawOpen, reducedPeak.animatedJawOpen);
  assert.deepEqual([...reducedStart.vertices], [...reducedPeak.vertices]);
});

test("perspective projection is finite, visible, and painter sorted", () => {
  for (const [currentX, currentY] of [
    [-1, -1],
    [0, 0],
    [1, 1],
    [-0.42, 0.73],
  ]) {
    const model = buildFace3dModel({ currentX, currentY, phase: 2.4 });
    const scene = projectFace3dModel(model, { width: 640, height: 420 });
    assert.ok(everyFinite(scene.screen));
    assert.ok(everyFinite(scene.world));
    assert.ok(scene.visibleTriangles.length > FACE_3D_MESH_COUNTS.triangles * 0.3);
    assert.ok(scene.visibleTriangles.length < FACE_3D_MESH_COUNTS.triangles * 0.65);
    for (let index = 1; index < scene.visibleTriangles.length; index += 1) {
      assert.ok(
        scene.visibleTriangles[index - 1].depth <= scene.visibleTriangles[index].depth,
      );
    }
    const featureNumbers = JSON.stringify(scene.features).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
    assert.ok(featureNumbers?.every((value) => Number.isFinite(Number(value))));
  }
});

test("presentation color is locally parsed into a stable shaded material", () => {
  const long = resolveFace3dPalette("#5dffb0");
  const short = resolveFace3dPalette("#abc");
  const rgb = resolveFace3dPalette("rgb(255, 91, 104)");
  assert.deepEqual(long.accent, [93, 255, 176]);
  assert.deepEqual(short.accent, [170, 187, 204]);
  assert.deepEqual(rgb.accent, [255, 91, 104]);
  for (const palette of [long, short, rgb, resolveFace3dPalette("invalid")]) {
    for (const color of Object.values(palette)) {
      assert.equal(color.length, 3);
      assert.ok(color.every((channel) => channel >= 0 && channel <= 255));
    }
  }
});

function createMockContext() {
  const counts = { clears: 0, fills: 0, strokes: 0 };
  return {
    counts,
    beginPath() {},
    clearRect() { counts.clears += 1; },
    closePath() {},
    ellipse() {},
    fill() { counts.fills += 1; },
    lineTo() {},
    moveTo() {},
    quadraticCurveTo() {},
    arc() {},
    restore() {},
    save() {},
    setTransform() {},
    stroke() { counts.strokes += 1; },
  };
}

function createSmoothMockContext() {
  const context = createMockContext();
  context.counts.clips = 0;
  context.counts.fillRects = 0;
  context.createRadialGradient = () => ({ addColorStop() {} });
  context.clip = () => { context.counts.clips += 1; };
  context.fillRect = () => { context.counts.fillRects += 1; };
  return context;
}

function createRendererFixture(context) {
  const listeners = new Map();
  const fallback = {
    hidden: true,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
  };
  const canvas = {
    clientWidth: 420,
    clientHeight: 360,
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ width: 420, height: 360 }),
    getContext: () => context,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const root = {
    dataset: {},
    querySelector(selector) {
      return selector.startsWith("canvas") ? canvas : fallback;
    },
  };
  return { canvas, fallback, listeners, root };
}

test("renderer draws the projected mesh without reading target coordinates", () => {
  const context = createMockContext();
  const fixture = createRendererFixture(context);
  const renderer = createFace3dRenderer(fixture.root, { maxDevicePixelRatio: 1 });
  const current = Object.freeze({ currentX: 0.4, currentY: 0.8, phase: 1.1 });
  const snapshot = new Proxy(current, {
    get(target, property, receiver) {
      if (property === "targetX" || property === "targetY") {
        throw new Error("3D renderer must not read target coordinates");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = renderer(snapshot, false, "#ffd166");
  assert.equal(result.mode, "canvas-3d");
  assert.ok(result.visibleTriangleCount >= 300);
  assert.equal(renderer.available, true);
  assert.equal(renderer.mode, "canvas");
  assert.equal(fixture.root.dataset.face3dMode, "canvas");
  assert.equal(fixture.fallback.hidden, true);
  assert.equal(fixture.canvas.width, 420);
  assert.equal(fixture.canvas.height, 360);
  assert.equal(context.counts.clears, 1);
  assert.ok(context.counts.fills > 300);
  renderer.destroy();
  assert.equal(renderer.available, false);
  assert.equal(renderer.mode, "destroyed");
});

test("Canvas compatibility renderer uses smooth gradient shading without drawing a triangle grid", () => {
  const context = createSmoothMockContext();
  const fixture = createRendererFixture(context);
  const renderer = createFace3dRenderer(fixture.root, { maxDevicePixelRatio: 1 });
  const result = renderer({ currentX: 0.7, currentY: 0.7, phase: 1.2 }, false, "#5dffb0");
  assert.equal(result.mode, "canvas-3d");
  assert.equal(result.smoothShading, true);
  assert.equal(context.counts.clips, 1);
  assert.equal(context.counts.fillRects, 4);
  assert.ok(context.counts.fills < 40, "smooth path should not repaint hundreds of triangles");
});

test("renderer invokes the local SVG fallback with the exact shared snapshot", () => {
  const fixture = createRendererFixture(null);
  const calls = [];
  const renderer = createFace3dRenderer(fixture.root, {
    fallbackRenderer(snapshot, reducedMotion, presentationColor) {
      calls.push({ snapshot, reducedMotion, presentationColor });
      return "svg-result";
    },
  });
  const snapshot = Object.freeze({ currentX: -0.2, currentY: 0.3, phase: 4 });
  const result = renderer(snapshot, true, "#5c7cfa");
  assert.equal(result.mode, "fallback");
  assert.equal(result.result, "svg-result");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot, snapshot);
  assert.equal(calls[0].reducedMotion, true);
  assert.equal(calls[0].presentationColor, "#5c7cfa");
  assert.equal(renderer.available, false);
  assert.equal(renderer.mode, "fallback");
  assert.equal(fixture.root.dataset.face3dMode, "fallback");
  assert.equal(fixture.fallback.hidden, false);
});

test("3D renderer stays self-contained and free of acquisition or network paths", () => {
  const source = readFileSync(new URL("../site/src/face-3d.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/face\.js"/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//);
  assert.doesNotMatch(source, /getUserMedia|requestDevice|navigator\.mediaDevices/);
  assert.doesNotMatch(source, /Date\.now|performance\.now|requestAnimationFrame|setInterval/);
  assert.doesNotMatch(source, /targetX|targetY/);
});
