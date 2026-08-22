export const SMARTPHONE_LAYOUT_MAX_WIDTH = 600;
export const SMARTPHONE_LANDSCAPE_MAX_HEIGHT = 500;

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
