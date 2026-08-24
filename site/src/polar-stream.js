import { clamp } from "./math.js";

export const POLAR_UUIDS = Object.freeze({
  heartRateService: "0000180d-0000-1000-8000-00805f9b34fb",
  heartRateMeasurement: "00002a37-0000-1000-8000-00805f9b34fb",
  batteryService: "0000180f-0000-1000-8000-00805f9b34fb",
  batteryLevel: "00002a19-0000-1000-8000-00805f9b34fb",
  pmdService: "fb005c80-02e7-f387-1cad-8acd2d8df0c8",
  pmdControl: "fb005c81-02e7-f387-1cad-8acd2d8df0c8",
  pmdData: "fb005c82-02e7-f387-1cad-8acd2d8df0c8",
});

export const POLAR_COMMANDS = Object.freeze({
  startEcg: Object.freeze([0x02, 0x00, 0x00, 0x01, 130, 0, 0x01, 0x01, 14, 0]),
  stopEcg: Object.freeze([0x03, 0x00]),
});

export const POLAR_METRICS = Object.freeze([
  Object.freeze({
    id: "excitement_score", label: "Excite-O-Meter score", shortLabel: "Excite-O-Meter", unit: "0–1",
    minimum: 0, maximum: 1, group: "Composite", detail: "Provisional RR + 10-beat RMSSD score",
  }),
  Object.freeze({
    id: "excitometer", label: "Activation composite", shortLabel: "Activation", unit: "0–1",
    minimum: 0, maximum: 1, group: "Composite", detail: "65% heart-rate rise + 35% lnRMSSD fall",
  }),
  Object.freeze({
    id: "rmssd", label: "Rolling RMSSD (uncorrected)", shortLabel: "HRV · RMSSD", unit: "ms",
    minimum: 0, maximum: 120, group: "HRV", detail: "Beat-to-beat short-term variability",
  }),
  Object.freeze({
    id: "ln_rmssd", label: "Rolling lnRMSSD (uncorrected)", shortLabel: "HRV · lnRMSSD", unit: "ln(ms)",
    minimum: 1.5, maximum: 5.5, group: "HRV", detail: "Natural log of rolling RMSSD",
  }),
  Object.freeze({
    id: "sdnn", label: "Rolling SDNN (uncorrected)", shortLabel: "HRV · SDNN", unit: "ms",
    minimum: 0, maximum: 120, group: "HRV", detail: "Standard deviation of recent RR intervals",
  }),
  Object.freeze({
    id: "ecg_local_power", label: "Local ECG power (5 s)", shortLabel: "Local ECG power", unit: "µV²",
    minimum: 10_000, maximum: 2_250_000, group: "ECG", detail: "Five-second mean squared amplitude",
  }),
  Object.freeze({
    id: "heart_rate", label: "Heart rate", shortLabel: "Heart rate", unit: "bpm",
    minimum: 45, maximum: 160, group: "Vitals", detail: "Current H10 heart-rate notification",
  }),
  Object.freeze({
    id: "rr_interval", label: "Latest RR interval", shortLabel: "Latest RR", unit: "ms",
    minimum: 400, maximum: 1_300, group: "Vitals", detail: "Latest uncorrected beat interval",
  }),
  Object.freeze({
    id: "ecg_rms", label: "ECG RMS amplitude", shortLabel: "ECG RMS", unit: "µV",
    minimum: 100, maximum: 1_500, group: "ECG", detail: "Square root of local ECG power",
  }),
  Object.freeze({
    id: "ecg_peak_to_peak", label: "ECG peak-to-peak", shortLabel: "ECG range", unit: "µV",
    minimum: 200, maximum: 4_000, group: "ECG", detail: "Five-second maximum minus minimum",
  }),
]);

const METRIC_BY_ID = new Map(POLAR_METRICS.map((metric) => [metric.id, metric]));
const ECG_WINDOW_SAMPLES = 130 * 5;
const RR_WINDOW_VALUES = 300;
const GATT_CONNECT_RETRY_DELAY_MS = 300;

export class PolarStreamError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "PolarStreamError";
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value ?? []);
}

function unsigned64Le(bytes, offset) {
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(bytes[offset + index]);
  return result;
}

function signed24Le(bytes, offset) {
  const value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return value & 0x800000 ? value - 0x1000000 : value;
}

export function decodePolarEcg(value) {
  const bytes = bytesFrom(value);
  if (bytes.length < 10) throw new PolarStreamError("PMD_FRAME_TOO_SHORT", "Polar PMD frame is shorter than its header.");
  if (bytes[0] !== 0x00 || bytes[9] !== 0x00) return null;
  const payload = bytes.subarray(10);
  if (payload.length % 3 !== 0) {
    throw new PolarStreamError("PMD_INVALID_ECG", "Polar ECG payload is not a sequence of signed 24-bit samples.");
  }
  const microvolts = [];
  for (let offset = 0; offset < payload.length; offset += 3) microvolts.push(signed24Le(payload, offset));
  return { sensorTimestampNs: unsigned64Le(bytes, 1).toString(), microvolts };
}

export function decodePolarHeartRate(value) {
  const bytes = bytesFrom(value);
  if (bytes.length < 2) return { beatsPerMinute: 0, rrIntervalsMs: [] };
  const flags = bytes[0];
  const wideHeartRate = Boolean(flags & 0x01);
  const beatsPerMinute = wideHeartRate && bytes.length >= 3
    ? bytes[1] | (bytes[2] << 8)
    : bytes[1];
  let cursor = wideHeartRate ? 3 : 2;
  if (flags & 0x08) cursor += 2;
  const rrIntervalsMs = [];
  if (flags & 0x10) {
    while (cursor + 1 < bytes.length) {
      rrIntervalsMs.push((bytes[cursor] | (bytes[cursor + 1] << 8)) * (1000 / 1024));
      cursor += 2;
    }
  }
  return { beatsPerMinute, rrIntervalsMs };
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function rmssd(values) {
  if (values.length < 2) return undefined;
  let squaredDifferenceSum = 0;
  for (let index = 1; index < values.length; index += 1) {
    squaredDifferenceSum += (values[index] - values[index - 1]) ** 2;
  }
  return Math.sqrt(squaredDifferenceSum / (values.length - 1));
}

class RunningStats {
  constructor() {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
  }

  push(value) {
    if (!Number.isFinite(value)) return;
    this.count += 1;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    this.m2 += delta * (value - this.mean);
  }

  zScore(value, { population = false } = {}) {
    if (this.count < 2) return 0;
    const divisor = population ? this.count : this.count - 1;
    const standardDeviation = Math.sqrt(this.m2 / divisor);
    return standardDeviation < 1e-6 ? 0 : (value - this.mean) / standardDeviation;
  }
}

// Abramowitz and Stegun 7.1.26, matching the legacy Excite-O-Meter implementation.
function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * scaled);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-(scaled ** 2)));
  return 0.5 * (1 + sign * erf);
}

export class PolarMetricProcessor {
  constructor({ ecgCapacity = ECG_WINDOW_SAMPLES, rrCapacity = RR_WINDOW_VALUES } = {}) {
    this.ecgCapacity = Math.max(2, Math.floor(ecgCapacity));
    this.rrCapacity = Math.max(2, Math.floor(rrCapacity));
    this.reset();
  }

  reset() {
    this.ecg = [];
    this.rr = [];
    this.values = {};
    this.totalEcgSamples = 0;
    this.excitementRecentRr = [];
    this.excitementRrStats = new RunningStats();
    this.excitementRmssdStats = new RunningStats();
    this.activationHeartRateStats = new RunningStats();
    this.activationLnRmssdStats = new RunningStats();
  }

  pushEcg(samples) {
    const finite = Array.from(samples ?? [], Number).filter(Number.isFinite);
    if (!finite.length) return this.snapshot();
    this.totalEcgSamples += finite.length;
    this.ecg.push(...finite);
    if (this.ecg.length > this.ecgCapacity) this.ecg.splice(0, this.ecg.length - this.ecgCapacity);
    const meanSquare = this.ecg.reduce((sum, value) => sum + value * value, 0) / this.ecg.length;
    this.values.ecg_local_power = meanSquare;
    this.values.ecg_rms = Math.sqrt(meanSquare);
    this.values.ecg_peak_to_peak = Math.max(...this.ecg) - Math.min(...this.ecg);
    return this.snapshot();
  }

  pushHeartRate({ beatsPerMinute, rrIntervalsMs } = {}) {
    if (Number.isFinite(beatsPerMinute) && beatsPerMinute > 0) this.values.heart_rate = Number(beatsPerMinute);
    const accepted = Array.from(rrIntervalsMs ?? [], Number).filter((value) => Number.isFinite(value) && value > 0);
    if (accepted.length) {
      this.values.rr_interval = accepted.at(-1);
      for (const rrInterval of accepted) {
        this.rr.push(rrInterval);
        if (this.rr.length > this.rrCapacity) this.rr.shift();
        this.updateExciteOMeter(rrInterval);

        const rollingRmssd = rmssd(this.rr);
        const rollingSdnn = sampleStandardDeviation(this.rr);
        if (rollingRmssd !== undefined) {
          this.values.rmssd = rollingRmssd;
          this.values.ln_rmssd = rollingRmssd > 0 ? Math.log(rollingRmssd) : 0;
          this.updateActivationComposite(
            Number.isFinite(beatsPerMinute) && beatsPerMinute > 0 ? Number(beatsPerMinute) : 60_000 / rrInterval,
            this.values.ln_rmssd,
          );
        }
        if (rollingSdnn !== undefined) this.values.sdnn = rollingSdnn;
      }
    }
    return this.snapshot();
  }

  updateExciteOMeter(rrInterval) {
    this.excitementRecentRr.push(rrInterval);
    if (this.excitementRecentRr.length > 10) this.excitementRecentRr.shift();
    if (this.excitementRecentRr.length < 10) return;
    const rollingRmssd = rmssd(this.excitementRecentRr);
    if (!Number.isFinite(rollingRmssd)) return;
    this.excitementRrStats.push(rrInterval);
    this.excitementRmssdStats.push(rollingRmssd);
    if (this.excitementRrStats.count < 10 || this.excitementRmssdStats.count < 10) return;
    const rrPercentile = normalCdf(this.excitementRrStats.zScore(rrInterval, { population: true }));
    const rmssdPercentile = normalCdf(this.excitementRmssdStats.zScore(rollingRmssd, { population: true }));
    this.values.excitement_score = clamp(1 - (rrPercentile + rmssdPercentile) / 2, 0, 1);
  }

  updateActivationComposite(heartRate, lnRmssd) {
    this.activationHeartRateStats.push(heartRate);
    this.activationLnRmssdStats.push(lnRmssd);
    if (this.activationHeartRateStats.count < 20 || this.activationLnRmssdStats.count < 20) return;
    const activation = 0.65 * this.activationHeartRateStats.zScore(heartRate)
      - 0.35 * this.activationLnRmssdStats.zScore(lnRmssd);
    this.values.excitometer = clamp(1 / (1 + Math.exp(-activation)), 0, 1);
  }

  snapshot() {
    return {
      values: { ...this.values },
      ecgWindowSamples: this.ecg.length,
      rrWindowValues: this.rr.length,
      totalEcgSamples: this.totalEcgSamples,
      readiness: {
        excitementPairs: this.excitementRrStats.count,
        activationPairs: this.activationHeartRateStats.count,
      },
    };
  }
}

export function polarMetricDefinition(id) {
  return METRIC_BY_ID.get(id);
}

export function defaultPolarMappings() {
  return {
    valence: { metric: "manual", minimum: -1, maximum: 1, invert: false },
    arousal: { metric: "manual", minimum: -1, maximum: 1, invert: false },
  };
}

export function normalizePolarMappings(value = {}) {
  const defaults = defaultPolarMappings();
  return Object.fromEntries(["valence", "arousal"].map((axis) => {
    const candidate = value?.[axis] ?? defaults[axis];
    const definition = polarMetricDefinition(candidate.metric);
    if (!definition) return [axis, { ...defaults[axis] }];
    const requestedMinimum = Number(candidate.minimum);
    const requestedMaximum = Number(candidate.maximum);
    const minimum = Number.isFinite(requestedMinimum) ? requestedMinimum : definition.minimum;
    const maximum = Number.isFinite(requestedMaximum) && requestedMaximum > minimum
      ? requestedMaximum
      : (definition.maximum > minimum ? definition.maximum : minimum + 1);
    return [axis, {
      metric: definition.id,
      minimum,
      maximum,
      invert: candidate.invert === true,
    }];
  }));
}

export function normalizePolarMetric(value, mapping) {
  const minimum = Number(mapping?.minimum);
  const maximum = Number(mapping?.maximum);
  if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) {
    return undefined;
  }
  const normalized = clamp(((value - minimum) / (maximum - minimum)) * 2 - 1, -1, 1);
  return mapping.invert ? -normalized : normalized;
}

export function polarWebBluetoothSupport({
  secureContext = globalThis.isSecureContext,
  navigatorObject = globalThis.navigator,
} = {}) {
  if (!secureContext) return { supported: false, questBrowser: false, reason: "Web Bluetooth requires HTTPS or localhost." };
  const userAgent = String(navigatorObject?.userAgent ?? "");
  const questBrowser = /OculusBrowser|Meta Quest Browser/i.test(userAgent);
  if (questBrowser) {
    return {
      supported: false,
      questBrowser: true,
      reason: "Meta Quest Browser does not provide a usable Web Bluetooth device chooser. Connect from desktop Chromium; sideloaded browsers are not a supported study path.",
    };
  }
  if (typeof navigatorObject?.bluetooth?.requestDevice !== "function") {
    return {
      supported: false,
      questBrowser,
      reason: questBrowser
        ? "Meta Quest Browser does not expose a working Web Bluetooth chooser. Use desktop Chromium or an explicitly tested sideloaded browser."
        : "This browser does not expose Web Bluetooth. Use a compatible Chrome, Edge, or Chromium build.",
    };
  }
  return {
    supported: true,
    questBrowser: false,
    reason: "Web Bluetooth is available. Connection still requires a user-selected Polar H10.",
  };
}

function normalizeBluetoothError(error, questBrowser = false) {
  if (error instanceof PolarStreamError) return error;
  if (error?.name === "NotFoundError") {
    return new PolarStreamError(
      "BLUETOOTH_CHOOSER_CANCELLED",
      questBrowser ? "Meta Quest Browser did not provide a usable H10 chooser." : "No Polar H10 was selected.",
      true,
    );
  }
  if (error?.name === "SecurityError" || error?.name === "NotAllowedError") {
    return new PolarStreamError("BLUETOOTH_PERMISSION_DENIED", "Bluetooth permission was not granted.", true);
  }
  if (error?.name === "NetworkError" || error?.name === "AbortError") {
    return new PolarStreamError("BLUETOOTH_CONNECTION_FAILED", "The Polar H10 Bluetooth connection failed.", true);
  }
  return new PolarStreamError("BROWSER_BLE_FAILED", error?.message || "The browser could not connect to the Polar H10.", true);
}

export class PolarH10BrowserSession {
  constructor({ navigatorObject = globalThis.navigator, timer = globalThis, secureContext = globalThis.isSecureContext } = {}) {
    this.navigatorObject = navigatorObject;
    this.timer = timer;
    this.secureContext = secureContext;
    this.processor = new PolarMetricProcessor();
    this.resetConnectionState();
    this.boundPmd = (event) => this.handlePmd(event);
    this.boundHeartRate = (event) => this.handleHeartRate(event);
    this.boundControl = (event) => this.handleControl(event);
    this.boundDisconnected = () => this.handleDisconnected();
  }

  resetConnectionState() {
    this.device = null;
    this.server = null;
    this.control = null;
    this.pmdData = null;
    this.heartRate = null;
    this.connected = false;
    this.disconnecting = false;
  }

  async connect(onEvent) {
    const support = polarWebBluetoothSupport({ secureContext: this.secureContext, navigatorObject: this.navigatorObject });
    if (!support.supported) throw new PolarStreamError("WEB_BLUETOOTH_UNAVAILABLE", support.reason);
    if (this.device || this.connected) throw new PolarStreamError("BROWSER_BLE_BUSY", "Disconnect the current H10 before choosing another.", true);
    this.onEvent = onEvent;
    this.processor.reset();
    try {
      this.emit({ kind: "status", message: "Choose your Polar H10 in the browser Bluetooth prompt…" });
      this.device = await this.navigatorObject.bluetooth.requestDevice({
        filters: [{ namePrefix: "Polar H10" }],
        optionalServices: [POLAR_UUIDS.pmdService, POLAR_UUIDS.heartRateService, POLAR_UUIDS.batteryService],
      });
      this.device.addEventListener("gattserverdisconnected", this.boundDisconnected);
      this.emit({ kind: "status", message: "Connecting to Polar PMD ECG…" });
      this.server = await this.connectGatt();
      const pmdService = await this.server.getPrimaryService(POLAR_UUIDS.pmdService);
      this.control = await pmdService.getCharacteristic(POLAR_UUIDS.pmdControl);
      this.pmdData = await pmdService.getCharacteristic(POLAR_UUIDS.pmdData);
      this.control.addEventListener("characteristicvaluechanged", this.boundControl);
      this.pmdData.addEventListener("characteristicvaluechanged", this.boundPmd);
      await this.pmdData.startNotifications();
      await this.control.startNotifications();
      try {
        const heartRateService = await this.server.getPrimaryService(POLAR_UUIDS.heartRateService);
        this.heartRate = await heartRateService.getCharacteristic(POLAR_UUIDS.heartRateMeasurement);
        this.heartRate.addEventListener("characteristicvaluechanged", this.boundHeartRate);
        await this.heartRate.startNotifications();
      } catch {
        this.heartRate = null;
      }
      await this.writeControl(POLAR_COMMANDS.startEcg);
      let batteryPercent;
      try {
        const batteryService = await this.server.getPrimaryService(POLAR_UUIDS.batteryService);
        const battery = await batteryService.getCharacteristic(POLAR_UUIDS.batteryLevel);
        batteryPercent = bytesFrom(await battery.readValue())[0];
      } catch {
        batteryPercent = undefined;
      }
      this.connected = true;
      this.emit({ kind: "connection", connected: true, batteryPercent, message: "Polar H10 ECG streaming at 130 Hz" });
    } catch (error) {
      await this.disconnect({ emit: false });
      const normalized = normalizeBluetoothError(error, support.questBrowser);
      this.onEvent = null;
      throw normalized;
    }
  }

  async connectGatt() {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.device.gatt.connect();
      } catch (error) {
        lastError = error;
        if (!(error?.name === "NetworkError" || error?.name === "AbortError") || attempt === 1) throw error;
        this.emit({ kind: "status", message: "Retrying the browser GATT connection…" });
        await new Promise((resolve) => this.timer.setTimeout(resolve, GATT_CONNECT_RETRY_DELAY_MS));
      }
    }
    throw lastError;
  }

  async writeControl(command) {
    const value = Uint8Array.from(command);
    if (typeof this.control.writeValueWithResponse === "function") await this.control.writeValueWithResponse(value);
    else await this.control.writeValue(value);
  }

  handlePmd(event) {
    try {
      const frame = decodePolarEcg(event.target.value);
      if (!frame) return;
      const snapshot = this.processor.pushEcg(frame.microvolts);
      this.emit({ kind: "ecg", ...frame, snapshot });
      this.emit({ kind: "metrics", snapshot });
    } catch (error) {
      this.emit({ kind: "error", message: `Skipped malformed Polar ECG frame: ${error.message}` });
    }
  }

  handleHeartRate(event) {
    const frame = decodePolarHeartRate(event.target.value);
    this.emit({ kind: "metrics", snapshot: this.processor.pushHeartRate(frame) });
  }

  handleControl(event) {
    const bytes = bytesFrom(event.target.value);
    if (bytes.length >= 4 && bytes[0] === 0xf0 && bytes[3] !== 0) {
      this.emit({ kind: "error", message: `Polar PMD rejected the ECG command (status ${bytes[3]}).` });
    }
  }

  async disconnect({ emit = true } = {}) {
    if (this.disconnecting) return;
    this.disconnecting = true;
    const wasConnected = this.connected;
    try {
      if (this.server?.connected && this.control) {
        try { await this.writeControl(POLAR_COMMANDS.stopEcg); } catch { /* best effort */ }
      }
      await this.stopCharacteristic(this.pmdData, this.boundPmd);
      await this.stopCharacteristic(this.control, this.boundControl);
      await this.stopCharacteristic(this.heartRate, this.boundHeartRate);
      this.device?.removeEventListener("gattserverdisconnected", this.boundDisconnected);
      if (this.server?.connected) this.server.disconnect();
    } finally {
      this.resetConnectionState();
    }
    if (emit && (wasConnected || this.onEvent)) this.emit({ kind: "connection", connected: false, message: "Polar H10 disconnected" });
    if (emit) this.onEvent = null;
  }

  async stopCharacteristic(characteristic, listener) {
    if (!characteristic) return;
    characteristic.removeEventListener("characteristicvaluechanged", listener);
    try { await characteristic.stopNotifications(); } catch { /* best effort */ }
  }

  handleDisconnected() {
    if (this.disconnecting) return;
    this.resetConnectionState();
    this.emit({ kind: "connection", connected: false, message: "The Polar H10 left Bluetooth range or disconnected" });
    this.onEvent = null;
  }

  emit(event) {
    if (typeof this.onEvent === "function") this.onEvent(event);
  }
}

export function createPolarH10BrowserSession(options) {
  return new PolarH10BrowserSession(options);
}
