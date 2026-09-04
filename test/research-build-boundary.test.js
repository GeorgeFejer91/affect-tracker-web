import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Research production builds have closed, Research-only input boundaries", async () => {
  const [vite, pages] = await Promise.all([
    read("desktop/vite.config.js"),
    read("scripts/build-research-pages.js"),
  ]);
  assert.match(vite, /publicDir:\s*false/u);
  assert.match(vite, /input:\s*\{\s*research:\s*resolve\(desktopRoot,\s*"index\.html"\)/u);
  assert.doesNotMatch(vite, /site\/vendor|overlay\.html|study\.html|webxr/iu);
  assert.match(pages, /resolve\(sourceRoot,\s*"src",\s*"research"\)/u);
  assert.doesNotMatch(pages, /vendor|overlay\.html|study\.html|webxr/iu);
});

test("Windows alpha artifacts pin their build actions and bind the commit, installer, runtime pin, and source archive", async () => {
  const workflows = await Promise.all([
    read(".github/workflows/desktop.yml"),
    read(".github/workflows/desktop-release.yml"),
  ]);
  for (const workflow of workflows) {
    const actionReferences = [...workflow.matchAll(/^\s*uses:\s*[^@\s#]+@([^\s#]+)/gmu)];
    assert.ok(actionReferences.length >= 5, "expected the complete desktop action set");
    for (const [, reference] of actionReferences) assert.match(reference, /^[0-9a-f]{40}$/u);
    assert.match(workflow, /cargo test --locked --manifest-path src-tauri\/Cargo\.toml --all-features/u);
    assert.match(workflow, /cargo test --locked --manifest-path src-tauri\/Cargo\.toml --no-default-features/u);
    assert.match(workflow, /vlc-3\.0\.23\.tar\.xz/u);
    assert.match(workflow, /e891cae6aa3ccda69bf94173d5105cbc55c7a7d9b1d21b9b21666e69eff3e7e0/u);
    assert.match(workflow, /artifact-provenance\.json/u);
    assert.match(workflow, /commit = \$env:GITHUB_SHA/u);
    assert.match(workflow, /repository = \$env:GITHUB_REPOSITORY/u);
    assert.match(workflow, /workflowRef = \$env:GITHUB_WORKFLOW_REF/u);
    assert.match(workflow, /runId = \$env:GITHUB_RUN_ID/u);
    assert.match(workflow, /nativeRuntimePin = \[ordered\]@\{/u);
    assert.match(workflow, /git status --porcelain=v1 --untracked-files=normal/u);
    assert.match(workflow, /windows-x64-\$\{\{ github\.sha \}\}/u);
    assert.match(workflow, /native-media\/libvlc-runtime-v1\.json/u);
  }
});

test("the local Windows installer command always enables the required libVLC runtime gate", async () => {
  const [packageJson, script] = await Promise.all([
    read("package.json"),
    read("scripts/build-research-desktop.js"),
  ]);
  assert.match(packageJson, /"desktop:bundle": "node scripts\/build-research-desktop\.js"/u);
  assert.match(script, /process\.platform !== "win32" \|\| process\.arch !== "x64"/u);
  assert.match(script, /AFFECT_RESEARCH_REQUIRE_LIBVLC_RUNTIME: "1"/u);
  assert.match(script, /process\.env\.ComSpec/u);
  assert.match(script, /pnpm exec tauri build --bundles nsis/u);
});
