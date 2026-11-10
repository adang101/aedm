/** Whole-scene mood tint and light halos, drawn in screen space over the map (never over the HTML UI). */
import type { Mood } from "@aedm/schemas";

type Ctx = CanvasRenderingContext2D;

export interface Light { x: number; y: number; r: number }

/** Tint strength per mood: flat dark overlay alpha, vignette alpha, and an optional color wash. */
export const MOOD_TINT: Record<Mood, { dark: number; vignette: number; wash: string | null; washAlpha: number }> = {
  bright: { dark: 0, vignette: 0, wash: null, washAlpha: 0 },
  neutral: { dark: 0, vignette: 0, wash: null, washAlpha: 0 },
  dim: { dark: 0.15, vignette: 0, wash: null, washAlpha: 0 },
  dark: { dark: 0.35, vignette: 0.5, wash: null, washAlpha: 0 },
  eerie: { dark: 0.08, vignette: 0.32, wash: "#3d2a6b", washAlpha: 0.32 },
};

export function drawMood(ctx: Ctx, mood: Mood, w: number, h: number, now: number): void {
  const t = MOOD_TINT[mood];
  if (t.dark === 0 && t.vignette === 0 && !t.wash) return;
  ctx.save();
  if (t.wash) {
    ctx.fillStyle = t.wash;
    ctx.globalAlpha = t.washAlpha + (mood === "eerie" ? 0.02 * Math.sin(now / 1100) : 0);
    ctx.fillRect(0, 0, w, h);
  }
  if (t.dark > 0) {
    ctx.globalAlpha = t.dark;
    ctx.fillStyle = "#1b1626";
    ctx.fillRect(0, 0, w, h);
  }
  if (t.vignette > 0) {
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
    g.addColorStop(0, "rgba(10,6,20,0)");
    g.addColorStop(1, `rgba(10,6,20,${t.vignette})`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/** Warm halos around torches and braziers in the dimmer moods (additive, so they cut the tint). */
export function drawLights(ctx: Ctx, mood: Mood, lights: readonly Light[], sc: number, ox: number, oy: number, now: number): void {
  if (mood === "bright" || mood === "neutral" || lights.length === 0) return;
  const k = mood === "dim" ? 0.18 : 0.3;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const l of lights) {
    const x = l.x * sc + ox, y = l.y * sc + oy, r = l.r * sc * (1 + 0.03 * Math.sin(now / 170 + l.x));
    if (x < -r || y < -r || x > ctx.canvas.width + r || y > ctx.canvas.height + r) continue;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(245,166,91,${k})`);
    g.addColorStop(1, "rgba(245,166,91,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}
