/**
 * Props drawn on a transparent 48 x 64 canvas whose bottom edge is the bottom of the tile (the extra 16px
 * above let tree crowns and pillars rise over the tile north of them). Also hazard motifs and doors.
 * Everything is picked from the material id and pattern, so any material the DM invents still draws.
 */
import type { MaterialRole, Pattern, TileDef } from "@aedm/schemas";
import { OUTLINE, RAMPS, mixHex, tones, type Tones } from "./palette";
import { Pen, rint, rng } from "./px";

export const PROP_KINDS = [
  "tree", "pine", "rock", "crystal", "pillar", "spire", "bush", "crate", "barrel", "torch", "lamppost", "brazier",
  "campfire", "table", "bed", "shelf", "pot", "flowers", "mushroom", "bones", "banner", "well", "sign", "web",
  "rubble", "reeds", "stump", "coffin", "grave", "statue", "block",
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

const KEYWORDS: readonly (readonly [RegExp, PropKind])[] = [
  [/stump|log\b/, "stump"],
  [/campfire|fire_?pit|bonfire|hearth/, "campfire"],
  [/brazier|sconce/, "brazier"],
  [/lamp|lantern|streetlight/, "lamppost"],
  [/torch|candle|flame_?post/, "torch"],
  [/pine|fir\b|fir_|spruce|conifer/, "pine"],
  [/tree|oak|willow|birch|palm|trunk|sapling/, "tree"],
  [/crystal|gem|geode|ice_?spike|quartz/, "crystal"],
  [/stalag|spire|spike_?rock|obelisk/, "spire"],
  [/sign|notice|marker_?post/, "sign"],
  [/pillar|column|post\b/, "pillar"],
  [/statue|idol|gargoyle|totem|effigy/, "statue"],
  [/sarcoph|coffin|tomb|crypt_?lid|casket/, "coffin"],
  [/grave|tombstone|headstone|marker/, "grave"],
  [/boulder|rock|stone_?pile|cliff|outcrop/, "rock"],
  [/rubble|debris|pebble|scree|gravel|bits/, "rubble"],
  [/bush|shrub|hedge|thorn|bramble|fern|berry/, "bush"],
  [/barrel|keg|cask|cauldron|bucket/, "barrel"],
  [/crate|box|chest|trunk_?chest|sack|bale|hay|supplies/, "crate"],
  [/table|desk|bench|counter|bar\b|altar|workbench|chair|stool/, "table"],
  [/bed|cot|bedroll|hammock/, "bed"],
  [/shelf|bookcase|library|rack|cabinet|wardrobe/, "shelf"],
  [/pot|vase|urn|jar|amphora|pitcher/, "pot"],
  [/flower|bloom|rose|lily|tulip|herb|garden/, "flowers"],
  [/mushroom|fungus|toadstool|shroom/, "mushroom"],
  [/bone|skull|skeleton|remains|corpse/, "bones"],
  [/banner|flag|tapestry|pennant|curtain/, "banner"],
  [/well|fountain|basin|trough|pool_?edge/, "well"],
  [/web|cobweb/, "web"],
  [/reed|cattail|rushes|tall_?grass|weed/, "reeds"],
];

/** Which prop a tile draws: a keyword in the material id, else a guess from the role and pattern. */
export function propKindFor(def: Pick<TileDef, "material_id" | "role" | "pattern">): PropKind {
  const id = def.material_id.toLowerCase();
  for (const [rx, kind] of KEYWORDS) if (rx.test(id)) return kind;
  return fallbackKind(def.role, def.pattern);
}

function fallbackKind(role: MaterialRole, pattern: Pattern): PropKind {
  if (role === "obstacle") {
    if (pattern === "grass") return "bush";
    if (pattern === "rings" || pattern === "grain" || pattern === "planks") return "stump";
    if (pattern === "glow" || pattern === "runes") return "crystal";
    return "rock";
  }
  if (pattern === "grass") return "flowers";
  if (pattern === "glow") return "crystal";
  if (pattern === "planks" || pattern === "grain") return "crate";
  return "block";
}

/** Props that flicker, drawn in two frames. */
export function propFrames(kind: PropKind): number {
  return kind === "torch" || kind === "brazier" || kind === "campfire" || kind === "lamppost" ? 2 : 1;
}

/** Props that cast light in dark scenes. */
export function propGivesLight(kind: PropKind): boolean {
  return propFrames(kind) === 2;
}

const SHADOW = "rgba(27,22,38,0.34)";
const E = RAMPS.earth, F = RAMPS.fire, G = RAMPS.grass;
const earth = (i: 0 | 1 | 2 | 3) => E[i];

function shadow(p: Pen, rx = 14, ry = 4.5, cy = 57.5): void {
  p.ell(24, cy, rx, ry, SHADOW);
}

function flame(p: Pen, frame: number, cx = 24, base = 36, s = 1): void {
  const f = frame % 2;
  const h = (n: number) => Math.round(n * s);
  p.poly([[cx, base - h(15) - f], [cx + h(6) + f, base - h(6)], [cx + h(4), base], [cx - h(4), base], [cx - h(6), base - h(6)]], F[2]);
  p.poly([[cx + (f ? 1 : 0), base - h(10)], [cx + h(4), base - h(4)], [cx + h(3), base], [cx - h(3), base], [cx - h(4), base - h(4)]], F[3]);
  p.poly([[cx, base - h(5)], [cx + h(2), base - h(2)], [cx + h(2), base], [cx - h(2), base], [cx - h(2), base - h(2)]], "#f6e8a0");
}

type Draw = (p: Pen, c: Tones, a: Tones, frame: number, seed: number, def: TileDef) => void;

const DRAW: Record<PropKind, Draw> = {
  tree(p, c, a, _f, seed) {
    const r = rng(seed);
    shadow(p, 17, 5);
    p.rect(21, 38, 7, 20, earth(1));
    p.rect(21, 38, 2, 20, earth(2));
    p.rect(26, 38, 2, 20, earth(0));
    p.rect(19, 54, 11, 4, earth(1));
    p.rect(19, 54, 3, 4, earth(2));
    p.blob(24, 25, 17, 14, c);
    p.blob(13, 33, 11, 9, c);
    p.blob(35, 33, 11, 9, c);
    p.blob(24, 35, 13, 9, c);
    for (let k = 0; k < 9; k++) p.px(10 + rint(r, 28), 14 + rint(r, 26), k % 2 ? c.hi : c.dk);
    if (a.base !== c.base) for (let k = 0; k < 3; k++) { const x = 12 + rint(r, 24), y = 20 + rint(r, 16); p.rect(x, y, 2, 2, a.base); p.px(x, y, a.hi); }
  },

  pine(p, c, a) {
    shadow(p, 15, 4.5);
    p.rect(22, 50, 5, 8, earth(1));
    p.rect(22, 50, 2, 8, earth(2));
    const tier = (top: number, bot: number, half: number) => {
      p.poly([[24, top], [24 + half, bot], [24 - half, bot]], c.sh);
      p.poly([[24, top], [24, bot], [24 - half, bot]], c.base);
      p.poly([[24, top + 2], [24 - Math.round(half * 0.4), top + (bot - top) * 0.5], [24, top + (bot - top) * 0.5]], c.hi);
      p.rect(24 - half, bot - 1, half * 2, 2, c.dk);
    };
    tier(24, 52, 20); tier(12, 40, 16); tier(1, 28, 12);
    p.poly([[24, 1], [29, 10], [19, 10]], a.base);
    p.poly([[24, 12], [31, 22], [17, 22]], a.base);
    p.poly([[24, 24], [33, 34], [15, 34]], a.base);
    p.poly([[24, 1], [24, 10], [19, 10]], a.hi);
  },

  rock(p, c, a, _f, seed) {
    const r = rng(seed);
    shadow(p, 17, 4.5);
    const pts: [number, number][] = [[7, 54], [9, 41], [16, 32], [28, 29], [38, 35], [42, 47], [39, 57], [14, 58]];
    p.poly(pts, c.dk);
    p.poly(pts.map(([x, y]) => [24 + (x - 24) * 0.93, 44 + (y - 44) * 0.9 - 1] as [number, number]), c.sh);
    p.poly([[10, 49], [11, 41], [17, 34], [27, 31], [31, 36], [22, 42], [17, 52]], c.base);
    p.poly([[13, 41], [18, 35], [26, 33], [22, 38]], c.hi);
    p.line(26, 44, 29, 50, c.dk); p.line(29, 50, 27, 55, c.dk);
    for (let k = 0; k < 4; k++) p.px(14 + rint(r, 22), 38 + rint(r, 16), c.hi);
    if (a.base !== c.base) { p.ell(21, 33, 6, 2.2, a.base); p.ell(20, 32.5, 3, 1, a.hi); }
  },

  crystal(p, c, a) {
    shadow(p, 15, 4);
    const prism = (cx: number, base: number, w: number, h: number, col: Tones) => {
      const top = base - h, sh = top + Math.round(h * 0.28);
      const pts: [number, number][] = [[cx, top], [cx + w, sh], [cx + w, base], [cx - w, base], [cx - w, sh]];
      p.poly(pts, col.dk);
      p.poly([[cx, top + 1], [cx + w - 1, sh + 1], [cx + w - 1, base - 1], [cx, base - 1]], col.base);
      p.poly([[cx, top + 1], [cx, base - 1], [cx - w + 1, base - 1], [cx - w + 1, sh + 1]], col.hi);
      p.rect(cx + 1, sh + 2, 1, Math.round(h * 0.4), col.sh);
    };
    prism(15, 56, 7, 22, c); prism(33, 57, 8, 28, c); prism(24, 58, 9, 38, c);
    p.rect(20, 28, 2, 4, a.hi); p.px(21, 25, a.hi);
  },

  pillar(p, c) {
    shadow(p, 14, 4.5);
    p.box(14, 53, 20, 6, c);
    p.rect(14, 58, 20, 1, c.dk);
    p.rect(18, 19, 12, 35, c.base);
    p.rect(18, 19, 3, 35, c.hi);
    p.rect(27, 19, 3, 35, c.sh);
    p.rect(23, 20, 1, 33, c.sh);
    p.box(13, 13, 22, 7, c);
    p.rect(13, 19, 22, 1, c.dk);
    p.px(25, 30, c.dk); p.px(24, 31, c.dk); p.px(24, 32, c.dk); p.px(22, 40, c.dk); p.px(23, 41, c.dk);
  },

  spire(p, c) {
    shadow(p, 14, 4);
    p.poly([[24, 14], [36, 56], [12, 56]], c.dk);
    p.poly([[24, 15], [24, 56], [13, 56]], c.hi);
    p.poly([[24, 15], [35, 56], [24, 56]], c.base);
    p.poly([[24, 15], [28, 36], [24, 36]], c.sh);
    p.poly([[40, 56], [34, 36], [29, 56]], c.sh);
    p.poly([[10, 57], [14, 44], [19, 57]], c.base);
  },

  bush(p, c, a, _f, seed) {
    const r = rng(seed);
    shadow(p, 17, 5);
    p.blob(14, 47, 11, 9, c); p.blob(34, 47, 11, 9, c); p.blob(24, 40, 14, 11, c); p.blob(24, 50, 15, 7, c);
    for (let k = 0; k < 7; k++) p.px(10 + rint(r, 28), 36 + rint(r, 18), k % 2 ? c.hi : c.dk);
    if (a.base !== c.base) for (let k = 0; k < 4; k++) { const x = 12 + rint(r, 22), y = 38 + rint(r, 14); p.rect(x, y, 2, 2, a.base); p.px(x, y, a.hi); }
  },

  crate(p, c, a) {
    shadow(p, 16, 4.5);
    p.rect(10, 34, 28, 24, c.dk);
    p.rect(11, 42, 26, 15, c.base);
    p.rect(11, 35, 26, 7, mixHex(c.base, c.hi, 0.45));
    p.rect(11, 35, 26, 1, c.hi);
    p.rect(11, 42, 26, 1, c.dk);
    p.rect(11, 42, 3, 15, c.sh); p.rect(34, 42, 3, 15, c.sh);
    p.line(14, 44, 34, 55, c.sh); p.line(34, 44, 14, 55, c.sh);
    p.px(12, 43, a.base); p.px(35, 43, a.base); p.px(12, 55, a.base); p.px(35, 55, a.base);
  },

  barrel(p, c, a) {
    shadow(p, 14, 4.5);
    p.ell(24, 47, 13, 12, c.dk);
    p.rect(11, 38, 26, 18, c.dk);
    p.rect(12, 38, 24, 18, c.base);
    p.rect(12, 38, 4, 18, c.hi);
    p.rect(30, 38, 6, 18, c.sh);
    p.rect(12, 42, 24, 2, a.sh); p.rect(12, 52, 24, 2, a.sh);
    p.rect(12, 42, 24, 1, a.hi); p.rect(12, 52, 24, 1, a.hi);
    p.ell(24, 38, 12, 5, c.dk);
    p.ell(24, 38, 11, 4, c.hi);
    p.ell(24, 38.5, 8, 2.5, c.base);
  },

  torch(p, _c, _a, frame) {
    shadow(p, 8, 3);
    p.rect(22, 32, 4, 26, earth(1));
    p.rect(22, 32, 1, 26, earth(2));
    p.rect(20, 30, 8, 4, earth(0));
    p.rect(20, 30, 8, 1, earth(2));
    flame(p, frame, 24, 30);
  },

  lamppost(p, c, a, frame) {
    shadow(p, 8, 3);
    p.rect(22, 30, 4, 28, c.sh);
    p.rect(22, 30, 1, 28, c.base);
    p.rect(19, 55, 10, 3, c.dk);
    p.rect(17, 14, 14, 16, c.dk);
    p.rect(19, 16, 10, 12, mixHex(F[3], "#f6e8a0", frame ? 0.5 : 0.25));
    p.rect(21, 19, 6, 7, "#f6e8a0");
    p.rect(15, 12, 18, 3, c.base); p.rect(15, 12, 18, 1, c.hi);
    p.px(24, 10, a.base);
  },

  brazier(p, c, _a, frame) {
    shadow(p, 13, 4);
    p.rect(16, 54, 3, 4, c.dk); p.rect(29, 54, 3, 4, c.dk);
    p.poly([[11, 42], [37, 42], [31, 55], [17, 55]], c.dk);
    p.poly([[12, 43], [36, 43], [31, 53], [17, 53]], c.base);
    p.rect(12, 43, 24, 2, c.hi);
    p.rect(30, 45, 5, 8, c.sh);
    p.ell(24, 42, 13, 3, c.dk);
    p.ell(24, 42, 11, 2, F[1]);
    flame(p, frame, 24, 42, 1.2);
  },

  campfire(p, c, _a, frame) {
    shadow(p, 15, 4.5);
    p.ell(24, 53, 13, 5, "#3b3f55");
    for (let k = 0; k < 8; k++) { const ang = (k / 8) * Math.PI * 2; p.rect(24 + Math.cos(ang) * 11 - 2, 53 + Math.sin(ang) * 4 - 2, 4, 4, k % 2 ? c.base : RAMPS.stone[2]); }
    p.line(14, 56, 33, 48, earth(0), 4); p.line(14, 56, 33, 48, earth(1), 2);
    p.line(34, 56, 15, 48, earth(0), 4); p.line(34, 56, 15, 48, earth(2), 2);
    flame(p, frame, 24, 50, 1.4);
  },

  table(p, c, a) {
    shadow(p, 18, 5);
    p.rect(10, 46, 4, 12, c.dk); p.rect(34, 46, 4, 12, c.dk);
    p.rect(10, 46, 1, 12, c.sh); p.rect(34, 46, 1, 12, c.sh);
    p.rect(6, 36, 36, 12, c.dk);
    p.rect(7, 37, 34, 8, c.base);
    p.rect(7, 37, 34, 1, c.hi);
    p.rect(7, 45, 34, 2, c.sh);
    p.rect(30, 39, 4, 4, a.base); p.rect(30, 39, 4, 1, a.hi);
    p.rect(13, 40, 8, 1, c.sh);
  },

  bed(p, c, a) {
    shadow(p, 19, 5);
    p.box(7, 34, 34, 24, { hi: earth(2), base: earth(1), sh: earth(0) });
    p.rect(9, 36, 30, 20, "#f2e3c8");
    p.rect(9, 45, 30, 11, a.base); p.rect(9, 45, 30, 1, a.hi); p.rect(9, 55, 30, 1, a.sh);
    p.rrect(11, 38, 12, 6, 2, c.hi);
  },

  shelf(p, c, a) {
    shadow(p, 17, 4.5);
    p.rect(9, 14, 30, 44, earth(0));
    p.rect(10, 15, 28, 42, earth(1));
    p.rect(10, 15, 28, 1, earth(2));
    const cols = [c.base, a.base, c.hi, a.sh, c.sh, a.hi];
    for (let row = 0; row < 3; row++) {
      const y = 17 + row * 13;
      p.rect(11, y + 10, 26, 2, earth(0));
      let x = 12;
      for (let k = 0; x < 35; k++) { const w = 3 + ((k * 5 + row) % 3); p.rect(x, y + (k % 3), w, 10 - (k % 3), cols[(k + row) % cols.length]!); p.rect(x, y + (k % 3), 1, 10 - (k % 3), OUTLINE); x += w + 1; }
    }
  },

  pot(p, c, a) {
    shadow(p, 11, 3.5);
    p.blob(24, 47, 11, 10, c);
    p.rect(20, 34, 9, 6, c.sh); p.rect(20, 34, 3, 6, c.base);
    p.rect(18, 33, 13, 3, c.hi);
    p.rect(14, 46, 20, 2, a.base);
    p.rect(14, 46, 20, 1, a.hi);
  },

  flowers(p, c, a, _f, seed) {
    const r = rng(seed);
    shadow(p, 12, 3.5, 56);
    for (let k = 0; k < 5; k++) {
      const x = 12 + k * 6 + rint(r, 3), top = 36 + rint(r, 10), col = k % 2 ? a : c;
      p.rect(x, top + 3, 1, 56 - top - 3, G[1]);
      p.rect(x - 2, 50 - (k % 2) * 4, 2, 1, G[2]);
      p.rect(x - 1, top, 3, 3, col.base); p.px(x, top + 1, "#f6e8a0"); p.px(x - 1, top, col.hi);
    }
  },

  mushroom(p, c, a) {
    shadow(p, 12, 3.5);
    p.rect(21, 46, 6, 11, "#f2cfa6"); p.rect(25, 46, 2, 11, "#d39a72");
    p.ell(24, 45, 14, 10, c.dk);
    p.blob(24, 43, 13, 9, c);
    p.rect(11, 47, 26, 3, c.sh);
    p.rect(17, 38, 3, 3, a.hi); p.rect(27, 40, 3, 3, a.hi); p.rect(22, 34, 2, 2, a.hi);
    p.blob(10, 54, 5, 4, c);
    p.rect(9, 55, 3, 3, "#f2cfa6");
  },

  bones(p, c) {
    shadow(p, 15, 4);
    p.line(10, 54, 36, 46, c.dk, 4); p.line(10, 54, 36, 46, c.base, 2);
    p.line(12, 46, 34, 55, c.dk, 4); p.line(12, 46, 34, 55, c.hi, 2);
    p.blob(24, 47, 8, 7, c);
    p.rect(20, 46, 3, 3, OUTLINE); p.rect(26, 46, 3, 3, OUTLINE);
    p.rect(21, 52, 6, 2, c.sh);
    for (let i = 0; i < 3; i++) p.rect(21 + i * 2, 52, 1, 2, c.dk);
  },

  banner(p, c, a) {
    shadow(p, 7, 3);
    p.rect(23, 14, 3, 44, earth(1)); p.rect(23, 14, 1, 44, earth(2));
    p.rect(11, 15, 26, 3, earth(0)); p.rect(11, 15, 26, 1, earth(2));
    p.poly([[13, 18], [35, 18], [35, 44], [24, 38], [13, 44]], c.dk);
    p.poly([[14, 18], [34, 18], [34, 42], [24, 36], [14, 42]], c.base);
    p.rect(14, 18, 3, 24, c.hi);
    p.rect(30, 18, 4, 24, c.sh);
    p.poly([[24, 22], [28, 28], [24, 34], [20, 28]], a.base);
    p.poly([[24, 22], [24, 34], [20, 28]], a.hi);
  },

  well(p, c, a) {
    shadow(p, 19, 5.5);
    p.ell(24, 48, 18, 10, c.dk);
    p.ell(24, 46, 18, 9, c.base);
    p.ell(24, 46, 12.5, 6, c.dk);
    p.ell(24, 46.5, 11, 5, mixHex(a.base, "#1f3f7a", 0.2));
    p.ell(22, 45, 5, 1.5, a.hi);
    p.rect(8, 47, 32, 10, c.base);
    p.rect(8, 47, 6, 10, c.hi); p.rect(34, 47, 6, 10, c.sh);
    p.ell(24, 57, 16, 3, c.sh);
    p.rect(8, 49, 32, 1, c.sh);
    p.rect(14, 52, 1, 5, c.sh); p.rect(24, 52, 1, 5, c.sh); p.rect(33, 52, 1, 5, c.sh);
  },

  sign(p, c, a) {
    shadow(p, 8, 3);
    p.rect(22, 30, 4, 28, earth(1)); p.rect(22, 30, 1, 28, earth(2));
    p.box(9, 18, 30, 15, { hi: c.hi, base: c.base, sh: c.sh });
    p.rect(9, 18, 30, 15, c.base);
    p.rect(9, 18, 30, 1, c.hi); p.rect(9, 32, 30, 1, c.dk);
    p.rect(9, 18, 1, 15, c.dk); p.rect(38, 18, 1, 15, c.dk);
    p.rect(13, 22, 18, 2, c.dk); p.rect(13, 27, 11, 2, c.dk);
    p.px(11, 20, a.base); p.px(36, 20, a.base);
  },

  web(p, c) {
    const col = c.hi;
    for (const [x, y] of [[44, 18], [34, 34], [18, 46], [4, 52]] as const) p.line(4, 17, x, y, col);
    for (const rad of [10, 18, 26]) for (let a = 0; a <= 8; a++) {
      const t = (a / 8) * (Math.PI / 2) * 0.95 + 0.05;
      p.px(4 + Math.cos(t) * rad, 17 + Math.sin(t) * rad * 1.1, col);
    }
  },

  rubble(p, c, _a, _f, seed) {
    const r = rng(seed);
    shadow(p, 17, 4.5);
    const rocks: [number, number, number][] = [[14, 52, 9], [30, 53, 8], [23, 46, 7], [36, 47, 5]];
    for (const [x, y, s] of rocks) {
      const jx = rint(r, 2);
      p.poly([[x - s, y + 4], [x - s * 0.7 + jx, y - s * 0.6], [x + s * 0.2, y - s * 0.8], [x + s, y - 1], [x + s * 0.8, y + 4]], c.dk);
      p.poly([[x - s + 1, y + 3], [x - s * 0.6 + jx, y - s * 0.5], [x + s * 0.2, y - s * 0.7], [x + s * 0.6, y + 3]], c.base);
      p.poly([[x - s * 0.6, y - s * 0.3], [x - s * 0.2, y - s * 0.6], [x + s * 0.2, y - s * 0.6]], c.hi);
    }
  },

  reeds(p, c, a, _f, seed) {
    const r = rng(seed);
    shadow(p, 14, 3.5, 56.5);
    for (let k = 0; k < 8; k++) {
      const x = 8 + k * 4 + rint(r, 2), top = 20 + rint(r, 16), lean = rint(r, 5) - 2;
      p.line(x, 57, x + lean, top, k % 2 ? c.base : c.sh);
      if (k % 3 === 0) p.rect(x + lean - 1, top - 1, 3, 7, a.base);
      if (k % 3 === 0) p.rect(x + lean - 1, top - 1, 1, 7, a.hi);
    }
  },

  stump(p, c, a) {
    shadow(p, 17, 5);
    p.rect(11, 44, 26, 13, earth(0));
    p.rect(12, 44, 24, 13, earth(1));
    p.rect(12, 44, 5, 13, earth(2));
    p.ell(24, 57, 13, 3.5, earth(0));
    for (let k = 0; k < 4; k++) p.rect(17 + k * 5, 47, 1, 8, earth(0));
    p.ell(24, 44, 14, 7, earth(0));
    p.ell(24, 44, 13, 6, c.hi);
    p.ell(24, 44, 9.5, 4, c.sh); p.ell(24, 44, 8.5, 3.4, c.base);
    p.ell(24, 44, 5, 2, c.sh); p.ell(24, 44, 4, 1.5, c.base);
    p.px(24, 44, a.base);
  },

  coffin(p, c, a) {
    shadow(p, 19, 5);
    p.rect(7, 34, 34, 24, c.dk);
    p.rect(8, 36, 32, 20, c.base);
    p.rect(8, 35, 32, 6, c.hi);
    p.rect(8, 47, 32, 9, c.sh);
    p.rect(8, 41, 32, 1, c.dk);
    p.rect(22, 38, 4, 14, a.base); p.rect(18, 42, 12, 3, a.base);
    p.rect(22, 38, 1, 14, a.hi); p.rect(18, 42, 12, 1, a.hi);
    p.rect(8, 55, 32, 1, c.dk);
  },

  grave(p, c, a) {
    shadow(p, 15, 4.5);
    p.rrect(14, 26, 21, 32, 8, c.dk);
    p.rrect(15, 27, 19, 30, 7, c.base);
    p.rect(15, 33, 4, 24, c.hi); p.rect(30, 33, 4, 24, c.sh);
    p.rect(23, 33, 3, 12, a.sh); p.rect(19, 36, 11, 3, a.sh);
    p.rect(23, 33, 1, 12, a.hi); p.rect(19, 36, 11, 1, a.hi);
    p.ell(24, 58, 14, 3, c.sh);
  },

  statue(p, c, a) {
    shadow(p, 15, 4.5);
    p.box(12, 48, 24, 10, c);
    p.rect(12, 52, 24, 1, c.dk);
    p.blob(24, 24, 8, 8, c);
    p.rrect(16, 31, 16, 18, 4, c.dk);
    p.rrect(17, 31, 14, 17, 4, c.base);
    p.rect(17, 31, 4, 17, c.hi); p.rect(28, 31, 3, 17, c.sh);
    p.rect(20, 23, 2, 2, c.dk); p.rect(26, 23, 2, 2, c.dk);
    p.rect(22, 38, 4, 3, a.base);
  },

  block(p, c, a) {
    shadow(p, 15, 4.5);
    p.rect(11, 36, 26, 22, c.dk);
    p.rect(12, 44, 24, 13, c.base);
    p.rect(12, 37, 24, 7, mixHex(c.base, c.hi, 0.5));
    p.rect(12, 37, 24, 1, c.hi);
    p.rect(12, 44, 24, 1, c.dk);
    p.rect(12, 45, 3, 12, c.hi);
    p.rect(33, 45, 3, 12, c.sh);
    p.rect(21, 48, 6, 6, a.base); p.rect(21, 48, 6, 1, a.hi);
  },
};

/** Draw the prop for a tile into `ctx` (a 48 x 64 canvas, bottom = tile bottom). */
export function drawProp(p: Pen, def: TileDef, frame: number): PropKind {
  const kind = propKindFor(def);
  DRAW[kind](p, tones(def.color), tones(def.accent), frame, def.gid * 977 + def.variant * 31, def);
  return kind;
}

// ---------- hazards ----------

export type HazardMotif = "flames" | "spikes" | "bubbles" | "shards" | "sparks" | "warning";

export function hazardMotifFor(def: Pick<TileDef, "material_id" | "pattern">): HazardMotif {
  const id = def.material_id.toLowerCase();
  if (/fire|lava|flame|ember|magma|burn|coal|brimstone/.test(id)) return "flames";
  if (/spike|trap|thorn|bramble|caltrop|blade|needle/.test(id)) return "spikes";
  if (/acid|poison|toxic|slime|ooze|bog|sludge|gas|spore|marsh|miasma|swamp|tar/.test(id)) return "bubbles";
  if (/ice|frost|cold|freez|shard|snow/.test(id)) return "shards";
  if (/ecto|spirit|ghost|curse|arcane|magic|rune|void|soul|glow|lightning|shock|aether/.test(id)) return "sparks";
  if (def.pattern === "glow" || def.pattern === "runes") return "sparks";
  if (def.pattern === "cracks") return "flames";
  return "warning";
}

/** Small icon-like motif in the middle of a hazard tile (48 x 48 canvas). */
export function drawHazardMotif(p: Pen, def: TileDef, frame: number): void {
  const motif = hazardMotifFor(def);
  const a = tones(def.accent), c = tones(def.color);
  const f = frame % 2;
  switch (motif) {
    case "flames":
      p.ell(24, 36, 10, 3, "rgba(27,22,38,0.35)");
      flame(p, frame, 24, 36, 1.5);
      break;
    case "spikes":
      for (const [x, h] of [[13, 12], [24, 16], [35, 12]] as const) {
        p.poly([[x - 5, 38], [x, 38 - h], [x + 5, 38]], OUTLINE);
        p.poly([[x - 3, 37], [x, 38 - h + 3], [x, 37]], "#c4c9dc");
        p.poly([[x, 38 - h + 3], [x + 3, 37], [x, 37]], "#5c6380");
      }
      break;
    case "bubbles":
      for (const [x, y, r] of [[14, 30, 5], [30, 20, 6], [24, 35, 4], [36, 33, 3]] as const) {
        const yy = y - f * 2;
        p.ell(x, yy, r + 1, r + 1, c.dk); p.ell(x, yy, r, r, a.base); p.rect(x - r * 0.5, yy - r * 0.5, Math.max(1, r * 0.4), Math.max(1, r * 0.4), a.hi);
      }
      break;
    case "shards":
      for (const [x, h] of [[15, 14], [25, 20], [35, 12]] as const) {
        p.poly([[x - 4, 40], [x, 40 - h], [x + 4, 40]], c.dk);
        p.poly([[x - 3, 39], [x, 40 - h + 2], [x, 39]], "#9fd4f5");
        p.poly([[x, 40 - h + 2], [x + 3, 39], [x, 39]], "#4f9fe0");
      }
      break;
    case "sparks": {
      const star = (cx: number, cy: number, s: number) => {
        p.poly([[cx, cy - s - 1], [cx + 2, cy - 2], [cx + s + 1, cy], [cx + 2, cy + 2], [cx, cy + s + 1], [cx - 2, cy + 2], [cx - s - 1, cy], [cx - 2, cy - 2]], OUTLINE);
        p.poly([[cx, cy - s], [cx + 1, cy - 1], [cx + s, cy], [cx + 1, cy + 1], [cx, cy + s], [cx - 1, cy + 1], [cx - s, cy], [cx - 1, cy - 1]], f ? a.hi : a.base);
      };
      star(24, 24, 8 - f); star(12, 35, 4 + f); star(36, 14, 4 + f);
      break;
    }
    case "warning":
      p.poly([[24, 12], [38, 38], [10, 38]], OUTLINE);
      p.poly([[24, 16], [34, 35], [14, 35]], a.base);
      p.rect(23, 22, 3, 7, OUTLINE); p.rect(23, 31, 3, 2, OUTLINE);
      break;
  }
}

/** Colors for the pulsing tint and light halo of a hazard. */
export function hazardGlow(def: Pick<TileDef, "material_id" | "accent">): string {
  const m = hazardMotifFor({ material_id: def.material_id, pattern: "none" });
  return m === "flames" ? F[2] : m === "shards" ? "#9fd4f5" : def.accent;
}

// ---------- doors ----------

/** A doorway: stone-ish frame, a half-open plank leaf, the floor showing through. 48 x 48. */
export function drawDoor(p: Pen, def: TileDef): void {
  const c = tones(def.color), a = tones(def.accent);
  const frame = tones(def.accent);
  p.rect(5, 0, 38, 48, OUTLINE);
  p.rect(6, 0, 36, 5, frame.base); p.rect(6, 0, 36, 1, frame.hi);
  p.rect(6, 0, 6, 48, frame.base); p.rect(6, 0, 2, 48, frame.hi);
  p.rect(36, 0, 6, 48, frame.sh);
  p.rect(12, 5, 24, 43, "rgba(27,22,38,0.55)");
  p.rect(12, 5, 24, 2, OUTLINE);
  // plank leaf, opened toward the left
  p.rect(12, 7, 11, 41, c.dk);
  for (let k = 0; k < 3; k++) { p.rect(13 + k * 3, 8, 3, 40, k % 2 ? c.base : c.hi); p.rect(13 + k * 3, 8, 1, 40, c.dk); }
  p.rect(12, 14, 11, 2, a.base); p.rect(12, 38, 11, 2, a.base);
  p.rect(21, 27, 2, 3, a.hi);
  p.rect(6, 45, 36, 3, frame.dk);
}

export { OUTLINE };
