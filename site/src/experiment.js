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

export function computeExperimentLayout(viewportWidth, viewportHeight, widgetSize, gap = 24) {
  const width = Math.max(1, Number(viewportWidth));
  const height = Math.max(1, Number(viewportHeight));
  const body = clamp(Number(widgetSize) || 120, 80, 640);
  const edgeGap = clamp(gap, 8, 48);

  const side = fitVideo(width - 2 * (body + edgeGap), height - 2 * edgeGap);
  const below = fitVideo(width - 2 * edgeGap, height - 2 * (body + edgeGap));
  const placement = side.width * side.height >= below.width * below.height ? "right" : "below";
  let video = placement === "right" ? side : below;

  // Retain a practical 200 px media minimum whenever the viewport makes it possible.
  if (video.width < 200) video = fitVideo(Math.max(0, width - 2 * edgeGap), Math.max(0, height - 2 * edgeGap));
  const videoRect = {
    left: (width - video.width) / 2,
    top: (height - video.height) / 2,
    width: video.width,
    height: video.height,
  };

  const radius = body / 2;
  const widget = placement === "right"
    ? {
        x: clamp(videoRect.left + videoRect.width + edgeGap + radius, radius, width - radius),
        y: height / 2,
      }
    : {
        x: width / 2,
        y: clamp(videoRect.top + videoRect.height + edgeGap + radius, radius, height - radius),
      };

  return { videoRect, widget, placement };
}

export function experimentFilename(sessionId, wallClock = new Date()) {
  const timestamp = wallClock.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return `affect-tracker-experiment-${sessionId}-${timestamp}.csv`;
}
