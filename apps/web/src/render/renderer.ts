import type { EntityView, GameMap, MapObject } from "@aedm/schemas";
import type { AppState, Store } from "../state/store";
import { containerAt, myEntity } from "../state/store";
import { shownEntity } from "../state/workshop";
import {
  TILE, clampCamera, clampZoom, follow, scaleOf, screenToTile, type Camera,
} from "./camera";
import { OUTLINE } from "./palette";
import { drawEntityBody, drawEntityHud, type EntityDrawOpts } from "./sprites";
import { drawContainerMarker, drawExit, drawInteractable, createMapStyle, type MapStyle } from "./tiles";
import { drawLights, drawMood, type Light } from "./mood";

export interface TapInfo {
  tileX: number;
  tileY: number;
  entityId: string | null;
  interactable: { id: string; kind: string } | null;
  /** A pile or remains on the tile (a chest is reported as the interactable it belongs to). */
  containerId: string | null;
  clientX: number;
  clientY: number;
}

export interface RenderHooks {
  onTap(info: TapInfo): void;
  /** Entities that should pulse as valid targets right now (targeting mode). */
  isTargetable(e: EntityView): boolean;
}

export interface MapLayers {
  mapId: string;
  ref: GameMap;
  w: number;
  h: number;
  ground: number[];
  walls: number[];
  decor: number[];
  above: number[];
  objects: MapObject[];
  style: MapStyle;
  mood: GameMap["meta"]["setting"]["mood"];
}

export function extractLayers(map: GameMap): MapLayers {
  const tiles = (name: string): number[] => {
    const l = map.layers.find((x) => x.type === "tilelayer" && x.name === name);
    return l && l.type === "tilelayer" ? l.data : [];
  };
  const obj = map.layers.find((l) => l.type === "objectgroup");
  return {
    mapId: map.id, ref: map, w: map.width, h: map.height,
    ground: tiles("ground"), walls: tiles("walls"), decor: tiles("decor"), above: tiles("above"),
    objects: obj && obj.type === "objectgroup" ? obj.objects : [],
    style: createMapStyle(map.tileset.tiles, tiles("ground")),
    mood: map.meta.setting.mood,
  };
}

export interface PaintHooks {
  /** Receives the positions of lights (torches, braziers) as they are drawn. */
  lights?: Light[];
  /** Called after the ground, walls and exits and before props (hover and flash markers). */
  beforeProps?: () => void;
  /** Called after each row of props, so the caller can draw entities that stand in that row. */
  afterRow?: (y: number) => void;
}

/** Everything under the mood tint, in world pixels: ground, walls, decals, exits, props and canopy. */
export function paintMapLayers(ctx: CanvasRenderingContext2D, L: MapLayers, r: { x0: number; y0: number; x1: number; y1: number }, now: number, hooks: PaintHooks = {}): void {
  const { x0, y0, x1, y1 } = r;
  const st = L.style;
  const gidAt = (arr: number[], x: number, y: number) => (x < 0 || y < 0 || x >= L.w || y >= L.h ? 0 : (arr[y * L.w + x] ?? 0));
  const wallAt = (x: number, y: number) => x < 0 || y < 0 || x >= L.w || y >= L.h || st.isWall(gidAt(L.walls, x, y)) || st.isWall(gidAt(L.ground, x, y));
  const liquidAt = (x: number, y: number) => st.isLiquid(gidAt(L.walls, x, y)) || st.isLiquid(gidAt(L.ground, x, y)) || wallAt(x, y);

  const drawFullCell = (gid: number, x: number, y: number) => {
    st.drawFull(ctx, gid, x * TILE, y * TILE, now);
    if (st.isLiquid(gid)) {
      st.drawLiquidEdges(ctx, gid, x * TILE, y * TILE, !liquidAt(x, y - 1), !liquidAt(x, y + 1), !liquidAt(x - 1, y), !liquidAt(x + 1, y));
    }
  };
  const drawWallCell = (gid: number, x: number, y: number) =>
    st.drawWall(ctx, gid, x * TILE, y * TILE, !wallAt(x, y + 1), !wallAt(x, y - 1), !wallAt(x - 1, y), !wallAt(x + 1, y));

  // 1. ground: floors, liquids, hazards, doors; an underlay where nothing is drawn or a prop will stand
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * L.w + x;
      const g = L.ground[i] ?? 0;
      const cls = g ? st.classOf(g) : null;
      if (cls === "full") drawFullCell(g, x, y);
      else if (cls === "wall") drawWallCell(g, x, y);
      else if (!g || cls === "prop") st.drawFull(ctx, st.underlay, x * TILE, y * TILE, now);
      else st.drawFull(ctx, st.underlay, x * TILE, y * TILE, now);
    }
  }
  // 2. walls and flat decals; props wait for the depth-sorted pass
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * L.w + x;
      for (const arr of [L.walls, L.decor]) {
        const g = arr[i] ?? 0;
        if (!g) continue;
        const cls = st.classOf(g);
        if (cls === "wall") drawWallCell(g, x, y);
        else if (cls === "full") drawFullCell(g, x, y);
      }
    }
  }
  // soft shadow of a wall on the floor south of it
  ctx.fillStyle = "rgba(27,22,38,0.28)";
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (wallAt(x, y) && !wallAt(x, y + 1) && y + 1 < L.h) ctx.fillRect(x * TILE, (y + 1) * TILE, TILE, 5);
    }
  }
  for (const o of L.objects) {
    if (o.type === "exit") drawExit(ctx, o.x * TILE, o.y * TILE, now);
  }

  hooks.beforeProps?.();

  // 3. props, row by row
  const lights = hooks.lights;
  const drawObjects = (y: number) => {
    for (const o of L.objects) if (o.type === "interactable" && o.y === y) drawInteractable(ctx, o.kind, o.state, o.x * TILE, o.y * TILE);
  };
  for (let y = y0; y <= y1; y++) {
    drawObjects(y);
    for (let x = x0; x <= x1; x++) {
      const i = y * L.w + x;
      for (const arr of [L.ground, L.walls, L.decor]) {
        const g = arr[i] ?? 0;
        if (!g || st.classOf(g) !== "prop") continue;
        const art = st.drawProp(ctx, g, x * TILE, y * TILE, now);
        if (art?.light) lights?.push({ x: x * TILE + TILE / 2, y: y * TILE + 14, r: 96 });
      }
    }
    hooks.afterRow?.(y);
  }

  // 4. canopy and other tiles above the entities
  ctx.globalAlpha = 0.92;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const g = L.above[y * L.w + x] ?? 0;
      if (!g) continue;
      const cls = st.classOf(g);
      if (cls === "prop") st.drawProp(ctx, g, x * TILE, y * TILE, now);
      else if (cls === "full") st.drawFull(ctx, g, x * TILE, y * TILE, now);
    }
  }
  ctx.globalAlpha = 1;
}

export class MapRenderer {
  private ctx: CanvasRenderingContext2D;
  private layers: MapLayers | null = null;
  private cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  private viewW = 1;
  private viewH = 1;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private hover: { x: number; y: number } | null = null;
  private flash: { x: number; y: number; until: number } | null = null;
  private pos = new Map<string, { x: number; y: number }>();
  private facing = new Map<string, "left" | "right">();
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private down: { x: number; y: number; id: number } | null = null;
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, private store: Store, private hooks: RenderHooks) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is not available");
    this.ctx = ctx;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
    canvas.addEventListener("pointerleave", () => { this.hover = null; });
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resize();
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      this.frame(t, dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro.disconnect();
  }

  zoomBy(factor: number): void {
    this.cam.zoom = clampZoom(this.cam.zoom * factor);
  }

  flashTile(x: number, y: number): void {
    this.flash = { x, y, until: performance.now() + 700 };
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.viewW = Math.max(1, Math.round(r.width));
    this.viewH = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.viewW * this.dpr);
    this.canvas.height = Math.round(this.viewH * this.dpr);
  }

  // ---------- input ----------

  private local(ev: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private onDown = (ev: PointerEvent): void => {
    this.canvas.setPointerCapture?.(ev.pointerId);
    const p = this.local(ev);
    this.pointers.set(ev.pointerId, p);
    if (this.pointers.size === 1) this.down = { ...p, id: ev.pointerId };
    else { this.down = null; this.pinchDist = this.pointerDistance(); }
  };

  private onMove = (ev: PointerEvent): void => {
    const p = this.local(ev);
    if (this.pointers.has(ev.pointerId)) this.pointers.set(ev.pointerId, p);
    if (this.pointers.size === 2) {
      const d = this.pointerDistance();
      if (this.pinchDist > 0) this.zoomBy(d / this.pinchDist);
      this.pinchDist = d;
      return;
    }
    if (ev.pointerType === "mouse") {
      const t = screenToTile(p.x, p.y, this.viewW, this.viewH, this.cam);
      this.hover = { x: Math.floor(t.x), y: Math.floor(t.y) };
    }
  };

  private onUp = (ev: PointerEvent): void => {
    const p = this.local(ev);
    this.pointers.delete(ev.pointerId);
    const d = this.down;
    this.down = null;
    if (!d || d.id !== ev.pointerId) return;
    if (Math.hypot(p.x - d.x, p.y - d.y) > 10) return; // a drag, not a tap
    this.tap(p.x, p.y, ev.clientX, ev.clientY);
  };

  private onCancel = (ev: PointerEvent): void => {
    this.pointers.delete(ev.pointerId);
    this.down = null;
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.zoomBy(ev.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  private pointerDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private tap(sx: number, sy: number, clientX: number, clientY: number): void {
    const s = this.store.state;
    const t = screenToTile(sx, sy, this.viewW, this.viewH, this.cam);
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (!this.layers || tx < 0 || ty < 0 || tx >= this.layers.w || ty >= this.layers.h) return;
    // entity hit test over the 48x64 footprint, front-most (largest y) first
    const wx = t.x * TILE, wy = t.y * TILE;
    let hit: EntityView | null = null;
    let hitY = -1;
    for (const e of Object.values(s.entities)) {
      const p = this.pos.get(e.id) ?? { x: e.x, y: e.y };
      const left = p.x * TILE, top = p.y * TILE;
      if (wx >= left && wx < left + TILE && wy >= top - 16 && wy < top + TILE && p.y > hitY) { hit = e; hitY = p.y; }
    }
    const inter = this.layers.objects.find((o) => o.type === "interactable" && o.x === tx && o.y === ty);
    const pile = containerAt(s, tx, ty);
    this.hooks.onTap({
      tileX: tx, tileY: ty, entityId: hit?.id ?? null,
      interactable: inter && inter.type === "interactable" ? { id: inter.id, kind: inter.kind } : null,
      containerId: pile && pile.kind !== "chest" ? pile.id : null,
      clientX, clientY,
    });
  }

  // ---------- drawing ----------

  private frame(now: number, dt: number): void {
    const s = this.store.state;
    if (!this.layers || this.layers.ref !== s.map) this.layers = s.map ? extractLayers(s.map) : null;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const L = this.layers;
    if (!L) return;

    this.updatePositions(s, dt);
    this.updateCamera(s, L, dt);

    const sc = scaleOf(this.viewW, this.cam) * this.dpr;
    const ox = Math.round(this.viewW / 2 * this.dpr - this.cam.cx * sc);
    const oy = Math.round(this.viewH / 2 * this.dpr - this.cam.cy * sc);
    const world = () => ctx.setTransform(sc, 0, 0, sc, ox, oy);
    world();
    ctx.imageSmoothingEnabled = false;

    // visible tile range
    const x0 = Math.max(0, Math.floor((-ox / sc) / TILE)), y0 = Math.max(0, Math.floor((-oy / sc) / TILE));
    const x1 = Math.min(L.w - 1, Math.ceil(((this.canvas.width - ox) / sc) / TILE));
    const y1 = Math.min(L.h - 1, Math.ceil(((this.canvas.height - oy) / sc) / TILE) + 1);

    const lights: Light[] = [];
    // entities are drawn row by row among the props so a tree in front hides the feet of someone behind it
    const mine = myEntity(s);
    const active = s.combat?.active_id;
    const ents = Object.values(s.entities)
      .map((e) => {
        const p = this.pos.get(e.id) ?? { x: e.x, y: e.y };
        return { e: shownEntity(e, s.cast), p, row: Math.max(y0, Math.min(y1, Math.round(p.y))) };
      })
      .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x);
    const huds: { e: EntityView; o: EntityDrawOpts }[] = [];
    let ei = 0;
    while (ei < ents.length && ents[ei]!.row < y0) ei++;
    paintMapLayers(ctx, L, { x0, y0, x1, y1 }, now, {
      lights,
      beforeProps: () => this.drawMarkers(s, now),
      afterRow: (y) => {
        while (ei < ents.length && ents[ei]!.row <= y) {
          const { e, p } = ents[ei]!;
          const hovered = !!this.hover && this.hover.x === e.x && this.hover.y === e.y;
          const o: EntityDrawOpts = {
            x: p.x * TILE, y: p.y * TILE, time: now, mine: mine?.id === e.id, activeTurn: active === e.id,
            targetable: this.hooks.isTargetable(e), hovered, label: true, facing: this.facing.get(e.id) ?? "right",
          };
          drawEntityBody(ctx, e, o);
          huds.push({ e, o });
          ei++;
        }
      },
    });

    // 5. whole-scene mood tint and lights (screen space), then HUD pieces on top
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawMood(ctx, L.mood, this.canvas.width, this.canvas.height, now);
    drawLights(ctx, L.mood, lights, sc, ox, oy, now);
    world();
    for (const h of huds) drawEntityHud(ctx, h.e, h.o);
  }

  private drawMarkers(s: AppState, now: number): void {
    const ctx = this.ctx;
    for (const c of Object.values(s.containers)) if (c.kind !== "chest") drawContainerMarker(ctx, c.kind, c.x * TILE, c.y * TILE, now);
    if (this.hover && this.layers && this.hover.x >= 0 && this.hover.y >= 0 && this.hover.x < this.layers.w && this.hover.y < this.layers.h) {
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(246,232,160,0.7)";
      ctx.strokeRect(this.hover.x * TILE + 1, this.hover.y * TILE + 1, TILE - 2, TILE - 2);
    }
    if (this.flash) {
      const left = this.flash.until - now;
      if (left <= 0) this.flash = null;
      else {
        const k = left / 700;
        ctx.lineWidth = 3; ctx.strokeStyle = `rgba(159,212,245,${k})`;
        const grow = (1 - k) * 8;
        ctx.strokeRect(this.flash.x * TILE + 4 - grow / 2, this.flash.y * TILE + 4 - grow / 2, TILE - 8 + grow, TILE - 8 + grow);
      }
    }
  }

  /** Ease displayed entity positions toward their tile so moves look smooth. */
  private updatePositions(s: AppState, dt: number): void {
    const speed = 9; // tiles per second
    for (const e of Object.values(s.entities)) {
      const p = this.pos.get(e.id);
      if (!p) { this.pos.set(e.id, { x: e.x, y: e.y }); continue; }
      const dx = e.x - p.x, dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.01) { p.x = e.x; p.y = e.y; continue; }
      const step = Math.min(d, speed * dt);
      if (Math.abs(dx) > 0.05) this.facing.set(e.id, dx > 0 ? "right" : "left");
      p.x += (dx / d) * step; p.y += (dy / d) * step;
    }
    for (const id of this.pos.keys()) if (!s.entities[id]) { this.pos.delete(id); this.facing.delete(id); }
  }

  private updateCamera(s: AppState, L: MapLayers, dt: number): void {
    const me = myEntity(s);
    const p = me ? (this.pos.get(me.id) ?? me) : null;
    const tx = p ? p.x * TILE + TILE / 2 : (L.w * TILE) / 2;
    const ty = p ? p.y * TILE + TILE / 2 : (L.h * TILE) / 2;
    if (this.cam.cx === 0 && this.cam.cy === 0) { this.cam.cx = tx; this.cam.cy = ty; }
    this.cam.cx = follow(this.cam.cx, tx, dt);
    this.cam.cy = follow(this.cam.cy, ty, dt);
    this.cam = clampCamera(this.cam, this.viewW, this.viewH, L.w, L.h);
  }
}
