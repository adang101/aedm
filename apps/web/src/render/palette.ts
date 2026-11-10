/** Master palette helpers (docs/style-bible.md). Ramps come from @aedm/schemas so there is one source. */
import { OUTLINE_HEX, PALETTE as SCHEMA_PALETTE, RAMP_NAMES, type Ramp } from "@aedm/schemas";

export const OUTLINE = OUTLINE_HEX;
export const RAMPS = SCHEMA_PALETTE;
export const PALETTE: readonly string[] = RAMP_NAMES.flatMap((n) => [...SCHEMA_PALETTE[n]]);

/** Body color choices for the sprite picker: the two middle tones of each ramp. */
export const BODY_SWATCHES: readonly string[] = RAMP_NAMES.flatMap((n) => [SCHEMA_PALETTE[n][1], SCHEMA_PALETTE[n][2]]);
/** Accent color choices: the darkest and lightest tone of each ramp. */
export const ACCENT_SWATCHES: readonly string[] = RAMP_NAMES.flatMap((n) => [SCHEMA_PALETTE[n][0], SCHEMA_PALETTE[n][3]]);

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic palette color for an unknown id. */
export function paletteColorForGid(gid: number): string {
  const idx = Math.imul(gid, 2654435761) >>> 0;
  return PALETTE[idx % PALETTE.length] ?? PALETTE[0]!;
}

export function parseHex(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two #rrggbb colors; t = 0 gives a, t = 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

const RAMP_INDEX = new Map<string, { ramp: Ramp; i: number }>();
for (const n of RAMP_NAMES) SCHEMA_PALETTE[n].forEach((c, i) => RAMP_INDEX.set(c.toLowerCase(), { ramp: SCHEMA_PALETTE[n], i }));

/** Which ramp a palette color sits on, and its index (0 dark .. 3 light), or null. */
export function rampPosition(hex: string): { ramp: Ramp; i: number } | null {
  return RAMP_INDEX.get(hex.toLowerCase()) ?? null;
}

/**
 * Move `steps` along the master palette ramp (positive = lighter). Past an end of the ramp the color
 * keeps going toward white or the outline color. A color that is not on a ramp is lightened or darkened.
 * Always returns lowercase #rrggbb.
 */
export function shade(hex: string, steps: number): string {
  const h = hex.toLowerCase();
  const hit = RAMP_INDEX.get(h);
  if (hit && Number.isInteger(steps)) {
    const j = hit.i + steps;
    if (j >= 0 && j <= 3) return hit.ramp[j]!;
    if (j > 3) return mixHex(hit.ramp[3], "#ffffff", Math.min(1, 0.32 * (j - 3)));
    return mixHex(hit.ramp[0], OUTLINE, Math.min(1, 0.5 * -j));
  }
  if (steps === 0) return h;
  return steps > 0 ? mixHex(h, "#ffffff", Math.min(1, 0.22 * steps)) : mixHex(h, OUTLINE, Math.min(1, 0.3 * -steps));
}

/** Three tones and a highlight around a base color: light from the top left. */
export interface Tones { hi: string; base: string; sh: string; dk: string }

const toneCache = new Map<string, Tones>();
export function tones(hex: string): Tones {
  const key = hex.toLowerCase();
  let t = toneCache.get(key);
  if (!t) {
    t = { hi: shade(key, 1), base: key, sh: shade(key, -1), dk: shade(key, -2) };
    toneCache.set(key, t);
  }
  return t;
}

/** Relative luminance 0..1, for choosing a readable glyph color. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function readableOn(hex: string): string {
  return luminance(hex) > 0.5 ? OUTLINE : "#fff8e8";
}
