import type { EntityView, GameMap, MapObject } from "@aedm/schemas";
import type { AppState, Store } from "../state/store";
import { myEntity } from "../state/store";
import {
  TILE, clampCamera, clampZoom, follow, scaleOf, screenToTile, type Camera,
} from "./camera";
import { OUTLINE } from "./palette";
import { drawEntity } from "./sprites";
import { drawDecor, drawExit, drawGround, drawInteractable, drawWall } from "./tiles";

export interface TapInfo {
  tileX: number;
  tileY: number;
  entityId: string | null;
  interactable: { id: string; kind: string } | null;
  clientX: number;
  clientY: number;
}

export interface RenderHooks {
  onTap(info: TapInfo): void;
  /** Entities that should pulse as valid targets right now (targeting mode). */
  isTargetable(e: EntityView): boolean;
}

interface MapLayers {
  mapId: string;
  ref: GameMap;
  w: number;
  h: number;
  ground: number[];
  walls: number[];
  decor: number[];
  above: number[];
  objects: MapObject[];
}

function extractLayers(map: GameMap): MapLayers {
  const tiles = (name: string): number[] => {
    const l = map.layers.find((x) => x.type === "tilelayer" && x.name === name);
    return l && l.type === "tilelayer" ? l.data : [];
  };
  const obj = map.layers.find((l) => l.type === "objectgroup");
  return {
    mapId: map.id, ref: map, w: map.width, h: map.height,
    ground: tiles("ground"), walls: tiles("walls"), decor: tiles("decor"), above: tiles("above"),
    objects: obj && obj.type === "objectgroup" ? obj.objects : [],
  };
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
    this.hooks.onTap({
      tileX: tx, tileY: ty, entityId: hit?.id ?? null,
      interactable: inter && inter.type === "interactable" ? { id: inter.id, kind: inter.kind } : null,
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
    ctx.setTransform(sc, 0, 0, sc, ox, oy);
    ctx.imageSmoothingEnabled = false;

    // visible tile range
    const x0 = Math.max(0, Math.floor((-ox / sc) / TILE)), y0 = Math.max(0, Math.floor((-oy / sc) / TILE));
    const x1 = Math.min(L.w - 1, Math.ceil(((this.canvas.width - ox) / sc) / TILE));
    const y1 = Math.min(L.h - 1, Math.ceil(((this.canvas.height - oy) / sc) / TILE) + 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * L.w + x;
        const g = L.ground[i];
        if (g) drawGround(ctx, g, x * TILE, y * TILE);
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const w = L.walls[y * L.w + x];
        if (w) drawWall(ctx, w, x * TILE, y * TILE, !(L.walls[(y + 1) * L.w + x] ?? 0));
        else {
          const d = L.decor[y * L.w + x];
          if (d) drawDecor(ctx, d, x * TILE, y * TILE);
        }
      }
    }
    for (const o of L.objects) {
      if (o.type === "interactable") drawInteractable(ctx, o.kind, o.state, o.x * TILE, o.y * TILE);
      else if (o.type === "exit") drawExit(ctx, o.x * TILE, o.y * TILE, now);
    }

    this.drawMarkers(s, now);

    const mine = myEntity(s);
    const active = s.combat?.active_id;
    const list = Object.values(s.entities).sort((a, b) => (this.pos.get(a.id)?.y ?? a.y) - (this.pos.get(b.id)?.y ?? b.y));
    for (const e of list) {
      const p = this.pos.get(e.id) ?? { x: e.x, y: e.y };
      const hovered = !!this.hover && this.hover.x === e.x && this.hover.y === e.y;
      drawEntity(ctx, e, {
        x: p.x * TILE, y: p.y * TILE, time: now, mine: mine?.id === e.id, activeTurn: active === e.id,
        targetable: this.hooks.isTargetable(e), hovered, label: true,
      });
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const a = L.above[y * L.w + x];
        if (a) { ctx.globalAlpha = 0.92; drawDecor(ctx, a, x * TILE, y * TILE); ctx.globalAlpha = 1; }
      }
    }
  }

  private drawMarkers(_s: AppState, now: number): void {
    const ctx = this.ctx;
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
      p.x += (dx / d) * step; p.y += (dy / d) * step;
    }
    for (const id of this.pos.keys()) if (!s.entities[id]) this.pos.delete(id);
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
