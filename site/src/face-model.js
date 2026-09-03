import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { buildAffecEmpiricalWeights } from "./face-affec.js";
import { buildMediapipeAtlasWeights } from "./face-mediapipe-calibration.js";
import {
  AFFECT_MATRIX_SIZE,
  affectMatrixCellFromCoordinates,
  affectMatrixCoordinate,
} from "./affect-matrix.js?v=matrix21-1";

const DEFAULT_CANVAS_SIZE = 320;
const DEFAULT_VERTICAL_FOV = 28;

export const FACE_MODEL_URL = new URL(
  "../assets/affect-face/vitruvian-head.glb",
  import.meta.url,
).href;

export const FACE_MODEL_TEXTURE_URLS = Object.freeze({
  skinBase: new URL("../assets/affect-face/skin-base.webp", import.meta.url).href,
  skinNormal: new URL("../assets/affect-face/skin-normal.webp", import.meta.url).href,
  skinRoughness: new URL("../assets/affect-face/skin-roughness.webp", import.meta.url).href,
  mouth: new URL("../assets/affect-face/mouth.webp", import.meta.url).href,
  iris: new URL("../assets/affect-face/iris.webp", import.meta.url).href,
  sclera: new URL("../assets/affect-face/sclera.webp", import.meta.url).href,
});

export const FACE_MODEL_FRIENDLY_STYLE = Object.freeze({
  id: "friendly-soft-v1",
  iris: "soft gray-green",
  sclera: "clean neutral white",
  skinRedStart: 0.015,
  skinRedEnd: 0.12,
  irisMaskStart: 0.005,
  irisMaskEnd: 0.03,
  irisDetailStart: 0.008,
  irisDetailEnd: 0.09,
  irisDarkLinear: Object.freeze([0.008, 0.018, 0.015]),
  irisLightLinear: Object.freeze([0.075, 0.13, 0.105]),
});

const FRIENDLY_FACE_SHADER_GRADES = Object.freeze({
  skin: `
    float affectSkinRedExcess = max(
      0.0,
      diffuseColor.r - max(diffuseColor.g, diffuseColor.b)
    );
    float affectSkinRedMask = smoothstep(
      ${FACE_MODEL_FRIENDLY_STYLE.skinRedStart},
      ${FACE_MODEL_FRIENDLY_STYLE.skinRedEnd},
      affectSkinRedExcess
    );
    vec3 affectSkinCalmer = diffuseColor.rgb + affectSkinRedExcess
      * vec3(-0.50, 0.08, 0.06);
    diffuseColor.rgb = mix(
      diffuseColor.rgb,
      affectSkinCalmer,
      0.85 * affectSkinRedMask
    );
  `,
  iris: `
    float affectEyeLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    float affectEyeIrisMask = smoothstep(
      ${FACE_MODEL_FRIENDLY_STYLE.irisMaskStart},
      ${FACE_MODEL_FRIENDLY_STYLE.irisMaskEnd},
      affectEyeLuma
    );
    vec3 affectEyeFriendlyIris = mix(
      vec3(${FACE_MODEL_FRIENDLY_STYLE.irisDarkLinear.join(", ")}),
      vec3(${FACE_MODEL_FRIENDLY_STYLE.irisLightLinear.join(", ")}),
      smoothstep(
        ${FACE_MODEL_FRIENDLY_STYLE.irisDetailStart},
        ${FACE_MODEL_FRIENDLY_STYLE.irisDetailEnd},
        affectEyeLuma
      )
    );
    diffuseColor.rgb = mix(
      diffuseColor.rgb,
      affectEyeFriendlyIris,
      0.90 * affectEyeIrisMask
    );
  `,
  sclera: `
    float affectEyeLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 affectEyeNeutralDetail = vec3(affectEyeLuma);
    vec3 affectEyeClearSclera = mix(
      affectEyeNeutralDetail,
      vec3(0.90, 0.93, 0.93),
      0.72
    );
    diffuseColor.rgb = mix(diffuseColor.rgb, affectEyeClearSclera, 0.92);
  `,
});

export const FACE_MODEL_MORPH_NAMES = Object.freeze([
  "Jaw_Lower",
  "Mouth_Large_Opened",
  "Lips_Up_Funnel",
  "Lips_Up_Corner_Wide_Left",
  "Lips_Up_Corner_Wide_Right",
  "Happy",
  "Sad",
  "Angry",
  "Scared",
  "Disgusted",
  "Thinking",
  "Kiss",
  "Smile_Lips_Closed",
  "Eyebrows_Raised_Left",
  "Eyebrows_Raised_Right",
  "Eyebrows_Frown_Left",
  "Eyebrows_Frown_Right",
  "Eyes_Closed_Max",
  "Eyes_Opened_Max_Left",
  "Eyes_Opened_Max_Right",
  "Eyes_Squint",
]);

export const FACE_MODEL_PROFILES = Object.freeze([
  "affec-empirical",
  "mediapipe-atlas",
  "facs-continuous",
  "matrix-anchors",
]);

export const DEFAULT_FACE_MODEL_PROFILE = "affec-empirical";

const anchor = (values = {}) => Object.freeze(values);

// Rows are low, neutral, and high arousal. Columns are negative, neutral,
// and positive valence. Runtime values blend these anchors continuously.
const AFFECT_ANCHORS = Object.freeze([
  Object.freeze([
    anchor({
      Sad: 0.82,
      Eyebrows_Frown_Left: 0.34,
      Eyebrows_Frown_Right: 0.34,
      Eyes_Closed_Max: 0.62,
      Eyes_Squint: 0.16,
    }),
    anchor({
      Eyes_Closed_Max: 0.72,
      Eyes_Squint: 0.08,
    }),
    anchor({
      Happy: 0.58,
      Smile_Lips_Closed: 0.84,
      Eyes_Closed_Max: 0.36,
      Eyes_Squint: 0.25,
    }),
  ]),
  Object.freeze([
    anchor({
      Sad: 0.74,
      Eyebrows_Frown_Left: 0.64,
      Eyebrows_Frown_Right: 0.64,
      Eyes_Squint: 0.18,
    }),
    anchor(),
    anchor({
      Happy: 0.76,
      Smile_Lips_Closed: 0.88,
      Eyes_Squint: 0.17,
    }),
  ]),
  Object.freeze([
    anchor({
      Sad: 0.16,
      Angry: 0.68,
      Scared: 0.3,
      Eyebrows_Raised_Left: 0.3,
      Eyebrows_Raised_Right: 0.3,
      Eyebrows_Frown_Left: 0.9,
      Eyebrows_Frown_Right: 0.9,
      Eyes_Opened_Max_Left: 0.82,
      Eyes_Opened_Max_Right: 0.82,
      Jaw_Lower: 0.3,
      Mouth_Large_Opened: 0.22,
    }),
    anchor({
      Eyebrows_Raised_Left: 0.72,
      Eyebrows_Raised_Right: 0.72,
      Eyes_Opened_Max_Left: 0.74,
      Eyes_Opened_Max_Right: 0.74,
      Jaw_Lower: 0.17,
      Mouth_Large_Opened: 0.11,
    }),
    anchor({
      Happy: 0.94,
      Smile_Lips_Closed: 0.76,
      Eyebrows_Raised_Left: 0.58,
      Eyebrows_Raised_Right: 0.58,
      Eyes_Opened_Max_Left: 0.54,
      Eyes_Opened_Max_Right: 0.54,
      Eyes_Squint: 0.2,
      Jaw_Lower: 0.36,
      Mouth_Large_Opened: 0.32,
    }),
  ]),
]);

const clamp = (value, minimum, maximum, fallback = 0) => {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, finite));
};

const axisWeights = (value) => Object.freeze([
  Math.max(0, -value),
  1 - Math.abs(value),
  Math.max(0, value),
]);

function emptyMorphWeights() {
  return Object.fromEntries(FACE_MODEL_MORPH_NAMES.map((name) => [name, 0]));
}

function normalizeProfile(profile = DEFAULT_FACE_MODEL_PROFILE) {
  if (FACE_MODEL_PROFILES.includes(profile)) return profile;
  throw new RangeError(`Unknown detailed face profile: ${String(profile)}`);
}

function buildMatrixAnchorWeights(currentX, currentY) {
  const xWeights = axisWeights(currentX);
  const yWeights = axisWeights(currentY);
  const result = emptyMorphWeights();

  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const contribution = xWeights[column] * yWeights[row];
      if (contribution <= 0) continue;
      const values = AFFECT_ANCHORS[row][column];
      for (const name of FACE_MODEL_MORPH_NAMES) {
        result[name] += contribution * (values[name] ?? 0);
      }
    }
  }
  return result;
}

function finalizeMorphWeights(result) {
  for (const name of FACE_MODEL_MORPH_NAMES) {
    result[name] = clamp(result[name], 0, 1);
  }
  return Object.freeze(result);
}

function createFaceModelMatrixStates() {
  const states = [];
  for (let row = 0; row < AFFECT_MATRIX_SIZE; row += 1) {
    for (let column = 0; column < AFFECT_MATRIX_SIZE; column += 1) {
      const x = affectMatrixCoordinate(column);
      const y = affectMatrixCoordinate(row);
      states.push(Object.freeze({
        row,
        column,
        x,
        y,
        weights: finalizeMorphWeights(buildMatrixAnchorWeights(x, y)),
      }));
    }
  }
  return Object.freeze(states);
}

/** Compact coefficient cache only; no image, texture, or duplicate mesh data. */
export const FACE_MODEL_MATRIX_STATES = createFaceModelMatrixStates();

export function resolveFaceModelMatrixState(snapshot = {}) {
  const currentX = clamp(snapshot?.currentX, -1, 1);
  const currentY = clamp(snapshot?.currentY, -1, 1);
  const cell = affectMatrixCellFromCoordinates(currentX, currentY);
  const state = FACE_MODEL_MATRIX_STATES[cell.row * AFFECT_MATRIX_SIZE + cell.column];
  return Math.abs(state.x - currentX) <= 1e-9 && Math.abs(state.y - currentY) <= 1e-9
    ? state
    : null;
}

const smoothMagnitude = (value) => {
  const magnitude = clamp(Math.abs(value), 0, 1);
  return magnitude * magnitude * (3 - 2 * magnitude);
};

function buildContinuousWeights(currentX, currentY) {
  const positive = currentX > 0 ? smoothMagnitude(currentX) : 0;
  const negative = currentX < 0 ? smoothMagnitude(currentX) : 0;
  const activated = currentY > 0 ? smoothMagnitude(currentY) : 0;
  const subdued = currentY < 0 ? smoothMagnitude(currentY) : 0;
  const result = emptyMorphWeights();

  result.Happy = positive * (0.72 + 0.22 * activated - 0.12 * subdued);
  result.Smile_Lips_Closed = positive * (0.86 - 0.1 * activated + 0.04 * subdued);
  result.Sad = negative * (0.64 + 0.22 * subdued - 0.14 * activated);
  result.Angry = negative * activated * 0.72;
  result.Scared = negative * activated * 0.32;
  const raised = activated * (0.7 + 0.08 * positive - 0.08 * negative);
  result.Eyebrows_Raised_Left = raised;
  result.Eyebrows_Raised_Right = raised;
  const frown = negative * (0.56 + 0.32 * activated + 0.08 * subdued);
  result.Eyebrows_Frown_Left = frown;
  result.Eyebrows_Frown_Right = frown;
  result.Eyes_Closed_Max = subdued * (0.7 - 0.2 * negative + 0.05 * positive);
  const opened = activated * (0.72 + 0.1 * negative - 0.12 * positive);
  result.Eyes_Opened_Max_Left = opened;
  result.Eyes_Opened_Max_Right = opened;
  result.Eyes_Squint = positive * (0.16 + 0.12 * subdued)
    + negative * subdued * 0.12;
  result.Jaw_Lower = activated * (0.15 + 0.21 * Math.max(positive, negative));
  result.Mouth_Large_Opened = activated
    * (0.1 + 0.22 * positive + 0.12 * negative);
  return result;
}

/**
 * Convert the current displayed affect coordinate into Vitruvian morph
 * influences. This function is time-independent and does not read target,
 * phase, gaze, motion preference, or any input authority.
 */
export function buildFaceModelWeights(snapshot = {}, options = {}) {
  const currentX = clamp(snapshot?.currentX, -1, 1);
  const currentY = clamp(snapshot?.currentY, -1, 1);
  const requestedProfile = typeof options === "string" ? options : options?.profile;
  const profile = normalizeProfile(requestedProfile ?? DEFAULT_FACE_MODEL_PROFILE);
  let result;
  if (profile === "affec-empirical") {
    result = { ...emptyMorphWeights(), ...buildAffecEmpiricalWeights({ currentX, currentY }) };
  } else if (profile === "mediapipe-atlas") {
    result = { ...emptyMorphWeights(), ...buildMediapipeAtlasWeights({ currentX, currentY }) };
  } else if (profile === "matrix-anchors") {
    const cached = resolveFaceModelMatrixState({ currentX, currentY });
    if (cached) return cached.weights;
    result = buildMatrixAnchorWeights(currentX, currentY);
  } else {
    result = buildContinuousWeights(currentX, currentY);
  }
  return finalizeMorphWeights(result);
}

function findCanvas(root) {
  if (root?.matches?.("canvas[data-face-model]")) return root;
  return root?.querySelector?.("canvas[data-face-model]") ?? null;
}

function findPhotoCanvas(root) {
  return root?.querySelector?.("canvas[data-face-photo]") ?? null;
}

function findFallback(root) {
  return root?.querySelector?.("[data-face-3d-fallback]") ?? null;
}

function setVisible(node, visible) {
  if (!node) return;
  if ("hidden" in node) node.hidden = !visible;
  if (node.style) node.style.visibility = visible ? "" : "hidden";
  node.setAttribute?.("aria-hidden", String(!visible));
}

function asError(value, fallbackMessage) {
  if (value instanceof Error) return value;
  const message = typeof value?.message === "string" && value.message.trim()
    ? value.message
    : fallbackMessage;
  return new Error(message);
}

function materialRole(name) {
  const baseName = String(name ?? "").replace(/\.001$/, "");
  if (baseName === "VitSkin") return "skin";
  if (baseName === "VitMouth") return "mouth";
  if (baseName === "VitIris") return "iris";
  if (baseName === "VitSclera") return "sclera";
  if (baseName === "VitEyeBack") return "eye-back";
  if (baseName === "VitCornea2") return "cornea";
  if (baseName === "VitEyeshadow") return "eyeshadow";
  if (baseName === "VitTearline") return "tearline";
  if (baseName === "VitCaruncle") return "caruncle";
  return null;
}

function applyFriendlyMaterialGrade(material, role) {
  const grade = FRIENDLY_FACE_SHADER_GRADES[role];
  if (!grade || material?.userData?.affectTrackerFriendlyStyle === FACE_MODEL_FRIENDLY_STYLE.id) {
    return;
  }
  const previousHook = typeof material.onBeforeCompile === "function"
    ? material.onBeforeCompile
    : null;
  const previousCacheKey = typeof material.customProgramCacheKey === "function"
    ? material.customProgramCacheKey.bind(material)
    : null;

  material.onBeforeCompile = (shader, renderer) => {
    previousHook?.call(material, shader, renderer);
    const mapFragment = "#include <map_fragment>";
    if (!shader?.fragmentShader?.includes(mapFragment)) return;
    shader.fragmentShader = shader.fragmentShader.replace(
      mapFragment,
      `${mapFragment}\n${grade}`,
    );
  };
  material.customProgramCacheKey = () => [
    previousCacheKey?.() ?? "",
    FACE_MODEL_FRIENDLY_STYLE.id,
    role,
  ].join(":");
  material.userData = {
    ...(material.userData ?? {}),
    affectTrackerFriendlyStyle: FACE_MODEL_FRIENDLY_STYLE.id,
    affectTrackerMaterialRole: role,
  };
}

function prepareTexture(texture, isColor, renderer, dependencies) {
  if (!texture) throw new TypeError("A face texture did not load.");
  texture.flipY = false;
  if (isColor && dependencies.SRGBColorSpace !== undefined) {
    texture.colorSpace = dependencies.SRGBColorSpace;
  }
  const maximumAnisotropy = renderer.capabilities?.getMaxAnisotropy?.();
  if (Number.isFinite(maximumAnisotropy) && maximumAnisotropy > 0) {
    texture.anisotropy = Math.min(8, maximumAnisotropy);
  }
  texture.needsUpdate = true;
  return texture;
}

function configureMaterial(source, textures, dependencies) {
  const role = materialRole(source?.name);
  if (!role) return source;
  const material = source;
  material.name = source.name;
  material.metalness = 0;

  if (role === "skin") {
    material.map = textures.skinBase;
    material.normalMap = textures.skinNormal;
    material.roughnessMap = textures.skinRoughness;
    material.roughness = 0.88;
    material.envMapIntensity = 0.08;
    if ("specularIntensity" in material) material.specularIntensity = 0.12;
    material.normalScale?.set?.(0.28, 0.28);
    material.color?.set?.(0xffffff);
    applyFriendlyMaterialGrade(material, role);
  } else if (role === "mouth") {
    material.map = textures.mouth;
    material.roughness = 0.7;
    material.envMapIntensity = 0.05;
    if ("specularIntensity" in material) material.specularIntensity = 0.1;
    material.color?.set?.(0xffffff);
  } else if (role === "iris") {
    material.map = textures.iris;
    material.roughness = 0.65;
    material.envMapIntensity = 0.03;
    if ("specularIntensity" in material) material.specularIntensity = 0.06;
    if ("clearcoat" in material) material.clearcoat = 0;
    if ("clearcoatRoughness" in material) material.clearcoatRoughness = 0.8;
    material.color?.set?.(0xffffff);
    applyFriendlyMaterialGrade(material, role);
  } else if (role === "sclera") {
    material.map = textures.sclera;
    // The source texture's alpha channel is the cornea window. Keeping this
    // surface opaque hides the iris and produces the blank mannequin-eye look.
    material.transparent = true;
    material.alphaTest = 0.01;
    material.depthWrite = true;
    material.roughness = 0.6;
    material.envMapIntensity = 0.02;
    if ("specularIntensity" in material) material.specularIntensity = 0.04;
    material.color?.set?.(0xffffff);
    applyFriendlyMaterialGrade(material, role);
  } else if (role === "eye-back") {
    material.map = null;
    material.roughness = 0.72;
    material.envMapIntensity = 0.08;
    if ("specularIntensity" in material) material.specularIntensity = 0.05;
    material.color?.set?.(0x111515);
  } else if (role === "cornea") {
    material.map = null;
    material.transparent = true;
    // The exported inner dome must remain invisible; even a faint white film
    // sits directly over the pupil at this display size.
    material.opacity = 0;
    material.depthWrite = false;
    material.roughness = 0.04;
    material.envMapIntensity = 0.75;
    material.color?.set?.(0xffffff);
  } else if (role === "eyeshadow") {
    material.map = null;
    material.transparent = true;
    material.opacity = 0.04;
    material.depthWrite = false;
    material.roughness = 0.7;
    material.color?.set?.(0x695e5b);
  } else if (role === "tearline") {
    material.map = null;
    material.transparent = true;
    material.opacity = 0.025;
    material.depthWrite = false;
    material.roughness = 0.3;
    if ("specularIntensity" in material) material.specularIntensity = 0.04;
    material.color?.set?.(0xd2beb9);
  } else if (role === "caruncle") {
    material.map = null;
    material.transparent = true;
    material.opacity = 0.28;
    material.depthWrite = false;
    material.roughness = 0.8;
    material.envMapIntensity = 0.05;
    if ("specularIntensity" in material) material.specularIntensity = 0.06;
    material.color?.set?.(0x918987);
  }

  if (dependencies.FrontSide !== undefined) material.side = dependencies.FrontSide;
  material.needsUpdate = true;
  return material;
}

function prepareModel(model, textures, dependencies) {
  let morphMeshCount = 0;
  let mappedMaterialCount = 0;
  model.traverse?.((object) => {
    if (object?.material) {
      const sources = Array.isArray(object.material) ? object.material : [object.material];
      const materials = sources.map((source) => {
        const mapped = configureMaterial(source, textures, dependencies);
        if (materialRole(source?.name)) mappedMaterialCount += 1;
        return mapped;
      });
      object.material = Array.isArray(object.material) ? materials : materials[0];
    }
    if (object?.morphTargetDictionary && object?.morphTargetInfluences) {
      morphMeshCount += 1;
      for (const index of Object.values(object.morphTargetDictionary)) {
        if (Number.isInteger(index) && index >= 0 && index < object.morphTargetInfluences.length) {
          object.morphTargetInfluences[index] = 0;
        }
      }
    }
  });
  return Object.freeze({ morphMeshCount, mappedMaterialCount });
}

function applyWeights(model, weights) {
  let morphMeshCount = 0;
  model.traverse?.((object) => {
    const dictionary = object?.morphTargetDictionary;
    const influences = object?.morphTargetInfluences;
    if (!dictionary || !influences) return;
    morphMeshCount += 1;
    for (const [name, index] of Object.entries(dictionary)) {
      if (!Number.isInteger(index) || index < 0 || index >= influences.length) continue;
      influences[index] = weights[name] ?? 0;
    }
  });
  return morphMeshCount;
}

function createScene(dependencies) {
  const scene = new dependencies.Scene();
  scene.background = null;
  const camera = new dependencies.PerspectiveCamera(DEFAULT_VERTICAL_FOV, 1, 0.01, 20);
  camera.up?.set?.(0, 1, 0);

  const ambient = new dependencies.HemisphereLight(0xfff8f1, 0x20252d, 1.6);
  const key = new dependencies.DirectionalLight(0xffeee2, 1.35);
  key.position?.set?.(1.8, 2.3, 3.2);
  const fill = new dependencies.DirectionalLight(0xe8f0f2, 1);
  fill.position?.set?.(-2.2, 1.15, 2.4);
  const rim = new dependencies.DirectionalLight(0xffffff, 0.12);
  rim.position?.set?.(0.2, 2.1, -2.5);
  scene.add(ambient, key, fill, rim);
  return { scene, camera };
}

function frameHead(model, camera, dependencies) {
  model.updateWorldMatrix?.(true, true);
  const leftEye = model.getObjectByName?.("Eye_L_eyeball");
  const rightEye = model.getObjectByName?.("Eye_R_eyeball");
  const target = new dependencies.Vector3();
  let headHeight = 0;

  if (leftEye?.getWorldPosition && rightEye?.getWorldPosition) {
    const left = leftEye.getWorldPosition(new dependencies.Vector3());
    const right = rightEye.getWorldPosition(new dependencies.Vector3());
    target.copy(left).add(right).multiplyScalar(0.5);
    const eyeDistance = Math.max(0.001, left.distanceTo(right));
    target.y -= eyeDistance * 0.3;
    headHeight = eyeDistance * 4.9;
  } else {
    const bounds = new dependencies.Box3().setFromObject(model);
    const size = bounds.getSize(new dependencies.Vector3());
    bounds.getCenter(target);
    headHeight = Math.max(size.y, size.x, 0.1);
  }

  const fovRadians = (DEFAULT_VERTICAL_FOV * Math.PI) / 180;
  const distance = Math.max(0.1, (headHeight * 0.5) / (Math.tan(fovRadians * 0.5) * 0.84));
  camera.position.set(target.x, target.y, target.z + distance);
  camera.near = Math.max(0.001, distance / 100);
  camera.far = Math.max(10, distance + headHeight * 12);
  camera.lookAt(target);
  camera.updateProjectionMatrix?.();
  return Object.freeze({ target: target.clone(), headHeight, distance });
}

function loaderPromise(loader, url, label) {
  if (typeof loader?.loadAsync === "function") {
    return Promise.resolve().then(() => loader.loadAsync(url));
  }
  if (typeof loader?.load === "function") {
    return new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
  }
  return Promise.reject(new TypeError(`${label} loader is unavailable.`));
}

function realizeProvider(provider, fallbackFactory) {
  if (provider === undefined || provider === null) return fallbackFactory();
  return typeof provider === "function" ? provider() : provider;
}

function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  root?.traverse?.((object) => {
    if (object?.geometry) geometries.add(object.geometry);
    const values = Array.isArray(object?.material) ? object.material : [object?.material];
    for (const material of values) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();
}

/**
 * Create the lazy detailed-face renderer. It mirrors the established
 * `(snapshot, reducedMotion, presentationColor)` signature. Reduced motion and
 * presentation color are intentionally presentation-neutral for this model.
 */
export function createFaceModelRenderer(root, options = {}) {
  const canvas = findCanvas(root);
  const photoCanvas = findPhotoCanvas(root);
  const fallback = findFallback(root);
  const fallbackRenderer = typeof options.fallbackRenderer === "function"
    ? options.fallbackRenderer
    : null;
  const dependencies = options.dependencies ?? THREE;
  const modelUrl = options.modelUrl ?? FACE_MODEL_URL;
  const textureUrls = Object.freeze({
    ...FACE_MODEL_TEXTURE_URLS,
    ...(options.textureUrls ?? {}),
  });
  const maximumDpr = clamp(options.maxDevicePixelRatio, 1, 4, 2);
  let activeProfile = normalizeProfile(options.profile ?? DEFAULT_FACE_MODEL_PROFILE);

  let webglRenderer = null;
  let scene = null;
  let camera = null;
  let model = null;
  let textures = null;
  let modelInfo = Object.freeze({ morphMeshCount: 0, mappedMaterialCount: 0 });
  let frameInfo = null;
  let loadState = "idle";
  let activeMode = "fallback";
  let lastError = null;
  let contextLost = false;
  let destroyed = false;
  let resizeDirty = true;
  let width = DEFAULT_CANVAS_SIZE;
  let height = DEFAULT_CANVAS_SIZE;
  let dpr = 1;
  let lastCall = null;
  let readySettled = false;
  let settleReady;
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });

  const finishReady = (value) => {
    if (readySettled) return;
    readySettled = true;
    settleReady(Boolean(value));
  };

  const setMode = (mode) => {
    const modelActive = mode === "model";
    setVisible(canvas, modelActive);
    setVisible(photoCanvas, !modelActive);
    setVisible(fallback, !modelActive);
    if (root?.dataset) root.dataset.faceModelMode = mode;
    if (mode === activeMode) return;
    activeMode = mode;
    options.onModeChange?.(mode);
  };

  const measure = (apply = true) => {
    const bounds = canvas?.getBoundingClientRect?.();
    const measuredWidth = Number(bounds?.width || canvas?.clientWidth);
    const measuredHeight = Number(bounds?.height || canvas?.clientHeight);
    if (measuredWidth > 0) width = measuredWidth;
    if (measuredHeight > 0) height = measuredHeight;
    const deviceDpr = Number.isFinite(globalThis.devicePixelRatio)
      ? globalThis.devicePixelRatio
      : 1;
    dpr = clamp(deviceDpr, 1, maximumDpr, 1);
    if (apply && webglRenderer && camera) {
      webglRenderer.setPixelRatio?.(dpr);
      webglRenderer.setSize?.(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix?.();
    }
    resizeDirty = false;
    return Object.freeze({ width, height, dpr });
  };

  const dispose = () => {
    disposeObject(model);
    if (textures) {
      for (const texture of Object.values(textures)) texture?.dispose?.();
    }
    scene?.remove?.(model);
    model = null;
    textures = null;
    scene = null;
    camera = null;
    webglRenderer?.dispose?.();
    webglRenderer?.forceContextLoss?.();
    webglRenderer = null;
  };

  const fail = (value, message) => {
    if (destroyed) return;
    lastError = asError(value, message);
    loadState = "failed";
    dispose();
    setMode("fallback");
    finishReady(false);
  };

  const renderFallback = (snapshot, reducedMotion, presentationColor) => {
    if (!destroyed) setMode("fallback");
    const result = fallbackRenderer?.(snapshot, reducedMotion, presentationColor);
    return Object.freeze({ mode: destroyed ? "destroyed" : "fallback", result, error: lastError });
  };

  const drawModel = (call) => {
    if (destroyed || contextLost || loadState !== "ready" || !model || !webglRenderer) {
      return renderFallback(call.snapshot, call.reducedMotion, call.presentationColor);
    }
    if (resizeDirty) measure(true);
    const matrixState = activeProfile === "matrix-anchors"
      ? resolveFaceModelMatrixState(call.snapshot)
      : null;
    const weights = matrixState?.weights
      ?? buildFaceModelWeights(call.snapshot, { profile: activeProfile });
    const morphMeshCount = applyWeights(model, weights);
    webglRenderer.render(scene, camera);
    lastError = null;
    setMode("model");
    return Object.freeze({
      mode: "model",
      profile: activeProfile,
      weights,
      matrixState: matrixState
        ? Object.freeze({
          row: matrixState.row,
          column: matrixState.column,
          x: matrixState.x,
          y: matrixState.y,
        })
        : null,
      morphMeshCount,
      mappedMaterialCount: modelInfo.mappedMaterialCount,
      framing: frameInfo,
    });
  };

  const initialize = async () => {
    if (destroyed) return false;
    const rendererFactory = typeof options.rendererFactory === "function"
      ? options.rendererFactory
      : (parameters) => new dependencies.WebGLRenderer(parameters);
    webglRenderer = rendererFactory({
      canvas,
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!webglRenderer || typeof webglRenderer.render !== "function") {
      throw new TypeError("A WebGL renderer is unavailable for the detailed face.");
    }
    if (typeof webglRenderer.getContext === "function" && !webglRenderer.getContext()) {
      throw new Error("WebGL is unavailable for the detailed face.");
    }
    webglRenderer.setClearColor?.(0x000000, 0);
    if (dependencies.SRGBColorSpace !== undefined) {
      webglRenderer.outputColorSpace = dependencies.SRGBColorSpace;
    }
    if (dependencies.ACESFilmicToneMapping !== undefined) {
      webglRenderer.toneMapping = dependencies.ACESFilmicToneMapping;
      webglRenderer.toneMappingExposure = 0.92;
    }
    ({ scene, camera } = createScene(dependencies));
    measure(true);

    const modelLoader = realizeProvider(options.modelLoader, () => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      return loader;
    });
    modelLoader?.setMeshoptDecoder?.(options.meshoptDecoder ?? MeshoptDecoder);
    const textureLoader = realizeProvider(
      options.textureLoader,
      () => new dependencies.TextureLoader(),
    );
    const entries = Object.entries(textureUrls);
    const outcomes = await Promise.allSettled([
      loaderPromise(modelLoader, modelUrl, "3D model"),
      ...entries.map(([, url]) => loaderPromise(textureLoader, url, "texture")),
    ]);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed) {
      for (const outcome of outcomes.slice(1)) {
        if (outcome.status === "fulfilled") outcome.value?.dispose?.();
      }
      throw failed.reason;
    }

    if (destroyed) {
      const abandonedModel = outcomes[0].value?.scene ?? outcomes[0].value?.scenes?.[0];
      disposeObject(abandonedModel);
      for (const outcome of outcomes.slice(1)) outcome.value?.dispose?.();
      return false;
    }

    const gltf = outcomes[0].value;
    model = gltf?.scene ?? gltf?.scenes?.[0] ?? null;
    if (!model?.traverse) throw new TypeError("The detailed face model contains no scene.");
    textures = Object.fromEntries(entries.map(([name], index) => [name, outcomes[index + 1].value]));
    textures = Object.fromEntries(entries.map(([name]) => [
      name,
      prepareTexture(
        textures[name],
        name === "skinBase" || name === "mouth" || name === "iris" || name === "sclera",
        webglRenderer,
        dependencies,
      ),
    ]));
    modelInfo = prepareModel(model, textures, dependencies);
    scene.add(model);
    frameInfo = frameHead(model, camera, dependencies);
    loadState = "ready";
    resizeDirty = true;
    if (lastCall && !contextLost) drawModel(lastCall);
    finishReady(true);
    return true;
  };

  const startLoading = () => {
    if (loadState !== "idle" || destroyed) return;
    if (!canvas) {
      fail(null, "A canvas[data-face-model] element is required for the detailed face.");
      return;
    }
    loadState = "loading";
    Promise.resolve()
      .then(initialize)
      .catch((error) => fail(error, "The local detailed face could not be loaded."));
  };

  const render = (snapshot, reducedMotion = false, presentationColor) => {
    if (destroyed) return renderFallback(snapshot, reducedMotion, presentationColor);
    lastCall = { snapshot, reducedMotion, presentationColor };
    if (loadState === "idle") startLoading();
    if (loadState !== "ready" || contextLost) {
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
    try {
      return drawModel(lastCall);
    } catch (error) {
      fail(error, "The detailed face could not be rendered.");
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
  };

  const onContextLost = (event) => {
    event?.preventDefault?.();
    contextLost = true;
    lastError = new Error("The detailed face WebGL context was lost; using the local fallback.");
    if (lastCall) renderFallback(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
    else setMode("fallback");
  };
  const onContextRestored = () => {
    if (destroyed) return;
    contextLost = false;
    if (loadState !== "ready") return;
    resizeDirty = true;
    if (!lastCall) return;
    try {
      drawModel(lastCall);
    } catch (error) {
      fail(error, "The detailed face could not recover its WebGL context.");
    }
  };
  const onResize = () => {
    resizeDirty = true;
  };

  canvas?.addEventListener?.("webglcontextlost", onContextLost);
  canvas?.addEventListener?.("webglcontextrestored", onContextRestored);
  let resizeObserver = null;
  if (canvas && typeof globalThis.ResizeObserver === "function") {
    resizeObserver = new globalThis.ResizeObserver(onResize);
    resizeObserver.observe(canvas);
  } else {
    globalThis.addEventListener?.("resize", onResize);
  }

  render.resize = () => {
    resizeDirty = true;
    return measure(Boolean(webglRenderer && camera));
  };
  render.setProfile = (profile) => {
    const nextProfile = normalizeProfile(profile);
    if (nextProfile === activeProfile) return activeProfile;
    activeProfile = nextProfile;
    if (!destroyed && !contextLost && loadState === "ready" && lastCall) {
      try {
        drawModel(lastCall);
      } catch (error) {
        fail(error, "The detailed face profile could not be applied.");
      }
    }
    return activeProfile;
  };
  render.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.("resize", onResize);
    canvas?.removeEventListener?.("webglcontextlost", onContextLost);
    canvas?.removeEventListener?.("webglcontextrestored", onContextRestored);
    dispose();
    loadState = "destroyed";
    setMode("destroyed");
    finishReady(false);
  };
  Object.defineProperties(render, {
    available: {
      enumerable: true,
      get: () => !destroyed && !contextLost && loadState === "ready"
        && activeMode === "model" && Boolean(model && webglRenderer),
    },
    mode: { enumerable: true, get: () => activeMode },
    lastError: { enumerable: true, get: () => lastError },
    error: { enumerable: true, get: () => lastError },
    loadState: { enumerable: true, get: () => loadState },
    ready: { enumerable: true, value: ready },
    modelUrl: { enumerable: true, value: modelUrl },
    textureUrls: { enumerable: true, value: textureUrls },
    profile: { enumerable: true, get: () => activeProfile },
  });

  // Construction performs no WebGL allocation and issues no asset request.
  setMode("fallback");
  return render;
}
