const YOUTUBE_IFRAME_API_URL = "https://www.youtube.com/iframe_api";
export const YOUTUBE_PREFLIGHT_MAX_AGE_MS = 5 * 60_000;

const apiPromises = new WeakMap();

export class ResearchYouTubeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ResearchYouTubeError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ResearchYouTubeError(code, message, options);
}

function playerError(errorCode) {
  const code = Number(errorCode);
  const messages = {
    2: "YouTube rejected the video ID or player parameters.",
    5: "The YouTube HTML5 player could not play this video.",
    100: "This YouTube video is unavailable, private, or removed.",
    101: "The video owner does not allow this YouTube video to be embedded.",
    150: "The video owner does not allow this YouTube video to be embedded.",
    153: "YouTube rejected playback because the request did not provide an accepted Referer or API client identity (error 153).",
  };
  return new ResearchYouTubeError(
    `youtube-player-${Number.isFinite(code) ? code : "unknown"}`,
    messages[code] ?? `The YouTube player failed with error ${Number.isFinite(code) ? code : "unknown"}.`,
  );
}

export function normalizeYouTubePlayerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("youtube-origin", "The YouTube player requires an absolute browser origin.");
  }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.origin === "null") {
    fail("youtube-origin", "The YouTube player requires an HTTP or HTTPS browser origin.");
  }
  return parsed.origin;
}

export function youtubePlayerParameters(origin) {
  return Object.freeze({
    autoplay: 0,
    controls: 1,
    enablejsapi: 1,
    origin: normalizeYouTubePlayerOrigin(origin),
    playsinline: 1,
  });
}

export function loadYouTubeIframeApi({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  timeoutMs = 15_000,
} = {}) {
  if (!windowObject || !documentObject) {
    return Promise.reject(new ResearchYouTubeError("youtube-api-unavailable", "The YouTube player API is unavailable in this context."));
  }
  if (windowObject.navigator?.onLine === false) {
    return Promise.reject(new ResearchYouTubeError("youtube-offline", "YouTube preflight requires an online connection."));
  }
  if (typeof windowObject.YT?.Player === "function") return Promise.resolve(windowObject.YT);
  if (apiPromises.has(windowObject)) return apiPromises.get(windowObject);

  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const priorReady = windowObject.onYouTubeIframeAPIReady;
    const timeout = windowObject.setTimeout(() => {
      settleReject(new ResearchYouTubeError("youtube-api-timeout", "The YouTube player API did not become ready before the preflight deadline."));
    }, timeoutMs);
    const settleResolve = () => {
      if (settled) return;
      if (typeof windowObject.YT?.Player !== "function") {
        settleReject(new ResearchYouTubeError("youtube-api-invalid", "The YouTube player API loaded without a usable Player implementation."));
        return;
      }
      settled = true;
      windowObject.clearTimeout(timeout);
      resolve(windowObject.YT);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      windowObject.clearTimeout(timeout);
      apiPromises.delete(windowObject);
      reject(error);
    };

    windowObject.onYouTubeIframeAPIReady = () => {
      try {
        if (typeof priorReady === "function") priorReady();
        settleResolve();
      } catch (error) {
        settleReject(new ResearchYouTubeError("youtube-api-callback", "The YouTube player API readiness callback failed.", { cause: error }));
      }
    };

    let script = documentObject.querySelector?.(`script[src="${YOUTUBE_IFRAME_API_URL}"]`);
    if (!script) {
      script = documentObject.createElement?.("script");
      if (!script) {
        settleReject(new ResearchYouTubeError("youtube-api-unavailable", "The YouTube player API script could not be created."));
        return;
      }
      script.src = YOUTUBE_IFRAME_API_URL;
      script.async = true;
      // Deliberately do not set referrerPolicy: YouTube error 153 is associated
      // with requests that omit the Referer/API client identity.
      documentObject.head?.append?.(script);
    }
    script.addEventListener?.("error", () => {
      settleReject(new ResearchYouTubeError("youtube-api-load", "The YouTube player API could not be loaded. Check the network, content policy, and blocking extensions."));
    }, { once: true });
  });
  apiPromises.set(windowObject, promise);
  return promise;
}

function stateName(code, states = {}) {
  const names = new Map([
    [states.UNSTARTED ?? -1, "unstarted"],
    [states.ENDED ?? 0, "ended"],
    [states.PLAYING ?? 1, "playing"],
    [states.PAUSED ?? 2, "paused"],
    [states.BUFFERING ?? 3, "buffering"],
    [states.CUED ?? 5, "cued"],
  ]);
  return names.get(code) ?? "unknown";
}

function observedMetadata(player, videoId) {
  const durationSeconds = Number(player?.getDuration?.());
  const videoData = player?.getVideoData?.() ?? {};
  const title = typeof videoData.title === "string" ? videoData.title.trim() : "";
  const observedVideoId = typeof videoData.video_id === "string" && videoData.video_id
    ? videoData.video_id
    : videoId;
  if (!(durationSeconds > 0) || !Number.isFinite(durationSeconds) || !title || observedVideoId !== videoId) return null;
  return Object.freeze({
    videoId,
    observedTitle: title.slice(0, 200),
    observedDurationMs: Math.round(durationSeconds * 1_000),
  });
}

export function isFreshYouTubePreflight(record, source, {
  now = Date.now(),
  maximumAgeMs = YOUTUBE_PREFLIGHT_MAX_AGE_MS,
} = {}) {
  if (!record || !source || source.kind !== "youtube") return false;
  return record.operational === true
    && record.verification === "unverified-noncanonical"
    && record.qualificationExcluded === true
    && record.sha256 === null
    && record.videoId === source.videoId
    && record.url === source.url
    && record.observedTitle === source.observedTitle
    && record.observedDurationMs === source.observedDurationMs
    && Number.isFinite(record.preflightedAtEpochMs)
    && now >= record.preflightedAtEpochMs
    && now - record.preflightedAtEpochMs <= maximumAgeMs;
}

export class YouTubeIframePlayerAdapter extends EventTarget {
  constructor(container, {
    origin = globalThis.location?.origin,
    apiLoader = loadYouTubeIframeApi,
    now = () => Date.now(),
    setTimer = globalThis.setTimeout?.bind(globalThis),
    clearTimer = globalThis.clearTimeout?.bind(globalThis),
    metadataTimeoutMs = 15_000,
  } = {}) {
    super();
    if (!container) throw new TypeError("A YouTube player container is required.");
    if (typeof apiLoader !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("The YouTube adapter requires loader and timer functions.");
    }
    this.container = container;
    this.origin = normalizeYouTubePlayerOrigin(origin);
    this.apiLoader = apiLoader;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.metadataTimeoutMs = metadataTimeoutMs;
    this.player = null;
    this.playerTarget = null;
    this.videoId = null;
    this.lastError = null;
    this.lastState = "unstarted";
    this.pendingStateWaits = new Set();
  }

  async prepare(videoId) {
    if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{6,32}$/u.test(videoId)) {
      fail("youtube-video-id", "The YouTube video ID is invalid.");
    }
    this.destroyPlayer();
    this.videoId = videoId;
    this.lastError = null;
    const YT = await this.apiLoader();
    if (typeof YT?.Player !== "function") fail("youtube-api-invalid", "The YouTube player API has no Player constructor.");
    const ownerDocument = this.container.ownerDocument;
    if (ownerDocument?.createElement && this.container.append) {
      const mount = ownerDocument.createElement("div");
      mount.className = "youtube-player-mount";
      this.container.replaceChildren?.();
      this.container.append(mount);
      this.playerTarget = mount;
    } else {
      this.playerTarget = this.container;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = this.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(new ResearchYouTubeError("youtube-player-ready-timeout", "The YouTube player did not become ready before the preflight deadline."));
      }, this.metadataTimeoutMs);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timeout);
        callback(value);
      };
      const options = {
        width: "640",
        height: "360",
        videoId,
        playerVars: youtubePlayerParameters(this.origin),
        events: {
          onReady: (event) => {
            this.player = event?.target ?? this.player;
            this.player?.cueVideoById?.(videoId);
            finish(resolve);
          },
          onStateChange: (event) => this.#onStateChange(event, YT.PlayerState),
          onError: (event) => {
            const error = playerError(event?.data);
            this.#onError(error);
            finish(reject, error);
          },
        },
      };
      try {
        const player = new YT.Player(this.playerTarget, options);
        if (!this.player) this.player = player;
      } catch (error) {
        finish(reject, new ResearchYouTubeError("youtube-player-create", "The YouTube player could not be created.", { cause: error }));
      }
    });
    return this.#waitForMetadata();
  }

  async preflight({ videoId, url }) {
    const metadata = await this.prepare(videoId);
    const record = Object.freeze({
      ...metadata,
      url,
      operational: true,
      verification: "unverified-noncanonical",
      qualificationExcluded: true,
      sha256: null,
      preflightedAtEpochMs: this.now(),
    });
    this.dispatchEvent(new CustomEvent("preflight", { detail: record }));
    return record;
  }

  playFromGesture({ timeoutMs = 15_000 } = {}) {
    if (!this.player || !this.videoId) return Promise.reject(new ResearchYouTubeError("youtube-not-prepared", "Prepare the YouTube stimulus before playback."));
    const wait = this.#waitForState("playing", timeoutMs);
    try {
      this.player.playVideo();
    } catch (error) {
      const wrapped = new ResearchYouTubeError("youtube-play", "The YouTube player could not start from this gesture.", { cause: error });
      this.#rejectStateWaits(wrapped);
      return Promise.reject(wrapped);
    }
    return wait;
  }

  pause() {
    this.player?.pauseVideo?.();
  }

  stop() {
    this.player?.stopVideo?.();
  }

  currentTimeMs() {
    const seconds = Number(this.player?.getCurrentTime?.());
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0;
  }

  destroy() {
    this.destroyPlayer();
    this.videoId = null;
    this.lastError = null;
    this.lastState = "unstarted";
  }

  destroyPlayer() {
    this.#rejectStateWaits(new ResearchYouTubeError("youtube-player-replaced", "The YouTube player was replaced before reaching the requested state."));
    this.player?.destroy?.();
    this.player = null;
    this.playerTarget = null;
    this.container.replaceChildren?.();
  }

  async #waitForMetadata() {
    const startedAt = this.now();
    while (this.now() - startedAt <= this.metadataTimeoutMs) {
      if (this.lastError) throw this.lastError;
      const metadata = observedMetadata(this.player, this.videoId);
      if (metadata) return metadata;
      await new Promise((resolve) => this.setTimer(resolve, 50));
    }
    fail("youtube-metadata-timeout", "YouTube did not provide a title and positive complete-video duration before the preflight deadline.");
  }

  #waitForState(expected, timeoutMs) {
    if (this.lastState === expected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { expected, resolve, reject, timer: null };
      waiter.timer = this.setTimer(() => {
        this.pendingStateWaits.delete(waiter);
        reject(new ResearchYouTubeError("youtube-state-timeout", `The YouTube player did not reach ${expected} before the playback deadline.`));
      }, timeoutMs);
      this.pendingStateWaits.add(waiter);
    });
  }

  #onStateChange(event, states) {
    const name = stateName(event?.data, states);
    this.lastState = name;
    for (const waiter of [...this.pendingStateWaits]) {
      if (waiter.expected !== name) continue;
      this.pendingStateWaits.delete(waiter);
      this.clearTimer(waiter.timer);
      waiter.resolve();
    }
    this.dispatchEvent(new CustomEvent("statechange", {
      detail: Object.freeze({
        code: event?.data,
        state: name,
        videoId: this.videoId,
        currentTimeMs: this.currentTimeMs(),
      }),
    }));
  }

  #onError(error) {
    this.lastError = error;
    this.#rejectStateWaits(error);
    this.dispatchEvent(new CustomEvent("runtimeerror", { detail: Object.freeze({ error }) }));
  }

  #rejectStateWaits(error) {
    for (const waiter of this.pendingStateWaits) {
      this.clearTimer(waiter.timer);
      waiter.reject(error);
    }
    this.pendingStateWaits.clear();
  }
}

export { YOUTUBE_IFRAME_API_URL, playerError as youtubePlayerError };
