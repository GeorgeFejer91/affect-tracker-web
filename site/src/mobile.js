export const SMARTPHONE_LAYOUT_MAX_WIDTH = 600;
export const SMARTPHONE_LANDSCAPE_MAX_HEIGHT = 500;
export const MOBILE_COORDINATE_GRAB_RADIUS_PX = 30;

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
