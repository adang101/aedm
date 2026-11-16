import { describe, expect, it } from "vitest";
import { RouteViewSchema, type StoryBible } from "@aedm/schemas";
import { routeView } from "./route-view.ts";
import type { GameState } from "./state.ts";
import { BIBLE, CAMPAIGN_BIBLE, makeWorld, withState } from "./testkit.ts";

/** The testkit plan is a chain: square - dock - marsh - crypt - lair. */
function at(visited: string[], here: string | null, bible: StoryBible = CAMPAIGN_BIBLE): GameState {
  const base = makeWorld(7, { bible }).state;
  return withState(base, (s) => {
    const locations: Record<string, string> = {};
    for (const id of visited) locations[id] = `m_${id}`;
    s.campaign = { locations, cast: {}, encounters: {}, items: {}, visited, talked: [] };
    s.currentMapId = here ? `m_${here}` : "m_elsewhere";
  });
}
const names = (s: GameState) => routeView(s)!.nodes.map((n) => `${n.name}:${n.state}`);

describe("routeView: what is revealed", () => {
  it("is null for a bible without a plan, and for a plan the party has not entered", () => {
    expect(routeView(makeWorld(7, { bible: BIBLE }).state)).toBeNull();
    expect(routeView(withState(makeWorld(7, { bible: CAMPAIGN_BIBLE }).state, (s) => { delete s.campaign; }))).toBeNull();
  });
  it("at the start shows the first place as current and its neighbour as known, nothing else", () => {
    const v = routeView(at(["l_square"], "l_square"))!;
    expect(RouteViewSchema.safeParse(v).success).toBe(true);
    expect(names(at(["l_square"], "l_square"))).toEqual(["Hollowmere Square:current", "The Rotting Dock:known"]);
    expect(v.edges).toHaveLength(1);
    expect(v.current).toBe(v.nodes[0]!.id);
  });
  it("after travelling: visited, current and the neighbours of visited places; never places two steps from a visited one", () => {
    expect(names(at(["l_square", "l_dock"], "l_dock"))).toEqual([
      "Hollowmere Square:visited", "The Rotting Dock:current", "Lantern Marsh:known",
    ]);
    const back = names(at(["l_square", "l_dock"], "l_square"));
    expect(back).toEqual(["Hollowmere Square:current", "The Rotting Dock:visited", "Lantern Marsh:known"]);
  });
  it("never leaks plan ids, later names, or encounter and item detail", () => {
    const json = JSON.stringify(routeView(at(["l_square"], "l_square")));
    for (const secret of ["l_square", "l_dock", "Lantern Marsh", "Crypt", "Choir", "Sentries", "Lens", "Signet", "e_boss", "k_lens", "c_tam", "Old Tam"]) expect(json).not.toContain(secret);
  });
  it("shows a summary on visited places only", () => {
    const v = routeView(at(["l_square", "l_dock"], "l_dock"))!;
    expect(v.nodes.map((n) => n.summary !== undefined)).toEqual([true, true, false]);
    expect(v.nodes[0]!.summary).toBe("A fogbound village square.");
  });
  it("shows edges only where an end is visited, and only between shown nodes", () => {
    const v = routeView(at(["l_square", "l_dock"], "l_dock"))!;
    expect(v.edges).toHaveLength(2);
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) { expect(ids.has(e.a)).toBe(true); expect(ids.has(e.b)).toBe(true); }
  });
  it("counts the current place as visited even when the binding lists nothing as visited, and copes with an off-plan map", () => {
    const s = at([], "l_square");
    s.campaign!.locations = { l_square: "m_l_square" };
    expect(names(s)).toEqual(["Hollowmere Square:current", "The Rotting Dock:known"]);
    const off = routeView(at(["l_square"], null))!;
    expect(off.current).toBeNull();
    expect(off.nodes.map((n) => n.state)).toEqual(["visited", "known"]);
  });
  it("ignores visited ids the plan does not have", () => {
    expect(names(at(["l_square", "l_ghost"], "l_square"))).toEqual(["Hollowmere Square:current", "The Rotting Dock:known"]);
  });
});

describe("routeView: exits", () => {
  it("names the exit of the current map that leads to each neighbour of the current place", () => {
    const v = routeView(at(["l_square", "l_dock"], "l_dock"))!;
    const [sq, dock, marsh] = v.nodes;
    expect(sq!.exit).toEqual({ side: "west", label: "To Hollowmere Square" });
    expect(marsh!.exit).toEqual({ side: "east", label: "To Lantern Marsh" });
    expect(dock!.exit).toBeUndefined();
  });
  it("gives no exits when the party is off the plan", () => {
    expect(routeView(at(["l_square"], null))!.nodes.every((n) => n.exit === undefined)).toBe(true);
  });
});

describe("routeView: objective markers", () => {
  it("places open objectives of the current stage that the engine can place, at nodes the party knows", () => {
    const v = routeView(at(["l_square"], "l_square"))!;
    expect(v.markers).toEqual([{ milestone_id: "m1", node: v.nodes[0]!.id }]); // talk to Tam, who lives in the square
  });
  it("skips objectives at places the party does not know yet, story milestones and finished ones", () => {
    const s = at(["l_square"], "l_square");
    s.bible.milestones.find((m) => m.id === "m1")!.completed = true; // stage 2: find the lens at the dock (a neighbour)
    const v = routeView(s)!;
    expect(v.markers).toEqual([{ milestone_id: "m2", node: v.nodes.find((n) => n.name === "The Rotting Dock")!.id }]);
    s.bible.milestones.find((m) => m.id === "m2")!.completed = true; // stage 3: sentries at the marsh (unknown), plus a story milestone
    expect(routeView(s)!.markers).toEqual([]);
  });
});

describe("routeView: layout", () => {
  it("is layered left to right by connection depth, with integer positions", () => {
    const v = routeView(at(["l_square", "l_dock", "l_marsh", "l_crypt"], "l_marsh"))!;
    const xs = v.nodes.map((n) => n.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
    for (const n of v.nodes) { expect(Number.isInteger(n.x) && Number.isInteger(n.y)).toBe(true); expect(n.x).toBeGreaterThanOrEqual(0); expect(n.y).toBeGreaterThanOrEqual(0); }
  });
  it("never moves a node as more of the route is discovered, and is the same for the same state", () => {
    const early = routeView(at(["l_square"], "l_square"))!;
    const late = routeView(at(["l_square", "l_dock", "l_marsh"], "l_marsh"))!;
    for (const n of early.nodes) {
      const m = late.nodes.find((x) => x.name === n.name)!;
      expect([m.x, m.y]).toEqual([n.x, n.y]);
    }
    expect(routeView(at(["l_square"], "l_square"))).toEqual(early);
  });
  it("keeps node ids stable and opaque", () => {
    const a = routeView(at(["l_square"], "l_square"))!.nodes[0]!.id;
    const b = routeView(at(["l_square", "l_dock"], "l_dock"))!.nodes[0]!.id;
    expect(a).toBe(b);
    expect(a).not.toContain("square");
  });
  it("spreads a branching plan over rows within a layer, ties by stage then plan order", () => {
    const bible: StoryBible = {
      ...CAMPAIGN_BIBLE,
      locations: CAMPAIGN_BIBLE.locations!.map((l) =>
        l.id === "l_square" ? { ...l, connects_to: ["l_dock", "l_marsh"] } : l.id === "l_marsh" ? { ...l, connects_to: ["l_square", "l_dock", "l_crypt"] } : l),
    };
    const v = routeView(at(["l_square"], "l_square", bible))!;
    const dock = v.nodes.find((n) => n.name === "The Rotting Dock")!;
    const marsh = v.nodes.find((n) => n.name === "Lantern Marsh")!;
    expect(dock.x).toBe(marsh.x);
    expect(dock.y).toBeLessThan(marsh.y);
  });
});
