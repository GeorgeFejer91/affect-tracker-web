package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.core.Vector2
import com.meta.spatial.runtime.ButtonBits
import kotlin.math.hypot

/** Pure routing for the hand-specific Touch button bits published by Spatial SDK. */
internal object TouchControllerInput {
  const val SCROLL_EPSILON = 0.0001f

  fun stickX(frame: TouchControllerFrame, hand: StickHand): Float =
      stickX(if (hand == StickHand.LEFT) frame.leftButtonState else frame.rightButtonState, hand)

  fun stickY(frame: TouchControllerFrame, hand: StickHand): Float =
      stickY(if (hand == StickHand.LEFT) frame.leftButtonState else frame.rightButtonState, hand)

  fun stickX(buttonState: Int, hand: StickHand): Float {
    val left = if (hand == StickHand.LEFT) ButtonBits.ButtonThumbLL else ButtonBits.ButtonThumbRL
    val right = if (hand == StickHand.LEFT) ButtonBits.ButtonThumbLR else ButtonBits.ButtonThumbRR
    return direction(buttonState, negative = left, positive = right)
  }

  fun stickY(buttonState: Int, hand: StickHand): Float {
    val up = if (hand == StickHand.LEFT) ButtonBits.ButtonThumbLU else ButtonBits.ButtonThumbRU
    val down = if (hand == StickHand.LEFT) ButtonBits.ButtonThumbLD else ButtonBits.ButtonThumbRD
    // Android/Spatial stick Y is negative when the participant pushes up.
    return direction(buttonState, negative = up, positive = down)
  }

  fun pressed(buttonState: Int, changedButtons: Int, button: Int): Boolean =
      button != 0 && (buttonState and changedButtons and button) != 0

  private fun direction(buttonState: Int, negative: Int, positive: Int): Float {
    var value = 0f
    if ((buttonState and negative) == negative) value -= 1f
    if ((buttonState and positive) == positive) value += 1f
    return value
  }

  /** Converts ISDK's arbitrary scroll delta into the stable direction vector used by AffectEngine. */
  fun normalizeScroll(x: Float, y: Float): Vector2 {
    val magnitude = hypot(x, y)
    if (!magnitude.isFinite() || magnitude <= SCROLL_EPSILON) return Vector2(0f, 0f)
    return Vector2(x / magnitude, y / magnitude)
  }
}
