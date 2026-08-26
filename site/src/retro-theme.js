export const RETRO_THEME_ID = "windows-95";

export const RETRO_SOUND_URLS = Object.freeze({
  click: new URL("../assets/retro-ui/click.wav", import.meta.url).href,
  open: new URL("../assets/retro-ui/open.wav", import.meta.url).href,
  confirm: new URL("../assets/retro-ui/confirm.wav", import.meta.url).href,
  alert: new URL("../assets/retro-ui/alert.wav", import.meta.url).href,
});

export function retroCueForMessage(message) {
  const normalized = String(message ?? "").toLowerCase();
  if (/error|failed|could not|cannot|invalid|unsupported|denied|required|lost|cancelled/.test(normalized)) return "alert";
  if (/saved|exported|complete|connected|started|restored|updated|assigned|enabled|shown/.test(normalized)) return "confirm";
  return "open";
}

export function createRetroSoundboard({ AudioConstructor = globalThis.Audio, urls = RETRO_SOUND_URLS } = {}) {
  const sounds = new Map();

  function soundFor(cue) {
    if (typeof AudioConstructor !== "function" || !urls[cue]) return undefined;
    if (!sounds.has(cue)) {
      const audio = new AudioConstructor(urls[cue]);
      audio.preload = "auto";
      audio.volume = cue === "click" ? 0.16 : 0.22;
      sounds.set(cue, audio);
    }
    return sounds.get(cue);
  }

  function play(cue) {
    const audio = soundFor(cue);
    if (!audio) return false;
    try {
      audio.pause();
      audio.currentTime = 0;
      const result = audio.play();
      result?.catch?.(() => {});
      return true;
    } catch {
      return false;
    }
  }

  return { play };
}
