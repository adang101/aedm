/**
 * One small deterministic routine per material pattern. Each fills a 48 x 48 tile (seamless where it can)
 * with `color` as the base, `accent` for details and tones taken along the palette ramp.
 * `variant` (0 to 3) and `seed` move the details so repeated tiles do not look stamped.
 */
import { PATTERNS, type MaterialRole, type Pattern } from "@aedm/schemas";
import { mixHex, tones } from "./palette";
import { Pen, rint, rng } from "./px";

export const TS = 48;

export interface PatternOpts {
  color: string;
  accent: string;
  variant: number;
  seed: number;
  role: MaterialRole;
  /** Liquids draw their moving crests into a separate transparent overlay. */
  layer: "base" | "overlay";
}

export type PatternFn = (p: Pen, o: PatternOpts) => void;

const fill = (p: Pen, c: string) => p.rect(0, 0, TS, TS, c);
const wrap = (v: number) => ((v % TS) + TS) % TS;

const RUNES: readonly (readonly string[])[] = [
  ["..#..", ".###.", "#.#.#", "..#..", "#.#.#", ".###.", "..#.."],
  ["#...#", "##.##", "#.#.#", "#...#", "#.#.#", "##.##", "#...#"],
  ["..#..", "..#..", "#####", "..#..", ".###.", "#.#.#", "#...#"],
  [".###.", "#...#", "#.#.#", ".#.#.", "#.#.#", "#...#", ".###."],
  ["#####", "..#..", ".###.", "#.#.#", ".###.", "..#..", "#####"],
];

export const PATTERN_DRAWERS: Record<Pattern, PatternFn> = {
  none: (p, o) => fill(p, o.color),

  dots(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.base);
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const x = gx * 16 + 3 + rint(r, 9), y = gy * 16 + 3 + rint(r, 9);
        p.rect(x, y, 2, 2, r() < 0.65 ? t.sh : t.hi);
        if (r() < 0.3) p.px(x + 5, y + 6, t.hi);
      }
    }
  },

  stripes(p, o) {
    const t = tones(o.color), off = o.variant * 3;
    fill(p, t.base);
    for (let y = 0; y < TS; y++) {
      for (let k = 0; k < 4; k++) {
        const x = wrap(k * 12 - y + off);
        p.rect(x, y, 2, 1, t.sh);
        p.px(x + 2, y, t.hi);
      }
    }
  },

  cross(p, o) {
    const t = tones(o.color);
    fill(p, t.base);
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const cx = wrap(gx * 16 + 8 + (gy % 2) * 8 + o.variant), cy = gy * 16 + 8;
        p.rect(cx - 2, cy, 5, 1, t.sh);
        p.rect(cx, cy - 2, 1, 5, t.sh);
        p.px(cx, cy, t.hi);
      }
    }
  },

  bricks(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.dk);
    const RH = 12, BW = 24;
    for (let row = 0; row < 4; row++) {
      const off = ((row + o.variant) % 2) * 12;
      for (let bx = -1; bx < 3; bx++) {
        const x = bx * BW + off, y = row * RH;
        const pick = r();
        const face = pick < 0.25 ? t.sh : pick < 0.5 ? mixHex(t.base, t.hi, 0.3) : t.base;
        p.rect(x + 1, y + 1, BW - 1, RH - 1, face);
        p.rect(x + 1, y + 1, BW - 1, 1, t.hi);
        p.rect(x + 1, y + RH - 1, BW - 1, 1, t.sh);
        if (r() < 0.12) p.rect(x + 3 + rint(r, 12), y + 1, 5, 2, a.base);
      }
    }
  },

  planks(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.base);
    for (let row = 0; row < 4; row++) {
      const y = row * 12;
      p.rect(0, y, TS, 11, row % 2 ? mixHex(t.base, t.hi, 0.22) : t.base);
      p.rect(0, y, TS, 1, t.hi);
      p.rect(0, y + 11, TS, 1, t.dk);
      const jx = wrap(10 + row * 17 + o.variant * 5);
      p.rect(jx, y + 1, 1, 10, t.dk);
      p.px(jx + 3, y + 3, t.sh); p.px(jx - 3, y + 8, t.sh);
      for (let k = 0; k < 3; k++) { const gx = rint(r, 40), gy = y + 2 + rint(r, 7); p.rect(gx, gy, 3 + rint(r, 7), 1, t.sh); }
    }
  },

  cobbles(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.dk);
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        const x = gx * 12 + (gy % 2) * 3 + rint(r, 2), y = gy * 12 + rint(r, 2);
        const pick = r();
        const face = pick < 0.3 ? mixHex(t.base, t.hi, 0.3) : pick < 0.55 ? mixHex(t.base, t.sh, 0.4) : t.base;
        p.rrect(x, y, 11, 11, 3, face);
        p.rect(x + 2, y + 1, 5, 1, t.hi);
        p.rect(x + 1, y + 2, 1, 3, t.hi);
        p.rect(x + 3, y + 10, 6, 1, t.sh);
      }
    }
  },

  tiles(p, o) {
    const t = tones(o.color), a = tones(o.accent);
    fill(p, t.dk);
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const odd = (gx + gy + o.variant) % 2 === 1;
        const x = gx * 16, y = gy * 16;
        p.rect(x + 1, y + 1, 15, 15, odd ? mixHex(t.base, t.sh, 0.4) : t.base);
        p.rect(x + 1, y + 1, 15, 1, t.hi);
        p.rect(x + 1, y + 1, 1, 15, t.hi);
        if (odd && o.accent.toLowerCase() !== o.color.toLowerCase()) { p.rect(x + 7, y + 7, 3, 3, a.base); p.px(x + 7, y + 7, a.hi); }
      }
    }
  },

  waves(p, o) {
    const t = tones(o.color);
    const row = (y0: number, c: string, from: number, len: number) => {
      for (let x = from; x < from + len; x++) {
        const xx = wrap(x);
        p.px(xx, y0 + Math.round(1.5 * Math.sin((xx / 24) * Math.PI * 2)), c);
      }
    };
    if (o.layer === "overlay") {
      for (let k = 0; k < 4; k++) row(7 + k * 12 + (o.variant % 2) * 3, t.hi, k * 17 + 4, 9);
      return;
    }
    fill(p, t.base);
    for (let k = 0; k < 4; k++) row(12 + k * 12, t.sh, 0, TS);
    p.rect(0, 0, TS, 1, t.base);
  },

  cracks(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.base);
    const glow = o.role === "hazard" || o.role === "liquid";
    const n = 3 + (o.variant % 2);
    for (let k = 0; k < n; k++) {
      let x = rint(r, TS), y = rint(r, TS), dir = r() * Math.PI * 2;
      const steps = 6 + rint(r, 6);
      for (let s = 0; s < steps; s++) {
        dir += (r() - 0.5) * 1.6;
        const nx = x + Math.round(Math.cos(dir) * 3), ny = y + Math.round(Math.sin(dir) * 3);
        if (glow) p.line(x + 1, y + 1, nx + 1, ny + 1, a.base);
        p.line(x, y, nx, ny, glow ? t.dk : t.sh);
        x = nx; y = ny;
      }
    }
    for (let k = 0; k < 6; k++) p.px(rint(r, TS), rint(r, TS), t.hi);
  },

  grain(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.base);
    for (let k = 0; k < 11; k++) {
      const x = rint(r, 40); let y = 2 + rint(r, 44);
      const len = 8 + rint(r, 10), c = r() < 0.7 ? t.sh : t.hi;
      for (let i = 0; i < len; i++) { p.px(x + i, y, c); if (r() < 0.12) y += r() < 0.5 ? -1 : 1; }
    }
    for (let k = 0; k < 2; k++) { const x = 6 + rint(r, 34), y = 6 + rint(r, 34); p.rect(x, y, 3, 2, t.dk); p.px(x + 1, y, t.sh); }
  },

  grass(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.base);
    for (let k = 0; k < 4; k++) p.rect(rint(r, 40), rint(r, 44), 6 + rint(r, 4), 2, t.sh);
    for (let k = 0; k < 11; k++) {
      const x = 2 + rint(r, 43), y = 4 + rint(r, 41);
      p.rect(x - 2, y - 1, 1, 2, t.hi);
      p.rect(x, y - 2, 1, 3, t.hi);
      p.rect(x + 2, y - 1, 1, 2, t.sh);
      p.px(x, y + 1, t.sh);
    }
    if (o.accent.toLowerCase() !== o.color.toLowerCase() && o.variant !== 3) {
      for (let k = 0; k < 2; k++) { const x = 4 + rint(r, 38), y = 4 + rint(r, 38); p.rect(x, y, 2, 2, a.base); p.px(x, y, a.hi); }
    }
  },

  sand(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.base);
    for (let k = 0; k < 5; k++) {
      const x = rint(r, 36), y = 3 + rint(r, 42), len = 8 + rint(r, 8);
      for (let i = 0; i < len; i++) p.px(x + i, y + Math.round(Math.sin(i / 3) * 1), t.sh);
      for (let i = 2; i < len - 2; i++) p.px(x + i, y + 1 + Math.round(Math.sin(i / 3) * 1), t.hi);
    }
    for (let k = 0; k < 7; k++) p.px(rint(r, TS), rint(r, TS), k % 3 === 0 ? a.base : t.hi);
  },

  speckle(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.base);
    for (let k = 0; k < 18; k++) p.px(rint(r, TS), rint(r, TS), r() < 0.55 ? t.sh : t.hi);
    for (let k = 0; k < 3; k++) p.rect(rint(r, 44), rint(r, 46), 2, 1, a.base);
  },

  rings(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.base);
    const cx = 24 + rint(r, 9) - 4, cy = 24 + rint(r, 9) - 4;
    for (const rad of [30, 23, 16, 9]) {
      p.ell(cx, cy, rad, rad, t.sh);
      p.ell(cx - 0.5, cy - 0.5, rad - 1.5, rad - 1.5, t.base);
    }
    p.ell(cx, cy, 3, 3, t.dk);
    p.ell(cx - 0.5, cy - 0.5, 1.5, 1.5, t.sh);
  },

  scales(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.dk);
    for (let row = -1; row < 9; row++) {
      for (let col = -1; col < 5; col++) {
        const cx = col * 12 + (row % 2) * 6 + 6, cy = row * 6 + 4;
        const accent = r() < 0.12;
        const c = accent ? a : t;
        p.ell(cx, cy, 6, 5, c.dk);
        p.ell(cx, cy - 0.5, 5, 4.2, c.base);
        p.rect(cx - 3, cy - 3, 3, 1, c.hi);
        p.rect(cx - 4, cy - 2, 1, 2, c.hi);
      }
    }
  },

  runes(p, o) {
    const t = tones(o.color), a = tones(o.accent), r = rng(o.seed);
    fill(p, t.base);
    p.ell(24, 24, 20, 20, t.sh);
    p.ell(24, 24, 18.5, 18.5, t.base);
    const spots: Pt2[] = [[10, 8], [31, 10], [8, 31], [32, 31]];
    for (const [sx, sy] of spots) {
      const g = RUNES[rint(r, RUNES.length)]!;
      const x = sx + rint(r, 3), y = sy + rint(r, 3);
      g.forEach((line, gy) => [...line].forEach((ch, gx) => {
        if (ch === "#") { p.px(x + gx + 1, y + gy + 1, t.dk); p.px(x + gx, y + gy, a.base); }
      }));
    }
    for (let k = 0; k < 4; k++) p.px(rint(r, TS), rint(r, TS), a.hi);
  },

  glow(p, o) {
    const t = tones(o.color), r = rng(o.seed);
    fill(p, t.base);
    for (let k = 0; k < 2; k++) {
      const cx = 12 + rint(r, 24), cy = 12 + rint(r, 24);
      p.ell(cx, cy, 15, 13, mixHex(t.base, o.accent, 0.18));
      p.ell(cx, cy, 10, 8.5, mixHex(t.base, o.accent, 0.42));
      p.ell(cx, cy, 5.5, 4.5, mixHex(t.base, o.accent, 0.78));
      p.ell(cx, cy, 2, 1.6, tones(o.accent).hi);
    }
    for (let k = 0; k < 6; k++) p.px(rint(r, TS), rint(r, TS), tones(o.accent).base);
  },

  lattice(p, o) {
    const t = tones(o.color), a = tones(o.accent);
    fill(p, t.base);
    const off = o.variant * 2;
    for (let y = 0; y < TS; y++) {
      for (let k = 0; k < 4; k++) {
        const x1 = wrap(k * 12 - y + off), x2 = wrap(k * 12 + y + off);
        p.px(x1, y, t.dk); p.px(x1 + 1, y, t.sh);
        p.px(x2, y, t.dk); p.px(x2 + 1, y, t.sh);
      }
    }
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) {
      if ((gx + gy) % 2 === 0) p.rect(wrap(gx * 12 + off + 6 - 1), gy * 12 + 5, 2, 2, a.base);
    }
  },
};

type Pt2 = readonly [number, number];

/** Every pattern in the schema, for tests and the gallery. */
export const ALL_PATTERNS: readonly Pattern[] = PATTERNS;
