package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.runtime.ButtonBits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TouchControllerInputTest {
  @Test fun leftMappingUsesHandSpecificBitsWithoutEntityNames() {
    val state = ButtonBits.ButtonThumbLR or ButtonBits.ButtonThumbLU
    assertEquals(1f, TouchControllerInput.stickX(state, StickHand.LEFT))
    assertEquals(-1f, TouchControllerInput.stickY(state, StickHand.LEFT))
    assertEquals(0f, TouchControllerInput.stickX(state, StickHand.RIGHT))
    assertEquals(0f, TouchControllerInput.stickY(state, StickHand.RIGHT))
  }

  @Test fun rightMappingSupportsDiagonalAndOppositeCancellation() {
    val diagonal = ButtonBits.ButtonThumbRL or ButtonBits.ButtonThumbRD
    assertEquals(-1f, TouchControllerInput.stickX(diagonal, StickHand.RIGHT))
    assertEquals(1f, TouchControllerInput.stickY(diagonal, StickHand.RIGHT))

    val cancelled = ButtonBits.ButtonThumbRL or ButtonBits.ButtonThumbRR
    assertEquals(0f, TouchControllerInput.stickX(cancelled, StickHand.RIGHT))
  }

  @Test fun buttonsFireOnlyOnDownEdges() {
    assertTrue(TouchControllerInput.pressed(ButtonBits.ButtonX, ButtonBits.ButtonX, ButtonBits.ButtonX))
    assertFalse(TouchControllerInput.pressed(ButtonBits.ButtonX, 0, ButtonBits.ButtonX))
    assertFalse(TouchControllerInput.pressed(0, ButtonBits.ButtonX, ButtonBits.ButtonX))
  }

  @Test fun frameMappingUsesOnlyTheConfiguredHandState() {
    val frame = TouchControllerFrame(
        leftButtonState = ButtonBits.ButtonThumbLL or ButtonBits.ButtonThumbLU,
        rightButtonState = ButtonBits.ButtonThumbRR or ButtonBits.ButtonThumbRD,
        leftChangedButtons = 0,
        rightChangedButtons = 0,
        controllerEntities = 2,
        activeControllerEntities = 2,
        controllerTypeEntities = 2,
        handTypeEntities = 0,
        attachmentState = 0,
        avatarState = 0,
        allEntityState = 0,
        directTouchState = 0,
        leftSource = "test",
        rightSource = "test",
    )
    assertEquals(-1f, TouchControllerInput.stickX(frame, StickHand.LEFT))
    assertEquals(-1f, TouchControllerInput.stickY(frame, StickHand.LEFT))
    assertEquals(1f, TouchControllerInput.stickX(frame, StickHand.RIGHT))
    assertEquals(1f, TouchControllerInput.stickY(frame, StickHand.RIGHT))
  }

  @Test fun controllerRoutesMergeZeroAttachmentWithLiveAvatarState() {
    val merged = TouchControllerAdapter.mergeControllerStates(
        0,
        ButtonBits.ButtonThumbLR or ButtonBits.ButtonThumbLU,
        0,
    )
    assertEquals(ButtonBits.ButtonThumbLR or ButtonBits.ButtonThumbLU, merged)
  }

  @Test fun isdkScrollDeltaPreservesDirectionAtStableFullScale() {
    val horizontal = TouchControllerInput.normalizeScroll(12f, 0f)
    assertEquals(1f, horizontal.x, 0.00001f)
    assertEquals(0f, horizontal.y, 0.00001f)

    val diagonal = TouchControllerInput.normalizeScroll(-3f, 4f)
    assertEquals(-0.6f, diagonal.x, 0.00001f)
    assertEquals(0.8f, diagonal.y, 0.00001f)
  }

  @Test fun isdkScrollDeltaRejectsNoiseAndNonFiniteValues() {
    val noise = TouchControllerInput.normalizeScroll(0.00001f, -0.00001f)
    assertEquals(0f, noise.x, 0f)
    assertEquals(0f, noise.y, 0f)

    val invalid = TouchControllerInput.normalizeScroll(Float.NaN, 1f)
    assertEquals(0f, invalid.x, 0f)
    assertEquals(0f, invalid.y, 0f)
  }
}
