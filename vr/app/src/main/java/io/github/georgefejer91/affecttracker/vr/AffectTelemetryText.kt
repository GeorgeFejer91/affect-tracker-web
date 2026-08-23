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
  var valenceLine: String = "V current +0.000  target +0.000  rate +0.00/s"
    private set
  var arousalLine: String = "A current +0.000  target +0.000  rate +0.00/s"
    private set
  var stickLine: String = "Stick X +0.00  Y +0.00"
    private set

  private var lastUpdateNanos = 0L
  private var lastValence = 0f
  private var lastArousal = 0f

  fun reset() {
    lastUpdateNanos = 0L
    lastValence = 0f
    lastArousal = 0f
    valenceLine = "V current +0.000  target +0.000  rate +0.00/s"
    arousalLine = "A current +0.000  target +0.000  rate +0.00/s"
    stickLine = "Stick X +0.00  Y +0.00"
  }

  fun update(
      nowNanos: Long,
      currentValence: Float,
      currentArousal: Float,
      targetValence: Float,
      targetArousal: Float,
      stickX: Float,
      stickY: Float,
  ): Boolean {
    if (lastUpdateNanos != 0L && nowNanos - lastUpdateNanos < refreshNanos) return false
    val elapsedSeconds = if (lastUpdateNanos == 0L) 0f else (nowNanos - lastUpdateNanos) / 1_000_000_000f
    val valenceRate = if (elapsedSeconds > 0f) (currentValence - lastValence) / elapsedSeconds else 0f
    val arousalRate = if (elapsedSeconds > 0f) (currentArousal - lastArousal) / elapsedSeconds else 0f

    valenceLine = String.format(
        Locale.US,
        "V current %+.3f  target %+.3f  rate %+.2f/s",
        currentValence,
        targetValence,
        valenceRate,
    )
    arousalLine = String.format(
        Locale.US,
        "A current %+.3f  target %+.3f  rate %+.2f/s",
        currentArousal,
        targetArousal,
        arousalRate,
    )
    stickLine = String.format(Locale.US, "Stick X %+.2f  Y %+.2f", stickX, stickY)
    lastUpdateNanos = nowNanos
    lastValence = currentValence
    lastArousal = currentArousal
    return true
  }
}
