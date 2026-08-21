import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  pictureInPictureOptions,
  pictureInPictureSupported,
  pictureInPictureWindowSize,
} from "../site/src/picture-in-picture.js";

test("Document Picture-in-Picture support is feature-detected", () => {
  assert.equal(pictureInPictureSupported({}), false);
  assert.equal(pictureInPictureSupported({ documentPictureInPicture: {} }), false);
  assert.equal(pictureInPictureSupported({ documentPictureInPicture: { requestWindow() {} } }), true);
});

test("Picture-in-Picture opening size is finite and bounded", () => {
  assert.equal(pictureInPictureWindowSize(Number.NaN), 240);
  assert.equal(pictureInPictureWindowSize(120), 180);
  assert.equal(pictureInPictureWindowSize(321.6), 322);
  assert.equal(pictureInPictureWindowSize(900), 640);
});

test("Picture-in-Picture requests the smallest browser chrome and a square viewport", () => {
  assert.deepEqual(pictureInPictureOptions(320), {
    width: 320,
    height: 320,
    disallowReturnToOpener: true,
  });
});

test("Picture-in-Picture surfaces under site control are transparent and borderless", async () => {
  const css = await readFile(new URL("../site/styles.css", import.meta.url), "utf8");
  assert.match(css, /html:has\(\.pip-body\)[\s\S]*background: transparent !important/);
  assert.match(css, /\.pip-widget \{[^}]*width: 100vw;[^}]*height: 100vh;[^}]*outline: none !important;[^}]*filter: none;/);
  assert.doesNotMatch(css, /\.pip-body[^}]*background:\s*#000/);
});
