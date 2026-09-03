import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const nativeApi = Object.freeze({
  openStudyStudio: () => invoke("open_study_studio"),
  getSettings: () => invoke("get_settings"),
  saveSettings: (settings) => invoke("save_settings", { settings }),
  getSnapshot: () => invoke("get_snapshot"),
  nudgeAction: (action) => invoke("nudge_action", { action }),
  reset: () => invoke("reset_affect"),
  setAffectTarget: (x, y) => invoke("set_affect_target", { x, y }),
  setTraversalMode: (mode) => invoke("set_traversal_mode", { mode }),
  traverseAffectMatrix: (column, row, stepsPerSecond) => invoke("traverse_affect_matrix", { column, row, stepsPerSecond }),
  stopMatrixTraversal: () => invoke("stop_matrix_traversal"),
  togglePause: () => invoke("toggle_pause"),
  setOverlayVisible: (visible) => invoke("set_overlay_visible", { visible }),
  setOverlayEditing: (editing) => invoke("set_overlay_editing", { editing }),
  beginOverlayDrag: () => getCurrentWindow().startDragging(),
  onSnapshot: (handler) => listen("affect://snapshot", ({ payload }) => handler(payload)),
  onOverlayEditing: (handler) => listen("affect://overlay-editing", ({ payload }) => handler(payload)),
});
