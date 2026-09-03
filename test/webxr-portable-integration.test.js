import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import initStudyCore, {
  publishStudyJsonV1,
  validateResultManifestJsonV1,
  WasmStudyAuthorityV1,
} from "../site/vendor/study-core/affect_tracker_study_core.js";
import { createDefaultStudy } from "../site/src/study/schema.js";
import {
  BrowserStudySession,
  createRunConfiguration,
} from "../site/src/study/participant-runner.js";
import {
  createXrPanelState,
  portableSampleSchedule,
  projectPortableBlockToXrPanel,
  reduceXrPanelController,
  resolvePortableVideoBlock,
} from "../site/src/study-xr/index.js";
import { createTestRunOwnership } from "./helpers/fake-web-locks.js";

await initStudyCore({
  module_or_path: await readFile(new URL(
    "../site/vendor/study-core/affect_tracker_study_core_bg.wasm",
    import.meta.url,
  )),
});

const core = {
  implementation: "wasm",
  validateResultManifest(manifest) {
    return JSON.parse(validateResultManifestJsonV1(JSON.stringify(manifest)));
  },
  createAuthority(study, configuration, generation) {
    return new WasmStudyAuthorityV1(
      JSON.stringify(study),
      JSON.stringify(configuration),
      BigInt(generation),
    );
  },
};

function context(session, panelState) {
  const block = session.currentBlock();
  const questionnaire = block.type === "questionnaire"
    ? session.study.questionnaires.find(({ questionnaireId }) => questionnaireId === block.questionnaireId)
    : undefined;
  return { block, questionnaire, state: panelState };
}

test("portable XR panels remain downstream of the shared WASM run authority", async () => {
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(createDefaultStudy({
    studyId: "portable-webxr-integration",
    title: "Portable WebXR integration",
  }))));
  const configuration = createRunConfiguration(published, {
    platform: "webXr",
    runId: "run-portable-webxr-integration",
    capabilities: [
      "affectInput",
      "durableJournal",
      "faceFlubberComparison",
      "immersivePanels",
      "questionnaires",
    ],
  });
  const session = new BrowserStudySession({
    core,
    study: published,
    configuration,
    generation: 3,
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize();
    assert.equal(session.currentBlock().blockId, "instructions");

    let panelState = createXrPanelState({ block: session.currentBlock() });
    const comparison = projectPortableBlockToXrPanel({
      block: session.currentBlock(),
      state: panelState,
      affectSnapshot: { currentX: 0.25, currentY: -0.5, phase: 1.75 },
    });
    assert.strictEqual(comparison.presentation.face.snapshot, comparison.presentation.flubber.snapshot);
    let reduced = reduceXrPanelController({
      ...context(session, panelState),
      intent: { type: "activate" },
      affectSnapshot: { currentX: 0.25, currentY: -0.5, phase: 1.75 },
    });
    await session.dispatch(reduced.effect.command);
    assert.equal(session.currentBlock().blockId, "pre-run-questionnaire");

    const questionnaire = session.study.questionnaires[0];
    panelState = createXrPanelState({ block: session.currentBlock(), questionnaire });
    reduced = reduceXrPanelController({ ...context(session, panelState), intent: { type: "activate" } });
    panelState = reduced.state;
    reduced = reduceXrPanelController({ ...context(session, panelState), intent: { type: "next" } });
    assert.equal(reduced.effect.command.type, "submitQuestionnaire");
    await session.dispatch(reduced.effect.command);
    await session.advance();
    assert.equal(session.currentBlock().blockId, "main-instructions");

    panelState = createXrPanelState({ block: session.currentBlock() });
    reduced = reduceXrPanelController({ ...context(session, panelState), intent: { type: "activate" } });
    await session.dispatch(reduced.effect.command);
    assert.equal(session.currentBlock().blockId, "completion");

    panelState = createXrPanelState({ block: session.currentBlock() });
    reduced = reduceXrPanelController({ ...context(session, panelState), intent: { type: "activate" } });
    await session.dispatch(reduced.effect.command);
    assert.equal(session.state().phase, "awaitingFinalization");

    const result = await session.finalize();
    assert.equal(result.manifest.completionStatus, "completed");
    assert.equal(result.manifest.protocolHash, published.protocolHash);
    assert.ok(result.events.some(({ payload }) => payload.type === "questionnaireSubmitted"));
    assert.ok(result.csv.includes("questionnaireSubmitted"));
  } finally {
    await session.close();
  }
});

test("portable content video remains downstream of the WASM timeline and sample authority", async () => {
  const draft = createDefaultStudy({
    studyId: "portable-webxr-video",
    title: "Portable WebXR video",
  });
  draft.media = [{
    assetId: "verified-video",
    sha256: "b".repeat(64),
    byteLength: 12,
    mimeType: "video/mp4",
    container: "mp4",
    durationMs: 4_000,
    hasAudio: false,
    projection: "equirectangular180",
    stereoLayout: "sideBySideLeftRight",
    defaultClip: { startMs: 500, endMs: 3_500 },
    requiredCapabilities: ["contentAddressedMedia", "equirectangular180", "sideBySideStereo"],
  }];
  draft.sections[1].trials[0].blocks = [{
    type: "video",
    blockId: "rated-video",
    purpose: "stimulus",
    source: { kind: "contentAsset", assetId: "verified-video", clip: { startMs: 1_000, endMs: 3_000 } },
    collectAffect: true,
  }];
  const published = JSON.parse(publishStudyJsonV1(JSON.stringify(draft)));
  const configuration = createRunConfiguration(published, {
    platform: "webXr",
    runId: "run-portable-webxr-video",
  });
  const file = new Blob([new Uint8Array(12)], { type: "video/mp4" });
  const bindings = new Map([["verified-video", file]]);
  const resolved = resolvePortableVideoBlock(published, draft.sections[1].trials[0].blocks[0], bindings);
  assert.deepEqual(resolved.descriptor.clip, { startMs: 1_000, endMs: 3_000, durationMs: 2_000 });
  const session = new BrowserStudySession({
    core,
    study: published,
    configuration,
    assetBindings: bindings,
    runOwnership: createTestRunOwnership(),
  });

  try {
    await session.initialize();
    await session.advance();
    await session.submitQuestionnaire("pre-run", [{
      type: "acknowledgement",
      itemId: "ready",
      acknowledged: true,
    }]);
    await session.advance();
    assert.equal(session.currentBlock().blockId, "rated-video");

    await session.reportMedia(0, true);
    const schedule = portableSampleSchedule({
      nowMs: 1_000,
      nextDueMs: null,
      sampleRateHz: 20,
      active: true,
      authorityPlaying: session.state().mediaTimelineAnchor.playing,
      pending: false,
    });
    assert.equal(schedule.due, true);
    await session.recordAffect({
      currentValence: 0.25,
      currentArousal: -0.5,
      targetValence: 0.3,
      targetArousal: -0.4,
    });
    await session.reportMedia(2_000, false);
    await assert.rejects(
      () => session.recordAffect({ currentValence: 0, currentArousal: 0 }),
      /media playback must be active/,
    );
    await session.advance();
    assert.equal(session.currentBlock().blockId, "completion");
    await session.advance();
    const result = await session.finalize();
    assert.ok(result.events.some(({ payload }) => payload.type === "mediaTimelineUpdated" && payload.anchor.playing));
    assert.ok(result.events.some(({ payload }) => payload.type === "affectSampleRecorded"));
  } finally {
    await session.close();
  }
});

test("the WebXR entrypoint exposes portable panels and fail-closed content media", async () => {
  const [page, runtime, runtimePreflight] = await Promise.all([
    readFile(new URL("../site/webxr.html", import.meta.url), "utf8"),
    readFile(new URL("../site/src/webxr-study.js", import.meta.url), "utf8"),
    readFile(new URL("../site/src/study-xr/runtime-preflight.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="run-mode-legacy"[^>]*checked/);
  assert.match(page, /id="run-mode-portable"/);
  assert.match(page, /id="portable-study-file"[^>]*accept="application\/json,\.json"/);
  assert.match(page, /id="portable-media-files"[^>]*multiple/);
  assert.match(page, /id="download-manifest"/);
  assert.match(page, /unsupported media fails[\s\S]*rather than being skipped/i);
  assert.match(runtime, /if \(state\.runnerMode === "portable"\) return startPortableStudy\(\)/);
  assert.match(runtime, /evaluatePortableWebXrRuntimePreflight/);
  assert.match(runtime, /await waitForPortableController\(requestedSession\)/);
  assert.match(runtime, /new BrowserStudySession/);
  assert.match(runtime, /await browserSession\.initialize\(\{ calibrationPoint \}\)/);
  assert.match(runtime, /portableControllerSnapshot/);
  assert.match(runtime, /resolvePortableVideoBlock/);
  assert.match(runtime, /probePortableMediaFile/);
  assert.match(runtime, /queuePortableTimeline/);
  assert.match(runtime, /portableSampleSchedule/);
  assert.match(runtime, /new EvidenceWriteWatchdog/);
  assert.match(runtime, /guardPortableEvidenceWrite/);
  assert.match(runtime, /evidenceWriteBlocked/);
  assert.match(runtime, /abandonPendingJournalOutcome/);
  assert.match(runtime, /partialRetention/);
  assert.match(runtime, /portableStereoUvTransform/);
  assert.match(runtime, /panelView\.transform\.inverse\.matrix/);
  assert.match(runtimePreflight, /PORTABLE_WEBXR_RUNTIME_PROFILE = "content-asset-media-v1"/);
  assert.match(runtimePreflight, /"video"/);
});
