import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePolarEcg,
  decodePolarHeartRate,
  normalizePolarMappings,
  normalizePolarMetric,
  POLAR_COMMANDS,
  POLAR_METRICS,
  POLAR_UUIDS,
  PolarH10BrowserSession,
  PolarMetricProcessor,
  polarWebBluetoothSupport,
} from "../site/src/polar-stream.js";

test("Polar PMD ECG decoder reads timestamp and signed 24-bit microvolt samples", () => {
  const frame = Uint8Array.from([
    0x00,
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    0x00,
    0xff, 0xff, 0x7f,
    0x00, 0x00, 0x80,
    0xff, 0xff, 0xff,
    0x00, 0x00, 0x00,
  ]);

  assert.deepEqual(decodePolarEcg(frame), {
    sensorTimestampNs: "72623859790382856",
    microvolts: [8_388_607, -8_388_608, -1, 0],
  });
});

test("Polar PMD decoder ignores non-ECG frame types", () => {
  const frame = new Uint8Array(10);
  frame[9] = 1;
  assert.equal(decodePolarEcg(frame), null);
});

test("heart-rate decoder supports uint8, uint16, energy, and RR fields", () => {
  assert.deepEqual(decodePolarHeartRate(Uint8Array.from([0x10, 72, 0x00, 0x04])), {
    beatsPerMinute: 72,
    rrIntervalsMs: [1000],
  });
  assert.deepEqual(decodePolarHeartRate(Uint8Array.from([0x19, 0x2c, 0x01, 0x34, 0x12, 0x00, 0x02])), {
    beatsPerMinute: 300,
    rrIntervalsMs: [500],
  });
});

test("metric processor bounds raw windows and derives ECG and RR metrics", () => {
  const processor = new PolarMetricProcessor({ ecgCapacity: 4, rrCapacity: 3 });
  processor.pushEcg([1, 2, 3, 4, 5]);
  const snapshot = processor.pushHeartRate({ beatsPerMinute: 60, rrIntervalsMs: [1000, 1100, 900] });

  assert.equal(snapshot.ecgWindowSamples, 4);
  assert.equal(snapshot.rrWindowValues, 3);
  assert.equal(snapshot.totalEcgSamples, 5);
  assert.equal(snapshot.values.heart_rate, 60);
  assert.equal(snapshot.values.rr_interval, 900);
  assert.equal(snapshot.values.ecg_peak_to_peak, 3);
  assert.equal(snapshot.values.ecg_local_power, (4 + 9 + 16 + 25) / 4);
  assert.equal(snapshot.values.ecg_rms, Math.sqrt((4 + 9 + 16 + 25) / 4));
  assert.equal(snapshot.values.rmssd, Math.sqrt((10_000 + 40_000) / 2));
  assert.equal(snapshot.values.sdnn, 100);
});

test("metric modules expose Excite-O-Meter, HRV, and local ECG power choices", () => {
  const ids = new Set(POLAR_METRICS.map((metric) => metric.id));
  for (const id of ["excitement_score", "excitometer", "rmssd", "ln_rmssd", "ecg_local_power"]) {
    assert.ok(ids.has(id), `${id} should be assignable`);
  }
});

test("experimental composites wait for their live baselines and remain neutral for a constant session", () => {
  const processor = new PolarMetricProcessor();
  let snapshot;
  for (let index = 0; index < 18; index += 1) {
    snapshot = processor.pushHeartRate({ beatsPerMinute: 75, rrIntervalsMs: [800] });
  }
  assert.equal(snapshot.values.excitement_score, undefined);

  snapshot = processor.pushHeartRate({ beatsPerMinute: 75, rrIntervalsMs: [800] });
  assert.ok(Math.abs(snapshot.values.excitement_score - 0.5) < 1e-6);
  assert.equal(snapshot.values.excitometer, undefined);

  processor.pushHeartRate({ beatsPerMinute: 75, rrIntervalsMs: [800] });
  snapshot = processor.pushHeartRate({ beatsPerMinute: 75, rrIntervalsMs: [800] });
  assert.ok(Math.abs(snapshot.values.excitometer - 0.5) < 1e-6);
  assert.equal(snapshot.readiness.excitementPairs, 12);
  assert.equal(snapshot.readiness.activationPairs, 20);
});

test("Polar metric mappings normalize, clamp, and reverse assigned axes", () => {
  const mappings = normalizePolarMappings({
    valence: { metric: "heart_rate", minimum: 60, maximum: 100, invert: true },
    arousal: { metric: "unknown", minimum: 1, maximum: 2 },
  });

  assert.deepEqual(mappings.valence, { metric: "heart_rate", minimum: 60, maximum: 100, invert: true });
  assert.equal(mappings.arousal.metric, "manual");
  assert.equal(normalizePolarMetric(60, mappings.valence), 1);
  assert.equal(normalizePolarMetric(80, mappings.valence), -0);
  assert.equal(normalizePolarMetric(120, mappings.valence), -1);
  assert.equal(normalizePolarMetric(undefined, mappings.valence), undefined);
});

test("Web Bluetooth support requires a secure compatible desktop browser", () => {
  const compatible = { userAgent: "Chromium", bluetooth: { requestDevice() {} } };
  assert.equal(polarWebBluetoothSupport({ secureContext: true, navigatorObject: compatible }).supported, true);
  assert.match(polarWebBluetoothSupport({ secureContext: false, navigatorObject: compatible }).reason, /HTTPS|localhost/);
  assert.match(polarWebBluetoothSupport({ secureContext: true, navigatorObject: { userAgent: "Firefox" } }).reason, /does not expose/);

  const quest = polarWebBluetoothSupport({
    secureContext: true,
    navigatorObject: { userAgent: "Mozilla/5.0 OculusBrowser/40.0", bluetooth: { requestDevice() {} } },
  });
  assert.equal(quest.supported, false);
  assert.equal(quest.questBrowser, true);
  assert.match(quest.reason, /Meta Quest Browser/);
});

test("browser session reports the exact failing GATT stage and a competing-session recovery hint", async () => {
  class Characteristic extends EventTarget {
    async startNotifications() {
      if (this.failStart) throw new DOMException("GATT operation failed for unknown reason.", "NetworkError");
      return this;
    }
    async stopNotifications() { return this; }
  }
  const control = new Characteristic();
  const pmdData = new Characteristic();
  pmdData.failStart = true;
  const server = {
    connected: true,
    async getPrimaryService() {
      return { getCharacteristic: async (uuid) => uuid === POLAR_UUIDS.pmdControl ? control : pmdData };
    },
    disconnect() { this.connected = false; },
  };
  class Device extends EventTarget {}
  const device = new Device();
  device.gatt = { connect: async () => server };
  const session = new PolarH10BrowserSession({
    navigatorObject: { userAgent: "Chromium test", bluetooth: { requestDevice: async () => device } },
    secureContext: true,
  });

  await assert.rejects(
    session.connect(() => {}),
    (error) => error.code === "BLUETOOTH_PMD_DATA_NOTIFY_FAILED"
      && /ECG data notifications failed/.test(error.message)
      && /another browser tab/.test(error.message),
  );
  assert.equal(server.connected, false);
});

test("browser session fails closed on rejected or missing ECG start acknowledgements", async () => {
  async function attempt(controlResponse) {
    class Characteristic extends EventTarget {
      async startNotifications() { return this; }
      async stopNotifications() { return this; }
      async writeValueWithResponse(value) {
        if (value[0] === POLAR_COMMANDS.startEcg[0] && controlResponse) {
          queueMicrotask(() => {
            this.value = new DataView(controlResponse.buffer, controlResponse.byteOffset, controlResponse.byteLength);
            this.dispatchEvent(new Event("characteristicvaluechanged"));
          });
        }
      }
    }
    const control = new Characteristic();
    const pmdData = new Characteristic();
    const server = {
      connected: true,
      async getPrimaryService(uuid) {
        if (uuid !== POLAR_UUIDS.pmdService) throw new DOMException("Service unavailable", "NotFoundError");
        return { getCharacteristic: async (characteristicUuid) => characteristicUuid === POLAR_UUIDS.pmdControl ? control : pmdData };
      },
      disconnect() { this.connected = false; },
    };
    class Device extends EventTarget {}
    const device = new Device();
    device.gatt = { connect: async () => server };
    const session = new PolarH10BrowserSession({
      navigatorObject: { userAgent: "Chromium test", bluetooth: { requestDevice: async () => device } },
      secureContext: true,
      controlResponseTimeoutMs: 5,
      firstEcgTimeoutMs: 50,
    });
    return session.connect(() => {});
  }

  await assert.rejects(
    attempt(Uint8Array.from([0xf0, 0x02, 0x00, 0x05, 0x00])),
    (error) => error.code === "PMD_COMMAND_REJECTED" && /another Polar app or tab/.test(error.message),
  );
  await assert.rejects(
    attempt(null),
    (error) => error.code === "PMD_CONTROL_TIMEOUT" && /did not acknowledge/.test(error.message),
  );
  await assert.rejects(
    attempt(Uint8Array.from([0xf0, 0x02, 0x00, 0x00, 0x00])),
    (error) => error.code === "PMD_FIRST_ECG_TIMEOUT" && /no live ECG packet/.test(error.message),
  );
});

test("two simulated minutes of 130 Hz ECG remain bounded and report healthy stream timing", () => {
  let nowMs = 0;
  const events = [];
  const session = new PolarH10BrowserSession({ now: () => nowMs });
  session.onEvent = (event) => events.push(event);
  const frame = new Uint8Array(10 + 13 * 3);
  frame[0] = 0x00;
  frame[9] = 0x00;
  for (let index = 0; index < 13; index += 1) frame[10 + index * 3] = index + 1;

  for (let notification = 0; notification < 1_200; notification += 1) {
    nowMs += 100;
    session.handlePmd({ target: { value: frame } });
  }

  const health = events.at(-2).streamHealth;
  assert.equal(health.sampleCount, 15_600);
  assert.equal(health.frameCount, 1_200);
  assert.ok(health.observedSampleRateHz > 129 && health.observedSampleRateHz < 131);
  assert.equal(health.maximumGapMs, 100);
  assert.equal(session.processor.ecg.length, 650);
  assert.ok(Object.values(session.processor.snapshot().values).every(Number.isFinite));
});

test("browser session requests an H10, starts ECG notifications, emits metrics, and stops cleanly", async () => {
  class FakeCharacteristic extends EventTarget {
    constructor(value = new Uint8Array()) {
      super();
      this.value = new DataView(value.buffer, value.byteOffset, value.byteLength);
      this.writes = [];
      this.started = 0;
      this.stopped = 0;
    }

    async startNotifications() { this.started += 1; return this; }
    async stopNotifications() { this.stopped += 1; return this; }
    async writeValueWithResponse(value) {
      this.writes.push([...value]);
      this.onWrite?.(value);
    }
    async readValue() { return this.value; }
    notify(value) {
      this.value = new DataView(value.buffer, value.byteOffset, value.byteLength);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }

  const control = new FakeCharacteristic();
  const pmdData = new FakeCharacteristic();
  const heartRate = new FakeCharacteristic();
  const battery = new FakeCharacteristic(Uint8Array.from([87]));
  const pmdFrame = Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 200, 0, 0]);
  control.onWrite = (value) => {
    if (value[0] !== POLAR_COMMANDS.startEcg[0]) return;
    queueMicrotask(() => {
      control.notify(Uint8Array.from([0xf0, 0x02, 0x00, 0x00, 0x00]));
      pmdData.notify(pmdFrame);
    });
  };
  const services = new Map([
    [POLAR_UUIDS.pmdService, { getCharacteristic: async (uuid) => uuid === POLAR_UUIDS.pmdControl ? control : pmdData }],
    [POLAR_UUIDS.heartRateService, { getCharacteristic: async () => heartRate }],
    [POLAR_UUIDS.batteryService, { getCharacteristic: async () => battery }],
  ]);
  const server = {
    connected: true,
    getPrimaryService: async (uuid) => services.get(uuid),
    disconnect() { this.connected = false; },
  };
  class FakeDevice extends EventTarget {}
  const device = new FakeDevice();
  device.gatt = { connect: async () => server };
  let chooserOptions;
  const navigatorObject = {
    userAgent: "Chromium test",
    bluetooth: {
      async requestDevice(options) { chooserOptions = options; return device; },
    },
  };
  const events = [];
  const session = new PolarH10BrowserSession({ navigatorObject, secureContext: true });

  await session.connect((event) => events.push(event));
  assert.deepEqual(chooserOptions.filters, [{ namePrefix: "Polar H10" }]);
  assert.ok(chooserOptions.optionalServices.includes(POLAR_UUIDS.pmdService));
  assert.deepEqual(control.writes[0], [...POLAR_COMMANDS.startEcg]);
  assert.equal(pmdData.started, 1);
  assert.equal(control.started, 1);
  assert.equal(heartRate.started, 1);
  assert.ok(events.some((event) => event.kind === "connection" && event.connected && event.batteryPercent === 87));
  assert.ok(events.some((event) => event.kind === "ecg" && event.streamHealth.sampleCount === 2));

  heartRate.notify(Uint8Array.from([0x10, 60, 0x00, 0x04]));
  pmdData.notify(pmdFrame);
  assert.ok(events.some((event) => event.kind === "metrics" && event.snapshot.values.heart_rate === 60));
  assert.ok(events.some((event) => event.kind === "ecg" && event.microvolts.length === 2));

  await session.disconnect();
  assert.deepEqual(control.writes.at(-1), [...POLAR_COMMANDS.stopEcg]);
  assert.equal(server.connected, false);
  assert.equal(pmdData.stopped, 1);
  assert.ok(events.some((event) => event.kind === "connection" && !event.connected));
});
