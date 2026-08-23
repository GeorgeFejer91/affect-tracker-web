import {
  affectParameters,
  buildFlubberPath,
  createProfiles,
  createProjectionOffsets,
} from "./math.js";
import {
  advanceWebXrAffect,
  controllerFacingModelMatrix,
  createEquirectSphereVertices,
  matrixWithoutTranslation,
  modelMatrix,
  multiplyMatrices,
  normalizeWebhookUrl,
  readQuestControllerState,
  WEBXR_SAMPLE_INTERVAL_MS,
  webXrCsv,
} from "./webxr-study-core.js";
import {
  stimulusDurationSeconds,
  stimulusFilenameToken,
  WEBXR_STIMULI,
  webXrStimulusById,
} from "./webxr-stimuli.js";

const VIDEO_MODEL = modelMatrix(0, 1.55, -2.8, 2.4, 1.35);
const SPHERE_MODEL = modelMatrix(0, 0, 0, 1, 1);
const FLUBBER_MODEL = modelMatrix(0, 0.54, -2.38, 0.62, 0.7);
const IMMERSIVE_FLUBBER_MODEL = modelMatrix(0, -0.72, -2.2, 0.62, 0.7);
const FLUBBER_CANVAS_WIDTH = 512;
const FLUBBER_CANVAS_HEIGHT = 576;
const COUNTDOWN_MS = 3_000;

const elements = {
  canvas: document.querySelector("#xr-canvas"),
  video: document.querySelector("#study-video"),
  stimulus: document.querySelector("#stimulus-select"),
  stimulusName: document.querySelector("#stimulus-name"),
  stimulusDescription: document.querySelector("#stimulus-description"),
  stimulusMetadata: document.querySelector("#stimulus-metadata"),
  stimulusWarning: document.querySelector("#stimulus-warning"),
  webhook: document.querySelector("#webhook-url"),
  controllerFollow: document.querySelector("#controller-follow-enabled"),
  controllerFollowControls: document.querySelector("#controller-follow-controls"),
  controllerFollowHand: document.querySelector("#controller-follow-hand"),
  controllerFollowDistance: document.querySelector("#controller-follow-distance"),
  controllerFollowDistanceOutput: document.querySelector("#controller-follow-distance-output"),
  start: document.querySelector("#start-vr"),
  download: document.querySelector("#download-csv"),
  status: document.querySelector("#study-status"),
};

const state = {
  session: undefined,
  referenceSpace: undefined,
  viewerSpace: undefined,
  sessionId: "",
  webhookUrl: "",
  phase: "idle",
  countdownEndsAt: 0,
  runStartedAt: 0,
  previousFrameAt: 0,
  previousSampleAt: 0,
  targetX: 0,
  targetY: 0,
  currentX: 0,
  currentY: 0,
  phaseRadians: 0,
  stickX: 0,
  stickY: 0,
  controllerHand: "unknown",
  controllerFollowEnabled: false,
  controllerFollowHand: "right",
  controllerFollowDistance: 0.18,
  controllerTracking: false,
  controllerRigModel: undefined,
  resetPressed: false,
  pausePressed: false,
  paused: false,
  finalizing: false,
  records: [],
  lastCsv: "",
  lastFilename: "",
  stimulus: WEBXR_STIMULI[0],
};

const profiles = createProfiles();
let offsets = createProjectionOffsets("webxr-preview", profiles.waveCount);
let renderer;

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", error);
}

function applyStimulus(stimulus, updateUrl = true) {
  if (state.session) return;
  state.stimulus = stimulus;
  elements.video.pause();
  elements.video.setAttribute("src", stimulus.src);
  elements.video.load();
  elements.stimulus.value = stimulus.id;
  elements.stimulusName.textContent = stimulus.title;
  elements.stimulusDescription.textContent = stimulus.description;
  const duration = stimulusDurationSeconds(stimulus);
  const presentation = stimulus.projection === "flat" ? "flat theatre screen" : "full equirectangular 360° sphere";
  const parts = [stimulus.collection, presentation, stimulus.audio ? "with audio" : "silent"];
  if (duration) parts.push(`${duration.toFixed(2)} seconds`, `${stimulus.frameCount} frames`);
  if (stimulus.pilotValence !== undefined && stimulus.pilotArousal !== undefined) {
    parts.push(`CEAP pilot V/A ${stimulus.pilotValence.toFixed(2)} / ${stimulus.pilotArousal.toFixed(2)} (1–9)`);
  }
  elements.stimulusMetadata.textContent = parts.join(" • ");
  elements.stimulusWarning.textContent = stimulus.warning ? `Content note: ${stimulus.warning}` : "";
  elements.stimulusWarning.hidden = !stimulus.warning;
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("stimulus", stimulus.id);
    history.replaceState(null, "", url);
  }
}

function populateStimulusLibrary() {
  for (const stimulus of WEBXR_STIMULI) {
    const option = document.createElement("option");
    option.value = stimulus.id;
    option.textContent = stimulus.optionLabel;
    elements.stimulus.append(option);
  }
  const requested = new URL(window.location.href).searchParams.get("stimulus");
  applyStimulus(webXrStimulusById(requested), false);
}

function rounded(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : "";
}

function record(recordType, event = "", detail = "") {
  const now = performance.now();
  state.records.push({
    session_id: state.sessionId,
    stimulus_id: state.stimulus.id,
    stimulus_title: state.stimulus.title,
    stimulus_collection: state.stimulus.collection,
    stimulus_projection: state.stimulus.projection,
    stimulus_source_start_seconds: state.stimulus.sourceStartSeconds,
    stimulus_frame_count: state.stimulus.frameCount,
    stimulus_pilot_valence: state.stimulus.pilotValence,
    stimulus_pilot_arousal: state.stimulus.pilotArousal,
    record_type: recordType,
    iso_time: new Date().toISOString(),
    monotonic_ms: rounded(now, 3),
    elapsed_ms: state.runStartedAt ? rounded(now - state.runStartedAt, 3) : 0,
    video_time_seconds: rounded(elements.video.currentTime, 3),
    current_valence: rounded(state.currentX),
    current_arousal: rounded(state.currentY),
    target_valence: rounded(state.targetX),
    target_arousal: rounded(state.targetY),
    stick_x: rounded(state.stickX),
    stick_y: rounded(state.stickY),
    controller_hand: state.controllerHand,
    flubber_controller_follow: state.controllerFollowEnabled,
    flubber_follow_hand: state.controllerFollowEnabled ? state.controllerFollowHand : "",
    flubber_follow_distance_m: state.controllerFollowEnabled ? rounded(state.controllerFollowDistance, 2) : "",
    flubber_tracking: state.controllerFollowEnabled ? state.controllerTracking : "",
    paused: state.paused,
    event,
    detail,
  });
}

function sessionFilename(partial) {
  const date = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  return `affect-webxr-${stimulusFilenameToken(state.stimulus)}-${date}${partial ? "-partial" : ""}.csv`;
}

function downloadLastCsv() {
  if (!state.lastCsv) return;
  const url = URL.createObjectURL(new Blob([state.lastCsv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = state.lastFilename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

async function forwardCsv(csv) {
  if (!state.webhookUrl) return "No webhook configured; CSV stayed on this headset.";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(state.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "text/csv;charset=utf-8" },
      body: csv,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
    return "CSV delivered to the configured webhook.";
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Webhook timed out after 15 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function finalize(reason, partial = false, autoDownload = true) {
  if (state.finalizing || state.phase === "idle") return;
  state.finalizing = true;
  state.phase = "finished";
  elements.video.pause();
  record("event", partial ? "study-aborted" : "study-complete", reason);
  state.lastCsv = webXrCsv(state.records);
  state.lastFilename = sessionFilename(partial);
  elements.download.hidden = false;
  elements.start.disabled = true;
  elements.start.textContent = "Run another study";
  setStatus(`${partial ? "Study ended early" : "Study complete"}. CSV ready to save.`);
  if (autoDownload) downloadLastCsv();

  let delivery = "";
  try {
    delivery = await forwardCsv(state.lastCsv);
  } catch (error) {
    delivery = `Webhook delivery failed: ${error?.message ?? String(error)} The CSV is still available below.`;
  }
  setStatus(`${partial ? "Study ended early" : "Study complete"}. ${delivery}`,
    delivery.startsWith("Webhook delivery failed"));
  state.finalizing = false;
  if (!state.session) elements.start.disabled = false;
}

function resetAffect() {
  state.targetX = 0;
  state.targetY = 0;
  state.currentX = 0;
  state.currentY = 0;
  record("event", "reset", "left-x");
}

async function togglePause() {
  if (state.phase !== "running") return;
  state.paused = !state.paused;
  if (state.paused) elements.video.pause();
  else await elements.video.play();
  record("event", state.paused ? "pause" : "resume", "left-y");
}

function readControllers() {
  const input = readQuestControllerState(state.session?.inputSources);
  state.stickX = input.x;
  state.stickY = input.y;
  state.controllerHand = input.hand;
  if (input.reset && !state.resetPressed) resetAffect();
  if (input.pause && !state.pausePressed) togglePause().catch((error) => {
    setStatus(`Playback could not resume: ${error?.message ?? String(error)}`, true);
  });
  state.resetPressed = input.reset;
  state.pausePressed = input.pause;
  return input;
}

function updateControllerRig(frame, viewerPose) {
  if (!state.controllerFollowEnabled) return;
  const source = Array.from(state.session?.inputSources ?? []).find(
    (candidate) => candidate.handedness === state.controllerFollowHand && candidate.gripSpace,
  );
  const gripPose = source ? frame.getPose(source.gripSpace, state.referenceSpace) : undefined;
  const tracked = Boolean(gripPose && viewerPose?.transform?.position);
  if (tracked) {
    state.controllerRigModel = controllerFacingModelMatrix(
      gripPose.transform.position,
      viewerPose.transform.position,
      state.controllerFollowDistance,
      0.62,
      0.7,
    );
  }
  if (tracked !== state.controllerTracking) {
    state.controllerTracking = tracked;
    record("event", tracked ? "controller-tracking-acquired" : "controller-tracking-lost", state.controllerFollowHand);
  }
}

async function beginPlayback() {
  if (state.phase !== "countdown") return;
  state.phase = "running";
  state.runStartedAt = performance.now();
  state.previousSampleAt = state.runStartedAt;
  state.paused = false;
  elements.video.currentTime = 0;
  try {
    await elements.video.play();
    record("event", "video-start", state.stimulus.id);
  } catch (error) {
    finalize(`video-play-failed:${error?.name ?? "error"}`, true, false).catch(() => {});
    state.session?.end().then(downloadLastCsv).catch(() => downloadLastCsv());
  }
}

function updateStudy(now, deltaSeconds) {
  const input = readControllers();
  if (state.phase === "countdown" && now >= state.countdownEndsAt) beginPlayback();
  if (state.phase === "running" && !state.paused) {
    const next = advanceWebXrAffect(state, input, deltaSeconds);
    Object.assign(state, next);
    const frequency = affectParameters(state.currentX, state.currentY).frequency;
    state.phaseRadians = (state.phaseRadians + deltaSeconds * Math.PI * 2 * frequency) % (Math.PI * 2);
    if (now - state.previousSampleAt >= WEBXR_SAMPLE_INTERVAL_MS) {
      state.previousSampleAt += WEBXR_SAMPLE_INTERVAL_MS;
      if (now - state.previousSampleAt >= WEBXR_SAMPLE_INTERVAL_MS) state.previousSampleAt = now;
      record("sample");
    }
  }
}

function renderFrame(now, frame) {
  const session = frame.session;
  const pose = frame.getViewerPose(state.referenceSpace);
  const viewerPose = frame.getViewerPose(state.viewerSpace);
  const deltaSeconds = state.previousFrameAt ? Math.min(0.05, (now - state.previousFrameAt) / 1_000) : 0;
  state.previousFrameAt = now;
  updateStudy(now, deltaSeconds);
  updateControllerRig(frame, pose);
  if (pose) renderer.render(session, pose, viewerPose, state);
  if (state.phase !== "finished") session.requestAnimationFrame(renderFrame);
}

async function startStudy() {
  if (state.session) return;
  let webhookUrl;
  try {
    webhookUrl = normalizeWebhookUrl(elements.webhook.value);
  } catch (error) {
    setStatus(error.message, true);
    elements.webhook.focus();
    return;
  }

  elements.start.disabled = true;
  elements.stimulus.disabled = true;
  elements.controllerFollow.disabled = true;
  elements.controllerFollowHand.disabled = true;
  elements.controllerFollowDistance.disabled = true;
  elements.download.hidden = true;
  setStatus(`Loading ${state.stimulus.title} and requesting immersive access…`);
  let requestedSession;
  try {
    const sessionPromise = navigator.xr.requestSession("immersive-vr", {
      requiredFeatures: ["local-floor"],
    });
    const mediaUnlock = elements.video.play()
        .then(() => { elements.video.pause(); elements.video.currentTime = 0; })
        .catch(() => {});
    const session = await sessionPromise;
    requestedSession = session;
    await mediaUnlock;
    if (!renderer) renderer = createRenderer(elements.canvas, elements.video);
    const layer = new XRWebGLLayer(session, renderer.gl, { alpha: false, antialias: true });
    session.updateRenderState({ baseLayer: layer });
    const [referenceSpace, viewerSpace] = await Promise.all([
      session.requestReferenceSpace("local-floor"),
      session.requestReferenceSpace("viewer"),
    ]);

    state.session = session;
    state.referenceSpace = referenceSpace;
    state.viewerSpace = viewerSpace;
    state.sessionId = crypto.randomUUID?.() ?? `webxr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.webhookUrl = webhookUrl;
    state.controllerFollowEnabled = elements.controllerFollow.checked;
    state.controllerFollowHand = elements.controllerFollowHand.value;
    state.controllerFollowDistance = Number(elements.controllerFollowDistance.value);
    state.controllerTracking = false;
    state.controllerRigModel = undefined;
    state.phase = "countdown";
    state.countdownEndsAt = performance.now() + COUNTDOWN_MS;
    state.runStartedAt = 0;
    state.previousFrameAt = 0;
    state.previousSampleAt = 0;
    state.targetX = 0;
    state.targetY = 0;
    state.currentX = 0;
    state.currentY = 0;
    state.phaseRadians = 0;
    state.stickX = 0;
    state.stickY = 0;
    state.controllerHand = "unknown";
    state.resetPressed = false;
    state.pausePressed = false;
    state.paused = false;
    state.finalizing = false;
    state.records = [];
    offsets = createProjectionOffsets(state.sessionId, profiles.waveCount);
    record("event", "xr-session-start", `immersive-vr:${state.stimulus.id}:${state.stimulus.projection}`);
    session.addEventListener("end", () => {
      const wasFinished = state.phase === "finished";
      const finalizePromise = wasFinished ? Promise.resolve() : finalize("xr-session-ended", true);
      finalizePromise.finally(() => {
        state.session = undefined;
        state.referenceSpace = undefined;
        state.viewerSpace = undefined;
        elements.stimulus.disabled = false;
        elements.controllerFollow.disabled = false;
        elements.controllerFollowHand.disabled = !elements.controllerFollow.checked;
        elements.controllerFollowDistance.disabled = !elements.controllerFollow.checked;
        if (!state.finalizing) elements.start.disabled = false;
      });
    }, { once: true });
    elements.video.onended = () => {
      finalize("video-ended", false, false).catch(() => {});
      session.end().then(downloadLastCsv).catch(() => downloadLastCsv());
    };
    session.requestAnimationFrame(renderFrame);
    setStatus(`${state.stimulus.title} is running. Use the right thumbstick to rate affect.`);
  } catch (error) {
    requestedSession?.end().catch(() => {});
    elements.start.disabled = false;
    elements.stimulus.disabled = false;
    elements.controllerFollow.disabled = false;
    elements.controllerFollowHand.disabled = !elements.controllerFollow.checked;
    elements.controllerFollowDistance.disabled = !elements.controllerFollow.checked;
    setStatus(
      error?.name === "NotSupportedError"
        ? "This browser could not start immersive VR. Open this page in Meta Quest Browser."
        : `Immersive mode could not start: ${error?.message ?? String(error)}`,
      true,
    );
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader compilation failed.");
  }
  return shader;
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return texture;
}

function createRenderer(canvas, video) {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: true, xrCompatible: true });
  if (!gl) throw new Error("WebGL is unavailable in this browser.");
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec2 a_tex_coord;
    uniform mat4 u_mvp;
    varying vec2 v_tex_coord;
    void main() {
      gl_Position = u_mvp * vec4(a_position, 1.0);
      v_tex_coord = a_tex_coord;
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_tex_coord;
    void main() { gl_FragColor = texture2D(u_texture, v_tex_coord); }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "WebGL program linking failed.");
  }

  const quadVertices = new Float32Array([
    -0.5, -0.5, 0, 0, 0,
     0.5, -0.5, 0, 1, 0,
    -0.5,  0.5, 0, 0, 1,
    -0.5,  0.5, 0, 0, 1,
     0.5, -0.5, 0, 1, 0,
     0.5,  0.5, 0, 1, 1,
  ]);
  const sphereVertices = createEquirectSphereVertices();
  const createGeometryBuffer = (vertices) => {
    const geometryBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, geometryBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return geometryBuffer;
  };
  const quadBuffer = createGeometryBuffer(quadVertices);
  const sphereBuffer = createGeometryBuffer(sphereVertices);
  const sphereViewMatrices = [new Float32Array(16), new Float32Array(16)];
  const position = gl.getAttribLocation(program, "a_position");
  const texCoord = gl.getAttribLocation(program, "a_tex_coord");
  const mvp = gl.getUniformLocation(program, "u_mvp");
  const videoTexture = createTexture(gl);
  const flubberTexture = createTexture(gl);
  const flubberCanvas = document.createElement("canvas");
  flubberCanvas.width = FLUBBER_CANVAS_WIDTH;
  flubberCanvas.height = FLUBBER_CANVAS_HEIGHT;
  const context = flubberCanvas.getContext("2d");

  function uploadVideo() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  function uploadFlubber(study) {
    const countdown = study.phase === "countdown"
      ? Math.max(1, Math.ceil((study.countdownEndsAt - performance.now()) / 1_000))
      : undefined;
    const rendered = buildFlubberPath({
      profiles,
      offsets,
      x: study.currentX,
      y: study.currentY,
      phase: study.phaseRadians,
    });
    context.clearRect(0, 0, flubberCanvas.width, flubberCanvas.height);
    context.save();
    context.translate(FLUBBER_CANVAS_WIDTH / 2, 238);
    context.scale(165, -165);
    const path = new Path2D(rendered.path);
    context.fillStyle = rendered.color;
    context.shadowColor = rendered.color;
    context.shadowBlur = 0.16;
    context.fill(path);
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(255,255,255,0.9)";
    context.lineWidth = 0.025;
    context.stroke(path);
    context.restore();
    context.fillStyle = "rgba(255,255,255,0.96)";
    context.textAlign = "center";
    context.font = "700 30px system-ui, sans-serif";
    context.fillText(`X ${study.currentX >= 0 ? "+" : ""}${study.currentX.toFixed(3)}   Y ${study.currentY >= 0 ? "+" : ""}${study.currentY.toFixed(3)}`, 256, 525);
    context.font = "600 19px system-ui, sans-serif";
    context.fillStyle = "rgba(220,230,240,0.92)";
    context.fillText(study.paused ? "PAUSED — press Y to resume" : "Right stick: valence × arousal", 256, 558);
    if (countdown !== undefined) {
      context.fillStyle = "rgba(0,0,0,0.7)";
      context.beginPath();
      context.arc(256, 238, 86, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = "800 112px system-ui, sans-serif";
      context.fillText(String(countdown), 256, 276);
    }
    gl.bindTexture(gl.TEXTURE_2D, flubberTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flubberCanvas);
  }

  function bindGeometry(buffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(texCoord);
    gl.vertexAttribPointer(texCoord, 2, gl.FLOAT, false, 20, 12);
  }

  function draw(texture, projection, view, model, transparent, geometryBuffer, vertexCount) {
    const viewModel = multiplyMatrices(view, model);
    const projectionViewModel = multiplyMatrices(projection, viewModel);
    gl.uniformMatrix4fv(mvp, false, projectionViewModel);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    bindGeometry(geometryBuffer);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  return {
    gl,
    render(session, pose, viewerPose, study) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, session.renderState.baseLayer.framebuffer);
      gl.clearColor(0.008, 0.012, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      uploadVideo();
      uploadFlubber(study);
      for (let viewIndex = 0; viewIndex < pose.views.length; viewIndex += 1) {
        const view = pose.views[viewIndex];
        const viewport = session.renderState.baseLayer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        if (study.stimulus.projection === "equirectangular-360") {
          draw(
            videoTexture,
            view.projectionMatrix,
            matrixWithoutTranslation(view.transform.inverse.matrix, sphereViewMatrices[viewIndex]),
            SPHERE_MODEL,
            false,
            sphereBuffer,
            sphereVertices.length / 5,
          );
          const controllerRigged = study.controllerFollowEnabled && study.controllerRigModel;
          const hudView = controllerRigged ? view : (viewerPose?.views?.[viewIndex] ?? view);
          draw(
            flubberTexture,
            hudView.projectionMatrix,
            hudView.transform.inverse.matrix,
            controllerRigged ? study.controllerRigModel : IMMERSIVE_FLUBBER_MODEL,
            true,
            quadBuffer,
            6,
          );
        } else {
          draw(
            videoTexture,
            view.projectionMatrix,
            view.transform.inverse.matrix,
            VIDEO_MODEL,
            false,
            quadBuffer,
            6,
          );
          draw(
            flubberTexture,
            view.projectionMatrix,
            view.transform.inverse.matrix,
            study.controllerFollowEnabled && study.controllerRigModel ? study.controllerRigModel : FLUBBER_MODEL,
            true,
            quadBuffer,
            6,
          );
        }
      }
    },
  };
}

async function initialize() {
  elements.start.disabled = true;
  if (!navigator.xr) {
    setStatus("WebXR is unavailable. Open this page in Meta Quest Browser.", true);
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported("immersive-vr");
    elements.start.disabled = !supported;
    setStatus(
      supported
        ? "Ready. Put on the headset, then enter VR."
        : "This browser does not provide immersive VR. Open the page in Meta Quest Browser.",
      !supported,
    );
  } catch (error) {
    setStatus(`WebXR capability check failed: ${error?.message ?? String(error)}`, true);
  }
}

elements.start.addEventListener("click", startStudy);
elements.download.addEventListener("click", downloadLastCsv);
elements.stimulus.addEventListener("change", () => applyStimulus(webXrStimulusById(elements.stimulus.value)));
function updateRiggingControls() {
  const enabled = elements.controllerFollow.checked;
  elements.controllerFollowHand.disabled = !enabled;
  elements.controllerFollowDistance.disabled = !enabled;
  elements.controllerFollowControls.classList.toggle("is-disabled", !enabled);
  elements.controllerFollowDistanceOutput.value = Number(elements.controllerFollowDistance.value).toFixed(2);
}
elements.controllerFollow.addEventListener("change", updateRiggingControls);
elements.controllerFollowDistance.addEventListener("input", updateRiggingControls);
populateStimulusLibrary();
updateRiggingControls();
initialize();
