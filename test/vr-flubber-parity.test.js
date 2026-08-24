import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { createGoldenFixture } from "./generate-vr-flubber-golden.js";

test("checked-in VR Flubber fixture matches the canonical web implementation", async () => {
  const stored = JSON.parse(await readFile(new URL("../vr/contracts/flubber-golden-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(stored, createGoldenFixture());
});
