/**
 * The old `shape` sprite recipe (a colored shape with a glyph). The recipe kind still exists in the schema,
 * so it keeps its own small routine; `spec` recipes go through sprite-composer.ts.
 */
import type { SpriteRecipe } from "@aedm/schemas";
import { OUTLINE, readableOn } from "./palette";

type Ctx = CanvasRenderingContext2D;
export type ShapeRecipe = Extract<SpriteRecipe, { kind: "shape" }>;
type Shape = ShapeRecipe["shape"];

export function shapePath(ctx: Ctx, shape: Shape, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "square": {
      const s = r * 0.92, rad = 6;
      ctx.roundRect(cx - s, cy - s, s * 2, s * 2, rad);
      break;
    }
    case "diamond":
      ctx.moveTo(cx, cy - r - 2); ctx.lineTo(cx + r + 1, cy); ctx.lineTo(cx, cy + r + 2); ctx.lineTo(cx - r - 1, cy);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(cx, cy - r - 1); ctx.lineTo(cx + r + 3, cy + r - 1); ctx.lineTo(cx - r - 3, cy + r - 1);
      ctx.closePath();
      break;
    case "hex":
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = cx + Math.cos(a) * (r + 1), py = cy + Math.sin(a) * (r + 1);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
  }
}

/** Body of a shape sprite: fill, dark outline, accent rim, glyph. */
export function drawShapeBody(ctx: Ctx, sprite: ShapeRecipe, cx: number, cy: number, r = 17): void {
  shapePath(ctx, sprite.shape, cx, cy, r);
  ctx.fillStyle = sprite.color;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = sprite.accent;
  ctx.stroke();
  ctx.save();
  shapePath(ctx, sprite.shape, cx, cy, r);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.fillRect(cx - r - 4, cy - r - 4, r * 2 + 8, r * 0.8);
  ctx.restore();
  ctx.fillStyle = readableOn(sprite.color);
  ctx.font = `bold ${sprite.glyph.length > 1 ? 15 : 19}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sprite.glyph, cx, cy + (sprite.shape === "triangle" ? 5 : 1));
}
