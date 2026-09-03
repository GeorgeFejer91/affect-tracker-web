const QR_VERSION = 7;
const QR_SIZE = 17 + (4 * QR_VERSION);
const DATA_CODEWORDS = 156;
const BLOCK_DATA_CODEWORDS = 78;
const ERROR_CODEWORDS_PER_BLOCK = 20;
const MAX_BYTE_PAYLOAD = 154;

function appendBits(bits, value, length) {
  if (!Number.isSafeInteger(value) || value < 0 || value >>> length !== 0) {
    throw new RangeError("The QR bit value does not fit its declared width.");
  }
  for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((value >>> shift) & 1);
}

function multiplyGalois(left, right) {
  let x = left;
  let y = right;
  let result = 0;
  for (let index = 0; index < 8; index += 1) {
    if ((y & 1) !== 0) result ^= x;
    y >>>= 1;
    x = (x << 1) ^ (((x >>> 7) & 1) * 0x11d);
  }
  return result & 0xff;
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < degree; coefficient += 1) {
      result[coefficient] = multiplyGalois(result[coefficient], root);
      if (coefficient + 1 < degree) result[coefficient] ^= result[coefficient + 1];
    }
    root = multiplyGalois(root, 2);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let index = 0; index < result.length; index += 1) {
      result[index] ^= multiplyGalois(divisor[index], factor);
    }
  }
  return result;
}

function encodeCodewords(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_BYTE_PAYLOAD) {
    throw new RangeError(`The QR invitation is too long; the local renderer supports ${MAX_BYTE_PAYLOAD} UTF-8 bytes.`);
  }
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.byteLength, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacityBits = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[offset + bit];
    data.push(byte);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);

  const blocks = [
    Uint8Array.from(data.slice(0, BLOCK_DATA_CODEWORDS)),
    Uint8Array.from(data.slice(BLOCK_DATA_CODEWORDS)),
  ];
  const divisor = reedSolomonDivisor(ERROR_CODEWORDS_PER_BLOCK);
  const errors = blocks.map((block) => reedSolomonRemainder(block, divisor));
  const codewords = [];
  for (let index = 0; index < BLOCK_DATA_CODEWORDS; index += 1) {
    for (const block of blocks) codewords.push(block[index]);
  }
  for (let index = 0; index < ERROR_CODEWORDS_PER_BLOCK; index += 1) {
    for (const error of errors) codewords.push(error[index]);
  }
  return Uint8Array.from(codewords);
}

function formatBits(mask) {
  const data = (1 << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function versionBits() {
  let remainder = QR_VERSION;
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  }
  return (QR_VERSION << 12) | remainder;
}

function bit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

export function createQrMatrix(text) {
  if (typeof text !== "string") throw new TypeError("QR content must be text.");
  const codewords = encodeCodewords(text);
  const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  const functions = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
  const setFunction = (x, y, value) => {
    modules[y][x] = Boolean(value);
    functions[y][x] = true;
  };

  for (let index = 0; index < QR_SIZE; index += 1) {
    setFunction(6, index, index % 2 === 0);
    setFunction(index, 6, index % 2 === 0);
  }
  const drawFinder = (centerX, centerY) => {
    for (let offsetY = -4; offsetY <= 4; offsetY += 1) {
      for (let offsetX = -4; offsetX <= 4; offsetX += 1) {
        const x = centerX + offsetX;
        const y = centerY + offsetY;
        if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) continue;
        const distance = Math.max(Math.abs(offsetX), Math.abs(offsetY));
        setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(QR_SIZE - 4, 3);
  drawFinder(3, QR_SIZE - 4);

  const alignmentPositions = [6, 22, 38];
  for (let row = 0; row < alignmentPositions.length; row += 1) {
    for (let column = 0; column < alignmentPositions.length; column += 1) {
      if ((row === 0 && column === 0)
        || (row === 0 && column === alignmentPositions.length - 1)
        || (row === alignmentPositions.length - 1 && column === 0)) continue;
      const centerX = alignmentPositions[column];
      const centerY = alignmentPositions[row];
      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          setFunction(
            centerX + offsetX,
            centerY + offsetY,
            Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== 1,
          );
        }
      }
    }
  }

  const mask = 0;
  const format = formatBits(mask);
  for (let index = 0; index <= 5; index += 1) setFunction(8, index, bit(format, index));
  setFunction(8, 7, bit(format, 6));
  setFunction(8, 8, bit(format, 7));
  setFunction(7, 8, bit(format, 8));
  for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, bit(format, index));
  for (let index = 0; index < 8; index += 1) setFunction(QR_SIZE - 1 - index, 8, bit(format, index));
  for (let index = 8; index < 15; index += 1) setFunction(8, QR_SIZE - 15 + index, bit(format, index));
  setFunction(8, QR_SIZE - 8, true);

  const version = versionBits();
  for (let index = 0; index < 18; index += 1) {
    const a = QR_SIZE - 11 + (index % 3);
    const b = Math.floor(index / 3);
    setFunction(a, b, bit(version, index));
    setFunction(b, a, bit(version, index));
  }

  let dataBit = 0;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? QR_SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functions[y][x]) continue;
        const value = dataBit < codewords.byteLength * 8
          ? ((codewords[dataBit >>> 3] >>> (7 - (dataBit & 7))) & 1) !== 0
          : false;
        modules[y][x] = value !== ((x + y) % 2 === 0);
        dataBit += 1;
      }
    }
  }
  if (dataBit !== codewords.byteLength * 8) throw new Error("The QR matrix did not consume the complete codeword stream.");
  return Object.freeze(modules.map((row) => Object.freeze(row)));
}

export function renderQrCode(host, text, { document = globalThis.document } = {}) {
  if (!host || !document?.createElementNS) throw new TypeError("A QR host and DOM document are required.");
  const matrix = createQrMatrix(text);
  const quietZone = 4;
  const extent = matrix.length + (quietZone * 2);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${extent} ${extent}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "One-time QR invitation for the Affect Tracker remote controller");
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", String(extent));
  background.setAttribute("height", String(extent));
  background.setAttribute("fill", "#ffffff");
  svg.append(background);
  let pathData = "";
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (matrix[y][x]) pathData += `M${x + quietZone},${y + quietZone}h1v1h-1z`;
    }
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "#111111");
  svg.append(path);
  host.replaceChildren(svg);
  return svg;
}
