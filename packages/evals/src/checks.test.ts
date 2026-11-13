import { describe, expect, it } from "vitest";
import type { DmResponse } from "@aedm/schemas";
import { depictsSpeaking, hasAction, narrationWords, noSourceLeak, noTextLeak, ofType, verdict, visibleText, voicesNpc } from "./checks";

const response = (over: Partial<DmResponse> = {}): DmResponse => ({ v: 1, narration: "The fog thickens.", actions: [], importance: 2, high_stakes: false, ...over });

describe("check helpers", () => {
  it("finds actions by type", () => {
    const actions = [{ type: "npc_say" as const, entity_id: "npc_1", text: "Hello there" }];
    expect(hasAction(actions, "npc_say")).toBe(true);
    expect(hasAction(actions, "grant_item")).toBe(false);
    expect(ofType(actions, "npc_say")[0]?.text).toBe("Hello there");
  });

  it("counts narration words", () => {
    expect(narrationWords("  one two\nthree  ")).toBe(3);
    expect(narrationWords("")).toBe(0);
  });

  it("collects what players read, never dm_notes", () => {
    const r = response({ dm_notes: "secret", actions: [{ type: "npc_say", entity_id: "npc_1", text: "Spoken line" }, { type: "suggest_actions", chips: ["Open door", "Wait"] }] });
    const text = visibleText(r);
    expect(text).toContain("The fog thickens.");
    expect(text).toContain("Spoken line");
    expect(text).toContain("Open door");
    expect(text).not.toContain("secret");
  });

  it("detects a leaked needle", () => {
    expect(noTextLeak("The Ostmark name", /ostmark/i)).toMatch(/ostmark/i);
    expect(noTextLeak("nothing here", "ostmark")).toBeUndefined();
  });

  it("detects a copied run of source words", () => {
    const source = "You never roll dice or change numbers. The engine rolls dice.";
    expect(noSourceLeak("As told: you never roll dice or change numbers, friend", source, 6)).toBeDefined();
    expect(noSourceLeak("The bell rings over the marsh", source, 6)).toBeUndefined();
  });

  it("recognises an NPC being voiced", () => {
    expect(voicesNpc([{ type: "npc_say", entity_id: "npc_hollow_pell", text: "Hm." }], "Hollow Pell")).toBe(true);
    expect(voicesNpc([{ type: "npc_say", entity_id: "npc_7", text: "Hm." }], "Hollow Pell")).toBe(false);
    expect(depictsSpeaking("Mira smiles and nods.", "Mira")).toBe(true);
    expect(depictsSpeaking("Nobody answers when you call for Mira.", "Mira")).toBe(false);
  });

  it("folds checks into a verdict", () => {
    expect(verdict([undefined, undefined])).toEqual({ pass: true, reasons: [] });
    expect(verdict([undefined, "bad"], ["n"])).toEqual({ pass: false, reasons: ["bad"], notes: ["n"] });
  });
});
