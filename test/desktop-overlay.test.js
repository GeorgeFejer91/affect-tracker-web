import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const overlayHtml = readFileSync(new URL("../desktop/overlay.html", import.meta.url), "utf8");
const desktopCss = readFileSync(new URL("../desktop/styles.css", import.meta.url), "utf8");

test("desktop overlay explicitly clears the root WebView canvas", () => {
  assert.match(overlayHtml, /<html[^>]+class="overlay-root"/);
  assert.match(
    desktopCss,
    /\.overlay-root, \.overlay-body, #overlay-surface[^}]+background: transparent !important;/s,
  );
});
