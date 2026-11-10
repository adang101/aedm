import { TILE } from "./camera";
import { OUTLINE, shade } from "./palette";
import { tileStyle } from "./tileset";

type Ctx = CanvasRenderingContext2D;

const DOTS: ReadonlyArray<readonly [number, number]> = [[8, 10], [28, 6], [18, 26], [38, 32], [10, 38], [32, 18]];

function drawPattern(ctx: Ctx, pattern: string, color: string, px: number, py: number, w: number, h: number): void {
  ctx.fillStyle = shade(color, 0.22);
  ctx.strokeStyle = shade(color, 0.22);
  ctx.lineWidth = 2;
  if (pattern === "dots") {
    for (const [dx, dy] of DOTS) if (dx + 3 <= w && dy + 3 <= h) ctx.fillRect(px + dx, py + dy, 3, 3);
  } else if (pattern === "stripes") {
    ctx.beginPath();
    for (let o = 8; o < w + h; o += 12) { ctx.moveTo(px + Math.min(o, w), py + Math.max(0, o - w)); ctx.lineTo(px + Math.max(0, o - h), py + Math.min(o, h)); }
    ctx.stroke();
  } else if (pattern === "cross") {
    ctx.beginPath();
    ctx.moveTo(px + w / 2, py + 6); ctx.lineTo(px + w / 2, py + h - 6);
    ctx.moveTo(px + 6, py + h / 2); ctx.lineTo(px + w - 6, py + h / 2);
    ctx.stroke();
  }
}

/** Ground tile: filled 48x48 square, optional pattern, 1px darker edge. */
export function drawGround(ctx: Ctx, gid: number, px: number, py: number): void {
  const st = tileStyle(gid);
  ctx.fillStyle = st.color;
  ctx.fillRect(px, py, TILE, TILE);
  drawPattern(ctx, st.pattern, st.color, px, py, TILE, TILE);
  ctx.lineWidth = 1;
  ctx.strokeStyle = shade(st.color, -0.28);
  ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
}

/**
 * Wall tile with a three-quarter look: a lighter top face and, when the tile to the south is open,
 * a darker 16px front face.
 */
export function drawWall(ctx: Ctx, gid: number, px: number, py: number, openBelow: boolean): void {
  const st = tileStyle(gid);
  const top = openBelow ? TILE - 16 : TILE;
  ctx.fillStyle = shade(st.color, 0.18);
  ctx.fillRect(px, py, TILE, top);
  drawPattern(ctx, st.pattern, shade(st.color, 0.18), px, py, TILE, top);
  ctx.lineWidth = 1;
  ctx.strokeStyle = shade(st.color, -0.2);
  ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, top - 1);
  if (openBelow) {
    ctx.fillStyle = shade(st.color, -0.32);
    ctx.fillRect(px, py + top, TILE, 16);
    ctx.strokeStyle = shade(st.color, -0.6);
    ctx.beginPath();
    ctx.moveTo(px, py + top + 8.5); ctx.lineTo(px + TILE, py + top + 8.5);
    ctx.moveTo(px + 16.5, py + top); ctx.lineTo(px + 16.5, py + top + 8);
    ctx.moveTo(px + 34.5, py + top + 8); ctx.lineTo(px + 34.5, py + TILE);
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.strokeRect(px + 0.5, py + top + 0.5, TILE - 1, 15);
  }
}

/** Decor and "above" tiles: an inset block so the ground shows around it. */
export function drawDecor(ctx: Ctx, gid: number, px: number, py: number): void {
  const st = tileStyle(gid);
  const round = /tree|bush|torch|lamp|barrel|pot|bloom|shrub/i.test(st.name);
  ctx.beginPath();
  if (round) ctx.ellipse(px + 24, py + 25, 15, 15, 0, 0, Math.PI * 2);
  else ctx.roundRect(px + 9, py + 9, 30, 30, 5);
  ctx.fillStyle = st.color;
  ctx.fill();
  drawPatternClipped(ctx, st.pattern, st.color, px + 9, py + 9);
  ctx.lineWidth = 2;
  ctx.strokeStyle = shade(st.color, -0.55);
  ctx.stroke();
}

function drawPatternClipped(ctx: Ctx, pattern: string, color: string, px: number, py: number): void {
  if (pattern === "none") return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(px + 3, py + 3, 24, 24);
  ctx.clip();
  drawPattern(ctx, pattern, color, px, py, 30, 30);
  ctx.restore();
}

const KIND_COLOR: Record<string, string> = {
  chest: "#9a6a3f", door: "#c99a63", lever: "#8b93b0", sign: "#c99a3a", altar: "#9b72d8",
};

export function drawInteractable(ctx: Ctx, kind: string, state: string, px: number, py: number): void {
  const color = KIND_COLOR[kind] ?? "#c4c9dc";
  ctx.beginPath();
  ctx.roundRect(px + 11, py + 14, 26, 22, 4);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.fillStyle = state === "locked" ? "#c0392b" : "#f6e8a0";
  ctx.fillRect(px + 21, py + 22, 6, 6);
  ctx.fillStyle = OUTLINE;
  ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillText(kind.slice(0, 1).toUpperCase(), px + 24, py + 12);
}

export function drawExit(ctx: Ctx, px: number, py: number, time: number): void {
  const a = 0.55 + Math.sin(time / 400) * 0.25;
  ctx.globalAlpha = a;
  ctx.fillStyle = "#e8c95a";
  ctx.beginPath();
  ctx.moveTo(px + 24, py + 8); ctx.lineTo(px + 40, py + 38); ctx.lineTo(px + 8, py + 38);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.globalAlpha = 1;
}
