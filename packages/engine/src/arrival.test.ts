import { describe, expect, it } from "vitest";
import type { MapObject } from "@aedm/schemas";
import { placePartyOnMap } from "./state.ts";
import { arrivalPoint } from "./map/index.ts";
import { PARTY_IDS, makeWorld } from "./testkit.ts";

const exit = (name: string, x: number, y: number): MapObject => ({ type: "exit", name, to: "pending", target_entry: "party_start", x, y }) as unknown as MapObject;

describe("arriving by an exit", () => {
  it("resolves a spawn by name first, then an exit by name (any letter case), else nothing", () => {
    const { state } = makeWorld(7, { objects: [exit("To The Rotting Dock", 9, 5)] });
    const map = state.maps[state.currentMapId!]!;
    expect(arrivalPoint(map, "party_start")).toMatchObject({ kind: "spawn" });
    expect(arrivalPoint(map, "to the rotting dock")).toEqual({ kind: "exit", x: 9, y: 5 });
    expect(arrivalPoint(map, "nowhere")).toBeNull();
  });

  it("places the party beside the named exit, never on it, so nobody leaves again by standing still", () => {
    const { state } = makeWorld(7, { objects: [exit("To The Rotting Dock", 9, 5)] });
    const r = placePartyOnMap(state, state.currentMapId!, "To The Rotting Dock");
    expect(r.value).toBe(true);
    for (const id of PARTY_IDS) {
      const e = r.state.entities[id]!;
      expect(`${e.x},${e.y}`).not.toBe("9,5");
      expect(Math.max(Math.abs(e.x - 9), Math.abs(e.y - 5))).toBeLessThanOrEqual(3);
    }
  });

  it("still fails for a name that is neither a spawn nor an exit", () => {
    const { state } = makeWorld(7);
    expect(placePartyOnMap(state, state.currentMapId!, "nowhere").value).toBe(false);
  });
});
