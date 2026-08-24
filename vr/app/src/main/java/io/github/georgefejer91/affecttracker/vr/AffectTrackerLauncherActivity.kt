package io.github.georgefejer91.affecttracker.vr

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class LauncherPresentation(
    val title: String,
    val detail: String,
    val ready: Boolean = false,
    val selectedFingerprint: String? = null,
    val choices: List<LauncherChoice> = emptyList(),
    val issues: List<SessionIssue> = emptyList(),
) {
  companion object {
    fun from(result: LoadResult, selectedFingerprint: String? = null): LauncherPresentation = when (result) {
      LoadResult.NoFolder -> LauncherPresentation(
          "Authorize the session folder",
          "Connect the headset to a PC, copy files to Documents/AffectTrackerVR, then choose that folder here.",
      )
      LoadResult.NoManifest -> LauncherPresentation(
          "Waiting for active-session.json",
          "Copy the video to Documents/AffectTrackerVR/media first, then copy active-session.json last.",
      )
      LoadResult.CopyInProgress -> LauncherPresentation(
          "Checking copied video",
          "Waiting for the file size to settle before validating its SHA-256 and decoder metadata.",
      )
      is LoadResult.Rejected -> LauncherPresentation(result.code, result.detail)
      is LoadResult.Ready -> {
        val staged = result.choices.firstOrNull { it.fingerprint == selectedFingerprint } ?: result.staged
        LauncherPresentation(
            "Ready to start",
            choiceDetail(staged, formatDuration(staged.durationMs)),
            ready = true,
            selectedFingerprint = staged.fingerprint,
            choices = result.choices.map { LauncherChoice.from(it, it.fingerprint == staged.fingerprint) },
            issues = result.issues,
        )
      }
    }

    private fun formatDuration(durationMs: Long): String {
      val seconds = durationMs / 1_000
      return "%d:%02d".format(seconds / 60, seconds % 60)
    }

    internal fun choiceDetail(staged: StagedSession, duration: String): String {
      val flubberPlacement = if (staged.session.flubber.controllerFollow.enabled) {
        "Flubber follows ${staged.session.flubber.controllerFollow.hand.token} Touch"
      } else {
        "world-anchored Flubber"
      }
      val layout = when (staged.choiceSource) {
        VideoChoiceSource.ACTIVE_MANIFEST -> "active layout"
        VideoChoiceSource.OPTIONAL_MANIFEST -> "declared layout"
        VideoChoiceSource.ACTIVE_LAYOUT_DEFAULTS -> "active default layout"
      }
      return listOf(
          staged.session.video.projection.token,
          staged.session.video.stereo.token,
          duration,
          staged.session.environment.token,
          flubberPlacement,
          layout,
      ).joinToString(" · ")
    }
  }
}

data class LauncherChoice(
    val fingerprint: String,
    val videoFile: String,
    val detail: String,
    val selected: Boolean,
) {
  companion object {
    fun from(staged: StagedSession, selected: Boolean) = LauncherChoice(
        staged.fingerprint,
        staged.session.video.file,
        LauncherPresentation.choiceDetail(staged, "${staged.durationMs / 1_000}s"),
        selected,
    )
  }
}

class AffectTrackerLauncherActivity : ComponentActivity() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val runtime get() = (application as AffectTrackerVrApplication).runtime
  private var polling: Job? = null
  private var initialValidation: Job? = null
  private var staged: StagedSession? = null
  private var choices: List<StagedSession> = emptyList()
  private var selectedFingerprint: String? = null
  private var runtimeSettingsFingerprint: String? = null
  private var lastCatalogReceipt: String? = null
  private var starting by mutableStateOf(false)
  private var showAffectValues by mutableStateOf(false)
  private var mixedRealityEnabled by mutableStateOf(false)
  private var flubberOnlyPassthrough by mutableStateOf(false)
  private var controllerFollowEnabled by mutableStateOf(false)
  private var controllerFollowHand by mutableStateOf(StickHand.LEFT)
  private var followedControllerVisible by mutableStateOf(true)
  private var presentation by mutableStateOf(LauncherPresentation.from(LoadResult.NoFolder))
  private val polarPermissionRequest = registerForActivityResult(
      ActivityResultContracts.RequestMultiplePermissions(),
  ) { runtime.polar.onPermissionsChanged() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      val polarState by runtime.polar.state.collectAsState()
      LauncherScreen(
          presentation,
          starting,
          showAffectValues,
          mixedRealityEnabled,
          flubberOnlyPassthrough,
          controllerFollowEnabled,
          controllerFollowHand,
          followedControllerVisible,
          polarState,
          ::chooseFolder,
          ::selectSession,
          { showAffectValues = it },
          { mixedRealityEnabled = it },
          {
            flubberOnlyPassthrough = it
            if (it) mixedRealityEnabled = true
          },
          { controllerFollowEnabled = it },
          { controllerFollowHand = it },
          { followedControllerVisible = it },
          ::connectPolar,
          { runtime.polar.disconnect() },
          { runtime.polar.restartDiscovery() },
          { axis, metricId -> runtime.polar.toggleMetric(axis, metricId) },
          { axis, minimum, maximum, invert ->
            runtime.polar.updateMapping(axis, minimum, maximum, invert)
          },
          ::openWebXrStudy,
          ::startExperiment,
      )
    }
    Log.i(ExperimentRuntime.READINESS_TAG, "launcher_rendered")
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "launcher_controls_rendered mixed_reality=true flubber_only_passthrough=true " +
            "controller_follow=true follow_hand_selector=true followed_controller_visibility=true webxr_link=true",
    )
    // Three bounded passes settle the active file, then optional/automatic media, even when
    // Horizon creates this launcher but has not yet projected it as resumed.
    initialValidation = scope.launch {
      repeat(INITIAL_VALIDATION_PASSES) { index ->
        scanAndPresent()
        if (index + 1 < INITIAL_VALIDATION_PASSES) delay(2_000)
      }
    }
  }

  override fun onResume() {
    super.onResume()
    runtime.polar.onForeground()
    starting = false
    beginPolling()
  }

  override fun onPause() {
    polling?.cancel()
    super.onPause()
  }

  override fun onDestroy() {
    polling?.cancel()
    initialValidation?.cancel()
    scope.coroutineContext[Job]?.cancel()
    super.onDestroy()
  }

  private fun beginPolling() {
    polling?.cancel()
    polling = scope.launch {
      initialValidation?.join()
      while (isActive && !starting) {
        scanAndPresent()
        delay(2_000)
      }
    }
  }

  private suspend fun scanAndPresent() {
    val result = runCatching { runtime.loader.scan() }.getOrElse {
      LoadResult.Rejected("folder_unavailable", "Folder access was lost. Authorize Documents/AffectTrackerVR again.")
    }
    val ready = result as? LoadResult.Ready
    choices = ready?.choices.orEmpty()
    staged = ready?.choices?.firstOrNull { it.fingerprint == selectedFingerprint } ?: ready?.staged
    selectedFingerprint = staged?.fingerprint
    staged?.let {
      if (runtimeSettingsFingerprint != it.fingerprint) {
        applySessionRuntimeDefaults(it)
      }
    }
    presentation = LauncherPresentation.from(result, selectedFingerprint)
    ready?.let(::logCatalogIfChanged)
    staged?.let {
      Log.i(ExperimentRuntime.READINESS_TAG, "session_ready session=${it.session.sessionId} fingerprint=${it.fingerprint}")
    }
  }

  private fun logCatalogIfChanged(ready: LoadResult.Ready) {
    val videos = ready.choices.joinToString(",") {
      "${it.session.video.file.replace(Regex("\\s+"), "_")}:" +
          "${it.choiceSource.name.lowercase()}:${it.session.controls.stick.token}"
    }
    val issueCodes = ready.issues.joinToString(",") { it.code }
    val receipt = "choices=${ready.choices.size} videos=$videos issues=${ready.issues.size} codes=$issueCodes"
    if (receipt == lastCatalogReceipt) return
    lastCatalogReceipt = receipt
    Log.i(ExperimentRuntime.READINESS_TAG, "session_catalog $receipt")
  }

  private fun selectSession(fingerprint: String) {
    val next = choices.firstOrNull { it.fingerprint == fingerprint } ?: return
    staged = next
    selectedFingerprint = fingerprint
    applySessionRuntimeDefaults(next)
    presentation = presentation.copy(
        detail = LauncherPresentation.choiceDetail(next, "${next.durationMs / 1_000}s"),
        selectedFingerprint = fingerprint,
        choices = choices.map { LauncherChoice.from(it, it.fingerprint == fingerprint) },
    )
    Log.i(ExperimentRuntime.READINESS_TAG, "session_selected session=${next.session.sessionId}")
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "runtime_profile source=active-session.json video=${next.session.video.file} " +
            "layout_source=${next.choiceSource.name.lowercase()} stick=${next.session.controls.stick.token}",
    )
  }

  private fun applySessionRuntimeDefaults(next: StagedSession) {
    runtimeSettingsFingerprint = next.fingerprint
    showAffectValues = next.session.flubber.showAffectValues
    mixedRealityEnabled = next.session.environment == VrEnvironment.PASSTHROUGH
    flubberOnlyPassthrough = false
    controllerFollowEnabled = next.session.flubber.controllerFollow.enabled
    controllerFollowHand = next.session.flubber.controllerFollow.hand
    followedControllerVisible = next.session.controls.showControllerModels
  }

  private fun chooseFolder() {
    val proxyIntent = Intent(this, FolderPickerProxyActivity::class.java).apply {
      action = Intent.ACTION_MAIN
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val pendingProxyIntent = PendingIntent.getActivity(
        this,
        FOLDER_PROXY_REQUEST,
        proxyIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    startActivity(
        Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_HOME)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_LAUNCH_IN_HOME_PENDING_INTENT, pendingProxyIntent),
    )
    Log.i(ExperimentRuntime.READINESS_TAG, "folder_picker_requested_in_home")
  }

  private fun openWebXrStudy() {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(WEBXR_STUDY_URL)).apply {
      addCategory(Intent.CATEGORY_BROWSABLE)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    runCatching { startActivity(intent) }
        .onSuccess {
          Log.i(ExperimentRuntime.READINESS_TAG, "webxr_study_requested url=$WEBXR_STUDY_URL")
        }
        .onFailure {
          presentation = presentation.copy(
              title = "Meta Quest Browser unavailable",
              detail = "Open $WEBXR_STUDY_URL manually in the headset browser.",
          )
          Log.e(ExperimentRuntime.READINESS_TAG, "webxr_study_open_failed", it)
        }
  }

  private fun connectPolar() {
    runtime.polar.connect()
    if (!runtime.polar.permissionsGranted()) {
      polarPermissionRequest.launch(PolarH10Manager.requiredRuntimePermissions())
    }
  }

  private fun startExperiment() {
    val next = staged ?: return
    if (starting) return
    val polarState = runtime.polar.state.value
    if (polarState.mappings.anyAssigned && !polarState.readiness.ready) {
      presentation = presentation.copy(
          title = "Polar H10 not ready",
          detail = "This run maps Polar data to Flubber. Connect and wear the H10 until 130 Hz ECG is stable for three seconds.",
      )
      Log.w(
          ExperimentRuntime.READINESS_TAG,
          "start_blocked polar_required=true readiness=${polarState.readiness.reason}",
      )
      return
    }
    val effective = next.copy(
        session = next.session.withLauncherRuntimeOverrides(
            mixedRealityEnabled,
            flubberOnlyPassthrough,
            controllerFollowEnabled,
            controllerFollowHand,
            followedControllerVisible,
        ),
    )
    starting = true
    polling?.cancel()
    presentation = presentation.copy(title = "Starting LSL…", detail = "Opening the state and marker streams before the countdown.")
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "launcher_runtime_options environment=${effective.session.environment.token} " +
            "presentation=${effective.session.presentationMode.token} " +
            "controller_follow=${effective.session.flubber.controllerFollow.enabled} " +
            "follow_hand=${effective.session.flubber.controllerFollow.hand.token} " +
            "followed_controller_visible=${effective.session.flubber.controllerFollow.showControllerModel} " +
            "show_affect_values=$showAffectValues",
    )
    val queued = runtime.arm(effective) { ready ->
      if (!ready) {
        starting = false
        presentation = presentation.copy(title = "LSL unavailable", detail = "${runtime.lsl.status}. Experiment start was blocked.")
        return@arm
      }
      Log.i(ExperimentRuntime.READINESS_TAG, "immersive_requested session=${effective.session.sessionId}")
      startActivity(Intent(this, AffectTrackerVrActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(AffectTrackerVrActivity.EXTRA_FINGERPRINT, next.fingerprint)
        putExtra(AffectTrackerVrActivity.EXTRA_SHOW_AFFECT_VALUES, showAffectValues)
      })
    }
    if (!queued) {
      starting = false
      presentation = presentation.copy(title = "LSL unavailable", detail = "${runtime.lsl.status}. Experiment start was blocked.")
    }
  }

  companion object {
    private const val FOLDER_PROXY_REQUEST = 4103
    private const val INITIAL_VALIDATION_PASSES = 3
    internal const val WEBXR_STUDY_URL = "https://GeorgeFejer91.github.io/affect-tracker-web/webxr.html"
    const val EXTRA_LAUNCH_IN_HOME_PENDING_INTENT = "extra_launch_in_home_pending_intent"
  }
}

@Composable
private fun LauncherScreen(
    state: LauncherPresentation,
    starting: Boolean,
    showAffectValues: Boolean,
    mixedRealityEnabled: Boolean,
    flubberOnlyPassthrough: Boolean,
    controllerFollowEnabled: Boolean,
    controllerFollowHand: StickHand,
    followedControllerVisible: Boolean,
    polarState: PolarH10State,
    chooseFolder: () -> Unit,
    selectSession: (String) -> Unit,
    setShowAffectValues: (Boolean) -> Unit,
    setMixedRealityEnabled: (Boolean) -> Unit,
    setFlubberOnlyPassthrough: (Boolean) -> Unit,
    setControllerFollowEnabled: (Boolean) -> Unit,
    setControllerFollowHand: (StickHand) -> Unit,
    setFollowedControllerVisible: (Boolean) -> Unit,
    connectPolar: () -> Unit,
    disconnectPolar: () -> Unit,
    retryPolar: () -> Unit,
    togglePolarMetric: (PolarAffectAxis, String) -> Unit,
    updatePolarMapping: (PolarAffectAxis, Double, Double, Boolean) -> Boolean,
    openWebXrStudy: () -> Unit,
    startExperiment: () -> Unit,
) {
  MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF78D7FF), background = Color(0xFF080B10))) {
    Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF080B10)) {
      Column(
          modifier = Modifier.fillMaxSize().background(Color(0xFF080B10)).padding(32.dp),
          verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Text("Affect Tracker VR", style = MaterialTheme.typography.headlineMedium)
        Text("QUEST VIDEO EXPERIMENT", color = Color(0xFF78D7FF), style = MaterialTheme.typography.labelLarge)
        Button(onClick = openWebXrStudy, enabled = !starting, modifier = Modifier.fillMaxWidth()) {
          Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Open WebXR study")
            Text("Launch in Meta Quest Browser", style = MaterialTheme.typography.bodySmall)
          }
        }
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF131923)), modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(state.title, style = MaterialTheme.typography.titleLarge)
              Text(state.detail, color = Color(0xFFC4CEDA))
              if (state.choices.isNotEmpty()) {
                Text("Choose a validated video", color = Color(0xFF9DE5B3))
                Text(
                    "Environment, Flubber, controller, display, and LSL settings always come from active-session.json.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFAAB4C2),
                )
                state.choices.forEach { choice ->
                  Button(
                      onClick = { selectSession(choice.fingerprint) },
                      enabled = !starting,
                      modifier = Modifier.fillMaxWidth(),
                  ) {
                    Column(modifier = Modifier.fillMaxWidth()) {
                      Text("${if (choice.selected) "✓ " else ""}${choice.videoFile}")
                      Text(choice.detail, style = MaterialTheme.typography.bodySmall)
                    }
                  }
                }
                if (state.issues.isNotEmpty()) {
                  Text("${state.issues.size} optional session${if (state.issues.size == 1) "" else "s"} not ready", color = Color(0xFFFFC46B))
                  state.issues.take(3).forEach { issue -> Text("${issue.manifestName}: ${issue.code}", color = Color(0xFFAAB4C2)) }
                }
              }
            }
          }
          PolarStreamCard(
              polarState,
              starting,
              connectPolar,
              disconnectPolar,
              retryPolar,
              togglePolarMetric,
              updatePolarMapping,
          )
          Text(
              "PC folder: Documents/AffectTrackerVR — add videos to media/. Optional sessions/*.json files declare only per-video projection/stereo; videos without one use the active layout defaults.",
              color = Color(0xFFAAB4C2),
          )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text("Show X/Y affect coordinates")
            Text("Two current values, each from -1 to +1", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
          }
          Switch(
              checked = showAffectValues,
              onCheckedChange = setShowAffectValues,
              enabled = state.ready && !starting,
          )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text("Mixed reality passthrough")
            Text("Show video and Flubber over the normal see-through view", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
          }
          Switch(
              checked = mixedRealityEnabled,
              onCheckedChange = setMixedRealityEnabled,
              enabled = state.ready && !starting && !flubberOnlyPassthrough,
          )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text("Flubber-only passthrough")
            Text("Clear see-through view with Flubber only; no video is decoded or shown", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
          }
          Switch(
              checked = flubberOnlyPassthrough,
              onCheckedChange = setFlubberOnlyPassthrough,
              enabled = state.ready && !starting,
          )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text("Track Flubber near a controller")
            Text("Left is the default; Flubber faces the headset", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
          }
          Switch(
              checked = controllerFollowEnabled,
              onCheckedChange = setControllerFollowEnabled,
              enabled = state.ready && !starting,
          )
        }
        if (controllerFollowEnabled) {
          Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(12.dp),
              verticalAlignment = Alignment.CenterVertically,
          ) {
            Text("Controller to follow", modifier = Modifier.weight(1f))
            Button(
                onClick = { setControllerFollowHand(StickHand.LEFT) },
                enabled = state.ready && !starting,
            ) { Text(if (controllerFollowHand == StickHand.LEFT) "✓ Left" else "Left") }
            Button(
                onClick = { setControllerFollowHand(StickHand.RIGHT) },
                enabled = state.ready && !starting,
            ) { Text(if (controllerFollowHand == StickHand.RIGHT) "✓ Right" else "Right") }
          }
          Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(modifier = Modifier.weight(1f)) {
              Text("Show followed controller")
              Text("Visibility does not affect tracking or joystick input", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
            }
            Switch(
                checked = followedControllerVisible,
                onCheckedChange = setFollowedControllerVisible,
                enabled = state.ready && !starting,
            )
          }
        }
        Text(
            "This run: ${if (flubberOnlyPassthrough) "passthrough · Flubber only · no video" else if (mixedRealityEnabled) "passthrough · video" else "dark room · video"} · " +
                if (controllerFollowEnabled) "Flubber follows ${controllerFollowHand.token} controller" else "Flubber is world-anchored",
            style = MaterialTheme.typography.bodySmall,
            color = Color(0xFF9DE5B3),
        )
        Text(
            if (flubberOnlyPassthrough) {
              "These switches apply to this run only. Start opens LSL, shows Flubber and a 3-second countdown, then keeps the Flubber session running without video."
            } else {
              "These switches apply to this run only. Start opens LSL, shows Flubber and a 3-second countdown, then plays the selected video."
            },
            color = Color(0xFFB9C5D4),
        )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
          Button(onClick = chooseFolder, modifier = Modifier.weight(1f)) { Text("Authorize / change folder") }
          Button(onClick = startExperiment, enabled = state.ready && !starting, modifier = Modifier.weight(1f)) {
            Text(if (starting) "Starting…" else "Start experiment")
          }
        }
      }
    }
  }
}

@Composable
private fun PolarStreamCard(
    state: PolarH10State,
    starting: Boolean,
    connect: () -> Unit,
    disconnect: () -> Unit,
    retry: () -> Unit,
    toggleMetric: (PolarAffectAxis, String) -> Unit,
    updateMapping: (PolarAffectAxis, Double, Double, Boolean) -> Boolean,
) {
  Card(
      colors = CardDefaults.cardColors(containerColor = Color(0xFF101D1B)),
      modifier = Modifier.fillMaxWidth(),
  ) {
    Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text("Polar Stream · H10", style = MaterialTheme.typography.titleLarge)
      Text(
          state.compactLabel(),
          color = if (state.readiness.ready) Color(0xFF9DE5B3) else Color(0xFFFFC46B),
      )
      Text(
          "Official Polar SDK ${PolarH10Manager.SDK_VERSION} · ECG ${state.ecgSampleRateHz ?: 0} Hz / " +
              "${state.ecgResolutionBits ?: 0} bit · ${state.ecgSampleCount} samples · raw ECG is never saved",
          style = MaterialTheme.typography.bodySmall,
          color = Color(0xFFAAB4C2),
      )
      Text(
          "Uses Polar BLE SDK © Polar Electro Oy under its packaged license. Experimental; not a medical device.",
          style = MaterialTheme.typography.bodySmall,
          color = Color(0xFFAAB4C2),
      )
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        Button(
            onClick = if (state.enabled) disconnect else connect,
            enabled = !starting,
            modifier = Modifier.weight(1f),
        ) { Text(if (state.enabled) "Disconnect H10" else "Connect H10") }
        Button(onClick = retry, enabled = state.enabled && !starting, modifier = Modifier.weight(1f)) {
          Text("Retry")
        }
      }
      PolarWaveform(state.recentEcgSamplesUv)
      Text(
          "Assign any metric independently to Flubber X and/or Y. Unassigned or unavailable axes remain on the selected Touch controller.",
          style = MaterialTheme.typography.bodySmall,
          color = Color(0xFFB9C5D4),
      )
      PolarMetricCatalog.metrics.forEach { metric ->
        val value = state.metrics[metric.id]
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
          Column(modifier = Modifier.weight(1f)) {
            Text(metric.shortLabel)
            Text(
                value?.let { "%.3f ${metric.unit}".format(it) } ?: "warming up · ${metric.unit}",
                style = MaterialTheme.typography.bodySmall,
                color = Color(0xFFAAB4C2),
            )
          }
          Button(
              onClick = { toggleMetric(PolarAffectAxis.X, metric.id) },
              enabled = !starting,
          ) { Text(if (state.mappings.x.metricId == metric.id) "✓ X" else "X") }
          Button(
              onClick = { toggleMetric(PolarAffectAxis.Y, metric.id) },
              enabled = !starting,
          ) { Text(if (state.mappings.y.metricId == metric.id) "✓ Y" else "Y") }
        }
      }
      PolarAxisMappingEditor(PolarAffectAxis.X, state.mappings.x, starting, updateMapping)
      PolarAxisMappingEditor(PolarAffectAxis.Y, state.mappings.y, starting, updateMapping)
      if (state.mappings.anyAssigned) {
        Text(
            if (state.readiness.ready) {
              "Mapped run ready. Polar targets will begin after the countdown."
            } else {
              "Start is blocked while a mapped axis is assigned: ${state.readiness.reason.replace('-', ' ')}."
            },
            color = if (state.readiness.ready) Color(0xFF9DE5B3) else Color(0xFFFFC46B),
            style = MaterialTheme.typography.bodySmall,
        )
      }
    }
  }
}

@Composable
private fun PolarWaveform(samples: List<Int>) {
  Canvas(
      modifier = Modifier.fillMaxWidth().height(96.dp).background(Color(0xFF08100F)),
  ) {
    if (samples.size < 2) return@Canvas
    val minimum = samples.minOrNull()?.toFloat() ?: return@Canvas
    val maximum = samples.maxOrNull()?.toFloat() ?: return@Canvas
    val range = (maximum - minimum).coerceAtLeast(1f)
    for (index in 1 until samples.size) {
      val x0 = (index - 1).toFloat() / (samples.size - 1) * size.width
      val x1 = index.toFloat() / (samples.size - 1) * size.width
      val y0 = size.height - (samples[index - 1] - minimum) / range * size.height
      val y1 = size.height - (samples[index] - minimum) / range * size.height
      drawLine(Color(0xFF78D7FF), start = androidx.compose.ui.geometry.Offset(x0, y0),
          end = androidx.compose.ui.geometry.Offset(x1, y1), strokeWidth = 2f)
    }
  }
}

@Composable
private fun PolarAxisMappingEditor(
    axis: PolarAffectAxis,
    mapping: PolarAxisMapping,
    starting: Boolean,
    updateMapping: (PolarAffectAxis, Double, Double, Boolean) -> Boolean,
) {
  if (!mapping.assigned) return
  var minimumText by remember(mapping.metricId, mapping.minimum) { mutableStateOf(mapping.minimum.toString()) }
  var maximumText by remember(mapping.metricId, mapping.maximum) { mutableStateOf(mapping.maximum.toString()) }
  val label = axis.token.uppercase()
  Text("$label mapping · ${PolarMetricCatalog.definition(mapping.metricId)?.shortLabel ?: mapping.metricId}")
  Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
  ) {
    OutlinedTextField(
        value = minimumText,
        onValueChange = { minimumText = it },
        label = { Text("Low") },
        enabled = !starting,
        singleLine = true,
        modifier = Modifier.weight(1f),
    )
    OutlinedTextField(
        value = maximumText,
        onValueChange = { maximumText = it },
        label = { Text("High") },
        enabled = !starting,
        singleLine = true,
        modifier = Modifier.weight(1f),
    )
    Button(
        onClick = {
          val minimum = minimumText.toDoubleOrNull() ?: return@Button
          val maximum = maximumText.toDoubleOrNull() ?: return@Button
          updateMapping(axis, minimum, maximum, mapping.invert)
        },
        enabled = !starting,
    ) { Text("Apply") }
    Switch(
        checked = mapping.invert,
        onCheckedChange = { invert ->
          val minimum = minimumText.toDoubleOrNull() ?: return@Switch
          val maximum = maximumText.toDoubleOrNull() ?: return@Switch
          updateMapping(axis, minimum, maximum, invert)
        },
        enabled = !starting,
    )
  }
  Text("Reverse $label", style = MaterialTheme.typography.bodySmall, color = Color(0xFFAAB4C2))
}
