/** Master palette from docs/style-bible.md. */
export const OUTLINE = "#1b1626";

export const RAMPS = {
  grass: ["#2f5d34", "#4f8a3c", "#7cb342", "#b5d66b"],
  stone: ["#3b3f55", "#5c6380", "#8b93b0", "#c4c9dc"],
  earth: ["#4a2f24", "#70472f", "#9a6a3f", "#c99a63"],
  sand: ["#8a6a2b", "#c99a3a", "#e8c95a", "#f6e8a0"],
  water: ["#1f3f7a", "#2f6bb5", "#4f9fe0", "#9fd4f5"],
  fire: ["#7a1f2b", "#c0392b", "#e8683a", "#f5a65b"],
  magic: ["#3d2a6b", "#6a45a8", "#9b72d8", "#cbb0f0"],
  skin: ["#6b3b2e", "#a5654a", "#d39a72", "#f2cfa6"],
} as const;

export const PALETTE: readonly string[] = Object.values(RAMPS).flat();

/** Body color choices for the sprite picker: the two middle tones of each ramp. */
export const BODY_SWATCHES: readonly string[] = Object.values(RAMPS).flatMap((r) => [r[1], r[2]]);
/** Accent color choices: the darkest and lightest tone of each ramp. */
export const ACCENT_SWATCHES: readonly string[] = Object.values(RAMPS).flatMap((r) => [r[0], r[3]]);

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic palette color for an unknown tile id. */
export function paletteColorForGid(gid: number): string {
  const idx = Math.imul(gid, 2654435761) >>> 0;
  return PALETTE[idx % PALETTE.length] ?? PALETTE[0]!;
}

function parse(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix `hex` toward black (amount < 0) or white (amount > 0). amount in [-1, 1]. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = parse(hex);
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  const m = (c: number) => Math.round(c + (t - c) * k);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}

/** Relative luminance 0..1, for choosing a readable glyph color. */
export function luminance(hex: string): number {
  const [r, g, b] = parse(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function readableOn(hex: string): string {
  return luminance(hex) > 0.5 ? OUTLINE : "#fff8e8";
}
