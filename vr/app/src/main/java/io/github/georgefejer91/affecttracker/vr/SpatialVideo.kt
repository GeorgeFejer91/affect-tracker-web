package io.github.georgefejer91.affecttracker.vr

import android.content.Context
import android.view.Surface
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.runtime.StereoMode
import com.meta.spatial.toolkit.Equirect180ShapeOptions
import com.meta.spatial.toolkit.Equirect360ShapeOptions
import com.meta.spatial.toolkit.MediaPanelRenderOptions
import com.meta.spatial.toolkit.MediaPanelSettings
import com.meta.spatial.toolkit.Panel
import com.meta.spatial.toolkit.PanelInputOptions
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.VideoSurfacePanelRegistration
import com.meta.spatial.toolkit.Visible
import kotlin.math.max
import kotlin.math.min

data class VideoPlaybackState(val token: String, val ready: Boolean, val playing: Boolean, val positionMs: Long)

@androidx.annotation.OptIn(markerClass = [UnstableApi::class])
class SpatialVideoPlayer(context: Context, private val onState: (VideoPlaybackState) -> Unit, private val onMarker: (String) -> Unit) {
  private val player = ExoPlayer.Builder(context).build()
  private var staged: StagedSession? = null
  private var playRequested = false
  private var firstPlaybackFrameMarked = false

  init {
    player.setVideoFrameMetadataListener { _, _, _, _ ->
      if (playRequested && !firstPlaybackFrameMarked) {
        firstPlaybackFrameMarked = true
        onMarker("video:first_frame")
      }
    }
    player.addListener(object : Player.Listener {
      override fun onEvents(player: Player, events: Player.Events) = publish()
      override fun onRenderedFirstFrame() { onMarker("video:surface_frame_ready"); publish() }
      override fun onPlayerError(error: PlaybackException) { onMarker("video:error:media3_${error.errorCode}"); publish() }
      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED) onMarker("video:ended")
        publish()
      }
    })
  }

  fun attach(stagedSession: StagedSession, surface: Surface) {
    staged = stagedSession
    playRequested = false
    firstPlaybackFrameMarked = false
    player.pause()
    player.clearVideoSurface()
    player.setVideoSurface(surface)
    player.repeatMode = if (stagedSession.session.video.loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    player.setMediaItem(MediaItem.Builder().setMediaId(stagedSession.session.sessionId).setUri(stagedSession.videoUri).build())
    player.prepare()
  }

  fun play() { playRequested = true; player.play() }
  fun pause() = player.pause()
  fun positionMs(): Long = player.currentPosition.coerceAtLeast(0)
  fun release() { player.clearVideoSurface(); player.release() }

  private fun publish() {
    val token = when (player.playbackState) {
      Player.STATE_IDLE -> "idle"
      Player.STATE_BUFFERING -> "buffering"
      Player.STATE_READY -> "ready"
      Player.STATE_ENDED -> "ended"
      else -> "unknown"
    }
    onState(VideoPlaybackState(token, player.playbackState == Player.STATE_READY, player.isPlaying, positionMs()))
  }
}

class SpatialVideoCoordinator(private val onSurface: (StagedSession, Surface) -> Unit) {
  private data class Key(val projection: Projection, val stereo: StereoLayout)
  private val panelIds = mapOf(
      Key(Projection.FLAT, StereoLayout.MONO) to R.id.video_flat_mono,
      Key(Projection.FLAT, StereoLayout.SIDE_BY_SIDE) to R.id.video_flat_sbs,
      Key(Projection.FLAT, StereoLayout.TOP_BOTTOM) to R.id.video_flat_tb,
      Key(Projection.EQUIRECT_180, StereoLayout.MONO) to R.id.video_180_mono,
      Key(Projection.EQUIRECT_180, StereoLayout.SIDE_BY_SIDE) to R.id.video_180_sbs,
      Key(Projection.EQUIRECT_180, StereoLayout.TOP_BOTTOM) to R.id.video_180_tb,
      Key(Projection.EQUIRECT_360, StereoLayout.MONO) to R.id.video_360_mono,
      Key(Projection.EQUIRECT_360, StereoLayout.SIDE_BY_SIDE) to R.id.video_360_sbs,
      Key(Projection.EQUIRECT_360, StereoLayout.TOP_BOTTOM) to R.id.video_360_tb,
  )
  private var active: StagedSession? = null
  private var entity: Entity? = null

  fun registrations(): List<PanelRegistration> = panelIds.map { (key, id) ->
    VideoSurfacePanelRegistration(
        id,
        surfaceConsumer = { _, surface -> active?.takeIf { Key(it.session.video.projection, it.session.video.stereo) == key }?.let { onSurface(it, surface) } },
        settingsCreator = { settingsFor(requireNotNull(active)) },
    )
  }

  fun present(staged: StagedSession, viewer: Pose): Pose {
    active = staged
    entity?.destroy()
    val key = Key(staged.session.video.projection, staged.session.video.stereo)
    val pose = SpatialPlacement.videoPose(viewer, staged.session.video.projection)
    entity = Entity.create(Panel(requireNotNull(panelIds[key])), Transform(pose), Visible(true))
    return pose
  }

  fun recenter(viewer: Pose): Pose {
    val staged = requireNotNull(active)
    val pose = SpatialPlacement.videoPose(viewer, staged.session.video.projection)
    entity?.setComponent(Transform(pose))
    return pose
  }

  /**
   * Drop Kotlin references during Activity teardown. AppSystemActivity owns destruction of its
   * scene entities; calling Entity.destroy() after its native DataModel has closed is unsafe.
   */
  fun detachForRuntimeTeardown() { entity = null; active = null }

  private fun settingsFor(staged: StagedSession): MediaPanelSettings {
    val video = staged.session.video
    val perEyeWidth = if (video.stereo == StereoLayout.SIDE_BY_SIDE) staged.displayWidthPx / 2f else staged.displayWidthPx.toFloat()
    val perEyeHeight = if (video.stereo == StereoLayout.TOP_BOTTOM) staged.displayHeightPx / 2f else staged.displayHeightPx.toFloat()
    val shape = when (video.projection) {
      Projection.FLAT -> {
        val height = min(FLAT_MAX_HEIGHT_METERS, max(FLAT_MIN_HEIGHT_METERS, SpatialPlacement.FLAT_VIDEO_WIDTH_METERS / (perEyeWidth / perEyeHeight)))
        QuadShapeOptions(width = SpatialPlacement.FLAT_VIDEO_WIDTH_METERS, height = height)
      }
      Projection.EQUIRECT_180 -> Equirect180ShapeOptions(radius = IMMERSIVE_RADIUS_METERS)
      Projection.EQUIRECT_360 -> Equirect360ShapeOptions(radius = IMMERSIVE_RADIUS_METERS)
    }
    val stereo = when (video.stereo) {
      StereoLayout.MONO -> StereoMode.None
      StereoLayout.SIDE_BY_SIDE -> StereoMode.LeftRight
      StereoLayout.TOP_BOTTOM -> StereoMode.UpDown
    }
    return MediaPanelSettings(
        shape = shape,
        display = PixelDisplayOptions(width = staged.widthPx, height = staged.heightPx),
        rendering = MediaPanelRenderOptions(stereoMode = stereo, zIndex = -40),
        input = PanelInputOptions(0),
    )
  }

  companion object {
    private const val IMMERSIVE_RADIUS_METERS = 50f
    private const val FLAT_MIN_HEIGHT_METERS = 0.6f
    private const val FLAT_MAX_HEIGHT_METERS = 1.8f
  }
}
