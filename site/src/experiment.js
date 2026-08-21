import { clamp } from "./math.js";

export const DEMO_VIDEO_ID = "pY6vrOpnM64";
export const DEMO_START_SECONDS = 90;
export const DEMO_VIDEO_URL = "./assets/dictator-3-study.mp4";
export const EXPERIMENT_SAMPLE_INTERVAL_MS = 50;
export const DEFAULT_EXPERIMENT_CONFIG = Object.freeze({
  source: "local",
  youtubeUrl: `https://www.youtube.com/watch?v=${DEMO_VIDEO_ID}`,
  startSeconds: DEMO_START_SECONDS,
  endSeconds: 344.4,
});

export function youtubeVideoId(value) {
  const input = String(value ?? "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (url.hostname.endsWith("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v") ?? "";
      const [, kind, id] = url.pathname.split("/");
      if (["embed", "shorts", "live"].includes(kind)) return id ?? "";
    }
  } catch { /* handled below */ }
  return "";
}

export function normalizeExperimentConfig(input) {
  const source = input?.source === "youtube" ? "youtube" : "local";
  if (source === "local") return { ...DEFAULT_EXPERIMENT_CONFIG, source };
  const videoId = youtubeVideoId(input.youtubeUrl);
  const startSeconds = Number(input.startSeconds);
  const endSeconds = Number(input.endSeconds);
  if (!videoId) throw new Error("Enter a valid YouTube watch, share, Shorts, live, or embed URL.");
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error("Start time must be zero or greater.");
  if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error("Finish time must be greater than the start time.");
  if (endSeconds - startSeconds > 14_400) throw new Error("Experiment segments cannot exceed four hours.");
  return {
    source,
    youtubeUrl: String(input.youtubeUrl).trim(),
    videoId,
    startSeconds,
    endSeconds,
  };
}

export function experimentBufferCapacity(durationSeconds) {
  return Math.max(10_000, Math.ceil(Number(durationSeconds) * 40) + 5_000);
}

function fitVideo(maxWidth, maxHeight) {
  const ratio = 16 / 9;
  const width = Math.max(0, Math.min(maxWidth, maxHeight * ratio));
  return { width, height: width / ratio };
}

export function computeExperimentLayout(viewportWidth, viewportHeight, widgetSize, gap = 24, tracePanelSize) {
  const width = Math.max(1, Number(viewportWidth));
  const height = Math.max(1, Number(viewportHeight));
  const edgeGap = clamp(gap, 8, 48);
  const maximumWidth = Math.max(1, width - 2 * edgeGap);
  let body = clamp(Number(widgetSize) || 120, Math.min(80, maximumWidth), Math.min(640, maximumWidth));
  let traceWidth = tracePanelSize ? clamp(Number(tracePanelSize.width) || 220, 1, maximumWidth) : 0;
  let traceHeight = tracePanelSize ? clamp(Number(tracePanelSize.height) || 0, 0, Math.max(0, height - 2 * edgeGap)) : 0;
  const traceAspect = traceWidth > 0 ? traceHeight / traceWidth : 0;
  const traceGap = traceHeight > 0 ? edgeGap : 0;
  const interElementGaps = edgeGap + traceGap;
  const innerHeight = Math.max(1, height - 2 * edgeGap - interElementGaps);

  // On short landscape phones, preserving the configured desktop-sized widget
  // can consume the complete viewport before the video is laid out. Collapse
  // the experiment-only rendering size to a usable 80 px first, then shrink the
  // trace only when even that cannot leave at least one video row. Portable
  // settings remain unchanged and are restored after the experiment.
  if (body + traceHeight >= innerHeight) body = Math.min(body, Math.min(80, maximumWidth));
  const maximumTraceHeight = Math.max(0, innerHeight - body - 1);
  if (traceHeight > maximumTraceHeight) {
    traceHeight = maximumTraceHeight;
    traceWidth = traceAspect > 0 ? Math.min(traceWidth, traceHeight / traceAspect) : 0;
  }

  // Treat the stimulus and Flubber as one centered vertical stack. Reserving the
  // widget's full height first guarantees that it remains directly below the
  // video without overlap, even when the viewport becomes narrow.
  const video = fitVideo(
    maximumWidth,
    Math.max(1, innerHeight - body - traceHeight),
  );
  const stackHeight = video.height + edgeGap + body + traceGap + traceHeight;
  const stackTop = Math.max(edgeGap, (height - stackHeight) / 2);
  const videoRect = {
    left: (width - video.width) / 2,
    top: stackTop,
    width: video.width,
    height: video.height,
  };

  const widget = {
    x: videoRect.left + videoRect.width / 2,
    y: videoRect.top + videoRect.height + edgeGap + body / 2,
  };

  const traceRect = traceHeight > 0 ? {
    left: (width - traceWidth) / 2,
    top: widget.y + body / 2 + traceGap,
    width: traceWidth,
    height: traceHeight,
  } : undefined;

  return { videoRect, widget, widgetSize: body, traceRect, placement: "below" };
}

export function experimentFilename(sessionId, wallClock = new Date()) {
  const timestamp = wallClock.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `affect-tracker-experiment-${sessionId}-${timestamp}.csv`;
}
