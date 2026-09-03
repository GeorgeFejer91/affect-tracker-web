export const SMARTPHONE_LAYOUT_MAX_WIDTH = 600;
export const SMARTPHONE_LANDSCAPE_MAX_HEIGHT = 500;
export const MOBILE_COORDINATE_GRAB_RADIUS_PX = 30;
export const MOBILE_PARTY_ZOOM_MIN = 0.5;
export const MOBILE_PARTY_ZOOM_MAX = 1.6;
export const MOBILE_PARTY_PAN_LIMIT = 0.5;
export const MOBILE_PREVIEW_MIN_SIZE_PX = 44;

const clampUnit = (value, fallback = 0.5) => {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : fallback));
};

export function layoutMobileAffectPreviews({
  width,
  height,
  viewportX = 0.5,
  viewportY = 0.5,
  faceVisible = false,
} = {}) {
  const availableWidth = Number(width);
  const availableHeight = Number(height);
  if (![availableWidth, availableHeight].every(Number.isFinite)
    || availableWidth <= 0
    || availableHeight <= 0) return undefined;

  const paired = faceVisible === true;
  const gap = paired
    ? Math.min(12, availableWidth / 5, Math.max(8, availableWidth * 0.02))
    : 0;
  const widthLimit = paired
    ? Math.max(0, (availableWidth - gap) / 2)
    : availableWidth;
  const preferredSize = Math.min(
    paired ? 176 : 224,
    availableWidth * (paired ? 0.43 : 0.74),
    availableHeight * 0.9,
    widthLimit,
  );
  const containedMinimum = Math.min(
    MOBILE_PREVIEW_MIN_SIZE_PX,
    availableHeight,
    widthLimit,
  );
  const size = Math.min(
    availableHeight,
    widthLimit,
    Math.max(containedMinimum, preferredSize),
  );
  const normalizedX = clampUnit(viewportX);
  const normalizedY = clampUnit(viewportY);
  const desiredFlubberX = size / 2 + normalizedX * Math.max(0, availableWidth - size);
  const flubberMaximumX = availableWidth - size / 2;
  const flubberMinimumX = paired
    ? Math.min(flubberMaximumX, size * 1.5 + gap)
    : size / 2;
  const flubberX = Math.max(flubberMinimumX, Math.min(flubberMaximumX, desiredFlubberX));
  const centerY = size / 2 + normalizedY * Math.max(0, availableHeight - size);
  const flubber = Object.freeze({ x: flubberX, y: centerY, size });
  const face = paired
    ? Object.freeze({ x: flubberX - size - gap, y: centerY, size })
    : undefined;

  return Object.freeze({ gap, flubber, face });
}

export function isSmartphoneTouchViewport({
  width,
  height,
  coarsePointer = false,
  maxTouchPoints = 0,
} = {}) {
  const touchCapable = coarsePointer || Number(maxTouchPoints) > 0;
  const narrowPortrait = Number.isFinite(width) && width > 0 && width <= SMARTPHONE_LAYOUT_MAX_WIDTH;
  const shortLandscape = Number.isFinite(height) && height > 0 && height <= SMARTPHONE_LANDSCAPE_MAX_HEIGHT;
  return touchCapable && (narrowPortrait || shortLandscape);
}

export function affectCoordinateToClientPoint({ x, y, bounds } = {}) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const left = Number(bounds?.left);
  const top = Number(bounds?.top);
  if (![width, height, left, top].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  const boundedX = Math.max(-1, Math.min(1, Number(x) || 0));
  const boundedY = Math.max(-1, Math.min(1, Number(y) || 0));
  return {
    x: left + (boundedX + 1) * 0.5 * width,
    y: top + (1 - boundedY) * 0.5 * height,
  };
}

export function clientPointToAffectCoordinate({ clientX, clientY, bounds } = {}) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  const left = Number(bounds?.left);
  const top = Number(bounds?.top);
  if (![clientX, clientY, width, height, left, top].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return {
    x: Math.max(-1, Math.min(1, ((clientX - left) / width) * 2 - 1)),
    y: Math.max(-1, Math.min(1, 1 - ((clientY - top) / height) * 2)),
  };
}

export function startsOnCoordinateMarker({
  clientX,
  clientY,
  x,
  y,
  bounds,
  radius = MOBILE_COORDINATE_GRAB_RADIUS_PX,
} = {}) {
  if (![clientX, clientY, radius].every(Number.isFinite) || radius <= 0) return false;
  const marker = affectCoordinateToClientPoint({ x, y, bounds });
  if (!marker) return false;
  return Math.hypot(clientX - marker.x, clientY - marker.y) <= radius;
}

export function normalizeMobilePartyCamera({ zoom = 1, panX = 0, panY = 0 } = {}) {
  return {
    zoom: Math.max(MOBILE_PARTY_ZOOM_MIN, Math.min(MOBILE_PARTY_ZOOM_MAX, Number(zoom) || 1)),
    panX: Math.max(-MOBILE_PARTY_PAN_LIMIT, Math.min(MOBILE_PARTY_PAN_LIMIT, Number(panX) || 0)),
    panY: Math.max(-MOBILE_PARTY_PAN_LIMIT, Math.min(MOBILE_PARTY_PAN_LIMIT, Number(panY) || 0)),
  };
}

export function projectMobilePartyPoint({ viewportX, viewportY, camera } = {}) {
  const normalized = normalizeMobilePartyCamera(camera);
  const x = Number(viewportX);
  const y = Number(viewportY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    viewportX: 0.5 + (x - 0.5) * normalized.zoom + normalized.panX,
    viewportY: 0.5 + (y - 0.5) * normalized.zoom + normalized.panY,
  };
}

export function unprojectMobilePartyPoint({ viewportX, viewportY, camera } = {}) {
  const normalized = normalizeMobilePartyCamera(camera);
  const x = Number(viewportX);
  const y = Number(viewportY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return {
    viewportX: 0.5 + (x - 0.5 - normalized.panX) / normalized.zoom,
    viewportY: 0.5 + (y - 0.5 - normalized.panY) / normalized.zoom,
  };
}
