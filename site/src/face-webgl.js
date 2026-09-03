import { interpolateFaceExpression } from "./face.js";
import {
  computeFace3dWeights,
  normalizeFace3dFrame,
  resolveFace3dPalette,
} from "./face-3d.js";

const TAU = Math.PI * 2;
const HEAD_LATITUDES = 48;
const HEAD_LONGITUDES = 64;
const PRIMITIVE_LATITUDES = 16;
const PRIMITIVE_LONGITUDES = 24;
const HEAD_RADIUS_X = 0.68;
const HEAD_RADIUS_Y = 0.94;
const HEAD_RADIUS_Z = 0.65;
const DEFAULT_CANVAS_SIZE = 360;

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

function jawTaper(y) {
  return 1 - 0.2 * smoothstep(0.16, 0.92, -y);
}

function appendOrientedTriangle(positionList, indexList, a, b, c) {
  const ax = positionList[a * 3];
  const ay = positionList[a * 3 + 1];
  const az = positionList[a * 3 + 2];
  const bx = positionList[b * 3];
  const by = positionList[b * 3 + 1];
  const bz = positionList[b * 3 + 2];
  const cx = positionList[c * 3];
  const cy = positionList[c * 3 + 1];
  const cz = positionList[c * 3 + 2];
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const centreX = (ax + bx + cx) / 3;
  const centreY = (ay + by + cy) / 3;
  const centreZ = (az + bz + cz) / 3;
  if (nx * centreX + ny * centreY + nz * centreZ >= 0) {
    indexList.push(a, b, c);
  } else {
    indexList.push(a, c, b);
  }
}

function calculateSmoothNormals(positions, indices, target) {
  const normals = target?.length === positions.length
    ? target
    : new Float32Array(positions.length);
  normals.fill(0);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] * 3;
    const b = indices[offset + 1] * 3;
    const c = indices[offset + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [a, b, c]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    normals[offset] /= length;
    normals[offset + 1] /= length;
    normals[offset + 2] /= length;
  }
  return normals;
}

function createClosedUvMesh(latitudeCount, longitudeCount, pointAt) {
  const positions = [...pointAt(0, 0)];
  for (let latitude = 1; latitude < latitudeCount; latitude += 1) {
    const theta = (Math.PI * latitude) / latitudeCount;
    for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
      const phi = (TAU * longitude) / longitudeCount;
      positions.push(...pointAt(theta, phi));
    }
  }
  const bottomIndex = positions.length / 3;
  positions.push(...pointAt(Math.PI, 0));
  const indices = [];
  const ringIndex = (ring, longitude) =>
    1 + ring * longitudeCount + ((longitude + longitudeCount) % longitudeCount);

  for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
    appendOrientedTriangle(positions, indices, 0, ringIndex(0, longitude), ringIndex(0, longitude + 1));
  }
  for (let ring = 0; ring < latitudeCount - 2; ring += 1) {
    for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
      const upperLeft = ringIndex(ring, longitude);
      const upperRight = ringIndex(ring, longitude + 1);
      const lowerLeft = ringIndex(ring + 1, longitude);
      const lowerRight = ringIndex(ring + 1, longitude + 1);
      appendOrientedTriangle(positions, indices, upperLeft, lowerLeft, upperRight);
      appendOrientedTriangle(positions, indices, upperRight, lowerLeft, lowerRight);
    }
  }
  const finalRing = latitudeCount - 2;
  for (let longitude = 0; longitude < longitudeCount; longitude += 1) {
    appendOrientedTriangle(
      positions,
      indices,
      ringIndex(finalRing, longitude),
      bottomIndex,
      ringIndex(finalRing, longitude + 1),
    );
  }

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint16Array(indices);
  return Object.freeze({
    positions: positionArray,
    normals: calculateSmoothNormals(positionArray, indexArray),
    indices: indexArray,
    vertexCount: positionArray.length / 3,
    triangleCount: indexArray.length / 3,
  });
}

const HEAD_MESH = createClosedUvMesh(
  HEAD_LATITUDES,
  HEAD_LONGITUDES,
  (theta, phi) => {
    const y = HEAD_RADIUS_Y * Math.cos(theta);
    const radius = Math.sin(theta);
    return [
      HEAD_RADIUS_X * radius * Math.cos(phi) * jawTaper(y),
      y,
      HEAD_RADIUS_Z * radius * Math.sin(phi),
    ];
  },
);

const UNIT_SPHERE = createClosedUvMesh(
  PRIMITIVE_LATITUDES,
  PRIMITIVE_LONGITUDES,
  (theta, phi) => [
    Math.sin(theta) * Math.cos(phi),
    Math.cos(theta),
    Math.sin(theta) * Math.sin(phi),
  ],
);

function matrixCoordinate(index) {
  return Number((-1 + index * 0.2).toFixed(10));
}

function createMatrixStateCache() {
  const states = [];
  for (let row = 0; row < 11; row += 1) {
    for (let column = 0; column < 11; column += 1) {
      const x = matrixCoordinate(column);
      const y = matrixCoordinate(row);
      states.push(Object.freeze({
        row,
        column,
        x,
        y,
        expression: interpolateFaceExpression(x, y),
        weights: computeFace3dWeights({ currentX: x, currentY: y }),
      }));
    }
  }
  return Object.freeze(states);
}

/** Runtime-only cache: 121 small expression records, never an image/mesh atlas. */
export const FACE_WEBGL_MATRIX_STATES = createMatrixStateCache();

function cachedMatrixState(x, y) {
  const column = Math.round((x + 1) * 5);
  const row = Math.round((y + 1) * 5);
  if (column < 0 || column > 10 || row < 0 || row > 10) return null;
  const candidate = FACE_WEBGL_MATRIX_STATES[row * 11 + column];
  return Math.abs(candidate.x - x) <= 1e-9 && Math.abs(candidate.y - y) <= 1e-9
    ? candidate
    : null;
}

export const FACE_WEBGL_METRICS = Object.freeze({
  matrixStateCount: FACE_WEBGL_MATRIX_STATES.length,
  headVertices: HEAD_MESH.vertexCount,
  headTriangles: HEAD_MESH.triangleCount,
  primitiveVertices: UNIT_SPHERE.vertexCount,
  primitiveTriangles: UNIT_SPHERE.triangleCount,
  staticGpuBufferBytes: (
    HEAD_MESH.positions.byteLength
    + HEAD_MESH.normals.byteLength
    + HEAD_MESH.indices.byteLength
    + UNIT_SPHERE.positions.byteLength
    + UNIT_SPHERE.normals.byteLength
    + UNIT_SPHERE.indices.byteLength
  ),
  perFrameBufferUpdates: 0,
});

/** Build the expression state without reading time, targets, input, or persistence. */
export function buildFaceWebglState(
  snapshot = {},
  reducedMotion = false,
  presentationColor,
) {
  const frame = normalizeFace3dFrame(snapshot, reducedMotion, presentationColor);
  const cached = cachedMatrixState(frame.currentX, frame.currentY);
  const expression = cached?.expression
    ?? interpolateFaceExpression(frame.currentX, frame.currentY);
  const weights = cached?.weights
    ?? computeFace3dWeights({ currentX: frame.currentX, currentY: frame.currentY });
  const pulse = frame.reducedMotion ? 0 : Math.sin(frame.phase);
  return Object.freeze({
    frame,
    expression,
    weights,
    matrixCacheHit: Boolean(cached),
    pulse,
    animatedJawOpen: clamp01(expression.mouthOpen * (1 + pulse * 0.012)),
    headScale: 1,
    rotation: Object.freeze({
      yaw: 0,
      pitch: 0,
    }),
  });
}

function deformHeadPoint(x, y, z, state) {
  const originalX = x;
  const originalY = y;
  const originalZ = z;
  const front = smoothstep(-0.1, 0.5, originalZ);
  const lowerFace = smoothstep(0.14, 0.9, -originalY) * front;
  const cheek = gaussian(Math.abs(originalX), 0.31, 0.2)
    * gaussian(originalY, -0.01, 0.3) * front;
  const mouthSocket = gaussian(originalX, 0, 0.4)
    * gaussian(originalY, -0.31, 0.2) * front;
  const eyeSocket = gaussian(Math.abs(originalX), 0.265, 0.14)
    * gaussian(originalY, 0.14, 0.13) * front;
  const noseRidge = gaussian(originalX, 0, 0.115)
    * gaussian(originalY, 0.02, 0.31) * front;
  const noseTip = gaussian(originalX, 0, 0.13)
    * gaussian(originalY, -0.105, 0.13) * front;
  const chin = gaussian(originalX, 0, 0.28)
    * gaussian(originalY, -0.69, 0.19) * front;

  y -= 0.072 * state.animatedJawOpen * lowerFace * lowerFace;
  x *= 1 - 0.04 * state.animatedJawOpen * lowerFace;
  y += 0.02 * state.weights.smile * cheek;
  z += 0.037 * state.weights.smile * cheek;
  z -= 0.013 * state.weights.frown * cheek;
  z -= 0.019 * state.animatedJawOpen * mouthSocket;
  z -= 0.022 * eyeSocket;
  z += 0.105 * noseRidge + 0.045 * noseTip + 0.02 * chin;
  z += 0.008 * state.expression.browLift
    * gaussian(Math.abs(originalX), 0.26, 0.28)
    * gaussian(originalY, 0.39, 0.19) * front;
  return { x, y, z };
}

/**
 * CPU conformance geometry for tests and non-rendering consumers. The WebGL
 * renderer performs the same deformation in its vertex shader on static data.
 */
export function buildFaceWebglGeometry(
  snapshot = {},
  reducedMotion = false,
  presentationColor,
  reusable = {},
) {
  const state = buildFaceWebglState(snapshot, reducedMotion, presentationColor);
  const positions = reusable.positions?.length === HEAD_MESH.positions.length
    ? reusable.positions
    : new Float32Array(HEAD_MESH.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const point = deformHeadPoint(
      HEAD_MESH.positions[offset],
      HEAD_MESH.positions[offset + 1],
      HEAD_MESH.positions[offset + 2],
      state,
    );
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
  }
  const normals = calculateSmoothNormals(positions, HEAD_MESH.indices, reusable.normals);
  return Object.freeze({ state, positions, normals, indices: HEAD_MESH.indices });
}

function surfaceZ(x, y) {
  const normalY = clamp(y / HEAD_RADIUS_Y);
  const slice = Math.sqrt(Math.max(0, 1 - normalY * normalY));
  const xLimit = Math.max(0.0001, HEAD_RADIUS_X * slice * jawTaper(y));
  const normalX = clamp(x / xLimit);
  return HEAD_RADIUS_Z * slice * Math.sqrt(Math.max(0, 1 - normalX * normalX));
}

function featurePoint(x, y, offset, state) {
  const point = deformHeadPoint(x, y, surfaceZ(x, y), state);
  point.z += offset;
  return point;
}

function component(role, position, scale, rotationZ = 0, specular = 0.12) {
  return Object.freeze({
    role,
    position: Object.freeze([...position]),
    scale: Object.freeze([...scale]),
    rotationZ,
    specular,
  });
}

function componentBetween(role, start, end, thickness, depth, specular = 0.08) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  return component(
    role,
    [(start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5],
    [Math.max(0.001, Math.hypot(dx, dy, dz) * 0.52), thickness, depth],
    Math.atan2(dy, dx),
    specular,
  );
}

function quadraticPoint(start, control, end, amount) {
  const inverse = 1 - amount;
  return {
    x: inverse * inverse * start.x + 2 * inverse * amount * control.x + amount * amount * end.x,
    y: inverse * inverse * start.y + 2 * inverse * amount * control.y + amount * amount * end.y,
  };
}

function appendCurveComponents(components, role, points, state, thickness, depth) {
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = featurePoint(points[index].x, points[index].y, 0.045, state);
    const end = featurePoint(points[index + 1].x, points[index + 1].y, 0.045, state);
    components.push(componentBetween(role, start, end, thickness, depth));
  }
}

/** Build the smooth primitive placements used around the continuous head mesh. */
export function buildFaceWebglComponents(state) {
  const expression = state.expression;
  const components = [];
  components.push(component("skinShadow", [0, -1.04, -0.22], [0.29, 0.5, 0.24], 0, 0.08));
  components.push(component("skinShadow", [-0.69, 0.015, -0.015], [0.105, 0.19, 0.07], 0, 0.08));
  components.push(component("skinShadow", [0.69, 0.015, -0.015], [0.105, 0.19, 0.07], 0, 0.08));

  const eyeY = 0.14 + expression.browLift * 0.008;
  const eyeHeight = 0.017 + expression.eyeOpen * 0.052;
  for (const side of [-1, 1]) {
    const eye = featurePoint(side * 0.265, eyeY, 0.018, state);
    components.push(component("sclera", [eye.x, eye.y, eye.z], [0.128, eyeHeight, 0.044], 0, 0.24));
    const irisRadius = Math.min(0.043, eyeHeight * 0.72 + 0.01);
    components.push(component("iris", [eye.x, eye.y, eye.z + 0.044], [irisRadius, irisRadius, 0.012], 0, 0.34));
    components.push(component("feature", [eye.x, eye.y, eye.z + 0.054], [irisRadius * 0.45, irisRadius * 0.45, 0.009], 0, 0.38));
    components.push(component(
      "highlight",
      [eye.x - irisRadius * 0.28, eye.y + irisRadius * 0.28, eye.z + 0.064],
      [irisRadius * 0.14, irisRadius * 0.14, 0.006],
      0,
      0.6,
    ));
  }

  const outerBrowY = 0.395 + 0.07 * expression.browLift;
  const innerBrowY = outerBrowY + 0.066 * expression.innerBrowLift;
  for (const side of [-1, 1]) {
    const outer = featurePoint(side * 0.46, outerBrowY, 0.036, state);
    const middle = featurePoint(side * 0.29, (outerBrowY + innerBrowY) * 0.5 + 0.018, 0.04, state);
    const inner = featurePoint(side * 0.12, innerBrowY, 0.036, state);
    components.push(componentBetween("feature", outer, middle, 0.025, 0.019));
    components.push(componentBetween("feature", middle, inner, 0.027, 0.019));
  }

  for (const side of [-1, 1]) {
    const nostril = featurePoint(side * 0.052, -0.14, 0.022, state);
    components.push(component("featureSoft", [nostril.x, nostril.y, nostril.z], [0.022, 0.011, 0.007], 0, 0.04));
  }

  const mouthWidth = 0.3 + Math.abs(expression.mouthCurve) * 0.012;
  const mouthBase = -0.315;
  const cornerY = mouthBase + expression.mouthCurve * 0.048;
  const centreY = mouthBase - expression.mouthCurve * 0.116;
  const open = state.animatedJawOpen * 0.056;
  const left = { x: -mouthWidth, y: cornerY };
  const right = { x: mouthWidth, y: cornerY };
  const upperControl = { x: 0, y: centreY + open };
  const lowerControl = { x: 0, y: centreY - open };
  const upper = [];
  const lower = [];
  for (let index = 0; index <= 6; index += 1) {
    const amount = index / 6;
    upper.push(quadraticPoint(left, upperControl, right, amount));
    lower.push(quadraticPoint(left, lowerControl, right, amount));
  }
  const cavity = featurePoint(0, centreY, 0.026, state);
  components.push(component(
    "mouth",
    [cavity.x, cavity.y, cavity.z],
    [mouthWidth * 0.9, Math.max(0.006, open * 0.82), 0.018],
    0,
    0.02,
  ));
  appendCurveComponents(components, "lip", upper, state, 0.014, 0.014);
  appendCurveComponents(components, "lip", lower, state, 0.014, 0.014);
  return Object.freeze(components);
}

function identityMatrix() {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
}

function multiplyMatrices(first, second) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        first[row] * second[column * 4]
        + first[4 + row] * second[column * 4 + 1]
        + first[8 + row] * second[column * 4 + 2]
        + first[12 + row] * second[column * 4 + 3];
    }
  }
  return result;
}

function translationMatrix(x, y, z) {
  const matrix = identityMatrix();
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

function scaleMatrix(x, y, z) {
  const matrix = identityMatrix();
  matrix[0] = x;
  matrix[5] = y;
  matrix[10] = z;
  return matrix;
}

function rotationXMatrix(angle) {
  const matrix = identityMatrix();
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  matrix[5] = cosine;
  matrix[6] = sine;
  matrix[9] = -sine;
  matrix[10] = cosine;
  return matrix;
}

function rotationYMatrix(angle) {
  const matrix = identityMatrix();
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  matrix[0] = cosine;
  matrix[2] = -sine;
  matrix[8] = sine;
  matrix[10] = cosine;
  return matrix;
}

function rotationZMatrix(angle) {
  const matrix = identityMatrix();
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  matrix[0] = cosine;
  matrix[1] = sine;
  matrix[4] = -sine;
  matrix[5] = cosine;
  return matrix;
}

function perspectiveMatrix(fieldOfView, aspect, near, far) {
  const inverseTan = 1 / Math.tan(fieldOfView * 0.5);
  const range = 1 / (near - far);
  return new Float32Array([
    inverseTan / Math.max(0.01, aspect), 0, 0, 0,
    0, inverseTan, 0, 0,
    0, 0, (far + near) * range, -1,
    0, 0, 2 * far * near * range, 0,
  ]);
}

function normalMatrixFrom(modelView) {
  const a00 = modelView[0];
  const a01 = modelView[1];
  const a02 = modelView[2];
  const a10 = modelView[4];
  const a11 = modelView[5];
  const a12 = modelView[6];
  const a20 = modelView[8];
  const a21 = modelView[9];
  const a22 = modelView[10];
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const determinant = a00 * b01 + a01 * b11 + a02 * b21;
  const inverse = 1 / (determinant || 1);
  return new Float32Array([
    b01 * inverse,
    (-a22 * a01 + a02 * a21) * inverse,
    (a12 * a01 - a02 * a11) * inverse,
    b11 * inverse,
    (a22 * a00 - a02 * a20) * inverse,
    (-a12 * a00 + a02 * a10) * inverse,
    b21 * inverse,
    (-a21 * a00 + a01 * a20) * inverse,
    (a11 * a00 - a01 * a10) * inverse,
  ]);
}

const DEFORM_GLSL = `
uniform float uDeformHead;
uniform vec4 uHeadDeform;

float bell(float value, float centre, float spread) {
  float distance = (value - centre) / spread;
  return exp(-(distance * distance));
}

vec3 deformHead(vec3 point) {
  if (uDeformHead < 0.5) return point;
  vec3 original = point;
  float front = smoothstep(-0.1, 0.5, original.z);
  float lowerFace = smoothstep(0.14, 0.9, -original.y) * front;
  float cheek = bell(abs(original.x), 0.31, 0.2) * bell(original.y, -0.01, 0.3) * front;
  float mouthSocket = bell(original.x, 0.0, 0.4) * bell(original.y, -0.31, 0.2) * front;
  float eyeSocket = bell(abs(original.x), 0.265, 0.14) * bell(original.y, 0.14, 0.13) * front;
  float noseRidge = bell(original.x, 0.0, 0.115) * bell(original.y, 0.02, 0.31) * front;
  float noseTip = bell(original.x, 0.0, 0.13) * bell(original.y, -0.105, 0.13) * front;
  float chin = bell(original.x, 0.0, 0.28) * bell(original.y, -0.69, 0.19) * front;
  point.y -= 0.072 * uHeadDeform.z * lowerFace * lowerFace;
  point.x *= 1.0 - 0.04 * uHeadDeform.z * lowerFace;
  point.y += 0.02 * uHeadDeform.x * cheek;
  point.z += 0.037 * uHeadDeform.x * cheek;
  point.z -= 0.013 * uHeadDeform.y * cheek;
  point.z -= 0.019 * uHeadDeform.z * mouthSocket;
  point.z -= 0.022 * eyeSocket;
  point.z += 0.105 * noseRidge + 0.045 * noseTip + 0.02 * chin;
  point.z += 0.008 * uHeadDeform.w * bell(abs(original.x), 0.26, 0.28)
    * bell(original.y, 0.39, 0.19) * front;
  return point;
}
`;

function vertexShaderSource(webgl2) {
  const declarations = webgl2
    ? `#version 300 es
in vec3 aPosition;
in vec3 aNormal;
out vec3 vNormal;
out vec3 vViewPosition;`
    : `attribute vec3 aPosition;
attribute vec3 aNormal;
varying vec3 vNormal;
varying vec3 vViewPosition;`;
  return `${declarations}
precision highp float;
uniform mat4 uModelViewProjection;
uniform mat4 uModelView;
uniform mat3 uNormalMatrix;
${DEFORM_GLSL}
void main() {
  vec3 position = deformHead(aPosition);
  vec3 normal = aNormal;
  if (uDeformHead > 0.5) {
    vec3 reference = abs(aNormal.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(reference, aNormal));
    vec3 bitangent = normalize(cross(aNormal, tangent));
    vec3 tangentPosition = deformHead(aPosition + tangent * 0.0045);
    vec3 bitangentPosition = deformHead(aPosition + bitangent * 0.0045);
    normal = normalize(cross(tangentPosition - position, bitangentPosition - position));
    if (dot(normal, aNormal) < 0.0) normal = -normal;
  }
  vec4 viewPosition = uModelView * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vNormal = normalize(uNormalMatrix * normal);
  gl_Position = uModelViewProjection * vec4(position, 1.0);
}`;
}

function fragmentShaderSource(webgl2) {
  const declarations = webgl2
    ? `#version 300 es
in vec3 vNormal;
in vec3 vViewPosition;
out vec4 outColor;`
    : `varying vec3 vNormal;
varying vec3 vViewPosition;`;
  const output = webgl2 ? "outColor" : "gl_FragColor";
  return `${declarations}
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSpecular;
void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDirection = normalize(-vViewPosition);
  vec3 keyDirection = normalize(vec3(-0.42, 0.72, 0.72));
  vec3 fillDirection = normalize(vec3(0.64, 0.12, 0.48));
  float key = max(dot(normal, keyDirection), 0.0);
  float fill = max(dot(normal, fillDirection), 0.0);
  vec3 halfDirection = normalize(keyDirection + viewDirection);
  float specular = pow(max(dot(normal, halfDirection), 0.0), 42.0) * uSpecular;
  float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0) * 0.055;
  vec3 lit = uColor * (0.34 + 0.56 * key + 0.16 * fill + rim) + vec3(specular);
  ${output} = vec4(clamp(lit, 0.0, 1.0), uOpacity);
}`;
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate a WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const details = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(details);
  }
  return shader;
}

function createProgram(gl, webgl2) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource(webgl2));
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource(webgl2));
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to allocate a WebGL program.");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const details = gl.getProgramInfoLog(program) || "Unknown WebGL link error.";
    gl.deleteProgram(program);
    throw new Error(details);
  }
  return program;
}

function createGpuMesh(gl, mesh) {
  const position = gl.createBuffer();
  const normal = gl.createBuffer();
  const index = gl.createBuffer();
  if (!position || !normal || !index) throw new Error("Unable to allocate WebGL mesh buffers.");
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, normal);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  return Object.freeze({ position, normal, index, count: mesh.indices.length });
}

function findCanvas(root) {
  if (typeof root?.getContext === "function") return root;
  return root?.querySelector?.("canvas[data-face-webgl], canvas") ?? null;
}

function findFallback(root) {
  return root?.querySelector?.(
    "[data-face-webgl-fallback], .face-webgl-fallback, [data-face-3d-fallback], .face-3d-fallback",
  ) ?? null;
}

function findCanvas2d(root) {
  return root?.querySelector?.("[data-face-canvas2d]") ?? null;
}

function setFallbackVisibility(root, canvas, canvas2d, fallback, useFallback) {
  if (canvas?.style) canvas.style.visibility = useFallback ? "hidden" : "";
  if (canvas2d) {
    canvas2d.hidden = !useFallback;
    if (canvas2d.style) canvas2d.style.visibility = useFallback ? "" : "hidden";
    canvas2d.setAttribute?.("aria-hidden", String(!useFallback));
  }
  if (fallback) {
    fallback.hidden = !useFallback;
    fallback.setAttribute?.("aria-hidden", String(!useFallback));
  }
  if (root?.dataset) root.dataset.faceWebglMode = useFallback ? "fallback" : "webgl";
}

function normalizedColor(color) {
  return color.map((channel) => channel / 255);
}

function materialPalette(presentationColor) {
  const palette = resolveFace3dPalette(presentationColor);
  const porcelain = [218, 207, 196];
  const tint = (base, accent, amount) => base.map((channel, index) =>
    channel + (accent[index] - channel) * amount);
  const skin = tint(porcelain, palette.accent, 0.1);
  const darkerSkin = skin.map((channel) => channel * 0.69);
  return Object.freeze({
    skin: normalizedColor(skin),
    skinShadow: normalizedColor(darkerSkin),
    sclera: normalizedColor(palette.sclera),
    iris: normalizedColor(tint([61, 66, 63], palette.accent, 0.12)),
    feature: normalizedColor(palette.feature),
    featureSoft: normalizedColor(palette.feature.map((channel) => channel * 1.25)),
    highlight: [1, 0.98, 0.92],
    lip: normalizedColor(tint([124, 79, 82], palette.accent, 0.12)),
    mouth: normalizedColor(palette.mouth),
  });
}

function buildGlobalModel(state) {
  return multiplyMatrices(
    rotationXMatrix(state.rotation.pitch),
    multiplyMatrices(
      rotationYMatrix(state.rotation.yaw),
      scaleMatrix(state.headScale, state.headScale, state.headScale),
    ),
  );
}

function componentModel(globalModel, item) {
  const local = multiplyMatrices(
    translationMatrix(...item.position),
    multiplyMatrices(
      rotationZMatrix(item.rotationZ),
      scaleMatrix(...item.scale),
    ),
  );
  return multiplyMatrices(globalModel, local);
}

/**
 * Create the self-contained GPU renderer. The returned function accepts the
 * exact shared `(snapshot, reducedMotion, presentationColor)` call signature.
 */
export function createFaceWebglRenderer(root, options = {}) {
  const canvas = findCanvas(root);
  const canvas2d = findCanvas2d(root);
  const fallback = findFallback(root);
  const fallbackRenderer = typeof options.fallbackRenderer === "function"
    ? options.fallbackRenderer
    : null;
  const maxDpr = clamp(
    Number.isFinite(options.maxDevicePixelRatio) ? options.maxDevicePixelRatio : 2,
    1,
    4,
  );
  let gl = null;
  let resources = null;
  let contextLost = false;
  let destroyed = false;
  let resizeDirty = true;
  let width = DEFAULT_CANVAS_SIZE;
  let height = DEFAULT_CANVAS_SIZE;
  let activeMode = "fallback";
  let lastError = null;
  let lastCall = null;

  const setMode = (mode) => {
    const useFallback = mode === "fallback";
    setFallbackVisibility(root, canvas, canvas2d, fallback, useFallback);
    if (mode === activeMode) return;
    activeMode = mode;
    options.onModeChange?.(mode);
  };

  const disposeResources = () => {
    if (!gl || !resources) {
      resources = null;
      return;
    }
    for (const mesh of [resources.head, resources.primitive]) {
      gl.deleteBuffer?.(mesh.position);
      gl.deleteBuffer?.(mesh.normal);
      gl.deleteBuffer?.(mesh.index);
    }
    gl.deleteProgram?.(resources.program);
    resources = null;
  };

  const acquire = () => {
    if (!canvas || destroyed || contextLost) return false;
    if (gl && resources) return true;
    const attributes = {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    };
    try {
      gl = canvas.getContext("webgl2", attributes);
      let webgl2 = Boolean(gl);
      if (!gl) {
        gl = canvas.getContext("webgl", attributes)
          || canvas.getContext("experimental-webgl", attributes);
        webgl2 = false;
      }
      if (!gl) return false;
      const program = createProgram(gl, webgl2);
      const head = createGpuMesh(gl, HEAD_MESH);
      const primitive = createGpuMesh(gl, UNIT_SPHERE);
      resources = Object.freeze({
        webgl2,
        mode: webgl2 ? "webgl2" : "webgl",
        program,
        head,
        primitive,
        attributes: Object.freeze({
          position: gl.getAttribLocation(program, "aPosition"),
          normal: gl.getAttribLocation(program, "aNormal"),
        }),
        uniforms: Object.freeze({
          modelViewProjection: gl.getUniformLocation(program, "uModelViewProjection"),
          modelView: gl.getUniformLocation(program, "uModelView"),
          normalMatrix: gl.getUniformLocation(program, "uNormalMatrix"),
          color: gl.getUniformLocation(program, "uColor"),
          opacity: gl.getUniformLocation(program, "uOpacity"),
          specular: gl.getUniformLocation(program, "uSpecular"),
          deformHead: gl.getUniformLocation(program, "uDeformHead"),
          headDeform: gl.getUniformLocation(program, "uHeadDeform"),
        }),
      });
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      lastError = null;
      return true;
    } catch (error) {
      lastError = error;
      disposeResources();
      gl = null;
      return false;
    }
  };

  const resize = () => {
    resizeDirty = false;
    const bounds = canvas?.getBoundingClientRect?.();
    const measuredWidth = bounds?.width || canvas?.clientWidth;
    const measuredHeight = bounds?.height || canvas?.clientHeight;
    if (Number.isFinite(measuredWidth) && measuredWidth > 0) width = measuredWidth;
    if (Number.isFinite(measuredHeight) && measuredHeight > 0) height = measuredHeight;
    const deviceDpr = Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1;
    const dpr = clamp(deviceDpr, 1, maxDpr);
    if (canvas) {
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    }
    gl?.viewport(0, 0, canvas?.width ?? 1, canvas?.height ?? 1);
    return Object.freeze({ width, height, dpr });
  };

  const renderFallback = (snapshot, reducedMotion, presentationColor) => {
    setMode("fallback");
    const result = fallbackRenderer?.(snapshot, reducedMotion, presentationColor);
    return Object.freeze({ mode: "fallback", result, error: lastError });
  };

  const bindMesh = (mesh) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.position);
    gl.enableVertexAttribArray(resources.attributes.position);
    gl.vertexAttribPointer(resources.attributes.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normal);
    gl.enableVertexAttribArray(resources.attributes.normal);
    gl.vertexAttribPointer(resources.attributes.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.index);
  };

  const drawMesh = (mesh, model, view, projection, color, item, deform) => {
    const modelView = multiplyMatrices(view, model);
    const mvp = multiplyMatrices(projection, modelView);
    gl.uniformMatrix4fv(resources.uniforms.modelViewProjection, false, mvp);
    gl.uniformMatrix4fv(resources.uniforms.modelView, false, modelView);
    gl.uniformMatrix3fv(resources.uniforms.normalMatrix, false, normalMatrixFrom(modelView));
    gl.uniform3f(resources.uniforms.color, color[0], color[1], color[2]);
    gl.uniform1f(resources.uniforms.opacity, 1);
    gl.uniform1f(resources.uniforms.specular, item?.specular ?? 0.14);
    gl.uniform1f(resources.uniforms.deformHead, deform ? 1 : 0);
    gl.uniform4f(
      resources.uniforms.headDeform,
      deform?.weights.smile ?? 0,
      deform?.weights.frown ?? 0,
      deform?.animatedJawOpen ?? 0,
      deform?.expression.browLift ?? 0,
    );
    bindMesh(mesh);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  };

  const render = (snapshot, reducedMotion = false, presentationColor) => {
    lastCall = { snapshot, reducedMotion, presentationColor };
    if (!acquire()) return renderFallback(snapshot, reducedMotion, presentationColor);
    try {
      if (resizeDirty) resize();
      const state = buildFaceWebglState(snapshot, reducedMotion, presentationColor);
      const components = buildFaceWebglComponents(state);
      const palette = materialPalette(state.frame.presentationColor);
      const globalModel = buildGlobalModel(state);
      const view = translationMatrix(0, 0.08, -3.45);
      const projection = perspectiveMatrix(
        (38 * Math.PI) / 180,
        (canvas?.width || 1) / (canvas?.height || 1),
        0.1,
        10,
      );
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(resources.program);
      drawMesh(resources.head, globalModel, view, projection, palette.skin, null, state);
      for (const item of components) {
        drawMesh(
          resources.primitive,
          componentModel(globalModel, item),
          view,
          projection,
          palette[item.role] ?? palette.feature,
          item,
          null,
        );
      }
      setMode(resources.mode);
      lastError = null;
      return Object.freeze({
        mode: resources.mode,
        expression: state.expression,
        weights: state.weights,
        matrixCacheHit: state.matrixCacheHit,
        headScale: state.headScale,
        componentCount: components.length,
        bufferUpdates: 0,
      });
    } catch (error) {
      lastError = error;
      disposeResources();
      gl = null;
      return renderFallback(snapshot, reducedMotion, presentationColor);
    }
  };

  const onContextLost = (event) => {
    event?.preventDefault?.();
    contextLost = true;
    resources = null;
    gl = null;
    lastError = new Error("WebGL context lost; using the local fallback renderer.");
    if (lastCall) renderFallback(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
    else setMode("fallback");
  };
  const onContextRestored = () => {
    contextLost = false;
    resizeDirty = true;
    if (!lastCall) return;
    render(lastCall.snapshot, lastCall.reducedMotion, lastCall.presentationColor);
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
    return acquire() ? resize() : Object.freeze({ width, height, dpr: 1 });
  };
  render.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.("resize", onResize);
    canvas?.removeEventListener?.("webglcontextlost", onContextLost);
    canvas?.removeEventListener?.("webglcontextrestored", onContextRestored);
    disposeResources();
    gl = null;
    activeMode = "destroyed";
  };
  Object.defineProperties(render, {
    mode: { enumerable: true, get: () => activeMode },
    available: {
      enumerable: true,
      get: () => !destroyed && !contextLost && Boolean(gl && resources)
        && (activeMode === "webgl" || activeMode === "webgl2"),
    },
    error: { enumerable: true, get: () => lastError },
    lastError: { enumerable: true, get: () => lastError },
  });

  // Context creation is intentionally lazy. Hidden desktop/mobile surfaces do
  // not allocate GPU resources until their first render or explicit resize.
  setMode("fallback");
  return render;
}
