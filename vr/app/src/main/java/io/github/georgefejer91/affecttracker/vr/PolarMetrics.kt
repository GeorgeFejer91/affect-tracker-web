package io.github.georgefejer91.affecttracker.vr

import java.util.ArrayDeque
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt

data class PolarMetricDefinition(
    val id: String,
    val label: String,
    val shortLabel: String,
    val unit: String,
    val minimum: Double,
    val maximum: Double,
)

object PolarMetricCatalog {
  val metrics = listOf(
      PolarMetricDefinition("excitement_score", "Excite-O-Meter score", "Excite-O-Meter", "0–1", 0.0, 1.0),
      PolarMetricDefinition("excitometer", "Activation composite", "Activation", "0–1", 0.0, 1.0),
      PolarMetricDefinition("rmssd", "Rolling RMSSD (uncorrected)", "HRV · RMSSD", "ms", 0.0, 120.0),
      PolarMetricDefinition("ln_rmssd", "Rolling lnRMSSD (uncorrected)", "HRV · lnRMSSD", "ln(ms)", 1.5, 5.5),
      PolarMetricDefinition("sdnn", "Rolling SDNN (uncorrected)", "HRV · SDNN", "ms", 0.0, 120.0),
      PolarMetricDefinition("ecg_local_power", "Local ECG power (5 s)", "Local ECG power", "µV²", 10_000.0, 2_250_000.0),
      PolarMetricDefinition("heart_rate", "Heart rate", "Heart rate", "bpm", 45.0, 160.0),
      PolarMetricDefinition("rr_interval", "Latest RR interval", "Latest RR", "ms", 400.0, 1_300.0),
      PolarMetricDefinition("ecg_rms", "ECG RMS amplitude", "ECG RMS", "µV", 100.0, 1_500.0),
      PolarMetricDefinition("ecg_peak_to_peak", "ECG peak-to-peak", "ECG range", "µV", 200.0, 4_000.0),
  )

  private val byId = metrics.associateBy(PolarMetricDefinition::id)

  fun definition(id: String): PolarMetricDefinition? = byId[id]
}

enum class PolarAffectAxis(val token: String) { X("x"), Y("y") }

data class PolarAxisMapping(
    val metricId: String = MANUAL,
    val minimum: Double = -1.0,
    val maximum: Double = 1.0,
    val invert: Boolean = false,
) {
  val assigned: Boolean get() = metricId != MANUAL && PolarMetricCatalog.definition(metricId) != null

  fun normalized(value: Double?): Float? {
    if (!assigned || value == null || !value.isFinite() || !minimum.isFinite() ||
        !maximum.isFinite() || maximum <= minimum) return null
    val mapped = (2.0 * (value - minimum) / (maximum - minimum) - 1.0).coerceIn(-1.0, 1.0)
    return (if (invert) -mapped else mapped).toFloat()
  }

  companion object {
    const val MANUAL = "manual"
    fun forMetric(definition: PolarMetricDefinition) = PolarAxisMapping(
        definition.id,
        definition.minimum,
        definition.maximum,
        false,
    )
  }
}

data class PolarAffectMappings(
    val x: PolarAxisMapping = PolarAxisMapping(),
    val y: PolarAxisMapping = PolarAxisMapping(),
) {
  fun mapping(axis: PolarAffectAxis): PolarAxisMapping = if (axis == PolarAffectAxis.X) x else y

  fun withMapping(axis: PolarAffectAxis, mapping: PolarAxisMapping): PolarAffectMappings =
      if (axis == PolarAffectAxis.X) copy(x = mapping) else copy(y = mapping)

  val anyAssigned: Boolean get() = x.assigned || y.assigned
}

data class PolarReadiness(
    val ready: Boolean = false,
    val reason: String = "not-started",
    val stableForMs: Long = 0,
    val latestSampleAgeMs: Long? = null,
)

data class PolarReadinessObservation(
    val permissionsGranted: Boolean,
    val bluetoothPowered: Boolean,
    val connected: Boolean,
    val ecgStreaming: Boolean,
    val sampleRateHz: Int?,
    val sampleCount: Long,
    val firstEcgSampleElapsedMs: Long?,
    val latestEcgSampleElapsedMs: Long?,
)

object PolarReadinessGate {
  const val REQUIRED_SAMPLE_RATE_HZ = 130
  const val REQUIRED_STABLE_MS = 3_000L
  const val MAX_SAMPLE_AGE_MS = 5_000L

  fun evaluate(nowElapsedMs: Long, observation: PolarReadinessObservation): PolarReadiness {
    val stableForMs = observation.firstEcgSampleElapsedMs
        ?.let { (nowElapsedMs - it).coerceAtLeast(0L) } ?: 0L
    val latestAgeMs = observation.latestEcgSampleElapsedMs
        ?.let { (nowElapsedMs - it).coerceAtLeast(0L) }
    val reason = when {
      !observation.permissionsGranted -> "permissions-required"
      !observation.bluetoothPowered -> "bluetooth-disabled"
      !observation.connected -> "h10-not-connected"
      !observation.ecgStreaming -> "ecg-not-streaming"
      observation.sampleRateHz != REQUIRED_SAMPLE_RATE_HZ -> "ecg-sample-rate-not-130-hz"
      observation.sampleCount <= 0L || observation.firstEcgSampleElapsedMs == null ||
          observation.latestEcgSampleElapsedMs == null -> "ecg-samples-not-observed"
      stableForMs < REQUIRED_STABLE_MS -> "ecg-stabilizing"
      latestAgeMs == null || latestAgeMs > MAX_SAMPLE_AGE_MS -> "ecg-stream-stalled"
      else -> "ready"
    }
    return PolarReadiness(reason == "ready", reason, stableForMs, latestAgeMs)
  }
}

data class PolarDrive(
    val x: Float?,
    val y: Float?,
    val xObserved: Double?,
    val yObserved: Double?,
) {
  val active: Boolean get() = x != null || y != null
}

data class PolarH10State(
    val enabled: Boolean = false,
    val permissionsGranted: Boolean = false,
    val bluetoothPowered: Boolean = true,
    val transportState: String = "not-started",
    val connected: Boolean = false,
    val heartRateBpm: Int? = null,
    val rrIntervalMs: Int? = null,
    val heartRateSampleAgeMs: Long? = null,
    val rrSampleAgeMs: Long? = null,
    val ecgStreaming: Boolean = false,
    val ecgSampleRateHz: Int? = null,
    val ecgResolutionBits: Int? = null,
    val ecgSampleCount: Long = 0,
    val ecgStreamEpoch: Long = 0,
    val observedEcgSampleRateHz: Double? = null,
    val recentEcgSamplesUv: List<Int> = emptyList(),
    val metrics: Map<String, Double> = emptyMap(),
    val readiness: PolarReadiness = PolarReadiness(),
    val mappings: PolarAffectMappings = PolarAffectMappings(),
) {
  fun drive(): PolarDrive {
    if (!readiness.ready) return PolarDrive(null, null, metrics[mappings.x.metricId], metrics[mappings.y.metricId])
    val xObserved = metrics[mappings.x.metricId]
    val yObserved = metrics[mappings.y.metricId]
    return PolarDrive(
        mappings.x.normalized(xObserved),
        mappings.y.normalized(yObserved),
        xObserved,
        yObserved,
    )
  }

  fun compactLabel(): String = when {
    !enabled -> "Polar Stream disconnected"
    !permissionsGranted -> "Nearby-device permission required"
    readiness.ready -> "Polar H10 · ${heartRateBpm?.let { "$it bpm · " }.orEmpty()}130 Hz ECG ready"
    connected -> "Polar H10 · ${readiness.reason.replace('-', ' ')}"
    else -> transportState.replace('-', ' ')
  }
}

/**
 * Bounded, dependency-free mirror of the current web Affect Tracker metrics.
 * Raw ECG and RR values are retained only in memory and are never persisted here.
 */
class PolarMetricProcessor(
    private val ecgCapacity: Int = ECG_WINDOW_SAMPLES,
    private val rrCapacity: Int = RR_WINDOW_VALUES,
) {
  private val ecg = ArrayDeque<Int>(ecgCapacity)
  private val rr = ArrayDeque<Double>(rrCapacity)
  private val values = linkedMapOf<String, Double>()
  private var ecgSquareSum = 0.0
  private val excitementRecentRr = ArrayDeque<Double>(10)
  private var excitementRrStats = RunningStats()
  private var excitementRmssdStats = RunningStats()
  private var activationHeartRateStats = RunningStats()
  private var activationLnRmssdStats = RunningStats()

  @Synchronized fun reset() {
    ecg.clear()
    rr.clear()
    values.clear()
    ecgSquareSum = 0.0
    excitementRecentRr.clear()
    excitementRrStats = RunningStats()
    excitementRmssdStats = RunningStats()
    activationHeartRateStats = RunningStats()
    activationLnRmssdStats = RunningStats()
  }

  @Synchronized fun pushEcg(samples: Iterable<Int>): Map<String, Double> {
    for (sample in samples) {
      val numeric = sample.toDouble()
      if (!numeric.isFinite()) continue
      ecg.addLast(sample)
      ecgSquareSum += numeric * numeric
      while (ecg.size > ecgCapacity.coerceAtLeast(2)) {
        val removed = ecg.removeFirst().toDouble()
        ecgSquareSum -= removed * removed
      }
    }
    if (ecg.isNotEmpty()) {
      val meanSquare = (ecgSquareSum / ecg.size).coerceAtLeast(0.0)
      values["ecg_local_power"] = meanSquare
      values["ecg_rms"] = sqrt(meanSquare)
      var minimum = Int.MAX_VALUE
      var maximum = Int.MIN_VALUE
      for (sample in ecg) {
        if (sample < minimum) minimum = sample
        if (sample > maximum) maximum = sample
      }
      values["ecg_peak_to_peak"] = (maximum.toLong() - minimum.toLong()).toDouble()
    }
    return snapshot()
  }

  @Synchronized fun pushHeartRate(beatsPerMinute: Int?, rrIntervalsMs: Iterable<Int>): Map<String, Double> {
    if (beatsPerMinute != null && beatsPerMinute > 0) values["heart_rate"] = beatsPerMinute.toDouble()
    for (raw in rrIntervalsMs) {
      val interval = raw.toDouble()
      if (!interval.isFinite() || interval <= 0.0) continue
      values["rr_interval"] = interval
      rr.addLast(interval)
      while (rr.size > rrCapacity.coerceAtLeast(2)) rr.removeFirst()
      updateExciteOMeter(interval)
      val rollingRmssd = rootMeanSquareSuccessiveDifference(rr)
      val rollingSdnn = sampleStandardDeviation(rr)
      if (rollingRmssd != null) {
        values["rmssd"] = rollingRmssd
        values["ln_rmssd"] = if (rollingRmssd > 0.0) ln(rollingRmssd) else 0.0
        val effectiveHeartRate = beatsPerMinute?.takeIf { it > 0 }?.toDouble() ?: 60_000.0 / interval
        updateActivationComposite(effectiveHeartRate, values.getValue("ln_rmssd"))
      }
      if (rollingSdnn != null) values["sdnn"] = rollingSdnn
    }
    return snapshot()
  }

  @Synchronized fun snapshot(): Map<String, Double> = LinkedHashMap(values)

  @Synchronized fun ecgWindowSize(): Int = ecg.size
  @Synchronized fun rrWindowSize(): Int = rr.size

  private fun updateExciteOMeter(interval: Double) {
    excitementRecentRr.addLast(interval)
    while (excitementRecentRr.size > 10) excitementRecentRr.removeFirst()
    if (excitementRecentRr.size < 10) return
    val rollingRmssd = rootMeanSquareSuccessiveDifference(excitementRecentRr) ?: return
    excitementRrStats.push(interval)
    excitementRmssdStats.push(rollingRmssd)
    if (excitementRrStats.count < 10 || excitementRmssdStats.count < 10) return
    val rrPercentile = normalCdf(excitementRrStats.zScore(interval, population = true))
    val rmssdPercentile = normalCdf(excitementRmssdStats.zScore(rollingRmssd, population = true))
    values["excitement_score"] = (1.0 - (rrPercentile + rmssdPercentile) / 2.0).coerceIn(0.0, 1.0)
  }

  private fun updateActivationComposite(heartRate: Double, lnRmssd: Double) {
    activationHeartRateStats.push(heartRate)
    activationLnRmssdStats.push(lnRmssd)
    if (activationHeartRateStats.count < 20 || activationLnRmssdStats.count < 20) return
    val activation = 0.65 * activationHeartRateStats.zScore(heartRate) -
        0.35 * activationLnRmssdStats.zScore(lnRmssd)
    values["excitometer"] = (1.0 / (1.0 + exp(-activation))).coerceIn(0.0, 1.0)
  }

  companion object {
    const val ECG_WINDOW_SAMPLES = 130 * 5
    const val RR_WINDOW_VALUES = 300
  }
}

private class RunningStats {
  var count = 0
    private set
  private var mean = 0.0
  private var m2 = 0.0

  fun push(value: Double) {
    if (!value.isFinite()) return
    count += 1
    val delta = value - mean
    mean += delta / count
    m2 += delta * (value - mean)
  }

  fun zScore(value: Double, population: Boolean = false): Double {
    if (count < 2) return 0.0
    val standardDeviation = sqrt(m2 / if (population) count else count - 1)
    return if (standardDeviation < 1e-6) 0.0 else (value - mean) / standardDeviation
  }
}

private fun rootMeanSquareSuccessiveDifference(values: Collection<Double>): Double? {
  if (values.size < 2) return null
  var prior: Double? = null
  var sum = 0.0
  var count = 0
  for (value in values) {
    prior?.let {
      val difference = value - it
      sum += difference * difference
      count += 1
    }
    prior = value
  }
  return if (count > 0) sqrt(sum / count) else null
}

private fun sampleStandardDeviation(values: Collection<Double>): Double? {
  if (values.size < 2) return null
  val mean = values.sum() / values.size
  val variance = values.sumOf { (it - mean) * (it - mean) } / (values.size - 1)
  return sqrt(variance.coerceAtLeast(0.0))
}

// Abramowitz and Stegun 7.1.26, matching the browser and legacy Excite-O-Meter path.
private fun normalCdf(value: Double): Double {
  val sign = if (value < 0.0) -1.0 else 1.0
  val scaled = abs(value) / sqrt(2.0)
  val t = 1.0 / (1.0 + 0.3275911 * scaled)
  val erf = 1.0 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) * t + 0.254829592) * t * exp(-(scaled * scaled)))
  return 0.5 * (1.0 + sign * erf)
}
