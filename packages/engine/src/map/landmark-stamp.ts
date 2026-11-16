/**
 * Choosing and stamping landmarks (see landmarks.ts): which set piece goes in which focal area, where it fits, and how it is
 * blended into the terrain. Deterministic from the brief and the seed, on its own random stream (the layout never shifts).
 * A stamp is kept only if the map stays connected: exits, anchors and the tiles routes use must remain reachable.
 */
import type { MapBrief, Material } from "@aedm/schemas";
import { getMaterial } from "./materials";
import { findRoute } from "./fields";
import { hash } from "./assemble";
import { T, isPassable } from "./layouts/grid";
import type { Grid, Pt, RoomShape, Terrain } from "./layouts/grid";
import { wornPatch } from "./nature";
import type { ResolvedSetting } from "./settings";
import {
  LANDMARK_LIMITS, ORIENTATIONS, fallbackLandmark, matchLandmark, orient, landmarkRadius,
  type Anchors, type LandmarkPiece, type LandmarkRole, type LegendEntry, type Oriented,
} from "./landmarks";

export interface LandmarkPlan {
  piece: LandmarkPiece;
  roomId: string;
  role: LandmarkRole;
  /** The free text that asked for it (a feature name), or the role it fills. */
  text: string;
  /** Index of the point of interest this plan answers, if any. */
  poi?: number;
}

const SLOT_ROLE: Record<string, LandmarkRole> = { npc: "npc", enemy: "enemy", boss: "boss", loot: "loot" };

/**
 * Which landmarks a brief gets. Points of interest that name a set piece (and are not chests, doors, levers, signs or
 * altars, which stay interactables) become that piece; then every room that holds a boss, an NPC, enemies or loot and
 * has no landmark yet gets one that suits the role; a map with none at all gets one. At most `limits[size]`.
 */
export function planLandmarks(brief: MapBrief, setting: ResolvedSetting, isInteractable: (kind: string) => boolean): LandmarkPlan[] {
  const ctx = { environment: setting.environment, layout: setting.layout, water: setting.density.liquid > 0 };
  const limit = LANDMARK_LIMITS[brief.size_class];
  const used = new Set<string>();
  const plans: LandmarkPlan[] = [];
  brief.points_of_interest.forEach((poi, i) => {
    if (isInteractable(poi.kind)) return;
    const m = matchLandmark(poi.kind, ctx, "poi", used);
    if (!m || m.score <= 0) return;
    used.add(m.piece.id);
    plans.push({ piece: m.piece, roomId: poi.room_id, role: "poi", text: poi.kind, poi: i });
  });
  const has = new Set(plans.map((p) => p.roomId));
  const order = ["boss", "npc", "enemy", "loot"];
  const slots = [...brief.entity_slots].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  for (const s of slots) {
    if (has.has(s.room_id)) continue;
    const role = SLOT_ROLE[s.role] ?? "poi";
    const piece = fallbackLandmark(`${brief.setting.name}|${s.room_id}|${role}`, ctx, role, used);
    if (!piece) continue;
    used.add(piece.id);
    has.add(s.room_id);
    plans.push({ piece, roomId: s.room_id, role, text: role });
  }
  if (plans.length === 0) {
    const room = brief.rooms[brief.rooms.length - 1]!;
    const piece = fallbackLandmark(`${brief.setting.name}|${room.id}`, ctx, "poi", used);
    if (piece) plans.push({ piece, roomId: room.id, role: "poi", text: "place" });
  }
  return plans.slice(0, limit);
}

// ---------- materials ----------

const propCache = new Map<string, Material>();

function propMaterial(id: string, solid: boolean): Material | undefined {
  const key = `${id}|${solid}`;
  const hit = propCache.get(key);
  if (hit) return hit;
  const m = getMaterial(id);
  if (!m) return undefined;
  const out: Material = solid
    ? (m.role === "obstacle" ? m : { ...m, role: "obstacle", walkable: false, blocks_sight: false })
    : (m.role === "decor" ? m : { ...m, role: "decor", walkable: true, blocks_sight: false });
  propCache.set(key, out);
  return out;
}

// ---------- the stamp ----------

type Kind = "keep" | "open" | "solid" | "water" | "shallow" | "bridge" | "door" | "wall" | "path";

function classify(ch: string, legend: Record<string, LegendEntry>): Kind {
  switch (ch) {
    case ".": return "keep";
    case "_": case "@": case "s": case "f": case "i": case "g": return "open";
    case ",": return "path";
    case "#": return "wall";
    case "o": case "r": case "t": return "solid";
    case "~": return "water";
    case "-": return "shallow";
    case "=": return "bridge";
    case "+": return "door";
    default: {
      const e = legend[ch];
      if (!e) return "open";
      if (e.wall) return "wall";
      return e.solid ? "solid" : "open";
    }
  }
}

const K_OPEN = 1, K_SOLID = 2, K_WATER = 3, K_BRIDGE = 4, K_DOOR = 5;

interface Program { n: number; dx: Int16Array; dy: Int16Array; kind: Uint8Array }
// Keyed by the oriented pattern itself (`orient` caches those), so a lookup never rebuilds a string key.
const programs = new WeakMap<Oriented, Program>();

/** An oriented pattern as flat lists of the cells it writes (and how), so searching never re-reads the text. */
function compile(piece: LandmarkPiece, ori: Oriented): Program {
  let prog = programs.get(ori);
  if (prog) return prog;
  const dx: number[] = [];
  const dy: number[] = [];
  const kind: number[] = [];
  for (let y = 0; y < ori.h; y++) {
    for (let x = 0; x < ori.w; x++) {
      const k = classify(ori.cells[y * ori.w + x]!, piece.legend);
      if (k === "keep") continue;
      dx.push(x);
      dy.push(y);
      kind.push(k === "open" || k === "path" ? K_OPEN : k === "solid" || k === "wall" ? K_SOLID : k === "water" || k === "shallow" ? K_WATER : k === "bridge" ? K_BRIDGE : K_DOOR);
    }
  }
  prog = { n: dx.length, dx: Int16Array.from(dx), dy: Int16Array.from(dy), kind: Uint8Array.from(kind) };
  programs.set(ori, prog);
  return prog;
}

export interface PlacedLandmark {
  /** Map object id of its trigger (`lm_n`). */
  id: string;
  plan: LandmarkPlan;
  /** Orientation 0 to 7 and the tile the pattern's top-left corner sits on. */
  t: number;
  origin: Pt;
  center: Pt;
  radius: number;
  anchors: Anchors;
  /** Every tile the stamp wrote (grid indexes). */
  cells: number[];
}

export interface StampOutput {
  placed: PlacedLandmark[];
  /** Decor props by grid index. */
  decor: Map<number, Material>;
  /** Materials that replace what the assembler would choose for a wall or obstacle tile. */
  override: Map<number, Material>;
  /** Signs the pieces carry: tile and text. */
  signs: Array<{ x: number; y: number; text: string }>;
}

export interface StampInput {
  grid: Grid;
  setting: ResolvedSetting;
  seed: number;
  plans: readonly LandmarkPlan[];
  shapes: readonly RoomShape[];
  start: Pt;
  /** Tiles that may never be covered: exits, the party start, anything already placed. */
  taken: ReadonlySet<number>;
  /** What replaces open tiles cut off from the party. */
  pocket: Terrain;
}

const CONFINED = new Set(["rooms_and_corridors", "maze"]);

/** Sign text for a piece, a deterministic pick from its data. */
function signFor(piece: LandmarkPiece, seed: number, n: number): string {
  const list = piece.sign ?? ["Nothing is written here."];
  return list[Math.floor(hash(seed, n, piece.id.length, 41) * list.length)]!;
}

export function stampLandmarks(input: StampInput): StampOutput {
  const { grid, setting, seed, shapes, start, taken } = input;
  const { w, h } = grid;
  const L = LANDMARK_LIMITS;
  const out: StampOutput = { placed: [], decor: new Map(), override: new Map(), signs: [] };
  const confined = CONFINED.has(setting.layout);
  const outdoor = setting.environment === "outdoor";
  const stamped = new Uint8Array(w * h);
  const exitIdx = [...taken];
  const wallNatural = setting.materials.wall[0]?.tags.includes("natural") ?? false;
  let before = grid.reachable(start);
  const byId = new Map(shapes.map((s) => [s.id, s]));

  // tiles no stamp may touch: the arrival area and the surroundings of exits and anything already placed
  const blocked = new Uint8Array(w * h);
  const markAround = (cx: number, cy: number, r: number): void => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (grid.inside(cx + dx, cy + dy)) blocked[grid.idx(cx + dx, cy + dy)] = 1;
  };
  markAround(start.x, start.y, 2);
  for (const e of exitIdx) markAround(e % w, Math.floor(e / w), 1);

  // biggest footprints first so they get the room; the plan order is kept in the result
  const order = input.plans.map((p, i) => i).sort((a, b) => {
    const area = (p: LandmarkPlan) => p.piece.rows.length * p.piece.rows[0]!.length;
    return area(input.plans[b]!) - area(input.plans[a]!) || a - b;
  });
  const results: Array<PlacedLandmark | undefined> = new Array(input.plans.length).fill(undefined);
  let objN = 0;

  for (const pi of order) {
    const plan = input.plans[pi]!;
    const piece = plan.piece;
    const target = (byId.get(plan.roomId) ?? shapes[0]!).center;

    interface Cand { t: number; ox: number; oy: number; cost: number }
    /** Candidates whose centre lies in a box (tiles); outdoors a square round the target, indoors the room's own bounds. */
    const search = (box: { x0: number; y0: number; x1: number; y1: number }): Cand[] => {
      const found: Cand[] = [];
      const seen = new Set<string>();
      for (let t = 0; t < ORIENTATIONS; t++) {
        const ori = orient(piece, t);
        const sig = ori.cells.join("") + ori.w;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const prog = compile(piece, ori);
        for (let oy = box.y0 - ori.center.y; oy <= box.y1 - ori.center.y; oy++) {
          for (let ox = box.x0 - ori.center.x; ox <= box.x1 - ori.center.x; ox++) {
            const c = evaluate(prog, ori, ox, oy, target);
            if (c !== null) found.push({ t, ox, oy, cost: c + 0.9 * hash(seed, ox * 31 + t, oy, 77 + pi) });
          }
        }
      }
      return found;
    };
    const square = (r: number) => ({ x0: Math.max(2, Math.floor(target.x - r)), y0: Math.max(2, Math.floor(target.y - r)), x1: Math.min(w - 3, Math.ceil(target.x + r)), y1: Math.min(h - 3, Math.ceil(target.y + r)) });
    const roomBox = (s: RoomShape) => ({ x0: s.x0, y0: s.y0, x1: s.x0 + s.w - 1, y1: s.y0 + s.h - 1 });

    const evaluate = (prog: Program, ori: Oriented, ox: number, oy: number, tgt: Pt): number | null => {
      const gt = grid.t;
      let cost = 0;
      for (let k = 0; k < prog.n; k++) {
        const gx = ox + prog.dx[k]!;
        const gy = oy + prog.dy[k]!;
        if (gx < 2 || gy < 2 || gx > w - 3 || gy > h - 3) return null;
        const i = gy * w + gx;
        if (stamped[i] || blocked[i]) return null;
        if (confined && grid.room[i]! < 0) return null;
        const t = gt[i]!;
        switch (prog.kind[k]) {
          case K_OPEN:
            if (t === T.OBSTACLE) cost += 1;
            else if (t === T.HAZARD || t === T.SHALLOW) cost += 0.5;
            else if (t !== T.FLOOR && t !== T.PATH) return null;
            break;
          case K_SOLID:
            if (grid.crit[i]) return null;
            if (t === T.OBSTACLE) cost += 0.3;
            else if (t === T.HAZARD) cost += 0.5;
            else if (t !== T.FLOOR && t !== T.PATH) return null;
            break;
          case K_WATER:
            if (t === T.LIQUID || t === T.SHALLOW) cost -= 0.8;
            else if (grid.crit[i]) return null;
            else if (t === T.FLOOR || t === T.PATH || t === T.OBSTACLE) cost += 1.5;
            else return null;
            break;
          case K_BRIDGE:
            if (t === T.LIQUID || t === T.SHALLOW) cost -= 0.6;
            else if (t !== T.FLOOR && t !== T.PATH && t !== T.OBSTACLE) return null;
            break;
          default:
            if (t !== T.FLOOR && t !== T.PATH && t !== T.OBSTACLE) return null;
        }
      }
      const dx = ox + ori.center.x - tgt.x;
      const dy = oy + ori.center.y - tgt.y;
      return cost + 0.6 * Math.hypot(dx, dy);
    };

    let cands: Cand[] = [];
    if (confined) {
      // inside a room: the planned room first, then the others nearest first
      const rooms = shapes.filter((s) => !s.extra).sort((a, b) => Math.hypot(a.center.x - target.x, a.center.y - target.y) - Math.hypot(b.center.x - target.x, b.center.y - target.y));
      for (const s of rooms) {
        cands = search(roomBox(s));
        if (cands.length > 0) break;
      }
    } else {
      cands = search(square(L.searchRadius));
      if (cands.length === 0) cands = search(square(L.wideRadius));
    }
    cands.sort((a, b) => a.cost - b.cost || a.t - b.t || a.oy - b.oy || a.ox - b.ox);

    for (const c of cands.slice(0, L.maxTries)) {
      const res = tryStamp(c.t, c.ox, c.oy);
      if (res) { results[pi] = res; break; }
    }

    // apply a candidate, check the map is still whole, and keep it or roll it back
    function tryStamp(t: number, ox: number, oy: number): PlacedLandmark | undefined {
      const ori = orient(piece, t);
      const snap = { t: grid.t.slice(), veg: grid.veg.slice(), crit: grid.crit.slice(), block: grid.block.slice() };
      const decor = new Map<number, Material>();
      const override = new Map<number, Material>();
      const cells: number[] = [];
      const signs: Array<{ x: number; y: number; text: string }> = [];
      const blockId = 1000 + out.placed.length + results.filter(Boolean).length;
      const abs = (list: Pt[]): Pt[] => list.map((q) => ({ x: q.x + ox, y: q.y + oy }));
      const own = new Uint8Array(w * h);

      for (let cy = 0; cy < ori.h; cy++) {
        for (let cx = 0; cx < ori.w; cx++) {
          const ch = ori.cells[cy * ori.w + cx]!;
          const kind = classify(ch, piece.legend);
          if (kind === "keep") continue;
          const i = grid.idx(ox + cx, oy + cy);
          own[i] = 1;
          cells.push(i);
          grid.crit[i] = 1;
          grid.veg[i] = 0;
          const e = piece.legend[ch];
          switch (kind) {
            case "open":
              if (grid.t[i] !== T.PATH || e?.ground === ",") grid.t[i] = e?.ground === "," ? T.PATH : T.FLOOR;
              if (ch === "g") { const m = propMaterial("signpost", false); if (m) decor.set(i, m); signs.push({ x: ox + cx, y: oy + cy, text: signFor(piece, seed, signs.length + out.signs.length + pi) }); }
              else if (e?.p) { const m = propMaterial(e.p, false); if (m) decor.set(i, m); }
              break;
            case "path": grid.t[i] = T.PATH; if (e?.p) { const m = propMaterial(e.p, false); if (m) decor.set(i, m); } break;
            case "wall": {
              grid.t[i] = T.WALL;
              grid.block[i] = blockId;
              if (e?.use && wallNatural) { const m = getMaterial(e.use[0]!); if (m) override.set(i, { ...m, role: "wall", walkable: false, blocks_sight: true }); }
              break;
            }
            case "solid": {
              grid.t[i] = T.OBSTACLE;
              grid.veg[i] = ch === "r" ? 3 : ch === "t" ? 1 : 0;
              if (e?.p) { const m = propMaterial(e.p, true); if (m) override.set(i, m); }
              break;
            }
            case "water": grid.t[i] = T.LIQUID; break;
            case "shallow": grid.t[i] = T.SHALLOW; break;
            case "bridge": grid.t[i] = T.BRIDGE; break;
            case "door": grid.t[i] = T.DOOR; break;
          }
        }
      }
      const center = { x: ox + ori.center.x, y: oy + ori.center.y };
      const anchors: Anchors = { stand: abs(ori.anchors.stand), fight: abs(ori.anchors.fight), item: abs(ori.anchors.item), sign: abs(ori.anchors.sign) };

      // blend: clear vegetation in a ring (wider round a fight), wear the ground, lay a path to the nearest road
      const clear = (cx: number, cy: number, r: number): void => {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (!grid.inside(x, y) || grid.border(x, y)) continue;
            const i = grid.idx(x, y);
            if (own[i] || stamped[i] || grid.t[i] !== T.OBSTACLE) continue;
            if (confined && grid.room[i]! < 0) continue;
            grid.t[i] = T.FLOOR;
            grid.veg[i] = 0;
          }
        }
      };
      for (const i of cells) if (grid.t[i] !== T.OBSTACLE && grid.t[i] !== T.WALL && grid.t[i] !== T.LIQUID) clear(i % w, Math.floor(i / w), 1);
      for (const f of anchors.fight) clear(f.x, f.y, L.fightClear);
      if (outdoor) wornPatch(grid, center.x, center.y, Math.max(ori.w, ori.h) / 2 + 0.6);
      for (const i of cells) grid.crit[i] = 1;
      if (outdoor && !confined) connect(center, own, ori, ox, oy, target);

      // the map must stay whole
      const after = grid.reachable(start);
      let ok = true;
      for (const e of exitIdx) if (before[e] && !after[e]) ok = false;
      const need = [center, ...anchors.stand, ...anchors.fight, ...anchors.item, ...anchors.sign];
      for (const q of need) if (!after[grid.idx(q.x, q.y)]) ok = false;
      let lost = 0;
      if (ok) {
        for (let i = 0; i < after.length; i++) {
          if (before[i] && !after[i] && !own[i]) {
            lost++;
            if (grid.crit[i] || taken.has(i)) { ok = false; break; }
          }
        }
        if (lost > 6) ok = false;
      }
      if (!ok) {
        grid.t.set(snap.t);
        grid.veg.set(snap.veg);
        grid.crit.set(snap.crit);
        grid.block.set(snap.block);
        return undefined;
      }
      before = after;
      for (const i of cells) for (let dy = -L.gap; dy <= L.gap; dy++) for (let dx = -L.gap; dx <= L.gap; dx++) {
        const x = (i % w) + dx;
        const y = Math.floor(i / w) + dy;
        if (grid.inside(x, y)) stamped[grid.idx(x, y)] = 1;
      }
      for (const [i, m] of decor) out.decor.set(i, m);
      for (const [i, m] of override) out.override.set(i, m);
      out.signs.push(...signs);
      objN++;
      return { id: `lm_${objN}`, plan, t, origin: { x: ox, y: oy }, center, radius: landmarkRadius(ori), anchors, cells };
    }
  }

  // landmarks keep their plan order (ids follow placement order, which is by footprint)
  out.placed = results.filter((r): r is PlacedLandmark => r !== undefined);

  // scraps of open ground cut off by a stamp go back to what the layout calls a pocket
  const seen = grid.reachable(start);
  for (let i = 0; i < grid.t.length; i++) {
    if (isPassable(grid.t[i]!) && !seen[i]) { grid.t[i] = input.pocket; grid.room[i] = -1; out.decor.delete(i); }
  }
  return out;

  /** A short path from the landmark's open edge to the nearest road, never through a stamped solid, water or the border. */
  function connect(center: Pt, own: Uint8Array, ori: Oriented, ox: number, oy: number, target: Pt): void {
    let entry: number | undefined;
    let bestD = Infinity;
    for (let cy = 0; cy < ori.h; cy++) {
      for (let cx = 0; cx < ori.w; cx++) {
        const ch = ori.cells[cy * ori.w + cx]!;
        const k = classify(ch, {});
        if (k !== "open" && k !== "path") continue;
        const i = grid.idx(ox + cx, oy + cy);
        if (!isPassable(grid.t[i]!)) continue;
        const d = Math.hypot(ox + cx - target.x, oy + cy - target.y);
        if (d < bestD) { bestD = d; entry = i; }
      }
    }
    if (entry === undefined) return;
    // nearest existing road tile outside the stamp, by walking out from the entry
    const dist = new Map<number, number>([[entry, 0]]);
    const queue = [entry];
    let goal: number | undefined;
    for (let q = 0; q < queue.length && goal === undefined; q++) {
      const c = queue[q]!;
      const d = dist.get(c)!;
      if (d > 14) break;
      const x = c % w;
      const y = Math.floor(c / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = grid.idx(x + dx, y + dy);
        if (!grid.inside(x + dx, y + dy) || dist.has(n) || grid.border(x + dx, y + dy)) continue;
        const t = grid.t[n]!;
        if (t === T.LIQUID || t === T.WALL || (t === T.OBSTACLE && stamped[n])) continue;
        dist.set(n, d + 1);
        queue.push(n);
        if (!own[n] && (t === T.PATH || t === T.BRIDGE || t === T.DOOR) && d + 1 >= 2) { goal = n; break; }
      }
    }
    if (goal === undefined) return;
    const cost = (i: number): number => {
      const x = i % w;
      const y = Math.floor(i / w);
      if (grid.border(x, y) || stamped[i]) return Infinity;
      const t = grid.t[i]!;
      if (own[i] && (t === T.OBSTACLE || t === T.WALL || t === T.LIQUID)) return Infinity;
      if (t === T.LIQUID || t === T.WALL || t === T.DOOR) return Infinity;
      if (t === T.PATH || t === T.BRIDGE) return 0.4;
      return 1 + (t === T.OBSTACLE ? 5 : 0) + 4 * grid.wander[i]! ** 2;
    };
    const route = findRoute(w, h, entry, goal, cost);
    for (const c of route) {
      if (own[c]) continue;
      grid.crit[c] = 1;
      if (grid.t[c] === T.OBSTACLE || grid.t[c] === T.FLOOR || grid.t[c] === T.HAZARD) { grid.t[c] = T.PATH; grid.veg[c] = 0; }
    }
  }
}
