package io.github.georgefejer91.affecttracker.vr

import org.json.JSONObject

enum class Projection(val token: String) { FLAT("flat"), EQUIRECT_180("equirect-180"), EQUIRECT_360("equirect-360") }
enum class StereoLayout(val token: String) { MONO("mono"), SIDE_BY_SIDE("side-by-side-left-right"), TOP_BOTTOM("top-bottom") }
enum class StickHand(val token: String) { LEFT("left"), RIGHT("right") }
enum class VrEnvironment(val token: String) { DARK("dark"), PASSTHROUGH("passthrough") }
enum class VrPresentationMode(val token: String) { VIDEO("video"), FLUBBER_ONLY("flubber-only") }
enum class FlubberBaseShape(val token: String) { CIRCLE("circle"), HEART("heart"), TRIANGLE("triangle"), SQUARE("square") }

data class VideoSpec(
    val file: String,
    val byteLength: Long,
    val sha256: String,
    val projection: Projection,
    val stereo: StereoLayout,
    val loop: Boolean,
)

data class VisualSettings(
    val animationSpeed: Double,
    val amplitudeScale: Double,
    val disorderScale: Double,
    val baseShape: FlubberBaseShape = FlubberBaseShape.CIRCLE,
)
data class PaletteSettings(val up: String, val down: String, val left: String, val right: String)
data class OverlaySettings(val opacity: Double, val visible: Boolean)
data class LslSettings(
    val streamName: String,
    val streamType: String,
    val markerName: String,
    val sampleRate: Int,
    val sourceId: String,
)

data class AffectSettings(
    val inputMode: String,
    val stepSize: Double,
    val continuousSpeed: Double,
    val response: Double,
    val visual: VisualSettings,
    val palette: PaletteSettings,
    val overlay: OverlaySettings,
    val lsl: LslSettings,
)

data class FlubberPlacement(
    val widthMeters: Float,
    val distanceMeters: Float,
    val horizontalOffsetMeters: Float,
    val verticalOffsetMeters: Float,
    val showAffectValues: Boolean,
    val controllerFollow: ControllerFollowSettings,
)

data class ControllerFollowSettings(
    val enabled: Boolean,
    val hand: StickHand,
    val distanceMeters: Float,
    /** Runtime-only launcher choice; it is deliberately not part of session JSON v1. */
    val showControllerModel: Boolean = true,
)

data class ControllerBindings(
    val stick: StickHand,
    val resetButton: String,
    val pauseButton: String,
    val showControllerModels: Boolean,
)

data class VrSession(
    val sessionId: String,
    val video: VideoSpec,
    val affect: AffectSettings,
    val environment: VrEnvironment,
    val flubber: FlubberPlacement,
    val controls: ControllerBindings,
    /** Runtime-only presentation choice; admitted v1 manifests always parse as [VIDEO]. */
    val presentationMode: VrPresentationMode = VrPresentationMode.VIDEO,
)

/**
 * Applies the one experiment-wide runtime profile from active-session.json to another video.
 *
 * Optional manifests retain only their media identity and explicit spatial layout. This prevents a
 * video choice from silently changing controller ownership, Flubber behavior, placement, or LSL.
 */
internal fun VrSession.withRuntimeProfile(profile: VrSession): VrSession = copy(
    affect = profile.affect,
    environment = profile.environment,
    flubber = profile.flubber,
    controls = profile.controls,
)

/** Applies transient headset-launcher choices without rewriting the admitted JSON profile. */
internal fun VrSession.withLauncherRuntimeOverrides(
    mixedRealityEnabled: Boolean,
    flubberOnlyPassthrough: Boolean,
    controllerFollowEnabled: Boolean,
    controllerFollowHand: StickHand,
    followedControllerVisible: Boolean,
): VrSession = copy(
    environment = if (mixedRealityEnabled || flubberOnlyPassthrough) VrEnvironment.PASSTHROUGH else VrEnvironment.DARK,
    presentationMode = if (flubberOnlyPassthrough) VrPresentationMode.FLUBBER_ONLY else VrPresentationMode.VIDEO,
    flubber = flubber.copy(
        controllerFollow = flubber.controllerFollow.copy(
            enabled = controllerFollowEnabled,
            hand = controllerFollowHand,
            showControllerModel = followedControllerVisible,
        ),
    ),
)

object SessionContract {
  private val sessionIdPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
  private val hashPattern = Regex("^[a-f0-9]{64}$")
  private val colorPattern = Regex("^#[0-9a-fA-F]{6}$")
  private val buttons = setOf("x", "y", "a", "b", "none")
  private val coreActions = setOf("increaseValence", "decreaseValence", "increaseArousal", "decreaseArousal", "reset", "togglePause", "showSettings", "toggleOverlayEditing")
  private val advancedActions = setOf("increaseAnimationSpeed", "decreaseAnimationSpeed", "increaseAmplitude", "decreaseAmplitude", "increaseDisorder", "decreaseDisorder", "increaseTransparency", "decreaseTransparency", "increaseSize", "decreaseSize")
  private val keyBinding = Regex("^key:[A-Za-z0-9]{1,40}$")
  private val mouseBinding = Regex("^mouse:(left|right|middle|button4|button5)$", RegexOption.IGNORE_CASE)
  private val wheelBinding = Regex("^wheel:(up|down|left|right)$", RegexOption.IGNORE_CASE)

  fun parse(text: String): VrSession {
    require(text.toByteArray(Charsets.UTF_8).size <= MAX_MANIFEST_BYTES) { "manifest_too_large" }
    val root = JSONObject(text)
    root.requireExact("schema", "version", "sessionId", "video", "affectSettings", "vr")
    require(root.getString("schema") == "affect-tracker-vr-session") { "unsupported_schema" }
    require(root.getInt("version") == 1) { "unsupported_version" }
    val sessionId = root.getString("sessionId")
    require(sessionIdPattern.matches(sessionId)) { "invalid_session_id" }
    val video = parseVideo(root.getJSONObject("video"))
    val affect = parseAffect(root.getJSONObject("affectSettings"))
    val vr = root.getJSONObject("vr")
    vr.requireExact("environment", "flubber", "controls")
    val environment = enumValue(vr.getString("environment"), VrEnvironment.entries) { it.token }
    return VrSession(
        sessionId,
        video,
        affect,
        environment,
        parseFlubber(vr.getJSONObject("flubber")),
        parseControls(vr.getJSONObject("controls")),
    )
  }

  private fun parseVideo(value: JSONObject): VideoSpec {
    value.requireExact("file", "byteLength", "sha256", "projection", "stereo", "loop")
    val file = value.getString("file")
    require(isSafeVideoFilename(file)) { "invalid_video_filename" }
    val bytes = value.getLong("byteLength")
    require(bytes in 1..9_007_199_254_740_991L) { "invalid_video_length" }
    val hash = value.getString("sha256")
    require(hashPattern.matches(hash)) { "invalid_video_sha256" }
    return VideoSpec(
        file,
        bytes,
        hash,
        enumValue(value.getString("projection"), Projection.entries) { it.token },
        enumValue(value.getString("stereo"), StereoLayout.entries) { it.token },
        value.getBoolean("loop"),
    )
  }

  internal fun isSafeVideoFilename(file: String): Boolean =
      file.isNotEmpty() && file.length <= 255 && file != "." && file != ".." &&
          !file.contains('/') && !file.contains('\\') && !file.contains('\u0000')

  private fun parseAffect(value: JSONObject): AffectSettings {
    value.requireExact("version", "inputMode", "stepSize", "continuousSpeed", "response", "bindings", "advancedBindings", "visual", "palette", "overlay", "lsl")
    require(value.getInt("version") == 1) { "unsupported_affect_settings" }
    val mode = value.getString("inputMode")
    require(mode == "continuous" || mode == "step") { "invalid_input_mode" }
    val visual = value.getJSONObject("visual")
    val palette = value.getJSONObject("palette")
    val overlay = value.getJSONObject("overlay")
    val lsl = value.getJSONObject("lsl")
    val bindings = value.getJSONObject("bindings")
    val advancedBindings = value.getJSONObject("advancedBindings")
    val requiredVisual = setOf("animationSpeed", "amplitudeScale", "disorderScale")
    visual.requireKnown(*requiredVisual.toTypedArray(), "baseShape")
    require(requiredVisual.all(visual::has)) { "unknown_or_missing_fields" }
    palette.requireExact("up", "down", "left", "right")
    overlay.requireExact("x", "y", "size", "opacity", "visible")
    lsl.requireExact("streamName", "streamType", "markerName", "sampleRate", "sourceId")
    bindings.requireExact(*coreActions.toTypedArray())
    advancedBindings.requireKnown(*advancedActions.toTypedArray())
    val assigned = mutableSetOf<String>()
    (coreActions.map { bindings.getString(it) } + advancedBindings.keys().asSequence().map { advancedBindings.getString(it) })
        .forEach { binding ->
          require(keyBinding.matches(binding) || mouseBinding.matches(binding) || wheelBinding.matches(binding)) { "invalid_binding" }
          require(assigned.add(binding.lowercase())) { "duplicate_binding" }
        }
    return AffectSettings(
        mode,
        value.number("stepSize", 0.01, 1.0),
        value.number("continuousSpeed", 0.05, 4.0),
        value.number("response", 0.1, 30.0),
        VisualSettings(
            visual.number("animationSpeed", 0.25, 4.0),
            visual.number("amplitudeScale", 0.0, 2.0),
            visual.number("disorderScale", 0.0, 2.0),
            enumValue(visual.optString("baseShape", "circle"), FlubberBaseShape.entries) { it.token },
        ),
        PaletteSettings(palette.color("up"), palette.color("down"), palette.color("left"), palette.color("right")),
        OverlaySettings(overlay.number("opacity", 0.0, 1.0), overlay.getBoolean("visible")),
        LslSettings(lsl.text("streamName", 80), lsl.text("streamType", 80), lsl.text("markerName", 80), lsl.number("sampleRate", 1.0, 240.0).toInt(), lsl.text("sourceId", 120)),
    )
  }

  private fun parseFlubber(value: JSONObject): FlubberPlacement {
    val required = setOf("widthMeters", "distanceMeters", "horizontalOffsetMeters", "verticalOffsetMeters")
    value.requireKnown(*required.toTypedArray(), "showAffectValues", "controllerFollow")
    require(required.all(value::has)) { "unknown_or_missing_fields" }
    val showAffectValues = if (value.has("showAffectValues")) {
      require(value.get("showAffectValues") is Boolean) { "invalid_show_affect_values" }
      value.getBoolean("showAffectValues")
    } else false
    val controllerFollow = if (value.has("controllerFollow")) {
      require(value.get("controllerFollow") is JSONObject) { "invalid_controller_follow" }
      parseControllerFollow(value.getJSONObject("controllerFollow"))
    } else {
      ControllerFollowSettings(false, StickHand.LEFT, 0.18f)
    }
    return FlubberPlacement(
        value.number("widthMeters", 0.12, 1.2).toFloat(),
        value.number("distanceMeters", 0.35, 5.0).toFloat(),
        value.number("horizontalOffsetMeters", -2.0, 2.0).toFloat(),
        value.number("verticalOffsetMeters", -2.0, 2.0).toFloat(),
        showAffectValues,
        controllerFollow,
    )
  }

  private fun parseControllerFollow(value: JSONObject): ControllerFollowSettings {
    value.requireKnown("enabled", "hand", "distanceMeters")
    val enabled = if (value.has("enabled")) {
      require(value.get("enabled") is Boolean) { "invalid_controller_follow_enabled" }
      value.getBoolean("enabled")
    } else false
    return ControllerFollowSettings(
        enabled,
        enumValue(value.optString("hand", "left"), StickHand.entries) { it.token },
        if (value.has("distanceMeters")) {
          value.number("distanceMeters", 0.05, 0.6).toFloat()
        } else 0.18f,
    )
  }

  private fun parseControls(value: JSONObject): ControllerBindings {
    value.requireKnown("stick", "resetButton", "pauseButton", "grabTrigger", "showControllerModels")
    require(value.optString("grabTrigger", "either") == "either") { "invalid_grab_trigger" }
    val reset = value.optString("resetButton", "x")
    val pause = value.optString("pauseButton", "y")
    val showControllerModels = if (value.has("showControllerModels")) {
      require(value.get("showControllerModels") is Boolean) { "invalid_show_controller_models" }
      value.getBoolean("showControllerModels")
    } else true
    require(reset in buttons && pause in buttons && (reset == "none" || reset != pause)) { "invalid_controller_bindings" }
    return ControllerBindings(
        enumValue(value.optString("stick", "right"), StickHand.entries) { it.token },
        reset,
        pause,
        showControllerModels,
    )
  }

  private fun JSONObject.requireExact(vararg names: String) {
    require(keys().asSequence().toSet() == names.toSet()) { "unknown_or_missing_fields" }
  }

  private fun JSONObject.requireKnown(vararg names: String) {
    require(keys().asSequence().all { it in names }) { "unknown_fields" }
  }

  private fun JSONObject.number(name: String, min: Double, max: Double): Double =
      getDouble(name).also { require(it.isFinite() && it in min..max) { "invalid_$name" } }

  private fun JSONObject.text(name: String, max: Int): String =
      getString(name).trim().also { require(it.isNotEmpty() && it.length <= max && !it.contains('\u0000')) { "invalid_$name" } }

  private fun JSONObject.color(name: String): String =
      getString(name).lowercase().also { require(colorPattern.matches(it)) { "invalid_palette" } }

  private fun <T> enumValue(token: String, values: List<T>, selector: (T) -> String): T =
      values.firstOrNull { selector(it) == token } ?: error("unsupported_enum_$token")

  const val MAX_MANIFEST_BYTES = 256 * 1024
}
