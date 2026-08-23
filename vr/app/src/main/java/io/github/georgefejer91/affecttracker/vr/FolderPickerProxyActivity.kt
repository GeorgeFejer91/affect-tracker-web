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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

class FolderPickerProxyActivity : ComponentActivity() {
  private var pickerStarted = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      MaterialTheme(colorScheme = darkColorScheme(primary = Color(0xFF78D7FF))) {
        Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF080B10)) {
          Column(
              modifier = Modifier.fillMaxSize().background(Color(0xFF080B10)).padding(32.dp),
              verticalArrangement = Arrangement.spacedBy(16.dp),
          ) {
            Text("Authorize AffectTrackerVR", style = MaterialTheme.typography.headlineMedium)
            Text("In the folder window, open Documents, select AffectTrackerVR, then press Use this folder.")
            Text("Returning to Affect Tracker VR after authorization…", color = Color(0xFFB9C5D4))
          }
        }
      }
    }
    Log.i(ExperimentRuntime.READINESS_TAG, "folder_proxy_rendered")
    if (savedInstanceState == null) {
      window.decorView.postDelayed(::openPicker, 500)
    }
  }

  private fun openPicker() {
    if (pickerStarted || isFinishing) return
    pickerStarted = true
    startActivityForResult(
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        ),
        TREE_REQUEST,
    )
  }

  @Deprecated("Android result API is required here so DocumentsUI can return to the Home-launched proxy task.")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == TREE_REQUEST && resultCode == RESULT_OK && data?.data != null) {
      runCatching {
        (application as AffectTrackerVrApplication).runtime.loader.retainTree(requireNotNull(data.data))
      }.onSuccess {
        Log.i(ExperimentRuntime.READINESS_TAG, "folder_authorized")
      }.onFailure {
        Log.e(ExperimentRuntime.READINESS_TAG, "folder_authorization_failed", it)
      }
    } else {
      Log.i(ExperimentRuntime.READINESS_TAG, "folder_authorization_cancelled")
    }
    returnToLauncherInHome()
  }

  private fun returnToLauncherInHome() {
    val launcherIntent = Intent(this, AffectTrackerLauncherActivity::class.java).apply {
      action = Intent.ACTION_MAIN
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    val pendingLauncherIntent = PendingIntent.getActivity(
        this,
        LAUNCHER_REQUEST,
        launcherIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    startActivity(
        Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_HOME)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(AffectTrackerLauncherActivity.EXTRA_LAUNCH_IN_HOME_PENDING_INTENT, pendingLauncherIntent),
    )
    finish()
  }

  companion object {
    private const val TREE_REQUEST = 4102
    private const val LAUNCHER_REQUEST = 4104
  }
}
