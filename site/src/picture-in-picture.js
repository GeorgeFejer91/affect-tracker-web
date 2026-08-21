export function pictureInPictureSupported(hostWindow) {
  return typeof hostWindow?.documentPictureInPicture?.requestWindow === "function";
}

export function pictureInPictureWindowSize(widgetSize) {
  const numericSize = Number(widgetSize);
  if (!Number.isFinite(numericSize)) return 240;
  return Math.round(Math.min(640, Math.max(180, numericSize)));
}
