package io.github.georgefejer91.affecttracker.vr

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
  private var controllerFollowEnabled by mutableStateOf(false)
  private var controllerFollowHand by mutableStateOf(StickHand.LEFT)
  private var presentation by mutableStateOf(LauncherPresentation.from(LoadResult.NoFolder))

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      LauncherScreen(
          presentation,
          starting,
          showAffectValues,
          mixedRealityEnabled,
          controllerFollowEnabled,
          controllerFollowHand,
          ::chooseFolder,
          ::selectSession,
          { showAffectValues = it },
          { mixedRealityEnabled = it },
          { controllerFollowEnabled = it },
          { controllerFollowHand = it },
          ::openWebXrStudy,
          ::startExperiment,
      )
    }
    Log.i(ExperimentRuntime.READINESS_TAG, "launcher_rendered")
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "launcher_controls_rendered mixed_reality=true controller_follow=true follow_hand_selector=true",
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
    controllerFollowEnabled = next.session.flubber.controllerFollow.enabled
    controllerFollowHand = next.session.flubber.controllerFollow.hand
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

  private fun startExperiment() {
    val next = staged ?: return
    if (starting) return
    val effective = next.copy(
        session = next.session.withLauncherRuntimeOverrides(
            mixedRealityEnabled,
            controllerFollowEnabled,
            controllerFollowHand,
        ),
    )
    starting = true
    polling?.cancel()
    presentation = presentation.copy(title = "Starting LSL…", detail = "Opening the state and marker streams before the countdown.")
    Log.i(
        ExperimentRuntime.READINESS_TAG,
        "launcher_runtime_options environment=${effective.session.environment.token} " +
            "controller_follow=${effective.session.flubber.controllerFollow.enabled} " +
            "follow_hand=${effective.session.flubber.controllerFollow.hand.token} " +
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
    controllerFollowEnabled: Boolean,
    controllerFollowHand: StickHand,
    chooseFolder: () -> Unit,
    selectSession: (String) -> Unit,
    setShowAffectValues: (Boolean) -> Unit,
    setMixedRealityEnabled: (Boolean) -> Unit,
    setControllerFollowEnabled: (Boolean) -> Unit,
    setControllerFollowHand: (StickHand) -> Unit,
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
        }
        Text(
            "This run: ${if (mixedRealityEnabled) "passthrough" else "dark room"} · " +
                if (controllerFollowEnabled) "Flubber follows ${controllerFollowHand.token} controller" else "Flubber is world-anchored",
            style = MaterialTheme.typography.bodySmall,
            color = Color(0xFF9DE5B3),
        )
        Text("These switches apply to this run only. Start opens LSL, shows Flubber and a 3-second countdown, then plays the selected video.", color = Color(0xFFB9C5D4))
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
