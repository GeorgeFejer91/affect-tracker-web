package io.github.georgefejer91.affecttracker.vr

import android.app.Application
import android.util.Log

class AffectTrackerVrApplication : Application() {
  val runtime: ExperimentRuntime by lazy { ExperimentRuntime(this) }
}

class ExperimentRuntime(application: Application) {
  val loader = SessionLoader(application)
  val lsl = LslService(application)

  @Volatile var armedSession: StagedSession? = null
    private set

  fun arm(staged: StagedSession, onComplete: (Boolean) -> Unit): Boolean {
    armedSession = null
    Log.i(READINESS_TAG, "start_pressed session=${staged.session.sessionId}")
    return lsl.start(staged.session.affect.lsl, staged.session.sessionId) { ready ->
      if (ready) {
        armedSession = staged
        lsl.marker("system:start_requested:${staged.session.sessionId}")
        Log.i(READINESS_TAG, "lsl_running session=${staged.session.sessionId}")
      } else {
        Log.e(READINESS_TAG, "lsl_failed status=${lsl.status}")
      }
      onComplete(ready)
    }
  }

  fun finish(reason: String) {
    val staged = armedSession
    if (staged != null && lsl.status == "running") {
      lsl.marker("system:session_ended:${staged.session.sessionId}:$reason")
    }
    armedSession = null
    lsl.stop()
    Log.i(READINESS_TAG, "runtime_stopped reason=$reason")
  }

  companion object {
    const val READINESS_TAG = "AffectTrackerReady"
  }
}
