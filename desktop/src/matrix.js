import { affectPaletteColor } from "../../site/src/math.js";

export const AFFECT_MATRIX_SIZE = 11;

export function matrixCoordinate(index) {
  if (!Number.isInteger(index) || index < 0 || index >= AFFECT_MATRIX_SIZE) {
    throw new RangeError("Matrix index must be an integer between 0 and 10.");
  }
  return -1 + (2 * index) / (AFFECT_MATRIX_SIZE - 1);
}

const keyFor = (column, row) => `${column}:${row}`;
const coordinateLabel = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;

export function createAffectMatrixGrid(root, { onSelect }) {
  const buttons = new Map();
  let rovingCell = { column: 5, row: 5 };

  function setRovingCell(column, row, focus = false) {
    rovingCell = {
      column: Math.max(0, Math.min(AFFECT_MATRIX_SIZE - 1, column)),
      row: Math.max(0, Math.min(AFFECT_MATRIX_SIZE - 1, row)),
    };
    for (const button of buttons.values()) button.tabIndex = -1;
    const button = buttons.get(keyFor(rovingCell.column, rovingCell.row));
    if (button) {
      button.tabIndex = 0;
      if (focus) button.focus();
    }
  }

  for (let row = AFFECT_MATRIX_SIZE - 1; row >= 0; row -= 1) {
    for (let column = 0; column < AFFECT_MATRIX_SIZE; column += 1) {
      const button = document.createElement("button");
      const x = matrixCoordinate(column);
      const y = matrixCoordinate(row);
      button.type = "button";
      button.className = "affect-matrix-cell";
      button.dataset.column = String(column);
      button.dataset.row = String(row);
      button.setAttribute("role", "gridcell");
      button.setAttribute(
        "aria-label",
        `Valence ${coordinateLabel(x)}, arousal ${coordinateLabel(y)}`,
      );
      button.title = button.getAttribute("aria-label");
      button.tabIndex = -1;
      button.addEventListener("click", () => {
        setRovingCell(column, row);
        onSelect({ column, row, x, y });
      });
      button.addEventListener("keydown", (event) => {
        const direction = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, 1],
          ArrowDown: [0, -1],
        }[event.key];
        if (!direction) return;
        event.preventDefault();
        setRovingCell(column + direction[0], row + direction[1], true);
      });
      buttons.set(keyFor(column, row), button);
      root.append(button);
    }
  }
  setRovingCell(rovingCell.column, rovingCell.row);

  return {
    render(snapshot, palette) {
      const current = snapshot.matrixCurrent;
      const target = snapshot.matrixTarget;
      for (const [key, button] of buttons) {
        const isCurrent = current && key === keyFor(current.column, current.row);
        const isTarget = target && key === keyFor(target.column, target.row);
        const column = Number(button.dataset.column);
        const row = Number(button.dataset.row);
        button.classList.toggle("is-current", Boolean(isCurrent));
        button.classList.toggle("is-target", Boolean(isTarget));
        if (isCurrent) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
        button.style.setProperty(
          "--matrix-cell-color",
          affectPaletteColor(matrixCoordinate(column), matrixCoordinate(row), palette),
        );
      }
      if (current) setRovingCell(current.column, current.row);
      else if (target) setRovingCell(target.column, target.row);
    },
  };
}
