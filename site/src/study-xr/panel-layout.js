export const XR_PANEL_LIMITS = Object.freeze({
  titleColumns: 52,
  titleLines: 2,
  bodyColumns: 52,
  bodyLines: 8,
  choiceColumns: 40,
  choiceLineBudget: 8,
  choicesPerPage: 6,
  controlsPerPanel: 9,
});

function codePoints(value) {
  return [...String(value ?? "")];
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function splitLongWord(word, columns) {
  const points = codePoints(word);
  const chunks = [];
  for (let offset = 0; offset < points.length; offset += columns) {
    chunks.push(points.slice(offset, offset + columns).join(""));
  }
  return chunks;
}

export function wrapPanelText(text, { columns = XR_PANEL_LIMITS.bodyColumns } = {}) {
  assertPositiveInteger(columns, "columns");
  const source = String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = [];

  for (const paragraph of source.split("\n")) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const chunks = splitLongWord(word, columns);
      for (const chunk of chunks) {
        const candidate = line ? `${line} ${chunk}` : chunk;
        if (codePoints(candidate).length <= columns) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = chunk;
      }
    }
    if (line) lines.push(line);
  }

  return Object.freeze(lines.length > 0 ? lines : [""]);
}

export function paginatePanelText(text, {
  columns = XR_PANEL_LIMITS.bodyColumns,
  linesPerPage = XR_PANEL_LIMITS.bodyLines,
} = {}) {
  assertPositiveInteger(linesPerPage, "linesPerPage");
  const lines = wrapPanelText(text, { columns });
  const pages = [];
  for (let offset = 0; offset < lines.length; offset += linesPerPage) {
    pages.push(Object.freeze(lines.slice(offset, offset + linesPerPage)));
  }
  return Object.freeze(pages.length > 0 ? pages : [Object.freeze([""])]);
}

export function boundedPanelTitle(title) {
  const accessibleText = String(title ?? "").trim();
  if (!accessibleText) throw new TypeError("XR panel titles must be non-empty strings.");
  const lines = wrapPanelText(accessibleText, { columns: XR_PANEL_LIMITS.titleColumns });
  if (lines.length > XR_PANEL_LIMITS.titleLines) {
    throw new RangeError(`XR panel title exceeds the ${XR_PANEL_LIMITS.titleLines}-line limit.`);
  }
  return deepFreeze({ accessibleText, lines: [...lines] });
}

function normalizedOption(option, index, columns) {
  if (!option || typeof option.optionId !== "string" || !option.optionId) {
    throw new TypeError(`options[${index}].optionId must be a non-empty string.`);
  }
  if (typeof option.label !== "string" || !option.label) {
    throw new TypeError(`options[${index}].label must be a non-empty string.`);
  }
  return Object.freeze({
    optionId: option.optionId,
    label: option.label,
    labelLines: wrapPanelText(option.label, { columns }),
    sourceIndex: index,
  });
}

export function paginateChoiceOptions(options, {
  columns = XR_PANEL_LIMITS.choiceColumns,
  lineBudget = XR_PANEL_LIMITS.choiceLineBudget,
  choicesPerPage = XR_PANEL_LIMITS.choicesPerPage,
} = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError("options must be a non-empty array.");
  }
  assertPositiveInteger(lineBudget, "lineBudget");
  assertPositiveInteger(choicesPerPage, "choicesPerPage");
  const normalized = options.map((option, index) => normalizedOption(option, index, columns));
  const pages = [];
  let page = [];
  let usedLines = 0;

  for (const option of normalized) {
    if (option.labelLines.length > lineBudget) {
      throw new RangeError(`Option ${option.optionId} cannot fit in one bounded XR choice panel.`);
    }
    const wouldOverflow = page.length > 0
      && (page.length >= choicesPerPage || usedLines + option.labelLines.length > lineBudget);
    if (wouldOverflow) {
      pages.push(Object.freeze(page));
      page = [];
      usedLines = 0;
    }
    page.push(option);
    usedLines += option.labelLines.length;
  }
  if (page.length > 0) pages.push(Object.freeze(page));
  return Object.freeze(pages);
}

export function boundedIndex(value, count) {
  assertPositiveInteger(count, "count");
  const numeric = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(count - 1, numeric));
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertLineBounds(lines, columns, limit, label) {
  if (!Array.isArray(lines) || lines.length > limit) {
    throw new RangeError(`${label} exceeds the ${limit}-line XR panel limit.`);
  }
  for (const line of lines) {
    if (codePoints(line).length > columns) {
      throw new RangeError(`${label} contains a line wider than ${columns} code points.`);
    }
  }
}

export function assertBoundedXrPanel(panel) {
  if (panel?.schema !== "affect-tracker-study-xr-panel" || panel?.version !== 1) {
    throw new TypeError("Expected an Affect Tracker XR panel model version 1.");
  }
  assertLineBounds(
    panel.title?.lines,
    XR_PANEL_LIMITS.titleColumns,
    XR_PANEL_LIMITS.titleLines,
    "panel title",
  );
  assertLineBounds(
    panel.content?.lines,
    XR_PANEL_LIMITS.bodyColumns,
    XR_PANEL_LIMITS.bodyLines,
    "panel content",
  );
  if (!Array.isArray(panel.controls) || panel.controls.length > XR_PANEL_LIMITS.controlsPerPanel) {
    throw new RangeError(`XR panels may expose at most ${XR_PANEL_LIMITS.controlsPerPanel} controls.`);
  }
  const ids = new Set();
  for (const control of panel.controls) {
    if (!control?.id || ids.has(control.id)) throw new TypeError("XR panel control IDs must be unique.");
    ids.add(control.id);
    if (!Number.isInteger(control.row) || !Number.isInteger(control.column)) {
      throw new TypeError(`XR control ${control.id} requires integer row and column coordinates.`);
    }
    assertLineBounds(
      control.labelLines,
      XR_PANEL_LIMITS.choiceColumns,
      XR_PANEL_LIMITS.choiceLineBudget,
      `control ${control.id}`,
    );
  }
  return true;
}
