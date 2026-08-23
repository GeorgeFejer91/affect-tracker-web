package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AffectTelemetryTextTest {
  @Test fun readoutShowsCurrentTargetStickAndMeasuredRateAtTenHertz() {
    val text = AffectTelemetryText()
    assertTrue(text.update(1_000_000_000L, 0f, 0f, 1f, -1f, 1f, -1f))
    assertEquals("V current +0.000  target +1.000  rate +0.00/s", text.valenceLine)
    assertEquals("A current +0.000  target -1.000  rate +0.00/s", text.arousalLine)
    assertEquals("Stick X +1.00  Y -1.00", text.stickLine)

    assertFalse(text.update(1_050_000_000L, 0.1f, -0.05f, 1f, -1f, 1f, -1f))
    assertTrue(text.update(1_100_000_000L, 0.1f, -0.05f, 1f, -1f, 1f, -1f))
    assertEquals("V current +0.100  target +1.000  rate +1.00/s", text.valenceLine)
    assertEquals("A current -0.050  target -1.000  rate -0.50/s", text.arousalLine)
  }

  @Test fun resetPreventsAStaleRateFromCrossingSessions() {
    val text = AffectTelemetryText()
    text.update(1_000_000_000L, 0.5f, 0.5f, 0.5f, 0.5f, 0f, 0f)
    text.reset()
    text.update(2_000_000_000L, -0.5f, -0.5f, -0.5f, -0.5f, 0f, 0f)
    assertEquals("V current -0.500  target -0.500  rate +0.00/s", text.valenceLine)
    assertEquals("A current -0.500  target -0.500  rate +0.00/s", text.arousalLine)
  }
}
