package io.github.georgefejer91.affecttracker.vr

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class StagedSession(
    val session: VrSession,
    val videoUri: Uri,
    val widthPx: Int,
    val heightPx: Int,
    val durationMs: Long,
    val rotationDegrees: Int,
    val fingerprint: String,
    val manifestName: String,
    val choiceSource: VideoChoiceSource,
) {
  val displayWidthPx: Int get() = if (rotationDegrees == 90 || rotationDegrees == 270) heightPx else widthPx
  val displayHeightPx: Int get() = if (rotationDegrees == 90 || rotationDegrees == 270) widthPx else heightPx
}

enum class VideoChoiceSource {
  ACTIVE_MANIFEST,
  OPTIONAL_MANIFEST,
  ACTIVE_LAYOUT_DEFAULTS,
}

data class SessionIssue(val manifestName: String, val code: String, val detail: String)

private data class VideoMetadata(val width: Int, val height: Int, val durationMs: Long, val rotationDegrees: Int)

private sealed interface CandidateResult {
  val claimedVideoFile: String?

  data class CopyInProgress(override val claimedVideoFile: String? = null) : CandidateResult
  data class Ready(val staged: StagedSession) : CandidateResult {
    override val claimedVideoFile: String = staged.session.video.file
  }
  data class Rejected(
      val code: String,
      val detail: String,
      override val claimedVideoFile: String? = null,
  ) : CandidateResult
}

sealed interface LoadResult {
  data object NoFolder : LoadResult
  data object NoManifest : LoadResult
  data object CopyInProgress : LoadResult
  data class Ready(
      val staged: StagedSession,
      val choices: List<StagedSession> = listOf(staged),
      val issues: List<SessionIssue> = emptyList(),
  ) : LoadResult
  data class Rejected(val code: String, val detail: String) : LoadResult
}

class SessionLoader(private val context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val lastCandidates = mutableMapOf<String, String>()
  private val cache = mutableMapOf<String, StagedSession>()

  fun authorizedTree(): Uri? = preferences.getString(TREE_URI, null)?.let(Uri::parse)

  fun retainTree(uri: Uri) {
    context.contentResolver.takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    preferences.edit().putString(TREE_URI, uri.toString()).apply()
    lastCandidates.clear()
    cache.clear()
  }

  suspend fun scan(): LoadResult = withContext(Dispatchers.IO) {
    val treeUri = authorizedTree() ?: return@withContext LoadResult.NoFolder
    val root = DocumentFile.fromTreeUri(context, treeUri)
        ?: return@withContext LoadResult.Rejected("folder_unavailable", "Choose Documents/AffectTrackerVR again.")
    val rootFiles = root.listFiles()
    val manifests = rootFiles.filter { it.name == MANIFEST }
    if (manifests.isEmpty()) return@withContext LoadResult.NoManifest
    if (manifests.size != 1) return@withContext LoadResult.Rejected("manifest_duplicate", "Keep exactly one active-session.json in AffectTrackerVR.")
    val mediaFolders = rootFiles.filter { it.name == MEDIA_DIRECTORY }
    if (mediaFolders.isEmpty()) return@withContext LoadResult.Rejected("media_folder_missing", "Create the media folder inside AffectTrackerVR.")
    if (mediaFolders.size != 1 || !mediaFolders.single().isDirectory) {
      return@withContext LoadResult.Rejected("media_folder_duplicate", "Keep exactly one media folder in AffectTrackerVR.")
    }
    val mediaFiles = mediaFolders.single().listFiles().filter { it.isFile }

    val active = validateCandidate(
        manifests.single(),
        mediaFiles,
        MANIFEST,
        VideoChoiceSource.ACTIVE_MANIFEST,
    )
    val activeStaged = when (active) {
      is CandidateResult.CopyInProgress -> return@withContext LoadResult.CopyInProgress
      is CandidateResult.Rejected -> return@withContext LoadResult.Rejected(active.code, active.detail)
      is CandidateResult.Ready -> active.staged
    }

    val issues = mutableListOf<SessionIssue>()
    val choices = mutableListOf(activeStaged)
    val claimedVideoFiles = mutableSetOf(activeStaged.session.video.file)
    val sessionFolders = rootFiles.filter { it.name == SESSION_DIRECTORY }
    if (sessionFolders.size > 1 || sessionFolders.singleOrNull()?.isDirectory == false) {
      issues += SessionIssue(SESSION_DIRECTORY, "session_folder_duplicate", "Keep at most one sessions folder in AffectTrackerVR.")
    } else {
      val optional = sessionFolders.singleOrNull()?.listFiles()
          ?.filter { it.isFile && it.name?.lowercase()?.endsWith(".json") == true }
          ?.sortedBy { it.name?.lowercase() }
          .orEmpty()
      if (optional.size > MAX_OPTIONAL_SESSIONS) {
        issues += SessionIssue(SESSION_DIRECTORY, "session_limit_exceeded", "Only the first $MAX_OPTIONAL_SESSIONS optional sessions are checked.")
      }
      optional.take(MAX_OPTIONAL_SESSIONS).forEach { manifest ->
        val name = manifest.name ?: "optional-session.json"
        val result = validateCandidate(
            manifest,
            mediaFiles,
            "$SESSION_DIRECTORY/$name",
            VideoChoiceSource.OPTIONAL_MANIFEST,
            activeStaged,
        )
        when (result) {
          is CandidateResult.CopyInProgress -> issues += SessionIssue(name, "copy_in_progress", "Waiting for this session's files to settle.")
          is CandidateResult.Rejected -> issues += SessionIssue(name, result.code, result.detail)
          is CandidateResult.Ready -> choices += result.staged
        }
        result.claimedVideoFile?.let(claimedVideoFiles::add)
      }
    }

    val unmanifestedMedia = mediaFiles
        .filterNot { it.name in claimedVideoFiles }
        .sortedBy { it.name?.lowercase() }
    if (unmanifestedMedia.size > MAX_AUTO_MEDIA_CHOICES) {
      issues += SessionIssue(
          MEDIA_DIRECTORY,
          "media_limit_exceeded",
          "Only the first $MAX_AUTO_MEDIA_CHOICES videos without manifests are checked.",
      )
    }
    unmanifestedMedia.take(MAX_AUTO_MEDIA_CHOICES).forEach { media ->
      val name = media.name ?: "unnamed-media"
      when (val result = validateDiscoveredMedia(media, activeStaged)) {
        is CandidateResult.CopyInProgress -> issues += SessionIssue(name, "copy_in_progress", "Waiting for this video to settle.")
        is CandidateResult.Rejected -> issues += SessionIssue(name, result.code, result.detail)
        is CandidateResult.Ready -> choices += result.staged
      }
    }

    val unique = mutableListOf<StagedSession>()
    val seenSessionIds = mutableSetOf<String>()
    val seenVideoFiles = mutableSetOf<String>()
    choices.forEach { choice ->
      when {
        !seenSessionIds.add(choice.session.sessionId) ->
          issues += SessionIssue(choice.manifestName, "duplicate_session_id", "Session ID ${choice.session.sessionId} is already in use.")
        !seenVideoFiles.add(choice.session.video.file) ->
          issues += SessionIssue(choice.manifestName, "duplicate_video_choice", "${choice.session.video.file} is already available.")
        else -> unique += choice
      }
    }
    LoadResult.Ready(activeStaged, unique, issues)
  }

  private fun validateCandidate(
      manifest: DocumentFile,
      mediaFiles: List<DocumentFile>,
      manifestName: String,
      source: VideoChoiceSource,
      runtimeProfile: StagedSession? = null,
  ): CandidateResult {
    if (manifest.length() <= 0 || manifest.length() > SessionContract.MAX_MANIFEST_BYTES) {
      return CandidateResult.Rejected("manifest_invalid_size", "$manifestName is empty or too large.")
    }
    val text = context.contentResolver.openInputStream(manifest.uri)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        ?: return CandidateResult.Rejected("manifest_unreadable", "$manifestName could not be read.")
    val session = runCatching { SessionContract.parse(text) }.getOrElse {
      return CandidateResult.Rejected("manifest_invalid", it.message ?: "$manifestName is invalid.")
    }
    val videos = mediaFiles.filter { it.name == session.video.file }
    if (videos.isEmpty()) return CandidateResult.Rejected("video_missing", "Copy ${session.video.file} into the media folder first.", session.video.file)
    if (videos.size != 1) return CandidateResult.Rejected("video_duplicate", "Keep exactly one ${session.video.file} in the media folder.", session.video.file)
    val video = videos.single()
    val manifestFingerprint = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).toHex()
    val profileFingerprint = runtimeProfile?.fingerprint ?: "active"
    val observation = "$manifestFingerprint|$profileFingerprint|${video.uri}|${video.length()}|${video.lastModified()}"
    cache[observation]?.let { return CandidateResult.Ready(it) }
    val candidateKey = manifest.uri.toString()
    if (observation != lastCandidates[candidateKey]) {
      lastCandidates[candidateKey] = observation
      return CandidateResult.CopyInProgress(session.video.file)
    }
    if (video.length() != session.video.byteLength) {
      return CandidateResult.Rejected("video_length_mismatch", "${session.video.file} length does not match $manifestName.", session.video.file)
    }
    val hash = runCatching { sha256(video.uri) }.getOrElse {
      return CandidateResult.Rejected("video_unreadable", "${session.video.file} could not be read.", session.video.file)
    }
    if (hash != session.video.sha256) {
      return CandidateResult.Rejected("video_hash_mismatch", "${session.video.file} SHA-256 does not match $manifestName.", session.video.file)
    }
    val metadata = runCatching { inspect(video.uri) }.getOrElse {
      return CandidateResult.Rejected("video_probe_failed", it.message ?: "Media metadata could not be decoded.", session.video.file)
    }
    validateLayout(session.video, metadata.width, metadata.height)
        ?.let { return CandidateResult.Rejected("video_layout_invalid", it, session.video.file) }
    val effectiveSession = runtimeProfile?.let { session.withRuntimeProfile(it.session) } ?: session
    val staged = StagedSession(
        effectiveSession,
        video.uri,
        metadata.width,
        metadata.height,
        metadata.durationMs,
        metadata.rotationDegrees,
        observation,
        manifestName,
        source,
    )
    cache[observation] = staged
    return CandidateResult.Ready(staged)
  }

  private fun validateDiscoveredMedia(
      video: DocumentFile,
      runtimeProfile: StagedSession,
  ): CandidateResult {
    val name = video.name
        ?: return CandidateResult.Rejected("video_filename_invalid", "A media file has no usable name.")
    if (!SessionContract.isSafeVideoFilename(name)) {
      return CandidateResult.Rejected("video_filename_invalid", "$name is not a safe video filename.", name)
    }
    if (video.length() <= 0L) {
      return CandidateResult.Rejected("video_invalid_size", "$name is empty.", name)
    }
    val observation = "auto|${runtimeProfile.fingerprint}|${video.uri}|${video.length()}|${video.lastModified()}"
    cache[observation]?.let { return CandidateResult.Ready(it) }
    val candidateKey = "auto:${video.uri}"
    if (observation != lastCandidates[candidateKey]) {
      lastCandidates[candidateKey] = observation
      return CandidateResult.CopyInProgress(name)
    }
    val hash = runCatching { sha256(video.uri) }.getOrElse {
      return CandidateResult.Rejected("video_unreadable", "$name could not be read.", name)
    }
    val metadata = runCatching { inspect(video.uri) }.getOrElse {
      return CandidateResult.Rejected("video_probe_failed", "$name: ${it.message ?: "media metadata could not be decoded"}", name)
    }
    val inheritedVideo = runtimeProfile.session.video.copy(
        file = name,
        byteLength = video.length(),
        sha256 = hash,
    )
    validateLayout(inheritedVideo, metadata.width, metadata.height)
        ?.let { return CandidateResult.Rejected("video_layout_invalid", it, name) }
    val effectiveSession = runtimeProfile.session.copy(
        sessionId = "media-${hash.take(24)}",
        video = inheritedVideo,
    )
    val staged = StagedSession(
        effectiveSession,
        video.uri,
        metadata.width,
        metadata.height,
        metadata.durationMs,
        metadata.rotationDegrees,
        observation,
        "$MEDIA_DIRECTORY/$name",
        VideoChoiceSource.ACTIVE_LAYOUT_DEFAULTS,
    )
    cache[observation] = staged
    return CandidateResult.Ready(staged)
  }

  private fun sha256(uri: Uri): String {
    val digest = MessageDigest.getInstance("SHA-256")
    context.contentResolver.openInputStream(uri)?.use { input ->
      val buffer = ByteArray(1024 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    } ?: error("video_unreadable")
    return digest.digest().toHex()
  }

  private fun validateLayout(video: VideoSpec, width: Int, height: Int): String? = when {
    video.stereo == StereoLayout.SIDE_BY_SIDE && width % 2 != 0 -> "Side-by-side video width must be even."
    video.stereo == StereoLayout.TOP_BOTTOM && height % 2 != 0 -> "Top/bottom video height must be even."
    else -> null
  }

  private fun inspect(uri: Uri): VideoMetadata {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, uri)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: error("video_width_missing")
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: error("video_height_missing")
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: error("video_duration_missing")
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      require(width > 0 && height > 0 && duration > 0) { "video_metadata_invalid" }
      require(rotation in setOf(0, 90, 180, 270)) { "video_rotation_invalid" }
      return VideoMetadata(width, height, duration, rotation)
    } finally {
      retriever.release()
    }
  }

  companion object {
    const val MANIFEST = "active-session.json"
    const val MEDIA_DIRECTORY = "media"
    const val SESSION_DIRECTORY = "sessions"
    const val MAX_OPTIONAL_SESSIONS = 24
    const val MAX_AUTO_MEDIA_CHOICES = 24
    private const val PREFERENCES = "affect-tracker-vr-loader-v1"
    private const val TREE_URI = "authorized-tree-uri"
  }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
