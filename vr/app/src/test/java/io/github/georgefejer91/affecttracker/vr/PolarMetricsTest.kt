package io.github.georgefejer91.affecttracker.vr

import kotlin.math.ln
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarMetricsTest {
  @Test fun mappingUsesExplicitBoundsClampingAndInversion() {
    val metric = requireNotNull(PolarMetricCatalog.definition("heart_rate"))
    val mapping = PolarAxisMapping.forMetric(metric).copy(minimum = 50.0, maximum = 150.0)

    assertEquals(-1f, mapping.normalized(50.0)!!, 0.0001f)
    assertEquals(0f, mapping.normalized(100.0)!!, 0.0001f)
    assertEquals(1f, mapping.normalized(500.0)!!, 0.0001f)
    assertEquals(-0.5f, mapping.copy(invert = true).normalized(125.0)!!, 0.0001f)
    assertNull(mapping.copy(maximum = 50.0).normalized(100.0))
    assertNull(PolarAxisMapping().normalized(100.0))
  }

  @Test fun ecgWindowIsBoundedAndPublishesFiveSecondAmplitudeMetrics() {
    val processor = PolarMetricProcessor(ecgCapacity = 4)
    processor.pushEcg(listOf(-2, 2, 4, 8, 10))
    val metrics = processor.snapshot()

    assertEquals(4, processor.ecgWindowSize())
    assertEquals(46.0, metrics.getValue("ecg_local_power"), 0.0001)
    assertEquals(sqrt(46.0), metrics.getValue("ecg_rms"), 0.0001)
    assertEquals(8.0, metrics.getValue("ecg_peak_to_peak"), 0.0001)
  }

  @Test fun rrWindowIsBoundedAndMatchesWebRollingHrvDefinitions() {
    val processor = PolarMetricProcessor(rrCapacity = 4)
    processor.pushHeartRate(60, listOf(800, 810, 790, 820, 780))
    val metrics = processor.snapshot()

    assertEquals(4, processor.rrWindowSize())
    assertEquals(780.0, metrics.getValue("rr_interval"), 0.0001)
    assertEquals(sqrt((400.0 + 900.0 + 1600.0) / 3.0), metrics.getValue("rmssd"), 0.0001)
    assertEquals(ln(metrics.getValue("rmssd")), metrics.getValue("ln_rmssd"), 0.0001)
    assertEquals(sqrt(1_000.0 / 3.0), metrics.getValue("sdnn"), 0.0001)
    assertEquals(60.0, metrics.getValue("heart_rate"), 0.0001)
  }

  @Test fun compositeMetricsRespectTheirWebWarmupCounts() {
    val processor = PolarMetricProcessor()
    repeat(18) { processor.pushHeartRate(70 + (it % 3), listOf(800 + it)) }
    assertFalse(processor.snapshot().containsKey("excitement_score"))
    repeat(3) { index -> processor.pushHeartRate(72 + index, listOf(818 + index)) }
    val metrics = processor.snapshot()

    assertTrue(metrics.getValue("excitement_score") in 0.0..1.0)
    assertTrue(metrics.getValue("excitometer") in 0.0..1.0)
  }

  @Test fun readinessRequiresExactRateSamplesThreeStableSecondsAndFreshData() {
    val base = PolarReadinessObservation(
        permissionsGranted = true,
        bluetoothPowered = true,
        connected = true,
        ecgStreaming = true,
        sampleRateHz = 130,
        sampleCount = 390,
        firstEcgSampleElapsedMs = 1_000,
        latestEcgSampleElapsedMs = 4_000,
    )

    assertEquals("ecg-stabilizing", PolarReadinessGate.evaluate(3_999, base).reason)
    assertTrue(PolarReadinessGate.evaluate(4_000, base).ready)
    assertEquals("ecg-stream-stalled", PolarReadinessGate.evaluate(9_001, base).reason)
    assertEquals(
        "ecg-sample-rate-not-130-hz",
        PolarReadinessGate.evaluate(4_000, base.copy(sampleRateHz = 200)).reason,
    )
  }

  @Test fun driveOnlyOverridesAssignedReadyAndFiniteAxes() {
    val heartRate = PolarAxisMapping.forMetric(requireNotNull(PolarMetricCatalog.definition("heart_rate")))
    val state = PolarH10State(
        readiness = PolarReadiness(ready = true, reason = "ready"),
        mappings = PolarAffectMappings(x = heartRate),
        metrics = mapOf("heart_rate" to 102.5),
    )

    assertEquals(0f, state.drive().x!!, 0.0001f)
    assertNull(state.drive().y)
    assertFalse(state.copy(readiness = PolarReadiness()).drive().active)
    assertNull(state.copy(metrics = mapOf("heart_rate" to Double.NaN)).drive().x)
  }
}
