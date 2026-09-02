const clamp = (value, minimum = -1, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));

const freezeExpression = (mouthCurve, mouthOpen, eyeOpen, browLift, innerBrowLift) =>
  Object.freeze({ mouthCurve, mouthOpen, eyeOpen, browLift, innerBrowLift });

export const FACE_AFFECT_ANCHORS = Object.freeze([
  Object.freeze([
    freezeExpression(-0.85, 0.03, 0.20, -0.15, 0.65),
    freezeExpression(0.00, 0.00, 0.28, -0.10, 0.00),
    freezeExpression(0.65, 0.02, 0.25, -0.05, 0.00),
  ]),
  Object.freeze([
    freezeExpression(-0.90, 0.08, 0.43, 0.00, 0.55),
    freezeExpression(0.00, 0.00, 0.50, 0.00, 0.00),
    freezeExpression(0.85, 0.08, 0.45, 0.05, 0.00),
  ]),
  Object.freeze([
    freezeExpression(-0.45, 0.85, 1.00, 0.75, 0.80),
    freezeExpression(0.00, 0.72, 1.00, 0.75, 0.20),
    freezeExpression(0.95, 0.68, 0.82, 0.55, 0.00),
  ]),
]);

const expressionKeys = Object.freeze([
  "mouthCurve",
  "mouthOpen",
  "eyeOpen",
  "browLift",
  "innerBrowLift",
]);

function axisSegment(value) {
  return value <= 0 ? { low: 0, high: 1, mix: value + 1 } : { low: 1, high: 2, mix: value };
}

const mix = (start, end, amount) => start + (end - start) * amount;

export function interpolateFaceExpression(x, y) {
  const safeX = clamp(x);
  const safeY = clamp(y);
  const horizontal = axisSegment(safeX);
  const vertical = axisSegment(safeY);
  const result = {};
  for (const key of expressionKeys) {
    const lower = mix(
      FACE_AFFECT_ANCHORS[vertical.low][horizontal.low][key],
      FACE_AFFECT_ANCHORS[vertical.low][horizontal.high][key],
      horizontal.mix,
    );
    const upper = mix(
      FACE_AFFECT_ANCHORS[vertical.high][horizontal.low][key],
      FACE_AFFECT_ANCHORS[vertical.high][horizontal.high][key],
      horizontal.mix,
    );
    result[key] = mix(lower, upper, vertical.mix);
  }
  return Object.freeze(result);
}

const point = (value) => Number(value.toFixed(4));

export function buildFaceGeometry({ x = 0, y = 0, phase = 0, reducedMotion = false } = {}) {
  const safeX = clamp(x);
  const safeY = clamp(y);
  const safePhase = Number.isFinite(phase) ? phase : 0;
  const expression = interpolateFaceExpression(safeX, safeY);
  const activation = (safeY + 1) * 0.5;
  const pulse = reducedMotion ? 0 : Math.sin(safePhase);
  const mouthOpen = clamp(expression.mouthOpen * (1 + pulse * 0.06), 0, 1.1);
  const eyeRy = 0.035 + 0.085 * expression.eyeOpen;
  const browOuterY = -0.42 - 0.08 * expression.browLift;
  const browInnerY = browOuterY - 0.08 * expression.innerBrowLift;
  const mouthCornerY = 0.36 - 0.04 * expression.mouthCurve;
  const mouthControlY = 0.36 + 0.15 * expression.mouthCurve;
  const mouthHalfOpen = 0.055 * mouthOpen;
  const headScale = 1 + 0.015 * activation * pulse;

  return Object.freeze({
    x: safeX,
    y: safeY,
    expression,
    headScale,
    eyeRy,
    leftBrowPath: `M -0.55 ${point(browOuterY)} L -0.18 ${point(browInnerY)}`,
    rightBrowPath: `M 0.18 ${point(browInnerY)} L 0.55 ${point(browOuterY)}`,
    mouthPath: [
      `M -0.42 ${point(mouthCornerY)}`,
      `Q 0 ${point(mouthControlY - mouthHalfOpen)} 0.42 ${point(mouthCornerY)}`,
      `Q 0 ${point(mouthControlY + mouthHalfOpen)} -0.42 ${point(mouthCornerY)}`,
      "Z",
    ].join(" "),
  });
}

export function createFaceRenderer(root) {
  const svg = root.querySelector("svg");
  const leftEye = root.querySelector(".face-eye-left");
  const rightEye = root.querySelector(".face-eye-right");
  const leftBrow = root.querySelector(".face-brow-left");
  const rightBrow = root.querySelector(".face-brow-right");
  const mouth = root.querySelector(".face-mouth");

  return (snapshot, reducedMotion = false, affectColor) => {
    const geometry = buildFaceGeometry({
      x: snapshot.currentX,
      y: snapshot.currentY,
      phase: snapshot.phase,
      reducedMotion,
    });
    leftEye.setAttribute("ry", geometry.eyeRy.toFixed(4));
    rightEye.setAttribute("ry", geometry.eyeRy.toFixed(4));
    leftBrow.setAttribute("d", geometry.leftBrowPath);
    rightBrow.setAttribute("d", geometry.rightBrowPath);
    mouth.setAttribute("d", geometry.mouthPath);
    root.style.setProperty("--affect-color", affectColor);
    svg.style.opacity = String(snapshot.overlayOpacity ?? 1);
    svg.style.transform = `scale(${geometry.headScale.toFixed(5)})`;
    return geometry;
  };
}
