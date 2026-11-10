/** Shared helpers for body plans and parts. */
import type { PartColor, SpritePalette } from "@aedm/schemas";
import { tones, type Tones } from "./palette";
import type { Pen, Pt as PxPt } from "./px";
import type { Pt } from "./sprite-anchors";

export type Pal = Record<PartColor, Tones>;

export function palOf(p: SpritePalette): Pal {
  return { primary: tones(p.primary), secondary: tones(p.secondary), accent: tones(p.accent), detail: tones(p.detail) };
}

/** A chain of round segments along a polyline (tails, tentacles, serpent bodies). */
export function chain(p: Pen, pts: readonly Pt[], r0: number, r1: number, t: Tones, step = 1.6): void {
  const samples: { x: number; y: number; r: number }[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const prog = (walked + len * f) / (total || 1);
      samples.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, r: r0 + (r1 - r0) * prog });
    }
    walked += len;
  }
  const last = pts[pts.length - 1];
  if (last) samples.push({ x: last.x, y: last.y, r: r1 });
  for (const s of samples) p.ell(s.x, s.y, s.r + 0.8, s.r + 0.8, t.dk);
  for (const s of samples) p.ell(s.x, s.y, s.r, s.r, t.sh);
  for (const s of samples) p.ell(s.x - s.r * 0.15, s.y - s.r * 0.2, s.r * 0.78, s.r * 0.75, t.base);
  for (const s of samples) if (s.r >= 2.2) p.rect(s.x - s.r * 0.45, s.y - s.r * 0.5, Math.max(1, s.r * 0.4), 1, t.hi);
}

/** A shape in local item coordinates (grip at the origin, up is negative y), mirrored for the left hand and rotated. */
export class Xf {
  private cs: number;
  private sn: number;
  constructor(readonly p: Pen, readonly ox: number, readonly oy: number, ang: number, readonly s: 1 | -1) {
    this.cs = Math.cos(ang * s);
    this.sn = Math.sin(ang * s);
  }
  at(lx: number, ly: number): PxPt {
    const x = lx * this.s;
    return [this.ox + x * this.cs - ly * this.sn, this.oy + x * this.sn + ly * this.cs];
  }
  poly(pts: readonly (readonly [number, number])[], c: string): void {
    this.p.poly(pts.map(([x, y]) => this.at(x, y)), c);
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: string, th = 1): void {
    const a = this.at(x0, y0), b = this.at(x1, y1);
    this.p.line(a[0], a[1], b[0], b[1], c, th);
  }
  ell(cx: number, cy: number, rx: number, ry: number, c: string): void {
    const a = this.at(cx, cy);
    this.p.ell(a[0], a[1], rx, ry, c);
  }
}

/** Dashed elliptical ring, 2px thick; `phase` shifts the dashes (animation). */
export function ring(p: Pen, cx: number, cy: number, rx: number, ry: number, c: string, dash: number, phase: number): void {
  const n = 72;
  for (let i = 0; i < n; i++) {
    if ((Math.floor(i / dash) + phase) % 2 !== 0) continue;
    const t = (i / n) * Math.PI * 2;
    p.rect(cx + Math.cos(t) * rx - 1, cy + Math.sin(t) * ry - 1, 2, 2, c);
  }
}
