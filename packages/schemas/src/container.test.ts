import { describe, expect, it } from "vitest";
import { ContainerSchema, ContainerSummarySchema, ContainerViewPayload, InteractableViewSchema, MAX_CONTAINER_ITEMS } from "./container";

const item = { id: "it_1", name: "Healing draught", kind: "consumable", value: 25 };
const chest = { v: 1, id: "cn_1", kind: "chest", map_id: "m_start", x: 3, y: 4, items: [item], label: "Chest", locked: true, lock: { dc: 12 }, object_id: "chest_1" };

describe("Container", () => {
  it("parses a locked chest, a pile, remains and pockets", () => {
    expect(ContainerSchema.safeParse(chest).success).toBe(true);
    expect(ContainerSchema.safeParse({ v: 1, id: "cn_2", kind: "pile", map_id: "m_start", x: 1, y: 1, items: [] }).success).toBe(true);
    expect(ContainerSchema.safeParse({ v: 1, id: "cn_3", kind: "remains", map_id: "m_start", x: 1, y: 1, items: [item], owner_entity_id: "ei_4" }).success).toBe(true);
    expect(ContainerSchema.safeParse({ v: 1, id: "cn_4", kind: "pockets", map_id: "m_start", x: 1, y: 1, items: [item], owner_entity_id: "npc_2" }).success).toBe(true);
  });
  it("rejects a wrong version, an unknown kind, extra fields and too many items", () => {
    expect(ContainerSchema.safeParse({ ...chest, v: 2 }).success).toBe(false);
    expect(ContainerSchema.safeParse({ ...chest, kind: "sack" }).success).toBe(false);
    expect(ContainerSchema.safeParse({ ...chest, gold: 5 }).success).toBe(false);
    expect(ContainerSchema.safeParse({ ...chest, map_id: "start" }).success).toBe(false);
    const many = Array.from({ length: MAX_CONTAINER_ITEMS + 1 }, (_, i) => ({ ...item, id: `it_${i}` }));
    expect(ContainerSchema.safeParse({ ...chest, items: many }).success).toBe(false);
  });
});

describe("container views", () => {
  it("a summary never carries items", () => {
    const s = { id: "cn_1", kind: "chest", x: 3, y: 4, item_count: 1, locked: true, open: false };
    expect(ContainerSummarySchema.safeParse(s).success).toBe(true);
    expect(ContainerSummarySchema.safeParse({ ...s, items: [item] }).success).toBe(false);
    expect(ContainerSummarySchema.safeParse({ ...s, item_count: -1 }).success).toBe(false);
  });
  it("an interactable view is a map id, an object id and one of three states", () => {
    expect(InteractableViewSchema.safeParse({ map_id: "m_start", id: "door_1", state: "open" }).success).toBe(true);
    expect(InteractableViewSchema.safeParse({ map_id: "m_start", id: "door_1", state: "broken" }).success).toBe(false);
  });
  it("the opened view lists the items", () => {
    expect(ContainerViewPayload.safeParse({ container_id: "cn_1", kind: "chest", items: [item], locked: false }).success).toBe(true);
  });
});
