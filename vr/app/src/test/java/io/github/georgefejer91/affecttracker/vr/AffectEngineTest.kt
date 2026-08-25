package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AffectEngineTest {
  private fun settings(mode: String = "continuous") = AffectSettings(
      mode, 0.1, 0.8, 8.0,
      VisualSettings(1.0, 1.0, 1.0),
      PaletteSettings("#ffd166", "#5c7cfa", "#ff5b68", "#5dffb0"),
      OverlaySettings(0.95, true),
      LslSettings("AffectTracker", "Affect", "AffectTrackerMarkers", 50, "affect-tracker-vr"),
  )

  @Test fun continuousStickMovementIsFrameRateIndependent() {
    val a = AffectEngine(settings())
    val b = AffectEngine(settings())
    a.setStick(1f, 0f); b.setStick(1f, 0f)
    repeat(60) { a.tick(1f / 60f) }
    repeat(120) { b.tick(1f / 120f) }
    assertEquals(a.snapshot().targetX, b.snapshot().targetX, 0.0002f)
    assertTrue(a.snapshot().targetX > 0.7f)
  }

  @Test fun stepInputRequiresNeutralRearm() {
    val engine = AffectEngine(settings("step"))
    engine.setStick(1f, 0f)
    engine.setStick(1f, 0f)
    assertEquals(0.1f, engine.snapshot().targetX, 0.0001f)
    engine.setStick(0f, 0f)
    engine.setStick(1f, 0f)
    assertEquals(0.2f, engine.snapshot().targetX, 0.0001f)
  }

  @Test fun externalTargetsOwnOnlyAssignedAxesAndControllerTakesOverOnFallback() {
    val engine = AffectEngine(settings())
    engine.setExternalTargets(0.75f, null)
    engine.setStick(0f, -1f)
    repeat(60) { engine.tick(1f / 60f) }
    val driven = engine.snapshot()
    assertEquals(0.75f, driven.targetX, 0.0001f)
    assertTrue(driven.targetY > 0.7f)

    engine.setExternalTargets(null, null)
    engine.setStick(-1f, 0f)
    repeat(60) { engine.tick(1f / 60f) }
    assertTrue(engine.snapshot().targetX < 0.1f)
  }

  @Test fun pauseHoldsExternalTargetAndResetChangesOnlyManualAxes() {
    val engine = AffectEngine(settings())
    engine.setExternalTargets(0.6f, null)
    engine.setStick(0f, -1f)
    engine.tick(0.05f)
    engine.togglePause()
    engine.setExternalTargets(-0.8f, null)
    engine.reset()
    val paused = engine.tick(0.05f)
    assertEquals(0.6f, paused.targetX, 0.0001f)
    assertEquals(0f, paused.targetY, 0.0001f)

    engine.togglePause()
    assertEquals(-0.8f, engine.tick(0.05f).targetX, 0.0001f)
  }

  @Test fun thirtyMinuteWorstCaseSimulationStaysFiniteAndBounded() {
    val engine = AffectEngine(settings())
    val geometry = FlubberGeometry("soak-session")
    val visual = settings().visual
    val shapeVisuals = FlubberBaseShape.entries.map {
      visual.copy(amplitudeScale = 2.0, disorderScale = 2.0, baseShape = it)
    }
    var phase = 0.0
    repeat(30 * 60 * 90) { frame ->
      val x = if ((frame / 450) % 2 == 0) 1f else -1f
      val y = if ((frame / 675) % 2 == 0) 1f else -1f
      engine.setStick(x, y)
      val snapshot = engine.tick(1f / 90f)
      phase += (1.0 / 90.0) * visual.animationSpeed
      geometry.update(snapshot, phase, shapeVisuals[frame % shapeVisuals.size])
      assertTrue(snapshot.currentX.isFinite() && snapshot.currentY.isFinite())
      assertTrue(snapshot.currentX in -1f..1f && snapshot.currentY in -1f..1f)
      if (frame % 90 == 0) {
        assertTrue(geometry.x.all { it.isFinite() } && geometry.y.all { it.isFinite() })
      }
    }
    assertEquals(192, geometry.x.size)
    assertEquals(192, geometry.y.size)
  }
}
