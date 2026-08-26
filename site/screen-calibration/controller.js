import {
  BIS_2025_MOST_TRADED_CURRENCY_CODES,
  COUNTRY_CATALOG,
  coinReferenceById,
  countryByCode,
  currencyByCode,
} from "./coin-reference-catalog.js";
import {
  calibrationRecordContext,
  calibrationSquareAfterPointerCancellation,
  createCalibrationSquareFromDrag,
  createScreenCalibration,
  currentDisplaySignature,
  parseScreenCalibration,
  resizeCalibrationSquareFromCorner,
  SCREEN_CALIBRATION_STORAGE_KEY,
  screenCalibrationStatus,
  translateCalibrationSquare,
  translateCalibrationSquareFromEdge,
} from "./screen-calibration.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const elementIds = Object.freeze({
  start: "screen-calibration-start",
  status: "screen-calibration-status",
  result: "screen-calibration-result",
  layer: "screen-calibration-layer",
  title: "screen-calibration-overlay-title",
  step: "screen-calibration-step",
  chooseView: "screen-calibration-choose-view",
  drawView: "screen-calibration-draw-view",
  directory: "screen-calibration-directory",
  shortcuts: "screen-calibration-shortcuts",
  countrySearch: "screen-calibration-country-search",
  countryGrid: "screen-calibration-country-grid",
  coinPicker: "screen-calibration-coin-picker",
  countryBack: "screen-calibration-country-back",
  currencyTitle: "screen-calibration-currency-title",
  currencyDescription: "screen-calibration-currency-description",
  countrySelectField: "screen-calibration-country-select-field",
  countrySelect: "screen-calibration-country-select",
  coinGrid: "screen-calibration-coin-grid",
  canvas: "screen-calibration-canvas",
  drawSurface: "screen-calibration-draw-surface",
  square: "screen-calibration-square",
  squareRect: "screen-calibration-square-rect",
  handles: "screen-calibration-handles",
  instructions: "screen-calibration-instructions",
  sizeOutput: "screen-calibration-size-output",
  selectedCoin: "screen-calibration-selected-coin",
  actions: "screen-calibration-actions",
  confirm: "screen-calibration-confirm",
  redraw: "screen-calibration-redraw",
  chooseAnother: "screen-calibration-choose-another",
  cancel: "screen-calibration-cancel",
  cancelChoose: "screen-calibration-cancel-choose",
  error: "screen-calibration-error",
});

function queryElements(documentObject) {
  const entries = Object.entries(elementIds).map(([name, id]) => [name, documentObject.getElementById(id)]);
  const missing = Object.entries(elementIds).filter(([, id]) => !documentObject.getElementById(id)).map(([, id]) => id);
  if (missing.length) throw new Error(`Screen Calibration module is missing required elements: ${missing.join(", ")}`);
  return Object.fromEntries(entries);
}

function flagEmoji(code) {
  return [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("");
}

function iconHue(token) {
  return [...token].reduce((value, character) => value * 31 + character.charCodeAt(0), 17) % 360;
}

function calibrationSvgIcon(documentObject, className) {
  const svg = documentObject.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 48 36");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add(className);
  return svg;
}

export function createCountryFlagSvg(documentObject, countryCode) {
  const svg = calibrationSvgIcon(documentObject, "screen-calibration-flag-svg");
  svg.style.setProperty("--country-hue", String(iconHue(countryCode)));
  for (let index = 0; index < 3; index += 1) {
    const band = documentObject.createElementNS(SVG_NAMESPACE, "rect");
    band.setAttribute("x", "1");
    band.setAttribute("y", String(1 + index * 11.33));
    band.setAttribute("width", "46");
    band.setAttribute("height", "11.5");
    band.setAttribute("class", `screen-calibration-country-band band-${index + 1}`);
    svg.append(band);
  }
  const border = documentObject.createElementNS(SVG_NAMESPACE, "rect");
  border.setAttribute("x", "1");
  border.setAttribute("y", "1");
  border.setAttribute("width", "46");
  border.setAttribute("height", "34");
  border.setAttribute("rx", "5");
  border.setAttribute("class", "screen-calibration-country-border");
  const glyph = documentObject.createElementNS(SVG_NAMESPACE, "text");
  glyph.setAttribute("x", "24");
  glyph.setAttribute("y", "22");
  glyph.setAttribute("text-anchor", "middle");
  glyph.setAttribute("class", "screen-calibration-flag-glyph");
  glyph.textContent = countryCode;
  svg.append(border, glyph);
  return svg;
}

export function createCurrencySvg(documentObject, currency) {
  const svg = calibrationSvgIcon(documentObject, "screen-calibration-currency-svg");
  svg.style.setProperty("--currency-hue", String(iconHue(currency.code)));
  const background = documentObject.createElementNS(SVG_NAMESPACE, "rect");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", "46");
  background.setAttribute("height", "34");
  background.setAttribute("rx", "7");
  background.setAttribute("class", "screen-calibration-currency-background");
  const ring = documentObject.createElementNS(SVG_NAMESPACE, "circle");
  ring.setAttribute("cx", "24");
  ring.setAttribute("cy", "18");
  ring.setAttribute("r", "12");
  ring.setAttribute("class", "screen-calibration-currency-ring");
  const symbol = documentObject.createElementNS(SVG_NAMESPACE, "text");
  symbol.setAttribute("x", "24");
  symbol.setAttribute("y", "22");
  symbol.setAttribute("text-anchor", "middle");
  symbol.setAttribute("class", "screen-calibration-currency-symbol");
  symbol.textContent = currency.symbol.length <= 3 ? currency.symbol : currency.code;
  svg.append(background, ring, symbol);
  return svg;
}

function coinShapeLabel(shape) {
  return ({
    round: "round",
    "spanish-flower": "Spanish-flower edge",
    scalloped: "scalloped edge",
    heptagonal: "seven-sided",
    hendecagonal: "eleven-sided",
    dodecagonal: "twelve-sided",
    tridecagonal: "thirteen-sided",
  })[shape] ?? shape;
}

export function createScreenCalibrationController({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  storage = windowObject?.localStorage,
  announce = () => {},
  canStart = () => true,
  onStateChange = () => {},
} = {}) {
  if (!documentObject || !windowObject || !storage) throw new TypeError("Screen Calibration requires a browser document, window, and local storage.");
  const elements = queryElements(documentObject);
  const run = {
    active: false,
    ownsFullscreen: false,
    step: "choose",
    currencyCode: "",
    countryCode: "",
    coinId: "",
    square: undefined,
    pointer: undefined,
  };
  let available = true;
  let savedCalibration;
  try {
    const stored = storage.getItem(SCREEN_CALIBRATION_STORAGE_KEY);
    savedCalibration = stored ? parseScreenCalibration(stored) : undefined;
  } catch {
    savedCalibration = undefined;
  }

  const currentStatus = () => {
    try {
      return screenCalibrationStatus(savedCalibration, currentDisplaySignature(windowObject));
    } catch {
      return { state: "invalid", message: "Display information is unavailable" };
    }
  };

  const renderStatus = () => {
    const status = currentStatus();
    elements.status.dataset.state = status.state;
    elements.status.value = status.message;
    if (status.state === "valid") {
      const calibration = status.calibration;
      const side = calibration.version === 2 ? calibration.squareSideCssPx : calibration.meanCssPx;
      const place = calibration.version === 2 ? `${calibration.country.name} · ` : "";
      elements.result.textContent = `${place}${calibration.coin.denomination}: ${side.toFixed(1)} CSS px; fullscreen viewport approximately ${calibration.fullscreenViewport.widthMm.toFixed(0)} × ${calibration.fullscreenViewport.heightMm.toFixed(0)} mm.`;
    } else if (status.state === "stale") {
      elements.result.textContent = "The saved result belongs to a different display size, scale, or orientation. Recalibrate before relying on physical-size estimates.";
    } else {
      elements.result.textContent = "Calibration is approximate and applies only while this display, scaling, and orientation stay unchanged.";
    }
  };

  const refreshAvailability = () => {
    elements.start.disabled = !available || run.active || !canStart();
  };

  const canvasBounds = () => {
    const rect = elements.canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const pointerPoint = (event) => {
    const rect = elements.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const setStep = (step) => {
    run.step = step;
    elements.layer.dataset.calibrationStep = step;
    const choosing = step === "choose";
    elements.chooseView.hidden = !choosing;
    elements.drawView.hidden = choosing;
    elements.cancelChoose.hidden = !choosing;
    elements.step.value = choosing ? "Step 1 of 3" : (step === "draw" ? "Step 2 of 3" : "Step 3 of 3");
    elements.title.textContent = choosing ? "Choose a reference coin" : (step === "draw" ? "Draw a square around the coin" : "Adjust and confirm");
    elements.actions.hidden = step !== "adjust";
    elements.handles.hidden = step !== "adjust";
    elements.instructions.textContent = step === "draw"
      ? "The entire lower half is the measuring surface. Place the selected coin there—even against the left, right, or bottom screen rim—then drag diagonally around its outer edge."
      : "Fine-tune the square in the unobstructed lower half so its four sides meet the coin's outer edge. The square may touch the left, right, or bottom screen rim.";
  };

  const renderSquare = () => {
    const square = run.square;
    elements.square.hidden = !square;
    if (!square) {
      elements.sizeOutput.value = "Draw a square";
      return;
    }
    const { x, y, side } = square;
    for (const [name, value] of Object.entries({ x, y, width: side, height: side })) elements.squareRect.setAttribute(name, value);
    const hit = Math.min(28, Math.max(18, side * 0.2));
    const edges = { top: [x, y - hit / 2, side, hit], right: [x + side - hit / 2, y, hit, side], bottom: [x, y + side - hit / 2, side, hit], left: [x - hit / 2, y, hit, side] };
    for (const handle of elements.handles.querySelectorAll("[data-edge]")) {
      const [hx, hy, width, height] = edges[handle.dataset.edge];
      for (const [name, value] of Object.entries({ x: hx, y: hy, width, height })) handle.setAttribute(name, value);
    }
    const corners = { nw: [x, y], ne: [x + side, y], se: [x + side, y + side], sw: [x, y + side] };
    for (const handle of elements.handles.querySelectorAll("[data-corner]")) {
      const [cx, cy] = corners[handle.dataset.corner];
      handle.setAttribute("cx", cx);
      handle.setAttribute("cy", cy);
    }
    elements.sizeOutput.value = `${side.toFixed(1)} CSS px × ${side.toFixed(1)} CSS px`;
  };

  const renderCountryGrid = (query = "") => {
    const needle = query.trim().toLocaleLowerCase();
    elements.countryGrid.replaceChildren();
    const matches = COUNTRY_CATALOG.filter((country) => !needle || `${country.name} ${country.currencyCode} ${country.currencyName}`.toLocaleLowerCase().includes(needle));
    for (const country of matches) {
      const button = documentObject.createElement("button");
      button.type = "button";
      button.className = "screen-calibration-country";
      button.dataset.countryCode = country.code;
      const label = documentObject.createElement("span");
      label.textContent = `${country.name} · ${country.currencyCode}`;
      button.append(createCountryFlagSvg(documentObject, country.code), createCurrencySvg(documentObject, currencyByCode(country.currencyCode)), label);
      elements.countryGrid.append(button);
    }
    if (!matches.length) elements.countryGrid.textContent = "No matching countries.";
  };

  const showCurrency = (currencyCode, countryCode = "") => {
    const currency = currencyByCode(currencyCode);
    const country = countryByCode(countryCode);
    if (!currency || (country && country.currencyCode !== currency.code)) return;
    const selectedCountry = country ?? (currency.countries.length === 1 ? currency.countries[0] : undefined);
    run.currencyCode = currency.code;
    run.countryCode = selectedCountry?.code ?? "";
    elements.directory.hidden = true;
    elements.coinPicker.hidden = false;
    elements.currencyTitle.replaceChildren(createCurrencySvg(documentObject, currency), documentObject.createTextNode(`${currency.code} · ${currency.name}`));
    elements.countrySelect.replaceChildren();
    if (currency.countries.length > 1) {
      const placeholder = documentObject.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose the country where the participant is located";
      elements.countrySelect.append(placeholder);
    }
    for (const candidate of currency.countries) {
      const option = documentObject.createElement("option");
      option.value = candidate.code;
      option.textContent = `${flagEmoji(candidate.code)} ${candidate.name}`;
      option.selected = candidate.code === run.countryCode;
      elements.countrySelect.append(option);
    }
    elements.countrySelectField.hidden = currency.countries.length === 1;
    elements.countrySelect.value = run.countryCode;
    elements.currencyDescription.textContent = selectedCountry
      ? `${selectedCountry.name} selected. Choose the undamaged standard circulating coin you will place on the screen. For a non-round coin, fit its furthest outer edges.`
      : "Choose the participant country from the compact list, then choose an undamaged standard circulating coin. Non-round sizes use the official maximum outer span.";
    elements.coinGrid.replaceChildren();
    const diameters = currency.coins.map(({ diameterMm }) => diameterMm);
    const minimum = Math.min(...diameters);
    const maximum = Math.max(...diameters);
    for (const coin of currency.coins) {
      const button = documentObject.createElement("button");
      button.type = "button";
      button.className = "screen-calibration-coin";
      button.dataset.coinId = coin.id;
      button.dataset.coinShape = coin.shape;
      button.disabled = !run.countryCode;
      button.style.setProperty("--currency-hue", String(iconHue(currency.code)));
      const relative = maximum === minimum ? 4.5 : 3.6 + ((coin.diameterMm - minimum) / (maximum - minimum)) * 1.8;
      button.style.setProperty("--coin-button-size", `${relative}rem`);
      button.title = `${coin.denomination}, ${coin.diameterMm} mm ${coin.shape === "round" ? "diameter" : "maximum outer span"}, ${coinShapeLabel(coin.shape)}`;
      const label = documentObject.createElement("strong");
      label.textContent = coin.label;
      const size = documentObject.createElement("small");
      size.textContent = `${coin.diameterMm} mm${coin.shape === "round" ? "" : " outer"}`;
      button.append(label, size);
      elements.coinGrid.append(button);
    }
  };

  const chooseCoin = (coinId) => {
    const coin = coinReferenceById(coinId);
    if (!coin || !run.countryCode || coin.currency !== run.currencyCode) return;
    run.coinId = coin.id;
    run.square = undefined;
    const measuredAs = coin.shape === "round" ? "diameter" : `maximum outer span · ${coinShapeLabel(coin.shape)}`;
    elements.selectedCoin.replaceChildren(documentObject.createTextNode(`${coin.label} · ${coin.diameterMm} mm ${measuredAs} · ${coin.authority} · `));
    const source = documentObject.createElement("a");
    source.href = coin.sourceUrl;
    source.target = "_blank";
    source.rel = "noreferrer";
    source.textContent = "official specification";
    elements.selectedCoin.append(source);
    setStep("draw");
    renderSquare();
    windowObject.requestAnimationFrame(() => {
      const bounds = canvasBounds();
      elements.canvas.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
      elements.canvas.focus();
    });
  };

  const end = ({ exitFullscreen = true } = {}) => {
    const shouldExit = exitFullscreen && run.ownsFullscreen && documentObject.fullscreenElement === elements.layer;
    run.active = false;
    run.ownsFullscreen = false;
    run.pointer = undefined;
    run.square = undefined;
    elements.layer.hidden = true;
    documentObject.body.classList.remove("is-screen-calibrating");
    if (shouldExit) documentObject.exitFullscreen?.().catch(() => {});
    renderStatus();
    refreshAvailability();
    onStateChange();
  };

  const begin = async () => {
    if (!available || !canStart() || run.active) return;
    if (!documentObject.fullscreenEnabled || !elements.layer.requestFullscreen) {
      announce("This browser does not permit the fullscreen calibration protocol.");
      return;
    }
    run.active = true;
    run.currencyCode = "";
    run.countryCode = "";
    run.coinId = "";
    run.square = undefined;
    run.pointer = undefined;
    elements.layer.hidden = false;
    documentObject.body.classList.add("is-screen-calibrating");
    elements.countrySearch.value = "";
    elements.directory.hidden = false;
    elements.countryGrid.hidden = false;
    elements.coinPicker.hidden = true;
    elements.error.hidden = true;
    renderCountryGrid();
    setStep("choose");
    refreshAvailability();
    onStateChange();
    try {
      await elements.layer.requestFullscreen();
      run.ownsFullscreen = documentObject.fullscreenElement === elements.layer;
      if (!run.ownsFullscreen) throw new Error("Fullscreen did not start.");
      elements.countrySearch.focus();
      announce("Fullscreen screen calibration started.");
    } catch {
      end({ exitFullscreen: false });
      announce("Fullscreen permission is required for screen calibration.");
    }
  };

  const confirm = () => {
    if (!run.active || documentObject.fullscreenElement !== elements.layer || !run.square) return;
    try {
      savedCalibration = createScreenCalibration({
        coinId: run.coinId,
        countryCode: run.countryCode,
        squareSideCssPx: run.square.side,
        viewportWidthCssPx: windowObject.innerWidth,
        viewportHeightCssPx: windowObject.innerHeight,
        displaySignature: currentDisplaySignature(windowObject),
      });
      storage.setItem(SCREEN_CALIBRATION_STORAGE_KEY, JSON.stringify(savedCalibration));
      end();
      announce("Screen calibration saved in this browser.");
    } catch (error) {
      elements.error.textContent = error?.message ?? String(error);
      elements.error.hidden = false;
    }
  };

  const beginPointer = (event) => {
    if (!run.active || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const point = pointerPoint(event);
    let kind;
    let edge;
    let corner;
    if (run.step === "draw" && event.target === elements.drawSurface) kind = "draw";
    if (run.step === "adjust") {
      edge = event.target.dataset?.edge;
      corner = event.target.dataset?.corner;
      if (edge) kind = "edge";
      else if (corner) kind = "corner";
      else if (event.target === elements.squareRect) kind = "move";
    }
    if (!kind) return;
    event.preventDefault();
    elements.canvas.setPointerCapture(event.pointerId);
    run.pointer = { id: event.pointerId, kind, edge, corner, start: point, original: run.square };
    if (kind === "draw") {
      run.square = createCalibrationSquareFromDrag(point, point, canvasBounds());
      renderSquare();
    }
  };

  const movePointer = (event) => {
    const operation = run.pointer;
    if (!operation || operation.id !== event.pointerId) return;
    event.preventDefault();
    const point = pointerPoint(event);
    const bounds = canvasBounds();
    if (operation.kind === "draw") run.square = createCalibrationSquareFromDrag(operation.start, point, bounds);
    if (operation.kind === "move") run.square = translateCalibrationSquare(operation.original, point.x - operation.start.x, point.y - operation.start.y, bounds);
    if (operation.kind === "edge") {
      const delta = operation.edge === "top" || operation.edge === "bottom" ? point.y - operation.start.y : point.x - operation.start.x;
      run.square = translateCalibrationSquareFromEdge(operation.original, operation.edge, delta, bounds);
    }
    if (operation.kind === "corner") run.square = resizeCalibrationSquareFromCorner(operation.original, operation.corner, point, bounds);
    renderSquare();
  };

  const finishPointer = (event, cancelled = false) => {
    const operation = run.pointer;
    if (!operation || operation.id !== event.pointerId) return;
    if (cancelled) run.square = calibrationSquareAfterPointerCancellation(operation.kind, operation.original);
    run.pointer = undefined;
    if (elements.canvas.hasPointerCapture(event.pointerId)) elements.canvas.releasePointerCapture(event.pointerId);
    if (!cancelled && operation.kind === "draw" && run.square) setStep("adjust");
    renderSquare();
  };

  const redraw = () => {
    run.square = undefined;
    run.pointer = undefined;
    setStep("draw");
    renderSquare();
    elements.canvas.focus();
  };

  const chooseAnother = () => {
    run.square = undefined;
    run.coinId = "";
    run.currencyCode = "";
    run.countryCode = "";
    elements.directory.hidden = false;
    elements.countryGrid.hidden = false;
    elements.coinPicker.hidden = true;
    setStep("choose");
    elements.countrySearch.focus();
  };

  const cancel = () => {
    end();
    announce("Screen calibration cancelled.");
  };

  for (const currencyCode of BIS_2025_MOST_TRADED_CURRENCY_CODES) {
    const currency = currencyByCode(currencyCode);
    const button = documentObject.createElement("button");
    button.type = "button";
    button.className = "screen-calibration-shortcut";
    button.dataset.currencyCode = currency.code;
    const code = documentObject.createElement("strong");
    code.textContent = currency.symbol === currency.code ? currency.code : `${currency.symbol} ${currency.code}`;
    const name = documentObject.createElement("span");
    name.textContent = currency.name;
    button.append(createCurrencySvg(documentObject, currency), code, name);
    elements.shortcuts.append(button);
  }
  renderCountryGrid();
  renderStatus();
  refreshAvailability();

  elements.start.addEventListener("click", begin);
  elements.shortcuts.addEventListener("click", (event) => {
    const button = event.target.closest("[data-currency-code]");
    const currency = button && currencyByCode(button.dataset.currencyCode);
    if (currency) showCurrency(currency.code, currency.countries.length === 1 ? currency.countries[0].code : "");
  });
  elements.countrySearch.addEventListener("input", () => renderCountryGrid(elements.countrySearch.value));
  elements.countryGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-country-code]");
    const country = button && countryByCode(button.dataset.countryCode);
    if (country) showCurrency(country.currencyCode, country.code);
  });
  elements.countryBack.addEventListener("click", () => {
    elements.coinPicker.hidden = true;
    elements.directory.hidden = false;
    elements.countryGrid.hidden = false;
    elements.countrySearch.focus();
  });
  elements.countrySelect.addEventListener("change", () => {
    const country = countryByCode(elements.countrySelect.value);
    const currency = currencyByCode(run.currencyCode);
    if (!country || !currency || country.currencyCode !== currency.code) return;
    showCurrency(currency.code, country.code);
    elements.countrySelect.focus();
  });
  elements.coinGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-coin-id]");
    if (button) chooseCoin(button.dataset.coinId);
  });
  elements.canvas.addEventListener("pointerdown", beginPointer);
  elements.canvas.addEventListener("pointermove", movePointer);
  elements.canvas.addEventListener("pointerup", (event) => finishPointer(event));
  elements.canvas.addEventListener("pointercancel", (event) => finishPointer(event, true));
  elements.confirm.addEventListener("click", confirm);
  elements.redraw.addEventListener("click", redraw);
  elements.chooseAnother.addEventListener("click", chooseAnother);
  elements.cancel.addEventListener("click", cancel);
  elements.cancelChoose.addEventListener("click", cancel);
  elements.layer.addEventListener("keydown", (event) => {
    if (!run.active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
      return;
    }
    if (run.step !== "adjust" || !run.square) return;
    const movement = event.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-movement, 0], ArrowRight: [movement, 0], ArrowUp: [0, -movement], ArrowDown: [0, movement] }[event.key];
    const resize = event.key === "+" || event.key === "=" ? movement : (event.key === "-" || event.key === "_" ? -movement : 0);
    if (!delta && !resize) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const bounds = canvasBounds();
    if (delta) run.square = translateCalibrationSquare(run.square, delta[0], delta[1], bounds);
    if (resize) {
      const target = { x: run.square.x + run.square.side + resize, y: run.square.y + run.square.side + resize };
      run.square = resizeCalibrationSquareFromCorner(run.square, "se", target, bounds);
    }
    renderSquare();
  });
  documentObject.addEventListener("fullscreenchange", () => {
    if (run.active && documentObject.fullscreenElement !== elements.layer) {
      end({ exitFullscreen: false });
      announce("Screen calibration cancelled because fullscreen ended.");
    }
  });
  windowObject.addEventListener("resize", () => {
    if (run.active && run.step !== "choose") {
      windowObject.requestAnimationFrame(() => {
        const bounds = canvasBounds();
        elements.canvas.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
        if (run.square) run.square = translateCalibrationSquare(run.square, 0, 0, bounds);
        renderSquare();
      });
    } else {
      renderStatus();
    }
  });
  windowObject.screen.orientation?.addEventListener?.("change", () => {
    if (!run.active) renderStatus();
  });

  return Object.freeze({
    isActive: () => run.active,
    recordContext: () => calibrationRecordContext(currentStatus()),
    refresh: renderStatus,
    setAvailable(value) {
      available = Boolean(value);
      refreshAvailability();
    },
    status: currentStatus,
  });
}
