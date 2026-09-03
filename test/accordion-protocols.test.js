import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACCORDION_PROTOCOLS,
  normalizeAccordionState,
  setAccordionProtocolOpen,
  toggleAccordionProtocol,
  touchProtocolActive,
} from "../site/src/accordion-protocols.js";

const allOpen = {
  panelOpen: true,
  faceFlubberPanelOpen: true,
  experimentPanelOpen: true,
  screenCalibrationPanelOpen: true,
  touchPlaygroundPanelOpen: true,
  polarStreamPanelOpen: true,
  groundControlPanelOpen: true,
};

test("the seven UI accordions expose distinct protocol boundaries", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.deepEqual(Object.keys(ACCORDION_PROTOCOLS), ["settings", "face", "experiment", "calibration", "touch", "polar", "ground"]);
  const responsibilities = Object.values(ACCORDION_PROTOCOLS).flatMap((protocol) => protocol.responsibilities);
  assert.equal(new Set(responsibilities).size, responsibilities.length);
  assert.ok(ACCORDION_PROTOCOLS.settings.responsibilities.includes("manual-input"));
  assert.ok(ACCORDION_PROTOCOLS.face.responsibilities.includes("smartphone-affect-controller-host"));
  assert.ok(!ACCORDION_PROTOCOLS.face.responsibilities.includes("manual-input"));
  assert.equal(new Set(Object.values(ACCORDION_PROTOCOLS).map(({ domainModule }) => domainModule)).size, 7);
  for (const [protocolId, protocol] of Object.entries(ACCORDION_PROTOCOLS)) {
    assert.match(html, new RegExp(`id="${protocol.panelId}"[^>]*data-module-protocol="${protocolId}"`));
    const implementation = await readFile(new URL(`../site/src/${protocol.domainModule}`, import.meta.url), "utf8");
    assert.ok(implementation.length > 0);
  }
});

test("the accordion shell keeps exactly one module open", () => {
  assert.deepEqual(normalizeAccordionState(allOpen), {
    panelOpen: true,
    faceFlubberPanelOpen: false,
    experimentPanelOpen: false,
    screenCalibrationPanelOpen: false,
    touchPlaygroundPanelOpen: false,
    polarStreamPanelOpen: false,
    groundControlPanelOpen: false,
  });
  assert.deepEqual(setAccordionProtocolOpen(allOpen, "polar", true), {
    panelOpen: false,
    faceFlubberPanelOpen: false,
    experimentPanelOpen: false,
    screenCalibrationPanelOpen: false,
    touchPlaygroundPanelOpen: false,
    polarStreamPanelOpen: true,
    groundControlPanelOpen: false,
  });
  assert.deepEqual(toggleAccordionProtocol({ ...allOpen, panelOpen: false }, "experiment"), {
    panelOpen: false,
    faceFlubberPanelOpen: false,
    experimentPanelOpen: false,
    screenCalibrationPanelOpen: false,
    touchPlaygroundPanelOpen: false,
    polarStreamPanelOpen: false,
    groundControlPanelOpen: false,
  });
});

test("Touch/Trackpad is effective only in its open module or an active experiment lifecycle", () => {
  assert.equal(touchProtocolActive({ inputSource: "touch-trace", touchPlaygroundPanelOpen: true }), true);
  assert.equal(touchProtocolActive({ inputSource: "touch-trace", touchPlaygroundPanelOpen: false }), false);
  assert.equal(touchProtocolActive({
    inputSource: "touch-trace",
    touchPlaygroundPanelOpen: false,
    experimentPhase: "running",
  }), true);
  assert.equal(touchProtocolActive({
    inputSource: "manual",
    touchPlaygroundPanelOpen: true,
    experimentPhase: "running",
  }), false);
});
