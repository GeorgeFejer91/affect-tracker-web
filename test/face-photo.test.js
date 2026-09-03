import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FACE_PHOTO_ATLAS_URL,
  FACE_PHOTO_GRID_SIZE,
  FACE_PHOTO_PROFILES,
  buildFacePhotoState,
  computeFacePhotoBlend,
  computeFacePhotoLayout,
  createFacePhotoRenderer,
  normalizeFacePhotoFrame,
  normalizeFacePhotoProfile,
  resolveFacePhotoAtlasUrl,
} from "../site/src/face-photo.js";

const approximately = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function createImageMock() {
  return {
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null,
    onerror: null,
    decoding: "auto",
    assignedSource: "",
    set src(value) { this.assignedSource = value; },
    get src() { return this.assignedSource; },
    succeed(width = 3360, height = 3360) {
      this.complete = true;
      this.naturalWidth = width;
      this.naturalHeight = height;
      this.onload?.();
    },
    fail(error = new Error("image failed")) {
      this.onerror?.({ error });
    },
  };
}

function createContextMock() {
  const stateStack = [];
  const context = {
    clears: [],
    draws: [],
    transforms: [],
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    clearRect(...args) { this.clears.push(args); },
    drawImage(...args) {
      this.draws.push({
        args,
        alpha: this.globalAlpha,
        composite: this.globalCompositeOperation,
        smoothing: this.imageSmoothingEnabled,
        quality: this.imageSmoothingQuality,
      });
    },
    restore() {
      const saved = stateStack.pop();
      if (!saved) return;
      this.globalAlpha = saved.globalAlpha;
      this.globalCompositeOperation = saved.globalCompositeOperation;
      this.imageSmoothingEnabled = saved.imageSmoothingEnabled;
      this.imageSmoothingQuality = saved.imageSmoothingQuality;
    },
    save() {
      stateStack.push({
        globalAlpha: this.globalAlpha,
        globalCompositeOperation: this.globalCompositeOperation,
        imageSmoothingEnabled: this.imageSmoothingEnabled,
        imageSmoothingQuality: this.imageSmoothingQuality,
      });
    },
    setTransform(...args) { this.transforms.push(args); },
  };
  return context;
}

function createRendererFixture({ width = 400, height = 300, context = createContextMock() } = {}) {
  const listeners = new Map();
  let bounds = { width, height };
  const canvas = {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
    style: {},
    getBoundingClientRect: () => ({ ...bounds }),
    getContext(kind) { return kind === "2d" ? context : null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const root = {
    dataset: {},
    querySelector(selector) {
      assert.equal(selector, "canvas[data-face-photo]");
      return canvas;
    },
  };
  return {
    canvas,
    context,
    listeners,
    root,
    setBounds(nextWidth, nextHeight) {
      bounds = { width: nextWidth, height: nextHeight };
      canvas.clientWidth = nextWidth;
      canvas.clientHeight = nextHeight;
    },
  };
}

test("photo atlas URL is module-relative and frame normalization uses only displayed state", () => {
  assert.match(
    FACE_PHOTO_ATLAS_URL,
    /\/site\/assets\/affect-face\/affect-face-atlas-v3\.webp$/,
  );
  assert.equal(FACE_PHOTO_GRID_SIZE, 21);
  assert.deepEqual(FACE_PHOTO_PROFILES, ["geometric-grid", "affec-guided"]);
  assert.equal(normalizeFacePhotoProfile("affec-guided"), "affec-guided");
  assert.equal(normalizeFacePhotoProfile("unknown"), "geometric-grid");
  assert.equal(resolveFacePhotoAtlasUrl(), FACE_PHOTO_ATLAS_URL);
  assert.equal(
    resolveFacePhotoAtlasUrl("../assets/custom-atlas.webp"),
    new URL("../site/assets/custom-atlas.webp", import.meta.url).href,
  );
  assert.deepEqual(
    normalizeFacePhotoFrame(
      {
        currentX: 4,
        currentY: -3,
        targetX: -0.7,
        targetY: 0.8,
        phase: Math.PI,
        overlayOpacity: Number.NaN,
      },
      true,
    ),
    { currentX: 1, currentY: -1, overlayOpacity: 1, reducedMotion: true },
  );
});

test("AFFEC photo profile preserves tracker coordinates while sampling its empirical atlas field", () => {
  const snapshot = { currentX: 0.60286725, currentY: 0.2660965 };
  const direct = computeFacePhotoBlend(snapshot);
  const empirical = computeFacePhotoBlend(snapshot, "affec-guided");
  assert.equal(empirical.currentX, snapshot.currentX);
  assert.equal(empirical.currentY, snapshot.currentY);
  assert.equal(empirical.profile, "affec-guided");
  assert.ok(empirical.atlasX > direct.atlasX);
  assert.ok(empirical.atlasY > direct.atlasY);
  assert.ok(empirical.empiricalBlend > 0.4);
  assert.ok(empirical.tiles.length >= 1 && empirical.tiles.length <= 4);
  assert.ok(Math.abs(empirical.tiles.reduce((sum, tile) => sum + tile.weight, 0) - 1) < 1e-12);
});

test("ready renderer hot-switches the AFFEC-guided sampling profile without changing state", () => {
  const fixture = createRendererFixture();
  const image = createImageMock();
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => image,
    maxDevicePixelRatio: 1,
    profile: "affec-guided",
  });
  const snapshot = Object.freeze({ currentX: 0.60286725, currentY: 0.2660965 });
  renderer(snapshot);
  image.succeed();
  const guided = renderer(snapshot);
  assert.equal(renderer.profile, "affec-guided");
  assert.equal(fixture.root.dataset.facePhotoProfile, "affec-guided");
  assert.equal(guided.currentX, snapshot.currentX);
  assert.equal(guided.currentY, snapshot.currentY);
  assert.ok(guided.atlasX > guided.currentX);

  assert.equal(renderer.setProfile("geometric-grid"), "geometric-grid");
  const direct = renderer(snapshot);
  assert.equal(fixture.root.dataset.facePhotoProfile, "geometric-grid");
  assert.equal(direct.atlasX, snapshot.currentX);
  assert.equal(direct.atlasY, snapshot.currentY);
});

test("dense atlas metadata locks the owned source, generated output, and mobile budget", () => {
  const assetDirectory = new URL("../site/assets/affect-face/", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("affect-face-atlas-v3.json", assetDirectory), "utf8"));
  const qa = JSON.parse(readFileSync(new URL("affect-face-atlas-v3-qa.json", assetDirectory), "utf8"));
  const source = readFileSync(new URL(metadata.source, assetDirectory));
  const output = readFileSync(new URL(metadata.output, assetDirectory));
  const generator = readFileSync(
    new URL("../scripts/build-dense-photo-atlas.py", import.meta.url),
    "utf8",
  );
  const verifier = readFileSync(
    new URL("../scripts/verify-dense-photo-atlas.py", import.meta.url),
    "utf8",
  );

  assert.equal(metadata.id, "affect-face-atlas-v3-landmark-warp-21x21");
  assert.equal(metadata.sourceGridSize, 3);
  assert.equal(metadata.gridSize, FACE_PHOTO_GRID_SIZE);
  assert.equal(metadata.nodeCount, 441);
  assert.equal(metadata.tileSize, 160);
  assert.equal(metadata.controlPointCount, 58);
  assert.equal(metadata.triangleCount, 98);
  assert.equal(metadata.topologySweepSize, 101);
  assert.ok(metadata.minimumTriangleAreaPixels > 3);
  assert.deepEqual(Object.keys(metadata.versions).sort(), [
    "mediapipe",
    "numpy",
    "opencv",
    "pillow",
    "scipy",
  ]);
  assert.equal(metadata.sourceSha256, digest(source));
  assert.equal(metadata.outputSha256, digest(output));
  assert.ok(output.byteLength < 4_000_000, "dense WebP must remain under the 4 MB transfer budget");
  assert.equal(output.toString("ascii", 0, 4), "RIFF");
  assert.equal(output.toString("ascii", 8, 12), "WEBP");
  assert.equal(output.toString("ascii", 12, 16), "VP8X");
  assert.equal(output.readUIntLE(24, 3) + 1, metadata.gridSize * metadata.tileSize);
  assert.equal(output.readUIntLE(27, 3) + 1, metadata.gridSize * metadata.tileSize);
  assert.match(metadata.method, /piecewise-affine premultiplied landmark warp/);
  assert.match(metadata.runtimeInterpolation, /continuous bilinear/);
  assert.match(metadata.affectValidation, /not independent validated affect observations/);
  assert.match(generator, /MediaPipe is used only offline/);
  assert.doesNotMatch(generator, /site\/src/);
  assert.equal(qa.schema, "affect-tracker-photo-atlas-engineering-qa");
  assert.equal(qa.version, 1);
  assert.equal(qa.passed, true);
  assert.match(qa.evidenceBoundary, /do not establish perceived or validated valence\/arousal/);
  assert.equal(qa.asset.sourceSha256, metadata.sourceSha256);
  assert.equal(qa.asset.atlasSha256, metadata.outputSha256);
  assert.equal(qa.asset.metadataSha256, digest(readFileSync(new URL("affect-face-atlas-v3.json", assetDirectory))));
  assert.equal(qa.asset.builderSha256, digest(generator));
  assert.equal(qa.asset.verifierSha256, digest(verifier));
  assert.equal(qa.asset.gridSize, metadata.gridSize);
  assert.equal(qa.asset.tileSize, metadata.tileSize);
  assert.equal(qa.asset.detectedCellCount, metadata.nodeCount);
  assert.ok(Object.values(qa.checks).every(Boolean));
  assert.equal(qa.metrics.observedFoldCount, 0);
  assert.equal(qa.metrics.expectedAxisAnchorPathProgress.violationCount, 0);
  assert.equal(qa.metrics.anchorPreservation.maximumAlphaError, 0);
  assert.equal(qa.metrics.anchorPreservation.anchors.length, 9);
});

test("center and all four affect corners select their exact atlas anchors", () => {
  const cases = [
    [{ currentX: 0, currentY: 0 }, { column: 10, row: 10, weight: 1 }],
    [{ currentX: -1, currentY: 1 }, { column: 0, row: 0, weight: 1 }],
    [{ currentX: 1, currentY: 1 }, { column: 20, row: 0, weight: 1 }],
    [{ currentX: -1, currentY: -1 }, { column: 0, row: 20, weight: 1 }],
    [{ currentX: 1, currentY: -1 }, { column: 20, row: 20, weight: 1 }],
  ];
  for (const [snapshot, expected] of cases) {
    const blend = computeFacePhotoBlend(snapshot);
    assert.deepEqual(blend.tiles, [expected]);
    assert.equal(blend.currentX, snapshot.currentX);
    assert.equal(blend.currentY, snapshot.currentY);
  }
});

test("all 441 dense nodes resolve to one exact row-major cell", () => {
  for (let row = 0; row < FACE_PHOTO_GRID_SIZE; row += 1) {
    for (let column = 0; column < FACE_PHOTO_GRID_SIZE; column += 1) {
      const currentX = -1 + (2 * column) / (FACE_PHOTO_GRID_SIZE - 1);
      const currentY = 1 - (2 * row) / (FACE_PHOTO_GRID_SIZE - 1);
      const blend = computeFacePhotoBlend({ currentX, currentY });
      assert.deepEqual(blend.tiles, [{ column, row, weight: 1 }]);
    }
  }
});

test("continuous and diagonal coordinates use exact bilinear weights without quantization", () => {
  assert.deepEqual(computeFacePhotoBlend({ currentX: 0.55, currentY: 0.55 }).tiles, [
    { column: 15, row: 4, weight: 0.25 },
    { column: 16, row: 4, weight: 0.25 },
    { column: 15, row: 5, weight: 0.25 },
    { column: 16, row: 5, weight: 0.25 },
  ]);

  const arbitrary = computeFacePhotoBlend({ currentX: -0.37, currentY: -0.64 });
  assert.deepEqual(
    arbitrary.tiles.map(({ column, row }) => [column, row]),
    [[6, 16], [7, 16], [6, 17], [7, 17]],
  );
  approximately(arbitrary.tiles.reduce((sum, tile) => sum + tile.weight, 0), 1);
  approximately(arbitrary.tiles[0].weight, 0.7 * 0.6);
  approximately(arbitrary.tiles[1].weight, 0.3 * 0.6);
  approximately(arbitrary.tiles[2].weight, 0.7 * 0.4);
  approximately(arbitrary.tiles[3].weight, 0.3 * 0.4);

  const matrixState = computeFacePhotoBlend({ currentX: 0.2, currentY: -0.8 });
  assert.equal(matrixState.currentX, 0.2);
  assert.equal(matrixState.currentY, -0.8);
  approximately(matrixState.tiles.reduce((sum, tile) => sum + tile.weight, 0), 1);
});

test("layout makes a centered square crop and object-contain destination", () => {
  const layout = computeFacePhotoLayout(
    { width: 2310, height: 1890 },
    { width: 500, height: 300 },
  );
  assert.deepEqual(layout, {
    atlasWidth: 2310,
    atlasHeight: 1890,
    cellWidth: 110,
    cellHeight: 90,
    sourceSize: 90,
    sourceInsetX: 10,
    sourceInsetY: 0,
    destinationX: 100,
    destinationY: 0,
    destinationSize: 300,
  });
  assert.throws(() => computeFacePhotoLayout({ width: 0, height: 900 }, { width: 300, height: 300 }));
  assert.throws(() => computeFacePhotoLayout({ width: 900, height: 900 }, { width: 0, height: 300 }));

  const state = buildFacePhotoState(
    { currentX: 0.4, currentY: -0.2, phase: 999, overlayOpacity: 0.7 },
    true,
    { width: 3360, height: 3360 },
    { width: 300, height: 400 },
  );
  assert.equal(state.frame.currentX, 0.4);
  assert.equal(state.frame.currentY, -0.2);
  assert.equal(state.frame.reducedMotion, true);
  assert.equal(state.layout.destinationY, 50);
});

test("renderer delegates exact calls while loading, then redraws the latest frame on load", () => {
  const fixture = createRendererFixture();
  const image = createImageMock();
  const fallbackCalls = [];
  const modes = [];
  let imageFactoryCalls = 0;
  const renderer = createFacePhotoRenderer(fixture.root, {
    atlasUrl: "../assets/test-face.webp",
    imageFactory: () => {
      imageFactoryCalls += 1;
      return image;
    },
    maxDevicePixelRatio: 1,
    onModeChange: (mode) => modes.push(mode),
    fallbackRenderer(...args) {
      fallbackCalls.push(args);
      return "procedural";
    },
  });
  const snapshot = { currentX: -0.25, currentY: 0.75, phase: 12, overlayOpacity: 0.8 };

  assert.equal(renderer.mode, "fallback");
  assert.equal(renderer.available, false);
  assert.equal(renderer.loadState, "idle");
  assert.equal(imageFactoryCalls, 0);
  assert.equal(image.src, "");
  assert.equal(renderer(snapshot, true, "#ff0000").result, "procedural");
  assert.equal(renderer.loadState, "loading");
  assert.equal(imageFactoryCalls, 1);
  assert.equal(image.decoding, "async");
  assert.equal(image.src, renderer.atlasUrl);
  assert.deepEqual(fallbackCalls, [[snapshot, true, "#ff0000"]]);

  image.succeed();
  assert.equal(renderer.loadState, "ready");
  assert.equal(renderer.available, true);
  assert.equal(renderer.mode, "photo");
  assert.equal(fixture.context.draws.length, 4);
  assert.equal(fixture.canvas.style.visibility, "");
  assert.equal(fixture.root.dataset.facePhotoMode, "photo");
  assert.deepEqual(modes, ["photo"]);
});

test("renderer rejects an atlas whose dimensions cannot contain 21 exact rows and columns", () => {
  const fixture = createRendererFixture();
  const image = createImageMock();
  const renderer = createFacePhotoRenderer(fixture.root, { imageFactory: () => image });
  renderer({ currentX: 0, currentY: 0 });
  image.succeed(3361, 3360);
  assert.equal(renderer.mode, "fallback");
  assert.equal(renderer.loadState, "failed");
  assert.match(renderer.lastError.message, /divisible by 21/);
});

test("ready renderer bilinearly composites four source tiles without order bias or skin tint", () => {
  const fixture = createRendererFixture();
  const image = createImageMock();
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => image,
    maxDevicePixelRatio: 1,
  });
  renderer({ currentX: 0, currentY: 0 });
  image.succeed(3360, 3360);
  fixture.context.draws.length = 0;
  fixture.context.clears.length = 0;

  const result = renderer(
    { currentX: 0.55, currentY: 0.55, phase: 1, overlayOpacity: 0.8 },
    false,
    "#ff0000",
  );
  assert.equal(result.mode, "photo");
  assert.equal(result.tileCount, 4);
  assert.equal(fixture.context.clears.length, 1);
  assert.deepEqual(fixture.context.clears[0], [0, 0, 400, 300]);
  assert.equal(fixture.context.draws.length, 4);
  assert.deepEqual(
    fixture.context.draws.map(({ args }) => args.slice(1)),
    [
      [2400, 640, 160, 160, 50, 0, 300, 300],
      [2560, 640, 160, 160, 50, 0, 300, 300],
      [2400, 800, 160, 160, 50, 0, 300, 300],
      [2560, 800, 160, 160, 50, 0, 300, 300],
    ],
  );
  for (const draw of fixture.context.draws) {
    approximately(draw.alpha, 0.2);
    assert.equal(draw.composite, "lighter");
    assert.equal(draw.smoothing, true);
    assert.equal(draw.quality, "high");
  }
  approximately(
    fixture.context.draws.reduce((sum, draw) => sum + draw.alpha, 0),
    0.8,
  );
  assert.equal(fixture.context.globalAlpha, 1);
  assert.equal(fixture.context.globalCompositeOperation, "source-over");

  fixture.context.draws.length = 0;
  renderer(
    { currentX: 0.55, currentY: 0.55, phase: 999, overlayOpacity: 0.8 },
    true,
    "#00ff00",
  );
  assert.deepEqual(fixture.context.draws.map((draw) => draw.args.slice(1)), [
    [2400, 640, 160, 160, 50, 0, 300, 300],
    [2560, 640, 160, 160, 50, 0, 300, 300],
    [2400, 800, 160, 160, 50, 0, 300, 300],
    [2560, 800, 160, 160, 50, 0, 300, 300],
  ]);
});

test("load and draw failures remain local and delegate to the exact fallback", () => {
  {
    const fixture = createRendererFixture();
    const image = createImageMock();
    const fallbackCalls = [];
    const renderer = createFacePhotoRenderer(fixture.root, {
      imageFactory: () => image,
      fallbackRenderer(...args) { fallbackCalls.push(args); },
    });
    const snapshot = { currentX: 0.1, currentY: -0.2 };
    renderer(snapshot, true, "#123456");
    fallbackCalls.length = 0;
    image.fail(new Error("missing atlas"));
    const result = renderer(snapshot, true, "#123456");
    assert.equal(result.mode, "fallback");
    assert.equal(renderer.mode, "fallback");
    assert.equal(renderer.available, false);
    assert.equal(renderer.loadState, "failed");
    assert.match(renderer.lastError.message, /missing atlas/);
    assert.deepEqual(fallbackCalls, [[snapshot, true, "#123456"]]);
  }

  {
    const context = createContextMock();
    context.drawImage = () => { throw new Error("draw failed"); };
    const fixture = createRendererFixture({ context });
    const image = createImageMock();
    const fallbackCalls = [];
    const renderer = createFacePhotoRenderer(fixture.root, {
      imageFactory: () => image,
      fallbackRenderer(...args) { fallbackCalls.push(args); return "fallback"; },
    });
    const snapshot = { currentX: 0, currentY: 0 };
    renderer(snapshot, false, "#abcdef");
    fallbackCalls.length = 0;
    image.succeed();
    const result = renderer(snapshot, false, "#abcdef");
    assert.equal(result.mode, "fallback");
    assert.equal(result.result, "fallback");
    assert.equal(renderer.loadState, "failed");
    assert.match(renderer.lastError.message, /draw failed/);
    assert.deepEqual(fallbackCalls, [
      [snapshot, false, "#abcdef"],
      [snapshot, false, "#abcdef"],
    ]);
  }
});

test("switching portrait atlases is lazy and ignores the retired image lifecycle", () => {
  const fixture = createRendererFixture();
  const images = [createImageMock(), createImageMock()];
  let imageFactoryCalls = 0;
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => images[imageFactoryCalls++],
    maxDevicePixelRatio: 1,
  });

  renderer({ currentX: 0, currentY: 0 });
  assert.equal(imageFactoryCalls, 1);
  images[0].succeed();
  assert.equal(renderer.mode, "photo");

  const nextUrl = renderer.setAtlasUrl("../assets/affect-face/affect-face-atlas-synthetic-01-21x21.webp");
  assert.match(nextUrl, /affect-face-atlas-synthetic-01-21x21\.webp$/);
  assert.equal(renderer.loadState, "idle");
  assert.equal(renderer.mode, "fallback");
  assert.equal(imageFactoryCalls, 1, "changing the selection must not preload another atlas");
  assert.equal(images[0].onload, null);
  assert.equal(images[0].onerror, null);

  renderer({ currentX: 0.2, currentY: -0.4 });
  assert.equal(imageFactoryCalls, 2);
  assert.equal(images[1].src, nextUrl);
  images[0].succeed();
  assert.equal(renderer.loadState, "loading");
  images[1].succeed();
  assert.equal(renderer.loadState, "ready");
  assert.equal(renderer.mode, "photo");
});

test("queued callbacks from an in-flight retired atlas cannot alter the replacement lifecycle", () => {
  const fixture = createRendererFixture();
  const images = [createImageMock(), createImageMock()];
  let imageFactoryCalls = 0;
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => images[imageFactoryCalls++],
    maxDevicePixelRatio: 1,
  });

  renderer({ currentX: -0.1, currentY: 0.3 });
  const retiredOnload = images[0].onload;
  const retiredOnerror = images[0].onerror;
  renderer.setAtlasUrl(`../assets/affect-face/packs/photo-synthetic-02/atlas-v1.webp?v=${"b".repeat(12)}`);

  retiredOnload();
  retiredOnerror({ error: new Error("late retired failure") });
  assert.equal(renderer.loadState, "idle");
  assert.equal(renderer.lastError, null);
  assert.equal(renderer.mode, "fallback");

  renderer({ currentX: 0.7, currentY: -0.8 });
  assert.equal(imageFactoryCalls, 2);
  images[1].succeed();
  assert.equal(renderer.loadState, "ready");
  assert.equal(renderer.mode, "photo");
});

test("resize updates the high-DPI object-contain viewport and destroy releases lifecycle hooks", () => {
  const fixture = createRendererFixture({ width: 320, height: 240 });
  const image = createImageMock();
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => image,
    maxDevicePixelRatio: 1,
  });
  renderer({ currentX: 0, currentY: 0 });
  image.succeed();
  renderer({ currentX: 0, currentY: 0 });
  assert.equal(fixture.canvas.width, 320);
  assert.equal(fixture.canvas.height, 240);
  assert.equal(fixture.context.draws.at(-1).args[5], 40);
  assert.equal(fixture.context.draws.at(-1).args[6], 0);
  assert.equal(fixture.context.draws.at(-1).args[7], 240);
  assert.equal(fixture.context.draws.at(-1).args[8], 240);

  fixture.setBounds(200, 400);
  assert.deepEqual(renderer.resize(), { width: 200, height: 400, dpr: 1 });
  fixture.context.draws.length = 0;
  renderer({ currentX: 1, currentY: -1 });
  assert.deepEqual(fixture.context.draws[0].args.slice(5), [0, 100, 200, 200]);

  assert.equal(fixture.listeners.has("contextlost"), true);
  assert.equal(fixture.listeners.has("contextrestored"), true);
  renderer.destroy();
  assert.equal(renderer.mode, "destroyed");
  assert.equal(renderer.available, false);
  assert.equal(renderer.loadState, "destroyed");
  assert.equal(fixture.listeners.size, 0);
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
  assert.equal(fixture.canvas.style.visibility, "hidden");
  assert.equal(renderer({ currentX: -1, currentY: 1 }).mode, "destroyed");
});
