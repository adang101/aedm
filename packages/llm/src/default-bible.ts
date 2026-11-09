import type { StoryBible } from "@aedm/schemas";

/** The Lantern Marsh, from docs/spike-kit.md. Used when bible generation fails and by the fake provider. */
export const LANTERN_MARSH_BIBLE: StoryBible = {
  title: "The Lantern Marsh",
  digest:
    "The Lantern Marsh is a drowned coastal region where fog and tide hide old secrets. Eleven days ago the lighthouse keeper of Hollowmere, Edda Marrow, vanished. Villagers now walk toward the marsh in their sleep. A smuggling guild, the Tidewrights, wants the lighthouse cellar sealed. A cult called the Quiet Choir borrows the voices of the drowned and is gathering sleepers. Act 1 goal: learn what happened to Edda and why the sleepers walk. The party starts in Hollowmere's square at dusk.",
  tone: "Eerie, grounded, a little wry.",
  acts: [
    { title: "The Sleepers of Hollowmere", goal: "Learn what happened to Edda Marrow and why the villagers sleepwalk toward the marsh." },
    { title: "The Quiet Choir", goal: "Find the cult's gathering place and decide whether to stop it or bargain with the Tidewrights." },
  ],
  milestones: [
    { id: "m1", description: "The party learns the cult's name: the Quiet Choir.", completed: false },
    { id: "m2", description: "The party finds out what became of Edda Marrow.", completed: false },
    { id: "m3", description: "The party reaches the place where the sleepers gather in the marsh.", completed: false },
  ],
  quests: [
    { id: "q_edda", title: "Find Edda Marrow", status: "new", notes: [] },
    { id: "q_sleepers", title: "Why the sleepers walk", status: "new", notes: [] },
  ],
};

export const LANTERN_MARSH_FACTS = [
  { subject: "Hollow Pell", predicate: "is_alive", object: "false" },
  { subject: "Lighthouse door", predicate: "state", object: "locked; Edda's spare key hangs behind the bar at the inn" },
  { subject: "Odalys Brand", predicate: "disposition", object: "friendly" },
];
