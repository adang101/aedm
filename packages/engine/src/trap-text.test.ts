import { describe, expect, it } from "vitest";
import { trapBlockedText, trapEventText } from "./traps.ts";
import { searchedText } from "./search.ts";

describe("trap table text comes from data", () => {
  it("each trap event has a line with the character's name and no coordinates, ids or roll numbers", () => {
    const base = { mapId: "m", objectId: "trap_1", x: 4, y: 7 };
    const lines = [
      trapEventText({ type: "spotted", ...base, by: "c1", byName: "Brindle", kind: "trap" }),
      trapEventText({ type: "trap_sprung", ...base, victim: "c1", victimName: "Brindle", amount: 6, saved: false }),
      trapEventText({ type: "trap_sprung", ...base, victim: "c1", victimName: "Brindle", amount: 3, saved: true }),
      trapEventText({ type: "trap_disarmed", ...base, by: "c1", byName: "Brindle" }),
      trapEventText({ type: "disarm_failed", ...base, by: "c1", byName: "Brindle" }),
    ];
    for (const l of lines) {
      expect(l).toContain("Brindle");
      expect(l).not.toMatch(/trap_1|\(4,7\)|\b4,7\b/);
    }
    expect(new Set(lines).size).toBe(5);
    expect(trapBlockedText().length).toBeGreaterThan(10);
  });
  it("a search that found nothing reads the same with or without a roll", () => {
    const a = searchedText({ type: "searched", mapId: "m", by: "c1", byName: "Brindle", total: 3, found: [] });
    const b = searchedText({ type: "searched", mapId: "m", by: "c1", byName: "Brindle", found: [], nothingNew: true });
    expect(a).toBe(b);
  });
});
