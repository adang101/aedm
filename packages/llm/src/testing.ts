import { LANTERN_MARSH_BIBLE, LANTERN_MARSH_FACTS } from "./default-bible";
import type { DmContextPack } from "./context";

/** Test/demo fixture: the Lantern Marsh at the start of the spike campaign. */
export function makeLanternPack(intents: { characterId: string; characterName: string; text: string }[] = []): DmContextPack {
  return {
    storyDigest: LANTERN_MARSH_BIBLE.digest,
    contentRating: "family",
    linesAndVeils: "No graphic gore.",
    summaries: [],
    facts: LANTERN_MARSH_FACTS,
    scene: {
      mapId: "m_hollowmere",
      setting: "Hollowmere town square",
      description: "Hollowmere's square at dusk, with the inn glowing at one end and the marsh path at the other.",
      entities: [
        { id: "ch_brindle", kind: "character", name: "Brindle Ash", x: 10, y: 10 },
        { id: "ch_tamsin", kind: "character", name: "Tamsin Quickfoot", x: 11, y: 10 },
        { id: "ch_orrin", kind: "character", name: "Orrin Vale", x: 10, y: 11 },
        { id: "npc_odalys", kind: "npc", name: "Odalys Brand", x: 14, y: 9, disposition: "friendly" },
      ],
      exits: [{ label: "Marsh path", side: "east" }],
    },
    party: [
      ["ch_brindle", "Brindle Ash", "demolitions expert", ["explosives", "crafting"]],
      ["ch_tamsin", "Tamsin Quickfoot", "courier and speedster", ["speed", "stealth"]],
      ["ch_orrin", "Orrin Vale", "marsh herbalist", ["medicine", "nature"]],
    ].map(([id, name, title, tags]) => ({
      id: id as string, name: name as string, title: title as string, level: 1, hp: 12, hpMax: 12,
      tags: tags as string[], abilities: [], inventory: [], playerName: `player_${id as string}`, present: true,
    })),
    quests: [{ id: "q_edda", title: "Find Edda Marrow", status: "active" }],
    milestones: [{ id: "m1", description: "The party learns the cult's name.", completed: false }],
    recentTurns: [],
    engineLines: [],
    intents,
    partyLevel: 1,
    lootRemaining: 30,
    growthRemaining: { ch_brindle: 50, ch_tamsin: 50, ch_orrin: 50 },
  };
}
