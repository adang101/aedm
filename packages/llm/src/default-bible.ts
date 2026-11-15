import type { Milestone, PlotArc, PlotPattern, StoryBible } from "@aedm/schemas";
import { buildPlot } from "@aedm/engine";

/**
 * One milestone per stage, by position (every plot pattern has five stages). `hint` is what players see; `trigger` is what
 * the engine tracks. The ids point into the hand-written plan below.
 */
const LANTERN_MARSH_MILESTONES: Pick<Milestone, "description" | "hint" | "trigger">[] = [
  {
    description: "The party learns the cult's name: the Quiet Choir.",
    hint: "Ask Odalys Brand what the sleepwalkers are walking toward",
    trigger: { type: "talk_to", cast: "c_odalys" },
  },
  {
    description: "The party finds out what became of Edda Marrow.",
    hint: "Search Marrow Light for Edda's logbook",
    trigger: { type: "obtain_item", item: "k_logbook" },
  },
  {
    description: "The party reaches the place where the sleepers gather in the marsh.",
    hint: "Follow the sleepers out to the Sleepers' Causeway",
    trigger: { type: "reach_location", location: "l_causeway" },
  },
  {
    description: "The party survives the Choir's counterstroke and learns how the borrowed voices can be silenced.",
    hint: "Survive the Choir's ambush in the Drowned Chapel",
    trigger: { type: "defeat_encounter", encounter: "e_ambush" },
  },
  {
    description: "The party ends the Choir's hold on the marsh and the sleepers wake.",
    hint: "Silence Cantor Vael in the Choir's Hollow",
    trigger: { type: "defeat_encounter", encounter: "e_cantor" },
  },
];

/**
 * The Lantern Marsh, from docs/spike-kit.md, with a plot plan of the requested pattern and arc (default: overcoming the
 * monster, into the pit and out) and a hand-written campaign plan: five places in a chain (village, lighthouse, causeway,
 * drowned chapel, the Choir's hollow), three named people, four encounters building to the Choir's cantor, two key items
 * and an ending. The plan is tied to the plot by stage position, so it holds for any pattern. Passes `validateCampaign`.
 * Used when bible generation fails and by the fake provider.
 */
export function lanternMarshBible(pattern: PlotPattern = "overcoming_the_monster", arc: PlotArc = "fall_rise"): StoryBible {
  const plot = buildPlot(pattern, arc);
  const stage = (i: number): string => plot.stages[i]!.id;
  return {
    title: "The Lantern Marsh",
    digest:
      "The Lantern Marsh is a drowned coastal region where fog and tide hide old secrets. Eleven days ago the lighthouse keeper of Hollowmere, Edda Marrow, vanished. Villagers now walk toward the marsh in their sleep. A smuggling guild, the Tidewrights, wants the lighthouse cellar sealed. A cult called the Quiet Choir borrows the voices of the drowned and is gathering sleepers. Act 1 goal: learn what happened to Edda and why the sleepers walk. The party starts in Hollowmere's square at dusk.",
    tone: "Eerie, grounded, a little wry.",
    acts: [
      { title: "The Sleepers of Hollowmere", goal: "Learn what happened to Edda Marrow and why the villagers sleepwalk toward the marsh." },
      { title: "The Quiet Choir", goal: "Find the cult's gathering place and decide whether to stop it or bargain with the Tidewrights." },
    ],
    plot,
    locations: [
      {
        id: "l_square", name: "Hollowmere Square", stage: stage(0), connects_to: ["l_light"],
        summary: "A fogbound fishing village at dusk. The inn glows at one end of the square and the lighthouse road runs out of the other.",
        setting: { name: "Hollowmere square", preset: "town", layout: "settlement", environment: "outdoor", mood: "neutral" },
        theme_tags: ["village", "fog", "inn"], features: ["well", "notice board"],
      },
      {
        id: "l_light", name: "Marrow Light", stage: stage(1), connects_to: ["l_causeway"],
        summary: "Edda's lighthouse on the headland. The door is locked, the lamp is cold, and the cellar below smells of tar and smugglers.",
        setting: { name: "Marrow Light", preset: "interior", layout: "rooms_and_corridors", environment: "indoor", mood: "dim" },
        theme_tags: ["lighthouse", "cellar", "tar"], features: ["keeper's desk", "cellar hatch"],
      },
      {
        id: "l_causeway", name: "The Sleepers' Causeway", stage: stage(2), connects_to: ["l_chapel"],
        summary: "A plank road through reeds and black water where the sleepwalkers shuffle in a line, humming one low note.",
        setting: { name: "Sleepers' causeway", preset: "swamp", layout: "trail", environment: "outdoor", mood: "eerie" },
        theme_tags: ["marsh", "reeds", "humming"], features: ["lantern post"],
      },
      {
        id: "l_chapel", name: "The Drowned Chapel", stage: stage(3), connects_to: ["l_hollow"],
        summary: "A flooded chapel under the marsh where the Choir keeps its lanterns lit and holds the people it has taken.",
        setting: { name: "Drowned chapel", preset: "crypt", layout: "rooms_and_corridors", environment: "underground", mood: "dark" },
        theme_tags: ["flooded", "chapel", "lanterns"], features: ["drowned pipe organ", "altar"],
      },
      {
        id: "l_hollow", name: "The Choir's Hollow", stage: stage(4), connects_to: [],
        summary: "A vast sea cave where the borrowed voices gather, rising and falling as the Cantor conducts them.",
        setting: { name: "Choir's hollow", preset: "cave", layout: "arena", environment: "underground", mood: "eerie" },
        theme_tags: ["sea cave", "echo", "voices"], features: ["conductor's rock"],
      },
    ],
    cast: [
      {
        id: "c_odalys", name: "Odalys Brand", role: "quest_giver", location: "l_square",
        concept: "The innkeeper of Hollowmere. Practical and kind, she knows who walks out at night and has been locking her doors against the humming.",
        voice: "warm, brisk, drops her voice for secrets",
      },
      {
        id: "c_wren", name: "Wren Ashby", role: "ally", location: "l_causeway",
        concept: "A marsh guide who stayed awake by chewing bitter reed. She knows the safe planks and fears the Choir's song.",
        voice: "dry, terse, counts steps aloud",
      },
      {
        id: "c_edda", name: "Edda Marrow", role: "bystander", location: "l_chapel",
        concept: "The missing lighthouse keeper, hollow-eyed and humming in the Choir's key. Part of her is still herself.",
        voice: "soft, distant, finishes other people's sentences",
      },
    ],
    encounters: [
      {
        id: "e_tidewrights", name: "Tidewright smugglers", location: "l_light", stage: stage(1),
        groups: [{ concept: "A Tidewright smuggler guarding the lighthouse cellar, tar-stained and nervous about the humming outside", role: "minion", count: 2 }],
      },
      {
        id: "e_sentries", name: "Choir sentries", location: "l_causeway", stage: stage(2),
        groups: [
          { concept: "A cultist who borrows the voices of the drowned, shepherding the sleepers along the causeway", role: "minion", count: 2 },
          { concept: "A choir sentry in drowned-white robes who answers questions in a dead man's voice", role: "standard", count: 1 },
        ],
      },
      {
        id: "e_ambush", name: "The Choir's ambush", location: "l_chapel", stage: stage(3),
        groups: [
          { concept: "A robed chorister who sings the flood higher around the chapel", role: "standard", count: 2 },
          { concept: "The Cantor's lieutenant, a cunning choir-warden who carries the hushing bell", role: "elite", count: 1 },
        ],
      },
      {
        id: "e_cantor", name: "Cantor Vael and the Choir", location: "l_hollow", stage: stage(4),
        groups: [
          { concept: "A chorister in drowned-white robes, fanatically loyal to the Cantor", role: "standard", count: 2 },
          { concept: "Cantor Vael, a drowned choir-master who sings the sleepers under with a hundred borrowed voices", role: "boss", count: 1 },
        ],
      },
    ],
    key_items: [
      { id: "k_logbook", name: "Edda's Logbook", location: "l_light" },
      { id: "k_bell", name: "Hushing Bell", location: "l_chapel", held_by: { kind: "encounter", id: "e_ambush" } },
    ],
    ending: {
      goal: "Silence Cantor Vael and break the Quiet Choir's hold on the marsh.",
      success: "The borrowed voices fall quiet, the sleepers wake in their beds, and Edda hears her own name again.",
      failure: "The Choir's note swells over the marsh, and Hollowmere walks into the water one house at a time.",
    },
    milestones: plot.stages.map((st, i) => ({ id: `m${i + 1}`, ...LANTERN_MARSH_MILESTONES[i]!, completed: false, stage: st.id })),
    quests: [
      { id: "q_edda", title: "Find Edda Marrow", status: "new", notes: [] },
      { id: "q_sleepers", title: "Why the sleepers walk", status: "new", notes: [] },
    ],
  };
}

export const LANTERN_MARSH_BIBLE: StoryBible = lanternMarshBible();

export const LANTERN_MARSH_FACTS = [
  { subject: "Hollow Pell", predicate: "is_alive", object: "false" },
  { subject: "Lighthouse door", predicate: "state", object: "locked; Edda's spare key hangs behind the bar at the inn" },
  { subject: "Odalys Brand", predicate: "disposition", object: "friendly" },
];
