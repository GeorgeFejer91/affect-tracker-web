import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRetroSoundboard, retroCueForMessage, RETRO_SOUND_URLS, RETRO_THEME_ID } from "../site/src/retro-theme.js";

const readSiteFile = (name) => readFile(new URL(`../site/${name}`, import.meta.url), "utf8");

test("the Windows 95 skin remains a browser-local presentation preference", async () => {
  const [html, app, bootstrap, css] = await Promise.all([
    readSiteFile("index.html"),
    readSiteFile("src/app.js"),
    readSiteFile("src/theme-bootstrap.js"),
    readSiteFile("styles.css"),
  ]);

  assert.equal(RETRO_THEME_ID, "windows-95");
  assert.match(html, /id="retro-theme-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="retro-toast"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /src="\.\/src\/theme-bootstrap\.js\?v=retro-2"/);
  assert.match(html, /src="\.\/src\/app\.js\?v=[^"]+"/);
  assert.match(app, /from "\.\/retro-theme\.js\?v=retro-2"/);
  assert.match(bootstrap, /affect-tracker-web\/preferences-v1/);
  assert.match(bootstrap, /stored\?\.retroTheme === true/);
  assert.match(app, /retroTheme: parsed\.retroTheme === true/);
  assert.match(app, /retroTheme: state\.retroTheme/);
  assert.match(app, /recordEvent\("appearance", "theme-change", "windows-95"/);
  assert.match(css, /html\[data-theme="windows-95"\]/);
  assert.match(css, /"MS Sans Serif"/);
  assert.match(css, /#000080/);
  assert.match(css, /#008080/);
  assert.doesNotMatch(app, /settings\.retroTheme/);
  assert.doesNotMatch(app, /closest\("button, a, summary, input, select, textarea"\)/);
});

test("retro messages map to stable interface cues", () => {
  assert.equal(retroCueForMessage("Settings exported."), "confirm");
  assert.equal(retroCueForMessage("Connection failed."), "alert");
  assert.equal(retroCueForMessage("Choose an input."), "open");
  assert.equal(retroCueForMessage("3"), null);
  assert.equal(retroCueForMessage("Valence changed."), null);
});

test("the local CC0 soundboard reuses preloaded low-volume players", () => {
  const instances = [];
  class FakeAudio {
    constructor(url) {
      this.url = url;
      this.currentTime = 8;
      this.playCount = 0;
      this.pauseCount = 0;
      instances.push(this);
    }
    pause() { this.pauseCount += 1; }
    play() { this.playCount += 1; return Promise.resolve(); }
  }

  const soundboard = createRetroSoundboard({
    AudioConstructor: FakeAudio,
    urls: { click: "click.wav", open: "open.wav" },
  });
  assert.equal(soundboard.play("click"), true);
  assert.equal(soundboard.play("click"), true);
  assert.equal(soundboard.play("missing"), false);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].preload, "auto");
  assert.equal(instances[0].volume, 0.16);
  assert.equal(instances[0].currentTime, 0);
  assert.equal(instances[0].pauseCount, 2);
  assert.equal(instances[0].playCount, 2);
});

test("all retro sound assets and their CC0 notice are packaged locally", async () => {
  const expectedHashes = {
    click: "0d80e2c82426316b140b0686e10f83924ef794e9a9dfe13aaaa794b18200b048",
    open: "89f5746144f41a5dbf889d017ab549a6246922662321ddf25a76b4de69f7819c",
    confirm: "d724a9922ce3d978069b02401f6aafdb3fd247a1a55d54a7e3e3e062e400f44c",
    alert: "c0c10c006967920edbb29ca364099a42ad3459a823d75f18a90181ac36774bf2",
  };
  for (const [cue, url] of Object.entries(RETRO_SOUND_URLS)) {
    assert.match(url, new RegExp(`/assets/retro-ui/${cue === "click" ? "click" : cue === "open" ? "open" : cue === "confirm" ? "confirm" : "alert"}\\.wav$`));
    const file = new URL(`../site/assets/retro-ui/${cue}.wav`, import.meta.url);
    assert.ok((await stat(file)).size > 1000);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), expectedHashes[cue]);
  }
  const notice = await readSiteFile("assets/retro-ui/NOTICE.md");
  const license = await readSiteFile("assets/retro-ui/LICENSE.txt");
  assert.match(notice, /Kenney UI Audio/);
  assert.match(notice, /8c3d81b9159d058c444f89d12d518276b0b09345/);
  assert.match(notice, /No Microsoft audio/);
  assert.match(license, /Creative Commons Zero, CC0/);
  assert.match(license, /creativecommons\.org\/publicdomain\/zero\/1\.0/);
});
