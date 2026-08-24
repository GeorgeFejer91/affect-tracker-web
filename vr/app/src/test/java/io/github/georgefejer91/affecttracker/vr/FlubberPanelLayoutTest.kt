package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FlubberPanelLayoutTest {
  @Test fun defaultSurfaceTightlyFitsFlubberAndReadout() {
    assertEquals(0.345f, FlubberPanelLayout.surfaceWidthMeters(0.3f), 0.0001f)
    assertEquals(0.3864f, FlubberPanelLayout.surfaceHeightMeters(0.3f), 0.0001f)
  }

  @Test fun worstCaseOutlineAndReadoutHaveSeparateUnclippedBands() {
    assertTrue(FlubberPanelLayout.maximumCanvasRadiusFraction() < 0.5f)
    assertTrue(0.5f - FlubberPanelLayout.maximumCanvasRadiusFraction() > 0.04f)
    assertTrue(
        FlubberPanelLayout.telemetryTopFractionOfWidth() -
            (FlubberPanelLayout.CONTENT_CENTER_Y_TO_WIDTH +
                FlubberPanelLayout.maximumCanvasRadiusFraction()) > 0.07f,
    )
  }
}
