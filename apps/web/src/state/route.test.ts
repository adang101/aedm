import type { GameMap, RouteView } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { applyServerMessage, createInitialState, resetRoom } from "./store";
import { routeAdvice, routeGeometry, wrapLabel } from "./route";
import { mockRouteView } from "../net/mock-route";

type Side = "east" | "west" | "north" | "south";
const node = (id: string, name: string, state: "current" | "visited" | "known", x: number, y: number, exit?: { side: Side; label: string }) =>
  ({ id, name, state, x, y, ...(exit ? { exit } : {}) });
const view: RouteView = {
  nodes: [
    node("a", "Square", "visited", 0, 0, { side: "west", label: "To Square" }),
    node("b", "Dock", "current", 120, 0),
    node("c", "Marsh", "known", 240, 0, { side: "east", label: "To Marsh" }),
  ],
  edges: [{ a: "a", b: "b" }, { a: "b", b: "c" }],
  markers: [{ milestone_id: "m1", node: "c" }],
  current: "b",
};
const mapWith = (...exits: { name: string; x: number; y: number }[]) =>
  ({ layers: [{ type: "objectgroup", name: "objects", objects: exits.map((e) => ({ type: "exit", target_entry: "party_start", to: "m_x", ...e })) }] }) as unknown as GameMap;

describe("routeGeometry", () => {
  it("fits every node inside the box with padding, and keeps relative positions", () => {
    const g = routeGeometry(view, { pad: 30, minWidth: 100 });
    expect(g.width).toBe(240 + 60);
    const [a, b, c] = g.nodes;
    expect(a!.cx).toBe(30);
    expect(c!.cx).toBe(270);
    expect(b!.cx - a!.cx).toBe(120);
    for (const n of g.nodes) { expect(n.cx).toBeGreaterThanOrEqual(0); expect(n.cy).toBeLessThanOrEqual(g.height); }
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0]).toMatchObject({ x1: a!.cx, y1: a!.cy, x2: b!.cx, y2: b!.cy });
  });
  it("copes with one node, and drops edges to missing nodes", () => {
    const one = routeGeometry({ ...view, nodes: [view.nodes[1]!], edges: [{ a: "a", b: "b" }], markers: [] }, { pad: 30, minWidth: 200 });
    expect(one.nodes).toHaveLength(1);
    expect(one.edges).toHaveLength(0);
    expect(one.width).toBeGreaterThanOrEqual(200);
  });
  it("flags nodes that hold an open objective", () => {
    expect(routeGeometry(view).nodes.map((n) => n.marked)).toEqual([false, false, true]);
  });
});

describe("wrapLabel", () => {
  it("splits at words into at most two lines and truncates the rest", () => {
    expect(wrapLabel("Dock")).toEqual(["Dock"]);
    expect(wrapLabel("The Rotting Dock Of Doom")).toEqual(["The Rotting Dock", "Of Doom"]);
    const long = wrapLabel("A very long name indeed that keeps going and going on");
    expect(long).toHaveLength(2);
    expect(long[1]!.endsWith("...")).toBe(true);
    expect(wrapLabel("Supercalifragilisticexpialidocious")[0]!.length).toBeLessThanOrEqual(16);
  });
});

describe("routeAdvice", () => {
  const map = mapWith({ name: "To Marsh", x: 40, y: 7 }, { name: "to square", x: 0, y: 9 });
  it("says you are here for the current place", () => {
    expect(routeAdvice(view, "b", map)).toEqual({ text: "You are here." });
  });
  it("names the exit and offers to walk to it", () => {
    expect(routeAdvice(view, "c", map)).toEqual({ text: "Take the east exit: To Marsh", walkTo: { x: 40, y: 7 } });
    expect(routeAdvice(view, "a", map)).toEqual({ text: "Take the west exit: To Square", walkTo: { x: 0, y: 9 } });
  });
  it("still says which exit when the map does not have it, with no action", () => {
    expect(routeAdvice(view, "c", mapWith())).toEqual({ text: "Take the east exit: To Marsh" });
    expect(routeAdvice(view, "c", null)).toEqual({ text: "Take the east exit: To Marsh" });
  });
  it("routes via the first step for a place further away", () => {
    const far: RouteView = {
      nodes: [
        node("a", "Square", "current", 0, 0),
        node("b", "Dock", "visited", 120, 0, { side: "east", label: "To Dock" }),
        node("c", "Marsh", "known", 240, 0),
      ],
      edges: [{ a: "a", b: "b" }, { a: "b", b: "c" }],
      markers: [],
      current: "a",
    };
    const adv = routeAdvice(far, "c", mapWith({ name: "To Dock", x: 5, y: 5 }));
    expect(adv.text).toBe("Not next door. Go through Dock first. Take the east exit: To Dock");
    expect(adv.walkTo).toEqual({ x: 5, y: 5 });
  });
  it("says so when there is no way to tell, or no current place", () => {
    expect(routeAdvice({ ...view, current: null }, "c", map).text).toMatch(/not on the route/i);
    expect(routeAdvice(view, "zzz", map).text).toBe("");
  });
});

describe("store", () => {
  it("keeps the route from route_update and clears it on a reset", () => {
    const s = createInitialState();
    expect(s.route).toBeNull();
    applyServerMessage(s, { v: 9, type: "route_update", id: "s1", ts: 0, payload: view } as never, 0);
    expect(s.route).toEqual(view);
    resetRoom(s);
    expect(s.route).toBeNull();
  });
});

describe("mock route", () => {
  it("is a valid three-place route that grows with travel", () => {
    expect(mockRouteView("m_hollowmere", ["m_hollowmere"], []).nodes.length).toBeGreaterThanOrEqual(3);
    const r = mockRouteView("m_crypt", ["m_hollowmere", "m_crypt"], ["m_odalys"]);
    expect(r.nodes.find((n) => n.state === "current")!.name).toBe("Drowned Crypt");
    expect(r.current).toBe(r.nodes.find((n) => n.state === "current")!.id);
  });
});
