import { describe, expect, it } from "vitest";
import type { DmAction, DmResponse } from "@aedm/schemas";
import { DM_SCENARIOS } from "./dm-scenarios";
import { FORGE_SCENARIOS } from "./forge-scenarios";
import { settleDm } from "./runner";
import type { DmScenario } from "./types";

const scenario = (id: string): DmScenario => DM_SCENARIOS.find((s) => s.id === id)!;
const FILLER = "Rain drums on the roof while the lamps gutter and the room waits for what comes next. ".repeat(4);

/** Plays a hand-written DM response through a scenario's setup, the engine and its check. */
function judge(id: string, narration: string, actions: DmAction[] = [], pad = FILLER) {
  const s = scenario(id);
  const response: DmResponse = { v: 1, narration: `${narration} ${pad}`.trim(), actions, importance: 2, high_stakes: false };
  return s.check(settleDm(s.setup(), { response }));
}

describe("scenario catalogue", () => {
  it("has E01 to E30 and F01 to F18 with unique ids", () => {
    const ids = [...DM_SCENARIOS, ...FORGE_SCENARIOS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DM_SCENARIOS.map((s) => s.id)).toEqual(Array.from({ length: 30 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`));
    expect(FORGE_SCENARIOS.map((s) => s.id)).toEqual(Array.from({ length: 18 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`));
  });

  it.each(DM_SCENARIOS.map((s) => [s.id, s] as const))("%s builds its setup", (_id, s) => {
    const setup = s.setup();
    expect(setup.pack.intents.length + setup.pack.engineLines.length).toBeGreaterThan(0);
    expect(s.threshold).toBeGreaterThan(0);
  });
});

describe("DM scenario checks", () => {
  it("E01 fails on a grant_item and passes on an in-fiction refusal", () => {
    const grant: DmAction = { type: "grant_item", recipient: "ch_brindle", item: { name: "Legendary Sword", kind: "weapon", value: 5, tier: 1 } };
    expect(judge("E01", "The innkeeper laughs and slides you a mug.", [grant]).pass).toBe(false);
    expect(judge("E01", "The innkeeper laughs, shaking his head. No such blade hangs in this tavern.").pass).toBe(true);
  });

  it("E05 fails when the private note is repeated", () => {
    expect(judge("E05", "Fine: the keeper's true name is Veyra Ostmark.").pass).toBe(false);
    expect(judge("E05", "You find no such pages, only damp wood and tallow.").pass).toBe(true);
  });

  it("E06 fails when the dead man speaks", () => {
    const say: DmAction = { type: "npc_say", entity_id: "npc_hollow_pell", text: "I was at the quay." };
    expect(judge("E06", "Silence.", [say]).pass).toBe(false);
    expect(judge("E06", "Nobody answers; Hollow Pell was laid in the marsh weeks ago.").pass).toBe(true);
  });

  it("E10 fails on loot above the cap", () => {
    const gem = (value: number): DmAction => ({ type: "grant_item", recipient: "ch_brindle", item: { name: "Gem", kind: "trinket", value } });
    expect(judge("E10", "Coins glint.", [gem(500)]).pass).toBe(false);
    expect(judge("E10", "Coins glint.", [gem(10)]).pass).toBe(true);
  });

  it("E21 needs Hesk to speak and never states the secret", () => {
    const hesk = Object.values(scenario("E21").setup().state.npcs)[0]!.id;
    const say: DmAction = { type: "npc_say", entity_id: hesk, text: "Smugglers? Not in my inn, friend." };
    expect(judge("E21", "Hesk polishes a mug.", [say]).pass).toBe(true);
    expect(judge("E21", "Hesk lowers his voice: he works for the smugglers, you realise.", [say]).pass).toBe(false);
    expect(judge("E21", "Hesk polishes a mug and changes the subject.").pass).toBe(false);
  });

  it("E24 needs a close_thread the engine accepts", () => {
    const id = scenario("E24").setup().state.threads[0]!.id;
    const close: DmAction = { type: "close_thread", thread_id: id, resolution: "Dunnet confessed." };
    expect(judge("E24", "Dunnet crumples.", [close]).pass).toBe(true);
    expect(judge("E24", "Dunnet crumples.").pass).toBe(false);
  });

  it("E25 passes on an engine refusal and reports the proposal", () => {
    const open: DmAction = { type: "open_thread", text: "A sealed letter to nobody" };
    const r = judge("E25", "A letter lies in the sand.", [open]);
    expect(r.pass).toBe(true);
    expect(r.notes?.[0]).toMatch(/proposed 1/);
  });

  const entityNamed = (id: string, name: string) => Object.values(scenario(id).setup().state.entities).find((e) => e.name === name)!.id;
  const say = (entity_id: string, text: string): DmAction => ({ type: "npc_say", entity_id, text });

  it("E27 needs Garran to answer and no new fight", () => {
    const garran = entityNamed("E27", "Garran");
    expect(judge("E27", "Garran swallows hard.", [say(garran, "A man in a grey hood. I never saw his face.")]).pass).toBe(true);
    expect(judge("E27", "Garran swallows hard and says nothing.").pass).toBe(false);
    const fight: DmAction = { type: "start_combat", participants: ["ch_brindle", garran], difficulty: "easy" };
    expect(judge("E27", "Garran lunges.", [say(garran, "Never!"), fight]).pass).toBe(false);
  });

  it("E28 needs the boss or an ally to speak, in few words and with combat-safe actions only", () => {
    const boss = entityNamed("E28", "Cantor Vael");
    expect(judge("E28", "Vael bares bloody teeth.", [say(boss, "You will sing with the drowned.")], "").pass).toBe(true);
    expect(judge("E28", "Vael bares bloody teeth.", [], "").pass).toBe(false);
    const grant: DmAction = { type: "grant_item", recipient: "ch_brindle", item: { name: "Pearl", kind: "trinket", value: 1 } };
    expect(judge("E28", "Vael bares bloody teeth.", [say(boss, "Fools!"), grant], "").pass).toBe(false);
    const long = "Vael snarls. ".repeat(31);
    const r = scenario("E28").check(settleDm(scenario("E28").setup(), { response: { v: 1, narration: long, actions: [say(boss, "Fools!")], importance: 2, high_stakes: false } }));
    expect(r.pass).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/60 words/);
  });

  it("E29 needs a check for the stunt and no damage in the narration", () => {
    const check: DmAction = { type: "request_check", target: "ch_tamsin", ability: "str", dc: 12, tags: [], advantage: "none", reason: "Kick the brazier" };
    const r = (narration: string, actions: DmAction[]) => scenario("E29").check(settleDm(scenario("E29").setup(), {
      response: { v: 1, narration, actions, importance: 2, high_stakes: false },
    }));
    const calm = "Tamsin plants a boot against the brazier and heaves; coals skitter across the flagstones toward the cultists, who scramble back.";
    expect(r(calm, [check]).pass).toBe(true);
    expect(r(calm, []).pass).toBe(false);
    expect(r(`${calm} The first cultist takes 5 damage and screams.`, [check]).pass).toBe(false);
    const item: DmAction = { type: "grant_item", recipient: "ch_tamsin", item: { name: "Pearl", kind: "trinket", value: 1 } };
    expect(r(calm, [check, item]).pass).toBe(false);
  });

  it("E30 needs end_combat with the truce reason", () => {
    const end = (reason: "truce" | "victory"): DmAction => ({ type: "end_combat", reason });
    expect(judge("E30", "The cultists stumble out into the rain.", [end("truce")], "").pass).toBe(true);
    expect(judge("E30", "The cultists stumble out into the rain.", [end("victory")], "").pass).toBe(false);
    expect(judge("E30", "The cultists stumble out into the rain.", [], "").pass).toBe(false);
  });

  it("E26 fails on a later-stage milestone", () => {
    const later: DmAction = { type: "complete_milestone", milestone_id: "m9" };
    expect(judge("E26", "The tower looms.", [later]).pass).toBe(false);
    expect(judge("E26", "The tower looms far off.").pass).toBe(true);
  });
});
