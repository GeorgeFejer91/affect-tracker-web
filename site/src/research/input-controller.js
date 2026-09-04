import {
  createInputBindingPreset,
  validateInputBindingV1,
} from "./contracts.js";

const DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function signature(action) {
  if (action.kind === "keyboard") return `keyboard:${action.code}`;
  if (action.kind === "mouseButton") return `mouseButton:${action.button}`;
  if (action.kind === "wheel") return `wheel:${action.direction}`;
  if (action.kind === "gamepadButton") return `gamepadButton:${action.button}`;
  throw new TypeError("Unsupported digital input action.");
}

function directionDelta(direction, stepSize) {
  if (direction === "up") return [0, stepSize];
  if (direction === "down") return [0, -stepSize];
  if (direction === "left") return [-stepSize, 0];
  if (direction === "right") return [stepSize, 0];
  throw new TypeError("Input direction is invalid.");
}

function actionFromKeyboard(event) {
  if (typeof event?.code !== "string" || !/^[A-Za-z0-9]+$/u.test(event.code)) return null;
  return { kind: "keyboard", code: event.code };
}

function actionFromMouse(event) {
  if (!Number.isInteger(event?.button) || event.button < 0 || event.button > 31) return null;
  return { kind: "mouseButton", button: event.button };
}

function actionFromWheel(event) {
  const x = Number(event?.deltaX) || 0;
  const y = Number(event?.deltaY) || 0;
  if (x === 0 && y === 0) return null;
  if (Math.abs(x) > Math.abs(y)) return { kind: "wheel", direction: x < 0 ? "left" : "right" };
  return { kind: "wheel", direction: y < 0 ? "up" : "down" };
}

export function capturedDigitalAction(event) {
  if (event?.type === "keydown") return actionFromKeyboard(event);
  if (event?.type === "mousedown" || event?.type === "pointerdown") return actionFromMouse(event);
  if (event?.type === "wheel") return actionFromWheel(event);
  if (event?.type === "gamepadbutton") {
    if (!Number.isInteger(event.button) || event.button < 0 || event.button > 63) return null;
    return { kind: "gamepadButton", button: event.button };
  }
  return null;
}

export function withCustomDigitalAction(binding, direction, action) {
  if (!DIRECTIONS.includes(direction)) throw new TypeError("Choose up, down, left, or right before capture.");
  const current = validateInputBindingV1(binding);
  if (current.kind !== "digital") throw new TypeError("Custom action capture is available for digital bindings only.");
  const nextAction = action && typeof action === "object" ? structuredClone(action) : null;
  if (!nextAction) throw new TypeError("No supported physical action was captured.");
  const nextSignature = signature(nextAction);
  for (const candidate of DIRECTIONS) {
    if (candidate !== direction && signature(current.directions[candidate]) === nextSignature) {
      throw new TypeError(`That physical action is already assigned to ${candidate}.`);
    }
  }
  return validateInputBindingV1({
    ...structuredClone(current),
    preset: "custom",
    directions: { ...structuredClone(current.directions), [direction]: nextAction },
  });
}

export class ResearchInputController {
  constructor({
    binding = createInputBindingPreset(),
    onState = () => {},
    onInputEdge = () => {},
    now = () => performance.now(),
    getGamepads = () => navigator.getGamepads?.() ?? [],
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
    deadzone = 0.12,
  } = {}) {
    this.binding = validateInputBindingV1(binding);
    this.onState = onState;
    this.onInputEdge = onInputEdge;
    this.now = now;
    this.getGamepads = getGamepads;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.deadzone = Math.max(0, Math.min(0.5, Number(deadzone)));
    this.state = { x: 0, y: 0, inputActive: false, anchorMonotonicMs: this.now() };
    this.activeActions = new Set();
    this.gamepadButtons = new Map();
    this.frameId = null;
    this.element = null;
    this.captureDirection = null;
    this.captureCallback = null;
    this.listeners = {
      keydown: (event) => this.handleKeyDown(event),
      keyup: (event) => this.handleKeyUp(event),
      mousedown: (event) => this.handleMouseDown(event),
      mouseup: (event) => this.handleMouseUp(event),
      wheel: (event) => this.handleWheel(event),
      pointerdown: (event) => this.handlePointer(event),
      pointermove: (event) => this.handlePointer(event),
      pointerup: (event) => this.handlePointer(event),
      pointercancel: (event) => this.handlePointer(event),
      lostpointercapture: (event) => this.handlePointer(event),
    };
  }

  setBinding(binding) {
    this.binding = validateInputBindingV1(binding);
    this.activeActions.clear();
    this.gamepadButtons.clear();
    this.#emitState(false);
    this.#syncGamepadPolling();
    return this.binding;
  }

  attach(element = globalThis.window) {
    if (!element?.addEventListener) throw new TypeError("Input controller requires an event target.");
    this.detach();
    this.element = element;
    element.addEventListener("keydown", this.listeners.keydown);
    element.addEventListener("keyup", this.listeners.keyup);
    element.addEventListener("mousedown", this.listeners.mousedown);
    element.addEventListener("mouseup", this.listeners.mouseup);
    element.addEventListener("wheel", this.listeners.wheel, { passive: false });
    element.addEventListener("pointerdown", this.listeners.pointerdown);
    element.addEventListener("pointermove", this.listeners.pointermove);
    element.addEventListener("pointerup", this.listeners.pointerup);
    element.addEventListener("pointercancel", this.listeners.pointercancel);
    element.addEventListener("lostpointercapture", this.listeners.lostpointercapture);
    this.#syncGamepadPolling();
    return this;
  }

  detach() {
    if (this.element) {
      this.element.removeEventListener("keydown", this.listeners.keydown);
      this.element.removeEventListener("keyup", this.listeners.keyup);
      this.element.removeEventListener("mousedown", this.listeners.mousedown);
      this.element.removeEventListener("mouseup", this.listeners.mouseup);
      this.element.removeEventListener("wheel", this.listeners.wheel);
      this.element.removeEventListener("pointerdown", this.listeners.pointerdown);
      this.element.removeEventListener("pointermove", this.listeners.pointermove);
      this.element.removeEventListener("pointerup", this.listeners.pointerup);
      this.element.removeEventListener("pointercancel", this.listeners.pointercancel);
      this.element.removeEventListener("lostpointercapture", this.listeners.lostpointercapture);
    }
    this.element = null;
    if (this.frameId !== null) this.cancelFrame(this.frameId);
    this.frameId = null;
    this.activeActions.clear();
  }

  beginCapture(direction, callback) {
    if (!DIRECTIONS.includes(direction)) throw new TypeError("Capture direction is invalid.");
    if (this.binding.kind !== "digital") throw new TypeError("Only digital bindings support custom capture.");
    if (typeof callback !== "function") throw new TypeError("Capture callback is required.");
    this.captureDirection = direction;
    this.captureCallback = callback;
  }

  cancelCapture() {
    this.captureDirection = null;
    this.captureCallback = null;
  }

  handleKeyDown(event) {
    if (event?.repeat) return false;
    const action = actionFromKeyboard(event);
    if (!action) return false;
    if (this.#capture(action, event)) return true;
    return this.#digitalPress(action, event);
  }

  handleKeyUp(event) {
    const action = actionFromKeyboard(event);
    return action ? this.#digitalRelease(action) : false;
  }

  handleMouseDown(event) {
    const action = actionFromMouse(event);
    if (!action) return false;
    if (this.#capture(action, event)) return true;
    return this.#digitalPress(action, event);
  }

  handleMouseUp(event) {
    const action = actionFromMouse(event);
    return action ? this.#digitalRelease(action) : false;
  }

  handleWheel(event) {
    const action = actionFromWheel(event);
    if (!action) return false;
    if (this.#capture(action, event)) return true;
    const handled = this.#digitalPress(action, event, { momentary: true });
    if (handled) this.#digitalRelease(action);
    return handled;
  }

  handlePointer(event, bounds = event?.currentTarget?.getBoundingClientRect?.()) {
    if (this.binding.kind !== "absolute" || this.binding.preset !== "pointerGrid") return false;
    if (["pointerup", "pointercancel", "lostpointercapture"].includes(event?.type)) {
      event.preventDefault?.();
      this.#emitState(false, "pointer:absolute");
      return true;
    }
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
    if (event.type === "pointermove" && event.buttons === 0) return false;
    if (event.type === "pointerdown" && Number.isInteger(event.pointerId)) {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    }
    const normalizedX = clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1);
    const normalizedY = clamp(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    this.state.x = this.binding.axes.x.invert ? -normalizedX : normalizedX;
    this.state.y = this.binding.axes.y.invert ? -normalizedY : normalizedY;
    event.preventDefault?.();
    this.#emitState(true, "pointer:absolute");
    return true;
  }

  pollGamepads() {
    const pads = [...(this.getGamepads() ?? [])].filter(Boolean);
    if (this.binding.kind === "analog") {
      const pad = pads[0];
      if (pad) {
        const xToken = this.binding.axes.x;
        const yToken = this.binding.axes.y;
        const rawX = Number(pad.axes?.[xToken.index] ?? 0);
        const rawY = Number(pad.axes?.[yToken.index] ?? 0);
        const x = Math.abs(rawX) < this.deadzone ? 0 : (xToken.invert ? -rawX : rawX);
        const y = Math.abs(rawY) < this.deadzone ? 0 : (yToken.invert ? -rawY : rawY);
        this.state.x = clamp(x);
        this.state.y = clamp(y);
        this.#emitState(x !== 0 || y !== 0, `gamepad:${pad.index}:analog`);
      }
    } else if (this.binding.preset === "gamepadDpad") {
      const pad = pads[0];
      if (pad) {
        for (const direction of DIRECTIONS) {
          const action = this.binding.directions[direction];
          const key = signature(action);
          const pressed = Boolean(pad.buttons?.[action.button]?.pressed);
          const prior = this.gamepadButtons.get(key) ?? false;
          if (pressed && !prior) this.#digitalPress(action, null);
          if (!pressed && prior) this.#digitalRelease(action);
          this.gamepadButtons.set(key, pressed);
        }
      }
    }
    return this.state;
  }

  resetNeutral(reason = "neutral-reset") {
    this.state.x = 0;
    this.state.y = 0;
    this.activeActions.clear();
    this.#emitState(false, reason);
  }

  #capture(action, event) {
    if (!this.captureDirection || !this.captureCallback) return false;
    const direction = this.captureDirection;
    const callback = this.captureCallback;
    try {
      const binding = withCustomDigitalAction(this.binding, direction, action);
      this.setBinding(binding);
      callback({ ok: true, direction, action: structuredClone(action), binding });
      this.cancelCapture();
    } catch (error) {
      callback({ ok: false, direction, action: structuredClone(action), error });
    }
    event?.preventDefault?.();
    return true;
  }

  #matchingDirection(action) {
    if (this.binding.kind !== "digital") return null;
    const wanted = signature(action);
    return DIRECTIONS.find((direction) => signature(this.binding.directions[direction]) === wanted) ?? null;
  }

  #digitalPress(action, event, { momentary = false } = {}) {
    const direction = this.#matchingDirection(action);
    if (!direction) return false;
    const key = signature(action);
    if (this.activeActions.has(key)) return false;
    this.activeActions.add(key);
    const [dx, dy] = directionDelta(direction, this.binding.stepSize);
    this.state.x = clamp(this.state.x + dx);
    this.state.y = clamp(this.state.y + dy);
    this.#emitState(true, key);
    this.onInputEdge(Object.freeze({
      direction,
      action: Object.freeze(structuredClone(action)),
      active: true,
      momentary,
      monotonicMs: this.state.anchorMonotonicMs,
    }));
    event?.preventDefault?.();
    return true;
  }

  #digitalRelease(action) {
    const key = signature(action);
    if (!this.activeActions.delete(key)) return false;
    const direction = this.#matchingDirection(action);
    this.#emitState(this.activeActions.size > 0, key);
    this.onInputEdge(Object.freeze({
      direction,
      action: Object.freeze(structuredClone(action)),
      active: false,
      momentary: false,
      monotonicMs: this.state.anchorMonotonicMs,
    }));
    return true;
  }

  #emitState(inputActive, source = null) {
    this.state.inputActive = Boolean(inputActive);
    this.state.anchorMonotonicMs = this.now();
    this.onState(Object.freeze({
      x: this.state.x,
      y: this.state.y,
      inputActive: this.state.inputActive,
      inputKind: this.binding.kind,
      source,
      anchorMonotonicMs: this.state.anchorMonotonicMs,
    }));
  }

  #syncGamepadPolling() {
    const needsPolling = this.binding.kind === "analog" || this.binding.preset === "gamepadDpad";
    if (!needsPolling) {
      if (this.frameId !== null) this.cancelFrame(this.frameId);
      this.frameId = null;
      return;
    }
    if (this.frameId !== null || !this.element) return;
    const loop = () => {
      this.frameId = null;
      if (!this.element) return;
      this.pollGamepads();
      this.frameId = this.requestFrame(loop);
    };
    this.frameId = this.requestFrame(loop);
  }
}
