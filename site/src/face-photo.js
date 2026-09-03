const GRID_SIZE = 3;
const DEFAULT_CANVAS_SIZE = 320;

const clamp = (value, minimum, maximum, fallback = minimum) => {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, finite));
};

const freezeTile = (column, row, weight) => Object.freeze({ column, row, weight });

export const FACE_PHOTO_ATLAS_URL = new URL(
  "../assets/affect-face/affect-face-atlas-v1.webp",
  import.meta.url,
).href;

/** Resolve project-local and explicitly supplied atlas URLs relative to this module. */
export function resolveFacePhotoAtlasUrl(value = FACE_PHOTO_ATLAS_URL) {
  if (value === undefined || value === null || value === "") return FACE_PHOTO_ATLAS_URL;
  return new URL(String(value), import.meta.url).href;
}

/**
 * Normalize only the shared presentation values consumed by the photo atlas.
 * Phase and presentationColor are deliberately absent: the atlas has no
 * autonomous movement and real skin pixels must not be tinted.
 */
export function normalizeFacePhotoFrame(snapshot = {}, reducedMotion = false) {
  return Object.freeze({
    currentX: clamp(snapshot?.currentX, -1, 1, 0),
    currentY: clamp(snapshot?.currentY, -1, 1, 0),
    overlayOpacity: clamp(snapshot?.overlayOpacity, 0, 1, 1),
    reducedMotion: Boolean(reducedMotion),
  });
}

function axisBlend(position) {
  const first = Math.floor(position);
  const second = Math.ceil(position);
  if (first === second) {
    return Object.freeze({ first, second, firstWeight: 1, secondWeight: 0 });
  }
  const secondWeight = position - first;
  return Object.freeze({ first, second, firstWeight: 1 - secondWeight, secondWeight });
}

/**
 * Return exact bilinear atlas weights. Columns run valence -1, 0, +1 from
 * left to right. Rows run arousal +1, 0, -1 from top to bottom.
 */
export function computeFacePhotoBlend(snapshot = {}) {
  const currentX = clamp(snapshot?.currentX, -1, 1, 0);
  const currentY = clamp(snapshot?.currentY, -1, 1, 0);
  const columnPosition = currentX + 1;
  const rowPosition = 1 - currentY;
  const columns = axisBlend(columnPosition);
  const rows = axisBlend(rowPosition);
  const tiles = [];

  const append = (column, row, weight) => {
    if (weight > 0) tiles.push(freezeTile(column, row, weight));
  };

  append(columns.first, rows.first, columns.firstWeight * rows.firstWeight);
  append(columns.second, rows.first, columns.secondWeight * rows.firstWeight);
  append(columns.first, rows.second, columns.firstWeight * rows.secondWeight);
  append(columns.second, rows.second, columns.secondWeight * rows.secondWeight);

  return Object.freeze({
    currentX,
    currentY,
    columnPosition,
    rowPosition,
    tiles: Object.freeze(tiles),
  });
}

/**
 * Compute the centered square crop within each atlas cell and an object-contain
 * square destination within the renderer viewport.
 */
export function computeFacePhotoLayout(atlas = {}, viewport = {}) {
  const atlasWidth = Number(atlas?.width ?? atlas?.naturalWidth);
  const atlasHeight = Number(atlas?.height ?? atlas?.naturalHeight);
  const viewportWidth = Number(viewport?.width);
  const viewportHeight = Number(viewport?.height);
  if (!(atlasWidth > 0) || !(atlasHeight > 0)) {
    throw new RangeError("The affect face atlas must have positive dimensions.");
  }
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    throw new RangeError("The affect face viewport must have positive dimensions.");
  }

  const cellWidth = atlasWidth / GRID_SIZE;
  const cellHeight = atlasHeight / GRID_SIZE;
  const sourceSize = Math.min(cellWidth, cellHeight);
  const sourceInsetX = (cellWidth - sourceSize) * 0.5;
  const sourceInsetY = (cellHeight - sourceSize) * 0.5;
  const destinationSize = Math.min(viewportWidth, viewportHeight);

  return Object.freeze({
    atlasWidth,
    atlasHeight,
    cellWidth,
    cellHeight,
    sourceSize,
    sourceInsetX,
    sourceInsetY,
    destinationX: (viewportWidth - destinationSize) * 0.5,
    destinationY: (viewportHeight - destinationSize) * 0.5,
    destinationSize,
  });
}

/** Pure, allocation-friendly inspection state used by tests and integrations. */
export function buildFacePhotoState(
  snapshot = {},
  reducedMotion = false,
  atlas = {},
  viewport = {},
) {
  return Object.freeze({
    frame: normalizeFacePhotoFrame(snapshot, reducedMotion),
    blend: computeFacePhotoBlend(snapshot),
    layout: computeFacePhotoLayout(atlas, viewport),
  });
}

function findCanvas(root) {
  return root?.querySelector?.("canvas[data-face-photo]") ?? null;
}

function imageDimensions(image) {
  return {
    width: Number(image?.naturalWidth || image?.width || 0),
    height: Number(image?.naturalHeight || image?.height || 0),
  };
}

function errorFrom(value, fallbackMessage) {
  if (value instanceof Error) return value;
  const message = typeof value?.message === "string" && value.message.trim()
    ? value.message
    : fallbackMessage;
  return new Error(message);
}

function fillBlendScratch(currentX, currentY, scratch) {
  const columnPosition = currentX + 1;
  const rowPosition = 1 - currentY;
  const firstColumn = Math.floor(columnPosition);
  const secondColumn = Math.ceil(columnPosition);
  const firstRow = Math.floor(rowPosition);
  const secondRow = Math.ceil(rowPosition);
  const columnMix = columnPosition - firstColumn;
  const rowMix = rowPosition - firstRow;

  scratch.columnIndices[0] = firstColumn;
  scratch.columnWeights[0] = secondColumn === firstColumn ? 1 : 1 - columnMix;
  scratch.columnCount = secondColumn === firstColumn ? 1 : 2;
  if (scratch.columnCount === 2) {
    scratch.columnIndices[1] = secondColumn;
    scratch.columnWeights[1] = columnMix;
  }

  scratch.rowIndices[0] = firstRow;
  scratch.rowWeights[0] = secondRow === firstRow ? 1 : 1 - rowMix;
  scratch.rowCount = secondRow === firstRow ? 1 : 2;
  if (scratch.rowCount === 2) {
    scratch.rowIndices[1] = secondRow;
    scratch.rowWeights[1] = rowMix;
  }
}

/**
 * Create the shared browser/desktop photo-atlas renderer. The returned function
 * accepts `(snapshot, reducedMotion = false, presentationColor)` just like the
 * procedural face renderers. The third argument is passed only to a fallback.
 */
export function createFacePhotoRenderer(root, options = {}) {
  const canvas = findCanvas(root);
  const fallbackRenderer = typeof options.fallbackRenderer === "function"
    ? options.fallbackRenderer
    : null;
  const maximumDpr = clamp(
    Number.isFinite(options.maxDevicePixelRatio) ? options.maxDevicePixelRatio : 2,
    1,
    4,
    2,
  );
  let atlasUrl;
  try {
    atlasUrl = resolveFacePhotoAtlasUrl(options.atlasUrl);
  } catch (error) {
    atlasUrl = FACE_PHOTO_ATLAS_URL;
  }

  let image = null;
  let context = null;
  let loadState = "idle";
  let activeMode = "fallback";
  let lastError = null;
  let destroyed = false;
  let contextLost = false;
  let resizeDirty = true;
  let cssWidth = DEFAULT_CANVAS_SIZE;
  let cssHeight = DEFAULT_CANVAS_SIZE;
  let dpr = 1;
  let sourceCellWidth = 0;
  let sourceCellHeight = 0;
  let sourceSize = 0;
  let sourceInsetX = 0;
  let sourceInsetY = 0;
  let destinationX = 0;
  let destinationY = 0;
  let destinationSize = DEFAULT_CANVAS_SIZE;
  let hasLastCall = false;

  const lastCall = { snapshot: null, reducedMotion: false, presentationColor: undefined };
  const blendScratch = {
    columnCount: 0,
    rowCount: 0,
    columnIndices: new Uint8Array(2),
    rowIndices: new Uint8Array(2),
    columnWeights: new Float64Array(2),
    rowWeights: new Float64Array(2),
  };
  const photoResult = {
    mode: "photo",
    currentX: 0,
    currentY: 0,
    overlayOpacity: 1,
    tileCount: 0,
  };
  const fallbackResult = { mode: "fallback", result: undefined, error: null };
  const destroyedResult = { mode: "destroyed", result: undefined, error: null };

  const setMode = (mode) => {
    if (canvas?.style) canvas.style.visibility = mode === "photo" ? "" : "hidden";
    if (root?.dataset) root.dataset.facePhotoMode = mode;
    if (mode === activeMode) return;
    activeMode = mode;
    options.onModeChange?.(mode);
  };

  const acquireContext = () => {
    if (!canvas || destroyed || contextLost) return null;
    if (context) return context;
    try {
      context = canvas.getContext?.("2d", { alpha: true, desynchronized: true }) ?? null;
    } catch (error) {
      lastError = errorFrom(error, "The photo face canvas could not be initialized.");
      context = null;
    }
    return context;
  };

  const measure = () => {
    const bounds = canvas?.getBoundingClientRect?.();
    const measuredWidth = Number(bounds?.width || canvas?.clientWidth);
    const measuredHeight = Number(bounds?.height || canvas?.clientHeight);
    if (measuredWidth > 0) cssWidth = measuredWidth;
    if (measuredHeight > 0) cssHeight = measuredHeight;
    const deviceDpr = Number.isFinite(globalThis.devicePixelRatio)
      ? globalThis.devicePixelRatio
      : 1;
    dpr = clamp(deviceDpr, 1, maximumDpr, 1);
    if (canvas) {
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    }
    context?.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    destinationSize = Math.min(cssWidth, cssHeight);
    destinationX = (cssWidth - destinationSize) * 0.5;
    destinationY = (cssHeight - destinationSize) * 0.5;
    resizeDirty = false;
    return Object.freeze({ width: cssWidth, height: cssHeight, dpr });
  };

  const fail = (value, message) => {
    loadState = "failed";
    lastError = errorFrom(value, message);
    context = null;
    setMode("fallback");
  };

  const renderFallback = (snapshot, reducedMotion, presentationColor) => {
    if (!destroyed) setMode("fallback");
    fallbackResult.result = fallbackRenderer?.(snapshot, reducedMotion, presentationColor);
    fallbackResult.error = lastError;
    return fallbackResult;
  };

  const render = (snapshot, reducedMotion = false, presentationColor) => {
    if (destroyed) return destroyedResult;
    hasLastCall = true;
    lastCall.snapshot = snapshot;
    lastCall.reducedMotion = reducedMotion;
    lastCall.presentationColor = presentationColor;

    if (loadState === "idle") beginLoad();

    if (loadState !== "ready" || !acquireContext()) {
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }

    try {
      if (resizeDirty) measure();
      const currentX = clamp(snapshot?.currentX, -1, 1, 0);
      const currentY = clamp(snapshot?.currentY, -1, 1, 0);
      const overlayOpacity = clamp(snapshot?.overlayOpacity, 0, 1, 1);
      fillBlendScratch(currentX, currentY, blendScratch);

      context.setTransform?.(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      context.save?.();
      try {
        // Weighted additive compositing produces the intended premultiplied
        // bilinear sum. Repeated source-over draws would make later atlas
        // cells disproportionately strong and leave the result translucent.
        context.globalCompositeOperation = "lighter";
        if ("imageSmoothingEnabled" in context) context.imageSmoothingEnabled = true;
        if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
        let tileCount = 0;
        for (let rowIndex = 0; rowIndex < blendScratch.rowCount; rowIndex += 1) {
          const row = blendScratch.rowIndices[rowIndex];
          const rowWeight = blendScratch.rowWeights[rowIndex];
          for (let columnIndex = 0; columnIndex < blendScratch.columnCount; columnIndex += 1) {
            const column = blendScratch.columnIndices[columnIndex];
            const weight = rowWeight * blendScratch.columnWeights[columnIndex];
            context.globalAlpha = overlayOpacity * weight;
            context.drawImage(
              image,
              column * sourceCellWidth + sourceInsetX,
              row * sourceCellHeight + sourceInsetY,
              sourceSize,
              sourceSize,
              destinationX,
              destinationY,
              destinationSize,
              destinationSize,
            );
            tileCount += 1;
          }
        }
        photoResult.tileCount = tileCount;
      } finally {
        context.restore?.();
        context.globalAlpha = 1;
      }

      photoResult.currentX = currentX;
      photoResult.currentY = currentY;
      photoResult.overlayOpacity = overlayOpacity;
      lastError = null;
      setMode("photo");
      return photoResult;
    } catch (error) {
      fail(error, "The affect face atlas could not be drawn.");
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
  };

  const atlasLoaded = () => {
    if (destroyed || loadState !== "loading") return;
    const dimensions = imageDimensions(image);
    if (!(dimensions.width > 0) || !(dimensions.height > 0)) {
      fail(null, "The affect face atlas loaded without usable dimensions.");
      return;
    }
    if (!acquireContext()) {
      fail(lastError, "A 2D canvas is unavailable for the affect face atlas.");
      return;
    }
    sourceCellWidth = dimensions.width / GRID_SIZE;
    sourceCellHeight = dimensions.height / GRID_SIZE;
    sourceSize = Math.min(sourceCellWidth, sourceCellHeight);
    sourceInsetX = (sourceCellWidth - sourceSize) * 0.5;
    sourceInsetY = (sourceCellHeight - sourceSize) * 0.5;
    loadState = "ready";
    lastError = null;
    resizeDirty = true;
    if (hasLastCall) {
      render(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
    }
  };

  const atlasFailed = (event) => {
    if (destroyed || loadState !== "loading") return;
    fail(event?.error, "The local affect face atlas could not be loaded.");
  };

  const onContextLost = (event) => {
    event?.preventDefault?.();
    contextLost = true;
    context = null;
    lastError = new Error("The photo face canvas context was lost; using the local fallback.");
    if (hasLastCall) {
      renderFallback(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
    } else {
      setMode("fallback");
    }
  };

  const onContextRestored = () => {
    if (destroyed) return;
    contextLost = false;
    context = null;
    resizeDirty = true;
    if (hasLastCall) render(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
  };

  const onResize = () => {
    resizeDirty = true;
  };

  const imageFactory = typeof options.imageFactory === "function"
    ? options.imageFactory
    : typeof globalThis.Image === "function"
      ? () => new globalThis.Image()
      : null;

  function beginLoad() {
    if (destroyed || loadState !== "idle") return;
    loadState = "loading";
    if (!canvas) {
      fail(null, "A canvas[data-face-photo] element is required for the photo face renderer.");
      return;
    }
    if (!imageFactory) {
      fail(null, "Image loading is unavailable; using the local fallback face renderer.");
      return;
    }
    try {
      image = imageFactory(atlasUrl);
      if (!image) throw new TypeError("The image factory returned no image.");
      image.onload = atlasLoaded;
      image.onerror = atlasFailed;
      try {
        image.decoding = "async";
      } catch {
        // Some image adapters expose decoding as read-only.
      }
      image.src = atlasUrl;
      queueMicrotask(() => {
        if (loadState === "loading" && image?.complete && imageDimensions(image).width > 0) {
          atlasLoaded();
        }
      });
    } catch (error) {
      fail(error, "The local affect face atlas could not be initialized.");
    }
  }

  canvas?.addEventListener?.("contextlost", onContextLost);
  canvas?.addEventListener?.("contextrestored", onContextRestored);
  let resizeObserver = null;
  if (canvas && typeof globalThis.ResizeObserver === "function") {
    resizeObserver = new globalThis.ResizeObserver(onResize);
    resizeObserver.observe(canvas);
  } else {
    globalThis.addEventListener?.("resize", onResize);
  }

  render.resize = () => {
    resizeDirty = true;
    return canvas ? measure() : Object.freeze({ width: cssWidth, height: cssHeight, dpr: 1 });
  };
  render.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.("resize", onResize);
    canvas?.removeEventListener?.("contextlost", onContextLost);
    canvas?.removeEventListener?.("contextrestored", onContextRestored);
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
    context = null;
    loadState = "destroyed";
    setMode("destroyed");
  };
  Object.defineProperties(render, {
    available: {
      enumerable: true,
      get: () => !destroyed && !contextLost && loadState === "ready" && Boolean(context),
    },
    mode: { enumerable: true, get: () => activeMode },
    lastError: { enumerable: true, get: () => lastError },
    error: { enumerable: true, get: () => lastError },
    loadState: { enumerable: true, get: () => loadState },
    atlasUrl: { enumerable: true, get: () => atlasUrl },
  });

  setMode("fallback");
  return render;
}
