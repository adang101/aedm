/**
 * Legibility rule for generated maps: a wall must read against the floor and the paths it borders. Luminance is
 * the plain Rec. 709 weighting on 0..1, the same number the web renderer uses for text contrast.
 * `ensureWallContrast` moves a wall material to a palette color that is far enough from every floor and path
 * color, preferring its own ramp and the darker side (a dark wall reads as solid mass).
 */
import { OUTLINE_HEX, PALETTE, PALETTE_HEX } from "@aedm/schemas";
import type { Material, MaterialRole } from "@aedm/schemas";
import { rampPosition } from "./materials";

/** Smallest luminance gap between any wall color and any floor or path color. The hand-built crypt sits at 0.15. */
export const MIN_WALL_CONTRAST = 0.13;

export function lum(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

type Mats = Record<MaterialRole, Material[]>;

const groundLums = (m: Mats): number[] => [...m.floor, ...m.path].map((x) => lum(x.color));

/** Smallest luminance gap between a wall and a floor or path material (Infinity when there is no wall). */
export function wallFloorContrast(m: Mats): number {
  const g = groundLums(m);
  let min = Infinity;
  for (const w of m.wall) for (const f of g) min = Math.min(min, Math.abs(lum(w.color) - f));
  return min;
}

const gap = (c: string, refs: readonly number[]): number => refs.reduce((n, f) => Math.min(n, Math.abs(lum(c) - f)), Infinity);

/** Replacement colors for a wall color, best first: its own ramp (darker side first), then neutral stone and the outline color, then the whole palette by closeness. */
function candidates(color: string): string[] {
  const pos = rampPosition(color);
  const darker: string[] = [];
  const lighter: string[] = [];
  if (pos) {
    const ramp = PALETTE[pos.ramp];
    for (let i = pos.index; i >= 0; i--) darker.push(ramp[i]!);
    for (let i = pos.index + 1; i <= 3; i++) lighter.push(ramp[i]!);
  }
  // neutral stone and the outline color read as solid in any palette; lighter colors only as a last resort
  const stone = PALETTE.stone;
  const neutral = [stone[1], stone[0], OUTLINE_HEX, stone[2], stone[3]];
  const l = lum(color);
  const rest = [...PALETTE_HEX].sort((a, b) => Math.abs(lum(a) - l) - Math.abs(lum(b) - l) || lum(a) - lum(b));
  return [...darker, ...neutral, ...lighter, ...rest];
}

function accentFor(color: string): string {
  const pos = rampPosition(color);
  if (!pos) return PALETTE.stone[1];
  return PALETTE[pos.ramp][pos.index >= 2 ? pos.index - 1 : pos.index + 1]!;
}

/**
 * Makes every wall material clear the floors and paths by `MIN_WALL_CONTRAST`. When the floors and paths are
 * spread so wide that no single wall color could clear all of them, only the first (most characteristic)
 * floor and path are kept. Mutates and returns `m`.
 */
export function ensureWallContrast(m: Mats): Mats {
  if (m.wall.length === 0) return m;
  let refs = groundLums(m);
  if (!PALETTE_HEX.some((c) => gap(c, refs) >= MIN_WALL_CONTRAST)) {
    m.floor = m.floor.slice(0, 1);
    m.path = m.path.slice(0, 1);
    refs = groundLums(m);
  }
  m.wall = m.wall.map((w) => {
    if (gap(w.color, refs) >= MIN_WALL_CONTRAST) return w;
    const color = candidates(w.color).find((c) => gap(c, refs) >= MIN_WALL_CONTRAST);
    return color ? { ...w, color, accent: accentFor(color) } : w;
  });
  return m;
}
