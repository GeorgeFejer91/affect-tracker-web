import { interpolateFaceExpression } from "./face.js";

const TAU = Math.PI * 2;
const HEAD_LATITUDE_SEGMENTS = 18;
const HEAD_LONGITUDE_SEGMENTS = 26;
const HEAD_RADIUS_X = 0.72;
const HEAD_RADIUS_Y = 0.98;
const HEAD_RADIUS_Z = 0.68;
const DEFAULT_PRESENTATION_COLOR = "#d8b095";
const DEFAULT_CANVAS_SIZE = 320;

const clamp = (value, minimum = -1, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));

const clamp01 = (value) => clamp(value, 0, 1);

const smoothstep = (edge0, edge1, value) => {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
};

const gaussian = (value, centre, spread) => {
  const distance = (value - centre) / spread;
  return Math.exp(-(distance * distance));
};

const freezePoint = (x, y, z) => Object.freeze({ x, y, z });

function normalisePresentationColor(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_PRESENTATION_COLOR;
}

/**
 * Normalize only presentation inputs. The renderer deliberately ignores target
 * coordinates, timing, input state, and every research/diagnostic field.
 */
export function normalizeFace3dFrame(
  snapshot = {},
  reducedMotion = false,
  presentationColor,
) {
  return Object.freeze({
    currentX: clamp(snapshot.currentX),
    currentY: clamp(snapshot.currentY),
    phase: Number.isFinite(snapshot.phase) ? snapshot.phase : 0,
    reducedMotion: Boolean(reducedMotion),
    presentationColor: normalisePresentationColor(
      presentationColor ?? snapshot.presentationColor,
    ),
  });
}

function weightsFromExpression(expression) {
  const eyeDelta = expression.eyeOpen - 0.5;
  return Object.freeze({
    smile: clamp01(expression.mouthCurve),
    frown: clamp01(-expression.mouthCurve),
    jawOpen: clamp01(expression.mouthOpen),
    eyeWide: clamp01(eyeDelta / 0.5),
    eyeSquint: clamp01(-eyeDelta / 0.3),
    browUp: clamp01(expression.browLift / 0.75),
    browDown: clamp01(-expression.browLift / 0.2),
    innerBrowUp: clamp01(expression.innerBrowLift),
  });
}

/**
 * A compact morph-weight view of the canonical 3x3 expression map. These are
 * rendering controls, not measured Facial Action Units or inferred emotions.
 */
export function computeFace3dWeights(snapshot = {}) {
  const frame = normalizeFace3dFrame(snapshot);
  return weightsFromExpression(
    interpolateFaceExpression(frame.currentX, frame.currentY),
  );
}

function jawTaper(y) {
  return 1 - 0.23 * smoothstep(0.18, 0.96, -y);
}

function headSurfaceZ(x, y) {
  const normalY = clamp(y / HEAD_RADIUS_Y);
  const horizontalSlice = Math.sqrt(Math.max(0, 1 - normalY * normalY));
  const xLimit = Math.max(0.0001, HEAD_RADIUS_X * horizontalSlice * jawTaper(y));
  const normalX = clamp(x / xLimit);
  return HEAD_RADIUS_Z * horizontalSlice * Math.sqrt(Math.max(0, 1 - normalX * normalX));
}

function orientTriangle(vertices, a, b, c) {
  const first = vertices[a];
  const second = vertices[b];
  const third = vertices[c];
  const abx = second.x - first.x;
  const aby = second.y - first.y;
  const abz = second.z - first.z;
  const acx = third.x - first.x;
  const acy = third.y - first.y;
  const acz = third.z - first.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const centreX = (first.x + second.x + third.x) / 3;
  const centreY = (first.y + second.y + third.y) / 3;
  const centreZ = (first.z + second.z + third.z) / 3;
  return nx * centreX + ny * centreY + nz * centreZ >= 0
    ? Object.freeze([a, b, c])
    : Object.freeze([a, c, b]);
}

function createHeadMesh() {
  const vertices = [freezePoint(0, HEAD_RADIUS_Y, 0)];

  for (let latitude = 1; latitude < HEAD_LATITUDE_SEGMENTS; latitude += 1) {
    const theta = (Math.PI * latitude) / HEAD_LATITUDE_SEGMENTS;
    const y = HEAD_RADIUS_Y * Math.cos(theta);
    const ringRadius = Math.sin(theta);
    for (let longitude = 0; longitude < HEAD_LONGITUDE_SEGMENTS; longitude += 1) {
      const phi = (TAU * longitude) / HEAD_LONGITUDE_SEGMENTS;
      vertices.push(freezePoint(
        HEAD_RADIUS_X * ringRadius * Math.cos(phi) * jawTaper(y),
        y,
        HEAD_RADIUS_Z * ringRadius * Math.sin(phi),
      ));
    }
  }

  const bottomIndex = vertices.length;
  vertices.push(freezePoint(0, -HEAD_RADIUS_Y, 0));
  const triangles = [];
  const ringIndex = (ring, longitude) =>
    1 + ring * HEAD_LONGITUDE_SEGMENTS
    + ((longitude + HEAD_LONGITUDE_SEGMENTS) % HEAD_LONGITUDE_SEGMENTS);

  for (let longitude = 0; longitude < HEAD_LONGITUDE_SEGMENTS; longitude += 1) {
    triangles.push(orientTriangle(
      vertices,
      0,
      ringIndex(0, longitude),
      ringIndex(0, longitude + 1),
    ));
  }

  for (let ring = 0; ring < HEAD_LATITUDE_SEGMENTS - 2; ring += 1) {
    for (let longitude = 0; longitude < HEAD_LONGITUDE_SEGMENTS; longitude += 1) {
      const upperLeft = ringIndex(ring, longitude);
      const upperRight = ringIndex(ring, longitude + 1);
      const lowerLeft = ringIndex(ring + 1, longitude);
      const lowerRight = ringIndex(ring + 1, longitude + 1);
      triangles.push(orientTriangle(vertices, upperLeft, lowerLeft, upperRight));
      triangles.push(orientTriangle(vertices, upperRight, lowerLeft, lowerRight));
    }
  }

  const finalRing = HEAD_LATITUDE_SEGMENTS - 2;
  for (let longitude = 0; longitude < HEAD_LONGITUDE_SEGMENTS; longitude += 1) {
    triangles.push(orientTriangle(
      vertices,
      ringIndex(finalRing, longitude),
      bottomIndex,
      ringIndex(finalRing, longitude + 1),
    ));
  }

  return Object.freeze({
    vertices: Object.freeze(vertices),
    triangles: Object.freeze(triangles),
  });
}

const BASE_HEAD_MESH = createHeadMesh();

export const FACE_3D_MESH_COUNTS = Object.freeze({
  vertices: BASE_HEAD_MESH.vertices.length,
  triangles: BASE_HEAD_MESH.triangles.length,
});

function deformHeadPoint(point, expression, weights, animatedJawOpen) {
  let { x, y, z } = point;
  const front = smoothstep(-0.12, 0.5, z);
  const lowerFace = smoothstep(0.16, 0.92, -y) * front;
  const cheek = (
    gaussian(Math.abs(x), 0.32, 0.2)
    * gaussian(y, -0.02, 0.3)
    * front
  );
  const mouthSocket = (
    gaussian(x, 0, 0.42)
    * gaussian(y, -0.32, 0.22)
    * front
  );

  y -= 0.082 * animatedJawOpen * lowerFace * lowerFace;
  x *= 1 - 0.048 * animatedJawOpen * lowerFace;
  y += 0.024 * weights.smile * cheek;
  z += 0.042 * weights.smile * cheek;
  z -= 0.018 * weights.frown * cheek;
  z -= 0.025 * animatedJawOpen * mouthSocket;
  z += 0.009 * expression.browLift * gaussian(Math.abs(x), 0.25, 0.28)
    * gaussian(y, 0.4, 0.2) * front;

  return { x, y, z };
}

function localFeaturePoint(x, y, zOffset, expression, weights, animatedJawOpen) {
  const deformed = deformHeadPoint(
    { x, y, z: headSurfaceZ(x, y) },
    expression,
    weights,
    animatedJawOpen,
  );
  deformed.z += zOffset;
  return deformed;
}

function buildEyeFeatures(centreX, expression, weights, animatedJawOpen, gazeX, gazeY) {
  const centreY = 0.16 + expression.browLift * 0.01;
  const halfWidth = 0.17;
  const halfHeight = 0.019 + 0.068 * expression.eyeOpen;
  const point = (x, y, offset = 0.035) => localFeaturePoint(
    x,
    y,
    offset,
    expression,
    weights,
    animatedJawOpen,
  );
  const irisX = centreX + gazeX;
  const irisY = centreY + gazeY;
  const irisRadius = Math.min(0.062, halfHeight * 0.82 + 0.015);

  return Object.freeze({
    outline: Object.freeze([
      point(centreX - halfWidth, centreY),
      point(centreX, centreY + halfHeight),
      point(centreX + halfWidth, centreY),
      point(centreX, centreY - halfHeight),
    ]),
    iris: Object.freeze({
      centre: point(irisX, irisY, 0.047),
      horizontal: point(irisX + irisRadius, irisY, 0.047),
      vertical: point(irisX, irisY + irisRadius, 0.047),
      highlight: point(irisX - irisRadius * 0.28, irisY + irisRadius * 0.3, 0.052),
    }),
  });
}

function buildSilhouette() {
  const points = [];
  const samples = 44;
  for (let index = 0; index <= samples; index += 1) {
    const y = HEAD_RADIUS_Y * (1 - (2 * index) / samples);
    const vertical = Math.sqrt(Math.max(0, 1 - (y / HEAD_RADIUS_Y) ** 2));
    points.push({ x: HEAD_RADIUS_X * vertical * jawTaper(y), y, z: 0 });
  }
  for (let index = samples; index >= 0; index -= 1) {
    const y = HEAD_RADIUS_Y * (1 - (2 * index) / samples);
    const vertical = Math.sqrt(Math.max(0, 1 - (y / HEAD_RADIUS_Y) ** 2));
    points.push({ x: -HEAD_RADIUS_X * vertical * jawTaper(y), y, z: 0 });
  }
  return Object.freeze(points.map((point) => Object.freeze(point)));
}

const BASE_SILHOUETTE = buildSilhouette();

function buildFeatureGeometry(frame, expression, weights, animatedJawOpen) {
  const featurePoint = (x, y, offset = 0.035) => localFeaturePoint(
    x,
    y,
    offset,
    expression,
    weights,
    animatedJawOpen,
  );
  const gazeX = frame.currentX * 0.018;
  const gazeY = frame.currentY * 0.008;
  const browOuterY = 0.405 + 0.076 * expression.browLift;
  const browInnerY = browOuterY + 0.074 * expression.innerBrowLift;
  const mouthWidth = 0.365 + 0.018 * Math.abs(expression.mouthCurve);
  const mouthBaseY = -0.31;
  const mouthCornerY = mouthBaseY + 0.052 * expression.mouthCurve;
  const mouthCentreY = mouthBaseY - 0.132 * expression.mouthCurve;
  const mouthHalfOpen = 0.072 * animatedJawOpen;

  const ears = [-1, 1].map((side) => {
    const centre = freezePoint(side * 0.715, 0.01, -0.01);
    return Object.freeze({
      centre,
      horizontal: freezePoint(side * 0.81, 0.01, -0.01),
      vertical: freezePoint(side * 0.715, 0.18, -0.01),
    });
  });

  return Object.freeze({
    eyes: Object.freeze([
      buildEyeFeatures(-0.275, expression, weights, animatedJawOpen, gazeX, gazeY),
      buildEyeFeatures(0.275, expression, weights, animatedJawOpen, gazeX, gazeY),
    ]),
    brows: Object.freeze([
      Object.freeze([
        featurePoint(-0.49, browOuterY, 0.045),
        featurePoint(-0.31, (browOuterY + browInnerY) * 0.5 + 0.02, 0.052),
        featurePoint(-0.12, browInnerY, 0.045),
      ]),
      Object.freeze([
        featurePoint(0.12, browInnerY, 0.045),
        featurePoint(0.31, (browOuterY + browInnerY) * 0.5 + 0.02, 0.052),
        featurePoint(0.49, browOuterY, 0.045),
      ]),
    ]),
    nose: Object.freeze({
      bridge: Object.freeze([
        featurePoint(-0.025, 0.24, 0.055),
        featurePoint(0.008, -0.06, 0.12),
      ]),
      base: Object.freeze([
        featurePoint(-0.095, -0.12, 0.065),
        featurePoint(0.005, -0.155, 0.13),
        featurePoint(0.1, -0.12, 0.06),
      ]),
    }),
    mouth: Object.freeze({
      left: featurePoint(-mouthWidth, mouthCornerY, 0.052),
      upper: featurePoint(0, mouthCentreY + mouthHalfOpen, 0.061),
      right: featurePoint(mouthWidth, mouthCornerY, 0.052),
      lower: featurePoint(0, mouthCentreY - mouthHalfOpen, 0.061),
      halfOpen: mouthHalfOpen,
    }),
    ears: Object.freeze(ears),
    neck: Object.freeze([
      freezePoint(-0.24, -0.77, -0.19),
      freezePoint(0.24, -0.77, -0.19),
      freezePoint(0.31, -1.24, -0.3),
      freezePoint(-0.31, -1.24, -0.3),
    ]),
    silhouette: BASE_SILHOUETTE,
  });
}

/**
 * Build deterministic local-space geometry. Animation derives exclusively from
 * the caller-provided phase; this function never reads time or owns smoothing.
 */
export function buildFace3dModel(
  snapshot = {},
  reducedMotion = false,
  presentationColor,
) {
  const frame = normalizeFace3dFrame(snapshot, reducedMotion, presentationColor);
  const expression = interpolateFaceExpression(frame.currentX, frame.currentY);
  const weights = weightsFromExpression(expression);
  const activation = (frame.currentY + 1) * 0.5;
  const pulse = frame.reducedMotion ? 0 : Math.sin(frame.phase);
  const animatedJawOpen = clamp01(expression.mouthOpen * (1 + pulse * 0.06));
  const headScale = 1 + 0.014 * activation * pulse;
  const vertices = new Float64Array(BASE_HEAD_MESH.vertices.length * 3);

  for (let index = 0; index < BASE_HEAD_MESH.vertices.length; index += 1) {
    const vertex = deformHeadPoint(
      BASE_HEAD_MESH.vertices[index],
      expression,
      weights,
      animatedJawOpen,
    );
    vertices[index * 3] = vertex.x;
    vertices[index * 3 + 1] = vertex.y;
    vertices[index * 3 + 2] = vertex.z;
  }

  return Object.freeze({
    mode: "canvas-3d",
    frame,
    expression,
    weights,
    pulse,
    animatedJawOpen,
    headScale,
    rotation: Object.freeze({
      yaw: frame.currentX * 0.068,
      pitch: -frame.currentY * 0.025,
    }),
    vertices,
    triangles: BASE_HEAD_MESH.triangles,
    features: buildFeatureGeometry(frame, expression, weights, animatedJawOpen),
  });
}

function transformPoint(model, point) {
  const scaledX = point.x * model.headScale;
  const scaledY = point.y * model.headScale;
  const scaledZ = point.z * model.headScale;
  const cosYaw = Math.cos(model.rotation.yaw);
  const sinYaw = Math.sin(model.rotation.yaw);
  const cosPitch = Math.cos(model.rotation.pitch);
  const sinPitch = Math.sin(model.rotation.pitch);
  const yawX = scaledX * cosYaw + scaledZ * sinYaw;
  const yawZ = -scaledX * sinYaw + scaledZ * cosYaw;
  return {
    x: yawX,
    y: scaledY * cosPitch - yawZ * sinPitch,
    z: scaledY * sinPitch + yawZ * cosPitch,
  };
}

function safeViewport(viewport = {}) {
  return Object.freeze({
    width: Math.max(1, Number.isFinite(viewport.width) ? viewport.width : DEFAULT_CANVAS_SIZE),
    height: Math.max(1, Number.isFinite(viewport.height) ? viewport.height : DEFAULT_CANVAS_SIZE),
  });
}

function projectorFor(model, viewport) {
  const size = Math.min(viewport.width, viewport.height);
  const pixelScale = size * 0.39;
  const cameraDistance = 3.4;
  const focalLength = 3;
  const centreX = viewport.width * 0.5;
  const centreY = viewport.height * 0.455;
  return {
    pixelScale,
    project(point) {
      const world = transformPoint(model, point);
      const perspective = focalLength / Math.max(0.4, cameraDistance - world.z);
      return {
        x: centreX + world.x * perspective * pixelScale,
        y: centreY - world.y * perspective * pixelScale,
        z: world.z,
        world,
        perspective,
      };
    },
  };
}

function projectEye(project, eye) {
  return Object.freeze({
    outline: Object.freeze(eye.outline.map(project)),
    iris: Object.freeze({
      centre: project(eye.iris.centre),
      horizontal: project(eye.iris.horizontal),
      vertical: project(eye.iris.vertical),
      highlight: project(eye.iris.highlight),
    }),
  });
}

function projectFeatures(project, features) {
  return Object.freeze({
    eyes: Object.freeze(features.eyes.map((eye) => projectEye(project, eye))),
    brows: Object.freeze(features.brows.map((brow) => Object.freeze(brow.map(project)))),
    nose: Object.freeze({
      bridge: Object.freeze(features.nose.bridge.map(project)),
      base: Object.freeze(features.nose.base.map(project)),
    }),
    mouth: Object.freeze({
      left: project(features.mouth.left),
      upper: project(features.mouth.upper),
      right: project(features.mouth.right),
      lower: project(features.mouth.lower),
      halfOpen: features.mouth.halfOpen,
    }),
    ears: Object.freeze(features.ears.map((ear) => Object.freeze({
      centre: project(ear.centre),
      horizontal: project(ear.horizontal),
      vertical: project(ear.vertical),
    }))),
    neck: Object.freeze(features.neck.map(project)),
    silhouette: Object.freeze(features.silhouette.map(project)),
  });
}

/** Project the local model into a finite painter-sorted scene. */
export function projectFace3dModel(model, viewport = {}) {
  const safe = safeViewport(viewport);
  const { project, pixelScale } = projectorFor(model, safe);
  const world = new Float64Array(model.vertices.length);
  const screen = new Float64Array(model.vertices.length);

  for (let offset = 0; offset < model.vertices.length; offset += 3) {
    const projected = project({
      x: model.vertices[offset],
      y: model.vertices[offset + 1],
      z: model.vertices[offset + 2],
    });
    world[offset] = projected.world.x;
    world[offset + 1] = projected.world.y;
    world[offset + 2] = projected.world.z;
    screen[offset] = projected.x;
    screen[offset + 1] = projected.y;
    screen[offset + 2] = projected.z;
  }

  const lightLength = Math.hypot(-0.42, 0.72, 0.62);
  const lightX = -0.42 / lightLength;
  const lightY = 0.72 / lightLength;
  const lightZ = 0.62 / lightLength;
  const visibleTriangles = [];

  for (const [a, b, c] of model.triangles) {
    const aOffset = a * 3;
    const bOffset = b * 3;
    const cOffset = c * 3;
    const abx = world[bOffset] - world[aOffset];
    const aby = world[bOffset + 1] - world[aOffset + 1];
    const abz = world[bOffset + 2] - world[aOffset + 2];
    const acx = world[cOffset] - world[aOffset];
    const acy = world[cOffset + 1] - world[aOffset + 1];
    const acz = world[cOffset + 2] - world[aOffset + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-9) continue;
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
    const centreX = (world[aOffset] + world[bOffset] + world[cOffset]) / 3;
    const centreY = (world[aOffset + 1] + world[bOffset + 1] + world[cOffset + 1]) / 3;
    const centreZ = (world[aOffset + 2] + world[bOffset + 2] + world[cOffset + 2]) / 3;
    const viewDot = nx * -centreX + ny * -centreY + nz * (3.4 - centreZ);
    if (viewDot <= 0) continue;
    const diffuse = Math.max(0, nx * lightX + ny * lightY + nz * lightZ);
    const rim = Math.pow(1 - Math.max(0, nz), 2) * 0.08;
    visibleTriangles.push(Object.freeze({
      a,
      b,
      c,
      depth: centreZ,
      light: clamp(0.38 + 0.62 * diffuse + rim, 0.3, 1.08),
    }));
  }
  visibleTriangles.sort((first, second) => first.depth - second.depth);

  return Object.freeze({
    viewport: safe,
    pixelScale,
    screen,
    world,
    visibleTriangles: Object.freeze(visibleTriangles),
    features: projectFeatures(project, model.features),
  });
}

function parseHexChannel(value) {
  return Number.parseInt(value, 16);
}

/** Resolve the supplied CSS color into the small local material palette. */
export function resolveFace3dPalette(presentationColor) {
  const value = normalisePresentationColor(presentationColor);
  let accent = null;
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value);
  const longHex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value);
  if (shortHex) {
    accent = [...shortHex[1]].map((channel) => parseHexChannel(channel + channel));
  } else if (longHex) {
    accent = [
      parseHexChannel(longHex[1].slice(0, 2)),
      parseHexChannel(longHex[1].slice(2, 4)),
      parseHexChannel(longHex[1].slice(4, 6)),
    ];
  } else if (rgb) {
    accent = rgb.slice(1, 4).map((channel) => clamp(Number(channel), 0, 255));
  }
  if (!accent) accent = [216, 176, 149];

  const mix = (first, second, amount) => first.map((channel, index) =>
    Math.round(channel + (second[index] - channel) * amount));
  const neutralSkin = [207, 184, 164];
  const skin = mix(neutralSkin, accent, 0.38);
  return Object.freeze({
    accent: Object.freeze(accent),
    skin: Object.freeze(skin),
    feature: Object.freeze(mix(skin, [29, 23, 26], 0.82)),
    lip: Object.freeze(mix(accent, [101, 34, 47], 0.63)),
    mouth: Object.freeze([45, 17, 25]),
    sclera: Object.freeze([245, 242, 233]),
    iris: Object.freeze(mix(accent, [32, 42, 42], 0.7)),
  });
}

const rgbString = (color, alpha = 1) =>
  `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha})`;

function shade(color, amount) {
  return color.map((channel) => clamp(channel * amount, 0, 255));
}

function polygon(context, points) {
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) {
    context.lineTo(points[index].x, points[index].y);
  }
  context.closePath();
}

function drawEye(context, eye, palette, lineWidth) {
  const [left, top, right, bottom] = eye.outline;
  context.beginPath();
  context.moveTo(left.x, left.y);
  context.quadraticCurveTo(top.x, top.y, right.x, right.y);
  context.quadraticCurveTo(bottom.x, bottom.y, left.x, left.y);
  context.closePath();
  context.fillStyle = rgbString(palette.sclera, 0.96);
  context.fill();
  context.strokeStyle = rgbString(palette.feature, 0.92);
  context.lineWidth = lineWidth;
  context.stroke();

  const irisRadiusX = Math.max(1, Math.hypot(
    eye.iris.horizontal.x - eye.iris.centre.x,
    eye.iris.horizontal.y - eye.iris.centre.y,
  ));
  const irisRadiusY = Math.max(1, Math.hypot(
    eye.iris.vertical.x - eye.iris.centre.x,
    eye.iris.vertical.y - eye.iris.centre.y,
  ));
  context.beginPath();
  context.ellipse(
    eye.iris.centre.x,
    eye.iris.centre.y,
    irisRadiusX,
    irisRadiusY,
    0,
    0,
    TAU,
  );
  context.fillStyle = rgbString(palette.iris);
  context.fill();
  context.beginPath();
  context.arc(
    eye.iris.centre.x,
    eye.iris.centre.y,
    Math.max(1.5, Math.min(irisRadiusX, irisRadiusY) * 0.48),
    0,
    TAU,
  );
  context.fillStyle = rgbString(palette.feature);
  context.fill();
  context.beginPath();
  context.arc(
    eye.iris.highlight.x,
    eye.iris.highlight.y,
    Math.max(0.8, Math.min(irisRadiusX, irisRadiusY) * 0.17),
    0,
    TAU,
  );
  context.fillStyle = "rgba(255, 255, 255, 0.9)";
  context.fill();
}

/** Draw a projected model into an already-sized CanvasRenderingContext2D. */
export function drawFace3d(context, model, projected) {
  const palette = resolveFace3dPalette(model.frame.presentationColor);
  const { width, height } = projected.viewport;
  const unit = Math.max(0.6, Math.min(width, height) / DEFAULT_CANVAS_SIZE);
  context.clearRect(0, 0, width, height);
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  polygon(context, projected.features.neck);
  context.fillStyle = rgbString(shade(palette.skin, 0.58));
  context.fill();

  for (const ear of projected.features.ears) {
    const radiusX = Math.max(1, Math.hypot(
      ear.horizontal.x - ear.centre.x,
      ear.horizontal.y - ear.centre.y,
    ));
    const radiusY = Math.max(1, Math.hypot(
      ear.vertical.x - ear.centre.x,
      ear.vertical.y - ear.centre.y,
    ));
    context.beginPath();
    context.ellipse(ear.centre.x, ear.centre.y, radiusX, radiusY, 0, 0, TAU);
    context.fillStyle = rgbString(shade(palette.skin, 0.72));
    context.fill();
    context.strokeStyle = rgbString(palette.feature, 0.35);
    context.lineWidth = 1.2 * unit;
    context.stroke();
  }

  for (const triangle of projected.visibleTriangles) {
    const aOffset = triangle.a * 3;
    const bOffset = triangle.b * 3;
    const cOffset = triangle.c * 3;
    context.beginPath();
    context.moveTo(projected.screen[aOffset], projected.screen[aOffset + 1]);
    context.lineTo(projected.screen[bOffset], projected.screen[bOffset + 1]);
    context.lineTo(projected.screen[cOffset], projected.screen[cOffset + 1]);
    context.closePath();
    const fill = rgbString(shade(palette.skin, triangle.light));
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = fill;
    context.lineWidth = 0.45 * unit;
    context.stroke();
  }

  const silhouette = projected.features.silhouette;
  context.beginPath();
  context.moveTo(silhouette[0].x, silhouette[0].y);
  for (let index = 1; index < silhouette.length; index += 1) {
    context.lineTo(silhouette[index].x, silhouette[index].y);
  }
  context.closePath();
  context.strokeStyle = rgbString(palette.feature, 0.48);
  context.lineWidth = 1.5 * unit;
  context.stroke();

  for (const eye of projected.features.eyes) {
    drawEye(context, eye, palette, 1.5 * unit);
  }

  for (const brow of projected.features.brows) {
    context.beginPath();
    context.moveTo(brow[0].x, brow[0].y);
    context.quadraticCurveTo(brow[1].x, brow[1].y, brow[2].x, brow[2].y);
    context.strokeStyle = rgbString(palette.feature, 0.94);
    context.lineWidth = 6 * unit;
    context.stroke();
  }

  const nose = projected.features.nose;
  context.beginPath();
  context.moveTo(nose.bridge[0].x, nose.bridge[0].y);
  context.quadraticCurveTo(
    nose.bridge[0].x - 4 * unit,
    (nose.bridge[0].y + nose.bridge[1].y) * 0.5,
    nose.bridge[1].x,
    nose.bridge[1].y,
  );
  context.strokeStyle = rgbString(palette.feature, 0.32);
  context.lineWidth = 2 * unit;
  context.stroke();
  context.beginPath();
  context.moveTo(nose.base[0].x, nose.base[0].y);
  context.quadraticCurveTo(nose.base[1].x, nose.base[1].y, nose.base[2].x, nose.base[2].y);
  context.strokeStyle = rgbString(palette.feature, 0.48);
  context.lineWidth = 1.8 * unit;
  context.stroke();

  const mouth = projected.features.mouth;
  context.beginPath();
  context.moveTo(mouth.left.x, mouth.left.y);
  context.quadraticCurveTo(mouth.upper.x, mouth.upper.y, mouth.right.x, mouth.right.y);
  context.quadraticCurveTo(mouth.lower.x, mouth.lower.y, mouth.left.x, mouth.left.y);
  context.closePath();
  context.fillStyle = rgbString(palette.mouth, Math.min(1, 0.3 + mouth.halfOpen * 10));
  context.fill();
  context.strokeStyle = rgbString(palette.lip, 0.96);
  context.lineWidth = (mouth.halfOpen > 0.015 ? 3.4 : 2.7) * unit;
  context.stroke();
  if (mouth.halfOpen > 0.035) {
    context.beginPath();
    const teethY = mouth.upper.y + (mouth.lower.y - mouth.upper.y) * 0.22;
    context.moveTo(
      mouth.left.x + (mouth.upper.x - mouth.left.x) * 0.22,
      teethY,
    );
    context.quadraticCurveTo(
      mouth.upper.x,
      mouth.upper.y + (mouth.lower.y - mouth.upper.y) * 0.16,
      mouth.right.x + (mouth.upper.x - mouth.right.x) * 0.22,
      teethY,
    );
    context.strokeStyle = "rgba(255, 248, 235, 0.82)";
    context.lineWidth = 2 * unit;
    context.stroke();
  }

  context.restore();
  return Object.freeze({
    mode: "canvas-3d",
    expression: model.expression,
    weights: model.weights,
    headScale: model.headScale,
    visibleTriangleCount: projected.visibleTriangles.length,
    presentationColor: model.frame.presentationColor,
  });
}

function findCanvas(root) {
  if (typeof root?.getContext === "function") return root;
  return root?.querySelector?.("canvas") ?? null;
}

function findFallback(root) {
  if (!root || typeof root.querySelector !== "function") return null;
  return root.querySelector("[data-face-3d-fallback], .face-3d-fallback");
}

function setPresentationMode(root, canvas, fallback, useFallback) {
  if (canvas?.style) canvas.style.visibility = useFallback ? "hidden" : "";
  if (fallback) {
    fallback.hidden = !useFallback;
    fallback.setAttribute?.("aria-hidden", String(!useFallback));
  }
  if (root?.dataset) root.dataset.face3dMode = useFallback ? "fallback" : "canvas";
}

/**
 * Create a renderer that mirrors the existing face renderer signature. It is
 * callable as `(snapshot, reducedMotion = false, presentationColor)` and has
 * `.resize()`, `.destroy()`, and a live `.available` property.
 */
export function createFace3dRenderer(root, options = {}) {
  const canvas = findCanvas(root);
  const fallback = findFallback(root);
  const fallbackRenderer = typeof options.fallbackRenderer === "function"
    ? options.fallbackRenderer
    : null;
  const maximumDpr = clamp(
    Number.isFinite(options.maxDevicePixelRatio) ? options.maxDevicePixelRatio : 2,
    1,
    4,
  );
  let context = null;
  let destroyed = false;
  let contextLost = false;
  let resizeDirty = true;
  let lastError = null;
  let cssWidth = DEFAULT_CANVAS_SIZE;
  let cssHeight = DEFAULT_CANVAS_SIZE;
  let activeMode = "fallback";

  const updatePresentationMode = (useFallback) => {
    const nextMode = useFallback ? "fallback" : "canvas";
    setPresentationMode(root, canvas, fallback, useFallback);
    if (nextMode === activeMode) return;
    activeMode = nextMode;
    options.onModeChange?.(activeMode);
  };

  const acquireContext = () => {
    if (destroyed || contextLost || !canvas) return null;
    if (context) return context;
    try {
      context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    } catch (error) {
      lastError = error;
      context = null;
    }
    return context;
  };

  const resize = () => {
    resizeDirty = false;
    if (!canvas) return Object.freeze({ width: cssWidth, height: cssHeight, dpr: 1 });
    const bounds = canvas.getBoundingClientRect?.();
    const measuredWidth = bounds?.width || canvas.clientWidth;
    const measuredHeight = bounds?.height || canvas.clientHeight;
    if (Number.isFinite(measuredWidth) && measuredWidth > 0) cssWidth = measuredWidth;
    if (Number.isFinite(measuredHeight) && measuredHeight > 0) cssHeight = measuredHeight;
    const deviceDpr = Number.isFinite(globalThis.devicePixelRatio)
      ? globalThis.devicePixelRatio
      : 1;
    const dpr = clamp(deviceDpr, 1, maximumDpr);
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    acquireContext()?.setTransform?.(dpr, 0, 0, dpr, 0, 0);
    return Object.freeze({ width: cssWidth, height: cssHeight, dpr });
  };

  const onContextLost = (event) => {
    event?.preventDefault?.();
    contextLost = true;
    context = null;
    updatePresentationMode(true);
  };
  const onContextRestored = () => {
    contextLost = false;
    context = null;
    resizeDirty = true;
  };
  const onWindowResize = () => {
    resizeDirty = true;
  };

  canvas?.addEventListener?.("contextlost", onContextLost);
  canvas?.addEventListener?.("contextrestored", onContextRestored);
  let resizeObserver = null;
  if (canvas && typeof globalThis.ResizeObserver === "function") {
    resizeObserver = new globalThis.ResizeObserver(() => {
      resizeDirty = true;
    });
    resizeObserver.observe(canvas);
  } else {
    globalThis.addEventListener?.("resize", onWindowResize);
  }

  const renderFallback = (snapshot, reducedMotion, presentationColor) => {
    updatePresentationMode(true);
    const result = fallbackRenderer?.(snapshot, reducedMotion, presentationColor);
    return Object.freeze({ mode: "fallback", result });
  };

  const render = (snapshot, reducedMotion = false, presentationColor) => {
    if (destroyed || !acquireContext()) {
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
    try {
      const viewport = resizeDirty
        ? resize()
        : { width: cssWidth, height: cssHeight };
      const model = buildFace3dModel(snapshot, reducedMotion, presentationColor);
      const projected = projectFace3dModel(model, viewport);
      const result = drawFace3d(context, model, projected);
      updatePresentationMode(false);
      lastError = null;
      return result;
    } catch (error) {
      lastError = error;
      context = null;
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
  };

  render.resize = () => {
    resizeDirty = true;
    return acquireContext() ? resize() : Object.freeze({ width: cssWidth, height: cssHeight, dpr: 1 });
  };
  render.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.("resize", onWindowResize);
    canvas?.removeEventListener?.("contextlost", onContextLost);
    canvas?.removeEventListener?.("contextrestored", onContextRestored);
    context = null;
  };
  Object.defineProperties(render, {
    available: {
      enumerable: true,
      get: () => !destroyed && !contextLost && activeMode === "canvas" && Boolean(context),
    },
    lastError: {
      enumerable: true,
      get: () => lastError,
    },
    mode: {
      enumerable: true,
      get: () => (destroyed ? "destroyed" : activeMode),
    },
  });

  updatePresentationMode(!acquireContext());
  return render;
}
