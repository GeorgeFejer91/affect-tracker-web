package io.github.georgefejer91.affecttracker.vr

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.view.View

class FlubberView(context: Context, private val onShapeDrawn: (Float, Float) -> Unit = { _, _ -> }) : View(context) {
  private val path = Path()
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; color = Color.WHITE }
  private val telemetryStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeJoin = Paint.Join.ROUND
    textAlign = Paint.Align.CENTER
    typeface = Typeface.MONOSPACE
    color = Color.BLACK
  }
  private val telemetryFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.FILL
    textAlign = Paint.Align.CENTER
    typeface = Typeface.MONOSPACE
    color = Color.WHITE
  }
  private val telemetry = AffectTelemetryText()
  private var geometry: FlubberGeometry? = null
  private var color = Color.rgb(183, 183, 183)
  private var opacity = 0.95f
  private var visibleShape = true
  private var valence = 0f
  private var arousal = 0f
  private var showAffectValues = false

  init {
    setBackgroundColor(Color.TRANSPARENT)
    setLayerType(LAYER_TYPE_HARDWARE, null)
  }

  fun resetTelemetry() = telemetry.reset()

  fun render(
      next: FlubberGeometry,
      affectColor: Int,
      alpha: Float,
      visible: Boolean,
      currentValence: Float,
      currentArousal: Float,
      displayAffectValues: Boolean,
      nowNanos: Long = System.nanoTime(),
  ) {
    geometry = next
    color = affectColor
    opacity = alpha.coerceIn(0f, 1f)
    visibleShape = visible
    valence = currentValence
    arousal = currentArousal
    if (showAffectValues && !displayAffectValues) telemetry.reset()
    showAffectValues = displayAffectValues
    if (showAffectValues) {
      telemetry.update(nowNanos, currentValence, currentArousal)
    }
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val points = geometry ?: return
    if (!visibleShape || points.x.isEmpty()) return
    val scale = width * FlubberPanelLayout.CONTENT_SCALE_FRACTION
    val centerX = width * 0.5f
    val centerY = width * FlubberPanelLayout.CONTENT_CENTER_Y_TO_WIDTH
    path.rewind()
    path.moveTo(centerX + points.x[0] * scale, centerY + points.y[0] * scale)
    for (index in 1 until points.x.size) path.lineTo(centerX + points.x[index] * scale, centerY + points.y[index] * scale)
    path.close()

    halo.color = color
    halo.alpha = (opacity * 87).toInt()
    halo.strokeWidth = width * 0.035f
    fill.color = color
    fill.alpha = (opacity * 194).toInt()
    outline.alpha = (opacity * 235).toInt()
    outline.strokeWidth = width * 0.009f
    canvas.drawPath(path, halo)
    canvas.drawPath(path, fill)
    canvas.drawPath(path, outline)
    if (showAffectValues) drawTelemetry(canvas)
    onShapeDrawn(valence, arousal)
  }

  private fun drawTelemetry(canvas: Canvas) {
    val textSize = width * FlubberPanelLayout.TELEMETRY_TEXT_SIZE_TO_WIDTH
    val baseline = height - width * FlubberPanelLayout.TELEMETRY_BASELINE_BOTTOM_MARGIN_TO_WIDTH
    telemetryStroke.textSize = textSize
    telemetryStroke.strokeWidth = textSize * 0.19f
    telemetryFill.textSize = textSize
    drawTelemetryLine(canvas, telemetry.coordinateLine, baseline)
  }

  private fun drawTelemetryLine(canvas: Canvas, text: String, baseline: Float) {
    canvas.drawText(text, width * 0.5f, baseline, telemetryStroke)
    canvas.drawText(text, width * 0.5f, baseline, telemetryFill)
  }
}
