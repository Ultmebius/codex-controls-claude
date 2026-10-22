// Build-time only: generates the dashboard's circular pixel ring.
// Runtime never decodes images or runs an encoder; it emits cached Sixel payloads.
//
// Pixel-art contract: centre a 16x16 circle on the existing 24x16 logical grid, colour each logical
// pixel once from a cyclic Codex-blue -> Claude-red -> blue ramp, then replicate that colour in a 6x6
// output square (nearest neighbour, no antialias, no dithering). The 144x96 stored image fits the
// six-row header at the verified 8x16 console cell (6 rows, 18 columns).
//
// Animation is precomputed here as FRAMES separate payloads, each a one-step phase shift of the
// same cyclic gradient. The host cycles cached strings locally at ~30fps; no per-tick encoding.
// Every payload is decoded again below, so a dithering or background regression in the encoder
// fails the build instead of reaching the terminal.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode, sixelEncode, toRGBA8888 } from "sixel";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  output: { type: "string" }
} });
const outPath = values.output ? path.resolve(values.output) : path.resolve(here, "../TerminalHost/LogoSixelData.g.cs");

// Interpolate directly between both endpoints, returning through the same intermediate shades.
const STOPS = [
  [0x3b, 0x82, 0xf6],
  [0xd9, 0x77, 0x57],
  [0x3b, 0x82, 0xf6]
];
const LOGICAL_WIDTH = 24;
const LOGICAL_HEIGHT = 16;
const SCALE = 6;
const OUTER_RADIUS = 8;
const INNER_RADIUS = 5; // Three logical pixels (18 output pixels) of ring thickness.
// 30fps over a two-second loop: small enough phase steps not to read as stepping, and the host
// can hold every payload in memory (~4.5KB each).
const FRAMES = 60;
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

function inkAt(x, y, columns, rows) {
  // Equal physical axes: the wider canvas adds horizontal space, never stretches the circle.
  const dx = (x + 0.5) * LOGICAL_WIDTH / columns - LOGICAL_WIDTH / 2;
  const dy = (y + 0.5) * LOGICAL_HEIGHT / rows - LOGICAL_HEIGHT / 2;
  const radiusSquared = dx * dx + dy * dy;
  return radiusSquared <= OUTER_RADIUS ** 2 && radiusSquared >= INNER_RADIUS ** 2;
}
const logicalRows = Array.from({length: LOGICAL_HEIGHT}, (_, y) =>
  Array.from({length: LOGICAL_WIDTH}, (_, x) => inkAt(x, y, LOGICAL_WIDTH, LOGICAL_HEIGHT) ? '#' : '.').join(''));

// One colour per logical pixel, then an exact SCALE x SCALE replication. The palette is a
// 256-step ramp so every frame has fine shades; sixelEncode matches palette entries exactly, so no
// quantizer or dithering ever runs.
const palette = [];
for (let stop = 0; stop < 256; stop++) palette.push(ramp(stop / 256));
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
  // Declare only the colours this frame actually uses: the encoder writes every palette entry,
  // so a fixed full ramp would add kilobytes per frame to a 30fps stream for no visible gain.
  const used = new Map();
  for (let ly = 0; ly < LOGICAL_HEIGHT; ly++) {
    for (let lx = 0; lx < LOGICAL_WIDTH; lx++) {
      if (!inkAt(lx, ly, LOGICAL_WIDTH, LOGICAL_HEIGHT)) continue;
      // Screen y grows downwards: atan2 increases clockwise. Subtracting time advances each
      // colour clockwise, with blue initially at the top and red at the bottom.
      const angle = (Math.atan2(ly + 0.5 - LOGICAL_HEIGHT / 2, lx + 0.5 - LOGICAL_WIDTH / 2) + Math.PI / 2) / (2 * Math.PI);
      const t = angle - frame / FRAMES;
      const color = nearest(ramp(t));
      used.set(color.join(","), color);
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
  payloads.push(sixelEncode(rgba, width, height, [...used.values()], true));
}

// Decode every emitted payload back to pixels and prove the real defect is gone: each 6x6 ink
// block is ONE exact colour (no dithering or partial-alpha bleed), background stays untouched, and
// every step including last->first moves the gradient with no duplicate frames.
const inkMap = Array.from({length: LOGICAL_HEIGHT}, (_, ly) =>
  Array.from({length: LOGICAL_WIDTH}, (_, lx) => inkAt(lx, ly, LOGICAL_WIDTH, LOGICAL_HEIGHT)));
// Pure green is outside the blue/red ramp, so it unambiguously marks transparent pixels.
const fill = toRGBA8888(0, 255, 0);
const transparent = [0, 255, 0, 255].join(",");
const decoded = payloads.map(payload => {
  const image = decode(Buffer.from(payload, "latin1"), { truncate: true, fillColor: fill });
  if (image.width !== width || image.height !== height) throw new Error(`Decoded size ${image.width}x${image.height}`);
  return image.data8;
});
let uniformBlocks = 0, silhouetteMismatches = 0, largestStep = 0, smallestStep = Infinity, seamStep = 0;
for (let frame = 0; frame < decoded.length; frame++) {
  const pixels = decoded[frame];
  for (let ly = 0; ly < LOGICAL_HEIGHT; ly++) {
    for (let lx = 0; lx < LOGICAL_WIDTH; lx++) {
      const first = ((ly * SCALE) * width + lx * SCALE) * 4;
      const expected = [pixels[first], pixels[first + 1], pixels[first + 2], pixels[first + 3]].join(",");
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const offset = ((ly * SCALE + dy) * width + lx * SCALE + dx) * 4;
          if ([pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]].join(",") !== expected)
            throw new Error(`frame ${frame} block ${lx},${ly} is not one colour`);
        }
      }
      uniformBlocks++;
      const isInk = inkMap[ly][lx];
      const isBackground = expected === transparent;
      if (isInk === isBackground) silhouetteMismatches++;
    }
  }
  const next = decoded[(frame + 1) % decoded.length];
  let changed = 0, total = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const delta = Math.abs(pixels[index] - next[index]) + Math.abs(pixels[index + 1] - next[index + 1])
      + Math.abs(pixels[index + 2] - next[index + 2]);
    if (delta > 0) changed++;
    total += delta;
  }
  if (changed === 0) throw new Error(`frame ${frame} is identical to the next phase`);
  const meanStep = total / (width * height) / 765;
  if (frame + 1 === decoded.length) seamStep = meanStep;
  else { largestStep = Math.max(largestStep, meanStep); smallestStep = Math.min(smallestStep, meanStep); }
}
if (silhouetteMismatches !== 0) throw new Error(`${silhouetteMismatches} pixels disagree with the silhouette`);
// The last->first transition must look like any other step, so the loop has no visible seam.
if (largestStep > seamStep * 1.5 + 0.005) throw new Error(`Loop seam ${seamStep.toFixed(3)} breaks the step range ${largestStep.toFixed(3)}`);
// One colour per block is the user-visible contract, not a generator detail: a frame that tinted
// a block's pixels differently would read as a grey/flashing patch at 6x6.
if (uniformBlocks !== FRAMES * LOGICAL_WIDTH * LOGICAL_HEIGHT) throw new Error(`Checked ${uniformBlocks} blocks, expected ${FRAMES * LOGICAL_WIDTH * LOGICAL_HEIGHT}`);
// Independently inspect decoded pixels: a quarter-loop must rotate every coloured block 90
// degrees clockwise around the canvas centre, while the ring itself stays stationary and round.
let clockwiseBlocks = 0;
for (let y = 0; y < LOGICAL_HEIGHT; y++) {
  for (let x = 4; x < 20; x++) {
    const rotatedX = 19 - y, rotatedY = x - 4;
    if (inkMap[y][x] !== inkMap[rotatedY][rotatedX]) throw new Error("Ring is not circularly symmetric");
    if (!inkMap[y][x]) continue;
    const start = (y * SCALE * width + x * SCALE) * 4;
    const rotated = (rotatedY * SCALE * width + rotatedX * SCALE) * 4;
    if (!decoded[0].subarray(start, start + 4).every((value, channel) => value === decoded[FRAMES / 4][rotated + channel]))
      throw new Error(`Gradient does not rotate clockwise at ${x},${y}`);
    clockwiseBlocks++;
  }
}
const decodedEvidence = {
  decodedBy: "sixel 0.16.0 decoder, WASM",
  frames: FRAMES,
  uniformBlocks,
  silhouetteMismatches,
  clockwiseBlocks,
  interiorStepPercent: [+(smallestStep * 100).toFixed(2), +(largestStep * 100).toFixed(2)],
  loopSeamStepPercent: +(seamStep * 100).toFixed(2),
  payloadBytes: payloads.reduce((total, payload) => total + Buffer.byteLength(payload, "latin1"), 0)
};

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
  "// Circular ring generated by native/logo-tools/generate-logo.mjs.",
  "// Runtime uses only this compiled data: no image decoder, encoder, process or package at paint time.",
  "internal static class LogoSixelData",
  "{",
  `    internal const int PixelWidth = ${width};`,
  `    internal const int PixelHeight = ${height};`,
  `    internal const int LogicalWidth = ${LOGICAL_WIDTH};`,
  `    internal const int LogicalHeight = ${LOGICAL_HEIGHT};`,
  `    internal const int Scale = ${SCALE};`,
  `    internal const int FallbackColumns = ${FALLBACK_COLUMNS};`,
  `    // Build-time decoded evidence: ${JSON.stringify(decodedEvidence)}`,
  `    internal const int UniformBlocks = ${uniformBlocks};`,
  `    internal const int SilhouetteMismatches = ${silhouetteMismatches};`,
  `    internal const int ClockwiseBlocks = ${clockwiseBlocks};`,
  `    internal const int InteriorMaxStepPercentX100 = ${Math.round(largestStep * 10000)};`,
  `    internal const int LoopSeamStepPercentX100 = ${Math.round(seamStep * 10000)};`,
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
  payloadBytes: payloads.reduce((total, payload) => total + Buffer.byteLength(payload, "latin1"), 0),
  fallbackRows: fallbackRows.length,
  ...decodedEvidence
}));
