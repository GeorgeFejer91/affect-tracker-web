import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ResearchYouTubeError,
  YOUTUBE_IFRAME_API_URL,
  YOUTUBE_PREFLIGHT_MAX_AGE_MS,
  YouTubeIframePlayerAdapter,
  isFreshYouTubePreflight,
  loadYouTubeIframeApi,
  youtubePlayerError,
  youtubePlayerParameters,
} from "../site/src/research/youtube-player.js";
import { assertFreshYouTubePreflights } from "../site/src/research/runtime-bridge.js";

const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function createFakeYouTube({ title = "Observed title", durationSeconds = 123.456 } = {}) {
  const instances = [];
  const PlayerState = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  class Player {
    constructor(container, options) {
      this.container = container;
      this.options = options;
      this.videoId = options.videoId;
      this.currentTime = 0;
      this.destroyed = false;
      instances.push(this);
      queueMicrotask(() => options.events.onReady({ target: this }));
    }

    cueVideoById(videoId) {
      this.videoId = videoId;
      this.options.events.onStateChange({ data: PlayerState.CUED, target: this });
    }

    playVideo() {
      this.options.events.onStateChange({ data: PlayerState.PLAYING, target: this });
    }

    pauseVideo() {
      this.options.events.onStateChange({ data: PlayerState.PAUSED, target: this });
    }

    stopVideo() {
      this.options.events.onStateChange({ data: PlayerState.ENDED, target: this });
    }

    getDuration() { return durationSeconds; }
    getCurrentTime() { return this.currentTime; }
    getVideoData() { return { video_id: this.videoId, title }; }
    destroy() { this.destroyed = true; }
    emit(state) { this.options.events.onStateChange({ data: state, target: this }); }
    fail(code) { this.options.events.onError({ data: code, target: this }); }
  }
  return { YT: { Player, PlayerState }, instances, PlayerState };
}

test("the official IFrame API loads lazily without suppressing Referer", async () => {
  class FakeScript extends EventTarget {}
  const scripts = [];
  const windowObject = {
    navigator: { onLine: true },
    setTimeout,
    clearTimeout,
    YT: undefined,
  };
  const documentObject = {
    querySelector: () => null,
    createElement(name) {
      assert.equal(name, "script");
      return new FakeScript();
    },
    head: {
      append(script) { scripts.push(script); },
    },
  };

  assert.equal(scripts.length, 0, "importing the adapter does not contact YouTube");
  const pending = loadYouTubeIframeApi({ windowObject, documentObject });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, YOUTUBE_IFRAME_API_URL);
  assert.equal(scripts[0].async, true);
  assert.equal(scripts[0].referrerPolicy, undefined);
  windowObject.YT = createFakeYouTube().YT;
  windowObject.onYouTubeIframeAPIReady();
  assert.equal(await pending, windowObject.YT);
});

test("offline API preflight fails before creating a remote script", async () => {
  let created = false;
  await assert.rejects(loadYouTubeIframeApi({
    windowObject: { navigator: { onLine: false } },
    documentObject: { createElement() { created = true; } },
  }), (error) => error instanceof ResearchYouTubeError && error.code === "youtube-offline");
  assert.equal(created, false);
});

test("player parameters retain controls, JavaScript API, and exact origin", () => {
  assert.deepEqual(youtubePlayerParameters("https://example.test/path"), {
    autoplay: 0,
    controls: 1,
    enablejsapi: 1,
    origin: "https://example.test",
    playsinline: 1,
  });
  assert.throws(() => youtubePlayerParameters("file:///study.html"), /HTTP or HTTPS browser origin/u);
});

test("explicit preflight records observed metadata without inventing byte identity", async () => {
  const fake = createFakeYouTube();
  const states = [];
  const adapter = new YouTubeIframePlayerAdapter({}, {
    origin: "https://example.test",
    apiLoader: async () => fake.YT,
    now: () => 50_000,
  });
  adapter.addEventListener("statechange", ({ detail }) => states.push(detail.state));
  const record = await adapter.preflight({ videoId: VIDEO_ID, url: VIDEO_URL });

  assert.deepEqual(record, {
    videoId: VIDEO_ID,
    observedTitle: "Observed title",
    observedDurationMs: 123_456,
    url: VIDEO_URL,
    operational: true,
    verification: "unverified-noncanonical",
    qualificationExcluded: true,
    sha256: null,
    preflightedAtEpochMs: 50_000,
  });
  assert.ok(states.includes("cued"));
  assert.equal(fake.instances[0].options.width, "640");
  assert.equal(fake.instances[0].options.height, "360");
  assert.equal(fake.instances[0].options.playerVars.origin, "https://example.test");
  assert.equal(fake.instances[0].options.playerVars.controls, 1);
});

test("freshness binds the exact URL, video, observed metadata, and current page session", async () => {
  const fake = createFakeYouTube();
  const adapter = new YouTubeIframePlayerAdapter({}, {
    origin: "https://example.test",
    apiLoader: async () => fake.YT,
    now: () => 100_000,
  });
  const record = await adapter.preflight({ videoId: VIDEO_ID, url: VIDEO_URL });
  const source = {
    kind: "youtube",
    url: VIDEO_URL,
    videoId: VIDEO_ID,
    observedTitle: record.observedTitle,
    observedDurationMs: record.observedDurationMs,
  };
  assert.equal(isFreshYouTubePreflight(record, source, { now: 100_001 }), true);
  assert.equal(isFreshYouTubePreflight(record, { ...source, observedDurationMs: 10 }, { now: 100_001 }), false);
  assert.equal(isFreshYouTubePreflight(record, source, { now: 100_000 + YOUTUBE_PREFLIGHT_MAX_AGE_MS + 1 }), false);
});

test("browser runtime refuses missing or stale page-session preflights", () => {
  const source = {
    kind: "youtube",
    url: VIDEO_URL,
    videoId: VIDEO_ID,
    observedTitle: "Observed title",
    observedDurationMs: 123_456,
  };
  const plan = { stimuli: [{ stimulusId: "youtube-1", title: "Observed title", source }] };
  const record = {
    ...source,
    operational: true,
    verification: "unverified-noncanonical",
    qualificationExcluded: true,
    sha256: null,
    preflightedAtEpochMs: 20_000,
  };
  assert.equal(assertFreshYouTubePreflights(plan, () => record, { now: 20_001 }), true);
  assert.throws(() => assertFreshYouTubePreflights(plan, () => null, { now: 20_001 }), /fresh successful visible-player preflight/u);
  assert.throws(() => assertFreshYouTubePreflights(plan, () => record, {
    now: 20_000 + YOUTUBE_PREFLIGHT_MAX_AGE_MS + 1,
  }), /fresh successful visible-player preflight/u);
});

test("state events expose playing, buffering, pause, and end lifecycle deterministically", async () => {
  const fake = createFakeYouTube();
  const adapter = new YouTubeIframePlayerAdapter({}, {
    origin: "https://example.test",
    apiLoader: async () => fake.YT,
  });
  const states = [];
  adapter.addEventListener("statechange", ({ detail }) => states.push(detail.state));
  await adapter.prepare(VIDEO_ID);
  const playing = adapter.playFromGesture();
  await playing;
  fake.instances[0].currentTime = 4.25;
  fake.instances[0].emit(fake.PlayerState.BUFFERING);
  adapter.pause();
  fake.instances[0].emit(fake.PlayerState.PLAYING);
  fake.instances[0].emit(fake.PlayerState.ENDED);
  assert.equal(adapter.currentTimeMs(), 4_250);
  assert.deepEqual(states.slice(-5), ["playing", "buffering", "paused", "playing", "ended"]);
});

test("embed-disabled and Referer/API identity failures remain explicit", async () => {
  assert.match(youtubePlayerError(150).message, /does not allow.*embedded/u);
  assert.match(youtubePlayerError(153).message, /Referer or API client identity.*153/u);

  const fake = createFakeYouTube();
  const adapter = new YouTubeIframePlayerAdapter({}, {
    origin: "https://example.test",
    apiLoader: async () => fake.YT,
  });
  await adapter.prepare(VIDEO_ID);
  const failed = new Promise((resolve) => adapter.addEventListener("runtimeerror", ({ detail }) => resolve(detail.error), { once: true }));
  fake.instances[0].fail(153);
  const error = await failed;
  assert.equal(error.code, "youtube-player-153");
  assert.match(error.message, /error 153/u);
});

test("UI and runtime wiring keep the player visible, adjacent, browser-only, and state-authoritative", async () => {
  const [app, runtime, css] = await Promise.all([
    readFile(new URL("../site/src/research/app.js", import.meta.url), "utf8"),
    readFile(new URL("../site/src/research/runtime-bridge.js", import.meta.url), "utf8"),
    readFile(new URL("../site/research.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /id="youtube-preflight-player"/u);
  assert.match(app, /id="run-youtube-player"/u);
  assert.ok(app.indexOf('class="stimulus-stage"') < app.indexOf('class="run-feedback-stage"'));
  assert.match(app, /surface === "browser"/u);
  assert.match(app, /Experimental YouTube is browser-only and remains blocked in Windows Tauri/u);
  assert.match(app, /getYouTubePreflight\(stimulusId\)/u);
  assert.match(runtime, /return this\.youtubeAdapter\.playFromGesture\(\)/u);
  const begin = runtime.slice(runtime.indexOf("async #beginPreparedStimulus"), runtime.indexOf("async #resolvePlayable"));
  assert.ok(begin.indexOf("await (playbackPromise ?? this.#startPreparedPlayback())") < begin.indexOf("await this.controller.startStimulus(prepared.index)"));
  for (const state of ["buffering", "playing", "paused", "ended"]) {
    assert.match(runtime, new RegExp(`detail\\?\\.state === "${state}"`, "u"));
  }
  assert.match(css, /\.youtube-player-host\s*\{[^}]*min-width:\s*200px;[^}]*min-height:\s*200px;[^}]*aspect-ratio:\s*16 \/ 9;/su);
  assert.match(css, /\.stimulus-stage \.run-youtube-player\s*\{[^}]*width:\s*100%;/su);
  const transitionStyle = css.slice(css.indexOf(".run-transition {"), css.indexOf("}", css.indexOf(".run-transition {")) + 1);
  assert.doesNotMatch(transitionStyle, /position:\s*absolute|z-index/u, "the Begin/Continue row must not cover the player");
});

test("settings file import uses bounded fatal UTF-8 and duplicate-key-safe parsing", async () => {
  const app = await readFile(new URL("../site/src/research/app.js", import.meta.url), "utf8");
  const start = app.indexOf('query("#settings-file-input")?.addEventListener');
  const end = app.indexOf("root.addEventListener(RESEARCH_UI_EVENTS.settingsLoaded", start);
  const listener = app.slice(start, end);
  assert.match(listener, /5 \* 1024 \* 1024/u);
  assert.match(listener, /new TextDecoder\("utf-8", \{ fatal: true \}\)/u);
  assert.match(listener, /parseStrictJson\(text, \{ maximumBytes \}\)/u);
  assert.doesNotMatch(listener, /JSON\.parse|file\.text\(\)/u);
  assert.match(listener, /Settings import failed:/u);
});
