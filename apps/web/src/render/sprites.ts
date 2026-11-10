import type { Condition, EntityView, SpritePose } from "@aedm/schemas";
import { SPRITE_H, TILE } from "./camera";
import { OUTLINE, hashString } from "./palette";
import { drawShapeBody } from "./shape-recipe";
import { POSE_SHADOW, composeSprite, effectivePose, type Facing } from "./sprite-composer";

type Ctx = CanvasRenderingContext2D;

export const CONDITION_COLORS: Record<Condition, string> = {
  stunned: "#f5a65b", slowed: "#4f9fe0", rooted: "#7cb342", prone: "#a5654a",
  burning: "#e8683a", bleeding: "#c0392b", shielded: "#9fd4f5", hasted: "#e8c95a",
  marked: "#cbb0f0", taunted: "#c0392b", dazzled: "#f6e8a0", evasive: "#b5d66b",
};

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
  /** Which way the sprite looks (mirrors the composed sprite). */
  facing?: Facing;
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

/** Pose to draw: the spec's own, else aggressive for an enemy on its turn, cowering when nearly dead. */
export function poseFor(e: EntityView, activeTurn: boolean): SpritePose | undefined {
  if (e.sprite.kind !== "spec") return undefined;
  if (e.hp > 0 && e.hp / e.hp_max <= 0.25) return "cowering";
  if (e.kind === "enemy" && activeTurn) return "aggressive";
  return undefined;
}

const feet = (o: EntityDrawOpts) => ({ x: o.x + TILE / 2, y: o.y + TILE - 4 });

/** Top of the entity's sprite in world pixels, for markers and pips above the head. */
function spriteTop(e: EntityView, o: EntityDrawOpts): number {
  const f = feet(o);
  if (e.sprite.kind !== "spec") return f.y - 62;
  const s = composeSprite(e.sprite, "right", 0, poseFor(e, o.activeTurn));
  return f.y - 62 * s.scale;
}

/** The ground ring, shadow and the sprite itself. */
export function drawEntityBody(ctx: Ctx, e: EntityView, o: EntityDrawOpts): void {
  const phase = (hashString(e.id) % 628) / 100;
  const dead = e.hp <= 0;
  const f = feet(o);
  const pose = poseFor(e, o.activeTurn);
  const shadowK = e.sprite.kind === "spec" ? POSE_SHADOW[effectivePose(e.sprite, pose)] : 1;
  const sizeK = e.sprite.kind === "spec" ? Math.max(0.7, composeSprite(e.sprite, "right", 0, pose).scale) : 1;

  ctx.save();
  ctx.globalAlpha = dead ? 0.45 : 1;
  const gx = f.x, gy = f.y - 2;
  const rx = 17 * shadowK * sizeK, ry = 6 * shadowK * (0.7 + sizeK * 0.3);
  ellipse(ctx, gx, gy, rx, ry);
  ctx.fillStyle = "rgba(10,6,20,0.38)";
  ctx.fill();
  const ring = (k: number) => 20 * k * Math.max(1, sizeK);
  if (e.kind === "enemy") {
    ellipse(ctx, gx, gy, ring(1), 7.5);
    ctx.lineWidth = 3; ctx.strokeStyle = "#c0392b"; ctx.stroke();
  } else if (e.kind === "npc") {
    ellipse(ctx, gx, gy, ring(1), 7.5);
    ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeStyle = "#c4c9dc"; ctx.stroke(); ctx.setLineDash([]);
  }
  if (o.mine) {
    ellipse(ctx, gx, gy, ring(1.05), 8);
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#9fd4f5"; ctx.stroke();
  }
  if (o.activeTurn) {
    const pulse = 1 + Math.sin(o.time / 250) * 0.08;
    ellipse(ctx, gx, gy, ring(1.2) * pulse, 9.5 * pulse);
    ctx.lineWidth = 3; ctx.strokeStyle = "#e8c95a"; ctx.stroke();
  }
  if (o.targetable || o.hovered) {
    const pulse = 1 + Math.sin(o.time / 160) * 0.1;
    ellipse(ctx, gx, gy, ring(1.25) * pulse, 10 * pulse);
    ctx.lineWidth = 2.5; ctx.strokeStyle = o.targetable ? "#e8683a" : "#f6e8a0"; ctx.stroke();
  }

  if (e.sprite.kind === "spec") {
    const frame = Math.floor(o.time / 420 + phase) % 2;
    const s = composeSprite(e.sprite, o.facing ?? "right", frame, pose);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.canvas, Math.round(f.x - s.footX), Math.round(f.y - s.footY));
  } else {
    const bob = Math.sin(o.time / 380 + phase);
    drawShapeBody(ctx, e.sprite, f.x, o.y + TILE - SPRITE_H + 40 + bob);
  }
  ctx.restore();
}

/** Marker, HP bar, condition pips and name. Drawn after the mood tint so they stay readable. */
export function drawEntityHud(ctx: Ctx, e: EntityView, o: EntityDrawOpts): void {
  if (e.hp <= 0) return;
  const f = feet(o);
  const top = spriteTop(e, o);
  ctx.save();

  if (e.kind === "enemy") {
    ctx.beginPath();
    ctx.moveTo(f.x, top + 8); ctx.lineTo(f.x - 4, top + 3); ctx.lineTo(f.x + 4, top + 3); ctx.closePath();
    ctx.fillStyle = "#c0392b"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }

  // condition pips above the head
  const n = Math.min(e.conditions.length, 6);
  for (let i = 0; i < n; i++) {
    const cond = e.conditions[i]!;
    const px = f.x + (i - (n - 1) / 2) * 8;
    ctx.beginPath();
    ctx.arc(px, top - 1, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = CONDITION_COLORS[cond.condition];
    ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = OUTLINE; ctx.stroke();
  }

  // HP bar under the feet
  const bw = 34, bx = f.x - bw / 2, by = o.y + TILE - 1;
  const frac = Math.max(0, Math.min(1, e.hp / e.hp_max));
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(bx - 1.5, by - 1.5, bw + 3, 7);
  ctx.fillStyle = "#3b3f55";
  ctx.fillRect(bx, by, bw, 4);
  ctx.fillStyle = e.kind === "enemy" ? "#c0392b" : hpColor(frac);
  ctx.fillRect(bx, by, Math.round(bw * frac), 4);

  if (o.label) {
    ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const name = e.name.length > 16 ? `${e.name.slice(0, 15)}…` : e.name;
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(20,12,30,0.9)"; ctx.lineJoin = "round";
    ctx.strokeText(name, f.x, by + 6);
    ctx.fillStyle = e.kind === "enemy" ? "#f5a65b" : e.kind === "npc" ? "#cbd5e8" : "#f6e8a0";
    ctx.fillText(name, f.x, by + 6);
  }
  ctx.restore();
}

/** Body and HUD in one call (used where there is no mood tint). */
export function drawEntity(ctx: Ctx, e: EntityView, o: EntityDrawOpts): void {
  drawEntityBody(ctx, e, o);
  drawEntityHud(ctx, e, o);
}


