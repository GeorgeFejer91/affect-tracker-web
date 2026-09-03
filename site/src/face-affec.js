const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

const freezePrototype = (values) => Object.freeze(values);

/**
 * Perceived valence/arousal summaries computed from all 5,807 valid trials in
 * AFFEC core v0.1. Ratings use AFFEC's 1–9 scales; `x` and `y` normalize them
 * with (rating - 5) / 4. The published archive is never loaded at runtime.
 */
export const AFFEC_EMPIRICAL_CENTROIDS = Object.freeze([
  Object.freeze({ emotion: "angry", count: 920, meanValence: 2.886957, sdValence: 1.197678, meanArousal: 6.513043, sdArousal: 1.688418 }),
  Object.freeze({ emotion: "disgust", count: 923, meanValence: 3.049837, sdValence: 1.192760, meanArousal: 5.393283, sdArousal: 1.707530 }),
  Object.freeze({ emotion: "fear", count: 992, meanValence: 3.156250, sdValence: 1.088784, meanArousal: 6.024194, sdArousal: 1.800162 }),
  Object.freeze({ emotion: "happy", count: 994, meanValence: 7.411469, sdValence: 1.280699, meanArousal: 6.064386, sdArousal: 1.803510 }),
  Object.freeze({ emotion: "neutral", count: 986, meanValence: 4.511156, sdValence: 0.917056, meanArousal: 3.281947, sdArousal: 1.722829 }),
  Object.freeze({ emotion: "sad", count: 992, meanValence: 3.245968, sdValence: 1.214603, meanArousal: 4.525202, sdArousal: 1.963689 }),
]);

export const AFFEC_EMPIRICAL_METADATA = Object.freeze({
  id: "affec-perceived-va-centroids-v1",
  source: "AFFEC Multimodal Dataset v0.1",
  record: "https://zenodo.org/records/14794876",
  derivedAt: "2026-09-03",
  validTrialCount: 5807,
  ratingFields: Object.freeze(["p_emotion_v", "p_emotion_a"]),
  normalization: "(rating - 5) / 4",
  archiveLicensePolicy: "Attributed as CC BY 4.0 per the Zenodo record; the devkit describes dataset files as CC0.",
});

const PROTOTYPES = Object.freeze({
  angry: freezePrototype({
    Angry: 0.96,
    Eyebrows_Frown_Left: 0.90,
    Eyebrows_Frown_Right: 0.90,
    Eyes_Squint: 0.20,
    Jaw_Lower: 0.12,
  }),
  disgust: freezePrototype({
    Disgusted: 0.96,
    Eyebrows_Frown_Left: 0.34,
    Eyebrows_Frown_Right: 0.34,
    Eyes_Squint: 0.32,
    Lips_Up_Funnel: 0.14,
  }),
  fear: freezePrototype({
    Scared: 0.96,
    Eyebrows_Raised_Left: 0.76,
    Eyebrows_Raised_Right: 0.76,
    Eyes_Opened_Max_Left: 0.88,
    Eyes_Opened_Max_Right: 0.88,
    Jaw_Lower: 0.38,
    Mouth_Large_Opened: 0.32,
  }),
  happy: freezePrototype({
    Happy: 0.98,
    Smile_Lips_Closed: 0.78,
    Lips_Up_Corner_Wide_Left: 0.62,
    Lips_Up_Corner_Wide_Right: 0.62,
    Eyes_Squint: 0.22,
  }),
  neutral: freezePrototype({
    Eyes_Closed_Max: 0.42,
    Eyes_Squint: 0.06,
  }),
  sad: freezePrototype({
    Sad: 0.98,
    Eyebrows_Frown_Left: 0.32,
    Eyebrows_Frown_Right: 0.32,
    Eyes_Closed_Max: 0.18,
  }),
});

const smoothMagnitude = (value) => {
  const magnitude = clamp01(value);
  return magnitude * magnitude * (3 - 2 * magnitude);
};

/**
 * Blend AFFEC's empirical category locations with artist-authored Vitruvian
 * expression morphs. AFFEC validates the category locations; this continuous
 * RBF interpolation is deliberately disclosed as project-authored.
 */
export function buildAffecEmpiricalWeights(snapshot = {}) {
  const x = Math.max(-1, Math.min(1, Number.isFinite(snapshot.currentX) ? snapshot.currentX : 0));
  const y = Math.max(-1, Math.min(1, Number.isFinite(snapshot.currentY) ? snapshot.currentY : 0));
  const intensity = smoothMagnitude(Math.max(Math.abs(x), Math.abs(y)));
  const categoryWeights = [];
  let total = 0;

  for (const centroid of AFFEC_EMPIRICAL_CENTROIDS) {
    const centerX = (centroid.meanValence - 5) / 4;
    const centerY = (centroid.meanArousal - 5) / 4;
    const spreadX = Math.max(0.18, centroid.sdValence / 4);
    const spreadY = Math.max(0.18, centroid.sdArousal / 4);
    const dx = (x - centerX) / spreadX;
    const dy = (y - centerY) / spreadY;
    const weight = Math.exp(-0.5 * (dx * dx + dy * dy));
    categoryWeights.push({ emotion: centroid.emotion, weight });
    total += weight;
  }

  const output = {};
  if (!(total > 0) || intensity === 0) return Object.freeze(output);
  for (const category of categoryWeights) {
    const contribution = category.weight / total * intensity;
    for (const [name, value] of Object.entries(PROTOTYPES[category.emotion])) {
      output[name] = (output[name] ?? 0) + contribution * value;
    }
  }
  const activated = Math.max(0, y) * intensity;
  const subdued = Math.max(0, -y) * intensity;
  output.Eyebrows_Raised_Left = (output.Eyebrows_Raised_Left ?? 0) + activated * 0.28;
  output.Eyebrows_Raised_Right = (output.Eyebrows_Raised_Right ?? 0) + activated * 0.28;
  output.Eyes_Opened_Max_Left = (output.Eyes_Opened_Max_Left ?? 0) + activated * 0.34;
  output.Eyes_Opened_Max_Right = (output.Eyes_Opened_Max_Right ?? 0) + activated * 0.34;
  output.Jaw_Lower = (output.Jaw_Lower ?? 0) + activated * 0.13;
  output.Mouth_Large_Opened = (output.Mouth_Large_Opened ?? 0) + activated * 0.11;
  output.Eyes_Closed_Max = (output.Eyes_Closed_Max ?? 0) + subdued * 0.42;
  for (const name of Object.keys(output)) output[name] = clamp01(output[name]);
  return Object.freeze(output);
}
