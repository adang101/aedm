import type { MapObject } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { labelsToShow, poiLabel, prettyName } from "./poi-labels";

const objs: MapObject[] = [
  { type: "exit", name: "stairs_up", to: "m_a", target_entry: "x", x: 2, y: 17 },
  { type: "interactable", id: "d1", kind: "door", state: "locked", x: 10, y: 10 },
  { type: "interactable", id: "c1", kind: "chest", state: "open", x: 11, y: 10 },
  { type: "interactable", id: "h1", kind: "trap", state: "closed", x: 12, y: 10, hidden: true },
  { type: "spawn", name: "party_start", x: 1, y: 1 },
];

describe("point of interest labels", () => {
  it("names exits and things from their kind and state", () => {
    expect(prettyName("stairs_up")).toBe("Stairs up");
    expect(poiLabel(objs[0]!)?.text).toBe("Exit: Stairs up");
    expect(poiLabel(objs[1]!)?.text).toBe("Door (locked)");
    expect(poiLabel(objs[2]!)?.text).toBe("Chest (open)");
  });

  it("never labels hidden objects or spawns", () => {
    expect(poiLabel(objs[3]!)).toBeNull();
    expect(poiLabel(objs[4]!)).toBeNull();
  });

  it("shows labels near the party or under the pointer only", () => {
    expect(labelsToShow(objs, null, [{ x: 30, y: 30 }])).toEqual([]);
    expect(labelsToShow(objs, null, [{ x: 12, y: 11 }]).map((l) => l.id)).toEqual(["d1", "c1"]);
    expect(labelsToShow(objs, { x: 2, y: 17 }, []).map((l) => l.text)).toEqual(["Exit: Stairs up"]);
  });
});
