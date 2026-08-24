package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.vr.LocomoteState
import com.meta.spatial.vr.LocomotionControls
import com.meta.spatial.vr.LocomotionSystem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class LocomotionPolicyTest {
  @Test fun disabledBridgeDoesNotClaimControllers() {
    val bridge = LocomotionSystem(LocomotionControls.Right, false)

    bridge.enableLocomotion(false)

    assertEquals(LocomoteState.Disabled, bridge.locomoteState)
    assertFalse(bridge.areControllersInUse())
  }
}
