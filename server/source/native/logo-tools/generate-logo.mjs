// Build-time only: derives the dashboard logo assets from the packaged PNG.
// Runtime never decodes images or runs an encoder; it emits cached Sixel payloads.
//
// Pixel-art contract: sample the whale silhouette on a 24x16 logical grid, colour each logical
// pixel once from a cyclic violet->blue->cyan ramp, then replicate that exact colour in a 6x6
// output square (nearest neighbour, no antialias, no dithering). The 144x96 stored image fits the
// six-row header at the verified 8x16 console cell (6 rows, 18 columns).
//
// Animation is precomputed here as FRAMES separate payloads, each a one-step phase shift of the
// same cyclic gradient. The host cycles cached strings locally at ~6fps; no per-tick encoding.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { sixelEncode } from "sixel";

const here = path.dirname(fileURLToPath(import.meta.url));
const pngPath = [
  path.resolve(here, "../../../../codex-controls-claude/assets/deepseek-color.png"),
  path.resolve(here, "../../../../assets/deepseek-color.png")
].find(candidate => existsSync(candidate));
if (!pngPath) throw new Error("Packaged logo PNG not found");
const outPath = path.resolve(here, "../TerminalHost/LogoSixelData.g.cs");

// Closed loop: violet -> blue -> cyan -> violet, so a phase shift never shows a seam.
const STOPS = [
  [0x8b, 0x5c, 0xf6],
  [0x3b, 0x82, 0xf6],
  [0x22, 0xd3, 0xee],
  [0x8b, 0x5c, 0xf6]
];
const LOGICAL_WIDTH = 24;
const LOGICAL_HEIGHT = 16;
const SCALE = 6;
const FRAMES = 24;
const FALLBACK_COLUMNS = 18;
const FALLBACK_PIXEL_ROWS = 12; // 6 half-block cell rows

function ramp(t) {
  const scaled = Math.min(0.9999, Math.max(0, t - Math.floor(t))) * (STOPS.length - 1);
  const index = Math.floor(scaled);
  const local = scaled - index;
  const a = STOPS[index];
  const b = STOPS[Math.min(STOPS.length - 1, index + 1)];
  return a.map((value, channel) => Math.round(value + (b[channel] - value) * local));
}

const png = PNG.sync.read(readFileSync(pngPath));
let minX = png.width, minY = png.height, maxX = -1, maxY = -1;
for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    if (png.data[(y * png.width + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
const inkWidth = maxX - minX + 1;
const inkHeight = maxY - minY + 1;

// Binary silhouette at logical pixel centres: pixel art wants a hard edge, not coverage.
function sourceInkAt(x, y, columns, rows) {
  const sx = Math.max(minX, Math.min(maxX, Math.floor(minX + ((x + 0.5) * inkWidth) / columns)));
  const sy = Math.max(minY, Math.min(maxY, Math.floor(minY + ((y + 0.5) * inkHeight) / rows)));
  return png.data[(sy * png.width + sx) * 4 + 3] >= 128;
}

function inkAt(x, y, columns, rows) {
  // Restore the reference's separate small pupil without redrawing the rest of the silhouette.
  if (columns === LOGICAL_WIDTH && rows === LOGICAL_HEIGHT && x === 12 && y === 7) return false;
  return sourceInkAt(x, y, columns, rows);
}
const corrections = [];
const logicalRows = Array.from({length: LOGICAL_HEIGHT}, (_, y) =>
  Array.from({length: LOGICAL_WIDTH}, (_, x) => {
    if (sourceInkAt(x, y, LOGICAL_WIDTH, LOGICAL_HEIGHT) !== inkAt(x, y, LOGICAL_WIDTH, LOGICAL_HEIGHT)) corrections.push([x,y]);
    return inkAt(x, y, LOGICAL_WIDTH, LOGICAL_HEIGHT) ? '#' : '.';
  }).join(''));
if (JSON.stringify(corrections) !== '[[12,7]]') throw new Error('Unexpected non-eye silhouette change');

// One colour per logical pixel, then an exact SCALE x SCALE replication.
const palette = [];
for (let stop = 0; stop < 64; stop++) palette.push(ramp(stop / 63));
const nearest = (color) => {
  let best = palette[0];
  let bestDistance = Infinity;
  for (const entry of palette) {
    const dr = color[0] - entry[0];
    const dg = color[1] - entry[1];
    const db = color[2] - entry[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
};

const width = LOGICAL_WIDTH * SCALE;
const height = LOGICAL_HEIGHT * SCALE;
const payloads = [];
for (let frame = 0; frame < FRAMES; frame++) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let ly = 0; ly < LOGICAL_HEIGHT; ly++) {
    for (let lx = 0; lx < LOGICAL_WIDTH; lx++) {
      if (!inkAt(lx, ly, LOGICAL_WIDTH, LOGICAL_HEIGHT)) continue;
      const t = 0.25 * (lx / (LOGICAL_WIDTH - 1) + ly / (LOGICAL_HEIGHT - 1)) - frame / FRAMES;
      const color = nearest(ramp(t));
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const offset = ((ly * SCALE + dy) * width + lx * SCALE + dx) * 4;
          rgba[offset] = color[0];
          rgba[offset + 1] = color[1];
          rgba[offset + 2] = color[2];
          rgba[offset + 3] = 255;
        }
      }
    }
  }
  payloads.push(sixelEncode(rgba, width, height, palette, true));
}

// Fallback for terminals without Sixel: the WHOLE silhouette resized to 18x12 binary pixels and
// drawn as six rows of plain half-block glyphs. Colour is applied by the host per row, so no
// ANSI is embedded in the generated strings.
const fallbackRows = [];
for (let row = 0; row < FALLBACK_PIXEL_ROWS / 2; row++) {
  let text = "";
  for (let column = 0; column < FALLBACK_COLUMNS; column++) {
    const top = inkAt(column, row * 2, FALLBACK_COLUMNS, FALLBACK_PIXEL_ROWS);
    const bottom = inkAt(column, row * 2 + 1, FALLBACK_COLUMNS, FALLBACK_PIXEL_ROWS);
    text += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
  }
  fallbackRows.push(text);
}

const chunk = (value, size) => value.match(new RegExp(`.{1,${size}}`, "g")) ?? [];
const payloadLines = payloads.flatMap((payload, frame) => [
  `        // frame ${frame}`,
  ...chunk(Buffer.from(payload, "latin1").toString("base64"), 100).map(
    (part, index, all) => `        "${part}"${index === all.length - 1 ? (frame === payloads.length - 1 ? "" : ",") : " +"}`
  )
]);
const lines = [
  "// <auto-generated />",
  "// Derived from codex-controls-claude/assets/deepseek-color.png by native/logo-tools/generate-logo.mjs.",
  "// Runtime uses only this compiled data: no image decoder, encoder, process or package at paint time.",
  "internal static class LogoSixelData",
  "{",
  `    internal const int PixelWidth = ${width};`,
  `    internal const int PixelHeight = ${height};`,
  `    internal const int LogicalWidth = ${LOGICAL_WIDTH};`,
  `    internal const int LogicalHeight = ${LOGICAL_HEIGHT};`,
  `    internal const int Scale = ${SCALE};`,
  `    internal const int FallbackColumns = ${FALLBACK_COLUMNS};`,
  "    // One cached answer per gradient phase; the host cycles them locally.",
  "    internal static readonly string[] Payloads =",
  "    [",
  ...payloadLines,
  "    ];",
  "    internal static readonly string[] LogicalRows =",
  "    [",
  ...logicalRows.map(row => `        "${row}",`),
  "    ];",
  "    // Six plain half-block rows for terminals without Sixel support.",
  "    internal static readonly string[] FallbackRows =",
  "    [",
  ...fallbackRows.map((row) => `        ${JSON.stringify(row)},`),
  "    ];",
  "}"
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(JSON.stringify({
  logical: [LOGICAL_WIDTH, LOGICAL_HEIGHT],
  scale: SCALE,
  width,
  height,
  frames: payloads.length,
  payloadBytes: payloads.reduce((total, payload) => total + payload.length, 0),
  fallbackRows: fallbackRows.length
}));
