package io.github.georgefejer91.affecttracker.vr

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.graphics.Color as AndroidColor
import android.os.Bundle
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.SpatialSDKExperimentalAPI
import com.meta.spatial.core.Vector2
import com.meta.spatial.core.Vector3
import com.meta.spatial.core.Vector4
import com.meta.spatial.isdk.IsdkGrabState
import com.meta.spatial.isdk.IsdkGrabbable
import com.meta.spatial.isdk.IsdkPanelGrabHandle
import com.meta.spatial.isdk.IsdkSystem
import com.meta.spatial.runtime.ButtonBits
import com.meta.spatial.runtime.PanelShapeLayerBlendType
import com.meta.spatial.runtime.PointerEvent
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.AvatarSystem
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.GrabbableType
import com.meta.spatial.toolkit.Hittable
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelDimensions
import com.meta.spatial.toolkit.PanelInputOptions
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelRenderMode
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelRenderOptions
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.Visible
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.LocomotionControls
import com.meta.spatial.vr.LocomoteState
import com.meta.spatial.vr.LocomotionSystem
import com.meta.spatial.vr.VRFeature
import com.meta.spatial.vr.VrInputSystemType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs

@OptIn(SpatialSDKExperimentalAPI::class)
class AffectTrackerVrActivity : AppSystemActivity() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val runtime get() = (application as AffectTrackerVrApplication).runtime
  private lateinit var player: SpatialVideoPlayer
  private lateinit var videoCoordinator: SpatialVideoCoordinator
  private val lsl get() = runtime.lsl
  private var engine: AffectEngine? = null
  private var geometry: FlubberGeometry? = null
  private var staged: StagedSession? = null
  private var flubberView: FlubberView? = null
  private var flubberEntity: Entity? = null
  private var controlEntity: Entity? = null
  private var sceneReady = false
  private var sessionActive = false
  private var lslSamplingActive = false
  private var countdownStarted = false
  private var playerReady = false
  private var phase = 0.0
  private var lastTickNanos = 0L
  private var lslAccumulator = 0f
  private var lastHorizontalDirection = "neutral"
  private var lastVerticalDirection = "neutral"
  private var lastGrabbed = false
  private var pausedForFocus = false
  private var firstFlubberDrawLogged = false
  private var reactiveFlubberDrawLogged = false
  private var lastControllerInventory = ""
  private var lastControllerButtonState = Int.MIN_VALUE
  private var isdkSystem: IsdkSystem? = null
  private lateinit var locomotionInputBridge: LocomotionSystem
  private var spatialStickX = 0f
  private var spatialStickY = 0f
  @Volatile private var spatialScrollStickX = 0f
  @Volatile private var spatialScrollStickY = 0f
  @Volatile private var spatialScrollExpiresNanos = 0L
  @Volatile private var spatialScrollEventId = 0
  private var androidStickX = 0f
  private var androidStickY = 0f
  private var androidStickUpdatedNanos = 0L
  private var androidStickRoute = "spatial_vractivity_game_controller"
  private val pinnedGameControllerIds = mutableSetOf<Int>()
  private var nextGameControllerScanNanos = 0L
  private var lastStickRoute = ""
  private var diagnosticStickX = 0f
  private var diagnosticStickY = 0f
  private var diagnosticStickExpiresNanos = 0L
  private var diagnosticCommandId = ""
  private var diagnosticReceiverRegistered = false
  private var pendingDrawReceiptRoute: String? = null
  private var pendingDrawReceiptId = ""
  private var pendingDrawBaselineX = 0f
  private var pendingDrawBaselineY = 0f
  private var grabStartPosition: Vector3? = null
  private var grabMoveLogged = false
  private var status by mutableStateOf("Preparing experiment…")
  private var details by mutableStateOf("Flubber will appear before the countdown.")
  private var controllerInputStatus by mutableStateOf("Right Touch: waiting for immersive input")
  private var lastControllerStatusLabel = ""
  private var lastControllerStatusSource = ""
  private var lastControllerStatusX = Float.NaN
  private var lastControllerStatusY = Float.NaN

  override fun registerFeatures(): List<SpatialFeature> = listOf(
      // Use the same explicit Interaction SDK lifecycle as the working MesmerPrism Spatial apps.
      // VRFeature shares LocomotionSystem with ISDK as its controller-input handoff. Keep that bridge
      // registered, but force its public state to Disabled so it cannot teleport or rotate the world.
      VRFeature(this, LocomotionControls.Right, false, VrInputSystemType.INTERACTION_SDK),
      TouchControllerPollingFeature(::pollSpatialControllers),
      ComposeFeature(),
  )

  override fun onCreate(savedInstanceState: Bundle?) {
    videoCoordinator = SpatialVideoCoordinator { next, surface -> player.attach(next, surface) }
    super.onCreate(savedInstanceState)
    // LocomotionSystem is also VRFeature's ExternalControllerInputHandler state bridge. Removing it
    // stops its per-frame reset and can starve ISDK/controller updates. Disabled preserves that input
    // lifecycle while making areControllersInUse() false and bypassing teleport/snap-turn behavior.
    locomotionInputBridge = systemManager.findSystem<LocomotionSystem>().also {
      it.enableLocomotion(false)
      check(it.locomoteState == LocomoteState.Disabled) {
        "Spatial locomotion did not enter Disabled state"
      }
      check(!it.areControllersInUse()) {
        "Disabled Spatial locomotion still claims controller input"
      }
    }
    isdkSystem = runCatching { systemManager.findSystem<IsdkSystem>() }.getOrNull()?.also {
      it.registerObserver(spatialPointerObserver)
      Log.i(ExperimentRuntime.READINESS_TAG, "isdk_pointer_observer registered=true")
    }
    registerDiagnosticReceiverIfDebuggable()
    player = SpatialVideoPlayer(this, ::onPlayerState, ::onPlayerMarker)
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "controller_owner activity=affect_tracker input_system=interaction_sdk " +
            "locomotion_registered=true locomotion_enabled=false locomotion_state=Disabled " +
            "locomotion_claims_controllers=false input_bridge=retained polling_phase=late_feature",
    )
    Log.i(ExperimentRuntime.READINESS_TAG, "immersive_created")
  }

  override fun registerPanels(): List<PanelRegistration> = buildList {
    add(controlPanelRegistration())
    add(flubberPanelRegistration())
    addAll(videoCoordinator.registrations())
  }

  override fun onSceneReady() {
    super.onSceneReady()
    sceneReady = true
    scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
    scene.enablePassthrough(false)
    scene.setViewOrigin(0f, 0f, 2f, 180f)
    scene.spatialInterface.enableInput(true)
    ensureGameControllerPins()
    controlEntity = Entity.createPanelEntity(
        R.id.control_panel,
        Transform(viewerRelativePose(1.35f, 0f, 0f)),
        PanelDimensions(Vector2(0.72f, 0.58f)),
        Grabbable(enabled = true, type = GrabbableType.PIVOT_Y, minHeight = 0.25f, maxHeight = 2.5f),
        Visible(true),
    )
    Log.i(ExperimentRuntime.READINESS_TAG, "scene_ready")
    val armed = runtime.armedSession
    val expected = intent.getStringExtra(EXTRA_FINGERPRINT)
    if (armed == null || armed.fingerprint != expected) {
      status = "Experiment was not armed"
      details = "Return to the launcher and press Start after the session reports Ready."
      Log.e(ExperimentRuntime.READINESS_TAG, "fatal armed_session_missing")
      return
    }
    stage(armed)
  }

  override fun onSceneTick() {
    super.onSceneTick()
    val now = System.nanoTime()
    val dt = if (lastTickNanos == 0L) 0f else ((now - lastTickNanos) / 1_000_000_000.0).toFloat().coerceAtMost(0.05f)
    lastTickNanos = now
    val localEngine = engine ?: return
    ensureGameControllerPins()
    applyControllerStick(localEngine, now)
    val snapshot = localEngine.tick(dt)
    val session = staged?.session ?: return
    if (!localEngine.isPaused()) phase += dt * session.affect.visual.animationSpeed
    if (session.affect.overlay.visible) geometry?.let { shape ->
      shape.update(snapshot, phase, session.affect.visual)
      flubberView?.render(
          shape,
          PaletteColor.resolve(snapshot.currentX, snapshot.currentY, session.affect.palette),
          session.affect.overlay.opacity.toFloat(),
          true,
          snapshot.currentX,
          snapshot.currentY,
      )
    }
    if (lslSamplingActive && lsl.status == "running") {
      lslAccumulator += dt
      val interval = 1f / session.affect.lsl.sampleRate
      if (lslAccumulator >= interval) {
        lslAccumulator %= interval
        if (!lsl.push(snapshot)) status = "LSL sample delivery failed"
      }
    }
    updateGrabState()
  }

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
    // VrActivity owns an explicit game-controller registry/pinning API. Let it deliver registered
    // devices to the pinned callback; retain direct dispatch only as a compatibility fallback.
    if (event.deviceId in VrActivityGameControllerAccess.ids(this)) return super.dispatchGenericMotionEvent(event)
    if (acceptGameControllerMotion(event, "activity_dispatch")) return true
    return super.dispatchGenericMotionEvent(event)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.deviceId in VrActivityGameControllerAccess.ids(this)) return super.dispatchKeyEvent(event)
    return acceptGameControllerKey(event) || super.dispatchKeyEvent(event)
  }

  private fun acceptGameControllerKey(event: KeyEvent): Boolean {
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0) return false
    val token = when (event.keyCode) {
      KeyEvent.KEYCODE_BUTTON_X -> "x"
      KeyEvent.KEYCODE_BUTTON_Y -> "y"
      KeyEvent.KEYCODE_BUTTON_A -> "a"
      KeyEvent.KEYCODE_BUTTON_B -> "b"
      else -> return false
    }
    val controls = staged?.session?.controls ?: return false
    if (token == controls.resetButton) { engine?.reset(); lsl.marker("input:controller:reset"); return true }
    if (token == controls.pauseButton && sessionActive) { togglePause(); return true }
    return false
  }

  override fun onDestroy() {
    scope.coroutineContext[Job]?.cancel()
    pinnedGameControllerIds.forEach(::unpinGameController)
    pinnedGameControllerIds.clear()
    isdkSystem?.unregisterObserver(spatialPointerObserver)
    isdkSystem = null
    if (diagnosticReceiverRegistered) {
      unregisterReceiver(diagnosticReceiver)
      diagnosticReceiverRegistered = false
    }
    if (lslSamplingActive) runtime.finish("app_destroyed")
    player.release()
    videoCoordinator.detachForRuntimeTeardown()
    // AppSystemActivity owns its scene and destroys these entities with the native DataModel.
    // Only forget handles here: explicit destruction can race the Spatial runtime shutdown.
    flubberEntity = null
    controlEntity = null
    super.onDestroy()
  }

  private fun stage(next: StagedSession) {
    if (staged?.fingerprint == next.fingerprint) return
    staged = next
    engine = AffectEngine(next.session.affect)
    geometry = FlubberGeometry(next.session.sessionId)
    status = "Preparing ${next.session.video.file}"
    details = "LSL is running. Waiting for the video decoder…"
    lslSamplingActive = true
    if (sceneReady) {
      val viewer = scene.getViewerPose()
      videoCoordinator.present(next, viewer)
      placeFlubber(next, viewer, create = true)
      configureControllerModels(next)
    }
  }

  private fun placeFlubber(next: StagedSession, viewer: Pose, create: Boolean): Pose {
    val pose = SpatialPlacement.flubberPose(viewer, next.session.flubber)
    if (create || flubberEntity == null) {
      val width = next.session.flubber.widthMeters
      flubberEntity?.destroy()
      flubberEntity = Entity.create(
          Panel(R.id.flubber_panel),
          PanelDimensions(Vector2(width, width)),
          Transform(pose),
          Visible(next.session.affect.overlay.visible),
          Grabbable(enabled = true, type = GrabbableType.PIVOT_Y, minHeight = 0.25f, maxHeight = 2.5f),
          Hittable(),
          // The SDK default is an edge-only grab region. These four overlapping edge widths
          // deliberately cover the complete transparent panel, including its empty corners.
          IsdkPanelGrabHandle(grabHandleCollisionWidths = Vector4(width, width, width, width)),
      )
      lastGrabbed = false
      grabStartPosition = null
      grabMoveLogged = false
      lsl.marker("flubber:visible")
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_entity_visible session=${next.session.sessionId}")
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_full_surface_grab width_m=$width")
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "joystick_route active=${next.session.affect.overlay.visible} stick=${next.session.controls.stick.token} " +
              "sources=spatial_standard_system,spatial_isdk_scroll,spatial_vractivity_game_controller " +
              "hand_precedence=attachment_avatar_fallback android_fallback=true",
      )
    } else {
      flubberEntity?.setComponent(Transform(pose))
    }
    return pose
  }

  private fun maybeBeginCountdown() {
    val next = staged ?: return
    if (countdownStarted || !playerReady || lsl.status != "running" || !sceneReady) return
    countdownStarted = true
    Log.i(ExperimentRuntime.READINESS_TAG, "decoder_ready session=${next.session.sessionId}")
    scope.launch {
      val viewer = scene.getViewerPose()
      val videoPose = videoCoordinator.recenter(viewer)
      val flubberPose = placeFlubber(next, viewer, create = false)
      controlEntity?.setComponent(Transform(viewerRelativePose(1.35f, 0f, 0f)))
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "spatial_lock projection=${next.session.video.projection.token} " +
              "video_distance=${SpatialPlacement.distance(viewer.t, videoPose.t)} " +
              "flubber_distance=${SpatialPlacement.distance(viewer.t, flubberPose.t)} " +
              "viewer=${viewer.t.x},${viewer.t.y},${viewer.t.z} " +
              "video=${videoPose.t.x},${videoPose.t.y},${videoPose.t.z} " +
              "flubber=${flubberPose.t.x},${flubberPose.t.y},${flubberPose.t.z}",
      )
      delay(150)
      for (value in 3 downTo 1) {
        status = value.toString()
        details = "Video begins in $value"
        lsl.marker("countdown:$value")
        Log.i(ExperimentRuntime.READINESS_TAG, "countdown:$value")
        delay(1_000)
      }
      sessionActive = true
      lsl.marker("system:session_started:${next.session.sessionId}")
      lsl.marker("video:start_requested:${next.session.video.file}")
      Log.i(ExperimentRuntime.READINESS_TAG, "video_play_requested file=${next.session.video.file}")
      controlEntity?.setComponent(Visible(false))
      player.play()
      status = "Session running"
      details = next.session.video.file
    }
  }

  private fun togglePause() {
    val paused = engine?.togglePause() ?: return
    if (paused) player.pause() else player.play()
    lsl.marker(if (paused) "system:paused" else "system:resumed")
    status = if (paused) "Session paused" else "Session running"
  }

  private fun onPlayerState(next: VideoPlaybackState) = runOnUiThread {
    playerReady = next.ready
    if (!sessionActive && next.ready) {
      status = "Flubber ready"
      details = "The countdown is starting."
      maybeBeginCountdown()
    }
    if (next.token == "ended" && sessionActive) {
      sessionActive = false
      lsl.marker("video:stop:ended")
      status = "Session complete"
      details = "Returning to the launcher…"
      Log.i(ExperimentRuntime.READINESS_TAG, "session_completed reason=video_ended")
      lslSamplingActive = false
      runtime.finish("video_ended")
      scope.launch { delay(1_200); finish() }
    }
  }

  private fun onPlayerMarker(marker: String) {
    lsl.marker(marker)
    if (marker == "video:first_frame") Log.i(ExperimentRuntime.READINESS_TAG, "first_video_frame")
    if (marker.startsWith("video:error:")) runOnUiThread {
      if (sessionActive) {
        sessionActive = false
        lsl.marker("video:stop:error")
      }
      playerReady = false
      status = "Video playback error"
      details = marker
      Log.e(ExperimentRuntime.READINESS_TAG, "fatal $marker")
      lslSamplingActive = false
      runtime.finish("video_error")
      scope.launch { delay(2_500); finish() }
    }
  }

  override fun onPause() {
    if (sessionActive && engine?.isPaused() == false) {
      engine?.togglePause()
      player.pause()
      pausedForFocus = true
      lsl.marker("system:paused:focus_loss")
    }
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    if (sessionActive && pausedForFocus) {
      pausedForFocus = false
      engine?.togglePause()
      player.play()
      lsl.marker("system:resumed:focus_gain")
    }
  }

  private fun controlPanelRegistration(): PanelRegistration = ComposeViewPanelRegistration(
      R.id.control_panel,
      composeViewCreator = { _, context -> ComposeView(context).apply { setContent { ControlPanel() } } },
      settingsCreator = {
        UIPanelSettings(
            shape = QuadShapeOptions(width = 0.72f, height = 0.58f),
            style = PanelStyleOptions(themeResourceId = R.style.AffectTrackerVrTheme),
            display = DpPerMeterDisplayOptions(dpPerMeter = 1000f),
            rendering = UIPanelRenderOptions(PanelRenderMode.Layer()),
            input = PanelInputOptions(ButtonBits.ButtonTriggerL or ButtonBits.ButtonTriggerR),
        )
      },
  )

  private fun flubberPanelRegistration(): PanelRegistration = ComposeViewPanelRegistration(
      R.id.flubber_panel,
      composeViewCreator = { _, context -> ComposeView(context).apply {
        setBackgroundColor(AndroidColor.TRANSPARENT)
        alpha = 1f
        setLayerType(View.LAYER_TYPE_HARDWARE, null)
        setContent {
          AndroidView(
              modifier = Modifier.fillMaxSize(),
              factory = { FlubberView(it, ::onFlubberShapeDrawn).also { view -> flubberView = view } },
          )
        }
      } },
      settingsCreator = {
        val width = staged?.session?.flubber?.widthMeters ?: 0.3f
        UIPanelSettings(
            shape = QuadShapeOptions(width = width, height = width),
            style = PanelStyleOptions(themeResourceId = R.style.TransparentSpatialPanelTheme),
            display = DpPerMeterDisplayOptions(dpPerMeter = 1200f),
            rendering = UIPanelRenderOptions(
                PanelRenderMode.Layer(layerBlendType = PanelShapeLayerBlendType.ALPHA_BLEND),
            ),
            input = PanelInputOptions(ButtonBits.ButtonTriggerL or ButtonBits.ButtonTriggerR),
        )
      },
  )

  @androidx.compose.runtime.Composable
  private fun ControlPanel() {
    MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF78D7FF))) {
      Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF101318)) {
        Column(modifier = Modifier.fillMaxSize().background(Color(0xFF101318)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
          Text("Affect Tracker VR", style = MaterialTheme.typography.headlineSmall)
          Text(status, style = MaterialTheme.typography.titleMedium)
          Text(details, style = MaterialTheme.typography.bodyMedium, color = Color(0xFFB8C2CE))
          Text(controllerInputStatus, style = MaterialTheme.typography.labelLarge, color = Color(0xFFFFD166))
          Text("LSL: ${lsl.status}", style = MaterialTheme.typography.labelLarge, color = Color(0xFF78D7FF))
        }
      }
    }
  }

  private fun viewerRelativePose(distance: Float, x: Float, y: Float): Pose {
    val viewer = runCatching { scene.getViewerPose() }.getOrElse { return Pose(Vector3(x, 1.35f + y, -distance), Quaternion(0f, 1f, 0f, 0f)) }
    val forward = SpatialPlacement.uprightForward(viewer)
    return Pose(viewer.t + forward * distance + Vector3(x, y, 0f), Quaternion.lookRotationAroundY(forward))
  }

  private fun faceAndClampFlubberToViewer() {
    val entity = flubberEntity ?: return
    val transform = entity.tryGetComponent<Transform>()?.transform ?: return
    val viewer = runCatching { scene.getViewerPose() }.getOrNull() ?: return
    val delta = transform.t - viewer.t
    val distance = kotlin.math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z)
    val direction = if (distance > 0.001f) delta * (1f / distance) else viewer.forward()
    entity.setComponent(Transform(Pose(viewer.t + direction * distance.coerceIn(0.35f, 5f), Quaternion.lookRotationAroundY(direction))))
  }

  private fun emitDirectionMarker(x: Float, y: Float) {
    val magnitude = kotlin.math.hypot(x, y)
    val horizontal = if (magnitude <= AffectEngine.DEAD_ZONE || abs(x) < 0.05f) "neutral" else if (x > 0f) "right" else "left"
    val vertical = if (magnitude <= AffectEngine.DEAD_ZONE || abs(y) < 0.05f) "neutral" else if (y > 0f) "up" else "down"
    lastHorizontalDirection = emitDirectionEdge(lastHorizontalDirection, horizontal)
    lastVerticalDirection = emitDirectionEdge(lastVerticalDirection, vertical)
  }

  private fun emitDirectionEdge(previous: String, next: String): String {
    if (previous == next) return previous
    if (previous != "neutral") lsl.marker("controller:$previous:released")
    if (next != "neutral") {
      lsl.marker("controller:$next:pressed")
      Log.i(ExperimentRuntime.READINESS_TAG, "joystick_input direction=$next")
    }
    return next
  }

  private fun configureControllerModels(next: StagedSession) {
    val visible = next.session.controls.showControllerModels
    systemManager.findSystem<AvatarSystem>().apply {
      setShowHands(false)
      setShowControllers(visible)
    }
    Log.i(ExperimentRuntime.READINESS_TAG, "controller_models visible=$visible")
  }

  private fun onSpatialControllerFrame(frame: TouchControllerFrame) {
    val controls = staged?.session?.controls ?: return
    val inventory = "entities=${frame.controllerEntities} active=${frame.activeControllerEntities} " +
        "controller_type=${frame.controllerTypeEntities} hand_type=${frame.handTypeEntities} " +
        "left_source=${frame.leftSource} right_source=${frame.rightSource}"
    if (inventory != lastControllerInventory) {
      lastControllerInventory = inventory
      Log.i(ExperimentRuntime.READINESS_TAG, "controller_inventory $inventory")
    }
    if (frame.buttonState != lastControllerButtonState) {
      lastControllerButtonState = frame.buttonState
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "controller_button_state merged=0x${frame.buttonState.toUInt().toString(16)} " +
              "left=0x${frame.leftButtonState.toUInt().toString(16)} " +
              "right=0x${frame.rightButtonState.toUInt().toString(16)} " +
              "attachment=0x${frame.attachmentState.toUInt().toString(16)} " +
              "avatar=0x${frame.avatarState.toUInt().toString(16)} " +
              "all=0x${frame.allEntityState.toUInt().toString(16)} " +
              "direct_touch=0x${frame.directTouchState.toUInt().toString(16)}",
      )
    }
    spatialStickX = TouchControllerInput.stickX(frame, controls.stick)
    spatialStickY = TouchControllerInput.stickY(frame, controls.stick)
    updateControllerStatus(
        controls.stick.token.replaceFirstChar { it.uppercase() },
        frameSource(frame, controls.stick),
        spatialStickX,
        -spatialStickY,
    )
    if (TouchControllerInput.pressed(frame.buttonState, frame.changedButtons, buttonBit(controls.resetButton))) {
      engine?.reset()
      lsl.marker("input:controller:reset")
    }
    if (sessionActive && TouchControllerInput.pressed(frame.buttonState, frame.changedButtons, buttonBit(controls.pauseButton))) togglePause()
  }

  private fun pollSpatialControllers() {
    // Reassert the invariant if a future lifecycle/system change re-enables locomotion. This late
    // poll runs after the bridge has performed its normal per-frame controller handoff/reset.
    if (locomotionInputBridge.locomoteState != LocomoteState.Disabled) {
      locomotionInputBridge.enableLocomotion(false)
      Log.w(ExperimentRuntime.READINESS_TAG, "locomotion_reasserted state=Disabled")
    }
    onSpatialControllerFrame(TouchControllerAdapter.capture(scene))
  }

  private fun frameSource(frame: TouchControllerFrame, hand: StickHand): String =
      if (hand == StickHand.LEFT) frame.leftSource else frame.rightSource

  private fun axisLabel(value: Float): String = when {
    value > 0.5f -> "+1"
    value < -0.5f -> "-1"
    else -> "0"
  }

  private fun updateControllerStatus(label: String, source: String, x: Float, y: Float) {
    if (label == lastControllerStatusLabel && source == lastControllerStatusSource &&
        x == lastControllerStatusX && y == lastControllerStatusY) return
    lastControllerStatusLabel = label
    lastControllerStatusSource = source
    lastControllerStatusX = x
    lastControllerStatusY = y
    controllerInputStatus = "$label Touch: $source • stick ${axisLabel(x)}, ${axisLabel(y)}"
  }

  /**
   * Spatial SDK 0.13.x publishes thumb direction in Controller.buttonState when available. On
   * runtime/controller combinations that reserve the stick for pointer scrolling, ISDK instead
   * delivers the physical stick delta through PointerEvent.scrollInfo. Both routes feed the same
   * activity-owned AffectEngine; this is not an Android View or second-app input path.
   */
  private val spatialPointerObserver: (PointerEvent) -> Unit = { event ->
    val x = event.scrollInfo.x
    val y = event.scrollInfo.y
    if (x.isFinite() && y.isFinite() &&
        (abs(x) > TouchControllerInput.SCROLL_EPSILON || abs(y) > TouchControllerInput.SCROLL_EPSILON)) {
      val selected = staged?.session?.controls?.stick
      val eventHand = runCatching { isdkSystem?.getHandForPointerEvent(event) }.getOrNull()
      val handMatches = selected == null || eventHand == null ||
          (selected == StickHand.LEFT && eventHand == com.meta.spatial.core.Hand.LEFT) ||
          (selected == StickHand.RIGHT && eventHand == com.meta.spatial.core.Hand.RIGHT)
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "isdk_scroll_input event=${event.eventId} hand=${eventHand?.name ?: "unknown"} " +
              "selected=${selected?.token ?: "unstaged"} accepted=$handMatches raw_x=$x raw_y=$y " +
              "semantic=${event.semanticType} type=${event.type}",
      )
      if (handMatches) {
        val normalized = TouchControllerInput.normalizeScroll(x, y)
        spatialScrollStickX = normalized.x
        spatialScrollStickY = normalized.y
        spatialScrollEventId = event.eventId
        spatialScrollExpiresNanos = System.nanoTime() + ISDK_SCROLL_FRESH_NANOS
        updateControllerStatus(
            selected?.token?.replaceFirstChar { it.uppercase() } ?: "Selected",
            "spatial_isdk_scroll",
            normalized.x,
            -normalized.y,
        )
      }
    }
  }

  private fun applyControllerStick(activeEngine: AffectEngine, now: Long) {
    if (!isFlubberInputActive()) {
      activeEngine.setStick(0f, 0f)
      return
    }
    val spatialActive = spatialStickX != 0f || spatialStickY != 0f
    val spatialScrollActive = now <= spatialScrollExpiresNanos &&
        (spatialScrollStickX != 0f || spatialScrollStickY != 0f)
    val diagnosticActive = isDebuggable() && now <= diagnosticStickExpiresNanos
    val androidFresh = now - androidStickUpdatedNanos <= ANDROID_STICK_FRESH_NANOS
    val route: String
    val x: Float
    val y: Float
    if (spatialActive) {
      route = "spatial_standard_system"
      x = spatialStickX
      y = spatialStickY
    } else if (spatialScrollActive) {
      route = "spatial_isdk_scroll"
      x = spatialScrollStickX
      y = spatialScrollStickY
    } else if (diagnosticActive) {
      route = "diagnostic_cli"
      x = diagnosticStickX
      y = diagnosticStickY
    } else if (androidFresh) {
      route = androidStickRoute
      x = androidStickX
      y = androidStickY
    } else {
      route = "neutral"
      x = 0f
      y = 0f
    }
    if (route != lastStickRoute) {
      lastStickRoute = route
      Log.i(ExperimentRuntime.READINESS_TAG, "joystick_source route=$route")
      if (route != "neutral") armFlubberDrawReceipt(route)
    }
    activeEngine.setStick(x, y)
    emitDirectionMarker(x, -y)
  }

  private fun armFlubberDrawReceipt(route: String) {
    val snapshot = engine?.snapshot() ?: return
    pendingDrawReceiptRoute = route
    pendingDrawReceiptId = when (route) {
      "diagnostic_cli" -> diagnosticCommandId
      "spatial_isdk_scroll" -> "physical-event-$spatialScrollEventId"
      else -> "physical"
    }
    pendingDrawBaselineX = snapshot.currentX
    pendingDrawBaselineY = snapshot.currentY
  }

  private fun isFlubberInputActive(): Boolean =
      engine != null && flubberEntity != null && staged?.session?.affect?.overlay?.visible == true

  private fun buttonBit(token: String): Int = when (token) {
    "x" -> ButtonBits.ButtonX
    "y" -> ButtonBits.ButtonY
    "a" -> ButtonBits.ButtonA
    "b" -> ButtonBits.ButtonB
    else -> 0
  }

  private fun onFlubberShapeDrawn(valence: Float, arousal: Float) {
    if (!firstFlubberDrawLogged) {
      firstFlubberDrawLogged = true
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_first_draw alpha_blend=true")
    }
    if (!reactiveFlubberDrawLogged && (abs(valence) > 0.02f || abs(arousal) > 0.02f)) {
      reactiveFlubberDrawLogged = true
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_reactive valence=$valence arousal=$arousal")
    }
    val receiptRoute = pendingDrawReceiptRoute
    if (receiptRoute != null &&
        (abs(valence - pendingDrawBaselineX) > 0.005f || abs(arousal - pendingDrawBaselineY) > 0.005f)) {
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "flubber_input_response route=$receiptRoute id=$pendingDrawReceiptId " +
              "current_valence=$valence current_arousal=$arousal " +
              "target_valence=${engine?.snapshot()?.targetX} target_arousal=${engine?.snapshot()?.targetY}",
      )
      pendingDrawReceiptRoute = null
    }
  }

  private val diagnosticReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (!isDebuggable() || intent?.action != ACTION_DEBUG_JOYSTICK) return
      val x = intent.getFloatExtra(EXTRA_DEBUG_X, Float.NaN)
      val y = intent.getFloatExtra(EXTRA_DEBUG_Y, Float.NaN)
      val durationMs = intent.getIntExtra(EXTRA_DEBUG_DURATION_MS, 0)
      val id = intent.getStringExtra(EXTRA_DEBUG_ID).orEmpty()
      if (!x.isFinite() || !y.isFinite() || x !in -1f..1f || y !in -1f..1f ||
          durationMs !in 50..5_000 || !id.matches(Regex("[A-Za-z0-9._-]{1,64}"))) {
        Log.w(ExperimentRuntime.READINESS_TAG, "diagnostic_joystick_rejected")
        return
      }
      diagnosticStickX = x
      diagnosticStickY = y
      diagnosticCommandId = id
      diagnosticStickExpiresNanos = System.nanoTime() + durationMs * 1_000_000L
      Log.i(
          ExperimentRuntime.READINESS_TAG,
          "diagnostic_joystick_received id=$id x=$x y=$y duration_ms=$durationMs",
      )
    }
  }

  private fun registerDiagnosticReceiverIfDebuggable() {
    if (!isDebuggable()) return
    registerReceiver(
        diagnosticReceiver,
        IntentFilter(ACTION_DEBUG_JOYSTICK),
        android.Manifest.permission.DUMP,
        null,
        Context.RECEIVER_EXPORTED,
    )
    diagnosticReceiverRegistered = true
    Log.i(ExperimentRuntime.READINESS_TAG, "diagnostic_joystick_receiver enabled=true permission=android.permission.DUMP")
  }

  private fun isDebuggable(): Boolean =
      applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

  private fun updateGrabState() {
    val entity = flubberEntity ?: return
    val grabbed = entity.tryGetComponent<Grabbable>()?.isGrabbed == true ||
        entity.tryGetComponent<IsdkGrabbable>()?.grabState == IsdkGrabState.Grabbed
    if (grabbed) faceAndClampFlubberToViewer()
    if (grabbed && !grabMoveLogged) {
      val start = grabStartPosition
      val current = entity.tryGetComponent<Transform>()?.transform?.t
      if (start != null && current != null && SpatialPlacement.distance(start, current) >= 0.02f) {
        grabMoveLogged = true
        Log.i(ExperimentRuntime.READINESS_TAG, "flubber_grab_moved")
      }
    }
    if (grabbed == lastGrabbed) return
    lastGrabbed = grabbed
    if (grabbed) {
      grabStartPosition = entity.tryGetComponent<Transform>()?.transform?.t
      grabMoveLogged = false
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_grab_started full_surface=true")
    } else {
      grabStartPosition = null
      Log.i(ExperimentRuntime.READINESS_TAG, "flubber_grab_ended moved=$grabMoveLogged")
    }
    lsl.marker(if (grabbed) "flubber:grab_started" else "flubber:grab_ended")
  }

  private fun axis(event: MotionEvent, primary: Int, fallback: Int): Float = event.getAxisValue(primary).takeIf { abs(it) > 0.001f } ?: event.getAxisValue(fallback)

  private fun ensureGameControllerPins() {
    val now = System.nanoTime()
    if (now < nextGameControllerScanNanos) return
    nextGameControllerScanNanos = now + GAME_CONTROLLER_SCAN_NANOS
    VrActivityGameControllerAccess.refreshIds(this).forEach { deviceId ->
      if (pinnedGameControllerIds.add(deviceId)) {
        pinGameController(deviceId) { motionEvent, keyEvent ->
          if (motionEvent != null) acceptGameControllerMotion(motionEvent, "vractivity_pinned")
          if (keyEvent != null) acceptGameControllerKey(keyEvent)
        }
        Log.i(
            ExperimentRuntime.READINESS_TAG,
            "spatial_game_controller_pinned count=${pinnedGameControllerIds.size}",
        )
      }
    }
  }

  private fun acceptGameControllerMotion(event: MotionEvent, sourceRoute: String): Boolean {
    if (!isFlubberInputActive() || event.action != MotionEvent.ACTION_MOVE ||
        (!event.isFromSource(InputDevice.SOURCE_JOYSTICK) &&
            !event.isFromSource(InputDevice.SOURCE_GAMEPAD))) return false
    val controls = staged?.session?.controls ?: return false
    val x = if (controls.stick == StickHand.LEFT) {
      event.getAxisValue(MotionEvent.AXIS_X)
    } else {
      axis(event, MotionEvent.AXIS_RX, MotionEvent.AXIS_Z)
    }
    val y = if (controls.stick == StickHand.LEFT) {
      event.getAxisValue(MotionEvent.AXIS_Y)
    } else {
      axis(event, MotionEvent.AXIS_RY, MotionEvent.AXIS_RZ)
    }
    androidStickX = x
    androidStickY = y
    androidStickRoute = "spatial_vractivity_game_controller"
    androidStickUpdatedNanos = System.nanoTime()
    updateControllerStatus(
        controls.stick.token.replaceFirstChar { it.uppercase() },
        "spatial_vractivity_game_controller",
        x,
        -y,
    )
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "spatial_game_controller_motion route=$sourceRoute selected=${controls.stick.token} x=$x y=$y",
    )
    return true
  }

  companion object {
    const val EXTRA_FINGERPRINT = "session_fingerprint"
    private const val ANDROID_STICK_FRESH_NANOS = 250_000_000L
    private const val GAME_CONTROLLER_SCAN_NANOS = 1_000_000_000L
    private const val ISDK_SCROLL_FRESH_NANOS = 250_000_000L
    private const val ACTION_DEBUG_JOYSTICK = "io.github.georgefejer91.affecttracker.vr.DEBUG_JOYSTICK"
    private const val EXTRA_DEBUG_X = "x"
    private const val EXTRA_DEBUG_Y = "y"
    private const val EXTRA_DEBUG_DURATION_MS = "duration_ms"
    private const val EXTRA_DEBUG_ID = "id"
  }
}
