export function pictureInPictureSupported(hostWindow) {
  return typeof hostWindow?.documentPictureInPicture?.requestWindow === "function";
}

export function pictureInPictureWindowSize(widgetSize) {
  const numericSize = Number(widgetSize);
  if (!Number.isFinite(numericSize)) return 240;
  return Math.round(Math.min(640, Math.max(180, numericSize)));
}

export function pictureInPictureOptions(widgetSize) {
  const size = pictureInPictureWindowSize(widgetSize);
  return {
    width: size,
    height: size,
    disallowReturnToOpener: true,
  };
}
