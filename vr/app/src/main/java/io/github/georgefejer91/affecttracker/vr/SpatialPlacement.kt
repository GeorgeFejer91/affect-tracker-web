package io.github.georgefejer91.affecttracker.vr

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.Vector3
import kotlin.math.sqrt

/** Pure, testable viewer-relative placement shared by the live scene and readiness tests. */
object SpatialPlacement {
  const val FLAT_VIDEO_DISTANCE_METERS = 2.0f
  const val FLAT_VIDEO_WIDTH_METERS = 2.2f

  fun videoPose(viewer: Pose, projection: Projection): Pose =
      if (projection == Projection.FLAT) {
        val forward = uprightForward(viewer)
        Pose(viewer.t + forward * FLAT_VIDEO_DISTANCE_METERS, Quaternion.lookRotationAroundY(forward))
      } else {
        Pose(viewer.t, viewer.q)
      }

  fun flubberPose(viewer: Pose, placement: FlubberPlacement): Pose {
    val forward = uprightForward(viewer)
    val rawRight = Vector3(forward.z, 0f, -forward.x)
    val rightLength = length(rawRight)
    val right = if (rightLength > 0.001f) rawRight * (1f / rightLength) else Vector3(1f, 0f, 0f)
    return Pose(
        viewer.t + forward * placement.distanceMeters + right * placement.horizontalOffsetMeters +
            Vector3(0f, placement.verticalOffsetMeters, 0f),
        Quaternion.lookRotationAroundY(forward),
    )
  }

  fun distance(a: Vector3, b: Vector3): Float = length(a - b)

  fun uprightForward(viewer: Pose): Vector3 {
    val tracked = viewer.forward()
    val flat = Vector3(tracked.x, 0f, tracked.z)
    val flatLength = length(flat)
    return if (flatLength > 0.001f) flat * (1f / flatLength) else Vector3(0f, 0f, 1f)
  }

  private fun length(value: Vector3): Float = sqrt(value.x * value.x + value.y * value.y + value.z * value.z)
}
