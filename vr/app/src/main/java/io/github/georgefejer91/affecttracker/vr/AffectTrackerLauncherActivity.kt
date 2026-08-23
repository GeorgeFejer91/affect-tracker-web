package io.github.georgefejer91.affecttracker.vr

import android.app.PendingIntent
import android.content.Intent
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
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
            "${staged.session.video.projection.token} · ${staged.session.video.stereo.token} · ${formatDuration(staged.durationMs)}",
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
        "${staged.session.video.projection.token} · ${staged.session.video.stereo.token} · ${staged.durationMs / 1_000}s",
        selected,
    )
  }
}

class AffectTrackerLauncherActivity : ComponentActivity() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val runtime get() = (application as AffectTrackerVrApplication).runtime
  private var polling: Job? = null
  private var staged: StagedSession? = null
  private var choices: List<StagedSession> = emptyList()
  private var selectedFingerprint: String? = null
  private var starting by mutableStateOf(false)
  private var presentation by mutableStateOf(LauncherPresentation.from(LoadResult.NoFolder))

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { LauncherScreen(presentation, starting, ::chooseFolder, ::selectSession, ::startExperiment) }
    Log.i(ExperimentRuntime.READINESS_TAG, "launcher_rendered")
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
    scope.coroutineContext[Job]?.cancel()
    super.onDestroy()
  }

  private fun beginPolling() {
    polling?.cancel()
    polling = scope.launch {
      while (isActive && !starting) {
        val result = runCatching { runtime.loader.scan() }.getOrElse {
          LoadResult.Rejected("folder_unavailable", "Folder access was lost. Authorize Documents/AffectTrackerVR again.")
        }
        val ready = result as? LoadResult.Ready
        choices = ready?.choices.orEmpty()
        staged = ready?.choices?.firstOrNull { it.fingerprint == selectedFingerprint } ?: ready?.staged
        selectedFingerprint = staged?.fingerprint
        presentation = LauncherPresentation.from(result, selectedFingerprint)
        staged?.let {
          Log.i(ExperimentRuntime.READINESS_TAG, "session_ready session=${it.session.sessionId} fingerprint=${it.fingerprint}")
        }
        delay(2_000)
      }
    }
  }

  private fun selectSession(fingerprint: String) {
    val next = choices.firstOrNull { it.fingerprint == fingerprint } ?: return
    staged = next
    selectedFingerprint = fingerprint
    presentation = presentation.copy(
        detail = "${next.session.video.projection.token} · ${next.session.video.stereo.token} · ${next.durationMs / 1_000}s",
        selectedFingerprint = fingerprint,
        choices = choices.map { LauncherChoice.from(it, it.fingerprint == fingerprint) },
    )
    Log.i(ExperimentRuntime.READINESS_TAG, "session_selected session=${next.session.sessionId}")
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

  private fun startExperiment() {
    val next = staged ?: return
    if (starting) return
    starting = true
    polling?.cancel()
    presentation = presentation.copy(title = "Starting LSL…", detail = "Opening the state and marker streams before the countdown.")
    val queued = runtime.arm(next) { ready ->
      if (!ready) {
        starting = false
        presentation = presentation.copy(title = "LSL unavailable", detail = "${runtime.lsl.status}. Experiment start was blocked.")
        return@arm
      }
      Log.i(ExperimentRuntime.READINESS_TAG, "immersive_requested session=${next.session.sessionId}")
      startActivity(Intent(this, AffectTrackerVrActivity::class.java).apply {
        action = Intent.ACTION_MAIN
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        putExtra(AffectTrackerVrActivity.EXTRA_FINGERPRINT, next.fingerprint)
      })
    }
    if (!queued) {
      starting = false
      presentation = presentation.copy(title = "LSL unavailable", detail = "${runtime.lsl.status}. Experiment start was blocked.")
    }
  }

  companion object {
    private const val FOLDER_PROXY_REQUEST = 4103
    const val EXTRA_LAUNCH_IN_HOME_PENDING_INTENT = "extra_launch_in_home_pending_intent"
  }
}

@Composable
private fun LauncherScreen(
    state: LauncherPresentation,
    starting: Boolean,
    chooseFolder: () -> Unit,
    selectSession: (String) -> Unit,
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
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF131923)), modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
              Text(state.title, style = MaterialTheme.typography.titleLarge)
              Text(state.detail, color = Color(0xFFC4CEDA))
              if (state.choices.isNotEmpty()) {
                Text("Choose a validated experiment", color = Color(0xFF9DE5B3))
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
          Text("PC folder: Documents/AffectTrackerVR — videos in media/, optional manifests in sessions/", color = Color(0xFFAAB4C2))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
          Button(onClick = chooseFolder, modifier = Modifier.weight(1f)) { Text("Authorize / change folder") }
          Button(onClick = startExperiment, enabled = state.ready && !starting, modifier = Modifier.weight(1f)) {
            Text(if (starting) "Starting…" else "Start experiment")
          }
        }
        Text("Start opens LSL, shows Flubber and a 3-second countdown, then plays the selected video.", color = Color(0xFFB9C5D4))
      }
    }
  }
}
