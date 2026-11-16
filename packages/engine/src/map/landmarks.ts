/**
 * Landmarks: authored set pieces (data/landmarks.json) that the generator stamps into a map so a location's features become
 * places a player can name. This file holds the library, its oriented patterns, matching from free text and the reader that
 * finds the landmarks of a finished map. Stamping lives in landmark-stamp.ts. Pure and deterministic: no clock, no randomness.
 */
import type { Environment, GameMap, Layout } from "@aedm/schemas";
import data from "../../data/landmarks.json";
import { getObjects } from "./nav";
import { words } from "./materials";

export type LandmarkRole = "npc" | "enemy" | "boss" | "loot" | "poi";

/** A prop or special cell of a piece's pattern (the capital letters of its rows). */
export interface LegendEntry {
  /** Material id (prop or obstacle) from materials.json. */
  p?: string;
  /** Blocks movement (an obstacle) when true; otherwise a walkable decor prop. */
  solid?: boolean;
  /** `","` wears the ground under the prop. */
  ground?: string;
  /** A wall cell that wants a built look. */
  wall?: boolean;
  /** Library wall ids used instead of the setting's wall when that is natural (hedge, cliff, cave rock). */
  use?: string[];
}

export interface LandmarkPiece {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  env: Environment[];
  layouts?: Layout[];
  roles: LandmarkRole[];
  weight: number;
  pond?: boolean;
  sign?: string[];
  legend: Record<string, LegendEntry>;
  rows: string[];
}

interface LandmarkFile {
  /** Settings where some pieces do not fit (a hedge maze's rooms are too small), so they are never offered there. */
  unfit: Array<{ env: Environment; layout: Layout; pieces: string[] }>;
  limits: { small: number; medium: number; large: number; searchRadius: number; wideRadius: number; gap: number; fightClear: number; maxTries: number };
  pieces: LandmarkPiece[];
}

const file = data as unknown as LandmarkFile;
export const LANDMARK_LIMITS = file.limits;
export const LANDMARK_PIECES: readonly LandmarkPiece[] = file.pieces;
const UNFIT = new Set(file.unfit.flatMap((u) => u.pieces.map((id) => `${id}|${u.env}|${u.layout}`)));
const BY_ID = new Map(file.pieces.map((p) => [p.id, p]));

export const getLandmarkPiece = (id: string): LandmarkPiece | undefined => BY_ID.get(id);

// ---------- oriented patterns ----------

export interface Pt {
  x: number;
  y: number;
}

/** Anchor kinds, as the pattern letters: s stand, f fight, i item, g sign. */
export interface Anchors {
  stand: Pt[];
  fight: Pt[];
  item: Pt[];
  sign: Pt[];
}

export interface Oriented {
  w: number;
  h: number;
  /** Row-major pattern characters. */
  cells: string[];
  center: Pt;
  anchors: Anchors;
}

/** Eight orientations: four rotations, each optionally mirrored. */
export const ORIENTATIONS = 8;

const cache = new Map<string, Oriented>();

/** The piece's pattern turned `t` (0 to 7) times: `t % 4` quarter turns after a mirror when `t >= 4`. Cached. */
export function orient(piece: LandmarkPiece, t: number): Oriented {
  const key = `${piece.id}:${t}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let rows = piece.rows.map((r) => r.split(""));
  if (t >= 4) rows = rows.map((r) => r.slice().reverse());
  for (let k = 0; k < t % 4; k++) {
    const h = rows.length;
    const w = rows[0]!.length;
    const next: string[][] = Array.from({ length: w }, () => new Array<string>(h).fill("."));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) next[x]![h - 1 - y] = rows[y]![x]!;
    rows = next;
  }
  const h = rows.length;
  const w = rows[0]!.length;
  const cells = rows.flat();
  const anchors: Anchors = { stand: [], fight: [], item: [], sign: [] };
  let center: Pt = { x: 0, y: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = cells[y * w + x]!;
      if (c === "@") center = { x, y };
      else if (c === "s") anchors.stand.push({ x, y });
      else if (c === "f") anchors.fight.push({ x, y });
      else if (c === "i") anchors.item.push({ x, y });
      else if (c === "g") anchors.sign.push({ x, y });
    }
  }
  const o: Oriented = { w, h, cells, center, anchors };
  cache.set(key, o);
  return o;
}

// ---------- matching ----------

export interface MatchContext {
  environment: Environment;
  layout: Layout;
  /** False when the setting wants no water (liquid density 0): pieces that carve a pond are left out. Default true. */
  water?: boolean;
}

/** Whether a piece may be stamped in a setting. */
export const suits = (p: LandmarkPiece, ctx: MatchContext): boolean =>
  p.env.includes(ctx.environment) && !UNFIT.has(`${p.id}|${ctx.environment}|${ctx.layout}`) && (!p.layouts || p.layouts.includes(ctx.layout)) && (!p.pond || ctx.water !== false);

const keywordWords = new Map<string, string[]>();
function pieceWords(p: LandmarkPiece): string[] {
  let w = keywordWords.get(p.id);
  if (!w) {
    w = [...new Set([...p.keywords.flatMap((k) => words(k)), ...words(p.id.replaceAll("_", " ")), ...words(p.name)])];
    keywordWords.set(p.id, w);
  }
  return w;
}

/** Relevance of free text to a piece: whole keyword hits count most, a shared stem of 4 or more letters less. 0 when nothing fits. */
export function relevance(text: string, p: LandmarkPiece): number {
  const toks = words(text);
  if (toks.length === 0) return 0;
  const own = new Set([...words(p.id.replaceAll("_", " ")), ...words(p.name)]);
  const kw = pieceWords(p);
  let score = 0;
  for (const t of toks) {
    if (own.has(t)) score += 4;
    else if (kw.includes(t)) score += 3;
    else if (t.length >= 4 && kw.some((k) => k.length >= 4 && (k.startsWith(t) || t.startsWith(k)))) score += 1.5;
  }
  return score;
}

/** A small stable integer hash of text, so unusual phrases still pick a fitting piece the same way every time. */
export function textHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface Match {
  piece: LandmarkPiece;
  /** 0 means no keyword fit and the piece is a fallback chosen for the setting and role. */
  score: number;
}

/** Pieces that suit a setting, excluding some ids. */
export function candidates(ctx: MatchContext, exclude: ReadonlySet<string> = new Set()): LandmarkPiece[] {
  return LANDMARK_PIECES.filter((p) => suits(p, ctx) && !exclude.has(p.id));
}

/**
 * The set piece that best fits free text (a plan feature, a point-of-interest kind) in a setting: the highest keyword
 * relevance among the pieces that suit the environment and layout, ties broken by role fit, then id. With no keyword fit it
 * falls back to a piece suited to the role (`poi` by default), chosen by a hash of the text, so any phrase yields a piece.
 * `exclude` skips pieces already used on the map; when that leaves nothing the full list is used. Undefined only when no
 * piece suits the setting at all (the data guarantees at least one for every environment and layout).
 */
export function matchLandmark(text: string, ctx: MatchContext, role: LandmarkRole = "poi", exclude: ReadonlySet<string> = new Set()): Match | undefined {
  let pool = candidates(ctx, exclude);
  if (pool.length === 0) pool = candidates(ctx);
  if (pool.length === 0) return undefined;
  let best: Match | undefined;
  let bestKey = -Infinity;
  for (const p of pool) {
    const score = relevance(text, p);
    if (score <= 0) continue;
    const key = score * 10 + (p.roles.includes(role) ? 2 : 0) + p.weight * 0.01;
    if (key > bestKey || (key === bestKey && best && p.id < best.piece.id)) { best = { piece: p, score }; bestKey = key; }
  }
  if (best) return best;
  return { piece: fallbackLandmark(text, ctx, role, exclude)!, score: 0 };
}

/** A piece for a role when nothing is asked for: heavy pieces first for a boss, otherwise a hash of `salt` among those that fit the role. */
export function fallbackLandmark(salt: string, ctx: MatchContext, role: LandmarkRole, exclude: ReadonlySet<string> = new Set()): LandmarkPiece | undefined {
  let pool = candidates(ctx, exclude);
  if (pool.length === 0) pool = candidates(ctx);
  if (pool.length === 0) return undefined;
  const fit = pool.filter((p) => p.roles.includes(role));
  let list = fit.length > 0 ? fit : pool;
  if (role === "boss") {
    const top = Math.max(...list.map((p) => p.weight));
    list = list.filter((p) => p.weight >= top - 1);
  }
  list = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  return list[textHash(salt) % list.length];
}

// ---------- landmarks on a finished map ----------

export interface Landmark {
  /** The map object id (`lm_1`, ...). */
  id: string;
  /** Set piece id. */
  piece: string;
  /** Player-facing name, for example "Ferry dock". */
  name: string;
  description: string;
  /** The landmark's reference tile (a walkable tile in the middle of it). */
  x: number;
  y: number;
  /** Tiles around the reference tile that count as being at the landmark (1 to 3). */
  radius: number;
  weight: number;
  roles: LandmarkRole[];
  keywords: string[];
  /** Absolute tiles: where a person stands, where a fight forms up, where an item rests, where a sign stands. */
  anchors: Anchors;
}

export const LANDMARK_PREFIX = "lm:";

/** The `on_enter` text of a landmark's trigger object: `lm:<piece id>:<orientation>`. */
export const landmarkEvent = (piece: string, t: number): string => `${LANDMARK_PREFIX}${piece}:${t}`;

export function landmarkRadius(o: Oriented): number {
  return Math.max(1, Math.min(3, Math.ceil(Math.max(o.w, o.h) / 2)));
}

/**
 * The landmarks of a map, in object order. Each is a `trigger` object whose `on_enter` is `lm:<piece id>:<orientation>`
 * and whose position is the landmark's reference tile; the pattern and orientation give the rest, so a map carries
 * nothing new. Maps without landmarks (older saves, DM-made maps) give an empty list.
 */
export function mapLandmarks(map: GameMap): Landmark[] {
  const out: Landmark[] = [];
  for (const o of getObjects(map)) {
    if (o.type !== "trigger" || !o.on_enter.startsWith(LANDMARK_PREFIX)) continue;
    const [id, tt] = o.on_enter.slice(LANDMARK_PREFIX.length).split(":");
    const piece = id ? BY_ID.get(id) : undefined;
    const t = Number(tt);
    if (!piece || !Number.isInteger(t) || t < 0 || t >= ORIENTATIONS) continue;
    const ori = orient(piece, t);
    const ox = o.x - ori.center.x;
    const oy = o.y - ori.center.y;
    const abs = (list: Pt[]): Pt[] => list.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    out.push({
      id: o.id, piece: piece.id, name: piece.name, description: piece.description, x: o.x, y: o.y, radius: o.radius,
      weight: piece.weight, roles: piece.roles, keywords: pieceWords(piece),
      anchors: { stand: abs(ori.anchors.stand), fight: abs(ori.anchors.fight), item: abs(ori.anchors.item), sign: abs(ori.anchors.sign) },
    });
  }
  return out;
}

/** The landmark whose reference tile is nearest (Chebyshev) to a tile, within its own radius plus `slack` tiles. */
export function landmarkAt(map: GameMap, x: number, y: number, slack = 1): Landmark | undefined {
  let best: Landmark | undefined;
  let bestD = Infinity;
  for (const l of mapLandmarks(map)) {
    const d = Math.max(Math.abs(l.x - x), Math.abs(l.y - y));
    if (d <= l.radius + slack && d < bestD) { best = l; bestD = d; }
  }
  return best;
}

/** How well a landmark fits free text (a cast member's concept, an encounter's name): keyword relevance plus a small role fit. */
export function landmarkFit(l: Landmark, text: string, role: LandmarkRole): number {
  const toks = words(text);
  let score = 0;
  for (const t of toks) {
    if (l.keywords.includes(t)) score += 3;
    else if (t.length >= 4 && l.keywords.some((k) => k.length >= 4 && (k.startsWith(t) || t.startsWith(k)))) score += 1.5;
  }
  return score + (l.roles.includes(role) ? 1 : 0);
}
