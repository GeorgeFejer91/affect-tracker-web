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
