package io.github.georgefejer91.affecttracker.vr

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import kotlin.math.min

class FlubberView(context: Context, private val onShapeDrawn: (Float, Float) -> Unit = { _, _ -> }) : View(context) {
  private val path = Path()
  private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; color = Color.WHITE }
  private var geometry: FlubberGeometry? = null
  private var color = Color.rgb(183, 183, 183)
  private var opacity = 0.95f
  private var visibleShape = true
  private var valence = 0f
  private var arousal = 0f

  init {
    setBackgroundColor(Color.TRANSPARENT)
    setLayerType(LAYER_TYPE_HARDWARE, null)
  }

  fun render(next: FlubberGeometry, affectColor: Int, alpha: Float, visible: Boolean, currentValence: Float, currentArousal: Float) {
    geometry = next
    color = affectColor
    opacity = alpha.coerceIn(0f, 1f)
    visibleShape = visible
    valence = currentValence
    arousal = currentArousal
    postInvalidateOnAnimation()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val points = geometry ?: return
    if (!visibleShape || points.x.isEmpty()) return
    val scale = min(width, height) * 0.36f
    val centerX = width * 0.5f
    val centerY = height * 0.5f
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
    onShapeDrawn(valence, arousal)
  }
}
