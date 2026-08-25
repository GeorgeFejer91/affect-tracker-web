package io.github.georgefejer91.affecttracker.vr

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.roundToInt

internal data class FlubberAffectParameters(
    val frequencyHz: Double,
    val projectionAmplitude: Double,
    val shapeMix: Double,
    val disorder: Double,
)

/**
 * Canonical AffectTracker calibration.
 *
 * These extrema match the original Unity prefab and site/src/math.js. Keeping them together avoids
 * allowing the native geometry and its animation clock to drift independently.
 */
internal fun flubberAffectParameters(x: Float, y: Float): FlubberAffectParameters {
  val safeX = x.toDouble().coerceIn(-1.0, 1.0)
  val safeY = y.toDouble().coerceIn(-1.0, 1.0)
  return FlubberAffectParameters(
      frequencyHz = 1.5 + safeY,
      projectionAmplitude = 0.3 + 0.1 * safeY,
      shapeMix = (safeX + 1.0) / 2.0,
      disorder = 0.4 * (1.0 - safeX),
  )
}

internal fun advanceFlubberPhase(
    phase: Double,
    arousal: Float,
    animationSpeed: Double,
    deltaSeconds: Float,
): Double {
  val frequencyHz = flubberAffectParameters(0f, arousal).frequencyHz
  val next = phase + deltaSeconds.coerceIn(0f, 0.05f) * 2.0 * PI * frequencyHz * animationSpeed
  return next % (2.0 * PI)
}

class FlubberGeometry(seed: String, private val vertexCount: Int = 192, private val waveCount: Int = 16) {
  val x = FloatArray(vertexCount)
  val y = FloatArray(vertexCount)
  private val rounded = DoubleArray(vertexCount)
  private val pointy = DoubleArray(vertexCount)
  private val baseX = Array(FlubberBaseShape.entries.size) { DoubleArray(vertexCount) }
  private val baseY = Array(FlubberBaseShape.entries.size) { DoubleArray(vertexCount) }
  private val phases = DoubleArray(waveCount)
  private val amplitudes = DoubleArray(waveCount)

  init {
    require(vertexCount % waveCount == 0 && vertexCount >= waveCount * 4)
    val verticesPerWave = vertexCount / waveCount
    val halfWave = verticesPerWave / 2.0
    val vertexRadians = 2.0 * PI / vertexCount
    val alpha = PI / 2.0 + PI / 4.0
    for (index in 0 until vertexCount) {
      val theta = index * 2.0 * PI / vertexCount
      rounded[index] = cos(waveCount * theta)
      baseX[FlubberBaseShape.CIRCLE.ordinal][index] = cos(theta)
      baseY[FlubberBaseShape.CIRCLE.ordinal][index] = sin(theta)
      val heartSine = sin(theta)
      baseX[FlubberBaseShape.HEART.ordinal][index] = 16.0 * heartSine * heartSine * heartSine
      baseY[FlubberBaseShape.HEART.ordinal][index] = -(
          13.0 * cos(theta) - 5.0 * cos(2.0 * theta) -
              2.0 * cos(3.0 * theta) - cos(4.0 * theta)
          )
      val position = index % verticesPerWave
      val distance = abs(position - halfWave)
      pointy[index] = sin(alpha) / sin(PI - alpha - vertexRadians * distance)
    }
    normalize(rounded)
    normalize(pointy)
    normalizeHeartProfile()
    createRegularPolygonProfile(FlubberBaseShape.TRIANGLE, 3, -PI / 2.0)
    createRegularPolygonProfile(FlubberBaseShape.SQUARE, 4, -PI / 4.0)
    val random = Mulberry32(fnv1a(seed))
    for (index in 0 until waveCount) {
      phases[index] = (random.next() * 2.0 - 1.0) * PI
      amplitudes[index] = random.next() * 2.0 - 1.0
    }
  }

  fun update(snapshot: AffectSnapshot, phase: Double, visual: VisualSettings, reducedMotion: Boolean = false) {
    val parameters = flubberAffectParameters(snapshot.currentX, snapshot.currentY)
    val shapeMix = parameters.shapeMix
    val amplitude = parameters.projectionAmplitude * visual.amplitudeScale.coerceIn(0.0, 2.0)
    val disorder = parameters.disorder * visual.disorderScale.coerceIn(0.0, 2.0)
    val scale = if (reducedMotion) 1.0 else 0.9 + 0.1 * (sin(phase) * 0.5 + 0.5)
    val oscillationDepth = if (reducedMotion) 0.14 else 0.5
    val verticesPerWave = vertexCount / waveCount
    val baseShapeIndex = visual.baseShape.ordinal
    for (index in 0 until vertexCount) {
      val waveIndex = ((index + verticesPerWave / 2) / verticesPerWave) % waveCount
      val shape = pointy[index] * (1.0 - shapeMix) + rounded[index] * shapeMix
      val wave = 0.5 + oscillationDepth * sin(phase + disorder * phases[waveIndex])
      val asymmetry = 1.0 + disorder * amplitudes[waveIndex]
      val deformation = (1.0 + shape * amplitude * wave * asymmetry) * scale
      x[index] = (deformation * baseX[baseShapeIndex][index]).toFloat()
      y[index] = (deformation * baseY[baseShapeIndex][index]).toFloat()
    }
  }

  private fun createRegularPolygonProfile(baseShape: FlubberBaseShape, sideCount: Int, vertexRotation: Double) {
    val shapeIndex = baseShape.ordinal
    val sector = 2.0 * PI / sideCount
    val apothem = cos(PI / sideCount)
    val edgeNormal = vertexRotation + PI / sideCount
    for (index in 0 until vertexCount) {
      val theta = index * 2.0 * PI / vertexCount
      val offset = centeredModulo(theta - edgeNormal, sector)
      val radius = apothem / cos(offset)
      baseX[shapeIndex][index] = radius * cos(theta)
      baseY[shapeIndex][index] = radius * sin(theta)
    }
  }

  private fun normalizeHeartProfile() {
    val shapeIndex = FlubberBaseShape.HEART.ordinal
    val heartY = baseY[shapeIndex]
    val centerY = (heartY.minOrNull()!! + heartY.maxOrNull()!!) / 2.0
    var maximumRadius = 0.0
    for (index in 0 until vertexCount) {
      heartY[index] -= centerY
      maximumRadius = max(maximumRadius, kotlin.math.hypot(baseX[shapeIndex][index], heartY[index]))
    }
    for (index in 0 until vertexCount) {
      baseX[shapeIndex][index] /= maximumRadius
      heartY[index] /= maximumRadius
    }
  }

  private fun centeredModulo(value: Double, period: Double): Double =
      ((value + period / 2.0) % period + period) % period - period / 2.0

  private fun normalize(values: DoubleArray) {
    var low = Double.POSITIVE_INFINITY
    var high = Double.NEGATIVE_INFINITY
    values.forEach { low = min(low, it); high = max(high, it) }
    val range = high - low
    values.indices.forEach { values[it] = (values[it] - low) / if (range == 0.0) 1.0 else range }
  }

  private class Mulberry32(seed: UInt) {
    private var value = seed
    fun next(): Double {
      value += 0x6D2B79F5u
      var result = value
      result = (result xor (result shr 15)) * (result or 1u)
      result = result xor (result + (result xor (result shr 7)) * (result or 61u))
      return (result xor (result shr 14)).toDouble() / 4294967296.0
    }
  }

  private fun fnv1a(seed: String): UInt {
    var hash = 2166136261u
    seed.codePoints().forEach { point -> hash = (hash xor point.toUInt()) * 16777619u }
    return hash
  }
}

object PaletteColor {
  fun resolve(x: Float, y: Float, palette: PaletteSettings): Int {
    val up = max(0f, y)
    val down = max(0f, -y)
    val left = max(0f, -x)
    val right = max(0f, x)
    val total = up + down + left + right
    if (total <= Float.MIN_VALUE) return pack(183, 183, 183)
    val intensity = kotlin.math.hypot(x, y).coerceIn(0f, 1f)
    return pack(
        resolveChannel(1, palette, up, down, left, right, total, intensity),
        resolveChannel(3, palette, up, down, left, right, total, intensity),
        resolveChannel(5, palette, up, down, left, right, total, intensity),
    )
  }

  private fun pack(red: Int, green: Int, blue: Int) =
      0xff000000.toInt() or (red shl 16) or (green shl 8) or blue

  private fun resolveChannel(offset: Int, palette: PaletteSettings, up: Float, down: Float, left: Float, right: Float, total: Float, intensity: Float): Int {
    val directional = (channel(palette.up, offset) * up + channel(palette.down, offset) * down +
        channel(palette.left, offset) * left + channel(palette.right, offset) * right) / total
    return (183f + (directional - 183f) * intensity).roundToInt().coerceIn(0, 255)
  }

  private fun channel(hex: String, offset: Int): Int = digit(hex[offset]) * 16 + digit(hex[offset + 1])

  private fun digit(value: Char): Int = when (value) {
    in '0'..'9' -> value.code - '0'.code
    in 'a'..'f' -> value.code - 'a'.code + 10
    else -> value.code - 'A'.code + 10
  }
}
