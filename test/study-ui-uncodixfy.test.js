import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("Study Studio keeps the restrained Uncodixfy presentation contract", async () => {
  const [css, app, page, remoteCss, remotePage] = await Promise.all([
    read("../site/study.css"),
    read("../site/src/study/app.js"),
    read("../site/study.html"),
    read("../site/study-remote.css"),
    read("../site/study-remote.html"),
  ]);
  const source = `${css}\n${app}\n${page}\n${remoteCss}\n${remotePage}`;

  for (const prohibited of [
    /(?:linear|radial|conic)-gradient\s*\(/i,
    /backdrop-filter\s*:/i,
    /box-shadow\s*:/i,
    /text-transform\s*:\s*uppercase/i,
    /letter-spacing\s*:/i,
    /class=["'][^"']*\b(?:hero|eyebrow|glass|pill|dashboard-card)\b/i,
  ]) {
    assert.doesNotMatch(source, prohibited);
  }

  const radii = [...css.matchAll(/border-radius\s*:\s*([0-9.]+)rem/gi)]
    .map((match) => Number(match[1]));
  assert.ok(radii.length > 0);
  assert.ok(radii.every((radius) => radius <= 0.75), "container radii must stay at or below 12 px");

  assert.match(app, /<nav class="study-nav" aria-label="Study designer steps">/);
  assert.match(app, /<label class="study-field"><span>Study title<\/span>/);
  assert.match(app, /<table class="study-table">/);
  assert.match(app, /aria-label="Move (?:section|trial group|block|question) (?:up|down)"/);
  assert.doesNotMatch(
    app,
    /aria-label="Move (?:section|trial group|block|question) (?:up|down)"[^>]*>[↑↓]<\/button>/,
  );
  assert.match(app, /aria-label="Move block up"[^>]*>Up<\/button>/);
  assert.match(app, /aria-label="Move question down"[^>]*>Down<\/button>/);
});

test("the tiny flow editor exposes only the portable ordering and one-condition branch surface", async () => {
  const [app, flowModel] = await Promise.all([
    read("../site/src/study/app.js"),
    read("../site/src/study/flow-model.js"),
  ]);

  assert.match(app, /Trial-group order/);
  assert.match(app, /Randomization moves the complete group and never separates its blocks\./);
  assert.match(app, /<th>Trial groups<\/th>/);
  assert.match(app, /There is no hidden cross-participant “evenly present” counter\./);
  assert.match(app, /Universal v1 does not randomize questions inside a questionnaire\./);

  for (const type of [
    "acknowledgement",
    "singleChoice",
    "multipleChoice",
    "likert",
    "vas",
    "numeric",
    "affect2d",
  ]) {
    assert.match(flowModel, new RegExp(`case \\\"${type}\\\"`));
  }
  assert.match(app, /Earlier required answer/);
  assert.match(app, /If the answer matches, this complete trial group runs\./);
  assert.match(app, /data-branch-component="valence"/);
  assert.match(app, /data-branch-component="arousal"/);
  assert.match(app, /Reset expected answer/);
  assert.match(app, /The stored condition has not been changed\./);
  assert.match(app, /Acknowledgement, choice, Likert, VAS, numeric, and 2D affect questions are supported\./);
  assert.match(app, /Remove misplaced completion/);
  assert.match(app, /Required terminal/);
  assert.doesNotMatch(app, /(?:script|jump target|expression tree) editor/i);
});

test("Face and Flubber remains an instruction presentation, not a flow type", async () => {
  const [schema, app] = await Promise.all([
    read("../site/src/study/schema.js"),
    read("../site/src/study/app.js"),
  ]);

  assert.match(schema, /PORTABLE_BLOCK_TYPES[\s\S]*"instruction"/);
  assert.doesNotMatch(
    schema.match(/PORTABLE_BLOCK_TYPES[\s\S]*?\]\);/)?.[0] ?? "",
    /faceFlubberComparison/,
  );
  assert.match(app, /block\.type === "instruction"[\s\S]*faceFlubberComparison/);
  assert.match(app, /This does not create a stimulus or collect data\./);
  assert.match(app, /Instruction to preview/);
  assert.match(app, /preferredInstructionPreview\(instructions, selectedPreviewInstructionId\)/);
});
