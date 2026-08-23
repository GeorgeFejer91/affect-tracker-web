package io.github.georgefejer91.affecttracker.vr

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LauncherPresentationTest {
  @Test fun folderAuthorizationIsNeverAutomatic() {
    val state = LauncherPresentation.from(LoadResult.NoFolder)
    assertFalse(state.ready)
    assertTrue(state.title.contains("Authorize"))
    assertTrue(state.detail.contains("Documents/AffectTrackerVR"))
  }

  @Test fun rejectedSessionCannotEnableStart() {
    val state = LauncherPresentation.from(LoadResult.Rejected("video_hash_mismatch", "Copy the unchanged video."))
    assertFalse(state.ready)
    assertTrue(state.title.contains("video_hash_mismatch"))
  }
}
