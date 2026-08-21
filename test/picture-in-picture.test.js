import test from "node:test";
import assert from "node:assert/strict";
import { pictureInPictureSupported, pictureInPictureWindowSize } from "../site/src/picture-in-picture.js";

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
