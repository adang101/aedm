/**
 * The master palette from docs/style-bible.md: 8 ramps of 4 colors plus the outline color (33 colors).
 * Everything the DM or a designer model proposes is snapped to these before it is stored or drawn.
 */
export const RAMP_NAMES = ["grass", "stone", "earth", "sand", "water", "fire", "magic", "skin"] as const;
export type RampName = (typeof RAMP_NAMES)[number];

/** Ramp order is [dark, midDark, midLight, light]. */
export type Ramp = readonly [dark: string, midDark: string, midLight: string, light: string];

export const PALETTE: Readonly<Record<RampName, Ramp>> = {
  grass: ["#2f5d34", "#4f8a3c", "#7cb342", "#b5d66b"],
  stone: ["#3b3f55", "#5c6380", "#8b93b0", "#c4c9dc"],
  earth: ["#4a2f24", "#70472f", "#9a6a3f", "#c99a63"],
  sand: ["#8a6a2b", "#c99a3a", "#e8c95a", "#f6e8a0"],
  water: ["#1f3f7a", "#2f6bb5", "#4f9fe0", "#9fd4f5"],
  fire: ["#7a1f2b", "#c0392b", "#e8683a", "#f5a65b"],
  magic: ["#3d2a6b", "#6a45a8", "#9b72d8", "#cbb0f0"],
  skin: ["#6b3b2e", "#a5654a", "#d39a72", "#f2cfa6"],
};

/** Selective outline color: a hue-shifted dark, never pure black. */
export const OUTLINE_HEX = "#1b1626";

/** All 33 colors, lowercase, ramps in order then the outline. */
export const PALETTE_HEX: readonly string[] = [...RAMP_NAMES.flatMap((r) => [...PALETTE[r]]), OUTLINE_HEX];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function isHex(s: unknown): s is string {
  return typeof s === "string" && HEX6.test(s);
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

const PALETTE_RGB = PALETTE_HEX.map((h) => ({ hex: h, c: rgb(h) }));

/** "Redmean" weighted RGB distance (squared): cheap and closer to perceived difference than plain RGB. */
function distance(a: [number, number, number], b: [number, number, number]): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

/**
 * Nearest master palette color (lowercase hex). Ties go to the earlier palette entry, so the result is
 * deterministic. Throws on a value that is not `#rrggbb`; validate with `isHex` first.
 */
export function snapToPalette(hex: string): string {
  if (!isHex(hex)) throw new Error(`not a #rrggbb color: ${String(hex)}`);
  const c = rgb(hex);
  let best = PALETTE_RGB[0]!;
  let bestD = Infinity;
  for (const p of PALETTE_RGB) {
    const d = distance(c, p.c);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best.hex;
}

/** True when the color is exactly one of the 33 palette colors (case-insensitive). */
export function inPalette(hex: string): boolean {
  return isHex(hex) && PALETTE_HEX.includes(hex.toLowerCase());
}
