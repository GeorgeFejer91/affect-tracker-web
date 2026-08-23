import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const launcher = readFileSync(
  new URL(
    "../vr/app/src/main/java/io/github/georgefejer91/affecttracker/vr/AffectTrackerLauncherActivity.kt",
    import.meta.url,
  ),
  "utf8",
);

test("Quest launcher scrolls variable content and keeps its action bar reachable", () => {
  const scrollStart = launcher.indexOf("Modifier.weight(1f).verticalScroll(rememberScrollState())");
  const firstRunSetting = launcher.indexOf('Text("Show X/Y affect coordinates")');
  const runSummary = launcher.indexOf('Text(\n            "This run:');
  const runExplanation = launcher.indexOf('"These switches apply to this run only. Start opens LSL');
  const actionBar = launcher.indexOf(
    "Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth())",
  );
  const startButton = launcher.indexOf("Button(onClick = startExperiment");

  assert.ok(scrollStart >= 0, "launcher needs a bounded vertical scroll region");
  assert.ok(scrollStart < firstRunSetting, "run settings must be inside the scrollable region");
  assert.ok(firstRunSetting < runSummary, "run summary follows the variable settings");
  assert.ok(runSummary < runExplanation, "run explanation belongs with the scrollable settings");
  assert.ok(runExplanation < actionBar, "the fixed action bar must follow all variable-height content");
  assert.ok(actionBar < startButton, "Start experiment must remain in the fixed action bar");
});
