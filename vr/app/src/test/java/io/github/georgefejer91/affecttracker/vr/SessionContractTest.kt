package io.github.georgefejer91.affecttracker.vr

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionContractTest {
  @Test fun omittedControllerFieldsUseDocumentedDefaults() {
    val session = SessionContract.parse(manifest(JSONObject()))
    assertEquals(StickHand.RIGHT, session.controls.stick)
    assertEquals("x", session.controls.resetButton)
    assertEquals("y", session.controls.pauseButton)
    assertEquals(true, session.controls.showControllerModels)
    assertEquals(false, session.flubber.showAffectValues)
  }

  @Test fun traversalAndUnknownControllerFieldsAreRejected() {
    assertThrows(IllegalArgumentException::class.java) { SessionContract.parse(manifest(JSONObject(), "../stimulus.mp4")) }
    assertThrows(IllegalArgumentException::class.java) { SessionContract.parse(manifest(JSONObject().put("surprise", "a"))) }
    assertThrows(IllegalArgumentException::class.java) {
      SessionContract.parse(manifest(JSONObject().put("showControllerModels", "false")))
    }
  }

  @Test fun explicitControllerMappingIsAccepted() {
    val controls = JSONObject()
        .put("stick", "right").put("resetButton", "a").put("pauseButton", "b").put("grabTrigger", "either")
        .put("showControllerModels", false)
    val session = SessionContract.parse(manifest(controls))
    assertEquals(StickHand.RIGHT, session.controls.stick)
    assertEquals("a", session.controls.resetButton)
    assertEquals("b", session.controls.pauseButton)
    assertEquals(false, session.controls.showControllerModels)
  }

  @Test fun explicitAffectValueReadoutIsAcceptedAndTypeChecked() {
    val enabled = SessionContract.parse(manifest(JSONObject(), showAffectValues = true))
    assertEquals(true, enabled.flubber.showAffectValues)
    assertThrows(IllegalArgumentException::class.java) {
      SessionContract.parse(manifest(JSONObject(), rawShowAffectValues = "true"))
    }
  }

  private fun manifest(
      controls: JSONObject,
      filename: String = "stimulus.mp4",
      showAffectValues: Boolean? = null,
      rawShowAffectValues: Any? = null,
  ): String {
    val flubber = JSONObject()
        .put("widthMeters", 0.3).put("distanceMeters", 1.25)
        .put("horizontalOffsetMeters", 0).put("verticalOffsetMeters", -0.3)
    if (showAffectValues != null) flubber.put("showAffectValues", showAffectValues)
    if (rawShowAffectValues != null) flubber.put("showAffectValues", rawShowAffectValues)
    return JSONObject()
      .put("schema", "affect-tracker-vr-session")
      .put("version", 1)
      .put("sessionId", "contract-test")
      .put("video", JSONObject()
          .put("file", filename).put("byteLength", 42).put("sha256", "a".repeat(64))
          .put("projection", "flat").put("stereo", "mono").put("loop", false))
      .put("affectSettings", JSONObject(AFFECT_SETTINGS))
      .put("vr", JSONObject()
          .put("environment", "dark")
          .put("flubber", flubber)
          .put("controls", controls))
      .toString()
  }

  companion object {
    private val AFFECT_SETTINGS = """
      {"version":1,"inputMode":"continuous","stepSize":0.1,"continuousSpeed":0.8,"response":8,
       "bindings":{"increaseValence":"key:ArrowRight","decreaseValence":"key:ArrowLeft","increaseArousal":"key:ArrowUp","decreaseArousal":"key:ArrowDown","reset":"key:KeyR","togglePause":"key:Space","showSettings":"key:F10","toggleOverlayEditing":"key:F9"},
       "advancedBindings":{},"visual":{"animationSpeed":1,"amplitudeScale":1,"disorderScale":1},
       "palette":{"up":"#ffd166","down":"#5c7cfa","left":"#ff5b68","right":"#5dffb0"},
       "overlay":{"x":120,"y":120,"size":240,"opacity":0.95,"visible":true},
       "lsl":{"streamName":"AffectTracker","streamType":"Affect","markerName":"AffectTrackerMarkers","sampleRate":50,"sourceId":"affect-tracker-vr"}}
    """.trimIndent()
  }
}
