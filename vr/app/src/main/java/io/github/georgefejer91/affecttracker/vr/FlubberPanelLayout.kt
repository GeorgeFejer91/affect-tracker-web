package io.github.georgefejer91.affecttracker.vr

/**
 * Keeps the configured Flubber at its established apparent size while giving its most disordered,
 * amplified outline enough transparent compositor space and making that whole space grabbable.
 */
internal object FlubberPanelLayout {
  const val SURFACE_SIZE_MULTIPLIER = 2.5f
  const val CONTENT_SCALE_FRACTION = 0.14f

  // Canonical worst case: 1 + amplitude(0.8) * wave(1) * asymmetry(2.6) = 3.08.
  const val MAX_CANONICAL_RADIUS = 3.08f
  const val HALO_HALF_STROKE_FRACTION = 0.0175f

  fun surfaceWidthMeters(configuredWidthMeters: Float): Float =
      configuredWidthMeters * SURFACE_SIZE_MULTIPLIER

  fun maximumCanvasRadiusFraction(): Float =
      MAX_CANONICAL_RADIUS * CONTENT_SCALE_FRACTION + HALO_HALF_STROKE_FRACTION
}
