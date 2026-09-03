import assert from "node:assert/strict";
import test from "node:test";
import {
  FACE_PHOTO_ATLAS_URL,
  buildFacePhotoState,
  computeFacePhotoBlend,
  computeFacePhotoLayout,
  createFacePhotoRenderer,
  normalizeFacePhotoFrame,
  resolveFacePhotoAtlasUrl,
} from "../site/src/face-photo.js";

const approximately = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be near ${expected}`);
};

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
    succeed(width = 900, height = 900) {
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
    /\/site\/assets\/affect-face\/affect-face-atlas-v1\.webp$/,
  );
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

test("center and all four affect corners select their exact atlas anchors", () => {
  const cases = [
    [{ currentX: 0, currentY: 0 }, { column: 1, row: 1, weight: 1 }],
    [{ currentX: -1, currentY: 1 }, { column: 0, row: 0, weight: 1 }],
    [{ currentX: 1, currentY: 1 }, { column: 2, row: 0, weight: 1 }],
    [{ currentX: -1, currentY: -1 }, { column: 0, row: 2, weight: 1 }],
    [{ currentX: 1, currentY: -1 }, { column: 2, row: 2, weight: 1 }],
  ];
  for (const [snapshot, expected] of cases) {
    const blend = computeFacePhotoBlend(snapshot);
    assert.deepEqual(blend.tiles, [expected]);
    assert.equal(blend.currentX, snapshot.currentX);
    assert.equal(blend.currentY, snapshot.currentY);
  }
});

test("continuous and diagonal coordinates use exact bilinear weights without quantization", () => {
  assert.deepEqual(computeFacePhotoBlend({ currentX: 0.5, currentY: 0.5 }).tiles, [
    { column: 1, row: 0, weight: 0.25 },
    { column: 2, row: 0, weight: 0.25 },
    { column: 1, row: 1, weight: 0.25 },
    { column: 2, row: 1, weight: 0.25 },
  ]);

  const arbitrary = computeFacePhotoBlend({ currentX: -0.37, currentY: -0.64 });
  assert.deepEqual(
    arbitrary.tiles.map(({ column, row }) => [column, row]),
    [[0, 1], [1, 1], [0, 2], [1, 2]],
  );
  approximately(arbitrary.tiles.reduce((sum, tile) => sum + tile.weight, 0), 1);
  approximately(arbitrary.tiles[0].weight, 0.37 * 0.36);
  approximately(arbitrary.tiles[1].weight, 0.63 * 0.36);
  approximately(arbitrary.tiles[2].weight, 0.37 * 0.64);
  approximately(arbitrary.tiles[3].weight, 0.63 * 0.64);

  const matrixState = computeFacePhotoBlend({ currentX: 0.2, currentY: -0.8 });
  assert.equal(matrixState.currentX, 0.2);
  assert.equal(matrixState.currentY, -0.8);
  approximately(matrixState.tiles.reduce((sum, tile) => sum + tile.weight, 0), 1);
});

test("layout makes a centered square crop and object-contain destination", () => {
  const layout = computeFacePhotoLayout(
    { width: 900, height: 750 },
    { width: 500, height: 300 },
  );
  assert.deepEqual(layout, {
    atlasWidth: 900,
    atlasHeight: 750,
    cellWidth: 300,
    cellHeight: 250,
    sourceSize: 250,
    sourceInsetX: 25,
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
    { width: 900, height: 900 },
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

test("ready renderer bilinearly composites four source tiles without order bias or skin tint", () => {
  const fixture = createRendererFixture();
  const image = createImageMock();
  const renderer = createFacePhotoRenderer(fixture.root, {
    imageFactory: () => image,
    maxDevicePixelRatio: 1,
  });
  renderer({ currentX: 0, currentY: 0 });
  image.succeed(900, 900);
  fixture.context.draws.length = 0;
  fixture.context.clears.length = 0;

  const result = renderer(
    { currentX: 0.5, currentY: 0.5, phase: 1, overlayOpacity: 0.8 },
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
      [300, 0, 300, 300, 50, 0, 300, 300],
      [600, 0, 300, 300, 50, 0, 300, 300],
      [300, 300, 300, 300, 50, 0, 300, 300],
      [600, 300, 300, 300, 50, 0, 300, 300],
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

  fixture.context.draws.length = 0;
  renderer(
    { currentX: 0.5, currentY: 0.5, phase: 999, overlayOpacity: 0.8 },
    true,
    "#00ff00",
  );
  assert.deepEqual(fixture.context.draws.map((draw) => draw.args.slice(1)), [
    [300, 0, 300, 300, 50, 0, 300, 300],
    [600, 0, 300, 300, 50, 0, 300, 300],
    [300, 300, 300, 300, 50, 0, 300, 300],
    [600, 300, 300, 300, 50, 0, 300, 300],
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
