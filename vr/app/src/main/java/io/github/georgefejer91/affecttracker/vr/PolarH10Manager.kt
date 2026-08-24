package io.github.georgefejer91.affecttracker.vr

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import com.polar.androidcommunications.api.ble.model.DisInfo
import com.polar.sdk.api.PolarBleApi
import com.polar.sdk.api.PolarBleApiCallback
import com.polar.sdk.api.PolarBleApiDefaultImpl
import com.polar.sdk.api.model.EcgSample
import com.polar.sdk.api.model.PolarDeviceInfo
import com.polar.sdk.api.model.PolarHealthThermometerData
import com.polar.sdk.api.model.PolarSensorSetting
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Application-scoped Polar H10 transport.
 *
 * Android owns BLE permission, discovery, SDK lifecycle, and the visible readiness state. Raw ECG
 * remains in bounded memory for the five-second metric window and 160-sample preview; this class
 * performs no file I/O and never emits device identifiers.
 */
class PolarH10Manager(context: Context) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val stateLock = Any()
  private val metricProcessor = PolarMetricProcessor()
  private val recentEcgSamplesUv = ArrayDeque<Int>(RECENT_ECG_SAMPLE_LIMIT)
  private val _state = MutableStateFlow(
      PolarH10State(permissionsGranted = permissionsGranted()),
  )
  val state: StateFlow<PolarH10State> = _state.asStateFlow()

  private var api: PolarBleApi? = null
  private var autoConnectJob: Job? = null
  private var ecgJob: Job? = null
  private var hrJob: Job? = null
  private var monitorJob: Job? = null
  private var enabled = false
  private var bluetoothPowered = true
  private var transportState = "not-started"
  private var connected = false
  private var connectedIdentifier: String? = null
  private var heartRateBpm: Int? = null
  private var rrIntervalMs: Int? = null
  private var latestHeartRateSampleElapsedMs: Long? = null
  private var latestRrSampleElapsedMs: Long? = null
  private var ecgStreaming = false
  private var ecgSampleRateHz: Int? = null
  private var ecgResolutionBits: Int? = null
  private var ecgSampleCount = 0L
  private var ecgStreamEpoch = 0L
  private var firstEcgSampleElapsedMs: Long? = null
  private var firstEcgSampleCount = 0L
  private var latestEcgSampleElapsedMs: Long? = null
  private var metrics: Map<String, Double> = emptyMap()
  private var mappings = PolarAffectMappings()
  private var lastUiEmitElapsedMs = 0L
  private var lastHealthMarkerElapsedMs = 0L
  private var lastMarkerKey = ""

  fun connect() {
    synchronized(stateLock) {
      enabled = true
      transportState = if (permissionsGranted()) "starting" else "permissions-required"
    }
    emit(force = true)
    if (!permissionsGranted()) return
    val activeApi = ensureApi()
    activeApi.foregroundEntered()
    startMonitor()
    startAutoConnectLoop()
  }

  fun onForeground() {
    if (!enabled || !permissionsGranted()) return
    ensureApi().foregroundEntered()
    startMonitor()
    startAutoConnectLoop()
  }

  fun onPermissionsChanged() {
    if (permissionsGranted()) connect()
    else {
      synchronized(stateLock) { transportState = "permissions-denied" }
      emit(force = true)
    }
  }

  fun restartDiscovery() {
    if (!enabled) return
    autoConnectJob?.cancel()
    ecgJob?.cancel()
    hrJob?.cancel()
    connectedIdentifier?.let { identifier -> runCatching { api?.disconnectFromDevice(identifier) } }
    synchronized(stateLock) {
      connected = false
      connectedIdentifier = null
      transportState = if (permissionsGranted()) "restart-requested" else "permissions-required"
      clearStreamsLocked()
    }
    emit(force = true)
    connect()
  }

  fun disconnect() {
    synchronized(stateLock) {
      enabled = false
      transportState = "disconnected-by-user"
    }
    autoConnectJob?.cancel()
    ecgJob?.cancel()
    hrJob?.cancel()
    monitorJob?.cancel()
    connectedIdentifier?.let { identifier -> runCatching { api?.disconnectFromDevice(identifier) } }
    runCatching { api?.shutDown() }
    api = null
    synchronized(stateLock) {
      connected = false
      connectedIdentifier = null
      clearStreamsLocked()
    }
    emit(force = true)
  }

  fun toggleMetric(axis: PolarAffectAxis, metricId: String) {
    val definition = PolarMetricCatalog.definition(metricId) ?: return
    synchronized(stateLock) {
      val current = mappings.mapping(axis)
      val next = if (current.metricId == metricId) PolarAxisMapping() else PolarAxisMapping.forMetric(definition)
      mappings = mappings.withMapping(axis, next)
    }
    emit(force = true)
  }

  fun clearMapping(axis: PolarAffectAxis) {
    synchronized(stateLock) { mappings = mappings.withMapping(axis, PolarAxisMapping()) }
    emit(force = true)
  }

  fun updateMapping(axis: PolarAffectAxis, minimum: Double, maximum: Double, invert: Boolean): Boolean {
    if (!minimum.isFinite() || !maximum.isFinite() || maximum <= minimum) return false
    synchronized(stateLock) {
      val current = mappings.mapping(axis)
      if (!current.assigned) return false
      mappings = mappings.withMapping(axis, current.copy(minimum = minimum, maximum = maximum, invert = invert))
    }
    emit(force = true)
    return true
  }

  fun permissionsGranted(): Boolean = requiredRuntimePermissions().all { permission ->
    appContext.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun ensureApi(): PolarBleApi {
    api?.let { return it }
    val created = PolarBleApiDefaultImpl.defaultImplementation(
        appContext,
        setOf(
            PolarBleApi.PolarBleSdkFeature.FEATURE_HR,
            PolarBleApi.PolarBleSdkFeature.FEATURE_POLAR_ONLINE_STREAMING,
        ),
    )
    created.setAutomaticReconnection(true)
    created.setPolarFilter(true)
    created.setApiCallback(object : PolarBleApiCallback() {
      override fun blePowerStateChanged(powered: Boolean) {
        synchronized(stateLock) {
          bluetoothPowered = powered
          if (!powered) {
            transportState = "bluetooth-disabled"
            connected = false
            connectedIdentifier = null
            clearStreamsLocked()
          }
        }
        emit(force = true)
      }

      override fun deviceConnecting(polarDeviceInfo: PolarDeviceInfo) {
        if (!enabled) return
        synchronized(stateLock) { transportState = "connecting-h10" }
        emit(force = true)
      }

      override fun deviceConnected(polarDeviceInfo: PolarDeviceInfo) {
        if (!enabled) return
        synchronized(stateLock) {
          connected = true
          connectedIdentifier = polarDeviceInfo.deviceId
          transportState = "connected-awaiting-streams"
        }
        emit(force = true)
      }

      override fun deviceDisconnected(polarDeviceInfo: PolarDeviceInfo) {
        ecgJob?.cancel()
        hrJob?.cancel()
        synchronized(stateLock) {
          connected = false
          connectedIdentifier = null
          transportState = if (enabled) "disconnected-auto-reconnect" else "disconnected-by-user"
          clearStreamsLocked()
        }
        emit(force = true)
        if (enabled) startAutoConnectLoop()
      }

      override fun bleSdkFeatureReady(identifier: String, feature: PolarBleApi.PolarBleSdkFeature) {
        if (!enabled) return
        when (feature) {
          PolarBleApi.PolarBleSdkFeature.FEATURE_HR -> startHrStream(identifier)
          PolarBleApi.PolarBleSdkFeature.FEATURE_POLAR_ONLINE_STREAMING -> startEcgStream(identifier)
          else -> Unit
        }
      }

      // Polar 8.1.0 keeps these provider callbacks abstract even when their features are disabled.
      override fun disInformationReceived(identifier: String, disInfo: DisInfo) = Unit
      override fun htsNotificationReceived(identifier: String, data: PolarHealthThermometerData) = Unit
    })
    api = created
    synchronized(stateLock) { transportState = "sdk-ready" }
    emit(force = true)
    return created
  }

  private fun startAutoConnectLoop() {
    if (!enabled || !permissionsGranted() || connected || autoConnectJob?.isActive == true) return
    autoConnectJob = scope.launch {
      while (isActive && enabled && !connected) {
        synchronized(stateLock) { transportState = "searching-nearby-h10" }
        emit(force = true)
        try {
          ensureApi().autoConnectToDevice(
              AUTO_CONNECT_RSSI_LIMIT_DBM,
              HEART_RATE_SERVICE_UUID,
              AUTO_CONNECT_TIMEOUT_SECONDS,
              TimeUnit.SECONDS,
              POLAR_DEVICE_TYPE_H10,
          )
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (error: Throwable) {
          synchronized(stateLock) { transportState = "h10-not-found-retrying" }
          marker("status=auto-connect-retry error=${error.javaClass.simpleName}")
          emit(force = true)
        }
        if (!connected) delay(AUTO_CONNECT_RETRY_DELAY_MS)
      }
    }
  }

  private fun startEcgStream(identifier: String) {
    if (!enabled || ecgJob?.isActive == true) return
    ecgJob = scope.launch {
      try {
        val settings = requireNotNull(api)
            .requestStreamSettings(identifier, PolarBleApi.PolarDeviceDataType.ECG)
            .maxSettings()
        val sampleRate = settings.settings[PolarSensorSetting.SettingType.SAMPLE_RATE]?.maxOrNull()
        val resolution = settings.settings[PolarSensorSetting.SettingType.RESOLUTION]?.maxOrNull()
        synchronized(stateLock) {
          ecgStreaming = true
          ecgSampleRateHz = sampleRate
          ecgResolutionBits = resolution
          transportState = "ecg-stream-starting"
        }
        emit(force = true)
        requireNotNull(api).startEcgStreaming(identifier, settings).collect { data ->
          val now = SystemClock.elapsedRealtime()
          val samples = data.samples.filterIsInstance<EcgSample>()
          if (samples.isNotEmpty()) {
            val voltages = samples.map(EcgSample::voltage)
            synchronized(stateLock) {
              if (firstEcgSampleElapsedMs == null) {
                ecgStreamEpoch += 1L
                firstEcgSampleElapsedMs = now
                firstEcgSampleCount = ecgSampleCount
              }
              ecgSampleCount += samples.size.toLong()
              latestEcgSampleElapsedMs = now
              transportState = "ecg-streaming"
              for (voltage in voltages) {
                recentEcgSamplesUv.addLast(voltage)
                while (recentEcgSamplesUv.size > RECENT_ECG_SAMPLE_LIMIT) recentEcgSamplesUv.removeFirst()
              }
              metrics = metricProcessor.pushEcg(voltages)
            }
          }
          emit(force = false)
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        synchronized(stateLock) {
          ecgStreaming = false
          transportState = "ecg-stream-error"
        }
        marker("status=ecg-stream-error error=${error.javaClass.simpleName}")
        emit(force = true)
      }
    }
  }

  private fun startHrStream(identifier: String) {
    if (!enabled || hrJob?.isActive == true) return
    hrJob = scope.launch {
      try {
        requireNotNull(api).startHrStreaming(identifier).collect { data ->
          val samples = data.samples
          if (samples.isEmpty()) return@collect
          val now = SystemClock.elapsedRealtime()
          synchronized(stateLock) {
            for (sample in samples) {
              metrics = metricProcessor.pushHeartRate(sample.hr.takeIf { it > 0 }, sample.rrsMs)
            }
            samples.asReversed().firstNotNullOfOrNull { sample -> sample.hr.takeIf { it > 0 } }
                ?.let { latest ->
                  heartRateBpm = latest
                  latestHeartRateSampleElapsedMs = now
                }
            samples.asReversed().firstNotNullOfOrNull { sample -> sample.rrsMs.lastOrNull() }
                ?.let { latest ->
                  rrIntervalMs = latest
                  latestRrSampleElapsedMs = now
                }
          }
          emit(force = false)
        }
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        marker("status=hr-stream-error error=${error.javaClass.simpleName}")
      }
    }
  }

  private fun startMonitor() {
    if (monitorJob?.isActive == true) return
    monitorJob = scope.launch {
      while (isActive && enabled) {
        emit(force = false)
        delay(STATUS_MONITOR_INTERVAL_MS)
      }
    }
  }

  private fun snapshotAt(nowElapsedMs: Long): PolarH10State = synchronized(stateLock) {
    val permissions = permissionsGranted()
    val readiness = PolarReadinessGate.evaluate(
        nowElapsedMs,
        PolarReadinessObservation(
            permissions,
            bluetoothPowered,
            connected,
            ecgStreaming,
            ecgSampleRateHz,
            ecgSampleCount,
            firstEcgSampleElapsedMs,
            latestEcgSampleElapsedMs,
        ),
    )
    val elapsedMs = firstEcgSampleElapsedMs?.let { first ->
      latestEcgSampleElapsedMs?.let { latest -> (latest - first).coerceAtLeast(0L) }
    } ?: 0L
    val observedRate = if (elapsedMs > 0L) {
      (ecgSampleCount - firstEcgSampleCount) * 1_000.0 / elapsedMs
    } else null
    PolarH10State(
        enabled = enabled,
        permissionsGranted = permissions,
        bluetoothPowered = bluetoothPowered,
        transportState = transportState,
        connected = connected,
        heartRateBpm = heartRateBpm,
        rrIntervalMs = rrIntervalMs,
        heartRateSampleAgeMs = latestHeartRateSampleElapsedMs
            ?.let { (nowElapsedMs - it).coerceAtLeast(0L) },
        rrSampleAgeMs = latestRrSampleElapsedMs?.let { (nowElapsedMs - it).coerceAtLeast(0L) },
        ecgStreaming = ecgStreaming,
        ecgSampleRateHz = ecgSampleRateHz,
        ecgResolutionBits = ecgResolutionBits,
        ecgSampleCount = ecgSampleCount,
        ecgStreamEpoch = ecgStreamEpoch,
        observedEcgSampleRateHz = observedRate,
        recentEcgSamplesUv = recentEcgSamplesUv.toList(),
        metrics = LinkedHashMap(metrics),
        readiness = readiness,
        mappings = mappings,
    )
  }

  private fun emit(force: Boolean) {
    val now = SystemClock.elapsedRealtime()
    if (!force && now - lastUiEmitElapsedMs < STATUS_UI_INTERVAL_MS) return
    val next = snapshotAt(now)
    lastUiEmitElapsedMs = now
    _state.value = next
    val markerKey = listOf(
        next.enabled,
        next.permissionsGranted,
        next.bluetoothPowered,
        next.transportState,
        next.connected,
        next.ecgStreaming,
        next.ecgSampleRateHz,
        next.readiness.reason,
        next.mappings,
    ).joinToString("|")
    if (markerKey != lastMarkerKey) {
      lastMarkerKey = markerKey
      marker(
          "status=state-updated enabled=${next.enabled} permissionsGranted=${next.permissionsGranted} " +
              "bluetoothPowered=${next.bluetoothPowered} transport=${next.transportState} " +
              "connected=${next.connected} ecgStreaming=${next.ecgStreaming} " +
              "sampleRateHz=${next.ecgSampleRateHz ?: 0} resolutionBits=${next.ecgResolutionBits ?: 0} " +
              "sampleCount=${next.ecgSampleCount} ready=${next.readiness.ready} " +
              "readinessReason=${next.readiness.reason} xMetric=${next.mappings.x.metricId} " +
              "yMetric=${next.mappings.y.metricId} rawEcgPersisted=false rrSeriesPersisted=false " +
              "deviceIdentifierLogged=false",
      )
    }
    if (next.enabled && next.ecgSampleCount > 0L &&
        (lastHealthMarkerElapsedMs == 0L ||
            now - lastHealthMarkerElapsedMs >= HEALTH_MARKER_INTERVAL_MS)) {
      lastHealthMarkerElapsedMs = now
      val finiteMetricIds = PolarMetricCatalog.metrics
          .map(PolarMetricDefinition::id)
          .filter { metricId -> next.metrics[metricId]?.isFinite() == true }
          .joinToString(",")
          .ifEmpty { "none" }
      marker(
          "status=stream-health sampleCount=${next.ecgSampleCount} " +
              "streamEpoch=${next.ecgStreamEpoch} " +
              "observedRateHz=${formatHealthNumber(next.observedEcgSampleRateHz)} " +
              "latestSampleAgeMs=${next.readiness.latestSampleAgeMs ?: -1L} " +
              "sampleRateHz=${next.ecgSampleRateHz ?: 0} " +
              "resolutionBits=${next.ecgResolutionBits ?: 0} " +
              "heartRateAvailable=${next.heartRateBpm != null} " +
              "rrAvailable=${next.rrIntervalMs != null} " +
              "heartRateAgeMs=${next.heartRateSampleAgeMs ?: -1L} " +
              "rrAgeMs=${next.rrSampleAgeMs ?: -1L} finiteMetrics=$finiteMetricIds " +
              "ready=${next.readiness.ready} rawEcgPersisted=false " +
              "rrSeriesPersisted=false deviceIdentifierLogged=false",
      )
    }
  }

  private fun clearStreamsLocked() {
    heartRateBpm = null
    rrIntervalMs = null
    latestHeartRateSampleElapsedMs = null
    latestRrSampleElapsedMs = null
    ecgStreaming = false
    ecgSampleRateHz = null
    ecgResolutionBits = null
    ecgSampleCount = 0L
    firstEcgSampleElapsedMs = null
    firstEcgSampleCount = 0L
    latestEcgSampleElapsedMs = null
    lastHealthMarkerElapsedMs = 0L
    recentEcgSamplesUv.clear()
    metricProcessor.reset()
    metrics = emptyMap()
  }

  private fun marker(detail: String) {
    Log.i(TAG, "$MARKER_PREFIX channel=polar-stream $detail")
  }

  private fun formatHealthNumber(value: Double?): String =
      value?.takeIf(Double::isFinite)?.let { String.format(java.util.Locale.US, "%.3f", it) }
          ?: "unavailable"

  companion object {
    const val SDK_VERSION = "8.1.0"
    private const val TAG = "AffectTrackerPolar"
    private const val MARKER_PREFIX = "AFFECT_TRACKER_VR"
    private const val RECENT_ECG_SAMPLE_LIMIT = 160
    private const val POLAR_DEVICE_TYPE_H10 = "H10"
    private const val HEART_RATE_SERVICE_UUID = "180D"
    private const val AUTO_CONNECT_RSSI_LIMIT_DBM = -100
    private const val AUTO_CONNECT_TIMEOUT_SECONDS = 8
    private const val AUTO_CONNECT_RETRY_DELAY_MS = 3_000L
    private const val STATUS_UI_INTERVAL_MS = 250L
    private const val STATUS_MONITOR_INTERVAL_MS = 1_000L
    private const val HEALTH_MARKER_INTERVAL_MS = 10_000L

    fun requiredRuntimePermissions(): Array<String> = arrayOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
    )
  }
}
