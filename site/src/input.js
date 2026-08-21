import { clamp } from "./math.js";

export const DIRECTION_BY_KEY = new Map([
  ["ArrowLeft", "left"],
  ["a", "left"],
  ["A", "left"],
  ["ArrowRight", "right"],
  ["d", "right"],
  ["D", "right"],
  ["ArrowUp", "up"],
  ["w", "up"],
  ["W", "up"],
  ["ArrowDown", "down"],
  ["s", "down"],
  ["S", "down"],
]);

export function directionForKey(key) {
  return DIRECTION_BY_KEY.get(key) ?? null;
}

export function applyStep(targetX, targetY, direction, amount = 0.1) {
  let x = targetX;
  let y = targetY;
  if (direction === "left") x -= amount;
  if (direction === "right") x += amount;
  if (direction === "up") y += amount;
  if (direction === "down") y -= amount;
  return { x: clamp(x), y: clamp(y) };
}

export function continuousMovement(heldDirections, deltaSeconds, speed = 0.8) {
  const horizontal = Number(heldDirections.has("right")) - Number(heldDirections.has("left"));
  const vertical = Number(heldDirections.has("up")) - Number(heldDirections.has("down"));
  return {
    x: horizontal * speed * deltaSeconds,
    y: vertical * speed * deltaSeconds,
  };
}

export function normalizeWheel(deltaY) {
  return clamp(-deltaY * 0.0015, -0.15, 0.15);
}

export function constrainWidgetPosition(x, y, size, viewportWidth, viewportHeight) {
  const radius = Math.max(1, size / 2);
  const minimumX = Math.min(radius, viewportWidth / 2);
  const maximumX = Math.max(viewportWidth - radius, viewportWidth / 2);
  const minimumY = Math.min(radius, viewportHeight / 2);
  const maximumY = Math.max(viewportHeight - radius, viewportHeight / 2);
  return {
    x: clamp(x, minimumX, maximumX),
    y: clamp(y, minimumY, maximumY),
  };
}

export function isNativeFormControl(element) {
  return Boolean(element?.closest?.("button, input, select, textarea, [contenteditable='true']"));
}
