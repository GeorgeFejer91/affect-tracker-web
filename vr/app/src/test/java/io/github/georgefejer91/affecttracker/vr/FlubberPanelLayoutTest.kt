package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FlubberPanelLayoutTest {
  @Test fun defaultSurfaceIsLargeEnoughToGrabAcrossTransparentPadding() {
    assertEquals(0.75f, FlubberPanelLayout.surfaceWidthMeters(0.3f), 0.0001f)
  }

  @Test fun worstCaseCanonicalOutlineAndHaloRemainInsideCanvas() {
    assertTrue(FlubberPanelLayout.maximumCanvasRadiusFraction() < 0.5f)
    assertTrue(0.5f - FlubberPanelLayout.maximumCanvasRadiusFraction() > 0.04f)
  }
}
