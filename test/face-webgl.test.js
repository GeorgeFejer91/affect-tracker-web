import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import { interpolateFaceExpression } from "../site/src/face.js";
import {
  FACE_WEBGL_MATRIX_STATES,
  FACE_WEBGL_MATRIX_SIZE,
  FACE_WEBGL_MATRIX_STEP,
  FACE_WEBGL_METRICS,
  buildFaceWebglComponents,
  buildFaceWebglGeometry,
  buildFaceWebglState,
  createFaceWebglRenderer,
} from "../site/src/face-webgl.js";

const approximately = (actual, expected, tolerance = 1e-7) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

test("WebGL face exposes a dense static mesh and compact 21 by 21 state cache", () => {
  assert.equal(FACE_WEBGL_MATRIX_SIZE, 21);
  assert.equal(FACE_WEBGL_MATRIX_STEP, 0.1);
  assert.equal(FACE_WEBGL_MATRIX_STATES.length, 441);
  assert.equal(FACE_WEBGL_METRICS.matrixStateCount, 441);
  assert.ok(FACE_WEBGL_METRICS.headVertices >= 3_000);
  assert.ok(FACE_WEBGL_METRICS.headTriangles >= 6_000);
  assert.ok(FACE_WEBGL_METRICS.staticGpuBufferBytes < 150_000);
  assert.equal(FACE_WEBGL_METRICS.perFrameBufferUpdates, 0);

  const centre = FACE_WEBGL_MATRIX_STATES[10 * 21 + 10];
  assert.equal(centre.x, 0);
  assert.equal(centre.y, 0);
  assert.equal(centre.row, 10);
  assert.equal(centre.column, 10);
  assert.equal(centre.expression.mouthCurve, 0);
  assert.equal(centre.expression.mouthOpen, 0);
  for (const state of FACE_WEBGL_MATRIX_STATES) {
    assert.equal(state.x, Number((-1 + state.column * 0.1).toFixed(10)));
    assert.equal(state.y, Number((-1 + state.row * 0.1).toFixed(10)));
  }
});

test("cached and continuous WebGL states reuse the canonical expression map", () => {
  const cached = buildFaceWebglState({ currentX: 0.4, currentY: -0.6, phase: 0 });
  const continuous = buildFaceWebglState({ currentX: 0.413, currentY: -0.627, phase: 0 });
  assert.equal(cached.matrixCacheHit, true);
  assert.equal(continuous.matrixCacheHit, false);
  assert.deepEqual(cached.expression, interpolateFaceExpression(0.4, -0.6));
  assert.deepEqual(continuous.expression, interpolateFaceExpression(0.413, -0.627));
  assert.equal(cached.rotation.yaw, 0);
  assert.equal(cached.rotation.pitch, 0);
  assert.equal(cached.headScale, 1);
});

test("CPU conformance geometry is deterministic, finite, smooth, and reusable", () => {
  const snapshot = { currentX: -0.45, currentY: 0.72, phase: 1.7 };
  const first = buildFaceWebglGeometry(snapshot);
  const second = buildFaceWebglGeometry(snapshot);
  assert.equal(first.positions.length, FACE_WEBGL_METRICS.headVertices * 3);
  assert.equal(first.normals.length, first.positions.length);
  assert.equal(first.indices.length, FACE_WEBGL_METRICS.headTriangles * 3);
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.deepEqual([...first.normals], [...second.normals]);
  assert.ok([...first.positions].every(Number.isFinite));
  assert.ok([...first.normals].every(Number.isFinite));
  for (let offset = 0; offset < first.normals.length; offset += 3) {
    approximately(Math.hypot(
      first.normals[offset],
      first.normals[offset + 1],
      first.normals[offset + 2],
    ), 1, 1e-5);
  }

  const positions = new Float32Array(first.positions.length);
  const normals = new Float32Array(first.normals.length);
  const reused = buildFaceWebglGeometry(snapshot, false, "#ffd166", { positions, normals });
  assert.equal(reused.positions, positions);
  assert.equal(reused.normals, normals);
});

test("phase affects only restrained articulation and reduced motion is phase independent", () => {
  const snapshot = { currentX: 0.7, currentY: 0.9 };
  const start = buildFaceWebglGeometry({ ...snapshot, phase: 0 });
  const peak = buildFaceWebglGeometry({ ...snapshot, phase: Math.PI / 2 });
  assert.equal(start.state.headScale, 1);
  assert.equal(peak.state.headScale, 1);
  assert.notEqual(start.state.animatedJawOpen, peak.state.animatedJawOpen);

  const reducedStart = buildFaceWebglGeometry({ ...snapshot, phase: 0 }, true);
  const reducedPeak = buildFaceWebglGeometry({ ...snapshot, phase: Math.PI / 2 }, true);
  assert.equal(reducedStart.state.animatedJawOpen, reducedPeak.state.animatedJawOpen);
  assert.deepEqual([...reducedStart.positions], [...reducedPeak.positions]);
  assert.deepEqual(
    buildFaceWebglComponents(reducedStart.state),
    buildFaceWebglComponents(reducedPeak.state),
  );
});

test("smooth primitive treatment keeps features centered, bounded, and tooth-free", () => {
  const neutral = buildFaceWebglState({ currentX: 0, currentY: 0, phase: 0 });
  const components = buildFaceWebglComponents(neutral);
  const sclera = components.filter((item) => item.role === "sclera");
  const iris = components.filter((item) => item.role === "iris");
  const lips = components.filter((item) => item.role === "lip");
  assert.equal(sclera.length, 2);
  assert.equal(iris.length, 2);
  assert.equal(lips.length, 12);
  assert.equal(components.some((item) => item.role === "teeth"), false);
  approximately(sclera[0].position[0], -sclera[1].position[0], 1e-7);
  approximately(sclera[0].position[1], sclera[1].position[1], 1e-7);
  assert.ok(sclera.every((eye) => eye.scale[0] <= 0.13));
  assert.ok(lips.every((lip) => lip.scale[1] <= 0.014));
});

function createFakeWebgl({ compile = true } = {}) {
  let nextId = 1;
  const counts = {
    bufferData: 0,
    bufferSubData: 0,
    drawElements: 0,
    clear: 0,
  };
  const object = () => ({ id: nextId += 1 });
  return {
    counts,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    UNSIGNED_SHORT: 0x1403,
    TRIANGLES: 0x0004,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    createShader: object,
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => compile,
    getShaderInfoLog: () => (compile ? "" : "forced shader failure"),
    deleteShader() {},
    createProgram: object,
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram() {},
    createBuffer: object,
    bindBuffer() {},
    bufferData() { counts.bufferData += 1; },
    bufferSubData() { counts.bufferSubData += 1; },
    deleteBuffer() {},
    getAttribLocation(_program, name) { return name === "aPosition" ? 0 : 1; },
    getUniformLocation(_program, name) { return { name }; },
    clearColor() {},
    enable() {},
    blendFunc() {},
    viewport() {},
    clear() { counts.clear += 1; },
    useProgram() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    uniformMatrix4fv() {},
    uniformMatrix3fv() {},
    uniform3f() {},
    uniform1f() {},
    uniform4f() {},
    drawElements() { counts.drawElements += 1; },
  };
}

function rendererFixture(webgl) {
  const listeners = new Map();
  const requestCounts = { context: 0 };
  const fallback = {
    hidden: true,
    values: new Map(),
    setAttribute(name, value) { this.values.set(name, value); },
  };
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 480,
    clientHeight: 400,
    style: {},
    getBoundingClientRect: () => ({ width: 480, height: 400 }),
    getContext(type) {
      requestCounts.context += 1;
      return type === "webgl2" ? webgl : null;
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const canvas2d = {
    hidden: false,
    style: {},
    values: new Map(),
    setAttribute(name, value) { this.values.set(name, value); },
  };
  const root = {
    dataset: {},
    querySelector(selector) {
      if (selector.startsWith("canvas")) return canvas;
      if (selector === "[data-face-canvas2d]") return canvas2d;
      return fallback;
    },
  };
  return { canvas, canvas2d, fallback, listeners, requestCounts, root };
}

test("renderer uses static GPU buffers and reads no target coordinate", () => {
  const webgl = createFakeWebgl();
  const fixture = rendererFixture(webgl);
  const renderer = createFaceWebglRenderer(fixture.root, { maxDevicePixelRatio: 1 });
  assert.equal(fixture.requestCounts.context, 0);
  assert.equal(renderer.mode, "fallback");
  assert.equal(renderer.available, false);
  const current = Object.freeze({ currentX: 0.2, currentY: 0.4, phase: 0.8 });
  const snapshot = new Proxy(current, {
    get(target, property, receiver) {
      if (property === "targetX" || property === "targetY") throw new Error("target read");
      return Reflect.get(target, property, receiver);
    },
  });
  const result = renderer(snapshot, false, "#5dffb0");
  assert.equal(result.mode, "webgl2");
  assert.equal(result.bufferUpdates, 0);
  assert.equal(renderer.mode, "webgl2");
  assert.equal(renderer.available, true);
  assert.equal(renderer.error, null);
  assert.equal(webgl.counts.bufferData, 6);
  assert.equal(webgl.counts.bufferSubData, 0);
  assert.equal(webgl.counts.drawElements, result.componentCount + 1);
  assert.equal(fixture.canvas.width, 480);
  assert.equal(fixture.canvas.height, 400);
  assert.equal(fixture.canvas2d.hidden, true);
  renderer.destroy();
  assert.equal(renderer.mode, "destroyed");
  assert.equal(renderer.available, false);
});

test("context loss immediately delegates the exact latest snapshot to fallback", () => {
  const webgl = createFakeWebgl();
  const fixture = rendererFixture(webgl);
  const calls = [];
  const modes = [];
  const renderer = createFaceWebglRenderer(fixture.root, {
    fallbackRenderer(snapshot, reducedMotion, color) {
      calls.push({ snapshot, reducedMotion, color });
      return "local-fallback";
    },
    onModeChange(mode) { modes.push(mode); },
  });
  const snapshot = Object.freeze({ currentX: -0.3, currentY: 0.8, phase: 2 });
  renderer(snapshot, true, "#ff5b68");
  let prevented = false;
  fixture.listeners.get("webglcontextlost")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(renderer.mode, "fallback");
  assert.equal(renderer.available, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot, snapshot);
  assert.equal(calls[0].reducedMotion, true);
  assert.equal(calls[0].color, "#ff5b68");
  assert.equal(fixture.fallback.hidden, false);
  assert.equal(fixture.canvas2d.hidden, false);
  assert.ok(modes.includes("fallback"));

  fixture.listeners.get("webglcontextrestored")();
  assert.equal(renderer.mode, "webgl2");
  assert.equal(renderer.available, true);
  assert.equal(fixture.fallback.hidden, true);
  assert.equal(fixture.canvas2d.hidden, true);
});

test("context and shader failures fail closed through the injected local fallback", () => {
  for (const webgl of [null, createFakeWebgl({ compile: false })]) {
    const fixture = rendererFixture(webgl);
    const calls = [];
    const renderer = createFaceWebglRenderer(fixture.root, {
      fallbackRenderer(snapshot) { calls.push(snapshot); },
    });
    const snapshot = Object.freeze({ currentX: 0, currentY: 0, phase: 0 });
    const result = renderer(snapshot);
    assert.equal(result.mode, "fallback");
    assert.equal(renderer.mode, "fallback");
    assert.equal(renderer.available, false);
    assert.equal(calls[0], snapshot);
    if (webgl) assert.match(String(renderer.error), /forced shader failure/);
  }
});

test("WebGL implementation is a compact offline module with no atlas or clock", () => {
  const url = new URL("../site/src/face-webgl.js", import.meta.url);
  const source = readFileSync(url, "utf8");
  const bytes = statSync(url).size;
  assert.ok(bytes < 60_000, `source is unexpectedly large: ${bytes} bytes`);
  assert.match(source, /from "\.\/face\.js"/);
  assert.match(source, /from "\.\/face-3d\.js"/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//);
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval|Date\.now|performance\.now/);
  assert.doesNotMatch(source, /getUserMedia|requestDevice|navigator\.mediaDevices/);
  assert.doesNotMatch(source, /\.png|\.jpe?g|\.webp|sprite|frameAtlas/i);
  assert.doesNotMatch(source, /targetX|targetY/);
});
