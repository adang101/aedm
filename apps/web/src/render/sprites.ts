import type { Condition, EntityView, SpriteRecipe } from "@aedm/schemas";
import { SPRITE_H, SPRITE_W, TILE } from "./camera";
import { OUTLINE, hashString, readableOn } from "./palette";

type Ctx = CanvasRenderingContext2D;
type Shape = Extract<SpriteRecipe, { kind: "shape" }>["shape"];

export const CONDITION_COLORS: Record<Condition, string> = {
  stunned: "#f5a65b", slowed: "#4f9fe0", rooted: "#7cb342", prone: "#a5654a",
  burning: "#e8683a", bleeding: "#c0392b", shielded: "#9fd4f5", hasted: "#e8c95a",
  marked: "#cbb0f0", taunted: "#c0392b", dazzled: "#f6e8a0", evasive: "#b5d66b",
};

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

/** Body of a shape sprite: fill, dark outline, accent rim, glyph. Used by the map and the creator preview. */
export function drawShapeBody(ctx: Ctx, sprite: Extract<SpriteRecipe, { kind: "shape" }>, cx: number, cy: number, r = 17): void {
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
  // light-from-top-left highlight
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

export interface EntityDrawOpts {
  /** Top-left of the entity's tile, in world pixels (may be fractional while moving). */
  x: number;
  y: number;
  time: number;
  mine: boolean;
  activeTurn: boolean;
  /** Pulse a targeting marker (a pending attack or ability needs a target). */
  targetable: boolean;
  hovered: boolean;
  /** Draw the name under the feet. */
  label: boolean;
}

function hpColor(frac: number): string {
  if (frac > 0.6) return "#7cb342";
  if (frac > 0.3) return "#e8c95a";
  return "#e8683a";
}

function ellipse(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
}

/** Draw one entity on its 48x64 footprint, feet at the bottom of the tile. */
export function drawEntity(ctx: Ctx, e: EntityView, o: EntityDrawOpts): void {
  const fx = o.x + (TILE - SPRITE_W) / 2;
  const fy = o.y + TILE - SPRITE_H;
  const phase = (hashString(e.id) % 628) / 100;
  const bob = Math.sin(o.time / 380 + phase); // -1..1 => 2px range
  const dead = e.hp <= 0;

  ctx.save();
  ctx.globalAlpha = dead ? 0.45 : 1;

  // ground ring + shadow
  const gx = fx + 24, gy = fy + 58;
  ellipse(ctx, gx, gy, 17, 6);
  ctx.fillStyle = "rgba(10,6,20,0.38)";
  ctx.fill();
  if (e.kind === "enemy") {
    ellipse(ctx, gx, gy, 20, 7.5);
    ctx.lineWidth = 3; ctx.strokeStyle = "#c0392b"; ctx.stroke();
  } else if (e.kind === "npc") {
    ellipse(ctx, gx, gy, 20, 7.5);
    ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeStyle = "#c4c9dc"; ctx.stroke(); ctx.setLineDash([]);
  }
  if (o.mine) {
    ellipse(ctx, gx, gy, 21, 8);
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#9fd4f5"; ctx.stroke();
  }
  if (o.activeTurn) {
    const pulse = 1 + Math.sin(o.time / 250) * 0.08;
    ellipse(ctx, gx, gy, 24 * pulse, 9.5 * pulse);
    ctx.lineWidth = 3; ctx.strokeStyle = "#e8c95a"; ctx.stroke();
  }
  if (o.targetable || o.hovered) {
    const pulse = 1 + Math.sin(o.time / 160) * 0.1;
    ellipse(ctx, gx, gy, 25 * pulse, 10 * pulse);
    ctx.lineWidth = 2.5; ctx.strokeStyle = o.targetable ? "#e8683a" : "#f6e8a0"; ctx.stroke();
  }

  // body
  ctx.translate(0, bob);
  if (e.sprite.kind === "shape") drawShapeBody(ctx, e.sprite, fx + 24, fy + 40);
  ctx.translate(0, -bob);

  // enemy marker: small red chevron above the head
  if (e.kind === "enemy" && !dead) {
    ctx.beginPath();
    ctx.moveTo(fx + 24, fy + 3); ctx.lineTo(fx + 20, fy - 2); ctx.lineTo(fx + 28, fy - 2); ctx.closePath();
    ctx.fillStyle = "#c0392b"; ctx.fill();
  }

  // HP bar
  const bw = 36, bx = fx + 6, by = fy + 8;
  const frac = Math.max(0, Math.min(1, e.hp / e.hp_max));
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(bx - 1.5, by - 1.5, bw + 3, 8);
  ctx.fillStyle = "#3b3f55";
  ctx.fillRect(bx, by, bw, 5);
  ctx.fillStyle = e.kind === "enemy" ? "#c0392b" : hpColor(frac);
  ctx.fillRect(bx, by, Math.round(bw * frac), 5);

  // condition pips
  const n = Math.min(e.conditions.length, 6);
  for (let i = 0; i < n; i++) {
    const cond = e.conditions[i]!;
    const px = fx + 24 + (i - (n - 1) / 2) * 8;
    ctx.beginPath();
    ctx.arc(px, fy + 19, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = CONDITION_COLORS[cond.condition];
    ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }

  // name
  if (o.label) {
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const name = e.name.length > 16 ? `${e.name.slice(0, 15)}…` : e.name;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(20,12,30,0.9)"; ctx.lineJoin = "round";
    ctx.strokeText(name, gx, o.y + TILE + 1);
    ctx.fillStyle = e.kind === "enemy" ? "#f5a65b" : e.kind === "npc" ? "#cbd5e8" : "#f6e8a0";
    ctx.fillText(name, gx, o.y + TILE + 1);
  }
  ctx.restore();
}
