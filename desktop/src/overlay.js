import { nativeApi } from "./native.js";
import { createFlubberRenderer } from "./render.js";

const surface = document.querySelector("#overlay-surface");
const svg = document.querySelector("#overlay-flubber");
const renderFlubber = createFlubberRenderer(surface);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let editing = false;

function render(snapshot) {
  renderFlubber(snapshot, reducedMotion.matches);
  svg.setAttribute("aria-label", `Valence ${snapshot.currentX.toFixed(2)}, arousal ${snapshot.currentY.toFixed(2)}`);
}

surface.addEventListener("pointerdown", async (event) => {
  if (!editing || event.button !== 0) return;
  event.preventDefault();
  await nativeApi.beginOverlayDrag();
});

async function initialize() {
  render(await nativeApi.getSnapshot());
  await nativeApi.onSnapshot(render);
  await nativeApi.onOverlayEditing((value) => {
    editing = Boolean(value);
    document.body.classList.toggle("is-editing", editing);
  });
}

initialize();
