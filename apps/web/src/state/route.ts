import type { GameMap, RouteNode, RouteView } from "@aedm/schemas";

/** Pure logic for the route panel: where to draw each place, how to word a label, and how to get from here to a place. */

export interface GeoNode { node: RouteNode; cx: number; cy: number; marked: boolean }
export interface GeoEdge { x1: number; y1: number; x2: number; y2: number; a: string; b: string }
export interface Geometry { width: number; height: number; nodes: GeoNode[]; edges: GeoEdge[] }

export interface GeometryOptions {
  /** Space around the outermost nodes (room for labels). */
  pad?: number;
  /** The drawing is never narrower or shorter than this (so one or two places are not blown up). */
  minWidth?: number;
  minHeight?: number;
}

/**
 * Turn the engine's layout units into drawing coordinates. Layout units are used 1:1 (so the picture is the same for every
 * client), moved so the top-left known node sits at the padding; the viewBox only grows as places are discovered. Edges whose
 * ends are not both shown are dropped.
 */
export function routeGeometry(view: RouteView, opts: GeometryOptions = {}): Geometry {
  const pad = opts.pad ?? 40;
  const minW = opts.minWidth ?? 0;
  const minH = opts.minHeight ?? 0;
  if (view.nodes.length === 0) return { width: Math.max(minW, pad * 2), height: Math.max(minH, pad * 2), nodes: [], edges: [] };
  const minX = Math.min(...view.nodes.map((n) => n.x));
  const minY = Math.min(...view.nodes.map((n) => n.y));
  const maxX = Math.max(...view.nodes.map((n) => n.x));
  const maxY = Math.max(...view.nodes.map((n) => n.y));
  const width = Math.max(minW, maxX - minX + pad * 2);
  const height = Math.max(minH, maxY - minY + pad * 2);
  // centre a drawing that is smaller than the minimum
  const offX = pad + (width - (maxX - minX + pad * 2)) / 2;
  const offY = pad + (height - (maxY - minY + pad * 2)) / 2;
  const marked = new Set(view.markers.map((m) => m.node));
  const nodes = view.nodes.map((node) => ({ node, cx: node.x - minX + offX, cy: node.y - minY + offY, marked: marked.has(node.id) }));
  const at = new Map(nodes.map((n) => [n.node.id, n]));
  const edges: GeoEdge[] = [];
  for (const e of view.edges) {
    const a = at.get(e.a);
    const b = at.get(e.b);
    if (a && b) edges.push({ x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy, a: e.a, b: e.b });
  }
  return { width, height, nodes, edges };
}

/** Split a place name into at most two short lines for a label; whatever does not fit ends in "...". */
export function wrapLabel(name: string, max = 16): string[] {
  const clip = (s: string) => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);
  const words = name.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!;
    if (next.length <= max || !cur) { cur = next; continue; }
    if (lines.length === 1) break;
    lines.push(cur);
    cur = words[i]!;
  }
  if (lines.length === 0 || i >= words.length) {
    lines.push(cur);
    return lines.map(clip);
  }
  // a second line that cannot take the rest
  const rest = [cur, ...words.slice(i)].join(" ");
  lines.push(rest);
  return [clip(lines[0]!), clip(rest)];
}

export interface RouteAdvice {
  text: string;
  /** The exit tile to walk to, when the current map has the exit (the client's ordinary click-to-move goes there). */
  walkTo?: { x: number; y: number };
}

/** The exits drawn on a map (objects of type exit), by lowercase name. */
export function mapExits(map: GameMap | null): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (!map) return out;
  for (const l of map.layers) {
    if (l.type !== "objectgroup") continue;
    for (const o of l.objects) if (o.type === "exit") out.set(o.name.trim().toLowerCase(), { x: o.x, y: o.y });
  }
  return out;
}

function stepAdvice(node: RouteNode, exits: Map<string, { x: number; y: number }>): RouteAdvice | null {
  if (!node.exit) return null;
  const text = `Take the ${node.exit.side} exit: ${node.exit.label}`;
  const at = exits.get(node.exit.label.trim().toLowerCase());
  return at ? { text, walkTo: { x: at.x, y: at.y } } : { text };
}

/**
 * How to get to a place, in the game's own terms: the exit of the current map that leads there, with its tile when the map has it.
 * A place further along is reached through the shown places between (the first step is given). Empty text for an unknown node.
 */
export function routeAdvice(view: RouteView, nodeId: string, map: GameMap | null): RouteAdvice {
  const target = view.nodes.find((n) => n.id === nodeId);
  if (!target) return { text: "" };
  if (view.current === nodeId) return { text: "You are here." };
  if (view.current === null) return { text: "The party is not on the route right now." };
  const exits = mapExits(map);
  const direct = stepAdvice(target, exits);
  if (direct) return direct;
  // breadth-first over the shown edges to find the first step
  const prev = new Map<string, string>([[view.current, ""]]);
  const queue = [view.current];
  while (queue.length > 0 && !prev.has(nodeId)) {
    const id = queue.shift()!;
    for (const e of view.edges) {
      const other = e.a === id ? e.b : e.b === id ? e.a : null;
      if (other !== null && !prev.has(other)) { prev.set(other, id); queue.push(other); }
    }
  }
  if (!prev.has(nodeId)) return { text: "No known way there yet." };
  let hop = nodeId;
  while (prev.get(hop) !== view.current) hop = prev.get(hop)!;
  const first = view.nodes.find((n) => n.id === hop);
  const step = first ? stepAdvice(first, exits) : null;
  if (!first || !step) return { text: "No known way there yet." };
  return { text: `Not next door. Go through ${first.name} first. ${step.text}`, ...(step.walkTo ? { walkTo: step.walkTo } : {}) };
}

/** Short word for a node's state, for labels and screen readers. */
export const stateLabel = (n: RouteNode): string => (n.state === "current" ? "you are here" : n.state === "visited" ? "visited" : "not visited");
