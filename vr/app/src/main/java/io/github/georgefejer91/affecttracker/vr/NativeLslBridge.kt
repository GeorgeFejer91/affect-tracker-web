package io.github.georgefejer91.affecttracker.vr

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object NativeLslBridge {
  val available: Boolean = runCatching { System.loadLibrary("affect_tracker_vr_lsl"); true }.getOrDefault(false)
  external fun nativeStart(configurationJson: String): String
  external fun nativePushState(values: FloatArray): Boolean
  external fun nativePushMarker(marker: String): Boolean
  external fun nativeStop()
}

class LslService(context: Context) : AutoCloseable {
  private val multicastLock = (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
      .createMulticastLock("affect-tracker-vr-lsl").apply { setReferenceCounted(false) }
  private val mainHandler = Handler(Looper.getMainLooper())
  private val free = ArrayBlockingQueue<PooledCommand>(QUEUE_CAPACITY)
  private val pending = ArrayBlockingQueue<Command>(QUEUE_CAPACITY + CONTROL_CAPACITY)
  private val worker = Thread(::runWorker, "affect-tracker-lsl").apply {
    isDaemon = true
    priority = Thread.NORM_PRIORITY - 1
  }
  @Volatile var status: String = "stopped"
    private set
  @Volatile private var closed = false

  init {
    repeat(QUEUE_CAPACITY) { free.add(PooledCommand()) }
    worker.start()
  }

  fun start(settings: LslSettings, sessionId: String, onComplete: (Boolean) -> Unit = {}): Boolean {
    if (closed) { status = "worker_closed"; return false }
    val configuration = JSONObject()
        .put("streamName", settings.streamName)
        .put("streamType", settings.streamType)
        .put("markerName", settings.markerName)
        .put("sampleRate", settings.sampleRate)
        .put("sourceId", settings.sourceId)
        .put("sessionId", sessionId)
        .toString()
    status = "starting"
    return pending.offer(StartCommand(configuration, onComplete)).also { accepted ->
      if (!accepted) status = "control_queue_full"
    }
  }

  fun push(snapshot: AffectSnapshot): Boolean {
    if (status != "running") return false
    val command = free.poll() ?: run { status = "queue_full"; return false }
    command.kind = STATE
    command.values[0] = snapshot.currentX
    command.values[1] = snapshot.currentY
    command.values[2] = snapshot.targetX
    command.values[3] = snapshot.targetY
    command.values[4] = snapshot.radius
    command.values[5] = snapshot.angleDegrees
    command.values[6] = if (snapshot.animationActive) 1f else 0f
    command.values[7] = if (snapshot.inputActive) 1f else 0f
    return enqueue(command)
  }

  fun marker(value: String) {
    if (status != "running") return
    val command = free.poll() ?: run { status = "queue_full"; return }
    command.kind = MARKER
    command.marker = value
    enqueue(command)
  }

  fun stop(timeoutMillis: Long = 2_000): Boolean {
    if (closed || status == "stopped") return true
    status = "stopping"
    val latch = CountDownLatch(1)
    if (!pending.offer(StopCommand(latch))) {
      status = "control_queue_full"
      return false
    }
    return latch.await(timeoutMillis, TimeUnit.MILLISECONDS)
  }

  override fun close() {
    if (closed) return
    closed = true
    stop()
    pending.put(ShutdownCommand)
    worker.join(2_000)
  }

  private fun enqueue(command: PooledCommand): Boolean = pending.offer(command).also { accepted ->
    if (!accepted) {
      recycle(command)
      status = "queue_full"
    }
  }

  private fun runWorker() {
    while (true) {
      when (val command = pending.take()) {
        is StartCommand -> startNative(command)
        is StopCommand -> { stopNative(); command.latch.countDown() }
        ShutdownCommand -> { stopNative(); return }
        is PooledCommand -> process(command)
      }
    }
  }

  private fun startNative(command: StartCommand) {
    stopNative()
    val nextStatus = if (!NativeLslBridge.available) {
      "native_library_unavailable"
    } else {
      runCatching { NativeLslBridge.nativeStart(command.configuration) }
          .getOrElse { "start_failed:${it.javaClass.simpleName}" }
    }
    status = nextStatus
    if (nextStatus == "running" && !multicastLock.isHeld) multicastLock.acquire()
    mainHandler.post { command.onComplete(nextStatus == "running") }
  }

  private fun process(command: PooledCommand) {
    val delivered = when (command.kind) {
      STATE -> runCatching { NativeLslBridge.nativePushState(command.values) }.getOrDefault(false)
      MARKER -> runCatching { NativeLslBridge.nativePushMarker(command.marker.orEmpty()) }.getOrDefault(false)
      else -> false
    }
    if (!delivered && status == "running") status = if (command.kind == STATE) "state_push_failed" else "marker_push_failed"
    recycle(command)
  }

  private fun recycle(command: PooledCommand) {
    command.kind = UNUSED
    command.marker = null
    free.offer(command)
  }

  private fun stopNative() {
    if (NativeLslBridge.available) runCatching { NativeLslBridge.nativeStop() }
    if (multicastLock.isHeld) multicastLock.release()
    status = "stopped"
  }

  private sealed interface Command
  private data class StartCommand(val configuration: String, val onComplete: (Boolean) -> Unit) : Command
  private data class StopCommand(val latch: CountDownLatch) : Command
  private data object ShutdownCommand : Command
  private class PooledCommand : Command {
    var kind = UNUSED
    val values = FloatArray(8)
    var marker: String? = null
  }

  companion object {
    private const val UNUSED = 0
    private const val STATE = 1
    private const val MARKER = 2
    private const val QUEUE_CAPACITY = 256
    private const val CONTROL_CAPACITY = 8
  }
}
