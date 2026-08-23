package io.github.georgefejer91.affecttracker.vr

/** Tight visual and interaction bounds for the Flubber plus its optional X/Y readout. */
internal object FlubberPanelLayout {
  // widthMeters describes the maximum useful Flubber footprint. A small horizontal margin keeps
  // the halo inside the compositor without creating a large invisible interaction rectangle.
  const val SURFACE_WIDTH_MULTIPLIER = 1.15f
  const val SURFACE_HEIGHT_TO_WIDTH = 1.12f
  const val CONTENT_SCALE_FRACTION = 0.14f
  const val CONTENT_CENTER_Y_TO_WIDTH = 0.5f
  const val TELEMETRY_TEXT_SIZE_TO_WIDTH = 0.052f
  const val TELEMETRY_BASELINE_BOTTOM_MARGIN_TO_WIDTH = 0.039f

  // Canonical worst case: 1 + amplitude(0.8) * wave(1) * asymmetry(2.6) = 3.08.
  const val MAX_CANONICAL_RADIUS = 3.08f
  const val HALO_HALF_STROKE_FRACTION = 0.0175f

  fun surfaceWidthMeters(configuredWidthMeters: Float): Float =
      configuredWidthMeters * SURFACE_WIDTH_MULTIPLIER

  fun surfaceHeightMeters(configuredWidthMeters: Float): Float =
      surfaceWidthMeters(configuredWidthMeters) * SURFACE_HEIGHT_TO_WIDTH

  fun maximumCanvasRadiusFraction(): Float =
      MAX_CANONICAL_RADIUS * CONTENT_SCALE_FRACTION + HALO_HALF_STROKE_FRACTION

  fun telemetryTopFractionOfWidth(): Float =
      SURFACE_HEIGHT_TO_WIDTH - TELEMETRY_BASELINE_BOTTOM_MARGIN_TO_WIDTH -
          TELEMETRY_TEXT_SIZE_TO_WIDTH
}
