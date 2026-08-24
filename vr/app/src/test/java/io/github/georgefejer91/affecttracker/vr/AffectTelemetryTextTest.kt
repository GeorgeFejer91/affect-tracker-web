package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AffectTelemetryTextTest {
  @Test fun readoutShowsOnlyBoundedCurrentCoordinatesAtTenHertz() {
    val text = AffectTelemetryText()
    assertTrue(text.update(1_000_000_000L, 2f, -2f))
    assertEquals("X +1.000   Y -1.000", text.coordinateLine)

    assertFalse(text.update(1_050_000_000L, 0.1f, -0.05f))
    assertTrue(text.update(1_100_000_000L, 0.1f, -0.05f))
    assertEquals("X +0.100   Y -0.050", text.coordinateLine)
  }

  @Test fun resetRestoresNeutralCoordinates() {
    val text = AffectTelemetryText()
    text.update(1_000_000_000L, 0.5f, 0.5f)
    text.reset()
    assertEquals("X +0.000   Y +0.000", text.coordinateLine)
  }
}
