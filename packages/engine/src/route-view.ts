/**
 * The player-facing route view: the part of the campaign's geography the party knows (places visited, plus the places their
 * exits name), where the party is, which exit leads where, and where the open objectives are. Pure; reads the bible's plan and
 * the campaign binding. Later places never appear, and neither do plan ids, encounters, items or triggers.
 */
import type { PlanLocation, RouteEdge, RouteMarker, RouteNode, RouteView, StoryBible } from "@aedm/schemas";
import { campaignNeighbors, triggerOf } from "./campaign.ts";
import { locationExits } from "./campaign-map.ts";
import { CAMPAIGN } from "./data.ts";
import { currentStage } from "./plot.ts";
import { hashSeed } from "./rng.ts";
import { campaignOf, type GameState } from "./state.ts";

/** Opaque node ids: stable for a game (seed and plan id), and never the plan's own id. */
function nodeIds(seed: number, locs: readonly PlanLocation[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const l of locs) {
    let id = `r_${hashSeed(seed, l.id).toString(36)}`;
    for (let n = 2; used.has(id); n++) id = `r_${hashSeed(seed, l.id, n).toString(36)}`;
    used.add(id);
    out.set(l.id, id);
  }
  return out;
}

/**
 * Positions for the whole plan (not just what is known, so a node never moves when more is discovered): the column is the
 * connection depth from the first location (the plan's own order and stage order make that the story's direction), and inside a
 * column places are ordered by plot stage, then plan order, and centred on each other. Integers, from `CAMPAIGN.route`.
 */
export function routeLayout(bible: StoryBible): Map<string, { x: number; y: number }> {
  const locs = bible.locations ?? [];
  const out = new Map<string, { x: number; y: number }>();
  if (locs.length === 0) return out;
  const depth = new Map<string, number>([[locs[0]!.id, 0]]);
  const queue = [locs[0]!.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const n of campaignNeighbors(bible, id)) if (!depth.has(n)) { depth.set(n, depth.get(id)! + 1); queue.push(n); }
  }
  let deepest = Math.max(...depth.values());
  for (const l of locs) if (!depth.has(l.id)) depth.set(l.id, ++deepest); // unreachable (a plan that failed validation): one column each
  const stageIndex = (l: PlanLocation) => {
    const i = bible.plot?.stages.findIndex((s) => s.id === l.stage) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const order = new Map(locs.map((l, i) => [l.id, i]));
  const columns = new Map<number, PlanLocation[]>();
  for (const l of locs) columns.set(depth.get(l.id)!, [...(columns.get(depth.get(l.id)!) ?? []), l]);
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const { layerGap, rowGap } = CAMPAIGN.route;
  for (const [d, col] of columns) {
    col.sort((a, b) => stageIndex(a) - stageIndex(b) || order.get(a.id)! - order.get(b.id)!);
    col.forEach((l, row) => out.set(l.id, { x: d * layerGap, y: Math.round(((tallest - col.length) * rowGap) / 2) + row * rowGap }));
  }
  return out;
}

/** The plan location an open milestone is about, when the engine can tell (every machine trigger; never `story`). */
function milestonePlace(bible: StoryBible, m: StoryBible["milestones"][number]): string | undefined {
  const t = triggerOf(m);
  switch (t.type) {
    case "reach_location": return t.location;
    case "defeat_encounter": return bible.encounters?.find((e) => e.id === t.encounter)?.location;
    case "obtain_item": return bible.key_items?.find((k) => k.id === t.item)?.location;
    case "talk_to": return bible.cast?.find((c) => c.id === t.cast)?.location;
    case "story": return undefined;
  }
}

/**
 * What the party knows of the route: every place visited (the current one counts as visited), plus every place a visited one
 * connects to, shown by name only. Edges join shown places where at least one end is visited. Neighbours of the current place carry
 * the name of the exit that leads there. Markers sit on the shown places that hold an open objective of the current stage.
 * Null when the bible has no plan, or when the party has not entered any plan location (old saves). Nothing here depends on
 * anything the party has not seen.
 */
export function routeView(state: Pick<GameState, "bible" | "campaign" | "currentMapId" | "seed">): RouteView | null {
  const bible = state.bible;
  const locs = bible.locations ?? [];
  if (locs.length === 0) return null;
  const b = campaignOf(state as GameState);
  const known = new Set(locs.map((l) => l.id));
  const currentId = state.currentMapId ? Object.keys(b.locations).find((k) => b.locations[k] === state.currentMapId && known.has(k)) : undefined;
  const visited = new Set(b.visited.filter((id) => known.has(id)));
  if (currentId) visited.add(currentId);
  if (visited.size === 0) return null;

  const shown = new Set(visited);
  for (const id of visited) for (const n of campaignNeighbors(bible, id)) shown.add(n);

  const ids = nodeIds(state.seed, locs);
  const layout = routeLayout(bible);
  const exits = currentId ? locationExits(bible, currentId) : [];
  const nodes: RouteNode[] = locs.filter((l) => shown.has(l.id)).map((l) => {
    const pos = layout.get(l.id)!;
    const exit = exits.find((e) => e.to === l.id);
    const node: RouteNode = {
      id: ids.get(l.id)!,
      name: l.name,
      state: l.id === currentId ? "current" : visited.has(l.id) ? "visited" : "known",
      x: pos.x,
      y: pos.y,
    };
    if (visited.has(l.id)) node.summary = l.summary;
    if (exit) node.exit = { side: exit.side, label: exit.label };
    return node;
  });

  const edges: RouteEdge[] = [];
  const seen = new Set<string>();
  for (const l of locs) {
    if (!shown.has(l.id)) continue;
    for (const n of campaignNeighbors(bible, l.id)) {
      if (!shown.has(n) || (!visited.has(l.id) && !visited.has(n))) continue;
      const key = [l.id, n].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: ids.get(l.id)!, b: ids.get(n)! });
    }
  }

  const markers: RouteMarker[] = [];
  const cur = currentStage(bible);
  if (cur && !cur.finished) {
    for (const m of bible.milestones) {
      if (m.completed || m.stage !== cur.stage.id) continue;
      const place = milestonePlace(bible, m);
      if (place !== undefined && shown.has(place)) markers.push({ milestone_id: m.id, node: ids.get(place)! });
    }
  }
  return { nodes, edges, markers, current: currentId ? ids.get(currentId)! : null };
}
