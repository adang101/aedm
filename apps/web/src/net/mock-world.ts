import type { BodyPlan, EntityView, GameMap, MapObject, MaterialRole, Part, Pattern, SpriteSpec, TileDef } from "@aedm/schemas";

/**
 * Hand-built v2 maps for the mock server, each with its own inline tileset, to show the renderer's range:
 * a town square, a flooded crypt (eerie) and a snowy trail. Entities carry `spec` sprites covering every
 * body plan.
 */

export interface MockScene {
  id: string;
  title: string;
  map: GameMap;
  start: { x: number; y: number };
  entities: EntityView[];
  arrival: string;
  chips: string[];
}

// ---------- painting helpers ----------

interface MatOpts { variants?: number; walkable?: boolean; sight?: boolean; layer?: TileDef["layer"] }

class Book {
  tiles: TileDef[] = [];
  /** Adds a material (with up to 4 visual variants) and returns the gids. */
  mat(id: string, role: MaterialRole, color: string, accent: string, pattern: Pattern, o: MatOpts = {}): number[] {
    const n = o.variants ?? 1;
    const walkable = o.walkable ?? (role === "floor" || role === "path" || role === "hazard" || role === "decor" || role === "door");
    const layer = o.layer ?? (role === "wall" ? "walls" : role === "decor" || role === "obstacle" ? "decor" : "ground");
    const out: number[] = [];
    for (let v = 0; v < n; v++) {
      const gid = this.tiles.length + 1;
      this.tiles.push({
        gid, material_id: id, role, color, accent, pattern, walkable,
        blocks_sight: o.sight ?? role === "wall", variant: v, layer,
      });
      out.push(gid);
    }
    return out;
  }
}

class Painter {
  readonly ground: number[];
  readonly walls: number[];
  readonly decor: number[];
  readonly above: number[];
  readonly objects: MapObject[] = [];
  constructor(readonly w: number, readonly h: number, base: number[]) {
    const n = w * h;
    this.ground = new Array<number>(n).fill(0);
    this.walls = new Array<number>(n).fill(0);
    this.decor = new Array<number>(n).fill(0);
    this.above = new Array<number>(n).fill(0);
    this.fill(this.ground, 0, 0, w - 1, h - 1, base);
  }
  i(x: number, y: number): number { return y * this.w + x; }
  /** Fills a rectangle, choosing among variants by position so repeats do not line up. */
  fill(arr: number[], x0: number, y0: number, x1: number, y1: number, gids: number[]): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[this.i(x, y)] = gids[(x * 7 + y * 13 + ((x * y) % 5)) % gids.length]!;
  }
  set(arr: number[], x: number, y: number, gids: number[]): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) arr[this.i(x, y)] = gids[(x * 3 + y * 5) % gids.length]!;
  }
  clear(arr: number[], x: number, y: number): void { arr[this.i(x, y)] = 0; }
  box(arr: number[], x0: number, y0: number, x1: number, y1: number, gids: number[]): void {
    this.fill(arr, x0, y0, x1, y0, gids); this.fill(arr, x0, y1, x1, y1, gids);
    this.fill(arr, x0, y0, x0, y1, gids); this.fill(arr, x1, y0, x1, y1, gids);
  }
  scatter(arr: number[], pts: readonly (readonly [number, number])[], gids: number[]): void {
    for (const [x, y] of pts) this.set(arr, x, y, gids);
  }
  gate(arr: number[], x: number, y: number): void { this.clear(arr, x, y); }
}

function finish(id: string, p: Painter, book: Book, objects: MapObject[], setting: GameMap["meta"]["setting"], tags: string[], seed: number): GameMap {
  return {
    v: 2, id, width: p.w, height: p.h, tile_size: 48,
    tileset: { first_gid: 1, tiles: book.tiles },
    layers: [
      { type: "tilelayer", name: "ground", data: p.ground },
      { type: "tilelayer", name: "walls", data: p.walls },
      { type: "tilelayer", name: "decor", data: p.decor },
      { type: "tilelayer", name: "above", data: p.above },
      { type: "objectgroup", name: "objects", objects },
    ],
    meta: { setting, theme_tags: tags, seed, generated_at: "2026-01-01T00:00:00Z" },
  };
}

/** True when a tile in any layer is not walkable (walls, trees, deep water) or the tile is off the map. */
export function blockedAt(map: GameMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const walk = new Map(map.tileset.tiles.map((t) => [t.gid, t.walkable]));
  for (const l of map.layers) {
    if (l.type !== "tilelayer") continue;
    const g = l.data[y * map.width + x] ?? 0;
    if (g && walk.get(g) === false) return true;
  }
  return false;
}

// ---------- sprites ----------

const sp = (body: BodyPlan, size: SpriteSpec["size"], pal: [string, string, string, string], parts: Part[], extra: { glyph?: string; pose?: SpriteSpec["pose"] } = {}): SpriteSpec => ({
  kind: "spec", v: 1, body, size, traits: "", palette: { primary: pal[0], secondary: pal[1], accent: pal[2], detail: pal[3] },
  parts: parts.map((part) => ({ part })), ...extra,
});

const ent = (id: string, kind: EntityView["kind"], name: string, x: number, y: number, hp: number, sprite: SpriteSpec, disposition: EntityView["disposition"]): EntityView =>
  ({ id, kind, name, x, y, hp, hp_max: hp, conditions: [], sprite, disposition });

export const NPC_ODALYS: EntityView = ent("npc_odalys", "npc", "Odalys", 16, 8, 8,
  sp("humanoid", "medium", ["#d39a72", "#c99a3a", "#c0392b", "#70472f"], ["long_hair", "tool"], { glyph: "O" }), "friendly");

export function choristerEntities(): EntityView[] {
  const look = sp("humanoid", "medium", ["#f2cfa6", "#8b93b0", "#cbb0f0", "#5c6380"], ["robe", "hood", "glowing_eyes", "aura"]);
  return [
    ent("en_chorister_1", "enemy", "Robed Chorister", 22, 11, 10, look, "hostile"),
    ent("en_chorister_2", "enemy", "Robed Chorister", 23, 9, 10, look, "hostile"),
  ];
}

// ---------- town ----------

function buildTown(): MockScene {
  const b = new Book();
  const grass = b.mat("meadow_grass", "floor", "#4f8a3c", "#e8c95a", "grass", { variants: 4 });
  const plaza = b.mat("cobblestone", "floor", "#8b93b0", "#5c6380", "cobbles", { variants: 3 });
  const road = b.mat("dirt_road", "path", "#9a6a3f", "#c99a63", "speckle", { variants: 3 });
  const oak = b.mat("oak_planks", "floor", "#c99a63", "#9a6a3f", "planks", { variants: 3 });
  const stoneWall = b.mat("mossy_stone_wall", "wall", "#5c6380", "#4f8a3c", "bricks", { variants: 2 });
  const timber = b.mat("timber_wall", "wall", "#70472f", "#4a2f24", "planks", { variants: 2 });
  const pond = b.mat("pond_water", "liquid", "#4f9fe0", "#9fd4f5", "waves", { variants: 2, walkable: false });
  const marsh = b.mat("toxic_marsh", "hazard", "#2f5d34", "#b5d66b", "speckle", { variants: 2 });
  const tree = b.mat("oak_tree", "obstacle", "#4f8a3c", "#e8683a", "grass", { variants: 2, walkable: false });
  const boulder = b.mat("boulder", "obstacle", "#8b93b0", "#4f8a3c", "cracks", { walkable: false });
  const barrel = b.mat("barrel", "decor", "#70472f", "#c99a3a", "planks");
  const crate = b.mat("crate", "decor", "#c99a3a", "#9a6a3f", "planks");
  const torch = b.mat("wall_torch", "decor", "#e8683a", "#f5a65b", "none");
  const stall = b.mat("market_stall", "decor", "#9a6a3f", "#c0392b", "planks");
  const well = b.mat("stone_well", "decor", "#8b93b0", "#4f9fe0", "cobbles");
  const flowers = b.mat("wildflowers", "decor", "#e8683a", "#f6e8a0", "none");
  const banner = b.mat("village_banner", "decor", "#c0392b", "#e8c95a", "none");
  const sign = b.mat("signpost", "decor", "#c99a3a", "#70472f", "planks");
  const reeds = b.mat("marsh_reeds", "decor", "#4f8a3c", "#9a6a3f", "none");
  const door = b.mat("inn_door", "door", "#9a6a3f", "#70472f", "planks");
  const tower = b.mat("ruined_arch_door", "door", "#8b93b0", "#5c6380", "lattice");

  const W = 30, H = 20;
  const p = new Painter(W, H, grass);
  p.fill(p.ground, 9, 6, 20, 13, plaza);
  p.fill(p.ground, 1, 10, 8, 10, road); p.fill(p.ground, 21, 10, 28, 10, road); p.fill(p.ground, 14, 3, 14, 5, road);
  p.fill(p.ground, 4, 4, 7, 6, oak);
  p.fill(p.ground, 22, 3, 26, 4, plaza);
  p.fill(p.ground, 23, 14, 28, 18, marsh);
  p.fill(p.ground, 2, 14, 6, 17, pond);
  p.fill(p.ground, 10, 17, 17, 17, road);

  p.box(p.walls, 0, 0, W - 1, H - 1, stoneWall);
  p.gate(p.walls, 0, 10); p.gate(p.walls, W - 1, 10);
  p.box(p.walls, 3, 3, 8, 7, timber); p.gate(p.walls, 5, 7); p.set(p.ground, 5, 7, door);
  p.box(p.walls, 23, 2, 27, 5, stoneWall); p.gate(p.walls, 25, 5); p.set(p.ground, 25, 5, tower);

  p.scatter(p.decor, [[4, 4], [7, 6], [10, 7], [19, 7], [11, 12], [18, 12]], barrel);
  p.scatter(p.decor, [[6, 5], [24, 3]], crate);
  p.scatter(p.decor, [[9, 8], [20, 8], [9, 11], [20, 11]], torch);
  p.scatter(p.decor, [[11, 6], [18, 6]], stall);
  p.scatter(p.decor, [[14, 8]], well);
  p.scatter(p.decor, [[12, 15], [13, 16], [26, 11], [3, 12], [16, 14], [8, 15]], flowers);
  p.scatter(p.decor, [[10, 5], [19, 5]], banner);
  p.scatter(p.decor, [[15, 6], [27, 10]], sign);
  p.scatter(p.decor, [[22, 15], [29 - 1, 14], [22, 17], [7, 14], [7, 16]], reeds);
  p.scatter(p.walls, [[2, 2], [12, 2], [16, 2], [21, 3], [2, 8], [3, 18], [9, 15], [14, 15], [19, 16], [21, 13], [27, 7], [27, 12], [1, 6], [1, 13], [28, 8]], tree);
  p.scatter(p.walls, [[1, 17], [20, 15], [28, 12], [21, 1 + 1]], boulder);

  const objects: MapObject[] = [
    { type: "spawn", name: "party_start", x: 13, y: 10 },
    { type: "exit", name: "crypt_stairs", to: "m_crypt", target_entry: "party_start", x: 0, y: 10 },
    { type: "exit", name: "snowy_trail", to: "m_trail", target_entry: "party_start", x: W - 1, y: 10 },
    { type: "entity_slot", id: "slot_choir", role: "enemy", count: 2, x: 22, y: 11 },
    { type: "interactable", id: "chest_plaza", kind: "chest", state: "locked", x: 19, y: 13 },
    { type: "interactable", id: "sign_square", kind: "sign", state: "closed", x: 15, y: 7 },
    { type: "interactable", id: "door_inn", kind: "door", state: "open", x: 5, y: 7 },
    { type: "trigger", id: "trg_marsh", radius: 2, on_enter: "marsh_whispers", x: 24, y: 14 },
  ];
  const map = finish("m_hollowmere", p, b, objects,
    { name: "Hollowmere", preset: "town", layout: "settlement", environment: "outdoor", mood: "dim" }, ["marsh", "dusk"], 1337);

  const entities: EntityView[] = [
    NPC_ODALYS, ...choristerEntities(),
    ent("npc_biscuit", "npc", "Biscuit", 11, 9, 5, sp("beast", "small", ["#c99a63", "#f6e8a0", "#c0392b", "#70472f"], ["tail", "ears_pointed"]), "friendly"),
    ent("npc_crow", "npc", "Marsh Crow", 17, 11, 3, sp("avian", "small", ["#3b3f55", "#5c6380", "#e8c95a", "#3b3f55"], ["wings"]), "neutral"),
    ent("npc_merchant", "npc", "Pell the Peddler", 12, 7, 8, sp("humanoid", "medium", ["#a5654a", "#c0392b", "#e8c95a", "#70472f"], ["hat", "beard", "book"]), "friendly"),
    ent("npc_totem", "npc", "Lantern Totem", 20, 7, 12, sp("object", "medium", ["#9a6a3f", "#c99a3a", "#e8683a", "#5c6380"], ["aura"], { glyph: "L" }), "neutral"),
    ent("npc_wisp", "npc", "Marsh Wisp", 23, 13, 4, sp("spirit", "small", ["#9fd4f5", "#4f9fe0", "#f6e8a0", "#1f3f7a"], ["aura", "sparkles"]), "neutral"),
    ent("npc_mud", "npc", "Mud Lump", 27, 16, 9, sp("amorphous", "medium", ["#70472f", "#9a6a3f", "#b5d66b", "#4a2f24"], ["drips"]), "neutral"),
    ent("npc_treant", "npc", "Elder Oak", 3, 10 - 4, 20, sp("plant", "large", ["#4f8a3c", "#70472f", "#e8c95a", "#4a2f24"], ["leaves", "roots"]), "friendly"),
  ];
  return {
    id: "m_hollowmere", title: "Hollowmere", map, start: { x: 13, y: 10 }, entities,
    arrival: "You are back on the cobbles of Hollowmere. Lanterns gutter, and the marsh hums at the edge of hearing.",
    chips: ["Talk to Odalys", "Look around", "Go to the crypt"],
  };
}

// ---------- crypt ----------

function buildCrypt(): MockScene {
  const b = new Book();
  const flags = b.mat("crypt_flagstone", "floor", "#5c6380", "#3b3f55", "tiles", { variants: 3 });
  const cracked = b.mat("cracked_flagstone", "floor", "#5c6380", "#3b3f55", "cracks", { variants: 2 });
  const rune = b.mat("rune_floor", "floor", "#3d2a6b", "#cbb0f0", "runes", { variants: 4 });
  const grate = b.mat("iron_grate", "path", "#5c6380", "#8b93b0", "lattice", { variants: 2 });
  const brick = b.mat("crypt_brick", "wall", "#3b3f55", "#5c6380", "bricks", { variants: 2 });
  const mural = b.mat("scaled_mural", "wall", "#2f5d34", "#7cb342", "scales");
  const water = b.mat("black_water", "liquid", "#1f3f7a", "#4f9fe0", "waves", { variants: 2, walkable: false });
  const ecto = b.mat("ectoplasm", "hazard", "#6a45a8", "#cbb0f0", "glow", { variants: 2 });
  const spikes = b.mat("spike_trap", "hazard", "#5c6380", "#c4c9dc", "tiles");
  const vent = b.mat("ember_vent", "hazard", "#7a1f2b", "#f5a65b", "cracks", { variants: 2 });
  const pillar = b.mat("stone_pillar", "obstacle", "#8b93b0", "#5c6380", "none", { walkable: false });
  const rubble = b.mat("rubble", "obstacle", "#5c6380", "#8b93b0", "cracks", { walkable: false });
  const spire = b.mat("stalagmite", "obstacle", "#8b93b0", "#c4c9dc", "none", { walkable: false });
  const crystal = b.mat("crystal_cluster", "obstacle", "#9b72d8", "#cbb0f0", "glow", { walkable: false });
  const brazier = b.mat("iron_brazier", "decor", "#5c6380", "#e8683a", "none");
  const torch = b.mat("wall_torch", "decor", "#e8683a", "#f5a65b", "none");
  const coffin = b.mat("sarcophagus", "decor", "#8b93b0", "#c99a3a", "none");
  const grave = b.mat("gravestone", "decor", "#8b93b0", "#c4c9dc", "none");
  const bones = b.mat("scattered_bones", "decor", "#c4c9dc", "#8b93b0", "none");
  const web = b.mat("cobweb", "decor", "#c4c9dc", "#8b93b0", "none");
  const shelf = b.mat("bone_shelf", "decor", "#70472f", "#c99a3a", "none");
  const mush = b.mat("glow_mushrooms", "decor", "#9b72d8", "#cbb0f0", "none");
  const statue = b.mat("gargoyle_statue", "decor", "#8b93b0", "#c0392b", "none");
  const banner = b.mat("tattered_banner", "decor", "#6a45a8", "#e8c95a", "none");
  const urn = b.mat("burial_urn", "decor", "#9a6a3f", "#c99a3a", "none");
  const gateDoor = b.mat("iron_door", "door", "#8b93b0", "#5c6380", "lattice");

  const W = 28, H = 22;
  const p = new Painter(W, H, flags);
  // entry hall (bottom left), flooded hall (middle), vault (top left), rune chamber (right)
  p.fill(p.ground, 2, 12, 10, 19, flags);
  p.fill(p.ground, 4, 14, 6, 16, cracked);
  p.fill(p.ground, 11, 15, 12, 16, flags);
  p.fill(p.ground, 13, 8, 21, 19, water);
  p.fill(p.ground, 13, 14, 21, 15, grate);
  p.fill(p.ground, 16, 8, 17, 19, grate);
  p.fill(p.ground, 2, 2, 11, 9, cracked);
  p.fill(p.ground, 22, 2, 26, 19, flags);
  p.fill(p.ground, 23, 4, 25, 9, rune);
  p.fill(p.ground, 23, 12, 25, 14, ecto);
  p.fill(p.ground, 3, 5, 10, 5, spikes);
  p.fill(p.ground, 8, 7, 9, 8, vent);
  p.fill(p.ground, 2, 11, 5, 11, flags);
  p.fill(p.ground, 14, 10, 15, 11, ecto);
  p.fill(p.ground, 19, 17, 20, 18, ecto);

  p.box(p.walls, 0, 0, W - 1, H - 1, brick);
  p.fill(p.walls, 1, 10, 11, 10, brick); p.gate(p.walls, 6, 10); p.set(p.ground, 6, 10, gateDoor);
  p.fill(p.walls, 12, 12, 12, 14, brick); p.fill(p.walls, 12, 17, 12, 20, brick);
  p.fill(p.walls, 21, 1, 21, 20, brick); p.gate(p.walls, 21, 14); p.gate(p.walls, 21, 15);
  p.fill(p.walls, 12, 1, 12, 9, brick); p.gate(p.walls, 12, 6);
  p.fill(p.walls, 13, 1, 20, 7, mural);
  p.set(p.ground, 12, 6, flags); p.set(p.ground, 21, 14, grate); p.set(p.ground, 21, 15, grate);

  p.scatter(p.walls, [[3, 13], [9, 13], [3, 18], [9, 18], [14, 17], [19, 9], [23, 16], [25, 17]], pillar);
  p.scatter(p.walls, [[7, 17], [10, 4], [5, 8]], rubble);
  p.scatter(p.walls, [[2, 19], [10, 19], [22, 19]], spire);
  p.scatter(p.walls, [[25, 2], [22, 2], [26, 18]], crystal);
  p.scatter(p.decor, [[2, 12], [10, 12], [6, 19]], brazier);
  p.scatter(p.decor, [[4, 11], [8, 11], [3, 3], [10, 3], [22, 5], [26, 5]], torch);
  p.scatter(p.decor, [[24, 6], [23, 8], [25, 8]], coffin);
  p.scatter(p.decor, [[3, 7], [4, 8], [10, 8], [24, 16]], grave);
  p.scatter(p.decor, [[7, 14], [5, 18], [15, 12], [18, 12], [11, 7]], bones);
  p.scatter(p.decor, [[1, 11], [11, 11], [22, 3], [11, 3], [1, 2]], web);
  p.scatter(p.decor, [[2, 3], [11, 8]], shelf);
  p.scatter(p.decor, [[23, 18], [26, 12], [8, 15], [2, 16]], mush);
  p.scatter(p.decor, [[23, 10], [25, 10], [5, 9], [8, 9]], statue);
  p.scatter(p.decor, [[4, 12], [8, 12], [24, 3]], banner);
  p.scatter(p.decor, [[26, 10], [22, 17], [3, 4]], urn);

  const objects: MapObject[] = [
    { type: "spawn", name: "party_start", x: 4, y: 18 },
    { type: "exit", name: "stairs_up", to: "m_hollowmere", target_entry: "party_start", x: 2, y: 17 },
    { type: "interactable", id: "chest_vault", kind: "chest", state: "locked", x: 10, y: 6 },
    { type: "interactable", id: "altar_runes", kind: "altar", state: "closed", x: 24, y: 7 },
    { type: "interactable", id: "gate_iron", kind: "door", state: "open", x: 6, y: 10 },
  ];
  const map = finish("m_crypt", p, b, objects,
    { name: "Drowned Crypt", layout: "rooms_and_corridors", environment: "underground", mood: "eerie" }, ["crypt", "flooded"], 4242);

  const entities: EntityView[] = [
    ent("en_warden", "enemy", "Skeleton Warden", 9, 14, 14, sp("humanoid", "medium", ["#c4c9dc", "#5c6380", "#c0392b", "#8b93b0"], ["helmet", "shield", "sword", "glowing_eyes"]), "hostile"),
    ent("en_shade", "enemy", "Wailing Shade", 8, 6, 9, sp("spirit", "medium", ["#6a45a8", "#9b72d8", "#cbb0f0", "#3d2a6b"], ["hood", "aura", "glowing_eyes"]), "hostile"),
    ent("npc_slime", "npc", "Grave Slime", 14, 17, 8, sp("amorphous", "medium", ["#4f8a3c", "#b5d66b", "#f6e8a0", "#2f5d34"], ["drips"]), "neutral"),
    ent("npc_spider", "npc", "Crypt Weaver", 18, 9, 12, sp("insectoid", "large", ["#3b3f55", "#6a45a8", "#c0392b", "#5c6380"], ["extra_eyes", "spikes"]), "neutral"),
    ent("npc_serpent", "npc", "Bone Serpent", 16, 18, 10, sp("serpent", "medium", ["#c4c9dc", "#8b93b0", "#c0392b", "#5c6380"], ["spikes", "fins"]), "neutral"),
    ent("npc_golem", "npc", "Vault Golem", 23, 16, 24, sp("construct", "large", ["#8b93b0", "#5c6380", "#e8c95a", "#3b3f55"], ["gears", "crystals"]), "neutral"),
    ent("npc_mimic", "npc", "Mimic Coffer", 10, 7, 10, sp("object", "medium", ["#9a6a3f", "#c99a3a", "#c0392b", "#8b93b0"], ["glowing_eyes", "spikes"], { glyph: "?" }), "neutral"),
    ent("npc_bat", "npc", "Cave Bat", 6, 3, 3, sp("avian", "small", ["#3d2a6b", "#6a45a8", "#e8683a", "#4a2f24"], ["wings", "ears_pointed"]), "neutral"),
    ent("npc_roots", "npc", "Crypt Root", 25, 18, 14, sp("plant", "medium", ["#4f8a3c", "#4a2f24", "#cbb0f0", "#70472f"], ["roots", "leaves", "glowing_eyes"]), "neutral"),
    ent("npc_hound", "npc", "Ember Hound", 9, 18, 11, sp("beast", "medium", ["#c0392b", "#f5a65b", "#f6e8a0", "#4a2f24"], ["fur", "tail", "horns", "flames"]), "neutral"),
    ent("npc_doctor", "npc", "Plague Physician", 24, 11, 8, sp("humanoid", "medium", ["#d39a72", "#3b3f55", "#c0392b", "#1b1626"], ["hat", "mask", "cloak", "lantern"]), "neutral"),
  ];
  return {
    id: "m_crypt", title: "Drowned Crypt", map, start: { x: 4, y: 18 }, entities,
    arrival: "Cold air breathes up the stairwell. Black water fills the crypt's heart, and violet light gathers on the stones.",
    chips: ["Examine the water", "Check the chest", "Go to the town square"],
  };
}

// ---------- snowy trail ----------

function buildTrail(): MockScene {
  const b = new Book();
  const snow = b.mat("fresh_snow", "floor", "#c4c9dc", "#9fd4f5", "speckle", { variants: 4 });
  const packed = b.mat("trampled_snow", "path", "#8b93b0", "#c4c9dc", "dots", { variants: 3 });
  const frost = b.mat("frozen_ground", "floor", "#9fd4f5", "#4f9fe0", "cracks", { variants: 2 });
  const sandy = b.mat("wind_swept_sand", "floor", "#e8c95a", "#c99a3a", "sand", { variants: 3 });
  const cliff = b.mat("ice_cliff", "wall", "#4f9fe0", "#9fd4f5", "stripes", { variants: 2 });
  const rockWall = b.mat("granite_wall", "wall", "#5c6380", "#8b93b0", "cobbles", { variants: 2 });
  const lake = b.mat("icy_water", "liquid", "#4f9fe0", "#9fd4f5", "waves", { variants: 2, walkable: false });
  const thin = b.mat("thin_ice", "hazard", "#9fd4f5", "#1f3f7a", "cracks", { variants: 2 });
  const vent = b.mat("ember_pit", "hazard", "#7a1f2b", "#f5a65b", "cracks");
  const pine = b.mat("snowy_pine", "obstacle", "#2f5d34", "#c4c9dc", "grass", { variants: 2, walkable: false });
  const rock = b.mat("snowy_boulder", "obstacle", "#8b93b0", "#c4c9dc", "cracks", { walkable: false });
  const ice = b.mat("ice_crystal", "obstacle", "#9fd4f5", "#c4c9dc", "glow", { walkable: false });
  const stump = b.mat("frozen_stump", "obstacle", "#c99a63", "#c4c9dc", "rings", { walkable: false });
  const camp = b.mat("campfire", "decor", "#9a6a3f", "#e8683a", "none");
  const signpost = b.mat("trail_signpost", "decor", "#c99a3a", "#70472f", "planks");
  const supplies = b.mat("supply_crate", "decor", "#9a6a3f", "#c0392b", "planks");
  const reeds = b.mat("frozen_reeds", "decor", "#c4c9dc", "#9a6a3f", "none");
  const bones = b.mat("old_bones", "decor", "#c4c9dc", "#8b93b0", "none");
  const bannerD = b.mat("expedition_banner", "decor", "#4f9fe0", "#f6e8a0", "none");
  const lantern = b.mat("trail_lamp", "decor", "#5c6380", "#e8c95a", "none");

  const W = 32, H = 20;
  const p = new Painter(W, H, snow);
  p.fill(p.ground, 0, 9, 31, 10, packed);
  p.fill(p.ground, 10, 4, 11, 8, packed);
  p.fill(p.ground, 20, 11, 21, 15, packed);
  p.fill(p.ground, 13, 12, 19, 17, lake);
  p.fill(p.ground, 12, 11, 20, 11, frost);
  p.fill(p.ground, 12, 17, 12, 18, thin);
  p.fill(p.ground, 4, 13, 7, 15, frost);
  p.fill(p.ground, 24, 2, 29, 5, sandy);
  p.fill(p.ground, 25, 14, 27, 15, thin);
  p.fill(p.ground, 4, 4, 5, 5, vent);

  p.box(p.walls, 0, 0, W - 1, H - 1, rockWall);
  p.gate(p.walls, 0, 9); p.gate(p.walls, 0, 10);
  p.fill(p.walls, 1, 1, 8, 2, cliff); p.fill(p.walls, 23, 1, 30, 1, cliff); p.fill(p.walls, 14, 1, 17, 3, cliff);
  p.fill(p.walls, 25, 7, 30, 7, cliff);

  p.scatter(p.walls, [[3, 6], [8, 6], [9, 12], [2, 11], [15, 6], [18, 5], [22, 8], [28, 9], [29, 12], [23, 17], [9, 17], [4, 18], [30, 17], [26, 11], [13, 4]], pine);
  p.scatter(p.walls, [[6, 8], [12, 13 - 1 + 1], [20, 3], [28, 15]], rock);
  p.scatter(p.walls, [[7, 17], [19, 7], [29, 18]], ice);
  p.scatter(p.walls, [[3, 9 + 3], [24, 12]], stump);
  p.scatter(p.decor, [[6, 11]], camp);
  p.scatter(p.decor, [[11, 9]], signpost);
  p.scatter(p.decor, [[7, 11], [5, 11]], supplies);
  p.scatter(p.decor, [[12, 18], [20, 18], [19, 12]], reeds);
  p.scatter(p.decor, [[22, 13], [16, 9]], bones);
  p.scatter(p.decor, [[8, 10], [27, 8]], bannerD);
  p.scatter(p.decor, [[2, 8], [30, 8]], lantern);

  const objects: MapObject[] = [
    { type: "spawn", name: "party_start", x: 2, y: 9 },
    { type: "exit", name: "road_to_town", to: "m_hollowmere", target_entry: "party_start", x: 0, y: 9 },
    { type: "interactable", id: "chest_camp", kind: "chest", state: "closed", x: 8, y: 12 },
    { type: "interactable", id: "sign_trail", kind: "sign", state: "closed", x: 11, y: 10 },
  ];
  const map = finish("m_trail", p, b, objects,
    { name: "Frostfang Trail", layout: "trail", environment: "outdoor", mood: "neutral" }, ["snow", "mountain"], 777);

  const entities: EntityView[] = [
    ent("npc_wolf", "npc", "Snow Wolf", 10, 6, 12, sp("beast", "medium", ["#c4c9dc", "#f6e8a0", "#4f9fe0", "#5c6380"], ["fur", "mane", "tail"]), "neutral"),
    ent("npc_owl", "npc", "Frost Owl", 15, 8, 5, sp("avian", "small", ["#f6e8a0", "#c4c9dc", "#e8683a", "#8b93b0"], ["wings", "ears_pointed"]), "friendly"),
    ent("npc_wyrm", "npc", "Frost Wyrm", 22, 12, 30, sp("serpent", "large", ["#4f9fe0", "#9fd4f5", "#f6e8a0", "#2f6bb5"], ["fins", "spikes"]), "neutral"),
    ent("npc_elemental", "npc", "Ice Elemental", 18, 10, 18, sp("spirit", "large", ["#9fd4f5", "#4f9fe0", "#f6e8a0", "#1f3f7a"], ["crystals", "sparkles"]), "neutral"),
    ent("npc_yeti", "npc", "Old Yeti", 26, 9, 22, sp("humanoid", "large", ["#c4c9dc", "#8b93b0", "#4f9fe0", "#5c6380"], ["fur", "horns", "beard"]), "friendly"),
    ent("npc_sprite", "npc", "Pine Sprite", 9, 13, 6, sp("plant", "small", ["#2f5d34", "#70472f", "#9fd4f5", "#4a2f24"], ["leaves", "glowing_eyes"]), "friendly"),
    ent("npc_golem", "npc", "Snow Golem", 28, 14, 20, sp("construct", "medium", ["#c4c9dc", "#8b93b0", "#4f9fe0", "#5c6380"], ["crystals", "armor"]), "neutral"),
    ent("npc_crab", "npc", "Rime Crab", 16, 14, 8, sp("insectoid", "small", ["#4f9fe0", "#9fd4f5", "#f5a65b", "#2f6bb5"], ["shell", "extra_eyes"]), "neutral"),
    ent("npc_drift", "npc", "Drift Slime", 24, 16, 8, sp("amorphous", "small", ["#9fd4f5", "#c4c9dc", "#f6e8a0", "#4f9fe0"], ["sparkles"]), "neutral"),
    ent("npc_guide", "npc", "Sera the Guide", 4, 10, 9, sp("humanoid", "medium", ["#d39a72", "#4f9fe0", "#e8c95a", "#5c6380"], ["hood", "cloak", "bow"]), "friendly"),
  ];
  return {
    id: "m_trail", title: "Frostfang Trail", map, start: { x: 2, y: 9 }, entities,
    arrival: "Wind combs the snow into long ridges. A packed trail winds between pines toward a frozen lake.",
    chips: ["Talk to Sera", "Look around", "Go to the town square"],
  };
}

/** The mock server's maps by id. */
export function buildScenes(): Record<string, MockScene> {
  const scenes = [buildTown(), buildCrypt(), buildTrail()];
  return Object.fromEntries(scenes.map((s) => [s.id, s]));
}

export const FIRST_SCENE = "m_hollowmere";

/** Which scene a "go to ..." message asks for, or null. */
export function sceneFromText(text: string): string | null {
  if (/crypt|tomb|catacomb|underground|flooded/i.test(text)) return "m_crypt";
  if (/trail|snow|mountain|frost|pass/i.test(text)) return "m_trail";
  if (/town|square|village|hollowmere|inn|back/i.test(text)) return "m_hollowmere";
  return null;
}

export function buildMockMap(): GameMap {
  return buildScenes()[FIRST_SCENE]!.map;
}

export const NARRATION_OPENING =
  "Dusk settles over Hollowmere like a damp wool blanket. Lanterns gutter along the village square, and " +
  "somewhere beyond the reeds a low, wordless humming drifts in from the marsh. Odalys the innkeeper pauses " +
  "mid-sweep on the porch of the Drowned Lantern, watching you with a wary, hopeful look. At the far side " +
  "of the square, two figures in grey robes stand perfectly still, mouths slightly open, as if listening.";
