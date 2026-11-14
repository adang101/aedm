import { ContainerSummarySchema, MapSchema, type CharacterView, type EntityView } from "@aedm/schemas";
import { describe, expect, it } from "vitest";
import { MockLoot, starterPack, type LootHost } from "./mock-loot";
import { blockedAt, buildScenes } from "./mock-world";

const sprite = { kind: "shape", shape: "circle", color: "#4f8a3c", accent: "#f6e8a0", glyph: "A" } as const;

function setup(at = { x: 19, y: 12 }, roll = true) {
  const map = buildScenes().m_hollowmere!.map;
  const me = { id: "ch_me", kind: "pc", name: "Me", ...at, hp: 5, hp_max: 5, conditions: [], sprite } as EntityView;
  const mine = { id: "ch_me", name: "Me", inventory: starterPack() } as CharacterView;
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const host: LootHost = {
    map: () => map, me: () => me, mine: () => mine, party: () => [mine], entities: () => ({ ch_me: me }),
    emit: (type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }),
    fail: (_c, m) => errors.push(m),
    engine: () => {},
    diff: (extra) => sent.push({ type: "state_diff", payload: extra }),
    snapshot: () => sent.push({ type: "state_snapshot", payload: {} }),
    roll: () => roll,
  };
  const loot = new MockLoot(host);
  const state = (id: string) => {
    for (const l of map.layers) if (l.type === "objectgroup") for (const o of l.objects) if (o.type === "interactable" && o.id === id) return o.state;
    return undefined;
  };
  return { loot, me, mine, sent, errors, map, state };
}

describe("mock world", () => {
  it("still parses as a v2 map with a locked door, a lever, a sign and a chest", () => {
    const map = buildScenes().m_hollowmere!.map;
    expect(MapSchema.safeParse(map).success).toBe(true);
    const kinds = map.layers.flatMap((l) => (l.type === "objectgroup" ? l.objects : [])).flatMap((o) => (o.type === "interactable" ? [`${o.kind}:${o.state}`] : []));
    expect(kinds).toEqual(expect.arrayContaining(["door:locked", "lever:closed", "sign:closed", "chest:locked", "chest:closed"]));
  });

  it("summaries are valid and include the chests and the pile", () => {
    const { loot } = setup();
    const s = loot.summaries();
    for (const c of s) expect(ContainerSummarySchema.safeParse(c).success).toBe(true);
    expect(s.filter((c) => c.kind === "chest")).toHaveLength(3);
    expect(s.filter((c) => c.kind === "pile")).toHaveLength(1);
  });

  it("a closed door blocks movement until it is open", () => {
    const { map, state } = setup();
    expect(state("door_tower")).toBe("locked");
    expect(blockedAt(map, 25, 5)).toBe(true);
    expect(blockedAt(map, 5, 7)).toBe(false); // the inn door stands open
  });
});

describe("mock containers", () => {
  it("opens a chest, sends its contents, then takes an item into the pack", () => {
    const { loot, sent, mine, state } = setup({ x: 16, y: 13 });
    loot.act("open", "chest_stall", "a1");
    expect(state("chest_stall")).toBe("open");
    const view = sent.find((m) => m.type === "container_view")!.payload as { items: { id: string }[]; locked: boolean };
    expect(view.locked).toBe(false);
    expect(view.items).toHaveLength(2);
    loot.containerAction("take", "cn_2", view.items[0]!.id, "a2");
    expect(mine.inventory!.some((i) => i.id === view.items[0]!.id)).toBe(true);
    const after = sent.filter((m) => m.type === "container_view").pop()!.payload as { items: unknown[] };
    expect(after.items).toHaveLength(1);
  });

  it("shows a locked chest as locked with no items, and picking the lock unlocks it", () => {
    const { loot, sent, state } = setup({ x: 19, y: 12 });
    loot.act("open", "chest_plaza", "a1");
    expect(sent.find((m) => m.type === "container_view")!.payload).toMatchObject({ locked: true, items: [] });
    loot.act("pick_lock", "chest_plaza", "a2");
    expect(state("chest_plaza")).toBe("closed");
  });

  it("refuses to act from too far away", () => {
    const { loot, errors, state } = setup({ x: 10, y: 8 });
    loot.act("pick_lock", "chest_plaza", "a1");
    expect(errors).toEqual(["You are too far away."]);
    expect(state("chest_plaza")).toBe("locked");
  });

  it("the lever unlocks and opens the tower door", () => {
    const { loot, sent, state } = setup({ x: 21, y: 7 });
    loot.act("pull", "lever_tower", "a1");
    expect(state("lever_tower")).toBe("open");
    expect(state("door_tower")).toBe("open");
    expect(sent.some((m) => m.type === "state_diff" && Array.isArray(m.payload.interactables_changed))).toBe(true);
  });

  it("drop makes a pile on my tile; weapons and armor stay bound", () => {
    const { loot, mine, errors, loot: l2, sent } = setup({ x: 14, y: 12 });
    const potion = mine.inventory!.find((i) => i.kind === "consumable")!;
    const sword = mine.inventory!.find((i) => i.kind === "weapon")!;
    loot.inventoryAction("drop", sword.id, undefined, "a1");
    expect(errors[0]).toMatch(/bound/);
    loot.inventoryAction("drop", potion.id, undefined, "a2");
    expect(mine.inventory!.some((i) => i.id === potion.id)).toBe(false);
    expect(l2.summaries().some((c) => c.kind === "pile" && c.x === 14 && c.y === 12)).toBe(true);
    expect(sent.some((m) => m.type === "state_diff" && Array.isArray(m.payload.containers_changed))).toBe(true);
  });
});
