/**
 * One layer routine per part in PART_CATALOG, placed relative to the body-plan anchors. A part picks a color
 * slot (its own default unless the spec overrides it), draws with that slot's three tones and highlight, and
 * says which layer it belongs to so the composer can order it: behind the body, over the body, over the head,
 * in the hand, or in front of everything (auras and effects).
 */
import type { BodyPlan, Part, PartColor, PartSide, SpritePose } from "@aedm/schemas";
import { RAMPS, type Tones } from "./palette";
import { OUTLINE } from "./palette";
import type { Pen } from "./px";
import type { Anchors } from "./sprite-anchors";
import { Xf, chain, ring, type Pal } from "./sprite-kit";

export type PartLayer = "behind" | "body" | "head" | "held" | "front";

export interface PartCtx {
  p: Pen;
  a: Anchors;
  pal: Pal;
  /** The tones of the part's color slot. */
  c: Tones;
  side: PartSide;
  frame: number;
  pose: SpritePose;
  body: BodyPlan;
}

export interface PartDef {
  layer: PartLayer;
  color: PartColor;
  draw(c: PartCtx): void;
}

const E = RAMPS.earth;
const sides = (side: PartSide, dflt: "both" | "left" | "right"): (1 | -1)[] => {
  const s = side === "both" && dflt !== "both" ? dflt : side;
  return s === "both" ? [-1, 1] : s === "left" ? [-1] : [1];
};

function eyeDots(p: Pen, a: Anchors, fill: string, rim: string, hi: string): void {
  for (const e of a.eyes) { p.rect(e.x - 1, e.y - 1, 4, 4, rim); p.rect(e.x, e.y - 1 + 1, 2, 3, fill); p.px(e.x, e.y, hi); }
}

function flameCol(p: Pen, cx: number, base: number, s: number, frame: number, c: Tones): void {
  const f = frame % 2, h = (n: number) => Math.round(n * s);
  p.poly([[cx, base - h(13) - f], [cx + h(5), base - h(5)], [cx + h(3), base], [cx - h(3), base], [cx - h(5), base - h(5)]], c.base);
  p.poly([[cx + f, base - h(8)], [cx + h(3), base - h(3)], [cx + h(2), base], [cx - h(2), base], [cx - h(3), base - h(3)]], c.hi);
}

function star(p: Pen, cx: number, cy: number, s: number, c: Tones): void {
  p.rect(cx - s, cy, s * 2 + 1, 1, c.base);
  p.rect(cx, cy - s, 1, s * 2 + 1, c.base);
  p.rect(cx - 1, cy - 1, 3, 3, c.hi);
}

function leaf(p: Pen, x: number, y: number, dir: 1 | -1, c: Tones): void {
  p.poly([[x, y], [x + 3 * dir, y - 3], [x + 8 * dir, y - 1], [x + 3 * dir, y + 2]], c.base);
  p.poly([[x, y], [x + 3 * dir, y - 3], [x + 8 * dir, y - 1]], c.hi);
  p.line(x + dir, y, x + 7 * dir, y - 1, c.dk);
}

const gear = (p: Pen, cx: number, cy: number, r: number, frame: number, c: Tones): void => {
  const rot = frame ? Math.PI / 8 : 0;
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2 + rot;
    p.rect(cx + Math.cos(t) * (r + 1) - 1.5, cy + Math.sin(t) * (r + 1) - 1.5, 3, 3, c.sh);
  }
  p.ell(cx, cy, r + 0.5, r + 0.5, c.sh); p.ell(cx - 0.4, cy - 0.4, r - 0.5, r - 0.5, c.base);
  p.ell(cx, cy, r * 0.42, r * 0.42, OUTLINE); p.px(cx - r * 0.5, cy - r * 0.6, c.hi);
};

/** Tilt of a held item: upright and slightly outward, or raised and forward when aggressive. */
function grip(c: PartCtx, s: 1 | -1): Xf {
  const h = s === 1 ? c.a.handR : c.a.handL;
  const ang = c.pose === "aggressive" && s === 1 ? 0.75 : c.pose === "cowering" ? 0.05 : 0.14;
  return new Xf(c.p, h.x, h.y, ang, s);
}

export const PART_DRAWERS: Record<Part, PartDef> = {
  // ---------------- head ----------------
  horns: { layer: "head", color: "detail", draw({ p, a, c }) {
    const { cx, cy, rx, ry } = a.head;
    for (const s of [-1, 1] as const) {
      const bx = cx + s * rx * 0.55, by = cy - ry * 0.7;
      p.poly([[bx - 3, by + 2], [bx - 2 + s * 1, by - 5], [bx + s * 6, by - 11], [bx + s * 3 + 2, by - 4], [bx + 3, by + 2]], c.sh);
      p.poly([[bx - 2, by + 2], [bx - 1 + s, by - 5], [bx + s * 6, by - 11], [bx + s * 2, by - 3]], c.base);
      p.px(bx - 1 + s, by - 4, c.hi); p.px(bx + s * 3, by - 7, c.hi);
    }
  } },
  antlers: { layer: "head", color: "detail", draw({ p, a, c, frame }) {
    const { cx, cy, rx, ry } = a.head;
    for (const s of [-1, 1] as const) {
      const bx = cx + s * rx * 0.5, by = cy - ry * 0.75;
      p.line(bx, by + 1, bx + s * 5, by - 9, c.sh, 3);
      p.line(bx, by + 1, bx + s * 5, by - 9, c.base, 1);
      p.line(bx + s * 2, by - 4, bx + s * 8, by - 7, c.base, 2);
      p.line(bx + s * 5, by - 9, bx + s * 4, by - 15 - (frame ? 0 : 0), c.base, 2);
      p.line(bx + s * 4, by - 12, bx + s * 9, by - 14, c.hi, 1);
    }
  } },
  hood: { layer: "head", color: "secondary", draw({ p, a, c, pal }) {
    const { cx, cy, rx, ry } = a.head;
    p.poly([[cx - rx * 0.5, cy - ry * 0.7], [cx + 2, cy - ry - 5], [cx + rx * 0.7, cy - ry * 0.6]], c.base);
    p.blob(cx, cy - 0.5, rx + 2.5, ry + 2, c);
    p.rect(cx - rx - 1, cy + ry - 4, 2 * rx + 3, 3, c.sh);
    p.ell(cx + 2, cy + 2, rx - 3.5, ry - 4.5, c.dk);
    p.ell(cx + 2, cy + 3, rx - 4.5, ry - 6, pal.primary.base);
    p.rect(cx - 2, cy + 2, rx, 2, pal.primary.hi);
    p.ell(cx + 2, cy + ry - 3, rx - 4, 2, pal.primary.sh);
    for (const e of a.eyes) p.rect(e.x, e.y, 2, 3, OUTLINE);
    p.rect(cx - rx + 1, cy - ry + 2, 3, 3, c.hi);
  } },
  hat: { layer: "head", color: "secondary", draw({ p, a, c, pal }) {
    const { cx, cy, rx, ry } = a.head;
    const by = cy - ry * 0.55;
    p.poly([[cx - rx * 0.62, by], [cx + 5, by - 20], [cx + rx * 0.62, by]], c.sh);
    p.poly([[cx - rx * 0.62, by], [cx + 5, by - 20], [cx - 1, by]], c.base);
    p.poly([[cx + 5, by - 20], [cx + 9, by - 16], [cx + 5, by - 16]], c.dk);
    p.ell(cx, by + 1, rx + 5, 3.8, c.dk); p.ell(cx, by, rx + 4, 3.2, c.base); p.rect(cx - rx, by - 2, 6, 1, c.hi);
    p.rect(cx - rx * 0.62 + 1, by - 4, rx * 1.24 - 2, 3, pal.accent.base); p.rect(cx - 2, by - 4, 4, 3, pal.accent.hi);
  } },
  helmet: { layer: "head", color: "detail", draw({ p, a, c, pal }) {
    const { cx, cy, rx, ry } = a.head;
    p.clipRect(0, 0, 48, cy + 2, () => p.blob(cx, cy - 2, rx + 1.5, ry + 0.5, c));
    p.rect(cx - rx - 1, cy + 1, 2 * rx + 3, 2, c.dk);
    p.rect(cx + 2, cy - 1, 3, 9, c.sh); p.rect(cx + 2, cy - 1, 1, 9, c.hi);
    p.rect(cx - rx + 3, cy - 4, 2 * rx - 6, 1, c.dk);
    p.rect(cx - 1, cy - ry - 5, 4, 6, pal.accent.base); p.rect(cx - 1, cy - ry - 5, 4, 1, pal.accent.hi);
    for (const e of a.eyes) p.rect(e.x, e.y, 2, 3, OUTLINE);
  } },
  crown: { layer: "head", color: "accent", draw({ p, a, c }) {
    const { cx, cy, rx, ry } = a.head;
    const x0 = Math.round(cx - rx * 0.62), x1 = Math.round(cx + rx * 0.62), by = Math.round(cy - ry * 0.62);
    p.poly([[x0, by + 2], [x0, by - 7], [x0 + 4, by - 3], [cx, by - 9], [x1 - 4, by - 3], [x1, by - 7], [x1, by + 2]], c.dk);
    p.poly([[x0 + 1, by + 2], [x0 + 1, by - 5], [x0 + 4, by - 2], [cx, by - 7], [x1 - 4, by - 2], [x1 - 1, by - 5], [x1 - 1, by + 2]], c.base);
    p.rect(x0 + 1, by - 1, x1 - x0 - 1, 1, c.hi);
    p.rect(cx - 1, by - 1, 3, 3, "#c0392b"); p.px(cx - 1, by - 1, "#f5a65b");
    p.px(x0 + 1, by - 6, c.hi); p.px(x1 - 1, by - 6, c.hi);
  } },
  mask: { layer: "head", color: "detail", draw({ p, a, c }) {
    const f = a.eyes.length ? a.eyes.reduce((s, e) => s + e.x, 0) / a.eyes.length : a.head.cx;
    const fy = a.eyes.length ? a.eyes[0]!.y : a.head.cy;
    const w = Math.max(6, a.eyes.length > 1 ? a.eyes[1]!.x - a.eyes[0]!.x + 6 : 8);
    p.rrect(f - w, fy - 3, w * 2 + 1, 10, 3, c.dk);
    p.rrect(f - w + 1, fy - 3, w * 2 - 1, 9, 3, c.base);
    p.rect(f - w + 2, fy - 2, w, 1, c.hi);
    for (const e of a.eyes) p.rect(e.x - 1, e.y, 3, 3, OUTLINE);
    p.rect(f - 1, fy + 3, 3, 3, c.sh);
  } },
  halo: { layer: "front", color: "accent", draw({ p, a, c, frame }) {
    const { cx } = a.head;
    const y = a.headTop.y - 3;
    for (let i = 0; i < 40; i++) {
      const t = (i / 40) * Math.PI * 2;
      p.rect(cx + Math.cos(t) * 9 - 1, y + Math.sin(t) * 3 - 1, 2, 2, i % 6 === frame ? c.hi : c.base);
    }
  } },
  beard: { layer: "head", color: "detail", draw({ p, a, c }) {
    const { cx, cy, rx, ry } = a.head;
    const fx = cx + 2;
    p.poly([[fx - rx * 0.75, cy + 3], [fx + rx * 0.75, cy + 3], [fx + rx * 0.45, cy + ry + 7], [fx, cy + ry + 11], [fx - rx * 0.5, cy + ry + 7]], c.dk);
    p.poly([[fx - rx * 0.7, cy + 4], [fx + rx * 0.7, cy + 4], [fx + rx * 0.4, cy + ry + 6], [fx, cy + ry + 9], [fx - rx * 0.45, cy + ry + 6]], c.base);
    p.rect(fx - rx * 0.6, cy + 5, 3, 7, c.hi);
    p.rect(fx - 1, cy + ry - 1, 1, 7, c.sh); p.rect(fx + 3, cy + ry, 1, 5, c.sh);
    p.rect(fx - 2, cy + 4, 5, 1, c.dk);
  } },
  long_hair: { layer: "head", color: "detail", draw({ p, a, c }) {
    const { cx, cy, rx, ry } = a.head;
    p.blob(cx - rx + 1, cy + 8, 4.5, 11, c); p.blob(cx + rx - 1, cy + 8, 4.5, 11, c);
    p.ell(cx, cy - ry * 0.45, rx + 1.5, ry * 0.62, c.sh);
    p.ell(cx - 0.5, cy - ry * 0.5, rx + 0.5, ry * 0.55, c.base);
    p.rect(cx - rx + 2, cy - ry + 3, 6, 2, c.hi);
    p.rect(cx - rx + 4, cy - 3, 2 * rx - 8, 2, c.base);
    for (const e of a.eyes) p.rect(e.x, e.y, 2, 3, OUTLINE);
  } },
  ears_pointed: { layer: "head", color: "primary", draw({ p, a, c }) {
    const { cx, cy, rx } = a.head;
    for (const s of [-1, 1] as const) {
      p.poly([[cx + s * (rx - 1), cy - 3], [cx + s * (rx + 8), cy - 10], [cx + s * (rx - 1), cy + 4]], c.sh);
      p.poly([[cx + s * (rx - 1), cy - 2], [cx + s * (rx + 6), cy - 9], [cx + s * (rx - 1), cy + 1]], c.base);
      p.px(cx + s * (rx + 3), cy - 6, c.hi);
    }
  } },
  glowing_eyes: { layer: "head", color: "accent", draw({ p, a, c }) { eyeDots(p, a, c.hi, c.sh, "#ffffff"); } },
  extra_eyes: { layer: "head", color: "accent", draw({ p, a, c }) {
    const ex = a.eyes.map((e) => e.x), ey = a.eyes[0]?.y ?? a.head.cy;
    const mid = ex.length ? ex.reduce((s, v) => s + v, 0) / ex.length : a.head.cx;
    const spots: [number, number][] = a.body === "insectoid" || a.body === "amorphous" || a.body === "construct"
      ? [[mid - 6, ey - 6], [mid + 3, ey - 7], [mid + 9, ey - 5]]
      : [[mid - 5, ey - 6], [mid + 1, ey - 8], [mid + 6, ey - 6]];
    for (const [x, y] of spots) { p.rect(x - 1, y - 1, 4, 4, OUTLINE); p.rect(x, y, 2, 2, c.base); p.px(x, y, c.hi); }
  } },

  // ---------------- body ----------------
  robe: { layer: "body", color: "secondary", draw({ p, a, c, pal }) {
    const g = a.garment, t = g.cx;
    const poly = (ins: number, col: string) => p.poly([[t - g.halfTop + ins, g.top], [t + g.halfTop - ins, g.top], [t + g.halfHem - ins, g.hem], [t - g.halfHem + ins, g.hem]], col);
    poly(0, c.dk); poly(1, c.sh);
    p.poly([[t - g.halfTop + 1, g.top], [t + 2, g.top], [t + 3, g.hem], [t - g.halfHem + 1, g.hem]], c.base);
    p.rect(t - g.halfTop + 2, g.top + 1, 3, 10, c.hi);
    for (const dx of [-5, 0, 5]) p.line(t + dx, g.top + 9, t + dx * 1.4, g.hem - 2, c.dk);
    p.rect(t - g.halfHem + 1, g.hem - 3, g.halfHem * 2 - 2, 2, pal.accent.base);
    p.rect(t - 1, g.top + 1, 3, g.hem - g.top - 4, pal.accent.sh);
    if (a.body === "humanoid") {
      p.rrect(8, 33, 8, 13, 3, c.dk); p.rrect(32, 33, 8, 13, 3, c.dk);
      p.rrect(9, 33, 6, 12, 3, c.base); p.rrect(33, 33, 6, 12, 3, c.sh);
      p.rect(9, 43, 6, 2, pal.accent.base); p.rect(33, 43, 6, 2, pal.accent.base);
    }
  } },
  cloak: { layer: "behind", color: "secondary", draw({ p, a, c, frame }) {
    const g = a.garment, t = a.torso, sw = frame ? 1 : 0;
    const top = g.top - 2;
    p.poly([[t.cx - t.rx - 2, top], [t.cx + t.rx + 2, top], [t.cx + t.rx + 9 + sw, g.hem + 1], [t.cx - t.rx - 9 - sw, g.hem + 1]], c.dk);
    p.poly([[t.cx - t.rx - 1, top + 1], [t.cx + t.rx + 1, top + 1], [t.cx + t.rx + 8 + sw, g.hem], [t.cx - t.rx - 8 - sw, g.hem]], c.sh);
    p.poly([[t.cx - t.rx - 1, top + 1], [t.cx - 2, top + 1], [t.cx - 4, g.hem], [t.cx - t.rx - 8 - sw, g.hem]], c.base);
    p.rect(t.cx - t.rx + 1, top + 4, 2, 10, c.hi);
  } },
  armor: { layer: "body", color: "detail", draw({ p, a, c, pal }) {
    const t = a.torso;
    p.rrect(t.cx - t.rx - 0.5, t.cy - t.ry - 0.5, t.rx * 2 + 1, t.ry * 2 - 1, 3, c.dk);
    p.rrect(t.cx - t.rx + 0.5, t.cy - t.ry + 0.5, t.rx * 2 - 1, t.ry * 2 - 3, 3, c.base);
    p.rect(t.cx - t.rx + 1, t.cy - t.ry + 1, 3, t.ry * 2 - 5, c.hi);
    p.rect(t.cx + t.rx - 4, t.cy - t.ry + 2, 3, t.ry * 2 - 5, c.sh);
    p.rect(t.cx, t.cy - t.ry + 2, 1, t.ry * 2 - 5, c.dk);
    p.rect(t.cx - t.rx + 1, t.cy + 1, t.rx * 2 - 2, 1, c.dk);
    p.rect(t.cx - 1, t.cy - 2, 3, 3, pal.accent.base);
    if (a.body === "humanoid" || a.body === "construct") {
      for (const s of [-1, 1] as const) { p.blob(t.cx + s * (t.rx + 1), t.cy - t.ry + 1, 4.5, 3.5, c); p.rect(t.cx + s * (t.rx + 1) - 1, t.cy - t.ry + 1, 2, 1, pal.accent.base); }
    }
  } },
  scales: { layer: "body", color: "secondary", draw({ p, a, c }) {
    const t = a.torso;
    p.atop(() => p.clipRect(t.cx - t.rx, t.cy - t.ry, t.rx * 2, t.ry * 2, () => {
      for (let row = 0; row < Math.ceil((t.ry * 2) / 4) + 1; row++) {
        for (let col = 0; col < Math.ceil((t.rx * 2) / 6) + 1; col++) {
          const x = t.cx - t.rx + col * 6 + (row % 2) * 3, y = t.cy - t.ry + row * 4;
          p.ell(x, y, 3.2, 2.8, c.dk); p.ell(x, y - 0.4, 2.5, 2.1, c.base); p.px(x - 1, y - 1, c.hi);
        }
      }
    }));
  } },
  fur: { layer: "body", color: "primary", draw({ p, a, c }) {
    const t = a.torso;
    p.atop(() => p.clipRect(t.cx - t.rx, t.cy - t.ry, t.rx * 2, t.ry * 2, () => {
      for (let y = 0; y < t.ry * 2; y += 3) for (let x = (y % 6) / 3 * 2; x < t.rx * 2; x += 4) {
        p.px(t.cx - t.rx + x, t.cy - t.ry + y, c.hi); p.px(t.cx - t.rx + x + 1, t.cy - t.ry + y + 1, c.sh);
      }
    }));
    for (const ang of [-2.6, -2.1, -1.6, -1.1, -0.6, 2.4, 2.9]) {
      const x = t.cx + Math.cos(ang) * t.rx, y = t.cy + Math.sin(ang) * t.ry;
      p.poly([[x - 2, y + 1], [x + Math.cos(ang) * 4, y + Math.sin(ang) * 4 - 1], [x + 2, y + 2]], c.base);
    }
  } },
  shell: { layer: "behind", color: "secondary", draw({ p, a, c }) {
    const t = a.torso;
    p.blob(t.cx, t.cy - 3, t.rx * 1.75, t.ry * 1.5, c);
    p.line(t.cx, t.cy - 4 - t.ry * 1.3, t.cx, t.cy + t.ry * 0.6, c.dk);
    p.line(t.cx - t.rx * 0.7, t.cy - t.ry * 1.0, t.cx - t.rx * 0.9, t.cy + t.ry * 0.2, c.dk);
    p.line(t.cx + t.rx * 0.7, t.cy - t.ry * 1.0, t.cx + t.rx * 0.9, t.cy + t.ry * 0.2, c.dk);
    p.line(t.cx - t.rx, t.cy - t.ry * 0.3, t.cx + t.rx, t.cy - t.ry * 0.3, c.dk);
  } },
  spikes: { layer: "head", color: "detail", draw({ p, a, c }) {
    const onHead = a.body === "humanoid" || a.body === "construct" || a.body === "spirit" || a.body === "plant" || a.body === "object" || a.body === "amorphous";
    const t = onHead ? { cx: a.head.cx, cy: a.head.cy, rx: a.head.rx, ry: a.head.ry } : a.torso;
    for (let i = 0; i < 5; i++) {
      const ang = -Math.PI * (0.15 + i * 0.175) - 0.1;
      const x = t.cx + Math.cos(ang) * t.rx * 0.95, y = t.cy + Math.sin(ang) * t.ry * 0.95;
      const ox = Math.cos(ang) * 7, oy = Math.sin(ang) * 7;
      p.poly([[x - 2, y + 2], [x + ox, y + oy], [x + 2, y + 2]], c.dk);
      p.poly([[x - 1, y + 2], [x + ox * 0.9, y + oy * 0.9 + 1], [x + 1, y + 2]], c.base);
      p.px(x + ox * 0.4, y + oy * 0.4, c.hi);
    }
  } },
  tentacles: { layer: "behind", color: "secondary", draw({ p, a, c, frame }) {
    const b = a.back, sw = frame ? 1.5 : -1.5;
    for (let i = 0; i < 4; i++) {
      const dir = i < 2 ? -1 : 1, k = i % 2;
      const sx = b.x + dir * (4 + k * 3), sy = b.y + 4 - k * 2;
      const pts = [
        { x: sx, y: sy }, { x: sx + dir * (6 + k * 3), y: sy - 3 + sw }, { x: sx + dir * (11 + k * 4), y: sy - 10 - k * 3 - sw },
        { x: sx + dir * (10 + k * 5), y: sy - 17 - k * 4 + sw },
      ];
      chain(p, pts, 2.8, 1.2, c, 1.5);
      p.px(pts[2]!.x, pts[2]!.y + 1, c.hi);
    }
  } },
  wings: { layer: "behind", color: "secondary", draw({ p, a, c, frame }) {
    const b = a.back, lift = frame ? -3 : 0;
    for (const s of [-1, 1] as const) {
      const x = b.x + s * 3, y = b.y - 4;
      const far = s === 1 && (a.body === "beast" || a.body === "serpent" || a.body === "insectoid");
      const col = far ? { ...c, base: c.sh, hi: c.base } : c;
      p.poly([[x, y + 6], [x + s * 6, y - 6], [x + s * 18, y - 20 + lift], [x + s * 25, y - 11 + lift], [x + s * 21, y + 2], [x + s * 15, y + 6], [x + s * 9, y + 12]], col.dk);
      p.poly([[x, y + 5], [x + s * 6, y - 4], [x + s * 18, y - 18 + lift], [x + s * 23, y - 10 + lift], [x + s * 19, y + 2], [x + s * 14, y + 5], [x + s * 8, y + 10]], col.base);
      p.poly([[x + s * 2, y + 4], [x + s * 8, y - 3], [x + s * 18, y - 16 + lift], [x + s * 12, y]], col.hi);
      p.line(x + s * 4, y + 4, x + s * 21, y - 9 + lift, col.dk); p.line(x + s * 6, y + 6, x + s * 19, y + 0, col.dk); p.line(x + s * 8, y + 8, x + s * 14, y + 4, col.dk);
    }
  } },
  tail: { layer: "behind", color: "primary", draw({ p, a, c, frame }) {
    const t = a.tailBase, w = frame ? 1 : 0;
    const pts = [{ x: t.x + 2, y: t.y }, { x: t.x - 4, y: t.y + 3 }, { x: t.x - 9, y: t.y - w }, { x: t.x - 12, y: t.y - 7 - w }, { x: t.x - 11, y: t.y - 12 }];
    chain(p, pts, 3.4, 1.4, c, 1.5);
  } },
  fins: { layer: "behind", color: "secondary", draw({ p, a, c, frame }) {
    const b = a.back, w = frame ? 1 : 0;
    p.poly([[b.x - 6, b.y], [b.x - 6, b.y - 15 - w], [b.x, b.y - 8], [b.x + 4, b.y - 18 - w], [b.x + 8, b.y - 7], [b.x + 12, b.y - 14], [b.x + 12, b.y]], c.dk);
    p.poly([[b.x - 5, b.y], [b.x - 5, b.y - 12 - w], [b.x, b.y - 7], [b.x + 4, b.y - 15 - w], [b.x + 7, b.y - 6], [b.x + 11, b.y - 11], [b.x + 11, b.y]], c.base);
    p.line(b.x, b.y, b.x, b.y - 6, c.dk); p.line(b.x + 4, b.y, b.x + 4, b.y - 12, c.dk); p.line(b.x + 8, b.y, b.x + 9, b.y - 8, c.dk);
    const { cx, cy, rx } = a.head;
    for (const s of [-1, 1] as const) {
      p.poly([[cx + s * (rx - 1), cy - 4], [cx + s * (rx + 8), cy - 8 - w], [cx + s * (rx + 6), cy], [cx + s * (rx + 8), cy + 5], [cx + s * (rx - 1), cy + 4]], c.dk);
      p.poly([[cx + s * (rx - 1), cy - 3], [cx + s * (rx + 6), cy - 6 - w], [cx + s * (rx + 4), cy], [cx + s * (rx + 6), cy + 3], [cx + s * (rx - 1), cy + 3]], c.base);
    }
  } },
  mane: { layer: "behind", color: "detail", draw({ p, a, c, frame }) {
    const { cx, cy, rx, ry } = a.head;
    p.ell(cx, cy + 2, rx + 3, ry + 3, c.sh);
    for (let i = 0; i < 11; i++) {
      const t = Math.PI * (1.0 + i * 0.1) - 0.05 + (i % 2) * 0.03;
      const x0 = cx + Math.cos(t) * (rx + 1), y0 = cy + 1 + Math.sin(t) * (ry + 1);
      const x1 = cx + Math.cos(t) * (rx + 8 + (i % 2) * 2 + (frame && i % 3 === 0 ? 1 : 0)), y1 = cy + 1 + Math.sin(t) * (ry + 8 + (i % 2) * 2);
      p.line(x0, y0, x1, y1, i % 2 ? c.base : c.sh, 4);
      p.px(x1, y1, c.hi);
    }
    p.ell(cx - 1, cy + 1, rx + 2, ry + 2, c.base);
  } },
  roots: { layer: "front", color: "detail", draw({ p, c }) {
    for (const [x0, y0, x1, y1] of [[18, 56, 8, 60], [16, 58, 12, 61], [30, 56, 40, 60], [32, 58, 36, 61], [24, 58, 22, 62]] as const) {
      p.line(x0, y0, x1, y1, c.dk, 3); p.line(x0, y0, x1, y1, c.base, 1);
    }
  } },
  leaves: { layer: "head", color: "primary", draw({ p, a, c }) {
    const { cx, cy, rx, ry } = a.head, t = a.torso;
    leaf(p, cx - rx * 0.6, cy - ry * 0.8, -1, c); leaf(p, cx + rx * 0.5, cy - ry * 0.85, 1, c);
    leaf(p, cx - 1, cy - ry - 1, 1, c);
    leaf(p, t.cx - t.rx, t.cy - t.ry + 3, -1, c); leaf(p, t.cx + t.rx, t.cy - t.ry + 3, 1, c);
  } },
  gears: { layer: "front", color: "detail", draw({ p, a, c, frame }) {
    const t = a.torso;
    gear(p, t.cx + t.rx * 0.45, t.cy + 1, 5, frame, c);
    gear(p, t.cx - t.rx * 0.55, t.cy - t.ry * 0.3, 3.4, frame ? 0 : 1, c);
  } },
  crystals: { layer: "behind", color: "accent", draw({ p, a, c }) {
    const t = a.torso, top = Math.min(t.cy - t.ry, a.head.cy + 6);
    const prism = (cx: number, base: number, w: number, h: number) => {
      const tp = base - h, sh = tp + Math.round(h * 0.3);
      p.poly([[cx, tp], [cx + w, sh], [cx + w, base], [cx - w, base], [cx - w, sh]], c.dk);
      p.poly([[cx, tp + 1], [cx + w - 1, sh + 1], [cx + w - 1, base - 1], [cx, base - 1]], c.base);
      p.poly([[cx, tp + 1], [cx, base - 1], [cx - w + 1, base - 1], [cx - w + 1, sh + 1]], c.hi);
    };
    const x = a.head.rx + 3;
    prism(a.head.cx - x - 2, top + 10, 4, 15); prism(a.head.cx + x + 2, top + 8, 4, 18); prism(a.head.cx - x + 4, top + 6, 3, 9);
  } },

  // ---------------- held ----------------
  sword: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c, ac = ctx.pal.accent;
      g.poly([[-2, -3], [-2, -20], [0, -24], [2, -20], [2, -3]], c.dk);
      g.poly([[-1, -3], [-1, -20], [0, -22], [0, -3]], c.hi); g.poly([[0, -3], [0, -22], [1, -20], [1, -3]], c.base);
      g.rect(-5, -4, 10, 3, ac.dk); g.rect(-4, -4, 8, 2, ac.base);
      g.rect(-1, -1, 3, 6, E[1]); g.rect(-2, 5, 5, 2, ac.base);
    }
  } },
  axe: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c;
      g.rect(-1, -22, 3, 30, E[0]); g.rect(-1, -22, 1, 30, E[1]);
      g.poly([[1, -23], [10, -26], [12, -17], [10, -11], [1, -14]], c.dk);
      g.poly([[1, -22], [9, -24], [10, -17], [9, -13], [1, -15]], c.base);
      g.poly([[1, -22], [9, -24], [8, -21], [1, -19]], c.hi);
    }
  } },
  spear: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c;
      g.rect(-1, -30, 3, 44, E[1]); g.rect(-1, -30, 1, 44, E[2]);
      g.poly([[-3, -29], [0, -40], [3, -29]], c.dk);
      g.poly([[-2, -29], [0, -38], [0, -29]], c.hi); g.poly([[0, -38], [2, -29], [0, -29]], c.base);
      g.rect(-3, -29, 7, 2, ctx.pal.accent.base);
    }
  } },
  bow: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "left")) {
      const g = grip(ctx, s), c = ctx.c;
      const pts: [number, number][] = [];
      for (let i = 0; i <= 8; i++) { const t = (i / 8) * 2 - 1; pts.push([-Math.cos(t * 1.25) * 4 + 3, t * 15]); }
      for (let i = 1; i < pts.length; i++) g.line(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1], E[1], 3);
      for (let i = 1; i < pts.length; i++) g.line(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1], c.base, 1);
      g.line(pts[0]![0], pts[0]![1], pts[8]![0], pts[8]![1], "#f6e8a0", 1);
    }
  } },
  staff: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c, ac = ctx.pal.accent;
      g.rect(-1, -28, 3, 40, E[0]); g.rect(-1, -28, 1, 40, c.base);
      g.rect(-3, -8, 7, 2, c.dk);
      g.ell(0, -32, 5, 5, c.dk); g.ell(0, -32, 4, 4, ac.base); g.ell(-1, -33, 2, 2, ac.hi);
      g.poly([[-5, -31], [-4, -37], [-2, -33]], c.base); g.poly([[5, -31], [4, -37], [2, -33]], c.base);
    }
  } },
  wand: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c, ac = ctx.pal.accent;
      g.rect(-1, -14, 2, 18, c.dk); g.rect(-1, -14, 1, 18, c.base);
      g.poly([[0, -22], [2, -17], [0, -13], [-2, -17]], ac.dk); g.poly([[0, -21], [1, -17], [0, -14], [-1, -17]], ac.hi);
      g.rect(-4, -17, 9, 1, ac.base); g.rect(0, -21, 1, 9, ac.base);
    }
  } },
  shield: { layer: "held", color: "secondary", draw(ctx) {
    for (const s of sides(ctx.side, "left")) {
      const c = ctx.c, ac = ctx.pal.accent;
      const h = s === 1 ? ctx.a.handR : ctx.a.handL;
      const gx = new Xf(ctx.p, h.x - s * 3, h.y - 4, 0, s);
      gx.poly([[-7, -10], [7, -10], [7, 2], [0, 11], [-7, 2]], c.dk);
      gx.poly([[-6, -9], [6, -9], [6, 1], [0, 9], [-6, 1]], c.base);
      gx.poly([[-6, -9], [0, -9], [0, 9], [-6, 1]], c.hi);
      gx.poly([[0, -9], [6, -9], [6, 1], [0, 9]], c.sh);
      gx.ell(0, -2, 3, 3, ac.dk); gx.ell(0, -2, 2.2, 2.2, ac.base); gx.ell(-0.6, -2.6, 1, 1, ac.hi);
    }
  } },
  lantern: { layer: "held", color: "accent", draw(ctx) {
    for (const s of sides(ctx.side, "left")) {
      const h = s === 1 ? ctx.a.handR : ctx.a.handL, c = ctx.c, p = ctx.p;
      const x = h.x + s * 2, y = h.y + 2 + (ctx.frame ? 1 : 0);
      p.line(x, y - 2, x, y - 7, E[0], 1); p.rect(x - 3, y - 9, 7, 2, E[0]);
      p.rect(x - 4, y, 9, 9, OUTLINE);
      p.rect(x - 3, y + 1, 7, 7, c.sh); p.rect(x - 2, y + 2, 5, 5, c.base); p.rect(x - 1, y + 3, 3, 3, ctx.frame ? "#ffffff" : c.hi);
      p.rect(x - 4, y + 8, 9, 2, E[0]);
    }
  } },
  book: { layer: "held", color: "secondary", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const h = s === 1 ? ctx.a.handR : ctx.a.handL, c = ctx.c, p = ctx.p;
      const x = h.x - 5 + (s === 1 ? 2 : 0), y = h.y - 10 - (ctx.pose === "aggressive" ? 2 : 0);
      p.rect(x - 1, y - 1, 12, 15, OUTLINE);
      p.rect(x, y, 10, 13, c.base); p.rect(x, y, 10, 1, c.hi); p.rect(x, y, 2, 13, c.sh);
      p.rect(x + 9, y + 1, 1, 11, "#f6e8a0");
      p.rect(x + 4, y + 3, 4, 4, ctx.pal.accent.base); p.px(x + 4, y + 3, ctx.pal.accent.hi);
    }
  } },
  tool: { layer: "held", color: "detail", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const g = grip(ctx, s), c = ctx.c;
      g.rect(-1, -16, 3, 24, E[1]); g.rect(-1, -16, 1, 24, E[2]);
      g.rect(-6, -22, 13, 8, c.dk); g.rect(-5, -21, 11, 6, c.base); g.rect(-5, -21, 11, 2, c.hi); g.rect(3, -21, 3, 6, c.sh);
    }
  } },
  orb: { layer: "held", color: "accent", draw(ctx) {
    for (const s of sides(ctx.side, "right")) {
      const h = s === 1 ? ctx.a.handR : ctx.a.handL, c = ctx.c, p = ctx.p;
      const x = h.x + s, y = h.y - 8 - (ctx.frame ? 1 : 0);
      p.ell(x, y, 7, 7, c.dk); p.ell(x, y, 6, 6, c.sh); p.ell(x + 0.5, y + 0.5, 4.6, 4.6, c.base);
      p.ell(x - 1.5, y - 2, 2.2, 1.6, c.hi); p.rect(x + 2, y + 2, 1, 1, c.hi);
    }
  } },

  // ---------------- aura ----------------
  aura: { layer: "behind", color: "accent", draw({ p, a, c, frame }) {
    const o = a.aura;
    ring(p, o.cx, o.cy, o.rx, o.ry, c.sh, 3, frame);
    ring(p, o.cx, o.cy, o.rx - 3, o.ry - 3, c.base, 4, frame + 1);
    ring(p, o.cx, o.cy, o.rx - 6, o.ry - 6, c.hi, 6, frame);
  } },
  smoke: { layer: "front", color: "detail", draw({ p, a, c, frame }) {
    const x = a.headTop.x, y = a.headTop.y - 2, w = frame ? 1 : -1;
    p.blob(x - 5 + w, y - 1, 4, 3.5, c); p.blob(x + 3 - w, y - 5, 3.2, 3, c); p.blob(x - 2 + w, y - 9, 2.4, 2.2, c);
    p.blob(a.torso.cx - a.torso.rx - 6 - w, a.torso.cy + 2, 3, 2.6, c);
  } },
  flames: { layer: "front", color: "accent", draw({ p, a, c, frame }) {
    const t = a.torso;
    flameCol(p, a.head.cx, a.headTop.y + 3, 1.2, frame, c);
    flameCol(p, t.cx - t.rx - 4, t.cy + 1, 1, frame + 1, c);
    flameCol(p, t.cx + t.rx + 4, t.cy + 1, 1, frame, c);
  } },
  sparkles: { layer: "front", color: "accent", draw({ p, a, c, frame }) {
    const o = a.aura;
    const spots: [number, number, number][] = [[-0.8, -0.6, 3], [0.7, -0.75, 2], [0.95, 0.2, 3], [-0.95, 0.35, 2], [0.2, 0.95, 2], [-0.3, -0.95, 2]];
    spots.forEach(([fx, fy, s], i) => { if ((i + frame) % 2 === 0) star(p, o.cx + fx * o.rx, o.cy + fy * o.ry, s, c); else p.px(o.cx + fx * o.rx, o.cy + fy * o.ry, c.hi); });
  } },
  drips: { layer: "front", color: "primary", draw({ p, a, c, frame }) {
    const g = a.garment, d = frame ? 2 : 0;
    for (const [x, y] of [[g.cx - g.halfHem * 0.6, g.hem - 6 + d], [g.cx + g.halfHem * 0.55, g.hem - 4 + (2 - d)], [g.cx + 1, g.hem - 1 + d]] as const) {
      p.poly([[x, y - 4], [x + 2, y], [x - 2, y]], c.dk);
      p.ell(x, y + 1, 2.6, 2.6, c.dk); p.ell(x, y + 1, 1.8, 1.8, c.base); p.px(x - 1, y, c.hi);
    }
  } },
};

