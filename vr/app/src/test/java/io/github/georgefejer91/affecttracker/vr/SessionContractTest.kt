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
    assertEquals(false, session.flubber.controllerFollow.enabled)
    assertEquals(StickHand.LEFT, session.flubber.controllerFollow.hand)
    assertEquals(0.18f, session.flubber.controllerFollow.distanceMeters, 0.0001f)
    assertEquals(VrEnvironment.DARK, session.environment)
    assertEquals(FlubberBaseShape.CIRCLE, session.affect.visual.baseShape)
  }

  @Test fun portableBaseShapeIsAcceptedWithACompatibleCircleDefault() {
    assertEquals(
        FlubberBaseShape.HEART,
        SessionContract.parse(manifest(JSONObject(), baseShape = "heart")).affect.visual.baseShape,
    )
    assertThrows(IllegalStateException::class.java) {
      SessionContract.parse(manifest(JSONObject(), baseShape = "star"))
    }
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

  @Test fun passthroughAndControllerFollowAreAcceptedAndTypeChecked() {
    val follow = JSONObject()
        .put("enabled", true).put("hand", "left").put("distanceMeters", 0.22)
    val session = SessionContract.parse(
        manifest(JSONObject(), environment = "passthrough", controllerFollow = follow),
    )
    assertEquals(VrEnvironment.PASSTHROUGH, session.environment)
    assertEquals(true, session.flubber.controllerFollow.enabled)
    assertEquals(StickHand.LEFT, session.flubber.controllerFollow.hand)
    assertEquals(0.22f, session.flubber.controllerFollow.distanceMeters, 0.0001f)
    assertThrows(IllegalArgumentException::class.java) {
      SessionContract.parse(manifest(JSONObject(), controllerFollow = JSONObject().put("enabled", "true")))
    }
    assertThrows(IllegalStateException::class.java) {
      SessionContract.parse(manifest(JSONObject(), environment = "camera"))
    }
  }

  @Test fun activeRuntimeProfileSupersedesEveryOptionalVideoProfile() {
    val active = SessionContract.parse(
        manifest(JSONObject().put("stick", "right"), filename = "primary.mp4", showAffectValues = true),
    )
    val optional = SessionContract.parse(
        manifest(JSONObject().put("stick", "left"), filename = "immersive.webm", showAffectValues = false),
    )

    val effective = optional.withRuntimeProfile(active)

    assertEquals("immersive.webm", effective.video.file)
    assertEquals(optional.video.projection, effective.video.projection)
    assertEquals(StickHand.RIGHT, effective.controls.stick)
    assertEquals(true, effective.flubber.showAffectValues)
    assertEquals(active.affect, effective.affect)
    assertEquals(active.environment, effective.environment)
    assertEquals(active.flubber.controllerFollow, effective.flubber.controllerFollow)
  }

  @Test fun headsetLauncherOverridesOnlyEnvironmentAndControllerFollowForOneRun() {
    val original = SessionContract.parse(manifest(JSONObject()))
    val effective = original.withLauncherRuntimeOverrides(
        mixedRealityEnabled = true,
        flubberOnlyPassthrough = true,
        controllerFollowEnabled = true,
        controllerFollowHand = StickHand.RIGHT,
        followedControllerVisible = false,
    )

    assertEquals(VrEnvironment.PASSTHROUGH, effective.environment)
    assertEquals(VrPresentationMode.FLUBBER_ONLY, effective.presentationMode)
    assertEquals(true, effective.flubber.controllerFollow.enabled)
    assertEquals(StickHand.RIGHT, effective.flubber.controllerFollow.hand)
    assertEquals(false, effective.flubber.controllerFollow.showControllerModel)
    assertEquals(original.flubber.controllerFollow.distanceMeters, effective.flubber.controllerFollow.distanceMeters)
    assertEquals(original.video, effective.video)
    assertEquals(original.controls, effective.controls)
    assertEquals(VrEnvironment.DARK, original.environment)
    assertEquals(VrPresentationMode.VIDEO, original.presentationMode)
    assertEquals(false, original.flubber.controllerFollow.enabled)
  }

  @Test fun discoveredMediaFilenameSafetyMatchesManifestSafety() {
    assertEquals(true, SessionContract.isSafeVideoFilename("clip with spaces.webm"))
    assertEquals(false, SessionContract.isSafeVideoFilename("../clip.mp4"))
    assertEquals(false, SessionContract.isSafeVideoFilename("folder/clip.mp4"))
  }

  private fun manifest(
      controls: JSONObject,
      filename: String = "stimulus.mp4",
      showAffectValues: Boolean? = null,
      rawShowAffectValues: Any? = null,
      environment: String = "dark",
      controllerFollow: JSONObject? = null,
      baseShape: String? = null,
  ): String {
    val flubber = JSONObject()
        .put("widthMeters", 0.3).put("distanceMeters", 1.25)
        .put("horizontalOffsetMeters", 0).put("verticalOffsetMeters", -0.3)
    if (showAffectValues != null) flubber.put("showAffectValues", showAffectValues)
    if (rawShowAffectValues != null) flubber.put("showAffectValues", rawShowAffectValues)
    if (controllerFollow != null) flubber.put("controllerFollow", controllerFollow)
    val affectSettings = JSONObject(AFFECT_SETTINGS)
    if (baseShape != null) affectSettings.getJSONObject("visual").put("baseShape", baseShape)
    return JSONObject()
      .put("schema", "affect-tracker-vr-session")
      .put("version", 1)
      .put("sessionId", "contract-test")
      .put("video", JSONObject()
          .put("file", filename).put("byteLength", 42).put("sha256", "a".repeat(64))
          .put("projection", "flat").put("stereo", "mono").put("loop", false))
      .put("affectSettings", affectSettings)
      .put("vr", JSONObject()
          .put("environment", environment)
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
