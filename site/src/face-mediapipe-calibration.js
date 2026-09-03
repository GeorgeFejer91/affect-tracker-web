const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const signal = (values) => Object.freeze(values);

/**
 * Compact summaries of 52 MediaPipe Face Landmarker blendshape scores extracted
 * once from the nine project-owned photoreal atlas cells. Rows are low, neutral,
 * high arousal; columns are negative, neutral, positive valence. Runtime code
 * ships no recognition model and requests no camera.
 */
export const MEDIAPIPE_ATLAS_SIGNALS = Object.freeze([
  Object.freeze([
    signal({ browDown: 0.0196, browUp: 0.1255, browInnerUp: 0.0208, blink: 0.1883, squint: 0.3752, wide: 0.0032, jawOpen: 0.0029, frown: 0.0135, smile: 0.0000, pucker: 0.4230, funnel: 0.0015, press: 0.0047, shrugLower: 0.1758, shrugUpper: 0.0938, upperUp: 0.0003, lowerDown: 0.0001 }),
    signal({ browDown: 0.0018, browUp: 0.4226, browInnerUp: 0.0555, blink: 0.2386, squint: 0.3485, wide: 0.0024, jawOpen: 0.0022, frown: 0.0045, smile: 0.0001, pucker: 0.3657, funnel: 0.0022, press: 0.0051, shrugLower: 0.0459, shrugUpper: 0.0535, upperUp: 0.0003, lowerDown: 0.0002 }),
    signal({ browDown: 0.0067, browUp: 0.2217, browInnerUp: 0.0238, blink: 0.1544, squint: 0.4869, wide: 0.0038, jawOpen: 0.0007, frown: 0.0002, smile: 0.6893, pucker: 0.0871, funnel: 0.0019, press: 0.0173, shrugLower: 0.0179, shrugUpper: 0.0197, upperUp: 0.0021, lowerDown: 0.0002 }),
  ]),
  Object.freeze([
    signal({ browDown: 0.1499, browUp: 0.0245, browInnerUp: 0.0086, blink: 0.0628, squint: 0.2685, wide: 0.0099, jawOpen: 0.0029, frown: 0.0243, smile: 0.0000, pucker: 0.5286, funnel: 0.0015, press: 0.0036, shrugLower: 0.3502, shrugUpper: 0.1466, upperUp: 0.0004, lowerDown: 0.0001 }),
    signal({ browDown: 0.0053, browUp: 0.3351, browInnerUp: 0.0162, blink: 0.0267, squint: 0.2055, wide: 0.0212, jawOpen: 0.0018, frown: 0.0032, smile: 0.0000, pucker: 0.5494, funnel: 0.0033, press: 0.0049, shrugLower: 0.1013, shrugUpper: 0.0998, upperUp: 0.0005, lowerDown: 0.0001 }),
    signal({ browDown: 0.0071, browUp: 0.2279, browInnerUp: 0.0263, blink: 0.0733, squint: 0.4329, wide: 0.0084, jawOpen: 0.0005, frown: 0.0001, smile: 0.7295, pucker: 0.0785, funnel: 0.0021, press: 0.0194, shrugLower: 0.0223, shrugUpper: 0.0243, upperUp: 0.0031, lowerDown: 0.0002 }),
  ]),
  Object.freeze([
    signal({ browDown: 0.1811, browUp: 0.0163, browInnerUp: 0.0135, blink: 0.0160, squint: 0.1192, wide: 0.0348, jawOpen: 0.0013, frown: 0.0102, smile: 0.0001, pucker: 0.1601, funnel: 0.0010, press: 0.0087, shrugLower: 0.1316, shrugUpper: 0.0819, upperUp: 0.0006, lowerDown: 0.0002 }),
    signal({ browDown: 0.0000, browUp: 0.9343, browInnerUp: 0.8973, blink: 0.0017, squint: 0.0153, wide: 0.3027, jawOpen: 0.1368, frown: 0.0002, smile: 0.0000, pucker: 0.6566, funnel: 0.0737, press: 0.0032, shrugLower: 0.0078, shrugUpper: 0.0403, upperUp: 0.0018, lowerDown: 0.0049 }),
    signal({ browDown: 0.0000, browUp: 0.9220, browInnerUp: 0.8451, blink: 0.0042, squint: 0.0324, wide: 0.2180, jawOpen: 0.1473, frown: 0.0000, smile: 0.7871, pucker: 0.0721, funnel: 0.0899, press: 0.0373, shrugLower: 0.0007, shrugUpper: 0.0120, upperUp: 0.3030, lowerDown: 0.0909 }),
  ]),
]);

export const MEDIAPIPE_ATLAS_METADATA = Object.freeze({
  id: "mediapipe-face-landmarker-atlas-v1",
  extractor: "MediaPipe Face Landmarker blendshape model",
  modelCard: "https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Blendshape%20V2.pdf",
  packageVersion: "0.10.21",
  atlas: "affect-face-atlas-v1.webp",
  extractedAt: "2026-09-03",
  sourceCellCount: 9,
  sourceBlendshapeCount: 52,
});

const axisWeights = (value) => [
  Math.max(0, -value),
  1 - Math.abs(value),
  Math.max(0, value),
];

const BASELINE = MEDIAPIPE_ATLAS_SIGNALS[1][1];

function signalToMorphs(values, column) {
  const excess = (name) => Math.max(0, values[name] - BASELINE[name]);
  const smile = excess("smile");
  const jaw = excess("jawOpen");
  const browUp = Math.max(excess("browUp"), excess("browInnerUp"));
  const browDown = excess("browDown");
  const frown = excess("frown");
  const blink = excess("blink");
  const squint = excess("squint");
  const wide = excess("wide");
  const press = excess("press");
  const shrugLower = excess("shrugLower");
  const shrugUpper = excess("shrugUpper");
  const upperUp = excess("upperUp");
  const lowerDown = excess("lowerDown");

  return Object.freeze({
    Happy: column === 2 ? clamp01(smile * 1.22) : 0,
    Sad: column === 0 ? clamp01(frown * 8 + shrugLower * 3.6) : 0,
    Angry: column === 0 ? clamp01(browDown * 3.9 + press * 2.8) : 0,
    Scared: column === 0 ? clamp01(wide * 1.9 + jaw * 1.4 + browUp * 0.28) : 0,
    Disgusted: column === 0 ? clamp01(upperUp * 2.25 + shrugUpper * 1.5) : 0,
    Smile_Lips_Closed: clamp01(smile * 1.08 * (1 - Math.min(0.8, jaw * 2))),
    Lips_Up_Funnel: clamp01(excess("funnel") * 5 + excess("pucker") * 0.24),
    Lips_Up_Corner_Wide_Left: clamp01(smile * 0.88),
    Lips_Up_Corner_Wide_Right: clamp01(smile * 0.88),
    Eyebrows_Raised_Left: clamp01(browUp * 1.38),
    Eyebrows_Raised_Right: clamp01(browUp * 1.38),
    Eyebrows_Frown_Left: clamp01(browDown * 3.3),
    Eyebrows_Frown_Right: clamp01(browDown * 3.3),
    Eyes_Closed_Max: clamp01(blink * 2.35),
    Eyes_Opened_Max_Left: clamp01(wide * 2.45),
    Eyes_Opened_Max_Right: clamp01(wide * 2.45),
    Eyes_Squint: clamp01(squint * 1.48),
    Jaw_Lower: clamp01(jaw * 2.1),
    Mouth_Large_Opened: clamp01(jaw * 2.65 + lowerDown * 1.2),
  });
}

const MORPH_ANCHORS = Object.freeze(MEDIAPIPE_ATLAS_SIGNALS.map((row) =>
  Object.freeze(row.map((values, column) => signalToMorphs(values, column)))));

export function buildMediapipeAtlasWeights(snapshot = {}) {
  const x = Math.max(-1, Math.min(1, Number.isFinite(snapshot.currentX) ? snapshot.currentX : 0));
  const y = Math.max(-1, Math.min(1, Number.isFinite(snapshot.currentY) ? snapshot.currentY : 0));
  const xWeights = axisWeights(x);
  const yWeights = axisWeights(y);
  const output = {};
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const contribution = yWeights[row] * xWeights[column];
      if (contribution <= 0) continue;
      for (const [name, value] of Object.entries(MORPH_ANCHORS[row][column])) {
        output[name] = (output[name] ?? 0) + contribution * value;
      }
    }
  }
  for (const name of Object.keys(output)) output[name] = clamp01(output[name]);
  return Object.freeze(output);
}
