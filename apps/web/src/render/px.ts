/**
 * Pixel-crisp drawing primitives. Everything here fills whole pixels (alpha 0 or 255), so tiles and sprites
 * keep the hard-edged look of the style bible instead of anti-aliased vector edges.
 */
export type Ctx = CanvasRenderingContext2D;

/** Small deterministic RNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function rint(r: () => number, n: number): number {
  return Math.floor(r() * n);
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctxOf(c: HTMLCanvasElement): Ctx {
  const g = c.getContext("2d");
  if (!g) throw new Error("Canvas 2D is not available");
  g.imageSmoothingEnabled = false;
  return g;
}

export type Pt = readonly [number, number];

export class Pen {
  constructor(readonly ctx: Ctx) {}

  rect(x: number, y: number, w: number, h: number, c: string): void {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    if (x1 <= x0 || y1 <= y0) return;
    this.ctx.fillStyle = c;
    this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  px(x: number, y: number, c: string): void {
    this.ctx.fillStyle = c;
    this.ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
  }

  /** Filled ellipse by scanlines (no anti-aliasing). */
  ell(cx: number, cy: number, rx: number, ry: number, c: string): void {
    if (rx <= 0 || ry <= 0) return;
    this.ctx.fillStyle = c;
    for (let y = Math.floor(cy - ry); y < Math.ceil(cy + ry); y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (dy <= -1 || dy >= 1) continue;
      const hw = rx * Math.sqrt(1 - dy * dy);
      const x0 = Math.round(cx - hw), x1 = Math.round(cx + hw);
      if (x1 > x0) this.ctx.fillRect(x0, y, x1 - x0, 1);
    }
  }

  /** Filled polygon by scanlines (even-odd). */
  poly(pts: readonly Pt[], c: string): void {
    if (pts.length < 3) return;
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    this.ctx.fillStyle = c;
    for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
      const sy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.round(xs[i]!), x1 = Math.round(xs[i + 1]!);
        if (x1 > x0) this.ctx.fillRect(x0, y, x1 - x0, 1);
      }
    }
  }

  /** 1px-wide (or `th` wide) Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, c: string, th = 1): void {
    this.ctx.fillStyle = c;
    let x = Math.round(x0), y = Math.round(y0);
    const ex = Math.round(x1), ey = Math.round(y1);
    const dx = Math.abs(ex - x), dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
    let err = dx + dy;
    const off = Math.floor(th / 2);
    for (let n = 0; n < 400; n++) {
      this.ctx.fillRect(x - off, y - off, th, th);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  /** Rectangle with rounded (cut) corners of radius r. */
  rrect(x: number, y: number, w: number, h: number, r: number, c: string): void {
    const x0 = Math.round(x), y0 = Math.round(y), W = Math.round(w), H = Math.round(h);
    if (W <= 0 || H <= 0) return;
    const rr = Math.min(r, Math.floor(W / 2), Math.floor(H / 2));
    this.ctx.fillStyle = c;
    for (let i = 0; i < H; i++) {
      const d = i < rr ? i + 0.5 : i >= H - rr ? H - i - 0.5 : rr;
      const inset = d >= rr ? 0 : rr - Math.floor(Math.sqrt(Math.max(0, rr * rr - (rr - d) * (rr - d))));
      this.ctx.fillRect(x0 + inset, y0 + i, W - 2 * inset, 1);
    }
  }

  /** A round shape with three tones and a highlight, light from the top left. */
  blob(cx: number, cy: number, rx: number, ry: number, t: { hi: string; base: string; sh: string }): void {
    this.ell(cx, cy, rx, ry, t.sh);
    this.ell(cx - rx * 0.1, cy - ry * 0.1, rx * 0.88, ry * 0.88, t.base);
    if (rx >= 3 && ry >= 3) this.ell(cx - rx * 0.38, cy - ry * 0.42, Math.max(1, rx * 0.3), Math.max(1, ry * 0.22), t.hi);
  }

  /** A box with a highlight on the top left edges and a shadow on the bottom right edges. */
  box(x: number, y: number, w: number, h: number, t: { hi: string; base: string; sh: string }): void {
    this.rect(x, y, w, h, t.base);
    this.rect(x, y, w, 1, t.hi);
    this.rect(x, y, 1, h, t.hi);
    this.rect(x + w - 1, y + 1, 1, h - 1, t.sh);
    this.rect(x + 1, y + h - 1, w - 1, 1, t.sh);
  }

  /** Run `fn` so that it only paints over pixels that are already opaque. */
  atop(fn: () => void): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = "source-atop";
    fn();
    this.ctx.restore();
  }

  clipRect(x: number, y: number, w: number, h: number, fn: () => void): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
    fn();
    this.ctx.restore();
  }
}
