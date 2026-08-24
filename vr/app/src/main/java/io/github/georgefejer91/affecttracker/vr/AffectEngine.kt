package io.github.georgefejer91.affecttracker.vr

import kotlin.math.atan2
import kotlin.math.exp
import kotlin.math.hypot

internal fun smoothToward(current: Float, target: Float, response: Double, deltaSeconds: Float): Float {
  val amount = (1.0 - exp(-response * deltaSeconds.coerceAtLeast(0f))).toFloat()
  return (current + (target - current) * amount).coerceIn(-1f, 1f)
}

data class AffectSnapshot(
    var currentX: Float,
    var currentY: Float,
    var targetX: Float,
    var targetY: Float,
    var radius: Float,
    var angleDegrees: Float,
    var animationActive: Boolean,
    var inputActive: Boolean,
)

class AffectEngine(private var settings: AffectSettings) {
  private var currentX = 0f
  private var currentY = 0f
  private var targetX = 0f
  private var targetY = 0f
  private var stickX = 0f
  private var stickY = 0f
  private var externalX: Float? = null
  private var externalY: Float? = null
  private var stepArmed = true
  private var paused = false
  private val snapshotBuffer = AffectSnapshot(0f, 0f, 0f, 0f, 0f, 0f, true, false)

  fun updateSettings(next: AffectSettings) { settings = next }

  fun setStick(rawX: Float, rawY: Float) {
    val magnitude = hypot(rawX, rawY)
    if (magnitude <= DEAD_ZONE) {
      stickX = 0f
      stickY = 0f
      if (magnitude < STEP_REARM) stepArmed = true
      return
    }
    val normalized = ((magnitude - DEAD_ZONE) / (1f - DEAD_ZONE)).coerceIn(0f, 1f)
    stickX = rawX / magnitude * normalized
    stickY = -rawY / magnitude * normalized
    if (settings.inputMode == "step" && stepArmed && magnitude >= STEP_THRESHOLD) {
      if (externalX == null) targetX = clamp(targetX + axisStep(stickX) * settings.stepSize.toFloat())
      if (externalY == null) targetY = clamp(targetY + axisStep(stickY) * settings.stepSize.toFloat())
      stepArmed = false
    }
  }

  /**
   * Supplies optional per-axis sensor targets. A null/non-finite axis remains controller-owned.
   * Targets are applied only while running, so pause holds the visible affect state.
   */
  fun setExternalTargets(x: Float?, y: Float?) {
    externalX = x?.takeIf(Float::isFinite)?.coerceIn(-1f, 1f)
    externalY = y?.takeIf(Float::isFinite)?.coerceIn(-1f, 1f)
  }

  fun tick(deltaSeconds: Float): AffectSnapshot {
    val dt = deltaSeconds.coerceIn(0f, 0.05f)
    if (!paused && settings.inputMode == "continuous") {
      if (externalX == null) targetX = clamp(targetX + stickX * settings.continuousSpeed.toFloat() * dt)
      if (externalY == null) targetY = clamp(targetY + stickY * settings.continuousSpeed.toFloat() * dt)
    }
    if (!paused) {
      externalX?.let { targetX = it }
      externalY?.let { targetY = it }
      currentX = smoothToward(currentX, targetX, settings.response, dt)
      currentY = smoothToward(currentY, targetY, settings.response, dt)
    }
    return snapshot()
  }

  fun reset() {
    if (externalX == null) targetX = 0f
    if (externalY == null) targetY = 0f
  }
  fun togglePause(): Boolean { paused = !paused; return paused }
  fun isPaused(): Boolean = paused

  fun snapshot(): AffectSnapshot {
    val radius = hypot(currentX, currentY).coerceAtMost(1f)
    val degrees = if (kotlin.math.abs(currentX) < 0.005f && kotlin.math.abs(currentY) < 0.005f) 0f else Math.toDegrees(atan2(currentX, currentY).toDouble()).toFloat() + 180f
    snapshotBuffer.currentX = currentX
    snapshotBuffer.currentY = currentY
    snapshotBuffer.targetX = targetX
    snapshotBuffer.targetY = targetY
    snapshotBuffer.radius = radius
    snapshotBuffer.angleDegrees = degrees
    snapshotBuffer.animationActive = !paused
    snapshotBuffer.inputActive = kotlin.math.abs(stickX) > 0f || kotlin.math.abs(stickY) > 0f ||
        externalX != null || externalY != null
    return snapshotBuffer
  }

  private fun axisStep(value: Float): Float = when { value > 0.35f -> 1f; value < -0.35f -> -1f; else -> 0f }
  private fun clamp(value: Float) = value.coerceIn(-1f, 1f)

  companion object {
    const val DEAD_ZONE = 0.18f
    const val STEP_THRESHOLD = 0.65f
    const val STEP_REARM = 0.35f
  }
}
