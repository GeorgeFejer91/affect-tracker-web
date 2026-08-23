package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.core.Query
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.SystemBase
import com.meta.spatial.runtime.Scene
import com.meta.spatial.toolkit.AvatarAttachment
import com.meta.spatial.toolkit.AvatarBody
import com.meta.spatial.toolkit.Controller
import com.meta.spatial.toolkit.ControllerType

/**
 * Registers controller polling in Spatial SDK's late-system phase.
 *
 * This matches the working MesmerPrism Spatial SDK apps: the input backend and avatar/controller
 * entities are created by [com.meta.spatial.vr.VRFeature] before this system begins querying them.
 */
internal class TouchControllerPollingFeature(
    private val poll: () -> Unit,
) : SpatialFeature {
  override fun lateSystemsToRegister(): List<SystemBase> = listOf(PollingSystem(poll))

  private class PollingSystem(private val poll: () -> Unit) : SystemBase() {
    override fun execute() = poll()
  }
}

internal data class TouchControllerFrame(
    val leftButtonState: Int,
    val rightButtonState: Int,
    val leftChangedButtons: Int,
    val rightChangedButtons: Int,
    val controllerEntities: Int,
    val activeControllerEntities: Int,
    val controllerTypeEntities: Int,
    val handTypeEntities: Int,
    val attachmentState: Int,
    val avatarState: Int,
    val allEntityState: Int,
    val directTouchState: Int,
    val leftSource: String,
    val rightSource: String,
) {
  val buttonState: Int get() = leftButtonState or rightButtonState
  val changedButtons: Int get() = leftChangedButtons or rightChangedButtons
}

/** Selects the hand-specific local attachment, then avatar hand, then all-controller fallback. */
internal object TouchControllerAdapter {
  /** Must run from [SystemBase.execute] after VRFeature has created the live scene data model. */
  fun capture(scene: Scene): TouchControllerFrame {
    var localLeftState = 0
    var localRightState = 0
    var localLeftChanged = 0
    var localRightChanged = 0
    var localLeftFound = false
    var localRightFound = false
    var attachmentState = 0
    var fallbackState = 0
    var fallbackChanged = 0
    var directTouchState = 0
    var controllerEntities = 0
    var activeControllerEntities = 0
    var controllerTypeEntities = 0
    var handTypeEntities = 0
    val dataModel = scene.spatialInterface.dataModel
    Query.where { has(Controller.id) }.eval(dataModel).forEach { entity ->
      // getComponent matches Meta's controller samples and forces a current component read.
      val controller = runCatching { entity.getComponent<Controller>() }.getOrNull() ?: return@forEach
      controllerEntities += 1
      if (controller.isActive) activeControllerEntities += 1
      when (controller.type.name) {
        "CONTROLLER" -> controllerTypeEntities += 1
        "HAND" -> handTypeEntities += 1
      }
      if (controller.type != ControllerType.CONTROLLER) return@forEach
      // Interaction SDK may publish contact-derived buttons separately from the ordinary state.
      // Preserve both representations; unknown bits are harmless and the mapping layer reads only
      // the configured thumb/button masks.
      val completeState = controller.buttonState or controller.directTouchButtonState
      directTouchState = directTouchState or controller.directTouchButtonState
      fallbackState = fallbackState or completeState
      fallbackChanged = fallbackChanged or controller.changedButtons
      if (!runCatching { entity.isLocal() }.getOrDefault(false)) return@forEach
      when (entity.tryGetComponent<AvatarAttachment>()?.type) {
        "left_controller", "left_hand" -> {
          localLeftFound = true
          localLeftState = localLeftState or completeState
          localLeftChanged = localLeftChanged or controller.changedButtons
          attachmentState = attachmentState or completeState
        }
        "right_controller", "right_hand" -> {
          localRightFound = true
          localRightState = localRightState or completeState
          localRightChanged = localRightChanged or controller.changedButtons
          attachmentState = attachmentState or completeState
        }
      }
    }

    var playerBody: AvatarBody? = null
    Query.where { has(AvatarBody.id) }.eval(dataModel).forEach { entity ->
      val body = runCatching { entity.getComponent<AvatarBody>() }.getOrNull() ?: return@forEach
      if (!body.isPlayerControlled || !runCatching { entity.isLocal() }.getOrDefault(false)) {
        return@forEach
      }
      if (playerBody == null) playerBody = body
    }
    // A default AvatarBody uses entity id 0 for an unavailable hand. Reading a component from that
    // sentinel enters native code and produces one Spatial SDK stack trace per frame.
    val avatarLeft = playerBody?.leftHand
        ?.takeIf { it.id != 0L }
        ?.let { runCatching { it.tryGetComponent<Controller>() }.getOrNull() }
    val avatarRight = playerBody?.rightHand
        ?.takeIf { it.id != 0L }
        ?.let { runCatching { it.tryGetComponent<Controller>() }.getOrNull() }
    val avatarLeftState = (avatarLeft?.buttonState ?: 0) or (avatarLeft?.directTouchButtonState ?: 0)
    val avatarRightState = (avatarRight?.buttonState ?: 0) or (avatarRight?.directTouchButtonState ?: 0)
    val avatarState = avatarLeftState or avatarRightState

    val avatarLeftUsable = avatarLeft?.type == ControllerType.CONTROLLER
    val avatarRightUsable = avatarRight?.type == ControllerType.CONTROLLER
    val leftAttachmentFound = localLeftFound
    val rightAttachmentFound = localRightFound
    val resolvedLeftState = when {
      leftAttachmentFound -> localLeftState
      avatarLeftUsable -> avatarLeftState
      else -> fallbackState
    }
    val resolvedRightState = when {
      rightAttachmentFound -> localRightState
      avatarRightUsable -> avatarRightState
      else -> fallbackState
    }
    val resolvedLeftChanged = when {
      leftAttachmentFound -> localLeftChanged
      avatarLeftUsable -> avatarLeft?.changedButtons ?: 0
      else -> fallbackChanged
    }
    val resolvedRightChanged = when {
      rightAttachmentFound -> localRightChanged
      avatarRightUsable -> avatarRight?.changedButtons ?: 0
      else -> fallbackChanged
    }
    return TouchControllerFrame(
        leftButtonState = resolvedLeftState,
        rightButtonState = resolvedRightState,
        leftChangedButtons = resolvedLeftChanged,
        rightChangedButtons = resolvedRightChanged,
        controllerEntities = controllerEntities,
        activeControllerEntities = activeControllerEntities,
        controllerTypeEntities = controllerTypeEntities,
        handTypeEntities = handTypeEntities,
        attachmentState = attachmentState,
        avatarState = avatarState,
        allEntityState = fallbackState,
        directTouchState = directTouchState,
        leftSource = when {
          leftAttachmentFound -> "spatial_sdk_left_attachment"
          avatarLeftUsable -> "spatial_sdk_left_avatar"
          else -> "spatial_sdk_controller_fallback"
        },
        rightSource = when {
          rightAttachmentFound -> "spatial_sdk_right_attachment"
          avatarRightUsable -> "spatial_sdk_right_avatar"
          else -> "spatial_sdk_controller_fallback"
        },
    )
  }

  internal fun mergeControllerStates(vararg states: Int?): Int {
    var merged = 0
    for (state in states) merged = merged or (state ?: 0)
    return merged
  }
}
