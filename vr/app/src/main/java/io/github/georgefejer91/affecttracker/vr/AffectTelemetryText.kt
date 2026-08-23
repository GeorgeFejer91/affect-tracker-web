package io.github.georgefejer91.affecttracker.vr

import java.util.Locale

/**
 * Throttles the optional in-headset numerical readout to 10 Hz.
 *
 * The normal Flubber path keeps its allocation-free steady state. String formatting and its small
 * allocation cost exist only when the researcher explicitly enables this diagnostic overlay.
 */
internal class AffectTelemetryText(
    private val refreshNanos: Long = 100_000_000L,
) {
  var coordinateLine: String = "X +0.000   Y +0.000"
    private set

  private var lastUpdateNanos = 0L

  fun reset() {
    lastUpdateNanos = 0L
    coordinateLine = "X +0.000   Y +0.000"
  }

  fun update(
      nowNanos: Long,
      currentX: Float,
      currentY: Float,
  ): Boolean {
    if (lastUpdateNanos != 0L && nowNanos - lastUpdateNanos < refreshNanos) return false
    coordinateLine = String.format(
        Locale.US,
        "X %+.3f   Y %+.3f",
        currentX.coerceIn(-1f, 1f),
        currentY.coerceIn(-1f, 1f),
    )
    lastUpdateNanos = nowNanos
    return true
  }
}
