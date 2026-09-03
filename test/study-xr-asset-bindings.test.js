import assert from "node:assert/strict";
import test from "node:test";

import {
  matchingPortableAssetIds,
  sha256PortableFile,
} from "../site/src/study-xr/index.js";

test("portable media binding requires both exact bytes and exact content identity", async () => {
  const file = new Blob([new TextEncoder().encode("portable-media")], { type: "video/mp4" });
  const hash = await sha256PortableFile(file);
  assert.match(hash, /^[0-9a-f]{64}$/);

  const assets = [
    { assetId: "match", byteLength: file.size, sha256: hash },
    { assetId: "wrong-bytes", byteLength: file.size + 1, sha256: hash },
    { assetId: "wrong-hash", byteLength: file.size, sha256: "0".repeat(64) },
  ];
  assert.deepEqual(matchingPortableAssetIds(assets, file, hash), ["match"]);
  assert.equal(Object.isFrozen(matchingPortableAssetIds(assets, file, hash)), true);
});

test("portable media hashing and matching fail closed on malformed inputs", async () => {
  await assert.rejects(() => sha256PortableFile({ size: 1 }), /File or Blob/);
  assert.throws(
    () => matchingPortableAssetIds([{ assetId: "bad", byteLength: 1, sha256: "bad" }], { size: 1 }, "0".repeat(64)),
    /lowercase SHA-256/,
  );
  assert.throws(
    () => matchingPortableAssetIds([], { size: 1 }, "BAD"),
    /lowercase SHA-256/,
  );
});
