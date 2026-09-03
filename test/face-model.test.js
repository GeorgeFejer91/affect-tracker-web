import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  DEFAULT_FACE_MODEL_PROFILE,
  FACE_MODEL_FRIENDLY_STYLE,
  FACE_MODEL_MATRIX_STATES,
  FACE_MODEL_MORPH_NAMES,
  FACE_MODEL_PROFILES,
  buildFaceModelWeights,
  createFaceModelRenderer,
  resolveFaceModelMatrixState,
} from "../site/src/face-model.js";

const approximately = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

function assertFiniteWeights(weights) {
  assert.deepEqual(Object.keys(weights), [...FACE_MODEL_MORPH_NAMES]);
  for (const value of Object.values(weights)) {
    assert.equal(Number.isFinite(value), true);
    assert.ok(value >= 0 && value <= 1, `${value} should be a normalized influence`);
  }
  assert.equal(weights.Eyebrows_Raised_Left, weights.Eyebrows_Raised_Right);
  assert.equal(weights.Eyebrows_Frown_Left, weights.Eyebrows_Frown_Right);
  assert.equal(weights.Eyes_Opened_Max_Left, weights.Eyes_Opened_Max_Right);
}

test("all detailed-face profiles retain exact neutral and distinct affect corners", () => {
  assert.deepEqual(FACE_MODEL_PROFILES, [
    "affec-empirical",
    "mediapipe-atlas",
    "facs-continuous",
    "matrix-anchors",
  ]);
  assert.equal(DEFAULT_FACE_MODEL_PROFILE, "affec-empirical");

  for (const profile of FACE_MODEL_PROFILES) {
    const centre = buildFaceModelWeights({ currentX: 0, currentY: 0 }, { profile });
    assert.ok(Object.values(centre).every((value) => value === 0));

    const positiveHigh = buildFaceModelWeights({ currentX: 1, currentY: 1 }, { profile });
    const negativeHigh = buildFaceModelWeights({ currentX: -1, currentY: 1 }, { profile });
    const negativeLow = buildFaceModelWeights({ currentX: -1, currentY: -1 }, { profile });
    assertFiniteWeights(positiveHigh);
    assertFiniteWeights(negativeHigh);
    assertFiniteWeights(negativeLow);
    assert.ok(positiveHigh.Happy > 0.8);
    assert.ok(positiveHigh.Smile_Lips_Closed > 0.55);
    assert.ok(negativeHigh.Angry + negativeHigh.Scared + negativeHigh.Disgusted > 0.6);
    assert.ok(negativeHigh.Eyebrows_Frown_Left > 0.5);
    assert.ok(negativeLow.Sad > 0.3);
    assert.ok(negativeLow.Eyes_Closed_Max > 0.1);
  }

  const continuous = buildFaceModelWeights(
    { currentX: 0.27, currentY: 0.63 },
    { profile: "facs-continuous" },
  );
  const anchored = buildFaceModelWeights(
    { currentX: 0.27, currentY: 0.63 },
    { profile: "matrix-anchors" },
  );
  assert.notDeepEqual(continuous, anchored);
  const empirical = buildFaceModelWeights(
    { currentX: 0.27, currentY: 0.63 },
    { profile: "affec-empirical" },
  );
  const calibrated = buildFaceModelWeights(
    { currentX: 0.27, currentY: 0.63 },
    { profile: "mediapipe-atlas" },
  );
  assert.notDeepEqual(empirical, calibrated);
});

test("continuous and matrix mappings are symmetric, finite, clamped, and current-only", () => {
  for (const profile of FACE_MODEL_PROFILES) {
    for (const coordinate of [
      [-1, -1],
      [-0.73, 0.48],
      [-0.2, 0.8],
      [0, -0.6],
      [0.2, -0.8],
      [0.61, 0.37],
      [1, 1],
    ]) {
      assertFiniteWeights(buildFaceModelWeights(
        { currentX: coordinate[0], currentY: coordinate[1] },
        { profile },
      ));
    }

    assert.deepEqual(
      buildFaceModelWeights({ currentX: 999, currentY: -999 }, { profile }),
      buildFaceModelWeights({ currentX: 1, currentY: -1 }, { profile }),
    );
    assert.deepEqual(
      buildFaceModelWeights({ currentX: Number.NaN, currentY: Infinity }, { profile }),
      buildFaceModelWeights({ currentX: 0, currentY: 0 }, { profile }),
    );

    const snapshot = new Proxy({ currentX: 0.4, currentY: -0.2 }, {
      get(target, property, receiver) {
        if (property === "targetX" || property === "targetY" || property === "phase") {
          throw new Error(`unexpected ${String(property)} read`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    assertFiniteWeights(buildFaceModelWeights(snapshot, { profile }));
  }

  assert.throws(
    () => buildFaceModelWeights({}, { profile: "unknown" }),
    /Unknown detailed face profile/,
  );
});

test("matrix-anchor profile reuses all 441 exact face states while off-grid mappings stay continuous", () => {
  assert.equal(FACE_MODEL_MATRIX_STATES.length, 441);
  const centre = FACE_MODEL_MATRIX_STATES[10 * 21 + 10];
  assert.deepEqual({ row: centre.row, column: centre.column, x: centre.x, y: centre.y }, {
    row: 10,
    column: 10,
    x: 0,
    y: 0,
  });
  assert.ok(Object.values(centre.weights).every((value) => value === 0));

  for (let row = 0; row < 21; row += 1) {
    for (let column = 0; column < 21; column += 1) {
      const state = FACE_MODEL_MATRIX_STATES[row * 21 + column];
      assert.equal(state.row, row);
      assert.equal(state.column, column);
      assert.equal(state.x, (column - 10) / 10);
      assert.equal(state.y, (row - 10) / 10);
      assertFiniteWeights(state.weights);
      assert.equal(resolveFaceModelMatrixState({ currentX: state.x, currentY: state.y }), state);
      assert.equal(
        buildFaceModelWeights(
          { currentX: state.x, currentY: state.y },
          { profile: "matrix-anchors" },
        ),
        state.weights,
      );
    }
  }

  assert.equal(resolveFaceModelMatrixState({ currentX: 0.313, currentY: -0.627 }), null);
  for (const profile of FACE_MODEL_PROFILES) {
    assert.notDeepEqual(
      buildFaceModelWeights({ currentX: 0.313, currentY: -0.627 }, { profile }),
      buildFaceModelWeights({ currentX: 0.314, currentY: -0.626 }, { profile }),
    );
  }
});

function createDomFixture(width = 400, height = 320) {
  const listeners = new Map();
  const attributes = () => ({
    values: new Map(),
    setAttribute(name, value) { this.values.set(name, value); },
  });
  let bounds = { width, height };
  const canvas = {
    ...attributes(),
    hidden: true,
    style: {},
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => bounds,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const photo = { ...attributes(), hidden: false, style: {} };
  const fallback = { ...attributes(), hidden: false, style: {} };
  const root = {
    dataset: {},
    querySelector(selector) {
      if (selector === "canvas[data-face-model]") return canvas;
      if (selector === "canvas[data-face-photo]") return photo;
      if (selector === "[data-face-3d-fallback]") return fallback;
      return null;
    },
  };
  return {
    canvas,
    photo,
    fallback,
    listeners,
    root,
    setBounds(nextWidth, nextHeight) {
      bounds = { width: nextWidth, height: nextHeight };
      canvas.clientWidth = nextWidth;
      canvas.clientHeight = nextHeight;
    },
  };
}

function createRendererMock({ context = {} } = {}) {
  const calls = {
    clearColor: [],
    forceContextLoss: 0,
    pixelRatio: [],
    render: [],
    setSize: [],
    dispose: 0,
  };
  return {
    calls,
    capabilities: { getMaxAnisotropy: () => 16 },
    getContext: () => context,
    setClearColor(...args) { calls.clearColor.push(args); },
    setPixelRatio(value) { calls.pixelRatio.push(value); },
    setSize(...args) { calls.setSize.push(args); },
    render(scene, camera) { calls.render.push({ scene, camera }); },
    dispose() { calls.dispose += 1; },
    forceContextLoss() { calls.forceContextLoss += 1; },
  };
}

function namedMaterial(name) {
  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
  material.name = name;
  return material;
}

function createModelFixture() {
  const root = new THREE.Group();
  root.name = "vitruvian-test-root";
  const morphGeometry = new THREE.BoxGeometry(0.18, 0.34, 0.12);
  const morphMesh = new THREE.Mesh(morphGeometry, namedMaterial("VitSkin"));
  morphMesh.name = "cm_vitruvian";
  morphMesh.morphTargetDictionary = Object.fromEntries(
    FACE_MODEL_MORPH_NAMES.map((name, index) => [name, index]),
  );
  morphMesh.morphTargetInfluences = new Array(FACE_MODEL_MORPH_NAMES.length).fill(0);
  root.add(morphMesh);

  for (const name of [
    "VitSkin.001",
    "VitMouth",
    "VitMouth.001",
    "VitIris",
    "VitIris.001",
    "VitSclera",
    "VitSclera.001",
    "VitEyeBack",
    "VitCornea2",
    "VitCornea2.001",
    "VitEyeshadow",
    "VitTearline",
    "VitCaruncle",
  ]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), namedMaterial(name));
    mesh.name = `material-${name}`;
    root.add(mesh);
  }

  const leftEye = new THREE.Group();
  leftEye.name = "Eye_L_eyeball";
  leftEye.position.set(-0.035, 0.07, 0.08);
  const rightEye = new THREE.Group();
  rightEye.name = "Eye_R_eyeball";
  rightEye.position.set(0.035, 0.07, 0.08);
  root.add(leftEye, rightEye);
  return { root, morphMesh };
}

function createLoaders(modelResult, { modelError = null } = {}) {
  const modelCalls = [];
  const decoderCalls = [];
  const textureCalls = [];
  const textures = new Map();
  const modelLoader = {
    setMeshoptDecoder(value) { decoderCalls.push(value); },
    loadAsync(url) {
      modelCalls.push(url);
      if (modelError) return Promise.reject(modelError);
      return Promise.resolve({ scene: modelResult });
    },
  };
  const textureLoader = {
    loadAsync(url) {
      textureCalls.push(url);
      const texture = new THREE.Texture();
      texture.name = url.split("/").at(-1);
      textures.set(url, texture);
      return Promise.resolve(texture);
    },
  };
  return { modelLoader, textureLoader, modelCalls, decoderCalls, textureCalls, textures };
}

async function createReadyRenderer({
  profile = DEFAULT_FACE_MODEL_PROFILE,
  snapshot = { currentX: 0.38, currentY: 0.64, phase: 0 },
  reducedMotion = false,
} = {}) {
  const dom = createDomFixture();
  const model = createModelFixture();
  const loaders = createLoaders(model.root);
  const rendererMock = createRendererMock();
  const fallbackCalls = [];
  let rendererFactoryCalls = 0;
  const renderer = createFaceModelRenderer(dom.root, {
    profile,
    modelLoader: loaders.modelLoader,
    textureLoader: loaders.textureLoader,
    rendererFactory(parameters) {
      rendererFactoryCalls += 1;
      assert.equal(parameters.canvas, dom.canvas);
      assert.equal(parameters.alpha, true);
      assert.equal(parameters.antialias, true);
      return rendererMock;
    },
    fallbackRenderer(...args) {
      fallbackCalls.push(args);
      return "photo-atlas";
    },
    maxDevicePixelRatio: 1,
  });
  const firstResult = renderer(snapshot, reducedMotion, "#abcdef");
  const ready = await renderer.ready;
  return {
    dom,
    model,
    loaders,
    renderer,
    rendererMock,
    fallbackCalls,
    firstResult,
    ready,
    get rendererFactoryCalls() { return rendererFactoryCalls; },
  };
}

test("asset and WebGL work starts lazily on first render while the exact fallback stays visible", async () => {
  const dom = createDomFixture();
  const model = createModelFixture();
  let resolveModel;
  const modelPromise = new Promise((resolve) => { resolveModel = resolve; });
  const modelCalls = [];
  const textureCalls = [];
  const fallbackCalls = [];
  let rendererFactoryCalls = 0;
  const rendererMock = createRendererMock();
  const renderer = createFaceModelRenderer(dom.root, {
    modelLoader: {
      setMeshoptDecoder() {},
      loadAsync(url) { modelCalls.push(url); return modelPromise; },
    },
    textureLoader: {
      loadAsync(url) { textureCalls.push(url); return Promise.resolve(new THREE.Texture()); },
    },
    rendererFactory() { rendererFactoryCalls += 1; return rendererMock; },
    fallbackRenderer(...args) { fallbackCalls.push(args); return "photo"; },
  });

  assert.equal(renderer.loadState, "idle");
  assert.equal(rendererFactoryCalls, 0);
  assert.equal(modelCalls.length, 0);
  assert.equal(textureCalls.length, 0);
  assert.equal(renderer.mode, "fallback");
  assert.equal(renderer.available, false);

  const snapshot = Object.freeze({ currentX: -0.4, currentY: 0.7, phase: 99 });
  const first = renderer(snapshot, true, "#123456");
  assert.equal(first.mode, "fallback");
  assert.equal(first.result, "photo");
  assert.deepEqual(fallbackCalls, [[snapshot, true, "#123456"]]);
  assert.equal(dom.canvas.hidden, true);
  assert.equal(dom.photo.hidden, false);
  assert.equal(dom.fallback.hidden, false);

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rendererFactoryCalls, 1);
  assert.equal(modelCalls.length, 1);
  assert.equal(textureCalls.length, 6);
  assert.equal(renderer.loadState, "loading");

  resolveModel({ scene: model.root });
  assert.equal(await renderer.ready, true);
  assert.equal(renderer.mode, "model");
  assert.equal(renderer.available, true);
  assert.equal(dom.canvas.hidden, false);
  assert.equal(dom.photo.hidden, true);
  assert.equal(dom.fallback.hidden, true);
  assert.equal(rendererMock.calls.render.length, 1);
  renderer.destroy();
});

test("successful load applies local maps, natural materials, straight framing, and morphs", async () => {
  const fixture = await createReadyRenderer({
    profile: "matrix-anchors",
    snapshot: { currentX: -0.45, currentY: 0.75, phase: 4 },
  });
  assert.equal(fixture.ready, true);
  assert.equal(fixture.firstResult.mode, "fallback");
  assert.equal(fixture.renderer.mode, "model");
  assert.equal(fixture.renderer.lastError, null);
  assert.equal(fixture.loaders.modelCalls.length, 1);
  assert.equal(fixture.loaders.textureCalls.length, 6);
  assert.equal(fixture.loaders.decoderCalls.length, 1);

  const renderCall = fixture.rendererMock.calls.render[0];
  assert.equal(renderCall.scene.background, null);
  assert.equal(renderCall.scene.children.filter((child) => child.isLight).length, 4);
  approximately(renderCall.camera.position.x, 0);
  approximately(renderCall.camera.rotation.x, 0);
  approximately(renderCall.camera.rotation.y, 0);
  assert.ok(renderCall.camera.position.z > 0);
  assert.deepEqual(fixture.rendererMock.calls.clearColor, [[0, 0]]);

  const skin = fixture.model.morphMesh.material;
  assert.equal(skin.name, "VitSkin");
  assert.equal(skin.map, fixture.loaders.textures.get(fixture.renderer.textureUrls.skinBase));
  assert.equal(skin.normalMap, fixture.loaders.textures.get(fixture.renderer.textureUrls.skinNormal));
  assert.equal(
    skin.roughnessMap,
    fixture.loaders.textures.get(fixture.renderer.textureUrls.skinRoughness),
  );
  assert.equal(skin.metalness, 0);
  assert.equal(skin.roughness, 0.88);
  assert.equal(skin.specularIntensity, 0.12);
  assert.ok(skin.normalScale.x > 0 && skin.normalScale.x < 0.5);

  const roleExpectations = new Map([
    ["VitSkin.001", "skinBase"],
    ["VitMouth", "mouth"],
    ["VitMouth.001", "mouth"],
    ["VitIris", "iris"],
    ["VitIris.001", "iris"],
    ["VitSclera", "sclera"],
    ["VitSclera.001", "sclera"],
  ]);
  for (const [materialName, textureName] of roleExpectations) {
    const mesh = fixture.model.root.getObjectByName(`material-${materialName}`);
    assert.equal(mesh.material.name, materialName);
    assert.equal(mesh.material.map, fixture.loaders.textures.get(
      fixture.renderer.textureUrls[textureName],
    ));
    assert.equal(mesh.material.metalness, 0);
  }
  const gradedMaterials = [
    ["VitSkin", "skin"],
    ["VitSkin.001", "skin"],
    ["VitIris", "iris"],
    ["VitIris.001", "iris"],
    ["VitSclera", "sclera"],
    ["VitSclera.001", "sclera"],
  ].map(([name, role]) => [
    fixture.model.root.getObjectByName(name === "VitSkin" ? "cm_vitruvian" : `material-${name}`).material,
    role,
  ]);
  const materialCacheKeys = new Map();
  for (const [material, role] of gradedMaterials) {
    assert.equal(material.userData.affectTrackerFriendlyStyle, FACE_MODEL_FRIENDLY_STYLE.id);
    assert.equal(material.userData.affectTrackerMaterialRole, role);
    assert.match(material.customProgramCacheKey(), /friendly-soft-v1/);
    materialCacheKeys.set(role, material.customProgramCacheKey());
    const shader = { fragmentShader: "#include <map_fragment>" };
    material.onBeforeCompile(shader, {});
    assert.doesNotMatch(shader.fragmentShader, /diffuseColor\.a\s*=/);
    assert.match(shader.fragmentShader, new RegExp(
      role === "skin"
        ? "affectSkinCalmer"
        : role === "iris"
          ? "affectEyeFriendlyIris"
          : "affectEyeClearSclera",
    ));
  }
  assert.equal(new Set(materialCacheKeys.values()).size, 3);
  const iris = fixture.model.root.getObjectByName("material-VitIris").material;
  const sclera = fixture.model.root.getObjectByName("material-VitSclera").material;
  assert.equal(iris.color.getHex(), 0xffffff);
  assert.equal(iris.roughness, 0.65);
  assert.equal(iris.envMapIntensity, 0.03);
  assert.equal(iris.specularIntensity, 0.06);
  assert.equal(iris.clearcoat, 0);
  assert.ok(iris.clearcoatRoughness >= 0.8);
  assert.equal(sclera.color.getHex(), 0xffffff);
  assert.equal(sclera.roughness, 0.6);
  assert.equal(sclera.envMapIntensity, 0.02);
  assert.equal(sclera.specularIntensity, 0.04);
  const smoothstep = (start, end, value) => {
    const normalized = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return normalized * normalized * (3 - 2 * normalized);
  };
  const irisMask = (value) => smoothstep(
    FACE_MODEL_FRIENDLY_STYLE.irisMaskStart,
    FACE_MODEL_FRIENDLY_STYLE.irisMaskEnd,
    value,
  );
  assert.ok(irisMask(0.003) < 0.01, "deep pupil blacks must remain ungraded");
  assert.ok(irisMask(0.0418) > 0.99, "the measured median iris texel must be graded");
  assert.ok(irisMask(0.0593) > 0.99, "the measured upper iris range must be graded");
  assert.equal(
    createHash("sha256")
      .update(readFileSync(new URL("../site/assets/affect-face/iris.webp", import.meta.url)))
      .digest("hex"),
    "9dfc61eed590e2f504e63f66a8a2020acb5c3397f9bb4925778198690b161e2f",
    "the measured linear-light thresholds are bound to the pinned iris texture",
  );
  const cornea = fixture.model.root.getObjectByName("material-VitCornea2").material;
  assert.equal(cornea.transparent, true);
  assert.equal(cornea.depthWrite, false);
  assert.ok(cornea.opacity < 0.1);
  const tearline = fixture.model.root.getObjectByName("material-VitTearline").material;
  assert.equal(tearline.transparent, true);
  assert.ok(tearline.opacity <= 0.025);
  assert.ok(tearline.roughness >= 0.3);
  assert.equal(tearline.color.getHex(), 0xd2beb9);
  const caruncle = fixture.model.root.getObjectByName("material-VitCaruncle").material;
  assert.equal(caruncle.color.getHex(), 0x918987);
  assert.equal(caruncle.transparent, true);
  assert.ok(caruncle.opacity <= 0.28);
  assert.equal(
    fixture.model.root.getObjectByName("material-VitEyeBack").material.map,
    null,
  );

  const expected = buildFaceModelWeights(
    { currentX: -0.45, currentY: 0.75 },
    { profile: "matrix-anchors" },
  );
  for (const [name, index] of Object.entries(fixture.model.morphMesh.morphTargetDictionary)) {
    approximately(fixture.model.morphMesh.morphTargetInfluences[index], expected[name]);
  }
  fixture.renderer.destroy();
});

test("profile switching updates the same loaded model without another request", async () => {
  const snapshot = { currentX: 0.27, currentY: 0.63, phase: 1 };
  const fixture = await createReadyRenderer({ profile: "facs-continuous", snapshot });
  const modelLoads = fixture.loaders.modelCalls.length;
  const textureLoads = fixture.loaders.textureCalls.length;
  const renderCount = fixture.rendererMock.calls.render.length;
  const continuous = buildFaceModelWeights(snapshot, { profile: "facs-continuous" });

  assert.equal(fixture.renderer.profile, "facs-continuous");
  assert.equal(fixture.renderer.setProfile("matrix-anchors"), "matrix-anchors");
  assert.equal(fixture.renderer.profile, "matrix-anchors");
  assert.equal(fixture.loaders.modelCalls.length, modelLoads);
  assert.equal(fixture.loaders.textureCalls.length, textureLoads);
  assert.equal(fixture.rendererMock.calls.render.length, renderCount + 1);
  const anchored = buildFaceModelWeights(snapshot, { profile: "matrix-anchors" });
  assert.notDeepEqual(continuous, anchored);
  for (const [name, index] of Object.entries(fixture.model.morphMesh.morphTargetDictionary)) {
    approximately(fixture.model.morphMesh.morphTargetInfluences[index], anchored[name]);
  }

  const result = fixture.renderer({ ...snapshot, phase: 999 }, true, "#ff0000");
  assert.equal(result.profile, "matrix-anchors");
  assert.deepEqual(result.weights, anchored);
  assert.equal(result.matrixState, null);
  const exactMatrixResult = fixture.renderer(
    { currentX: 0.3, currentY: -0.6, phase: 1000 },
    true,
    "#ff0000",
  );
  assert.deepEqual(exactMatrixResult.matrixState, {
    row: 4,
    column: 13,
    x: 0.3,
    y: -0.6,
  });
  assert.throws(() => fixture.renderer.setProfile("other"), /Unknown detailed face profile/);
  fixture.renderer.destroy();
});

test("renderer failures remain local and preserve the exact fallback call", async () => {
  {
    const dom = createDomFixture();
    const modelCalls = [];
    const fallbackCalls = [];
    const renderer = createFaceModelRenderer(dom.root, {
      rendererFactory() { throw new Error("WebGL blocked"); },
      modelLoader: { loadAsync(url) { modelCalls.push(url); } },
      fallbackRenderer(...args) { fallbackCalls.push(args); return "atlas"; },
    });
    const snapshot = { currentX: 0.1, currentY: -0.2 };
    assert.equal(renderer(snapshot, false, "#abc").result, "atlas");
    assert.equal(await renderer.ready, false);
    assert.equal(renderer.mode, "fallback");
    assert.equal(renderer.available, false);
    assert.match(renderer.lastError.message, /WebGL blocked/);
    assert.equal(modelCalls.length, 0);
    assert.deepEqual(fallbackCalls, [[snapshot, false, "#abc"]]);
  }

  {
    const dom = createDomFixture();
    const model = createModelFixture();
    const loaders = createLoaders(model.root, { modelError: new Error("model missing") });
    const rendererMock = createRendererMock();
    const renderer = createFaceModelRenderer(dom.root, {
      modelLoader: loaders.modelLoader,
      textureLoader: loaders.textureLoader,
      rendererFactory: () => rendererMock,
    });
    renderer({ currentX: 0, currentY: 0 });
    assert.equal(await renderer.ready, false);
    assert.equal(renderer.mode, "fallback");
    assert.match(renderer.lastError.message, /model missing/);
    assert.equal(rendererMock.calls.dispose, 1);
    assert.equal(rendererMock.calls.forceContextLoss, 1);
  }

  {
    const dom = createDomFixture();
    const rendererMock = createRendererMock({ context: null });
    let modelLoads = 0;
    const renderer = createFaceModelRenderer(dom.root, {
      rendererFactory: () => rendererMock,
      modelLoader: { loadAsync() { modelLoads += 1; } },
    });
    renderer({ currentX: 0, currentY: 0 });
    assert.equal(await renderer.ready, false);
    assert.match(renderer.lastError.message, /WebGL is unavailable/);
    assert.equal(modelLoads, 0);
  }
});

test("resize remains lazy and destroy releases renderer and presentation ownership", async () => {
  const dom = createDomFixture(320, 240);
  let rendererFactoryCalls = 0;
  let modelLoads = 0;
  const preflight = createFaceModelRenderer(dom.root, {
    rendererFactory() { rendererFactoryCalls += 1; return createRendererMock(); },
    modelLoader: { loadAsync() { modelLoads += 1; } },
  });
  assert.deepEqual(preflight.resize(), { width: 320, height: 240, dpr: 1 });
  assert.equal(rendererFactoryCalls, 0);
  assert.equal(modelLoads, 0);
  preflight.destroy();
  assert.equal(await preflight.ready, false);

  const fixture = await createReadyRenderer();
  assert.equal(fixture.dom.listeners.has("webglcontextlost"), true);
  assert.equal(fixture.dom.listeners.has("webglcontextrestored"), true);
  fixture.dom.setBounds(200, 400);
  assert.deepEqual(fixture.renderer.resize(), { width: 200, height: 400, dpr: 1 });
  assert.deepEqual(fixture.rendererMock.calls.setSize.at(-1), [200, 400, false]);
  assert.equal(fixture.rendererMock.calls.render.length, 1);

  fixture.renderer.destroy();
  assert.equal(fixture.renderer.mode, "destroyed");
  assert.equal(fixture.renderer.available, false);
  assert.equal(fixture.renderer.loadState, "destroyed");
  assert.equal(fixture.dom.listeners.size, 0);
  assert.equal(fixture.rendererMock.calls.dispose, 1);
  assert.equal(fixture.rendererMock.calls.forceContextLoss, 1);
  assert.equal(fixture.dom.canvas.hidden, true);
  assert.equal(fixture.dom.photo.hidden, false);
  assert.equal(fixture.dom.fallback.hidden, false);
  assert.equal(fixture.renderer({ currentX: 1, currentY: 1 }).mode, "destroyed");
});

test("module uses bundled Three.js assets and contains no autonomous face clock", () => {
  const source = readFileSync(new URL("../site/src/face-model.js", import.meta.url), "utf8");
  const engines = readFileSync(new URL("../site/src/face-engines.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../site/src/app.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(source, /from "three"/);
  assert.match(source, /from "three\/addons\/loaders\/GLTFLoader\.js"/);
  assert.match(source, /from "three\/addons\/libs\/meshopt_decoder\.module\.js"/);
  for (const asset of [
    "vitruvian-head.glb",
    "skin-base.webp",
    "skin-normal.webp",
    "skin-roughness.webp",
    "mouth.webp",
    "iris.webp",
    "sclera.webp",
  ]) {
    assert.match(source, new RegExp(asset.replace(".", "\\.")));
  }
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval|setTimeout|Date\.now|performance\.now/);
  assert.doesNotMatch(source, /snapshot\?\.phase|snapshot\.phase|targetX|targetY/);
  assert.doesNotMatch(source, /getUserMedia|mediaDevices|requestDevice|https?:\/\//);
  assert.match(index, /phone-face-switcher-1-friendly-eyes-1-photo-packs-2/);
  assert.match(app, /face-engines-2-matrix21-1-friendly-eyes-1-photo-packs-1/);
  assert.match(engines, /face-model\.js\?v=matrix21-1-friendly-eyes-1/);
  assert.match(engines, /face-photo\.js\?v=dense21-warp-packs-1/);
});
