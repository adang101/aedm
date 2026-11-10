export const TILE = 48;
/** Character footprint: 48 wide, 64 tall, feet on the bottom of the tile. */
export const SPRITE_W = 48;
export const SPRITE_H = 64;

export const PHONE_BREAKPOINT = 600;
export const PHONE_TILES_ACROSS = 11;
export const DESKTOP_SCALE = 1.25;

export interface Camera {
  /** World pixel at the center of the view. */
  cx: number;
  cy: number;
  /** User zoom multiplier on top of the base scale. */
  zoom: number;
}

/** Pixels-per-world-pixel for a view of the given CSS width. Phones fit about 11 tiles across. */
export function baseScale(viewW: number): number {
  return viewW < PHONE_BREAKPOINT ? viewW / (PHONE_TILES_ACROSS * TILE) : DESKTOP_SCALE;
}

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 2.2;
export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function scaleOf(viewW: number, cam: Camera): number {
  return baseScale(viewW) * cam.zoom;
}

/** Clamp a camera center so the view stays inside the map; center the map on an axis where it is smaller than the view. */
export function clampAxis(center: number, viewWorld: number, mapWorld: number): number {
  if (mapWorld <= viewWorld) return mapWorld / 2;
  return Math.min(mapWorld - viewWorld / 2, Math.max(viewWorld / 2, center));
}

export function clampCamera(cam: Camera, viewW: number, viewH: number, mapW: number, mapH: number): Camera {
  const s = scaleOf(viewW, cam);
  return {
    ...cam,
    cx: clampAxis(cam.cx, viewW / s, mapW * TILE),
    cy: clampAxis(cam.cy, viewH / s, mapH * TILE),
  };
}

/** Convert a point in canvas CSS pixels to a (fractional) tile coordinate. */
export function screenToTile(sx: number, sy: number, viewW: number, viewH: number, cam: Camera): { x: number; y: number } {
  const s = scaleOf(viewW, cam);
  const wx = (sx - viewW / 2) / s + cam.cx;
  const wy = (sy - viewH / 2) / s + cam.cy;
  return { x: wx / TILE, y: wy / TILE };
}

export function tileToScreen(tx: number, ty: number, viewW: number, viewH: number, cam: Camera): { x: number; y: number } {
  const s = scaleOf(viewW, cam);
  return { x: (tx * TILE - cam.cx) * s + viewW / 2, y: (ty * TILE - cam.cy) * s + viewH / 2 };
}

/** Exponential smoothing step toward a target; `dt` in seconds. */
export function follow(current: number, target: number, dt: number, rate = 10): number {
  const k = 1 - Math.exp(-rate * dt);
  const next = current + (target - current) * k;
  return Math.abs(target - next) < 0.05 ? target : next;
}
