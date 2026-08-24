package io.github.georgefejer91.affecttracker.vr

import kotlin.math.PI
import org.junit.Assert.assertEquals
import org.junit.Test

class FlubberCalibrationTest {
  @Test fun nativeParametersMatchOriginalUnityPrefabExtrema() {
    val lowArousal = flubberAffectParameters(0f, -1f)
    val neutral = flubberAffectParameters(0f, 0f)
    val highArousal = flubberAffectParameters(0f, 1f)
    assertEquals(0.5, lowArousal.frequencyHz, 1e-12)
    assertEquals(1.5, neutral.frequencyHz, 1e-12)
    assertEquals(2.5, highArousal.frequencyHz, 1e-12)
    assertEquals(0.2, lowArousal.projectionAmplitude, 1e-12)
    assertEquals(0.3, neutral.projectionAmplitude, 1e-12)
    assertEquals(0.4, highArousal.projectionAmplitude, 1e-12)

    val negative = flubberAffectParameters(-1f, 0f)
    val positive = flubberAffectParameters(1f, 0f)
    assertEquals(0.0, negative.shapeMix, 1e-12)
    assertEquals(0.8, negative.disorder, 1e-12)
    assertEquals(1.0, positive.shapeMix, 1e-12)
    assertEquals(0.0, positive.disorder, 1e-12)
  }

  @Test fun animationClockUsesArousalFrequencyInHertz() {
    val dt = 0.05f
    val low = advanceFlubberPhase(0.0, -1f, 1.0, dt)
    val neutral = advanceFlubberPhase(0.0, 0f, 1.0, dt)
    val high = advanceFlubberPhase(0.0, 1f, 1.0, dt)
    assertEquals(2.0 * PI * 0.5 * dt.toDouble(), low, 1e-12)
    assertEquals(2.0 * PI * 1.5 * dt.toDouble(), neutral, 1e-12)
    assertEquals(2.0 * PI * 2.5 * dt.toDouble(), high, 1e-12)
  }

  @Test fun calibrationClampsCoordinatesBeforeMapping() {
    assertEquals(flubberAffectParameters(-1f, 1f), flubberAffectParameters(-5f, 5f))
    assertEquals(flubberAffectParameters(1f, -1f), flubberAffectParameters(5f, -5f))
  }
}
