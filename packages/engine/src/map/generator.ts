import { MapBriefSchema } from "@aedm/schemas";
import type { Biome, GameMap, InteractableKind, MapBrief, MapObject, Room } from "@aedm/schemas";
import { MapRng } from "./prng";
import { legacyBiome, legacyInlineTileset } from "./compat";
import { gidOf, hasTile } from "./tileset";
import { validateMap } from "./validate";

export interface GenerateOptions {
  seed: number;
  id: string;
  /** ISO timestamp for meta.generated_at. The engine has no clock, so the caller supplies it. */
  generatedAt?: string;
}

export const DEFAULT_GENERATED_AT = "1970-01-01T00:00:00Z";
const MAX_ATTEMPTS = 3;

const SIZE_RANGE = { small: [20, 30], medium: [30, 45], large: [45, 60] } as const;
const INDOOR: ReadonlySet<Biome> = new Set(["dungeon", "interior"]);

interface Pt {
  x: number;
  y: number;
}
interface RoomShape {
  id: string;
  type: Room["type"];
  x0: number;
  y0: number;
  w: number;
  h: number;
  tiles: Pt[];
  center: Pt;
}

class Builder {
  readonly w: number;
  readonly h: number;
  readonly ground: number[];
  readonly walls: number[];
  readonly decor: number[];
  readonly above: number[];
  readonly objects: MapObject[] = [];
  readonly roomMask: Uint8Array;
  /** Tiles that must stay clear of obstacles (rooms, paths, exit lines). */
  readonly protect: Uint8Array;
  readonly pathTiles = new Set<number>();
  readonly used = new Set<number>();
  readonly rooms: RoomShape[] = [];
  readonly indoor: boolean;
  readonly biome: Biome;

  constructor(readonly brief: MapBrief, readonly rng: MapRng) {
    // Compatibility shim: the v2 setting is reduced to one of the five old biomes.
    this.biome = legacyBiome(brief.setting);
    this.indoor = INDOOR.has(this.biome);
    const [lo, hi] = SIZE_RANGE[brief.size_class];
    this.w = rng.int(lo, hi);
    this.h = rng.int(lo, hi);
    const n = this.w * this.h;
    this.ground = new Array<number>(n).fill(0);
    this.walls = new Array<number>(n).fill(0);
    this.decor = new Array<number>(n).fill(0);
    this.above = new Array<number>(n).fill(0);
    this.roomMask = new Uint8Array(n);
    this.protect = new Uint8Array(n);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  border(x: number, y: number): boolean {
    return x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1;
  }
  open(x: number, y: number): boolean {
    return this.inside(x, y) && this.walls[this.idx(x, y)] === 0;
  }
  tile(suffix: string): number {
    return gidOf(`${this.biome}_${suffix}`);
  }
  floorTile(): number {
    const r = this.rng.next();
    if (this.biome === "town") return this.tile(r < 0.72 ? "cobble_1" : r < 0.88 ? "cobble_2" : "grass");
    const word = { forest: "grass", dungeon: "floor", desert: "sand", interior: "floor" }[this.biome];
    return this.tile(`${word}_${r < 0.7 ? 1 : r < 0.85 ? 2 : 3}`);
  }
  pathTile(): number {
    return this.tile(this.biome === "town" ? "road" : "path");
  }
  borderWall(): number {
    switch (this.biome) {
      case "forest":
        return gidOf(this.rng.chance(0.5) ? "tree_oak" : "tree_pine");
      case "desert":
        return gidOf(this.rng.chance(0.6) ? "dune" : "rock");
      case "interior":
        return gidOf("wall_brick");
      default:
        return gidOf("wall_stone");
    }
  }
  doorTile(): number {
    return gidOf(this.biome === "dungeon" ? "door_iron" : "door_wood");
  }

  carve(x: number, y: number, asPath: boolean): void {
    if (!this.inside(x, y)) return;
    const i = this.idx(x, y);
    this.protect[i] = 1;
    if (this.walls[i] !== 0) {
      this.walls[i] = 0;
      this.above[i] = 0;
      this.ground[i] = this.pathTile();
      this.pathTiles.add(i);
    } else if (asPath && !this.roomMask[i] && !this.pathTiles.has(i)) {
      this.ground[i] = this.pathTile();
      this.pathTiles.add(i);
    }
  }

  line(a: Pt, b: Pt, horizontalFirst: boolean): void {
    const bend = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    for (const [p, q] of [[a, bend], [bend, b]] as const) {
      const sx = Math.sign(q.x - p.x);
      const sy = Math.sign(q.y - p.y);
      let { x, y } = p;
      this.carve(x, y, true);
      while (x !== q.x || y !== q.y) {
        x += sx;
        y += sy;
        this.carve(x, y, true);
      }
    }
  }

  // ---------- layout ----------

  layoutRooms(): void {
    const rooms = this.brief.rooms;
    const n = rooms.length;
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * this.w) / this.h))));
    const rows = Math.ceil(n / cols);
    const cw = Math.floor(this.w / cols);
    const ch = Math.floor(this.h / rows);
    rooms.forEach((room, i) => {
      const r = Math.floor(i / cols);
      const c = r % 2 === 0 ? i % cols : cols - 1 - (i % cols);
      const maxW = Math.max(2, cw - 2);
      const maxH = Math.max(2, ch - 2);
      const frac = { small: 0.5, medium: 0.7, large: 0.95 }[room.size];
      const jit = () => 0.85 + this.rng.next() * 0.15;
      let rw = Math.max(3, Math.round(maxW * frac * jit()));
      let rh = Math.max(3, Math.round(maxH * frac * jit()));
      if (room.type === "hall") {
        const horizontal = cw >= ch;
        const short = { small: 3, medium: 4, large: 5 }[room.size];
        if (horizontal) {
          rw = maxW;
          rh = short;
        } else {
          rh = maxH;
          rw = short;
        }
      } else if (room.type === "corridor") {
        const horizontal = cw >= ch;
        const long = Math.max(3, Math.round((horizontal ? maxW : maxH) * (0.8 + this.rng.next() * 0.2)));
        if (horizontal) {
          rw = long;
          rh = 2;
        } else {
          rh = long;
          rw = 2;
        }
      }
      rw = Math.min(rw, maxW);
      rh = Math.min(rh, maxH);
      const x0 = c * cw + 1 + this.rng.int(0, maxW - rw);
      const y0 = r * ch + 1 + this.rng.int(0, maxH - rh);
      this.rooms.push(this.shapeRoom(room, x0, y0, rw, rh));
    });
  }

  private shapeRoom(room: Room, x0: number, y0: number, w: number, h: number): RoomShape {
    const tiles: Pt[] = [];
    const cx = x0 + (w - 1) / 2;
    const cy = y0 + (h - 1) / 2;
    if (room.type === "cave") {
      const cand = new Set<number>();
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const dx = (x - cx) / (w / 2);
          const dy = (y - cy) / (h / 2);
          const d = dx * dx + dy * dy;
          if (d < 0.45 || d < 0.55 + this.rng.next() * 0.55) cand.add(this.idx(x, y));
        }
      }
      // keep the 4-connected component around the center
      const seed = this.idx(Math.round(cx), Math.round(cy));
      cand.add(seed);
      const seen = new Set<number>([seed]);
      const stack = [seed];
      while (stack.length > 0) {
        const c = stack.pop()!;
        const px = c % this.w;
        const py = Math.floor(c / this.w);
        for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const n = this.idx(px + ddx, py + ddy);
          if (cand.has(n) && !seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
      for (const c of [...seen].sort((a, b) => a - b)) tiles.push({ x: c % this.w, y: Math.floor(c / this.w) });
    } else {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) tiles.push({ x, y });
    }
    let center = tiles[0]!;
    let best = Infinity;
    for (const t of tiles) {
      const d = (t.x - cx) ** 2 + (t.y - cy) ** 2;
      if (d < best) {
        best = d;
        center = t;
      }
    }
    return { id: room.id, type: room.type, x0, y0, w, h, tiles, center };
  }

  /** Base terrain: indoor is solid wall with rooms carved; outdoor is open ground inside a wall border. */
  paintBase(): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        if (this.indoor) {
          this.walls[i] = this.border(x, y) ? this.borderWall() : gidOf(this.biome === "dungeon" ? "wall_stone" : "wall_brick");
        } else if (this.border(x, y)) {
          this.walls[i] = this.borderWall();
        } else {
          this.ground[i] = this.floorTile();
        }
      }
    }
    for (const r of this.rooms) {
      const special = r.type === "cave" || r.type === "courtyard" || r.type === "outdoor";
      for (const t of r.tiles) {
        const i = this.idx(t.x, t.y);
        this.roomMask[i] = 1;
        this.protect[i] = 1;
        this.walls[i] = 0;
        this.above[i] = 0;
        if (this.indoor) this.ground[i] = special && this.rng.chance(0.5) ? this.tile("floor_3") : this.floorTile();
      }
    }
  }

  connectRooms(): void {
    const ix = new Map(this.rooms.map((r, i) => [r.id, i]));
    const parent = this.rooms.map((_, i) => i);
    const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
    const link = (a: number, b: number) => {
      parent[find(a)] = find(b);
      this.line(this.rooms[a]!.center, this.rooms[b]!.center, this.rng.chance(0.5));
    };
    const done = new Set<string>();
    this.brief.rooms.forEach((room, a) => {
      for (const target of room.connects_to) {
        const b = ix.get(target);
        if (b === undefined || b === a) continue;
        const k = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (done.has(k)) continue;
        done.add(k);
        link(a, b);
      }
    });
    // join any leftover components so the map is always connected
    let prevRep = 0;
    for (let i = 1; i < this.rooms.length; i++) {
      if (find(i) !== find(prevRep)) link(prevRep, i);
      prevRep = i;
    }
  }

  addExits(): void {
    const sorted = (side: string) => {
      const key = (t: Pt) =>
        side === "north" ? t.y : side === "south" ? -t.y : side === "west" ? t.x : -t.x;
      return (r: RoomShape) => Math.min(...r.tiles.map(key));
    };
    for (const ex of this.brief.exits) {
      const score = sorted(ex.side);
      let room = this.rooms[0]!;
      let best = Infinity;
      for (const r of this.rooms) {
        const s = score(r);
        if (s < best) {
          best = s;
          room = r;
        }
      }
      const along = (t: Pt) => (ex.side === "north" || ex.side === "south" ? Math.abs(t.x - room.center.x) : Math.abs(t.y - room.center.y));
      const depth = (t: Pt) => (ex.side === "north" ? t.y : ex.side === "south" ? -t.y : ex.side === "west" ? t.x : -t.x);
      const cands = [...room.tiles].sort((a, b) => depth(a) - depth(b) || along(a) - along(b) || a.y - b.y || a.x - b.x);
      let placed = false;
      for (const t of cands) {
        const end: Pt =
          ex.side === "north" ? { x: t.x, y: 0 } : ex.side === "south" ? { x: t.x, y: this.h - 1 } : ex.side === "west" ? { x: 0, y: t.y } : { x: this.w - 1, y: t.y };
        if (this.used.has(this.idx(end.x, end.y))) continue;
        // keep exits off the corners and away from each other
        if ((end.x === 0 || end.x === this.w - 1) && (end.y < 1 || end.y > this.h - 2)) continue;
        if ((end.y === 0 || end.y === this.h - 1) && (end.x < 1 || end.x > this.w - 2)) continue;
        this.line(t, end, ex.side === "west" || ex.side === "east");
        this.used.add(this.idx(end.x, end.y));
        this.objects.push({ type: "exit", name: ex.label.trim().slice(0, 32).trim() || ex.side, to: "pending", target_entry: "party_start", x: end.x, y: end.y });
        placed = true;
        break;
      }
      if (!placed) throw new Error(`could not place ${ex.side} exit`);
    }
  }

  /** Door tiles where a 1-wide corridor meets a room (indoor biomes). */
  addDoors(): void {
    if (!this.indoor) return;
    const door = this.doorTile();
    const arch = gidOf("arch");
    const dirs: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const i of [...this.pathTiles].sort((a, b) => a - b)) {
      const x = i % this.w;
      const y = Math.floor(i / this.w);
      if (this.border(x, y) || this.used.has(i)) continue;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inside(nx, ny) || !this.roomMask[this.idx(nx, ny)]) continue;
        const sideWalled = !this.open(x + dy, y + dx) && !this.open(x - dy, y - dx);
        const behind = this.open(x - dx, y - dy);
        if (sideWalled && behind) {
          this.ground[i] = door;
          if (this.rng.chance(0.5)) this.above[i] = arch;
          break;
        }
      }
    }
  }

  // ---------- outdoor obstacles ----------

  addObstacles(): void {
    if (this.indoor) return;
    const { w, h, rng } = this;
    const tags = new Set(this.brief.theme_tags.map((t) => t.toLowerCase()));
    const wet = ["marsh", "swamp", "bog", "fen", "water", "lake", "river", "coast"].some((t) => tags.has(t));
    const smooth = (p: number, iters: number): Uint8Array => {
      let m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = rng.chance(p) ? 1 : 0;
      for (let it = 0; it < iters; it++) {
        const nm = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            let c = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && m[this.idx(x + dx, y + dy)]) c++;
            nm[this.idx(x, y)] = c >= 5 || (m[this.idx(x, y)] && c >= 4) ? 1 : 0;
          }
        }
        m = nm;
      }
      return m;
    };
    const free = (x: number, y: number) => !this.border(x, y) && !this.protect[this.idx(x, y)] && this.walls[this.idx(x, y)] === 0;
    const pond = (r: number) => {
      const cx = rng.int(3, w - 4);
      const cy = rng.int(3, h - 4);
      for (let y = cy - r - 1; y <= cy + r + 1; y++) {
        for (let x = cx - r - 1; x <= cx + r + 1; x++) {
          if (!this.inside(x, y) || !free(x, y)) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (d < r - 0.6 + rng.next() * 1.4) {
            this.walls[this.idx(x, y)] = gidOf("water");
            this.decor[this.idx(x, y)] = 0;
          }
        }
      }
    };

    if (this.biome === "forest") {
      const trees = smooth(0.43, 3);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!free(x, y)) continue;
          const i = this.idx(x, y);
          if (trees[i]) this.walls[i] = gidOf(rng.chance(0.55) ? "tree_oak" : "tree_pine");
          else if (rng.chance(0.015)) this.walls[i] = gidOf("rock");
        }
      }
      const ponds = wet ? rng.int(3, 5) : rng.int(0, 2);
      for (let k = 0; k < ponds; k++) pond(rng.int(2, wet ? 5 : 4));
    } else if (this.biome === "desert") {
      const dunes = smooth(0.34, 2);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!free(x, y)) continue;
          const i = this.idx(x, y);
          if (dunes[i]) this.walls[i] = gidOf("dune");
          else if (rng.chance(0.02)) this.walls[i] = gidOf("rock");
        }
      }
      if (rng.chance(0.4)) pond(rng.int(2, 3));
    } else if (this.biome === "town") {
      if (wet || rng.chance(0.3)) pond(rng.int(2, 4));
      this.addBuildings();
    }

    // canopy over some tree trunks
    if (this.biome === "forest") {
      const canopy = gidOf("canopy");
      for (let i = 0; i < this.walls.length; i++) {
        const t = this.walls[i]!;
        if ((t === gidOf("tree_oak") || t === gidOf("tree_pine")) && rng.chance(0.22)) this.above[i] = canopy;
      }
    }
  }

  private addBuildings(): void {
    const { rng } = this;
    const target = Math.max(2, Math.floor((this.w * this.h) / 120));
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (let attempt = 0; attempt < 120 && placed.length < target; attempt++) {
      const bw = rng.int(4, 7);
      const bh = rng.int(4, 6);
      const x = rng.int(2, this.w - bw - 3);
      const y = rng.int(2, this.h - bh - 4);
      if (x < 2 || y < 2) continue;
      let ok = true;
      // footprint plus a 1-tile margin (and the tile in front of the door) must be open and unprotected
      for (let yy = y - 1; yy <= y + bh + 1 && ok; yy++) {
        for (let xx = x - 1; xx <= x + bw && ok; xx++) {
          const i = this.idx(xx, yy);
          if (!this.inside(xx, yy) || this.border(xx, yy) || this.protect[i] || this.walls[i] !== 0) ok = false;
        }
      }
      if (!ok) continue;
      for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) this.walls[this.idx(xx, yy)] = gidOf("building_wall");
      const dx = x + Math.floor(bw / 2);
      const dy = y + bh - 1;
      this.walls[this.idx(dx, dy)] = 0;
      this.ground[this.idx(dx, dy)] = gidOf("door_wood");
      this.used.add(this.idx(dx, dy));
      this.protect[this.idx(dx, dy + 1)] = 1;
      placed.push({ x, y, w: bw, h: bh });
    }
  }

  // ---------- decor ----------

  addDecor(): void {
    const { rng } = this;
    const pools: Record<Biome, string[]> = {
      forest: ["flowers", "mushroom", "bush", "bush", "bones"],
      dungeon: ["barrel", "crate", "bones", "rubble", "mushroom"],
      desert: ["bones", "cactus", "cactus", "rubble"],
      town: ["flowers", "barrel", "crate", "bush"],
      interior: ["barrel", "crate", "table", "bookshelf", "bed", "rubble"],
    };
    const pool = pools[this.biome].map(gidOf);
    const torch = gidOf("torch");
    const rate = this.indoor ? 0.025 : 0.035;
    for (let y = 1; y < this.h - 1; y++) {
      for (let x = 1; x < this.w - 1; x++) {
        const i = this.idx(x, y);
        if (this.walls[i] === 0) {
          if (this.pathTiles.has(i) || this.used.has(i) || this.ground[i] === this.doorTile()) continue;
          if (this.indoor && !this.roomMask[i]) continue;
          if (rng.chance(rate)) this.decor[i] = rng.pick(pool);
        } else if (this.indoor && this.open(x, y + 1) && this.roomMask[this.idx(x, y + 1)] && rng.chance(0.12)) {
          this.decor[i] = torch;
        }
      }
    }
  }

  // ---------- objects ----------

  private occupiedKeys = new Set<number>();

  private occupy(p: Pt): void {
    this.occupiedKeys.add(this.idx(p.x, p.y));
  }

  private freeTile(room: RoomShape | undefined, prefer?: Pt): Pt {
    const ok = (t: Pt) => this.open(t.x, t.y) && !this.occupiedKeys.has(this.idx(t.x, t.y)) && !this.used.has(this.idx(t.x, t.y));
    const cands = (room ? room.tiles : this.rooms.flatMap((r) => r.tiles)).filter(ok);
    if (cands.length === 0) {
      // fall back to anywhere walkable
      for (let y = 1; y < this.h - 1; y++) for (let x = 1; x < this.w - 1; x++) if (ok({ x, y })) cands.push({ x, y });
      if (cands.length === 0) throw new Error("no free tile for object");
    }
    if (prefer) {
      cands.sort((a, b) => (a.x - prefer.x) ** 2 + (a.y - prefer.y) ** 2 - ((b.x - prefer.x) ** 2 + (b.y - prefer.y) ** 2) || a.y - b.y || a.x - b.x);
      return cands[0]!;
    }
    return this.rng.pick(cands);
  }

  placeObjects(): void {
    const byId = new Map(this.rooms.map((r) => [r.id, r]));
    for (const o of this.objects) this.occupy(o);
    const first = this.rooms[0]!;
    const start = this.freeTile(first, first.center);
    this.occupy(start);
    this.objects.unshift({ type: "spawn", name: "party_start", x: start.x, y: start.y });

    this.brief.entity_slots.forEach((s, i) => {
      const p = this.freeTile(byId.get(s.room_id));
      this.occupy(p);
      this.objects.push({ type: "entity_slot", id: `slot_${i + 1}`, role: s.role, count: s.count, x: p.x, y: p.y });
    });

    const counters = new Map<string, number>();
    for (const poi of this.brief.points_of_interest) {
      const kind = poi.kind.toLowerCase();
      const p = this.freeTile(byId.get(poi.room_id));
      this.occupy(p);
      const ik = interactableKind(kind);
      const i = this.idx(p.x, p.y);
      if (ik) {
        const n = (counters.get(ik) ?? 0) + 1;
        counters.set(ik, n);
        const state = ik === "chest" || ik === "door" ? (this.rng.chance(0.3) ? "locked" : "closed") : "closed";
        this.decor[i] = gidOf(ik === "door" ? "door_prop" : ik);
        this.objects.push({ type: "interactable", id: `${ik}_${n}`, kind: ik, state, x: p.x, y: p.y });
      } else {
        this.decor[i] = gidOf(propFor(kind, this.biome));
      }
    }
  }

  toMap(id: string, seed: number, generatedAt: string): GameMap {
    return {
      v: 2,
      id,
      width: this.w,
      height: this.h,
      tile_size: 48,
      tileset: legacyInlineTileset(),
      layers: [
        { type: "tilelayer", name: "ground", data: this.ground },
        { type: "tilelayer", name: "walls", data: this.walls },
        { type: "tilelayer", name: "decor", data: this.decor },
        { type: "tilelayer", name: "above", data: this.above },
        { type: "objectgroup", name: "objects", objects: this.objects },
      ],
      meta: {
        setting: {
          name: this.brief.setting.name,
          ...(this.brief.setting.preset ? { preset: this.brief.setting.preset } : {}),
          layout: this.brief.setting.layout,
          environment: this.brief.setting.environment,
          mood: this.brief.setting.mood,
        },
        theme_tags: [...this.brief.theme_tags], seed, generated_at: generatedAt,
      },
    };
  }
}

function interactableKind(kind: string): InteractableKind | null {
  for (const k of ["chest", "door", "lever", "sign", "altar"] as const) if (kind.includes(k)) return k;
  return null;
}

const PROP_ALIASES: Array<[string, string]> = [
  ["statue", "statue"], ["well", "well"], ["fountain", "well"], ["barrel", "barrel"], ["crate", "crate"], ["table", "table"],
  ["torch", "torch"], ["book", "bookshelf"], ["shelf", "bookshelf"], ["bed", "bed"], ["bone", "bones"], ["skeleton", "bones"],
  ["mushroom", "mushroom"], ["banner", "banner"], ["cactus", "cactus"], ["rubble", "rubble"], ["flower", "flowers"], ["bush", "bush"],
];

function propFor(kind: string, biome: Biome): string {
  for (const [needle, name] of PROP_ALIASES) {
    if (kind.includes(needle) && hasTile(name)) return name;
  }
  return { forest: "mushroom", desert: "bones", dungeon: "rubble", town: "banner", interior: "rubble" }[biome];
}

function build(brief: MapBrief, seed: number, opts: GenerateOptions): GameMap {
  const rng = new MapRng(seed);
  const b = new Builder(brief, rng);
  b.layoutRooms();
  b.paintBase();
  b.connectRooms();
  b.addExits();
  b.addDoors();
  b.addObstacles();
  b.addDecor();
  b.placeObjects();
  return b.toMap(opts.id, seed, opts.generatedAt ?? DEFAULT_GENERATED_AT);
}

/** Generate a validated map. Retries with seed+1, seed+2 on failure; throws after 3 attempts. */
export function generateMap(brief: MapBrief, opts: GenerateOptions): { map: GameMap; attempts: number } {
  const parsed = MapBriefSchema.parse(brief);
  const failures: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const seed = opts.seed + attempt - 1;
    try {
      const map = build(parsed, seed, opts);
      const v = validateMap(map);
      if (v.ok) return { map, attempts: attempt };
      failures.push(`attempt ${attempt} (seed ${seed}): ${v.errors.join("; ")}`);
    } catch (e) {
      failures.push(`attempt ${attempt} (seed ${seed}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`generateMap failed after ${MAX_ATTEMPTS} attempts: ${failures.join(" | ")}`);
}
