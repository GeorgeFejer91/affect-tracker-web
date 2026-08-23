package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpatialPlacementTest {
  @Test fun flatVideoUsesTheLiveViewerPoseAtAComfortableAngularSize() {
    val firstViewer = Pose(Vector3(0f, 1.65f, 0f), Quaternion())
    val turnedViewer = Pose(Vector3(2f, 1.45f, -1f), Quaternion(30f, 90f, 0f))
    val first = SpatialPlacement.videoPose(firstViewer, Projection.FLAT)
    val turned = SpatialPlacement.videoPose(turnedViewer, Projection.FLAT)

    assertEquals(SpatialPlacement.FLAT_VIDEO_DISTANCE_METERS, SpatialPlacement.distance(firstViewer.t, first.t), 0.001f)
    assertEquals(SpatialPlacement.FLAT_VIDEO_DISTANCE_METERS, SpatialPlacement.distance(turnedViewer.t, turned.t), 0.001f)
    assertEquals(turnedViewer.t.y, turned.t.y, 0.001f)
    assertNotEquals(first.t, turned.t)
  }

  @Test fun flubberStartsBelowAndCloserThanTheFlatVideo() {
    val viewer = Pose(Vector3(0f, 1.6f, 0f), Quaternion())
    val placement = FlubberPlacement(0.3f, 1.25f, 0f, -0.3f, false)
    val flubber = SpatialPlacement.flubberPose(viewer, placement)

    assertTrue(flubber.t.y < viewer.t.y)
    assertTrue(SpatialPlacement.distance(viewer.t, flubber.t) < SpatialPlacement.FLAT_VIDEO_DISTANCE_METERS)
  }
}
